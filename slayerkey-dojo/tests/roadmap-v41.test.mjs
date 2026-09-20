import test from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTALS_URL,
  MANUAL_ITEMS,
  ONBOARDING_URL,
  __test as roadmap,
  getRoadmapV41State,
  setRoadmapV41Manual,
} from "../src/roadmap-v41.js";

const anchor = "2026-09-01T00:00:00.000Z";

function storage(initial = []) {
  const values = new Map(initial);
  return {
    values,
    api: {
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async list({ prefix } = {}) {
        return new Map([...values].filter(([key]) => !prefix || String(key).startsWith(prefix)));
      },
      async delete(key) { values.delete(key); },
    },
  };
}

test("channel resolver handles emoji-prefixed Discord channel names", () => {
  const result = roadmap.resolveRoadmapChannels([
    { id: "1", type: 0, name: "📌┃start-here" },
    { id: "2", type: 15, name: "👋┃introductions" },
    { id: "3", type: 15, name: "🧪┃tasks" },
    { id: "4", type: 0, name: "🤖┃bots" },
    { id: "5", type: 0, name: "💬┃general" },
    { id: "6", type: 15, name: "📅┃2026-goals" },
    { id: "7", type: 15, name: "🏆┃wins" },
    { id: "8", type: 0, name: "🤼┃premier-info" },
    { id: "9", type: 15, name: "🎬┃clips" },
    { id: "10", type: 0, name: "🧑‍🏫┃community-help" },
  ], "guild");

  assert.equal(result.channels.start_here, "1");
  assert.equal(result.channels.introductions, "2");
  assert.equal(result.channels.tasks, "3");
  assert.equal(result.channels.bots, "4");
  assert.equal(result.channels.general, "5");
  assert.equal(result.channels.goals, "6");
  assert.equal(result.channels.wins, "7");
  assert.equal(result.channels.premier_info, "8");
  assert.equal(result.channels.clips, "9");
  assert.equal(result.channels.community_help, "10");
  assert.deepEqual(result.unresolved, []);
});

test("roadmap preserves the exact Whop onboarding and Fundamentals links", () => {
  assert.equal(ONBOARDING_URL, "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_EbCc3zaRKmonI/lessons/lesn_7emHFEKsx8iY4/");
  assert.equal(FUNDAMENTALS_URL, "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_EbCc3zaRKmonI/lessons/lesn_rHCBrfAAys9m8/");
});

test("automatic activation milestones check themselves off", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {
      introduction_posted: true,
      replied_to_two_members: true,
      first_training_post: true,
      riot_linked: true,
      first_general_message: true,
      goal_posted: true,
      first_win_posted: true,
      first_win_within_7_days: true,
    },
    manual: { completed: [] },
    config: { channels: {} },
  });

  const autoLabels = new Set([
    "Introduce yourself",
    "Respond to two other members",
    "Submit your Day 1 task",
    "Link your Riot account",
    "Welcome someone or join a conversation",
    "Post your goals for this year",
    "Post your Week 1 Win",
  ]);

  for (const item of model.tasks.filter((task) => autoLabels.has(task.label))) {
    assert.equal(item.done, true, item.label);
  }
  assert.equal(model.win_complete, true);
  assert.equal(model.win_within_7_days, true);
});

test("manual checklist items become completed without changing automatic milestones", () => {
  const selected = MANUAL_ITEMS.map((item) => item.value);
  const model = roadmap.buildRoadmapModel({
    activation: {},
    manual: { completed: selected },
    config: { channels: {} },
  });

  const manualLabels = new Set([
    "Watch the onboarding video",
    "Complete Day 1 of the 7-Day Fundamentals Sprint",
    "Adopt the STD server tag",
    "Mark Interested on an upcoming event",
    "Complete Days 2–7 of the 7-Day Fundamentals Sprint",
    "Submit your Day 2–7 tasks",
  ]);
  for (const item of model.tasks.filter((task) => manualLabels.has(task.label))) {
    assert.equal(item.done, true, item.label);
  }
  assert.equal(model.tasks.find((task) => task.label === "Introduce yourself").done, false);
});

test("first incomplete task is the roadmap next step", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {},
    manual: { completed: [] },
    config: { channels: {} },
  });
  assert.equal(model.next.label, "Watch the onboarding video");
});

test("first win remains visibly emphasized in formatted progress", () => {
  const model = roadmap.buildRoadmapModel({
    activation: { first_win_posted: false },
    manual: { completed: [] },
    config: { channels: {} },
  });
  const text = roadmap.formatRoadmapView(model);
  assert.match(text, /FIRST WIN: ⬜ NOT YET/);
  assert.match(text, /Post your Week 1 Win/);
});

test("persistent card has one obvious View My Progress action", () => {
  const card = roadmap.buildRoadmapCard({
    guild_id: "guild",
    channels: { start_here: "123" },
  });
  assert.match(card.content, /personal progress shortcut/);
  assert.equal(card.components[0].components[0].custom_id, "roadmap:v41:view");
  assert.equal(card.components[0].components[0].label, "View My Progress");
  assert.equal(card.components[0].components[1].style, 5);
});

test("manual selections are stored as a full idempotent checklist", async () => {
  const store = storage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
  ]);
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord(id) { return store.values.get("tenure:" + id) || null; },
  };

  const first = await setRoadmapV41Manual(gateway, "100", ["day1_sprint", "server_tag"], "interaction-1");
  assert.equal(first.ok, true);
  assert.deepEqual(first.state.completed, ["day1_sprint", "server_tag"]);

  const retry = await setRoadmapV41Manual(gateway, "100", ["day1_sprint"], "interaction-1");
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.state.completed, ["day1_sprint", "server_tag"]);

  const replace = await setRoadmapV41Manual(gateway, "100", ["onboarding_watched"], "interaction-2");
  assert.deepEqual(replace.state.completed, ["onboarding_watched"]);
});

test("targeted member state reads activation, manual checklist, team application, and config", async () => {
  const store = storage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
    ["activation:v3:member:100", {
      discord_user_id: "100",
      activation_started_at: anchor,
      first_win_at: "2026-09-05T00:00:00.000Z",
    }],
    ["roadmap:v41:manual:100", { completed: ["server_tag"] }],
    ["teamapp:v40:application:100", { status: "pending", submitted_at: "2026-09-04T00:00:00.000Z" }],
    ["roadmap:v41:config", { channels: { start_here: "123" } }],
  ]);
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord(id) { return store.values.get("tenure:" + id) || null; },
  };

  const state = await getRoadmapV41State(gateway, "100");
  assert.equal(state.ok, true);
  assert.equal(state.activation.first_win_posted, true);
  assert.deepEqual(state.manual.completed, ["server_tag"]);
  assert.equal(state.team_application.status, "pending");
  assert.equal(state.config.channels.start_here, "123");
});

test("roadmap state refuses users outside the known Dojo cohort", async () => {
  const store = storage();
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord() { return null; },
  };
  const state = await getRoadmapV41State(gateway, "999");
  assert.equal(state.ok, false);
});

test("roadmap view stays below Discord message limit", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {},
    manual: { completed: [] },
    config: {
      channels: {
        introductions: "1", tasks: "2", bots: "3", general: "4", goals: "5",
        wins: "6", premier_info: "7", clips: "8", community_help: "9",
      },
    },
  });
  assert.ok(roadmap.formatRoadmapView(model).length <= 1950);
});
