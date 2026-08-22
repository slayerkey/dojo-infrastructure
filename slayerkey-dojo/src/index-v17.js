import legacy, { DiscordGateway as DiscordGatewayV16 } from "./index-v16.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      let rawBody;
      let interaction;

      try {
        rawBody = await request.text();
        interaction = JSON.parse(rawBody);
      } catch {
        return legacy.fetch(delegated, env, ctx);
      }

      // /rr is intentionally a minimal stored-data presentation path. It does not
      // call Henrik, import matches, refresh Riot data, fetch a rank icon, or do a
      // live Discord member lookup. /sync remains the explicit refresh command.
      if (interaction.type === 2 && interaction.data?.name === "rr") {
        const valid = await verifyDiscordSignature(
          request.headers,
          rawBody,
          env.DISCORD_PUBLIC_KEY,
        );
        if (!valid) return new Response("Invalid request signature", { status: 401 });

        const discordUserId = getInteractionUserId(interaction);
        if (!discordUserId) {
          return ephemeralMessage("I could not determine your Discord user ID.");
        }

        const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
        const memberRoles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles.map(String)
          : [];
        if (!owner && !memberRoles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""))) {
          return ephemeralMessage(
            `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
          );
        }

        if (!env.RR_TRACKER) {
          return ephemeralMessage("The RR tracker service is not connected right now.");
        }

        const traceId = crypto.randomUUID().slice(0, 8);
        const startedAt = Date.now();
        console.log(JSON.stringify({
          event: "rr_received",
          trace_id: traceId,
          worker_version: "v17",
        }));

        ctx.waitUntil(
          handleStoredRr(interaction, discordUserId, env, traceId, startedAt).catch(async (error) => {
            console.error(JSON.stringify({
              event: "rr_failed",
              trace_id: traceId,
              worker_version: "v17",
              error: String(error),
            }));
            await editOriginalInteraction(interaction, env, {
              content: `I could not load your stored RR stats. Try **/rr** again in a moment. Reference: **${traceId}**`,
            }).catch(() => {});
          }),
        );

        console.log(JSON.stringify({
          event: "rr_acknowledged",
          trace_id: traceId,
          worker_version: "v17",
        }));

        return Response.json({ type: 5, data: {} });
      }

      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rr_mode = "direct-stored-d1-read-v17";
        body.discord.rr_external_refresh = false;
        body.discord.rr_rank_icon_fetch = false;
        body.discord.diagnostics = "workers-observability";
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV16 {}

async function handleStoredRr(interaction, discordUserId, env, traceId, startedAt) {
  const result = await env.RR_TRACKER.getDiscordUserStatsDetailed(discordUserId);
  const payload = buildStoredRrPayload(result);
  await editOriginalInteraction(interaction, env, payload);

  console.log(JSON.stringify({
    event: "rr_completed",
    trace_id: traceId,
    worker_version: "v17",
    wall_ms: Date.now() - startedAt,
    ok: Boolean(result?.ok),
  }));
}

function buildStoredRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    }
    return { content: result?.message || "I could not load your stored RR stats." };
  }

  const leaderboard = result.leaderboard_position
    ? `**#${result.leaderboard_position}**${result.leaderboard_count ? ` of ${result.leaderboard_count}` : ""}`
    : "Not ranked yet";

  const updated = formatRelativeTime(result.last_synced_at);
  return {
    embeds: [cleanEmbed({
      title: `${result.riot_id}  ${formatRank(result.current_rank, result.current_rr)}`,
      description: updated ? `Last synced ${updated}` : "No sync timestamp recorded yet.",
      fields: [
        {
          name: "🏁 Start rank",
          value: result.start_rank ? formatRank(result.start_rank, result.start_rr) : "Not recorded yet",
          inline: true,
        },
        {
          name: "👑 Peak tracked",
          value: result.peak_rank
            ? formatRank(result.peak_rank, result.peak_rr)
            : formatRank(result.current_rank, result.current_rr),
          inline: true,
        },
        { name: "🏆 Leaderboard", value: leaderboard, inline: true },
        {
          name: "Last 12 hours",
          value: `${formatDelta(result.recent_12h_rr)}\n${result.recent_12h_games || 0} competitive games`,
          inline: true,
        },
        {
          name: result.month || "This month",
          value: `${formatDelta(result.monthly_rr)}\n${result.games_counted || 0} competitive games`,
          inline: true,
        },
        {
          name: "Streak",
          value: result.current_streak
            ? `🔥 **${result.current_streak} day${result.current_streak === 1 ? "" : "s"}**`
            : "No active streak",
          inline: true,
        },
        {
          name: "Activity",
          value: `**${result.active_days || 0} active days**\n${result.tracking_days || 0} days tracked`,
          inline: true,
        },
        { name: "Monthly activity", value: formatHeatmap(result.activity || []), inline: false },
      ],
      footer: joinFooter(
        historyWarning(result),
        "Stored stats only. Run /sync after playing to refresh.",
      ),
    })],
  };
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank}  ${rr} RR`;
}

function formatDelta(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 **+${number} RR**`;
  if (number < 0) return `🔴 **${number} RR**`;
  return "⚪ **0 RR**";
}

function historyWarning(result) {
  return result?.history_complete
    ? null
    : "⚠️ Monthly stats may be incomplete because tracking started after the month began.";
}

function joinFooter(...parts) {
  return parts.filter(Boolean).join("  ");
}

function formatRelativeTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatHeatmap(activity) {
  if (!Array.isArray(activity) || !activity.length) return "No activity yet.";
  const today = new Date().getUTCDate();
  const symbols = activity.map((entry) => {
    if (entry.day > today) return "▫️";
    const games = Number(entry.games || 0);
    if (games === 0) return "⬛";
    if (games === 1) return "🟥";
    if (games <= 3) return "🟧";
    return "🟨";
  });
  const rows = [];
  for (let i = 0; i < symbols.length; i += 7) rows.push(symbols.slice(i, i + 7).join(""));
  return `${rows.join("\n")}\n⬛ 0  🟥 1  🟧 2 to 3  🟨 4+  ▫️ upcoming`;
}

function cleanEmbed({ title, description, fields = [], footer }) {
  const embed = { color: VALORANT_RED, title, fields };
  if (description) embed.description = description;
  if (footer) embed.footer = { text: footer };
  return embed;
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = typeof payload === "string" ? { content: payload } : { ...(payload || {}) };
  body.allowed_mentions = { parse: [] };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not edit interaction: ${response.status} ${await response.text()}`);
  }
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("Invalid hex value");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}
