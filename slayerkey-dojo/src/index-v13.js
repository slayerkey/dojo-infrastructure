import legacy, { DiscordGateway as DiscordGatewayV11 } from "./index-v11.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_OAUTH_TOKEN = "https://discord.com/api/oauth2/token";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_CONNECTED_ACCOUNTS_URL = "https://whop.com/@me/settings/connected-accounts/";
const VERIFY_CHANNEL_ID = "1497054385908220036";
const VERIFY_MESSAGE_ID = "1497057798989811792";
const VERIFY_EMOJI = "🔑";
const EPHEMERAL = 64;
const encoder = new TextEncoder();
const ACCESS_FALLBACK_STATUSES = new Set(["active", "trialing", "canceling", "completed"]);
const OAUTH_STATE_TTL_SECONDS = 600;
const OAUTH_REDIRECT_URI = "https://slayerkey-dojo.mystd.workers.dev/discord/oauth/callback";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/connect" && request.method === "GET") {
      return startDiscordOAuth(env);
    }

    if (url.pathname === "/discord/oauth/callback" && request.method === "GET") {
      return finishDiscordOAuth(url, env);
    }

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

      if (interaction.type === 2 && interaction.data?.name === "verify") {
        const discordUserId = String(interaction.member?.user?.id || interaction.user?.id || "");
        if (!discordUserId) return ephemeralMessage("I could not determine your Discord user ID.");

        ctx.waitUntil(
          verifyDiscordAccess(discordUserId, env, "Dojo slash verification")
            .then(async (result) => {
              const content = result.verified
                ? "Verified. Your Training Dojo role is active."
                : `I could not match this Discord account to active Training Dojo access yet.\n\nMake sure **this same Discord account** is connected on Whop: ${WHOP_CONNECTED_ACCOUNTS_URL}\n\nThen run **/verify** again or react with ${VERIFY_EMOJI}.`;
              await editOriginalInteraction(interaction, env, { content });
            })
            .catch(async (error) => {
              console.error("Canonical verify failed:", error);
              await editOriginalInteraction(interaction, env, {
                content: "Verification hit an error. Try **/verify** again in a moment.",
              }).catch(() => {});
            }),
        );

        return Response.json({ type: 5, data: { flags: EPHEMERAL } });
      }

      return legacy.fetch(delegated, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.access_resolver = "whop-customer-access-v13";
        body.discord.oauth_join = {
          enabled: true,
          configured: Boolean(env.DISCORD_CLIENT_SECRET),
          connect_path: "/discord/connect",
          callback_path: "/discord/oauth/callback",
          scopes: ["identify", "guilds.join"],
          email_scope_requested: false,
        };
        body.discord.verify_reaction = {
          channel_id: VERIFY_CHANNEL_ID,
          message_id: VERIFY_MESSAGE_ID,
          emoji: VERIFY_EMOJI,
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

export class DiscordGateway extends DiscordGatewayV11 {
  async handleGatewayMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return super.handleGatewayMessage(raw);
    }

    if (payload.op === 0 && payload.t === "GUILD_MEMBER_ADD") {
      if (payload.s != null) this.sequence = payload.s;
      this.lastEventAt = new Date().toISOString();

      const member = payload.d || {};
      if (String(member.guild_id || "") !== String(this.env.DISCORD_GUILD_ID || "")) return;
      if (member.user?.bot) return;

      this.lastMemberJoinAt = new Date().toISOString();
      const discordUserId = String(member.user?.id || "");
      if (!discordUserId) return;

      try {
        const result = await verifyDiscordAccess(
          discordUserId,
          this.env,
          "Automatic Dojo verification on server join",
        );
        this.lastVerification = {
          at: new Date().toISOString(),
          result: result.reason || (result.verified ? "verified" : "not_verified"),
        };
      } catch (error) {
        this.lastError = `Join verification failed: ${String(error)}`;
      }
      return;
    }

    if (
      payload.op === 0 &&
      payload.t === "MESSAGE_REACTION_ADD" &&
      String(payload.d?.guild_id || "") === String(this.env.DISCORD_GUILD_ID || "") &&
      String(payload.d?.channel_id || "") === VERIFY_CHANNEL_ID &&
      String(payload.d?.message_id || "") === VERIFY_MESSAGE_ID &&
      String(payload.d?.emoji?.name || "") === VERIFY_EMOJI
    ) {
      if (payload.s != null) this.sequence = payload.s;
      this.lastEventAt = new Date().toISOString();

      const userId = String(payload.d?.user_id || "");
      if (!userId || payload.d?.member?.user?.bot) return;

      try {
        const result = await verifyDiscordAccess(
          userId,
          this.env,
          "Dojo key reaction verification",
        );
        this.lastReactionVerification = {
          at: new Date().toISOString(),
          user_id: userId,
          verified: Boolean(result.verified),
          result: result.reason || (result.verified ? "verified" : "not_verified"),
        };

        if (!result.verified) {
          await sendVerificationDm(userId, this.env).catch(() => {});
        }
      } catch (error) {
        this.lastReactionVerification = {
          at: new Date().toISOString(),
          user_id: userId,
          verified: false,
          result: "error",
        };
        this.lastError = `Reaction verification failed: ${String(error)}`;
      }
      return;
    }

    return super.handleGatewayMessage(raw);
  }

  async startVerificationAudit(interactionToken) {
    const resolved = await getDojoCustomerUsers(this.env);
    const job = {
      id: crypto.randomUUID(),
      started_at: new Date().toISOString(),
      token: String(interactionToken || ""),
      users: resolved.users.map((item) => ({ userId: String(item.userId) })),
      index: 0,
      resolver_source: resolved.source,
      company_memberships_visible: resolved.company_memberships_visible || resolved.users.length,
      filtered_records_visible: resolved.filtered_records_visible || resolved.users.length,
      attempts: resolved.attempts || [],
      sample_keys: [],
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
    await editOriginalByToken(job.token, this.env, {
      content: `**Dojo verification audit running**\nChecked: **0/${job.users.length}**\n\nThis updates automatically as the scan continues.`,
    }).catch(() => {});

    if (!job.users.length) {
      job.status = "finished";
      job.finished_at = new Date().toISOString();
      await this.ctx.storage.put("verify_all_job", job);
      return { started: true, total: 0 };
    }

    await this.ctx.storage.setAlarm(Date.now() + 250);
    return { started: true, total: job.users.length };
  }
}

async function verifyDiscordAccess(discordUserId, env, reason) {
  const id = String(discordUserId || "");
  if (!id) return { verified: false, reason: "missing_discord_id" };

  if (id === String(env.DISCORD_OWNER_USER_ID || "")) {
    await grantDojoRole(id, null, env, reason);
    return { verified: true, reason: "owner" };
  }

  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${id}`, "json").catch(() => null);
    const whopUserId = String(reverse?.whop_user_id || "");
    if (whopUserId && await whopUserHasProductAccess(whopUserId, env)) {
      await grantDojoRole(id, whopUserId, env, reason);
      return { verified: true, reason: "cached_whop_link" };
    }
  }

  const resolved = await getDojoCustomerUsers(env);
  const users = resolved.users || [];

  // First use exact cached mappings, but only after confirming the Whop user currently has access.
  for (const item of users) {
    const whopUserId = String(item.userId || "");
    if (!whopUserId || !env.MEMBER_LINKS) continue;
    const cached = await env.MEMBER_LINKS.get(`whop:${whopUserId}`, "json").catch(() => null);
    if (String(cached?.discord_user_id || "") === id) {
      if (await whopUserHasProductAccess(whopUserId, env)) {
        await grantDojoRole(id, whopUserId, env, reason);
        return { verified: true, reason: "cached_whop_user" };
      }
    }
  }

  // Refresh social links live so a recently linked/relinked Discord account is never blocked by stale KV.
  for (let i = 0; i < users.length; i += 8) {
    const batch = users.slice(i, i + 8);
    const matches = await Promise.all(batch.map(async (item) => {
      const whopUserId = String(item.userId || "");
      if (!whopUserId) return null;
      const found = await resolveDiscordIdForWhopUser(whopUserId, env).catch(() => null);
      if (found && env.MEMBER_LINKS) await storeMemberLink(whopUserId, found, env);
      return String(found || "") === id ? whopUserId : null;
    }));

    const match = matches.find(Boolean);
    if (match && await whopUserHasProductAccess(match, env)) {
      await grantDojoRole(id, match, env, reason);
      return { verified: true, reason: "live_whop_link" };
    }
  }

  return { verified: false, reason: "no_active_whop_access" };
}

async function getDojoCustomerUsers(env) {
  const attempts = [];

  // Canonical path: Whop's member access_level=customer means the user currently has valid product access.
  try {
    const records = await fetchPaged("/members", env, (params) => {
      params.append("company_id", env.WHOP_COMPANY_ID);
      params.append("access_level", "customer");
      params.append("product_ids", env.WHOP_PRODUCT_ID);
    });
    attempts.push({ source: "members-customer-access", count: records.length });
    const users = dedupeUsers(records);
    if (users.length) {
      return {
        users,
        source: "members-customer-access",
        company_memberships_visible: records.length,
        filtered_records_visible: records.length,
        attempts,
      };
    }
  } catch (error) {
    attempts.push({ source: "members-customer-access", count: 0, error: shortError(error) });
  }

  // Fallback for older/permission-limited API keys. Include completed so paid-once/lifetime access is not dropped.
  try {
    const records = await fetchPaged("/memberships", env, (params) => {
      params.append("company_id", env.WHOP_COMPANY_ID);
      params.append("product_ids", env.WHOP_PRODUCT_ID);
    });
    attempts.push({ source: "memberships-product-fallback", count: records.length });
    const candidates = dedupeUsers(records.filter((record) => {
      const status = String(record?.status || record?.membership?.status || "");
      return !status || ACCESS_FALLBACK_STATUSES.has(status);
    }));

    const verified = [];
    for (let i = 0; i < candidates.length; i += 8) {
      const batch = candidates.slice(i, i + 8);
      const results = await Promise.all(batch.map(async (item) =>
        (await whopUserHasProductAccess(item.userId, env)) ? item : null,
      ));
      verified.push(...results.filter(Boolean));
    }

    return {
      users: verified,
      source: "memberships-plus-access-check",
      company_memberships_visible: records.length,
      filtered_records_visible: verified.length,
      attempts,
    };
  } catch (error) {
    attempts.push({ source: "memberships-product-fallback", count: 0, error: shortError(error) });
  }

  return { users: [], source: "no-access-result", attempts };
}

function dedupeUsers(records) {
  const users = new Map();
  for (const record of records || []) {
    const userId = String(
      record?.user?.id ||
      record?.user_id ||
      record?.member?.user?.id ||
      record?.membership?.user?.id ||
      "",
    );
    if (userId && !users.has(userId)) users.set(userId, { userId });
  }
  return [...users.values()];
}

async function whopUserHasProductAccess(userId, env) {
  const response = await fetch(
    `${WHOP_API}/users/${encodeURIComponent(userId)}/access/${encodeURIComponent(env.WHOP_PRODUCT_ID)}`,
    { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
  );
  if (!response.ok) return false;
  const body = await response.json();
  return Boolean(body?.has_access) && String(body?.access_level || "") === "customer";
}

async function resolveDiscordIdForWhopUser(userId, env) {
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
    if (!response.ok) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 180)}`);
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
}

