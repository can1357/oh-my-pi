# Current OMP2 native capability audit

## Scope and confidence

Inspected `blyzer/oh-my-pi`, branch `omp2`, commit
`9cb6fd638918de77913a3e6c8fc42f9d5b3365bc` (2026-11-14).
The initial `/workspace` was not a checkout; a shallow clone was clean before research.
This is a Rust workspace, not the upstream TypeScript coding-agent stack.
`AGENTS.md`, root `Cargo.toml`, and real implementations were inspected. No production
Rust build or live LSP/sandbox integration proof was executed for this audit.
“Verified” below means source-traced implementation, with the cited tests as additional
repository evidence; it does **not** mean those tests were independently rerun.

Status vocabulary:

- **IV** — implemented and verified by source tracing.
- **II** — implemented but incomplete for the stated capability.
- **SI** — stub or interface only at the named boundary.
- **PD** — planned/documented but not implemented.
- **A** — absent from inspected tracked Rust source (bounded negative evidence).
- **U** — unknown or not verifiable in this environment.

A public trait is not automatically a stub: where concrete implementations exist, their
locations are given. Absence of a requested *name* is not absence of its underlying function.
Paths/ranges below resolve against the inspected commit; [the pinned source root][root]
provides the immutable reference. The matrix records maturity for verification reuse,
not an assertion that every provider/backend supports every operation.

## Production composition and execution

The actual composition boundary is `crates/driver/src/headless/kernel.rs:2457`,
`compose_kernel`. It constructs the agent/session and environment wiring. The core loop
is `crates/agent/src/loop.rs:463-539` (`Kernel<C>`), with `run_turn` at 1006 and the
`Inference` capability at 115. Do not build a second production agent stack in a verifier.
`Dispatcher` performs typed admission and execution (`dispatch.rs:1236-1451`,
`1573-1766`), and project effects belong to `omp-envd`, reached through `omp-env`.

Existing autonomous workflow infrastructure is more substantial than a blank review loop:
`omp-adw` has phase declarations, validated DAGs, explicit consumed inputs, acceptance,
rejection, replay and posture requirements. `crates/driver/src/adw/production.rs:1-10`
and `:130` implement a production host: code phases use environment execution and
agent/review phases use restricted child kernels. Untrusted workspaces refuse code
phases. These primitives are reusable, but workflow acceptance is not itself a
source-snapshot-bound proof of correctness.

## Capability matrix

LLM column answers whether the native operation can run without a model. “Yes” does
not mean it can prove arbitrary semantic correctness.

