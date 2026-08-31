const nativeFetch = globalThis.fetch.bind(globalThis);
let playerDefCache = null;

async function getDefensePlayers() {
  if (playerDefCache) return playerDefCache;
  const response = await nativeFetch("https://api.sleeper.app/v1/players/nfl", {
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

function installDefenseMarketGuard() {
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input ?? "");
    const response = await nativeFetch(input, init);
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
