import legacy, { DiscordGateway as DiscordGatewayV17 } from "./index-v17.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_OAUTH_TOKEN = "https://discord.com/api/oauth2/token";
const WHOP_API = "https://api.whop.com/api/v1";
const WHOP_CONNECTED_ACCOUNTS_URL = "https://whop.com/@me/settings/connected-accounts/";
const OAUTH_REDIRECT_URI = "https://slayerkey-dojo.mystd.workers.dev/discord/oauth/callback";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const FRESH_ACCESS_TTL_MS = 2 * 60 * 60 * 1000;
const ACCESS_FALLBACK_STATUSES = new Set(["active", "trialing", "canceling", "completed"]);
const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // A signed membership.activated webhook is the earliest reliable signal that a
    // brand-new buyer has access. Record it in the existing Durable Object so the
    // Discord join flow does not wait for Whop's read/list APIs to catch up.
    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      const delegated = request.clone();
      const rawBody = await request.text();
      const event = await parseVerifiedWhopEvent(request.headers, rawBody, env);

      if (event && isDojoMembershipEvent(event, env)) {
        const whopUserId = String(event.data?.user?.id || "");
        if (whopUserId && event.type === "membership.activated") {
          ctx.waitUntil(recordFreshActivation(whopUserId, event, env));
        } else if (whopUserId && event.type === "membership.deactivated") {
          ctx.waitUntil(clearFreshActivation(whopUserId, env));
        }
      }

      return legacy.fetch(delegated, env, ctx);
    }

    // Use stateless signed OAuth state. This removes a KV put + delete from every
    // Discord join attempt and avoids making new-customer onboarding depend on KV.
    if (url.pathname === "/discord/connect" && request.method === "GET") {
      return startDiscordOAuth(env);
    }

    if (url.pathname === "/discord/oauth/callback" && request.method === "GET") {
      return finishDiscordOAuth(url, env);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.new_customer_join = {
          mode: "activation-webhook-fast-path-v18",
          fresh_access_ttl_minutes: FRESH_ACCESS_TTL_MS / 60000,
          storage: "durable-object",
          oauth_state: "stateless-signed",
          current_access_fallback: true,
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

export class DiscordGateway extends DiscordGatewayV17 {
  async recordFreshDojoAccess(userId, data = {}) {
    const id = String(userId || "");
    if (!id) return { ok: false };
    const item = {
      whop_user_id: id,
      discord_user_id: data.discord_user_id ? String(data.discord_user_id) : null,
      membership_id: data.membership_id ? String(data.membership_id) : null,
      activated_at: data.activated_at || new Date().toISOString(),
      expires_at: Date.now() + FRESH_ACCESS_TTL_MS,
    };
    await this.ctx.storage.put(`fresh_dojo_access:${id}`, item);
    return { ok: true };
  }

  async clearFreshDojoAccess(userId) {
    const id = String(userId || "");
    if (!id) return { ok: false };
    await this.ctx.storage.delete(`fresh_dojo_access:${id}`);
    return { ok: true };
  }

  async getFreshDojoAccess(userId) {
    const id = String(userId || "");
    if (!id) return null;
    const key = `fresh_dojo_access:${id}`;
    const item = await this.ctx.storage.get(key);
    if (!item) return null;
    if (Number(item.expires_at || 0) <= Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return item;
  }

  async listFreshDojoAccess() {
    const rows = await this.ctx.storage.list({ prefix: "fresh_dojo_access:" });
    const active = [];
    const expired = [];
    for (const [key, item] of rows) {
      if (Number(item?.expires_at || 0) <= Date.now()) expired.push(key);
      else active.push(item);
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    return active.slice(0, 50);
  }
}

async function recordFreshActivation(whopUserId, event, env) {
  let discordUserId = null;
  try {
    discordUserId = await resolveDiscordIdForWhopUser(whopUserId, env);
  } catch (error) {
    console.warn("Fresh activation Discord lookup failed:", String(error));
  }

  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (stub) {
    await stub.recordFreshDojoAccess(whopUserId, {
      discord_user_id: discordUserId,
      membership_id: event.data?.id || null,
      activated_at: event.timestamp || new Date().toISOString(),
    });
  }

  console.log(JSON.stringify({
    event: "fresh_activation_recorded",
    discord_linked: Boolean(discordUserId),
    worker_version: "v18",
  }));

  // If the buyer is already in the guild, trust the signed activation event and
  // grant access immediately instead of waiting for Whop's read API to propagate.
  if (discordUserId) {
    const role = await changeDiscordRole(discordUserId, true, env, "Fresh Training Dojo membership activation");
    if (role.ok) {
      await storeMemberLinkIfChanged(whopUserId, discordUserId, env).catch(() => {});
      await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});
    }
  }
}

async function clearFreshActivation(whopUserId, env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (stub) await stub.clearFreshDojoAccess(whopUserId).catch(() => {});
}

async function startDiscordOAuth(env) {
  if (!env.DISCORD_CLIENT_SECRET) {
    return htmlPage(
      "Discord connection is not configured yet",
      "The Discord connection is temporarily unavailable. Please try again shortly.",
      503,
    );
  }

  const state = await createSignedState(env.DISCORD_CLIENT_SECRET);
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
  const traceId = crypto.randomUUID().slice(0, 8);
  const error = url.searchParams.get("error");
  if (error) return htmlPage("Discord authorization canceled", "No changes were made.", 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlPage("Invalid Discord connection", "The authorization link is missing required information. Start again.", 400);
  }

  const stateValid = await validateOAuthState(state, env);
  if (!stateValid) {
    return htmlPage("Discord connection expired", "Start the Discord connection again.", 400);
  }

  if (!env.DISCORD_CLIENT_SECRET) {
    return htmlPage("Discord connection unavailable", "OAuth is not configured yet.", 503);
  }

  console.log(JSON.stringify({ event: "discord_join_callback", trace_id: traceId, worker_version: "v18" }));

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
    console.warn(JSON.stringify({ event: "discord_join_token_failed", trace_id: traceId, status: tokenResponse.status }));
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

  let match = await findCachedWhopAccess(discordUserId, env);
  if (!match) match = await findFreshActivationForDiscord(discordUserId, env);

  // A person may have connected Discord to Whop only seconds before authorizing
  // the Dojo Bot. Give that social-account link one quick chance to propagate.
  if (!match) {
    await sleep(1500);
    match = await findFreshActivationForDiscord(discordUserId, env);
  }

  // Mature/existing customers still use the canonical current-access lookup.
  if (!match) match = await findCurrentWhopUserForDiscord(discordUserId, env);

  if (!match) {
    console.warn(JSON.stringify({ event: "discord_join_access_not_found", trace_id: traceId, worker_version: "v18" }));
    return htmlPage(
      "Training Dojo access not found yet",
      "Your purchase may still be finishing setup, or this Discord account is not linked to your Whop account. Make sure this same Discord account is connected on Whop, then try again.",
      403,
      WHOP_CONNECTED_ACCOUNTS_URL,
      "Connect Discord on Whop",
    );
  }

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
    console.error(JSON.stringify({
      event: "discord_join_guild_failed",
      trace_id: traceId,
      status: addMemberResponse.status,
      body: body.slice(0, 180),
    }));
    return htmlPage(
      "Could not join the Discord server",
      "Your membership was verified, but Discord could not add you to the server. Please try again.",
      500,
    );
  }

  const role = await changeDiscordRole(discordUserId, true, env, "Dojo Discord OAuth verification");
  if (!role.ok) {
    console.error(JSON.stringify({ event: "discord_join_role_failed", trace_id: traceId, status: role.status }));
    return htmlPage(
      "Joined, but role setup is still finishing",
      "You are in the Discord server, but your Training Dojo role could not be added yet. Run /verify in Discord or try again shortly.",
      500,
    );
  }

  await storeMemberLinkIfChanged(match.whopUserId, discordUserId, env).catch(() => {});
  await env.RR_TRACKER?.setMemberActive(discordUserId, true).catch(() => {});

  console.log(JSON.stringify({
    event: "discord_join_success",
    trace_id: traceId,
    access_source: match.source,
    worker_version: "v18",
  }));

  return htmlPage(
    "You're in the Training Dojo",
    "Discord is connected, your membership is verified, and your Training Dojo role is active. You can close this page and return to Discord.",
    200,
  );
}

async function findCachedWhopAccess(discordUserId, env) {
  if (!env.MEMBER_LINKS) return null;
  const reverse = await env.MEMBER_LINKS.get(`discord:${discordUserId}`, "json").catch(() => null);
  const whopUserId = String(reverse?.whop_user_id || "");
  if (!whopUserId) return null;

  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  const fresh = stub ? await stub.getFreshDojoAccess(whopUserId).catch(() => null) : null;
  if (fresh) return { whopUserId, source: "fresh_activation_cached_link" };

  if (await whopUserHasProductAccess(whopUserId, env)) {
    return { whopUserId, source: "current_access_cached_link" };
  }
  return null;
}

async function findFreshActivationForDiscord(discordUserId, env) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return null;
  const candidates = await stub.listFreshDojoAccess().catch(() => []);
  if (!Array.isArray(candidates) || !candidates.length) return null;

  for (const item of candidates) {
    if (String(item?.discord_user_id || "") === String(discordUserId)) {
      return { whopUserId: String(item.whop_user_id), source: "fresh_activation_direct" };
    }
  }

  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const results = await Promise.all(batch.map(async (item) => {
      const whopUserId = String(item?.whop_user_id || "");
      if (!whopUserId) return null;
      const found = await resolveDiscordIdForWhopUser(whopUserId, env).catch(() => null);
      return String(found || "") === String(discordUserId)
        ? { whopUserId, source: "fresh_activation_live_social" }
        : null;
    }));
    const match = results.find(Boolean);
    if (match) return match;
  }

  return null;
}

