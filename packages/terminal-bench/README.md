# @pk-nerdsaver-ai/terminal-bench

Run [harbor-framework/terminal-bench-2](https://github.com/harbor-framework/terminal-bench-2)
against the **local `omp` build** with a live progress / spend / success dashboard.

It drives [Harbor](https://github.com/laude-institute/harbor) (the official TB-2
harness) under the hood and renders its own dashboard by polling each trial's
`result.json`.

```
bun src/runner.ts --model anthropic/claude-sonnet-4-6 --tasks 20 --concurrency 4
```

```
terminal-bench-2 · omp · anthropic/claude-sonnet-4-6 · conc=4 k=1
████████████░░░░░░░░  12/20  elapsed 14:32  eta ~6:10
pass 9 (75%)   fail 2   err 1   run 4   pend 4
spend $1.84   in 1.2M  out 84k  cache 3.1M
──────────────────────────────────────────────────────
 ✓ fix-git                      r1.00   $0.12   1:40
 ✗ regex-chess                  r0.00   $0.31   4:10
 ! qemu-startup                 —       $0.04   0:30   TimeoutError
 ⠙ path-tracing                 ·       $0.05   2:01
──────────────────────────────────────────────────────
harbor: ...
```

## How it works

1. **Local omp, not npm.** Harbor's built-in `pi` agent installs the upstream
   `@mariozechner/pi-coding-agent`. This runner instead packs the working tree —
   `bun pm pack` in `packages/coding-agent`, which bundles every workspace TS
   package into `dist/cli.js` — and a custom Harbor agent
   ([`agent/omp_local.py`](./agent/omp_local.py)) uploads that tarball into each
   task container, installs Bun, `bun install`s the bundle's external deps + the
   matching `@pk-nerdsaver-ai/pi-natives-linux-<arch>` prebuilt, and runs
   `bun .../dist/cli.js --print --mode json --no-session --auto-approve`.
2. **Auth via the host gateway — no keys in containers.** A generated
   `~/.omp/agent/models.yml` routes the model providers' `baseUrl` at the host
   pm2 `omp-auth-gateway` (`http://host.docker.internal:4000`, `transport:
   pi-native`). The gateway resolves credentials host-side; containers only ever
   see a dummy `apiKey`. Cost/tokens are parsed from omp's `message_end` events.
3. **Live dashboard.** Harbor's own output is redirected to `harbor.log`; this
   process owns the terminal and polls `<jobDir>/result.json` (authoritative
   totals) + `<jobDir>/<trial>/result.json` (per-task reward/cost/tokens).

## Prerequisites

- **Docker** running (Docker Desktop on macOS — provides `host.docker.internal`).
- **Harbor**: `uv tool install harbor` (provides `harbor` on `PATH`).
- **Auth gateway** running on the host (pm2 `omp-auth-gateway`, default
  `127.0.0.1:4000`, started `--no-auth` on loopback). Check:
  `curl -s 127.0.0.1:4000/healthz`.

## Usage

```
bun src/runner.ts [options] [-- <extra harbor args>]
```

| Option | Default | Notes |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Repeatable |
| `-l, --tasks <N>` | `20` | Max tasks |
| `-n, --concurrency <N>` | `4` | Concurrent trials |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k) |
| `-i/-x, --include/--exclude <glob>` | — | Task filters (repeatable) |
| `--thinking <level>` | — | `off…xhigh` |
| `--advisor-model <p/m>` | — | Second model reviewing the primary; spend summed in |
| `--agent <name>` | `omp` | `oracle`/`nop`/any harbor agent (bypasses omp) |
| `--install <local\|published>` | `local` | `published` = npm `@pk-nerdsaver-ai/pi-coding-agent` |
| `--tarball <path>` / `--no-build` | — | Reuse a prebuilt omp tarball |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | |
| `--no-gateway` | off | Pass host provider keys into containers instead |
| `--allow-host <h>` | — | `harbor --allow-agent-host` (allowlist tasks) |
| `-o, --jobs-dir <path>` | `<repo>/runs/tb2` | |
| `--timeout-multiplier <f>` | — | Scale task timeouts |
| `--dry-run` | off | Print the harbor command + models.yml and exit |

### Examples

```bash
# Default 20-task run
bun src/runner.ts -m anthropic/claude-sonnet-4-6 -l 20 -n 4

# Compare models (separate runs / job dirs)
bun src/runner.ts -m openai-codex/gpt-5.1-codex -l 20 --thinking high

# Primary model + advisor model (combined spend reported)
bun src/runner.ts -m anthropic/claude-sonnet-4-6 --advisor-model anthropic/claude-haiku-4-5 -l 20

# Cheap pipeline smoke (no model spend — uses task reference solutions)
bun src/runner.ts --agent oracle -l 2

# Inspect exactly what will run
bun src/runner.ts --dry-run -l 20
```

## Output

Per run, under `--jobs-dir`:

- `<jobName>/` — Harbor's trial dirs (`result.json` per trial).
- `_bench/<jobName>/report.md` — markdown summary table.
- `_bench/<jobName>/harbor.log` — full Harbor output.
- `_bench/<jobName>/models.yml` — generated gateway routing (dummy key).

## Caveats

- **Network policy.** On Harbor's local Docker backend only **public**
  agent-phase tasks can reach the host gateway. `no_network` tasks cut off
  `host.docker.internal`; allowlist tasks aren't supported by the Docker backend
  (use `--allow-host` only when you know the task allows it). Such tasks surface
  as agent errors in the dashboard.
- **Architecture.** The native prebuilt is selected from the container's
  `uname -m` (linux-arm64 / linux-x64). Alpine/musl base images are unsupported
  (no musl prebuilt) and fail fast in `install()`.
- **`web_search` is off by default.** It can't authenticate through the gateway
  (it uses dedicated search-provider creds), so it's disabled in the container
  config to avoid 401s and false negatives. Re-enable with `--web-search` only
  if the container can reach a search provider. The report shows `web_search=on/off`.
- **Advisor spend accuracy vs speed.** `--advisor-model` runs a second model
  (separate spend, summed into the reported total + an `(advisor $…)` breakdown).
  Its turns are flushed to `__advisor.jsonl` only when the primary stays caught
  up, so the default `--advisor-sync 1` waits per turn for accurate spend.
  `--advisor-sync off` is faster but can drop end-of-run advisor backlog,
  undercounting advisor cost.
- **`--install local` reflects local TS changes** across the monorepo (they're
  inlined into `dist/cli.js`), but **not** uncommitted changes to the Rust
  natives or other externalized deps (mupdf, puppeteer) — those resolve from npm
  at the bundle's version.
