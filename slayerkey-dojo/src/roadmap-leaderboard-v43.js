const DISCORD_API = "https://discord.com/api/v10";
const CACHE_KEY = "roadmap:v43:leaderboard-cache";
const CACHE_MS = 5 * 60 * 1000;
const MAX_MEMBERS = 2000;
const CONCURRENCY = 8;

async function discordJson(url, env) {
  const response = await fetch(url, { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } });
  if (!response.ok) throw new Error("Discord leaderboard lookup " + response.status + ": " + (await response.text()).slice(0, 200));
  return response.json();
}

async function currentDojoMembers(env, api = discordJson) {
  const dojoRole = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!dojoRole || !env.DISCORD_GUILD_ID) throw new Error("Dojo role/guild configuration missing.");
  let after = "0";
  const members = [];
  while (members.length < MAX_MEMBERS) {
    const page = await api(
      DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members?limit=1000&after=" + encodeURIComponent(after),
      env,
    );
    if (!Array.isArray(page)) throw new Error("Discord did not return the member list.");
    for (const member of page) {
      if (!member?.user?.bot && (member.roles || []).map(String).includes(dojoRole)) members.push(member);
    }
    if (page.length < 1000) break;
    const last = String(page[page.length - 1]?.user?.id || "");
    if (!last || last === after) break;
    after = last;
  }
  return members;
}

export function scoreRoadmap(state, modelBuilders) {
  const models = modelBuilders.map((build) => build(state));
  const done = models.reduce((sum, model) => sum + Number(model.completed || 0), 0);
  const total = models.reduce((sum, model) => sum + Number(model.total || 0), 0);
  return { done, total, percent: total ? Math.round(100 * done / total) : 0 };
}

export function rankRoadmapMembers(rows) {
  const sorted = [...rows].sort((a, b) => b.done - a.done || String(a.user_id).localeCompare(String(b.user_id)));
  let lastDone = null;
  let currentRank = 0;
  return sorted.map((row, index) => {
    if (lastDone !== row.done) currentRank = index + 1;
    lastDone = row.done;
    return { ...row, rank: currentRank };
  });
}

function displayName(member) {
  return String(member?.nick || member?.user?.global_name || member?.user?.username || "Member").slice(0, 50);
}

export async function buildRoadmapLeaderboard(env, stub, modelBuilders, options = {}) {
  if (!stub) throw new Error("Dojo storage unavailable.");
  const now = options.now ?? Date.now();
  const cached = await stub.getRoadmapLeaderboardCache();
  if (!options.forceRefresh && cached?.rows && now - Number(cached.created_ms || 0) < CACHE_MS && now >= Number(cached.created_ms || 0)) return cached;

  const members = await currentDojoMembers(env, options.api);
  const rows = [];
  for (let i = 0; i < members.length; i += CONCURRENCY) {
    const batch = await Promise.all(members.slice(i, i + CONCURRENCY).map(async (member) => {
      const userId = String(member.user?.id || "");
      if (!userId) return null;
      try {
        // These IDs were just verified against Discord's active paid-member role.
        const state = await stub.getRoadmapV41State(userId, false, true);
        if (!state?.ok || state.test_mode) return null;
        return { user_id: userId, name: displayName(member), ...scoreRoadmap(state, modelBuilders) };
      } catch (error) {
        console.warn("Leaderboard member unavailable:", userId, error?.message || error);
        return null;
      }
    }));
    rows.push(...batch.filter(Boolean));
  }
  const result = { created_ms: now, rows: rankRoadmapMembers(rows), members_scored: rows.length };
  await stub.setRoadmapLeaderboardCache(result);
  return result;
}

export function buildLeaderboardMessage(snapshot, viewerUserId, options = {}) {
  const rows = snapshot?.rows || [];
  const top = rows.slice(0, 10);
  const lines = top.map((row) =>
    "**#" + row.rank + "** <@" + row.user_id + "> — **" + row.done + "/" + row.total + "** (" + row.percent + "%)"
  );
  const viewer = rows.find((row) => row.user_id === String(viewerUserId || ""));
  if (viewer && !top.some((row) => row.user_id === viewer.user_id)) {
    lines.push("", "**Your standing:** #" + viewer.rank + " — " + viewer.done + "/" + viewer.total + " (" + viewer.percent + "%)");
  }
  return {
    content: "",
    embeds: [{
      title: "Dojo 90-Day Roadmap Leaderboard" + (options.label ? " — " + options.label : ""),
      description: [
        lines.length ? lines.join("\n") : "No verified Dojo members with roadmap data yet.",
        "",
        options.archived
          ? "**Archived month-end standings.** Total tasks completed by the snapshot date (cumulative), not tasks gained that month."
          : "**Current standings.** Total tracked tasks completed (cumulative), not RR.",
        "Some tasks are self-reported.",
        "Use /roadmap to see and update your own progress.",
      ].join("\n"),
      footer: { text: options.archived
        ? rows.length + " members · Frozen " + (options.capturedAt || "at month end") + " · Never recalculated"
        : rows.length + " current Dojo members scored · Refreshes at most every 5 minutes" },
    }],
    allowed_mentions: { parse: [] },
  };
}

export async function getRoadmapLeaderboardCache(gateway) {
  return gateway.ctx.storage.get(CACHE_KEY);
}

export async function setRoadmapLeaderboardCache(gateway, snapshot) {
  await gateway.ctx.storage.put(CACHE_KEY, snapshot);
}
