import legacy, { DiscordGateway as DiscordGatewayV38 } from "./index-v38.js";
import {
  beginActivationBackfill,
  claimActivationCommandRegistration,
  completeActivationCommandRegistration,
  ensureActivationCommandsOnce,
  failActivationCommandRegistration,
  getActivationAuditSnapshot,
  getActivationBackfillStatus,
  handleActivationInteraction,
  noteThreadEvent,
  observeRiotLink,
  processActivationBackfillBatch,
  recordLiveActivationMessage,
} from "./activation-audit.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const activationCopy = request.clone();
      const delegated = request.clone();
      const response = await handleActivationInteraction(activationCopy, env, ctx);
      if (response) return response;

      let interaction = null;
      try { interaction = JSON.parse(await request.text()); } catch {}
      const legacyResponse = await legacy.fetch(delegated, env, ctx);

      if (interaction?.type === 2 && String(interaction?.data?.name || "") === "linkriot") {
        const discordUserId = String(interaction?.member?.user?.id || interaction?.user?.id || "");
        const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
        if (discordUserId && stub) {
          ctx.waitUntil(
            new Promise((resolve) => setTimeout(resolve, 4000))
              .then(() => stub.observeActivationRiotLink(discordUserId, "linkriot_observed"))
              .then(async (result) => {
                if (result?.linked) return result;
                await new Promise((resolve) => setTimeout(resolve, 8000));
                return stub.observeActivationRiotLink(discordUserId, "linkriot_observed_retry");
              })
              .catch((error) => console.error("activation Riot observation failed:", error)),
          );
        }
      }
      return legacyResponse;
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.activation = {
          version: "v39",
          live_gateway_tracking: true,
          message_content_required: false,
          historical_backfill: "durable-object-cron-state-machine",
          commands: ["/activation-audit", "/activation-backfill", "/activation-backfill-status"],
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
    const tasks = [
      ensureActivationCommandsOnce(env, stub),
      stub.processActivationBackfillBatch(),
    ];
    const settled = await Promise.allSettled(tasks);
    for (const result of settled) {
      if (result.status === "rejected") console.error("v39 activation scheduled task failed:", result.reason);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV38 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {}

    try {
      if (payload?.op === 0 && payload?.t === "THREAD_CREATE" && String(payload?.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "")) {
        await noteThreadEvent(this, payload.d);
      }

      if (
        payload?.op === 0 &&
        payload?.t === "MESSAGE_CREATE" &&
        String(payload?.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
        !payload?.d?.author?.bot
      ) {
        const roles = Array.isArray(payload?.d?.member?.roles) ? payload.d.member.roles.map(String) : [];
        if (roles.includes(String(this.env.DISCORD_DOJO_ROLE_ID || ""))) {
          await recordLiveActivationMessage(this, payload.d);
        }
      }
    } catch (error) {
      console.error("v39 activation gateway tracking failed without blocking legacy handling:", error);
    }

    return super.handleGatewayMessage(raw);
  }

  async claimActivationCommandRegistration(version) {
    return claimActivationCommandRegistration(this, version);
  }

  async completeActivationCommandRegistration(version) {
    return completeActivationCommandRegistration(this, version);
  }

  async failActivationCommandRegistration(version, error) {
    return failActivationCommandRegistration(this, version, error);
  }

  async beginActivationBackfill() {
    return beginActivationBackfill(this);
  }

  async getActivationBackfillStatus() {
    return getActivationBackfillStatus(this);
  }

  async processActivationBackfillBatch() {
    return processActivationBackfillBatch(this);
  }

  async getActivationAuditSnapshot() {
    return getActivationAuditSnapshot(this);
  }

  async observeActivationRiotLink(discordUserId, source) {
    return observeRiotLink(this, discordUserId, source);
  }
}
