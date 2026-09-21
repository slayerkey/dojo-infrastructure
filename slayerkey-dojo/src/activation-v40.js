import {
  ACTIVATION_DESTINATIONS,
  MEMBER_PREFIX,
  earliestIso,
  mergeTenureIntoRecord,
} from "./activation-core.js";
import {
  applyInterventionAction,
  buildActivationV40Model,
  formatPercent,
  identityFromGuildMember,
  isPrivateTextChannel,
  mergeIdentityIntoRecord,
  previousSevenPhoenixDateKeys,
  resolveDisplayName,
  validateTeamApplication,
} from "./activation-v40-core.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const COMMAND_STATE_KEY = "activation:v40:command-registration";
const COMMAND_RECHECK_MS = 6 * 60 * 60 * 1000;
const INTERVENTION_PREFIX = "activation:v40:intervention:";
const TEAM_CONFIG_KEY = "teamapp:v40:config";
const TEAM_DRAFT_PREFIX = "teamapp:v40:draft:";
const TEAM_APPLICATION_PREFIX = "teamapp:v40:application:";
const TEAM_PUBLIC_CARD_KEY = "teamapp:v41:public-card";
const PREMIER_INFO_MESSAGE_URL = "https://discord.com/channels/1494446702378221590/1529539108597268510/1529545999889072322";
const encoder = new TextEncoder();

export const PROPOSED_FIRST_WIN_DM =
  "Hey {name} — quick Dojo check-in. I want to make sure you're getting an actual win from the roadmap, not just going through lessons. How's it going so far? Open the Dojo Discord and run **/wincheckin** — it gives you 3 one-tap options.";

const FIRST_WIN_CHECKIN_PROMPT =
  "Quick Dojo check-in: have you gotten a real win from the roadmap yet, are you stuck, or have you just not had much time to play?";

export const V40_COMMANDS = Object.freeze([
  {
    name: "activation-queue",
    description: "Show current Dojo members who need activation help",
    type: 1,
  },
  {
    name: "activation-checkin-preview",
    description: "Preview the first-win check-in for one member without sending it",
    type: 1,
    options: [{
      name: "member",
      description: "Member to preview",
      type: 6,
      required: true,
    }],
  },
  {
    name: "wincheckin",
    description: "Tell the Dojo how your first-win progress is going",
    type: 1,
  },
  {
    name: "teamapply",
    description: "Apply for a Dojo Premier team",
    type: 1,
    options: [
      {
        name: "region",
        description: "Premier region",
        type: 3,
        required: true,
        choices: [
          { name: "NA", value: "NA" },
          { name: "EU", value: "EU" },
        ],
      },
      {
        name: "current_rank",
        description: "Your current Valorant rank",
        type: 3,
        required: true,
        max_length: 40,
      },
      {
        name: "peak_rank",
        description: "Your peak Valorant rank",
        type: 3,
        required: true,
        max_length: 40,
      },
    ],
  },
  {
    name: "teamapply-setup",
    description: "Set this private channel as the Premier application inbox",
    type: 1,
  },
  {
    name: "premier-buttons-setup",
    description: "Post or refresh the public Premier application buttons in this channel",
    type: 1,
  },
]);

