import {
  buildActivationV40Model,
  identityFromGuildMember,
  previousSevenPhoenixDateKeys,
} from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";

export async function postWeeklyDigest(env, stub, channelId, options = {}) {
  if (!channelId) throw new Error("No Weekly Digest channel is configured.");

  // Live THREAD_CREATE/THREAD_UPDATE events keep task stages fresh continuously.
  // The digest also performs a full task-forum safety scan immediately before
  // it builds the weekly snapshot so a missed gateway event cannot leave the
  // report stale. Fail open so a Discord archive hiccup never blocks the digest.
  if (typeof stub?.scanTaskStagesV47 === "function") {
    await stub.scanTaskStagesV47().catch((error) => {
      console.error("Weekly Digest task-stage safety scan failed; continuing with stored stages:", error);
    });
  }

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
      member.community_participated &&
      Number(member.messages_last_7_days || 0) > 0 &&
      !member.first_win_posted,
  );
  const activated = members.filter((member) => member.first_win_posted);

  const embeds = [{
    title: options.title || "📊 Weekly Digest",
    description: [
      "**The funnel:** Onboarding → Community Participation → First Win",
      "",
      `**Current members:** ${members.length}`,
      `🚨 No message evidence found: **${neverStarted.length}**`,
      `👋 Onboarded, not in community: **${onboardedNotSocial.length}**`,
      `💤 Participated before, 0 msgs / 7d: **${lapsed.length}**`,
      `🏆 Active, no first win: **${activeNoWin.length}**`,
      `✅ First win posted: **${activated.length}**`,
      "",
      "**Community Participation** = tracked activity in General, Community Help, or Clips.",
      "**No message evidence found** is conservative: recent tracked messages, activation posts, and task submissions all count as evidence.",
    ].join("\n"),
    footer: { text: options.footer || "Current Dojo members only." },
    timestamp: new Date().toISOString(),
  }];

  appendDigestGroup(embeds, "🚨 NO MESSAGE EVIDENCE FOUND", neverStarted);
  appendDigestGroup(embeds, "👋 ONBOARDED · NOT IN COMMUNITY", onboardedNotSocial);
  appendDigestGroup(embeds, "💤 LAPSED · 0 MSGS / 7D", lapsed);
  appendDigestGroup(embeds, "🏆 ACTIVE · NO FIRST WIN", activeNoWin);

  if (!neverStarted.length && !onboardedNotSocial.length && !lapsed.length && !activeNoWin.length) {
    embeds.push({
      title: "✅ No members need a check",
      description: "Every current member has community participation, recent activity, and a tracked first win.",
    });
  }

  return {
    content: "",
    embeds: embeds.slice(0, 10),
    allowed_mentions: { parse: [] },
  };
}

function appendDigestGroup(embeds, label, members) {
  if (!members.length) return;
  const sorted = members
    .slice()
    .sort((a, b) => {
      const aCount = Number(a.messages_last_7_days || 0);
      const bCount = Number(b.messages_last_7_days || 0);
      return aCount - bCount || String(a.display_name || "").localeCompare(String(b.display_name || ""));
    });

  const chunkSize = 15;
  for (let offset = 0; offset < sorted.length && embeds.length < 10; offset += chunkSize) {
    const chunk = sorted.slice(offset, offset + chunkSize);
    embeds.push({
      title: offset === 0 ? `${label} — ${members.length}` : `${label} (cont.)`,
      fields: chunk.map((member) => buildDigestMemberField(member)),
    });
  }
}

export function buildDigestMemberField(member) {
  const id = String(member?.discord_user_id || "");
  const mention = id ? "<@" + id + ">" : "Unknown member";
  let fallback;
  if (member?.username) fallback = "`@" + String(member.username).replace(/`/g, "") + "`";
  else if (member?.display_name && !String(member.display_name).startsWith("Unknown member")) fallback = "`" + String(member.display_name).replace(/`/g, "") + "`";
  else if (id) fallback = "`ID " + id + "`";
  else fallback = "`Unresolved`";

  const count = Math.max(0, Number(member?.messages_last_7_days || 0));
  const intro = member?.introduction_posted ? "✅" : "❌";
  const community = member?.community_participated ? "✅" : "❌";
  const win = member?.first_win_posted ? "✅" : "❌";
  const task = formatTaskStage(member);

  const responseLabels = {
    community_still_improving: "Still improving",
    snooze: "Hasn't played much",
    stuck: "Stuck",
    community_break: "Taking a break",
    community_details: "Details submitted",
  };
  const response = responseLabels[member?.last_intervention] || null;
  const note = String(member?.community_note || "").trim();

  const value = [
    "```text",
    "Intro   Community   Task        Win   7d",
    padCell(intro, 7) + " " + padCell(community, 11) + " " + padCell(task, 11) + " " + padCell(win, 5) + " " + count,
    "```",
    response ? `**Reply:** ${response}` : null,
    note ? `**Note:** ${escapeDigestText(note).slice(0, 180)}` : null,
  ].filter(Boolean).join("\n");

  return {
    name: mention + " · " + fallback,
    value,
    inline: false,
  };
}

export function formatDigestMember(member) {
  const field = buildDigestMemberField(member);
  return field.name + "\n" + field.value;
}

function formatTaskStage(member) {
  const label = String(member?.task_stage_label || "").trim();
  const stage = Number(member?.task_stage || 0);
  if (/month\s*2/i.test(label)) return "Month 2";
  if (label) {
    const numbered = /#\s*(\d+)/i.exec(label);
    if (numbered) return "#" + numbered[1];
  }
  return stage > 0 ? "#" + stage : "—";
}

function padCell(value, width) {
  const text = String(value || "");
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function escapeDigestText(value) {
  return String(value || "")
    .replace(/@/g, "@\u200b")
    .replace(/\r?\n/g, " ")
    .trim();
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
  buildDigestMemberField,
  formatDigestMember,
  formatTaskStage,
});
