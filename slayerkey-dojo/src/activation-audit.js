import {
  buildActivationAudit,
  noteThreadEvent,
  observeRiotLink,
  recordLiveActivationMessage,
} from "./activation-core.js";
import {
  beginActivationBackfill,
  getActivationBackfillStatus,
  processActivationBackfillBatch,
} from "./activation-backfill.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const COMMAND_VERSION = "activation-v3";
const COMMAND_STATE_KEY = "activation:v3:command-registration";
const COMMAND_RECHECK_MS = 6 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export {
  beginActivationBackfill,
  getActivationBackfillStatus,
  noteThreadEvent,
  observeRiotLink,
  processActivationBackfillBatch,
  recordLiveActivationMessage,
};

export const ACTIVATION_COMMANDS = Object.freeze([
  {
    name: "activation-audit",
    description: "Review stored Dojo activation milestones",
    type: 1,
  },
  {
    name: "activation-backfill",
    description: "Start or resume the Dojo activation history backfill",
    type: 1,
  },
  {
    name: "activation-backfill-status",
    description: "Show Dojo activation backfill progress",
    type: 1,
  },
]);

export async function handleActivationInteraction(request, env, ctx) {
  const rawBody = await request.text();
  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const command = interaction?.type === 2 ? String(interaction?.data?.name || "") : "";
  if (!ACTIVATION_COMMANDS.some((item) => item.name === command)) return null;

  if (!(await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Invalid request signature", { status: 401 });
  }

  const userId = String(interaction?.member?.user?.id || interaction?.user?.id || "");
  if (userId !== String(env.DISCORD_OWNER_USER_ID || "")) {
    return ephemeralMessage("Only the Dojo owner can use this command.");
  }
  if (String(interaction?.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
    return ephemeralMessage("This command only works in the Slayerkey Discord server.");
  }

  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return ephemeralMessage("Activation storage is unavailable right now.");

  if (command === "activation-audit") {
    ctx.waitUntil(
      runAuditInteraction(interaction, env, stub).catch(async (error) => {
        console.error("activation audit failed:", error);
        await editOriginalInteraction(interaction, env, {
          content: `Activation audit failed: ${safeError(error)}`,
        }).catch(() => {});
      }),
    );
    return deferredEphemeral();
  }

  if (command === "activation-backfill") {
    ctx.waitUntil(
      stub.beginActivationBackfill()
        .then((status) => editOriginalInteraction(interaction, env, {
          content: formatBackfillStatus(status, "Activation backfill started or resumed."),
        }))
        .catch(async (error) => {
          console.error("activation backfill start failed:", error);
          await editOriginalInteraction(interaction, env, {
            content: `Could not start activation backfill: ${safeError(error)}`,
          }).catch(() => {});
        }),
    );
    return deferredEphemeral();
  }

  ctx.waitUntil(
    stub.getActivationBackfillStatus()
      .then((status) => editOriginalInteraction(interaction, env, {
        content: formatBackfillStatus(status),
      }))
      .catch(async (error) => {
        await editOriginalInteraction(interaction, env, {
          content: `Could not read activation backfill status: ${safeError(error)}`,
        }).catch(() => {});
      }),
  );
  return deferredEphemeral();
}

export async function ensureActivationCommandsOnce(env, stub) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN || !stub) return;
  const claimed = await stub.claimActivationCommandRegistration(COMMAND_VERSION).catch(() => false);
  if (!claimed) return;

  try {
    const base = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
    const existing = await discordJson(base, env);
    const byName = new Map((Array.isArray(existing) ? existing : []).map((item) => [String(item?.name || ""), item]));

    for (const command of ACTIVATION_COMMANDS) {
      const current = byName.get(command.name);
      if (!current) {
        await discordJson(base, env, { method: "POST", body: JSON.stringify(command) });
      } else if (String(current.description || "") !== command.description) {
        await discordJson(`${base}/${current.id}`, env, { method: "PATCH", body: JSON.stringify(command) });
      }
    }
    await stub.completeActivationCommandRegistration(COMMAND_VERSION);
  } catch (error) {
    await stub.failActivationCommandRegistration(COMMAND_VERSION, safeError(error)).catch(() => {});
    throw error;
  }
}

export async function claimActivationCommandRegistration(gateway, version) {
  const now = Date.now();
  const state = await gateway.ctx.storage.get(COMMAND_STATE_KEY);
  if (
    state?.status === "complete" &&
    state?.version === version &&
    Date.parse(state?.updated_at || "") > now - COMMAND_RECHECK_MS
  ) return false;
  if (state?.status === "running" && state?.version === version && Number(state?.claimed_at || 0) > now - 10 * 60 * 1000) {
    return false;
  }
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "running",
    claimed_at: now,
    updated_at: new Date(now).toISOString(),
    error: null,
  });
  return true;
}

export async function completeActivationCommandRegistration(gateway, version) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "complete",
    updated_at: new Date().toISOString(),
    error: null,
  });
}

