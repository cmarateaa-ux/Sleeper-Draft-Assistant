import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const SLEEPER_APP = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS = "https://api.sleeper.com/projections/nfl/2026";
const SLEEPER_WEEK1 = "https://api.sleeper.com/projections/nfl/2026/1";
const FFC_ADP = "https://fantasyfootballcalculator.com/api/v1/adp";
let playersCache = null;
let playersCacheAt = 0;
let marketCache = null;
let marketCacheAt = 0;
let seasonCache = null;
let seasonCacheAt = 0;
let ffcCache = new Map();

async function fetchJson(base, pathname = "") {
  const upstream = await fetch(base + pathname, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 Sleeper-Draft-Assistant" },
    cache: "no-store",
  });
  const body = await upstream.text();
  if (!upstream.ok) throw new Error(`Upstream returned ${upstream.status} · ${body || "empty response"}`);
  try { return JSON.parse(body); } catch { throw new Error("Upstream returned invalid JSON"); }
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
async function getFfcAdp(scoring, teams) {
  const key = `${scoring}:${teams}`;
  const cached = ffcCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;
  const format = scoring === "half_ppr" ? "half-ppr" : scoring === "standard" ? "standard" : "ppr";
  try {
    const data = await fetchJson(FFC_ADP, `/${format}?teams=${teams}&year=2026`);
    ffcCache.set(key, { data, at: Date.now() });
    return data;
  } catch {
    return null;
  }
}
function asRows(value) {
  if (Array.isArray(value)) return value.map((row) => [String(row.player_id ?? row.playerId ?? row.id ?? ""), row]).filter(([id]) => id);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}
