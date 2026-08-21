const WHOP_API = "https://api.whop.com/api/v1";
const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API_VERSION_DATE = "2026-08-13";
const COMMANDS_VERSION = "2026-08-21-v1";
const EPHEMERAL = 64;
const encoder = new TextEncoder();

const ACCESS_STATUSES = new Set(["active", "trialing", "canceling"]);

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
    name: "linkriot",
    description: "Link your Riot account to the Dojo RR tracker",
    type: 1,
    integration_types: [0],
    contexts: [0],
    options: [
      {
        name: "riot_id",
        description: "Your Riot ID, for example Slayerkey#NA1",
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
    description: "Show your current rank and monthly net RR",
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

    if (url.pathname === "/") {
      return new Response("Slayerkey Dojo Sync is running.", { status: 200 });
    }

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname.startsWith("/dashboard/")) {
      return handleDashboard(env);
    }

    if (url.pathname === "/discord/interactions") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleDiscordInteraction(request, env, ctx);
    }

    if (url.pathname === "/whop/webhook") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleWhopWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
};

async function runScheduledMaintenance(env) {
  const results = await Promise.allSettled([
    reconcileActiveMemberships(env),
    ensureGuildCommands(env),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Scheduled maintenance task failed:", result.reason);
    }
  }
}

async function handleDiscordInteraction(request, env, ctx) {
  if (!env.DISCORD_PUBLIC_KEY) {
    return new Response("Discord public key not configured", { status: 503 });
  }

  const rawBody = await request.text();
  const valid = await verifyDiscordSignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);
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
    ctx.waitUntil(ensureGuildCommands(env));
    return Response.json({ type: 1 });
  }

  if (interaction.type !== 2) {
    return interactionMessage("Unsupported interaction type.", true);
  }

  if (interaction.guild_id !== env.DISCORD_GUILD_ID) {
    return interactionMessage("This command only works in the Slayerkey Discord server.", true);
  }

  const commandName = interaction.data?.name;
  const supported = new Set(GUILD_COMMANDS.map((command) => command.name));
  if (!supported.has(commandName)) {
    return interactionMessage("Unknown command.", true);
  }

  ctx.waitUntil(
    executeDiscordCommand(interaction, env)
      .then((message) => editOriginalInteraction(interaction, env, message))
      .catch(async (error) => {
        console.error(`Discord command ${commandName} failed:`, error);
        await editOriginalInteraction(
          interaction,
          env,
          "Something went wrong while running that command. Try again in a moment.",
        );
      }),
  );

  return Response.json({
    type: 5,
    data: { flags: EPHEMERAL },
  });
}

async function executeDiscordCommand(interaction, env) {
  const commandName = interaction.data?.name;
  const discordUserId = String(interaction.member?.user?.id || interaction.user?.id || "");
  const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.map(String) : [];
  const hasDojoRole = roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));

  if (!discordUserId) {
    return "I could not determine your Discord user ID.";
  }

  if (commandName === "verify") {
    return commandVerify(discordUserId, env);
  }

  if (commandName === "verify-all") {
    if (discordUserId !== String(env.DISCORD_OWNER_USER_ID || "")) {
      return "This command is owner only.";
    }
    const result = await reconcileActiveMemberships(env);
    return `Verification finished. Active roles checked: **${result.active_processed}**. Stale roles removed: **${result.removed_processed}**.`;
  }

  if (!hasDojoRole) {
    return "You need the Training Dojo role to use this command. Run **/verify** first.";
  }

  if (!env.RR_TRACKER) {
    return "The RR tracker service is not connected yet.";
  }

  if (commandName === "linkriot") {
    const riotId = getStringOption(interaction, "riot_id");
    if (!riotId) {
      return "Enter your Riot ID in the format **Name#Tag**.";
    }

    const result = await env.RR_TRACKER.linkRiot(discordUserId, riotId, "na");
    return formatLinkResult(result);
  }

  if (commandName === "sync") {
    const result = await env.RR_TRACKER.syncDiscordUser(discordUserId);
    return formatSyncResult(result);
  }

  if (commandName === "rr") {
    const result = await env.RR_TRACKER.getDiscordUserStats(discordUserId);
    return formatRrStats(result);
  }

  if (commandName === "rrleaderboard") {
    const result = await env.RR_TRACKER.getLeaderboard(10);
    return formatLeaderboard(result);
  }

  return "Unknown command.";
}

