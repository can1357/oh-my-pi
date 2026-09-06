# Local tool latency benchmark

From the repository root, after installing dependencies and the matching native
addon and running `bun run gen:tool-views`:

```sh
bun packages/coding-agent/scripts/bench-tool-latency.ts > tool-latency.json
bun packages/coding-agent/scripts/bench-tool-latency.ts --runs 10 --warmups 3 --python /path/to/python3 > tool-latency-python.json
```

This developer command runs deterministic local read/search fixtures without
calling a model. It launches a measurement process with a temporary agent
directory, minimal environment, in-memory settings and a tool registry limited
to read, grep and a fixed 50 ms delay probe. The parent removes temporary state
after the measurement process exits. Python is opt-in; supply a working Python
interpreter by absolute path. No user hooks, provider credentials, `.envrc`, shell profiles or
workspace scripts are executed. It does not introduce a doctor command or a CI
performance threshold. `--help` and invalid arguments do not start workloads.

The JSON report contains the checkout revision/dirty state, OS/runtime, fixture
sizes, first-call latency, raw warm samples, median, nearest-rank p95, errors and
observed concurrency. Failed observations are excluded from percentiles, remain
visible in the report and cause a nonzero exit. Startup/setup failures are fatal
and go to stderr. Progress goes to stderr, so stdout stays machine-readable.

Routes use the real tool implementations: direct execution, host bridge, JS eval
and optional Python eval. Every result's formatted text must match the canonical
tool result after removing the variable repeat-read notice; the fixture check also requires the expected content. Workloads
include a small file, a middle range in a 1 MB text file and native grep. Four
reads and four controlled delays run both sequentially and concurrently inside
each route. Batch timing is elapsed time, never the sum of concurrent durations.

First-call timings are single observations, not cold-start distributions. Module
imports and canonical fixture validation happen before measurement. Only the first
cell in each language includes its kernel initialization; later workload first
calls reuse the kernel. JS/Python measurements include JSON serialization and
kernel output. The output column cap is disabled for lossless JSON transport. No internal phase durations are inferred. The outer agent loop,
model, approvals, hooks, UI rendering and general shell execution are outside this benchmark. Direnv is measured only when explicitly selected below.

Compare reports on the same machine and runtime, using baseline, candidate and
reverted code. Dirty state includes untracked files, so writing reports inside
the checkout can set it. Keep output elsewhere for a clean revision comparison.
Use multiple runs for small differences; JIT and system load can affect them.
Do not describe these measurements as whole-agent speedups. The delay probe
demonstrates transport overlap, not a speedup for real reads.


## Optional cold kernels and direnv

```sh
bun packages/coding-agent/scripts/bench-tool-latency.ts --runs 10 --warmups 3 --python /path/to/python3 --cold-runs 10 --direnv /path/to/direnv > tool-startup.json
```

`--cold-runs N` (1–30) adds paired empty-cell measurements in N fresh Bun
processes per language. `coldKernels[].raw` reports `firstCellMs`, `secondCellMs`
and `processMs` for each pair. The first cell includes kernel startup and
interpreter discovery but excludes host module imports and fixture setup; the
second cell reuses that kernel. `processMs` includes host imports, both cells,
output collection and teardown. This is a benchmark harness process, not CLI
startup or time to first model token. OS filesystem caches remain warm between
processes. Failures are retained and excluded from the corresponding summaries.

`--direnv /absolute/path/to/direnv` is POSIX-only and adds no-envrc, blocked,
allowed-simple and allowed-watched-file rows using the real `loadDirenvEnv`.
The launcher gives the child a temporary HOME and XDG config/data/cache roots,
and puts a link to the selected binary first on PATH. It allows only generated
`.envrc` fixtures in this temporary state. It never approves or sources the
caller's workspace `.envrc`. No Nix/devenv environment is built.

Direnv timing windows include ancestor lookup, process execution, parsing and
result validation. Approval and fixture creation happen before measurement.
Outside the timing windows, the suite verifies that a watched-file change is
reflected, revoked approval is respected, editing an approved `.envrc` requires renewed approval, and a blocked
fixture never executes. `unchangedEvaluations` counts how often the watched
fixture was evaluated across its first call, warmups and measured calls. These
checks guard against interpreting a stale environment cache as a performance
improvement. Both optional sections are separate from the original `rows`.
