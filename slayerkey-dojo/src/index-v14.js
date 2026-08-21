import legacy, { DiscordGateway as DiscordGatewayV13 } from "./index-v13.js";

const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API = "https://api.whop.com/api/v1";
const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/whop/webhook" && request.method === "POST") {
      return handleCanonicalWhopWebhook(request, env, ctx);
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.membership_webhook_mode = "customer-access-v14";
        body.discord.deactivation_mode = "recheck-access-then-remove-all-manageable-roles";
        body.discord.deactivation_rechecks_seconds = [0, 2, 5];
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

export class DiscordGateway extends DiscordGatewayV13 {}

async function handleCanonicalWhopWebhook(request, env, ctx) {
  if (!env.WHOP_WEBHOOK_SECRET) {
    return new Response("Webhook secret not configured", { status: 503 });
  }

  const rawBody = await request.text();
  const valid = await verifyWhopWebhook(request.headers, rawBody, env.WHOP_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "membership.activated" && event.type !== "membership.deactivated") {
    return new Response("Ignored", { status: 200 });
  }

  const companyId = String(event.company_id || event.data?.company?.id || "");
  const productId = String(event.data?.product?.id || "");
  if (companyId !== String(env.WHOP_COMPANY_ID || "")) {
    return new Response("Ignored company", { status: 200 });
  }
  if (productId !== String(env.WHOP_PRODUCT_ID || "")) {
    return new Response("Ignored product", { status: 200 });
  }

  ctx.waitUntil(processCanonicalMembershipEvent(event, env));
  return new Response("OK", { status: 200 });
}

async function processCanonicalMembershipEvent(event, env) {
  const whopUserId = String(event.data?.user?.id || "");
  if (!whopUserId) {
    console.warn("Whop membership event did not contain a user ID.");
    return;
  }

  const discordId = await resolveDiscordForWhopUser(whopUserId, env);
  if (!discordId) {
    console.log(`No Discord account is linked for Whop user ${whopUserId}.`);
    return;
  }

  if (event.type === "membership.activated") {
    const hasAccess = await whopUserHasProductAccess(whopUserId, env);
    if (!hasAccess) {
      console.log(`Activation received for ${whopUserId}, but customer access is not active yet.`);
      return;
    }

    await addDojoRole(discordId, whopUserId, env, "Training Dojo access activated");
    return;
  }

  // A user can have multiple memberships, plans, or price points under the same product.
  // Never remove access just because one membership record deactivated. Recheck the
  // canonical product access endpoint first, with short retries for API propagation.
  const delays = [0, 2000, 5000];
  for (const delay of delays) {
    if (delay) await sleep(delay);
    if (await whopUserHasProductAccess(whopUserId, env)) {
      console.log(`Whop user ${whopUserId} still has Training Dojo customer access. No roles removed.`);
      await addDojoRole(discordId, whopUserId, env, "Training Dojo access still active").catch(() => {});
      return;
    }
  }

  const result = await removeAllManageableRoles(
    discordId,
    env,
    "Training Dojo access expired",
  );

  if (env.RR_TRACKER) {
    await env.RR_TRACKER.setMemberActive(discordId, false).catch((error) => {
      console.warn("Could not mark RR tracker member inactive:", error);
    });
  }

  console.log(
    `Removed ${result.removed.length} manageable roles from Discord user ${discordId}` +
      (result.skipped.length ? `; skipped ${result.skipped.length} unmanageable/managed roles.` : "."),
  );
}

async function resolveDiscordForWhopUser(whopUserId, env) {
  if (env.MEMBER_LINKS) {
    const cached = await env.MEMBER_LINKS.get(`whop:${whopUserId}`, "json").catch(() => null);
    if (cached?.discord_user_id) return String(cached.discord_user_id);
  }

  const response = await fetch(
    `https://api.whop.com/v5/company/users/${encodeURIComponent(whopUserId)}/social_accounts`,
    { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
  );
  if (!response.ok) return null;

  const body = await response.json();
  const accounts = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const discord = accounts.find((account) => account?.service === "discord" && account?.account_id);
  const discordId = discord?.account_id ? String(discord.account_id) : null;
  if (discordId && env.MEMBER_LINKS) await storeMemberLink(whopUserId, discordId, env);
  return discordId;
}

async function whopUserHasProductAccess(whopUserId, env) {
  try {
    const response = await fetch(
      `${WHOP_API}/users/${encodeURIComponent(whopUserId)}/access/${encodeURIComponent(env.WHOP_PRODUCT_ID)}`,
      { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } },
    );
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body?.has_access) && String(body?.access_level || "") === "customer";
  } catch {
    return false;
  }
}

