# @oh-my-pi/pi-metaharness

One manager for repository benchmarks. Harbor, TypeScript edit, and SnapCompact
runs use the same experiment → run → trace model, SQLite store, REST/SSE API,
and dashboard. Benchmark-native artifacts remain on disk; adapters normalize
their live progress, scores, token usage, costs, and traces.

```bash
# Dashboard + API on :4700; launch every benchmark from the same “new run” form
bun run serve --port 4700
```

## How Harbor runs execute

1. **Local omp, not npm.** By default the runner bind-mounts the repo
   read-only into each task container (`--install source`) and runs omp
   straight from `packages/coding-agent/src/cli.ts` — TS edits apply to the
   next trial with no rebuild. A cached linux `node_modules` tree (built once
   per lockfile change inside `oven/bun`, stored in `<jobs-dir>/_bench/_deps/`)
   shadows the host's darwin one, and a linux `bun` binary is mounted at
   `/opt/omp/bin` — so trial setup needs zero outbound network. Alternatives:
   `--install local` (pack a tarball per run) or `--binary` (prebuilt
   `dist/omp-linux-*` self-contained binaries).
2. **Auth never enters containers.** A generated `models.yml` routes provider
   `baseUrl`s at the host pm2 auth-gateway; the gateway resolves credentials
   host-side.
3. **Harbor owns trials.** The runner/serve layer polls each trial's
   `result.json` for progress, spend, and outcomes.

## Server

- `GET /` — experiments, runs, normalized traces, and a launch form for every benchmark.
- `GET /api/experiments[?q=]` — experiment summaries across all benchmark types
  (`q` filters by id/goal substring).
- `POST /api/experiments` — register an experiment before its first arm. Body
  `{ "id": "sb2", "goal": "..." }`; the id is the dash-free token job names
  group under (`sb2-n8` → experiment `sb2`).
- `GET /api/experiments/:id` — arms, per-task matrix, and calibrated projections.
- `PUT /api/experiments/:id` — update the goal and per-run role/note/label.
- `POST /api/experiments/:id/arms` — launch a comparable arm; sample + config
  inherited from a sibling.
- `DELETE /api/experiments/:id` — delete every arm (DB rows **and** job dirs)
  plus the goal row; rejected while any arm is running.
- `GET /api/runs[?experiment=&status=&benchmark=]` — uniform run rows with
  benchmark, score, progress, spend, and tokens.
- `POST /api/runs` — launch through a benchmark adapter. Body:

  ```json
  {
    "benchmark": "edit",
    "model": "anthropic/claude-opus-4-8",
    "tasks": 20,
    "concurrency": 4,
    "attempts": 2,
    "jobName": "edit-baseline",
    "role": "baseline",
    "goal": "compare edit strategies"
  }
  ```

  `benchmark` is `harbor`, `edit`, or `snapcompact`. Harbor uses `dataset`,
  `include`, `timeoutMultiplier`, and `prewalk`; edit uses `include` as task IDs;
  SnapCompact uses `conditions` and treats `tasks` as the passage limit.
- `GET /api/runs/:name` — `{ run, traces }` (syncs native artifacts on read).
- `POST /api/runs/:name/cancel` — cancel a manager-launched run.
- `DELETE /api/runs/:name` — permanently delete a finished run (DB row **and**
  job dir; a surviving dir would be re-discovered on restart); rejected while
  the run is live.
- `POST /api/runs/:name/resume` — resume an incomplete harbor run in place:
  completed trials (and their spend) are reused, interrupted/pending trials
  re-run, and errored trials retried (body `{ "filterErrorTypes": [...] }`
  overrides the retry set, which defaults to every exception type in the job's
  `result.json`). The runner recovers the original launch flags from
  `_bench/<name>/runner-config.json` (snapshotted at launch) or the run's
  `manager.json` — nothing needs re-specifying.
- `GET /api/runs/:name/traces/:trace[?raw=1]` — normalized or native trace.
- `GET /api/events` — SSE stream of run-list snapshots (sent on change).

State lives in `<jobs-dir>/_manager/metaharness.sqlite`; the filesystem
stays the source of truth and historical CLI runs are auto-discovered.

## Native Terminal-Bench 2.1 runner

`bench:tb` bypasses Harbor and Docker. It boots each task's published OCI
image as an x86_64 KVM microVM on a Vibemon host, streams omp's `--mode rpc`
protocol through `vmon exec --pipe`, runs the verifier in the same mutated VM,
and writes resumable epochs plus artifacts under `runs/tb`.

```bash
bun run bench:tb \
  --dataset /path/to/terminal-bench-2-1 \
  --concurrency 4 --forever --budget 25
```

For the measured workstation defaults (seven-model pool, `:floor`, concurrency
20), use the resumable wrapper:

```bash
bun --cwd packages/metaharness run bench:tb-floor
```

It writes to `runs/tb-floor`; rerunning resumes an incomplete epoch or starts
the next epoch after completion. Environment overrides: `TB_JOBS_DIR`,
`TB_CONCURRENCY`, `TB_DATASET`, `TB_BUDGET_USD`, `TB_ATTEMPTS`, and
`TB_FOREVER=1`. Extra CLI flags pass through and win over wrapper defaults.

