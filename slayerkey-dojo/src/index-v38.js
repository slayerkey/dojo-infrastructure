import legacy, { DiscordGateway as DiscordGatewayV37 } from "./index-v37.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const encoder = new TextEncoder();
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

    // v14's old deactivation path removes every Discord role the bot can manage.
    // That conflicts with permanent champion roles and any unrelated community
    // roles. Intercept only deactivation here and reconcile access-related roles.
    // Activation keeps using the existing, already-proven webhook/onboarding path.
    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      const delegated = request.clone();
      const rawBody = await request.text();
      const valid = await verifyWhopWebhook(request.headers, rawBody, env.WHOP_WEBHOOK_SECRET);
      if (!valid) return new Response("Invalid signature", { status: 401 });

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (isRelevantDeactivation(event, env)) {
        ctx.waitUntil(
          reconcileDeactivatedMembership(event, env).catch((error) => {
            console.error("v38 safe deactivation reconciliation failed:", error);
          }),
        );
        return new Response("OK", { status: 200 });
      }

      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          version: "v38",
          deactivation_role_scope: "dojo-access-and-managed-tenure-only",
          permanent_champion_roles_preserved_on_membership_end: true,
          v28_daily_discord_backfill_suppressed: true,
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

export class DiscordGateway extends DiscordGatewayV37 {
  async prepareV37ScheduledDay(dayKey) {
    const result = await super.prepareV37ScheduledDay(dayKey);

    // v28 has a separate daily full Discord-member backfill. v37's local tenure
    // transition pass supersedes it, so pre-claim that legacy job on each new day.
    if (result?.new_day) {
      await this.ctx.storage.put("membership_v28_backfill:last_day", String(dayKey || ""));
    }
    return result;
  }
}

async function reconcileDeactivatedMembership(event, env) {
  const whopUserId = String(event?.data?.user?.id || "");
  if (!whopUserId) return { ok: false, reason: "missing_whop_user" };

  const access = await currentAccessWithPropagationRetry(whopUserId, env);
  if (access == null) {
    // Never remove roles when Whop itself could not establish current access.
    // A later event or manual /memberroles can repair state without risking a
    // false-positive removal.
    console.warn(`Could not establish current Whop access for ${whopUserId}; leaving Discord roles unchanged.`);
    return { ok: false, reason: "access_indeterminate" };
  }

  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  const discordUserId = await resolveDiscordIdForWhopUser(whopUserId, env);
  if (!discordUserId) {
    if (!access) await stub?.clearFreshDojoAccess?.(whopUserId).catch(() => {});
    return { ok: true, reason: "no_discord_mapping", active: access };
  }

  const stored = await stub?.getTenureRecord?.(discordUserId).catch(() => null);

  if (!access) {
    const next = {
      ...(stored || {}),
      discord_user_id: discordUserId,
      whop_user_id: whopUserId,
      active: false,
      is_annual: false,
      updated_at: new Date().toISOString(),
    };
    await stub?.putTenureRecord?.(discordUserId, next).catch(() => {});
    await stub?.clearFreshDojoAccess?.(whopUserId).catch(() => {});
    const changed = await removeDojoAccessRolesOnly(discordUserId, env);
    await env.RR_TRACKER?.setMemberActive(discordUserId, false).catch(() => {});
    return { ok: true, active: false, removed: changed };
  }

  // One membership deactivated, but the user still has product access through
  // another membership/plan. Recalculate Annual + tenure for that user only.
  const memberships = await fetchDojoMembershipsForUser(whopUserId, env);
  const activeMemberships = memberships.filter(isActiveMembership);
  if (!activeMemberships.length) {
    // Access endpoint is authoritative. Keep the base role and do not destructively
    // change managed roles if the membership list is temporarily behind.
    await ensureBaseDojoRole(discordUserId, env);
    await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
    return { ok: true, active: true, reason: "membership_list_propagating" };
  }

  const annualPlanIds = new Set(configuredAnnualPlanIds(env));
  const isAnnual = activeMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
  const membershipStart = earliestMembershipDate(activeMemberships);
  const firstEligibleAt = earliestIsoDate(stored?.first_eligible_at, membershipStart) || new Date().toISOString();
  const tenureKey = tenureRoleKey(firstEligibleAt);
  const latestMembership = activeMemberships
    .slice()
    .sort((a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0))[0];

  const next = {
    ...(stored || {}),
    discord_user_id: discordUserId,
    whop_user_id: whopUserId,
    membership_id: latestMembership?.id ? String(latestMembership.id) : stored?.membership_id || null,
    first_eligible_at: firstEligibleAt,
    active: true,
    is_annual: isAnnual,
    tenure_role_key: tenureKey,
    updated_at: new Date().toISOString(),
  };

  await stub?.putTenureRecord?.(discordUserId, next).catch(() => {});
  await ensureBaseDojoRole(discordUserId, env);
  const changed = await applyManagedRoles(discordUserId, next, env);
  await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
  return { ok: true, active: true, annual: isAnnual, role_changes: changed };
}

async function currentAccessWithPropagationRetry(whopUserId, env) {
  for (const delay of [0, 2000, 5000]) {
    if (delay) await sleep(delay);
    const state = await whopUserAccessState(whopUserId, env);
    if (state === true) return true;
    if (state == null) continue;
  }

  // Make one final explicit read. `false` is safe only when Whop successfully
  // answered that the user does not have customer access.
  return whopUserAccessState(whopUserId, env);
}