export async function handleV40Interaction(request, env, ctx) {
  const rawBody = await request.text();
  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const command = interaction?.type === 2 ? String(interaction?.data?.name || "") : "";
  const customId = interaction?.data?.custom_id ? String(interaction.data.custom_id) : "";
  const isV40 =
    ["activation-audit", "activation-queue", "activation-checkin-preview", "wincheckin", "teamapply", "teamapply-setup", "premier-buttons-setup"].includes(command) ||
    customId.startsWith("actv40:") ||
    customId.startsWith("teamapp:v40:") ||
    customId.startsWith("teamapp:v41:") ||
    customId.startsWith("teamapp:v42:");
  if (!isV40) return null;

  if (!(await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid request signature", { status: 401 });
  }
  if (String(interaction?.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
    return ephemeralMessage("This interaction only works in the Slayerkey Discord server.");
  }

  const userId = interactionUserId(interaction);
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return ephemeralMessage("Dojo activation storage is unavailable right now.");

  if (command === "activation-audit") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can use this command.");
    ctx.waitUntil(runV40Audit(interaction, env, stub).catch((error) => failInteraction(interaction, env, "Activation audit failed", error)));
    return deferredEphemeral();
  }

  if (command === "activation-queue") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can use this command.");
    ctx.waitUntil(runV40Queue(interaction, env, stub).catch((error) => failInteraction(interaction, env, "Activation queue failed", error)));
    return deferredEphemeral();
  }

  if (command === "activation-checkin-preview") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can use this command.");
    const targetId = String(getOption(interaction, "member") || "");
    ctx.waitUntil(runCheckinPreview(interaction, targetId, env, stub).catch((error) => failInteraction(interaction, env, "Check-in preview failed", error)));
    return deferredEphemeral();
  }

  if (command === "wincheckin") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use this check-in.");
    return Response.json({
      type: 4,
      data: {
        content: buildCheckinPrompt(resolveInteractionName(interaction)),
        flags: EPHEMERAL,
        components: checkinButtons(false),
        allowed_mentions: { parse: [] },
      },
    });
  }

  if (command === "teamapply-setup") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can configure team applications.");
    ctx.waitUntil(setupTeamApplicationChannel(interaction, env, stub).catch((error) => failInteraction(interaction, env, "Team application setup failed", error)));
    return deferredEphemeral();
  }

  if (command === "premier-buttons-setup") {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can configure Premier application buttons.");
    ctx.waitUntil(setupPremierPublicCard(interaction, env, stub).catch((error) => failInteraction(interaction, env, "Premier button setup failed", error)));
    return deferredEphemeral();
  }

  if (command === "teamapply") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to apply for a team.");
    const draft = {
      region: String(getOption(interaction, "region") || ""),
      current_rank: String(getOption(interaction, "current_rank") || ""),
      peak_rank: String(getOption(interaction, "peak_rank") || ""),
      created_at: new Date().toISOString(),
    };
    const saved = await stub.saveTeamApplicationDraft(userId, draft).catch(() => null);
    if (!saved?.ok) return ephemeralMessage("I could not start the team application right now. Try again in a moment.");
    return teamApplicationModal();
  }

  if (customId === "teamapp:v41:start:NA" || customId === "teamapp:v41:start:EU") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to apply for a team.");
    const region = customId.endsWith(":EU") ? "EU" : "NA";
    const draft = {
      region,
      created_at: new Date().toISOString(),
      source: "premier_public_button",
    };
    const saved = await stub.saveTeamApplicationDraft(userId, draft).catch(() => null);
    if (!saved?.ok) return ephemeralMessage("I could not start the team application right now. Try again in a moment.");
    return quickTeamApplicationModal(region);
  }

  if (customId.startsWith("actv40:mark-sent:")) {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can mark activation outreach.");
    const [, , stage, targetId] = customId.split(":");
    if (!["day3", "day7"].includes(stage) || !targetId) return ephemeralMessage("That outreach action is invalid.");
    const action = stage === "day7" ? "contacted_day7" : "contacted_day3";
    const result = await stub.applyActivationIntervention(targetId, action, String(interaction.id || ""));
    if (!result?.ok) return ephemeralMessage(result?.message || "I could not record that outreach.");
    return Response.json({
      type: 7,
      data: {
        content: `Marked the **${stage === "day7" ? "Day 7" : "Day 3"}** first-win check-in as manually sent for Discord ID **${targetId}**. No DM was sent by the bot.`,
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  }

  if (customId === "actv40:win") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to submit a win.");
    return firstWinModal();
  }

  if (customId === "actv40:stuck" || customId === "actv40:snooze") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to use this check-in.");
    const action = customId.endsWith(":stuck") ? "stuck" : "snooze";
    const result = await stub.applyActivationIntervention(userId, action, String(interaction.id || ""));
    const content = action === "stuck"
      ? "Got it. You're now on the coaching follow-up queue. Bring one specific problem to **Weekly Group Coaching** and keep working the current roadmap step."
      : `Got it. I'll treat this as a play-time issue rather than an improvement issue and snooze the activation follow-up until <t:${Math.floor(Date.parse(result?.state?.snooze_until || 0) / 1000)}:R>.`;
    return Response.json({
      type: 7,
      data: { content, components: [], allowed_mentions: { parse: [] } },
    });
  }

  if (customId === "actv40:winmodal") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to submit a win.");
    const improved = modalValue(interaction, "improved");
    const helped = modalValue(interaction, "helped");
    const identity = identityFromInteraction(interaction);
    const now = new Date().toISOString();
    const result = await stub.recordActivationCheckinWin(
      userId,
      now,
      String(interaction.id || ""),
      identity,
    );
    if (!result?.ok) return ephemeralMessage(result?.message || "I could not save that win.");
    if (result.already_recorded || result.duplicate) {
      return ephemeralMessage("Your first win is already recorded, so I did not create another Wins post.");
    }
    ctx.waitUntil(
      publishFirstWin(interaction, improved, helped, env, stub)
        .then((thread) => editOriginalInteraction(interaction, env, {
          content: thread?.id
            ? "Win recorded. I also shared it in **Wins**."
            : "Win recorded. The Wins post could not be created, but your activation milestone is saved.",
          components: [],
        }))
        .catch((error) => failInteraction(interaction, env, "Your win was recorded, but the Wins post failed", error)),
    );
    return deferredEphemeral();
  }

  if (customId === "teamapp:v41:quick-submit") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to submit a team application.");
    const fields = {
      current_rank: modalValue(interaction, "current_rank"),
      peak_rank: modalValue(interaction, "peak_rank"),
      role_agents: modalValue(interaction, "role_agents"),
      availability: modalValue(interaction, "availability"),
      tracker_link: modalValue(interaction, "tracker_link"),
      team_goal: null,
    };
    let application;
    try {
      application = await stub.completeTeamApplication(
        userId,
        String(interaction.id || ""),
        fields,
        identityFromInteraction(interaction),
      );
    } catch (error) {
      return ephemeralMessage(`Application could not be saved: ${safeError(error)}`);
    }
    if (!application?.ok) return ephemeralMessage(application?.message || "Application could not be saved.");
    if (application.duplicate) return ephemeralMessage("Your Premier team application was already submitted. I did not create a duplicate.");

    ctx.waitUntil(
      publishTeamApplication(application.application, env, stub)
        .then(() => editOriginalInteraction(interaction, env, {
          content: "Your Premier team application was submitted privately to the team application inbox.",
        }))
        .catch((error) => failInteraction(interaction, env, "Application saved, but staff delivery failed", error)),
    );
    return deferredEphemeral();
  }

  if (customId === "teamapp:v40:submit") {
    if (!hasDojoAccess(interaction, env)) return ephemeralMessage("You need the Dojo role to submit a team application.");
    const fields = {
      role_agents: modalValue(interaction, "role_agents"),
      availability: modalValue(interaction, "availability"),
      tracker_link: modalValue(interaction, "tracker_link"),
      team_goal: modalValue(interaction, "team_goal"),
    };
    let application;
    try {
      application = await stub.completeTeamApplication(
        userId,
        String(interaction.id || ""),
        fields,
        identityFromInteraction(interaction),
      );
    } catch (error) {
      return ephemeralMessage(`Application could not be saved: ${safeError(error)}`);
    }
    if (!application?.ok) return ephemeralMessage(application?.message || "Application could not be saved.");
    if (application.duplicate) return ephemeralMessage("Your Premier team application was already submitted. I did not create a duplicate.");

    ctx.waitUntil(
      publishTeamApplication(application.application, env, stub)
        .then(() => editOriginalInteraction(interaction, env, {
          content: "Your Premier team application was submitted privately to the team application inbox.",
        }))
        .catch((error) => failInteraction(interaction, env, "Application saved, but staff delivery failed", error)),
    );
    return deferredEphemeral();
  }

  if (customId.startsWith("teamapp:v40:status:")) {
    if (!isOwner(userId, env)) return ephemeralMessage("Only the Dojo owner can change application status.");
    const [, , , status, targetId] = customId.split(":");
    if (!["accepted", "waitlisted", "declined"].includes(status) || !targetId) {
      return ephemeralMessage("That team application action is invalid.");
    }
    const updated = await stub.updateTeamApplicationStatus(targetId, status, userId);
    if (!updated?.ok) return ephemeralMessage(updated?.message || "Application could not be updated.");
    return Response.json({
      type: 7,
      data: {
        content: renderTeamApplication(updated.application),
        components: teamApplicationStatusButtons(updated.application),
        allowed_mentions: { parse: [] },
      },
    });
  }

  return null;
}

