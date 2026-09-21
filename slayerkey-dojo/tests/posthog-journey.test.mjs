import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  handleCustomerIdentityBridge,
  pseudonymousWhopDistinctId,
  resolveCustomerPosthogIdentity,
  signIdentityBridgeBody,
  syncActivationPosthogMember,
} from "../src/posthog-journey.js";
import {
  looksAnnual,
  resolveDiscordUserId,
  tenureRoleKey,
} from "../src/index-v25.js";
import {
  ACTIVATION_DESTINATIONS,
  MEMBER_PREFIX,
  recordLiveActivationMessage,
} from "../src/activation-core.js";

const anchor = "2026-09-01T00:00:00.000Z";

function memoryStorage(initial = []) {
  const values = new Map(initial);
  return {
    values,
    storage: {
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async delete(key) { values.delete(key); },
      async list({ prefix } = {}) {
        return new Map(
          [...values.entries()]
            .filter(([key]) => !prefix || String(key).startsWith(prefix))
            .map(([key, value]) => [key, structuredClone(value)]),
        );
      },
    },
  };
}

function memoryKv(initial = []) {
  const values = new Map(initial);
  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      if (value == null) return null;
      if (type === "json") return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async put(key, value) { values.set(key, value); },
  };
}

function gatewayFixture({
  discordUserId = "900001",
  whopUserId = "user_private_123",
  posthogDistinctId = null,
  isAnnual = false,
  active = true,
  record = null,
  posthogOk = true,
} = {}) {
  const tenure = {
    discord_user_id: discordUserId,
    whop_user_id: whopUserId,
    first_eligible_at: anchor,
    is_annual: isAnnual,
    active,
  };
  const memberRecord = record || {
    discord_user_id: discordUserId,
    activation_started_at: anchor,
    membership_active: active,
  };
  const { values, storage } = memoryStorage([
    [`tenure:${discordUserId}`, tenure],
    [`${MEMBER_PREFIX}${discordUserId}`, memberRecord],
  ]);
  const memberLinks = memoryKv(
    posthogDistinctId
      ? [[`whop:${whopUserId}`, { discord_user_id: discordUserId, posthog_distinct_id: posthogDistinctId }]]
      : [],
  );
  const captures = [];
  const gateway = {
    env: {
      MEMBER_LINKS: memberLinks,
      POSTHOG_PROJECT_TOKEN: "phc_test_project",
      POSTHOG_CAPTURE_URL: "https://us.i.posthog.com/i/v0/e/",
    },
    ctx: { storage },
    async getTenureRecord(id) { return values.get(`tenure:${id}`) || null; },
    async listTenureRecords() {
      return [...values.entries()]
        .filter(([key]) => String(key).startsWith("tenure:"))
        .map(([, value]) => structuredClone(value));
    },
    async posthogFetch(url, options) {
      captures.push({ url, payload: JSON.parse(options.body) });
      return { ok: posthogOk, status: posthogOk ? 200 : 503 };
    },
  };
  return { gateway, values, memberLinks, captures, tenure };
}

test("website-attributed Whop buyer maps to original PostHog distinct ID", async () => {
  const { gateway, tenure } = gatewayFixture({ posthogDistinctId: "browser_distinct_abc" });
  const identity = await resolveCustomerPosthogIdentity(gateway, "900001", tenure);
  assert.equal(identity.distinct_id, "browser_distinct_abc");
  assert.equal(identity.identity_source, "website_posthog_distinct_id");
});

test("direct Whop buyer maps to deterministic pseudonymous Whop identity", async () => {
  const raw = "user_direct_private_456";
  const expected = "whop_user_" + createHash("sha256").update(raw).digest("hex");
  assert.equal(await pseudonymousWhopDistinctId(raw), expected);
  assert.equal(await pseudonymousWhopDistinctId(raw), expected);
});

test("Discord user resolves through tenure Whop mapping to the same PostHog identity", async () => {
  const { gateway } = gatewayFixture({
    discordUserId: "777001",
    whopUserId: "user_bridge_777",
    posthogDistinctId: "website_person_777",
  });
  const identity = await resolveCustomerPosthogIdentity(gateway, "777001");
  assert.equal(identity.distinct_id, "website_person_777");
});

