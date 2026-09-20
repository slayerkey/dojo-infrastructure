import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  applyInterventionAction,
  buildActivationV40Model,
  identityFromGuildMember,
  resolveDisplayName,
  summarizeActivity,
  validateTeamApplication,
} from "../src/activation-v40-core.js";
import {
  __test as v40,
  completeTeamApplication,
  recordActivationCheckinWin,
  saveTeamApplicationDraft,
} from "../src/activation-v40.js";

const anchor = "2026-09-01T00:00:00.000Z";

function guildMember(id, overrides = {}) {
  return {
    nick: overrides.nick ?? null,
    roles: ["dojo"],
    user: {
      id: String(id),
      username: overrides.username ?? `user${id}`,
      global_name: overrides.global_name ?? null,
      bot: false,
    },
  };
}

function activationRecord(id, overrides = {}) {
  return {
    discord_user_id: String(id),
    activation_started_at: anchor,
    membership_active: overrides.membership_active ?? true,
    ...overrides,
  };
}

function mockStorage(initial = []) {
  const values = new Map(initial);
  return {
    values,
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); },
      async list({ prefix } = {}) {
        return new Map([...values].filter(([key]) => !prefix || String(key).startsWith(prefix)));
      },
    },
  };
}

test("current member identity prefers nickname, then global name, then username", () => {
  const nick = identityFromGuildMember(guildMember("100", { nick: "Dojo Nick", global_name: "Global", username: "user" }));
  assert.equal(resolveDisplayName("100", nick, null), "Dojo Nick");

  const globalOnly = identityFromGuildMember(guildMember("101", { nick: null, global_name: "Global", username: "user" }));
  assert.equal(resolveDisplayName("101", globalOnly, null), "Global");

  const usernameOnly = identityFromGuildMember(guildMember("102", { nick: null, global_name: null, username: "fallbackuser" }));
  assert.equal(resolveDisplayName("102", usernameOnly, null), "fallbackuser");
});

test("historical stored identity is used when current guild identity is unavailable", () => {
  const stored = { discord_user_id: "200", global_name: "Historical Name", username: "olduser" };
  assert.equal(resolveDisplayName("200", null, stored), "Historical Name");
});

test("truly unresolved identity uses explicit Discord ID fallback and never @unknown-user", () => {
  const value = resolveDisplayName("999999", null, null);
  assert.equal(value, "Unknown member · Discord ID: 999999");
  assert.equal(value.includes("@unknown-user"), false);
});

test("first-win check-in writes the milestone to the submitting Discord user", async () => {
  const { values, storage } = mockStorage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
  ]);
  const gateway = {
    ctx: { storage },
    async getTenureRecord(userId) { return values.get(`tenure:${userId}`) || null; },
  };

  const result = await recordActivationCheckinWin(
    gateway,
    "100",
    "2026-09-04T00:00:00.000Z",
    "interaction-1",
    { discord_user_id: "100", username: "winner", last_identity_seen_at: "2026-09-04T00:00:00.000Z" },
  );

  assert.equal(result.ok, true);
  const stored = values.get("activation:v3:member:100");
  assert.equal(stored.discord_user_id, "100");
  assert.equal(stored.first_win_at, "2026-09-04T00:00:00.000Z");
  assert.equal(stored.first_win_source, "self_report_modal");
  assert.equal(values.get("activation:v40:intervention:100").status, "activated");
});

test("Day 3 and Day 7 intervention boundaries are exact and mutually exclusive", () => {
  const day3Now = new Date(Date.parse(anchor) + 3 * DAY_MS);
  const day3 = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 1 },
    now: day3Now,
  });
  assert.equal(day3.queue.day3.length, 1);
  assert.equal(day3.queue.day7.length, 0);

  const day7Now = new Date(Date.parse(anchor) + 7 * DAY_MS);
  const day7 = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 1 },
    now: day7Now,
  });
  assert.equal(day7.queue.day3.length, 0);
  assert.equal(day7.queue.day7.length, 1);
});

