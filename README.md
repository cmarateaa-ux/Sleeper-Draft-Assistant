# Sleeper Draft Assistant

A Sleeper-first live fantasy football draft assistant.

## Tonight's MVP
- Connect to a live Sleeper draft by draft ID or Sleeper draft URL.
- Poll the read-only Sleeper API for new picks.
- Detect draft slot, current pick, roster ownership, league settings, and available players.
- Combine Sleeper market signals with independent ADP/rankings feeds.
- Produce a ranked recommendation for the user's next pick with a concise explanation.

Sleeper is the only live draft platform targeted by this application. Other fantasy sites are supporting data sources only.

## Data boundary
Sleeper's API is read-only and does not require an API token. Keep request frequency conservative. Player data should be cached because Sleeper notes that the full player map does not need to be fetched more than once per day.

## Development
The first implementation is browser-runnable so it can be tested quickly. Desktop packaging is intentionally separate from the live-draft engine.
