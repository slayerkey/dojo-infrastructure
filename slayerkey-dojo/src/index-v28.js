import legacy, { DiscordGateway as DiscordGatewayV27 } from "./index-v27.js";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_INTENTS = 1 | 2 | 512 | 1024; // Guilds, Guild Members, Guild Messages, Guild Message Reactions
const ACTIVITY_CHANNEL_ID = "1545559455540715602";
const ACTIVITY_WEEKDAY = 0; // Sunday
const ACTIVITY_HOUR = 6;
const ACTIVITY_MINUTE = 0;

const TENURE_ROLES = [
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
        body.discord.activity_check = {
          ...(body.discord.activity_check || {}),
          gateway_message_events: true,
          schedule: "Sunday 6:00 AM America/Phoenix",
          channel_id: ACTIVITY_CHANNEL_ID,
        };
        body.discord.membership_roles = {
          ...(body.discord.membership_roles || {}),
          dojo_role_backfill: true,
          fallback_tenure_source: "Discord guild joined_at when Whop tenure is unavailable",
          yearly_roles: ["Year 1 • Master", "Year 2 • Legend", "Year 3 • Icon"],
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
      await legacy.scheduled(controller, env, ctx);
    }
    await runV28Maintenance(env);
  },
};

export class DiscordGateway extends DiscordGatewayV27 {
  sendIdentifyOrResume() {
    if (!this.ws || this.ws.readyState !== 1) return;

    if (this.sessionId && this.sequence != null) {
      this.ws.send(JSON.stringify({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      }));
      return;
    }

    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "slayerkey-dojo",
          device: "slayerkey-dojo",
        },
      },
    }));
  }

  async claimV28BackfillDay(dayKey) {
    const key = "membership_v28_backfill:last_day";
    const current = await this.ctx.storage.get(key);
    if (String(current || "") === String(dayKey || "")) return false;
    await this.ctx.storage.put(key, String(dayKey || ""));
    return true;
  }

  async applyV28ActivitySchedule(config) {
    const marker = "activity:v28_fixed_schedule";
    if (await this.ctx.storage.get(marker)) return false;
    await this.setActivityConfig(config);
    await this.ctx.storage.put(marker, new Date().toISOString());
    return true;
  }
}

async function runV28Maintenance(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return;

  await stub.applyV28ActivitySchedule({
    enabled: true,
    channel_id: ACTIVITY_CHANNEL_ID,
    weekday: ACTIVITY_WEEKDAY,
    hour: ACTIVITY_HOUR,
    minute: ACTIVITY_MINUTE,
    configured_at: new Date().toISOString(),
    source: "user_requested_sunday_6am_arizona",
  }).catch((error) => console.error("Could not set v28 activity schedule:", error));

  const dayKey = new Date().toISOString().slice(0, 10);
  const claimed = await stub.claimV28BackfillDay(dayKey).catch(() => false);
  if (!claimed) return;

  await backfillAllCurrentDojoMembers(env, stub).catch((error) => {
    console.error("Dojo tenure backfill failed:", error);
  });
}

async function backfillAllCurrentDojoMembers(env, stub) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID || !env.DISCORD_DOJO_ROLE_ID) return;
  const roleIds = await ensureTenureRoles(env);
  const members = await fetchDojoMembers(env);

  let assigned = 0;
  for (const member of members) {
    const discordUserId = String(member?.user?.id || "");
    if (!discordUserId || member?.user?.bot) continue;

    const stored = await stub.getTenureRecord(discordUserId).catch(() => null);
    const tenureStart = stored?.first_eligible_at || member?.joined_at || new Date().toISOString();
    const roleKey = tenureRoleKey(tenureStart);
    const desiredRoleId = roleIds[roleKey];
    if (!desiredRoleId) continue;

    const current = new Set((member.roles || []).map(String));
    for (const roleId of Object.values(roleIds)) {
      const shouldHave = String(roleId) === String(desiredRoleId);
      const hasRole = current.has(String(roleId));
      if (shouldHave === hasRole) continue;
      await changeRole(discordUserId, String(roleId), shouldHave, env, "Dojo tenure backfill");
    }
    assigned += 1;
  }

  console.log(JSON.stringify({
    event: "dojo_tenure_backfill",
    dojo_members: members.length,
    members_processed: assigned,
    worker_version: "v28",
  }));
}

async function ensureTenureRoles(env) {
  let guildRoles = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env);
  if (!Array.isArray(guildRoles)) guildRoles = [];
  const roles = {};

  // Annual Member is deliberately ensured here too, even though it is not a tenure role.
  if (!guildRoles.find((role) => String(role?.name || "") === "Annual Member")) {
    const annual = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env, {
      method: "POST",
      body: JSON.stringify({ name: "Annual Member", permissions: "0", color: 0, hoist: false, mentionable: false }),
      reason: "Ensure Annual Member role exists",
    });
    guildRoles.push(annual);
  }

  for (const definition of TENURE_ROLES) {
    let role = guildRoles.find((item) => String(item?.name || "") === definition.name);
    if (!role) {
      role = await discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env, {
        method: "POST",
        body: JSON.stringify({ name: definition.name, permissions: "0", color: 0, hoist: false, mentionable: false }),
        reason: `Ensure Dojo tenure role: ${definition.name}`,
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
  const response = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {
    method: add ? "PUT" : "DELETE",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "X-Audit-Log-Reason": encodeURIComponent(reason || "Dojo tenure sync"),
    },
  });
  if (response.status === 204 || (!add && response.status === 404)) return;
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
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (response.status === 204) return null;
  return response.json();
}