async function commandVerify(discordUserId, env) {
  const result = await verifyDiscordMembership(discordUserId, env);

  if (result.active) {
    if (env.RR_TRACKER) {
      try {
        await env.RR_TRACKER.setMemberActive(discordUserId, true);
      } catch (error) {
        console.warn("Could not mark RR member active:", error);
      }
    }
    return result.already_had_role
      ? "Your Training Dojo membership is active and your role is already verified."
      : "Verified. Your Training Dojo role has been added.";
  }

  if (env.RR_TRACKER) {
    try {
      await env.RR_TRACKER.setMemberActive(discordUserId, false);
    } catch (error) {
      console.warn("Could not mark RR member inactive:", error);
    }
  }

  return "I could not find an active Training Dojo membership connected to this Discord account.";
}

function formatLinkResult(result) {
  if (!result?.ok) {
    if (result?.code === "ALREADY_LINKED") return result.message;
    if (result?.code === "RIOT_ACCOUNT_IN_USE") return result.message;
    if (result?.code === "RATE_LIMITED") {
      return `Henrik is rate limited right now. Try **/linkriot** again in about ${result.retry_after || "60"} seconds.`;
    }
    return result?.message || "I could not link that Riot account.";
  }

  const rr = signedNumber(result.monthly_rr);
  const current = rankLine(result.current_rank, result.current_rr);
  const completeness = result.history_complete
    ? ""
    : "\nTracking started after the beginning of the month, so this month's total may be incomplete.";

  return `Linked **${result.riot_id}**.\n${current}\nThis month: **${rr} RR** across **${result.games_counted}** games.${completeness}\n\nRun **/sync** after you finish playing each day.`;
}

function formatSyncResult(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return "No Riot account is linked yet. Use **/linkriot** first.";
    if (result?.code === "RATE_LIMITED") {
      return `Henrik is rate limited right now. Try **/sync** again in about ${result.retry_after || "60"} seconds.`;
    }
    return result?.message || "I could not sync your Riot account.";
  }

  const imported = Number(result.new_matches_imported || 0);
  const rr = signedNumber(result.monthly_rr);
  const current = rankLine(result.current_rank, result.current_rr);
  const gameText = imported === 1 ? "1 new game" : `${imported} new games`;
  const completeness = result.history_complete
    ? ""
    : "\nThis month's total may be incomplete because tracking began after the month started.";

  return `Synced **${result.riot_id}**. Imported **${gameText}**.\n${current}\n${result.month}: **${rr} RR** across **${result.games_counted}** games.${completeness}`;
}

function formatRrStats(result) {
  if (!result?.ok) {
    if (result?.code === "NOT_LINKED") return "No Riot account is linked yet. Use **/linkriot** first.";
    return result?.message || "I could not load your RR stats.";
  }

  const completeness = result.history_complete
    ? ""
    : "\nTracking started after the beginning of the month, so this month's total may be incomplete.";

  return `**${result.riot_id}**\n${rankLine(result.current_rank, result.current_rr)}\n${result.month}: **${signedNumber(result.monthly_rr)} RR** across **${result.games_counted}** games.${completeness}`;
}

function formatLeaderboard(result) {
  if (!result?.ok) {
    return result?.message || "I could not load the RR leaderboard.";
  }

  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (entries.length === 0) {
    return `No linked Dojo players are on the ${result.month} leaderboard yet.`;
  }

  const lines = entries.map((entry) => {
    const rank = entry.current_rank ? ` • ${entry.current_rank}` : "";
    const incomplete = entry.history_complete ? "" : " *";
    return `**${entry.position}.** <@${entry.discord_user_id}> • **${entry.riot_id}** • **${signedNumber(entry.monthly_rr)} RR** • ${entry.games_counted} games${rank}${incomplete}`;
  });

  const hasIncomplete = entries.some((entry) => !entry.history_complete);
  return `**${result.month} RR Leaderboard**\n${lines.join("\n")}${hasIncomplete ? "\n\n* Monthly tracking may be incomplete for this player." : ""}`;
}

function rankLine(rank, rr) {
  if (!rank) return "Current rank: **Unknown**";
  if (rr == null) return `Current rank: **${rank}**`;
  return `Current rank: **${rank} ${rr} RR**`;
}

