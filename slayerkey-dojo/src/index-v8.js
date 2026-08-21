import legacy, { DiscordGateway as DiscordGatewayV7 } from "./index-v7.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_CONNECTED_ACCOUNTS_URL = "https://whop.com/@me/settings/connected-accounts/";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const COMMAND_TIMEOUT_MS = 25000;
const encoder = new TextEncoder();

const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const OVERRIDE_COMMANDS = new Set([
  "verify",
  "verify-all",
  "linkriot",
  "sync",
  "rr",
  "rrleaderboard",
]);
const PUBLIC_COMMANDS = new Set(["linkriot", "sync", "rr", "rrleaderboard"]);
const COOLDOWNS = {
  verify: 2,
  linkriot: 5,
  sync: 30,
  rr: 5,
  rrleaderboard: 8,
  "verify-all": 30,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      const rawBody = await request.text();
      const valid = await verifyDiscordSignature(
        request.headers,
        rawBody,
        env.DISCORD_PUBLIC_KEY,
      );
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      let interaction;
      try {
        interaction = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (interaction.type !== 2 || !OVERRIDE_COMMANDS.has(interaction.data?.name)) {
        return legacy.fetch(delegated, env, ctx);
      }

      const command = interaction.data.name;
      const discordUserId = getInteractionUserId(interaction);
      if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");

      const remaining = await takeCooldown(command, discordUserId, env);
      if (remaining > 0) {
        return ephemeralMessage(`You can use **/${command}** again in **${remaining}s**.`);
      }

      if (command === "verify-all") {
        return handleVerifyAll(interaction, discordUserId, env, ctx);
      }

      if (command === "verify") {
        return handleVerify(interaction, discordUserId, env, ctx);
      }

      const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
      const hasRole = owner || (await liveMemberHasDojoRole(interaction, discordUserId, env));
      if (!hasRole) {
        return ephemeralMessage(
          `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
        );
      }

      if (!env.RR_TRACKER) return ephemeralMessage("The RR tracker service is not connected yet.");

      ctx.waitUntil(
        withTimeout(runTrackerCommand(command, interaction, discordUserId, env), COMMAND_TIMEOUT_MS)
          .then((payload) => editOriginalInteraction(interaction, env, payload))
          .catch(async (error) => {
            console.error(`${command} failed:`, error);
            await editOriginalInteraction(interaction, env, {
              content:
                error?.message === "COMMAND_TIMEOUT"
                  ? "That took too long to finish. Try again in a moment."
                  : "Something went wrong while running that command. Try again in a moment.",
            });
          }),
      );

      return Response.json({
        type: 5,
        data: PUBLIC_COMMANDS.has(command) ? {} : { flags: EPHEMERAL },
      });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rr_presentation = "v8";
        body.discord.destructive_reconciliation_disabled = true;
        body.discord.verification_resolver = "membership-detail-safe-v8";
        body.discord.public_commands = [...PUBLIC_COMMANDS];
        body.discord.cooldowns_seconds = COOLDOWNS;
        if (env.MEMBER_LINKS) {
          body.discord.role_recovery =
            (await env.MEMBER_LINKS.get("emergency:role_recovery_status", "json").catch(() => null)) ||
            { status: "not_run_yet" };
        }
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Deliberately do not call the legacy scheduled reconciler. It could see
    // memberships without embedded product data as stale and remove valid roles.
    if (env.DISCORD_GATEWAY) {
      ctx.waitUntil(
        env.DISCORD_GATEWAY.getByName("dojo-main").ensureConnected().catch((error) => {
          console.error("Gateway keepalive failed:", error);
        }),
      );
    }

    ctx.waitUntil(
      maybeEmergencyRestoreRecentBotRoleRemovals(env).catch((error) => {
        console.error("Emergency role recovery failed:", error);
      }),
    );
  },
};

export class DiscordGateway extends DiscordGatewayV7 {
  async handleGatewayMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );
    } catch {
      return super.handleGatewayMessage(raw);
    }

    if (payload.op === 0 && payload.t === "GUILD_MEMBER_ADD") {
      this.lastEventAt = new Date().toISOString();
      if (payload.s != null) this.sequence = payload.s;

      const member = payload.d || {};
      if (String(member.guild_id || "") !== String(this.env.DISCORD_GUILD_ID || "")) return;
      if (member.user?.bot) return;

      this.lastMemberJoinAt = new Date().toISOString();
      const discordUserId = String(member.user?.id || "");
      if (!discordUserId) return;

      try {
        const result = await autoVerifyJoinedMember(discordUserId, this.env);
        this.lastVerification = {
          at: new Date().toISOString(),
          result: result.reason || (result.verified ? "verified" : "not_verified"),
        };
      } catch (error) {
        this.lastError = `Join verification failed: ${String(error)}`;
        console.error(this.lastError);
      }
      return;
    }

    return super.handleGatewayMessage(raw);
  }
}

async function runTrackerCommand(command, interaction, discordUserId, env) {
  if (command === "linkriot") {
    const name = getOption(interaction, "name");
    const tag = getOption(interaction, "tag");
    if (!name || !tag) return { content: "Enter both your Riot name and tag." };
    return buildLinkPayload(
      await env.RR_TRACKER.linkRiot(discordUserId, `${name}#${tag}`, "na"),
    );
  }

  if (command === "sync") {
    return buildSyncPayload(await env.RR_TRACKER.syncDiscordUser(discordUserId));
  }

  if (command === "rr") {
    return buildRrPayload(await env.RR_TRACKER.getDiscordUserStatsDetailed(discordUserId));
  }

  if (command === "rrleaderboard") {
    return buildLeaderboardPayload(await env.RR_TRACKER.getLeaderboard(10));
  }

  return { content: "Unknown command." };
}

async function handleVerify(interaction, discordUserId, env, ctx) {
  ctx.waitUntil(
    withTimeout(verifyDiscordUser(discordUserId, env), COMMAND_TIMEOUT_MS)
      .then((message) => editOriginalInteraction(interaction, env, { content: message }))
      .catch(async (error) => {
        console.error("Verify failed:", error);
        await editOriginalInteraction(interaction, env, {
          content: "Verification hit an error. Try **/verify** again in a moment.",
        });
      }),
  );

  return Response.json({ type: 5, data: { flags: EPHEMERAL } });
}

async function handleVerifyAll(interaction, discordUserId, env, ctx) {
  if (discordUserId !== String(env.DISCORD_OWNER_USER_ID || "")) {
    return ephemeralMessage("This command is owner only.");
  }

  ctx.waitUntil(
    runVerificationAudit(env)
      .then((report) => sendFollowup(interaction, env, formatVerificationAudit(report), true))
      .catch((error) => sendFollowup(
        interaction,
        env,
        `Verification audit failed: ${String(error).slice(0, 1200)}`,
        true,
      )),
  );

  return Response.json({
    type: 4,
    data: {
      content: "Verification audit started. I’ll post the results here when it finishes.",
      flags: EPHEMERAL,
    },
  });
}

async function verifyDiscordUser(discordUserId, env) {
  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(discordUserId, null, env, "Dojo owner verification");
    return "Verified as the Dojo owner. Your Training Dojo role is active.";
  }

  if (env.MEMBER_LINKS) {
    const manual = await env.MEMBER_LINKS.get(`manual:${discordUserId}`, "json").catch(() => null);
    if (manual) {
      await grantDojoRole(discordUserId, null, env, "Manual Dojo verification");
      return "Your manual Dojo verification is active.";
    }
  }

  const match = await findActiveDojoUserForDiscord(discordUserId, env);
  if (match) {
    await grantDojoRole(discordUserId, match.userId, env, "Active Training Dojo membership");
    return "Verified. Your Training Dojo role is active.";
  }

  return (
    "I could not match this Discord account to an active Training Dojo membership yet.\n\n" +
    `Make sure **this same Discord account** is linked on Whop: [Connect Discord to Whop](${WHOP_CONNECTED_ACCOUNTS_URL})\n\n` +
    "Then run **/verify** again."
  );
}

