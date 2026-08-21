import legacy, { DiscordGateway as DiscordGatewayV14 } from "./index-v14.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const COMMAND_TIMEOUT_MS = 25000;
const SYNC_COOLDOWN_SECONDS = 30;
const encoder = new TextEncoder();

const FAST_ACK_COMMANDS = new Set([
  "verify",
  "verify-all",
  "linkriot",
  "sync",
  "rr",
  "rrleaderboard",
]);

const RANK_ROLE_NAMES = [
  "Radiant",
  "Immortal",
  "Ascendant",
  "Diamond",
  "Platinum",
  "Gold",
  "Silver",
  "Bronze",
  "Iron",
  "Unranked",
];

const REGION_ROLE_ALIASES = {
  na: ["NA", "North America"],
  eu: ["EU", "Europe"],
  ap: ["AP", "APAC", "Asia Pacific"],
  kr: ["KR", "Korea"],
  latam: ["LATAM", "Latin America"],
  br: ["BR", "Brazil"],
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

      const command = interaction.data?.name;
      if (interaction.type === 2 && FAST_ACK_COMMANDS.has(command)) {
        if (command === "sync") {
          const discordUserId = getInteractionUserId(interaction);
          ctx.waitUntil(
            handleSync(interaction, discordUserId, env).catch(async (error) => {
              console.error("sync failed after acknowledgement:", error);
              await editOriginalInteraction(interaction, env, {
                content: "Something went wrong while syncing. Try **/sync** again in a moment.",
              }).catch(() => {});
            }),
          );
        } else {
          ctx.waitUntil(
            legacy.fetch(delegated, env, ctx).catch(async (error) => {
              console.error(`${command} failed after acknowledgement:`, error);
              await editOriginalInteraction(interaction, env, {
                content: `Something went wrong while running **/${command}**. Try again in a moment.`,
              }).catch(() => {});
            }),
          );
        }

        return Response.json({
          type: 5,
          data: command === "verify" || command === "verify-all" ? { flags: EPHEMERAL } : {},
        });
      }

      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.interaction_ack_mode = "immediate-v15";
        body.discord.sync_role_assignment = {
          enabled: true,
          rank_roles: RANK_ROLE_NAMES,
          region_roles: "exact-alias-match",
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
      return legacy.scheduled(controller, env, ctx);
    }
  },
};

export class DiscordGateway extends DiscordGatewayV14 {}