export async function ensureV40CommandsOnce(env, stub) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN || !stub) return;
  const claimed = await stub.claimV40CommandRegistration("activation-v40.1").catch(() => false);
  if (!claimed) return;
  try {
    const base = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
    const existing = await discordJson(base, env);
    const byName = new Map((Array.isArray(existing) ? existing : []).map((item) => [String(item?.name || ""), item]));
    for (const command of V40_COMMANDS) {
      const current = byName.get(command.name);
      if (!current) {
        await discordJson(base, env, { method: "POST", body: JSON.stringify(command) });
      } else if (commandSignature(current) !== commandSignature(command)) {
        await discordJson(`${base}/${current.id}`, env, { method: "PATCH", body: JSON.stringify(command) });
      }
    }
    await stub.completeV40CommandRegistration("activation-v40.1");
  } catch (error) {
    await stub.failV40CommandRegistration("activation-v40.1", safeError(error)).catch(() => {});
    throw error;
  }
}

export async function claimV40CommandRegistration(gateway, version) {
  const now = Date.now();
  const state = await gateway.ctx.storage.get(COMMAND_STATE_KEY);
  if (state?.status === "complete" && state?.version === version && Date.parse(state?.updated_at || "") > now - COMMAND_RECHECK_MS) return false;
  if (state?.status === "running" && state?.version === version && Number(state?.claimed_at || 0) > now - 10 * 60 * 1000) return false;
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "running",
    claimed_at: now,
    updated_at: new Date(now).toISOString(),
    error: null,
  });
  return true;
}

export async function completeV40CommandRegistration(gateway, version) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "complete",
    updated_at: new Date().toISOString(),
    error: null,
  });
}

export async function failV40CommandRegistration(gateway, version, error) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "error",
    updated_at: new Date().toISOString(),
    error: safeError(error),
  });
}

export async function getActivationV40Snapshot(gateway) {
  const [stored, tenures, interventionRows] = await Promise.all([
    gateway.ctx.storage.list({ prefix: MEMBER_PREFIX }),
    gateway.listTenureRecords?.().catch(() => []),
    gateway.ctx.storage.list({ prefix: INTERVENTION_PREFIX }),
  ]);
  const tenureById = new Map((Array.isArray(tenures) ? tenures : []).map((item) => [String(item?.discord_user_id || ""), item]));
  const records = [];
  for (const [key, value] of stored.entries()) {
    const userId = String(key).slice(MEMBER_PREFIX.length);
    records.push(mergeTenureIntoRecord(value, userId, tenureById.get(userId) || null));
    tenureById.delete(userId);
  }
  for (const [userId, tenure] of tenureById) {
    if (userId) records.push(mergeTenureIntoRecord(null, userId, tenure));
  }
  const interventions = {};
  for (const [key, value] of interventionRows.entries()) {
    interventions[String(key).slice(INTERVENTION_PREFIX.length)] = value;
  }
  return { records, interventions };
}

