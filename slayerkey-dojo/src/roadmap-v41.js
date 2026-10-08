import {
  ACTIVATION_DESTINATIONS,
  MEMBER_PREFIX,
  deriveMember,
  mergeTenureIntoRecord,
} from "./activation-core.js";
import { fullMonthsSince } from "./membership-core.js";

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
export const AIM_MASTERY_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_S0QdgIpwwRmpJ/lessons/lesn_9v72k1ZZcu53H/";
export const CROSSHAIR_TRAINING_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_S0QdgIpwwRmpJ/lessons/lesn_mF8EhC1K9jHS4/";
export const MOVEMENT_TRAINING_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_S0QdgIpwwRmpJ/lessons/lesn_CUdopLXNdMxBf/";
export const AIM_TRAINING_2SS_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_S0QdgIpwwRmpJ/lessons/lesn_mGObsRlmMuODz/";
export const TWO_SS_BREAKDOWN_URL = "https://whop.com/slayerkey/exp_gJq4d54kaCqWzC/app/courses/cors_S0QdgIpwwRmpJ/lessons/lesn_pEV2SrUsG0tgz/";

export const MANUAL_ITEMS = Object.freeze([
  { value: "onboarding_watched", label: "Watched onboarding video" },
  { value: "day1_sprint", label: "Completed Day 1 Fundamentals" },
  { value: "server_tag", label: "Adopted the STD server tag" },
  { value: "event_interest", label: "Marked Interested on an event" },
  { value: "days2_7_sprint", label: "Completed Days 2–7 Fundamentals" },
  { value: "days2_7_tasks", label: "Submitted Days 2–7 tasks" },
  { value: "month1_aim_mastery", label: "Completed Aim Mastery Course" },
  { value: "month1_crosshair", label: "Completed Crosshair Placement training" },
  { value: "month1_movement", label: "Completed Movement training" },
  { value: "month1_2ss", label: "Completed 2SS training" },
]);

const MONTH_ONE_MANUAL_VALUES = new Set([
  "month1_aim_mastery",
  "month1_crosshair",
  "month1_movement",
  "month1_2ss",
]);

const MANUAL_VALUES = new Set(MANUAL_ITEMS.map((item) => item.value));

