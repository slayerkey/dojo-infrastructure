import test from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTALS_URL,
  ONBOARDING_URL,
  __test as roadmap,
  getRoadmapV41State,
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

test("roadmap only tracks seven automatically verifiable activation steps", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {},
    config: { channels: {} },
  });
  assert.equal(model.total, 7);
  assert.deepEqual(model.tasks.map((item) => item.label), [
    "Introduce yourself",
    "Reply to two other members",
    "Post your first training task",
    "Link your Riot account",
    "Join a conversation",
    "Post your goal",
    "Post your first win",
  ]);
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
    config: { channels: {} },
  });

  assert.equal(model.completed, 7);
  assert.equal(model.tasks.every((item) => item.done), true);
  assert.equal(model.win_complete, true);
  assert.equal(model.win_within_7_days, true);
});

test("first incomplete automatic task is the only next step", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {
      introduction_posted: true,
      replied_to_two_members: true,
      first_training_post: false,
    },
    config: { channels: { tasks: "123" } },
  });
  assert.equal(model.next.label, "Post your first training task");
  assert.equal(model.next.channel_id, "123");
});

test("first win remains visibly emphasized without hour/day/week sections", () => {
  const model = roadmap.buildRoadmapModel({
    activation: { first_win_posted: false },
    config: { channels: {} },
  });
  const text = roadmap.formatRoadmapView(model);
  assert.match(text, /First Win: ⬜ NOT YET/);
  assert.equal(/YOUR FIRST HOUR/.test(text), false);
  assert.equal(/YOUR FIRST DAY/.test(text), false);
  assert.equal(/YOUR FIRST WEEK/.test(text), false);
  assert.match(text, /NEXT STEP/);
});

test("persistent card has one primary progress button and keeps resource links", () => {
  const card = roadmap.buildRoadmapCard({
    guild_id: "guild",
    channels: { start_here: "123" },
  });
  assert.match(card.content, /simple version/);
  assert.equal(card.components[0].components[0].custom_id, "roadmap:v41:view");
  assert.equal(card.components[0].components[0].label, "View My Progress");
  assert.equal(card.components[0].components[1].url, ONBOARDING_URL);
  assert.equal(card.components[0].components[2].url, FUNDAMENTALS_URL);
  assert.equal(card.components[1].components[0].style, 5);
});

test("targeted member state reads existing activation and team application without scanning history", async () => {
  const store = storage([
    ["tenure:100", { discord_user_id: "100", first_eligible_at: anchor, active: true }],
    ["activation:v3:member:100", {
      discord_user_id: "100",
      activation_started_at: anchor,
      first_win_at: "2026-09-05T00:00:00.000Z",
    }],
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
    config: {
      channels: {
        introductions: "1", tasks: "2", bots: "3", general: "4", goals: "5", wins: "6",
      },
    },
  });
  assert.ok(roadmap.formatRoadmapView(model).length <= 1950);
});