export async function hydrateActivationIdentities(gateway, identities) {
  const tenures = await gateway.listTenureRecords?.().catch(() => []);
  const tenureById = new Map((Array.isArray(tenures) ? tenures : []).map((item) => [String(item?.discord_user_id || ""), item]));
  let updated = 0;
  for (const identity of Array.isArray(identities) ? identities : []) {
    const userId = String(identity?.discord_user_id || "");
    if (!userId) continue;
    const key = `${MEMBER_PREFIX}${userId}`;
    let record = await gateway.ctx.storage.get(key);
    const tenure = tenureById.get(userId) || null;
    if (!record && !tenure) continue;
    record = mergeTenureIntoRecord(record, userId, tenure);
    record = mergeIdentityIntoRecord(record, identity);
    record.updated_at = new Date().toISOString();
    await gateway.ctx.storage.put(key, record);
    updated += 1;
  }
  return { ok: true, updated };
}

export async function applyActivationIntervention(gateway, discordUserId, action, interactionId) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };
  const key = `${INTERVENTION_PREFIX}${userId}`;
  const previous = await gateway.ctx.storage.get(key);
  const result = applyInterventionAction(previous, action, new Date().toISOString(), interactionId);
  if (!result.duplicate) await gateway.ctx.storage.put(key, result.state);
  return { ok: true, ...result };
}

export async function recordActivationCheckinWin(gateway, discordUserId, timestamp, interactionId, identity) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, message: "Missing Discord user." };
  const tenure = await gateway.getTenureRecord?.(userId).catch(() => null);
  const key = `${MEMBER_PREFIX}${userId}`;
  let record = await gateway.ctx.storage.get(key);
  if (!record && !tenure) return { ok: false, message: "This Discord account is not in the known Dojo cohort." };

  record = mergeTenureIntoRecord(record, userId, tenure);
  record = mergeIdentityIntoRecord(record, identity);
  if (!record.activation_started_at || !Number.isFinite(Date.parse(record.activation_started_at))) {
    return { ok: false, message: "Your Dojo activation start date is unknown, so I cannot safely record a timed first-win milestone." };
  }
  const at = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString();
  if (Date.parse(at) < Date.parse(record.activation_started_at)) {
    return { ok: false, message: "The win timestamp is before the Dojo activation start date." };
  }

  const interventionKey = `${INTERVENTION_PREFIX}${userId}`;
  const previousIntervention = await gateway.ctx.storage.get(interventionKey);
  if (previousIntervention?.last_interaction_id === String(interactionId || "")) {
    return { ok: true, duplicate: true, already_recorded: Boolean(record.first_win_at), record, intervention: previousIntervention };
  }
  if (record.first_win_at && Number.isFinite(Date.parse(record.first_win_at))) {
    return { ok: true, duplicate: false, already_recorded: true, record, intervention: previousIntervention || null };
  }

  record.first_win_at = at;
  record.first_win_source = "self_report_modal";
  record.first_win_self_reported_at = at;
  record.updated_at = new Date().toISOString();
  await gateway.ctx.storage.put(key, record);

  const intervention = applyInterventionAction(previousIntervention, "win", at, interactionId);
  if (!intervention.duplicate) await gateway.ctx.storage.put(interventionKey, intervention.state);
  return { ok: true, duplicate: intervention.duplicate, already_recorded: false, record, intervention: intervention.state };
}

export async function saveTeamApplicationDraft(gateway, discordUserId, draft) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false };
  await gateway.ctx.storage.put(`${TEAM_DRAFT_PREFIX}${userId}`, {
    ...(draft || {}),
    discord_user_id: userId,
  });
  return { ok: true };
}

export async function completeTeamApplication(gateway, discordUserId, interactionId, fields, identity) {
  const userId = String(discordUserId || "");
  const key = `${TEAM_APPLICATION_PREFIX}${userId}`;
  const existing = await gateway.ctx.storage.get(key);
  if (existing?.last_interaction_id === String(interactionId || "")) {
    return { ok: true, duplicate: true, application: existing };
  }

  const draftKey = `${TEAM_DRAFT_PREFIX}${userId}`;
  const draft = await gateway.ctx.storage.get(draftKey);
  if (!draft) return { ok: false, message: "Your team application draft expired. Run /teamapply again." };
  if (Date.now() - Date.parse(draft.created_at || 0) > 30 * 60 * 1000) {
    await gateway.ctx.storage.delete(draftKey);
    return { ok: false, message: "Your team application draft expired. Run /teamapply again." };
  }

  const validated = validateTeamApplication({ ...draft, ...(fields || {}) });

  const application = {
    version: 1,
    discord_user_id: userId,
    display_name: identity?.display_name || null,
    global_name: identity?.global_name || null,
    username: identity?.username || null,
    ...validated,
    status: "pending",
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_interaction_id: String(interactionId || ""),
    application_message_id: null,
  };
  const enriched = mergeIdentityIntoRecord(application, { ...(identity || {}), discord_user_id: userId });
  await gateway.ctx.storage.put(key, enriched);
  await gateway.ctx.storage.delete(draftKey);
  return { ok: true, duplicate: false, application: enriched };
}

export async function setTeamApplicationConfig(gateway, config) {
  await gateway.ctx.storage.put(TEAM_CONFIG_KEY, { ...(config || {}), updated_at: new Date().toISOString() });
  return { ok: true };
}

export async function getTeamApplicationConfig(gateway) {
  return (await gateway.ctx.storage.get(TEAM_CONFIG_KEY)) || null;
}

