import legacy from "./index-v4.js";
import { DurableObject } from "cloudflare:workers";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "https://gateway.discord.gg/?v=10&encoding=json";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_API_VERSION_DATE = "2026-08-13";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const COMMAND_TIMEOUT_MS = 20000;
const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const PUBLIC_RR_COMMANDS = new Set(["sync", "rr", "rrleaderboard"]);
const WHOP_CONNECTED_ACCOUNTS_URL = "https://whop.com/@me/settings/connected-accounts/";
const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    ctx?.waitUntil?.(ensureGateway(env).catch((error) => {
      console.error("Discord Gateway ensure failed:", error);
    }));

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegatedRequest = request.clone();
      const rawBody = await request.text();
      const valid = await verifyDiscordSignature(
        request.headers,
        rawBody,
        env.DISCORD_PUBLIC_KEY,
      );
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      let interaction;
      try {
        interaction = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (interaction.type === 2) {
        const commandName = interaction.data?.name;
        if (PUBLIC_RR_COMMANDS.has(commandName)) {
          return handlePublicRrInteraction(interaction, env, ctx);
        }
        if (commandName === "verify") {
          return handleVerifyInteraction(interaction, env, ctx);
        }
        if (commandName === "verify-all") {
          return handleVerifyAllInteraction(interaction, env, ctx);
        }
      }

      return legacy.fetch(delegatedRequest, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.verification_resolver = "whop-social-accounts-v5";
        body.discord.sync_is_public = true;
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      const webhookCopy = request.clone();
      const response = await legacy.fetch(request, env, ctx);
      if (response.ok) {
        ctx.waitUntil(cacheDiscordLinkFromWhopWebhook(webhookCopy, env));
      }
      return response;
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

// The class name intentionally stays DiscordGateway so the existing Durable Object
// namespace can use the upgraded resolver without a migration or a new namespace.
export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.connecting = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.heartbeatAcked = true;
    this.sequence = null;
    this.sessionId = null;
    this.ready = false;
    this.lastReadyAt = null;
    this.lastEventAt = null;
    this.lastMemberJoinAt = null;
    this.lastVerification = null;
    this.lastError = null;
  }

  async ensureConnected() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return this.status();
    }
    if (this.connecting) {
      await this.connecting;
      return this.status();
    }

    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    return this.status();
  }

  async status() {
    return {
      configured: true,
      connected: Boolean(this.ws && this.ws.readyState === 1),
      ready: this.ready,
      last_ready_at: this.lastReadyAt,
      last_event_at: this.lastEventAt,
      last_member_join_at: this.lastMemberJoinAt,
      last_verification: this.lastVerification,
      last_error: this.lastError,
    };
  }

  async connect() {
    this.clearHeartbeat();
    this.clearReconnect();
    this.ready = false;
    this.lastError = null;

    const response = await fetch(DISCORD_GATEWAY_URL, {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket;
    if (!ws) {
      this.lastError = `Gateway upgrade failed with HTTP ${response.status}`;
      this.scheduleReconnect(5000);
      throw new Error(this.lastError);
    }

    ws.accept();
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      this.ctx.waitUntil(this.handleGatewayMessage(event.data));
    });
    ws.addEventListener("close", (event) => {
      this.ready = false;
      this.ws = null;
      this.clearHeartbeat();
      this.lastError = `Gateway closed ${event.code}${event.reason ? `: ${event.reason}` : ""}`;
      this.scheduleReconnect(2500);
    });
    ws.addEventListener("error", () => {
      this.ready = false;
      this.lastError = "Discord Gateway WebSocket error";
    });
  }

  async handleGatewayMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );
    } catch {
      return;
    }

    this.lastEventAt = new Date().toISOString();
    if (payload.s != null) this.sequence = payload.s;

    if (payload.op === 10) {
      const interval = Number(payload.d?.heartbeat_interval || 45000);
      this.startHeartbeat(interval);
      this.sendIdentifyOrResume();
      return;
    }
    if (payload.op === 11) {
      this.heartbeatAcked = true;
      return;
    }
    if (payload.op === 1) {
      this.sendHeartbeat(false);
      return;
    }
    if (payload.op === 7) {
      this.reconnectNow();
      return;
    }
    if (payload.op === 9) {
      if (!payload.d) {
        this.sessionId = null;
        this.sequence = null;
      }
      this.reconnectNow(1500 + Math.floor(Math.random() * 2500));
      return;
    }
    if (payload.op !== 0) return;

    if (payload.t === "READY") {
      this.sessionId = payload.d?.session_id || null;
      this.ready = true;
      this.lastReadyAt = new Date().toISOString();
      return;
    }
    if (payload.t === "RESUMED") {
      this.ready = true;
      this.lastReadyAt = new Date().toISOString();
      return;
    }

    if (payload.t === "GUILD_MEMBER_ADD") {
      const member = payload.d || {};
      if (String(member.guild_id || "") !== String(this.env.DISCORD_GUILD_ID || "")) return;
      if (member.user?.bot) return;

      this.lastMemberJoinAt = new Date().toISOString();
      const discordUserId = String(member.user?.id || "");
      if (!discordUserId) return;

      try {
        const result = await autoVerifyJoinedMember(discordUserId, this.env);
        this.lastVerification = {
          at: new Date().toISOString(),
          result: result.reason || (result.verified ? "verified" : "not_verified"),
        };
      } catch (error) {
        this.lastError = `Join verification failed: ${String(error)}`;
        console.error(this.lastError);
      }
    }
  }

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
        intents: 3,
        properties: {
          os: "linux",
          browser: "slayerkey-dojo",
          device: "slayerkey-dojo",
        },
      },
    }));
  }

  startHeartbeat(interval) {
    this.clearHeartbeat();
    this.heartbeatInterval = interval;
    this.heartbeatAcked = true;
    this.heartbeatTimer = setTimeout(
      () => this.sendHeartbeat(true),
      Math.floor(Math.random() * Math.max(interval, 1)),
    );
  }

  sendHeartbeat(scheduleNext = true) {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (!this.heartbeatAcked) {
      this.lastError = "Discord Gateway heartbeat was not acknowledged";
      this.reconnectNow();
      return;
    }

    this.heartbeatAcked = false;
    this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
    if (scheduleNext && this.heartbeatInterval) {
      this.clearHeartbeat();
      this.heartbeatTimer = setTimeout(
        () => this.sendHeartbeat(true),
        this.heartbeatInterval,
      );
    }
  }

  reconnectNow(delay = 1000) {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.clearHeartbeat();
    try {
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
        ws.close(4000, "Reconnect");
      }
    } catch {}
    this.scheduleReconnect(delay);
  }

  scheduleReconnect(delay) {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ctx.waitUntil(this.ensureConnected().catch((error) => {
        this.lastError = String(error);
      }));
    }, delay);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

