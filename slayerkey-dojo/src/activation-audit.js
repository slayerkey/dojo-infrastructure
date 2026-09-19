const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const encoder = new TextEncoder();

export const ACTIVATION_CHANNELS = {
  introductions: "1540019496314474566",
  general: "1532854321723478217",
  goals: "1538607897658003546",
  wins: "1532854569946583300",
  training: "1541188454010978315",
  start: "1532855733333266614",
};

export const ACTIVATION_AUDIT_COMMAND = {
  name: "activation-audit",
  description: "Review read only activation milestones for Dojo members",
  type: 1,
};

export async function handleActivationAuditRequest(request, env) {
  const rawBody = await request.text();
  if (!(await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const command = interaction?.data?.name;
  if (interaction?.type !== 2 || command !== ACTIVATION_AUDIT_COMMAND.name) return null;
  if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) return ephemeralMessage("This command is only available inside the Dojo server.");
  if (String(interaction.member?.user?.id || interaction.user?.id || "") !== String(env.DISCORD_OWNER_USER_ID || "")) return ephemeralMessage("Only the configured owner can run this audit.");

  const response = ephemeralMessage("Running a read only activation audit. I will post the report here when it is ready.");
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return ephemeralMessage("Activation audit is not configured.");
  const channelId = String(interaction.channel_id || "");
  const task = runAudit(env, stub, channelId).catch((error) => {
    console.error("Activation audit failed:", error);
    return sendChannelMessage(channelId, `Activation audit failed: ${safeError(error)}`, env);
  });
  if (typeof executionContext !== "undefined") executionContext.waitUntil(task);
  else task;
  return response;
}

export async function ensureActivationAuditCommand(env) {
  const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const existing = await discordJson(url, env);
  const found = Array.isArray(existing) && existing.some((item) => item?.name === ACTIVATION_AUDIT_COMMAND.name);
  if (!found) await discordJson(url, env, { method: "POST", body: JSON.stringify(ACTIVATION_AUDIT_COMMAND) });
}

async function runAudit(env, stub, reportChannelId) {
  const members = await fetchDojoMembers(env);
  const results = [];
  for (const member of members) {
    const userId = String(member.user?.id || "");
    if (!userId) continue;
    const tenure = await stub.getTenureRecord?.(userId).catch(() => null);
    const messages = await fetchMemberMessages(userId, env);
    results.push(buildMemberResult(userId, member.user?.username || userId, tenure, messages));
  }
  const lines = ["## Activation Audit", `Members checked: ${results.length}`, "Read only. Message content is not stored.", ""];
  for (const item of results) {
    lines.push(`**${item.name}** <@${item.user_id}>`,
      `Introduction: ${mark(item.introduction)}`, `Two member replies: ${item.reply_members}/2`,
      `Training task: ${mark(item.training)}`, `Riot linked: ${mark(item.riot_linked)}`,
      `General message: ${mark(item.general)}`, `Goals: ${mark(item.goals)}`,
      `First qualifying win: ${item.first_win || "Not detected"}`, `Wins in first 7 days: ${item.wins_first_7_days}`, "");
  }
  for (const chunk of chunkLines(lines, 1900)) await sendChannelMessage(reportChannelId, chunk, env);
  return results;
}

function buildMemberResult(userId, name, tenure, messages) {
  const byChannel = (key) => messages.filter((message) => message.channel_id === ACTIVATION_CHANNELS[key]);
  const introductions = byChannel("introductions");
  const general = byChannel("general");
  const goals = byChannel("goals");
  const training = byChannel("training");
  const wins = byChannel("wins").filter(isQualifyingWin);
  const replies = new Set(messages.filter((message) => message.message_reference?.message_id && message.author?.id !== userId && message.referenced_message?.author?.id && message.referenced_message.author.id !== userId).map((message) => message.referenced_message.author.id));
  const firstEligible = Date.parse(tenure?.first_eligible_at || "");
  const firstSevenEnd = Number.isFinite(firstEligible) ? firstEligible + 7 * 86400000 : null;
  const firstSevenWins = wins.filter((message) => firstSevenEnd && Date.parse(message.timestamp) >= firstEligible && Date.parse(message.timestamp) <= firstSevenEnd);
  return { user_id: userId, name, introduction: introductions.length > 0, reply_members: replies.size, training: training.length > 0, riot_linked: false, general: general.length > 0, goals: goals.length > 0, first_win: wins[0]?.timestamp?.slice(0, 10) || null, wins_first_7_days: firstSevenWins.length };
}

function isQualifyingWin(message) {
  const content = String(message.content || "").toLowerCase();
  return /\b(win|won|victory|victorious|ggs?)\b/.test(content) || /[🏆🥇]/u.test(content);
}

async function fetchMemberMessages(userId, env) {
  const output = [];
  for (const channelId of Object.values(ACTIVATION_CHANNELS)) {
    let before = "";
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (before) query.set("before", before);
      const pageItems = await discordJson(`${DISCORD_API}/channels/${channelId}/messages?${query}`, env);
      if (!Array.isArray(pageItems) || !pageItems.length) break;
      output.push(...pageItems.filter((message) => message.author?.id === userId));
      const last = pageItems[pageItems.length - 1]?.id;
      if (!last || pageItems.length < 100) break;
      before = String(last);
    }
  }
  return output.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

async function fetchDojoMembers(env) {
  const output = [];
  let after = "0";
  while (true) {
    const page = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${after}`, env);
    if (!Array.isArray(page)) break;
    for (const member of page) if (!member.user?.bot && member.roles?.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID))) output.push(member);
    if (page.length < 1000) break;
    after = String(page[page.length - 1]?.user?.id || after);
    if (after === "0") break;
  }
  return output;
}

async function sendChannelMessage(channelId, content, env) { return discordJson(`${DISCORD_API}/channels/${channelId}/messages`, env, { method: "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) }); }
async function discordJson(url, env, options = {}) { const response = await fetch(url, { ...options, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) } }); if (!response.ok) throw new Error(`Discord API ${response.status}`); return response.status === 204 ? null : response.json(); }
async function verifyDiscordSignature(headers, rawBody, publicKeyHex) { const signature = headers.get("X-Signature-Ed25519"); const timestamp = headers.get("X-Signature-Timestamp"); if (!signature || !timestamp || !publicKeyHex) return false; try { const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]); return crypto.subtle.verify("Ed25519", key, hexToBytes(signature), encoder.encode(timestamp + rawBody)); } catch { return false; } }
function hexToBytes(hex) { if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) throw new Error("Invalid hex"); const bytes = new Uint8Array(hex.length / 2); for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16); return bytes; }
function ephemeralMessage(content) { return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } }); }
function mark(value) { return value ? "Yes" : "No"; }
function chunkLines(lines, max) { const chunks = []; let current = ""; for (const line of lines) { const next = current ? `${current}\n${line}` : line; if (next.length > max && current) { chunks.push(current); current = line; } else current = next; } if (current) chunks.push(current); return chunks; }
function safeError(error) { return String(error?.message || error || "Unknown error").slice(0, 240); }
