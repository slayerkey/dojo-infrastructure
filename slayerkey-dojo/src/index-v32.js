import legacy, { DiscordGateway as DiscordGatewayV31 } from "./index-v31.js";

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
          buildV32ActivityStatus(env)
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
        runSyncOnlyMemberRoles(env)
          .then((summary) => editOriginalInteraction(interaction, env, {
            content:
              `Role sync complete in **${summary.elapsed_ms} ms**.\n` +
              `**${summary.dojo_members}** current Dojo member(s) checked • **${summary.role_changes}** role change(s).\n` +
              `**${summary.whop_mapped}** matched to Whop • **${summary.annual_members}** annual • ` +
              `**${summary.discord_fallback}** using Discord join-date fallback.\n` +
              (summary.whop_available
                ? `Whop membership list loaded successfully. **${summary.unresolved_whop_links}** Dojo member(s) still have no usable Discord ↔ Whop mapping.`
                : "⚠️ Whop did not answer within the fast sync window, so existing stored mappings were used and no live annual/tenure refresh was attempted."),
          }))
          .catch(async (error) => {
            console.error("sync-only memberroles failed:", error);
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
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          manual_sync_mode: "sync-only-v32",
          manual_sync_creates_roles: false,
          live_social_account_scan: false,
        };
        body.discord.activity_check = {
          ...(body.discord.activity_check || {}),
          diagnostic_mode: "all-guild-events-plus-dojo-events-v32",
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
      await stub.forceV32FreshGatewaySession().catch((error) => {
        console.error("Could not refresh v32 Discord gateway session:", error);
      });
    }
    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV31 {
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
      await this.recordV32GuildMessageEvent(
        String(payload.d?.author?.id || ""),
        payload.d?.timestamp || null,
        Array.isArray(payload.d?.member?.roles)
          ? payload.d.member.roles.map(String).includes(String(this.env.DISCORD_DOJO_ROLE_ID || ""))
          : false,
      ).catch(() => {});
    }

    return super.handleGatewayMessage(raw);
  }

  async recordV32GuildMessageEvent(discordUserId, timestamp, hasDojoRole) {
    const now = new Date().toISOString();
    const allCount = Number((await this.ctx.storage.get("activity:v32_all_events_seen")) || 0) + 1;
    await this.ctx.storage.put("activity:v32_all_events_seen", allCount);
    await this.ctx.storage.put("activity:v32_last_all_event", {
      discord_user_id: String(discordUserId || ""),
      message_timestamp: timestamp || now,
      received_at: now,
      has_dojo_role: Boolean(hasDojoRole),
    });
    return { ok: true, count: allCount };
  }

  async getV32ActivityStatus() {
    return {
      all_events_seen: Number((await this.ctx.storage.get("activity:v32_all_events_seen")) || 0),
      last_all_event: (await this.ctx.storage.get("activity:v32_last_all_event")) || null,
      refreshed_at: (await this.ctx.storage.get("gateway:v32_refreshed")) || null,
    };
  }

  async forceV32FreshGatewaySession() {
    const marker = "gateway:v32_refreshed";
    if (await this.ctx.storage.get(marker)) return false;
    this.sessionId = null;
    this.sequence = null;
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.close(4000, "Refresh gateway for v32 activity diagnostics");
      }
    } catch {}
    await this.ctx.storage.put(marker, new Date().toISOString());
    return true;
  }
}

async function buildV32ActivityStatus(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) throw new Error("Discord gateway storage is unavailable.");
  const [v31, v32] = await Promise.all([
    stub.getV31ActivityStatus().catch(() => ({})),
    stub.getV32ActivityStatus().catch(() => ({})),
  ]);

  const lines = [
    "## Dojo Activity Tracking Status",
    `**Gateway refreshed:** ${formatDiscordTime(v32.refreshed_at || v31.gateway_reidentified_at)}`,
    `**All human guild message events seen since v32:** ${Number(v32.all_events_seen || 0)}`,
    `**Dojo message events seen:** ${Number(v31.events_seen || 0)}`,
    `**Last guild message event:** ${v32.last_all_event?.received_at ? `${formatDiscordTime(v32.last_all_event.received_at)} from <@${v32.last_all_event.discord_user_id}> • Dojo role: **${v32.last_all_event.has_dojo_role ? "Yes" : "No"}**` : "None captured yet"}`,
    `**Last Dojo event:** ${v31.last_event?.received_at ? `${formatDiscordTime(v31.last_event.received_at)} from <@${v31.last_event.discord_user_id}>` : "None captured yet"}`,
    "",
    `**Weekly channel:** ${v31.config?.channel_id ? `<#${v31.config.channel_id}>` : "Not configured"}`,
    "**Schedule:** Sunday 6:00 AM Arizona time",
    "",
    "Test: send one brand-new message after this deployment. If **all guild events** stays at 0, the Discord gateway still is not receiving message events. If all guild events increases but **Dojo events** stays at 0, the sender did not have the configured Dojo role on that message.",
  ];
  return lines.join("\n").slice(0, 1950);
}

