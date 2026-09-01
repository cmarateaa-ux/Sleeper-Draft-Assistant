import fs from "node:fs/promises";

const draftId = String(process.argv[2] || "");
const userSlot = Number(process.argv[3] || 3);
const autoDraftSlots = new Set([4]);

if (!draftId) {
  console.error("Usage: node scripts/draft-postmortem.mjs <draftId> [yourSlot]");
  process.exit(1);
}

async function sleeper(pathname) {
  const response = await fetch(`https://api.sleeper.app/v1${pathname}`, {
    headers: { "user-agent": "Sleeper-Draft-Assistant-postmortem/1.0" },
  });
  if (!response.ok) throw new Error(`Sleeper returned ${response.status} for ${pathname}`);
  return response.json();
}

function slotFor(pickNo, teams, type) {
  const within = ((pickNo - 1) % teams) + 1;
  const round = Math.ceil(pickNo / teams);
  return type === "linear" ? within : round % 2 === 1 ? within : teams - within + 1;
}

const [draft, picks] = await Promise.all([
  sleeper(`/draft/${draftId}`),
  sleeper(`/draft/${draftId}/picks`),
]);

const teams = Number(draft.settings?.teams ?? 12);
const type = draft.type ?? "snake";
const normalized = picks.map((p) => ({
  pickNo: Number(p.pick_no),
  round: Math.ceil(Number(p.pick_no) / teams),
  draftSlot: Number(p.draft_slot),
  calculatedSlot: slotFor(Number(p.pick_no), teams, type),
  playerId: p.player_id ?? null,
  playerName: [p.metadata?.first_name, p.metadata?.last_name].filter(Boolean).join(" ") || p.metadata?.full_name || p.player_id,
  position: p.metadata?.position ?? null,
  team: p.metadata?.team ?? null,
  autoDraft: autoDraftSlots.has(Number(p.draft_slot)),
  userPick: Number(p.draft_slot) === userSlot,
}));

const userPicks = normalized.filter((p) => p.userPick);
const autoDraftPicks = normalized.filter((p) => p.autoDraft);
const byRound = new Map();
for (const pick of normalized) {
  const list = byRound.get(pick.round) || [];
  list.push(pick);
  byRound.set(pick.round, list);
}

const report = {
  generatedAt: new Date().toISOString(),
  draftId,
  build: "sleeper-live-refresh-2026-08-31-41",
  configuration: {
    userSlot,
    autoDraftSlots: [...autoDraftSlots],
    teams,
    type,
    scoringType: draft.metadata?.scoring_type ?? null,
    season: draft.season ?? null,
  },
  summary: {
    totalPicks: normalized.length,
    userPicks: userPicks.length,
    autoDraftPicks: autoDraftPicks.length,
    finalPick: normalized.at(-1) ?? null,
  },
  userPicks,
  autoDraftPicks,
  picks: normalized,
  rounds: Object.fromEntries([...byRound.entries()].map(([round, list]) => [round, list])),
};

await fs.mkdir("draft-logs", { recursive: true });
const output = `draft-logs/postmortem-${draftId}.json`;
await fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");

console.log(`Post-mortem written to ${output}`);
console.log(`Draft: ${draftId}`);
console.log(`Build: ${report.build}`);
console.log(`Teams: ${teams} · Format: ${type} · Scoring: ${report.configuration.scoringType ?? "unknown"}`);
console.log(`Total picks: ${normalized.length}`);
console.log(`Your slot: ${userSlot} · Your picks: ${userPicks.length}`);
console.log(`Auto-draft slots: ${[...autoDraftSlots].join(", ")} · Auto-draft picks: ${autoDraftPicks.length}`);
console.log("\nYour picks:");
for (const pick of userPicks) console.log(`  ${pick.pickNo}. ${pick.playerName} (${pick.position ?? "?"})`);