export async function attachTeamApplicationMessage(gateway, discordUserId, messageId) {
  const key = `${TEAM_APPLICATION_PREFIX}${String(discordUserId || "")}`;
  const application = await gateway.ctx.storage.get(key);
  if (!application) return { ok: false };
  application.application_message_id = String(messageId || "");
  application.updated_at = new Date().toISOString();
  await gateway.ctx.storage.put(key, application);
  return { ok: true };
}

export async function updateTeamApplicationStatus(gateway, discordUserId, status, actorId, reason = null) {
  if (!["accepted", "waitlisted", "declined"].includes(status)) return { ok: false, message: "Invalid application status." };
  const key = `${TEAM_APPLICATION_PREFIX}${String(discordUserId || "")}`;
  const application = await gateway.ctx.storage.get(key);
  if (!application) return { ok: false, message: "Application not found." };
  const next = {
    ...application,
    status,
    status_updated_by: String(actorId || ""),
    status_updated_at: new Date().toISOString(),
    decision_reason: status === "declined" ? String(reason || "").trim() || null : null,
    updated_at: new Date().toISOString(),
  };
  await gateway.ctx.storage.put(key, next);
  return { ok: true, application: next };
}

async function runV40Audit(interaction, env, stub) {
  const runtime = await buildV40Runtime(env, stub);
  await editOriginalInteraction(interaction, env, { content: formatV40Audit(runtime.model) });
}

async function runV40Queue(interaction, env, stub) {
  const runtime = await buildV40Runtime(env, stub);
  const model = runtime.model;
  const both = model.queue.attention.filter((member) => member.needs_first_win && member.dormant).length;
  const summary = [
    "## Dojo Activation Queue",
    `**No first win — 7+ days:** ${model.needs_action.day7}`,
    `**Early no-win — days 3–6:** ${model.needs_action.day3}`,
    `**0 messages in the last 7 days:** ${model.needs_action.dormant}`,
    `**Both no-win + 0 messages:** ${both}`,
    "",
    "**Dormant = a current Dojo member with 0 tracked Discord messages in the previous 7 completed Arizona days.**",
    "The same person can appear as both no-win and dormant. Click the member mention to open their Discord profile.",
  ].join("\n");
  await editOriginalInteraction(interaction, env, { content: summary });

  if (!model.queue.attention.length) {
    await sendEphemeralFollowup(interaction, env, "✅ No current members need activation attention right now.");
    return;
  }

  const lines = ["## MEMBERS TO CHECK"];
  for (const member of model.queue.attention) lines.push(formatQueueMember(member));
  for (const chunk of chunkLines(lines, 1850)) {
    await sendEphemeralFollowup(interaction, env, chunk);
  }
}

async function runCheckinPreview(interaction, targetId, env, stub) {
  const runtime = await buildV40Runtime(env, stub);
  const target = runtime.members.find((member) => String(member?.user?.id || "") === String(targetId || ""));
  const stored = (runtime.snapshot?.records || []).find((record) => String(record?.discord_user_id || "") === String(targetId || ""));
  const currentIdentity = target ? identityFromGuildMember(target) : null;
  const name = resolveDisplayName(targetId, currentIdentity, stored);
  const stage = runtime.model.queue.day7.some((member) => member.discord_user_id === targetId)
    ? "day7"
    : runtime.model.queue.day3.some((member) => member.discord_user_id === targetId)
      ? "day3"
      : null;
  const components = [...checkinButtons(true)];
  if (stage) {
    components.push({
      type: 1,
      components: [{
        type: 2,
        style: 1,
        custom_id: `actv40:mark-sent:${stage}:${targetId}`,
        label: `Mark ${stage === "day7" ? "Day 7" : "Day 3"} DM Sent`,
      }],
    });
  }
  await editOriginalInteraction(interaction, env, {
    content: `## First-Win Check-In Preview\n**Member:** ${name}\n\n**Copy/paste this DM manually:**\n${buildProposedDm(name)}\n\n_No DM was sent. Automated DMs are disabled.${stage ? " After you send it manually, click the button below so this member is not repeatedly nudged at the same stage." : ""}_`,
    components,
  });
}

async function buildV40Runtime(env, stub) {
  const dates = previousSevenPhoenixDateKeys(new Date());
  const [members, snapshot, totals] = await Promise.all([
    fetchCurrentDojoMembers(env),
    stub.getActivationV40Snapshot(),
    stub.getActivityCounts(dates),
  ]);
  const identities = members.map((member) => identityFromGuildMember(member));
  await stub.hydrateActivationIdentities(identities).catch(() => {});
  const records = snapshot?.records || [];
  const model = buildActivationV40Model({
    records,
    currentMembers: members,
    totals: totals || {},
    interventions: snapshot?.interventions || {},
    now: new Date(),
  });
  return { members, snapshot, totals, model };
}

