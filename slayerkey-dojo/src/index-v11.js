import legacy, { DiscordGateway as DiscordGatewayV10 } from "./index-v10.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_CONNECTED_ACCOUNTS_URL = "https://whop.com/@me/settings/connected-accounts/";
const VERIFY_CHANNEL_ID = "1497054385908220036";
const VERIFY_MESSAGE_ID = "1497057798989811792";
const VERIFY_REACTION_COOLDOWN_SECONDS = 5;
const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const GATEWAY_INTENTS = 1 | 2 | 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.reaction_verification = {
          enabled: true,
          channel_id: VERIFY_CHANNEL_ID,
          message_id: VERIFY_MESSAGE_ID,
          cooldown_seconds: VERIFY_REACTION_COOLDOWN_SECONDS,
        };
        if (env.DISCORD_GATEWAY) {
          const gateway = await env.DISCORD_GATEWAY.getByName("dojo-main").status().catch(() => null);
          if (gateway) body.discord.gateway = gateway;
        }
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

export class DiscordGateway extends DiscordGatewayV10 {
  constructor(ctx, env) {
    super(ctx, env);
    this.lastReactionVerification = null;
  }

  async status() {
    const base = await super.status();
    return {
      ...base,
      reaction_verification_enabled: true,
      last_reaction_verification: this.lastReactionVerification,
    };
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
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "slayerkey-dojo",
          device: "slayerkey-dojo",
        },
      },
    }));
  }

  async handleGatewayMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return super.handleGatewayMessage(raw);
    }

    if (
      payload.op === 0 &&
      payload.t === "MESSAGE_REACTION_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      String(payload.d?.channel_id || "") === VERIFY_CHANNEL_ID &&
      String(payload.d?.message_id || "") === VERIFY_MESSAGE_ID
    ) {
      if (payload.s != null) this.sequence = payload.s;
      this.lastEventAt = new Date().toISOString();

      const userId = String(payload.d?.user_id || "");
      if (!userId || payload.d?.member?.user?.bot) return;

      try {
        const result = await verifyDiscordReactionUser(userId, this.env);
        this.lastReactionVerification = {
          at: new Date().toISOString(),
          user_id: userId,
          verified: Boolean(result.verified),
          result: result.reason || (result.verified ? "verified" : "not_verified"),
        };

        if (!result.verified && result.reason !== "cooldown") {
          await sendVerificationDm(userId, this.env).catch(() => {});
        }
      } catch (error) {
        this.lastReactionVerification = {
          at: new Date().toISOString(),
          user_id: userId,
          verified: false,
          result: "error",
        };
        this.lastError = `Reaction verification failed: ${String(error)}`;
        console.error(this.lastError);
      }
      return;
    }

    return super.handleGatewayMessage(raw);
  }
}

async function verifyDiscordReactionUser(discordUserId, env) {
  if (await takeReactionCooldown(discordUserId, env)) {
    return { verified: false, reason: "cooldown" };
  }

  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(discordUserId, null, env, "Dojo reaction verification owner");
    return { verified: true, reason: "owner" };
  }

  const activeUsers = await getActiveDojoUsers(env);
  const activeIds = new Set(activeUsers.map((item) => String(item.userId)));

  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
    if (reverse?.whop_user_id && activeIds.has(String(reverse.whop_user_id))) {
      await grantDojoRole(
        discordUserId,
        String(reverse.whop_user_id),
        env,
        "Dojo reaction verification cached link",
      );
      return { verified: true, reason: "cached_whop_link" };
    }
  }

  const uncached = [];
  for (const item of activeUsers) {
    const userId = String(item.userId);
    const cached = env.MEMBER_LINKS
      ? await env.MEMBER_LINKS.get(`whop:${userId}`, "json").catch(() => null)
      : null;

    if (cached?.discord_user_id) {
      if (String(cached.discord_user_id) === discordUserId) {
        await storeMemberLink(userId, discordUserId, env);
        await grantDojoRole(discordUserId, userId, env, "Dojo reaction verification cached user");
        return { verified: true, reason: "cached_whop_user" };
      }
      continue;
    }
    uncached.push(userId);
  }

  for (let i = 0; i < uncached.length; i += 6) {
    const batch = uncached.slice(i, i + 6);
    const matches = await Promise.all(batch.map(async (userId) => {
      const found = await resolveDiscordIdForWhopUser(userId, env).catch(() => null);
      if (found && env.MEMBER_LINKS) await storeMemberLink(userId, found, env);
      return found === discordUserId ? userId : null;
    }));
    const match = matches.find(Boolean);
    if (match) {
      await grantDojoRole(discordUserId, match, env, "Dojo reaction verification live Whop link");
      return { verified: true, reason: "live_whop_link" };
    }
  }

  return { verified: false, reason: "no_active_whop_access" };
}

async function getActiveDojoUsers(env) {
  let after = null;
  const users = new Map();

  do {
    const params = new URLSearchParams();
    params.append("first", "100");
    params.append("company_id", env.WHOP_COMPANY_ID);
    params.append("product_ids", env.WHOP_PRODUCT_ID);
    if (after) params.append("after", after);

    const response = await fetch(`${WHOP_API}/memberships?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) throw new Error(`Whop memberships lookup ${response.status}`);

    const page = await response.json();
    for (const record of Array.isArray(page?.data) ? page.data : []) {
      const status = String(record?.status || record?.membership?.status || "");
      if (status && !ACCESS_STATUSES.has(status)) continue;
      const userId = String(
        record?.user?.id || record?.user_id || record?.membership?.user?.id || "",
      );
      if (userId && !users.has(userId)) users.set(userId, { userId });
    }

    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);

  return [...users.values()];
}

async function resolveDiscordIdForWhopUser(userId, env) {
  const response = await fetch(
    `https://api.whop.com/v5/company/users/${encodeURIComponent(userId)}/social_accounts`,
    { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
  );
  if (!response.ok) throw new Error(`Whop social lookup ${response.status}`);
  const body = await response.json();
  const accounts = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const discord = accounts.find(
    (account) => account?.service === "discord" && account?.account_id,
  );
  return discord ? String(discord.account_id) : null;
}

async function grantDojoRole(discordUserId, whopUserId, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": reason,
      },
    },
  );
  if (response.status !== 204) throw new Error(`Discord role add failed ${response.status}`);

  if (whopUserId && env.MEMBER_LINKS) await storeMemberLink(whopUserId, discordUserId, env);
  await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
}

async function storeMemberLink(userId, discordId, env) {
  if (!env.MEMBER_LINKS || !userId || !discordId) return;
  const now = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${userId}`,
      JSON.stringify({ discord_user_id: String(discordId), updated_at: now }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({ whop_user_id: String(userId), updated_at: now }),
    ),
  ]);
}

async function takeReactionCooldown(discordUserId, env) {
  if (!env.MEMBER_LINKS) return false;
  const key = `cooldown:reaction-verify:${discordUserId}`;
  const now = Date.now();
  const existing = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (existing > now) return true;
  await env.MEMBER_LINKS.put(key, String(now + VERIFY_REACTION_COOLDOWN_SECONDS * 1000), {
    expirationTtl: 60,
  });
  return false;
}

async function sendVerificationDm(discordUserId, env) {
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!channelResponse.ok) return;
  const channel = await channelResponse.json();
  if (!channel?.id) return;

  await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content:
        `I couldn't verify your Training Dojo access yet. Make sure this Discord account is linked on Whop, then remove and re-add your reaction:\n${WHOP_CONNECTED_ACCOUNTS_URL}`,
      allowed_mentions: { parse: [] },
    }),
  });
}
