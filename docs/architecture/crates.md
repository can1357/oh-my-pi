# Workspace crate architecture

## Production spine

A live turn has one composition and one state authority:

```text
omp-app command adapter
  → omp-driver::compose_kernel
  → omp-agent::Kernel
  → omp-session::Session
      → append to omp-journal (.oms)
      → fold the exact entry into omp-dom
  → omp-chat actor over Session::subscribe()
```

`omp-app` owns process startup and presentation adapters. `omp-driver` owns composition, discovery,
con/cfg setup, registries, environment wiring, and subagent spawning. `omp-agent` owns turn
execution, dispatch policy, cancellation, jobs, Directors, hooks, extensions, and approvals.
`omp-session` is the only session-state authority: it owns the journal and DOM, and publishes a
detached snapshot followed by ordered patch/stream/reset events. `omp-chat` renders its own replica
and returns user actions through a mailbox; it cannot mutate controller state.

## State and control

| Crate | Responsibility |
|---|---|
| `omp-journal` (`crates/journal`) | Flat raw-SSE `.oms` journal, branching/live-chain rules, torn-tail recovery, and blob CAS. |
| `omp-dom` (`crates/dom`) | Typed handle arena, atomic patches, streams, selectors, snapshots, and subscriptions. |
| `omp-vocab` (`crates/vocab`) | Closed structural tag/property vocabulary shared by session DOM, macros, and TUI. |
| `omp-session` (`crates/session`) | Journal-first write API, single live/replay fold, components, rewind lifecycle diff, and pure projections. |
| `omp-con` (`crates/con`) | Typed convars, layers, cfg scripts, commands, binds, aliases, and actions. |
| `omp-cache` (`crates/cache`) | Non-authoritative document, GitHub, MCP, secret-key, and statistics caches. |

The journal is durable authority; caches are disposable accelerators. User-facing configuration is
a convar declaration plus command stream, with archived values represented by cfg scripts.

## Runtime and inference

| Crate | Responsibility |
|---|---|
| `omp-agent` | Kernel loop, tool dispatch, bounded results, cancellation tree, job board, Directors, hooks, extension seams, approvals. |
| `omp-tool` | Versioned tool contracts, streamed events, outcomes, and registry. |
| `omp-tools` | Built-in resource-owning tool implementations. |
| `omp-env` / `omp-envd` | Typed environment client / trusted environment host and worker supervision. |
| `omp-catalog` | Compiled provider/model compatibility, routes, capabilities, and pricing. |
| `omp-inference` | Typed requests, provider codecs, routing, recovery, and canonical `ChatEvent` streams. |
| `omp-ext` / `omp-py` | Extension manifests/trust / embedded free-threaded Python runtime and frozen modules. |
| `omp-shell-engine` / `omp-shell-builtins` | In-process Bash parser/runtime and built-ins. |

## Presentation and transports

| Crate | Responsibility |
|---|---|
| `omp-chat` | Session-subscriber actor, transcript projection, typed tool cards, composer, overlays, and actor-local UI state. |
| `omp-tui` / `omp-macros` | Retained terminal components, elastic transcript slots, rendering/input/debug protocol, and typed `dom!`. |
| `omp-gui` | Native GPU window host for retained UI applications. |
| `omp-app` | CLI commands for chat, print, render, RPC, RPC-UI, ACP, daemon, and gallery. |
| `omp-rpc` / `omp-serve` | Transport framing and service projections; neither owns canonical session semantics. |
| `omp-sdk` | Stable native embedding facade over the production composition. |
| `omp-e2e` | Joined-system P1–P8 acceptance proofs. |

## Supporting engines

`omp-core` supplies allocation-aware primitives; `omp-proto` owns generated wire contracts;
`omp-observability` and `omp-telemetry` own diagnostics and telemetry. The document authority now lives
inside `omp-envd`. Resource and editing engines include `omp-ast`, `omp-walker`, `omp-grep`, `omp-ar`,
and `omp-edit`, while tolerant JSON parsing is provided by `omp_core::slopjson`. These are libraries
below the production spine and never assemble a competing agent/session stack.

## Ownership rules

1. Driver composes; app presents.
2. Session appends first and folds the exact returned journal entry; replay uses the same fold.
3. Actors consume snapshots and events and send commands back; they never hold session authority.
4. Envd owns host resources and policy enforcement; `omp-env` is only its typed client.
5. Catalog owns compatibility facts; inference owns translation and correction.
6. Tool contracts are versioned and presentation consumes their typed payloads.
7. Transport crates project canonical state; they do not invent a second dialect or store.
