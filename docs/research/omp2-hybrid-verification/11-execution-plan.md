# Implementation execution plan

Status: proposed work queue, not a production implementation.
Updated: 2026-11-14.
Revalidated base: `omp2` at `355a324e4c52bb473eca53925807972d6491d265`,
the actual merge of research PR #618. This branch was created after a
fast-forward pull. The original research source pin remains unchanged.

## What the research establishes

There is a feasible implementation path, with substantial native reuse. OMP2
already provides the runtime, ADW phase/version/retry machinery, checker execution,
SCIP/AST/LSP navigation, approvals, sandbox authority and journal CAS. What is
missing is the integrated contract: a complete required-check inventory, a source-
and environment-bound result, conservative applicability/invalidation, native
finding validation and a deterministic tri-state gate. A model's completion claim,
an empty diagnostic list or a recalled past success cannot supply that contract.

The recommendation is to implement that contract first. Focused semantic review
comes next; optional reranking follows quality evaluation. A nine-objective policy
does not require nine LLM requests, and fewer requests have not yet been shown
equally effective. The existing research's P0/P1/P2 roadmap remains the detailed
long-term plan; this file orders the first deliverables and their ownership.

## Revalidation before implementation

Current source still has `ProductionAdwHost::model_phase_selector_for`
(`crates/driver/src/adw/production.rs:320–332`) selecting `@judge` for an implicit
reviewer model. Do not implement that selector again. `judge` in the same file
(`:676–690`) still accepts review by first word and accepts native Agent answers
on completion. ADR 0053's historical "Not started" text for the role is therefore
not a reliable description of all current code. Structured independent verdicts
and required gates still need their own source audit and acceptance tests.
Resolve that record's status and companion STATUS/TASKS entries when implementing
the corresponding change, without declaring all of ADR 0053 complete.

`Suite` and `CheckerRunner` in `driver/src/cleanse/checkers.rs:123–145` already
separate runnable and skipped checks and expose supervised execution. Use them
where applicable; do not change discovered Cargo behavior or silently substitute
a parser-empty result for success. For OMP2's own checks, the `justfile` recipes
and nextest plus doctest coverage remain authoritative.

## Ordered delivery queue

Each row is a proposed independently reviewable development PR. File names not
currently present are explicitly marked **new**. No runtime behavior changes
are included in the skills/plan PR.

| Slice | Deliverable and files | Depends on | Acceptance |
|---|---|---|---|
| S0: operating tools | Vendor seven pinned EGM skills and their referenced support files; add four short OMP skills under `.claude/skills`; provenance, notices and this queue | Merged research #618 | Exact vendored-byte comparison; all literal local skill/support links resolve; no settings/hook or runtime changes; explain discovery limitations |
| S1: required inventory and pure verdict | **New** `crates/driver/src/verification/{mod,policy}.rs`; export from `driver/src/lib.rs`; owning tests in `driver/src/verification/policy.rs` or `driver/tests/verification_policy.rs` | S0 is helpful tooling, not a runtime dependency | Typed required IDs and PASS/FAIL/INCONCLUSIVE; missing/duplicate/stale/cancelled/effects-unknown results cannot PASS; empty inventory is invalid for enabled policy; confirmed required violation is FAIL; no execution or model dependency |
| S2: snapshot and applicability | **New** `driver/src/verification/snapshot.rs`; reuse VCS and existing execution input capture, `omp_core::Hash32`; shared digest ownership follows `exec/src/digest.rs` | S1 | Byte-exact full input manifest with dependency/feature/toolchain/test/environment/policy identity; stable canonical encoding; dirty/untracked/generated input and source-race tests; unknown inputs prevent durable PASS reuse |
| S3: evidence adapter | **New** `driver/src/verification/evidence.rs`; existing `journal/src/{blob,kind,runlog,gc}.rs` changed only when required for registered records/retention; session projection through existing Component seam | S1–2 | Blobs finalized before journal publication; full transitive retention roots; replay, interrupted publication, corrupt/missing blob and GC tests; original evidence immutable; current-snapshot applicability receipt required for reuse |
| S4: first working verification path | **New** native adapter in `driver/src/verification/`; integrate `driver/src/adw/{definition,production}.rs` opt-in, existing `cleanse/checkers.rs` and execution authority; documentation/example under existing `.omp/workflows` only if schema needs it | S1–3 | Run explicit A1 and selected C1 `just` package recipes on captured input; persist raw output, observed check/test inventory and receipt; missing executable, zero selected tests, nonzero exit, cancellation and source change fail or remain inconclusive; real driver/envd integration test |
| S5: conservative impact and focused review | Existing `vcs`, `ast`, `kb`, LSP, child kernel and restriction seams; **new** impact/reviewer/validator modules in driver | Working S4 with tests | Uncertain graph widens scope; mandatory security context retained; claims source-bound and falsified natively where possible; first-word review not used as new evidence-backed acceptance; Standard profile opt-in |
| S6: measured optimization and autonomy | Existing evidence/ADW/job/approval seams; optional ranking provider and mutation adapters | S5 plus held-out evaluation | Compare original Forge and hybrid, with/without ranking; no stale-cache PASS; quality/latency/cost reported; bounded repairs, Strict perspectives and escalation only after evidence supports rollout |

