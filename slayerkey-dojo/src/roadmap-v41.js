import {
  ACTIVATION_DESTINATIONS,
  MEMBER_PREFIX,
  deriveMember,
  mergeTenureIntoRecord,
} from "./activation-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const CONFIG_KEY = "roadmap:v41:config";
const MANUAL_PREFIX = "roadmap:v41:manual:";
const COMMAND_STATE_KEY = "roadmap:v41:command-registration";
const TEAM_APPLICATION_PREFIX = "teamapp:v40:application:";
const COMMAND_RECHECK_MS = 6 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export const ONBOARDING_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_EbCc3zaRKmonI/lessons/lesn_7emHFEKsx8iY4/";
export const FUNDAMENTALS_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_EbCc3zaRKmonI/lessons/lesn_rHCBrfAAys9m8/";

export const MANUAL_ITEMS = Object.freeze([
  { value: "onboarding_watched", label: "Watched onboarding video" },
  { value: "day1_sprint", label: "Completed Day 1 Fundamentals" },
  { value: "server_tag", label: "Adopted the STD server tag" },
  { value: "event_interest", label: "Marked Interested on an event" },
  { value: "days2_7_sprint", label: "Completed Days 2–7 Fundamentals" },
  { value: "days2_7_tasks", label: "Submitted Days 2–7 tasks" },
]);

const MANUAL_VALUES = new Set(MANUAL_ITEMS.map((item) => item.value));

export const ROADMAP_COMMANDS = Object.freeze([
  { name: "roadmap", description: "Open your personal Dojo roadmap progress", type: 1 },
  { name: "roadmap-setup", description: "Post or refresh the persistent Dojo roadmap card in this channel", type: 1 },
]);

const CHANNEL_ALIASES = Object.freeze({
  start_here: ["start-here", "start here", "starthere"],
  introductions: ["introductions"],
  tasks: ["tasks", "training-tasks", "training tasks"],
  bots: ["bots", "bot"],
  general: ["general"],
  goals: ["2026-goals", "2026 goals", "goals"],
  wins: ["wins", "win"],
  premier_info: ["premier-info", "premier info", "premier"],
  clips: ["clips", "clip"],
  community_help: ["community-help", "community help", "help"],
});

export async function handleRoadmapV41Interaction(request, env) {
  const rawBody = await request.text();
  let interaction;
  try { interaction = JSON.parse(rawBody); } catch { return null; }

  const command = interaction?.type === 2 ? String(interaction?.data?.name || "") : "";
  const customId = interaction?.data?.custom_id ? String(interaction.data.custom_id) : "";
  const isRoadmap = command === "roadmap" || command === "roadmap-setup" || customId.startsWith("roadmap:v41:");
  if (!isRoadmap) return null;

  if (!(await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid request signature", { status: 401 });
  }
  if (String(interaction?.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
    return ephemeralMessage("This roadmap only works inside the Slayerkey Discord server.");
  }

  const userId = interactionUserId(interaction);
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return ephemeralMessage("Roadmap storage is unavailable right now.");

  if (command === "roadmap-setup") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can set up the roadmap card.");
    try {
      const result = await setupRoadmapCard(interaction, env, stub);
      return ephemeralMessage(result.message);
    } catch (error) {
      return ephemeralMessage(`Roadmap setup failed: ${safeError(error)}`);
    }
  }

  if (command === "roadmap" || customId === "roadmap:v41:view") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use the roadmap.");
    try {
      const view = await buildRoadmapView(userId, env, stub);
      return Response.json({ type: 4, data: { ...view, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
    } catch (error) {
      return ephemeralMessage(`I couldn't load your roadmap: ${safeError(error)}`);
    }
  }

  if (customId === "roadmap:v41:refresh") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use the roadmap.");
    try {
      const view = await buildRoadmapView(userId, env, stub);
      return Response.json({ type: 7, data: { ...view, allowed_mentions: { parse: [] } } });
    } catch (error) {
      return ephemeralMessage(`I couldn't refresh your roadmap: ${safeError(error)}`);
    }
  }

  if (customId === "roadmap:v41:manual") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to update the roadmap.");
    const selected = (Array.isArray(interaction?.data?.values) ? interaction.data.values : [])
      .map(String)
      .filter((value) => MANUAL_VALUES.has(value));
    try {
      const saved = await stub.setRoadmapV41Manual(userId, selected, String(interaction.id || ""));
      if (!saved?.ok) return ephemeralMessage(saved?.message || "I couldn't update that checklist.");
      const view = await buildRoadmapView(userId, env, stub);
      return Response.json({ type: 7, data: { ...view, allowed_mentions: { parse: [] } } });
    } catch (error) {
      return ephemeralMessage(`I couldn't update that checklist: ${safeError(error)}`);
    }
  }

  return null;
}

export async function ensureRoadmapV41CommandsOnce(env, stub) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN || !stub) return;
  const claimed = await stub.claimRoadmapV41CommandRegistration("roadmap-v41").catch(() => false);
  if (!claimed) return;

  try {
    const base = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
    const existing = await discordJson(base, env);
    const byName = new Map((Array.isArray(existing) ? existing : []).map((item) => [String(item?.name || ""), item]));
    for (const command of ROADMAP_COMMANDS) {
      const current = byName.get(command.name);
      if (!current) {
        await discordJson(base, env, { method: "POST", body: JSON.stringify(command) });
      } else if (commandSignature(current) !== commandSignature(command)) {
        await discordJson(`${base}/${current.id}`, env, { method: "PATCH", body: JSON.stringify(command) });
      }
    }
    await stub.completeRoadmapV41CommandRegistration("roadmap-v41");
  } catch (error) {
    await stub.failRoadmapV41CommandRegistration("roadmap-v41", safeError(error)).catch(() => {});
    throw error;
  }
}

