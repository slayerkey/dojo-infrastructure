import test from "node:test";
import assert from "node:assert/strict";

import {
  __test as core,
  SEVEN_DAYS_MS,
} from "../src/activation-core.js";
import { getRetryAfterMs } from "../src/activation-backfill.js";

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