The default pool is Ling 3.0 Flash, both DeepSeek V4 Flash routes (0731 and
unversioned/0423), Nemotron 3.5 Lightning, Laguna S 2.1, Tencent Hy3, and Step
3.7 Flash through OpenRouter. Requests default to OpenRouter's `:floor`
cheapest-provider routing; use `--openrouter-variant default|nitro|online|exacto`
to override it. Repeat `--model provider/id` to replace the pool.

Defaults target the workstation's `xeon.internal` KVM host and the local
`/work/vibevmm` checkout. The runner cross-builds and caches a patched `vmon`
binary when the remote copy lacks raw pipe support, owns a privileged TAP
broker for its lifetime, and reverse-tunnels the loopback omp auth gateway so
provider credentials never enter task VMs. Trial agents use a lean terminal
tool allowlist, `edit.mode: replace`, and the same low-cost
`openrouter/qwen/qwen3.7-flash` vision role; general orchestration tools are
omitted from the benchmark prompt. Override infrastructure with
`--vmon-host`, `--vmon-source`, `--vmon-bin`, `--vmon-home`,
`--vmon-kernel`, `--vmon-agent`, and `--gateway-url`.

## Harbor runner options (excerpt)

| Option | Default | Notes |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Repeatable |
| `-l, --tasks <N>` | `20` | Max tasks |
| `-n, --concurrency <N>` | `4` | Concurrent trials |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k) |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Any Harbor dataset id |
| `-i/-x, --include/--exclude <glob>` | — | Task filters (repeatable) |
| `--timeout-multiplier <x>` | — | Scales task agent/verifier timeouts |
| `--agent-arg <arg>` | — | Extra arg forwarded verbatim to the in-container omp CLI (repeatable) |
| `--env <KEY[=VALUE]>` | — | Forward env into the omp container (repeatable); `KEY` alone forwards the host value |
| `--binary <path>` | — | Prebuilt omp binary (repeat for arm64+x64) |
| `--install <source\|local\|published>` | `source` | `source` = repo bind-mount, `local` = tarball pack, `published` = npm `@oh-my-pi/pi-coding-agent` |
| `--environment <docker\|apple-container>` | `docker` | `apple-container` runs trials via Apple's `container` CLI (no Docker); source/deps mounts go through `harbor --mounts` and the gateway is auto-forwarded from `192.168.64.1:4000` to the loopback-bound gateway |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | `http://192.168.64.1:4000` under `--environment apple-container` |
| `--no-gateway` | off | Pass host provider keys into containers instead |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | Shared with the server |
| `--resume <name\|path>` | — | Resume that job dir via `harbor job resume`; original flags recovered automatically |
| `--filter-error-type <T>` | `CancelledError` | With `--resume`: also re-run completed trials that errored with exception type `T` (repeatable) |
| `--dry-run` | off | Print the harbor command + models.yml and exit |

## Outputs

- `<jobs-dir>/<jobName>/` — Harbor trial dirs (`result.json` per trial).
- `<jobs-dir>/_bench/<jobName>/report.md` — markdown summary table.
- `<jobs-dir>/_bench/<jobName>/harbor.log` — full Harbor output.
- `<jobs-dir>/_manager/logs/<jobName>.log` — runner output for API-launched runs.

## Trace reports

`scripts/trace-report.ts` turns one run trace into a narrative markdown report
(numbered Turn Log with one grounded sentence per assistant turn, harness
notices in place, then a Story Arc and — for failed runs — a failure analysis).
It map/reduces the normalized trace through two cheap OpenRouter models
(defaults: `inclusionai/ling-2.6-flash` per turn, `openai/gpt-oss-120b` for the
arc; ~$0.001 per report). API keys resolve through omp's auth storage.

```bash
bun scripts/trace-report.ts <run> <trace> [--focus "reviewer notes"] [--out report.md]
bun scripts/trace-report.ts "sb3-ntg|django__django-12325__ddQroP4"   # run|trace also accepted
```

Flags: `--base` (server, default `http://localhost:4700`), `--tiny` / `--synth`
(`<provider>/<model-id>` overrides), `--focus` (extra reviewer context, e.g. the
known-correct fix for a failed task), `--concurrency` (default 8).

## Caveats

- **Network policy.** On Harbor's local Docker backend only **public**
  registries work; task containers reach models via the host gateway.
- **`--install source` reflects local TS changes** with no rebuild, but Rust
  natives load from the in-tree `packages/natives/native/pi_natives.linux-*.node`
  prebuilds — rebuild those when Rust changes (the loader skips the version
  sentinel for workspace loads, so a stale `.node` runs silently).
- **Source mode is single-arch.** The deps tree matches the docker daemon's
  native arch; trials on emulated images (e.g. x64 tasks on an arm64 host)
  fail setup with an arch-mismatch error — use `--binary` for those.
- **The repo is visible (read-only) inside task containers** in source mode;
  fine for curated benchmarks, but don't point it at untrusted tasks.
- **Apple Container specifics.** `--environment apple-container` needs
  `brew install container && container system start` (macOS 26+, Apple
  silicon). `--host-network` and `--cleanup*` are docker-only, and bind
  mounts are read-write (the backend ignores `read_only`).
- **`--install local` reflects local TS changes** (inlined into `dist/cli.js`),
  but **not** uncommitted Rust natives — rebuild `packages/natives` per target
  first (the version sentinel must match).
