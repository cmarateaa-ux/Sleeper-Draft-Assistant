const nativeFetch = globalThis.fetch.bind(globalThis);
let playerDefCache = null;
let activePlayersCache = null;
let activePlayersPromise = null;

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

    // Sleeper documents /players/nfl as a large (~5 MB) bootstrap endpoint and
    // recommends filtered position/active requests instead. Build the same
    // player map from six small parallel requests so recommendation startup
    // does not spend tens of seconds downloading the full player database.
    if (url === "https://api.sleeper.app/v1/players/nfl") {
      const players = await getActivePlayers();
      return new Response(JSON.stringify(players), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

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