S1's domain contract remains driver-owned initially because it has one concrete
consumer. Move general reusable workflow concepts into `omp-adw` only with a
second demonstrated need; do not expand the ADW state machine just to house
verification names. Keep host resources out of pure domain code and preserve
`compose_kernel` as the production construction boundary.

S1 does not imply a working verification engine: S4 is the first joined-path
milestone. No standalone pure reducer, unused interface or skill collection
should be reported as completed autonomous verification.

## First-slice contract to defend

The policy supplies an explicit nonempty required inventory and immutable
snapshot/policy identity. Observed results carry check identity, scope,
completion and evidence provenance. Unknown or unauthorized check IDs cannot
satisfy required IDs. Duplicates are an input error, not a vote. A complete
confirmed required violation produces FAIL; otherwise incomplete, stale or
untrusted required evidence produces INCONCLUSIVE; only complete current passing
evidence produces PASS. Preserve incompleteness reasons even when another check
already proves FAIL. Optional failures remain visible but do not silently change
the declared required policy.

The initial A1/C1 inventory contains the selected package check and its test
recipe including doctests; test applicability is explicit, not inferred from a
directory diff. A recipe reporting no tests cannot claim the declared regression
coverage. An approved non-applicability disposition requires rationale and policy
authority, never an LLM's unsupported assertion.

## Parallel execution without shared-file collisions

The coordinator owns public contracts, integration, shared tables, commits and
publication. Before dispatch, assign each worker an exclusive path set, base SHA,
inputs and a concrete return artifact. Independent source inspection and writing
disjoint skill directories can run together. Do not assign two workers the same
Rust module, ADR table, lockfile or branch ref. Workers do not merge or commit
shared changes. Contracts are agreed before adapter implementation; do not let
parallel workers invent incompatible evidence/result types.

For S1–4, the coordinator settles policy/snapshot contracts first; a worker may
then implement domain tests while another inspects storage retention read-only.
After the contracts land, evidence-adapter and checker-adapter work can use
separate modules/worktrees with integration owned centrally. Fresh-context review
gets the frozen artifact, acceptance criteria and source reading list rather
than the producer's reasoning. Missing reviewer output is "not run", not clean.
EGM's upstream interactive workflows are available but are not automatically
executed merely by vendoring them.

## Branches, runners and honest readiness

A child implementation can proceed from a locally validated parent commit
without waiting for a remote runner or GitHub merge event. Pin that parent SHA
and make the child/PR base explicit; verify the diff excludes unrelated parent
work or clearly identifies the stack. This is a scheduling assumption, not a
claim that GitHub merged anything. Check actual refs before final integration
and rebase/refresh when the target moves.

When no runner is available, complete available deterministic local validation,
record exact blocked commands and prerequisites, and continue independent work.
For documentation/vendor changes this means manifests, licenses, references,
frontmatter, byte comparison and patch scope. For Rust production work, source
inspection and Python models cannot substitute for compile, owning tests and
joined-path proofs. Record production readiness as unverified until those run;
do not label a blocked check PASS or claim branches merged. No new mandatory
server/container/remote-runner dependency is introduced.

Each implementation PR records tests run, missing runner/toolchain, remaining
risks, parent SHA and actual merge status. The user's authorization permits
preparing and advancing dependent work; it does not make absent evidence true.

## Skills and invocation

Repo-native skills cover source audit, ADR/implementation planning, bounded
implementation, and evidence review. OMP2's `SKILL_SOURCES` already has a
Claude-project ancestor source and direct `<child>/SKILL.md` enumeration
(`crates/driver/src/discovery/skills.rs:519–527,819–840`), subject to source
policy/trust. No discovery code change is needed. A skill being present is not
proof that a particular external harness has loaded it or registered personas.

EGM is vendored for explicit use; its fresh-context review patterns support
planning and critique, not authoritative product gates. Read
`.claude/skills/EGM-PROVENANCE.md` for its immutable revision, support layout,
license/notice distinction and host integration. Repository/user instructions
take precedence over optional skill workflows. Existing `.omp/skills` remain
unchanged, and no new automatic hook is installed.