export const ROADMAP_COMMANDS = Object.freeze([
  { name: "roadmap", description: "Open your personal Dojo roadmap progress", type: 1 },
  { name: "roadmap-setup", description: "Post or refresh the persistent Dojo roadmap card in this channel", type: 1 },
  { name: "roadmap-preview", description: "Preview every roadmap link before publishing", type: 1 },
  {
    name: "roadmap-visibility",
    description: "Choose whether member roadmap progress is public or private",
    type: 1,
    options: [{
      type: 3,
      name: "mode",
      description: "Public for testing, private when you want personal progress hidden",
      required: true,
      choices: [
        { name: "Public", value: "public" },
        { name: "Private", value: "private" },
      ],
    }],
  },
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
  const isRoadmap =
    command === "roadmap" ||
    command === "roadmap-setup" ||
    command === "roadmap-preview" ||
    command === "roadmap-visibility" ||
    customId.startsWith("roadmap:v41:");
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

  if (command === "roadmap-preview") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can preview roadmap links.");
    try {
      return Response.json({
        type: 4,
        data: {
          ...(await buildRoadmapPreview(env)),
          flags: EPHEMERAL,
          allowed_mentions: { parse: [] },
        },
      });
    } catch (error) {
      return ephemeralMessage(`Roadmap preview failed: ${safeError(error)}`);
    }
  }

  if (command === "roadmap-visibility") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can change roadmap visibility.");
    const mode = String(commandOption(interaction, "mode") || "").toLowerCase();
    if (!["public", "private"].includes(mode)) return ephemeralMessage("Choose public or private.");
    const current = await stub.getRoadmapV41Config().catch(() => null);
    await stub.setRoadmapV41Config({ ...(current || {}), progress_visibility: mode });
    return ephemeralMessage(
      mode === "public"
        ? "Roadmap progress is now **public** when members use /roadmap or View My Progress. Use /roadmap-visibility private later to switch it back."
        : "Roadmap progress is now **private/ephemeral** again.",
    );
  }

  if (customId === "roadmap:v41:full" || customId.startsWith("roadmap:v41:section:")) {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use the roadmap.");
    const section = customId === "roadmap:v41:full"
      ? "overview"
      : String(customId.slice("roadmap:v41:section:".length) || "overview");
    try {
      const view = await buildRoadmapSectionView(userId, env, stub, section, isOwner(userId, env));
      const config = await stub.getRoadmapV41Config().catch(() => null);
      const isPublic = String(config?.progress_visibility || "public") !== "private";
      const updateExisting = customId.startsWith("roadmap:v41:section:");
      return Response.json({
        type: updateExisting ? 7 : 4,
        data: {
          ...view,
          ...(!updateExisting && !isPublic ? { flags: EPHEMERAL } : {}),
          allowed_mentions: { parse: [] },
        },
      });
    } catch (error) {
      return ephemeralMessage(`I couldn't load that roadmap section: ${safeError(error)}`);
    }
  }

  if (customId.startsWith("roadmap:v41:complete:")) {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to update the roadmap.");
    const value = String(customId.slice("roadmap:v41:complete:".length));
    if (!MONTH_ONE_MANUAL_VALUES.has(value)) return ephemeralMessage("That roadmap task cannot be completed manually.");
    try {
      const current = await stub.getRoadmapV41State(userId, isOwner(userId, env), true);
      if (!current?.ok) return ephemeralMessage(current?.message || "Roadmap state unavailable.");
      const selected = [...new Set([...(current.manual?.completed || []), value])];
      const saved = await stub.setRoadmapV41Manual(userId, selected, String(interaction.id || ""), true);
      if (!saved?.ok) return ephemeralMessage(saved?.message || "I couldn't update that task.");
      const view = await buildRoadmapSectionView(userId, env, stub, "month1", isOwner(userId, env));
      return Response.json({ type: 7, data: { ...view, allowed_mentions: { parse: [] } } });
    } catch (error) {
      return ephemeralMessage(`I couldn't update that roadmap task: ${safeError(error)}`);
    }
  }

  if (command === "roadmap" || customId === "roadmap:v41:view") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use the roadmap.");
    try {
      const view = await buildRoadmapView(userId, env, stub, isOwner(userId, env), true);
      const config = await stub.getRoadmapV41Config().catch(() => null);
      const isPublic = String(config?.progress_visibility || "public") !== "private";
      return Response.json({
        type: 4,
        data: {
          ...view,
          ...(isPublic ? {} : { flags: EPHEMERAL }),
          allowed_mentions: { parse: [] },
        },
      });
    } catch (error) {
      return ephemeralMessage(`I couldn't load your roadmap: ${safeError(error)}`);
    }
  }

  if (customId === "roadmap:v41:refresh") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use the roadmap.");
    try {
      const view = await buildRoadmapView(userId, env, stub, isOwner(userId, env), true);
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
      const saved = await stub.setRoadmapV41Manual(userId, selected, String(interaction.id || ""), true);
      if (!saved?.ok) return ephemeralMessage(saved?.message || "I couldn't update that checklist.");
      const view = await buildRoadmapView(userId, env, stub, false, true);
      return Response.json({ type: 7, data: { ...view, allowed_mentions: { parse: [] } } });
    } catch (error) {
      return ephemeralMessage(`I couldn't update that checklist: ${safeError(error)}`);
    }
  }

  return null;
}