function signedNumber(value) {
  const number = Number(value || 0);
  return number > 0 ? `+${number}` : String(number);
}

function getStringOption(interaction, name) {
  const options = Array.isArray(interaction.data?.options) ? interaction.data.options : [];
  const option = options.find((item) => item.name === name);
  return option?.value == null ? null : String(option.value).trim();
}

async function editOriginalInteraction(interaction, env, content) {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: String(content).slice(0, 2000),
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    console.error("Could not edit Discord interaction response:", response.status, await response.text());
  }
}

function interactionMessage(content, ephemeral = false) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: ephemeral ? EPHEMERAL : 0,
      allowed_mentions: { parse: [] },
    },
  });
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
  } catch (error) {
    console.error("Discord signature verification failed:", error);
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

async function ensureGuildCommands(env) {
  if (
    !env.DISCORD_APP_ID ||
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_BOT_TOKEN ||
    !env.MEMBER_LINKS
  ) {
    throw new Error("Discord command registration variables are not configured");
  }

  const currentVersion = await env.MEMBER_LINKS.get("discord:commands_version");
  if (currentVersion === COMMANDS_VERSION) {
    return { ok: true, changed: false, version: COMMANDS_VERSION };
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
    const body = await response.text();
    throw new Error(`Discord command registration ${response.status}: ${body}`);
  }

  const commands = await response.json();
  await env.MEMBER_LINKS.put("discord:commands_version", COMMANDS_VERSION);
  console.log(`Registered ${commands.length} Discord guild commands.`);
  return { ok: true, changed: true, version: COMMANDS_VERSION, count: commands.length };
}

async function handleWhopWebhook(request, env, ctx) {
  if (!env.WHOP_WEBHOOK_SECRET) {
    console.error("WHOP_WEBHOOK_SECRET is not configured.");
    return new Response("Webhook secret not configured", { status: 503 });
  }

  const rawBody = await request.text();
  const valid = await verifyWhopWebhook(request.headers, rawBody, env.WHOP_WEBHOOK_SECRET);

  if (!valid) {
    console.error("Invalid Whop webhook signature.");
    return new Response("Invalid signature", { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "membership.activated" && event.type !== "membership.deactivated") {
    return new Response("Ignored", { status: 200 });
  }

  const companyId = event.company_id || event.data?.company?.id;
  const productId = event.data?.product?.id;

  if (companyId !== env.WHOP_COMPANY_ID) {
    return new Response("Ignored company", { status: 200 });
  }

  if (productId !== env.WHOP_PRODUCT_ID) {
    return new Response("Ignored product", { status: 200 });
  }

  ctx.waitUntil(processMembershipEvent(event, env));
  return new Response("OK", { status: 200 });
}

async function processMembershipEvent(event, env) {
  const membershipId = event.data?.id;
  const fallbackUserId = event.data?.user?.id;
  if (!membershipId) {
    console.error("Webhook is missing membership ID.");
    return;
  }

  let membership = event.data;
  try {
    membership = await whopGet(`/memberships/${encodeURIComponent(membershipId)}`, env);
  } catch (error) {
    console.error("Unable to retrieve current membership state. Falling back to webhook state.", error);
  }

  const userId = membership?.user?.id || fallbackUserId;
  if (!userId) return;

  const currentProduct = membership?.product?.id || event.data?.product?.id;
  if (currentProduct !== env.WHOP_PRODUCT_ID) return;

  const shouldHaveAccess = membership?.status
    ? ACCESS_STATUSES.has(membership.status)
    : event.type === "membership.activated";

  await syncUserRole(userId, shouldHaveAccess, env);
}

async function getDiscordIdFromWhop(userId, env) {
  const user = await whopGet(`/users/${encodeURIComponent(userId)}`, env);
  const accounts = Array.isArray(user.social_accounts) ? user.social_accounts : [];
  const discord = accounts.find(
    (account) => account.platform === "discord" && account.external_id,
  );
  return discord ? String(discord.external_id) : null;
}

async function storeMemberLink(userId, discordId, env, granted = false) {
  if (!env.MEMBER_LINKS || !userId || !discordId) return;

  const timestamp = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${userId}`,
      JSON.stringify({
        discord_user_id: String(discordId),
        ...(granted ? { last_granted_at: timestamp } : {}),
      }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({
        whop_user_id: String(userId),
        updated_at: timestamp,
      }),
    ),
  ]);
}

async function syncUserRole(userId, shouldHaveAccess, env) {
  let discordId = null;

  try {
    discordId = await getDiscordIdFromWhop(userId, env);
  } catch (error) {
    console.error(`Could not retrieve Whop social accounts for ${userId}:`, error);
  }

  if (!discordId && env.MEMBER_LINKS) {
    try {
      const stored = await env.MEMBER_LINKS.get(`whop:${userId}`, "json");
      discordId = stored?.discord_user_id || null;
    } catch (error) {
      console.error("KV lookup failed:", error);
    }
  }

  if (!discordId) {
    console.log(`No Discord account currently linked for Whop user ${userId}.`);
    return { success: false, reason: "no_discord" };
  }

  const result = await changeDiscordRole(discordId, shouldHaveAccess, env);
  if (result.success) {
    await storeMemberLink(userId, discordId, env, shouldHaveAccess);
    if (env.RR_TRACKER) {
      try {
        await env.RR_TRACKER.setMemberActive(discordId, shouldHaveAccess);
      } catch (error) {
        console.warn("Could not update RR member status:", error);
      }
    }
  }

  return { ...result, discord_id: discordId };
}

async function changeDiscordRole(discordUserId, add, env) {
  const endpoint =
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}` +
    `/members/${discordUserId}` +
    `/roles/${env.DISCORD_DOJO_ROLE_ID}`;

  const response = await fetch(endpoint, {
    method: add ? "PUT" : "DELETE",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "X-Audit-Log-Reason": add
        ? "Active Slayerkey Training Dojo membership"
        : "Training Dojo membership deactivated",
    },
  });

  if (response.status === 204) {
    return { success: true, status: 204 };
  }

  const body = await response.text();
  if (response.status === 404) {
    return { success: false, status: 404, body };
  }

  console.error(`Discord role request failed (${response.status}):`, body);
  return { success: false, status: response.status, body };
}

async function discordMemberHasRole(discordUserId, env) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );

  if (!response.ok) return false;
  const member = await response.json();
  return Array.isArray(member.roles) && member.roles.map(String).includes(String(env.DISCORD_DOJO_ROLE_ID));
}

