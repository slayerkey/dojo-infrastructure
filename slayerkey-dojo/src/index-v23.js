import legacy, { DiscordGateway as DiscordGatewayV22 } from "./index-v22.js";

const DISCORD_API = "https://discord.com/api/v10";
const VALORANT_RED = 0xff4655;
const LINK_TIMEOUT_MS = 18000;
const LINK_COOLDOWN_MS = 5000;
const encoder = new TextEncoder();
const linkCooldowns = new Map();

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

      const isLinkRiot = interaction.type === 2 && interaction.data?.name === "linkriot";
      if (!isLinkRiot) return legacy.fetch(delegated, env, ctx);

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
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

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

      const now = Date.now();
      const cooldownUntil = Number(linkCooldowns.get(discordUserId) || 0);
      if (cooldownUntil > now) {
        return ephemeralMessage(
          `You can use **/linkriot** again in **${Math.max(1, Math.ceil((cooldownUntil - now) / 1000))}s**.`,
        );
      }
      linkCooldowns.set(discordUserId, now + LINK_COOLDOWN_MS);

      const rawName = String(getOption(interaction, "name") || "").trim();
      const rawTag = String(getOption(interaction, "tag") || "").trim();
      const normalizedName = rawName.trim();
      const normalizedTag = rawTag.replace(/^#+/, "").trim();

      if (!normalizedName || !normalizedTag) {
        return ephemeralMessage(
          "Enter both your Riot name and tag. You can type the tag with or without the **#**.",
        );
      }

      if (!env.RR_TRACKER) {
        return ephemeralMessage("The RR tracker service is not connected right now.");
      }

      const traceId = crypto.randomUUID().slice(0, 8);
      const startedAt = Date.now();
      console.log(JSON.stringify({
        event: "linkriot_received",
        trace_id: traceId,
        tag_hash_removed: rawTag !== normalizedTag,
        worker_version: "v23",
      }));

      ctx.waitUntil(
        runLinkRiot({
          interaction,
          discordUserId,
          name: normalizedName,
          tag: normalizedTag,
          env,
          traceId,
          startedAt,
        }).catch(async (error) => {
          const elapsedMs = Date.now() - startedAt;
          const timedOut = error?.message === "LINKRIOT_TIMEOUT";
          console.error(JSON.stringify({
            event: "linkriot_failed",
            trace_id: traceId,
            elapsed_ms: elapsedMs,
            timeout: timedOut,
            error: String(error),
            worker_version: "v23",
          }));

          await editOriginalInteraction(interaction, env, {
            content: timedOut
              ? `The Riot tracker took too long to answer for **${escapeDiscord(normalizedName)}#${escapeDiscord(normalizedTag)}**. Wait about 30 seconds, then run **/rr** to see whether the link finished before trying **/linkriot** again. Reference: **${traceId}**`
              : `I could not finish linking that Riot account. Try again in a moment. Reference: **${traceId}**`,
            embeds: [],
          }).catch(() => {});
        }),
      );

      console.log(JSON.stringify({
        event: "linkriot_acknowledged",
        trace_id: traceId,
        worker_version: "v23",
      }));

      return Response.json({ type: 5, data: {} });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.linkriot = {
          mode: "direct-fast-ack-v23",
          leading_hash_normalization: true,
          timeout_seconds: LINK_TIMEOUT_MS / 1000,
          cooldown_storage: "memory-only",
          kv_writes: false,
          result_logging: true,
        };
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

export class DiscordGateway extends DiscordGatewayV22 {}

async function runLinkRiot({ interaction, discordUserId, name, tag, env, traceId, startedAt }) {
  console.log(JSON.stringify({
    event: "linkriot_tracker_started",
    trace_id: traceId,
    worker_version: "v23",
  }));

  const result = await withTimeout(
    env.RR_TRACKER.linkRiot(discordUserId, `${name}#${tag}`, "na"),
    LINK_TIMEOUT_MS,
  );

  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    event: "linkriot_tracker_completed",
    trace_id: traceId,
    elapsed_ms: elapsedMs,
    ok: Boolean(result?.ok),
    code: result?.code || null,
    http_status: result?.http_status || null,
    worker_version: "v23",
  }));

  const payload = buildLinkPayload(result, traceId);
  await editOriginalInteraction(interaction, env, payload);

  console.log(JSON.stringify({
    event: "linkriot_response_updated",
    trace_id: traceId,
    elapsed_ms: Date.now() - startedAt,
    worker_version: "v23",
  }));
}

function buildLinkPayload(result, traceId) {
  if (!result?.ok) {
    if (result?.code === "RATE_LIMITED") {
      return {
        content: `The Riot tracker is rate limited right now. Try **/linkriot** again in about ${Number(result.retry_after || 60)} seconds. Reference: **${traceId}**`,
        embeds: [],
      };
    }
    if (result?.code === "ACCOUNT_LOOKUP_FAILED") {
      return {
        content: `I could not find that Riot account. Double check the name and tag, then try again. You can enter the tag with or without **#**. Reference: **${traceId}**`,
        embeds: [],
      };
    }
    if (result?.code === "MMR_HISTORY_FAILED") {
      return {
        content: `I found the Riot account, but the ranked history service did not answer correctly. The Discord link was not saved. Try again shortly. Reference: **${traceId}**`,
        embeds: [],
      };
    }
    if (result?.code === "ALREADY_LINKED" || result?.code === "RIOT_ACCOUNT_IN_USE") {
      return { content: result.message || "That Riot account cannot be linked.", embeds: [] };
    }
    return {
      content: `${result?.message || "I could not link that Riot account."} Reference: **${traceId}**`,
      embeds: [],
    };
  }

  const fields = [
    {
      name: "Current rank",
      value: formatRank(result.current_rank, result.current_rr),
      inline: true,
    },
    {
      name: result.month || "This month",
      value: `${formatDelta(result.monthly_rr)}\n${Number(result.games_counted || 0)} competitive games`,
      inline: true,
    },
  ];

  const footer = result.history_complete
    ? "Run /sync after playing to update your stats."
    : "Tracking is active. Earlier monthly RR may be missing if tracking started after the month began.";

  return {
    content: null,
    embeds: [{
      color: VALORANT_RED,
      title: `Riot account linked  ${result.riot_id}`,
      description: "Your ranked account is connected to the Dojo RR tracker.",
      fields,
      footer: { text: footer },
    }],
  };
}

function getOption(interaction, name) {
  const target = String(name || "");
  const stack = Array.isArray(interaction?.data?.options)
    ? [...interaction.data.options]
    : [];
  while (stack.length) {
    const item = stack.shift();
    if (String(item?.name || "") === target && item?.value != null) return item.value;
    if (Array.isArray(item?.options)) stack.push(...item.options);
  }
  return null;
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank}  ${Number(rr)} RR`;
}

function formatDelta(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 **+${number} RR**`;
  if (number < 0) return `🔴 **${number} RR**`;
  return "⚪ **0 RR**";
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: 64,
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
    throw new Error(`Could not edit /linkriot interaction: ${response.status} ${await response.text()}`);
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("LINKRIOT_TIMEOUT")), timeoutMs);
    }),
  ]);
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
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function escapeDiscord(value) {
  return String(value || "").replace(/([*_`~|>])/g, "\\$1");
}
