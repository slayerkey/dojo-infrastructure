import legacy, { DiscordGateway as DiscordGatewayV21 } from "./index-v21.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const PAGE_SIZE = 5;
const COMPONENT_PREFIX = "rrlb:v3";
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

      const isLeaderboardCommand =
        interaction.type === 2 && interaction.data?.name === "rrleaderboard";
      const component = interaction.type === 3
        ? parseLeaderboardComponent(interaction.data?.custom_id)
        : null;

      if (!isLeaderboardCommand && !component) {
        return legacy.fetch(delegated, env, ctx);
      }

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

      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This leaderboard only works in the Slayerkey Discord server.");
      }

      if (isLeaderboardCommand) {
        const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
        const roles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles.map(String)
          : [];
        const hasDojo = owner || roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
        if (!hasDojo) {
          return ephemeralMessage(
            `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
          );
        }

        if (!env.RR_TRACKER) {
          return ephemeralMessage("The leaderboard service is updating right now. Try again in a moment.");
        }

        const sessionId = createSessionId();
        const traceId = crypto.randomUUID().slice(0, 8);
        ctx.waitUntil(
          createLeaderboardSession(env, discordUserId, sessionId)
            .then(({ snapshot, cacheSource }) =>
              editOriginalInteraction(
                interaction,
                env,
                renderLeaderboardSnapshot(snapshot, discordUserId, sessionId, 1),
              ).then(() => ({ cacheSource })),
            )
            .then(({ cacheSource }) => console.log(JSON.stringify({
              event: "rrleaderboard_snapshot_rendered",
              trace_id: traceId,
              action: "open",
              cache_source: cacheSource,
              worker_version: "v22",
            })))
            .catch(async (error) => {
              console.error(JSON.stringify({
                event: "rrleaderboard_failed",
                trace_id: traceId,
                action: "open",
                error: String(error),
                worker_version: "v22",
              }));
              await editOriginalInteraction(interaction, env, {
                content: `I could not load the leaderboard. Try **/rrleaderboard** again. Reference: **${traceId}**`,
                embeds: [],
                components: [],
              }).catch(() => {});
            }),
        );

        return Response.json({ type: 5, data: {} });
      }

      if (discordUserId !== component.ownerId) {
        return ephemeralMessage(
          "These leaderboard controls belong to the person who opened this message. Run **/rrleaderboard** to open your own controls.",
        );
      }

      const traceId = crypto.randomUUID().slice(0, 8);
      ctx.waitUntil(
        loadLeaderboardSession(env, component.ownerId, component.sessionId)
          .then(({ snapshot, cacheSource }) => {
            const totalPages = Math.max(
              1,
              Math.ceil((Array.isArray(snapshot.entries) ? snapshot.entries.length : 0) / PAGE_SIZE),
            );
            const viewerPosition = Number(snapshot.viewer_position || 0);
            const viewerPage = viewerPosition > 0
              ? Math.ceil(viewerPosition / PAGE_SIZE)
              : component.page;
            const requestedPage = component.action === "prev"
              ? Math.max(1, component.page - 1)
              : component.action === "next"
                ? Math.min(totalPages, component.page + 1)
                : Math.min(totalPages, Math.max(1, viewerPage));

            return editOriginalInteraction(
              interaction,
              env,
              renderLeaderboardSnapshot(
                snapshot,
                component.ownerId,
                component.sessionId,
                requestedPage,
              ),
            ).then(() => ({ cacheSource, requestedPage }));
          })
          .then(({ cacheSource, requestedPage }) => console.log(JSON.stringify({
            event: "rrleaderboard_snapshot_rendered",
            trace_id: traceId,
            action: component.action,
            page: requestedPage,
            cache_source: cacheSource,
            worker_version: "v22",
          })))
          .catch((error) => console.error(JSON.stringify({
            event: "rrleaderboard_failed",
            trace_id: traceId,
            action: component.action,
            error: String(error),
            worker_version: "v22",
          }))),
      );

      return Response.json({ type: 6 });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rrleaderboard_format = "inline-rr-v22";
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

export class DiscordGateway extends DiscordGatewayV21 {}

async function createLeaderboardSession(env, ownerId, sessionId) {
  const snapshot = await env.RR_TRACKER.getLeaderboardSnapshot(ownerId);
  if (!snapshot?.ok) throw new Error(snapshot?.message || "Leaderboard snapshot failed");
  await cacheLeaderboardSnapshot(env, sessionId, ownerId, snapshot);
  return { snapshot, cacheSource: "d1_initial_snapshot" };
}

async function loadLeaderboardSession(env, ownerId, sessionId) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (stub) {
    const cached = await stub.getRrLeaderboardSnapshot(sessionId, ownerId).catch(() => null);
    if (cached?.ok) return { snapshot: cached, cacheSource: "durable_object_memory" };
  }

  const snapshot = await env.RR_TRACKER.getLeaderboardSnapshot(ownerId);
  if (!snapshot?.ok) throw new Error(snapshot?.message || "Leaderboard snapshot refresh failed");
  await cacheLeaderboardSnapshot(env, sessionId, ownerId, snapshot);
  return { snapshot, cacheSource: "d1_cache_miss_refresh" };
}

async function cacheLeaderboardSnapshot(env, sessionId, ownerId, snapshot) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return;
  await stub.putRrLeaderboardSnapshot(sessionId, ownerId, snapshot).catch(() => {});
}

function renderLeaderboardSnapshot(snapshot, ownerId, sessionId, requestedPage) {
  const allEntries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  if (!allEntries.length) {
    return {
      content: `No linked Dojo players are on the ${snapshot.month || "current"} leaderboard yet.`,
      embeds: [],
      components: [],
    };
  }

  const totalPlayers = Number(snapshot.total_players || allEntries.length);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number(requestedPage) || 1));
  const offset = (page - 1) * PAGE_SIZE;
  const entries = allEntries.slice(offset, offset + PAGE_SIZE);
  const blocks = entries.map(formatLeaderboardEntry);

  if (page === 1) {
    const previous = snapshot.previous_month_champion;
    blocks.push(
      previous
        ? `### 👑 ${snapshot.previous_month || "Previous month"} Champion\n<@${previous.discord_user_id}>  ${formatDeltaInline(previous.monthly_rr)}\n${previous.games_counted || 0} competitive games`
        : `### 👑 ${snapshot.previous_month || "Previous month"} Champion\nNo winner recorded yet.`,
    );
  }

  const marked = entries.some((entry) => !entry.history_complete);
  const footerParts = [
    `Page ${page} of ${totalPages}`,
    `${totalPlayers} player${totalPlayers === 1 ? "" : "s"}`,
  ];
  if (marked) footerParts.push("⚠️ Earlier monthly RR may be missing for marked players.");

  return {
    content: null,
    embeds: [{
      color: VALORANT_RED,
      title: `🏆 ${snapshot.month} RR Leaderboard`,
      description: blocks.join("\n\n"),
      footer: { text: footerParts.join("  •  ") },
    }],
    components: [buildLeaderboardControls({
      ownerId,
      sessionId,
      page,
      totalPages,
      viewerPosition: snapshot.viewer_position,
    })],
  };
}