async function autoVerifyJoinedMember(discordUserId, env) {
  if (discordUserId === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(discordUserId, null, env, "Automatic owner verification on join");
    return { verified: true, reason: "owner" };
  }

  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
    if (reverse?.whop_user_id) {
      const active = await isWhopUserActiveForDojo(String(reverse.whop_user_id), env);
      if (active) {
        await grantDojoRole(discordUserId, String(reverse.whop_user_id), env, "Automatic cached Dojo verification on join");
        return { verified: true, reason: "cached_whop_link" };
      }
    }

    const manual = await env.MEMBER_LINKS.get(`manual:${discordUserId}`, "json").catch(() => null);
    if (manual) {
      await grantDojoRole(discordUserId, null, env, "Automatic manual verification on join");
      return { verified: true, reason: "manual_override" };
    }
  }

  const match = await findActiveDojoUserForDiscord(discordUserId, env);
  if (!match) return { verified: false, reason: "no_active_whop_access" };

  await grantDojoRole(discordUserId, match.userId, env, "Automatic Dojo verification on server join");
  return { verified: true, reason: "live_whop_match" };
}

async function runVerificationAudit(env) {
  const recovery = await restoreRecentBotRoleRemovals(env).catch((error) => ({
    restored: 0,
    error: String(error),
  }));

  const resolved = await getActiveDojoUsersDetailed(env);
  const activeUsers = resolved.users;
  const report = {
    resolver_source: resolved.source,
    company_memberships_visible: resolved.company_memberships_visible,
    membership_details_checked: resolved.membership_details_checked,
    active_memberships: activeUsers.length,
    discord_linked: 0,
    cached_for_join: 0,
    already_had_role: 0,
    roles_added: 0,
    not_in_server: 0,
    no_discord_link: 0,
    lookup_errors: 0,
    role_errors: 0,
    emergency_restored: Number(recovery.restored || 0),
    emergency_restore_error: recovery.error || null,
    configured_product: env.WHOP_PRODUCT_ID,
    status_counts: resolved.status_counts,
  };

  for (let i = 0; i < activeUsers.length; i += 8) {
    const batch = activeUsers.slice(i, i + 8);
    await Promise.all(batch.map(async (item) => {
      let discordId;
      try {
        discordId = await resolveDiscordIdForWhopUser(item.userId, env, { preferCache: false });
      } catch {
        report.lookup_errors += 1;
        return;
      }

      if (!discordId) {
        report.no_discord_link += 1;
        return;
      }

      report.discord_linked += 1;
      await storeMemberLink(item.userId, discordId, env);
      report.cached_for_join += 1;

      const member = await fetchDiscordMember(discordId, env);
      if (member.status === 404) {
        report.not_in_server += 1;
        return;
      }
      if (!member.ok) {
        report.role_errors += 1;
        return;
      }

      const hasRole = Array.isArray(member.data?.roles) &&
        member.data.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
      if (hasRole) {
        report.already_had_role += 1;
        await env.RR_TRACKER?.setMemberActive(discordId, true).catch(() => {});
        return;
      }

      const role = await changeDiscordRole(discordId, true, env, "Dojo safe verify-all restore");
      if (role.ok) {
        report.roles_added += 1;
        await env.RR_TRACKER?.setMemberActive(discordId, true).catch(() => {});
      } else {
        report.role_errors += 1;
      }
    }));
  }

  return report;
}