| Capability and actual API/location | Status | No LLM? | Dependencies / limits | Decision and missing verification work |
|---|---|---|---|---|
| Rust agent orchestration: `Kernel<C>`, `Inference`, `RunControl`, `run_turn`, `agent/src/loop.rs:115-328,463-539,1006`; `driver/src/headless/kernel.rs:2457` | IV | Kernel effects yes; inference no | Generic inference still requires a provider for model turns; budgets are runtime controls | **Reuse** composition, cancellation and turn lifecycle; add verifier invocation at driver boundary |
| Native tools: `Tool`, `ToolSpec`, `Rev`, `Effects`, `Confinement`, `OperationSpec`, `CallOutcome`, `tool/src/lib.rs:269-299,508-592,843-852,1170,1344-1479,1522`; `Registry`, `HostToolExecutor`, `tool/src/registry.rs:177,3022-3218` | IV | Yes | Revisioned schemas, route and authority restrictions; effect declarations are contracts, not OS enforcement by themselves | **Reuse** registry and result contracts; add verification tool/objective schemas without silent contract changes |
| Admission/approvals: `ToolAdmission`, `ToolAdmissionVerdict`, `Dispatcher::prepare/drive`, `agent/src/dispatch.rs:366-391,1573-1766`; `ApprovalBook`, `ApprovalDesk`, `contract/src/approvals.rs:294,763` | IV | Yes | Approval authorizes effects; it does not certify code | **Extend** with evidence-backed commit admission, preserving existing approvals |
| LSP diagnostics/navigation: `Action`, `Params`, `LspControl`, `tools/src/lsp/mod.rs:42-150,354-421`; concrete `envd/src/tool_lsp.rs`; `DiagnosticResult`, `diagnostics.rs:13-31` | IV | Yes | Requires configured language servers; `complete` matters; returned flat calls are not a complete program graph | **Reuse** fresh diagnostics, definition/references/hover/incoming/outgoing calls; capture server identity, revision and completeness |
| Compiler/checker commands: `Preset`, `CheckerRequest`, `CheckerExecutor`, `tools/src/lsp/checkers.rs:16-106`; concrete host in `envd/src/tool_lsp.rs` | IV | Yes | Cargo, tsc, Go, Pyright, Biome, SwiftLint or bindings must be installed; bounded rendered output is not full evidence | **Reuse**, retain raw diagnostics and exit/completion state |
| Deterministic check discovery/execution: `Suite`, `discover`, `run_suite_streaming`, `run_suite`, `driver/src/cleanse/checkers.rs:139-211,597,829-887`; parsers under `driver/src/cleanse/parsers/` | IV | Yes | `Suite.skipped` records missing binaries; Rust family includes cargo check/clippy/test; source says cargo test although repository development policy uses just/nextest | **Reuse** discovery, parsing and execution; do not equate skipped checks with success; select repository-approved recipes for OMP2 itself |
| Continuous diagnostic repair: `driver/src/cleanse/continuous.rs:38-90`, file-owned bounded workers and `FuturesUnordered`; production host `cleanse/production.rs` | IV | Collection yes; repair normally no | File ownership limits races, not dependency soundness; observations can race with repairs | **Extend** with immutable revision-bound verification and invalidation, rather than add duplicate repair scheduler |
| AST/Tree-sitter: `SupportLang`, `find_symbols`, `SymbolQuery`, `SymbolMatch`, `ast/src/symbol.rs:106-180,276`; `parse_cached`, `ast/src/parse_cache.rs:196-243`; `compile_pattern`, `collect_matches_with_parse_status`, `ast/src/ops.rs:136,297` | IV | Yes | Syntactic declarations and patterns; no type/dataflow proof; unsupported/macro-generated declarations need fallback | **Reuse** symbol/hunk extraction, syntax context, parse cache; record parse failure and language version |
| Structural summaries and symbol reading: `SummaryOptions`, `SummaryResult`, `summarize_source`, `ast/src/summary.rs:17-73,208`; `tools/src/read/symbol.rs`, `tools/src/lsp/symbol.rs` | IV | Yes | Summary is a projection; omission cannot be treated as security evidence | **Reuse** compact manifests and demand loading; include exact source ranges/digests |
| SCIP knowledge base: `Store::{open,stale,load,build,update,refresh}`, `kb/src/store.rs:101,137-168,263-301`; `Index`, `Query`, `Index::query`, `kb/src/graph.rs:83-123,583` | IV | Yes | Producer binaries external; stale indices explicitly labelled; tree-sitter fallback is syntactic | **Reuse and extend**; no new mandatory index server. Expose typed bounded query/coverage data to impact analyzer |
| SCIP producer support: `PRODUCERS`, `kb/src/producer.rs:51-83` | IV | Yes | Rust `rust-analyzer scip`, `scip-typescript`, `scip-python`; missing executable can yield absent producer; other supported syntax falls back | **Reuse** optional producers; missing semantic coverage broadens checks rather than implies no affected callers |
| References/call graph: `Index` symbols/calls/implementation and relation maps, `kb/src/graph.rs:39-123`; decode `:423`, query `:583` | II | Yes | Actual callers/callees exist; limited to indexed relations and AST enclosing-function interpretation. Dynamic dispatch, macros, FFI and omitted inputs require conservative treatment | **Extend** into impact closure with unknown-edge markers; do not advertise whole-program completeness |
| KB durable objects and freshness: `kb/src/store.rs:137-166,168-225,263-299` | IV | Yes | SHA256-index JSON objects; source snapshot checked around producers/build; update serializes and atomically publishes. `refresh` marks pending and schedules update, not per-symbol incremental recomputation | **Reuse** snapshot and atomic-publication patterns; add toolchain/dependency/policy/environment validity keys |
| CodeQueryIR, CodeIR, ChangeIR, VerificationIR exact types | A | N/A | No matches for those case-insensitive terms in tracked Rust sources inspected | **New domain types only as needed**, adapting existing Index/Query, VCS and ADW contracts; do not claim existing named IRs |
| Glean, Tantivy, tgrep indexing backends | A | N/A | No corresponding backend implementation found by tracked-source searches; `ast_grep` substring matches are not tgrep | **Do not add by default**; existing native grep/AST/SCIP cover first slice |
| General source dependency graph, CFG, def-use/dataflow | A / U | Possible deterministic future analysis | Existing call graph is not CFG/dataflow; ADW dependency graph is workflow ordering, not source dependency semantics. Compiler internals are not exposed as reusable general analysis here | **New conservative impact adapter**; derive package edges through compiler metadata and model unknowns. Security taint analysis remains optional provider work |
| Git/JJ change processing: `Repo::{head_id,diff_text,changed_files,numstat,uncommitted_diff}`, `vcs/src/lib.rs:118-175`; backend modules in `vcs/src` | IV | Yes | Text/file/numstat operations do not map changes into semantic impact; untracked/dirty state needs explicit capture | **Reuse**, extend to exact immutable source manifest and AST hunk mapping |
| Review finding structure: `FindingDetails`, `ReviewVerdict`, `parse_finding_details`, `parse_review_verdict`, `tools/src/review.rs:62-153` | II | Parsing yes; reviewer no | “Fully validated” documentation means shape/ranges/confidence validation, not verified source truth or repro | **Extend** with revision anchors, evidence IDs, falsification and INCONCLUSIVE; do not treat current parser as proof |
| Security scan: `SecurityScanService`, `envd/src/security_scan.rs:51-113`; `scan_workspace:1139-1240`; tools contract `tools/src/security_scan.rs:21-58` | II | Native scan yes | Actual native rules shown are private-key marker and AWS access-key detection, bounded by 20k files/2MiB. SARIF/cloud import, lineage and remediation support do not imply native taint analysis | **Reuse** provenance/SARIF/lineage; extend providers and explicit coverage accounting |
| Security finding validation: `SecurityScanService::validate`, `envd/src/security_scan.rs:419-451` | II | Recording yes | Persists caller-supplied status/summary/evidence; does not execute a counterexample or check source semantic truth | **Extend** dedicated validator; current API is an audit trail, not authoritative gate validation |
| Native test execution/reporting: `ExecutionRequest`, `ExecutionPlan`, `exec/src/request.rs:157-217`; `BuildReport::from_nextest_output`, `exec/src/report.rs:9-41`; `ExecutionResult`, `Outcome`, `exec/src/result.rs:19-109` | IV | Yes | Structured execution result exists; parser output alone does not prove required inventory was run; environment compatibility matters | **Reuse** execution results and artifacts, capture full logs and selected tests |
| Unified execution backends: `ExecutionBackend`, `ExecutionRun`, `BackendCapabilities`, `CachePolicy`, `exec/src/backend.rs:23-99,139-168`; concrete `exec-local`, `exec-ssh`, `exec-reapi` crates | IV | Yes | Cache/cancel/reattach capabilities vary by backend; no assumption of universal remote availability | **Reuse** local-first execution and optional remote providers, no Docker requirement |
| Sandbox: `SandboxSpec`, `DegradationPolicy`, `ResourceLimits`, `sandbox/src/spec.rs:116-181`; `Backend/CapabilitySet`, `sandbox/src/capability.rs:22,195`; plans `sandbox/src/plan.rs:58-126`; concrete `envd/src/exec_sandbox.rs` | IV / U live | Yes | OS/backend-dependent enforced capabilities and caveats; no live confinement proof run here | **Reuse** authority and fail-closed posture requirements; reject unsupported high-risk posture rather than silently downgrade |
| Subagents/workpools: `DriverSubagentSpawner`, `driver/src/subagent/spawn.rs:89-116`; scheduler `workpool_scheduler.rs:212`; production child `workpool_runtime.rs:338` | IV | Scheduling yes; model work no | Child kernels reuse compose_kernel; concurrency consumes resources and can mutate shared state unless constrained | **Reuse** restricted reviewers/repair ownership, isolate mutating tests/worktrees |
| Jobs and cancellation: `CancelTree`, `TurnCancellation`, `agent/src/cancel.rs:18-99`; `JobBoard`, `start_execution`, `wait`, `terminate`, `agent/src/jobs.rs:699,1024,1453,1545` | IV | Yes | Read-only, mutation and detached jobs have different cancellation scopes; interrupted unknown effects cannot be assumed reverted | **Reuse** propagation and lifecycle; serialize terminal evidence only after settlement |
| Journal and blob CAS: `BlobRef`, `BlobStore::{put,get,verify}`, `journal/src/blob.rs:47,368,546-679`; `RunLog`, `RunRecord`, `journal/src/runlog.rs:169,268-337` | IV | Yes | Blob existence/integrity is not validity of result; GC needs retained references; runlog records actions/versions, not verification domain semantics | **Reuse**, add typed evidence manifests and reachable durable references, no parallel session database |
| ADW domain: `Workflow`, `Phase`, `PhaseKind`, `adw/src/workflow.rs:29-128,167-248`; `Run::{next_step,accept,reject}`, `adw/src/run.rs:279-449` | IV | Yes | Accept/reject are host-decided domain transitions. Declared inputs version consumed outputs; reject/rewind invalidates dependents. Not source-level cache validity | **Extend** with verifier results and required objective inventory; retain phase DAG and rejection semantics |
| ADW execution posture: `Requirement`, `Posture`, `adw/src/profile.rs:105-153,231`; production `driver/src/adw/production.rs:1-10,60-125` | IV | Yes | Code phases require trusted workspace; declared posture cannot be silently degraded; delegated requirements can be rejected | **Reuse** risk profiles atop existing ceilings, no new approval bypass |
| Native memory/Mnemopi: `MemoryRuntime`, recall/config/store in `crates/memory/src` | IV / II | Retrieval yes; extraction/reflection may use model | Historical retrieval is not current source authority; see detailed [memory audit](03-mnemopi-retrieval-reranking.md) | **Reuse selectively**, never infer gate PASS from recalled text |
| Prompt projection/cache accounting: `template_props`, `project_thread_with_attachments`, `agent/src/prompt/projection.rs:19-90`; `Registry::project_cached/cache_projected`, `tool/src/registry.rs:3131-3140`; usage protobuf `proto/proto/omp/inference/v1/common.proto:67-70` | IV | Projection yes | Cache-read/write token counters exist; remote provider prefix-cache support and prices vary; CAS references may be inlined when building requests | **Reuse**, stable verification prefix plus bounded manifest; measure provider caching rather than infer it from local cache hits |
| Context compaction: `CompactionDirector`, `agent/src/directors/compaction.rs:59`; `Kernel::compact/compact_with`, `agent/src/loop.rs:3837-3852`; `crates/snapcompact` | IV | Some summary generation no | Compaction is lossy; it cannot replace authoritative source/evidence needed for security verdict | **Reuse** session resource management; durable receipts live outside compressed narrative |
| Forge integration: `ForgeHost`, `ForgeChecks`, `CheckState`, `forge/src/lib.rs:1-10`, `forge/src/check.rs:34-163`; concrete adapters `envd/src/forge_adapter/` | IV | Yes | This is vendor-neutral repository hosting, **not** HouMinXi review Forge. Required state accepts only Success, but empty required set passes | **Reuse** hosted checks/PR transport; verification gate must require explicit nonempty policy inventory where applicable |
| General native mutation/fuzz/property objective scheduler | A / U | Test tools can run without LLM | Repository uses property tests; execution can invoke external mutation/fuzz tools, but no generic nine-objective verifier was identified | **New optional provider adapters**, no speculative mandatory dependency |
| Dedicated VerificationEngine/EvidenceStore/FindingValidator snapshot-bound APIs | A | N/A | Existing contracts above supply substantial substrate; exact proposed domain interfaces not found | **Implement narrow domain layer** integrated with ADW/driver rather than rewrite runtime |