async function runSyncOnlyMemberRoles(env) {
  const started = Date.now();
  requireSyncEnv(env);
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");

  const [guildRolesRaw, dojoMembers] = await Promise.all([
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
    fetchDojoMembers(env),
  ]);
  const guildRoles = Array.isArray(guildRolesRaw) ? guildRolesRaw : [];
  const { roles, missing } = existingManagedRoles(guildRoles);
  if (missing.length) {
    throw new Error(`Managed roles are missing: ${missing.join(", ")}. This sync intentionally does not create roles.`);
  }

  let memberships = [];
  let whopAvailable = true;
  try {
    memberships = await withTimeout(fetchCurrentDojoMemberships(env), 8000, "WHOP_TIMEOUT");
  } catch (error) {
    whopAvailable = false;
    console.warn("Fast memberroles Whop lookup unavailable:", String(error));
  }

  const activeMemberships = memberships.filter(isActiveMembership);
  const grouped = groupMembershipsByUser(activeMemberships);
  const annualPlanIds = new Set(configuredAnnualPlanIds(env));

  const contextRows = await mapConcurrent(dojoMembers, 20, async (member) => {
    const discordUserId = String(member?.user?.id || "");
    if (!discordUserId) return null;
    const [stored, reverse] = await Promise.all([
      stub.getTenureRecord(discordUserId).catch(() => null),
      env.MEMBER_LINKS?.get(`discord:${discordUserId}`, "json").catch(() => null),
    ]);
    return { member, discordUserId, stored, reverse };
  });

  let whopMapped = 0;
  let annualMembers = 0;
  let discordFallback = 0;
  let roleChanges = 0;
  let unresolvedWhopLinks = 0;

  await mapConcurrent(contextRows.filter(Boolean), 6, async (row) => {
    const { member, discordUserId, stored, reverse } = row;
    const whopUserId = String(reverse?.whop_user_id || stored?.whop_user_id || "");
    const userMemberships = whopAvailable && whopUserId ? (grouped.get(whopUserId) || []) : [];

    let firstEligibleAt = stored?.first_eligible_at || null;
    let isAnnual = Boolean(stored?.is_annual);

    if (userMemberships.length) {
      whopMapped += 1;
      firstEligibleAt = earliestIsoDate(firstEligibleAt, earliestMembershipDate(userMemberships)) || member?.joined_at || new Date().toISOString();
      isAnnual = userMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
      if (isAnnual) annualMembers += 1;
      await stub.putTenureRecord(discordUserId, {
        ...(stored || {}),
        discord_user_id: discordUserId,
        whop_user_id: whopUserId,
        membership_id: latestMembershipId(userMemberships) || stored?.membership_id || null,
        first_eligible_at: firstEligibleAt,
        is_annual: isAnnual,
        active: true,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    } else {
      if (whopAvailable && !whopUserId) unresolvedWhopLinks += 1;
      firstEligibleAt = firstEligibleAt || member?.joined_at || new Date().toISOString();
      discordFallback += 1;
      if (isAnnual) annualMembers += 1;
    }

    const desired = new Set();
    const tenureKey = tenureRoleKey(firstEligibleAt);
    if (roles[tenureKey]) desired.add(String(roles[tenureKey]));
    if (isAnnual) desired.add(String(roles.annual));

    const current = new Set((member?.roles || []).map(String));
    for (const roleId of Object.values(roles).map(String)) {
      const shouldHave = desired.has(roleId);
      const hasRole = current.has(roleId);
      if (shouldHave === hasRole) continue;
      await withTimeout(
        changeRole(discordUserId, roleId, shouldHave, env, "Dojo role sync"),
        7000,
        "DISCORD_ROLE_TIMEOUT",
      );
      roleChanges += 1;
    }
  });

  return {
    elapsed_ms: Date.now() - started,
    dojo_members: contextRows.filter(Boolean).length,
    whop_mapped: whopMapped,
    annual_members: annualMembers,
    discord_fallback: discordFallback,
    role_changes: roleChanges,
    unresolved_whop_links: unresolvedWhopLinks,
    whop_available: whopAvailable,
  };
}

function existingManagedRoles(guildRoles) {
  const roles = {};
  const missing = [];
  for (const definition of ROLE_DEFINITIONS) {
    const role = guildRoles.find((item) => String(item?.name || "") === definition.name);
    if (!role?.id) missing.push(definition.name);
    else roles[definition.key] = String(role.id);
  }
  return { roles, missing };
}

async function fetchDojoMembers(env) {
  const result = [];
  let after = "0";
  const dojoRoleId = String(env.DISCORD_DOJO_ROLE_ID || "");
  while (true) {
    const page = await discordJson(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${encodeURIComponent(after)}`,
      env,
    );
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
    if (!response.ok) throw new Error(`Whop memberships ${response.status}`);
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
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
  return String(record?.user?.id || record?.user_id || record?.member?.user?.id || record?.membership?.user?.id || "");
}

function membershipPlanId(record) {
  return String(record?.plan?.id || record?.plan_id || record?.membership?.plan?.id || "");
}

function membershipIsAnnual(membership, annualPlanIds) {
  const planId = membershipPlanId(membership);
  if (planId && annualPlanIds.has(planId)) return true;
  const plan = membership?.plan || membership?.membership?.plan || null;
  if (Number(plan?.billing_period || 0) >= 300 || Number(plan?.expiration_days || 0) >= 300) return true;
  const text = `${plan?.title || ""} ${plan?.description || ""}`.toLowerCase();
  return /\bannual\b|\byearly\b|\b1\s*year\b|\b12\s*month/.test(text);
}

function isActiveMembership(record) {
  return new Set(["active", "trialing", "canceling", "completed"]).has(String(record?.status || "").toLowerCase());
}

function configuredAnnualPlanIds(env) {
  return String(env.WHOP_ANNUAL_PLAN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

function latestMembershipId(memberships) {
  const sorted = [...(memberships || [])].sort(
    (a, b) => Date.parse(b?.updated_at || b?.created_at || 0) - Date.parse(a?.updated_at || a?.created_at || 0),
  );
  return sorted[0]?.id ? String(sorted[0].id) : null;
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
  if (response.status === 204 || (!add && response.status === 404)) return;
  throw new Error(`Discord role ${add ? "add" : "remove"} ${response.status}: ${(await response.text()).slice(0, 160)}`);
}

async function discordJson(url, env, options = {}) {
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 180)}`);
  if (response.status === 204) return null;
  return response.json();
}

async function mapConcurrent(items, limit, worker) {
  const input = Array.isArray(items) ? items : [];
  const results = new Array(input.length);
  let index = 0;
  async function runner() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= input.length) return;
      results[current] = await worker(input[current], current);
    }
  }
  const runners = Array.from({ length: Math.min(Math.max(1, limit), input.length || 1) }, () => runner());
  await Promise.all(runners);
  return results;
}

function withTimeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(code || "TIMEOUT")), timeoutMs)),
  ]);
}

function requireSyncEnv(env) {
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "WHOP_API_KEY", "WHOP_COMPANY_ID", "WHOP_PRODUCT_ID"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!env.DISCORD_GATEWAY || !env.MEMBER_LINKS) throw new Error("Membership storage bindings are missing.");
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
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
  if (!response.ok) throw new Error(`Could not edit interaction ${response.status}: ${(await response.text()).slice(0, 160)}`);
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
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) throw new Error("Invalid hex value");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  return bytes;
}

function formatDiscordTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? `<t:${Math.floor(time / 1000)}:F> (<t:${Math.floor(time / 1000)}:R>)` : "Not recorded";
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}