function formatVerificationAudit(report) {
  let text =
    "**Dojo verification audit**\n" +
    `Active Dojo memberships: **${report.active_memberships}**\n` +
    `Discord linked on Whop: **${report.discord_linked}**\n` +
    `Cached for instant join: **${report.cached_for_join}**\n` +
    `Already in server with role: **${report.already_had_role}**\n` +
    `Roles added now: **${report.roles_added}**\n` +
    `Emergency roles restored: **${report.emergency_restored}**\n` +
    `Linked but not in server yet: **${report.not_in_server}**\n` +
    `Missing Discord link on Whop: **${report.no_discord_link}**\n` +
    `Lookup errors: **${report.lookup_errors}**  Role errors: **${report.role_errors}**`;

  if (report.emergency_restore_error) {
    text += `\nAudit-log recovery note: ${String(report.emergency_restore_error).slice(0, 180)}`;
  }

  text +=
    `\n\n**Resolver diagnostic**\n` +
    `Source: **${report.resolver_source}**\n` +
    `Company memberships visible: **${report.company_memberships_visible}**\n` +
    `Membership details checked: **${report.membership_details_checked}**\n` +
    `Configured product: **${report.configured_product}**`;

  if (report.status_counts?.length) {
    text += `\nStatuses: ${report.status_counts.map(([status, count]) => `${status}: ${count}`).join(", ")}`;
  }

  return text.slice(0, 1900);
}

