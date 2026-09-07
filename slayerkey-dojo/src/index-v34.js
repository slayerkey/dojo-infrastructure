import legacy, { DiscordGateway as DiscordGatewayV33 } from "./index-v33.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const encoder = new TextEncoder();
const UNLINK_COMMAND = {
  name: "unlinkriot",
  description: "Unlink your current Riot account while keeping your RR history",
  type: 1,
  integration_types: [0],
  contexts: [0],
};

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

      const command = interaction.type === 2 ? String(interaction.data?.name || "") : "";
      if (command !== "unlinkriot") return legacy.fetch(delegated, env, ctx);

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const discordUserId = getInteractionUserId(interaction);
      if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");
      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }
      if (!env.RR_TRACKER) {
        return ephemeralMessage("The RR tracker service is not connected right now.");
      }

      const traceId = crypto.randomUUID().slice(0, 8);
      ctx.waitUntil(
        env.RR_TRACKER.unlinkRiot(discordUserId)
          .then((result) => editOriginalInteraction(interaction, env, unlinkMessage(result)))
          .then(() => console.log(JSON.stringify({
            event: "unlinkriot_completed",
            trace_id: traceId,
            discord_user_id: discordUserId,
            worker_version: "v34",
          })))
          .catch(async (error) => {
            console.error(JSON.stringify({
              event: "unlinkriot_failed",
              trace_id: traceId,
              error: String(error),
              worker_version: "v34",
            }));
            await editOriginalInteraction(interaction, env, {
              content: `I could not unlink your Riot account. Try again in a moment. Reference: **${traceId}**`,
              embeds: [],
              components: [],
            }).catch(() => {});
          }),
      );

      return Response.json({ type: 5, data: { flags: EPHEMERAL } });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.riot_linking = {
          ...(body.discord.riot_linking || {}),
          self_service_unlink: true,
          unlink_command: "/unlinkriot",
          unlink_history_policy: "preserve-rr-history",
          same_puuid_rename: "automatic",
          worker_version: "v34",
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
      await legacy.scheduled(controller, env, ctx);
    }

    // Older layers may perform their own command reconciliation in waitUntil().
    // Give that maintenance a moment to finish, then ensure only this new command
    // exists. This avoids bulk-overwriting the newer command set.
    await sleep(2500);
    await ensureUnlinkCommand(env).catch((error) => {
      console.error("Could not ensure /unlinkriot registration:", error);
    });
  },
};

export class DiscordGateway extends DiscordGatewayV33 {}

function unlinkMessage(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return { content: "You do not currently have a Riot account linked.", embeds: [], components: [] };
    }
    return {
      content: result?.message || "I could not unlink your Riot account.",
      embeds: [],
      components: [],
    };
  }

  return {
    content:
      `Unlinked **${escapeDiscord(result.riot_id || "your Riot account")}**. ` +
      "Your existing RR history, monthly results, yearly results, and past champion records are kept.\n\n" +
      "Use **/linkriot** whenever you want to connect this Discord account to a Riot account again.",
    embeds: [],
    components: [],
  };
}

async function ensureUnlinkCommand(env) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  const base = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(base, { headers });
  if (!response.ok) throw new Error(`Discord command list ${response.status}`);
  const commands = await response.json();
  const existing = Array.isArray(commands)
    ? commands.find((item) => String(item?.name || "") === UNLINK_COMMAND.name)
    : null;

  if (!existing) {
    const created = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(UNLINK_COMMAND),
    });
    if (!created.ok) throw new Error(`Discord /unlinkriot registration ${created.status}: ${await created.text()}`);
    return;
  }

  if (String(existing.description || "") !== UNLINK_COMMAND.description) {
    const updated = await fetch(`${base}/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(UNLINK_COMMAND),
    });
    if (!updated.ok) throw new Error(`Discord /unlinkriot update ${updated.status}: ${await updated.text()}`);
  }
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}), allowed_mentions: { parse: [] } };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not edit /unlinkriot interaction: ${response.status} ${await response.text()}`);
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
    return crypto.subtle.verify(
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
  const value = String(hex || "").trim();
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid hex value");
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  return bytes;
}

function escapeDiscord(value) {
  return String(value || "").replace(/([*_`~|>])/g, "\\$1");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
