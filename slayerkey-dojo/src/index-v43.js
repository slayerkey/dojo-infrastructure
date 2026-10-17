import legacy, { DiscordGateway as DiscordGatewayV42 } from "./index-v42.js";
import {
  claimDojoWelcome,
  greetNewDojoMember,
  releaseDojoWelcome,
} from "./dojowelcome-v43.js";
import {
  getRoadmapLeaderboardCache,
  setRoadmapLeaderboardCache,
} from "./roadmap-leaderboard-v43.js";

export default {
  async fetch(request, env, ctx) {
    const response = await legacy.fetch(request, env, ctx);
    if (new URL(request.url).pathname !== "/health") return response;
    try {
      const body = await response.clone().json();
      body.discord = body.discord || {};
      body.discord.roadmap = { ...(body.discord.roadmap || {}), version: "v43", leaderboard: true, owner_bound_controls: true };
      body.discord.welcome = { version: "v43", gateway_event: "GUILD_MEMBER_ADD", destination: "general", action: "start-here /roadmap" };
      return Response.json(body, { status: response.status });
    } catch {
      return response;
    }
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") await legacy.scheduled(controller, env, ctx);
  },
};

export class DiscordGateway extends DiscordGatewayV42 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {}
    if (payload?.op === 0 && payload?.t === "GUILD_MEMBER_ADD" &&
        String(payload?.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
        payload?.d?.user?.id && !payload.d.user.bot) {
      try {
        await greetNewDojoMember(this, payload.d);
      } catch (error) {
        console.error("New member greeting failed (does not block Discord):", error);
      }
    }
    return super.handleGatewayMessage(raw);
  }

  async claimDojoWelcome(key) { return claimDojoWelcome(this, key); }
  async releaseDojoWelcome(key) { return releaseDojoWelcome(this, key); }
  async getRoadmapLeaderboardCache() { return getRoadmapLeaderboardCache(this); }
  async setRoadmapLeaderboardCache(snapshot) { return setRoadmapLeaderboardCache(this, snapshot); }
}
