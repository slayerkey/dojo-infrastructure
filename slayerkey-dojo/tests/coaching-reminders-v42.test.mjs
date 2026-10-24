import test from "node:test";
import assert from "node:assert/strict";
import {
  dueCoachingSlot,
  selectCoachingEvent,
  buildCoachingReminder,
  runCoachingReminderScheduler,
} from "../src/coaching-reminders-v42.js";

const guild = "1494446702378221590";
const event = {
  id: "1533227276974555176",
  name: "Weekly Coaching Call",
  status: 1,
  scheduled_start_time: "2026-10-24T19:00:00.000Z",
};
const env = { DISCORD_BOT_TOKEN: "test-token", DISCORD_GUILD_ID: guild };

test("recognizes only the 30-minute Saturday reminder in Arizona", () => {
  assert.equal(dueCoachingSlot(new Date("2026-10-24T13:00:00Z")), null);
  assert.equal(dueCoachingSlot(new Date("2026-10-24T18:30:00Z"))?.beforeMinutes, 30);
  assert.equal(dueCoachingSlot(new Date("2026-10-23T13:00:00Z")), null);
  assert.equal(dueCoachingSlot(new Date("2026-10-24T17:00:00Z")), null);
});

test("chooses only a scheduled call starting at the expected time", () => {
  const now = new Date("2026-10-24T18:30:00Z");
  const slot = dueCoachingSlot(now);
  assert.equal(selectCoachingEvent([event], now, slot)?.id, event.id);
  assert.equal(selectCoachingEvent([{ ...event, status: 2 }], now, slot), null);
  assert.equal(selectCoachingEvent([{ ...event, scheduled_start_time: "2026-10-24T20:00:00Z" }], now, slot), null);
  assert.equal(selectCoachingEvent([{ ...event, id: "something-else", name: "Premier team" }], now, slot), null);
  assert.equal(selectCoachingEvent([{ ...event, id: "different", name: "Open Office Hour" }], now, slot)?.id, "different");
});

test("messages mention everyone, name Classroom and link to the correct voice channel", () => {
  const result = buildCoachingReminder({ label: "30 MINUTES" }, event);
  assert.match(result, /^@everyone \*\*COACHING CALL STARTS IN 30 MINUTES\*\*/);
  assert.match(result, /Bring any clips or questions/);
  assert.match(result, /Classroom/);
  assert.match(result, /1530226054210261032/);
  assert.match(result, /discord\.com\/events\/1494446702378221590\/1533227276974555176/);
});

test("sends exactly one 30-minute event-linked @everyone message in general", async () => {
  const claims = new Set();
  const stub = {
    async claimCoachingReminder(key) {
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    async releaseCoachingReminder(key) { claims.delete(key); },
  };
  const calls = [];
  const api = async (url, _env, options) => {
    if (url.endsWith("/scheduled-events")) return [event];
    if (url.includes("/messages")) {
      calls.push({ url, options });
      return { id: "message-id" };
    }
    throw Error("Unexpected URL " + url);
  };
  const now = new Date("2026-10-24T18:30:00Z");
  const first = await runCoachingReminderScheduler(env, stub, now, api);
  const again = await runCoachingReminderScheduler(env, stub, now, api);
  assert.equal(first.sent, true);
  assert.equal(again.skipped, "already_sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith("/channels/1532854321723478217/messages"), true);
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
  assert.match(payload.content, /STARTS IN 30 MINUTES/);
  assert.match(payload.content, /bring any clips or questions/i);
  assert.match(payload.content, /discord.com\/events\/1494446702378221590\/1533227276974555176/);
  assert.match(payload.content, /1530226054210261032/);
});

test("releases an unsuccessful claim for retry", async () => {
  const claims = new Set();
  const stub = {
    async claimCoachingReminder(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    async releaseCoachingReminder(key) { claims.delete(key); },
  };
  const api = async (url) => {
    if (url.endsWith("/scheduled-events")) return [event];
    throw Error("Simulated send failure");
  };
  await assert.rejects(runCoachingReminderScheduler(env, stub, new Date("2026-10-24T18:30:00Z"), api), /Simulated send failure/);
  assert.equal(claims.size, 0);
});