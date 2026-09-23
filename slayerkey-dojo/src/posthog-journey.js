import { MEMBER_PREFIX, SEVEN_DAYS_MS, mergeTenureIntoRecord } from "./activation-core.js";

const encoder = new TextEncoder();
const DEFAULT_POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const BRIDGE_MAX_SKEW_MS = 5 * 60 * 1000;

export const JOURNEY_EVENT_NAMES = Object.freeze([
  "introduction_posted",
  "replied_to_two_members",
  "first_training_post",
  "first_general_message",
  "goal_posted",
  "riot_linked",
  "first_win_posted",
  "first_win_within_7_days",
]);

export async function pseudonymousWhopDistinctId(rawWhopUserId) {
  const value = String(rawWhopUserId || "").trim();
  if (!value) return "";
  return `whop_user_${await sha256Hex(value)}`;
}

export async function resolveCustomerPosthogIdentity(gateway, discordUserId, tenureOverride = null) {
  const userId = String(discordUserId || "");
  if (!userId) return null;

  const tenure = tenureOverride || await gateway.getTenureRecord?.(userId).catch(() => null);
  const rawWhopUserId = String(tenure?.whop_user_id || "").trim();
  if (!rawWhopUserId) return null;

  const link = await gateway.env?.MEMBER_LINKS?.get(`whop:${rawWhopUserId}`, "json").catch(() => null);
  const linkedDistinctId = safeDistinctId(link?.posthog_distinct_id);
  if (linkedDistinctId) {
    return {
      distinct_id: linkedDistinctId,
      identity_source: "website_posthog_distinct_id",
      plan: tenure?.is_annual === true ? "annual" : tenure?.is_annual === false ? "monthly" : "unknown",
      membership_active: typeof tenure?.active === "boolean" ? tenure.active : null,
      activation_started_at: validIso(tenure?.first_eligible_at)
        ? new Date(tenure.first_eligible_at).toISOString()
        : null,
    };
  }

  const fallback = await pseudonymousWhopDistinctId(rawWhopUserId);
  if (!fallback) return null;
  return {
    distinct_id: fallback,
    identity_source: "whop_user_id_hash",
    plan: tenure?.is_annual === true ? "annual" : tenure?.is_annual === false ? "monthly" : "unknown",
    membership_active: typeof tenure?.active === "boolean" ? tenure.active : null,
    activation_started_at: validIso(tenure?.first_eligible_at)
      ? new Date(tenure.first_eligible_at).toISOString()
      : null,
  };
}

export async function syncActivationPosthogMember(gateway, discordUserId, recordOverride = null, tenureOverride = null) {
  const userId = String(discordUserId || "");
  if (!userId) return { ok: false, reason: "missing_discord_user" };

  const tenure = tenureOverride || await gateway.getTenureRecord?.(userId).catch(() => null);
  let record = recordOverride || await gateway.ctx.storage.get(`${MEMBER_PREFIX}${userId}`);
  if (!record && !tenure) return { ok: false, reason: "unknown_member" };
  record = mergeTenureIntoRecord(record, userId, tenure);

  const identity = await resolveCustomerPosthogIdentity(gateway, userId, tenure);
  if (!identity?.distinct_id) return { ok: false, reason: "identity_unresolved" };

  const milestones = milestoneCandidates(record);
  if (!milestones.length) return { ok: true, emitted: 0, pending: 0 };

  const delivery = { ...(record.posthog_delivery || {}) };
  let emitted = 0;
  let pending = 0;

  for (const milestone of milestones) {
    const previous = delivery[milestone.event];
    if (previous?.milestone_at === milestone.milestone_at) continue;

    const properties = {
      source: "discord",
      plan: identity.plan,
      activation_started_at: milestone.activation_started_at,
      milestone_at: milestone.milestone_at,
      days_since_activation: milestone.days_since_activation,
      membership_active: identity.membership_active,
      identity_source: identity.identity_source,
      $insert_id: await sha256Hex(`${identity.distinct_id}|${milestone.event}|${milestone.milestone_at}`),
    };

    const result = await capturePosthog(gateway, milestone.event, identity.distinct_id, properties);
    if (!result.ok) {
      pending += 1;
      continue;
    }

    delivery[milestone.event] = {
      milestone_at: milestone.milestone_at,
      delivered_at: new Date().toISOString(),
    };
    record.posthog_delivery = delivery;
    record.updated_at = new Date().toISOString();
    await gateway.ctx.storage.put(`${MEMBER_PREFIX}${userId}`, record);
    emitted += 1;
  }

  return { ok: pending === 0, emitted, pending };
}

export async function syncActivationPosthogBatch(gateway) {
  if (!String(gateway.env?.POSTHOG_PROJECT_TOKEN || "").trim()) {
    return { ok: true, checked: 0, emitted: 0, pending: 0, failed: 0, skipped: "posthog_not_configured" };
  }

  const rows = await gateway.ctx.storage.list({ prefix: MEMBER_PREFIX });
  const tenures = await gateway.listTenureRecords?.().catch(() => []);
  const tenureById = new Map(
    (Array.isArray(tenures) ? tenures : []).map((item) => [String(item?.discord_user_id || ""), item]),
  );

  let checked = 0;
  let emitted = 0;
  let pending = 0;
  let failed = 0;

  for (const [key, value] of rows.entries()) {
    const userId = String(key).slice(MEMBER_PREFIX.length);
    if (!userId) continue;
    checked += 1;

    try {
      const result = await syncActivationPosthogMember(
        gateway,
        userId,
        value,
        tenureById.get(userId) || null,
      );
      emitted += Number(result?.emitted || 0);
      pending += Number(result?.pending || 0);
      if (result?.ok === false && !["identity_unresolved", "unknown_member"].includes(result.reason)) failed += 1;
    } catch (error) {
      failed += 1;
      console.error("PostHog activation reconciliation failed:", safeError(error));
    }
  }

  return { ok: failed === 0, checked, emitted, pending, failed };
}

