import legacy, { DiscordGateway as DiscordGatewayV39 } from "./index-v39.js";
import {
  applyActivationIntervention,
  attachOrganizerApplicationMessage,
  attachTeamApplicationMessage,
  claimDailyDigestDate,
  claimV40CommandRegistration,
  completeOrganizerApplication,
  completeTeamApplication,
  completeV40CommandRegistration,
  disableLegacyActivityReport,
  ensureV40CommandsOnce,
  failV40CommandRegistration,
  getActivationV40Snapshot,
  getDailyDigestConfig,
  getPremierPublicCardConfig,
  getTeamApplicationConfig,
  handleV40Interaction,
  hydrateActivationIdentities,
  recordActivationCheckinWin,
  releaseDailyDigestDate,
  runDailyDigestScheduler,
  saveTeamApplicationDraft,
  setDailyDigestConfig,
  setPremierPublicCardConfig,
  setTeamApplicationConfig,
  updateOrganizerApplicationStatus,
  updateTeamApplicationStatus,
} from "./activation-v40.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const v40Copy = request.clone();
      const delegated = request.clone();
      const response = await handleV40Interaction(v40Copy, env, ctx);
      if (response) return response;
      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.clone().json();
        body.discord = body.discord || {};
        body.discord.activation = {
          ...(body.discord.activation || {}),
          version: "v40-preview",
          primary_kpi: "first-win-within-7-days",
          action_queue: true,
          identity_resolution: "nickname-global-name-username-stored-id-fallback",
          automated_dms: false,
          team_applications: "discord-native-private-inbox",
          commands: [
            "/activation-audit",
            "/activation-queue",
            "/daily-digest",
            "/daily-digest-setup",
            "/activation-checkin-preview",
            "/wincheckin",
            "/teamapply",
            "/teamapply-setup",
            "/activation-backfill",
            "/activation-backfill-status",
          ],
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
      ensureV40CommandsOnce(env, stub),
      runDailyDigestScheduler(env, stub),
    ];
    const settled = await Promise.allSettled(tasks);
    if (settled[0]?.status === "rejected") {
      console.error("v40 command registration failed:", settled[0].reason);
    }
    if (settled[1]?.status === "rejected") {
      console.error("Daily Digest scheduler failed:", settled[1].reason);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV39 {
  async claimV40CommandRegistration(version) {
    return claimV40CommandRegistration(this, version);
  }

  async completeV40CommandRegistration(version) {
    return completeV40CommandRegistration(this, version);
  }

  async failV40CommandRegistration(version, error) {
    return failV40CommandRegistration(this, version, error);
  }

  async getActivationV40Snapshot() {
    return getActivationV40Snapshot(this);
  }

  async setDailyDigestConfig(config) {
    return setDailyDigestConfig(this, config);
  }

  async getDailyDigestConfig() {
    return getDailyDigestConfig(this);
  }

  async claimDailyDigestDate(dateKey) {
    return claimDailyDigestDate(this, dateKey);
  }

  async releaseDailyDigestDate(dateKey) {
    return releaseDailyDigestDate(this, dateKey);
  }

  async disableLegacyActivityReport() {
    return disableLegacyActivityReport(this);
  }

  async hydrateActivationIdentities(identities) {
    return hydrateActivationIdentities(this, identities);
  }

  async applyActivationIntervention(discordUserId, action, interactionId) {
    return applyActivationIntervention(this, discordUserId, action, interactionId);
  }

  async recordActivationCheckinWin(discordUserId, timestamp, interactionId, identity) {
    return recordActivationCheckinWin(this, discordUserId, timestamp, interactionId, identity);
  }

  async saveTeamApplicationDraft(discordUserId, draft) {
    return saveTeamApplicationDraft(this, discordUserId, draft);
  }

  async completeTeamApplication(discordUserId, interactionId, fields, identity) {
    return completeTeamApplication(this, discordUserId, interactionId, fields, identity);
  }

  async completeOrganizerApplication(discordUserId, interactionId, fields, identity) {
    return completeOrganizerApplication(this, discordUserId, interactionId, fields, identity);
  }

  async setTeamApplicationConfig(config) {
    return setTeamApplicationConfig(this, config);
  }

  async getTeamApplicationConfig() {
    return getTeamApplicationConfig(this);
  }

  async setPremierPublicCardConfig(config) {
    return setPremierPublicCardConfig(this, config);
  }

  async getPremierPublicCardConfig() {
    return getPremierPublicCardConfig(this);
  }

  async attachTeamApplicationMessage(discordUserId, messageId) {
    return attachTeamApplicationMessage(this, discordUserId, messageId);
  }

  async attachOrganizerApplicationMessage(discordUserId, messageId) {
    return attachOrganizerApplicationMessage(this, discordUserId, messageId);
  }

  async updateTeamApplicationStatus(discordUserId, status, actorId, reason = null) {
    return updateTeamApplicationStatus(this, discordUserId, status, actorId, reason);
  }

  async updateOrganizerApplicationStatus(discordUserId, status, actorId, reason = null) {
    return updateOrganizerApplicationStatus(this, discordUserId, status, actorId, reason);
  }
}
