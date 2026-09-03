import legacy, { DiscordGateway as DiscordGatewayV23 } from "./index-v23.js";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 64;
const VALORANT_RED = 0xff4655;
const PAGE_SIZE = 5;
const COMPONENT_PREFIX = "rrlb:v4";
const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const delegated = request.clone();
      let rawBody;
      let interaction;

      try {
        rawBody = await request.text();
        interaction = JSON.parse(rawBody);
      } catch {
        return legacy.fetch(delegated, env, ctx);
      }

      const isLeaderboardCommand =
        interaction.type === 2 && interaction.data?.name === "rrleaderboard";
      const component = interaction.type === 3
        ? parseLeaderboardComponent(interaction.data?.custom_id)
        : null;

      if (!isLeaderboardCommand && !component) {
        return legacy.fetch(delegated, env, ctx);
      }

      const valid = await verifyDiscordSignature(
        request.headers,
        rawBody,
        env.DISCORD_PUBLIC_KEY,
      );
      if (!valid) return new Response("Invalid request signature", { status: 401 });

      const discordUserId = getInteractionUserId(interaction);
      if (!discordUserId) {
        return ephemeralMessage("I could not determine your Discord user ID.");
      }

      if (String(interaction.guild_id || "") !== String(env.DISCORD_GUILD_ID || "")) {
        return ephemeralMessage("This leaderboard only works in the Slayerkey Discord server.");
      }

      if (isLeaderboardCommand) {
        const owner = discordUserId === String(env.DISCORD_OWNER_USER_ID || "");
        const roles = Array.isArray(interaction.member?.roles)
          ? interaction.member.roles.map(String)
          : [];
        const hasDojo = owner || roles.includes(String(env.DISCORD_DOJO_ROLE_ID || ""));
        if (!hasDojo) {
          return ephemeralMessage(
            `You need <@&${env.DISCORD_DOJO_ROLE_ID}> to use the RR tracker. Run **/verify** first.`,
          );
        }

        if (!env.RR_TRACKER) {
          return ephemeralMessage("The leaderboard service is updating right now. Try again in a moment.");
        }

        const sessionId = createSessionId();
        const traceId = crypto.randomUUID().slice(0, 8);
        ctx.waitUntil(
          createLeaderboardSession(env, discordUserId, sessionId)
            .then(({ bundle, cacheSource }) =>
              editOriginalInteraction(
                interaction,
                env,
                renderLeaderboardView(bundle.month, "month", discordUserId, sessionId, 1),
              ).then(() => ({ cacheSource })),
            )
            .then(({ cacheSource }) => console.log(JSON.stringify({
              event: "rrleaderboard_rendered",
              trace_id: traceId,
              action: "open",
              mode: "month",
              cache_source: cacheSource,
              worker_version: "v24",
            })))
            .catch(async (error) => {
              console.error(JSON.stringify({
                event: "rrleaderboard_failed",
                trace_id: traceId,
                action: "open",
                error: String(error),
                worker_version: "v24",
              }));
              await editOriginalInteraction(interaction, env, {
                content: `I could not load the leaderboard. Try **/rrleaderboard** again. Reference: **${traceId}**`,
                embeds: [],
                components: [],
              }).catch(() => {});
            }),
        );

        return Response.json({ type: 5, data: {} });
      }

      if (discordUserId !== component.ownerId) {
        return ephemeralMessage(
          "These leaderboard controls belong to the person who opened this message. Run **/rrleaderboard** to open your own controls.",
        );
      }

      if (!env.RR_TRACKER) {
        return ephemeralMessage("The leaderboard service is updating right now. Try again in a moment.");
      }

      const traceId = crypto.randomUUID().slice(0, 8);
      ctx.waitUntil(
        handleLeaderboardComponent(interaction, component, env)
          .then(({ mode, page, cacheSource }) => console.log(JSON.stringify({
            event: "rrleaderboard_rendered",
            trace_id: traceId,
            action: component.action,
            mode,
            page,
            cache_source: cacheSource,
            worker_version: "v24",
          })))
          .catch((error) => console.error(JSON.stringify({
            event: "rrleaderboard_failed",
            trace_id: traceId,
            action: component.action,
            error: String(error),
            worker_version: "v24",
          }))),
      );

      return Response.json({ type: 6 });
    }

    if (url.pathname === "/health") {
      const response = await legacy.fetch(request, env, ctx);
      try {
        const body = await response.json();
        body.discord = body.discord || {};
        body.discord.rrleaderboard = {
          mode: "retained-period-pagination-v24",
          page_size: PAGE_SIZE,
          default_view: "month",
          views: ["month", "year"],
          year_load: "lazy-on-first-click",
          pagination_cache: "durable-object-memory",
          page_click_kv_writes: false,
          membership_expiry_removes_history: false,
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

export class DiscordGateway extends DiscordGatewayV23 {}

async function createLeaderboardSession(env, ownerId, sessionId) {
  const month = await env.RR_TRACKER.getLeaderboardSnapshot(ownerId);
  if (!month?.ok) throw new Error(month?.message || "Monthly leaderboard snapshot failed");

  const bundle = {
    ok: true,
    month,
    year: null,
    created_at: new Date().toISOString(),
  };
  await cacheLeaderboardBundle(env, sessionId, ownerId, bundle);
  return { bundle, cacheSource: "month_d1_initial" };
}

async function loadLeaderboardSession(env, ownerId, sessionId) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (stub) {
    const cached = await stub.getRrLeaderboardSnapshot(sessionId, ownerId).catch(() => null);
    if (cached?.ok && cached?.month?.ok) {
      return { bundle: cached, cacheSource: "durable_object_memory" };
    }
  }

  return createLeaderboardSession(env, ownerId, sessionId);
}

async function ensureLeaderboardView(env, ownerId, sessionId, bundle, mode, cacheSource) {
  if (mode === "month") {
    return { bundle, view: bundle.month, cacheSource };
  }

  if (bundle.year?.ok) {
    return { bundle, view: bundle.year, cacheSource };
  }

  const year = await env.RR_TRACKER.getYearLeaderboardSnapshot(ownerId);
  if (!year?.ok) throw new Error(year?.message || "Year leaderboard snapshot failed");

  const updated = { ...bundle, year };
  await cacheLeaderboardBundle(env, sessionId, ownerId, updated);
  return {
    bundle: updated,
    view: year,
    cacheSource: `${cacheSource}+year_d1_lazy`,
  };
}

async function handleLeaderboardComponent(interaction, component, env) {
  const loaded = await loadLeaderboardSession(env, component.ownerId, component.sessionId);
  const targetMode = component.action === "toggle"
    ? (component.mode === "month" ? "year" : "month")
    : component.mode;

  const ensured = await ensureLeaderboardView(
    env,
    component.ownerId,
    component.sessionId,
    loaded.bundle,
    targetMode,
    loaded.cacheSource,
  );

  const view = ensured.view;
  const totalPages = Math.max(
    1,
    Math.ceil((Array.isArray(view.entries) ? view.entries.length : 0) / PAGE_SIZE),
  );
  const viewerPosition = Number(view.viewer_position || 0);
  const viewerPage = viewerPosition > 0
    ? Math.ceil(viewerPosition / PAGE_SIZE)
    : component.page;

  const requestedPage = component.action === "toggle"
    ? 1
    : component.action === "prev"
      ? Math.max(1, component.page - 1)
      : component.action === "next"
        ? Math.min(totalPages, component.page + 1)
        : Math.min(totalPages, Math.max(1, viewerPage));

  await editOriginalInteraction(
    interaction,
    env,
    renderLeaderboardView(
      view,
      targetMode,
      component.ownerId,
      component.sessionId,
      requestedPage,
    ),
  );

  return {
    mode: targetMode,
    page: requestedPage,
    cacheSource: ensured.cacheSource,
  };
}

async function cacheLeaderboardBundle(env, sessionId, ownerId, bundle) {
  const stub = env.DISCORD_GATEWAY?.getByName("dojo-main");
  if (!stub) return;
  await stub.putRrLeaderboardSnapshot(sessionId, ownerId, bundle).catch(() => {});
}

function renderLeaderboardView(view, mode, ownerId, sessionId, requestedPage) {
  const allEntries = Array.isArray(view?.entries) ? view.entries : [];
  const totalPlayers = Number(view?.total_players || allEntries.length);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number(requestedPage) || 1));
  const offset = (page - 1) * PAGE_SIZE;
  const entries = allEntries.slice(offset, offset + PAGE_SIZE);
  const label = mode === "year" ? (view?.year || view?.label || "This Year") : (view?.month || view?.label || "This Month");

  const blocks = entries.length
    ? entries.map((entry) => formatLeaderboardEntry(entry, mode))
    : [`No tracked competitive games are on the ${label} leaderboard yet.`];

  if (mode === "month" && page === 1) {
    const previous = view.previous_month_champion;
    blocks.push(
      previous
        ? `### 👑 ${view.previous_month || "Previous month"} Champion\n<@${previous.discord_user_id}>  ${formatDeltaInline(previous.monthly_rr)}\n${previous.games_counted || 0} competitive games`
        : `### 👑 ${view.previous_month || "Previous month"} Champion\nNo winner recorded yet.`,
    );
  }

  const marked = entries.some((entry) => !entry.history_complete);
  const footerParts = [
    mode === "year" ? "Year to date" : "Monthly",
    `Page ${page} of ${totalPages}`,
    `${totalPlayers} player${totalPlayers === 1 ? "" : "s"}`,
  ];
  if (marked) {
    footerParts.push(
      mode === "year"
        ? "⚠️ Tracked RR may be incomplete for players who started tracking after Jan 1."
        : "⚠️ Earlier monthly RR may be missing for marked players.",
    );
  }

  return {
    content: null,
    embeds: [{
      color: VALORANT_RED,
      title: `🏆 ${label} RR Leaderboard`,
      description: blocks.join("\n\n"),
      footer: { text: footerParts.join("  •  ") },
    }],
    components: buildLeaderboardControls({
      ownerId,
      sessionId,
      mode,
      page,
      totalPages,
      viewerPosition: view?.viewer_position,
    }),
  };
}

