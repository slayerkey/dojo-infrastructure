export function tenureRoleKey(firstEligibleAt, now = new Date()) {
  const months = fullMonthsSince(firstEligibleAt, now);
  if (months < 1) return null;
  return `m${Math.min(months, 6)}`;
}

export function fullMonthsSince(iso, now = new Date()) {
  const start = new Date(iso);
  if (!Number.isFinite(start.getTime()) || start > now) return 0;
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  const lastDayThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const anniversaryDay = Math.min(start.getUTCDate(), lastDayThisMonth);
  if (now.getUTCDate() < anniversaryDay) months -= 1;
  return Math.max(0, months);
}

export function looksAnnual(plan) {
  if (!plan || typeof plan !== "object") return false;
  if (Number(plan.billing_period || 0) >= 300) return true;
  if (Number(plan.expiration_days || 0) >= 300) return true;
  const text = `${plan.title || ""} ${plan.description || ""}`.toLowerCase();
  return /\bannual\b|\byearly\b|\b1\s*year\b|\b12\s*month/.test(text);
}

export function mergeWhopMemberLink(current, discordUserId, updatedAt) {
  return {
    ...(current && typeof current === "object" ? current : {}),
    discord_user_id: String(discordUserId || ""),
    updated_at: updatedAt,
  };
}

export function mergeDiscordMemberLink(current, whopUserId, updatedAt) {
  return {
    ...(current && typeof current === "object" ? current : {}),
    whop_user_id: String(whopUserId || ""),
    updated_at: updatedAt,
  };
}
