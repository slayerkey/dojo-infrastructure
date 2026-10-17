import test from "node:test";
import assert from "node:assert/strict";
import { __test as roadmap, ROADMAP_COMMANDS } from "../src/roadmap-v41.js";
import {
  scoreRoadmap, rankRoadmapMembers, buildLeaderboardMessage, buildRoadmapLeaderboard,
} from "../src/roadmap-leaderboard-v43.js";
import {
  selectStartHereChannel, welcomeMessage, greetNewDojoMember,
} from "../src/dojowelcome-v43.js";

const memberId = "123456789012345678";
const otherId = "223456789012345678";
const env = {
  DISCORD_GUILD_ID: "1494446702378221590",
  DISCORD_DOJO_ROLE_ID: "1524461044754550964",
  DISCORD_BOT_TOKEN: "test-bot-token",
};

const state = {
  ok: true, discord_user_id: memberId, activation: {}, manual: { completed: ["month1_aim_mastery"] },
  tenure: null, task_stage: null, config: { channels: {} }, test_mode: false,
};

test("roadmap leaderboard is a registered command and a launcher button", () => {
  assert.ok(ROADMAP_COMMANDS.some((command) => command.name === "roadmap-leaderboard"));
  const card = roadmap.buildRoadmapCard();
  assert.ok(card.components[0].components.some((component) => component.custom_id === "roadmap:v41:leaderboard"));
  assert.ok(card.components[0].components.length <= 5);
});

test("each current user's roadmap controls bind to the owner's Discord ID", async () => {
  const stub = { async getRoadmapV41State() { return state; } };
  const view = await roadmap.buildRoadmapView(memberId, env, stub, false, true, { displayName: "MyReyna" });
  const ids = view.components.flatMap((row) => row.components.map((button) => button.custom_id).filter(Boolean));
  assert.match(view.embeds[0].title, /MyReyna/);
  assert.ok(ids.includes("roadmap:v41:refresh:owner:" + memberId));
  assert.ok(ids.includes("roadmap:v41:full:owner:" + memberId));

  const full = await roadmap.buildRoadmapSectionView(memberId, env, stub, "overview", false, { displayName: "MyReyna" });
  assert.match(full.embeds[0].title, /MyReyna/);
  const navigation = full.components.flatMap((row) => row.components.map((button) => button.custom_id).filter(Boolean));
  assert.ok(navigation.includes("roadmap:v41:section:days:owner:" + memberId));
  assert.ok(navigation.includes("roadmap:v41:refresh-section:overview:owner:" + memberId));
});

test("other members cannot refresh, navigate, or complete a different member's roadmap", () => {
  for (const action of [
    "roadmap:v41:refresh:owner:" + memberId,
    "roadmap:v41:full:owner:" + memberId,
    "roadmap:v41:section:days:owner:" + memberId,
    "roadmap:v41:refresh-section:days:owner:" + memberId,
    "roadmap:v41:complete:month1_aim_mastery:owner:" + memberId,
  ]) {
    assert.match(roadmap.resolveRoadmapOwnerAction(action, otherId, { type: 3 }).denied, /another member/);
    assert.ok(roadmap.resolveRoadmapOwnerAction(action, memberId, { type: 3 }).customId);
  }
  assert.match(roadmap.resolveRoadmapOwnerAction("roadmap:v41:refresh", memberId, { type: 3 }).denied, /old controls/);
  assert.match(roadmap.resolveRoadmapOwnerAction("roadmap:v41:full", memberId, { type: 3 }).denied, /old controls/);
  const launcher = { type: 3, message: { components: [{ components: [{ custom_id: "roadmap:v41:view" }] }] } };
  assert.equal(roadmap.resolveRoadmapOwnerAction("roadmap:v41:full", otherId, launcher).customId, "roadmap:v41:full");
});

test("leaderboard uses the exact 22 tracked task total and stable ties", () => {
  const scored = scoreRoadmap(state, [
    roadmap.buildRoadmapModel, roadmap.buildMonthOneModel, roadmap.buildMonthTwoModel, roadmap.buildMonthThreeModel,
  ]);
  assert.equal(scored.total, 22);
  assert.equal(scored.done, 1);
  const ranked = rankRoadmapMembers([
    { user_id: memberId, done: 5 }, { user_id: otherId, done: 5 },
    { user_id: "323456789012345678", done: 2 },
  ]);
  assert.deepEqual(ranked.map((row) => row.rank), [1, 1, 3]);
  const view = buildLeaderboardMessage({ rows: ranked, created_ms: Date.now() }, otherId);
  assert.match(view.embeds[0].description, /self-reported/);
  assert.deepEqual(view.allowed_mentions, { parse: [] });
});

test("leaderboard only counts active Dojo role holders, hides bots, and caches", async () => {
  let apiCalls = 0, stateCalls = 0, cached = null;
  const api = async (url) => {
    apiCalls += 1;
    assert.match(url, /guilds\/1494446702378221590\/members/);
    return [
      { user: { id: memberId, username: "Player" }, roles: [env.DISCORD_DOJO_ROLE_ID] },
      { user: { id: otherId }, roles: [] },
      { user: { id: "323456789012345678", bot: true }, roles: [env.DISCORD_DOJO_ROLE_ID] },
    ];
  };
  const stub = {
    async getRoadmapLeaderboardCache() { return cached; },
    async setRoadmapLeaderboardCache(row) { cached = row; },
    async getRoadmapV41State(id) { stateCalls += 1; assert.equal(id, memberId); return state; },
  };
  const builders = [roadmap.buildRoadmapModel, roadmap.buildMonthOneModel, roadmap.buildMonthTwoModel, roadmap.buildMonthThreeModel];
  const first = await buildRoadmapLeaderboard(env, stub, builders, { api, now: 10000 });
  const second = await buildRoadmapLeaderboard(env, stub, builders, { api, now: 20000 });
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  assert.equal(apiCalls, 1);
  assert.equal(stateCalls, 1);
});

test("welcome uses the unique start-here channel and one individual ping", async () => {
  assert.equal(selectStartHereChannel([{ id: "welcome-chan", name: "start-here", type: 0 }]), "welcome-chan");
  assert.equal(selectStartHereChannel([{ id: "a", name: "start-here", type: 0 }, { id: "b", name: "start-here", type: 0 }]), null);
  assert.match(welcomeMessage(memberId, "welcome-chan", "bots-chan"), /\/roadmap/);
  const claims = new Set();
  let sends = 0;
  const gateway = {
    env,
    async claimDojoWelcome(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    async releaseDojoWelcome(key) { claims.delete(key); },
    async getRoadmapV41Config() { return { channels: { start_here: "welcome-chan", bots: "bots-chan" } }; },
  };
  const api = async (url, _env, options) => {
    sends += 1;
    assert.match(url, /channels\/1532854321723478217\/messages/);
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [], users: [memberId] });
    assert.match(payload.content, /welcome-chan/);
    return { id: "message" };
  };
  assert.equal((await greetNewDojoMember(gateway, { user: { id: memberId } }, api)).sent, true);
  assert.equal((await greetNewDojoMember(gateway, { user: { id: memberId } }, api)).skipped, "already_welcomed");
  assert.equal(sends, 1);
  assert.equal((await greetNewDojoMember(gateway, { user: { id: otherId, bot: true } }, api)).skipped, "invalid_member_or_settings");
});