export async function failActivationCommandRegistration(gateway, version, error) {
  await gateway.ctx.storage.put(COMMAND_STATE_KEY, {
    version,
    status: "error",
    updated_at: new Date().toISOString(),
    error: String(error || "unknown").slice(0, 300),
  });
}

export async function getActivationAuditSnapshot(gateway) {
  return buildActivationAudit(gateway);
}

async function runAuditInteraction(interaction, env, stub) {
  const report = await stub.getActivationAuditSnapshot();
  const backfill = report?.backfill_status || await stub.getActivationBackfillStatus().catch(() => null);
  const aggregate = formatAuditSummary(report, backfill);
  await editOriginalInteraction(interaction, env, { content: aggregate });

  const detailLines = ["## Members missing milestones"];
  for (const member of report.members || []) {
    const missing = [];
    if (!member.anchor_valid) {
      missing.push("activation start unknown");
    } else {
      if (!member.introduction_posted) missing.push("introduction");
      if (!member.replied_to_two_members) missing.push("2 intro interactions");
      if (!member.first_training_post) missing.push("training post");
      if (!member.first_general_message) missing.push("general message");
      if (!member.goal_posted) missing.push("goal");
      if (!member.first_win_posted) missing.push("win");
      else if (!member.first_win_within_7_days) missing.push("win within 7d");
    }
    if (!member.riot_linked) missing.push("Riot link not observed");
    if (!missing.length) continue;
    detailLines.push(
      `<@${member.discord_user_id}>${member.membership_active === false ? " (inactive)" : ""}: ${missing.join(", ")}`,
    );
  }

  if (detailLines.length === 1) detailLines.push("No stored members are missing tracked milestones.");
  for (const chunk of chunkLines(detailLines, 1850)) {
    await sendEphemeralFollowup(interaction, env, chunk);
  }
}

function formatAuditSummary(report, backfill) {
  const lines = [
    "## Dojo Activation Audit",
    `**Backfill:** ${backfill?.status || "idle"}${backfill?.phase ? ` (${backfill.phase})` : ""}`,
  ];
  if (backfill?.status !== "complete") {
    lines.push("⚠️ Historical results are incomplete until the activation backfill finishes.");
  }
  lines.push(
    `**Members represented:** ${Number(report?.total_members || 0)}`,
    `**Valid Dojo start date:** ${Number(report?.valid_anchor_members || 0)}`,
    `**Unknown start date:** ${Number(report?.unknown_anchor_members || 0)}`,
    "",
  );

  for (const metric of report?.metrics || []) {
    if (metric.key === "riot_linked") {
      lines.push(`**${metric.label}:** at least ${metric.numerator}/${metric.denominator} (${formatPercent(metric.percentage)})`);
    } else {
      lines.push(`**${metric.label}:** ${metric.numerator}/${metric.denominator} (${formatPercent(metric.percentage)})`);
    }
  }
  lines.push(
    "",
    `**Median time to first training post:** ${formatHours(report?.median_hours_to_training)}`,
    `**Median time to first win:** ${formatHours(report?.median_hours_to_win)}`,
    "",
    `_${report?.riot_note || "Riot milestone data may be historically incomplete."}_`,
  );
  return lines.join("\n").slice(0, 1950);
}

export function formatBackfillStatus(status, prefix = "") {
  const state = status || {};
  const parts = [
    prefix,
    "## Activation Backfill",
    `**Status:** ${state.status || "idle"}`,
    `**Phase:** ${state.phase || "not started"}`,
    `**Seeded members:** ${Number(state.seeded_members || 0)}`,
    `**Sources discovered:** ${Array.isArray(state.sources) ? state.sources.length : 0}`,
    `**Sources completed:** ${Number(state.processed_sources || 0)}`,
    `**Messages scanned:** ${Number(state.processed_messages || 0)}`,
    `**Riot checks processed:** ${Number(state.riot_index || 0)}`,
    state.rate_limit_until ? `**Rate-limit pause until:** ${state.rate_limit_until}` : null,
    state.last_error ? `**Last error:** ${state.last_error}` : null,
    state.completed_at ? `**Completed:** ${state.completed_at}` : null,
  ].filter(Boolean);
  return parts.join("\n").slice(0, 1950);
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

async function editOriginalInteraction(interaction, env, payload) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(payload || {}), allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) throw new Error(`Could not edit activation interaction: ${response.status} ${await response.text()}`);
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
  if (!response.ok) throw new Error(`Could not send activation followup: ${response.status} ${await response.text()}`);
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

function formatPercent(value) {
  return Number.isFinite(value) ? `${value}%` : "n/a";
}

function formatHours(value) {
  if (!Number.isFinite(value)) return "Not enough data";
  if (value < 24) return `${Math.round(value * 10) / 10}h`;
  return `${Math.round((value / 24) * 10) / 10}d`;
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

export const __test = Object.freeze({
  chunkLines,
  formatBackfillStatus,
  formatAuditSummary,
});
