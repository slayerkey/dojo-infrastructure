import legacy, { DiscordGateway as DiscordGatewayV11 } from "./index-v11.js";

const VERIFY_CHANNEL_ID = "1497054385908220036";
const VERIFY_MESSAGE_ID = "1497057798989811792";
const VERIFY_EMOJI = "🔑";
const GATEWAY_INTENTS = 1 | 2 | 1024;
const GATEWAY_INTENT_VERSION = "members-and-reactions-v12";

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
          emoji: VERIFY_EMOJI,
          cooldown_seconds: 5,
        };
        body.discord.gateway_intents_expected = GATEWAY_INTENTS;
        body.discord.gateway_intent_version = GATEWAY_INTENT_VERSION;
        body.discord.whop_product_id = env.WHOP_PRODUCT_ID || null;
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
    // Calling the gateway once per cron also guarantees a fresh Identify after
    // an intent-version change instead of silently resuming an older session.
    if (env.DISCORD_GATEWAY) {
      ctx.waitUntil(
        env.DISCORD_GATEWAY.getByName("dojo-main").ensureConnected().catch((error) => {
          console.error("Gateway keepalive failed:", error);
        }),
      );
    }
  },
};

export class DiscordGateway extends DiscordGatewayV11 {
  constructor(ctx, env) {
    super(ctx, env);
    this.intentRefreshPromise = null;
  }

  async ensureConnected() {
    await this.ensureCurrentIntentSession();
    return super.ensureConnected();
  }

  async status() {
    const base = await super.status();
    const storedVersion = await this.ctx.storage.get("gateway_intent_version").catch(() => null);
    return {
      ...base,
      expected_intents: GATEWAY_INTENTS,
      intent_version: storedVersion || null,
      verification_reaction_emoji: VERIFY_EMOJI,
    };
  }

  async ensureCurrentIntentSession() {
    if (this.intentRefreshPromise) return this.intentRefreshPromise;

    this.intentRefreshPromise = (async () => {
      const current = await this.ctx.storage.get("gateway_intent_version").catch(() => null);
      if (current === GATEWAY_INTENT_VERSION) return;

      // Discord only negotiates intents on IDENTIFY. RESUME keeps the old
      // session's intent set, so force one clean reconnect when the desired
      // intents change.
      this.sessionId = null;
      this.sequence = null;
      this.ready = false;

      const ws = this.ws;
      this.ws = null;
      this.clearHeartbeat?.();
      this.clearReconnect?.();
      try {
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
          ws.close(4000, "Refresh Gateway intents");
        }
      } catch {}

      await this.ctx.storage.put("gateway_intent_version", GATEWAY_INTENT_VERSION);
    })();

    try {
      await this.intentRefreshPromise;
    } finally {
      this.intentRefreshPromise = null;
    }
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
      String(payload.d?.message_id || "") === VERIFY_MESSAGE_ID &&
      String(payload.d?.emoji?.name || "") !== VERIFY_EMOJI
    ) {
      // Only the key reaction is a verification action.
      return;
    }

    return super.handleGatewayMessage(raw);
  }
}
