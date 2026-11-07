import legacy, { DiscordGateway as DiscordGatewayV41 } from "./index-v41.js";

// v42 remains as a compatibility layer. Coaching-call announcements are disabled.
// Keep the legacy scheduled jobs (membership, roadmap, customer journey) running.
export default {
  async fetch(request, env, ctx) {
    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV41 {}
