# Verification evidence and context protocol

All schemas and interfaces below are proposals, not claims that CodeIR,
ChangeIR or VerificationIR already exist. Baseline is
`9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`.

## Existing storage to reuse

[`BlobStore`, journal/blob.rs:368–397, 546–705](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/journal/src/blob.rs#L368)
provides SHA-256+size `BlobRef`, streamed staged writes, atomic adoption,
deduplication, bounded ranges and full verification. `get` checks length only;
use `verify` at import/trust boundaries before admitting evidence. Addresses
follow existing `artifact://sha256/<64-hex>` convention and `omp_core::Hash32`.
Do not add another hashing package or blob database.

[`Journal::append`, journal/lib.rs:231–251](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/journal/src/lib.rs#L231)
is the append boundary. [`Vocabulary`, journal/kind.rs:136 onward](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/journal/src/kind.rs#L136)
allows registered kinds without redefining the closed session vocabulary.
[`runlog`, journal/runlog.rs:20–147](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/journal/src/runlog.rs#L20)
already records workflow identity, versioned inputs, dispatch/settle, uncertainty
and external-effect idempotency keys. Use a versioned verification vocabulary
on an owned run journal; project session views through the existing component
mechanism rather than a second mutable session history.

[`collect_value_roots`, journal/gc.rs:408–469](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/journal/src/gc.rs#L408)
recognizes inline blob-reference objects and artifact URI strings. It does not
recursively traverse arbitrary JSON blobs stored inside CAS. Therefore journal
the complete transitive blob inventory (or explicitly extend the collector and
test closure) when publishing a receipt. Rooting only the manifest blob risks
losing its children. Finalize blobs before appending their reachable record;
an interrupted write must never create an authoritative partial receipt.

[`ExecutionResult`, exec/result.rs:109–130](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/exec/src/result.rs#L109-L130)
already includes backend, outcome, log/artifact digests, timing and transfer
statistics. [`Digest`, exec/digest.rs:7–27](https://github.com/blyzer/oh-my-pi/blob/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc/crates/exec/src/digest.rs#L7)
is deliberately local to the pure execution domain; its comment directs moving
the common shape into `omp-core` when needed, not proliferating another digest.
Resolve that ownership in a small shared-type follow-up before new public APIs.

The KB's `Store` already hashes snapshots and verifies stored index-object
digests (`crates/kb/src/store.rs:109–165`). Reuse graph artifacts as inputs; its
filesystem freshness check alone is not a verification action-cache key.

## Proposed data model

Canonical encoding must have a version, stable field order, sorted sets and
length-delimited domain separation. SHA-256 hashes exact canonical bytes; avoid
hashing debug strings, filesystem mtimes or unspecified JSON map iteration.
Preserve original source bytes for reproduction, including generated inputs.

```rust,ignore
// Design sketch, intentionally not compiled production interfaces.
struct SourceSnapshot {
    revision: Str,                 // repository identity + base and head
    inputs: Hash32,                 // full tree/input manifest, including dirty files
    dependencies: Hash32,           // lockfile, resolved features, generated inputs
    environment: Hash32,            // platform, toolchain, allowed env, runner image
}
struct VerificationObjective {
    id: ObjectiveId,                // closed objective enum, not arbitrary strings
    policy: Hash32,
    required_inputs: Arc<[EvidenceId]>,
    acceptance: AcceptanceRule,
}
struct EvidenceRecord {
    id: EvidenceId,                 // digest of domain/version + body excluding id
    snapshot: SourceSnapshot,
    kind: EvidenceKind,
    payload: BlobRef,
    inputs: Arc<[EvidenceId]>,
    provenance: ProducerIdentity,   // tool/version/config/backend/model/template
    coverage: Coverage,            // requested, observed, omitted, unsupported
    outcome: EvidenceOutcome,      // success/failure/unknown, with reason
}
struct VerificationReceipt {
    snapshot: SourceSnapshot,
    policy: Hash32,
    required: Arc<[ObjectiveId]>,
    objectives: Arc<[ObjectiveReceipt]>,
    findings: Arc<[ValidatedFinding]>,
    roots: Arc<[BlobRef]>,          // transitive retention inventory
    verdict: GateVerdict,           // Pass / Fail / Inconclusive
}
```

Store source revisions, changed symbols and function digests, graph coverage,
raw native diagnostics, test names/results, static findings, mutation operator
and survivor details, requirement/policy references, historical confirmed defects,
reviewer claims, falsification outcomes and statuses as typed evidence kinds.
Each result names both requested and observed scope; `0 tests` cannot silently
mean “all required tests passed.” A historical confirmed defect is still advisory
until checked against the current snapshot.

Candidate boundaries below use existing `Str`, `Arc`, typed errors, cancellation
tokens and async conventions. Associated request/result types should remain
closed typed contracts; finalize exact signatures in the implementation PR.

| Boundary | Candidate operation | Existing owner / proposed placement |
|---|---|---|
| `VerificationEngine` | `verify(plan, snapshot, cancel) -> VerificationReceipt` | Driver orchestration over ADW; no second scheduler |
| `VerificationObjective` | `inputs`, `coverage`, `acceptance` | Pure domain specification, no model or I/O |
| `EvidenceStore` | `put(record)`, `load(id)`, `lookup(action_key)`, `publish(receipt)` | Thin journal/CAS adapter in driver/session ownership; cache is rebuildable |
| `ChangeImpactAnalyzer` | `analyze(base, head, kb_coverage) -> Impact` | Reuse VCS/AST/KB; typed uncertain edges |
| `NativeVerifier` | `check(objective, inputs) -> NativeResult` or `plan(...) -> ExecutionPlan`; `interpret(result)` | In-process AST/KB/rules or existing exec host; no direct unconfined spawn |
| `SemanticReviewer` | `investigate(manifest, evidence_reader, limits, cancel) -> Claims` | Restricted child kernel via driver; model routed through `omp-ai` |
| `FindingValidator` | `validate(claim, snapshot) -> ValidatedFinding` | Location/schema checks plus bounded native reproduction; unresolved is explicit |
| `VerificationGate` | `evaluate(required, receipts, policy, snapshot) -> GateVerdict` | Pure total function, no network, memory or LLM |
| `VerificationReceipt` | canonical encode, digest, retain, project | Journal-derived immutable artifact; projected UI status |

Use `thiserror` typed sources rather than string-erased errors. Domain code must
not import driver or host resources. Public async trait object requirements
should follow the chosen existing provider seam; this table does not prescribe
a speculative trait framework or dependency.

## Impact and conservative incremental validity

Capture an immutable full input manifest before analysis. Obtain VCS hunks via
`Repo::diff_text` and changed paths via `Repo::changed_files`
(`crates/vcs/src/lib.rs:142–173`); use syntax ranges to associate hunks with
declarations, then query native KB/LSP for references and callers. Preserve
deleted/renamed symbol identity with base/head mappings. A line-number change
does not establish semantic identity; regenerate source anchors on each revision.

Graph edge provenance matters: SCIP semantic reference, syntax candidate, LSP
response and unknown dynamic edge cannot have identical confidence. Rust
macros, conditional compilation, trait dispatch, proc-macros, FFI, build scripts
and generated modules require conservative crate/workspace expansion. No complete
CFG, alias analysis or interprocedural taint proof is assumed. If analysis cannot
bound impacts, widen checks instead of interpreting “no edges” as “no impact.”

An action key is a digest over schema/version, objective/rule config, input
closure, relevant interfaces/bodies, dependency/feature closure, compiler and
tool identities, target and runner identity, approved environment, test corpus,
seeds/inputs, policy/requirements and execution posture. Start with whole captured
input closure; narrow it only after dependency recording and mutation tests
prove invalidation. The same bytes may reuse a blob without reusing its verdict.

Cross-revision reuse publishes a **new applicability receipt for the current
snapshot**, referencing the original immutable result and demonstrating identical
action-key/input-closure identity. The gate checks that current receipt and its
proof of applicability; never relabel the original result's source revision.
If applicability cannot be established, rerun. In-process AST/KB/rule checks
produce the same typed coverage/provenance envelope without spawning a process.

| Change | Required invalidation |
|---|---|
| Function body, signature, visibility, ABI or invariant | Own diagnostics/review; affected callers/contracts/tests; graph and source anchors as applicable |
| Macro, proc-macro, `build.rs`, generated code, include file | Dependent expansion/build closure, semantic index, diagnostics/tests/review |
| Dependency version, lockfile, feature flags, target cfg, compiler/linker | All dependent actions; graph where resolution can change |
| Formatting only | Re-extract anchors; syntax/rustfmt; reuse other results only under an explicitly validated normalization rule |
| Policy, requirement or risk classifier version | Objective selection and gate; impacted semantic judgments even if source identical |
| Test code, fixtures, input datasets, fuzz corpus, mutation operators, random seed | Related executable actions, scores and downstream conclusions |
| OS/architecture, sandbox, permissions, env, locale, clock/network inputs, runner image | Every action depending on changed environment; uncaptured external state forbids durable PASS reuse |
| Reviewer model, parameters, prompt, tools or reranker config | Reviewer/selection action cache; immutable source/test blobs remain reusable |
| Graph producer/version/schema/coverage or deleted symbol | Impact result and all actions selected using it; broaden until rebuilt |
| Source moves during check or before commit | Supersede receipt for old snapshot; recapture, recompute affected inputs, never relabel old evidence |
| Interrupted/accepted external action with unknown effects | Reconcile existing execution handle; INCONCLUSIVE until known; do not blindly retry effects |

Optional time-based expiry supplements keys for external tools/security feeds;
it cannot substitute for dependency capture. A successful test under one input
does not prove another; flaky tests retain raw attempts and cannot be passed by
averaging away failures. Unknown environment or missing evidence fails closed
where required. Cache misses run checks, not weaker substitutes.

## Minimal context without hidden coverage loss

1. Send a compact manifest: snapshot/policy IDs, changed-symbol signatures and
   digests, objective, risk, coverage gaps, diagnostic/test summaries, evidence
   handles and exact access permissions. Omit secrets before any remote request.
2. Include mandatory security boundary context, contracts and relevant source
   slices. A source digest is an identity, not context the model can reason about.
3. Let the reviewer demand-load symbol, hunk, caller and raw-output ranges through
   existing read/navigation tools restricted to this snapshot. Every returned
   slice includes artifact identity, range and provenance. Record accesses.
4. Rank only optional evidence. Combine lexical/graph candidates with advisory
   memory, optionally cross-encode a bounded pool and MMR-diversify it. Keep
   mandatory caller/callee, trust-boundary, unsafe, permission and invariant
   context outside ranking quotas. If mandatory context exceeds budget, partition
   explicitly with shared contracts or escalate; do not omit it silently.
5. Reuse shared diagnostics/tests across objectives using evidence IDs. Dedup
   findings by snapshot, semantic location, violated invariant and reproduction;
   do not collapse independent failure mechanisms at the same line.
6. Use existing prompt stability bands (`crates/agent/src/prompt/slots.rs:207–270`):
   stable instructions/tool schemas first, dynamic manifest and volatile facts
   later. Provider prefix caching is conditional billing/latency optimization;
   it does not remove payload transmission or guarantee evidence freshness.

Artifacts fetched through a tool are subject to model context cost too. Measure
initial manifest, demanded bytes/tokens, repeated prefixes and tool-output tokens
separately. Keep raw compiler/test evidence; minimized output is a projection,
not the only durable record. Server-side prompt caches and model-access logs
are separate privacy surfaces from the local CAS.

## Integrity, provenance and persistence tests

Before accepting a result, verify evidence identity, source scope, tool version,
observed coverage and completion. A hash detects alteration, not a malicious
producer; record producer trust and review permissions. Imported artifacts cannot
become authoritative solely because their hash is correct.

Required tests: canonical serialization determinism; dependency/policy/environment
key changes; stale graph expansion; base/head rename/deletion anchors; forged
blob and short read; crash between put and append; replay after unknown execution;
GC retains transitive manifests and raw outputs; dedup is idempotent; corrupt or
missing child evidence blocks required gates; source mutation during review
cannot receive a current receipt. The benchmark chapter supplies the initial
small invalidation experiment and its limits.
