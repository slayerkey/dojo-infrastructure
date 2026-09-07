import legacy from "./index-v36.js";
import { DiscordGateway as DiscordGatewayV35 } from "./index-v35.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const VERIFY_CHANNEL_ID = "1497054385908220036";
const VERIFY_MESSAGE_ID = "1497057798989811792";
const VERIFY_EMOJI = "🔑";
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

const ADMIN_COMMANDS = [
  {
    name: "memberroles",
    description: "Create and sync all Dojo membership, tenure, and annual roles",
    type: 1,
  },
  {
    name: "setchampion",
    description: "Correct a frozen monthly RR champion",
    type: 1,
    options: [
      {
        name: "month",
        description: "Month to correct, in YYYY-MM format",
        type: 3,
        required: true,
      },
      {
        name: "winner",
        description: "The member who actually won that month",
        type: 6,
        required: true,
      },
    ],
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Keep the existing Whop webhook as the source of truth for base Dojo access.
    // Only after the legacy handler accepts the signed webhook do we update the
    // annual + tenure roles for that one Whop user.
    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      const inspection = request.clone();
      const response = await legacy.fetch(request, env, ctx);

      if (response.ok) {
        ctx.waitUntil(
          inspection.text()
            .then((rawBody) => {
              let event;
              try {
                event = JSON.parse(rawBody);
              } catch {
                return null;
              }
              if (!isRelevantMembershipEvent(event, env)) return null;
              const whopUserId = String(event?.data?.user?.id || "");
              if (!whopUserId) return null;
              const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
              if (!stub) return null;
              return syncWhopUserManagedRoles(whopUserId, env, stub, {
                source: `whop:${event.type}`,
                requireDojoRole: false,
              });
            })
            .catch((error) => console.error("v37 Whop managed-role sync failed:", error)),
        );
      }
      return response;
    }

    // If somebody was already in the server and uses /verify after connecting
    // Discord on Whop, give the base verifier a moment to store the mapping and
    // then immediately attach Annual Member + the correct tenure role.
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const inspection = request.clone();
      let interaction = null;
      try {
        interaction = JSON.parse(await inspection.text());
      } catch {}

      const response = await legacy.fetch(request, env, ctx);
      if (response.ok && interaction?.type === 2 && String(interaction?.data?.name || "") === "verify") {
        const discordUserId = String(interaction?.member?.user?.id || interaction?.user?.id || "");
        if (discordUserId) {
          ctx.waitUntil(
            sleep(1500)
              .then(() => syncDiscordManagedRolesIfMapped(discordUserId, env, {
                source: "slash-verify",
                requireDojoRole: true,
              }))
              .catch((error) => console.error("v37 /verify managed-role follow-up failed:", error)),
          );
        }
      }
      return response;
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          version: "v37",
          primary_sync: "event-driven",
          immediate_join_sync: true,
          immediate_join_sync_version: "v37-targeted",
          whop_membership_events_sync_managed_roles: true,
          full_company_scheduled_membership_scans: false,
          daily_sync: false,
          daily_tenure_maintenance: "local-storage-only; Discord write only when a tenure boundary is crossed",
          manual_full_repair: "/memberroles",
          legacy_v2_scheduled_reconciliation: "disabled",
          legacy_v25_v27_daily_membership_sweeps: "suppressed",
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
    const dayKey = new Date().toISOString().slice(0, 10);
    let isNewDay = false;

    // v25 and v27 both contain old once-a-day full Whop membership sweeps.
    // Mark those legacy day claims before delegating so all other scheduled
    // behavior remains intact while those two redundant sweeps stay dormant.
    if (stub) {
      const prepared = await stub.prepareV37ScheduledDay(dayKey).catch((error) => {
        console.error("v37 scheduled-day preparation failed:", error);
        return null;
      });
      isNewDay = Boolean(prepared?.new_day);
    }

    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }

    if (stub && isNewDay) {
      await runV37DailyLocalMaintenance(env, stub).catch((error) => {
        console.error("v37 local daily maintenance failed:", error);
      });
    }
  },
};