async function startDiscordOAuth(env) {
  if (!env.DISCORD_CLIENT_SECRET) {
    return htmlPage(
      "Discord connection is not configured yet",
      "The Dojo Discord OAuth flow is ready in code, but the Discord client secret still needs to be added to Cloudflare.",
      503,
    );
  }
  if (!env.MEMBER_LINKS) return new Response("OAuth state storage is unavailable", { status: 503 });

  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await env.MEMBER_LINKS.put(`discord-oauth-state:${state}`, JSON.stringify({ created_at: new Date().toISOString() }), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    client_id: env.DISCORD_APP_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: "identify guilds.join",
    state,
  });
  return Response.redirect(`${DISCORD_OAUTH_AUTHORIZE}?${params.toString()}`, 302);
}

async function finishDiscordOAuth(url, env) {
  const error = url.searchParams.get("error");
  if (error) return htmlPage("Discord authorization canceled", "No changes were made.", 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !env.MEMBER_LINKS) {
    return htmlPage("Invalid Discord connection", "The authorization link is missing required information. Start again.", 400);
  }

  const stateKey = `discord-oauth-state:${state}`;
  const stored = await env.MEMBER_LINKS.get(stateKey, "json").catch(() => null);
  if (!stored) return htmlPage("Discord connection expired", "Start the Discord connection again.", 400);
  await env.MEMBER_LINKS.delete(stateKey).catch(() => {});

  if (!env.DISCORD_CLIENT_SECRET) return htmlPage("Discord connection unavailable", "OAuth is not configured yet.", 503);

  const tokenResponse = await fetch(DISCORD_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_APP_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  });
  if (!tokenResponse.ok) {
    return htmlPage("Discord connection failed", "Discord could not complete authorization. Start again.", 400);
  }

  const token = await tokenResponse.json();
  const accessToken = String(token?.access_token || "");
  if (!accessToken) return htmlPage("Discord connection failed", "Discord did not return an access token.", 400);

  const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) return htmlPage("Discord connection failed", "Could not read your Discord identity.", 400);
  const discordUser = await userResponse.json();
  const discordUserId = String(discordUser?.id || "");
  if (!discordUserId) return htmlPage("Discord connection failed", "Could not identify your Discord account.", 400);

  const match = await findWhopUserForDiscord(discordUserId, env);
  if (!match) {
    return htmlPage(
      "Training Dojo access not found",
      "This Discord account is not linked to an active Training Dojo member on Whop yet. Connect this same Discord account on Whop, then try again.",
      403,
      WHOP_CONNECTED_ACCOUNTS_URL,
      "Connect Discord on Whop",
    );
  }

  // Discord requires a user OAuth token with guilds.join here. The token is used once and never stored.
  const addMemberResponse = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );

  if (addMemberResponse.status !== 201 && addMemberResponse.status !== 204) {
    const body = await addMemberResponse.text();
    console.error("Discord OAuth guild join failed:", addMemberResponse.status, body.slice(0, 300));
    return htmlPage(
      "Could not join the Discord server",
      "Your account was verified, but Discord could not add you to the server. Make sure Dojo Bot has permission to create invites, then try again.",
      500,
    );
  }

  await grantDojoRole(discordUserId, match.whopUserId, env, "Dojo Discord OAuth verification");

  return htmlPage(
    "You're in the Training Dojo",
    "Discord is connected, your membership is verified, and your Training Dojo role is active. You can close this page and return to Discord.",
    200,
  );
}