function formatLeaderboardEntry(entry, mode) {
  const position = Number(entry.position || 0);
  const medal = position === 1 ? "🥇" : position === 2 ? "🥈" : position === 3 ? "🥉" : "";
  const ordinal = position === 1 ? "1st" : position === 2 ? "2nd" : position === 3 ? "3rd" : `${position}.`;
  const heading = position === 1 ? "#" : position === 2 ? "##" : position === 3 ? "###" : "";
  const score = mode === "year" ? entry.yearly_rr : entry.monthly_rr;
  const delta = formatDeltaInline(score);
  const warning = entry.history_complete ? "" : " ⚠️";
  const start = entry.start_rank ? formatRank(entry.start_rank, entry.start_rr) : "Start not recorded";
  const peak = entry.peak_rank
    ? formatRank(entry.peak_rank, entry.peak_rr)
    : formatRank(entry.current_rank, entry.current_rr);
  const progression = `🏁 ${start}  →  👑 ${peak}`;
  const games = `${entry.games_counted || 0} competitive games${warning}`;

  if (position <= 3) {
    return `${heading} ${medal} ${ordinal}  <@${entry.discord_user_id}>  ${delta}\n${progression}\n${games}`.trim();
  }

  return `**${ordinal}** <@${entry.discord_user_id}>  ${delta}\n${progression}\n${games}`;
}

