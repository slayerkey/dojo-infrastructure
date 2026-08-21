import legacy, { DiscordGateway as DiscordGatewayV15 } from "./index-v15.js";

const commandCooldowns = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Slash command cooldowns are disposable state. Do not spend the Free plan's
    // limited Workers KV writes on them. Also make nonessential KV cache writes
    // fail open for command handling so an exhausted KV write quota cannot make
    // Discord report "The application did not respond".
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      return legacy.fetch(request, commandSafeEnv(env), ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.command_state_mode = "memory-cooldowns-kv-write-fail-open-v16";
        body.discord.member_link_cache_mode = "skip-unchanged-command-writes";
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

export class DiscordGateway extends DiscordGatewayV15 {}

function commandSafeEnv(env) {
  if (!env?.MEMBER_LINKS) return env;

  const realKv = env.MEMBER_LINKS;
  const safeKv = new Proxy(realKv, {
    get(target, property) {
      if (property === "get") {
        return async (key, ...args) => {
          const textKey = String(key || "");
          if (textKey.startsWith("cooldown:")) {
            const item = commandCooldowns.get(textKey);
            if (!item) return null;
            if (item.expiresAt && item.expiresAt <= Date.now()) {
              commandCooldowns.delete(textKey);
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
          if (textKey.startsWith("cooldown:")) {
            const ttlSeconds = Number(options?.expirationTtl || 0);
            commandCooldowns.set(textKey, {
              value: String(value),
              expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
            });
            return;
          }

          // Repeated /verify and related command flows often try to cache the same
          // Whop <-> Discord relationship again. Reads are cheap relative to writes,
          // so skip the write entirely when the mapping has not changed.
          if (textKey.startsWith("whop:") || textKey.startsWith("discord:")) {
            try {
              const existing = await target.get(textKey, "json");
              if (sameMemberLink(textKey, existing, value)) return;
            } catch {
              // Cache comparison is optional. Fall through to the normal write.
            }
          }

          try {
            return await target.put(key, value, options);
          } catch (error) {
            console.warn("Nonessential command KV write failed open:", String(error));
            return;
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
  if (!existing) return false;

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