export async function claimRoadmapV41CommandRegistration(gateway, version) {
  const now = Date.now();
  const state = await gateway.ctx.storage.get(COMMAND_STATE_KEY);
  if (state?.status === "complete" && state?.version === version && Date.parse(state?.updated_at || "") > now - COMMAND_RECHECK_MS) return false;
  if (state?.status === "running" && state?.version === version && Number(state?.claimed_at || 0) > now - 10 * 60 * 1000) return false;
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version, status: "running", claimed_at: now, updated_at: new Date(now).toISOString(), error: null,
  });
  return true;
}

export async function completeRoadmapV41CommandRegistration(gateway, version) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version, status: "complete", updated_at: new Date().toISOString(), error: null,
  });
}

export async function failRoadmapV41CommandRegistration(gateway, version, error) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version, status: "error", updated_at: new Date().toISOString(), error: safeError(error),
  });
}

export async function getRoadmapV41State(gateway, discordUserId) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };

  const [tenure, activation, manual, teamApplication, config] = await Promise.all([
    gateway.getTenureRecord?.(userId).catch(() => null),
    gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`),
    gateway.ctx.storage.get(`${MANUAL_PREFIX}${userId}`),
    gateway.ctx.storage.get(`${TEAM_APPLICATION_PREFIX}${userId}`),
    gateway.ctx.storage.get(CONFIG_KEY),
  ]);

  if (!activation && !tenure) return { ok: false, message: "This Discord account is not in the known Dojo cohort." };

  const merged = mergeTenureIntoRecord(activation, userId, tenure);
  return {
    ok: true,
    discord_user_id: userId,
    activation: deriveMember(merged),
    manual: {
      completed: Array.isArray(manual?.completed)
        ? manual.completed.filter((value) => MANUAL_VALUES.has(String(value))).map(String)
        : [],
      updated_at: manual?.updated_at || null,
    },
    team_application: teamApplication
      ? { status: String(teamApplication.status || "pending"), submitted_at: teamApplication.submitted_at || null }
      : null,
    config: config || null,
  };
}

export async function setRoadmapV41Manual(gateway, discordUserId, selected, interactionId) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };

  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  const activation = await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
  if (!activation && !tenure) return { ok: false, message: "This Discord account is not in the known Dojo cohort." };

  const key = `${MANUAL_PREFIX}${userId}`;
  const previous = await gateway.ctx.storage.get(key);
  if (previous?.last_interaction_id === String(interactionId || "")) return { ok: true, duplicate: true, state: previous };

  const completed = [...new Set((Array.isArray(selected) ? selected : []).map(String).filter((value) => MANUAL_VALUES.has(value)))];
  const state = { completed, updated_at: new Date().toISOString(), last_interaction_id: String(interactionId || "") };
  await gateway.ctx.storage.put(key, state);
  return { ok: true, duplicate: false, state };
}

export async function setRoadmapV41Config(gateway, config) {
  const next = { ...(config || {}), version: 41, updated_at: new Date().toISOString() };
  await gateway.ctx.storage.put(CONFIG_KEY, next);
  return { ok: true, config: next };
}

export async function getRoadmapV41Config(gateway) {
  return (await gateway.ctx.storage.get(CONFIG_KEY)) || null;
}

async function setupRoadmapCard(interaction, env, stub) {
  const targetChannelId = String(interaction?.channel_id || "");
  if (!targetChannelId) throw new Error("Missing setup channel.");

  const channels = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/channels`, env);
  const resolved = resolveRoadmapChannels(channels, env.DISCORD_GUILD_ID);
  const previous = await stub.getRoadmapV41Config().catch(() => null);

  const config = {
    channel_id: targetChannelId,
    message_id: previous?.channel_id === targetChannelId ? previous?.message_id || null : null,
    channels: resolved.channels,
    unresolved: resolved.unresolved,
    guild_id: String(env.DISCORD_GUILD_ID || ""),
    configured_by: interactionUserId(interaction),
    configured_at: new Date().toISOString(),
  };

  const payload = buildRoadmapCard(config);
  let message = null;
  if (config.message_id) {
    try {
      message = await discordJson(`${DISCORD_API}/channels/${targetChannelId}/messages/${config.message_id}`, env, {
        method: "PATCH", body: JSON.stringify(payload),
      });
    } catch {
      config.message_id = null;
    }
  }
  if (!message) {
    message = await discordJson(`${DISCORD_API}/channels/${targetChannelId}/messages`, env, {
      method: "POST", body: JSON.stringify(payload),
    });
  }

  config.message_id = String(message?.id || "");
  await stub.setRoadmapV41Config(config);

  const missing = resolved.unresolved.length ? ` Missing channel links: ${resolved.unresolved.join(", ")}.` : "";
  return {
    message: `Roadmap card is live in <#${targetChannelId}>. Members can click **View My Progress** for their private checklist.${missing}`,
    config,
  };
}