async function handlePublicRrInteraction(interaction, env, ctx) {
  if (interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return ephemeralMessage("This command only works in the Slayerkey Discord server.");
  }

  const discordUserId = getInteractionUserId(interaction);
  if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");

  const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
  const hasRole = owner || (await liveMemberHasDojoRole(interaction, discordUserId, env));
  if (!hasRole) {
    return ephemeralMessage(
      `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
    );
  }
  if (!env.RR_TRACKER) return ephemeralMessage("The RR tracker service is not connected yet.");

  ctx.waitUntil(
    withTimeout(runPublicRrCommand(interaction.data?.name, discordUserId, env), COMMAND_TIMEOUT_MS)
      .then((payload) => editOriginalInteraction(interaction, env, payload))
      .catch(async (error) => {
        console.error("Public RR command failed:", error);
        await editOriginalInteraction(interaction, env, {
          content:
            error?.message === "COMMAND_TIMEOUT"
              ? "That took too long to finish. Try the command again in a moment."
              : "Something went wrong while running that command. Try again in a moment.",
        });
      }),
  );

  return Response.json({ type: 5, data: {} });
}

async function runPublicRrCommand(commandName, discordUserId, env) {
  if (commandName === "sync") {
    const result = await env.RR_TRACKER.syncDiscordUser(discordUserId);
    return buildSyncPayload(result);
  }
  if (commandName === "rr") {
    const result = await env.RR_TRACKER.getDiscordUserStatsDetailed(discordUserId);
    return buildRrPayload(result);
  }
  if (commandName === "rrleaderboard") {
    const result = await env.RR_TRACKER.getLeaderboard(10);
    return buildLeaderboardPayload(result);
  }
  return { content: "Unknown command." };
}

async function handleVerifyInteraction(interaction, env, ctx) {
  if (interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return ephemeralMessage("This command only works in the Slayerkey Discord server.");
  }
  const discordUserId = getInteractionUserId(interaction);
  if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");

  ctx.waitUntil(
    withTimeout(verifyDiscordUser(discordUserId, env), COMMAND_TIMEOUT_MS)
      .then((message) => editOriginalInteraction(interaction, env, { content: message }))
      .catch(async (error) => {
        console.error("Verify command failed:", error);
        await editOriginalInteraction(interaction, env, {
          content: "Verification took too long or hit an error. Try **/verify** again in a moment.",
        });
      }),
  );
  return Response.json({ type: 5, data: { flags: EPHEMERAL } });
}

async function handleVerifyAllInteraction(interaction, env, ctx) {
  const discordUserId = getInteractionUserId(interaction);
  if (discordUserId !== String(env.DISCORD_OWNER_USER_ID || "")) {
    return ephemeralMessage("This command is owner only.");
  }

  ctx.waitUntil(
    runVerificationAudit(env)
      .then((report) => editOriginalInteraction(interaction, env, { content: formatVerificationAudit(report) }))
      .catch(async (error) => {
        console.error("Verification audit failed:", error);
        await editOriginalInteraction(interaction, env, {
          content: `Verification audit failed: ${String(error).slice(0, 1200)}`,
        });
      }),
  );
  return Response.json({ type: 5, data: { flags: EPHEMERAL } });
}

async function verifyDiscordUser(discordUserId, env) {
  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(discordUserId, null, env, "Dojo owner verification");
    return "Verified as the Dojo owner. Your Training Dojo role is active.";
  }

  if (env.MEMBER_LINKS) {
    const manual = await env.MEMBER_LINKS.get(`manual:${discordUserId}`, "json").catch(() => null);
    if (manual) {
      await grantDojoRole(discordUserId, null, env, "Manual Dojo verification");
      return "Your manual Dojo verification is active.";
    }
  }

  const match = await findActiveWhopMembershipForDiscord(discordUserId, env);
  if (match) {
    await grantDojoRole(discordUserId, match.userId, env, "Active Training Dojo membership");
    return "Verified. Your Training Dojo role is active.";
  }

  return (
    "I could not match this Discord account to an active Training Dojo membership yet.\n\n" +
    `Make sure **this same Discord account** is linked on Whop: [Connect Discord to Whop](${WHOP_CONNECTED_ACCOUNTS_URL})\n\n` +
    "Then run **/verify** again."
  );
}

async function runVerificationAudit(env) {
  const active = await getActiveDojoMemberships(env);
  const activeUserIds = new Set(active.map((item) => String(item.user?.id || "")).filter(Boolean));
  const report = {
    active_memberships: active.length,
    discord_linked: 0,
    cached_for_join: 0,
    in_server: 0,
    already_had_role: 0,
    roles_added: 0,
    no_discord_link: 0,
    not_in_server: 0,
    lookup_errors: 0,
    role_errors: 0,
    stale_roles_removed: 0,
  };

  for (let i = 0; i < active.length; i += 8) {
    const batch = active.slice(i, i + 8);
    await Promise.all(batch.map(async (membership) => {
      const userId = String(membership?.user?.id || "");
      if (!userId) return;

      let discordId;
      try {
        discordId = await resolveDiscordIdForWhopUser(userId, env, { preferCache: false });
      } catch (error) {
        report.lookup_errors += 1;
        console.warn(`Discord lookup failed for ${userId}:`, error);
        return;
      }

      if (!discordId) {
        report.no_discord_link += 1;
        return;
      }

      report.discord_linked += 1;
      await storeMemberLink(userId, discordId, env, false);
      report.cached_for_join += 1;

      const member = await fetchDiscordMember(discordId, env);
      if (member.status === 404) {
        report.not_in_server += 1;
        return;
      }
      if (!member.ok) {
        report.role_errors += 1;
        return;
      }

      report.in_server += 1;
      const hasRole = Array.isArray(member.data?.roles) &&
        member.data.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));

      if (hasRole) {
        report.already_had_role += 1;
        if (env.RR_TRACKER) {
          await env.RR_TRACKER.setMemberActive(discordId, true).catch(() => {});
        }
        return;
      }

      try {
        await grantDojoRole(discordId, userId, env, "Dojo verification audit");
        report.roles_added += 1;
      } catch {
        report.role_errors += 1;
      }
    }));
  }

  if (env.MEMBER_LINKS) {
    let cursor;
    do {
      const listed = await env.MEMBER_LINKS.list({ prefix: "whop:", cursor });
      for (const key of listed.keys || []) {
        const userId = key.name.slice("whop:".length);
        if (!userId || activeUserIds.has(userId)) continue;
        const stored = await env.MEMBER_LINKS.get(key.name, "json").catch(() => null);
        const discordId = stored?.discord_user_id;
        if (!discordId) continue;
        const manual = await env.MEMBER_LINKS.get(`manual:${discordId}`, "json").catch(() => null);
        if (manual) continue;

        const response = await changeDiscordRole(discordId, false, env);
        if (response.ok || response.status === 404) {
          report.stale_roles_removed += 1;
          if (env.RR_TRACKER) {
            await env.RR_TRACKER.setMemberActive(discordId, false).catch(() => {});
          }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }

  return report;
}

function formatVerificationAudit(report) {
  return (
    "**Dojo verification audit**\n" +
    `Active Whop memberships: **${report.active_memberships}**\n` +
    `Discord linked on Whop: **${report.discord_linked}**\n` +
    `Cached for instant join: **${report.cached_for_join}**\n` +
    `Already in server with role: **${report.already_had_role}**\n` +
    `Roles added now: **${report.roles_added}**\n` +
    `Linked but not in server yet: **${report.not_in_server}**\n` +
    `Missing Discord link on Whop: **${report.no_discord_link}**\n` +
    `Lookup errors: **${report.lookup_errors}** • Role errors: **${report.role_errors}**\n` +
    `Stale roles removed: **${report.stale_roles_removed}**`
  );
}

async function autoVerifyJoinedMember(discordUserId, env) {
  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(discordUserId, null, env, "Automatic owner verification on join");
    return { verified: true, reason: "owner" };
  }

  if (env.MEMBER_LINKS) {
    const manual = await env.MEMBER_LINKS.get(`manual:${discordUserId}`, "json").catch(() => null);
    if (manual) {
      await grantDojoRole(discordUserId, null, env, "Automatic manual verification on join");
      return { verified: true, reason: "manual_override" };
    }
  }

  const match = await findActiveWhopMembershipForDiscord(discordUserId, env);
  if (!match) return { verified: false, reason: "no_active_membership" };

  await grantDojoRole(discordUserId, match.userId, env, "Automatic Dojo verification on server join");
  return { verified: true, reason: match.source || "whop_match" };
}

async function findActiveWhopMembershipForDiscord(discordUserId, env) {
  const active = await getActiveDojoMemberships(env);

  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
    if (reverse?.whop_user_id) {
      const found = active.find(
        (membership) => String(membership?.user?.id || "") === String(reverse.whop_user_id),
      );
      if (found) return { userId: String(reverse.whop_user_id), source: "cached_reverse_link" };
    }
  }

  for (let i = 0; i < active.length; i += 8) {
    const batch = active.slice(i, i + 8);
    const matches = await Promise.all(batch.map(async (membership) => {
      const userId = String(membership?.user?.id || "");
      if (!userId) return null;
      try {
        const foundDiscord = await resolveDiscordIdForWhopUser(userId, env);
        if (foundDiscord && env.MEMBER_LINKS) {
          await storeMemberLink(userId, foundDiscord, env, false);
        }
        return foundDiscord === discordUserId ? { userId, source: "live_whop_social_account" } : null;
      } catch {
        return null;
      }
    }));
    const match = matches.find(Boolean);
    if (match) return match;
  }

  return null;
}

async function getActiveDojoMemberships(env) {
  const memberships = await fetchAllCompanyMemberships(env);
  const byUser = new Map();
  for (const membership of memberships) {
    const userId = String(membership?.user?.id || "");
    if (!userId) continue;
    if (membership?.product?.id !== env.WHOP_PRODUCT_ID) continue;
    if (!ACCESS_STATUSES.has(membership.status)) continue;
    if (!byUser.has(userId)) byUser.set(userId, membership);
  }
  return [...byUser.values()];
}

async function fetchAllCompanyMemberships(env) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams();
    params.set("company_id", env.WHOP_COMPANY_ID);
    params.set("first", "100");
    if (after) params.set("after", after);

    const page = await whopGet(`/memberships?${params.toString()}`, env);
    if (Array.isArray(page.data)) all.push(...page.data);
    const info = page.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function resolveDiscordIdForWhopUser(userId, env, { preferCache = true } = {}) {
  if (preferCache && env.MEMBER_LINKS) {
    const cached = await env.MEMBER_LINKS.get(`whop:${userId}`, "json").catch(() => null);
    if (cached?.discord_user_id) return String(cached.discord_user_id);
  }

  const headers = { Authorization: `Bearer ${env.WHOP_API_KEY}` };
  const socialUrls = [
    `https://api.whop.com/api/v5/company/users/${encodeURIComponent(userId)}/social_accounts`,
    `https://api.whop.com/v5/company/users/${encodeURIComponent(userId)}/social_accounts`,
  ];

  for (const url of socialUrls) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) continue;
      const body = await response.json();
      const accounts = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      const discord = accounts.find(
        (account) => account?.service === "discord" && account?.account_id,
      );
      if (discord) return String(discord.account_id);
    } catch {}
  }

  // Compatibility fallback for older Whop user responses.
  try {
    const user = await whopGet(`/users/${encodeURIComponent(userId)}`, env);
    const accounts = Array.isArray(user?.social_accounts) ? user.social_accounts : [];
    const discord = accounts.find(
      (account) =>
        (account?.platform === "discord" || account?.service === "discord") &&
        (account?.external_id || account?.account_id),
    );
    if (discord) return String(discord.external_id || discord.account_id);
  } catch {}

  return null;
}

