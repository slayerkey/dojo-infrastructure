import legacy, { DiscordGateway as DiscordGatewayV24 } from "./index-v24.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const encoder = new TextEncoder();

const MANAGED_ROLE_DEFINITIONS = [
  { key: "annual", name: "Annual Member" },
  { key: "m1", name: "Month 1 • Rookie" },
  { key: "m2", name: "Month 2 • Contender" },
  { key: "m3", name: "Month 3 • Competitor" },
  { key: "m4", name: "Month 4 • Challenger" },
  { key: "m5", name: "Month 5 • Veteran" },
  { key: "m6", name: "Month 6 • Elite" },
];

const ACCESS_STATUSES = new Set(["active", "trialing", "canceling", "completed"]);
const ADMIN_COMMANDS = [
  {
    name: "memberroles",
    description: "Create and sync Dojo membership tenure roles",
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
      if (command !== "memberroles" && command !== "setchampion") {
        return legacy.fetch(delegated, env, ctx);
      }

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const discordUserId = getInteractionUserId(interaction);
      if (!discordUserId || discordUserId !== String(env.DISCORD_OWNER_USER_ID || "")) {
        return ephemeralMessage("Only the Dojo owner can use this command.");
      }

      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

      if (command === "memberroles") {
        ctx.waitUntil(
          runMembershipRoleSync(env)
            .then(async (summary) => {
              const frozen = await env.RR_TRACKER?.freezePreviousMonthChampion?.().catch(() => null);
              if (frozen?.ok && frozen.champion) {
                await awardChampionRole(env, frozen.champion).catch(() => {});
              }
              await editOriginalInteraction(interaction, env, {
                content:
                  `Membership roles are synced. **${summary.roles_created}** role(s) created, ` +
                  `**${summary.members_synced}** active member(s) synced, ` +
                  `**${summary.members_deactivated}** inactive member(s) cleaned up.`,
              });
            })
            .catch(async (error) => {
              console.error("memberroles failed:", error);
              await editOriginalInteraction(interaction, env, {
                content: `Membership role sync failed: ${safeError(error)}`,
              }).catch(() => {});
            }),
        );
        return Response.json({ type: 5, data: { flags: EPHEMERAL } });
      }

      const month = String(getOption(interaction, "month") || "").trim();
      const winnerId = String(getOption(interaction, "winner") || "").trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^\d+$/.test(winnerId)) {
        return ephemeralMessage("Use a month like **2026-08** and choose the winning Discord member.");
      }

      ctx.waitUntil(
        correctChampion({ interaction, env, month, winnerId, ownerId: discordUserId })
          .catch(async (error) => {
            console.error("setchampion failed:", error);
            await editOriginalInteraction(interaction, env, {
              content: `Champion correction failed: ${safeError(error)}`,
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
        body.discord.membership_roles = {
          version: "v25",
          auto_create: true,
          annual_role: "Annual Member",
          tenure_roles: MANAGED_ROLE_DEFINITIONS.filter((item) => item.key !== "annual").map((item) => item.name),
          single_tenure_role: true,
          tenure_source: "Whop joined_at with preserved first eligible date",
          daily_sync: true,
          commands: ["/memberroles", "/setchampion"],
          frozen_monthly_champions: true,
          permanent_champion_roles: true,
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const tasks = [runDailyMaintenance(env)];
    if (typeof legacy.scheduled === "function") {
      tasks.push(Promise.resolve(legacy.scheduled(controller, env, ctx)));
    }
    await Promise.allSettled(tasks);
  },
};

export class DiscordGateway extends DiscordGatewayV24 {
  async claimMemberAutomationDay(dayKey) {
    const key = "membership_automation:last_day";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dayKey || "")) return false;
    await this.ctx.storage.put(key, String(dayKey || ""));
    return true;
  }

  async releaseMemberAutomationDay(dayKey) {
    const key = "membership_automation:last_day";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dayKey || "")) {
      await this.ctx.storage.delete(key);
    }
    return true;
  }

  async getTenureRecord(discordUserId) {
    return (await this.ctx.storage.get(`tenure:${String(discordUserId || "")}`)) || null;
  }

  async putTenureRecord(discordUserId, record) {
    const id = String(discordUserId || "");
    if (!id) return { ok: false };
    await this.ctx.storage.put(`tenure:${id}`, { ...(record || {}), discord_user_id: id });
    return { ok: true };
  }

  async listTenureRecords() {
    const rows = await this.ctx.storage.list({ prefix: "tenure:" });
    return [...rows.values()];
  }
}

async function runDailyMaintenance(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  const dayKey = new Date().toISOString().slice(0, 10);
  if (!stub) return;

  const claimed = await stub.claimMemberAutomationDay(dayKey).catch(() => false);
  if (!claimed) return;

  try {
    await ensureAdminCommands(env);
    await runMembershipRoleSync(env);
    const frozen = await env.RR_TRACKER?.freezePreviousMonthChampion?.();
    if (frozen?.ok && frozen.champion) {
      await awardChampionRole(env, frozen.champion);
    }
  } catch (error) {
    await stub.releaseMemberAutomationDay(dayKey).catch(() => {});
    console.error("Daily membership automation failed:", error);
    throw error;
  }
}

async function runMembershipRoleSync(env) {
  requireMembershipAutomationEnv(env);
  const { roles, created } = await ensureManagedRoles(env);
  const records = await fetchCurrentDojoMemberships(env);
  const activeMemberships = records.filter((record) => ACCESS_STATUSES.has(String(record?.status || "").toLowerCase()));
  const byUser = groupMembershipsByUser(activeMemberships);
  const planCache = new Map();
  const activeWhopUsers = new Set(byUser.keys());
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");

  let membersSynced = 0;
  for (const [whopUserId, memberships] of byUser.entries()) {
    const discordUserId = await resolveDiscordUserId(whopUserId, env);
    if (!discordUserId) continue;

    const annualFlags = await Promise.all(
      memberships.map((membership) => isAnnualMembership(membership, env, planCache)),
    );
    const isAnnual = annualFlags.some(Boolean);
    const joinedAt = earliestMembershipDate(memberships);
    const existing = await stub.getTenureRecord(discordUserId).catch(() => null);
    const firstEligibleAt = earliestIsoDate(existing?.first_eligible_at, joinedAt) || new Date().toISOString();
    const latestMembership = memberships
      .slice()
      .sort((a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0))[0];

    const next = {
      whop_user_id: whopUserId,
      membership_id: latestMembership?.id ? String(latestMembership.id) : existing?.membership_id || null,
      first_eligible_at: firstEligibleAt,
      is_annual: isAnnual,
      active: true,
      updated_at: new Date().toISOString(),
    };
    await stub.putTenureRecord(discordUserId, next);
    await applyManagedRoles(discordUserId, next, roles, env);
    await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
    membersSynced += 1;
  }

  let membersDeactivated = 0;
  const known = await stub.listTenureRecords().catch(() => []);
  for (const record of Array.isArray(known) ? known : []) {
    if (!record?.active) continue;
    if (activeWhopUsers.has(String(record.whop_user_id || ""))) continue;
    const discordUserId = String(record.discord_user_id || "");
    if (!discordUserId) continue;

    const next = {
      ...record,
      active: false,
      is_annual: false,
      updated_at: new Date().toISOString(),
    };
    await stub.putTenureRecord(discordUserId, next);
    await applyManagedRoles(discordUserId, next, roles, env);
    await env.RR_TRACKER?.setMemberActive(discordUserId, false).catch(() => {});
    membersDeactivated += 1;
  }

  return {
    roles_created: created,
    members_synced: membersSynced,
    members_deactivated: membersDeactivated,
  };
}

async function ensureManagedRoles(env) {
  let guildRoles = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env);
  if (!Array.isArray(guildRoles)) guildRoles = [];

  const roles = {};
  let created = 0;
  for (const definition of MANAGED_ROLE_DEFINITIONS) {
    let role = guildRoles.find((item) => String(item?.name || "") === definition.name);
    if (!role) {
      role = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env, {
        method: "POST",
        body: JSON.stringify({
          name: definition.name,
          permissions: "0",
          color: 0,
          hoist: false,
          mentionable: false,
        }),
        reason: `Create managed Dojo role: ${definition.name}`,
      });
      guildRoles.push(role);
      created += 1;
    }
    roles[definition.key] = String(role.id);
  }

  return { roles, created };
}

