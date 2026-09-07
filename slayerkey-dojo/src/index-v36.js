import legacy, { DiscordGateway as DiscordGatewayV35 } from "./index-v35.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const ACTIVE_MEMBERSHIP_STATUSES = new Set(["active", "trialing", "canceling", "completed"]);

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          immediate_join_sync: true,
          immediate_join_sync_version: "v36",
          immediate_join_sync_behavior: "verify-dojo-then-sync-tenure-and-annual",
          daily_reconciliation_retained_as_safety_net: true,
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV35 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return super.handleGatewayMessage(raw);
    }

    const isHumanGuildJoin =
      payload?.op === 0 &&
      payload?.t === "GUILD_MEMBER_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      !payload.d?.user?.bot;

    if (!isHumanGuildJoin) return super.handleGatewayMessage(raw);

    const discordUserId = String(payload.d?.user?.id || "");

    // Let the canonical join verifier run first. That verifier is responsible for
    // proving Whop access, granting the Dojo role, and persisting Discord↔Whop links.
    const result = await super.handleGatewayMessage(raw);

    if (!discordUserId) return result;

    try {
      const sync = await syncJoinedMemberRoles(discordUserId, this.env, this);
      await this.ctx.storage.put("membership:v36_last_join_sync", {
        discord_user_id: discordUserId,
        ...sync,
        at: new Date().toISOString(),
      });
    } catch (error) {
      const message = String(error?.message || error || "Unknown join role sync error");
      this.lastError = `Immediate membership-role sync failed: ${message}`;
      await this.ctx.storage.put("membership:v36_last_join_sync", {
        discord_user_id: discordUserId,
        ok: false,
        error: message.slice(0, 300),
        at: new Date().toISOString(),
      }).catch(() => {});
      console.error("v36 immediate join role sync failed:", error);
    }

    return result;
  }

  async getV36JoinRoleSyncStatus() {
    return (await this.ctx.storage.get("membership:v36_last_join_sync")) || null;
  }
}