export function resolveRoadmapChannels(channels, guildId) {
  const list = Array.isArray(channels) ? channels : [];
  const resolved = {
    introductions: ACTIVATION_DESTINATIONS.introductions,
    general: ACTIVATION_DESTINATIONS.general,
    goals: ACTIVATION_DESTINATIONS.goals,
    wins: ACTIVATION_DESTINATIONS.wins,
    tasks: ACTIVATION_DESTINATIONS.training,
  };

  for (const [key, aliases] of Object.entries(CHANNEL_ALIASES)) {
    const match = list.find((channel) => {
      if (![0, 5, 15, 16].includes(Number(channel?.type))) return false;
      const normalized = normalizeChannelName(channel?.name);
      return aliases.some((alias) => {
        const target = normalizeChannelName(alias);
        return normalized === target || normalized.endsWith(target);
      });
    });
    if (match?.id) resolved[key] = String(match.id);
  }

  const unresolved = Object.keys(CHANNEL_ALIASES).filter((key) => !resolved[key]);
  return { channels: resolved, unresolved, guild_id: String(guildId || "") };
}

export function buildRoadmapCard(config = {}) {
  const startHere = channelMention(config?.channels?.start_here);
  const content = [
    "## 🧭 Your 90 Day Improvement Roadmap",
    startHere
      ? `Your full roadmap and instructions stay in ${startHere}. This channel is your **personal progress shortcut**.`
      : "Your full roadmap stays in Start Here. This channel is your **personal progress shortcut**.",
    "",
    "The Dojo Bot automatically checks off the actions it can verify. For a few offline/manual steps, you can mark them complete yourself.",
    "",
    "### 🏆 Main goal",
    "**Post your first win during your first week.**",
    "",
    "Click below anytime to see exactly what's done, what's next, and jump straight to the right channel.",
  ].join("\n");

  const components = [{
    type: 1,
    components: [{
      type: 2, style: 1, custom_id: "roadmap:v41:view", label: "View My Progress", emoji: { name: "🧭" },
    }],
  }];

  if (config?.channels?.start_here && config?.guild_id) {
    components[0].components.push({
      type: 2, style: 5,
      url: discordChannelUrl(config.guild_id, config.channels.start_here),
      label: "Full Roadmap",
    });
  }

  return { content, components, allowed_mentions: { parse: [] } };
}

