import legacy, { DiscordGateway as DiscordGatewayV9 } from "./index-v9.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const encoder = new TextEncoder();
const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const OVERRIDE_COMMANDS = new Set(["rr", "rrleaderboard", "verify-all"]);
const COOLDOWNS = { rr: 5, rrleaderboard: 8, "verify-all": 30 };
const VERIFY_BATCH_SIZE = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      const rawBody = await request.text();
      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      let interaction;
      try {
        interaction = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const command = interaction.data?.name;
      if (interaction.type !== 2 || !OVERRIDE_COMMANDS.has(command)) {
        return legacy.fetch(delegated, env, ctx);
      }

      const discordUserId = getInteractionUserId(interaction);
      if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");

      const remaining = await takeCooldown(command, discordUserId, env);
      if (remaining > 0) {
        return ephemeralMessage(`You can use **/${command}** again in **${remaining}s**.`);
      }

      if (command === "verify-all") {
        if (discordUserId !== String(env.DISCORD_OWNER_USER_ID || "")) {
          return ephemeralMessage("This command is owner only.");
        }

        const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
        if (!stub) return ephemeralMessage("The verification worker is not available right now.");

        ctx.waitUntil(
          stub.startVerificationAudit(interaction.token).catch(async (error) => {
            console.error("Could not start verification audit:", error);
            await editOriginalByToken(interaction.token, env, {
              content: "I could not start the verification audit. Try **/verify-all** again in a moment.",
            }).catch(() => {});
          }),
        );

        return Response.json({
          type: 4,
          data: {
            content: "Verification audit starting...",
            flags: EPHEMERAL,
          },
        });
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
        runTrackerCommand(command, discordUserId, env)
          .then((payload) => editOriginalInteraction(interaction, env, payload))
          .catch(async (error) => {
            console.error(`${command} failed:`, error);
            await editOriginalInteraction(interaction, env, {
              content: "Something went wrong while running that command. Try again in a moment.",
            });
          }),
      );

      return Response.json({ type: 5, data: {} });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rr_presentation = "v11";
        body.discord.verify_all_mode = "durable-object-batched-progress-10";
        body.discord.destructive_reconciliation_disabled = true;
        if (env.DISCORD_GATEWAY) {
          body.discord.verification_audit = await env.DISCORD_GATEWAY
            .getByName("dojo-main")
            .verificationAuditStatus()
            .catch(() => null);
        }
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Never call the old membership reconciler. The cron only keeps the Discord Gateway alive.
    if (env.DISCORD_GATEWAY) {
      ctx.waitUntil(
        env.DISCORD_GATEWAY.getByName("dojo-main").ensureConnected().catch((error) => {
          console.error("Gateway keepalive failed:", error);
        }),
      );
    }
  },
};

export class DiscordGateway extends DiscordGatewayV9 {
  async startVerificationAudit(interactionToken) {
    const resolved = await getActiveDojoUsers(this.env, { diagnostics: true });
    const job = {
      id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      token: String(interactionToken || ""),
      users: resolved.users.map((item) => ({ userId: String(item.userId) })),
      index: 0,
      resolver_source: resolved.source,
      company_memberships_visible: resolved.company_memberships_visible,
      filtered_records_visible: resolved.filtered_records_visible,
      attempts: resolved.attempts || [],
      sample_keys: resolved.sample_keys || [],
      discord_linked: 0,
      cached_for_join: 0,
      already_had_role: 0,
      roles_added: 0,
      not_in_server: 0,
      no_discord_link: 0,
      lookup_errors: 0,
      role_errors: 0,
      status: "running",
    };

    await this.ctx.storage.put("verify_all_job", job);

    if (!job.users.length) {
      job.status = "finished";
      job.finished_at = new Date().toISOString();
      await this.ctx.storage.put("verify_all_job", job);
      await editOriginalByToken(job.token, this.env, { content: formatAuditFinal(job) });
      return { started: true, total: 0 };
    }

    await editOriginalByToken(job.token, this.env, {
      content: formatAuditProgress(job),
    });
    await this.ctx.storage.setAlarm(Date.now() + 250);
    return { started: true, total: job.users.length };
  }