function formatLeaderboardEntry(entry) {
  const position = Number(entry.position || 0);
  const medal = position === 1 ? "🥇" : position === 2 ? "🥈" : position === 3 ? "🥉" : "";
  const ordinal = position === 1 ? "1st" : position === 2 ? "2nd" : position === 3 ? "3rd" : `${position}.`;
  const heading = position === 1 ? "#" : position === 2 ? "##" : position === 3 ? "###" : "";
  const delta = formatDeltaInline(entry.monthly_rr);
  const warning = entry.history_complete ? "" : " ⚠️";
  const start = entry.start_rank ? formatRank(entry.start_rank, entry.start_rr) : "Start not recorded";
  const peak = entry.peak_rank
    ? formatRank(entry.peak_rank, entry.peak_rr)
    : formatRank(entry.current_rank, entry.current_rr);
  const progression = `🏁 ${start}  →  👑 ${peak}`;
  const games = `${entry.games_counted || 0} competitive games${warning}`;

  if (position <= 3) {
    return `${heading} ${medal} ${ordinal}  <@${entry.discord_user_id}>  ${delta}\n${progression}\n${games}`.trim();
  }

  // Keep only the numeric position bold. Discord mentions already render with their
  // own pill styling, and wrapping the mention itself in bold caused the following
  // RR delta to break onto a separate visual line.
  return `**${ordinal}** <@${entry.discord_user_id}>  ${delta}\n${progression}\n${games}`;
}

function buildLeaderboardControls({ ownerId, sessionId, page, totalPages, viewerPosition }) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: leaderboardCustomId(ownerId, sessionId, "prev", page),
        emoji: { name: "◀️" },
        disabled: page <= 1,
      },
      {
        type: 2,
        style: 2,
        custom_id: leaderboardCustomId(ownerId, sessionId, "me", page),
        label: "Me",
        emoji: { name: "👤" },
        disabled: !Number(viewerPosition || 0),
      },
      {
        type: 2,
        style: 2,
        custom_id: leaderboardCustomId(ownerId, sessionId, "next", page),
        emoji: { name: "▶️" },
        disabled: page >= totalPages,
      },
    ],
  };
}

function leaderboardCustomId(ownerId, sessionId, action, page) {
  return `${COMPONENT_PREFIX}:${ownerId}:${sessionId}:${action}:${Math.max(1, Number(page) || 1)}`;
}

function parseLeaderboardComponent(customId) {
  const value = String(customId || "");
  if (!value.startsWith(`${COMPONENT_PREFIX}:`)) return null;
  const parts = value.split(":");
  if (parts.length !== 6) return null;
  const ownerId = String(parts[2] || "");
  const sessionId = String(parts[3] || "");
  const action = String(parts[4] || "");
  const page = Math.max(1, Number(parts[5]) || 1);
  if (!/^\d+$/.test(ownerId)) return null;
  if (!/^[a-zA-Z0-9_-]{6,24}$/.test(sessionId)) return null;
  if (!["prev", "me", "next"].includes(action)) return null;
  return { ownerId, sessionId, action, page };
}

function createSessionId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank} ${Number(rr)} RR`;
}

function formatDeltaInline(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 **+${number} RR**`;
  if (number < 0) return `🔴 **${number} RR**`;
  return "⚪ **0 RR**";
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}) };
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
    throw new Error(`Could not edit leaderboard interaction: ${response.status} ${await response.text()}`);
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
