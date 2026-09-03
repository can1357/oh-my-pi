# @oh-my-pi/omp-stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Efficient stats storage and querying using `bun:sqlite`
- **Web dashboard**: Real-time metrics visualization with Chart.js
- **Incremental sync**: Only processes new/modified log entries

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Cache Savings | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

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

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `GET /api/sync` | Trigger sync and return counts |

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

## Dashboard

The web dashboard provides:

- Overall metrics cards (requests, API-equivalent estimate, cache rate, cache savings, error rate, duration, tokens/s)
- Time series chart showing requests and errors over time
- Per-model breakdown table
- Per-folder breakdown table
- Auto-refresh every 30 seconds

## License

MIT