async function setupPremierPublicCard(interaction, env, stub) {
  const channelId = String(interaction?.channel_id || "");
  if (!channelId) throw new Error("Missing Premier info channel.");

  const previous = await stub.getPremierPublicCardConfig().catch(() => null);
  const payload = {
    content: [
      "## 🤼 Apply for a Premier Team",
      "Pick your region and fill out the short application. Your answers are sent privately to the Dojo staff inbox.",
      "",
      "Use the Premier info post above for the full details.",
    ].join("\n"),
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: "teamapp:v41:start:NA", label: "Apply — NA" },
          { type: 2, style: 1, custom_id: "teamapp:v41:start:EU", label: "Apply — EU" },
          { type: 2, style: 5, url: PREMIER_INFO_MESSAGE_URL, label: "Premier Info" },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };

  let message = null;
  if (previous?.channel_id === channelId && previous?.message_id) {
    try {
      message = await discordJson(`${DISCORD_API}/channels/${channelId}/messages/${previous.message_id}`, env, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } catch {}
  }
  if (!message) {
    message = await discordJson(`${DISCORD_API}/channels/${channelId}/messages`, env, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  await stub.setPremierPublicCardConfig({
    channel_id: channelId,
    message_id: String(message?.id || ""),
    info_message_url: PREMIER_INFO_MESSAGE_URL,
    configured_by: interactionUserId(interaction),
    configured_at: new Date().toISOString(),
  });

  await editOriginalInteraction(interaction, env, {
    content: "Premier application buttons are live in this channel. Members can now click **Apply — NA** or **Apply — EU**.",
  });
}

export async function setPremierPublicCardConfig(gateway, config) {
  const next = { ...(config || {}), updated_at: new Date().toISOString() };
  await gateway.ctx.storage.put(TEAM_PUBLIC_CARD_KEY, next);
  return { ok: true, config: next };
}

export async function getPremierPublicCardConfig(gateway) {
  return (await gateway.ctx.storage.get(TEAM_PUBLIC_CARD_KEY)) || null;
}

async function setupTeamApplicationChannel(interaction, env, stub) {
  const channelId = String(interaction?.channel_id || "");
  const channel = await discordJson(`${DISCORD_API}/channels/${channelId}`, env);
  const parent = channel?.parent_id
    ? await discordJson(`${DISCORD_API}/channels/${channel.parent_id}`, env).catch(() => null)
    : null;
  if (!isPrivateTextChannel(channel, env.DISCORD_GUILD_ID, parent)) {
    await editOriginalInteraction(interaction, env, {
      content: "I did not configure this channel. Team applications must go to a private text channel whose @everyone role cannot View Channel (directly or through its parent category).",
    });
    return;
  }
  await stub.setTeamApplicationConfig({
    channel_id: channelId,
    channel_name: String(channel?.name || ""),
    configured_by: interactionUserId(interaction),
    configured_at: new Date().toISOString(),
  });
  await editOriginalInteraction(interaction, env, {
    content: `Premier team applications will be delivered privately to **#${channel?.name || "this-channel"}**. Applicants can now use **/teamapply**.`,
  });
}

async function publishFirstWin(interaction, improved, helped, env, stub) {
  const userId = interactionUserId(interaction);
  const snapshot = await stub.getActivationV40Snapshot().catch(() => null);
  const stored = (snapshot?.records || []).find((record) => String(record?.discord_user_id || "") === userId);
  const name = resolveDisplayName(userId, identityFromInteraction(interaction), stored);
  const content = [
    `**First win shared by ${escapeDiscord(name)}**`,
    "",
    `**What improved:** ${sanitizeUserText(improved, 900)}`,
    helped ? `**What helped:** ${sanitizeUserText(helped, 900)}` : null,
  ].filter(Boolean).join("\n");
  const thread = await discordJson(`${DISCORD_API}/channels/${ACTIVATION_DESTINATIONS.wins}/threads`, env, {
    method: "POST",
    body: JSON.stringify({
      name: trimForumTitle(`${name} — First Win`),
      message: {
        content,
        allowed_mentions: { parse: [] },
      },
    }),
  });
  return thread;
}

async function publishTeamApplication(application, env, stub) {
  const config = await stub.getTeamApplicationConfig();
  if (!config?.channel_id) throw new Error("No private team application channel is configured. Run /teamapply-setup in the staff channel.");

  const channel = await discordJson(`${DISCORD_API}/channels/${config.channel_id}`, env);
  const parent = channel?.parent_id
    ? await discordJson(`${DISCORD_API}/channels/${channel.parent_id}`, env).catch(() => null)
    : null;
  if (!isPrivateTextChannel(channel, env.DISCORD_GUILD_ID, parent)) {
    throw new Error("The configured team application inbox is no longer private. Re-run /teamapply-setup in a private staff channel.");
  }

  const message = await discordJson(`${DISCORD_API}/channels/${config.channel_id}/messages`, env, {
    method: "POST",
    body: JSON.stringify({
      content: renderTeamApplication(application),
      components: teamApplicationStatusButtons(application),
      allowed_mentions: { parse: [] },
    }),
  });
  if (message?.id) await stub.attachTeamApplicationMessage(application.discord_user_id, message.id);
  return message;
}

function formatV40Audit(model) {
  return [
    "## Dojo Activation",
    `**Current members:** ${model.current_members}`,
    `**Historical members represented:** ${model.historical_members}`,
    model.unknown_current_start ? `**Current members with unknown start date:** ${model.unknown_current_start}` : null,
    "",
    "### 🏆 FIRST WIN",
    `**Activated within 7 days:** ${model.activated_within_7_days}/${model.activation_denominator} (${formatPercent(model.activated_within_7_days, model.activation_denominator)})`,
    `**Ever posted a win:** ${model.ever_posted_win}/${model.current_members} (${formatPercent(model.ever_posted_win, model.current_members)})`,
    `**Still need first win:** ${model.still_need_first_win}`,
    "",
    "### CURRENT ENGAGEMENT",
    `**5+ messages this week:** ${model.engagement.active}`,
    `**1–4 messages:** ${model.engagement.low}`,
    `**0 messages:** ${model.engagement.zero}`,
    "",
    "### NEEDS ACTION",
    `**7+ days without a first win:** ${model.needs_action.day7}`,
    `**0 messages in the last 7 days:** ${model.needs_action.dormant}`,
    `**Early no-win (days 3–6):** ${model.needs_action.day3}`,
    "",
    "_No-win and zero-message groups can overlap. Use /activation-queue for clickable member profiles._",
  ].filter(Boolean).join("\n").slice(0, 1950);
}

function formatQueueMember(member) {
  const win = member.first_win_posted ? "✅" : "❌";
  const days = Number.isFinite(member.days_since_activation) ? `Day ${member.days_since_activation}` : "Start unknown";
  const flags = [
    member.no_win_stage === "day7" ? "7+ DAY NO WIN" : member.no_win_stage === "day3" ? "3–6 DAY NO WIN" : null,
    member.dormant ? "0 MSGS / 7D" : null,
    member.stuck ? "STUCK" : null,
  ].filter(Boolean).join(" · ");
  const mention = member.discord_user_id ? `<@${member.discord_user_id}>` : escapeDiscord(member.display_name);
  return `${mention} — ${days} · Win ${win} · 7d msgs **${member.messages_last_7_days}**${flags ? ` · **${flags}**` : ""}`;
}

function buildProposedDm(name) {
  return PROPOSED_FIRST_WIN_DM.replace("{name}", escapeDiscord(name || "there"));
}

function buildCheckinPrompt(name) {
  const safeName = escapeDiscord(name || "there");
  return `**${safeName}**, ${FIRST_WIN_CHECKIN_PROMPT}`;
}

function checkinButtons(disabled) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: "actv40:win", label: "I HAVE A WIN", disabled: Boolean(disabled) },
      { type: 2, style: 1, custom_id: "actv40:stuck", label: "I'M STUCK", disabled: Boolean(disabled) },
      { type: 2, style: 2, custom_id: "actv40:snooze", label: "HAVEN'T PLAYED MUCH", disabled: Boolean(disabled) },
    ],
  }];
}