function statsOf(row) { return row?.stats && typeof row.stats === "object" ? row.stats : row ?? {}; }
function normalizeName(name) { return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function projectionValue(seasonRow, marketRow, scoring) {
  const seasonStats = statsOf(seasonRow);
  const marketStats = statsOf(marketRow);
  const points = scoring === "ppr" ? (seasonStats.pts_ppr ?? seasonRow?.pts_ppr) : scoring === "half_ppr" ? (seasonStats.pts_half_ppr ?? seasonRow?.pts_half_ppr) : (seasonStats.pts_std ?? seasonRow?.pts_std);
  const sleeperAdp = scoring === "ppr" ? (marketStats.adp_dd_ppr ?? marketStats.adp_ppr ?? seasonStats.adp_dd_ppr ?? seasonStats.adp_ppr ?? marketRow?.adp_dd_ppr ?? seasonRow?.adp_dd_ppr) : scoring === "half_ppr" ? (marketStats.adp_dd_half_ppr ?? marketStats.adp_half_ppr ?? seasonStats.adp_dd_half_ppr ?? seasonStats.adp_half_ppr ?? marketRow?.adp_dd_half_ppr ?? seasonRow?.adp_dd_half_ppr) : (marketStats.adp_dd_std ?? marketStats.adp_std ?? seasonStats.adp_dd_std ?? seasonStats.adp_std ?? marketRow?.adp_dd_std ?? seasonRow?.adp_dd_std);
  const adpNumber = Number(sleeperAdp);
  return { points: Number.isFinite(Number(points)) ? Number(points) : 0, sleeperAdp: Number.isFinite(adpNumber) && adpNumber > 0 && adpNumber < 200 ? adpNumber : null };
}
function slotForPick(pickNo, teams, type = "snake") {
  if (!teams) return null;
  const index = pickNo - 1, round = Math.floor(index / teams) + 1, inRound = index % teams;
  return type === "snake" && round % 2 === 0 ? teams - inRound : inRound + 1;
}
function nextPickForSlot(currentPick, teams, userSlot, type = "snake") {
  if (!userSlot) return null;
  for (let p = currentPick; p < currentPick + teams * 2; p += 1) if (slotForPick(p, teams, type) === userSlot) return p;
  return null;
}
function survivalProbability(adp, nextPick) {
  if (!Number.isFinite(adp) || !nextPick) return null;
  const z = (adp - nextPick) / 4.5;
  return Math.round(100 / (1 + Math.exp(-z)));
}

async function buildRecommendation(draftId) {
  const draft = await sleeper(`/draft/${encodeURIComponent(draftId)}`);
  const picks = await sleeper(`/draft/${encodeURIComponent(draftId)}/picks`);
  const scoringType = draft.metadata?.scoring_type === "half_ppr" ? "half_ppr" : draft.metadata?.scoring_type === "std" ? "standard" : "ppr";
  const teams = Number(draft.settings?.teams ?? 12);
  const [seasonRaw, marketRaw, players, ffcRaw] = await Promise.all([getSeasonProjections(), getMarketData(), getPlayers(), getFfcAdp(scoringType, teams)]);
  const seasonRows = new Map(asRows(seasonRaw));
  const marketRows = new Map(asRows(marketRaw));
  const ffcRows = Array.isArray(ffcRaw?.players) ? ffcRaw.players : [];
  const ffcByName = new Map(ffcRows.map((row) => [normalizeName(row.name), row]));
  const drafted = new Set(picks.map((p) => String(p.player_id)));
  const currentPickNo = picks.length + 1;
  const currentSlot = slotForPick(currentPickNo, teams, draft.type);
  const userId = Array.isArray(draft.creators) && draft.creators.length === 1 ? String(draft.creators[0]) : null;
  const userSlot = userId && draft.draft_order ? Number(draft.draft_order[userId]) : null;
  const userPickNo = nextPickForSlot(currentPickNo, teams, userSlot, draft.type);
  const nextUserPick = userPickNo ? nextPickForSlot(userPickNo + 1, teams, userSlot, draft.type) : null;
  const userPicked = picks.filter((p) => userSlot && Number(p.draft_slot) === userSlot);
  const userCounts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pick of userPicked) { const pos = pick.metadata?.position; if (pos && Object.hasOwn(userCounts, pos)) userCounts[pos] += 1; }
  const needs = { QB: Number(draft.settings?.slots_qb ?? 1), RB: Number(draft.settings?.slots_rb ?? 2), WR: Number(draft.settings?.slots_wr ?? 2), TE: Number(draft.settings?.slots_te ?? 1) };
  const rawCandidates = Array.from(seasonRows.entries()).map(([id, seasonRow]) => {
    const player = players[id];
    if (!player || drafted.has(id)) return null;
    const pos = player.position || (Array.isArray(player.fantasy_positions) ? player.fantasy_positions[0] : "");
    if (!["QB", "RB", "WR", "TE"].includes(pos)) return null;
    const market = projectionValue(seasonRow, marketRows.get(id), scoringType);
    const fullName = [player.first_name, player.last_name].filter(Boolean).join(" ");
    const ffc = ffcByName.get(normalizeName(fullName));
    const ffcAdp = Number(ffc?.adp);
    const adp = Number.isFinite(ffcAdp) && ffcAdp > 0 && ffcAdp < 200 ? ffcAdp : market.sleeperAdp;
    if (!adp && !market.points) return null;
    return { id, name: fullName, position: pos, team: player.team ?? "", adp, sleeperAdp: market.sleeperAdp, points: market.points };
  }).filter(Boolean);

  const round = userPickNo ? Math.ceil(userPickNo / teams) : 1;
  const adpWindow = userPickNo ? userPickNo + Math.max(24, teams * 2) : teams * 2;
  const tierCandidates = rawCandidates.filter((player) => player.adp == null ? player.points > 0 : player.adp <= adpWindow);
  const projectionSorted = [...tierCandidates].sort((a, b) => b.points - a.points);
  const projectionRank = new Map(projectionSorted.map((player, index) => [player.id, index + 1]));

  const candidates = tierCandidates.map((player) => {
    const adp = player.adp ?? adpWindow;
    const rank = projectionRank.get(player.id) ?? tierCandidates.length;
    const marketScore = player.adp == null ? 0 : Math.max(0, 100 - adp * 1.55);
    const projectionScore = Math.max(0, 38 - Math.min(38, (rank - 1) * 1.15));
    const need = Math.max(0, (needs[player.position] ?? 0) - (userCounts[player.position] ?? 0));
    const needBonus = round <= 3 ? Math.min(2, need) : Math.min(9, need * 3);
    const fallBonus = userPickNo && player.adp != null ? Math.max(0, Math.min(10, player.adp - userPickNo) * 0.35) : 0;
    const reachPenalty = userPickNo && player.adp != null ? Math.max(0, userPickNo - player.adp - 5) * 2.5 : 0;
    const score = marketScore * 0.64 + projectionScore * 0.28 + needBonus + fallBonus - reachPenalty;
    return { ...player, projectionRank: rank, score, nextPickSurvival: survivalProbability(player.adp, nextUserPick) };
  }).sort((a, b) => b.score - a.score).slice(0, 8);

  const best = candidates[0] ?? null;
  const runnerUp = candidates[1]?.score ?? (best ? best.score - 8 : 0);
  const availableCount = Object.keys(players).filter((id) => !drafted.has(id) && players[id] && ["QB","RB","WR","TE"].includes(players[id].position || "")).length;
  const confidence = best ? Math.round(Math.min(88, Math.max(55, 58 + Math.max(0, best.score - runnerUp) * 1.5))) : null;
  const nextTurnTargets = nextUserPick ? candidates.filter((c) => c.id !== best?.id).sort((a,b) => (b.nextPickSurvival ?? 0) - (a.nextPickSurvival ?? 0)).slice(0,4).map(c => ({ name:c.name, position:c.position, team:c.team, adp:c.adp, survivalPct:c.nextPickSurvival })) : [];
  const nextPickDistance = userPickNo && nextUserPick ? nextUserPick - userPickNo : null;
  let plan = "Take the best player now; reassess the board after the next turn.");
  if (best && nextUserPick) {
    const likelyBack = nextTurnTargets.filter(c => (c.survivalPct ?? 0) >= 60).slice(0,2);
    const scarce = likelyBack.map(c => c.name).join(" or ");
    plan = scarce ? `Take ${best.name} now. At your next turn (${nextUserPick}), the market says ${scarce} has a reasonable chance to remain.` : `Take ${best.name} now. Your next turn is ${nextUserPick}; prioritize the best remaining player rather than forcing a position.`;
  }
  return {
    scoringType, teams, currentPickNo, currentSlot, userSlot, userPickNo, nextUserPick, picksUntilUser: userPickNo ? userPickNo - currentPickNo : null,
    availableCount, roster: userCounts,
    recommendation: best ? { name: best.name, position: best.position, team: best.team, adp: best.adp, points: best.points, confidence, nextPick: nextUserPick, survivalPct: best.nextPickSurvival, reason: `ADP ${best.adp?.toFixed(1) ?? "—"} · projected ${best.points.toFixed(1)} pts · market tier, projection value and your next pick considered.`, plan } : null,
    alternatives: candidates.slice(1, 5).map((c) => ({ name:c.name, position:c.position, team:c.team, adp:c.adp, points:c.points, survivalPct:c.nextPickSurvival })),
    nextTurnTargets,
    nextPickDistance,
  };
}
async function proxySleeper(pathname, res) { try { const data = await sleeper(pathname); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); } catch (error) { res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); } }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") { const html = await readFile(path.join(root, "../public/index.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); return; }
    if (url.pathname === "/api/health") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: true, build: "draft-strategy-2026-08-31-10" })); return; }
    const rec = url.pathname.match(/^\/api\/recommendations\/(\d+)$/);
    if (rec) { const data = await buildRecommendation(rec[1]); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); return; }
    if (url.pathname.startsWith("/api/sleeper/")) { await proxySleeper(url.pathname.slice("/api/sleeper".length), res); return; }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
  } catch (error) { res.writeHead(502, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(port, "0.0.0.0", () => console.log(`Sleeper Draft Assistant: http://localhost:${port}`));