async function findCurrentWhopUserForDiscord(discordUserId, env) {
  const users = await getCurrentDojoCustomerUsers(env);
  for (let i = 0; i < users.length; i += 8) {
    const batch = users.slice(i, i + 8);
    const results = await Promise.all(batch.map(async (item) => {
      const whopUserId = String(item.userId || "");
      if (!whopUserId) return null;
      const found = await resolveDiscordIdForWhopUser(whopUserId, env).catch(() => null);
      return String(found || "") === String(discordUserId)
        ? { whopUserId, source: item.source || "current_access" }
        : null;
    }));
    const match = results.find(Boolean);
    if (match) return match;
  }
  return null;
}

async function getCurrentDojoCustomerUsers(env) {
  try {
    const records = await fetchPaged("/members", env, (params) => {
      params.append("company_id", env.WHOP_COMPANY_ID);
      params.append("access_level", "customer");
      params.append("product_ids", env.WHOP_PRODUCT_ID);
    });
    const users = dedupeUsers(records).map((item) => ({ ...item, source: "members_customer_access" }));
    if (users.length) return users;
  } catch (error) {
    console.warn("Current member list lookup failed:", String(error));
  }

  try {
    const records = await fetchPaged("/memberships", env, (params) => {
      params.append("company_id", env.WHOP_COMPANY_ID);
      params.append("product_ids", env.WHOP_PRODUCT_ID);
    });
    const candidates = dedupeUsers(records.filter((record) => {
      const status = String(record?.status || record?.membership?.status || "");
      return !status || ACCESS_FALLBACK_STATUSES.has(status);
    }));

    const verified = [];
    for (let i = 0; i < candidates.length; i += 8) {
      const batch = candidates.slice(i, i + 8);
      const results = await Promise.all(batch.map(async (item) =>
        (await whopUserHasProductAccess(item.userId, env))
          ? { ...item, source: "membership_access_fallback" }
          : null,
      ));
      verified.push(...results.filter(Boolean));
    }
    return verified;
  } catch (error) {
    console.warn("Current membership fallback lookup failed:", String(error));
    return [];
  }
}

