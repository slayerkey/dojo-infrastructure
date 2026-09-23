import test from "node:test";
import assert from "node:assert/strict";

import {
  __test as core,
  SEVEN_DAYS_MS,
  noteThreadEvent,
  observeRiotLink,
  recordLiveActivationMessage,
} from "../src/activation-core.js";
import { beginActivationBackfill, getRetryAfterMs } from "../src/activation-backfill.js";
import {
  claimActivationCommandRegistration,
  completeActivationCommandRegistration,
  failActivationCommandRegistration,
} from "../src/activation-audit.js";

const anchor = "2026-09-01T00:00:00.000Z";

function record(overrides = {}) {
  return core.mergeTenureIntoRecord(
    { membership_active: true, ...overrides },
    "100",
    { discord_user_id: "100", first_eligible_at: anchor, active: overrides.membership_active ?? true },
  );
}

function message(userId, timestamp, extra = {}) {
  return {
    author: { id: String(userId), bot: false },
    timestamp,
    ...extra,
  };
}

test("direct introduction records earliest qualifying post", () => {
  let r = record();
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-01T01:00:00Z"), destinationKey: "introductions" });
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-01T02:00:00Z"), destinationKey: "introductions" });
  assert.equal(core.deriveMember(r).introduction_at, "2026-09-01T01:00:00.000Z");
});

test("two replies require two distinct other members", () => {
  let r = record();
  const reply = (target, time) => message("100", time, {
    message_reference: { message_id: "x" },
    referenced_message: { author: { id: String(target) } },
  });
  r = core.applyActivationMessage(r, { message: reply("200", "2026-09-01T01:00:00Z"), destinationKey: "introductions" });
  r = core.applyActivationMessage(r, { message: reply("200", "2026-09-01T02:00:00Z"), destinationKey: "introductions" });
  assert.equal(core.deriveMember(r).replied_to_two_members, false);
  r = core.applyActivationMessage(r, { message: reply("300", "2026-09-01T03:00:00Z"), destinationKey: "introductions" });
  assert.equal(core.deriveMember(r).replied_to_two_members, true);
  assert.equal(r.intro_reply_targets.length, 2);
});

test("forum introduction belongs to thread owner and comments count as member interactions", () => {
  let owner = record();
  owner = core.applyActivationMessage(owner, {
    message: message("100", "2026-09-01T01:00:00Z"),
    destinationKey: "introductions",
    threadOwnerId: "100",
  });
  assert.equal(core.deriveMember(owner).introduction_posted, true);

  let commenter = core.mergeTenureIntoRecord({}, "400", { first_eligible_at: anchor, active: true });
  commenter = core.applyActivationMessage(commenter, {
    message: message("400", "2026-09-01T01:05:00Z"),
    destinationKey: "introductions",
    threadOwnerId: "100",
  });
  assert.equal(core.deriveMember(commenter).introduction_posted, false);
  assert.equal(commenter.intro_reply_targets[0].user_id, "100");
});

test("training, general and goal milestones are classified correctly", () => {
  let r = record();
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-01T02:00:00Z"), destinationKey: "training" });
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-01T03:00:00Z"), destinationKey: "general" });
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-01T04:00:00Z"), destinationKey: "goals" });
  const d = core.deriveMember(r);
  assert.equal(d.first_training_post, true);
  assert.equal(d.first_general_message, true);
  assert.equal(d.goal_posted, true);
});

test("forum training/goal/win only credit the thread owner", () => {
  for (const destinationKey of ["training", "goals", "wins"]) {
    let commenter = record();
    commenter = core.applyActivationMessage(commenter, {
      message: message("100", "2026-09-01T03:00:00Z"),
      destinationKey,
      threadOwnerId: "999",
    });
    const d = core.deriveMember(commenter);
    if (destinationKey === "training") assert.equal(d.first_training_post, false);
    if (destinationKey === "goals") assert.equal(d.goal_posted, false);
    if (destinationKey === "wins") assert.equal(d.first_win_posted, false);

    let owner = record();
    owner = core.applyActivationMessage(owner, {
      message: message("100", "2026-09-01T03:00:00Z"),
      destinationKey,
      threadOwnerId: "100",
    });
    const od = core.deriveMember(owner);
    if (destinationKey === "training") assert.equal(od.first_training_post, true);
    if (destinationKey === "goals") assert.equal(od.goal_posted, true);
    if (destinationKey === "wins") assert.equal(od.first_win_posted, true);
  }
});

