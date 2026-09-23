import test from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTALS_URL,
  ONBOARDING_URL,
  ROADMAP_COMMANDS,
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



test("channel resolver never prefers old-introductions over the live introductions channel", () => {
  const result = roadmap.resolveRoadmapChannels([
    { id: "old", type: 15, name: "old-introductions" },
    { id: "live", type: 15, name: "👋┃introductions" },
  ], "guild");

  assert.equal(result.channels.introductions, "live");
  assert.equal(roadmap.roadmapChannelMatchScore("old-introductions", ["introductions"]), 0);
  assert.equal(roadmap.roadmapChannelMatchScore("👋┃introductions", ["introductions"]), 100);
});

test("roadmap preview and visibility commands are registered", () => {
  assert.equal(ROADMAP_COMMANDS.some((command) => command.name === "roadmap-preview"), true);
  const visibility = ROADMAP_COMMANDS.find((command) => command.name === "roadmap-visibility");
  assert.ok(visibility);
  assert.deepEqual(visibility.options[0].choices.map((choice) => choice.value), ["public", "private"]);
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
  assert.equal(card.content, "");
  assert.equal(card.embeds[0].title, "🧭 Your Dojo Roadmap");
  assert.match(card.embeds[0].description, /next step/i);
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
    async getTaskStageV47() { return { stage: 4, label: "#4 - Daily Routine" }; },
  };

  const state = await getRoadmapV41State(gateway, "100");
  assert.equal(state.ok, true);
  assert.equal(state.activation.first_win_posted, true);
  assert.equal(state.team_application.status, "pending");
  assert.equal(state.task_stage.stage, 4);
  assert.equal(state.config.channels.start_here, "123");
});



test("owner gets a persistent test cohort record instead of a disposable preview", async () => {
  const store = storage([
    ["roadmap:v41:config", { channels: { start_here: "123" } }],
  ]);
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord() { return null; },
  };
  const state = await getRoadmapV41State(gateway, "owner", true);
  assert.equal(state.ok, true);
  assert.equal(state.preview, false);
  assert.equal(state.test_mode, true);
  assert.equal(state.activation.first_win_posted, false);
  assert.equal(state.config.channels.start_here, "123");
  assert.equal(store.values.get("activation:v3:member:owner").roadmap_test_record, true);

  const second = await getRoadmapV41State(gateway, "owner", true);
  assert.equal(second.test_mode, true);
});

test("verified Dojo-role member can load roadmap without stored tenure or activation", async () => {
  const store = storage([
    ["roadmap:v41:config", { channels: { start_here: "123" } }],
  ]);
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord() { return null; },
    async getTaskStageV47() { return { stage: 9, label: "Month 2 - DM Review" }; },
  };

  const state = await getRoadmapV41State(gateway, "role-member", false, true);
  assert.equal(state.ok, true);
  assert.equal(state.cohort_source, "discord_dojo_role");
  assert.equal(state.activation.membership_active, true);
  assert.equal(state.activation.anchor_valid, false);
  assert.equal(state.activation.activation_started_at, null);
  assert.equal(state.task_stage.stage, 9);
  assert.equal(store.values.has("activation:v3:member:role-member"), false);
});

test("unknown-anchor member roadmap uses factual historical evidence without inventing a start date", async () => {
  const store = storage([
    ["activation:v3:member:older", {
      discord_user_id: "older",
      membership_active: true,
      activation_started_at: null,
      activation_anchor_source: "unknown",
      observed_introduction_at: "2026-07-01T01:00:00.000Z",
      observed_replied_to_two_members_at: "2026-07-01T02:00:00.000Z",
      observed_community_message_at: "2026-07-02T01:00:00.000Z",
      observed_goal_at: "2026-07-03T01:00:00.000Z",
      observed_win_at: "2026-07-04T01:00:00.000Z",
    }],
    ["roadmap:v41:config", { channels: {} }],
  ]);
  const gateway = {
    ctx: { storage: store.api },
    async getTenureRecord() { return null; },
    async getTaskStageV47() { return { stage: 9, label: "Month 2 - DM Review" }; },
  };

  const state = await getRoadmapV41State(gateway, "older", false, true);
  assert.equal(state.ok, true);
  assert.equal(state.activation.anchor_valid, false);
  assert.equal(state.activation.activation_started_at, null);
  assert.equal(state.activation.introduction_posted, true);
  assert.equal(state.activation.replied_to_two_members, true);
  assert.equal(state.activation.first_training_post, true);
  assert.equal(state.activation.first_general_message, true);
  assert.equal(state.activation.goal_posted, true);
  assert.equal(state.activation.first_win_posted, true);
  assert.equal(state.activation.first_win_within_7_days, false);
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


test("roadmap model carries the member's highest tagged Fundamentals task stage", () => {
  const model = roadmap.buildRoadmapModel({
    activation: {},
    task_stage: { stage: 7, label: "#7 - Pre Round LEAD" },
    config: { channels: {} },
  });
  assert.equal(model.task_stage.stage, 7);
  assert.equal(model.task_stage.label, "#7 - Pre Round LEAD");
});