function firstWinModal() {
  return Response.json({
    type: 9,
    data: {
      custom_id: "actv40:winmodal",
      title: "Share Your First Win",
      components: [
        textInput("improved", "What improved?", true, 2, 10, 900, "What changed in your gameplay or results?"),
        textInput("helped", "What helped?", false, 2, 0, 900, "Optional: lesson, routine, teammate, coaching, etc."),
      ],
    },
  });
}

function quickTeamApplicationModal(region) {
  return Response.json({
    type: 9,
    data: {
      custom_id: "teamapp:v41:quick-submit",
      title: `Premier Application — ${region}`,
      components: [
        textInput("current_rank", "Current rank", true, 1, 2, 40, "Example: Diamond 2"),
        textInput("peak_rank", "Peak rank", true, 1, 2, 40, "Example: Ascendant 1"),
        textInput("role_agents", "Main role / preferred agents", true, 1, 2, 200, "Example: Controller — Omen, Viper"),
        textInput("availability", "Typical availability + timezone", true, 2, 4, 400, "Example: Mon–Thu 7–10pm MST"),
        textInput("tracker_link", "Riot Tracker link", true, 1, 8, 500, "https://tracker.gg/..."),
      ],
    },
  });
}

function teamApplicationModal() {
  return Response.json({
    type: 9,
    data: {
      custom_id: "teamapp:v40:submit",
      title: "Premier Team Application",
      components: [
        textInput("role_agents", "Main role / preferred agents", true, 1, 2, 200, "Example: Controller — Omen, Viper"),
        textInput("availability", "Typical availability", true, 2, 4, 400, "Days, times, and timezone"),
        textInput("tracker_link", "Riot Tracker link", true, 1, 8, 500, "https://tracker.gg/..."),
        textInput("team_goal", "What do you want from a team?", true, 2, 10, 800, "What are you looking to improve or accomplish?"),
      ],
    },
  });
}

function textInput(customId, label, required, style, minLength, maxLength, placeholder) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: customId,
      label,
      style,
      required,
      min_length: minLength || undefined,
      max_length: maxLength,
      placeholder,
    }],
  };
}

function renderTeamApplication(application) {
  return [
    "## Premier Team Application",
    `**Member:** ${escapeDiscord(resolveDisplayName(application.discord_user_id, application, application))}`,
    `**Discord ID:** ${application.discord_user_id}`,
    `**Status:** ${String(application.status || "pending").toUpperCase()}`,
    `**Region:** ${escapeDiscord(application.region)}`,
    `**Current rank:** ${escapeDiscord(application.current_rank)}`,
    `**Peak rank:** ${escapeDiscord(application.peak_rank)}`,
    `**Role / agents:** ${escapeDiscord(application.role_agents)}`,
    `**Availability:** ${escapeDiscord(application.availability)}`,
    `**Tracker:** ${application.tracker_link}`,
    application.team_goal ? `**What they want:** ${escapeDiscord(application.team_goal)}` : null,
    `**Submitted:** ${relativeDiscordTime(application.submitted_at)}`,
  ].filter(Boolean).join("\n").slice(0, 1950);
}