async function syncJoinedMemberRoles(discordUserId, env, stub) {
  requireJoinSyncEnv(env);

  const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
  const whopUserId = String(reverse?.whop_user_id || "");
  if (!whopUserId) {
    return { ok: false, reason: "no_whop_link_after_join_verification" };
  }

  const [member, guildRoles, allMemberships, stored] = await Promise.all([
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`, env),
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
    fetchCurrentDojoMemberships(env),
    stub.getTenureRecord(discordUserId).catch(() => null),
  ]);

  const currentRoles = new Set((member?.roles || []).map(String));
  if (!currentRoles.has(String(env.DISCORD_DOJO_ROLE_ID || ""))) {
    // Never grant managed membership roles unless the canonical verifier actually
    // granted the base Dojo role first.
    return { ok: false, reason: "dojo_role_not_granted" };
  }

  const userMemberships = (allMemberships || []).filter((record) =>
    membershipUserId(record) === whopUserId && isActiveMembership(record),
  );
  if (!userMemberships.length) {
    return { ok: false, reason: "no_active_dojo_membership_after_verification" };
  }

  const roles = resolveExistingRoles(guildRoles);
  const annualPlanIds = new Set(configuredAnnualPlanIds(env));
  const isAnnual = userMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
  const membershipStart = earliestMembershipDate(userMemberships);
  const firstEligibleAt = earliestIsoDate(stored?.first_eligible_at, membershipStart) || new Date().toISOString();
  const latestMembership = userMemberships
    .slice()
    .sort((a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0))[0];

  const nextRecord = {
    ...(stored || {}),
    discord_user_id: discordUserId,
    whop_user_id: whopUserId,
    membership_id: latestMembership?.id ? String(latestMembership.id) : stored?.membership_id || null,
    first_eligible_at: firstEligibleAt,
    is_annual: isAnnual,
    active: true,
    updated_at: new Date().toISOString(),
  };
  await stub.putTenureRecord(discordUserId, nextRecord);

  const desired = new Set();
  const tenureKey = tenureRoleKey(firstEligibleAt);
  if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
  if (isAnnual && roles.annual) desired.add(String(roles.annual));

  const mutations = [];
  for (const roleId of Object.values(roles).map(String)) {
    const shouldHave = desired.has(roleId);
    const hasRole = currentRoles.has(roleId);
    if (shouldHave === hasRole) continue;
    mutations.push({ role_id: roleId, add: shouldHave });
  }

  // A new join normally needs at most Month 1 + Annual Member. Apply serially and
  // respect Discord's retry_after if this route happens to be rate-limited.
  let applied = 0;
  for (const mutation of mutations) {
    const changed = await applyRoleMutationWithRetry(discordUserId, mutation.role_id, mutation.add, env);
    if (changed) applied += 1;
  }

  return {
    ok: true,
    reason: "joined_member_synced",
    whop_user_id: whopUserId,
    membership_id: nextRecord.membership_id,
    plan_ids: [...new Set(userMemberships.map(membershipPlanId).filter(Boolean))],
    annual: isAnnual,
    tenure_role: ROLE_DEFINITIONS.find((definition) => definition.key === tenureKey)?.name || null,
    role_changes: applied,
  };
}

function resolveExistingRoles(guildRoles) {
  const list = Array.isArray(guildRoles) ? guildRoles : [];
  const roles = {};
  for (const definition of ROLE_DEFINITIONS) {
    const role = list.find((item) => String(item?.name || "") === definition.name);
    if (role?.id) roles[definition.key] = String(role.id);
  }

  // Join sync is intentionally non-destructive: it does not recreate roles. The
  // base tenure role is required; Annual Member is required only for annual buyers.
  if (!roles.m1) throw new Error("Managed role missing: Month 1 • Rookie");
  return roles;
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
    if (!response.ok) {
      throw new Error(`Whop memberships ${response.status}: ${(await response.text()).slice(0, 180)}`);
    }

    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function applyRoleMutationWithRetry(discordUserId, roleId, add, env) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {
        method: add ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "X-Audit-Log-Reason": encodeURIComponent("Immediate Dojo membership role sync on join"),
        },
      },
    );

    if (response.status === 204 || (!add && response.status === 404)) return true;
    if (response.status !== 429 || attempt === 1) {
      throw new Error(`Discord role ${add ? "add" : "remove"} ${response.status}: ${(await response.text()).slice(0, 180)}`);
    }

    let retryAfterMs = 10000;
    try {
      const body = await response.json();
      retryAfterMs = Math.ceil(Number(body?.retry_after || 10) * 1000) + 500;
    } catch {}
    await sleep(Math.min(Math.max(retryAfterMs, 1000), 15000));
  }
  return false;
}

async function discordJson(url, env) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 180)}`);
  if (response.status === 204) return null;
  return response.json();
}

function membershipUserId(record) {
  return String(
    record?.user?.id ||
    record?.user_id ||
    record?.member?.user?.id ||
    record?.membership?.user?.id ||
    "",
  );
}

function membershipPlanId(record) {
  return String(record?.plan?.id || record?.plan_id || record?.membership?.plan?.id || "");
}

function isActiveMembership(record) {
  return ACTIVE_MEMBERSHIP_STATUSES.has(String(record?.status || "").toLowerCase());
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

  // Preserve the existing metadata fallback for future annual plans while keeping
  // the exact configured plan ID as the primary signal.
  const plan = membership?.plan || membership?.membership?.plan || null;
  if (Number(plan?.billing_period || 0) >= 300 || Number(plan?.expiration_days || 0) >= 300) return true;
  const text = `${plan?.title || ""} ${plan?.description || ""}`.toLowerCase();
  return /\bannual\b|\byearly\b|\b1\s*year\b|\b12\s*month/.test(text);
}

function earliestMembershipDate(memberships) {
  let value = null;
  for (const membership of memberships || []) {
    value = earliestIsoDate(value, membership?.joined_at || membership?.created_at || null);
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

function tenureRoleKey(firstEligibleAt, now = new Date()) {
  const completedMonths = fullMonthsSince(firstEligibleAt, now);
  if (completedMonths >= 36) return "y3";
  if (completedMonths >= 24) return "y2";
  if (completedMonths >= 12) return "y1";
  return `m${Math.min(completedMonths + 1, 6)}`;
}

function fullMonthsSince(iso, now = new Date()) {
  const start = new Date(iso);
  if (!Number.isFinite(start.getTime()) || start > now) return 0;
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  const lastDayThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const anniversaryDay = Math.min(start.getUTCDate(), lastDayThisMonth);
  if (now.getUTCDate() < anniversaryDay) months -= 1;
  return Math.max(0, months);
}

function requireJoinSyncEnv(env) {
  for (const key of [
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_DOJO_ROLE_ID",
    "WHOP_API_KEY",
    "WHOP_COMPANY_ID",
    "WHOP_PRODUCT_ID",
  ]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!env.MEMBER_LINKS) throw new Error("MEMBER_LINKS is unavailable");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