async function verifyDiscordMembership(discordUserId, env) {
  const alreadyHadRole = await discordMemberHasRole(discordUserId, env);
  const cached = env.MEMBER_LINKS
    ? await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null)
    : null;

  if (cached?.whop_user_id) {
    const membership = await findActiveMembershipForWhopUser(cached.whop_user_id, env);
    if (membership) {
      const roleResult = await changeDiscordRole(discordUserId, true, env);
      if (roleResult.success) {
        await storeMemberLink(cached.whop_user_id, discordUserId, env, true);
        return { active: true, already_had_role: alreadyHadRole };
      }
    }
  }

  const memberships = await fetchAllCompanyMemberships(env);
  const active = memberships.filter(
    (membership) =>
      membership?.product?.id === env.WHOP_PRODUCT_ID &&
      ACCESS_STATUSES.has(membership.status),
  );

  for (const membership of active) {
    const userId = membership?.user?.id;
    if (!userId) continue;

    if (env.MEMBER_LINKS) {
      const stored = await env.MEMBER_LINKS.get(`whop:${userId}`, "json").catch(() => null);
      if (String(stored?.discord_user_id || "") === discordUserId) {
        const roleResult = await changeDiscordRole(discordUserId, true, env);
        if (roleResult.success) {
          await storeMemberLink(userId, discordUserId, env, true);
          return { active: true, already_had_role: alreadyHadRole };
        }
      }
    }
  }

  for (let i = 0; i < active.length; i += 10) {
    const batch = active.slice(i, i + 10);
    const resolved = await Promise.all(
      batch.map(async (membership) => {
        const userId = membership?.user?.id;
        if (!userId) return null;
        try {
          const foundDiscord = await getDiscordIdFromWhop(userId, env);
          return foundDiscord === discordUserId ? { userId } : null;
        } catch {
          return null;
        }
      }),
    );

    const match = resolved.find(Boolean);
    if (match) {
      const roleResult = await changeDiscordRole(discordUserId, true, env);
      if (roleResult.success) {
        await storeMemberLink(match.userId, discordUserId, env, true);
        return { active: true, already_had_role: alreadyHadRole };
      }
    }
  }

  if (alreadyHadRole) {
    await changeDiscordRole(discordUserId, false, env);
  }
  return { active: false, already_had_role: alreadyHadRole };
}