async function getActiveDojoUsersDetailed(env, onlyUserId = null) {
  const memberships = await fetchAllCompanyMemberships(env);
  const statusCounts = new Map();
  const candidates = [];

  for (const membership of memberships) {
    const status = String(membership?.status || "unknown");
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (!ACCESS_STATUSES.has(status)) continue;

    const listUserId = String(membership?.user?.id || "");
    if (onlyUserId && listUserId && listUserId !== onlyUserId) continue;
    candidates.push(membership);
  }

  const users = new Map();
  let detailsChecked = 0;

  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const resolved = await Promise.all(batch.map(async (membership) => {
      let detail = membership;
      let productId = String(
        membership?.product?.id || membership?.product_id || "",
      );

      if (!productId && membership?.id) {
        detailsChecked += 1;
        try {
          const fetched = await whopGet(`/memberships/${encodeURIComponent(membership.id)}`, env);
          detail = fetched?.data || fetched || membership;
          productId = String(detail?.product?.id || detail?.product_id || "");
        } catch (error) {
          console.warn(`Could not retrieve membership ${membership.id}:`, error);
        }
      }

      if (productId !== String(env.WHOP_PRODUCT_ID || "")) return null;
      const status = String(detail?.status || membership?.status || "");
      if (!ACCESS_STATUSES.has(status)) return null;
      const userId = String(detail?.user?.id || membership?.user?.id || "");
      if (!userId) return null;
      if (onlyUserId && userId !== onlyUserId) return null;
      return { userId, membershipId: String(detail?.id || membership?.id || "") };
    }));

    for (const item of resolved) {
      if (item?.userId && !users.has(item.userId)) users.set(item.userId, item);
    }
  }

  return {
    users: [...users.values()],
    source: "company-memberships+retrieve-detail",
    company_memberships_visible: memberships.length,
    membership_details_checked: detailsChecked,
    status_counts: [...statusCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

async function isWhopUserActiveForDojo(userId, env) {
  const result = await getActiveDojoUsersDetailed(env, String(userId));
  return result.users.some((item) => item.userId === String(userId));
}

async function findActiveDojoUserForDiscord(discordUserId, env) {
  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
    if (reverse?.whop_user_id) {
      const active = await isWhopUserActiveForDojo(String(reverse.whop_user_id), env);
      if (active) return { userId: String(reverse.whop_user_id), source: "cached_reverse_link" };
    }
  }

  const resolved = await getActiveDojoUsersDetailed(env);
  for (let i = 0; i < resolved.users.length; i += 8) {
    const batch = resolved.users.slice(i, i + 8);
    const matches = await Promise.all(batch.map(async (item) => {
      try {
        const foundDiscord = await resolveDiscordIdForWhopUser(item.userId, env);
        if (foundDiscord && env.MEMBER_LINKS) {
          await storeMemberLink(item.userId, foundDiscord, env);
        }
        return foundDiscord === discordUserId ? item : null;
      } catch {
        return null;
      }
    }));
    const match = matches.find(Boolean);
    if (match) return match;
  }
  return null;
}

async function fetchAllCompanyMemberships(env) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({
      company_id: env.WHOP_COMPANY_ID,
      first: "100",
    });
    if (after) params.set("after", after);
    const page = await whopGet(`/memberships?${params.toString()}`, env);
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function resolveDiscordIdForWhopUser(userId, env, { preferCache = true } = {}) {
  if (preferCache && env.MEMBER_LINKS) {
    const cached = await env.MEMBER_LINKS.get(`whop:${userId}`, "json").catch(() => null);
    if (cached?.discord_user_id) return String(cached.discord_user_id);
  }

  const response = await fetch(
    `https://api.whop.com/v5/company/users/${encodeURIComponent(userId)}/social_accounts`,
    { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
  );
  if (!response.ok) throw new Error(`Whop social lookup ${response.status}`);
  const body = await response.json();
  const accounts = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const discord = accounts.find(
    (account) => account?.service === "discord" && account?.account_id,
  );
  return discord ? String(discord.account_id) : null;
}

async function maybeEmergencyRestoreRecentBotRoleRemovals(env) {
  if (!env.MEMBER_LINKS) return;
  const key = "emergency:role_restore_v8_started_at";
  let started = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (!started) {
    started = Date.now();
    await env.MEMBER_LINKS.put(key, String(started));
  }

  // Run this recovery window for two hours after the safety deployment.
  if (Date.now() - started > 2 * 60 * 60 * 1000) return;
  await restoreRecentBotRoleRemovals(env);
}

async function restoreRecentBotRoleRemovals(env) {
  const status = {
    status: "running",
    checked_at: new Date().toISOString(),
    restored: 0,
    matched_removals: 0,
    audit_status: null,
    error: null,
  };

  try {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/audit-logs?action_type=25&limit=100`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
    );
    status.audit_status = response.status;

    if (!response.ok) {
      status.status = "audit_log_unavailable";
      status.error = `Discord audit log returned ${response.status}`;
      await saveRecoveryStatus(status, env);
      return status;
    }

    const body = await response.json();
    const entries = Array.isArray(body?.audit_log_entries) ? body.audit_log_entries : [];
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (String(entry?.user_id || "") !== String(env.DISCORD_APP_ID || "")) continue;
      if (snowflakeTime(entry?.id) < cutoff) continue;

      const removedDojoRole = (entry?.changes || []).some((change) => {
        if (change?.key !== "$remove") return false;
        const values = Array.isArray(change?.new_value)
          ? change.new_value
          : Array.isArray(change?.old_value)
            ? change.old_value
            : [];
        return values.some((role) => String(role?.id || "") === String(env.DISCORD_DOJO_ROLE_ID || ""));
      });
      if (!removedDojoRole) continue;

      const targetId = String(entry?.target_id || "");
      if (!targetId) continue;
      status.matched_removals += 1;

      const marker = `emergency:restored_audit:${entry.id}:${targetId}`;
      if (env.MEMBER_LINKS && await env.MEMBER_LINKS.get(marker)) continue;

      const role = await changeDiscordRole(targetId, true, env, "Emergency restore after Dojo bot role removal");
      if (role.ok) {
        status.restored += 1;
        await env.RR_TRACKER?.setMemberActive(targetId, true).catch(() => {});
        if (env.MEMBER_LINKS) {
          await env.MEMBER_LINKS.put(marker, "1", { expirationTtl: 86400 });
        }
      }
    }

    status.status = "ok";
  } catch (error) {
    status.status = "error";
    status.error = String(error);
  }

  await saveRecoveryStatus(status, env);
  return status;
}

async function saveRecoveryStatus(status, env) {
  if (!env.MEMBER_LINKS) return;
  await env.MEMBER_LINKS.put("emergency:role_recovery_status", JSON.stringify(status));
}

function snowflakeTime(value) {
  try {
    return Number((BigInt(String(value)) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

async function grantDojoRole(discordUserId, whopUserId, env, reason) {
  const role = await changeDiscordRole(discordUserId, true, env, reason);
  if (!role.ok) throw new Error(`Discord role add failed ${role.status}`);
  if (whopUserId && env.MEMBER_LINKS) await storeMemberLink(whopUserId, discordUserId, env);
  await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
}

async function storeMemberLink(userId, discordId, env) {
  if (!env.MEMBER_LINKS) return;
  const now = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${userId}`,
      JSON.stringify({ discord_user_id: String(discordId), updated_at: now }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({ whop_user_id: String(userId), updated_at: now }),
    ),
  ]);
}

async function buildLinkPayload(result) {
  if (!result?.ok) return { content: result?.message || "I could not link that Riot account." };
  const icon = await getRankIconUrl(result.current_rank);
  return {
    embeds: [cleanEmbed({
      title: `Riot account linked  ${result.riot_id}`,
      description: "Your ranked account is connected to the Dojo RR tracker.",
      thumbnail: icon,
      fields: [
        { name: "Current rank", value: formatRank(result.current_rank, result.current_rr), inline: true },
        {
          name: result.month || "This month",
          value: `${formatDelta(result.monthly_rr)}\n${result.games_counted || 0} competitive games`,
          inline: true,
        },
        {
          name: "Next step",
          value: "Run **/rr** for detailed stats. Run **/rrleaderboard** to see where you stand.",
          inline: false,
        },
      ],
      footer: historyWarning(result),
    })],
  };
}

async function buildSyncPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    if (result?.code === "RATE_LIMITED") {
      return { content: `The Riot tracker is rate limited right now. Try **/sync** again in about ${result.retry_after || 60} seconds.` };
    }
    return { content: result?.message || "I could not sync your Riot account." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const imported = Number(result.new_matches_imported || 0);
  return {
    embeds: [cleanEmbed({
      title: `Synced  ${result.riot_id}`,
      description: imported
        ? `Found **${imported} new ${imported === 1 ? "competitive game" : "competitive games"}**.`
        : "No new competitive games were found.",
      thumbnail: icon,
      fields: [
        {
          name: "Since last sync",
          value: `${formatDelta(result.sync_rr_change || 0)}\n${imported} new ${imported === 1 ? "game" : "games"}`,
          inline: true,
        },
        { name: "Current rank", value: formatRank(result.current_rank, result.current_rr), inline: true },
        {
          name: result.month || "This month",
          value: `${formatDelta(result.monthly_rr)}\n${result.games_counted || 0} competitive games`,
          inline: true,
        },
      ],
      footer: historyWarning(result),
    })],
  };
}

async function buildRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    return { content: result?.message || "I could not load your RR stats." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const updated = formatRelativeTime(result.last_synced_at);
  const leaderboard = result.leaderboard_position
    ? `**#${result.leaderboard_position}**${result.leaderboard_count ? ` of ${result.leaderboard_count}` : ""}`
    : "Not ranked yet";

  return {
    embeds: [cleanEmbed({
      title: `${result.riot_id}   ${formatRank(result.current_rank, result.current_rr)}`,
      description: updated ? `Updated ${updated}` : null,
      thumbnail: icon,
      fields: [
        {
          name: "🏁 Start rank",
          value: result.start_rank ? formatRank(result.start_rank, result.start_rr) : "Not recorded yet",
          inline: true,
        },
        {
          name: "👑 Peak tracked",
          value: result.peak_rank
            ? formatRank(result.peak_rank, result.peak_rr)
            : formatRank(result.current_rank, result.current_rr),
          inline: true,
        },
        { name: "🏆 Leaderboard", value: leaderboard, inline: true },
        {
          name: "Last 12 hours",
          value: `${formatDelta(result.recent_12h_rr)}\n${result.recent_12h_games || 0} competitive games`,
          inline: true,
        },
        {
          name: result.month || "This month",
          value: `${formatDelta(result.monthly_rr)}\n${result.games_counted || 0} competitive games`,
          inline: true,
        },
        {
          name: "Streak",
          value: result.current_streak
            ? `🔥 **${result.current_streak} day${result.current_streak === 1 ? "" : "s"}**`
            : "No active streak",
          inline: true,
        },
        {
          name: "Activity",
          value: `**${result.active_days || 0} active days**\n${result.tracking_days || 0} days tracked`,
          inline: true,
        },
        { name: "Monthly activity", value: formatHeatmap(result.activity || []), inline: false },
      ],
      footer: joinFooter(
        historyWarning(result),
        "Run /sync after playing to update your stats.",
      ),
    })],
  };
}

async function buildLeaderboardPayload(result) {
  if (!result?.ok) return { content: result?.message || "I could not load the RR leaderboard." };
  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!entries.length) return { content: `No linked Dojo players are on the ${result.month} leaderboard yet.` };

  const blocks = entries.map((entry, index) => {
    const warning = entry.history_complete ? "" : " ⚠️";
    const delta = `${formatDelta(entry.monthly_rr)}${warning}`;
    const rankLine = `${entry.current_rank || "Unranked"}${entry.current_rr == null ? "" : `  ${entry.current_rr} RR`}\n${entry.games_counted} competitive games`;

    if (index === 0) return `# 🥇 1st  <@${entry.discord_user_id}>  ${delta}\n${rankLine}`;
    if (index === 1) return `## 🥈 2nd  <@${entry.discord_user_id}>  ${delta}\n${rankLine}`;
    if (index === 2) return `### 🥉 3rd  <@${entry.discord_user_id}>  ${delta}\n${rankLine}`;
    return `**${index + 1}. <@${entry.discord_user_id}>  ${delta}**\n${rankLine}`;
  });

  const previous = result.previous_month_champion;
  const previousBlock = previous
    ? `### 👑 ${result.previous_month || "Previous month"} Champion\n<@${previous.discord_user_id}>  ${formatDelta(previous.monthly_rr)}\n${previous.games_counted} competitive games`
    : `### 👑 ${result.previous_month || "Previous month"} Champion\nNo winner recorded yet.`;

  const marked = entries.some((entry) => !entry.history_complete);
  const icon = await getRankIconUrl(entries[0]?.current_rank);

  return {
    embeds: [cleanEmbed({
      title: `🏆 ${result.month} RR Leaderboard`,
      description: `${blocks.join("\n\n")}\n\n${previousBlock}`,
      thumbnail: icon,
      footer: marked
        ? "⚠️ Marked players started tracking after the month began, so earlier RR may be missing. Use /linkriot to get started."
        : "Use /linkriot to get started.",
    })],
  };
}