async function cacheDiscordLinkFromWhopWebhook(request, env) {
  let event;
  try {
    event = await request.json();
  } catch {
    return;
  }
  if (event.type !== "membership.activated" && event.type !== "membership.deactivated") return;

  const companyId = event.company_id || event.data?.company?.id;
  const productId = event.data?.product?.id;
  const userId = event.data?.user?.id;
  if (companyId !== env.WHOP_COMPANY_ID || productId !== env.WHOP_PRODUCT_ID || !userId) return;

  try {
    const discordId = await resolveDiscordIdForWhopUser(userId, env, { preferCache: false });
    if (discordId && env.MEMBER_LINKS) {
      await storeMemberLink(userId, discordId, env, false);
    }
  } catch (error) {
    console.warn("Could not cache Whop Discord link:", error);
  }
}

async function grantDojoRole(discordUserId, whopUserId, env, reason) {
  const result = await changeDiscordRole(discordUserId, true, env, reason);
  if (!result.ok) {
    throw new Error(`Discord role add failed ${result.status}: ${result.body || ""}`);
  }
  if (whopUserId && env.MEMBER_LINKS) {
    await storeMemberLink(whopUserId, discordUserId, env, true);
  }
  if (env.RR_TRACKER) {
    await env.RR_TRACKER.setMemberActive(discordUserId, true).catch(() => {});
  }
}