// Deliberately extend v35 rather than v36 so the v36 full-company membership
// lookup on every GUILD_MEMBER_ADD is replaced by the targeted v37 join path.
export class DiscordGateway extends DiscordGatewayV35 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return super.handleGatewayMessage(raw);
    }

    const isHumanJoin =
      payload?.op === 0 &&
      payload?.t === "GUILD_MEMBER_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      !payload.d?.user?.bot;

    const isVerifyReaction =
      payload?.op === 0 &&
      payload?.t === "MESSAGE_REACTION_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      String(payload.d?.channel_id || "") === VERIFY_CHANNEL_ID &&
      String(payload.d?.message_id || "") === VERIFY_MESSAGE_ID &&
      String(payload.d?.emoji?.name || "") === VERIFY_EMOJI &&
      !payload.d?.member?.user?.bot;

    if (!isHumanJoin && !isVerifyReaction) return super.handleGatewayMessage(raw);

    const discordUserId = String(
      isHumanJoin ? payload.d?.user?.id || "" : payload.d?.user_id || "",
    );

    // Canonical verification runs first and remains responsible for proving Whop
    // access, granting/removing the base Dojo role, and storing Discord↔Whop links.
    const result = await super.handleGatewayMessage(raw);
    if (!discordUserId) return result;

    try {
      const sync = await syncDiscordManagedRolesIfMapped(discordUserId, this.env, {
        stub: this,
        source: isHumanJoin ? "guild-member-add" : "verify-reaction",
        requireDojoRole: true,
      });
      await this.ctx.storage.put("membership:v37_last_immediate_sync", {
        discord_user_id: discordUserId,
        ...sync,
        at: new Date().toISOString(),
      });
    } catch (error) {
      const message = String(error?.message || error || "Unknown managed-role sync error");
      this.lastError = `v37 immediate membership-role sync failed: ${message}`;
      await this.ctx.storage.put("membership:v37_last_immediate_sync", {
        discord_user_id: discordUserId,
        ok: false,
        error: message.slice(0, 300),
        at: new Date().toISOString(),
      }).catch(() => {});
      console.error("v37 immediate managed-role sync failed:", error);
    }

    return result;
  }

  async prepareV37ScheduledDay(dayKey) {
    const key = "membership:v37_scheduled_day";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dayKey || "")) {
      return { new_day: false };
    }

    // These are the exact claim keys read by the legacy v25/v27 daily sweeps.
    await Promise.all([
      this.ctx.storage.put(key, String(dayKey || "")),
      this.ctx.storage.put("membership_automation:last_day", String(dayKey || "")),
      this.ctx.storage.put("membership_v27:last_day", String(dayKey || "")),
    ]);
    return { new_day: true };
  }

  async processV37TenureTransitions() {
    const records = await this.listTenureRecords().catch(() => []);
    const active = (Array.isArray(records) ? records : []).filter(
      (record) => record?.active && record?.discord_user_id && record?.first_eligible_at,
    );

    let initialized = 0;
    let transitioned = 0;
    let skippedNotInGuild = 0;

    for (const record of active) {
      const discordUserId = String(record.discord_user_id);
      const expectedKey = tenureRoleKey(record.first_eligible_at);
      if (!expectedKey) continue;

      // Existing pre-v37 records did not persist the current tenure key. Seed the
      // local marker without a network call; the roles were already reconciled by
      // the previous system or can be repaired explicitly with /memberroles.
      if (!record.tenure_role_key) {
        await this.putTenureRecord(discordUserId, {
          ...record,
          tenure_role_key: expectedKey,
          updated_at: new Date().toISOString(),
        });
        initialized += 1;
        continue;
      }

      if (String(record.tenure_role_key) === expectedKey) continue;

      const changed = await applyExpectedManagedRoles(
        discordUserId,
        {
          ...record,
          tenure_role_key: expectedKey,
        },
        this.env,
        { reason: "Dojo tenure anniversary transition" },
      );

      if (changed.not_in_guild) {
        skippedNotInGuild += 1;
        continue;
      }

      await this.putTenureRecord(discordUserId, {
        ...record,
        tenure_role_key: expectedKey,
        updated_at: new Date().toISOString(),
      });
      transitioned += 1;
    }

    return { checked: active.length, initialized, transitioned, skipped_not_in_guild: skippedNotInGuild };
  }

  async getV37MembershipStatus() {
    return {
      last_immediate_sync: (await this.ctx.storage.get("membership:v37_last_immediate_sync")) || null,
      scheduled_day: (await this.ctx.storage.get("membership:v37_scheduled_day")) || null,
    };
  }
}

