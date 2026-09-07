import legacy from "./index-v2-event.js";

const DISCORD_API = "https://discord.com/api/v10";
const ENHANCED_COMMANDS_VERSION = "2026-08-21-v3";
const LEGACY_COMMANDS_VERSION = "2026-08-21-v2";
const EPHEMERAL = 64;
const COMMAND_TIMEOUT_MS = 15000;
const VALORANT_RED = 0xff4655;
const encoder = new TextEncoder();

const LEGACY_COMMAND_NAMES = new Set([
  "verify",
  "verify-all",
  "manualverify",
  "manualunverify",
]);

const RR_COMMAND_NAMES = new Set([
  "linkriot",
  "sync",
  "rr",
  "rrleaderboard",
]);

const GUILD_COMMANDS = [
  {
    name: "verify",
    description: "Verify your active Slayerkey Training Dojo membership",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "verify-all",
    description: "Owner only: reconcile all Dojo membership roles",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "manualverify",
    description: "Owner only: temporarily verify a Discord member for Dojo access",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "user",
        description: "Discord member to verify",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "manualunverify",
    description: "Owner only: remove a manual Dojo verification",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "user",
        description: "Discord member to remove manual verification from",
        type: 6,
        required: true,
      },
    ],
  },
  {
    name: "linkriot",
    description: "Link your Riot account to the Dojo RR tracker",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "name",
        description: "Your Riot name",
        type: 3,
        required: true,
      },
      {
        name: "tag",
        description: "Your Riot tag without the #",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "sync",
    description: "Sync your latest Valorant ranked RR after you finish playing",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "rr",
    description: "Show your current rank, recent RR, streak, and monthly activity",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
  {
    name: "rrleaderboard",
    description: "Show the Dojo monthly RR leaderboard",
    type: 1,
    integration_types: [0],
    contexts: [0],
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions") {
      return handleEnhancedInteraction(request, env, ctx);
    }

    if (url.pathname === "/health") {
      await ensureEnhancedCommands(env).catch((error) => {
        console.error("Enhanced command registration failed:", error);
      });

      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        const marker = env.MEMBER_LINKS
          ? await env.MEMBER_LINKS.get("discord:enhanced_commands_version")
          : null;
        body.discord = body.discord || {};
        body.discord.enhanced_commands_registered = marker === ENHANCED_COMMANDS_VERSION;
        body.discord.enhanced_commands_version = marker;
        body.discord.target_role_id = env.DISCORD_DOJO_ROLE_ID || null;
        return Response.json(body, { status: response.status });
      } catch {
        return response;
      }
    }

    ctx?.waitUntil?.(
      ensureEnhancedCommands(env).catch((error) => {
        console.error("Enhanced command registration failed:", error);
      }),
    );

    return legacy.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    try {
      await ensureEnhancedCommands(env);
    } catch (error) {
      console.error("Enhanced command registration failed:", error);
    }

    if (typeof legacy.scheduled === "function") {
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

async function handleEnhancedInteraction(request, env, ctx) {
  const delegatedRequest = request.clone();
  const rawBody = await request.text();

  const valid = await verifyDiscordSignature(
    request.headers,
    rawBody,
    env.DISCORD_PUBLIC_KEY,
  );
  if (!valid) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (interaction.type === 1) {
    ctx.waitUntil(
      ensureEnhancedCommands(env).catch((error) => {
        console.error("Enhanced command registration failed:", error);
      }),
    );
    return Response.json({ type: 1 });
  }

  if (interaction.type !== 2) {
    return interactionMessage("Unsupported interaction type.");
  }

  const commandName = interaction.data?.name;

  if (LEGACY_COMMAND_NAMES.has(commandName)) {
    return legacy.fetch(delegatedRequest, env, ctx);
  }

  if (!RR_COMMAND_NAMES.has(commandName)) {
    return interactionMessage("Unknown command.");
  }

  if (interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return interactionMessage("This command only works in the Slayerkey Discord server.");
  }

  const discordUserId = String(
    interaction.member?.user?.id || interaction.user?.id || "",
  );

  if (!discordUserId) {
    return interactionMessage("I could not determine your Discord user ID.");
  }

  const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
  const hasRole = owner || (await liveMemberHasDojoRole(interaction, discordUserId, env));

  if (!hasRole) {
    const roleMention = env.DISCORD_DOJO_ROLE_ID
      ? `<@&${env.DISCORD_DOJO_ROLE_ID}>`
      : "the Training Dojo role";
    return interactionMessage(
      `You need ${roleMention} to use the RR tracker. Run **/verify** first.`,
    );
  }

  if (!env.RR_TRACKER) {
    return interactionMessage("The RR tracker service is not connected yet.");
  }

  ctx.waitUntil(
    withTimeout(executeRrCommand(interaction, discordUserId, env), COMMAND_TIMEOUT_MS)
      .then((payload) => editOriginalInteraction(interaction, env, payload))
      .catch(async (error) => {
        console.error(`Discord RR command ${commandName} failed:`, error);
        await editOriginalInteraction(interaction, env, {
          content:
            error?.message === "COMMAND_TIMEOUT"
              ? "That took too long to finish. Try the command again in a moment."
              : "Something went wrong while running that command. Try again in a moment.",
        });
      }),
  );

  return Response.json({
    type: 5,
    data: { flags: EPHEMERAL },
  });
}

async function executeRrCommand(interaction, discordUserId, env) {
  const commandName = interaction.data?.name;

  if (commandName === "linkriot") {
    const name = getStringOption(interaction, "name");
    const tag = getStringOption(interaction, "tag")?.replace(/^#/, "");

    if (!name || !tag) {
      return { content: "Enter both your Riot **name** and **tag**." };
    }

    const result = await env.RR_TRACKER.linkRiot(
      discordUserId,
      `${name}#${tag}`,
      "na",
    );
    return buildLinkPayload(result);
  }

  if (commandName === "sync") {
    const result = await env.RR_TRACKER.syncDiscordUser(discordUserId);
    return buildSyncPayload(result);
  }

  if (commandName === "rr") {
    const result = await env.RR_TRACKER.getDiscordUserStatsDetailed(discordUserId);
    return buildRrPayload(result);
  }

  if (commandName === "rrleaderboard") {
    const result = await env.RR_TRACKER.getLeaderboard(10);
    return buildLeaderboardPayload(result);
  }

  return { content: "Unknown command." };
}

async function buildLinkPayload(result) {
  if (!result?.ok) {
    if (result?.code === "RATE_LIMITED") {
      return {
        content: `Henrik is rate limited right now. Try **/linkriot** again in about ${result.retry_after || "60"} seconds.`,
      };
    }
    return { content: result?.message || "I could not link that Riot account." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const completeness = result.history_complete
    ? "Tracking covers the full month."
    : "Tracking began after the month started, so the monthly total may be incomplete.";

  return {
    embeds: [
      cleanEmbed({
        title: `Riot account linked • ${result.riot_id}`,
        description: "Your ranked account is connected to the Dojo RR tracker.",
        thumbnail: icon,
        fields: [
          {
            name: "Current rank",
            value: formatRank(result.current_rank, result.current_rr),
            inline: true,
          },
          {
            name: result.month || "This month",
            value: `**${signedNumber(result.monthly_rr)} RR**\n${result.games_counted || 0} games`,
            inline: true,
          },
          {
            name: "Next step",
            value: "Run **/sync** after you finish a ranked session.",
            inline: false,
          },
        ],
        footer: completeness,
      }),
    ],
  };
}

async function buildSyncPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    }
    if (result?.code === "RATE_LIMITED") {
      return {
        content: `Henrik is rate limited right now. Try **/sync** again in about ${result.retry_after || "60"} seconds.`,
      };
    }
    return { content: result?.message || "I could not sync your Riot account." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const imported = Number(result.new_matches_imported || 0);
  const syncDelta = Number(result.sync_rr_change || 0);

  return {
    embeds: [
      cleanEmbed({
        title: `Synced • ${result.riot_id}`,
        description:
          imported > 0
            ? `Found **${imported} new ${imported === 1 ? "game" : "games"}**.`
            : "No new ranked games were found.",
        thumbnail: icon,
        fields: [
          {
            name: "Since last sync",
            value: `**${signedNumber(syncDelta)} RR**\n${imported} new ${imported === 1 ? "game" : "games"}`,
            inline: true,
          },
          {
            name: "Current rank",
            value: formatRank(result.current_rank, result.current_rr),
            inline: true,
          },
          {
            name: result.month || "This month",
            value: `**${signedNumber(result.monthly_rr)} RR**\n${result.games_counted || 0} games`,
            inline: true,
          },
        ],
        footer: result.history_complete
          ? "Monthly history is complete."
          : "Monthly history may be incomplete because tracking began after the month started.",
      }),
    ],
  };
}

async function buildRrPayload(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") {
      return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    }
    return { content: result?.message || "I could not load your RR stats." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const heatmap = formatHeatmap(result.activity || []);
  const lastSync = result.last_sync
    ? `${signedNumber(result.last_sync.rr_delta)} RR • ${result.last_sync.new_matches} new ${result.last_sync.new_matches === 1 ? "game" : "games"}${formatRelativeTime(result.last_sync.synced_at)}`
    : "No manual sync yet";

  return {
    embeds: [
      cleanEmbed({
        title: `${result.riot_id} • RR Tracker`,
        description: `**${formatRank(result.current_rank, result.current_rr)}**`,
        thumbnail: icon,
        fields: [
          {
            name: "Last 12 hours",
            value: `**${signedNumber(result.recent_12h_rr)} RR**\n${result.recent_12h_games || 0} games`,
            inline: true,
          },
          {
            name: result.month || "This month",
            value: `**${signedNumber(result.monthly_rr)} RR**\n${result.games_counted || 0} games`,
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
            value: `**${result.active_days || 0} active days** • ${result.tracking_days || 0} days tracked`,
            inline: true,
          },
          {
            name: "Last sync",
            value: lastSync,
            inline: true,
          },
          {
            name: "Monthly activity",
            value: heatmap,
            inline: false,
          },
        ],
        footer: result.history_complete
          ? "Each square is one UTC day. Run /sync after your ranked session."
          : "Monthly total may be incomplete. Each square is one UTC day. Run /sync after your ranked session.",
      }),
    ],
  };
}

async function buildLeaderboardPayload(result) {
  if (!result?.ok) {
    return { content: result?.message || "I could not load the RR leaderboard." };
  }

  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!entries.length) {
    return { content: `No linked Dojo players are on the ${result.month} leaderboard yet.` };
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = entries.map((entry, index) => {
    const lead = medals[index] || `**${index + 1}.**`;
    const rank = entry.current_rank || "Unranked";
    const incomplete = entry.history_complete ? "" : " *";
    return `${lead} <@${entry.discord_user_id}>  **${signedNumber(entry.monthly_rr)} RR**\n└ ${rank} • ${entry.games_counted} games${incomplete}`;
  });

  const topIcon = await getRankIconUrl(entries[0]?.current_rank);
  const hasIncomplete = entries.some((entry) => !entry.history_complete);

  return {
    embeds: [
      cleanEmbed({
        title: `🏆 ${result.month} RR Leaderboard`,
        description: lines.join("\n\n"),
        thumbnail: topIcon,
        footer: hasIncomplete
          ? "* Monthly tracking may be incomplete for marked players."
          : "Net ranked RR from tracked games.",
      }),
    ],
  };
}

function cleanEmbed({ title, description, thumbnail, fields = [], footer }) {
  const embed = {
    color: VALORANT_RED,
    title,
    description,
    fields,
    timestamp: new Date().toISOString(),
  };

  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: footer };
  return embed;
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
  for (let i = 0; i < symbols.length; i += 7) {
    rows.push(symbols.slice(i, i + 7).join(""));
  }

  return `${rows.join("\n")}\n⬛ 0  🟥 1  🟧 2–3  🟨 4+  ▫️ upcoming`;
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank} • ${rr} RR`;
}

function signedNumber(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function formatRelativeTime(value) {
  if (!value) return "";
  const normalized = String(value).includes("T")
    ? String(value)
    : `${String(value).replace(" ", "T")}Z`;
  const ms = new Date(normalized).getTime();
  if (!Number.isFinite(ms)) return "";
  return ` • <t:${Math.floor(ms / 1000)}:R>`;
}

function getStringOption(interaction, name) {
  const options = Array.isArray(interaction.data?.options)
    ? interaction.data.options
    : [];
  const option = options.find((item) => item.name === name);
  return option?.value == null ? null : String(option.value).trim();
}

async function liveMemberHasDojoRole(interaction, discordUserId, env) {
  try {
    const response = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
      {
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        },
      },
    );

    if (response.ok) {
      const member = await response.json();
      return (
        Array.isArray(member.roles) &&
        member.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID || ""))
      );
    }
  } catch (error) {
    console.warn("Live Discord role lookup failed:", error);
  }

  const fallbackRoles = Array.isArray(interaction.member?.roles)
    ? interaction.member.roles.map(String)
    : [];
  return fallbackRoles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
}

async function editOriginalInteraction(interaction, env, payload) {
  const body =
    typeof payload === "string"
      ? { content: payload }
      : { ...(payload || { content: "Done." }) };

  body.allowed_mentions = { parse: [] };

  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    console.error(
      "Could not edit Discord interaction response:",
      response.status,
      await response.text(),
    );
  }
}

function interactionMessage(content) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

async function ensureEnhancedCommands(env) {
  if (
    !env.DISCORD_APP_ID ||
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_BOT_TOKEN ||
    !env.MEMBER_LINKS
  ) {
    throw new Error("Discord command registration variables are not configured");
  }

  const current = await env.MEMBER_LINKS.get("discord:enhanced_commands_version");
  if (current === ENHANCED_COMMANDS_VERSION) {
    return { ok: true, changed: false };
  }

  const endpoint =
    `${DISCORD_API}/applications/${env.DISCORD_APP_ID}` +
    `/guilds/${env.DISCORD_GUILD_ID}/commands`;

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(GUILD_COMMANDS),
  });

  if (!response.ok) {
    throw new Error(
      `Discord enhanced command registration ${response.status}: ${await response.text()}`,
    );
  }

  await Promise.all([
    env.MEMBER_LINKS.put(
      "discord:enhanced_commands_version",
      ENHANCED_COMMANDS_VERSION,
    ),
    env.MEMBER_LINKS.put("discord:commands_version", LEGACY_COMMANDS_VERSION),
  ]);

  return { ok: true, changed: true };
}

async function getRankIconUrl(rankName) {
  if (!rankName) return null;

  const cacheKey = "__dojoValorantRankIcons";
  const cacheTimeKey = "__dojoValorantRankIconsAt";
  const cached = globalThis[cacheKey];
  const cachedAt = Number(globalThis[cacheTimeKey] || 0);

  if (cached && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
    return cached.get(String(rankName).toLowerCase()) || null;
  }

  try {
    const result = await withTimeout(
      fetch("https://valorant-api.com/v1/competitivetiers"),
      1800,
    );
    if (!result.ok) return null;

    const body = await result.json();
    const icons = new Map();

    for (const tierSet of Array.isArray(body?.data) ? body.data : []) {
      for (const tier of Array.isArray(tierSet?.tiers) ? tierSet.tiers : []) {
        const name = tier?.tierName;
        const icon = tier?.largeIcon || tier?.smallIcon;
        if (name && icon) icons.set(String(name).toLowerCase(), String(icon));
      }
    }

    globalThis[cacheKey] = icons;
    globalThis[cacheTimeKey] = Date.now();
    return icons.get(String(rankName).toLowerCase()) || null;
  } catch {
    return null;
  }
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
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), ms);
    }),
  ]);
}