async function changeDiscordRole(discordUserId, add, env, reason = "Training Dojo membership sync") {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: add ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": reason,
      },
    },
  );
  return {
    ok: response.status === 204,
    status: response.status,
    body: response.status === 204 ? "" : await response.text(),
  };
}

async function fetchDiscordMember(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? await response.json() : null,
  };
}

async function storeMemberLink(userId, discordId, env, granted) {
  if (!env.MEMBER_LINKS) return;
  const timestamp = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${userId}`,
      JSON.stringify({
        discord_user_id: String(discordId),
        updated_at: timestamp,
        ...(granted ? { last_granted_at: timestamp } : {}),
      }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({ whop_user_id: String(userId), updated_at: timestamp }),
    ),
  ]);
}

async function buildSyncPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    if (result?.code === "RATE_LIMITED") {
      return { content: `The Riot tracker is rate limited right now. Try **/sync** again in about ${result.retry_after || "60"} seconds.` };
    }
    return { content: result?.message || "I could not sync your Riot account." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const imported = Number(result.new_matches_imported || 0);
  const warning = historyWarning(result);
  return {
    embeds: [cleanEmbed({
      title: `Synced • ${result.riot_id}`,
      description: imported
        ? `Found **${imported} new ${imported === 1 ? "game" : "games"}**.`
        : "No new ranked games were found.",
      thumbnail: icon,
      fields: [
        {
          name: "Since last sync",
          value: `**${signedNumber(result.sync_rr_change || 0)} RR**\n${imported} new ${imported === 1 ? "game" : "games"}`,
          inline: true,
        },
        {
          name: "Current rank",
          value: formatRank(result.current_rank, result.current_rr),
          inline: true,
        },
        {
          name: result.month || "This month",
          value: `**${signedNumber(result.monthly_rr)} RR**\n${result.games_counted || 0} games`,
          inline: true,
        },
      ],
      footer: warning,
    })],
  };
}

async function buildRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    return { content: result?.message || "I could not load your RR stats." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const leaderboard = result.leaderboard_position
    ? `**#${result.leaderboard_position}**${result.leaderboard_count ? ` of ${result.leaderboard_count}` : ""}`
    : "Not ranked yet";
  const lastSync = result.last_sync
    ? `**${signedNumber(result.last_sync.rr_delta)} RR** • ${result.last_sync.new_matches} new ${result.last_sync.new_matches === 1 ? "game" : "games"}${formatRelativeTime(result.last_sync.synced_at)}`
    : "No manual sync yet";

  return {
    embeds: [cleanEmbed({
      title: `${result.riot_id} • RR Tracker`,
      description: `### ${formatRank(result.current_rank, result.current_rr)}`,
      thumbnail: icon,
      fields: [
        {
          name: "Last 12 hours",
          value: `**${signedNumber(result.recent_12h_rr)} RR**\n${result.recent_12h_games || 0} games`,
          inline: true,
        },
        {
          name: result.month || "This month",
          value: `**${signedNumber(result.monthly_rr)} RR**\n${result.games_counted || 0} games`,
          inline: true,
        },
        { name: "Leaderboard", value: leaderboard, inline: true },
        {
          name: "Start rank",
          value: result.start_rank ? formatRank(result.start_rank, result.start_rr) : "Not recorded yet",
          inline: true,
        },
        {
          name: "Streak",
          value: result.current_streak
            ? `🔥 **${result.current_streak} day${result.current_streak === 1 ? "" : "s"}**`
            : "No active streak",
          inline: true,
        },
        {
          name: "Activity",
          value: `**${result.active_days || 0} active days**\n${result.tracking_days || 0} days tracked`,
          inline: true,
        },
        { name: "Last sync", value: lastSync, inline: false },
        { name: "Monthly activity", value: formatHeatmap(result.activity || []), inline: false },
      ],
      footer: historyWarning(result),
    })],
  };
}