async function runV37DailyLocalMaintenance(env, stub) {
  // No Whop membership list is fetched here.
  const [tenure, commands] = await Promise.allSettled([
    stub.processV37TenureTransitions(),
    ensureAdminCommands(env),
  ]);

  if (tenure.status === "rejected") console.error("v37 tenure transitions failed:", tenure.reason);
  if (commands.status === "rejected") console.error("v37 admin command ensure failed:", commands.reason);

  // Preserve the old automatic previous-month champion finalization without
  // re-enabling its full membership sweep.
  if (env.RR_TRACKER?.freezePreviousMonthChampion) {
    const frozen = await env.RR_TRACKER.freezePreviousMonthChampion().catch((error) => {
      console.error("v37 champion freeze failed:", error);
      return null;
    });
    if (frozen?.ok && frozen.champion) {
      await awardChampionRole(env, frozen.champion).catch((error) => {
        console.error("v37 champion role award failed:", error);
      });
    }
  }
}

async function syncDiscordManagedRolesIfMapped(discordUserId, env, options = {}) {
  const stub = options.stub || env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub || !env.MEMBER_LINKS) return { ok: false, reason: "managed_role_storage_unavailable" };

  const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
  const whopUserId = String(reverse?.whop_user_id || "");
  if (!whopUserId) return { ok: false, reason: "no_whop_mapping" };

  return syncWhopUserManagedRoles(whopUserId, env, stub, {
    ...options,
    discordUserId,
  });
}

async function syncWhopUserManagedRoles(whopUserId, env, stub, options = {}) {
  requireManagedRoleEnv(env);

  const discordUserId = String(
    options.discordUserId || (await resolveDiscordIdForWhopUser(whopUserId, env)) || "",
  );
  if (!discordUserId) return { ok: false, reason: "no_discord_mapping" };

  const [memberships, stored] = await Promise.all([
    fetchDojoMembershipsForUser(whopUserId, env),
    stub.getTenureRecord(discordUserId).catch(() => null),
  ]);
  const activeMemberships = memberships.filter(isActiveMembership);
  const active = activeMemberships.length > 0;

  if (!active) {
    const record = {
      ...(stored || {}),
      discord_user_id: discordUserId,
      whop_user_id: whopUserId,
      active: false,
      is_annual: false,
      updated_at: new Date().toISOString(),
    };
    await stub.putTenureRecord(discordUserId, record);
    const changed = await applyExpectedManagedRoles(discordUserId, record, env, {
      reason: `Whop membership inactive (${options.source || "event"})`,
    });
    return {
      ok: true,
      active: false,
      annual: false,
      discord_user_id: discordUserId,
      role_changes: changed.applied,
      not_in_guild: Boolean(changed.not_in_guild),
    };
  }

  const annualPlanIds = new Set(configuredAnnualPlanIds(env));
  const isAnnual = activeMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
  const membershipStart = earliestMembershipDate(activeMemberships);
  const firstEligibleAt = earliestIsoDate(stored?.first_eligible_at, membershipStart) || new Date().toISOString();
  const latestMembership = activeMemberships
    .slice()
    .sort((a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0))[0];
  const tenureKey = tenureRoleKey(firstEligibleAt);

  const record = {
    ...(stored || {}),
    discord_user_id: discordUserId,
    whop_user_id: whopUserId,
    membership_id: latestMembership?.id ? String(latestMembership.id) : stored?.membership_id || null,
    first_eligible_at: firstEligibleAt,
    is_annual: isAnnual,
    active: true,
    tenure_role_key: tenureKey,
    updated_at: new Date().toISOString(),
  };

  if (options.requireDojoRole) {
    const member = await fetchDiscordMember(discordUserId, env);
    if (!member) return { ok: false, reason: "not_in_guild" };
    const current = new Set((member.roles || []).map(String));
    if (!current.has(String(env.DISCORD_DOJO_ROLE_ID || ""))) {
      return { ok: false, reason: "dojo_role_not_granted" };
    }
  }

  await stub.putTenureRecord(discordUserId, record);
  const changed = await applyExpectedManagedRoles(discordUserId, record, env, {
    reason: `Targeted Dojo membership sync (${options.source || "event"})`,
  });

  return {
    ok: true,
    active: true,
    annual: isAnnual,
    discord_user_id: discordUserId,
    whop_user_id: whopUserId,
    membership_id: record.membership_id,
    plan_ids: [...new Set(activeMemberships.map(membershipPlanId).filter(Boolean))],
    tenure_role: ROLE_DEFINITIONS.find((definition) => definition.key === tenureKey)?.name || null,
    role_changes: changed.applied,
    not_in_guild: Boolean(changed.not_in_guild),
  };
}