async function applyManagedRoles(discordUserId, record, roles, env) {
  const memberResponse = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (memberResponse.status === 404) return { ok: false, reason: "not_in_guild" };
  if (!memberResponse.ok) {
    throw new Error(`Discord member lookup ${memberResponse.status}: ${(await memberResponse.text()).slice(0, 160)}`);
  }
  const member = await memberResponse.json();
  const current = new Set((member.roles || []).map(String));
  const desired = new Set();

  if (record?.active) {
    if (record.is_annual && roles.annual) desired.add(String(roles.annual));
    const tenureKey = tenureRoleKey(record.first_eligible_at);
    if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
  }

  const managedIds = Object.values(roles).map(String);
  for (const roleId of managedIds) {
    const shouldHave = desired.has(roleId);
    const hasRole = current.has(roleId);
    if (shouldHave === hasRole) continue;
    await changeRole(discordUserId, roleId, shouldHave, env, "Automatic Dojo membership tenure sync");
  }
  return { ok: true };
}

function tenureRoleKey(firstEligibleAt, now = new Date()) {
  const months = fullMonthsSince(firstEligibleAt, now);
  if (months < 1) return null;
  return `m${Math.min(months, 6)}`;
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

async function fetchCurrentDojoMemberships(env) {
  return fetchPaged("/memberships", env, (params) => {
    params.append("company_id", env.WHOP_COMPANY_ID);
    params.append("product_ids", env.WHOP_PRODUCT_ID);
  });
}

function groupMembershipsByUser(records) {
  const map = new Map();
  for (const record of records || []) {
    const userId = membershipUserId(record);
    if (!userId) continue;
    if (!map.has(userId)) map.set(userId, []);
    map.get(userId).push(record);
  }
  return map;
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

async function isAnnualMembership(membership, env, planCache) {
  const planId = String(membership?.plan?.id || membership?.plan_id || "");
  const configuredAnnual = new Set(
    String(env.WHOP_ANNUAL_PLAN_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (planId && configuredAnnual.has(planId)) return true;

  const renewalStart = Date.parse(membership?.renewal_period_start || "");
  const renewalEnd = Date.parse(membership?.renewal_period_end || "");
  if (Number.isFinite(renewalStart) && Number.isFinite(renewalEnd)) {
    const days = (renewalEnd - renewalStart) / 86400000;
    if (days >= 300) return true;
  }

  if (looksAnnual(membership?.plan)) return true;
  if (!planId) return false;

  if (!planCache.has(planId)) {
    planCache.set(planId, fetchWhopPlan(planId, env).catch((error) => {
      console.warn(`Could not read Whop plan ${planId}:`, String(error));
      return null;
    }));
  }
  const plan = await planCache.get(planId);
  return looksAnnual(plan);
}

function looksAnnual(plan) {
  if (!plan || typeof plan !== "object") return false;
  if (Number(plan.billing_period || 0) >= 300) return true;
  if (Number(plan.expiration_days || 0) >= 300) return true;
  const text = `${plan.title || ""} ${plan.description || ""}`.toLowerCase();
  return /\bannual\b|\byearly\b|\b1\s*year\b|\b12\s*month/.test(text);
}

async function fetchWhopPlan(planId, env) {
  const response = await fetch(`${WHOP_API}/plans/${encodeURIComponent(planId)}`, {
    headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Whop plan lookup ${response.status}`);
  return response.json();
}

async function resolveDiscordUserId(whopUserId, env) {
  const key = `whop:${whopUserId}`;
  const cached = await env.MEMBER_LINKS?.get(key, "json").catch(() => null);
  if (cached?.discord_user_id) return String(cached.discord_user_id);

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

async function fetchPaged(path, env, configure) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({ first: "100" });
    configure(params);
    if (after) params.set("after", after);
    const response = await fetch(`${WHOP_API}${path}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) {
      throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 160)}`);
    }
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function ensureAdminCommands(env) {
  const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
  const existing = await discordJson(url, env);
  const names = new Set((Array.isArray(existing) ? existing : []).map((item) => String(item?.name || "")));
  for (const command of ADMIN_COMMANDS) {
    if (names.has(command.name)) continue;
    await discordJson(url, env, {
      method: "POST",
      body: JSON.stringify(command),
      reason: `Register owner command /${command.name}`,
    });
  }
}

async function correctChampion({ interaction, env, month, winnerId, ownerId }) {
  if (!env.RR_TRACKER) throw new Error("RR tracker service is unavailable.");
  const previous = await env.RR_TRACKER.getMonthlyChampion(month).catch(() => null);
  const result = await env.RR_TRACKER.setMonthlyChampion(month, winnerId, `owner:${ownerId}`);
  if (!result?.ok || !result.champion) {
    await editOriginalInteraction(interaction, env, {
      content: result?.message || "I could not save that champion correction.",
    });
    return;
  }

  await awardChampionRole(env, result.champion, previous?.champion?.discord_user_id || null);
  await editOriginalInteraction(interaction, env, {
    content:
      `Updated **${result.champion.month_label}** champion to <@${winnerId}> ` +
      `(${formatSigned(result.champion.monthly_rr)} RR). The frozen leaderboard record and permanent champion role now match.`,
  });
}

async function awardChampionRole(env, champion, previousWinnerId = null) {
  const monthKey = String(champion?.month_key || "");
  const winnerId = String(champion?.discord_user_id || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey) || !winnerId) return;

  const roleName = `${monthLabel(monthKey)} Champion`;
  const roleId = await ensureRoleByName(roleName, env);
  if (previousWinnerId && String(previousWinnerId) !== winnerId) {
    await changeRole(String(previousWinnerId), roleId, false, env, `Correct ${roleName}`).catch(() => {});
  }
  await changeRole(winnerId, roleId, true, env, `Award ${roleName}`);
}

async function ensureRoleByName(name, env) {
  let roles = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env);
  if (!Array.isArray(roles)) roles = [];
  const existing = roles.find((role) => String(role?.name || "") === name);
  if (existing?.id) return String(existing.id);
  const role = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env, {
    method: "POST",
    body: JSON.stringify({ name, permissions: "0", color: 0, hoist: false, mentionable: false }),
    reason: `Create permanent RR champion role: ${name}`,
  });
  return String(role.id);
}

function monthLabel(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function changeRole(discordUserId, roleId, add, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    {
      method: add ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": encodeURIComponent(reason || "Dojo role sync"),
      },
    },
  );
  if (response.status === 204 || (!add && response.status === 404)) return { ok: true };
  throw new Error(`Discord role ${add ? "add" : "remove"} ${response.status}: ${(await response.text()).slice(0, 160)}`);
}

async function discordJson(url, env, options = {}) {
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(options.reason);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function requireMembershipAutomationEnv(env) {
  for (const key of [
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_APP_ID",
    "WHOP_API_KEY",
    "WHOP_COMPANY_ID",
    "WHOP_PRODUCT_ID",
  ]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!env.MEMBER_LINKS || !env.DISCORD_GATEWAY) throw new Error("Membership storage bindings are missing.");
}

function getOption(interaction, name) {
  const stack = Array.isArray(interaction?.data?.options) ? [...interaction.data.options] : [];
  while (stack.length) {
    const item = stack.shift();
    if (String(item?.name || "") === String(name) && item?.value != null) return item.value;
    if (Array.isArray(item?.options)) stack.push(...item.options);
  }
  return null;
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}), allowed_mentions: { parse: [] } };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Could not edit Discord interaction: ${response.status} ${(await response.text()).slice(0, 160)}`);
  }
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
  const normalized = String(hex || "").trim();
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("Invalid hex value");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}