async function buildLeaderboardPayload(result) {
  if (!result?.ok) return { content: result?.message || "I could not load the RR leaderboard." };
  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!entries.length) return { content: `No linked Dojo players are on the ${result.month} leaderboard yet.` };

  const medals = ["🥇", "🥈", "🥉"];
  const lines = entries.map((entry, index) => {
    const lead = medals[index] || `**${index + 1}.**`;
    const warning = entry.history_complete ? "" : " ⚠️";
    return (
      `${lead} <@${entry.discord_user_id}> • **${signedNumber(entry.monthly_rr)} RR**${warning}\n` +
      `${entry.current_rank || "Unranked"}${entry.current_rr == null ? "" : ` • ${entry.current_rr} RR`} • ${entry.games_counted} games`
    );
  });
  const marked = entries.some((entry) => !entry.history_complete);
  const icon = await getRankIconUrl(entries[0]?.current_rank);

  return {
    embeds: [cleanEmbed({
      title: `🏆 ${result.month} RR Leaderboard`,
      description: lines.join("\n\n"),
      thumbnail: icon,
      footer: marked
        ? "⚠️ Marked players do not have the full month tracked, so earlier games may be missing."
        : null,
    })],
  };
}

function historyWarning(result) {
  if (result?.history_complete) return null;
  const value = result?.history_start_at || result?.first_tracked_at;
  const date = parseDate(value);
  if (!date) return "⚠️ Earlier games from this month may not be included.";
  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `⚠️ This tracker only has games from ${label} onward, so earlier games this month may not be included.`;
}

