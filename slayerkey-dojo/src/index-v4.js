import legacy from "./index-v3.js";
import { DurableObject } from "cloudflare:workers";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "https://gateway.discord.gg/?v=10&encoding=json";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_API_VERSION_DATE = "2026-08-13";
const COMMANDS_VERSION = "2026-08-21-v4";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const COMMAND_TIMEOUT_MS = 15000;
const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const PUBLIC_RR_COMMANDS = new Set(["rr", "rrleaderboard"]);
const encoder = new TextEncoder();

const GUILD_COMMANDS = [
  {
    name: "verify",
    description: "Verify your active Slayerkey Training Dojo membership",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "verify-all",
    description: "Owner only: reconcile all Dojo membership roles",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "manualverify",
    description: "Owner only: temporarily verify a Discord member for Dojo access",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "user",
        description: "Discord member to verify",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "manualunverify",
    description: "Owner only: remove a manual Dojo verification",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "user",
        description: "Discord member to remove manual verification from",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "linkriot",
    description: "Link your Riot account to the Dojo RR tracker",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "name",
        description: "Your Riot name",
        type: 3,
        required: true,
      },
      {
        name: "tag",
        description: "Your Riot tag without the #",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "sync",
    description: "Sync your latest Valorant ranked RR after you finish playing",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "rr",
    description: "Show your current rank, recent RR, streak, and monthly activity",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "rrleaderboard",
    description: "Show the Dojo monthly RR leaderboard",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
];

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
      if (!valid) {
        return new Response("Invalid request signature", { status: 401 });
      }

      let interaction;
      try {
        interaction = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (interaction.type === 1) {
        ctx.waitUntil(ensureCommandsV4(env));
        return legacy.fetch(delegatedRequest, env, ctx);
      }

      const commandName = interaction.data?.name;
      if (interaction.type === 2 && PUBLIC_RR_COMMANDS.has(commandName)) {
        return handlePublicRrInteraction(interaction, env, ctx);
      }

      return legacy.fetch(delegatedRequest, env, ctx);
    }

    if (url.pathname === "/health") {
      await Promise.allSettled([
        ensureCommandsV4(env),
        ensureGateway(env),
      ]);

      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        const commandMarker = env.MEMBER_LINKS
          ? await env.MEMBER_LINKS.get("discord:commands_v4_version")
          : null;

        body.discord = body.discord || {};
        body.discord.commands_v4_registered = commandMarker === COMMANDS_VERSION;
        body.discord.commands_v4_version = commandMarker;

        if (env.DISCORD_GATEWAY) {
          try {
            const stub = env.DISCORD_GATEWAY.getByName("dojo-main");
            body.discord.gateway = await stub.status();
          } catch (error) {
            body.discord.gateway = { connected: false, error: String(error) };
          }
        } else {
          body.discord.gateway = { connected: false, configured: false };
        }

        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      const webhookCopy = request.clone();
      const response = await legacy.fetch(request, env, ctx);
      if (response.ok) {
        ctx.waitUntil(cacheDiscordLinkFromAcceptedWhopWebhook(webhookCopy, env));
      }
      return response;
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureGateway(env).catch((error) => {
      console.error("Scheduled Gateway ensure failed:", error);
    }));

    ctx.waitUntil(ensureCommandsV4(env).catch((error) => {
      console.error("Scheduled command registration failed:", error);
    }));

    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    if (minute % 15 === 0 && typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

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
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
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
      if (String(member.guild_id || "") !== String(this.env.DISCORD_GUILD_ID || "")) {
        return;
      }
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
    const firstDelay = Math.floor(Math.random() * Math.max(interval, 1));
    this.heartbeatTimer = setTimeout(() => this.sendHeartbeat(true), firstDelay);
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

  const discordUserId = String(
    interaction.member?.user?.id || interaction.user?.id || "",
  );
  if (!discordUserId) {
    return ephemeralMessage("I could not determine your Discord user ID.");
  }

  const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
  const hasRole = owner || (await liveMemberHasDojoRole(interaction, discordUserId, env));
  if (!hasRole) {
    const roleMention = env.DISCORD_DOJO_ROLE_ID
      ? `<@&${env.DISCORD_DOJO_ROLE_ID}>`
      : "the Training Dojo role";
    return ephemeralMessage(
      `You need ${roleMention} to use the RR tracker. Run **/verify** first.`,
    );
  }

  if (!env.RR_TRACKER) {
    return ephemeralMessage("The RR tracker service is not connected yet.");
  }

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

  // No EPHEMERAL flag here. /rr and /rrleaderboard are intentionally public.
  return Response.json({ type: 5, data: {} });
}

async function runPublicRrCommand(commandName, discordUserId, env) {
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

async function buildRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    }
    return { content: result?.message || "I could not load your RR stats." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const heatmap = formatHeatmap(result.activity || []);
  const lastSync = result.last_sync
    ? `**${signedNumber(result.last_sync.rr_delta)} RR** • ${result.last_sync.new_matches} new ${result.last_sync.new_matches === 1 ? "game" : "games"}${formatRelativeTime(result.last_sync.synced_at)}`
    : "No manual sync yet";

  const leaderboard = result.leaderboard_position
    ? `**#${result.leaderboard_position}**${result.leaderboard_count ? ` of ${result.leaderboard_count}` : ""}`
    : "Not ranked yet";

  const footer = result.history_complete
    ? "Run /sync after your ranked session to keep your stats current."
    : `${historyExplanation(result)} Run /sync after your ranked session.`;

  return {
    embeds: [
      cleanEmbed({
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
          {
            name: "Leaderboard",
            value: leaderboard,
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
          {
            name: "Last sync",
            value: lastSync,
            inline: true,
          },
          {
            name: "Monthly activity",
            value: heatmap,
            inline: false,
          },
        ],
        footer,
      }),
    ],
  };
}

async function buildLeaderboardPayload(result) {
  if (!result?.ok) {
    return { content: result?.message || "I could not load the RR leaderboard." };
  }

  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!entries.length) {
    return { content: `No linked Dojo players are on the ${result.month} leaderboard yet.` };
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = entries.map((entry, index) => {
    const lead = medals[index] || `**${index + 1}.**`;
    const rank = entry.current_rank || "Unranked";
    return `${lead} <@${entry.discord_user_id}>  **${signedNumber(entry.monthly_rr)} RR**\n└ ${rank}${entry.current_rr == null ? "" : ` • ${entry.current_rr} RR`} • ${entry.games_counted} games`;
  });

  const topIcon = await getRankIconUrl(entries[0]?.current_rank);
  const incompleteCount = entries.filter((entry) => !entry.history_complete).length;

  return {
    embeds: [
      cleanEmbed({
        title: `🏆 ${result.month} RR Leaderboard`,
        description: lines.join("\n\n"),
        thumbnail: topIcon,
        footer: incompleteCount
          ? `${incompleteCount} player${incompleteCount === 1 ? " has" : "s have"} tracking that begins after the start of the month.`
          : "Net ranked RR from tracked games.",
      }),
    ],
  };
}

function historyExplanation(result) {
  const value = result.history_start_at || result.first_tracked_at;
  if (!value) {
    return "Earlier games from this month may not be included yet.";
  }

  const date = parseDate(value);
  if (!date) {
    return "Earlier games from this month may not be included yet.";
  }

  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Tracked match history currently reaches back to **${label}**, so games before that may not be included.`;
}

function cleanEmbed({ title, description, thumbnail, fields = [], footer }) {
  const embed = {
    color: VALORANT_RED,
    title,
    description,
    fields,
    timestamp: new Date().toISOString(),
  };
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
  for (let i = 0; i < symbols.length; i += 7) {
    rows.push(symbols.slice(i, i + 7).join(""));
  }

  return `${rows.join("\n")}\n⬛ 0  🟥 1  🟧 2–3  🟨 4+  ▫️ upcoming`;
}

async function liveMemberHasDojoRole(interaction, discordUserId, env) {
  try {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
    );
    if (response.ok) {
      const member = await response.json();
      return Array.isArray(member.roles) &&
        member.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
    }
  } catch (error) {
    console.warn("Live Discord role lookup failed:", error);
  }

  const fallbackRoles = Array.isArray(interaction.member?.roles)
    ? interaction.member.roles.map(String)
    : [];
  return fallbackRoles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}

async function ensureCommandsV4(env) {
  if (!env.MEMBER_LINKS) return { ok: false, reason: "no_kv" };
  const current = await env.MEMBER_LINKS.get("discord:commands_v4_version");
  if (current === COMMANDS_VERSION) return { ok: true, changed: false };

  const response = await fetch(
    `${DISCORD_API}/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(GUILD_COMMANDS),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord command refresh ${response.status}: ${await response.text()}`);
  }

  await env.MEMBER_LINKS.put("discord:commands_v4_version", COMMANDS_VERSION);
  return { ok: true, changed: true };
}

async function ensureGateway(env) {
  if (!env.DISCORD_GATEWAY) return { configured: false };
  const stub = env.DISCORD_GATEWAY.getByName("dojo-main");
  return stub.ensureConnected();
}

async function cacheDiscordLinkFromAcceptedWhopWebhook(request, env) {
  let event;
  try {
    event = await request.json();
  } catch {
    return;
  }

  if (event.type !== "membership.activated" && event.type !== "membership.deactivated") {
    return;
  }

  const companyId = event.company_id || event.data?.company?.id;
  const productId = event.data?.product?.id;
  const userId = event.data?.user?.id;
  if (
    companyId !== env.WHOP_COMPANY_ID ||
    productId !== env.WHOP_PRODUCT_ID ||
    !userId ||
    !env.MEMBER_LINKS
  ) {
    return;
  }

  try {
    const discordId = await getDiscordIdFromWhop(userId, env);
    if (discordId) {
      await storeMemberLink(userId, discordId, env, false);
    }
  } catch (error) {
    console.warn("Could not pre-cache Discord link from Whop webhook:", error);
  }
}

async function autoVerifyJoinedMember(discordUserId, env) {
  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantJoinedMember(discordUserId, null, env);
    return { verified: true, reason: "owner" };
  }

  if (env.MEMBER_LINKS) {
    const manual = await env.MEMBER_LINKS.get(`manual:${discordUserId}`, "json").catch(() => null);
    if (manual) {
      await grantJoinedMember(discordUserId, null, env);
      return { verified: true, reason: "manual_override" };
    }
  }

  const memberships = await fetchAllCompanyMemberships(env);
  const active = memberships.filter(
    (membership) =>
      membership?.product?.id === env.WHOP_PRODUCT_ID &&
      ACCESS_STATUSES.has(membership.status),
  );

  const cachedDiscord = env.MEMBER_LINKS
    ? await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null)
    : null;

  if (cachedDiscord?.whop_user_id) {
    const membership = active.find(
      (item) => String(item?.user?.id || "") === String(cachedDiscord.whop_user_id),
    );
    if (membership) {
      await grantJoinedMember(discordUserId, cachedDiscord.whop_user_id, env);
      return { verified: true, reason: "cached_whop_link" };
    }
  }

  // First use any mappings we already know from webhooks/reconciliation.
  for (const membership of active) {
    const userId = membership?.user?.id;
    if (!userId || !env.MEMBER_LINKS) continue;
    const stored = await env.MEMBER_LINKS.get(`whop:${userId}`, "json").catch(() => null);
    if (String(stored?.discord_user_id || "") === discordUserId) {
      await grantJoinedMember(discordUserId, userId, env);
      return { verified: true, reason: "cached_membership_scan" };
    }
  }

  // Last-resort live lookup. This handles someone connecting Discord to Whop and
  // joining the server before the mapping has ever been cached.
  for (let i = 0; i < active.length; i += 10) {
    const batch = active.slice(i, i + 10);
    const resolved = await Promise.all(
      batch.map(async (membership) => {
        const userId = membership?.user?.id;
        if (!userId) return null;
        try {
          const foundDiscord = await getDiscordIdFromWhop(userId, env);
          if (foundDiscord && env.MEMBER_LINKS) {
            await storeMemberLink(userId, foundDiscord, env, false);
          }
          return foundDiscord === discordUserId ? userId : null;
        } catch {
          return null;
        }
      }),
    );

    const userId = resolved.find(Boolean);
    if (userId) {
      await grantJoinedMember(discordUserId, userId, env);
      return { verified: true, reason: "live_whop_lookup" };
    }
  }

  return { verified: false, reason: "no_active_membership" };
}

async function grantJoinedMember(discordUserId, whopUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": "Automatic Dojo verification on server join",
      },
    },
  );

  if (response.status !== 204) {
    throw new Error(`Discord role add failed ${response.status}: ${await response.text()}`);
  }

  if (whopUserId && env.MEMBER_LINKS) {
    await storeMemberLink(whopUserId, discordUserId, env, true);
  }

  if (env.RR_TRACKER) {
    try {
      await env.RR_TRACKER.setMemberActive(discordUserId, true);
    } catch (error) {
      console.warn("Could not mark joined member active in RR tracker:", error);
    }
  }
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

async function getDiscordIdFromWhop(userId, env) {
  const user = await whopGet(`/users/${encodeURIComponent(userId)}`, env);
  const accounts = Array.isArray(user.social_accounts) ? user.social_accounts : [];
  const discord = accounts.find(
    (account) => account.platform === "discord" && account.external_id,
  );
  return discord ? String(discord.external_id) : null;
}

async function whopGet(path, env) {
  const response = await fetch(`${WHOP_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.WHOP_API_KEY}`,
      "Api-Version-Date": WHOP_API_VERSION_DATE,
    },
  });
  if (!response.ok) {
    throw new Error(`Whop API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function storeMemberLink(userId, discordId, env, granted) {
  const timestamp = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${userId}`,
      JSON.stringify({
        discord_user_id: String(discordId),
        ...(granted ? { last_granted_at: timestamp } : {}),
      }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({ whop_user_id: String(userId), updated_at: timestamp }),
    ),
  ]);
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = typeof payload === "string"
    ? { content: payload }
    : { ...(payload || { content: "Done." }) };
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

async function getRankIconUrl(rankName) {
  if (!rankName) return null;

  const cacheKey = "__dojoValorantRankIconsV4";
  const cacheTimeKey = "__dojoValorantRankIconsV4At";
  const cached = globalThis[cacheKey];
  const cachedAt = Number(globalThis[cacheTimeKey] || 0);
  if (cached && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
    return cached.get(String(rankName).toLowerCase()) || null;
  }

  try {
    const response = await withTimeout(
      fetch("https://valorant-api.com/v1/competitivetiers"),
      1800,
    );
    if (!response.ok) return null;
    const body = await response.json();
    const icons = new Map();
    for (const tierSet of Array.isArray(body?.data) ? body.data : []) {
      for (const tier of Array.isArray(tierSet?.tiers) ? tierSet.tiers : []) {
        if (tier?.tierName && (tier?.largeIcon || tier?.smallIcon)) {
          icons.set(
            String(tier.tierName).toLowerCase(),
            String(tier.largeIcon || tier.smallIcon),
          );
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
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), ms);
    }),
  ]);
}