test("win at exactly seven days qualifies and later win does not", () => {
  let exact = record();
  exact = core.applyActivationMessage(exact, {
    message: message("100", new Date(Date.parse(anchor) + SEVEN_DAYS_MS).toISOString()),
    destinationKey: "wins",
  });
  assert.equal(core.deriveMember(exact).first_win_within_7_days, true);

  let late = record();
  late = core.applyActivationMessage(late, {
    message: message("100", new Date(Date.parse(anchor) + SEVEN_DAYS_MS + 1).toISOString()),
    destinationKey: "wins",
  });
  assert.equal(core.deriveMember(late).first_win_within_7_days, false);
});

test("pre-membership messages never create milestones", () => {
  let r = record();
  r = core.applyActivationMessage(r, {
    message: message("100", "2026-08-31T23:59:59Z"),
    destinationKey: "wins",
  });
  assert.equal(core.deriveMember(r).first_win_posted, false);
});

test("unknown anchor stores factual historical evidence without turning it into timed activation", () => {
  let r = core.mergeTenureIntoRecord({}, "100", { active: true });
  r = core.applyActivationMessage(r, {
    message: message("100", "2026-08-15T12:00:00Z"),
    destinationKey: "introductions",
  });
  const d = core.deriveMember(r);
  assert.equal(d.anchor_valid, false);
  assert.equal(d.introduction_posted, false);
  assert.equal(d.introduction_observed, true);
  assert.equal(d.observed_introduction_at, "2026-08-15T12:00:00.000Z");
});

test("unknown activation anchor stays unknown instead of becoming false activation data", () => {
  const r = core.mergeTenureIntoRecord({}, "100", { active: true });
  const d = core.deriveMember(r);
  assert.equal(d.anchor_valid, false);
  assert.equal(d.first_win_posted, false);
});

test("inactive members remain represented in audit model", () => {
  const r = core.mergeTenureIntoRecord({}, "100", { first_eligible_at: anchor, active: false });
  const audit = core.buildAuditModel([r]);
  assert.equal(audit.total_members, 1);
  assert.equal(audit.members[0].membership_active, false);
});

test("historical newest-first processing remains idempotent and keeps the earliest event", () => {
  let r = record();
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-03T00:00:00Z"), destinationKey: "wins" });
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-02T00:00:00Z"), destinationKey: "wins" });
  r = core.applyActivationMessage(r, { message: message("100", "2026-09-02T00:00:00Z"), destinationKey: "wins" });
  assert.equal(core.deriveMember(r).first_win_at, "2026-09-02T00:00:00.000Z");
});

test("audit denominators exclude unknown anchors for time-based milestones", () => {
  const known = record();
  const unknown = core.mergeTenureIntoRecord({}, "200", { active: true });
  const audit = core.buildAuditModel([known, unknown]);
  const wins = audit.metrics.find((m) => m.key === "first_win_within_7_days");
  assert.equal(wins.denominator, 1);
  assert.equal(audit.unknown_anchor_members, 1);
});

test("Discord 429 retry behavior uses the larger retry_after signal with a one-second floor", () => {
  const headers = { get(name) { return name === "X-RateLimit-Reset-After" ? "2.5" : null; } };
  assert.equal(getRetryAfterMs({ retry_after: 1.2 }, headers), 2500);
  assert.equal(getRetryAfterMs({}, { get() { return null; } }), 1000);
});


test("backfill start/resume is idempotent and does not clear member records", async () => {
  const values = new Map([["activation:v3:member:100", { discord_user_id: "100", first_win_at: "2026-09-02T00:00:00.000Z" }]]);
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
  };
  const gateway = { ctx: { storage } };

  const first = await beginActivationBackfill(gateway);
  assert.equal(first.status, "running");
  assert.equal(first.phase, "seed");

  const running = { ...first, phase: "scan", source_index: 3, status: "running" };
  values.set("activation:v3:backfill", running);
  const resumed = await beginActivationBackfill(gateway);
  assert.equal(resumed.phase, "scan");
  assert.equal(resumed.source_index, 3);
  assert.equal(values.get("activation:v3:member:100").first_win_at, "2026-09-02T00:00:00.000Z");

  values.set("activation:v3:backfill", { ...resumed, status: "complete", phase: "complete" });
  const rerun = await beginActivationBackfill(gateway);
  assert.equal(rerun.phase, "seed");
  assert.equal(values.get("activation:v3:member:100").first_win_at, "2026-09-02T00:00:00.000Z");
});