  async verificationAuditStatus() {
    const job = await this.ctx.storage.get("verify_all_job");
    if (!job) return { status: "idle" };
    return {
      status: job.status,
      checked: Number(job.index || 0),
      total: Array.isArray(job.users) ? job.users.length : 0,
      roles_added: Number(job.roles_added || 0),
      already_had_role: Number(job.already_had_role || 0),
      started_at: job.started_at || null,
      finished_at: job.finished_at || null,
    };
  }

  async alarm() {
    const job = await this.ctx.storage.get("verify_all_job");
    if (!job || job.status !== "running") return;

    const start = Number(job.index || 0);
    const end = Math.min(start + VERIFY_BATCH_SIZE, job.users.length);
    const batch = job.users.slice(start, end);

    // Ten users stays comfortably below the external request ceiling while finishing much faster.
    await Promise.all(batch.map((item) => processAuditUser(item.userId, job, this.env)));
    job.index = end;

    if (end >= job.users.length) {
      job.status = "finished";
      job.finished_at = new Date().toISOString();
      await this.ctx.storage.put("verify_all_job", job);
      await editOriginalByToken(job.token, this.env, { content: formatAuditFinal(job) }).catch(() => {});
      return;
    }

    await this.ctx.storage.put("verify_all_job", job);
    await editOriginalByToken(job.token, this.env, { content: formatAuditProgress(job) }).catch(() => {});
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}

async function processAuditUser(userId, job, env) {
  let discordId;
  try {
    discordId = await resolveDiscordIdForWhopUser(userId, env);
  } catch (error) {
    job.lookup_errors += 1;
    console.warn(`Whop Discord lookup failed for ${userId}:`, error);
    return;
  }

  if (!discordId) {
    job.no_discord_link += 1;
    return;
  }

  job.discord_linked += 1;
  await storeMemberLink(userId, discordId, env);
  job.cached_for_join += 1;

  const member = await fetchDiscordMember(discordId, env);
  if (member.status === 404) {
    job.not_in_server += 1;
    return;
  }
  if (!member.ok) {
    job.role_errors += 1;
    return;
  }

  const hasRole = Array.isArray(member.data?.roles) &&
    member.data.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""));

  if (hasRole) {
    job.already_had_role += 1;
    await env.RR_TRACKER?.setMemberActive(discordId, true).catch(() => {});
    return;
  }

  const role = await changeDiscordRole(discordId, true, env, "Dojo verify-all restore");
  if (role.ok) {
    job.roles_added += 1;
    await env.RR_TRACKER?.setMemberActive(discordId, true).catch(() => {});
  } else {
    job.role_errors += 1;
  }
}

async function runTrackerCommand(command, discordUserId, env) {
  if (command === "rr") {
    return buildRrPayload(await env.RR_TRACKER.getDiscordUserStatsDetailed(discordUserId));
  }
  if (command === "rrleaderboard") {
    return buildLeaderboardPayload(await env.RR_TRACKER.getLeaderboard(10));
  }
  return { content: "Unknown command." };
}

