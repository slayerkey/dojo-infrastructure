import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  applyInterventionAction,
  buildActivationV40Model,
  identityFromGuildMember,
  isPrivateTextChannel,
  resolveDisplayName,
  summarizeActivity,
  validateTeamApplication,
} from "../src/activation-v40-core.js";
import {
  __test as v40,
  completeOrganizerApplication,
  completeTeamApplication,
  getActivationV40Snapshot,
  recordActivationCheckinWin,
  saveTeamApplicationDraft,
  updateOrganizerApplicationStatus,
  updateTeamApplicationStatus,
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
  const queuedIds = new Set(Object.values(model.queue).flat().map((item) => item.discord_user_id));
  assert.deepEqual([...queuedIds], ["100"]);
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

test("stuck status can overlap with zero-message dormancy", () => {
  const intervention = applyInterventionAction(null, "stuck", "2026-09-04T00:00:00.000Z", "stuck-1").state;
  const model = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    interventions: { "100": intervention },
    now: new Date(Date.parse(anchor) + 8 * DAY_MS),
  });
  assert.equal(model.queue.stuck.length, 1);
  assert.equal(model.queue.day7.length, 1);
  assert.equal(model.queue.dormant.length, 1);
  assert.equal(model.queue.attention.length, 1);
  assert.equal(model.queue.attention[0].stuck, true);
  assert.equal(model.queue.attention[0].dormant, true);
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

test("v40 owner queue uses clickable mentions only for known current member IDs", () => {
  const line = v40.formatQueueMember({
    discord_user_id: "100",
    display_name: "Example User",
    days_since_activation: 7,
    first_win_posted: false,
    messages_last_7_days: 0,
    no_win_stage: "day7",
    dormant: true,
    stuck: false,
  });
  assert.equal(line.includes("<@100>"), true);
  assert.equal(line.includes("@unknown-user"), false);
  assert.match(line, /7\+ DAY NO WIN/);
  assert.match(line, /0 MSGS \/ 7D/);
});


test("team application inbox rejects a channel-level public override on a private category", () => {
  const parent = {
    type: 4,
    permission_overwrites: [{ id: "guild", type: 0, deny: "1024", allow: "0" }],
  };
  const inheritedPrivate = { type: 0, permission_overwrites: [] };
  assert.equal(isPrivateTextChannel(inheritedPrivate, "guild", parent), true);

  const publicOverride = {
    type: 0,
    permission_overwrites: [{ id: "guild", type: 0, deny: "0", allow: "1024" }],
  };
  assert.equal(isPrivateTextChannel(publicOverride, "guild", parent), false);
});


test("first-win modal submission is idempotent and never creates a second first win", async () => {
  const { values, storage } = mockStorage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
  ]);
  const gateway = {
    ctx: { storage },
    async getTenureRecord(userId) { return values.get(`tenure:${userId}`) || null; },
  };

  const first = await recordActivationCheckinWin(
    gateway,
    "100",
    "2026-09-04T00:00:00.000Z",
    "win-interaction-1",
    { discord_user_id: "100", username: "winner", last_identity_seen_at: "2026-09-04T00:00:00.000Z" },
  );
  assert.equal(first.ok, true);
  assert.equal(first.already_recorded, false);

  const retry = await recordActivationCheckinWin(
    gateway,
    "100",
    "2026-09-04T00:01:00.000Z",
    "win-interaction-1",
    { discord_user_id: "100", username: "winner", last_identity_seen_at: "2026-09-04T00:01:00.000Z" },
  );
  assert.equal(retry.duplicate, true);
  assert.equal(retry.already_recorded, true);

  const laterAttempt = await recordActivationCheckinWin(
    gateway,
    "100",
    "2026-09-06T00:00:00.000Z",
    "win-interaction-2",
    { discord_user_id: "100", username: "winner", last_identity_seen_at: "2026-09-06T00:00:00.000Z" },
  );
  assert.equal(laterAttempt.already_recorded, true);
  assert.equal(values.get("activation:v3:member:100").first_win_at, "2026-09-04T00:00:00.000Z");
});


test("manual Day 3 outreach suppresses duplicate Day 3 nudges but still escalates on Day 7", () => {
  const contacted = applyInterventionAction(
    null,
    "contacted_day3",
    "2026-09-04T00:00:00.000Z",
    "owner-mark-day3",
  ).state;

  const day4 = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 1 },
    interventions: { "100": contacted },
    now: new Date("2026-09-05T00:00:00.000Z"),
  });
  assert.equal(day4.queue.day3.length, 0);
  assert.equal(day4.queue.day7.length, 0);

  const day7 = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 1 },
    interventions: { "100": contacted },
    now: new Date("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(day7.queue.day3.length, 0);
  assert.equal(day7.queue.day7.length, 1);
});