function cleanEmbed({ title, description, thumbnail, fields = [], footer }) {
  const embed = { color: VALORANT_RED, title, description, fields };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: footer };
  return embed;
}

function formatHeatmap(activity) {
  if (!Array.isArray(activity) || !activity.length) return "No activity yet.";
  const today = new Date().getUTCDate();
  const symbols = activity.map((entry) => {
    if (entry.day > today) return "▫️";
    const games = Number(entry.games || 0);
    if (games === 0) return "⬛";
    if (games === 1) return "🟥";
    if (games <= 3) return "🟧";
    return "🟨";
  });
  const rows = [];
  for (let i = 0; i < symbols.length; i += 7) rows.push(symbols.slice(i, i + 7).join(""));
  return `${rows.join("\n")}\n⬛ 0  🟥 1  🟧 2–3  🟨 4+  ▫️ upcoming`;
}

async function liveMemberHasDojoRole(interaction, discordUserId, env) {
  const member = await fetchDiscordMember(discordUserId, env).catch(() => null);
  if (member?.ok) {
    return Array.isArray(member.data?.roles) &&
      member.data.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
  }
  const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.map(String) : [];
  return roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}

async function ensureGateway(env) {
  if (!env.DISCORD_GATEWAY) return { configured: false };
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");
  return stub.ensureConnected();
}

