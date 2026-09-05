import legacy, { DiscordGateway as DiscordGatewayV32 } from "./index-v32.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const encoder = new TextEncoder();
const ROLE_SYNC_BATCH_SIZE = 4;

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
      if (command !== "memberroles") return legacy.fetch(delegated, env, ctx);

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const userId = getInteractionUserId(interaction);
      if (!userId || userId !== String(env.DISCORD_OWNER_USER_ID || "")) {
        return ephemeralMessage("Only the Dojo owner can use this command.");
      }
      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

      // Respond immediately. The old implementation tried to perform every role
      // mutation inside one interaction and hit Discord's per-route rate limit.
      ctx.waitUntil(
        prepareQueuedRoleSync(interaction, env).catch(async (error) => {
          console.error("v33 role sync preparation failed:", error);
          await editOriginalInteraction(interaction, env, {
            content: `Role sync could not start: ${safeError(error)}`,
          }).catch(() => {});
        }),
      );

      return ephemeralMessage("Preparing a safe role sync…");
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          manual_sync_mode: "queued-rate-limit-safe-v33",
          creates_roles_during_sync: false,
          mutations_per_cron_pass: ROLE_SYNC_BATCH_SIZE,
          discord_429_behavior: "pause-and-resume-next-cron",
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
      await stub.processV33RoleSyncBatch().catch((error) => {
        console.error("v33 queued role sync batch failed:", error);
      });
    }

    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV32 {
  async startV33RoleSync(job) {
    const existing = await this.ctx.storage.get("membership:v33_sync_job");
    if (existing?.status === "running") {
      return {
        started: false,
        job: existing,
      };
    }

    const next = {
      ...job,
      status: "running",
      index: 0,
      applied: 0,
      failed: 0,
      rate_limits: 0,
      next_attempt_at: 0,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await this.ctx.storage.put("membership:v33_sync_job", next);
    return { started: true, job: next };
  }

  async getV33RoleSyncJob() {
    return (await this.ctx.storage.get("membership:v33_sync_job")) || null;
  }

  async processV33RoleSyncBatch() {
    const key = "membership:v33_sync_job";
    const job = await this.ctx.storage.get(key);
    if (!job || job.status !== "running") return { processed: 0 };

    if (Number(job.next_attempt_at || 0) > Date.now()) {
      return { processed: 0, waiting: true };
    }

    const mutations = Array.isArray(job.mutations) ? job.mutations : [];
    let processed = 0;

    while (job.index < mutations.length && processed < ROLE_SYNC_BATCH_SIZE) {
      const mutation = mutations[job.index];
      const result = await applyRoleMutation(mutation, this.env);

      if (result.rate_limited) {
        job.rate_limits = Number(job.rate_limits || 0) + 1;
        job.next_attempt_at = Date.now() + Math.max(1000, Number(result.retry_after_ms || 10000));
        job.updated_at = new Date().toISOString();
        await this.ctx.storage.put(key, job);
        await updateRoleSyncInteraction(job, this.env, false).catch(() => {});
        return { processed, rate_limited: true };
      }

      job.index += 1;
      processed += 1;
      job.next_attempt_at = 0;
      if (result.ok) job.applied = Number(job.applied || 0) + 1;
      else job.failed = Number(job.failed || 0) + 1;
    }

    job.updated_at = new Date().toISOString();
    if (job.index >= mutations.length) {
      job.status = "finished";
      job.finished_at = new Date().toISOString();
    }
    await this.ctx.storage.put(key, job);
    await updateRoleSyncInteraction(job, this.env, job.status === "finished").catch(() => {});
    return { processed, finished: job.status === "finished" };
  }
}

async function prepareQueuedRoleSync(interaction, env) {
  requireSyncEnv(env);
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");
  const existing = await stub.getV33RoleSyncJob().catch(() => null);
  if (existing?.status === "running") {
    await editOriginalInteraction(interaction, env, {
      content: roleSyncProgressText(existing, false),
    });
    return;
  }

  const [guildRolesRaw, dojoMembers, memberships] = await Promise.all([
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
    fetchDojoMembers(env),
    fetchCurrentDojoMembershipsWithTimeout(env, 8000),
  ]);

  const guildRoles = Array.isArray(guildRolesRaw) ? guildRolesRaw : [];
  const roles = resolveExistingRoles(guildRoles);
  const membershipsByUser = groupMembershipsByUser((memberships || []).filter(isActiveMembership));
  const annualPlanIds = new Set(configuredAnnualPlanIds(env));

  let whopMapped = 0;
  let annualMembers = 0;
  let discordFallback = 0;
  const mutations = [];

  // This sync deliberately trusts existing Discord↔Whop mappings. It does not do
  // a live social-account crawl; that is what previously made the command slow.
  const prepared = await mapConcurrent(dojoMembers, 12, async (member) => {
    const discordUserId = String(member?.user?.id || "");
    if (!discordUserId || member?.user?.bot) return null;

    const [reverse, stored] = await Promise.all([
      env.MEMBER_LINKS?.get(`discord:${discordUserId}`, "json").catch(() => null),
      stub.getTenureRecord(discordUserId).catch(() => null),
    ]);

    const whopUserId = String(reverse?.whop_user_id || stored?.whop_user_id || "");
    const userMemberships = whopUserId ? (membershipsByUser.get(whopUserId) || []) : [];
    const hasWhopMembership = userMemberships.length > 0;

    let firstEligibleAt = stored?.first_eligible_at || member?.joined_at || new Date().toISOString();
    let isAnnual = false;

    if (hasWhopMembership) {
      whopMapped += 1;
      const whopStart = earliestMembershipDate(userMemberships);
      firstEligibleAt = earliestIsoDate(stored?.first_eligible_at, whopStart) || firstEligibleAt;
      isAnnual = userMemberships.some((membership) => membershipIsAnnual(membership, annualPlanIds));
      if (isAnnual) annualMembers += 1;

      await stub.putTenureRecord(discordUserId, {
        ...(stored || {}),
        discord_user_id: discordUserId,
        whop_user_id: whopUserId,
        first_eligible_at: firstEligibleAt,
        is_annual: isAnnual,
        active: true,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    } else {
      discordFallback += 1;
    }

    const desired = new Set();
    const tenureKey = tenureRoleKey(firstEligibleAt);
    if (tenureKey && roles[tenureKey]) desired.add(String(roles[tenureKey]));
    if (isAnnual && roles.annual) desired.add(String(roles.annual));

    const current = new Set((member?.roles || []).map(String));
    const additions = [];
    const removals = [];
    for (const roleId of Object.values(roles).map(String)) {
      const shouldHave = desired.has(roleId);
      const hasRole = current.has(roleId);
      if (shouldHave && !hasRole) additions.push({ discord_user_id: discordUserId, role_id: roleId, add: true });
      if (!shouldHave && hasRole) removals.push({ discord_user_id: discordUserId, role_id: roleId, add: false });
    }
    // Add the desired role before removing stale roles so a rate-limit pause never
    // leaves somebody temporarily without a tenure role.
    return [...additions, ...removals];
  });

  for (const item of prepared) {
    if (Array.isArray(item)) mutations.push(...item);
  }

  const job = {
    id: crypto.randomUUID(),
    interaction_token: String(interaction.token || ""),
    dojo_members: dojoMembers.length,
    whop_mapped: whopMapped,
    annual_members: annualMembers,
    discord_fallback: discordFallback,
    mutations,
  };

  const started = await stub.startV33RoleSync(job);
  const active = started?.job || job;
  await editOriginalInteraction(interaction, env, {
    content: started?.started
      ? roleSyncProgressText(active, mutations.length === 0)
      : roleSyncProgressText(active, false),
  });
}

function resolveExistingRoles(guildRoles) {
  const roles = {};
  const missing = [];
  for (const definition of ROLE_DEFINITIONS) {
    const role = guildRoles.find((item) => String(item?.name || "") === definition.name);
    if (!role?.id) missing.push(definition.name);
    else roles[definition.key] = String(role.id);
  }
  if (missing.length) {
    throw new Error(`Managed role(s) missing: ${missing.join(", ")}. /memberroles is sync-only and will not recreate them.`);
  }
  return roles;
}

async function applyRoleMutation(mutation, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${mutation.discord_user_id}/roles/${mutation.role_id}`,
    {
      method: mutation.add ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": encodeURIComponent("Queued Dojo membership role sync"),
      },
    },
  );

  if (response.status === 204 || (!mutation.add && response.status === 404)) {
    return { ok: true };
  }

  if (response.status === 429) {
    let retryAfterMs = 10000;
    try {
      const body = await response.json();
      retryAfterMs = Math.ceil(Number(body?.retry_after || 10) * 1000) + 500;
    } catch {}
    return { ok: false, rate_limited: true, retry_after_ms: retryAfterMs };
  }

  console.error("Queued role mutation failed", response.status, await response.text().catch(() => ""));
  return { ok: false, rate_limited: false };
}

async function updateRoleSyncInteraction(job, env, finished) {
  const token = String(job?.interaction_token || "");
  if (!token || !env.DISCORD_APP_ID) return;
  const response = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: roleSyncProgressText(job, finished),
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) {
    console.warn("Could not update role sync interaction:", response.status);
  }
}

function roleSyncProgressText(job, finished) {
  const total = Array.isArray(job?.mutations) ? job.mutations.length : 0;
  const index = Number(job?.index || 0);
  if (finished || (total === 0 && job?.status !== "running")) {
    return (
      `Role sync complete. **${Number(job?.dojo_members || 0)}** current Dojo member(s) checked.\n` +
      `**${Number(job?.whop_mapped || 0)}** matched to Whop • **${Number(job?.annual_members || 0)}** annual • ` +
      `**${Number(job?.discord_fallback || 0)}** using Discord join-date fallback.\n` +
      `**${Number(job?.applied || 0)}** role change(s) applied • **${Number(job?.failed || 0)}** failed • ` +
      `**${Number(job?.rate_limits || 0)}** rate-limit pause(s).`
    );
  }

  if (total === 0) {
    return (
      `Role sync complete. **${Number(job?.dojo_members || 0)}** current Dojo member(s) checked. ` +
      `Everyone already has the expected managed roles.`
    );
  }

  return (
    `Role sync queued safely. **${total}** role change(s) are needed across the Dojo.\n` +
    `Progress: **${Math.min(index, total)}/${total}** changes applied/checked. ` +
    `The bot will process a few each minute so Discord does not rate-limit it.\n` +
    `You do not need to run **/memberroles** again.`
  );
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

async function fetchCurrentDojoMembershipsWithTimeout(env, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let after = null;
    const all = [];
    do {
      const params = new URLSearchParams({ first: "100" });
      params.append("company_id", env.WHOP_COMPANY_ID);
      params.append("product_ids", env.WHOP_PRODUCT_ID);
      if (after) params.set("after", after);
      const response = await fetch(`${WHOP_API}/memberships?${params.toString()}`, {
        headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Whop memberships ${response.status}`);
      const page = await response.json();
      if (Array.isArray(page?.data)) all.push(...page.data);
      const info = page?.page_info || {};
      after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
    } while (after);
    return all;
  } finally {
    clearTimeout(timer);
  }
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

function isActiveMembership(record) {
  return new Set(["active", "trialing", "canceling", "completed"]).has(String(record?.status || "").toLowerCase());
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

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
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
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (response.status === 204) return null;
  return response.json();
}

function requireSyncEnv(env) {
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_APP_ID", "WHOP_API_KEY", "WHOP_COMPANY_ID", "WHOP_PRODUCT_ID"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  if (!env.MEMBER_LINKS || !env.DISCORD_GATEWAY) throw new Error("Membership storage bindings are missing.");
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
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
  if (!response.ok) throw new Error(`Could not edit interaction ${response.status}`);
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
  if (error?.name === "AbortError") return "Whop took too long to answer. Try again in a moment.";
  return String(error?.message || error || "Unknown error").slice(0, 300);
}
