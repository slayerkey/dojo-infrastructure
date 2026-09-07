import legacy, { DiscordGateway as DiscordGatewayV34 } from "./index-v34.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const COMPONENT_PREFIX = "unlinkriot:v2";
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

      const command = interaction.type === 2 ? String(interaction.data?.name || "") : "";
      const component = interaction.type === 3
        ? parseUnlinkComponent(interaction.data?.custom_id)
        : null;

      if (command !== "unlinkriot" && !component) {
        return legacy.fetch(delegated, env, ctx);
      }

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

      if (command === "unlinkriot") {
        const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
        const roles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles.map(String)
          : [];
        const hasDojo = owner || roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
        if (!hasDojo) {
          return ephemeralMessage(
            `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to manage your Riot tracker link.`,
          );
        }

        const traceId = crypto.randomUUID().slice(0, 8);
        ctx.waitUntil(
          showUnlinkConfirmation(interaction, discordUserId, env)
            .then(() => console.log(JSON.stringify({
              event: "unlinkriot_confirmation_shown",
              trace_id: traceId,
              worker_version: "v35",
            })))
            .catch(async (error) => {
              console.error(JSON.stringify({
                event: "unlinkriot_confirmation_failed",
                trace_id: traceId,
                error: String(error),
                worker_version: "v35",
              }));
              await editOriginalInteraction(interaction, env, {
                content: `I could not load your Riot link. Try **/unlinkriot** again. Reference: **${traceId}**`,
                embeds: [],
                components: [],
              }).catch(() => {});
            }),
        );

        return Response.json({ type: 5, data: { flags: EPHEMERAL } });
      }

      if (discordUserId !== component.ownerId) {
        return ephemeralMessage("That unlink confirmation belongs to another member.");
      }

      if (component.action === "cancel") {
        return Response.json({
          type: 7,
          data: {
            content: "Riot unlink cancelled. Nothing was changed.",
            embeds: [],
            components: [],
            allowed_mentions: { parse: [] },
          },
        });
      }

      const traceId = crypto.randomUUID().slice(0, 8);
      ctx.waitUntil(
        env.RR_TRACKER.unlinkRiot(discordUserId)
          .then((result) => editOriginalInteraction(interaction, env, unlinkResultMessage(result)))
          .then(() => console.log(JSON.stringify({
            event: "unlinkriot_confirmed",
            trace_id: traceId,
            discord_user_id: discordUserId,
            worker_version: "v35",
          })))
          .catch(async (error) => {
            console.error(JSON.stringify({
              event: "unlinkriot_confirm_failed",
              trace_id: traceId,
              error: String(error),
              worker_version: "v35",
            }));
            await editOriginalInteraction(interaction, env, {
              content: `I could not unlink your Riot account. Nothing else was changed. Try again in a moment. Reference: **${traceId}**`,
              embeds: [],
              components: [],
            }).catch(() => {});
          }),
      );

      return Response.json({ type: 6 });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.riot_linking = {
          ...(body.discord.riot_linking || {}),
          unlink_confirmation: "required-v35",
          same_puuid_rename: "continuous-no-reset",
          different_puuid_switch: "month-and-year-reset-at-switch",
          completed_history: "preserved",
          worker_version: "v35",
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

export class DiscordGateway extends DiscordGatewayV34 {}

async function showUnlinkConfirmation(interaction, discordUserId, env) {
  const current = await env.RR_TRACKER.getCurrentRiotLink(discordUserId);
  if (!current?.ok) {
    await editOriginalInteraction(interaction, env, {
      content: current?.code === "NOT_LINKED"
        ? "You do not currently have a Riot account linked."
        : (current?.message || "I could not read your current Riot link."),
      embeds: [],
      components: [],
    });
    return;
  }

  await editOriginalInteraction(interaction, env, {
    content:
      `### Unlink ${escapeDiscord(current.riot_id)}?\n` +
      "You **do not need to unlink** if you only changed your Riot name or tag. The bot recognizes the same Riot account by PUUID and keeps your tracking continuous.\n\n" +
      "Only continue if you want to switch to a **different Riot account**. Your completed RR history and past champion records stay saved, but linking a different account will restart your **current monthly and yearly leaderboard score from 0 at the switch**.",
    embeds: [],
    components: [{
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          custom_id: unlinkCustomId(discordUserId, "confirm"),
          label: "Unlink Riot",
        },
        {
          type: 2,
          style: 2,
          custom_id: unlinkCustomId(discordUserId, "cancel"),
          label: "Cancel",
        },
      ],
    }],
  });
}

function unlinkResultMessage(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return {
        content: "You do not currently have a Riot account linked.",
        embeds: [],
        components: [],
      };
    }
    return {
      content: result?.message || "I could not unlink your Riot account.",
      embeds: [],
      components: [],
    };
  }

  return {
    content:
      `Unlinked **${escapeDiscord(result.riot_id || "your Riot account")}**. Your completed RR history and past champion records are still saved.\n\n` +
      "If you reconnect this exact same Riot account, its scoring session stays continuous. If you link a different Riot account, your current monthly and yearly leaderboard score starts fresh from that new link.",
    embeds: [],
    components: [],
  };
}

function unlinkCustomId(ownerId, action) {
  return `${COMPONENT_PREFIX}:${ownerId}:${action}`;
}

function parseUnlinkComponent(customId) {
  const value = String(customId || "");
  if (!value.startsWith(`${COMPONENT_PREFIX}:`)) return null;
  const parts = value.split(":");
  if (parts.length !== 4) return null;
  const ownerId = String(parts[2] || "");
  const action = String(parts[3] || "");
  if (!/^\d+$/.test(ownerId)) return null;
  if (!["confirm", "cancel"].includes(action)) return null;
  return { ownerId, action };
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
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Invalid hex value");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return bytes;
}

function escapeDiscord(value) {
  return String(value || "").replace(/([*_`~|>])/g, "\\$1");
}
