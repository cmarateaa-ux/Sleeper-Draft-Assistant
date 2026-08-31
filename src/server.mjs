import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const SLEEPER_APP = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS = "https://api.sleeper.com/projections/nfl/2026";
const SLEEPER_WEEK1 = "https://api.sleeper.com/projections/nfl/2026/1";
let playersCache = null;
let playersCacheAt = 0;
let marketCache = null;
let marketCacheAt = 0;
let seasonCache = null;
let seasonCacheAt = 0;

async function fetchJson(base, pathname = "") {
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
async function getSeasonProjections() {
  if (seasonCache && Date.now() - seasonCacheAt < 60 * 60 * 1000) return seasonCache;
  seasonCache = await fetchJson(SLEEPER_PROJECTIONS, "?season_type=regular");
  seasonCacheAt = Date.now();
  return seasonCache;
}
async function getMarketData() {
  if (marketCache && Date.now() - marketCacheAt < 10 * 60 * 1000) return marketCache;
  marketCache = await fetchJson(SLEEPER_WEEK1, "?season_type=regular");
  marketCacheAt = Date.now();
  return marketCache;
}
function asRows(value) {
  if (Array.isArray(value)) return value.map((row) => [String(row.player_id ?? row.playerId ?? row.id ?? ""), row]).filter(([id]) => id);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}
function projectionValue(seasonRow, marketRow, scoring) {
  const points = scoring === "ppr" ? seasonRow?.pts_ppr : scoring === "half_ppr" ? seasonRow?.pts_half_ppr : seasonRow?.pts_std;
  const adp = scoring === "ppr"
    ? (marketRow?.adp_dd_ppr ?? marketRow?.adp_ppr ?? seasonRow?.adp_dd_ppr ?? seasonRow?.adp_ppr)
    : scoring === "half_ppr"
      ? (marketRow?.adp_dd_half_ppr ?? marketRow?.adp_half_ppr ?? seasonRow?.adp_dd_half_ppr ?? seasonRow?.adp_half_ppr)
      : (marketRow?.adp_dd_std ?? marketRow?.adp_std ?? seasonRow?.adp_dd_std ?? seasonRow?.adp_std);
  return {
    points: Number.isFinite(Number(points)) ? Number(points) : 0,
    adp: Number.isFinite(Number(adp)) && Number(adp) > 0 && Number(adp) < 999 ? Number(adp) : null,
  };
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
async function buildRecommendation(draftId) {
  const draft = await sleeper(`/draft/${encodeURIComponent(draftId)}`);
  const picks = await sleeper(`/draft/${encodeURIComponent(draftId)}/picks`);
  const scoringType = draft.metadata?.scoring_type === "half_ppr" ? "half_ppr" : draft.metadata?.scoring_type === "std" ? "standard" : "ppr";
  const [seasonRaw, marketRaw, players] = await Promise.all([getSeasonProjections(), getMarketData(), getPlayers()]);
  const seasonRows = new Map(asRows(seasonRaw));
  const marketRows = new Map(asRows(marketRaw));
  const drafted = new Set(picks.map((p) => String(p.player_id)));
  const teams = Number(draft.settings?.teams ?? 12);
  const currentPickNo = picks.length + 1;
  const currentSlot = slotForPick(currentPickNo, teams, draft.type);
  const userId = Array.isArray(draft.creators) && draft.creators.length === 1 ? String(draft.creators[0]) : null;
  const userSlot = userId && draft.draft_order ? Number(draft.draft_order[userId]) : null;
  const userPickNo = nextPickForSlot(currentPickNo, teams, userSlot, draft.type);
  const picksUntilUser = userPickNo ? userPickNo - currentPickNo : null;
  const userPicked = picks.filter((p) => userSlot && Number(p.draft_slot) === userSlot);
  const userCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pick of userPicked) {
    const pos = pick.metadata?.position;
    if (pos && Object.hasOwn(userCounts, pos)) userCounts[pos] += 1;
  }
  const needs = { QB: Number(draft.settings?.slots_qb ?? 1), RB: Number(draft.settings?.slots_rb ?? 2), WR: Number(draft.settings?.slots_wr ?? 2), TE: Number(draft.settings?.slots_te ?? 1) };

  const candidates = Array.from(seasonRows.entries()).map(([id, seasonRow]) => {
    const player = players[id];
    if (!player || drafted.has(id)) return null;
    const pos = player.position || (Array.isArray(player.fantasy_positions) ? player.fantasy_positions[0] : "");
    if (!["QB", "RB", "WR", "TE"].includes(pos)) return null;
    const market = projectionValue(seasonRow, marketRows.get(id), scoringType);
    if (!market.adp && !market.points) return null;
    const adp = market.adp ?? 999;
    const pointsScore = Math.min(40, market.points / 8);
    const marketValue = market.adp ? Math.max(0, 110 - adp) : 0;
    const needBonus = Math.max(0, (needs[pos] ?? 0) - (userCounts[pos] ?? 0)) * 4;
    const fallValue = userPickNo && market.adp ? Math.max(0, market.adp - userPickNo) : 0;
    const reachPenalty = userPickNo && market.adp ? Math.max(0, userPickNo - market.adp - 8) * 1.5 : 0;
    const score = marketValue + pointsScore + needBonus + fallValue * 0.7 - reachPenalty;
    return { id, name: [player.first_name, player.last_name].filter(Boolean).join(" "), position: pos, team: player.team ?? "", adp: market.adp, points: market.points, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);

  const best = candidates[0] ?? null;
  const runnerUp = candidates[1]?.score ?? (best ? best.score - 8 : 0);
  const availableCount = Array.from(seasonRows.keys()).filter((id) => !drafted.has(id) && players[id] && ["QB", "RB", "WR", "TE"].includes(players[id].position || "")).length;
  return {
    scoringType, teams, currentPickNo, currentSlot, userSlot, userPickNo, picksUntilUser,
    availableCount, roster: userCounts,
    recommendation: best ? {
      name: best.name, position: best.position, team: best.team, adp: best.adp, points: best.points,
      confidence: Math.round(Math.min(95, Math.max(55, 65 + (best.score - runnerUp) * 2))),
      reason: best.adp ? `Sleeper ADP ${best.adp.toFixed(1)} · projected ${best.points.toFixed(1)} pts · roster need and pick-range value included.` : `Strong Sleeper projection · ${best.points.toFixed(1)} projected pts · no current ADP signal.`,
    } : null,
    alternatives: candidates.slice(1, 4).map((c) => ({ name: c.name, position: c.position, team: c.team, adp: c.adp, points: c.points })),
  };
}
async function proxySleeper(pathname, res) {
  try { const data = await sleeper(pathname); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); }
  catch (error) { res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") { const html = await readFile(path.join(root, "../public/index.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); return; }
    if (url.pathname === "/api/health") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: true, build: "live-recommendations-2026-08-31-5" })); return; }
    const rec = url.pathname.match(/^\/api\/recommendations\/(\d+)$/);
    if (rec) { const data = await buildRecommendation(rec[1]); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); return; }
    if (url.pathname.startsWith("/api/sleeper/")) { await proxySleeper(url.pathname.slice("/api/sleeper".length), res); return; }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
  } catch (error) { res.writeHead(502, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(port, "0.0.0.0", () => console.log(`Sleeper Draft Assistant: http://localhost:${port}`));
