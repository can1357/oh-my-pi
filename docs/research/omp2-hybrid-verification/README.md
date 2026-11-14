# OMP2 native-first hybrid verification research

Research snapshot: **2026-11-14**. Recommendation: build a **native verification
subsystem using existing OMP2 orchestration and execution**, with pluggable focused
semantic reviewers. Adapt Forge's evidence/falsification discipline; keep original
Forge as a measured comparison provider. Make reranking optional and advisory.
Do not replace effective multi-perspective review on assumed token savings.

## Inspected repositories and state

The supplied `/workspace` was initially not a Git checkout. A shallow clone of
`https://github.com/blyzer/oh-my-pi` checked out its actual default/target branch
`omp2`, clean, at **`9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`**. Research branch:
`research/omp2-native-hybrid-verification`, created directly from that commit.
The target is a Rust workspace (embedded Python and auxiliary scripts are present),
not the upstream TypeScript coding-agent stack. The final research commit is
intentionally excluded from the source baseline: its only changes are these artifacts.

| Source | Inspected immutable reference | Interpretation |
|---|---|---|
| [blyzer/oh-my-pi](https://github.com/blyzer/oh-my-pi/tree/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc) | `9cb6fd638918de77913a3e6c8fc42f9d5b3365bc` (`omp2`) | Primary native implementation |
| [HouMinXi/forge](https://github.com/HouMinXi/forge/tree/91338bb2eb57e27b44c9164a2ada63aebb05fa4e) | `91338bb2eb57e27b44c9164a2ada63aebb05fa4e` (`main`) | Python review Forge; distinct from `crates/forge` |
| [upstream PR #18747](https://github.com/can1357/oh-my-pi/pull/18747) | head `92ce767cc18379efde6315f0d2069088d671450d`; base `55251e34c26eeb5a31a5c86cedf243acd7e2cb23` | Optional Mnemopi cross-encoder proposal; open/unmerged when inspected |
| [upstream PR #19210](https://github.com/can1357/oh-my-pi/pull/19210) | head `9f52feb512ffa69b63f5c0a3ffdcc49fe4ee97ad`; base `6ec2b71cd7d80e18e1b6481f2e3d9c05f5f0c56c` | Diff renderer parsing/allocation optimization; unrelated to reranking |

Upstream PR head and base code are historical comparison sources, not proof that
upstream features are ported to OMP2. Source references are pinned throughout.
“Implemented and verified” means source-traced unless explicitly marked as an
executed experiment; no native runtime tests were rerun here.

## Findings that change the design

- Reuse the real `Kernel`/driver composition, ADW versioned phase graph, native
  `cleanse` checkers, typed execution backends, SCIP/Tree-sitter KB, LSP, sandbox
  authority, journal and blob CAS. Do not introduce replacement frameworks.
- Exact CodeQueryIR/CodeIR/ChangeIR/VerificationIR types and the named
  Glean/Tantivy/tgrep backends were not found. Existing call navigation is useful,
  but does not establish sound CFG/dataflow or complete change-impact analysis.
- Finding parsing and security-scan validation are not executable proof of truth.
  Native security rules inspected are limited; a general taint engine is not present.
- Forge's three roles repeatedly receive shared review material. They are not
  automatically independent models. Current clean-window semantics, grouping,
  CI mode and retries make “exactly nine complete reviews” an inaccurate universal
  model. Its receipt and incompleteness checks are worth preserving.
- Rust OMP2 recall differs materially from TypeScript Mnemopi: four voices,
  weighted fusion, no active MMR path and no production cross-encoder wiring.
  PR #18747's actual CE/MMR execution order and score/cache behavior need explicit
  evaluation rather than copying its description as an implementation guarantee.
- Memory is historical knowledge. It may propose tests and defect hypotheses;
  only current source-bound, complete verification evidence can satisfy a gate.
- Whole-input identity, dependencies, policy, compiler, test inputs and environment
  must enter validity. Neither diff hashes nor content addresses alone prove reuse safe.

## Reading map

1. [Current capability audit](01-current-capability-audit.md): APIs, six maturity
   statuses, no-LLM operation, dependencies and reuse/extend/new matrix.
2. [Forge source analysis](02-forge-source-analysis.md): runtime perspectives,
   clean credits, receipts, falsification, grouping, mutation, backend and security.
3. [Mnemopi retrieval and reranking](03-mnemopi-retrieval-reranking.md): exact
   algorithms/callers, upstream differences, A–D pipeline choice and 16 GB feasibility.
4. [Architecture and ADR-R01](04-native-first-architecture.md): three integration
   strategies, recommended ownership and architecture diagram.
5. [Evidence store and context](05-evidence-store-and-context.md): candidate Rust
   boundaries, CAS/GC reuse, dependency keys, invalidation and demand loading.
6. [Nine verification objectives](06-verification-gates.md): deterministic/model
   responsibilities, evidence, falsification, reruns and tri-state gates.
7. [Autonomous loop](07-autonomous-loop.md): sequence diagram, profiles, budgets,
   repair convergence, cancellation, authority and injection resistance.
8. [Evaluation and experiments](08-benchmarks-and-evaluation.md): four-arm protocol,
   metrics, raw executed experiment and explicit unexecuted benchmarks.
9. [Implementation roadmap](09-implementation-roadmap.md): P0/P1/P2 files, API
   boundaries, dependencies, acceptance/tests, risks and relative effort.
10. [Risks and open questions](10-risks-open-questions.md): material unknowns and
    conditions for further decisions.
11. [Implementation execution plan](11-execution-plan.md): ordered first slices,
    ownership, acceptance, parallel work boundaries and runner-limited readiness.

## Final comparison

Qualitative expectations, **not benchmark results**. “Hybrid” is proposed, not
an implemented capability discovered in this checkout.

| Dimension | Existing OMP2 | OMP2 + external Forge | Native hybrid inspired by Forge | Native hybrid + semantic reranking |
|---|---|---|---|---|
| Implementation complexity | Existing substrate; no integrated new gate | Low/medium adapter, prerequisites and policy translation | High domain/integration work, phased | Hybrid plus optional model/provider and ranking evaluation |
| Code reuse | Native tools available separately | Native runtime plus duplicated external state/execution | Highest reuse of ADW/KB/exec/CAS/approvals | Same; share ranking boundary only when justified |
| Semantic coverage | Existing agent/review tools, no proven unified coverage | Real perspectives and clean-window protocol; Rust analysis limits | Explicit risk obligations and focused investigators; must validate quality | Potentially better evidence relevance, not more authoritative proof |
| Deterministic enforcement | Existing checks/approvals, no new complete receipt gate | External receipts/checks plus translated source binding | Required inventory, provenance, tri-state native gate | Identical gate; ranking cannot waive checks |
| Token efficiency | Depends on current agent usage | Shared prefix caching; repeated large source bodies | Expected manifest/demand-loading savings, unmeasured | Potential savings or extra cost depending on recall quality |
| Latency | Existing native checks and model turns | Repeated reviews plus CLI/API overhead | Parallel native checks, selective semantic calls | Extra rank latency; may reduce downstream review, unmeasured |
| Auditability | Durable journal/artifacts, incomplete verification semantics | External receipt trail plus native/remote identity reconciliation | One source-bound evidence lineage and gate reducer | Same plus candidate/score/selection provenance |
| Extensibility | Existing tool/host/provider seams | Follow Python review/backend ecosystem | Pluggable native/semantic objective providers | Optional common ranking provider for multiple uses |
| Maintenance | Existing native stack | Two state/runtime/configuration systems and upstream drift | Native contracts, policy and adapters | Additional model versions, score calibration and privacy surface |

Recommended first slice: **opt-in A1 + selected C1 deterministic receipts**, built
on existing driver/ADW/check execution and journal CAS, with whole-input invalidation
and a complete required-check inventory. Add conservative impact and focused
semantic investigation next. Evaluate adaptive optional reranking after labeled
evidence-selection data exists; it should not block the native verification work.

## Executed validation and limits

The small Python manifest-key experiment passed **12/12** expected cases; raw
inputs and results are committed under `experiments/`. The Forge hash experiment
executed actual upstream hash code and demonstrated a normalized-identity collision
for different multiline-literal values; it is not a proven full-gate bypass.
No defect-recall, token saving, paid model or Mac performance measurement is claimed.
`just check-pkg omp-exec` was blocked (exit 127, missing `just`); Rust/Bun tools
and pytest were unavailable. See chapters 02 and 08 for commands and repro procedures.

Documentation validation checks local links, pinned source file/range targets,
patch whitespace and research-only scope. This PR deliberately implements no
production engine, changes no runtime behavior and adds no dependency or lockfile.

Publication initially encountered HTTP 403 from Git push and the connected
GitHub app. Access was subsequently restored: the branch is pushed and
[PR #618](https://github.com/blyzer/oh-my-pi/pull/618) is open against `omp2`.
See [publication history](VALIDATION.md#publication-blocker) for the original
errors and their resolution. The PR has not been merged.
