# omp-e2e

`omp-e2e` is the non-publishable joined-system acceptance suite for the journal-first OMP spine. Tests use `omp-agent`, `omp-session`, `omp-journal`, `omp-driver::headless`, and the production environment and document authorities; no test constructs the removed legacy agent, transcript store, settings host, or chat actor.

## Harness contract

Scenario bodies live in `tests/`. `src/support` owns bounded waits, RAII process and daemon lifetimes, scratch roots, production document/environment connections, canonical scripted inference, and `.oms` session reopening. Scripts replace only nondeterministic provider output. The journal, DOM fold, dispatcher, document authority, environment authority, and terminal event path remain production implementations.

Every wait is bounded. Every process, task, socket, and temporary root has an RAII owner so panic unwinding cannot leak authority into another scenario. P7 drives the Cargo-built application on a real PTY through the debug protocol. P8 records measurements and locks their schema and arithmetic, but timing values are deliberately non-gating.

## Proofs

- P1: concurrent document leases preserve pinned reads and rebase non-overlapping stale writes.
- P2: `CancelTree` scope semantics and kernel `Up::Interrupt` / `Up::Cancel` preserve journal consistency.
- P3: dispatcher timeout settlement and `<meta><jobs>` / `JobBoard` lifecycle use one detached-job primitive.
- P4: only the live tool schema is advertised and `tool.call@1` records its selected `rev`.
- P5: Frozen, Stable, Dynamic, and Volatile prompt-band hashes preserve the provider cache prefix.
- P6: a killed mid-turn writer loses only a torn tail; `Session::open` reproduces the last committed DOM snapshot.
- P7: the production chat host handles input, streamed cards, resize, replay, and clean terminal restoration.
- P8: retained-frame and journal-first kernel throughput recorder.
- P9: isolated environment worktrees and extension Director/Component registration.
- P10: historical tool lifts are idempotent and the lifted live revision executes through `Dispatcher`.
- `tool_sources`: production environment source routing and shared document snapshots.

`just e2e-build` compiles the suite. `just e2e` runs P1–P7, P9, P10, and `tool_sources`, then runs the non-gating P8 recorder test. Individual groups are available as `e2e-core`, `e2e-p7`, `e2e-p8`, `e2e-p9`, and `e2e-p10`.
