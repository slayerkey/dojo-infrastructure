import legacy, { DiscordGateway as DiscordGatewayV44 } from "./index-v44.js";

export default {
  async fetch(request, env, ctx) {
    const response = await legacy.fetch(request, env, ctx);
    if (new URL(request.url).pathname !== "/health") return response;
    try {
      const body = await response.clone().json();
      body.discord = body.discord || {};
      body.discord.coaching_reminder = {
        version: "v45",
        scheduled: true,
        time_before_minutes: 30,
        channel_id: "1532854321723478217",
        destination: "general",
        includes_event_link: true,
        includes_classroom_vc_link: true,
      };
      return Response.json(body, { status: response.status });
    } catch {
      return response;
    }
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") await legacy.scheduled(controller, env, ctx);
  },
};

export class DiscordGateway extends DiscordGatewayV44 {}