async function findActiveMembershipForWhopUser(userId, env) {
  const memberships = await fetchAllCompanyMemberships(env);
  return (
    memberships.find(
      (membership) =>
        membership?.user?.id === userId &&
        membership?.product?.id === env.WHOP_PRODUCT_ID &&
        ACCESS_STATUSES.has(membership.status),
    ) || null
  );
}

async function fetchAllCompanyMemberships(env) {
  let after = null;
  const all = [];

  do {
    const params = new URLSearchParams();
    params.set("company_id", env.WHOP_COMPANY_ID);
    params.set("first", "100");
    if (after) params.set("after", after);

    const page = await whopGet(`/memberships?${params.toString()}`, env);
    if (Array.isArray(page.data)) all.push(...page.data);

    const pageInfo = page.page_info || {};
    after = pageInfo.has_next_page && pageInfo.end_cursor ? pageInfo.end_cursor : null;
  } while (after);

  return all;
}

async function reconcileActiveMemberships(env) {
  console.log("Starting Dojo membership reconciliation.");
  const memberships = await fetchAllCompanyMemberships(env);
  const activeMemberships = memberships.filter(
    (membership) =>
      membership?.product?.id === env.WHOP_PRODUCT_ID &&
      ACCESS_STATUSES.has(membership.status),
  );
  const activeUserIds = new Set(
    activeMemberships.map((membership) => membership?.user?.id).filter(Boolean),
  );

  let activeProcessed = 0;
  let removedProcessed = 0;

  for (let i = 0; i < activeMemberships.length; i += 10) {
    const batch = activeMemberships.slice(i, i + 10);
    await Promise.all(
      batch.map(async (membership) => {
        const userId = membership?.user?.id;
        if (!userId) return;
        const result = await syncUserRole(userId, true, env);
        if (result.success) activeProcessed += 1;
      }),
    );
  }

  if (env.MEMBER_LINKS) {
    let cursor;
    do {
      const listed = await env.MEMBER_LINKS.list({ prefix: "whop:", cursor });
      for (const key of listed.keys || []) {
        const userId = key.name.slice("whop:".length);
        if (!userId || activeUserIds.has(userId)) continue;

        const stored = await env.MEMBER_LINKS.get(key.name, "json").catch(() => null);
        const discordId = stored?.discord_user_id;
        if (!discordId) continue;

        const result = await changeDiscordRole(discordId, false, env);
        if (result.success || result.status === 404) {
          removedProcessed += 1;
          if (env.RR_TRACKER) {
            try {
              await env.RR_TRACKER.setMemberActive(discordId, false);
            } catch (error) {
              console.warn("Could not update RR member status:", error);
            }
          }
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }

  console.log(
    `Reconciliation completed. Active processed: ${activeProcessed}. Removed: ${removedProcessed}.`,
  );

  return {
    active_processed: activeProcessed,
    removed_processed: removedProcessed,
    active_memberships: activeMemberships.length,
  };
}

async function whopGet(path, env) {
  const response = await fetch(`${WHOP_API}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.WHOP_API_KEY}`,
      "Api-Version-Date": WHOP_API_VERSION_DATE,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whop API ${response.status}: ${body}`);
  }

  return response.json();
}

async function verifyWhopWebhook(headers, rawBody, secret) {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const timestampNumber = Number(webhookTimestamp);
  if (!Number.isFinite(timestampNumber)) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampNumber);
  if (ageSeconds > 300) return false;

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  for (const candidate of webhookSignature.split(" ")) {
    const comma = candidate.indexOf(",");
    if (comma === -1) continue;

    const version = candidate.slice(0, comma);
    const base64Signature = candidate.slice(comma + 1);
    if (version !== "v1") continue;

    try {
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        base64ToBytes(base64Signature),
        encoder.encode(signedContent),
      );
      if (valid) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleHealth(env) {
  const result = {
    worker: "ok",
    variables: {
      WHOP_COMPANY_ID: Boolean(env.WHOP_COMPANY_ID),
      WHOP_PRODUCT_ID: Boolean(env.WHOP_PRODUCT_ID),
      WHOP_API_KEY: Boolean(env.WHOP_API_KEY),
      DISCORD_GUILD_ID: Boolean(env.DISCORD_GUILD_ID),
      DISCORD_DOJO_ROLE_ID: Boolean(env.DISCORD_DOJO_ROLE_ID),
      DISCORD_BOT_TOKEN: Boolean(env.DISCORD_BOT_TOKEN),
      DISCORD_APP_ID: Boolean(env.DISCORD_APP_ID),
      DISCORD_PUBLIC_KEY: Boolean(env.DISCORD_PUBLIC_KEY),
      DISCORD_OWNER_USER_ID: Boolean(env.DISCORD_OWNER_USER_ID),
      WHOP_WEBHOOK_SECRET: Boolean(env.WHOP_WEBHOOK_SECRET),
      MEMBER_LINKS: Boolean(env.MEMBER_LINKS),
      RR_TRACKER: Boolean(env.RR_TRACKER),
    },
    whop: { ok: false },
    discord: { ok: false },
    rr_tracker: { ok: false },
  };

  try {
    const params = new URLSearchParams();
    params.set("company_id", env.WHOP_COMPANY_ID);
    params.set("first", "1");
    const page = await whopGet(`/memberships?${params.toString()}`, env);
    result.whop = {
      ok: true,
      membership_count: page.total_count ?? page.data?.length ?? null,
    };
  } catch (error) {
    result.whop = { ok: false, error: String(error) };
  }

  try {
    const botResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    if (!botResponse.ok) throw new Error(`Discord API returned ${botResponse.status}`);
    const bot = await botResponse.json();

    const rolesResponse = await fetch(
      `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
    );
    if (!rolesResponse.ok) {
      throw new Error(`Could not access guild roles: ${rolesResponse.status}`);
    }
    const roles = await rolesResponse.json();

    const commandVersion = env.MEMBER_LINKS
      ? await env.MEMBER_LINKS.get("discord:commands_version")
      : null;

    result.discord = {
      ok: true,
      bot_username: bot.username,
      bot_id: bot.id,
      target_role_found: roles.some((role) => role.id === env.DISCORD_DOJO_ROLE_ID),
      commands_registered: commandVersion === COMMANDS_VERSION,
      commands_version: commandVersion,
    };
  } catch (error) {
    result.discord = { ok: false, error: String(error) };
  }

  if (env.RR_TRACKER) {
    try {
      const rrHealth = await env.RR_TRACKER.health();
      result.rr_tracker = { ok: rrHealth?.status === "ok", ...rrHealth };
    } catch (error) {
      result.rr_tracker = { ok: false, error: String(error) };
    }
  }

  return Response.json(result, { status: 200 });
}

async function handleDashboard(env) {
  const response = await handleHealth(env);
  const health = await response.json();
  const escapeHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  return new Response(
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dojo Discord Sync</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; padding: 32px; line-height: 1.5; }
    .card { max-width: 760px; margin: 0 auto; padding: 24px; background: #1b1b1b; border: 1px solid #333; border-radius: 14px; }
    .good { color: #62d98b; }
    .bad { color: #ff7777; }
    pre { overflow: auto; background: #0d0d0d; padding: 16px; border-radius: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Dojo Discord Sync</h1>
    <p class="${health.whop.ok ? "good" : "bad"}">Whop: ${health.whop.ok ? "Connected" : "Error"}</p>
    <p class="${health.discord.ok ? "good" : "bad"}">Discord: ${health.discord.ok ? "Connected" : "Error"}</p>
    <p class="${health.rr_tracker.ok ? "good" : "bad"}">RR tracker: ${health.rr_tracker.ok ? "Connected" : "Error"}</p>
    <p>Discord target role: ${health.discord?.target_role_found ? "Found" : "Not confirmed"}</p>
    <p>Discord commands: ${health.discord?.commands_registered ? "Registered" : "Pending"}</p>
    <p>Webhook secret: ${health.variables?.WHOP_WEBHOOK_SECRET ? "Configured" : "Not configured"}</p>
    <pre>${escapeHtml(JSON.stringify(health, null, 2))}</pre>
  </div>
</body>
</html>`,
    { headers: { "content-type": "text/html;charset=UTF-8" } },
  );
}
