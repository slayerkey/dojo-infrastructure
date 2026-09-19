import legacy, { DiscordGateway as DiscordGatewayV38 } from "./index-v38.js";
import { handleActivationAuditRequest, ensureActivationAuditCommand } from "./activation-audit.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      const response = await handleActivationAuditRequest(request, env);
      if (response) return response;
      return legacy.fetch(delegated, env, ctx);
    }
    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureActivationAuditCommand(env).catch((error) => {
      console.error("Activation audit command registration failed:", error);
    }));
    if (typeof legacy.scheduled === "function") return legacy.scheduled(controller, env, ctx);
  },
};

export class DiscordGateway extends DiscordGatewayV38 {}