async function buildRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    return { content: result?.message || "I could not load your RR stats." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const leaderboard = result.leaderboard_position
    ? `**#${result.leaderboard_position}**${result.leaderboard_count ? ` of ${result.leaderboard_count}` : ""}`
    : "Not ranked yet";

  return {
    embeds: [cleanEmbed({
      title: `${result.riot_id}  ${formatRank(result.current_rank, result.current_rr)}`,
      thumbnail: icon,
      fields: [
        {
          name: "🏁 Start rank",
          value: result.start_rank ? formatRank(result.start_rank, result.start_rr) : "Not recorded yet",
          inline: true,
        },
        {
          name: "👑 Peak tracked",
          value: result.peak_rank ? formatRank(result.peak_rank, result.peak_rr) : formatRank(result.current_rank, result.current_rr),
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
      footer: joinFooter(historyWarning(result), "Run /sync after playing to update your stats."),
    })],
  };
}

async function buildLeaderboardPayload(result) {
  if (!result?.ok) return { content: result?.message || "I could not load the RR leaderboard." };
  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!entries.length) return { content: `No linked Dojo players are on the ${result.month} leaderboard yet.` };

  const blocks = [];
  for (let index = 0; index < Math.max(entries.length, 3); index += 1) {
    const entry = entries[index];
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "";
    const ordinal = index === 0 ? "1st" : index === 1 ? "2nd" : index === 2 ? "3rd" : `${index + 1}th`;
    const heading = index === 0 ? "#" : index === 1 ? "##" : index === 2 ? "###" : "";

    if (!entry) {
      blocks.push(`${heading} ${medal} ${ordinal}  Open`.trim());
      continue;
    }

    const delta = formatDeltaInline(entry.monthly_rr);
    const warning = entry.history_complete ? "" : " ⚠️";
    const start = entry.start_rank
      ? formatRank(entry.start_rank, entry.start_rr)
      : "Start not recorded";
    const peak = entry.peak_rank
      ? formatRank(entry.peak_rank, entry.peak_rr)
      : formatRank(entry.current_rank, entry.current_rr);
    const progression = `${start}  →  ${peak}`;
    const games = `${entry.games_counted || 0} competitive games${warning}`;

    if (index < 3) {
      blocks.push(`${heading} ${medal} ${ordinal}  <@${entry.discord_user_id}>  ${delta}\n${progression}\n${games}`);
    } else {
      blocks.push(`**${index + 1}. <@${entry.discord_user_id}>  ${delta}**\n${progression}\n${games}`);
    }
  }

  const previous = result.previous_month_champion;
  const previousBlock = previous
    ? `### ${result.previous_month || "Previous month"} Champion\n<@${previous.discord_user_id}>  ${formatDeltaInline(previous.monthly_rr)}\n${previous.games_counted} competitive games`
    : `### ${result.previous_month || "Previous month"} Champion\nNo winner recorded yet.`;

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

function formatAuditProgress(job) {
  const total = job.users.length;
  return (
    `**Dojo verification audit running**\n` +
    `Checked: **${job.index}/${total}**\n` +
    `Roles restored: **${job.roles_added}**\n` +
    `Already had role: **${job.already_had_role}**\n` +
    `Discord links found: **${job.discord_linked}**\n\n` +
    "This updates automatically as the scan continues."
  );
}

function formatAuditFinal(job) {
  let text =
    "**Dojo verification audit finished**\n" +
    `Active Dojo memberships: **${job.users.length}**\n` +
    `Discord linked on Whop: **${job.discord_linked}**\n` +
    `Cached for instant join: **${job.cached_for_join}**\n` +
    `Already in server with role: **${job.already_had_role}**\n` +
    `Roles restored: **${job.roles_added}**\n` +
    `Linked but not in server yet: **${job.not_in_server}**\n` +
    `Missing Discord link on Whop: **${job.no_discord_link}**\n` +
    `Lookup errors: **${job.lookup_errors}**  Role errors: **${job.role_errors}**\n\n` +
    `Resolver: **${job.resolver_source}**\n` +
    `Company memberships visible: **${job.company_memberships_visible}**\n` +
    `Product filtered records: **${job.filtered_records_visible}**`;

  if (job.attempts?.length) {
    text += `\nAttempts: ${job.attempts.map((a) => `${a.source}=${a.count}${a.error ? ` (${a.error})` : ""}`).join(", ")}`;
  }
  return text.slice(0, 1900);
}

async function getActiveDojoUsers(env, { diagnostics = false } = {}) {
  const attempts = [];
  let companyMembershipsVisible = 0;
  let sampleKeys = [];

  try {
    const unfiltered = await fetchPaged("/memberships", env, (params) => {
      params.append("company_id", env.WHOP_COMPANY_ID);
    });
    companyMembershipsVisible = unfiltered.length;
    sampleKeys = Object.keys(unfiltered[0] || {}).slice(0, 20);
  } catch (error) {
    attempts.push({ source: "memberships-unfiltered", count: 0, error: shortError(error) });
  }

  const membershipVariants = [
    { source: "memberships-product_ids", key: "product_ids" },
    { source: "memberships-product_ids-brackets", key: "product_ids[]" },
  ];

  for (const variant of membershipVariants) {
    try {
      const records = await fetchPaged("/memberships", env, (params) => {
        params.append("company_id", env.WHOP_COMPANY_ID);
        params.append(variant.key, env.WHOP_PRODUCT_ID);
      });
      attempts.push({ source: variant.source, count: records.length });
      const users = dedupeActiveMembershipUsers(records);
      if (users.length > 0) {
        return {
          users,
          source: variant.source,
          company_memberships_visible: companyMembershipsVisible,
          filtered_records_visible: records.length,
          attempts,
          sample_keys: sampleKeys,
        };
      }
    } catch (error) {
      attempts.push({ source: variant.source, count: 0, error: shortError(error) });
    }
  }

  const memberVariants = [
    { source: "members-product_ids", key: "product_ids" },
    { source: "members-product_ids-brackets", key: "product_ids[]" },
  ];

  for (const variant of memberVariants) {
    try {
      const records = await fetchPaged("/members", env, (params) => {
        params.append("company_id", env.WHOP_COMPANY_ID);
        params.append("access_level", "customer");
        params.append(variant.key, env.WHOP_PRODUCT_ID);
      });
      attempts.push({ source: variant.source, count: records.length });
      const users = dedupeMemberUsers(records);
      if (users.length > 0) {
        return {
          users,
          source: variant.source,
          company_memberships_visible: companyMembershipsVisible,
          filtered_records_visible: records.length,
          attempts,
          sample_keys: sampleKeys,
        };
      }
    } catch (error) {
      attempts.push({ source: variant.source, count: 0, error: shortError(error) });
    }
  }

  return {
    users: [],
    source: "no-product-filter-result",
    company_memberships_visible: companyMembershipsVisible,
    filtered_records_visible: 0,
    attempts,
    sample_keys: sampleKeys,
  };
}

function dedupeActiveMembershipUsers(records) {
  const users = new Map();
  for (const record of records || []) {
    const status = String(record?.status || record?.membership?.status || "");
    if (status && !ACCESS_STATUSES.has(status)) continue;
    const userId = String(record?.user?.id || record?.user_id || record?.membership?.user?.id || "");
    if (!userId || users.has(userId)) continue;
    users.set(userId, { userId });
  }
  return [...users.values()];
}

function dedupeMemberUsers(records) {
  const users = new Map();
  for (const record of records || []) {
    const userId = String(record?.user?.id || record?.user_id || "");
    if (!userId || users.has(userId)) continue;
    users.set(userId, { userId });
  }
  return [...users.values()];
}

async function fetchPaged(path, env, configure) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams();
    params.append("first", "100");
    configure(params);
    if (after) params.append("after", after);
    const response = await fetch(`${WHOP_API}${path}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) {
      throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 180)}`);
    }
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function resolveDiscordIdForWhopUser(userId, env) {
  if (env.MEMBER_LINKS) {
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

async function storeMemberLink(userId, discordId, env) {
  if (!env.MEMBER_LINKS || !userId || !discordId) return;
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

async function fetchDiscordMember(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );
  return { ok: response.ok, status: response.status, data: response.ok ? await response.json() : null };
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

function formatDeltaInline(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 +${number} RR`;
  if (number < 0) return `🔴 ${number} RR`;
  return "⚪ 0 RR";
}

function historyWarning(result) {
  return result?.history_complete
    ? null
    : "⚠️ Monthly stats may be incomplete because tracking started after the month began.";
}

function joinFooter(...parts) {
  return parts.filter(Boolean).join("  ");
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
  const cacheKey = "__dojoValorantRankIconsV11";
  const timeKey = "__dojoValorantRankIconsV11At";
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

async function takeCooldown(command, discordUserId, env) {
  const seconds = Number(COOLDOWNS[command] || 0);
  if (!seconds || !env.MEMBER_LINKS) return 0;
  const key = `cooldown:v11:${command}:${discordUserId}`;
  const now = Date.now();
  const existing = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (existing > now) return Math.max(1, Math.ceil((existing - now) / 1000));
  await env.MEMBER_LINKS.put(key, String(now + seconds * 1000), {
    expirationTtl: Math.max(60, seconds + 5),
  });
  return 0;
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function shortError(error) {
  return String(error?.message || error || "error").slice(0, 140);
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  return editOriginalByToken(interaction.token, env, payload);
}

async function editOriginalByToken(token, env, payload) {
  const body = typeof payload === "string" ? { content: payload } : { ...(payload || {}) };
  body.allowed_mentions = { parse: [] };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord interaction edit ${response.status}: ${await response.text()}`);
  }
  return true;
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
