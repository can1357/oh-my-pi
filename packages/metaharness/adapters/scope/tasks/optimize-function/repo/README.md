# namematch

Matches the product names shoppers type, and the names suppliers send, to the catalogue.

- `src/distance.ts`: `editDistance`, the edit distance every match is built on.
- `src/match.ts`: `bestMatch`, the closest catalogue name within a distance budget.
- `src/reconcile.ts`: maps a supplier feed onto the catalogue.
- `src/feed.ts`: pulls a supplier feed page by page under the supplier's rate limit.

## Benchmark

    bun run bench

Replays three shopper-query scenarios against the whole catalogue and prints the time each took.
The full replay takes about 15 seconds.

## Tests

    bun test

The feed suite waits out real rate-limit pauses and the reconcile suite matches a whole feed, so
the full run takes a while.
