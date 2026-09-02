---
title: Stats
description: The `omp stats` local usage dashboard — what it reads, where it stores, and what each section shows.
coverage: B
---

`omp stats` is the local observability dashboard for AI usage. It scans your session logs, aggregates request counts, tokens, cost, cache rate, and timing, and serves the result as a web dashboard plus JSON and console-summary modes for scripting.

## Launching the dashboard

```bash
omp stats               # start the dashboard server on http://localhost:3847
omp stats --port 8080   # custom port
omp stats --summary     # print a console summary and exit
omp stats --json        # print JSON output and exit
```

`omp stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running until you stop it with `Ctrl+C` (which closes the stats database cleanly).

The underlying `omp-stats` binary (used inside `omp stats` and exported by `@oh-my-pi/omp-stats`) accepts these flags:

| Flag | Short | Default | Description |
| --- | --- | --- | --- |
| `--port <port>` | `-p` | `3847` | Port for the dashboard server. |
| `--json` | `-j` | `false` | Output stats as JSON and exit. |
| `--sync` | `-s` | `false` | Sync session files and show summary. |
| `--help` | `-h` | — | Show usage information. |

## What it reads and stores

- **Reads:** `~/.omp/agent/sessions/` (the same directory the coding-agent writes session JSONL files to; scanned recursively so subagent and advisor transcripts in the same project folder count).
- **Stores:** `~/.omp/stats.db` — aggregates across runs.

The dashboard syncs session files before output, so changes since the last start are picked up automatically.

## Dashboard sections

The dashboard renders aggregate stats across these views; the same metrics surface in `--summary` and `--json` outputs.

### Overall

The headline numbers across every synced session:

- **Requests** — total assistant turns, with the failed (error-stopped) count in parentheses.
- **Error Rate** — fraction of requests that ended with `stopReason === "error"`.
- **Total Tokens** / **Input Tokens** / **Output Tokens** — token usage split.
- **Cache Rate** — cache-hit ratio (cache-read tokens over input tokens).
- **Total Cost** — USD total across all requests.
- **Premium Requests** — count of premium-tier requests, normalized to two decimals.
- **Avg Duration** — mean end-to-end request duration.
- **Avg TTFT** — mean time to first token.
- **Avg Tokens/s** — mean generation throughput when applicable.

### By Model

Per-model breakdown (top 10 in the console summary), with request count, cost, and cache rate for each.

### By Folder

Per-project folder breakdown (top 10 in the console summary), with request count and cost. Folders follow the same project-scoping rules the coding-agent uses (`~/.omp/agent/sessions/<dir-encoded>/…`).

## API endpoints

The dashboard server exposes these JSON endpoints:

| Endpoint | Purpose |
| --- | --- |
| `/api/stats` | Aggregate stats. |
| `/api/stats/models` | Per-model breakdown. |
| `/api/stats/folders` | Per-folder breakdown. |
| `/api/stats/timeseries` | Time-series data for charts. |
| `/api/sync` | Re-sync session files. |

## Programmatic use

`@oh-my-pi/omp-stats` exports helpers for embedding the aggregator into other tooling:

- `syncAllSessions()` — sync session files into the local stats DB.
- `getDashboardStats()` — fetch the full `DashboardStats` object (`overall`, `byModel`, `byFolder`, etc.).
- `getToolDashboardStats()`, `getTotalMessageCount()`, `getGainDashboardStats()` — additional aggregates.
- `smokeTestSyncWorker()` — self-test helper.
- `closeDb()` — close the stats DB (call on shutdown).

The exported `SyncOptions` and `SyncProgress` types drive the sync pipeline; the dashboard types (`AggregatedStats`, `DashboardStats`, `FolderStats`, `MessageStats`, `ModelStats`, `TimeSeriesPoint`, and the tool/gain variants) match the JSON returned by the API endpoints.
