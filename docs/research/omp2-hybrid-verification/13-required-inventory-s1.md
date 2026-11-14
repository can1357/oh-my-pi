# S1: explicit required inventory and deterministic verdict

Date: 2026-11-14.
Base: actual pulled `omp2` at `374eb3a2b0e2149bc4890be40a3b9d5bae621aa5`.
Branch: `feat/verification-required-inventory`.
Status: implemented and locally tested policy contract; no joined execution or
commit gate.

## Implemented behavior

`crates/driver/src/verification/policy.rs` provides the pure driver-owned
`VerificationPolicy`, `VerificationScope`, check observations/assessments and
`GateVerdict`. `driver/src/lib.rs` exports the module. It includes a usage
doctest; public contract tests are in `driver/tests/verification_policy.rs`.

- An enabled policy must declare at least one required check. Empty and
  advisory-only inventories are errors, avoiding vacuous PASS.
- Blank or duplicate declared identities, undeclared results and duplicate
  observations are typed errors. Identity matching is exact; results are not
  votes or last-write-wins updates.
- Every declared check appears in policy order. Missing observations are
  explicit; input observation order cannot reorder the assessment.
- Input/environment and policy digests must match before an outcome applies.
  Both stale success and stale failure become inconclusive for the current scope.
- Passing/failing observations need an admitted evidence digest. Missing evidence,
  cancellation, incomplete coverage, unknown effects, untrusted results, not-run
  and neutral states cannot satisfy required checks.
- A current confirmed required failure produces FAIL while preserving every
  other check's uncertainty. Otherwise incomplete required evidence produces
  INCONCLUSIVE; only all required passing checks yield PASS.
- Advisory failures and absent advisory results remain visible without changing
  the required verdict. Required neutral results block; authorized non-applicability
  policy is not introduced in this first slice.

The reducer performs no I/O, process execution, model call or approval. It
does not recompute digests, inspect blobs or establish producer trust. Host
adapters must admit observations only after those checks. A digest is not an
attestation. This module is not exposed as a model tool or connected to ADW
acceptance, and its PASS grants no commit authority.

Existing `omp-forge` hosting-check contracts, including their empty-required-set
semantics, are unchanged. The new inventory supplies the local policy contract
without adding a scheduler, CAS, dependency or runtime behavior change.

## Ownership and source review

The coordinator owned the contract, export and status documentation. A separate
worker wrote only the public test file. A fresh-context read-only reviewer
checked S1 semantics, then confirmed tests cover failure ordering, stale failure,
both missing-evidence outcomes, independently changed input/policy digests,
advisory failures and identical duplicate observations. No blocking finding was
reported. This is source review, not an independent runtime correctness proof.

ADR 0053, STATUS and TASKS are synchronized. They distinguish existing `@judge`
selection and this pure reducer from the missing structured verdict, source
capture, evidence validation, live gate and durable receipt. The ADR remains
proposed; existing Agent acceptance defaults do not change.

## Executed local validation

| Command | Observed result |
|---|---|
| `just fmt-check-rust` | Exit 0; workspace Rust formatting passed |
| Initial `just check-pkg omp-driver` | Exit 101; missing default checkout Python config, before external setup was selected |
| `just check-pkg omp-driver` with external pinned Python config | Exit 0; real driver and dependency graph checked |
| `CARGO_INCREMENTAL=0 cargo nextest run -p omp-driver --test verification_policy --locked` | Exit 0; **11 run, 11 passed, 0 skipped** |
| `cargo test --doc -p omp-driver --locked` | Exit 0; **1 passed, 0 failed/ignored/filtered** |
| `git diff --check` and staged equivalent | Exit 0 |

The environment initially lacked Rust/just/nextest. Task-local setup outside
the repository installed pinned nightly `2026-08-08`, rustfmt/clippy/Cranelift,
`just 1.58.0`, nextest `0.9.146`, CMake/Ninja and pinned free-threaded debug
CPython 3.14.7+20260807 with cloudpickle 3.1.2. Tool archive checksums were
verified. Setup preserved HOME and changed no lockfile, dependency or tracked
Python notice. `fetch-python.sh` used an explicit external destination and
`PYO3_CONFIG_FILE` named its generated config. Tests retained the repository's
homogeneous LLVM test profile; incremental compilation was already disabled by
the repository. No stable compiler or per-crate backend override was substituted.

For this task, `source /workspace/omp-toolchain/environment.sh` supplies those
external locations. Raw logs are task-local `/tmp/omp2-s1-{check,nextest,doc}.log`.
Completed check-only metadata and task-created download/research caches were
discarded to fit the 8 GB filesystem; source, commits and test artifacts were
preserved. Existing warnings in untouched modules remain; no unrelated cleanup
was attempted and these results are not a warning-free workspace claim.

No full driver test suite, platform-specific sandbox proof, paid model test or
joined verification execution was run. This slice adds a pure policy only;
its public API tests and real owning-crate compilation are the relevant local
evidence. S2–S4 need their own capture/storage/driver-envd integration proofs.

## Remaining work and branch readiness

S2 captures/hashes complete source, environment and policy inputs and defines
cross-revision applicability. S3 roots durable evidence in the existing journal
CAS. S4 connects opt-in A1/C1 checks through existing authority to produce usable
receipts. S1 claims no autonomous repair, reranking, security coverage or measured
token-efficiency improvement.

Local compilation and relevant tests establish this slice as a possible pinned
parent for dependent work without waiting for CI quota. Its PR remains explicitly
identified; actual GitHub merge status is separate. This is not an administrative
merge authorization for code and does not convert unavailable checks into PASS.

## Hosted workspace test follow-up

The hosted macOS workspace run at head `3e116ac` compiled successfully, then
reported 12,035 passing tests and four failing `omp-kb::cli` tests. Each failure
was `repository changed while SCIP producers were running`. The CLI fixtures
isolated Cargo's package cache but inherited the target directory. A hosted
runner does not supply the self-hosted runner's external target path, so
rust-analyzer created unignored `target/` metadata/lock files inside the temporary
source repositories. The snapshot guard correctly rejected this pollution.

The same four failures reproduced locally with `just test-pkg omp-kb`
(12 passed, 4 failed, exit 100). A direct real SCIP run in a fresh fixture
produced only untracked `target/` metadata/build locks; no Cargo.lock was added.
The fixture helper now directs `CARGO_TARGET_DIR` into its private `.git` tree,
and the publication test asserts no root `target/` was created. Production
snapshot guards, source/lockfile handling, test coverage and CI gates are unchanged.

After the fix, `just test-pkg omp-kb` exited 0: all 16 package tests passed,
zero skipped. Its paired doctest command also exited 0 with zero doctests
present. Pinned rustfmt and whitespace checks passed. The full hosted workspace
rerun remains separate evidence; this package result does not claim every
workspace or macOS-specific test passed. Local before/after logs are
`/tmp/omp2-kb-repro.log` and `/tmp/omp2-kb-fixed.log`.