export function buildRoadmapModel(state) {
  const activation = state?.activation || {};
  const manual = new Set(state?.manual?.completed || []);
  const channels = state?.config?.channels || {};

  const tasks = [
    task("first-hour", "Watch the onboarding video", manual.has("onboarding_watched"), markdownLink("Onboarding video", ONBOARDING_URL), "onboarding_watched"),
    task("first-hour", "Introduce yourself", Boolean(activation.introduction_posted), channelMention(channels.introductions)),
    task("first-hour", "Respond to two other members", Boolean(activation.replied_to_two_members), channelMention(channels.introductions)),
    task("first-hour", "Complete Day 1 of the 7-Day Fundamentals Sprint", manual.has("day1_sprint"), markdownLink("Day 1 Fundamentals", FUNDAMENTALS_URL), "day1_sprint"),
    task("first-hour", "Submit your Day 1 task", Boolean(activation.first_training_post), channelMention(channels.tasks)),

    task("first-day", "Adopt the STD server tag", manual.has("server_tag"), "Server name → Server Tag → Adopt Tag", "server_tag"),
    task("first-day", "Mark Interested on an upcoming event", manual.has("event_interest"), "Events tab below the server banner", "event_interest"),
    task("first-day", "Link your Riot account", Boolean(activation.riot_linked), joinPieces(["Run `/linkriot` in", channelMention(channels.bots)])),
    task("first-day", "Welcome someone or join a conversation", Boolean(activation.first_general_message), channelMention(channels.general)),
    task("first-day", "Post your goals for this year", Boolean(activation.goal_posted), channelMention(channels.goals)),

    task("first-week", "Complete Days 2–7 of the 7-Day Fundamentals Sprint", manual.has("days2_7_sprint"), markdownLink("Days 2–7 Fundamentals", FUNDAMENTALS_URL), "days2_7_sprint"),
    task("first-week", "Submit your Day 2–7 tasks", manual.has("days2_7_tasks"), channelMention(channels.tasks), "days2_7_tasks"),
    task("first-week", "Post your Week 1 Win", Boolean(activation.first_win_posted), channelMention(channels.wins), null, true),
  ];

  const completed = tasks.filter((item) => item.done).length;
  const next = tasks.find((item) => !item.done) || null;
  return {
    tasks, completed, total: tasks.length, next,
    win_complete: Boolean(activation.first_win_posted),
    win_within_7_days: Boolean(activation.first_win_within_7_days),
    team_application: state?.team_application || null,
    channels,
  };
}

async function buildRoadmapView(userId, env, stub) {
  const state = await stub.getRoadmapV41State(userId);
  if (!state?.ok) throw new Error(state?.message || "Roadmap state unavailable.");
  const model = buildRoadmapModel(state);
  const content = formatRoadmapView(model);
  const manualCompleted = new Set(state.manual?.completed || []);

  const components = [];
  const actionButtons = [{
    type: 2, style: 2, custom_id: "roadmap:v41:refresh", label: "Refresh Progress", emoji: { name: "🔄" },
  }];
  if (!model.win_complete) {
    actionButtons.unshift({
      type: 2, style: 3, custom_id: "actv40:win", label: "Post My First Win", emoji: { name: "🏆" },
    });
  }
  components.push({ type: 1, components: actionButtons });

  components.push({
    type: 1,
    components: [{
      type: 3,
      custom_id: "roadmap:v41:manual",
      placeholder: "Mark manual steps complete",
      min_values: 0,
      max_values: MANUAL_ITEMS.length,
      options: MANUAL_ITEMS.map((item) => ({
        label: item.label, value: item.value, default: manualCompleted.has(item.value),
      })),
    }],
  });

  if (model.channels?.start_here) {
    components.push({
      type: 1,
      components: [{
        type: 2, style: 5,
        url: discordChannelUrl(env.DISCORD_GUILD_ID, model.channels.start_here),
        label: "Open Full Roadmap",
      }],
    });
  }

  return { content, components };
}