function teamApplicationStatusButtons(application) {
  const status = String(application?.status || "pending");
  const id = String(application?.discord_user_id || "");
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: `teamapp:v40:status:accepted:${id}`, label: "Accept", disabled: status === "accepted" },
      { type: 2, style: 2, custom_id: `teamapp:v40:status:waitlisted:${id}`, label: "Waitlist", disabled: status === "waitlisted" },
      { type: 2, style: 4, custom_id: `teamapp:v40:status:declined:${id}`, label: "Decline", disabled: status === "declined" },
    ],
  }];
}

async function fetchCurrentDojoMembers(env) {
  const roleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!roleId) throw new Error("DISCORD_DOJO_ROLE_ID is missing.");
  const members = [];
  let after = "0";
  while (true) {
    const page = await discordJson(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${encodeURIComponent(after)}`,
      env,
    );
    if (!Array.isArray(page)) break;
    for (const member of page) {
      const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
      if (!member?.user?.bot && roles.includes(roleId)) members.push(member);
    }
    if (page.length < 1000) break;
    const last = String(page[page.length - 1]?.user?.id || "");
    if (!last || last === after) break;
    after = last;
  }
  return members;
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
  if (response.status === 429) {
    let retry = 1;
    try {
      const body = await response.clone().json();
      retry = Math.max(1, Number(body?.retry_after || 1));
    } catch {}
    throw new Error(`Discord rate limited. Retry after ${retry}s.`);
  }
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.status === 204 ? null : response.json();
}

function commandSignature(command) {
  return JSON.stringify({
    name: command?.name,
    description: command?.description,
    type: command?.type,
    options: normalizeCommandOptions(command?.options || []),
  });
}

function normalizeCommandOptions(options) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    name: option?.name,
    description: option?.description,
    type: option?.type,
    required: Boolean(option?.required),
    max_length: option?.max_length ?? null,
    min_length: option?.min_length ?? null,
    choices: (Array.isArray(option?.choices) ? option.choices : []).map((choice) => ({
      name: choice?.name,
      value: choice?.value,
    })),
    options: normalizeCommandOptions(option?.options || []),
  }));
}

function getOption(interaction, name) {
  return interaction?.data?.options?.find((option) => option?.name === name)?.value ?? null;
}

function modalValue(interaction, customId) {
  for (const row of interaction?.data?.components || []) {
    for (const component of row?.components || []) {
      if (component?.custom_id === customId) return String(component?.value || "").trim();
    }
  }
  return "";
}

function identityFromInteraction(interaction) {
  const user = interaction?.member?.user || interaction?.user || {};
  return {
    discord_user_id: String(user?.id || ""),
    display_name: String(interaction?.member?.nick || "").trim() || null,
    global_name: String(user?.global_name || "").trim() || null,
    username: String(user?.username || "").trim() || null,
    last_identity_seen_at: new Date().toISOString(),
  };
}

function resolveInteractionName(interaction) {
  const identity = identityFromInteraction(interaction);
  return identity.display_name || identity.global_name || identity.username || "there";
}

function interactionUserId(interaction) {
  return String(interaction?.member?.user?.id || interaction?.user?.id || "");
}

function hasDojoAccess(interaction, env) {
  if (isOwner(interactionUserId(interaction), env)) return true;
  const roles = Array.isArray(interaction?.member?.roles) ? interaction.member.roles.map(String) : [];
  return roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}

function isOwner(userId, env) {
  return String(userId || "") === String(env.DISCORD_OWNER_USER_ID || "");
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const value = String(hex || "").trim();
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2) throw new Error("Invalid hex");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

function deferredEphemeral() {
  return Response.json({ type: 5, data: { flags: EPHEMERAL } });
}

function ephemeralMessage(content) {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

async function editOriginalInteraction(interaction, env, payload) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(payload || {}), allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) throw new Error(`Could not edit interaction: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

async function sendEphemeralFollowup(interaction, env, content) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) throw new Error(`Could not send followup: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

async function failInteraction(interaction, env, prefix, error) {
  console.error(prefix, error);
  await editOriginalInteraction(interaction, env, {
    content: `${prefix}: ${safeError(error)}`,
    components: [],
  }).catch(() => {});
}

function chunkLines(lines, max) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function relativeDiscordTime(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:R>` : "unknown";
}

function trimForumTitle(value) {
  const text = String(value || "First Win").replace(/[\r\n]+/g, " ").trim();
  return text.slice(0, 100) || "First Win";
}

function sanitizeUserText(value, max) {
  const text = String(value || "").replace(/@/g, "@\u200b").trim();
  return escapeDiscord(text.slice(0, max)) || "Not provided";
}

function escapeDiscord(value) {
  return String(value ?? "")
    .replace(/@/g, "@\u200b")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~");
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

export const __test = Object.freeze({
  buildCheckinPrompt,
  buildProposedDm,
  checkinButtons,
  commandSignature,
  formatQueueMember,
  formatV40Audit,
  renderTeamApplication,
  teamApplicationStatusButtons,
});