test("manual Day 7 outreach suppresses duplicate nudges for seven days and then can resurface", () => {
  const contacted = applyInterventionAction(
    null,
    "contacted_day7",
    "2026-09-08T00:00:00.000Z",
    "owner-mark-day7",
  ).state;

  const withinCooldown = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    interventions: { "100": contacted },
    now: new Date("2026-09-12T00:00:00.000Z"),
  });
  assert.equal(withinCooldown.queue.day7.length, 0);
  assert.equal(withinCooldown.queue.dormant.length, 1);
  assert.equal(withinCooldown.queue.attention.length, 1);

  const afterCooldown = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    interventions: { "100": contacted },
    now: new Date("2026-09-16T00:00:01.000Z"),
  });
  assert.equal(afterCooldown.queue.day7.length, 1);
});

test("replayed team application modal stays idempotent after the draft is deleted", async () => {
  const { storage } = mockStorage();
  const gateway = { ctx: { storage } };

  await saveTeamApplicationDraft(gateway, "100", {
    region: "NA",
    current_rank: "Gold 3",
    peak_rank: "Platinum 2",
    created_at: new Date().toISOString(),
  });

  const fields = {
    role_agents: "Duelist — Jett",
    availability: "Evenings MST",
    tracker_link: "https://tracker.gg/valorant/profile/replay-test",
    team_goal: "Play consistent Premier.",
  };
  const identity = {
    discord_user_id: "100",
    display_name: "Replay Test",
    username: "replaytest",
    last_identity_seen_at: new Date().toISOString(),
  };

  const first = await completeTeamApplication(gateway, "100", "same-modal", fields, identity);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);

  const retry = await completeTeamApplication(gateway, "100", "same-modal", fields, identity);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.application.submitted_at, first.application.submitted_at);
});


test("zero-message dormancy overlaps with Day 7 no-win instead of hiding it", () => {
  const model = buildActivationV40Model({
    records: [activationRecord("100")],
    currentMembers: [guildMember("100")],
    totals: { "100": 0 },
    now: new Date(Date.parse(anchor) + 8 * DAY_MS),
  });
  assert.equal(model.queue.day7.length, 1);
  assert.equal(model.queue.dormant.length, 1);
  assert.equal(model.queue.attention.length, 1);
  assert.equal(model.queue.attention[0].needs_first_win, true);
  assert.equal(model.queue.attention[0].dormant, true);
});

test("quick Premier application does not require a team-goal essay", () => {
  const result = validateTeamApplication({
    region: "EU",
    current_rank: "Diamond 1",
    peak_rank: "Ascendant 1",
    role_agents: "Initiator — Sova",
    availability: "Weeknights CET",
    tracker_link: "https://tracker.gg/valorant/profile/quick",
  });
  assert.equal(result.region, "EU");
  assert.equal(result.team_goal, null);
});


test("Premier region helpers use flag-first North America and Europe labels", () => {
  assert.equal(v40.regionFlag("NA"), "🇺🇸");
  assert.equal(v40.regionName("NA"), "North America");
  assert.equal(v40.regionFlag("EU"), "🇪🇺");
  assert.equal(v40.regionName("EU"), "Europe");
});

test("Premier organizer application renders as a box with status first and no waitlist button", () => {
  const application = {
    discord_user_id: "100",
    display_name: "Applicant",
    region: "NA",
    status: "pending",
    current_rank: "Diamond 1",
    peak_rank: "Ascendant 1",
    role_agents: "Controller — Omen",
    availability: "Weeknights MST",
    tracker_link: "https://tracker.gg/valorant/profile/example",
    submitted_at: "2026-09-21T10:00:00.000Z",
  };
  const embed = v40.buildTeamApplicationEmbed(application);
  assert.equal(embed.title, "🇺🇸 North America Premier Application");
  assert.equal(embed.fields[0].name, "Status");
  assert.match(embed.fields[0].value, /PENDING/);
  const buttons = v40.teamApplicationStatusButtons(application)[0].components;
  assert.deepEqual(buttons.map((button) => button.label), ["Accept", "Decline"]);
});