export async function ensureRoadmapV41CommandsOnce(env, stub) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN || !stub) return;
  const claimed = await stub.claimRoadmapV41CommandRegistration("roadmap-v41.2").catch(() => false);
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
    await stub.completeRoadmapV41CommandRegistration("roadmap-v41.2");
  } catch (error) {
    await stub.failRoadmapV41CommandRegistration("roadmap-v41.2", safeError(error)).catch(() => {});
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

export async function getRoadmapV41State(gateway, discordUserId, allowPreview = false, allowRoleFallback = false) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };

  const [tenure, activation, manual, teamApplication, config, taskStage] = await Promise.all([
    gateway.getTenureRecord?.(userId).catch(() => null),
    gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`),
    gateway.ctx.storage.get(`${MANUAL_PREFIX}${userId}`),
    gateway.ctx.storage.get(`${TEAM_APPLICATION_PREFIX}${userId}`),
    gateway.ctx.storage.get(CONFIG_KEY),
    typeof gateway.getTaskStageV47 === "function"
      ? gateway.getTaskStageV47(userId).catch(() => null)
      : Promise.resolve(null),
  ]);

  let roleFallback = false;
  if (!activation && !tenure) {
    if (allowPreview) {
      const now = new Date().toISOString();
      const ownerTestRecord = {
        discord_user_id: userId,
        activation_started_at: now,
        roadmap_test_record: true,
        membership_active: false,
        created_at: now,
        updated_at: now,
      };
      await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, ownerTestRecord);

      return {
        ok: true,
        preview: false,
        test_mode: true,
        discord_user_id: userId,
        activation: deriveMember(ownerTestRecord),
        manual: { completed: [], updated_at: null },
        team_application: null,
        task_stage: taskStage || null,
        tenure: tenure || null,
        config: config || null,
      };
    }
    if (!allowRoleFallback) {
      return { ok: false, message: "This Discord account is not in the known Dojo cohort." };
    }
    // The signed Discord interaction already verified the current Dojo role.
    // Allow the roadmap to load without inventing a membership/start date or
    // persisting a fake tenure record for older members whose historical link
    // was never captured.
    roleFallback = true;
  }

  const merged = mergeTenureIntoRecord(
    activation || (roleFallback ? {
      discord_user_id: userId,
      membership_active: true,
      activation_started_at: null,
      activation_anchor_source: "unknown",
    } : null),
    userId,
    tenure,
  );
  return {
    ok: true,
    preview: false,
    test_mode: Boolean(merged?.roadmap_test_record),
    cohort_source: roleFallback ? "discord_dojo_role" : "stored_membership",
    discord_user_id: userId,
    activation: deriveRoadmapActivation(merged, taskStage),
    manual: {
      completed: Array.isArray(manual?.completed)
        ? manual.completed.filter((value) => MANUAL_VALUES.has(String(value))).map(String)
        : [],
      updated_at: manual?.updated_at || null,
    },
    team_application: teamApplication
      ? { status: String(teamApplication.status || "pending"), submitted_at: teamApplication.submitted_at || null }
      : null,
    task_stage: taskStage || null,
    tenure: tenure || null,
    config: config || null,
  };
}

function deriveRoadmapActivation(record, taskStage = null) {
  const derived = deriveMember(record);
  const hasTaskSubmission = Number(taskStage?.stage || 0) > 0;

  // If we know the true membership start date, preserve the strict post-anchor
  // activation metrics. A tagged task is direct evidence of a task submission.
  if (derived.anchor_valid) {
    return {
      ...derived,
      first_training_post: derived.first_training_post || hasTaskSubmission,
      first_general_message: derived.first_general_message || Boolean(record?.first_community_message_at),
    };
  }

  // Older members can have real Discord history without a recoverable Whop
  // start date. Use separately stored historical evidence for roadmap UX only;
  // these observations never become timed activation metrics.
  return {
    ...derived,
    introduction_posted: derived.introduction_posted || derived.introduction_observed,
    replied_to_two_members: derived.replied_to_two_members || derived.replied_to_two_members_observed,
    first_training_post: derived.first_training_post || derived.training_post_observed || hasTaskSubmission,
    first_general_message: derived.first_general_message || derived.community_participated_observed || derived.general_message_observed,
    goal_posted: derived.goal_posted || derived.goal_observed,
    first_win_posted: derived.first_win_posted || derived.win_observed,
    first_win_within_7_days: false,
  };
}

export async function setRoadmapV41Manual(gateway, discordUserId, selected, interactionId, allowRoleFallback = false) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };

  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  const activation = await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
  if (!activation && !tenure && !allowRoleFallback) return { ok: false, message: "This Discord account is not in the known Dojo cohort." };

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

  const placements = {
    ...(previous?.placements || {}),
  };
  // Backward-compat: preserve the one legacy placement if it predates multi-placement storage.
  if (previous?.channel_id && previous?.message_id && !placements[String(previous.channel_id)]) {
    placements[String(previous.channel_id)] = {
      channel_id: String(previous.channel_id),
      message_id: String(previous.message_id),
      configured_at: previous.configured_at || previous.updated_at || null,
    };
  }

  const existingPlacement = placements[targetChannelId] || null;
  const config = {
    ...(previous || {}),
    channel_id: targetChannelId,
    message_id: existingPlacement?.message_id || null,
    channels: resolved.channels,
    unresolved: resolved.unresolved,
    guild_id: String(env.DISCORD_GUILD_ID || ""),
    configured_by: interactionUserId(interaction),
    configured_at: new Date().toISOString(),
    progress_visibility: previous?.progress_visibility || "public",
    placements,
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
  config.placements[targetChannelId] = {
    channel_id: targetChannelId,
    message_id: config.message_id,
    configured_at: config.configured_at,
  };
  await stub.setRoadmapV41Config(config);

  const missing = resolved.unresolved.length ? ` Missing channel links: ${resolved.unresolved.join(", ")}.` : "";
  const placementCount = Object.keys(config.placements || {}).length;
  return {
    message: `Roadmap launcher is live in <#${targetChannelId}>. **${placementCount}** public roadmap placement${placementCount === 1 ? "" : "s"} now use the same member progress.${missing}`,
    config,
  };
}

