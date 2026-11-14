# Nine objectives and evidence-backed gates

Status: **proposed design**, informed by source inspection at OMP2
`9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`. No hybrid verifier is implemented by this research.
The nine cells are coverage objectives, not nine LLM calls, sequential passes, or a claim of
 equivalence to Forge's consecutive-clean-cycle algorithm.

## Verified reusable seams

These are implemented and verified by reading source, not by executing the complete runtime:

- [LSP Action](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/tools/src/lsp/mod.rs#L42-L105) includes diagnostics, references, incoming/outgoing calls and capability/status operations. Calls are navigation evidence, not a complete interprocedural graph.
- [CheckerExecutor, Preset, request, parse_output](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/tools/src/lsp/checkers.rs#L50-L202) distinguish checker faults from source diagnostics. Cargo preset invokes `cargo check --message-format=json`; it is not a test runner. Execution is authority-owned. The 50-line command/projection bound makes completeness important.
- [DiagnosticResult](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/tools/src/lsp/diagnostics.rs#L12-L43) carries `complete` and `omitted`; an empty partial result explicitly does not mean completed success.
- [ExecutionRequest](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/exec/src/request.rs#L120-L198) carries captured input manifest, argv, environment, toolchain, posture, resources, output selection and timeout. [ExecutionResult](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/exec/src/result.rs#L109-L136) carries outcome, log/artifact digests, timing, cache hit and fallback provenance. Exit zero proves command success, not requirement correctness.
- [ADW Phase](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/adw/src/workflow.rs#L23-L132) supports Code, Agent and Review phases, dependencies, consumed inputs, posture and rejection routes. [Run](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/adw/src/run.rs#L286-L355) enforces attempt ceilings and posture, and invalidates consumers of superseded accepted versions. This is reusable scheduling/state logic, not proof that the proposed objectives are already wired.
- [Forge CheckState](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/forge/src/check.rs#L1-L68) accepts only Success for required checks; even Neutral blocks. This crate models source-host checks and is distinct from HouMinXi/forge.
- [justfile](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/justfile#L210-L305) already defines lint, check, package tests and doctests. Reuse declared project commands; avoid parallel command specifications that diverge from CI.

## Objective matrix

All artifacts below must bind to a complete input/environment/policy digest. “Parallel” means
independent work over the same immutable snapshot with bounded CPU/RAM; it does not authorize
concurrent writes into one shared target directory. New coverage listed here is absent from the
proposed integration, even where an executable could already be invoked through shell.

| Objective | Native reuse and missing work | Deterministic versus semantic | Parallelism | Evidence and falsification | Rerun trigger and PASS / FAIL / INCONCLUSIVE |
|---|---|---|---|---|---|
| A1 Syntax/types/compile/format | Existing LSP checker and `just check`, `fmt-check`; new objective adapter and complete result envelope | Commands and parser deterministic; no LLM needed | Separate work dirs; avoid Cargo lock contention | Full compiler JSON, command/exit, format patch, version. Reproduce diagnostics on pinned source; distinguish toolchain faults | Source/transitive imports, generated inputs, flags, compiler/formatter/config/environment change. PASS all required commands complete successfully; FAIL reproducible source/format violation; INCONCLUSIVE missing tools, truncation preventing interpretation, cancellation |
| A2 Changed symbols/callers/contracts | Reuse AST, VCS and LSP references/calls; new conservative impact closure and graph completeness markers | Symbol extraction deterministic; dynamic dispatch/macros/FFI and undocumented contracts may need reviewer | Parallel graph queries once source snapshot fixed; semantic review depends on impact manifest | Symbol/hunk map, edges with provenance, unresolved edges, public signatures. Validate reference locations against exact source and compile affected consumers | Symbol bodies/signatures/imports/build graph/LSP generation or impact rule change. PASS declared closure checked including conservative fallback; FAIL broken caller/contract; INCONCLUSIVE unresolved critical edges without adequate fallback |
| A3 Requirements/invariants/behavior | Reuse source reads, tests and ADW review phase; new requirement linkage and structured hypothesis schema | Executable specifications deterministic; interpreting unstated intent requires focused LLM or human | Independent requirements parallel after A1/A2 evidence ready | Requirement IDs, invariant, source spans, counterexample/test. Challenge each finding with test or explicit source reasoning; missing test is not disproof | Requirement, relevant source or dependency change. PASS required invariants have accepted evidence; FAIL confirmed violation; INCONCLUSIVE ambiguous requirement or untested critical semantic claim |
| B1 Architecture/dependencies | Reuse existing workspace lint/CI commands; new reviewed dependency-boundary rules | Manifest/layer/import rules deterministic; design suitability semantic | Independent of behavioral tests over frozen snapshot | Dependency manifest/edge proof, rule ID, expected/actual layer. Falsify by resolving cfg/features and permitted exception | Manifests, feature graph, policy, tool version change. PASS all required rules and scoped design review complete; FAIL prohibited edge; INCONCLUSIVE policy conflict or unresolved generated dependencies |
| B2 Security/unsafe/dataflow | Reuse grep/AST/LSP and sandboxed command execution; new security rules/providers, source-to-sink coverage and finding validator | Known patterns/rules deterministic; exploitability, trust boundaries and multi-function reasoning need focused semantic work. No claim of native whole-program taint proof | Rules parallel; reviewer receives required trust-boundary/dependency context | Threat model, sink/source path, attacker input, privileges, reproducer. Native falsification checks reachability/sanitizers/config, never suppresses merely because tests pass | Unsafe/FFI/auth/serialization/build-script/dependency, threat model or scanner change. PASS policy-specific obligations covered; FAIL confirmed exploit/policy breach; INCONCLUSIVE critical path omitted or unsupported analysis |
| B3 Concurrency/errors/lifetime | Reuse compiler/Clippy, tests, source tools; add selected model checking or schedule harness only after measured need | Compiler proves some lifetime/type properties; lock order, async cancellation, state transitions and semantic cleanup often need reviewer/test | Independent scenario checks parallel with resource bounds | State-transition table, lock order, error paths, schedule/seed and replay. Falsify claimed race using ownership and actual happens-before; one clean run is insufficient | State machine/async/error handling/dependencies/scheduler/tool changes. PASS scoped obligations complete; FAIL reproducible race/deadlock/leak or source proof; INCONCLUSIVE unsupported schedule/state coverage |
| C1 Regression/integration | Reuse `just test-pkg` (nextest plus doctests), applicable `just e2e-*` proofs; new objective-to-test selection and completion ledger | Deterministic command and assertion results; flaky failures need classification | Tests parallel per declared isolation/resources; host-specific proofs run on required host | Test IDs, inputs, outputs, durations, platform, logs. Reproduce failure and compare pre-change baseline without dismissing new regressions | Test/fixture/source/dependency/compiler/host capability/environment changes; uncertain impact expands selection. PASS all required checks completed; FAIL confirmed regression; INCONCLUSIVE skipped host proof, flake unresolved, timeout |
| C2 Mutation/property/fuzz | Existing test harness can execute tools; new opt-in mutation/property/fuzz providers and budgets. External tools are optional until approved | Execution, seeds and mutation outcomes deterministic within declared environment; equivalent-mutant triage may need semantic review | Sharded isolated mutation worktrees; never alter reviewer snapshot | Mutant diff/operator, survivor/killed/invalid classification, seeds/corpus, budget. Confirm survivors compile and are non-equivalent before interpreting score | Relevant code/tests/operators/corpus/tool/environment changes. PASS declared bounded campaign and adequacy policy satisfied; FAIL demonstrated defect or violated tested adequacy policy; INCONCLUSIVE unclassified critical survivor or incomplete required campaign |
| C3 Final adversarial verdict | Reuse ADW Review phase and durable execution artifacts; new independent reviewer protocol and gate reducer | Reviewer investigates residual uncertainty; native reducer enforces evidence/completeness/current revision | Final verdict waits for required dependencies; independent perspectives may run concurrently | Structured finding, objective coverage, conflicting evidence, evidence references, reviewer identity. Validate spans/revision, reproduce or record explicit source proof; disputed critical findings escalate | Any relevant evidence/source/policy/model/prompt/provider configuration change. PASS required coverage current, no unresolved blocking findings; FAIL confirmed blocking issue; INCONCLUSIVE disagreement, missing context or reviewer/provider failure |

## Gate semantics

PASS means the declared verification contract was satisfied on a named snapshot, not universal
correctness. FAIL means a confirmed violation. INCONCLUSIVE means the contract could not be
established; it is never silently converted to PASS. Non-applicability is an explicit,
policy-authorized objective disposition with rationale, not a success inferred from empty output.

The proposed reducer must require:

1. Exact snapshot and input/environment/policy identities match each required evidence item;
   reused immutable results require a current-snapshot applicability receipt proving matching
   action inputs, never a relabeled original result (chapter 05).
2. Every required objective has a complete result or explicit authorized non-applicability.
3. Required commands succeeded, with declared host capabilities actually enforced.
4. All blocking findings resolved by current-source evidence; disagreement remains inconclusive.
5. No stale, cancelled, untrusted, superseded or effects-unknown execution counts as success.
6. Receipt records scope, omissions, budgets consumed and residual risks; operator override is
   explicit and separately journaled, never rewritten into a successful check.

Untrusted reviewer JSON must be schema-validated; severity and “verified” flags from a model are
claims. A validator checks source digest/range, evidence existence and consistency, then asks
native tools to challenge the hypothesis. It may classify a finding as confirmed, falsified or
unresolved. Not reproducing a concurrency/security issue within a small budget does not falsify it.
Mnemopi can suggest historical defect hypotheses; only current authoritative evidence can gate.

## Fewer calls without reduced obligations

A deterministic A1/C1 finding needs no model review before reporting it. A single focused semantic
investigation may discharge A3/B3 when it cites distinct evidence for both; coverage is tracked
per obligation, never inferred from number of calls. Deduplicate repeated hypotheses by
(snapshot, invariant, affected symbols, normalized claim), while retaining distinct independent
perspectives where Strict policy requires them. Initial model input is a compact manifest and
unresolved questions; source/evidence tools supply requested context. A security-critical source
path cannot be dropped to meet a context limit: expand budget, partition with preserved edges,
or return INCONCLUSIVE.

This is a hypothesis about efficiency, not an established quality equivalence. Before replacing
Forge behavior, run a paired, blinded defect corpus comparison with original Forge and the
hybrid, including clean changes, repeated model seeds and separate security/concurrency strata.
Hold tools, model/provider, base changes and total budget constant in one comparison; separately
compare unconstrained default profiles. Record first detection and confirmed detection, false
positives, gate completion, escaped defects, calls/tokens/time/cost and objective coverage. Require
predeclared non-inferiority margins and confidence intervals, with no acceptable aggregate gain
masking a critical-security regression. Retain original behavior until evidence supports replacement.
