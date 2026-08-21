const WHOP_API = "https://api.whop.com/api/v1";
const DISCORD_API = "https://discord.com/api/v10";
const WHOP_API_VERSION_DATE = "2026-08-13";

const ACCESS_STATUSES = new Set([
  "active",
  "trialing",
  "canceling",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Slayerkey Dojo Sync is running.", {
        status: 200,
      });
    }

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname.startsWith("/dashboard/")) {
      return handleDashboard(env);
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
    ctx.waitUntil(reconcileActiveMemberships(env));
  },
};


/* ============================================================
   WHOP WEBHOOK
   ============================================================ */

async function handleWhopWebhook(request, env, ctx) {
  if (!env.WHOP_WEBHOOK_SECRET) {
    console.error("WHOP_WEBHOOK_SECRET is not configured.");
    return new Response("Webhook secret not configured", {
      status: 503,
    });
  }

  const rawBody = await request.text();

  const valid = await verifyWhopWebhook(
    request.headers,
    rawBody,
    env.WHOP_WEBHOOK_SECRET
  );

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

  if (
    event.type !== "membership.activated" &&
    event.type !== "membership.deactivated"
  ) {
    return new Response("Ignored", { status: 200 });
  }

  const companyId =
    event.company_id ||
    event.data?.company?.id;

  const productId =
    event.data?.product?.id;

  if (companyId !== env.WHOP_COMPANY_ID) {
    console.log("Ignoring event for another Whop company:", companyId);
    return new Response("Ignored company", { status: 200 });
  }

  if (productId !== env.WHOP_PRODUCT_ID) {
    console.log("Ignoring event for another product:", productId);
    return new Response("Ignored product", { status: 200 });
  }

  /*
   * Whop wants webhook endpoints to respond quickly.
   * Verify first, then perform the Discord work in the background.
   */
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

  /*
   * Fetch the CURRENT membership state.
   *
   * This protects us if Whop delivers webhook events out of order.
   */
  try {
    membership = await whopGet(
      `/memberships/${encodeURIComponent(membershipId)}`,
      env
    );
  } catch (error) {
    console.error(
      "Unable to retrieve current membership state. Falling back to webhook state.",
      error
    );
  }

  const userId =
    membership?.user?.id ||
    fallbackUserId;

  if (!userId) {
    console.error("No Whop user ID found.");
    return;
  }

  const currentProduct =
    membership?.product?.id ||
    event.data?.product?.id;

  if (currentProduct !== env.WHOP_PRODUCT_ID) {
    return;
  }

  /*
   * If we successfully retrieved the membership, its current
   * status is the source of truth.
   *
   * canceling means they canceled renewal but still have
   * access through the paid period.
   */
  let shouldHaveAccess;

  if (membership?.status) {
    shouldHaveAccess = ACCESS_STATUSES.has(membership.status);
  } else {
    shouldHaveAccess =
      event.type === "membership.activated";
  }

  await syncUserRole(userId, shouldHaveAccess, env);
}


/* ============================================================
   WHOP USER → DISCORD USER
   ============================================================ */

async function getDiscordIdFromWhop(userId, env) {
  const user = await whopGet(
    `/users/${encodeURIComponent(userId)}`,
    env
  );

  const accounts = Array.isArray(user.social_accounts)
    ? user.social_accounts
    : [];

  const discord = accounts.find(
    (account) =>
      account.platform === "discord" &&
      account.external_id
  );

  if (!discord) {
    return null;
  }

  return String(discord.external_id);
}


/* ============================================================
   ROLE SYNC
   ============================================================ */

async function syncUserRole(userId, shouldHaveAccess, env) {
  let discordId = null;

  /*
   * First try Whop's current connected Discord information.
   */
  try {
    discordId = await getDiscordIdFromWhop(userId, env);
  } catch (error) {
    console.error(
      `Could not retrieve Whop social accounts for ${userId}:`,
      error
    );
  }

  /*
   * If Whop no longer shows their Discord account,
   * fall back to the ID we previously stored.
   */
  if (!discordId && env.MEMBER_LINKS) {
    try {
      const stored = await env.MEMBER_LINKS.get(
        `whop:${userId}`,
        "json"
      );

      discordId =
        stored?.discord_user_id || null;
    } catch (error) {
      console.error("KV lookup failed:", error);
    }
  }

  if (!discordId) {
    console.log(
      `No Discord account currently linked for Whop user ${userId}.`
    );
    return;
  }

  if (shouldHaveAccess) {
    const result = await changeDiscordRole(
      discordId,
      true,
      env
    );

    if (result.success && env.MEMBER_LINKS) {
      await env.MEMBER_LINKS.put(
        `whop:${userId}`,
        JSON.stringify({
          discord_user_id: discordId,
          last_granted_at: new Date().toISOString(),
        })
      );
    }

    return;
  }

  await changeDiscordRole(
    discordId,
    false,
    env
  );
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
      "X-Audit-Log-Reason":
        add
          ? "Active Slayerkey Training Dojo membership"
          : "Training Dojo membership deactivated",
    },
  });

  if (response.status === 204) {
    console.log(
      `${add ? "Added" : "Removed"} Dojo role for Discord user ${discordUserId}.`
    );

    return {
      success: true,
      status: 204,
    };
  }

  const body = await response.text();

  /*
   * 404 commonly means the customer has not joined the
   * Discord server yet. The scheduled reconciliation
   * will try them again later.
   */
  if (response.status === 404) {
    console.log(
      `Discord user ${discordUserId} is not currently available in the server.`
    );

    return {
      success: false,
      status: 404,
      body,
    };
  }

  console.error(
    `Discord role request failed (${response.status}):`,
    body
  );

  return {
    success: false,
    status: response.status,
    body,
  };
}