export function resolveRoadmapChannels(channels, guildId) {
  const list = (Array.isArray(channels) ? channels : [])
    .filter((channel) => [0, 5, 15, 16].includes(Number(channel?.type)));

  // Activation destinations are authoritative for the channels we already track.
  // Dynamic discovery fills in the remaining roadmap-only destinations and may
  // confirm tracked channels, but it should never prefer old/archive copies.
  const resolved = {
    introductions: ACTIVATION_DESTINATIONS.introductions,
    general: ACTIVATION_DESTINATIONS.general,
    goals: ACTIVATION_DESTINATIONS.goals,
    wins: ACTIVATION_DESTINATIONS.wins,
    tasks: ACTIVATION_DESTINATIONS.training,
  };

  for (const [key, aliases] of Object.entries(CHANNEL_ALIASES)) {
    const ranked = list
      .map((channel) => ({
        channel,
        score: roadmapChannelMatchScore(channel?.name, aliases),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || String(a.channel?.id || "").localeCompare(String(b.channel?.id || "")));

    if (ranked[0]?.channel?.id) resolved[key] = String(ranked[0].channel.id);
  }

  const unresolved = Object.keys(CHANNEL_ALIASES).filter((key) => !resolved[key]);
  return { channels: resolved, unresolved, guild_id: String(guildId || "") };
}

export function roadmapChannelMatchScore(name, aliases) {
  const normalized = normalizeChannelName(name);
  if (!normalized) return 0;

  // Never route new members into archived/legacy copies such as #old-introductions.
  if (/^(old|archive|archived|legacy|deprecated)/.test(normalized)) return 0;

  let best = 0;
  for (const alias of aliases || []) {
    const target = normalizeChannelName(alias);
    if (!target) continue;
    if (normalized === target) best = Math.max(best, 100);
    else if (normalized.endsWith(target)) best = Math.max(best, 40);
    else if (normalized.includes(target)) best = Math.max(best, 20);
  }
  return best;
}

async function buildRoadmapPreview(env) {
  const guildId = String(env.DISCORD_GUILD_ID || "");
  const channels = await discordJson(`${DISCORD_API}/guilds/${guildId}/channels`, env);
  const resolved = resolveRoadmapChannels(channels, guildId);

  const channelRows = [
    ["Start Here / Full Roadmap", "start_here"],
    ["Introductions", "introductions"],
    ["Tasks", "tasks"],
    ["Bots", "bots"],
    ["General", "general"],
    ["Goals", "goals"],
    ["Wins", "wins"],
    ["Premier Info", "premier_info"],
    ["Clips", "clips"],
    ["Community Help", "community_help"],
  ];

  const fields = channelRows.map(([label, key]) => ({
    name: label,
    value: resolved.channels?.[key]
      ? `<#${resolved.channels[key]}>  ·  \`${resolved.channels[key]}\``
      : "❌ Not found",
    inline: true,
  }));

  fields.push(
    {
      name: "👋 Onboarding Video",
      value: `[Open onboarding video](<${ONBOARDING_URL}>)`,
      inline: false,
    },
    {
      name: "🧪 7-Day Fundamentals",
      value: `[Open 7-Day Fundamentals](<${FUNDAMENTALS_URL}>)`,
      inline: false,
    },
    {
      name: "New-member task order",
      value: [
        "1. Introduce yourself",
        "2. Reply to two members",
        "3. Post first training task",
        "4. Link Riot",
        "5. Join a conversation",
        "6. Post goal",
        "7. 🏆 Post first win",
      ].join("\n"),
      inline: false,
    },
  );

  return {
    content: "",
    embeds: [{
      title: "🧭 Roadmap Link Preview",
      description: resolved.unresolved.length
        ? `Check every destination below before publishing. Missing: **${resolved.unresolved.join(", ")}**.`
        : "Check every destination below. **Nothing is published or changed by this preview.**",
      fields,
      footer: {
        text: "If these are correct, run /roadmap-setup in the roadmap channel to save and publish them.",
      },
    }],
    components: [],
  };
}

export function buildRoadmapCard(config = {}) {
  const embed = {
    title: "🧭 Your Dojo Roadmap",
    description: [
      "See exactly where you are right now and the **next step to complete**.",
      "",
      "🏆 **Main goal:** Post your first win.",
    ].join("\n"),
    footer: {
      text: "Most steps check themselves off automatically from your real Discord activity.",
    },
  };

  const components = [{
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        custom_id: "roadmap:v41:view",
        label: "View My Progress",
        emoji: { name: "🧭" },
      },
      {
        type: 2,
        style: 2,
        custom_id: "roadmap:v41:full",
        label: "Full 90 Days",
        emoji: { name: "🗺️" },
      },
      {
        type: 2,
        style: 5,
        url: ONBOARDING_URL,
        label: "Onboarding Video",
        emoji: { name: "👋" },
      },
      {
        type: 2,
        style: 5,
        url: FUNDAMENTALS_URL,
        label: "7-Day Fundamentals",
        emoji: { name: "🧪" },
      },
    ],
  }];

  return {
    content: "",
    embeds: [embed],
    components,
    allowed_mentions: { parse: [] },
  };
}

