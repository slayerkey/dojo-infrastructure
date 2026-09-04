import legacy, { DiscordGateway as DiscordGatewayV28 } from "./index-v28.js";

const ACTIVITY_CHANNEL_ID = "1545559455540715602";
const ACTIVITY_WEEKDAY = 0;
const ACTIVITY_HOUR = 6;
const ACTIVITY_MINUTE = 0;
const PHOENIX_OFFSET_MS = 7 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
    if (stub) {
      await stub.prepareV29ActivitySchedule({
        enabled: true,
        channel_id: ACTIVITY_CHANNEL_ID,
        weekday: ACTIVITY_WEEKDAY,
        hour: ACTIVITY_HOUR,
        minute: ACTIVITY_MINUTE,
        configured_at: new Date().toISOString(),
        source: "user_requested_sunday_6am_arizona",
      }).catch((error) => console.error("Could not prepare v29 activity schedule:", error));
    }

    if (typeof legacy.scheduled === "function") {
      await legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV28 {
  async prepareV29ActivitySchedule(config) {
    const marker = "activity:v29_full_week_baseline";
    if (await this.ctx.storage.get(marker)) return false;

    await this.setActivityConfig(config);
    // Prevent the v28 one-time schedule setter from resetting this baseline.
    await this.ctx.storage.put("activity:v28_fixed_schedule", new Date().toISOString());

    const nextDateKey = nextScheduledPhoenixDateKey(new Date(), ACTIVITY_WEEKDAY, ACTIVITY_HOUR, ACTIVITY_MINUTE);
    if (nextDateKey) {
      // The activity counter starts with this deployment. If the next scheduled
      // report is less than a full week away, pre-claim it so the first report
      // cannot falsely label members inactive using only a partial week of data.
      await this.ctx.storage.put("activity:last_report_date", nextDateKey);
    }

    await this.ctx.storage.put(marker, new Date().toISOString());
    return true;
  }
}

function nextScheduledPhoenixDateKey(now, weekday, hour, minute) {
  const shifted = new Date(now.getTime() - PHOENIX_OFFSET_MS);
  const localYear = shifted.getUTCFullYear();
  const localMonth = shifted.getUTCMonth();
  const localDay = shifted.getUTCDate();
  const localWeekday = shifted.getUTCDay();
  const localMinutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const targetMinutes = Number(hour) * 60 + Number(minute);

  let daysAhead = (Number(weekday) - localWeekday + 7) % 7;
  if (daysAhead === 0 && localMinutes >= targetMinutes) daysAhead = 7;

  const localTarget = new Date(Date.UTC(localYear, localMonth, localDay + daysAhead));
  return localTarget.toISOString().slice(0, 10);
}