async function findWhopUserForDiscord(discordUserId, env) {
  if (env.MEMBER_LINKS) {
    const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
    const whopUserId = String(reverse?.whop_user_id || "");
    if (whopUserId && await whopUserHasProductAccess(whopUserId, env)) {
      return { whopUserId, source: "cached" };
    }
  }

  const resolved = await getDojoCustomerUsers(env);
  for (let i = 0; i < resolved.users.length; i += 8) {
    const batch = resolved.users.slice(i, i + 8);
    const results = await Promise.all(batch.map(async (item) => {
      const whopUserId = String(item.userId || "");
      const found = await resolveDiscordIdForWhopUser(whopUserId, env).catch(() => null);
      if (found && env.MEMBER_LINKS) await storeMemberLink(whopUserId, found, env);
      return String(found || "") === String(discordUserId) ? whopUserId : null;
    }));
    const match = results.find(Boolean);
    if (match && await whopUserHasProductAccess(match, env)) return { whopUserId: match, source: "live" };
  }
  return null;
}

async function grantDojoRole(discordUserId, whopUserId, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": reason,
      },
    },
  );
  if (response.status !== 204) throw new Error(`Discord role add failed ${response.status}`);
  if (whopUserId && env.MEMBER_LINKS) await storeMemberLink(whopUserId, discordUserId, env);
  await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
}

