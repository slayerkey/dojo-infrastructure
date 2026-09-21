import legacy, { DiscordGateway as DiscordGatewayV40 } from "./index-v40.js";
import {
  claimRoadmapV41CommandRegistration,
  completeRoadmapV41CommandRegistration,
  ensureRoadmapV41CommandsOnce,
  failRoadmapV41CommandRegistration,
  getRoadmapV41Config,
  getRoadmapV41State,
  handleRoadmapV41Interaction,
  setRoadmapV41Config,
  setRoadmapV41Manual,
} from "./roadmap-v41.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const roadmapCopy = request.clone();
      const delegated = request.clone();
      const response = await handleRoadmapV41Interaction(roadmapCopy, env);
      if (response) return response;
      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.clone().json();
        body.discord = body.discord || {};
        body.discord.roadmap = {
          version: "v41",
          persistent_card: true,
          personal_ephemeral_progress: true,
          live_activation_checks: true,
          manual_checklist_items: true,
          new_polling_cron: false,
          commands: ["/roadmap", "/roadmap-setup"],
        };
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
    const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
    if (!stub) return;
    await ensureRoadmapV41CommandsOnce(env, stub).catch((error) => {
      console.error("v41 roadmap command registration failed:", error);
    });
  },
};

export class DiscordGateway extends DiscordGatewayV40 {
  async claimRoadmapV41CommandRegistration(version) {
    return claimRoadmapV41CommandRegistration(this, version);
  }

  async completeRoadmapV41CommandRegistration(version) {
    return completeRoadmapV41CommandRegistration(this, version);
  }

  async failRoadmapV41CommandRegistration(version, error) {
    return failRoadmapV41CommandRegistration(this, version, error);
  }

  async getRoadmapV41State(discordUserId, allowPreview = false) {
    return getRoadmapV41State(this, discordUserId, allowPreview);
  }

  async setRoadmapV41Manual(discordUserId, selected, interactionId) {
    return setRoadmapV41Manual(this, discordUserId, selected, interactionId);
  }

  async setRoadmapV41Config(config) {
    return setRoadmapV41Config(this, config);
  }

  async getRoadmapV41Config() {
    return getRoadmapV41Config(this);
  }
}
