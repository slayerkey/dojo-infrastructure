import {
  buildActivationV40Model,
  identityFromGuildMember,
  previousSevenPhoenixDateKeys,
} from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";

export async function postWeeklyDigest(env, stub, channelId, options = {}) {
  if (!channelId) throw new Error("No Weekly Digest channel is configured.");
  const model = await buildWeeklyDigestModel(env, stub);
  const payload = buildWeeklyDigestPayload(model, {
    title: options.manual ? "📊 Weekly Digest — Manual Check" : "📊 Weekly Digest",
    footer: "Current Dojo-role members only · Previous 7 completed Arizona days.",
  });
  await discordJson(DISCORD_API + "/channels/" + channelId + "/messages", env, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { model, payload };
}

export async function buildWeeklyDigestModel(env, stub) {
  const dates = previousSevenPhoenixDateKeys(new Date());
  const [members, snapshot, totals] = await Promise.all([
    fetchCurrentDojoMembers(env),
    stub.getActivationV40Snapshot(),
    stub.getActivityCounts(dates),
  ]);
  const identities = members.map((member) => identityFromGuildMember(member));
  await stub.hydrateActivationIdentities(identities).catch(() => {});
  return buildActivationV40Model({
    records: snapshot?.records || [],
    currentMembers: members,
    totals: totals || {},
    interventions: snapshot?.interventions || {},
    taskStages: snapshot?.taskStages || {},
    now: new Date(),
  });
}

export function buildWeeklyDigestPayload(model, options = {}) {
  const members = Array.isArray(model?.members) ? model.members : [];

  const neverStarted = members.filter((member) => !member.any_message_observed);
  const onboardedNotSocial = members.filter(
    (member) =>
      member.any_message_observed &&
      !member.community_participated &&
      !member.first_win_posted,
  );
  const lapsed = members.filter(
    (member) =>
      member.community_participated &&
      Number(member.messages_last_7_days || 0) === 0,
  );
  const activeNoWin = members.filter(
    (member) =>
      Number(member.messages_last_7_days || 0) > 0 &&
      !member.first_win_posted,
  );
  const activated = members.filter((member) => member.first_win_posted);

  const fields = [{
    name: "Activation Funnel",
    value: [
      `**Current members:** ${members.length}`,
      `🚨 No tracked message ever: **${neverStarted.length}**`,
      `👋 Onboarded, not in community: **${onboardedNotSocial.length}**`,
      `💤 Participated before, 0 msgs / 7d: **${lapsed.length}**`,
      `🏆 Active, no first win: **${activeNoWin.length}**`,
      `✅ First win posted: **${activated.length}**`,
    ].join("\n"),
    inline: false,
  }];

  appendDigestGroup(fields, "🚨 NO TRACKED MESSAGE EVER", neverStarted);
  appendDigestGroup(fields, "👋 ONBOARDED · NOT IN COMMUNITY", onboardedNotSocial);
  appendDigestGroup(fields, "💤 LAPSED · 0 MSGS / 7D", lapsed);
  appendDigestGroup(fields, "🏆 ACTIVE · NO FIRST WIN", activeNoWin);

  if (!neverStarted.length && !onboardedNotSocial.length && !lapsed.length && !activeNoWin.length) {
    fields.push({
      name: "✅ No members need a check",
      value: "Every current member has community participation, recent activity, and a tracked first win.",
      inline: false,
    });
  }

  return {
    content: "",
    embeds: [{
      title: options.title || "📊 Weekly Digest",
      description: [
        "**The funnel:** Onboarding → Community Participation → First Win",
        "",
        "**Community Participation** currently means a tracked message in General, Community Help, or Clips. Existing General history is backfilled; Help/Clips expand prospectively as members post.",
        "",
        "**No tracked message ever** means the bot has no message evidence from the tracked onboarding/activation history or live Dojo message tracking. It is intentionally phrased as “tracked,” not an absolute claim about every historical Discord message.",
      ].join("\n"),
      fields,
      footer: { text: options.footer || "Current Dojo members only." },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

function appendDigestGroup(fields, label, members) {
  if (!members.length) return;
  const lines = members
    .slice()
    .sort((a, b) => {
      const aCount = Number(a.messages_last_7_days || 0);
      const bCount = Number(b.messages_last_7_days || 0);
      return aCount - bCount || String(a.display_name || "").localeCompare(String(b.display_name || ""));
    })
    .map((member) => formatDigestMember(member));
  const chunks = chunkTextLines(lines, 900);
  chunks.forEach((value, index) => {
    fields.push({
      name: index === 0 ? label + " — " + members.length : label + " (cont.)",
      value,
      inline: false,
    });
  });
}

export function formatDigestMember(member) {
  const id = String(member?.discord_user_id || "");
  const mention = id ? "<@" + id + ">" : "**Unknown member**";
  let fallback;
  if (member?.username) fallback = "`@" + String(member.username).replace(/`/g, "") + "`";
  else if (member?.display_name && !String(member.display_name).startsWith("Unknown member")) fallback = "`" + String(member.display_name).replace(/`/g, "") + "`";
  else if (id) fallback = "`Discord ID: " + id + "`";
  else fallback = "`Unresolved member`";

  const count = Math.max(0, Number(member?.messages_last_7_days || 0));
  const intro = member?.introduction_posted ? "✅" : "❌";
  const community = member?.community_participated ? "✅" : "❌";
  const win = member?.first_win_posted ? "✅" : "❌";
  const stage = Number(member?.task_stage || 0);
  const task = stage > 0 ? `#${stage}` : "—";

  return [
    "• " + mention,
    fallback,
    `Intro ${intro}`,
    `Community ${community}`,
    `Task ${task}`,
    `Win ${win}`,
    `7d **${count}**`,
  ].join(" · ");
}

function chunkTextLines(lines, maxLength) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? current + "\n" + line : line;
    if (current && next.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function fetchCurrentDojoMembers(env) {
  const roleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!roleId) throw new Error("DISCORD_DOJO_ROLE_ID is missing.");
  const members = [];
  let after = "0";
  while (true) {
    const page = await discordJson(
      DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members?limit=1000&after=" + encodeURIComponent(after),
      env,
    );
    if (!Array.isArray(page)) break;
    for (const member of page) {
      const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
      if (!member?.user?.bot && roles.includes(roleId)) members.push(member);
    }
    if (page.length < 1000) break;
    const last = String(page[page.length - 1]?.user?.id || "");
    if (!last || last === after) break;
    after = last;
  }
  return members;
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
  if (!response.ok) throw new Error("Discord API " + response.status + ": " + (await response.text()).slice(0, 240));
  return response.status === 204 ? null : response.json();
}

export const __test = Object.freeze({
  buildWeeklyDigestPayload,
  formatDigestMember,
});
