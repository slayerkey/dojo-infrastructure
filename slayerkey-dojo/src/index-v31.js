import legacy, { DiscordGateway as DiscordGatewayV30 } from "./index-v30.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const encoder = new TextEncoder();

const ROLE_DEFINITIONS = [
  { key: "annual", name: "Annual Member" },
  { key: "m1", name: "Month 1 • Rookie" },
  { key: "m2", name: "Month 2 • Contender" },
  { key: "m3", name: "Month 3 • Competitor" },
  { key: "m4", name: "Month 4 • Challenger" },
  { key: "m5", name: "Month 5 • Veteran" },
  { key: "m6", name: "Month 6 • Elite" },
  { key: "y1", name: "Year 1 • Master" },
  { key: "y2", name: "Year 2 • Legend" },
  { key: "y3", name: "Year 3 • Icon" },
];

const OWNER_COMMANDS = [
  {
    name: "activitystatus",
    description: "Show whether live Dojo message tracking is actually receiving events",
    type: 1,
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      let rawBody;
      let interaction;
      try {
        rawBody = await request.text();
        interaction = JSON.parse(rawBody);
      } catch {
        return legacy.fetch(delegated, env, ctx);
      }

      const command = interaction.type === 2 ? String(interaction.data?.name || "") : "";
      if (command !== "memberroles" && command !== "activitystatus") {
        return legacy.fetch(delegated, env, ctx);
      }

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const userId = getInteractionUserId(interaction);
      if (!userId || userId !== String(env.DISCORD_OWNER_USER_ID || "")) {
        return ephemeralMessage("Only the Dojo owner can use this command.");
      }
      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

      if (command === "activitystatus") {
        ctx.waitUntil(
          buildActivityStatus(env)
            .then((content) => editOriginalInteraction(interaction, env, { content }))
            .catch(async (error) => {
              await editOriginalInteraction(interaction, env, {
                content: `Activity status failed: ${safeError(error)}`,
              }).catch(() => {});
            }),
        );
        return Response.json({ type: 5, data: { flags: EPHEMERAL } });
      }

      ctx.waitUntil(
        runFastMemberRoleSync(env)
          .then((summary) => editOriginalInteraction(interaction, env, {
            content:
              `Role sync complete. **${summary.dojo_members}** current Dojo member(s) checked.\n` +
              `**${summary.whop_mapped}** matched to Whop • **${summary.annual_members}** annual • ` +
              `**${summary.discord_fallback}** using Discord join-date fallback.\n` +
              `**${summary.role_changes}** role change(s) applied • **${summary.unresolved_whop}** active Whop member(s) still unmatched to Discord.`,
          }))
          .catch(async (error) => {
            console.error("fast memberroles failed:", error);
            await editOriginalInteraction(interaction, env, {
              content: `Role sync failed: ${safeError(error)}`,
            }).catch(() => {});
          }),
      );
      return Response.json({ type: 5, data: { flags: EPHEMERAL } });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.activity_check = {
          ...(body.discord.activity_check || {}),
          live_event_diagnostic: "/activitystatus",
          gateway_reidentify_version: "v31",
        };
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          manual_sync_mode: "batched-v31",
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
    if (stub) {
      await stub.ensureV31TrackingStart().catch(() => {});
      await stub.forceV31FreshGatewaySession().catch((error) => {
        console.error("Could not force fresh v31 gateway session:", error);
      });
    }

    await ensureOwnerCommands(env).catch((error) => {
      console.error("Could not register v31 commands:", error);
    });

    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV30 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {}

    if (
      payload?.op === 0 &&
      payload?.t === "MESSAGE_CREATE" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      !payload.d?.author?.bot
    ) {
      const roles = Array.isArray(payload.d?.member?.roles) ? payload.d.member.roles.map(String) : [];
      if (roles.includes(String(this.env.DISCORD_DOJO_ROLE_ID || ""))) {
        await this.recordV31ActivityEvent(String(payload.d?.author?.id || ""), payload.d?.timestamp || null);
      }
    }

    return super.handleGatewayMessage(raw);
  }

  async ensureV31TrackingStart() {
    const key = "activity:v31_tracking_started_at";
    const existing = await this.ctx.storage.get(key);
    if (existing) return existing;
    const now = new Date().toISOString();
    await this.ctx.storage.put(key, now);
    return now;
  }

  async forceV31FreshGatewaySession() {
    const marker = "gateway:v31_guild_messages_reidentified";
    if (await this.ctx.storage.get(marker)) return false;

    // Discord gateway intents are negotiated on IDENTIFY, not RESUME. v28 added
    // GUILD_MESSAGES, but an already-running session could keep resuming with its
    // older intent set forever. Drop the resumable session once so the next gateway
    // connection performs a fresh IDENTIFY with the new message intent enabled.
    this.sessionId = null;
    this.sequence = null;
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.close(4000, "Refresh gateway intents for Dojo activity tracking");
      }
    } catch {}

    await this.ctx.storage.put(marker, new Date().toISOString());
    return true;
  }

  async recordV31ActivityEvent(discordUserId, timestamp) {
    const now = new Date().toISOString();
    const count = Number((await this.ctx.storage.get("activity:v31_events_seen")) || 0) + 1;
    await this.ctx.storage.put("activity:v31_events_seen", count);
    await this.ctx.storage.put("activity:v31_last_event", {
      discord_user_id: String(discordUserId || ""),
      message_timestamp: timestamp || now,
      received_at: now,
    });
    return { ok: true, count };
  }

  async getV31ActivityStatus() {
    return {
      tracking_started_at: (await this.ctx.storage.get("activity:v31_tracking_started_at")) || null,
      events_seen: Number((await this.ctx.storage.get("activity:v31_events_seen")) || 0),
      last_event: (await this.ctx.storage.get("activity:v31_last_event")) || null,
      gateway_reidentified_at: (await this.ctx.storage.get("gateway:v31_guild_messages_reidentified")) || null,
      config: (await this.ctx.storage.get("activity:config")) || null,
    };
  }
}