/* ============================================================
   PERIODIC RECONCILIATION

   This catches cases where:
   1. Someone buys before connecting Discord.
   2. Someone connects Discord later.
   3. Someone joins the Discord server later.
   ============================================================ */

async function reconcileActiveMemberships(env) {
  console.log("Starting Dojo membership reconciliation.");

  let after = null;
  let processed = 0;

  do {
    const params = new URLSearchParams();

    params.set(
      "company_id",
      env.WHOP_COMPANY_ID
    );

    params.set("first", "100");

    if (after) {
      params.set("after", after);
    }

    const page = await whopGet(
      `/memberships?${params.toString()}`,
      env
    );

    const memberships =
      Array.isArray(page.data)
        ? page.data
        : [];

    const activeDojoMemberships =
      memberships.filter(
        (membership) =>
          membership?.product?.id ===
            env.WHOP_PRODUCT_ID &&
          ACCESS_STATUSES.has(
            membership.status
          )
      );

    /*
     * Work in small batches so we don't hammer either API.
     */
    for (
      let i = 0;
      i < activeDojoMemberships.length;
      i += 10
    ) {
      const batch =
        activeDojoMemberships.slice(
          i,
          i + 10
        );

      await Promise.all(
        batch.map(async (membership) => {
          const userId =
            membership?.user?.id;

          if (!userId) {
            return;
          }

          await syncUserRole(
            userId,
            true,
            env
          );

          processed++;
        })
      );
    }

    const pageInfo =
      page.page_info || {};

    if (
      !pageInfo.has_next_page ||
      !pageInfo.end_cursor
    ) {
      after = null;
    } else {
      after = pageInfo.end_cursor;
    }
  } while (after);

  console.log(
    `Reconciliation completed. Processed ${processed} active Dojo memberships.`
  );
}


/* ============================================================
   WHOP API
   ============================================================ */

async function whopGet(path, env) {
  const response = await fetch(
    `${WHOP_API}${path}`,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${env.WHOP_API_KEY}`,

        /*
         * Pin the current Whop API shape so linked social
         * account fields do not silently change.
         */
        "Api-Version-Date":
          WHOP_API_VERSION_DATE,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Whop API ${response.status}: ${body}`
    );
  }

  return response.json();
}


/* ============================================================
   WHOP WEBHOOK SIGNATURE VERIFICATION
   ============================================================ */

async function verifyWhopWebhook(
  headers,
  rawBody,
  secret
) {
  const webhookId =
    headers.get("webhook-id");

  const webhookTimestamp =
    headers.get("webhook-timestamp");

  const webhookSignature =
    headers.get("webhook-signature");

  if (
    !webhookId ||
    !webhookTimestamp ||
    !webhookSignature
  ) {
    return false;
  }

  /*
   * Reject requests older than 5 minutes to prevent replay.
   */
  const timestampNumber =
    Number(webhookTimestamp);

  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  const ageSeconds =
    Math.abs(
      Date.now() / 1000 -
      timestampNumber
    );

  if (ageSeconds > 300) {
    return false;
  }

  const signedContent =
    `${webhookId}.${webhookTimestamp}.${rawBody}`;

  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["verify"]
    );

  /*
   * Standard Webhooks can include more than one signature
   * separated by spaces.
   */
  const signatures =
    webhookSignature.split(" ");

  for (const candidate of signatures) {
    const comma =
      candidate.indexOf(",");

    if (comma === -1) {
      continue;
    }

    const version =
      candidate.slice(0, comma);

    const base64Signature =
      candidate.slice(comma + 1);

    if (version !== "v1") {
      continue;
    }

    let signatureBytes;

    try {
      signatureBytes =
        base64ToBytes(
          base64Signature
        );
    } catch {
      continue;
    }

    const valid =
      await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        encoder.encode(signedContent)
      );

    if (valid) {
      return true;
    }
  }

  return false;
}