## Source-specific implications

1. **Use native checks before semantic review.** `cleanse` already discovers and parses
   deterministic checks, while `ExecutionRequest` carries toolchain, input set,
   environment, platform, posture, timeout and output specifications. A new verifier
   should preserve those identities instead of flattening everything into shell strings.
2. **Do not confuse index freshness with verification validity.** KB snapshots record
   revision/files, reject races while producers run, and hash persisted content.
   Compiler flags, lockfiles, generated input, policies, test fixtures and environment
   semantics must additionally enter verification keys.
3. **Conservative impact is feasible now, sound whole-program analysis is not proven.**
   Combine VCS hunks, Tree-sitter declarations, SCIP/LSP callers and package metadata.
   Missing semantic producers, syntax fallback and dynamic edges must widen execution.
4. **Do not infer confidence from names.** `FindingDetails` parsing and security
   `validate` are useful normalization/recording seams. Neither establishes a finding
   by executable evidence. Required Forge checks also need a complete policy inventory
   before their all-success predicate can serve as a gate.
5. **Keep authoritative evidence outside recalled/compacted narrative.** CAS addresses
   identify bytes; verified receipts must also identify source and all relevant inputs.
   Memory may suggest historical defect classes or tests, never authorize a commit.

## Negative searches and remaining verification work