async function whopGet(path, env) {
  const response = await fetch(`${WHOP_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.WHOP_API_KEY}`,
      "Api-Version-Date": "2026-08-13",
    },
  });
  if (!response.ok) throw new Error(`Whop API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function liveMemberHasDojoRole(interaction, discordUserId, env) {
  const member = await fetchDiscordMember(discordUserId, env).catch(() => null);
  if (member?.ok) {
    return Array.isArray(member.data?.roles) &&
      member.data.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
  }
  const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.map(String) : [];
  return roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}

async function fetchDiscordMember(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
  return {
    ok: response.ok,
    status: response.status,
    data: response.ok ? await response.json() : null,
  };
}

async function changeDiscordRole(discordUserId, add, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: add ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": reason,
      },
    },
  );
  return { ok: response.status === 204, status: response.status };
}

async function takeCooldown(command, discordUserId, env) {
  const seconds = Number(COOLDOWNS[command] || 0);
  if (!seconds || !env.MEMBER_LINKS) return 0;
  const key = `cooldown:v8:${command}:${discordUserId}`;
  const now = Date.now();
  const existing = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (existing > now) return Math.max(1, Math.ceil((existing - now) / 1000));
  await env.MEMBER_LINKS.put(key, String(now + seconds * 1000), {
    expirationTtl: Math.max(60, seconds + 5),
  });
  return 0;
}

function getOption(interaction, name) {
  const option = (interaction.data?.options || []).find((item) => item.name === name);
  return option?.value == null ? null : String(option.value).trim();
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank}  ${rr} RR`;
}

function formatDelta(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 **+${number} RR**`;
  if (number < 0) return `🔴 **${number} RR**`;
  return "⚪ **0 RR**";
}

function historyWarning(result) {
  return result?.history_complete
    ? null
    : "⚠️ Monthly stats may be incomplete because tracking started after the month began.";
}

function joinFooter(...parts) {
  return parts.filter(Boolean).join("  ");
}

function formatRelativeTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatHeatmap(activity) {
  if (!Array.isArray(activity) || !activity.length) return "No activity yet.";
  const today = new Date().getUTCDate();
  const symbols = activity.map((entry) => {
    if (entry.day > today) return "▫️";
    const games = Number(entry.games || 0);
    if (games === 0) return "⬛";
    if (games === 1) return "🟥";
    if (games <= 3) return "🟧";
    return "🟨";
  });
  const rows = [];
  for (let i = 0; i < symbols.length; i += 7) rows.push(symbols.slice(i, i + 7).join(""));
  return `${rows.join("\n")}\n⬛ 0  🟥 1  🟧 2 to 3  🟨 4+  ▫️ upcoming`;
}

function cleanEmbed({ title, description, thumbnail, fields = [], footer }) {
  const embed = { color: VALORANT_RED, title, fields };
  if (description) embed.description = description;
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: footer };
  return embed;
}

async function getRankIconUrl(rankName) {
  if (!rankName) return null;
  const cacheKey = "__dojoValorantRankIconsV8";
  const timeKey = "__dojoValorantRankIconsV8At";
  const cached = globalThis[cacheKey];
  const cachedAt = Number(globalThis[timeKey] || 0);
  if (cached && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
    return cached.get(String(rankName).toLowerCase()) || null;
  }

  try {
    const response = await fetch("https://valorant-api.com/v1/competitivetiers");
    if (!response.ok) return null;
    const body = await response.json();
    const icons = new Map();
    for (const tierSet of Array.isArray(body?.data) ? body.data : []) {
      for (const tier of Array.isArray(tierSet?.tiers) ? tierSet.tiers : []) {
        if (tier?.tierName && (tier?.largeIcon || tier?.smallIcon)) {
          icons.set(String(tier.tierName).toLowerCase(), String(tier.largeIcon || tier.smallIcon));
        }
      }
    }
    globalThis[cacheKey] = icons;
    globalThis[timeKey] = Date.now();
    return icons.get(String(rankName).toLowerCase()) || null;
  } catch {
    return null;
  }
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = typeof payload === "string" ? { content: payload } : { ...(payload || {}) };
  body.allowed_mentions = { parse: [] };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) console.error("Could not edit interaction:", response.status, await response.text());
}

async function sendFollowup(interaction, env, content, ephemeral = false) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        flags: ephemeral ? EPHEMERAL : 0,
        allowed_mentions: { parse: [] },
      }),
    },
  );
  if (!response.ok) console.error("Could not send followup:", response.status, await response.text());
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error("Invalid hex value");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), ms)),
  ]);
}