async function whopUserHasProductAccess(userId, env) {
  try {
    const response = await fetch(
      `${WHOP_API}/users/${encodeURIComponent(userId)}/access/${encodeURIComponent(env.WHOP_PRODUCT_ID)}`,
      { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
    );
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body?.has_access) && String(body?.access_level || "") === "customer";
  } catch {
    return false;
  }
}

async function resolveDiscordIdForWhopUser(userId, env) {
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

async function fetchPaged(path, env, configure) {
  let after = null;
  const all = [];
  do {
    const params = new URLSearchParams({ first: "100" });
    configure(params);
    if (after) params.set("after", after);
    const response = await fetch(`${WHOP_API}${path}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` },
    });
    if (!response.ok) throw new Error(`${path} ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const page = await response.json();
    if (Array.isArray(page?.data)) all.push(...page.data);
    const info = page?.page_info || {};
    after = info.has_next_page && info.end_cursor ? info.end_cursor : null;
  } while (after);
  return all;
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

async function storeMemberLinkIfChanged(whopUserId, discordUserId, env) {
  if (!env.MEMBER_LINKS || !whopUserId || !discordUserId) return;
  const whopKey = `whop:${whopUserId}`;
  const discordKey = `discord:${discordUserId}`;
  const [whopExisting, discordExisting] = await Promise.all([
    env.MEMBER_LINKS.get(whopKey, "json").catch(() => null),
    env.MEMBER_LINKS.get(discordKey, "json").catch(() => null),
  ]);
  const now = new Date().toISOString();
  const writes = [];
  if (String(whopExisting?.discord_user_id || "") !== String(discordUserId)) {
    writes.push(env.MEMBER_LINKS.put(whopKey, JSON.stringify({ discord_user_id: String(discordUserId), updated_at: now })));
  }
  if (String(discordExisting?.whop_user_id || "") !== String(whopUserId)) {
    writes.push(env.MEMBER_LINKS.put(discordKey, JSON.stringify({ whop_user_id: String(whopUserId), updated_at: now })));
  }
  if (writes.length) await Promise.all(writes);
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

async function createSignedState(secret) {
  const payload = encoder.encode(JSON.stringify({ iat: Date.now(), nonce: crypto.randomUUID() }));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
}

async function validateOAuthState(state, env) {
  if (env.DISCORD_CLIENT_SECRET && await verifySignedState(state, env.DISCORD_CLIENT_SECRET)) return true;

  // Let OAuth links opened immediately before v18 deployed finish normally.
  if (env.MEMBER_LINKS) {
    const stateKey = `discord-oauth-state:${state}`;
    const stored = await env.MEMBER_LINKS.get(stateKey, "json").catch(() => null);
    if (stored) {
      await env.MEMBER_LINKS.delete(stateKey).catch(() => {});
      return true;
    }
  }
  return false;
}

async function verifySignedState(state, secret) {
  const [payloadText, signatureText] = String(state || "").split(".");
  if (!payloadText || !signatureText) return false;
  try {
    const payload = base64UrlDecode(payloadText);
    const signature = base64UrlDecode(signatureText);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(String(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, payload);
    if (!valid) return false;
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    const age = Date.now() - Number(parsed?.iat || 0);
    return age >= 0 && age <= OAUTH_STATE_TTL_MS;
  } catch {
    return false;
  }
}

async function parseVerifiedWhopEvent(headers, rawBody, env) {
  if (!env.WHOP_WEBHOOK_SECRET) return null;
  const valid = await verifyWhopWebhook(headers, rawBody, env.WHOP_WEBHOOK_SECRET).catch(() => false);
  if (!valid) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function isDojoMembershipEvent(event, env) {
  if (event.type !== "membership.activated" && event.type !== "membership.deactivated") return false;
  const companyId = String(event.company_id || event.data?.company?.id || "");
  const productId = String(event.data?.product?.id || "");
  return companyId === String(env.WHOP_COMPANY_ID || "") && productId === String(env.WHOP_PRODUCT_ID || "");
}

async function verifyWhopWebhook(headers, rawBody, secret) {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  const timestampNumber = Number(webhookTimestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

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
    if (comma === -1 || candidate.slice(0, comma) !== "v1") continue;
    try {
      if (await crypto.subtle.verify(
        "HMAC",
        key,
        base64ToBytes(candidate.slice(comma + 1)),
        encoder.encode(signedContent),
      )) return true;
    } catch {}
  }
  return false;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = String(value).replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