export async function handleCustomerIdentityBridge(request, env) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "POST required." }, { status: 405 });
  }
  if ((!env.DOJO_IDENTITY_BRIDGE_SECRET && !env.WHOP_WEBHOOK_SECRET) || !env.MEMBER_LINKS) {
    return Response.json({ ok: false, error: "Identity bridge is not configured." }, { status: 503 });
  }

  const timestampHeader = String(request.headers.get("X-Slayerkey-Timestamp") || "").trim();
  const signatureHeader = String(request.headers.get("X-Slayerkey-Signature") || "").trim();
  const rawBody = await request.text();
  const timestampSeconds = Number(timestampHeader);

  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() - timestampSeconds * 1000) > BRIDGE_MAX_SKEW_MS) {
    return Response.json({ ok: false, error: "Invalid bridge timestamp." }, { status: 401 });
  }

  const expected = await hmacSha256Hex(
    String(env.DOJO_IDENTITY_BRIDGE_SECRET),
    `${timestampHeader}.${rawBody}`,
  );
  const supplied = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : "";
  if (!constantTimeHexEqual(expected, supplied)) {
    return Response.json({ ok: false, error: "Invalid bridge signature." }, { status: 401 });
  }

  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const rawWhopUserId = safeServerIdentifier(body?.whop_user_id);
  const posthogDistinctId = safeDistinctId(body?.posthog_distinct_id);
  if (!rawWhopUserId || !posthogDistinctId) {
    return Response.json({ ok: false, error: "Missing identity fields." }, { status: 400 });
  }

  const key = `whop:${rawWhopUserId}`;
  const current = await env.MEMBER_LINKS.get(key, "json").catch(() => null);
  const fallback = await pseudonymousWhopDistinctId(rawWhopUserId);
  const now = new Date().toISOString();
  await env.MEMBER_LINKS.put(key, JSON.stringify({
    ...(current && typeof current === "object" ? current : {}),
    posthog_distinct_id: posthogDistinctId,
    posthog_identity_source: posthogDistinctId === fallback
      ? "whop_user_id_hash"
      : "website_posthog_distinct_id",
    posthog_identity_updated_at: now,
    updated_at: now,
  }));

  return Response.json({ ok: true });
}

export async function signIdentityBridgeBody(secret, timestamp, rawBody) {
  return hmacSha256Hex(String(secret || ""), `${timestamp}.${rawBody}`);
}

function milestoneCandidates(record) {
  const anchor = validIso(record?.activation_started_at)
    ? new Date(record.activation_started_at).toISOString()
    : null;
  if (!anchor) return [];

  const candidates = [
    ["introduction_posted", record?.introduction_at],
    ["replied_to_two_members", record?.replied_to_two_members_at],
    ["first_training_post", record?.first_training_post_at],
    ["first_general_message", record?.first_general_message_at],
    ["goal_posted", record?.first_goal_at],
    ["riot_linked", record?.riot_linked_observed_at || (record?.riot_linked_current ? record?.riot_link_checked_at : null)],
    ["first_win_posted", record?.first_win_at],
  ];

  const result = [];
  for (const [event, value] of candidates) {
    const milestoneAt = qualifiedAt(value, anchor);
    if (!milestoneAt) continue;
    result.push(buildMilestone(event, milestoneAt, anchor));
  }

  const firstWin = qualifiedAt(record?.first_win_at, anchor);
  if (firstWin && Date.parse(firstWin) <= Date.parse(anchor) + SEVEN_DAYS_MS) {
    result.push(buildMilestone("first_win_within_7_days", firstWin, anchor));
  }

  return result;
}

function buildMilestone(event, milestoneAt, anchor) {
  return {
    event,
    milestone_at: milestoneAt,
    activation_started_at: anchor,
    days_since_activation: Math.round(((Date.parse(milestoneAt) - Date.parse(anchor)) / 86400000) * 1000) / 1000,
  };
}

async function capturePosthog(gateway, event, distinctId, properties) {
  const token = String(gateway.env?.POSTHOG_PROJECT_TOKEN || "").trim();
  if (!token) return { ok: false, reason: "posthog_not_configured" };

  const url = String(gateway.env?.POSTHOG_CAPTURE_URL || DEFAULT_POSTHOG_CAPTURE_URL).trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: "invalid_posthog_url" };

  const payload = {
    api_key: token,
    event,
    distinct_id: distinctId,
    properties: {
      $process_person_profile: false,
      ...properties,
    },
  };

  const fetchImpl = typeof gateway.posthogFetch === "function"
    ? gateway.posthogFetch.bind(gateway)
    : fetch;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("PostHog delivery failed without blocking Discord:", safeError(error));
    return { ok: false, reason: "network_error" };
  }

  if (!response?.ok) {
    console.error("PostHog delivery returned non-2xx without blocking Discord:", response?.status || "unknown");
    return { ok: false, reason: "http_error", status: response?.status || 0 };
  }
  return { ok: true };
}

function safeDistinctId(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 200 ? normalized : "";
}

function safeServerIdentifier(value) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= 200 && !/[\r\n\0]/.test(normalized) ? normalized : "";
}

function qualifiedAt(value, anchor) {
  if (!validIso(value) || !validIso(anchor)) return null;
  if (Date.parse(value) < Date.parse(anchor)) return null;
  return new Date(value).toISOString();
}

function validIso(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(signature));
}

function constantTimeHexEqual(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

export const __test = Object.freeze({
  milestoneCandidates,
  safeDistinctId,
});