function base64ToBytes(value) {
  const binary =
    atob(value);

  const bytes =
    new Uint8Array(binary.length);

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}


/* ============================================================
   HEALTH CHECK
   ============================================================ */

async function handleHealth(env) {
  const result = {
    worker: "ok",

    variables: {
      WHOP_COMPANY_ID:
        Boolean(env.WHOP_COMPANY_ID),

      WHOP_PRODUCT_ID:
        Boolean(env.WHOP_PRODUCT_ID),

      WHOP_API_KEY:
        Boolean(env.WHOP_API_KEY),

      DISCORD_GUILD_ID:
        Boolean(env.DISCORD_GUILD_ID),

      DISCORD_DOJO_ROLE_ID:
        Boolean(env.DISCORD_DOJO_ROLE_ID),

      DISCORD_BOT_TOKEN:
        Boolean(env.DISCORD_BOT_TOKEN),

      WHOP_WEBHOOK_SECRET:
        Boolean(env.WHOP_WEBHOOK_SECRET),

      MEMBER_LINKS:
        Boolean(env.MEMBER_LINKS),
    },

    whop: {
      ok: false,
    },

    discord: {
      ok: false,
    },
  };

  /*
   * Test Whop authentication and membership permission.
   */
  try {
    const params =
      new URLSearchParams();

    params.set(
      "company_id",
      env.WHOP_COMPANY_ID
    );

    params.set("first", "1");

    const page = await whopGet(
      `/memberships?${params.toString()}`,
      env
    );

    result.whop = {
      ok: true,
      membership_count:
        page.total_count ??
        page.data?.length ??
        null,
    };
  } catch (error) {
    result.whop = {
      ok: false,
      error: String(error),
    };
  }

  /*
   * Test Discord bot authentication.
   */
  try {
    const botResponse =
      await fetch(
        `${DISCORD_API}/users/@me`,
        {
          headers: {
            Authorization:
              `Bot ${env.DISCORD_BOT_TOKEN}`,
          },
        }
      );

    if (!botResponse.ok) {
      throw new Error(
        `Discord API returned ${botResponse.status}`
      );
    }

    const bot =
      await botResponse.json();

    const rolesResponse =
      await fetch(
        `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/roles`,
        {
          headers: {
            Authorization:
              `Bot ${env.DISCORD_BOT_TOKEN}`,
          },
        }
      );

    if (!rolesResponse.ok) {
      throw new Error(
        `Could not access guild roles: ${rolesResponse.status}`
      );
    }

    const roles =
      await rolesResponse.json();

    result.discord = {
      ok: true,

      bot_username:
        bot.username,

      bot_id:
        bot.id,

      target_role_found:
        roles.some(
          (role) =>
            role.id ===
            env.DISCORD_DOJO_ROLE_ID
        ),
    };
  } catch (error) {
    result.discord = {
      ok: false,
      error: String(error),
    };
  }

  return Response.json(result, {
    status: 200,
  });
}


/* ============================================================
   WHOP DASHBOARD VIEW
   ============================================================ */

async function handleDashboard(env) {
  const response =
    await handleHealth(env);

  const health =
    await response.json();

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
    body {
      font-family: system-ui, sans-serif;
      background: #111;
      color: #eee;
      padding: 32px;
      line-height: 1.5;
    }

    .card {
      max-width: 760px;
      margin: 0 auto;
      padding: 24px;
      background: #1b1b1b;
      border: 1px solid #333;
      border-radius: 14px;
    }

    .good {
      color: #62d98b;
    }

    .bad {
      color: #ff7777;
    }

    pre {
      overflow: auto;
      background: #0d0d0d;
      padding: 16px;
      border-radius: 10px;
    }
  </style>
</head>

<body>
  <div class="card">
    <h1>Dojo Discord Sync</h1>

    <p class="${health.whop.ok ? "good" : "bad"}">
      Whop:
      ${health.whop.ok ? "Connected" : "Error"}
    </p>

    <p class="${health.discord.ok ? "good" : "bad"}">
      Discord:
      ${health.discord.ok ? "Connected" : "Error"}
    </p>

    <p>
      Discord target role:
      ${health.discord?.target_role_found ? "Found" : "Not confirmed"}
    </p>

    <p>
      Webhook secret:
      ${health.variables?.WHOP_WEBHOOK_SECRET ? "Configured" : "Not configured yet"}
    </p>

    <pre>${escapeHtml(JSON.stringify(health, null, 2))}</pre>
  </div>
</body>
</html>`,
    {
      headers: {
        "content-type":
          "text/html;charset=UTF-8",
      },
    }
  );
}