async function whopUserAccessState(whopUserId, env) {
  try {
    const response = await fetch(
      `${WHOP_API}/users/${encodeURIComponent(whopUserId)}/access/${encodeURIComponent(env.WHOP_PRODUCT_ID)}`,
      { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
    );
    if (!response.ok) return null;
    const body = await response.json();
    return Boolean(body?.has_access) && String(body?.access_level || "") === "customer";
  } catch {
    return null;
  }
}

async function resolveDiscordIdForWhopUser(whopUserId, env) {
  if (env.MEMBER_LINKS) {
    const cached = await env.MEMBER_LINKS.get(`whop:${whopUserId}`, "json").catch(() => null);
    if (cached?.discord_user_id) return String(cached.discord_user_id);
  }

  const response = await fetch(
    `https://api.whop.com/v5/company/users/${encodeURIComponent(whopUserId)}/social_accounts`,
    { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
  );
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

async function removeDojoAccessRolesOnly(discordUserId, env) {
  const [member, guildRoles] = await Promise.all([
    fetchDiscordMember(discordUserId, env),
    fetchGuildRoles(env),
  ]);
  if (!member) return 0;

  const managed = resolveManagedRoleIds(guildRoles);
  const current = new Set((member.roles || []).map(String));
  const removable = new Set([
    String(env.DISCORD_DOJO_ROLE_ID || ""),
    ...Object.values(managed).map(String),
  ]);

  let changed = 0;
  for (const roleId of removable) {
    if (!roleId || !current.has(roleId)) continue;
    if (await changeRoleWithRetry(discordUserId, roleId, false, env, "Training Dojo access expired")) changed += 1;
  }
  return changed;
}

async function ensureBaseDojoRole(discordUserId, env) {
  const member = await fetchDiscordMember(discordUserId, env);
  if (!member) return false;
  const roleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  if (!roleId || (member.roles || []).map(String).includes(roleId)) return true;
  await changeRoleWithRetry(discordUserId, roleId, true, env, "Training Dojo access still active");
  return true;
}

async function applyManagedRoles(discordUserId, record, env) {
  const [member, guildRoles] = await Promise.all([
    fetchDiscordMember(discordUserId, env),
    fetchGuildRoles(env),
  ]);
  if (!member) return 0;

  const roles = resolveManagedRoleIds(guildRoles);
  const desired = new Set();
  if (record?.active) {
    const tenureKey = record.tenure_role_key || tenureRoleKey(record.first_eligible_at);
    if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
    if (record.is_annual && roles.annual) desired.add(String(roles.annual));
  }

  const current = new Set((member.roles || []).map(String));
  let changed = 0;
  for (const roleId of Object.values(roles).map(String)) {
    const shouldHave = desired.has(roleId);
    const hasRole = current.has(roleId);
    if (shouldHave === hasRole) continue;
    if (await changeRoleWithRetry(discordUserId, roleId, shouldHave, env, "Targeted Dojo membership update")) changed += 1;
  }
  return changed;
}

function resolveManagedRoleIds(guildRoles) {
  const roles = {};
  const list = Array.isArray(guildRoles) ? guildRoles : [];
  for (const definition of ROLE_DEFINITIONS) {
    const role = list.find((item) => String(item?.name || "") === definition.name);
    if (role?.id) roles[definition.key] = String(role.id);
  }
  return roles;
}

async function fetchDojoMembershipsForUser(whopUserId, env) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({ first: "100" });
    params.append("company_id", env.WHOP_COMPANY_ID);
    params.append("product_ids", env.WHOP_PRODUCT_ID);
    params.append("user_ids", whopUserId);
    if (after) params.set("after", after);

    const response = await fetch(`${WHOP_API}/memberships?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) {
      throw new Error(`Targeted Whop membership lookup ${response.status}: ${(await response.text()).slice(0, 180)}`);
    }
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

function isActiveMembership(record) {
  return ACTIVE_MEMBERSHIP_STATUSES.has(String(record?.status || "").toLowerCase());
}

function membershipPlanId(record) {
  return String(record?.plan?.id || record?.plan_id || record?.membership?.plan?.id || "");
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

async function fetchDiscordMember(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Discord member lookup ${response.status}: ${(await response.text()).slice(0, 180)}`);
  return response.json();
}

async function fetchGuildRoles(env) {
  const response = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Discord role list ${response.status}: ${(await response.text()).slice(0, 180)}`);
  return response.json();
}

async function changeRoleWithRetry(discordUserId, roleId, add, env, reason) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {
        method: add ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "X-Audit-Log-Reason": encodeURIComponent(reason || "Dojo membership role update"),
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

function isRelevantDeactivation(event, env) {
  if (String(event?.type || "") !== "membership.deactivated") return false;
  const companyId = String(event?.company_id || event?.data?.company?.id || "");
  const productId = String(event?.data?.product?.id || "");
  return companyId === String(env.WHOP_COMPANY_ID || "") && productId === String(env.WHOP_PRODUCT_ID || "");
}

async function verifyWhopWebhook(headers, rawBody, secret) {
  if (!secret) return false;
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const timestampNumber = Number(webhookTimestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  for (const candidate of webhookSignature.split(" ")) {
    const comma = candidate.indexOf(",");
    if (comma === -1 || candidate.slice(0, comma) !== "v1") continue;
    try {
      if (await crypto.subtle.verify(
        "HMAC",
        key,
        base64ToBytes(candidate.slice(comma + 1)),
        encoder.encode(signedContent),
      )) return true;
    } catch {}
  }
  return false;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