test("operational queue includes only current guild members even when inactive history exists", () => {
  const model = buildActivationV40Model({
    records: [
      activationRecord("100"),
      activationRecord("200", { membership_active: false }),
    ],
    currentMembers: [guildMember("100")],
    totals: { "100": 0, "200": 0 },
    now: new Date(Date.parse(anchor) + 8 * DAY_MS),
  });
  const queuedIds = Object.values(model.queue).flat().map((item) => item.discord_user_id);
  assert.deepEqual(queuedIds, ["100"]);
  assert.equal(model.historical_members, 2);
  assert.equal(model.current_members, 1);
});

test("intervention actions dedupe the same Discord interaction", () => {
  const first = applyInterventionAction(null, "stuck", "2026-09-04T00:00:00.000Z", "abc");
  const second = applyInterventionAction(first.state, "stuck", "2026-09-04T01:00:00.000Z", "abc");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.state, first.state);
});

test("stuck status is persisted and prioritized in the action queue", () => {
  const intervention = applyInterventionAction(null, "stuck", "2026-09-04T00:00:00.000Z", "stuck-1").state;
  const model = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    interventions: { "100": intervention },
    now: new Date(Date.parse(anchor) + 8 * DAY_MS),
  });
  assert.equal(model.queue.stuck.length, 1);
  assert.equal(model.queue.day7.length, 0);
  assert.equal(model.queue.dormant.length, 0);
});

test("haven't-played action snoozes intervention for seven days and removes member from queue", () => {
  const snooze = applyInterventionAction(null, "snooze", "2026-09-04T00:00:00.000Z", "snooze-1").state;
  assert.equal(snooze.status, "snoozed");
  assert.equal(snooze.snooze_until, "2026-09-11T00:00:00.000Z");

  const model = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    interventions: { "100": snooze },
    now: new Date("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(Object.values(model.queue).flat().length, 0);
});

test("weekly activity summary explicitly separates 0, 1-4 and 5+ messages", () => {
  const members = [guildMember("1"), guildMember("2"), guildMember("3"), guildMember("4")];
  const result = summarizeActivity(members, { "1": 0, "2": 1, "3": 4, "4": 5 });
  assert.deepEqual(
    { total: result.total, zero: result.zero, low: result.low, active: result.active },
    { total: 4, zero: 1, low: 2, active: 1 },
  );
});

test("team application validation keeps structured fields", () => {
  const result = validateTeamApplication({
    region: "na",
    current_rank: "Diamond 2",
    peak_rank: "Ascendant 1",
    role_agents: "Controller — Omen",
    availability: "Mon-Fri 7-10pm MST",
    tracker_link: "https://tracker.gg/valorant/profile/example",
    team_goal: "Practice seriously with a consistent five.",
  });
  assert.equal(result.region, "NA");
  assert.equal(result.current_rank, "Diamond 2");
  assert.equal(result.peak_rank, "Ascendant 1");
});

test("team application draft completes into pending structured storage", async () => {
  const { values, storage } = mockStorage();
  const gateway = { ctx: { storage } };

  await saveTeamApplicationDraft(gateway, "100", {
    region: "EU",
    current_rank: "Platinum 3",
    peak_rank: "Diamond 1",
    created_at: new Date().toISOString(),
  });

  const completed = await completeTeamApplication(
    gateway,
    "100",
    "application-interaction",
    {
      role_agents: "Initiator — Sova",
      availability: "Weeknights CET",
      tracker_link: "https://tracker.gg/valorant/profile/test",
      team_goal: "Find a stable competitive team.",
    },
    {
      discord_user_id: "100",
      display_name: "Applicant",
      username: "applicant",
      last_identity_seen_at: new Date().toISOString(),
    },
  );

  assert.equal(completed.ok, true);
  assert.equal(completed.application.status, "pending");
  assert.equal(completed.application.region, "EU");
  assert.equal(completed.application.display_name, "Applicant");
  assert.equal(values.has("teamapp:v40:draft:100"), false);
  assert.equal(values.get("teamapp:v40:application:100").tracker_link, "https://tracker.gg/valorant/profile/test");
});

test("v40 owner queue formatting never creates a raw Discord user mention", () => {
  const line = v40.formatQueueMember({
    display_name: "Example User",
    days_since_activation: 7,
    first_training_post: false,
    goal_posted: true,
    first_win_posted: false,
    messages_last_7_days: 0,
    last_intervention: null,
    last_intervention_at: null,
  });
  assert.equal(line.includes("<@"), false);
  assert.equal(line.includes("@unknown-user"), false);
});
