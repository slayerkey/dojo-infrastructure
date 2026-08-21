import legacy, { DiscordGateway } from "./index-v7.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.destructive_reconciliation_disabled = true;
        body.discord.emergency_role_protection = "v8";
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }
    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Emergency safety override: do NOT delegate to the legacy reconciliation.
    // The legacy reconciler could interpret missing Whop product data as every
    // cached member being stale and remove the Training Dojo role.
    if (env.DISCORD_GATEWAY) {
      ctx.waitUntil(
        env.DISCORD_GATEWAY.getByName("dojo-main").ensureConnected().catch((error) => {
          console.error("Gateway keepalive failed:", error);
        }),
      );
    }
  },
};

export { DiscordGateway };
