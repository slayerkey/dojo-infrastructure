import legacy, { DiscordGateway as DiscordGatewayV6 } from "./index-v6.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const encoder = new TextEncoder();
const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);
const OVERRIDE_COMMANDS = new Set(["linkriot", "sync", "rr", "rrleaderboard", "verify-all"]);
const COOLDOWNS = {
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
      const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
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

      const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
      const hasRole = owner || (await liveMemberHasDojoRole(interaction, discordUserId, env));
      if (!hasRole) {
        return ephemeralMessage(
          `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
        );
      }

      if (!env.RR_TRACKER) return ephemeralMessage("The RR tracker service is not connected yet.");

      ctx.waitUntil(
        runCommand(command, interaction, discordUserId, env)
          .then((payload) => editOriginalInteraction(interaction, env, payload))
          .catch(async (error) => {
            console.error(`${command} failed:`, error);
            await editOriginalInteraction(interaction, env, {
              content: "Something went wrong while running that command. Try again in a moment.",
            });
          }),
      );

      // These community tracker commands are intentionally public.
      return Response.json({ type: 5, data: {} });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rr_presentation = "v7";
        body.discord.linkriot_is_public = true;
        body.discord.verify_all_mode = "immediate_ack_followup";
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacy.scheduled === "function") return legacy.scheduled(controller, env, ctx);
  },
};

export class DiscordGateway extends DiscordGatewayV6 {}

async function runCommand(command, interaction, discordUserId, env) {
  if (command === "linkriot") {
    const name = getOption(interaction, "name");
    const tag = getOption(interaction, "tag");
    if (!name || !tag) return { content: "Enter both your Riot name and tag." };
    const result = await env.RR_TRACKER.linkRiot(discordUserId, `${name}#${tag}`, "na");
    return buildLinkPayload(result);
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
          value: "Run **/rr** for your full tracker. Run **/rrleaderboard** to see where you stand.",
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
      title: result.riot_id,
      description: `### RR Tracker\n**${formatRank(result.current_rank, result.current_rr)}**${updated ? `\nUpdated ${updated}` : ""}`,
      thumbnail: icon,
      fields: [
        {
          name: "Start rank",
          value: result.start_rank ? formatRank(result.start_rank, result.start_rr) : "Not recorded yet",
          inline: true,
        },
        {
          name: "Peak tracked",
          value: result.peak_rank ? formatRank(result.peak_rank, result.peak_rr) : formatRank(result.current_rank, result.current_rr),
          inline: true,
        },
        { name: "Leaderboard", value: leaderboard, inline: true },
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

  const blocks = entries.map((entry, index) => {
    const warning = entry.history_complete ? "" : " ⚠️";
    const delta = `${formatDelta(entry.monthly_rr)}${warning}`;
    const rankLine = `${entry.current_rank || "Unranked"}${entry.current_rr == null ? "" : `  ${entry.current_rr} RR`}\n${entry.games_counted} competitive games`;

    if (index === 0) return `# 🥇 1st  <@${entry.discord_user_id}>\n${delta}\n${rankLine}`;
    if (index === 1) return `## 🥈 2nd  <@${entry.discord_user_id}>\n${delta}\n${rankLine}`;
    if (index === 2) return `### 🥉 3rd  <@${entry.discord_user_id}>\n${delta}\n${rankLine}`;
    return `**${index + 1}. <@${entry.discord_user_id}>**\n${delta}\n${rankLine}`;
  });

  const previous = result.previous_month_champion;
  const previousBlock = previous
    ? `### 👑 ${result.previous_month || "Previous month"} Champion\n<@${previous.discord_user_id}>\n${formatDelta(previous.monthly_rr)}\n${previous.games_counted} competitive games`
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

  // Stop the endless spinner immediately while the larger member scan runs.
  return Response.json({
    type: 4,
    data: {
      content: "Verification audit started. I’ll post the results here when it finishes.",
      flags: EPHEMERAL,
    },
  });
}

async function runVerificationAudit(env) {
  const memberships = await fetchAllMemberships(env);
  const productCounts = new Map();
  const statusCounts = new Map();
  const activeByUser = new Map();

  for (const membership of memberships) {
    const productId = String(membership?.product?.id || "unknown");
    const productTitle = String(membership?.product?.title || "untitled");
    const productKey = `${productTitle} (${productId})`;
    productCounts.set(productKey, (productCounts.get(productKey) || 0) + 1);

    const status = String(membership?.status || "unknown");
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);

    const userId = String(membership?.user?.id || "");
    if (
      userId &&
      productId === String(env.WHOP_PRODUCT_ID || "") &&
      ACCESS_STATUSES.has(status) &&
      !activeByUser.has(userId)
    ) {
      activeByUser.set(userId, userId);
    }
  }

  const activeUsers = [...activeByUser.keys()];
  const report = {
    company_memberships_visible: memberships.length,
    active_memberships: activeUsers.length,
    discord_linked: 0,
    cached_for_join: 0,
    already_had_role: 0,
    roles_added: 0,
    not_in_server: 0,
    no_discord_link: 0,
    lookup_errors: 0,
    role_errors: 0,
    configured_product: env.WHOP_PRODUCT_ID,
    products: [...productCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    statuses: [...statusCounts.entries()].sort((a, b) => b[1] - a[1]),
  };

  for (let i = 0; i < activeUsers.length; i += 16) {
    const batch = activeUsers.slice(i, i + 16);
    await Promise.all(batch.map(async (userId) => {
      let discordId;
      try {
        discordId = await resolveDiscordIdForWhopUser(userId, env);
      } catch {
        report.lookup_errors += 1;
        return;
      }

      if (!discordId) {
        report.no_discord_link += 1;
        return;
      }

      report.discord_linked += 1;
      await storeMemberLink(userId, discordId, env);
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

      const role = await changeDiscordRole(discordId, true, env, "Dojo verify-all audit");
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
    `Linked but not in server yet: **${report.not_in_server}**\n` +
    `Missing Discord link on Whop: **${report.no_discord_link}**\n` +
    `Lookup errors: **${report.lookup_errors}**  Role errors: **${report.role_errors}**`;

  if (report.active_memberships === 0) {
    text +=
      `\n\n**Whop diagnostic**\n` +
      `Company memberships visible: **${report.company_memberships_visible}**\n` +
      `Configured product: **${report.configured_product}**`;
    if (report.products.length) {
      text += `\nProducts seen: ${report.products.map(([key, count]) => `${key}: ${count}`).join(", ")}`;
    }
    if (report.statuses.length) {
      text += `\nStatuses seen: ${report.statuses.map(([key, count]) => `${key}: ${count}`).join(", ")}`;
    }
  }

  return text.slice(0, 1900);
}

async function fetchAllMemberships(env) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({ company_id: env.WHOP_COMPANY_ID, first: "100" });
    if (after) params.set("after", after);
    const page = await whopGet(`/memberships?${params.toString()}`, env);
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
  const discord = accounts.find((account) => account?.service === "discord" && account?.account_id);
  return discord ? String(discord.account_id) : null;
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

async function takeCooldown(command, discordUserId, env) {
  const seconds = Number(COOLDOWNS[command] || 0);
  if (!seconds || !env.MEMBER_LINKS) return 0;
  const key = `cooldown:v7:${command}:${discordUserId}`;
  const now = Date.now();
  const existing = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (existing > now) return Math.max(1, Math.ceil((existing - now) / 1000));
  const until = now + seconds * 1000;
  await env.MEMBER_LINKS.put(key, String(until), { expirationTtl: Math.max(60, seconds + 5) });
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
  const embed = { color: VALORANT_RED, title, description, fields };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: footer };
  return embed;
}

async function getRankIconUrl(rankName) {
  if (!rankName) return null;
  const cacheKey = "__dojoValorantRankIconsV7";
  const timeKey = "__dojoValorantRankIconsV7At";
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
  const body = {
    content,
    flags: ephemeral ? EPHEMERAL : 0,
    allowed_mentions: { parse: [] },
  };
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