test("identity bridge accepts authenticated server handoff and preserves existing Whop to Discord mapping", async () => {
  const memberLinks = memoryKv([
    ["whop:user_handoff", { discord_user_id: "555001", updated_at: "2026-09-01T00:00:00.000Z" }],
  ]);
  const secret = "bridge_test_secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    whop_user_id: "user_handoff",
    posthog_distinct_id: "browser_handoff",
  });
  const signature = await signIdentityBridgeBody(secret, timestamp, rawBody);
  const request = new Request("https://worker.example/internal/customer-identity", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slayerkey-Timestamp": timestamp,
      "X-Slayerkey-Signature": `sha256=${signature}`,
    },
    body: rawBody,
  });
  const response = await handleCustomerIdentityBridge(request, {
    DOJO_IDENTITY_BRIDGE_SECRET: secret,
    MEMBER_LINKS: memberLinks,
  });
  assert.equal(response.status, 200);
  const stored = await memberLinks.get("whop:user_handoff", "json");
  assert.equal(stored.discord_user_id, "555001");
  assert.equal(stored.posthog_distinct_id, "browser_handoff");
});

test("identity bridge rejects an invalid signature", async () => {
  const request = new Request("https://worker.example/internal/customer-identity", {
    method: "POST",
    headers: {
      "X-Slayerkey-Timestamp": String(Math.floor(Date.now() / 1000)),
      "X-Slayerkey-Signature": "sha256=" + "0".repeat(64),
    },
    body: JSON.stringify({ whop_user_id: "private", posthog_distinct_id: "public-ish" }),
  });
  const response = await handleCustomerIdentityBridge(request, {
    DOJO_IDENTITY_BRIDGE_SECRET: "correct_secret",
    MEMBER_LINKS: memoryKv(),
  });
  assert.equal(response.status, 401);
});

test("all eight activation milestones emit once and retry/backfill does not duplicate them", async () => {
  const record = {
    discord_user_id: "900001",
    activation_started_at: anchor,
    introduction_at: "2026-09-01T01:00:00.000Z",
    replied_to_two_members_at: "2026-09-01T02:00:00.000Z",
    first_training_post_at: "2026-09-02T00:00:00.000Z",
    first_general_message_at: "2026-09-02T01:00:00.000Z",
    first_goal_at: "2026-09-02T02:00:00.000Z",
    riot_linked_observed_at: "2026-09-02T03:00:00.000Z",
    riot_linked_current: true,
    first_win_at: "2026-09-04T00:00:00.000Z",
    membership_active: true,
  };
  const { gateway, captures } = gatewayFixture({
    record,
    posthogDistinctId: "browser_journey_900001",
    isAnnual: true,
  });

  const first = await syncActivationPosthogMember(gateway, "900001");
  assert.equal(first.ok, true);
  assert.equal(first.emitted, 8);

  const expected = [
    "introduction_posted",
    "replied_to_two_members",
    "first_training_post",
    "first_general_message",
    "goal_posted",
    "riot_linked",
    "first_win_posted",
    "first_win_within_7_days",
  ];
  for (const event of expected) {
    assert.equal(captures.filter((item) => item.payload.event === event).length, 1, `${event} emits exactly once`);
  }

  const retry = await syncActivationPosthogMember(gateway, "900001");
  assert.equal(retry.emitted, 0);
  assert.equal(captures.length, 8);
});

test("PostHog payload never contains raw Whop ID or raw Discord ID", async () => {
  const rawWhop = "raw_whop_NEVER_SEND";
  const rawDiscord = "999888777666";
  const { gateway, captures } = gatewayFixture({
    discordUserId: rawDiscord,
    whopUserId: rawWhop,
    posthogDistinctId: null,
    record: {
      discord_user_id: rawDiscord,
      activation_started_at: anchor,
      introduction_at: "2026-09-01T01:00:00.000Z",
    },
  });
  await syncActivationPosthogMember(gateway, rawDiscord);
  assert.equal(captures.length, 1);
  const serialized = JSON.stringify(captures[0].payload);
  assert.equal(serialized.includes(rawWhop), false);
  assert.equal(serialized.includes(rawDiscord), false);
  assert.match(captures[0].payload.distinct_id, /^whop_user_[0-9a-f]{64}$/);
});