async function applyExpectedManagedRoles(discordUserId, record, env, { reason } = {}) {
  const [member, guildRoles] = await Promise.all([
    fetchDiscordMember(discordUserId, env),
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
  ]);
  if (!member) return { applied: 0, not_in_guild: true };

  const roles = resolveExistingRoles(guildRoles);
  const current = new Set((member.roles || []).map(String));
  const desired = new Set();

  if (record?.active) {
    const tenureKey = record.tenure_role_key || tenureRoleKey(record.first_eligible_at);
    if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
    if (record.is_annual && roles.annual) desired.add(String(roles.annual));
  }

  let applied = 0;
  for (const roleId of Object.values(roles).map(String)) {
    const shouldHave = desired.has(roleId);
    const hasRole = current.has(roleId);
    if (shouldHave === hasRole) continue;
    const changed = await applyRoleMutationWithRetry(
      discordUserId,
      roleId,
      shouldHave,
      env,
      reason || "Targeted Dojo managed-role sync",
    );
    if (changed) applied += 1;
  }
  return { applied, not_in_guild: false };
}

function resolveExistingRoles(guildRoles) {
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

async function fetchDiscordMember(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Discord member lookup ${response.status}: ${(await response.text()).slice(0, 180)}`);
  }
  return response.json();
}

async function applyRoleMutationWithRetry(discordUserId, roleId, add, env, reason) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
      {
        method: add ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "X-Audit-Log-Reason": encodeURIComponent(reason || "Dojo managed-role sync"),
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

function isRelevantMembershipEvent(event, env) {
  const type = String(event?.type || "");
  if (type !== "membership.activated" && type !== "membership.deactivated") return false;
  const companyId = String(event?.company_id || event?.data?.company?.id || "");
  const productId = String(event?.data?.product?.id || "");
  return companyId === String(env.WHOP_COMPANY_ID || "") && productId === String(env.WHOP_PRODUCT_ID || "");
}

function membershipUserId(record) {
  return String(record?.user?.id || record?.user_id || record?.member?.user?.id || record?.membership?.user?.id || "");
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

async function ensureAdminCommands(env) {
  if (!env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const existing = await discordJson(url, env);
  const names = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item?.name || "")));
  for (const command of ADMIN_COMMANDS) {
    if (names.has(command.name)) continue;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent(`Register owner command /${command.name}`),
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error(`Discord command registration ${response.status}: ${await response.text()}`);
  }
}

async function awardChampionRole(env, champion) {
  const monthKey = String(champion?.month_key || "");
  const winnerId = String(champion?.discord_user_id || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) || !winnerId) return;

  const roleName = `${monthLabel(monthKey)} Champion`;
  const guildRoles = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env);
  let role = (Array.isArray(guildRoles) ? guildRoles : []).find((item) => String(item?.name || "") === roleName);
  if (!role?.id) {
    const response = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent(`Create permanent RR champion role: ${roleName}`),
      },
      body: JSON.stringify({ name: roleName, permissions: "0", color: 0, hoist: false, mentionable: false }),
    });
    if (!response.ok) throw new Error(`Champion role creation ${response.status}: ${await response.text()}`);
    role = await response.json();
  }

  await applyRoleMutationWithRetry(winnerId, String(role.id), true, env, `Award ${roleName}`);
}

function monthLabel(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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

function requireManagedRoleEnv(env) {
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
  if (!env.MEMBER_LINKS || !env.DISCORD_GATEWAY) throw new Error("Membership storage bindings are unavailable");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