test("decline reason is stored internally and shown on the organizer box", async () => {
  const { values, storage } = mockStorage([
    ["teamapp:v40:application:100", {
      discord_user_id: "100",
      display_name: "Applicant",
      region: "EU",
      status: "pending",
      current_rank: "Gold 3",
      peak_rank: "Platinum 2",
      role_agents: "Sentinel — Cypher",
      availability: "Weekends CET",
      tracker_link: "https://tracker.gg/valorant/profile/example",
      submitted_at: "2026-09-21T10:00:00.000Z",
    }],
  ]);
  const gateway = { ctx: { storage } };
  const updated = await updateTeamApplicationStatus(gateway, "100", "declined", "owner", "Need a more consistent schedule.");
  assert.equal(updated.ok, true);
  assert.equal(updated.application.status, "declined");
  assert.equal(updated.application.decision_reason, "Need a more consistent schedule.");
  const embed = v40.buildTeamApplicationEmbed(updated.application);
  assert.equal(embed.fields.at(-1).name, "Decline Reason");
  assert.match(embed.fields.at(-1).value, /consistent schedule/);
});

test("tracker.gg links without https are normalized for the short Premier application", () => {
  const result = validateTeamApplication({
    region: "NA",
    current_rank: "Diamond 1",
    peak_rank: "Ascendant 1",
    role_agents: "Initiator — Sova",
    availability: "Weeknights MST",
    tracker_link: "tracker.gg/valorant/profile/riot/example",
  });
  assert.equal(result.tracker_link, "https://tracker.gg/valorant/profile/riot/example");
});


test("Premier application accepts Riot ID#TAG without throwing away the form", () => {
  const result = validateTeamApplication({
    region: "NA",
    current_rank: "Diamond 1",
    peak_rank: "Ascendant 1",
    role_agents: "Controller — Omen",
    availability: "Weeknights MST",
    tracker_link: "Slayerkey#YOLO",
  });
  assert.equal(result.tracker_link, "Slayerkey#YOLO");
});

test("owner roadmap test record is excluded from activation analytics snapshots", async () => {
  const { storage } = mockStorage([
    ["activation:v3:member:owner", {
      discord_user_id: "owner",
      activation_started_at: anchor,
      roadmap_test_record: true,
    }],
    ["activation:v3:member:100", {
      discord_user_id: "100",
      activation_started_at: anchor,
    }],
  ]);
  const gateway = {
    ctx: { storage },
    async listTenureRecords() { return []; },
  };
  const snapshot = await getActivationV40Snapshot(gateway);
  assert.deepEqual(snapshot.records.map((record) => record.discord_user_id), ["100"]);
});

test("Premier Team Organizer application stores separately from player application", async () => {
  const { values, storage } = mockStorage();
  const gateway = { ctx: { storage } };
  const result = await completeOrganizerApplication(
    gateway,
    "100",
    "organizer-interaction",
    {
      region: "EU",
      riot_or_tracker: "Organizer#1234",
      availability: "Evenings CET",
      why_organize: "I like scheduling and keeping groups moving.",
      experience: "Ran a collegiate team Discord.",
    },
    {
      discord_user_id: "100",
      display_name: "Organizer",
      username: "organizer",
      last_identity_seen_at: new Date().toISOString(),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.application.application_type, "organizer");
  assert.equal(result.application.region, "EU");
  assert.equal(values.has("teamapp:v43:organizer:100"), true);
  assert.equal(values.has("teamapp:v40:application:100"), false);

  const embed = v40.buildOrganizerApplicationEmbed(result.application);
  assert.equal(embed.title, "🧑‍✈️ Premier Team Organizer Application");
  assert.equal(embed.fields[0].name, "Status");
  assert.equal(embed.fields[1].name, "Region");
  assert.match(embed.fields[1].value, /Europe/);

  const buttons = v40.organizerApplicationStatusButtons(result.application)[0].components;
  assert.deepEqual(buttons.map((button) => button.label), ["Accept", "Decline"]);
});

test("organizer decline reason is stored", async () => {
  const { storage } = mockStorage([
    ["teamapp:v43:organizer:100", {
      application_type: "organizer",
      discord_user_id: "100",
      region: "NA",
      status: "pending",
      riot_or_tracker: "Test#NA1",
      availability: "Weeknights",
      why_organize: "I can organize schedules.",
      submitted_at: "2026-09-21T10:00:00.000Z",
    }],
  ]);
  const gateway = { ctx: { storage } };
  const updated = await updateOrganizerApplicationStatus(
    gateway,
    "100",
    "declined",
    "owner",
    "Need more availability.",
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.application.status, "declined");
  assert.equal(updated.application.decision_reason, "Need more availability.");
});
