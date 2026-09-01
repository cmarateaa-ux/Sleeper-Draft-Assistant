import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeFetch = globalThis.fetch.bind(globalThis);
const root = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(root, "..", "draft-logs");
const logPath = path.join(logDir, "live-telemetry.jsonl");
const BUILD = "sleeper-live-refresh-2026-08-31-41";
const AUTO_DRAFT_SLOTS = [4];
let playerDefCache = null;
let activePlayersCache = null;
let activePlayersPromise = null;

function writeTelemetry(record) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), build: BUILD, ...record })}\n`, "utf8");
  } catch (error) {
    console.warn("Draft telemetry write failed:", error?.message || error);
  }
}

async function getDefensePlayers() {
  if (playerDefCache) return playerDefCache;
  const response = await nativeFetch("https://api.sleeper.app/v1/players/nfl?position=DEF&active=true", {
    headers: { "user-agent": "Sleeper-Draft-Assistant/0.1" },
  });
  if (!response.ok) return [];
  const players = await response.json();
  playerDefCache = Object.entries(players)
    .filter(([, player]) => player?.status === "Active" && player?.position === "DEF" && player?.team)
    .map(([id, player]) => ({ id: String(id), team: String(player.team) }))
    .sort((a, b) => a.team.localeCompare(b.team));
  return playerDefCache;
}

async function getActivePlayers() {
  if (activePlayersCache) return activePlayersCache;
  if (activePlayersPromise) return activePlayersPromise;

  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"];
  activePlayersPromise = Promise.all(
    positions.map(async (position) => {
      const response = await nativeFetch(`https://api.sleeper.app/v1/players/nfl?position=${position}&active=true`, {
        headers: { "user-agent": "Sleeper-Draft-Assistant/0.1" },
      });
      if (!response.ok) return {};
      return response.json();
    })
  )
    .then((groups) => {
      const merged = {};
      for (const group of groups) Object.assign(merged, group || {});
      activePlayersCache = merged;
      activePlayersPromise = null;
      return merged;
    })
    .catch((error) => {
      activePlayersPromise = null;
      throw error;
    });

  return activePlayersPromise;
}

function installDefenseMarketGuard() {
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input ?? "");

    if (url === "https://api.sleeper.app/v1/players/nfl") {
      const players = await getActivePlayers();
      return new Response(JSON.stringify(players), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const started = Date.now();
    const response = await nativeFetch(input, init);

    if (url.includes("/draft/") && (url.endsWith("/picks") || url.match(/\/draft\/[^/]+$/))) {
      try {
        const body = await response.clone().json();
        const match = url.match(/\/draft\/([^/?]+)/);
        const draftId = match?.[1] ?? null;
        const isPicks = url.endsWith("/picks");
        const picks = isPicks && Array.isArray(body) ? body : null;
        const lastPick = picks?.length ? picks[picks.length - 1] : null;
        writeTelemetry({
          type: isPicks ? "draft_picks_snapshot" : "draft_metadata",
          draftId,
          latencyMs: Date.now() - started,
          pickCount: picks?.length ?? null,
          lastPick: lastPick ? {
            pickNo: Number(lastPick.pick_no) || null,
            draftSlot: Number(lastPick.draft_slot) || null,
            playerId: lastPick.player_id ?? null,
            position: lastPick.metadata?.position ?? null,
          } : null,
          autoDraftSlots: AUTO_DRAFT_SLOTS,
          autoDraftLastPick: lastPick ? AUTO_DRAFT_SLOTS.includes(Number(lastPick.draft_slot)) : false,
          picks: picks?.map((p) => ({
            pickNo: Number(p.pick_no) || null,
            draftSlot: Number(p.draft_slot) || null,
            playerId: p.player_id ?? null,
            position: p.metadata?.position ?? null,
          })) ?? null,
          metadata: !isPicks ? {
            status: body?.status ?? null,
            teams: body?.settings?.teams ?? null,
            type: body?.type ?? null,
            season: body?.season ?? null,
            scoringType: body?.metadata?.scoring_type ?? null,
            draftOrder: body?.draft_order ?? null,
          } : null,
        });
      } catch (error) {
        writeTelemetry({ type: "draft_telemetry_error", url, error: error?.message || String(error) });
      }
    }

    if (!url.includes("api.sleeper.com/projections/nfl")) return response;

    try {
      const rows = await response.clone().json();
      const existing = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.player_id ?? "")));
      const defenses = await getDefensePlayers();
      const adpStart = 145;
      const pointsStart = 165;
      const synthetic = defenses
        .filter((def) => !existing.has(def.id))
        .map((def, index) => ({
          player_id: def.id,
          adp_ppr: adpStart + index * 2,
          adp_half_ppr: adpStart + index * 2,
          adp_std: adpStart + index * 2,
          pts_ppr: Math.max(105, pointsStart - index * 2),
          pts_half_ppr: Math.max(105, pointsStart - index * 2),
          pts_std: Math.max(105, pointsStart - index * 2),
        }));

      if (!synthetic.length) return response;
      return new Response(JSON.stringify([...(Array.isArray(rows) ? rows : []), ...synthetic]), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
}

installDefenseMarketGuard();
await import("./server.mjs");