export function buildRoadmapModel(state) {
  const activation = state?.activation || {};
  const channels = state?.config?.channels || {};

  // Keep the interactive checklist deliberately small. These are all events the
  // Dojo already proves automatically, so members never need to babysit checkboxes.
  const tasks = [
    task("Introduce yourself", Boolean(activation.introduction_posted), channelMention(channels.introductions), "introductions"),
    task("Reply to two other members", Boolean(activation.replied_to_two_members), channelMention(channels.introductions), "introductions"),
    task("Post your first training task", Boolean(activation.first_training_post), channelMention(channels.tasks), "tasks"),
    task("Link your Riot account", Boolean(activation.riot_linked), channelMention(channels.bots), "bots"),
    task("Join a conversation", Boolean(activation.first_general_message), channelMention(channels.general), "general"),
    task("Post your goal", Boolean(activation.goal_posted), channelMention(channels.goals), "goals"),
    task("Post your first win", Boolean(activation.first_win_posted), channelMention(channels.wins), "wins", true),
  ];

  const completed = tasks.filter((item) => item.done).length;
  const next = tasks.find((item) => !item.done) || null;
  return {
    tasks,
    completed,
    total: tasks.length,
    next,
    win_complete: Boolean(activation.first_win_posted),
    win_within_7_days: Boolean(activation.first_win_within_7_days),
    team_application: state?.team_application || null,
    task_stage: state?.task_stage || null,
    channels,
  };
}

async function buildRoadmapView(userId, env, stub, allowPreview = false, allowRoleFallback = false) {
  const state = await stub.getRoadmapV41State(userId, allowPreview, allowRoleFallback);
  if (!state?.ok) throw new Error(state?.message || "Roadmap state unavailable.");
  const model = buildRoadmapModel(state);

  const description = model.win_complete
    ? `**Progress:** ${model.completed}/${model.total}\n🏆 **First Win:** ✅ Complete${model.win_within_7_days ? " within 7 days" : ""}`
    : `**Progress:** ${model.completed}/${model.total}\n🏆 **First Win:** ⬜ Not yet`;

  const fields = [];
  if (model.next) {
    fields.push({
      name: "☑️ Next Task",
      value: `**${model.next.label}**${model.next.link ? `\n${model.next.link}` : ""}`,
      inline: false,
    });
  } else {
    fields.push({
      name: "✅ Starter Roadmap Complete",
      value: "Keep following the full 90-day roadmap and keep stacking wins.",
      inline: false,
    });
  }

  if (model.task_stage?.stage) {
    fields.push({
      name: "🧪 Fundamentals Task Stage",
      value: `**${model.task_stage.label || `Task #${model.task_stage.stage}`}** · highest tagged task submission observed`,
      inline: false,
    });
  }

  if (state.test_mode) {
    fields.push({
      name: "Owner Test Mode",
      value: "This behaves like a real roadmap account for testing, but it is excluded from member activation analytics.",
      inline: false,
    });
  }

  const components = [];
  const primary = [];
  if (!model.win_complete && model.next?.key === "wins") {
    primary.push({
      type: 2,
      style: 3,
      custom_id: "actv40:win",
      label: "Post My First Win",
      emoji: { name: "🏆" },
    });
  } else if (model.next?.channel_id) {
    primary.push({
      type: 2,
      style: 5,
      url: discordChannelUrl(env.DISCORD_GUILD_ID, model.next.channel_id),
      label: "Open Task",
      emoji: { name: "☑️" },
    });
  }
  primary.push({
    type: 2,
    style: 2,
    custom_id: "roadmap:v41:refresh",
    label: "Refresh",
    emoji: { name: "🔄" },
  });
  components.push({ type: 1, components: primary });

  const resources = [
    { type: 2, style: 5, url: ONBOARDING_URL, label: "Onboarding", emoji: { name: "👋" } },
    { type: 2, style: 5, url: FUNDAMENTALS_URL, label: "Fundamentals", emoji: { name: "🧪" } },
  ];
  if (model.channels?.start_here) {
    resources.push({
      type: 2,
      style: 5,
      url: discordChannelUrl(env.DISCORD_GUILD_ID, model.channels.start_here),
      label: "Full Roadmap",
      emoji: { name: "🗺️" },
    });
  }
  components.push({ type: 1, components: resources });
  components.push({
    type: 1,
    components: [{
      type: 2,
      style: 1,
      custom_id: "roadmap:v41:full",
      label: "View Full 90 Days",
      emoji: { name: "🗺️" },
    }],
  });

  return {
    content: "",
    embeds: [{
      title: "🧭 Your Dojo Roadmap",
      description,
      fields,
      footer: {
        text: "Finish the task, then hit Refresh. Automatic steps check themselves off.",
      },
    }],
    components,
  };
}