async function buildActivityStatus(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) throw new Error("Discord gateway storage is unavailable.");
  const status = await stub.getV31ActivityStatus();
  const lines = [
    "## Dojo Activity Tracking Status",
    `**Tracking started:** ${formatDiscordTime(status.tracking_started_at)}`,
    `**Fresh gateway identify:** ${formatDiscordTime(status.gateway_reidentified_at)}`,
    `**Dojo message events seen since v31:** ${Number(status.events_seen || 0)}`,
    `**Last Dojo message event:** ${status.last_event?.received_at ? `${formatDiscordTime(status.last_event.received_at)} from <@${status.last_event.discord_user_id}>` : "None captured yet"}`,
    "",
    `**Weekly channel:** ${status.config?.channel_id ? `<#${status.config.channel_id}>` : "Not configured"}`,
    `**Schedule:** Sunday 6:00 AM Arizona time`,
    "",
    "The weekly counter cannot reconstruct messages sent before activity tracking was enabled. Send one new message from an account with the Dojo role, then run **/activitystatus** again. If the event count increases, live tracking is working.",
  ];
  return lines.join("\n").slice(0, 1950);
}

async function runFastMemberRoleSync(env) {
  requireMemberSyncEnv(env);
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");

  const [guildRolesRaw, dojoMembers, memberships] = await Promise.all([
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
    fetchDojoMembers(env),
    fetchCurrentDojoMemberships(env),
  ]);

  const guildRoles = Array.isArray(guildRolesRaw) ? guildRolesRaw : [];
  const roles = await ensureRoles(guildRoles, env);
  const activeMemberships = memberships.filter(isActiveMembership);
  const grouped = groupMembershipsByUser(activeMemberships);
  const whopUsers = [...grouped.keys()];

  const resolvedPairs = await mapConcurrent(whopUsers, 8, async (whopUserId) => {
    const discordUserId = await resolveDiscordUserId(whopUserId, env);
    return { whopUserId, discordUserId };
  });

  const discordToWhop = new Map();
  let unresolvedWhop = 0;
  for (const pair of resolvedPairs) {
    if (pair?.discordUserId) discordToWhop.set(String(pair.discordUserId), String(pair.whopUserId));
    else unresolvedWhop += 1;
  }

  const annualPlanIds = new Set(configuredAnnualPlanIds(env));
  const existingRecords = await mapConcurrent(dojoMembers, 20, async (member) => {
    const id = String(member?.user?.id || "");
    return [id, id ? await stub.getTenureRecord(id).catch(() => null) : null];
  });
  const recordByDiscord = new Map(existingRecords.filter(([id]) => id));

  let whopMapped = 0;
  let annualMembers = 0;
  let discordFallback = 0;
  let roleChanges = 0;

  const results = await mapConcurrent(dojoMembers, 4, async (member) => {
    const discordUserId = String(member?.user?.id || "");
    if (!discordUserId || member?.user?.bot) return null;

    const existing = recordByDiscord.get(discordUserId) || null;
    const whopUserId = discordToWhop.get(discordUserId) || String(existing?.whop_user_id || "");
    const userMemberships = whopUserId ? (grouped.get(whopUserId) || []) : [];
    const hasWhopMembership = userMemberships.length > 0;

    let firstEligibleAt = existing?.first_eligible_at || null;
    let isAnnual = false;

    if (hasWhopMembership) {
      whopMapped += 1;
      const whopStart = earliestMembershipDate(userMemberships);
      firstEligibleAt = earliestIsoDate(firstEligibleAt, whopStart) || member?.joined_at || new Date().toISOString();
      isAnnual = userMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
      if (isAnnual) annualMembers += 1;

      const nextRecord = {
        ...(existing || {}),
        discord_user_id: discordUserId,
        whop_user_id: whopUserId,
        membership_id: latestMembershipId(userMemberships) || existing?.membership_id || null,
        first_eligible_at: firstEligibleAt,
        is_annual: isAnnual,
        active: true,
        updated_at: new Date().toISOString(),
      };
      await stub.putTenureRecord(discordUserId, nextRecord).catch(() => {});
    } else {
      discordFallback += 1;
      firstEligibleAt = firstEligibleAt || member?.joined_at || new Date().toISOString();
    }

    const desired = new Set();
    const tenureKey = tenureRoleKey(firstEligibleAt);
    if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
    if (isAnnual && roles.annual) desired.add(String(roles.annual));

    const current = new Set((member?.roles || []).map(String));
    let changed = 0;
    for (const roleId of Object.values(roles).map(String)) {
      const shouldHave = desired.has(roleId);
      const hasRole = current.has(roleId);
      if (shouldHave === hasRole) continue;
      await changeRole(discordUserId, roleId, shouldHave, env, "Fast Dojo membership role sync");
      changed += 1;
    }
    roleChanges += changed;
    return true;
  });

  return {
    dojo_members: results.filter(Boolean).length,
    whop_mapped: whopMapped,
    annual_members: annualMembers,
    discord_fallback: discordFallback,
    role_changes: roleChanges,
    unresolved_whop: unresolvedWhop,
  };
}

