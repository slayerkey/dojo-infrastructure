import legacy, { DiscordGateway as DiscordGatewayV41 } from "./index-v41.js";
import {
  claimCoachingReminder,
  releaseCoachingReminder,
  runCoachingReminderScheduler,
} from "./coaching-reminders-v42.js";

export default {
  async fetch(request, env, ctx) {
    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
    const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
    if (!stub) return;
    try {
      const outcome = await runCoachingReminderScheduler(env, stub);
      if (outcome?.skipped === "matching_live_coaching_event_not_found" ||
          outcome?.skipped === "missing_discord_configuration") {
        console.warn("Coaching reminder not sent:", outcome.skipped);
      }
    } catch (error) {
      console.error("Coaching call reminder failed without blocking existing cron tasks:", error);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV41 {
  async claimCoachingReminder(key) {
    return claimCoachingReminder(this, key);
  }

  async releaseCoachingReminder(key) {
    return releaseCoachingReminder(this, key);
  }
}