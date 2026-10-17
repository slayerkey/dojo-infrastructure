import { ACTIVATION_DESTINATIONS } from "./activation-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const WELCOME_PREFIX = "activation:v43:welcome:";
const START_HERE_NAMES = new Set(["starthere"]);

export function selectStartHereChannel(channels) {
  const matches = (Array.isArray(channels) ? channels : []).filter((channel) =>
    [0, 5].includes(Number(channel?.type)) &&
    START_HERE_NAMES.has(String(channel?.name || "").toLowerCase().replace(/[^a-z0-9]/g, ""))
  );
  return matches.length === 1 ? String(matches[0].id) : null;
}

export function welcomeMessage(userId, startHereId, botsChannelId) {
  const startHere = startHereId ? "<#" + startHereId + ">" : "**#start-here**";
  const bots = botsChannelId ? " in <#" + botsChannelId + ">" : "";
  return "Hey <@" + userId + "> — welcome to the Dojo.\n" +
    "Start with " + startHere + ", introduce yourself, then run **/roadmap**" + bots +
    " once your membership is verified. Your first training task is waiting.";
}

async function discordJson(url, env, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bot " + env.DISCORD_BOT_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error("Dojo welcome " + response.status + ": " + (await response.text()).slice(0, 200));
  return response.status === 204 ? null : response.json();
}

export async function greetNewDojoMember(gateway, member, api = discordJson) {
  const guildId = String(gateway.env.DISCORD_GUILD_ID || "");
  const userId = String(member?.user?.id || "");
  if (!guildId || !userId || member?.user?.bot || !gateway.env.DISCORD_BOT_TOKEN) {
    return { skipped: "invalid_member_or_settings" };
  }
  const key = WELCOME_PREFIX + guildId + ":" + userId;
  if (!(await gateway.claimDojoWelcome(key))) return { skipped: "already_welcomed" };
  try {
    const config = await gateway.getRoadmapV41Config().catch(() => null);
    let startHereId = String(config?.channels?.start_here || "");
    if (!startHereId) {
      const channels = await api(DISCORD_API + "/guilds/" + guildId + "/channels", gateway.env);
      startHereId = selectStartHereChannel(channels) || "";
    }
    const botsId = String(config?.channels?.bots || "");
    const channelId = String(gateway.env.DOJO_WELCOME_CHANNEL_ID || ACTIVATION_DESTINATIONS.general);
    await api(DISCORD_API + "/channels/" + channelId + "/messages", gateway.env, {
      method: "POST",
      body: JSON.stringify({
        content: welcomeMessage(userId, startHereId, botsId),
        allowed_mentions: { parse: [], users: [userId] },
      }),
    });
    return { sent: true, channel_id: channelId, user_id: userId };
  } catch (error) {
    await gateway.releaseDojoWelcome(key).catch(() => {});
    throw error;
  }
}

export async function claimDojoWelcome(gateway, key) {
  return gateway.ctx.storage.transaction(async (txn) => {
    if (await txn.get(key)) return false;
    await txn.put(key, { greeted_at: new Date().toISOString() });
    return true;
  });
}

export async function releaseDojoWelcome(gateway, key) {
  await gateway.ctx.storage.delete(key);
}