async function storeMemberLink(userId, discordId, env) {
  if (!env.MEMBER_LINKS || !userId || !discordId) return;
  const now = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(`whop:${userId}`, JSON.stringify({ discord_user_id: String(discordId), updated_at: now })),
    env.MEMBER_LINKS.put(`discord:${discordId}`, JSON.stringify({ whop_user_id: String(userId), updated_at: now })),
  ]);
}

async function sendVerificationDm(discordUserId, env) {
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!channelResponse.ok) return;
  const channel = await channelResponse.json();
  if (!channel?.id) return;
  await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `I couldn't verify your Training Dojo access yet. Make sure this Discord account is linked on Whop, then react with ${VERIFY_EMOJI} again:\n${WHOP_CONNECTED_ACCOUNTS_URL}`,
      allowed_mentions: { parse: [] },
    }),
  });
}

function htmlPage(title, message, status = 200, link = null, linkLabel = null) {
  const button = link
    ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#5865F2;color:white;text-decoration:none;font-weight:700">${escapeHtml(linkLabel || "Continue")}</a></p>`
    : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:80px auto;padding:0 24px;line-height:1.5;background:#111;color:#f5f5f5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${button}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
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
  if (!response.ok) throw new Error(`Discord interaction edit ${response.status}`);
  return true;
}

function ephemeralMessage(content) {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

async function verifyDiscordSignature(headers, rawBody, publicKeyHex) {
  const signature = headers.get("X-Signature-Ed25519");
  const timestamp = headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), encoder.encode(timestamp + rawBody));
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  return bytes;
}

function shortError(error) {
  return String(error?.message || error || "error").slice(0, 140);
}