async function addDojoRole(discordId, whopUserId, env, reason) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}/roles/${env.DISCORD_DOJO_ROLE_ID}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "X-Audit-Log-Reason": reason,
      },
    },
  );

  if (response.status !== 204) {
    throw new Error(`Discord role add failed ${response.status}: ${await response.text()}`);
  }

  if (env.MEMBER_LINKS) await storeMemberLink(whopUserId, discordId, env);
  await env.RR_TRACKER?.setMemberActive(discordId, true).catch(() => {});
}

async function removeAllManageableRoles(discordId, env, reason) {
  const [memberResponse, rolesResponse, botResponse] = await Promise.all([
    fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    }),
    fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    }),
    fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${env.DISCORD_APP_ID}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    }),
  ]);

  if (memberResponse.status === 404) return { removed: [], skipped: [], not_in_server: true };
  if (!memberResponse.ok) throw new Error(`Discord member lookup failed ${memberResponse.status}`);
  if (!rolesResponse.ok) throw new Error(`Discord role list failed ${rolesResponse.status}`);
  if (!botResponse.ok) throw new Error(`Discord bot member lookup failed ${botResponse.status}`);

  const member = await memberResponse.json();
  const roles = await rolesResponse.json();
  const botMember = await botResponse.json();
  const byId = new Map((Array.isArray(roles) ? roles : []).map((role) => [String(role.id), role]));
  const botRoleIds = Array.isArray(botMember.roles) ? botMember.roles.map(String) : [];
  const botHighestPosition = botRoleIds.reduce((max, roleId) => {
    const position = Number(byId.get(roleId)?.position ?? -1);
    return Math.max(max, position);
  }, -1);

  const removable = [];
  const skipped = [];
  for (const roleId of Array.isArray(member.roles) ? member.roles.map(String) : []) {
    if (roleId === String(env.DISCORD_GUILD_ID)) continue;
    const role = byId.get(roleId);
    if (!role) continue;
    if (role.managed || Number(role.position ?? 0) >= botHighestPosition) {
      skipped.push(roleId);
      continue;
    }
    removable.push(roleId);
  }

  const removed = [];
  for (let i = 0; i < removable.length; i += 6) {
    const batch = removable.slice(i, i + 6);
    const results = await Promise.all(batch.map(async (roleId) => {
      const response = await fetch(
        `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            "X-Audit-Log-Reason": reason,
          },
        },
      );
      return response.status === 204 ? roleId : null;
    }));
    removed.push(...results.filter(Boolean));
  }

  return { removed, skipped, not_in_server: false };
}

async function storeMemberLink(whopUserId, discordId, env) {
  if (!env.MEMBER_LINKS || !whopUserId || !discordId) return;
  const now = new Date().toISOString();
  await Promise.all([
    env.MEMBER_LINKS.put(
      `whop:${whopUserId}`,
      JSON.stringify({ discord_user_id: String(discordId), updated_at: now }),
    ),
    env.MEMBER_LINKS.put(
      `discord:${discordId}`,
      JSON.stringify({ whop_user_id: String(whopUserId), updated_at: now }),
    ),
  ]);
}

async function verifyWhopWebhook(headers, rawBody, secret) {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const timestampNumber = Number(webhookTimestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

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
    if (candidate.slice(0, comma) !== "v1") continue;
    try {
      if (
        await crypto.subtle.verify(
          "HMAC",
          key,
          base64ToBytes(candidate.slice(comma + 1)),
          encoder.encode(signedContent),
        )
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
