import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const SLEEPER_APP = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS = "https://api.sleeper.com/projections/nfl/2026/1";
let playersCache = null;
let playersCacheAt = 0;

async function fetchJson(base, pathname) {
  const upstream = await fetch(base + pathname, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 Sleeper-Draft-Assistant" },
    cache: "no-store",
  });
  const body = await upstream.text();
  if (!upstream.ok) throw new Error(`Sleeper returned ${upstream.status} · ${body || "empty response"}`);
  try { return JSON.parse(body); } catch { throw new Error("Sleeper returned invalid JSON"); }
}
async function sleeper(pathname) { return fetchJson(SLEEPER_APP, pathname); }
async function getPlayers() {
  if (playersCache && Date.now() - playersCacheAt < 24 * 60 * 60 * 1000) return playersCache;
  playersCache = await sleeper("/players/nfl");
  playersCacheAt = Date.now();
  return playersCache;
}
function projectionValue(row, scoring) {
  const points = scoring === "ppr" ? row.pts_ppr : scoring === "half_ppr" ? row.pts_half_ppr : row.pts_std;
  const adp = scoring === "ppr"
    ? (row.adp_dd_ppr ?? row.adp_ppr)
    : scoring === "half_ppr"
      ? (row.adp_dd_half_ppr ?? row.adp_half_ppr)
      : (row.adp_dd_std ?? row.adp_std);
  return {
    points: Number.isFinite(Number(points)) ? Number(points) : 0,
    adp: Number.isFinite(Number(adp)) && Number(adp) < 999 ? Number(adp) : null,
  };
}
function normalizeProjectionRows(raw) {
  if (Array.isArray(raw)) {
    return raw.map((row) => [String(row.player_id ?? row.id ?? ""), row]).filter(([id]) => id);
  }
  if (raw && typeof raw === "object") return Object.entries(raw);
  return [];
}
function slotForPick(pickNo, teams, type = "snake") {
  if (!teams) return null;
  const index = pickNo - 1;
  const round = Math.floor(index / teams) + 1;
  const inRound = index % teams;
  return type === "snake" && round % 2 === 0 ? teams - inRound : inRound + 1;
}
function nextPickForSlot(currentPick, teams, userSlot, type = "snake") {
  if (!userSlot) return null;
  for (let p = currentPick; p < currentPick + teams * 2; p += 1) {
    if (slotForPick(p, teams, type) === userSlot) return p;
  }
  return null;
}
function rosterCounts(picks, userSlot) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pick of picks) {
    if (!userSlot || Number(pick.draft_slot) !== userSlot) continue;
    const pos = pick.metadata?.position;
    if (pos && Object.hasOwn(counts, pos)) counts[pos] += 1;
  }
  return counts;
}

async function buildRecommendation(draftId) {
  const draft = await sleeper(`/draft/${encodeURIComponent(draftId)}`);
  const picks = await sleeper(`/draft/${encodeURIComponent(draftId)}/picks`);
  const scoringType = draft.metadata?.scoring_type === "half_ppr"
    ? "half_ppr"
    : draft.metadata?.scoring_type === "std"
      ? "standard"
      : "ppr";

  const [projectionRaw, players] = await Promise.all([
    fetchJson(SLEEPER_PROJECTIONS, "?season_type=regular"),
    getPlayers(),
  ]);
  const rows = normalizeProjectionRows(projectionRaw);
  const drafted = new Set(picks.map((p) => String(p.player_id)));
  const teams = Number(draft.settings?.teams ?? 12);
  const currentPickNo = picks.length + 1;
  const currentSlot = slotForPick(currentPickNo, teams, draft.type);
  const creatorIds = Array.isArray(draft.creators) ? draft.creators.map(String) : [];
  const userId = creatorIds.length === 1 ? creatorIds[0] : null;
  const userSlot = userId && draft.draft_order ? Number(draft.draft_order[userId]) : null;
  const userPickNo = nextPickForSlot(currentPickNo, teams, userSlot, draft.type);
  const picksUntilUser = userPickNo ? userPickNo - currentPickNo : null;
  const userCounts = rosterCounts(picks, userSlot);
  const needs = {
    QB: Number(draft.settings?.slots_qb ?? 1),
    RB: Number(draft.settings?.slots_rb ?? 2),
    WR: Number(draft.settings?.slots_wr ?? 2),
    TE: Number(draft.settings?.slots_te ?? 1),
  };

  const candidates = rows.map(([id, row]) => {
    const player = players[id];
    if (!player || drafted.has(id)) return null;
    const pos = player.position || (Array.isArray(player.fantasy_positions) ? player.fantasy_positions[0] : "");
    if (!["QB", "RB", "WR", "TE"].includes(pos)) return null;
    const market = projectionValue(row, scoringType);
    if (!market.adp && !market.points) return null;

    const adp = market.adp ?? 999;
    const pointsScore = Math.min(40, market.points / 8);
    const marketValue = Math.max(0, 100 - adp);
    const needBonus = Math.max(0, (needs[pos] ?? 0) - (userCounts[pos] ?? 0)) * 4;
    const fallValue = userPickNo && market.adp ? Math.max(0, market.adp - userPickNo) : 0;
    const reachPenalty = userPickNo && market.adp ? Math.max(0, userPickNo - market.adp - 8) * 1.5 : 0;
    const score = marketValue + pointsScore + needBonus + fallValue * 0.7 - reachPenalty;

    return {
      id,
      name: [player.first_name, player.last_name].filter(Boolean).join(" "),
      position: pos,
      team: player.team ?? "",
      adp: market.adp,
      points: market.points,
      score,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);

  const best = candidates[0] ?? null;
  const runnerUp = candidates[1]?.score ?? (best ? best.score - 8 : 0);
  const onClock = userPickNo === currentPickNo;

  return {
    scoringType,
    teams,
    currentPickNo,
    currentSlot,
    userSlot,
    userPickNo,
    picksUntilUser,
    onClock,
    availableCount: rows.filter(([id]) => !drafted.has(id)).length,
    roster: userCounts,
    recommendation: best ? {
      name: best.name,
      position: best.position,
      team: best.team,
      adp: best.adp,
      points: best.points,
      confidence: Math.round(Math.min(95, Math.max(55, 65 + (best.score - runnerUp) * 2))),
      reason: best.adp
        ? `Sleeper ADP ${best.adp.toFixed(1)} · projected ${best.points.toFixed(1)} pts · roster need and pick-range value included.`
        : "Strong Sleeper projection with no current ADP signal.",
    } : null,
    alternatives: candidates.slice(1, 4).map((c) => ({
      name: c.name,
      position: c.position,
      team: c.team,
      adp: c.adp,
      points: c.points,
    })),
  };
}

async function proxySleeper(pathname, res) {
  try {
    const data = await sleeper(pathname);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(path.join(root, "../public/index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, build: "live-recommendations-2026-08-31-4" }));
      return;
    }
    const rec = url.pathname.match(/^\/api\/recommendations\/(\d+)$/);
    if (rec) {
      const data = await buildRecommendation(rec[1]);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname.startsWith("/api/sleeper/")) {
      await proxySleeper(url.pathname.slice("/api/sleeper".length), res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Sleeper Draft Assistant: http://localhost:${port}`));
