import legacy, { DiscordGateway as DiscordGatewayV18 } from "./index-v18.js";

const VERIFY_CHANNEL_ID = "1497054385908220036";
const VERIFY_MESSAGE_ID = "1497057798989811792";
const VERIFY_EMOJI = "🔑";
const cooldownState = new Map();

export default {
  async fetch(request, env, ctx) {
    const safeEnv = kvSafeEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, safeEnv, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.kv_policy = {
          version: "v19",
          cooldowns: "memory-only",
          member_link_writes: "write-only-when-mapping-changes",
          gateway_uses_same_policy: true,
          verify_all_uses_same_policy: true,
          wrong_verify_emoji_ignored: true,
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, safeEnv, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, kvSafeEnv(env), ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV18 {
  constructor(ctx, env) {
    // The Durable Object is where member-join verification and /verify-all actually
    // run. Passing the same safe KV wrapper here closes the gap left by v16, which
    // only protected ordinary HTTP slash-command requests.
    super(ctx, kvSafeEnv(env));
  }

  async handleGatewayMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );
    } catch {
      return super.handleGatewayMessage(raw);
    }

    // v11 used to treat any reaction on the verification message as a verification
    // attempt. v13 correctly handles the key emoji, so swallow every other emoji
    // here before it can fall through to the legacy v11 handler and trigger a full
    // Whop/member scan plus KV cache churn.
    if (
      payload.op === 0 &&
      payload.t === "MESSAGE_REACTION_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      String(payload.d?.channel_id || "") === VERIFY_CHANNEL_ID &&
      String(payload.d?.message_id || "") === VERIFY_MESSAGE_ID &&
      String(payload.d?.emoji?.name || "") !== VERIFY_EMOJI
    ) {
      if (payload.s != null) this.sequence = payload.s;
      this.lastEventAt = new Date().toISOString();
      console.log(JSON.stringify({
        event: "verify_reaction_ignored",
        worker_version: "v19",
      }));
      return;
    }

    return super.handleGatewayMessage(raw);
  }
}

function kvSafeEnv(env) {
  if (!env?.MEMBER_LINKS) return env;

  const realKv = env.MEMBER_LINKS;
  const safeKv = new Proxy(realKv, {
    get(target, property) {
      if (property === "get") {
        return async (key, ...args) => {
          const textKey = String(key || "");
          if (textKey.startsWith("cooldown:")) {
            const item = cooldownState.get(textKey);
            if (!item) return null;
            if (item.expiresAt && item.expiresAt <= Date.now()) {
              cooldownState.delete(textKey);
              return null;
            }
            return item.value;
          }
          return target.get(key, ...args);
        };
      }

      if (property === "put") {
        return async (key, value, options = undefined) => {
          const textKey = String(key || "");

          // Cooldowns are disposable and must never consume the 1,000/day KV write
          // allowance. Losing an in-memory cooldown on an isolate restart is safe.
          if (textKey.startsWith("cooldown:")) {
            const ttlSeconds = Number(options?.expirationTtl || 0);
            cooldownState.set(textKey, {
              value: String(value),
              expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
            });
            return;
          }

          // Persistent Discord <-> Whop mappings are useful, but older layers rewrote
          // both keys on every verify, join, webhook, and audit. Only write when the
          // identity mapping itself actually changes. updated_at alone is not a reason
          // to spend a KV write.
          if (textKey.startsWith("whop:") || textKey.startsWith("discord:")) {
            try {
              const existing = await target.get(textKey, "json");
              if (sameMemberLink(textKey, existing, value)) {
                console.log(JSON.stringify({
                  event: "kv_write_skipped",
                  category: "member_link_unchanged",
                  worker_version: "v19",
                }));
                return;
              }
            } catch (error) {
              console.warn("KV member-link comparison failed:", String(error));
            }
          }

          try {
            const result = await target.put(key, value, options);
            console.log(JSON.stringify({
              event: "kv_write_actual",
              category: kvCategory(textKey),
              worker_version: "v19",
            }));
            return result;
          } catch (error) {
            // Member-link caching is an optimization, not authorization truth. Do not
            // make Discord onboarding or commands fail just because the KV write quota
            // is temporarily exhausted.
            if (textKey.startsWith("whop:") || textKey.startsWith("discord:")) {
              console.warn("Member-link KV write failed open:", String(error));
              return;
            }
            throw error;
          }
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(env, {
    get(target, property) {
      if (property === "MEMBER_LINKS") return safeKv;
      return Reflect.get(target, property, target);
    },
  });
}

function sameMemberLink(key, existing, nextValue) {
  if (!existing || typeof existing !== "object") return false;

  let next;
  try {
    next = typeof nextValue === "string" ? JSON.parse(nextValue) : nextValue;
  } catch {
    return false;
  }
  if (!next || typeof next !== "object") return false;

  if (key.startsWith("whop:")) {
    return String(existing.discord_user_id || "") === String(next.discord_user_id || "");
  }
  if (key.startsWith("discord:")) {
    return String(existing.whop_user_id || "") === String(next.whop_user_id || "");
  }
  return false;
}

function kvCategory(key) {
  if (key.startsWith("whop:") || key.startsWith("discord:")) return "member_link_changed";
  if (key.startsWith("manual:")) return "manual_verification";
  if (key.startsWith("discord-oauth-state:")) return "legacy_oauth_state";
  if (key.startsWith("emergency:")) return "legacy_emergency_state";
  return "other";
}