test("activation command registration dedupes, rechecks periodically, and retries errors", async () => {
  const state = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const gateway = {
    ctx: {
      storage: {
        async get(key) { return state.get(key); },
        async put(key, value) { state.set(key, clone(value)); },
      },
    },
  };

  assert.equal(await claimActivationCommandRegistration(gateway, "activation-v3"), true);
  assert.equal(await claimActivationCommandRegistration(gateway, "activation-v3"), false);

  await completeActivationCommandRegistration(gateway, "activation-v3");
  assert.equal(await claimActivationCommandRegistration(gateway, "activation-v3"), false);

  state.set("activation:v3:command-registration", {
    version: "activation-v3",
    status: "complete",
    updated_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(await claimActivationCommandRegistration(gateway, "activation-v3"), true);

  await failActivationCommandRegistration(gateway, "activation-v3", "test");
  assert.equal(await claimActivationCommandRegistration(gateway, "activation-v3"), true);
});


test("live tracking ignores Discord users outside the known Dojo cohort", async () => {
  const values = new Map();
  const gateway = {
    env: { DISCORD_BOT_TOKEN: "unused" },
    ctx: {
      storage: {
        async get(key) { return values.get(key); },
        async put(key, value) { values.set(key, value); },
      },
    },
    async getTenureRecord() { return null; },
  };

  const result = await recordLiveActivationMessage(gateway, {
    channel_id: "1532854321723478217",
    author: { id: "999", bot: false },
    timestamp: "2026-09-01T01:00:00.000Z",
  });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, "not_known_dojo_member");
  assert.equal(values.size, 0);
});

test("live tracking accepts known tenure member without relying on Discord role snapshot", async () => {
  const values = new Map();
  const gateway = {
    env: { DISCORD_BOT_TOKEN: "unused" },
    ctx: {
      storage: {
        async get(key) { return values.get(key); },
        async put(key, value) { values.set(key, value); },
      },
    },
    async getTenureRecord(userId) {
      return { discord_user_id: String(userId), first_eligible_at: anchor, active: true };
    },
  };

  const result = await recordLiveActivationMessage(gateway, {
    channel_id: "1532854321723478217",
    author: { id: "100", bot: false },
    timestamp: "2026-09-01T01:00:00.000Z",
  });

  assert.equal(result.recorded, true);
  assert.equal(core.deriveMember(values.get("activation:v3:member:100")).first_general_message, true);
});

test("thread cache stores only activation destination threads", async () => {
  const values = new Map();
  const gateway = {
    ctx: {
      storage: {
        async put(key, value) { values.set(key, value); },
      },
    },
  };

  await noteThreadEvent(gateway, { id: "thread-1", parent_id: "not-activation", owner_id: "100" });
  assert.equal(values.size, 0);

  await noteThreadEvent(gateway, { id: "thread-2", parent_id: "1532854569946583300", owner_id: "100" });
  assert.equal(values.get("activation:v3:thread:thread-2").destination_key, "wins");
});


test("forum milestones do not fall back to direct-channel credit when thread owner is unknown", () => {
  for (const destinationKey of ["introductions", "training", "goals", "wins"]) {
    let r = record();
    r = core.applyActivationMessage(r, {
      message: message("100", "2026-09-01T05:00:00Z"),
      destinationKey,
      threadOwnerId: null,
      isThread: true,
    });
    const d = core.deriveMember(r);
    if (destinationKey === "introductions") assert.equal(d.introduction_posted, false);
    if (destinationKey === "training") assert.equal(d.first_training_post, false);
    if (destinationKey === "goals") assert.equal(d.goal_posted, false);
    if (destinationKey === "wins") assert.equal(d.first_win_posted, false);
  }
});


test("Riot activation observation ignores users outside the known Dojo cohort", async () => {
  const values = new Map();
  const gateway = {
    env: {
      RR_TRACKER: {
        async getCurrentRiotLink() { return { ok: true, riot_id: "Test#NA1" }; },
      },
    },
    ctx: {
      storage: {
        async get(key) { return values.get(key); },
        async put(key, value) { values.set(key, value); },
      },
    },
    async getTenureRecord() { return null; },
  };

  const result = await observeRiotLink(gateway, "999", "test");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_known_dojo_member");
  assert.equal(values.size, 0);
});