export function buildMonthOneModel(state, now = new Date()) {
  const completedManual = new Set(state?.manual?.completed || []);
  const tenure = state?.tenure || null;
  const isAnnual = Boolean(tenure?.is_annual);
  const monthlyEligible = Boolean(tenure?.first_eligible_at) && fullMonthsSince(tenure.first_eligible_at, now) >= 1;
  const checkpointEligible = Boolean(state?.test_mode || isAnnual || monthlyEligible);
  const stage = Number(state?.task_stage?.stage || 0);
  const stageLabel = String(state?.task_stage?.label || "");
  const exactMonthTwoReview = stage === 9 && /month\s*2/i.test(stageLabel) && /dm\s*review/i.test(stageLabel);
  const checkpointSubmitted = stage > 9 || exactMonthTwoReview;
  const checkpointComplete = checkpointEligible && checkpointSubmitted;

  const tasks = [
    {
      key: "month1_aim_mastery",
      label: "Aim Mastery Course",
      done: completedManual.has("month1_aim_mastery"),
      instructions: "Complete the Aim Mastery Course before starting the focused mechanics blocks.",
      links: [{ label: "Aim Mastery Course", url: AIM_MASTERY_URL }],
    },
    {
      key: "month1_crosshair",
      label: "Crosshair Placement",
      done: completedManual.has("month1_crosshair"),
      instructions: "Watch the exercise, then do 2 Sheriff DMs/day for 5 days focused on crosshair placement and replacement.",
      links: [{ label: "Crosshair Exercise", url: CROSSHAIR_TRAINING_URL }],
    },
    {
      key: "month1_movement",
      label: "Movement",
      done: completedManual.has("month1_movement"),
      instructions: "Watch the drills, then do 15 minutes in customs for 3 days: pathing, isolating 1v1s, and preparing for common angles.",
      links: [{ label: "Movement Drills", url: MOVEMENT_TRAINING_URL }],
    },
    {
      key: "month1_2ss",
      label: "2SS",
      done: completedManual.has("month1_2ss"),
      instructions: "For 5 days: do the Range/Aim Lab aim-training drills, then 3 Vandal DMs/day practicing 2SS.",
      links: [
        { label: "2SS Breakdown", url: TWO_SS_BREAKDOWN_URL },
        { label: "Aim + 2SS Drills", url: AIM_TRAINING_2SS_URL },
      ],
    },
    {
      key: "month1_checkpoint",
      label: "Mechanics Checkpoint",
      done: checkpointComplete,
      locked: !checkpointEligible,
      instructions: checkpointEligible
        ? "Submit one task in the training forum using the **Month 2 - DM Review** flair. Submission is enough to complete the checkpoint."
        : "Unlocks after one full month in the Dojo. Annual members unlock this immediately.",
      links: [],
    },
  ];

  return {
    tasks,
    completed: tasks.filter((item) => item.done).length,
    total: tasks.length,
    next: tasks.find((item) => !item.done) || null,
    checkpoint_eligible: checkpointEligible,
    checkpoint_submitted: checkpointSubmitted,
    is_annual: isAnnual,
    monthly_eligible: monthlyEligible,
  };
}

