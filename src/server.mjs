import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const SLEEPER_APP = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS = "https://api.sleeper.com/projections/nfl/2026";
let playersCache = null;
let playersCacheAt = 0;
let projectionsCache = new Map();

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
  const adp = scoring === "ppr" ? (row.adp_dd_ppr ?? row.adp_ppr) : scoring === "half_ppr" ? (row.adp_dd_half_ppr ?? row.adp_half_ppr) : (row.adp_dd_std ?? row.adp_std);
  return { points: Number.isFinite(Number(points)) ? Number(points) : 0, adp: Number.isFinite(Number(adp)) && Number(adp) < 999 ? Number(adp) : null };
}

async function buildRecommendation(draftId) {
  const draft = await sleeper(`/draft/${encodeURIComponent(draftId)}`);
  const picks = await sleeper(`/draft/${encodeURIComponent(draftId)}/picks`);
  const scoringType = draft.metadata?.scoring_type === "half_ppr" ? "half_ppr" : draft.metadata?.scoring_type === "std" ? "standard" : "ppr";
  const week = await fetchJson(SLEEPER_PROJECTIONS, "?season_type=regular&week=1");
  const players = await getPlayers();
  const rows = week && !Array.isArray(week) ? Object.entries(week) : [];
  const drafted = new Set(picks.map((p) => String(p.player_id)));
  const teams = Number(draft.settings?.teams ?? 12);
  const nextPick = picks.length + 1;
  const slot = teams ? ((nextPick - 1) % teams) + 1 : null;
  const userId = Array.isArray(draft.creators) && draft.creators.length === 1 ? String(draft.creators[0]) : null;
  const userSlot = userId && draft.draft_order ? Number(draft.draft_order[userId]) : null;
  const turnsUntilNext = userSlot && slot ? ((userSlot - slot + teams) % teams) : 0;

  const candidates = rows.map(([id, row]) => {
    const player = players[id];
    if (!player || drafted.has(id)) return null;
    const pos = player.position || (row.position ?? "");
    if (!["QB", "RB", "WR", "TE"].includes(pos)) return null;
    const market = projectionValue(row, scoringType);
    if (!market.adp && !market.points) return null;
    const adp = market.adp ?? 999;
    const projectedPickValue = Math.max(0, 100 - adp);
    const projectionValueScore = Math.min(40, market.points / 8);
    const value = projectedPickValue + projectionValueScore;
    return { id, name: [player.first_name, player.last_name].filter(Boolean).join(" "), position: pos, team: player.team ?? "", adp: market.adp, points: market.points, score: value };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);

  const best = candidates[0] ?? null;
  return {
    scoringType,
    teams,
    nextPick,
    slot,
    userSlot,
    turnsUntilNext,
    availableCount: rows.filter(([id]) => !drafted.has(id)).length,
    recommendation: best ? {
      name: best.name,
      position: best.position,
      team: best.team,
      adp: best.adp,
      points: best.points,
      confidence: Math.round(Math.min(95, Math.max(55, 65 + (best.score - (candidates[1]?.score ?? best.score - 8)) * 2))),
      reason: best.adp ? `Sleeper ADP ${best.adp.toFixed(1)} with a strong ${scoringType.replace("_", " ")} projection.` : "Strong Sleeper projection with no current ADP signal.",
    } : null,
    alternatives: candidates.slice(1, 4).map((c) => ({ name: c.name, position: c.position, team: c.team, adp: c.adp, points: c.points })),
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
      res.end(html); return;
    }
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, build: "live-recommendations-2026-08-31-1" })); return;
    }
    const rec = url.pathname.match(/^\/api\/recommendations\/(\d+)$/);
    if (rec) {
      const data = await buildRecommendation(rec[1]);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data)); return;
    }
    if (url.pathname.startsWith("/api/sleeper/")) {
      await proxySleeper(url.pathname.slice("/api/sleeper".length), res); return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Sleeper Draft Assistant: http://localhost:${port}`));
