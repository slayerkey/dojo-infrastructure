import test from "node:test";
import assert from "node:assert/strict";

import {
  __test as community,
  observeTaskThreadV47,
  observeV47Message,
} from "../src/community-activation-v47.js";
import { ACTIVATION_DESTINATIONS } from "../src/activation-core.js";

const anchor = "2026-09-01T00:00:00.000Z";

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

test("task tag parser recognizes numbered Fundamentals tags and Month 2", () => {
  assert.deepEqual(community.parseTaskStage("#1 - Main Agent"), { stage: 1, label: "#1 - Main Agent" });
  assert.deepEqual(community.parseTaskStage("#7 - Pre Round LEAD"), { stage: 7, label: "#7 - Pre Round LEAD" });
  assert.deepEqual(community.parseTaskStage("Month 2 - DM Review"), { stage: 8, label: "Month 2 - DM Review" });
  assert.equal(community.parseTaskStage("Random tag"), null);
});

test("task thread tracking stores the highest applied task stage without message content", async () => {
  const now = new Date().toISOString();
  const { values, storage } = mockStorage([
    ["taskstage:v47:tags", {
      updated_at: now,
      tags: {
        "tag1": "#1 - Main Agent",
        "tag4": "#4 - Daily Routine",
      },
    }],
  ]);
  const gateway = { ctx: { storage }, env: {} };

  const result = await observeTaskThreadV47(gateway, {
    id: "thread-1",
    parent_id: ACTIVATION_DESTINATIONS.training,
    owner_id: "100",
    applied_tags: ["tag1", "tag4"],
  });

  assert.equal(result.ok, true);
  const stored = values.get("taskstage:v47:member:100");
  assert.equal(stored.stage, 4);
  assert.equal(stored.label, "#4 - Daily Routine");
  assert.equal(Object.hasOwn(stored, "content"), false);
});

test("live General message records both first-any-message and community participation once", async () => {
  const { values, storage } = mockStorage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
    ["roadmap:v41:config", {
      channels: {
        general: ACTIVATION_DESTINATIONS.general,
      },
    }],
  ]);
  const gateway = {
    ctx: { storage },
    env: { DISCORD_BOT_TOKEN: "test" },
    async getTenureRecord(id) { return values.get("tenure:" + id) || null; },
  };

  const result = await observeV47Message(gateway, {
    channel_id: ACTIVATION_DESTINATIONS.general,
    timestamp: "2026-09-02T12:00:00.000Z",
    author: { id: "100", username: "member", global_name: "Member", bot: false },
    member: { nick: "Nick" },
    content: "this must never be stored",
  });

  assert.equal(result.ok, true);
  assert.equal(result.any_message, true);
  assert.equal(result.community_message, true);

  const stored = values.get("activation:v3:member:100");
  assert.equal(stored.first_any_message_at, "2026-09-02T12:00:00.000Z");
  assert.equal(stored.first_community_message_at, "2026-09-02T12:00:00.000Z");
  assert.equal(stored.first_community_message_source, "general");
  assert.equal(Object.hasOwn(stored, "content"), false);
});

test("unknown guild participants are not turned into Dojo activation records", async () => {
  const { values, storage } = mockStorage([
    ["roadmap:v41:config", {
      channels: { general: ACTIVATION_DESTINATIONS.general },
    }],
  ]);
  const gateway = {
    ctx: { storage },
    env: { DISCORD_BOT_TOKEN: "test" },
    async getTenureRecord() { return null; },
  };

  const result = await observeV47Message(gateway, {
    channel_id: ACTIVATION_DESTINATIONS.general,
    timestamp: "2026-09-02T12:00:00.000Z",
    author: { id: "999", username: "outsider", bot: false },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_known_dojo_member");
  assert.equal(values.has("activation:v3:member:999"), false);
});