async function ensureRoles(guildRoles, env) {
  const roles = {};
  for (const definition of ROLE_DEFINITIONS) {
    let role = guildRoles.find((item) => String(item?.name || "") === definition.name);
    if (!role) {
      role = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env, {
        method: "POST",
        body: JSON.stringify({ name: definition.name, permissions: "0", color: 0, hoist: false, mentionable: false }),
        reason: `Ensure managed Dojo role: ${definition.name}`,
      });
      guildRoles.push(role);
    }
    roles[definition.key] = String(role.id);
  }
  return roles;
}

async function fetchDojoMembers(env) {
  const result = [];
  let after = "0";
  const dojoRoleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  while (true) {
    const page = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${encodeURIComponent(after)}`, env);
    if (!Array.isArray(page)) break;
    for (const member of page) {
      const roles = Array.isArray(member?.roles) ? member.roles.map(String) : [];
      if (!member?.user?.bot && roles.includes(dojoRoleId)) result.push(member);
    }
    if (page.length < 1000) break;
    const lastId = String(page[page.length - 1]?.user?.id || "");
    if (!lastId || lastId === after) break;
    after = lastId;
  }
  return result;
}

async function fetchCurrentDojoMemberships(env) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({ first: "100" });
    params.append("company_id", env.WHOP_COMPANY_ID);
    params.append("product_ids", env.WHOP_PRODUCT_ID);
    if (after) params.set("after", after);
    const response = await fetch(`${WHOP_API}/memberships?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) throw new Error(`Whop memberships ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function resolveDiscordUserId(whopUserId, env) {
  const cached = await env.MEMBER_LINKS?.get(`whop:${whopUserId}`, "json").catch(() => null);
  if (cached?.discord_user_id) return String(cached.discord_user_id);

  const response = await fetch(`https://api.whop.com/v5/company/users/${encodeURIComponent(whopUserId)}/social_accounts`, {
    headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
  });
  if (!response.ok) return null;
  const body = await response.json();
  const accounts = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const discord = accounts.find((account) => account?.service === "discord" && account?.account_id);
  const discordUserId = discord?.account_id ? String(discord.account_id) : null;
  if (!discordUserId || !env.MEMBER_LINKS) return discordUserId;

  const now = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(`whop:${whopUserId}`, JSON.stringify({ discord_user_id: discordUserId, updated_at: now })),
    env.MEMBER_LINKS.put(`discord:${discordUserId}`, JSON.stringify({ whop_user_id: whopUserId, updated_at: now })),
  ]).catch(() => {});
  return discordUserId;
}