function buildLeaderboardControls({ ownerId, sessionId, mode, page, totalPages, viewerPosition }) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: leaderboardCustomId(ownerId, sessionId, "prev", mode, page),
          emoji: { name: "◀️" },
          disabled: page <= 1,
        },
        {
          type: 2,
          style: 2,
          custom_id: leaderboardCustomId(ownerId, sessionId, "me", mode, page),
          label: "Me",
          emoji: { name: "👤" },
          disabled: !Number(viewerPosition || 0),
        },
        {
          type: 2,
          style: 2,
          custom_id: leaderboardCustomId(ownerId, sessionId, "next", mode, page),
          emoji: { name: "▶️" },
          disabled: page >= totalPages,
        },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: leaderboardCustomId(ownerId, sessionId, "toggle", mode, page),
          label: mode === "year" ? "Month" : "Year",
          emoji: { name: "📅" },
        },
      ],
    },
  ];
}

function leaderboardCustomId(ownerId, sessionId, action, mode, page) {
  return `${COMPONENT_PREFIX}:${ownerId}:${sessionId}:${action}:${mode}:${Math.max(1, Number(page) || 1)}`;
}

function parseLeaderboardComponent(customId) {
  const value = String(customId || "");
  if (!value.startsWith(`${COMPONENT_PREFIX}:`)) return null;
  const parts = value.split(":");
  if (parts.length !== 7) return null;
  const ownerId = String(parts[2] || "");
  const sessionId = String(parts[3] || "");
  const action = String(parts[4] || "");
  const mode = String(parts[5] || "");
  const page = Math.max(1, Number(parts[6]) || 1);
  if (!/^\d+$/.test(ownerId)) return null;
  if (!/^[a-zA-Z0-9_-]{6,24}$/.test(sessionId)) return null;
  if (!["prev", "me", "next", "toggle"].includes(action)) return null;
  if (!["month", "year"].includes(mode)) return null;
  return { ownerId, sessionId, action, mode, page };
}

function createSessionId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function formatRank(rank, rr) {
  if (!rank) return "Unranked";
  if (rr == null) return String(rank);
  return `${rank} ${Number(rr)} RR`;
}

function formatDeltaInline(value) {
  const number = Number(value || 0);
  if (number > 0) return `🟢 **+${number} RR**`;
  if (number < 0) return `🔴 **${number} RR**`;
  return "⚪ **0 RR**";
}

function getInteractionUserId(interaction) {
  return String(interaction.member?.user?.id || interaction.user?.id || "");
}

function ephemeralMessage(content) {
  return Response.json({
    type: 4,
    data: {
      content,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

async function editOriginalInteraction(interaction, env, payload) {
  const body = { ...(payload || {}) };
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
    throw new Error(`Could not edit leaderboard interaction: ${response.status} ${await response.text()}`);
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
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}