async function whopGet(path, env) {
  const response = await fetch(`${WHOP_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.WHOP_API_KEY}`,
      "Api-Version-Date": WHOP_API_VERSION_DATE,
    },
  });
  if (!response.ok) throw new Error(`Whop API ${response.status}: ${await response.text()}`);
  return response.json();
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank} • ${rr} RR`;
}

function signedNumber(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function formatRelativeTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  return ` • <t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = typeof payload === "string" ? { content: payload } : { ...(payload || { content: "Done." }) };
  body.allowed_mentions = { parse: [] };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    console.error("Could not edit Discord interaction response:", response.status, await response.text());
  }
}

async function getRankIconUrl(rankName) {
  if (!rankName) return null;
  const cacheKey = "__dojoValorantRankIconsV5";
  const cacheTimeKey = "__dojoValorantRankIconsV5At";
  const cached = globalThis[cacheKey];
  const cachedAt = Number(globalThis[cacheTimeKey] || 0);
  if (cached && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
    return cached.get(String(rankName).toLowerCase()) || null;
  }

  try {
    const response = await withTimeout(fetch("https://valorant-api.com/v1/competitivetiers"), 1800);
    if (!response.ok) return null;
    const body = await response.json();
    const icons = new Map();
    for (const tierSet of Array.isArray(body?.data) ? body.data : []) {
      for (const tier of Array.isArray(tierSet?.tiers) ? tierSet.tiers : []) {
        if (tier?.tierName && (tier?.largeIcon || tier?.smallIcon)) {
          icons.set(String(tier.tierName).toLowerCase(), String(tier.largeIcon || tier.smallIcon));
        }
      }
    }
    globalThis[cacheKey] = icons;
    globalThis[cacheTimeKey] = Date.now();
    return icons.get(String(rankName).toLowerCase()) || null;
  } catch {
    return null;
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
    return await crypto.subtle.verify(
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
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), ms)),
  ]);
}