async function handleSync(interaction, discordUserId, env) {
  if (!discordUserId) {
    await editOriginalInteraction(interaction, env, { content: "I could not determine your Discord user ID." });
    return;
  }

  const remaining = await takeSyncCooldown(discordUserId, env);
  if (remaining > 0) {
    await editOriginalInteraction(interaction, env, {
      content: `You can use **/sync** again in **${remaining}s**.`,
    });
    return;
  }

  const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
  const member = await fetchDiscordMember(discordUserId, env).catch(() => null);
  const interactionRoles = Array.isArray(interaction.member?.roles)
    ? interaction.member.roles.map(String)
    : [];
  const liveRoles = member?.ok && Array.isArray(member.data?.roles)
    ? member.data.roles.map(String)
    : interactionRoles;
  const hasDojoRole = owner || liveRoles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));

  if (!hasDojoRole) {
    await editOriginalInteraction(interaction, env, {
      content: `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
    });
    return;
  }

  if (!env.RR_TRACKER) {
    await editOriginalInteraction(interaction, env, {
      content: "The RR tracker service is not connected right now.",
    });
    return;
  }

  const result = await withTimeout(
    env.RR_TRACKER.syncDiscordUser(discordUserId),
    COMMAND_TIMEOUT_MS,
  );

  let roleSync = null;
  if (result?.ok) {
    roleSync = await syncValorantRoles(
      discordUserId,
      result.current_rank,
      result.region,
      env,
      member?.ok ? member.data : null,
    ).catch((error) => ({ ok: false, errors: [String(error)] }));
  }

  const payload = await buildSyncPayload(result, roleSync);
  await editOriginalInteraction(interaction, env, payload);
}

async function syncValorantRoles(discordUserId, currentRank, region, env, existingMember = null) {
  const [rolesResponse, memberResult] = await Promise.all([
    fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    }),
    existingMember
      ? Promise.resolve({ ok: true, data: existingMember })
      : fetchDiscordMember(discordUserId, env),
  ]);

  if (!rolesResponse.ok) {
    return { ok: false, errors: [`role list ${rolesResponse.status}`] };
  }
  if (!memberResult?.ok) {
    return { ok: false, errors: [`member lookup ${memberResult?.status || "failed"}`] };
  }

  const guildRoles = await rolesResponse.json();
  const memberRoleIds = new Set((memberResult.data?.roles || []).map(String));
  const rolesByName = new Map(
    (Array.isArray(guildRoles) ? guildRoles : []).map((role) => [String(role.name || "").toLowerCase(), role]),
  );

  const desiredRankName = rankRoleName(currentRank);
  const rankRoles = RANK_ROLE_NAMES
    .map((name) => rolesByName.get(name.toLowerCase()))
    .filter(Boolean);
  const targetRankRole = desiredRankName
    ? rolesByName.get(desiredRankName.toLowerCase()) || null
    : null;

  const normalizedRegion = String(region || "").trim().toLowerCase();
  const desiredRegionAliases = REGION_ROLE_ALIASES[normalizedRegion] || [];
  const allRegionAliasNames = new Set(
    Object.values(REGION_ROLE_ALIASES).flat().map((name) => name.toLowerCase()),
  );
  const regionRoles = [...rolesByName.entries()]
    .filter(([name]) => allRegionAliasNames.has(name))
    .map(([, role]) => role);
  const targetRegionRole = desiredRegionAliases
    .map((name) => rolesByName.get(name.toLowerCase()))
    .find(Boolean) || null;

  const errors = [];
  const removed = [];
  const added = [];

  for (const role of rankRoles) {
    if (targetRankRole && String(role.id) === String(targetRankRole.id)) continue;
    if (!memberRoleIds.has(String(role.id))) continue;
    const changed = await changeDiscordRoleById(discordUserId, role.id, false, env, "Valorant rank sync");
    if (changed.ok) {
      memberRoleIds.delete(String(role.id));
      removed.push(role.name);
    } else {
      errors.push(`remove ${role.name}: ${changed.status}`);
    }
  }

  if (targetRankRole && !memberRoleIds.has(String(targetRankRole.id))) {
    const changed = await changeDiscordRoleById(discordUserId, targetRankRole.id, true, env, "Valorant rank sync");
    if (changed.ok) {
      memberRoleIds.add(String(targetRankRole.id));
      added.push(targetRankRole.name);
    } else {
      errors.push(`add ${targetRankRole.name}: ${changed.status}`);
    }
  }

  if (targetRegionRole) {
    for (const role of regionRoles) {
      if (String(role.id) === String(targetRegionRole.id)) continue;
      if (!memberRoleIds.has(String(role.id))) continue;
      const changed = await changeDiscordRoleById(discordUserId, role.id, false, env, "Valorant region sync");
      if (changed.ok) {
        memberRoleIds.delete(String(role.id));
        removed.push(role.name);
      } else {
        errors.push(`remove ${role.name}: ${changed.status}`);
      }
    }

    if (!memberRoleIds.has(String(targetRegionRole.id))) {
      const changed = await changeDiscordRoleById(discordUserId, targetRegionRole.id, true, env, "Valorant region sync");
      if (changed.ok) {
        memberRoleIds.add(String(targetRegionRole.id));
        added.push(targetRegionRole.name);
      } else {
        errors.push(`add ${targetRegionRole.name}: ${changed.status}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    desired_rank: desiredRankName,
    rank_role_found: Boolean(targetRankRole),
    region: normalizedRegion || null,
    region_role_found: Boolean(targetRegionRole),
    added,
    removed,
    errors,
  };
}

function rankRoleName(rankName) {
  const rank = String(rankName || "").trim().toLowerCase();
  if (!rank || rank === "unknown") return null;
  if (rank === "unrated" || rank === "unranked") return "Unranked";
  return RANK_ROLE_NAMES.find(
    (name) => rank === name.toLowerCase() || rank.startsWith(`${name.toLowerCase()} `),
  ) || null;
}

async function changeDiscordRoleById(discordUserId, roleId, add, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
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

async function takeSyncCooldown(discordUserId, env) {
  if (!env.MEMBER_LINKS) return 0;
  const key = `cooldown:v15:sync:${discordUserId}`;
  const now = Date.now();
  const existing = Number(await env.MEMBER_LINKS.get(key) || 0);
  if (existing > now) return Math.max(1, Math.ceil((existing - now) / 1000));
  await env.MEMBER_LINKS.put(key, String(now + SYNC_COOLDOWN_SECONDS * 1000), {
    expirationTtl: 60,
  });
  return 0;
}

async function buildSyncPayload(result, roleSync) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return { content: "No Riot account is linked yet. Use **/linkriot** first." };
    if (result?.code === "RATE_LIMITED") {
      return {
        content: `The Riot tracker is rate limited right now. Try **/sync** again in about ${result.retry_after || 60} seconds.`,
      };
    }
    return { content: result?.message || "I could not sync your Riot account." };
  }

  const icon = await getRankIconUrl(result.current_rank);
  const imported = Number(result.new_matches_imported || 0);
  let footer = historyWarning(result);
  if (roleSync && !roleSync.ok) {
    footer = joinFooter(footer, "RR synced, but a Discord rank/region role could not be updated.");
  } else if (roleSync?.desired_rank && !roleSync.rank_role_found) {
    footer = joinFooter(footer, `RR synced, but I could not find the ${roleSync.desired_rank} Discord role.`);
  }

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
      footer,
    })],
  };
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

function cleanEmbed({ title, description, thumbnail, fields = [], footer }) {
  const embed = { color: VALORANT_RED, title, fields };
  if (description) embed.description = description;
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (footer) embed.footer = { text: footer };
  return embed;
}

async function getRankIconUrl(rankName) {
  if (!rankName) return null;
  const cacheKey = "__dojoValorantRankIconsV15";
  const timeKey = "__dojoValorantRankIconsV15At";
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

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
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
  if (!response.ok) {
    console.error("Could not edit interaction:", response.status, await response.text());
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
    new Promise((_, reject) => setTimeout(() => reject(new Error("COMMAND_TIMEOUT")), ms)),
  ]);
}
