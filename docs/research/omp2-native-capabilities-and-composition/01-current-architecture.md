# Current source-pinned architecture

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).  
Authority: `AGENTS.md`, ADR ledger, production crates at the pin — not marketing claims.

## Production stack (do not duplicate)

| Layer | Owner | Role |
|---|---|---|
| Presentation / CLI | `omp-app` | Commands, TUI/ACP/RPC/print adapters; hidden `omp-envd` child dispatch |
| Composition | `omp-driver` | `compose_kernel`, discovery, registries, env wiring, subagent spawn |
| Kernel / turns | `omp-agent` | Mailbox, Directors, Dispatcher, Inference capability, approvals surface |
| Durable state | `omp-journal` + `omp-session` / `omp-dom` | Append-only journal, fold, components |
| Environment host | `omp-envd` | FS/process/document/tool authorities, extension host, admission hooks |
| Environment client | `omp-env` | Typed protocol client only |
| Tools | `omp-tool` contracts + `omp-tools` impls | Revisioned identities; envd executes |
| Inference | `omp-ai` + `omp-catalog` | Tower spine, providers-as-data |
| Shell | `omp-shell` + `omp-shell-builtins` | In-process bash + builtins (incl. `jq`) |
| Output projection | `omp-minimizer` | Model-facing shell filters |
| Extensions | `omp-ext` + envd exthost | Config, trust, grants |
| Workflows | `omp-adw` + driver ADW | Durable phase DAG (separate from soft `omp.workflows`) |

Libraries never build a second production stack. Driver composes; app presents.

## Extensibility surfaces already present

| Surface | Location (representative) | Authority |
|---|---|---|
| Skills discovery | `crates/driver/src/discovery/skills.rs` | Prompt / `skill://` material; not permission grant |
| Lifecycle hooks | `crates/contract/src/hooks.rs` (`HookPhase`, `HookGate`) | Admission/transform/observe; envd/driver hosts |
| Hook catalog | `crates/contract/src/hook_catalog.rs` | Stable event ordinals / masks |
| Tool admission hooks | `crates/envd/src/tools/hooks.rs` | Delegated `HookGate` for tool calls |
| AI layer hook | `crates/ai/src/layer/hook.rs` | Provider/request middleware (inspect separately) |
| Plugin hook bridge | `crates/driver/src/plugin_hooks.rs` | Plugin → native subscription bridge |
| Directors / Components | `omp-agent` / `omp-session` | Cross-turn control; journal fold |
| Model routing | catalog + `omp-ai` | Capability-based; no skill-granted authority |
| Approvals | ApprovalBook / envd | Durable human/policy gate |
| Forge / CI Dyn | tools mounts | PR/CI request-response + CI watch poll |

## Stream status against this pin

| Stream | Doc | Verdict so far |
|---|---|---|
| A Skills | [02](02-agentskills-compliance.md), [03](03-model-tool-requirements.md) | **REUSE** discovery; **EXTEND** optional field retention; **REJECT** second registry |
| B Hooks | [04](04-native-hooks-and-pluggy.md) | Auditor in flight |
| C Structured / sHEL | [05](05-structured-operations-shel.md) | Auditor in flight; native `jq` builtin exists |
| D Experts | [06](06-expert-package-composition.md) | **REJECT** ExpertPackage runtime |

## Non-goals (architecture)

- Parallel skill registry, hook framework, model router, journal, or verification engine  
- Treating skill YAML or EGM agreement as authorization  
- Embedding a second shell interpreter without measured benefit  
