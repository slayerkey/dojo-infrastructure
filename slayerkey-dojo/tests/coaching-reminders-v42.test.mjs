import test from "node:test";
import assert from "node:assert/strict";
import {
  dueCoachingSlot,
  selectCoachingEvent,
  selectAnnouncementChannel,
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

test("recognizes six-hour and 30-minute Saturday reminders in Arizona", () => {
  assert.equal(dueCoachingSlot(new Date("2026-10-24T13:00:00Z"))?.beforeMinutes, 360);
  assert.equal(dueCoachingSlot(new Date("2026-10-24T18:30:00Z"))?.beforeMinutes, 30);
  assert.equal(dueCoachingSlot(new Date("2026-10-23T13:00:00Z")), null);
  assert.equal(dueCoachingSlot(new Date("2026-10-24T17:00:00Z")), null);
});

test("chooses only a scheduled call starting at the expected time", () => {
  const slot = dueCoachingSlot(new Date("2026-10-24T13:00:00Z"));
  assert.equal(selectCoachingEvent([event], new Date("2026-10-24T13:00:00Z"), slot)?.id, event.id);
  assert.equal(selectCoachingEvent([{ ...event, status: 2 }], new Date("2026-10-24T13:00:00Z"), slot), null);
  assert.equal(selectCoachingEvent([{ ...event, scheduled_start_time: "2026-10-24T20:00:00Z" }], new Date("2026-10-24T13:00:00Z"), slot), null);
  assert.equal(selectCoachingEvent([{ ...event, id: "something-else", name: "Premier team" }], new Date("2026-10-24T13:00:00Z"), slot), null);
  assert.equal(selectCoachingEvent([{ ...event, id: "different", name: "Open Office Hour" }], new Date("2026-10-24T13:00:00Z"), slot)?.id, "different");
});

test("refuses to guess an announcement destination", () => {
  assert.equal(selectAnnouncementChannel([{ id: "chan", name: "announcements", type: 0 }]), "chan");
  assert.equal(selectAnnouncementChannel([{ id: "a", name: "announcements", type: 0 }, { id: "b", name: "announcements", type: 5 }]), null);
  assert.equal(selectAnnouncementChannel([{ id: "vc", name: "classroom", type: 2 }]), null);
  assert.equal(selectAnnouncementChannel([], "explicit-channel"), "explicit-channel");
});

test("messages mention everyone, name Classroom and link to the correct voice channel", () => {
  const result = buildCoachingReminder({ label: "30 MINUTES" }, event);
  assert.match(result, /^@everyone \*\*COACHING CALL IN 30 MINUTES\*\*/);
  assert.match(result, /Classroom/);
  assert.match(result, /1530226054210261032/);
  assert.match(result, /discord\.com\/events\/1494446702378221590\/1533227276974555176/);
});

test("sends exactly one event-linked message with an explicit everyone ping", async () => {
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
    if (url.endsWith("/channels")) return [{ id: "announcements-id", name: "announcements", type: 5 }];
    if (url.includes("/messages")) {
      calls.push({ url, options });
      return { id: "message-id" };
    }
    throw Error("Unexpected URL " + url);
  };
  const now = new Date("2026-10-24T13:00:00Z");
  const first = await runCoachingReminderScheduler(env, stub, now, api);
  const again = await runCoachingReminderScheduler(env, stub, now, api);
  assert.equal(first.sent, true);
  assert.equal(again.skipped, "already_sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith("/channels/announcements-id/messages"), true);
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
  assert.match(payload.content, /6 HOURS/);
});

test("releases an unsuccessful claim for retry", async () => {
  const claims = new Set();
  const stub = {
    async claimCoachingReminder(key) { if (claims.has(key)) return false; claims.add(key); return true; },
    async releaseCoachingReminder(key) { claims.delete(key); },
  };
  const api = async (url) => {
    if (url.endsWith("/scheduled-events")) return [event];
    if (url.endsWith("/channels")) return [{ id: "news", name: "announcements", type: 0 }];
    throw Error("Simulated send failure");
  };
  await assert.rejects(runCoachingReminderScheduler(env, stub, new Date("2026-10-24T18:30:00Z"), api), /Simulated send failure/);
  assert.equal(claims.size, 0);
});