test("monthly and annual membership classification is preserved on analytics events", async () => {
  const monthly = gatewayFixture({
    posthogDistinctId: "monthly_person",
    isAnnual: false,
    record: { discord_user_id: "900001", activation_started_at: anchor, first_training_post_at: "2026-09-02T00:00:00.000Z" },
  });
  await syncActivationPosthogMember(monthly.gateway, "900001");
  assert.equal(monthly.captures[0].payload.properties.plan, "monthly");

  const annual = gatewayFixture({
    posthogDistinctId: "annual_person",
    isAnnual: true,
    record: { discord_user_id: "900001", activation_started_at: anchor, first_training_post_at: "2026-09-02T00:00:00.000Z" },
  });
  await syncActivationPosthogMember(annual.gateway, "900001");
  assert.equal(annual.captures[0].payload.properties.plan, "annual");
});

test("PostHog failure is fail-open: activation behavior remains stored and delivery remains retryable", async () => {
  const { gateway, values, captures } = gatewayFixture({
    posthogDistinctId: "fail_open_person",
    posthogOk: false,
    record: {
      discord_user_id: "900001",
      activation_started_at: anchor,
      membership_active: true,
    },
  });

  const message = {
    channel_id: ACTIVATION_DESTINATIONS.training,
    timestamp: "2026-09-02T00:00:00.000Z",
    author: { id: "900001", bot: false, username: "not-sent-to-posthog" },
    member: { nick: null },
  };
  const recorded = await recordLiveActivationMessage(gateway, message);
  assert.equal(recorded.recorded, true);
  assert.equal(values.get(`${MEMBER_PREFIX}900001`).first_training_post_at, "2026-09-02T00:00:00.000Z");

  const delivery = await syncActivationPosthogMember(gateway, "900001");
  assert.equal(delivery.ok, false);
  assert.equal(delivery.pending, 1);
  assert.equal(captures.length, 1);
  assert.equal(values.get(`${MEMBER_PREFIX}900001`).first_training_post_at, "2026-09-02T00:00:00.000Z");
  assert.equal(values.get(`${MEMBER_PREFIX}900001`).posthog_delivery?.first_training_post, undefined);
});


test("existing membership tenure role logic still distinguishes monthly tenure and annual plans", () => {
  assert.equal(tenureRoleKey("2026-08-01T00:00:00.000Z", new Date("2026-09-01T00:00:00.000Z")), "m1");
  assert.equal(tenureRoleKey("2026-03-01T00:00:00.000Z", new Date("2026-09-01T00:00:00.000Z")), "m6");
  assert.equal(looksAnnual({ billing_period: 365 }), true);
  assert.equal(looksAnnual({ title: "Annual Dojo" }), true);
  assert.equal(looksAnnual({ title: "Monthly Dojo", billing_period: 30 }), false);
});

test("membership social-account sync preserves an existing Whop to PostHog mapping", async () => {
  const memberLinks = memoryKv([
    ["whop:user_preserve", { posthog_distinct_id: "browser_preserve", posthog_identity_source: "website_posthog_distinct_id" }],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { data: [{ service: "discord", account_id: "424242" }] };
    },
  });
  try {
    const discordId = await resolveDiscordUserId("user_preserve", {
      WHOP_API_KEY: "whop_test",
      MEMBER_LINKS: memberLinks,
    });
    assert.equal(discordId, "424242");
    const stored = await memberLinks.get("whop:user_preserve", "json");
    assert.equal(stored.discord_user_id, "424242");
    assert.equal(stored.posthog_distinct_id, "browser_preserve");
    const reverse = await memberLinks.get("discord:424242", "json");
    assert.equal(reverse.whop_user_id, "user_preserve");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
