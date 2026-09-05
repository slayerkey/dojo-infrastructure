import legacy, { DiscordGateway as DiscordGatewayV29 } from "./index-v29.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const encoder = new TextEncoder();

const DIAGNOSTIC_COMMAND = {
  name: "memberrolecheck",
  description: "Check exactly why a Dojo member has their current membership roles",
  type: 1,
  options: [
    {
      name: "member",
      description: "Dojo member to inspect",
      type: 6,
      required: true,
    },
  ],
};

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
      if (command !== DIAGNOSTIC_COMMAND.name) return legacy.fetch(delegated, env, ctx);

      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const ownerId = getInteractionUserId(interaction);
      if (!ownerId || ownerId !== String(env.DISCORD_OWNER_USER_ID || "")) {
        return ephemeralMessage("Only the Dojo owner can use this command.");
      }
      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This command only works in the Slayerkey Discord server.");
      }

      const targetId = String(getOption(interaction, "member") || "");
      if (!/^\d+$/.test(targetId)) return ephemeralMessage("Choose a Discord member to inspect.");

      ctx.waitUntil(
        buildMemberRoleDiagnostic(targetId, env)
          .then((content) => editOriginalInteraction(interaction, env, { content }))
          .catch(async (error) => {
            console.error("memberrolecheck failed:", error);
            await editOriginalInteraction(interaction, env, {
              content: `Member role check failed: ${safeError(error)}`,
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
          diagnostic_command: "/memberrolecheck",
          configured_annual_plan_ids: configuredAnnualPlanIds(env),
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const tasks = [ensureDiagnosticCommandOnce(env)];
    if (typeof legacy.scheduled === "function") {
      tasks.push(Promise.resolve(legacy.scheduled(controller, env, ctx)));
    }
    await Promise.allSettled(tasks);
  },
};

export class DiscordGateway extends DiscordGatewayV29 {
  async claimV30DiagnosticRegistration() {
    const key = "membership_v30:diagnostic_registered";
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, new Date().toISOString());
    return true;
  }

  async releaseV30DiagnosticRegistration() {
    await this.ctx.storage.delete("membership_v30:diagnostic_registered");
    return true;
  }
}

async function ensureDiagnosticCommandOnce(env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub || !env.DISCORD_APP_ID || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  const claimed = await stub.claimV30DiagnosticRegistration().catch(() => false);
  if (!claimed) return;

  try {
    const url = `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
    const existing = await discordJson(url, env);
    const found = (Array.isArray(existing) ? existing : []).find(
      (item) => String(item?.name || "") === DIAGNOSTIC_COMMAND.name,
    );
    if (!found) {
      await discordJson(url, env, {
        method: "POST",
        body: JSON.stringify(DIAGNOSTIC_COMMAND),
        reason: "Register owner membership role diagnostic command",
      });
    }
  } catch (error) {
    await stub.releaseV30DiagnosticRegistration().catch(() => {});
    throw error;
  }
}

async function buildMemberRoleDiagnostic(discordUserId, env) {
  const [member, guildRoles, stored, reverse, memberships] = await Promise.all([
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`, env),
    discordJson(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, env),
    env.DISCORD_GATEWAY?.getByName("dojo-main")?.getTenureRecord(discordUserId).catch(() => null),
    env.MEMBER_LINKS?.get(`discord:${discordUserId}`, "json").catch(() => null),
    fetchCurrentDojoMemberships(env),
  ]);

  const currentRoleIds = new Set((member?.roles || []).map(String));
  const roleNames = new Map((Array.isArray(guildRoles) ? guildRoles : []).map((role) => [String(role.id), String(role.name)]));
  const managedRoleNames = [...currentRoleIds]
    .map((id) => roleNames.get(id))
    .filter((name) => name && (name === "Annual Member" || /^Month \d+ • /.test(name) || /^Year \d+ • /.test(name)));

  const whopUserId = String(stored?.whop_user_id || reverse?.whop_user_id || "");
  const userMemberships = (memberships || []).filter((record) => membershipUserId(record) === whopUserId);
  const planIds = [...new Set(userMemberships.map(membershipPlanId).filter(Boolean))];
  const annualPlanIds = configuredAnnualPlanIds(env);
  const annualMatch = planIds.some((id) => annualPlanIds.includes(id));
  const activeMemberships = userMemberships.filter(isActiveMembership);
  const dojoRole = currentRoleIds.has(String(env.DISCORD_DOJO_ROLE_ID || ""));
  const tenureStart = stored?.first_eligible_at || member?.joined_at || null;
  const expectedTenureRole = tenureStart ? tenureRoleName(tenureStart) : "Unknown";

  const lines = [
    `## Member Role Check`,
    `<@${discordUserId}>`,
    `**Dojo role:** ${dojoRole ? "Yes" : "No"}`,
    `**Current managed roles:** ${managedRoleNames.length ? managedRoleNames.join(", ") : "None"}`,
    `**Expected tenure role:** ${expectedTenureRole}`,
    `**Tenure date:** ${formatDate(tenureStart)} (${stored?.first_eligible_at ? "stored Whop/tenure record" : "Discord joined_at fallback"})`,
    "",
    `**Whop linked:** ${whopUserId ? "Yes" : "No"}`,
    `**Active Dojo memberships found:** ${activeMemberships.length}`,
    `**Plan ID(s):** ${planIds.length ? planIds.map((id) => `\`${id}\``).join(", ") : "None resolved"}`,
    `**Configured annual plan ID(s):** ${annualPlanIds.length ? annualPlanIds.map((id) => `\`${id}\``).join(", ") : "None"}`,
    `**Annual-plan match:** ${annualMatch ? "YES" : "No"}`,
    `**Stored annual flag:** ${stored?.is_annual ? "YES" : "No"}`,
  ];

  if (!whopUserId) {
    lines.push("", "⚠️ No Discord ↔ Whop mapping is stored for this member. Tenure may be using the Discord join-date fallback, and Annual Member cannot be reliably assigned until the Whop link resolves.");
  } else if (activeMemberships.length === 0) {
    lines.push("", "⚠️ A Whop user is linked, but no active membership for the configured Dojo product was returned.");
  } else if (annualMatch && !stored?.is_annual) {
    lines.push("", "⚠️ This member is on the configured annual plan but the stored annual flag has not caught up yet. Run **/memberroles** to force a sync.");
  }

  return lines.join("\n").slice(0, 1950);
}

async function fetchCurrentDojoMemberships(env) {
  if (!env.WHOP_API_KEY || !env.WHOP_COMPANY_ID || !env.WHOP_PRODUCT_ID) return [];
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

function configuredAnnualPlanIds(env) {
  return String(env.WHOP_ANNUAL_PLAN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

function tenureRoleName(firstEligibleAt, now = new Date()) {
  const completedMonths = fullMonthsSince(firstEligibleAt, now);
  if (completedMonths >= 36) return "Year 3 • Icon";
  if (completedMonths >= 24) return "Year 2 • Legend";
  if (completedMonths >= 12) return "Year 1 • Master";
  const month = Math.min(completedMonths + 1, 6);
  return [null, "Month 1 • Rookie", "Month 2 • Contender", "Month 3 • Competitor", "Month 4 • Challenger", "Month 5 • Veteran", "Month 6 • Elite"][month];
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

function formatDate(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return date.toISOString().slice(0, 10);
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

function ephemeralMessage(content) {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}), allowed_mentions: { parse: [] } };
  const response = await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Could not edit Discord interaction: ${response.status} ${(await response.text()).slice(0, 160)}`);
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
  for (let index = 0; index < normalized.length; index += 2) bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  return bytes;
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}
