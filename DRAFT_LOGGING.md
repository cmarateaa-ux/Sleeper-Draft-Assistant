# Experimental Draft Logging

This branch contains a durable telemetry framework for future Sleeper Draft Assistant experiments.

## What is captured

`src/def-market-guard.mjs` records JSONL telemetry for live Sleeper draft metadata and pick snapshots while the local server is running.

Each snapshot includes:

- timestamp
- build identifier
- draft ID
- pick count
- latest pick
- full pick-state snapshot
- draft slot
- player ID / position
- configured auto-draft slots
- whether the latest pick came from an auto-draft slot
- draft teams / type / scoring metadata when available
- request latency

The current experimental configuration marks **Team 4 / slot 4** as auto-drafting.

Logs are written locally to:

`draft-logs/live-telemetry.jsonl`

The logger is intentionally file-based and append-only so a slow or failed logging write does not block recommendations.

## Post-draft reconstruction

Run:

```bash
node scripts/draft-postmortem.mjs <draftId> 3
```

The second argument is your draft slot. The default is Team 3.

The script fetches the completed Sleeper draft and writes:

`draft-logs/postmortem-<draftId>.json`

This gives us a durable record of the actual draft, including your picks and Team 4 auto-draft picks.

## Important limitation

Build 41 did not persist the exact recommendation payload displayed at each pick. The telemetry framework therefore preserves the board state and timing needed for reconstruction, but it cannot retroactively recover every exact recommendation from the completed draft.

Future experimental builds should add a recommendation event containing:

- recommendation timestamp
- pick / round / user slot
- top recommendation
- top-N candidates and scores
- roster state
- available-player count
- ADP / projection / historical points
- positional-run state
- next-pick targets and survival estimates
- auto-draft slots / observed auto-draft behavior
- calculation latency
- build identifier

That event should be written alongside the pick-state snapshot so the recommendation can be evaluated against the eventual room behavior.
