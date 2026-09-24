import legacy, { DiscordGateway as DiscordGatewayV40 } from "./index-v40.js";
import {
  getTaskStageMapV47,
  getTaskStageV47,
  observeTaskThreadV47,
  observeV47Message,
  scanTaskStagesV47,
} from "./community-activation-v47.js";
import {
  handleCustomerIdentityBridge,
  syncActivationPosthogBatch,
} from "./posthog-journey.js";
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

    if (url.pathname === "/internal/customer-identity") {
      return handleCustomerIdentityBridge(request, env);
    }

    if (url.pathname === "/internal/whop-payment-shape" && request.method === "GET") {
      const paymentId = String(url.searchParams.get("payment_id") || "");
      if (paymentId !== "pay_UlAO5R8dHeCrWZ") {
        return Response.json({ ok: false, error: "Not found." }, { status: 404 });
      }
      const apiKey = String(env.WHOP_API_KEY || "").trim();
      if (!apiKey) return Response.json({ ok: false, error: "Whop API unavailable." }, { status: 503 });
      const response = await fetch(`https://api.whop.com/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Api-Version-Date": "2026-09-22-2",
          Accept: "application/json",
        },
      });
      let payment = null;
      try { payment = await response.json(); } catch {}
      const user = payment?.user;
      const company = payment?.company;
      const metadata = payment?.metadata;
      return Response.json({
        ok: response.ok,
        http_status: response.status,
        top_level_keys: payment && typeof payment === "object" ? Object.keys(payment).sort() : [],
        user_type: Array.isArray(user) ? "array" : typeof user,
        user_keys: user && typeof user === "object" && !Array.isArray(user) ? Object.keys(user).sort() : [],
        user_id_present: Boolean(user && typeof user === "object" && !Array.isArray(user) && user.id),
        user_scalar_present: typeof user === "string" && user.length > 0,
        company_type: Array.isArray(company) ? "array" : typeof company,
        company_keys: company && typeof company === "object" && !Array.isArray(company) ? Object.keys(company).sort() : [],
        company_id_present: Boolean(company && typeof company === "object" && !Array.isArray(company) && company.id),
        metadata_type: Array.isArray(metadata) ? "array" : typeof metadata,
        metadata_keys: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Object.keys(metadata).sort() : [],
        posthog_distinct_id_present: Boolean(metadata && typeof metadata === "object" && metadata.posthog_distinct_id),
        status_present: Boolean(payment?.status),
        substatus_present: Boolean(payment?.substatus),
        paid_at_present: Boolean(payment?.paid_at),
      });
    }


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
        body.discord.customer_journey = {
          version: "posthog-v1",
          activation_source: "v40",
          identity: "whop-to-posthog-via-member-links",
          delivery: "scheduled-reconciliation",
          posthog_configured: Boolean(env.POSTHOG_PROJECT_TOKEN),
          identity_bridge_configured: Boolean(env.DOJO_IDENTITY_BRIDGE_SECRET || env.WHOP_API_KEY),
          events: [
            "introduction_posted",
            "replied_to_two_members",
            "first_training_post",
            "first_general_message",
            "community_participated",
            "goal_posted",
            "riot_linked",
            "first_win_posted",
            "first_win_within_7_days",
          ],
        };
        body.discord.roadmap = {
          version: "v41",
          persistent_card: true,
          progress_visibility: "configurable; defaults public for current testing",
          live_activation_checks: true,
          manual_checklist_items: true,
          new_polling_cron: false,
          commands: ["/roadmap", "/roadmap-setup", "/roadmap-preview", "/roadmap-visibility"],
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
      ensureRoadmapV41CommandsOnce(env, stub),
      stub.syncActivationPosthogBatch(),
    ];
    const settled = await Promise.allSettled(tasks);
    if (settled[0]?.status === "rejected") {
      console.error("v41 roadmap command registration failed:", settled[0].reason);
    }
    if (settled[1]?.status === "rejected") {
      console.error("PostHog customer journey reconciliation failed without blocking Discord:", settled[1].reason);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV40 {
  async handleGatewayMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {}

    try {
      if (
        payload?.op === 0 &&
        payload?.t === "MESSAGE_CREATE" &&
        String(payload?.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
        !payload?.d?.author?.bot
      ) {
        const roles = Array.isArray(payload?.d?.member?.roles) ? payload.d.member.roles.map(String) : [];
        if (roles.includes(String(this.env.DISCORD_DOJO_ROLE_ID || ""))) {
          await observeV47Message(this, payload.d, true);
        }
      }

      if (
        payload?.op === 0 &&
        (payload?.t === "THREAD_CREATE" || payload?.t === "THREAD_UPDATE") &&
        String(payload?.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "")
      ) {
        await observeTaskThreadV47(this, payload.d);
      }
    } catch (error) {
      console.error("v47 community/task tracking failed without blocking legacy handling:", error);
    }

    return super.handleGatewayMessage(raw);
  }

  async syncActivationPosthogBatch() {
    return syncActivationPosthogBatch(this);
  }

  async claimRoadmapV41CommandRegistration(version) {
    return claimRoadmapV41CommandRegistration(this, version);
  }

  async completeRoadmapV41CommandRegistration(version) {
    return completeRoadmapV41CommandRegistration(this, version);
  }

  async failRoadmapV41CommandRegistration(version, error) {
    return failRoadmapV41CommandRegistration(this, version, error);
  }

  async getRoadmapV41State(discordUserId, allowPreview = false, allowRoleFallback = false) {
    return getRoadmapV41State(this, discordUserId, allowPreview, allowRoleFallback);
  }

  async setRoadmapV41Manual(discordUserId, selected, interactionId, allowRoleFallback = false) {
    return setRoadmapV41Manual(this, discordUserId, selected, interactionId, allowRoleFallback);
  }

  async setRoadmapV41Config(config) {
    return setRoadmapV41Config(this, config);
  }

  async getRoadmapV41Config() {
    return getRoadmapV41Config(this);
  }

  async scanTaskStagesV47() {
    return scanTaskStagesV47(this);
  }

  async getTaskStageMapV47() {
    return getTaskStageMapV47(this);
  }

  async getTaskStageV47(discordUserId) {
    return getTaskStageV47(this, discordUserId);
  }
}