function fundamentalsProgress(state) {
  const stage = Number(state?.task_stage?.stage || 0);
  if (stage >= 8) return 7;
  return Math.max(0, Math.min(7, stage));
}

function roadmapSectionNavigation(active = "overview") {
  const items = [
    ["overview", "Overview", "🗺️"],
    ["fundamentals", "Days 1–7", "7️⃣"],
    ["month1", "Month 1", "🎯"],
    ["month2", "Month 2", "🧠"],
    ["month3", "Month 3", "🔍"],
  ];
  return {
    type: 1,
    components: items.map(([key, label, emoji]) => ({
      type: 2,
      style: key === active ? 1 : 2,
      custom_id: `roadmap:v41:section:${key}`,
      label,
      emoji: { name: emoji },
      disabled: key === active,
    })),
  };
}

async function buildRoadmapSectionView(userId, env, stub, section = "overview", allowPreview = false) {
  const state = await stub.getRoadmapV41State(userId, allowPreview, true);
  if (!state?.ok) throw new Error(state?.message || "Roadmap state unavailable.");

  const activationModel = buildRoadmapModel(state);
  const monthOne = buildMonthOneModel(state);
  const fundamentalsDone = fundamentalsProgress(state);
  const components = [roadmapSectionNavigation(section)];
  let embed;

  if (section === "fundamentals") {
    const labels = [
      "Pick one agent",
      "Review your Tracker",
      "Find a duo",
      "Build your routine",
      "Apply the Rule of 2",
      "Learn 2SS Fighting",
      "Use the LEAD Method",
    ];
    embed = {
      title: "7️⃣ Days 1–7 — Fundamentals Sprint",
      description: `**Progress: ${fundamentalsDone}/7**\n\n${labels.map((label, index) => `${fundamentalsDone >= index + 1 ? "✅" : "⬜"} **Day ${index + 1}:** ${label}`).join("\n")}`,
      footer: { text: "Your highest tagged Fundamentals task updates this automatically." },
    };
    components.push({
      type: 1,
      components: [
        { type: 2, style: 5, url: FUNDAMENTALS_URL, label: "Open Fundamentals", emoji: { name: "🧪" } },
        { type: 2, style: 2, custom_id: "roadmap:v41:section:fundamentals", label: "Refresh", emoji: { name: "🔄" } },
      ],
    });
  } else if (section === "month1") {
    const taskLines = monthOne.tasks.map((item, index) => {
      const status = item.done ? "✅" : item.locked ? "🔒" : "⬜";
      return `${status} **${index + 1}. ${item.label}**\n${item.instructions}`;
    });
    embed = {
      title: "🎯 Month 1 — Mechanics",
      description: `**Progress: ${monthOne.completed}/${monthOne.total}**\n\n${taskLines.join("\n\n")}`,
      footer: { text: "Training blocks are trust-based. Finish the block, then mark it complete." },
    };

    const next = monthOne.next;
    if (next) {
      const actions = [];
      for (const link of next.links || []) {
        actions.push({ type: 2, style: 5, url: link.url, label: link.label });
      }
      if (MONTH_ONE_MANUAL_VALUES.has(next.key)) {
        actions.push({
          type: 2,
          style: 3,
          custom_id: `roadmap:v41:complete:${next.key}`,
          label: "Mark Complete",
          emoji: { name: "✅" },
        });
      } else if (next.key === "month1_checkpoint" && !next.locked && state?.config?.channels?.tasks) {
        actions.push({
          type: 2,
          style: 5,
          url: discordChannelUrl(env.DISCORD_GUILD_ID, state.config.channels.tasks),
          label: "Submit Checkpoint",
          emoji: { name: "🏁" },
        });
      }
      actions.push({
        type: 2,
        style: 2,
        custom_id: "roadmap:v41:section:month1",
        label: "Refresh",
        emoji: { name: "🔄" },
      });
      components.push({ type: 1, components: actions.slice(0, 5) });
    }
  } else if (section === "month2") {
    embed = {
      title: "🧠 Month 2 — Agent Hyperfocus",
      description: [
        "**Days 30–40 — Pro Agent Study**",
        "• Pick **1 agent + 1 map** to start.",
        "• Alternate one day of study with one day of practice/application.",
        "• After reviewing a map twice, decide whether to continue or move to the next map.",
        "",
        "**Days 40–50 — Keep Hyperfocusing**",
        "• Continue the same study → practice → apply loop across the maps you need.",
        "",
        "**Days 50–60 — Build & Improve Your Playbook**",
        "• Turn what you learned into repeatable plans and improve them through real games.",
        "• **Day 60:** Submit your playbook.",
      ].join("\n"),
      footer: { text: "Month 2 tracking will be connected after we lock the exact task/checkpoint details." },
    };
  } else if (section === "month3") {
    embed = {
      title: "🔍 Month 3 — Review & Improve",
      description: [
        "**Days 60–90 — Learn to improve yourself**",
        "• Learn how to VOD review.",
        "• Build an improvement mindset.",
        "• Learn where to get your VOD reviewed and when outside coaching helps.",
        "• Review → identify the problem → work on it → review again.",
        "",
        "**Day 90 Checkpoint**",
        "Submit your VOD review notes/session and who you reviewed with.",
      ].join("\n"),
      footer: { text: "Month 3 tracking will be connected after we lock the exact task/checkpoint details." },
    };
  } else {
    embed = {
      title: "🗺️ Your Full 90-Day Roadmap",
      description: "See what you've finished, what you're working on now, and everything still ahead.",
      fields: [
        {
          name: `⚙️ Starter Setup — ${activationModel.completed}/${activationModel.total}`,
          value: activationModel.completed === activationModel.total
            ? "✅ Complete"
            : `Next: **${activationModel.next?.label || "Complete setup"}**`,
          inline: false,
        },
        {
          name: `7️⃣ Days 1–7 — Fundamentals — ${fundamentalsDone}/7`,
          value: fundamentalsDone >= 7 ? "✅ Fundamentals Sprint complete" : "Pick agent → Tracker → Duo → Routine → Rule of 2 → 2SS → LEAD",
          inline: false,
        },
        {
          name: `🎯 Month 1 — Mechanics — ${monthOne.completed}/${monthOne.total}`,
          value: "Aim Mastery → Crosshair Placement → Movement → 2SS → Mechanics Checkpoint",
          inline: false,
        },
        {
          name: "🧠 Month 2 — Agent Hyperfocus",
          value: "Pro Agent Study → Study/Apply loop → Build Playbook → Day 60 Submission",
          inline: false,
        },
        {
          name: "🔍 Month 3 — Review & Improve",
          value: "VOD Review → Improvement Mindset → Get Feedback → Day 90 Submission",
          inline: false,
        },
      ],
      footer: { text: "Use the buttons above to move through each section." },
    };
  }

  return { content: "", embeds: [embed], components };
}

