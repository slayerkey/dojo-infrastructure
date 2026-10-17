import legacy, { DiscordGateway as DiscordGatewayV43 } from "./index-v43.js";
import {
  captureRoadmapMonthEnd,
  readRoadmapMonth,
  saveRoadmapMonth,
} from "./roadmap-monthly-v44.js";
import {
  buildRoadmapModel,
  buildMonthOneModel,
  buildMonthTwoModel,
  buildMonthThreeModel,
} from "./roadmap-v41.js";

export default {
  async fetch(request, env, ctx) {
    const response = await legacy.fetch(request, env, ctx);
    if (new URL(request.url).pathname !== "/health") return response;
    try {
      const body = await response.clone().json();
      body.discord = body.discord || {};
      body.discord.roadmap = {
        ...(body.discord.roadmap || {}),
        version: "v44",
        monthly_leaderboard: {
          optional_month: true,
          timezone: "America/Phoenix",
          archived_at: "last minute of each local month",
          metric: "cumulative_completed_roadmap_tasks",
        },
      };
      return Response.json(body, { status: response.status });
    } catch {
      return response;
    }
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") await legacy.scheduled(controller, env, ctx);
    const gateway = env.DISCORD_GATEWAY?.getByName("dojo-main");
    if (!gateway) return;
    try {
      const outcome = await captureRoadmapMonthEnd(new Date(), env, gateway, [
        buildRoadmapModel, buildMonthOneModel, buildMonthTwoModel, buildMonthThreeModel,
      ]);
      if (outcome.saved) console.log("Saved month-end roadmap snapshot:", outcome.month, outcome.members_scored);
    } catch (error) {
      console.error("Month-end roadmap snapshot failed; not substituting later rankings:", error);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV43 {
  async getRoadmapMonthlySnapshot(month) { return readRoadmapMonth(this, month); }
  async saveRoadmapMonthlySnapshot(month, snapshot) { return saveRoadmapMonth(this, month, snapshot); }
}