function configuredAnnualPlanIds(env) {
  return String(env.WHOP_ANNUAL_PLAN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function membershipIsAnnual(membership, annualPlanIds) {
  const planId = membershipPlanId(membership);
  if (planId && annualPlanIds.has(planId)) return true;
  const plan = membership?.plan || membership?.membership?.plan || null;
  if (Number(plan?.billing_period || 0) >= 300 || Number(plan?.expiration_days || 0) >= 300) return true;
  const text = `${plan?.title || ""} ${plan?.description || ""}`.toLowerCase();
  if (/\bannual\b|\byearly\b|\b1\s*year\b|\b12\s*month/.test(text)) return true;
  const start = Date.parse(membership?.renewal_period_start || membership?.created_at || "");
  const end = Date.parse(membership?.renewal_period_end || membership?.expires_at || "");
  return Number.isFinite(start) && Number.isFinite(end) && (end - start) / 86400000 >= 300;
}

function membershipPlanId(record) {
  return String(record?.plan?.id || record?.plan_id || record?.membership?.plan?.id || "");
}

function membershipUserId(record) {
  return String(record?.user?.id || record?.user_id || record?.member?.user?.id || record?.membership?.user?.id || "");
}

function isActiveMembership(record) {
  return new Set(["active", "trialing", "canceling", "completed"]).has(String(record?.status || "").toLowerCase());
}

function groupMembershipsByUser(records) {
  const map = new Map();
  for (const record of records || []) {
    const id = membershipUserId(record);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(record);
  }
  return map;
}

function earliestMembershipDate(records) {
  let value = null;
  for (const record of records || []) {
    value = earliestIsoDate(value, record?.joined_at || record?.created_at || null);
  }
  return value;
}

function earliestIsoDate(a, b) {
  const candidates = [a, b]
    .map((value) => ({ value, time: Date.parse(value || "") }))
    .filter((item) => Number.isFinite(item.time));
  if (!candidates.length) return null;
  candidates.sort((x, y) => x.time - y.time);
  return new Date(candidates[0].time).toISOString();
}

function latestMembershipId(records) {
  const sorted = [...(records || [])].sort((a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0));
  return sorted[0]?.id ? String(sorted[0].id) : null;
}

function tenureRoleKey(firstEligibleAt, now = new Date()) {
  const months = fullMonthsSince(firstEligibleAt, now);
  if (months >= 36) return "y3";
  if (months >= 24) return "y2";
  if (months >= 12) return "y1";
  return `m${Math.min(months + 1, 6)}`;
}

function fullMonthsSince(iso, now = new Date()) {
  const start = new Date(iso);
  if (!Number.isFinite(start.getTime()) || start > now) return 0;
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const anniversaryDay = Math.min(start.getUTCDate(), lastDay);
  if (now.getUTCDate() < anniversaryDay) months -= 1;
  return Math.max(0, months);
}

async function mapConcurrent(items, limit, fn) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, () => worker()));
  return result;
}

async function ensureOwnerCommands(env) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const existing = await discordJson(url, env);
  const names = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item?.name || "")));
  for (const command of OWNER_COMMANDS) {
    if (names.has(command.name)) continue;
    await discordJson(url, env, {
      method: "POST",
      body: JSON.stringify(command),
      reason: `Register owner command /${command.name}`,
    });
  }
}

async function changeRole(discordUserId, roleId, add, env, reason) {
  const response = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {
    method: add ? "PUT" : "DELETE",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "X-Audit-Log-Reason": encodeURIComponent(reason || "Dojo role sync"),
    },
  });
  if (response.status === 204 || (!add && response.status === 404)) return;
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const waitMs = Math.max(250, Math.ceil(Number(body?.retry_after || 1) * 1000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return changeRole(discordUserId, roleId, add, env, reason);
  }
  throw new Error(`Discord role ${add ? "add" : "remove"} ${response.status}: ${(await response.text()).slice(0, 160)}`);
}

async function discordJson(url, env, options = {}) {
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(options.reason);
  let response = await fetch(url, { ...options, headers });
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const waitMs = Math.max(250, Math.ceil(Number(body?.retry_after || 1) * 1000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await fetch(url, { ...options, headers });
  }
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (response.status === 204) return null;
  return response.json();
}

function requireMemberSyncEnv(env) {
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "WHOP_API_KEY", "WHOP_COMPANY_ID", "WHOP_PRODUCT_ID"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!env.DISCORD_GATEWAY || !env.MEMBER_LINKS) throw new Error("Membership storage bindings are missing.");
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatDiscordTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Not recorded";
  return `<t:${Math.floor(date.getTime() / 1000)}:F> (<t:${Math.floor(date.getTime() / 1000)}:R>)`;
}

function ephemeralMessage(content) {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

async function editOriginalInteraction(interaction, env, payload) {
  const response = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(payload || {}), allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Could not edit interaction: ${response.status} ${(await response.text()).slice(0, 160)}`);
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, hexToBytes(signature), encoder.encode(timestamp + rawBody));
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) throw new Error("Invalid hex value");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}
