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
interpreter. No user hooks, provider credentials, `.envrc`, shell profiles or
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
model, approvals, hooks, UI rendering, shell and direnv are outside this benchmark.

Compare reports on the same machine and runtime, using baseline, candidate and
reverted code. Dirty state includes untracked files, so writing reports inside
the checkout can set it. Keep output elsewhere for a clean revision comparison.
Use multiple runs for small differences; JIT and system load can affect them.
Do not describe these measurements as whole-agent speedups. The delay probe
demonstrates transport overlap, not a speedup for real reads.