export function formatRoadmapView(model) {
  const lines = [
    `## 🧭 Your Dojo Roadmap — ${model.completed}/${model.total}`,
    model.win_complete
      ? `### 🏆 First Win: ✅ COMPLETE${model.win_within_7_days ? " — within 7 days" : ""}`
      : "### 🏆 First Win: ⬜ NOT YET",
    "",
  ];

  if (model.next) {
    lines.push(
      "### NEXT STEP",
      `**${model.next.label}**${model.next.link ? ` → ${model.next.link}` : ""}`,
      "",
      "_Finish that step and come back here. The bot checks it off automatically._",
    );
  } else {
    lines.push(
      "✅ **Starter activation complete.**",
      "Keep following the full 90-day roadmap and keep stacking wins.",
    );
  }

  if (model.team_application) {
    lines.push("", `Premier application: **${String(model.team_application.status || "pending").toUpperCase()}**`);
  }

  return lines.join("\n").slice(0, 1950);
}

function task(label, done, link = null, key = null, mainGoal = false) {
  const match = /^<#(\d+)>$/.exec(String(link || ""));
  return {
    label,
    done: Boolean(done),
    link: link || null,
    key,
    channel_id: match ? match[1] : null,
    main_goal: Boolean(mainGoal),
  };
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
function commandOption(interaction, name) {
  return (Array.isArray(interaction?.data?.options) ? interaction.data.options : [])
    .find((option) => String(option?.name || "") === String(name || ""))?.value ?? null;
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
  roadmapChannelMatchScore,
  deriveRoadmapActivation,
  buildMonthOneModel,
  fundamentalsProgress,
});