export function formatRoadmapView(model) {
  const lines = [
    `## 🧭 Your Dojo Roadmap — ${model.completed}/${model.total}`,
    model.win_complete
      ? `### 🏆 FIRST WIN: ✅ COMPLETE${model.win_within_7_days ? " — within your first 7 days" : ""}`
      : "### 🏆 FIRST WIN: ⬜ NOT YET",
    "",
    "### ⌚ YOUR FIRST HOUR",
    ...formatStage(model.tasks, "first-hour"),
    "",
    "### 🕒 YOUR FIRST DAY",
    ...formatStage(model.tasks, "first-day"),
    "",
    "### 📅 YOUR FIRST WEEK",
    ...formatStage(model.tasks, "first-week"),
    "",
  ];

  if (model.next) {
    lines.push(`**NEXT STEP:** ${model.next.label}${model.next.link ? ` — ${model.next.link}` : ""}`, "");
  } else {
    lines.push("✅ **Starter roadmap complete.** Keep following the full 90-day roadmap in Start Here.", "");
  }

  const premier = model.team_application
    ? `✅ Premier application: **${String(model.team_application.status || "pending").toUpperCase()}**`
    : joinPieces(["⬜ Premier teams:", channelMention(model.channels?.premier_info), "— run `/teamapply` when you're ready."]);
  lines.push("### OPTIONAL / EXPLORE", premier);

  if (model.channels?.clips) lines.push(`• Share a recent clip in ${channelMention(model.channels.clips)}`);
  if (model.channels?.community_help) lines.push(`• Ask a question or share an experience in ${channelMention(model.channels.community_help)}`);

  lines.push("", "_Automatic items update from your real Discord activity. Use the select menu below only for steps the bot cannot verify._");
  return lines.join("\n").slice(0, 1950);
}

function formatStage(tasks, stage) {
  return tasks
    .filter((item) => item.stage === stage)
    .map((item) => `${item.done ? "✅" : "⬜"} ${item.label}${item.link ? ` — ${item.link}` : ""}`);
}

function task(stage, label, done, link = null, manualKey = null, mainGoal = false) {
  return { stage, label, done: Boolean(done), link: link || null, manual_key: manualKey, main_goal: Boolean(mainGoal) };
}

function joinPieces(parts) { return parts.filter(Boolean).join(" "); }
function channelMention(id) { return id ? `<#${String(id)}>` : null; }
function discordChannelUrl(guildId, channelId) {
  if (!guildId || !channelId) return null;
  return `https://discord.com/channels/${String(guildId)}/${String(channelId)}`;
}
function markdownLink(label, url) { return `[${label}](<${url}>)`; }
function normalizeChannelName(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}
function commandSignature(command) {
  return JSON.stringify({ name: command?.name, description: command?.description, type: command?.type, options: command?.options || [] });
}
function interactionUserId(interaction) {
  return String(interaction?.member?.user?.id || interaction?.user?.id || "");
}
function hasDojoAccess(interaction, env) {
  if (isOwner(interactionUserId(interaction), env)) return true;
  const roles = Array.isArray(interaction?.member?.roles) ? interaction.member.roles.map(String) : [];
  return roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}
function isOwner(userId, env) { return String(userId || "") === String(env.DISCORD_OWNER_USER_ID || ""); }

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, hexToBytes(signature), encoder.encode(timestamp + rawBody));
  } catch { return false; }
}
function hexToBytes(hex) {
  const value = String(hex || "").trim();
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2) throw new Error("Invalid hex");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}
async function discordJson(url, env, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.status === 204 ? null : response.json();
}
function ephemeralMessage(content) {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}
function safeError(error) { return String(error?.message || error || "Unknown error").slice(0, 300); }

export const __test = Object.freeze({
  buildRoadmapCard,
  buildRoadmapModel,
  formatRoadmapView,
  normalizeChannelName,
  resolveRoadmapChannels,
});
