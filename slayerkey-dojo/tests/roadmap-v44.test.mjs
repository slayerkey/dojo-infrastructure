import test from "node:test";
import assert from "node:assert/strict";
import { ROADMAP_COMMANDS } from "../src/roadmap-v41.js";
import { buildLeaderboardMessage } from "../src/roadmap-leaderboard-v43.js";
import {
  resolveLeaderboardMonth, localPhoenixTime, monthLabel, isPhoenixMonthEndMinute,
  saveRoadmapMonth, readRoadmapMonth, captureRoadmapMonthEnd,
  getMonthlyLeaderboardMessage,
} from "../src/roadmap-monthly-v44.js";

const oct = new Date("2026-10-17T20:00:00.000Z");
const nov = new Date("2026-11-01T07:00:00.000Z");
const end = new Date("2026-11-01T06:59:00.000Z");
const guild = "1494446702378221590";
const role = "1524461044754550964";
const userId = "123456789012345678";
const env = { DISCORD_GUILD_ID: guild, DISCORD_DOJO_ROLE_ID: role, DISCORD_BOT_TOKEN: "test" };

function fakeStore() {
  const map = new Map();
  const storage = {
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async transaction(fn) { return fn(storage); },
  };
  return {
    map,
    ctx: { storage },
    async getRoadmapMonthlySnapshot(month) { return readRoadmapMonth(this, month); },
    async saveRoadmapMonthlySnapshot(month, snapshot) { return saveRoadmapMonth(this, month, snapshot); },
  };
}

test("optional month accepts September, Sep, YYYY-MM and defaults to current", () => {
  const current = resolveLeaderboardMonth(undefined, oct);
  assert.deepEqual(current, { kind: "current", month: "2026-10", label: "October 2026" });
  for (const input of ["September", "sep", "2026-09", "September 2026", "last month"]) {
    assert.deepEqual(resolveLeaderboardMonth(input, oct), {
      kind: "archive", month: "2026-09", label: "September 2026",
    });
  }
  assert.deepEqual(resolveLeaderboardMonth("October", oct), current);
  assert.equal(resolveLeaderboardMonth("2026-11", oct).error.includes("future"), true);
  assert.equal(resolveLeaderboardMonth("not a month", oct).error.includes("September"), true);
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.deepEqual(resolveLeaderboardMonth("December", new Date("2027-01-02T13:00:00Z")), {
    kind: "archive", month: "2026-12", label: "December 2026",
  });
});

test("the month boundary is Arizona-local, never UTC month-end", () => {
  assert.equal(isPhoenixMonthEndMinute(end), true);
  assert.equal(isPhoenixMonthEndMinute(new Date("2026-11-01T06:58:00Z")), false);
  assert.equal(isPhoenixMonthEndMinute(nov), false);
  assert.equal(localPhoenixTime(end).month, "2026-10");
  assert.equal(localPhoenixTime(nov).month, "2026-11");
});

test("missing September snapshot is explicit, not reconstructed from current scores", async () => {
  const gateway = fakeStore();
  const selection = resolveLeaderboardMonth("September", oct);
  const view = await getMonthlyLeaderboardMessage(selection, env, gateway, [], userId);
  assert.match(view.content, /No saved snapshot for September 2026/);
  assert.match(view.content, /won't substitute today's rankings/);
  assert.equal(view.embeds, undefined);
  assert.equal(gateway.map.size, 0);
});

test("snapshot storage is write-once, keeps the original leaderboard and scoring", async () => {
  const gateway = fakeStore();
  const initial = { rows: [{ user_id: userId, rank: 1, done: 15, total: 22, percent: 68 }], members_scored: 1 };
  const first = await gateway.saveRoadmapMonthlySnapshot("2026-10", initial);
  assert.equal(first.saved, true);
  const second = await gateway.saveRoadmapMonthlySnapshot("2026-10", {
    rows: [{ user_id: userId, rank: 1, done: 22, total: 22, percent: 100 }],
  });
  assert.equal(second.saved, false);
  const stored = await gateway.getRoadmapMonthlySnapshot("2026-10");
  assert.equal(stored.rows[0].done, 15);
  assert.equal(stored.month, "2026-10");
  const view = buildLeaderboardMessage(stored, userId, {
    label: "October 2026", archived: true, capturedAt: stored.captured_at,
  });
  assert.match(view.embeds[0].title, /October 2026/);
  assert.match(view.embeds[0].description, /Archived month-end standings/);
  assert.match(view.embeds[0].description, /15\/22/);
  assert.match(view.embeds[0].footer.text, /Never recalculated/);
});

test("snapshot job only captures in month-end minute and bypasses stale cache", async () => {
  const gateway = fakeStore();
  let apiCalls = 0;
  let stateCalls = 0;
  // Existing persisted live leaderboard cache is stale (September or October 31 earlier).
  gateway.getRoadmapLeaderboardCache = async () => ({
    created_ms: end.getTime() - 60000, rows: [{ user_id: userId, done: 1 }], members_scored: 1,
  });
  gateway.setRoadmapLeaderboardCache = async () => {};
  gateway.getRoadmapV41State = async () => {
    stateCalls++;
    return { ok: true, test_mode: false };
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    apiCalls++;
    return { ok: true, json: async () => [{ user: { id: userId, username: "Example" }, roles: [role] }] };
  };
  try {
    const skip = await captureRoadmapMonthEnd(oct, env, gateway, [() => ({ completed: 10, total: 22 })]);
    assert.equal(skip.skipped, "not_month_end");
    const saved = await captureRoadmapMonthEnd(end, env, gateway, [() => ({ completed: 10, total: 22 })]);
    assert.deepEqual(saved, { saved: true, month: "2026-10", members_scored: 1 });
    assert.equal(apiCalls, 1);
    assert.equal(stateCalls, 1);
    assert.equal((await gateway.getRoadmapMonthlySnapshot("2026-10")).rows[0].done, 10);
    const again = await captureRoadmapMonthEnd(end, env, gateway, []);
    assert.equal(again.skipped, "already_saved");
    assert.equal(apiCalls, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("command offers optional month as the only extra argument", () => {
  const command = ROADMAP_COMMANDS.find((cmd) => cmd.name === "roadmap-leaderboard");
  assert.equal(command.options.length, 1);
  assert.deepEqual(
    { name: command.options[0].name, type: command.options[0].type, required: command.options[0].required },
    { name: "month", type: 3, required: false },
  );
});