Inspection commands included:

```sh
rg -n -i 'CodeQueryIR|CodeIR|ChangeIR|VerificationIR|SCIP|Glean|tgrep|Tantivy' crates Cargo.toml
rg -n 'pub (struct|enum|trait|async fn|fn)' crates/kb/src/{store,graph,producer}.rs
rg -n 'pub (struct|enum|trait|async fn|fn)' crates/tools/src/lsp/{mod,checkers,diagnostics,navigation}.rs
```

Names found only inside unrelated words (`AstGrep`, `GoogleAntigravity`) are not
backend evidence. “Absent” is bounded to inspected tracked implementation, not private
branches or installed external extensions. Documentation-only future proposals must
remain **PD** if referenced elsewhere; this audit does not promote ADR status into
implementation evidence. Live provider, OS confinement, backend cache, compiler and
LSP behavior remain **U** until joined tests are executed on supported hosts.

Follow-up validation should run repository `just` recipes for the touched owning
crates and their joined proofs, including P1 document races, P2 cancellation, P5
prefix stability, P6 crash/replay, P9 worktrees, P12 approvals and `tool_sources`
where applicable. Confirm exact current proof names in `crates/e2e/tests` before
selecting them; this audit does not report any unexecuted proof as passing.

[root]: https://github.com/blyzer/oh-my-pi/tree/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc
