# @oh-my-pi/omp-stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Stats storage in `bun:sqlite`, with hourly rollups so any range queries in milliseconds
- **Live web dashboard**: Opens instantly, ingests sessions in the background (newest first) and streams progress and updates to the page
- **Incremental sync**: Only processes new/modified log entries; a watcher re-syncs transcripts as they are written

## Metrics Tracked

| Metric                  | Calculation                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| Tokens/s                | `output_tokens / (duration / 1000)`                                        |
| Cache Rate              | `cache_read / (input + cache_read) * 100`                                  |
| Cache Savings           | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate              | `count(stopReason=error) / total_calls * 100`                              |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card           |
| Avg Latency             | Mean of `duration`                                                         |
| TTFT                    | Mean of `ttft` (time to first token)                                       |

Subscription-backed models use matching public API prices when an exact public model exists; these values estimate API-equivalent usage rather than the user's bill. Subscription-only models without a public price are reported as N/A and excluded from dollar totals.

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
omp stats

# Custom port
omp stats --port 8080

# Print summary to console
omp stats --summary

# Output as JSON (for scripting)
omp stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API Endpoints

| Endpoint                    | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `GET /api/stats`            | Overall stats with all breakdowns                                    |
| `GET /api/stats/models`     | Per-model statistics                                                 |
| `GET /api/stats/folders`    | Per-folder/project statistics                                        |
| `GET /api/stats/timeseries` | Hourly time series data                                              |
| `GET /api/events`           | Server-sent live status: sync progress, data version, rollup backlog |
| `GET /api/status`           | Current live status (same shape as the events)                       |
| `POST /api/sync`            | Start a background sync; progress arrives on `/api/events`           |

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

Synchronization fetches file metadata and saved cursors in bounded batches and overlaps transcript reads, including on macOS without worker threads. Statistics and cursors commit atomically; unchanged files are skipped, and interrupted batches are retried without double-counting usage.

Full reconciliation replays still scan every transcript. Unchanged transcripts retain their indexed rows while missing or stale records and unfinished links are repaired; modified transcripts are rebuilt. Parsing discards message bodies after extracting statistics rather than retaining entire decoded transcripts.

Range queries read `message_rollup` / `tool_rollup` / `session_rollup`, maintained from the raw tables: triggers mark touched hours and transcripts dirty (from any omp process), and the dashboard re-rolls them newest-first in short transactions. Reads stay exact by aggregating the few dirty hours raw; during an initial build the header shows the indexing backlog.

## Dashboard

Pages: Overview, Models, Providers, Costs, Requests, Errors, Traces, Tools, Frustration, Projects and Gain. `1`–`6` pick the time range; `g` then a letter jumps to a page. Every page revalidates when the live data version moves, so there is no refresh button.

## License

MIT
