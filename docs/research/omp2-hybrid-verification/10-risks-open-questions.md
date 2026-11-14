# Risks, unknowns and decision triggers

## Explicit limitations of this investigation

- OMP2 behavior is source-traced at `9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`,
  not certified by a clean build. `just`, `cargo`, `rustc` and `bun` are absent
  from this environment. No live LSP, sandbox, external execution backend or
  Apple Silicon runtime proof was run.
- Forge is pinned to `91338bb2eb57e27b44c9164a2ada63aebb05fa4e`; its targeted
  pytest command was blocked by missing pytest. The source-hash experiment
  executed actual dependency-free Forge code; it does not demonstrate a complete
  gate bypass. Upstream efficacy figures are attributed, not independently replicated.
- Mnemopi PR #18747 is an open upstream TypeScript proposal at inspected head
  `92ce767cc18379efde6315f0d2069088d671450d`; it is not implemented in Rust OMP2
  just because upstream code or config describes it. See chapter 03 for exact
  differences between its PR description and source execution order.
- PR #19210 is a TypeScript diff renderer performance change, not a verification
  or reranking proposal. Its profiling inputs/results were not reproduced.
- No paid model calls, real cross-encoder quality tests, four-arm defect corpus,
  production action-cache benchmark or 16 GB Mac measurements were run. All
  projected savings, effort and model-memory arithmetic are labeled estimates
  or hypotheses. No production verifier is implemented here.
- “Absent” findings mean absent in the inspected tracked implementation/search
  scope; they cannot rule out private branches, external extensions or later commits.

## Risks and mitigations to prove

| Risk | Consequence | Required mitigation / decision trigger |
|---|---|---|
| Incomplete source impact or hidden build inputs | Unsound cache reuse and escaped regressions | Whole-input keys first; uncertain graphs expand scope; full-rerun equivalence and adversarial invalidation corpus before narrowing |
| Empty required inventory | Vacuous all-green PASS | Policy declares required objective inventory; absence/missing is explicit inconclusive. Preserve existing `omp-forge` contract rather than silently change it |
| Model confidence mistaken for evidence | False FAIL or false PASS | Schema/source checks plus reproduction/source reasoning; unresolved critical claims escalate; keep model role advisory |
| Prompt injection from source/log/memory | Reviewer tool misuse or policy bypass | Host-owned policy, snapshot capabilities, read-only roster plus enforced sandbox, untrusted evidence delimiters, no instructions from retrieved data |
| Mutable workspace during checks | Receipt describes different code than committed | Immutable capture, pre/post checks, commit-time lock/identity comparison, superseded-results handling |
| CAS identity confused with trust | Fabricated result passes integrity check | Producer identity, complete provenance and scope; independently validate required results; hash is not attestation |
| CAS GC or partial journal publication | Apparently valid receipt loses evidence | Finalize before append, journal transitive retention roots, crash/replay and GC integration tests |
| Unknown remote effects and cancellation | Duplicate mutation or orphan process | Existing execution reattach/idempotency contracts; effects-unknown stays inconclusive; no unsafe automatic fallback |
| Reranker omits decisive context | Semantic false negative under budget | Mandatory evidence outside quotas, scope coverage ledger, demand loading, no truncation as silent success |
| Local model memory pressure | Swap, poor latency or failure on 16 GB | Lazy loading, bounded candidates/tokens, runtime pressure measurement, optional/off defaults, smaller tested model or approved remote fallback |
| Remote reranker/source disclosure | Confidential source or credentials leave machine | Scope and endpoint policy, redaction, approved provider credential authority, no raw secrets in receipts/logs |
| Uncalibrated scores and inert config | Apparent algorithm differs from actual recall | Trace callers and execution order; behavioral tests for flags, normalization and failure modes before enabling |
| Correlated perspectives | More calls without better recall | Blinded independent initial findings, optional model diversity, measured curves per risk category |
| Native tools treated as harmless | Malicious build scripts/tests execute | Existing trust decision and enforced posture; no unrestricted fallback when confinement required |
| Weak benchmark or memory leakage | Inflated defect recall | Held-out patches, hidden oracles, frozen historical memory before case date, blinded adjudication and per-class intervals |
| Licensing copied Forge prompts/code | Attribution/noncompliance risk | Forge Apache-2.0 notices reviewed for copied material; architectural adaptation alone does not require importing implementation |

## Open questions for implementation review

1. Which host-owned verification policies and requirement sources are authoritative
   for a project? Keep source-controlled suggestions separate from trusted execution
   policy. Decide explicit override authority and audit representation.
2. Where should shared digest types land? `omp-exec` documents a future move to
   `omp-core` rather than retaining duplicate shapes. Resolve without creating a
   journal dependency in a pure domain crate.
3. Can every local checker capture all inputs, particularly build scripts,
   environment, network and generated files? If not, which results are reusable
   only within the same frozen run, and which cannot have durable PASS reuse?
4. What subset of SCIP/LSP relations is trustworthy under feature/target changes?
   Specify fallback crate/workspace tests for unavailable producers and dynamic calls.
5. What is the operator-approved noninferiority margin for changing Forge-like
   review policy? Define it before inspecting evaluation outcomes; security
   strata may warrant a separate rule from aggregate recall.
6. Which objectives and platforms are mandatory in Quick/Standard/Strict? No
   universal model-call count or mutation-score threshold is justified yet.
7. Does a lightweight local cross-encoder improve evidence selection over native
   lexical/graph retrieval at equal token budgets? Measure before shared service
   extraction or any default-on recall change.
8. How should unresolved critical semantic findings be represented across revision
   repairs? Never silently migrate severity/location or drop them via duplicate
   filtering. Record revalidation and retirement reasons.
9. How long must raw evidence be retained and who can read it? Digest references,
   source excerpts and error output can themselves disclose sensitive information.

These questions block the relevant implementation slices, not this research PR.
The practical P0 deterministic receipt can proceed with conservative whole-input
invalidation and an explicitly selected check inventory.
