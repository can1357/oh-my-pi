# S2: native input snapshots and applicability keys

Date: 2026-11-14.
Base: pulled `omp2` at `0b4a60064dddc9d29b3451422d841f0a80c04b01`,
the merge of S1 PR #626.
Branch: `feat/verification-input-snapshots`.
Status: locally exercised implementation; no check execution, durable evidence
publication or joined gate. The original research source pin remains unchanged.

## Implemented boundary

`crates/driver/src/verification/snapshot.rs` supplies `SnapshotContext`,
`VerificationSnapshot`, typed `SnapshotError` and
`capture_verification_snapshot`. The driver calls the existing `omp-env`
`EnvClient::{workspace_roots,repository_snapshot,capture_inputs}` APIs;
`omp-envd` retains all filesystem, repository and CAS authority.
`EnvironmentInputs::captured_files` in `driver/src/exec_composer.rs` reuses
the existing execution manifest decoder and blob-presence/size lookup. No second
Git scanner, manifest format, source store, process host or dependency is added.

Capture requires a committed repository matching the primary native workspace
root. It reads repository identity, captures and reads a CAS manifest, captures
again, then compares the second manifest and final repository identity. Native
refusals, counted exclusions, omitted symlinks, malformed replies, inconsistent
counts, missing required paths and observed drift return errors. A cancelled
request returns no snapshot. Cancelling the driver's wait does not establish
that a blocking host operation was killed.

The versioned canonical record binds the native manifest digest/size, file and
byte counts, repository roots/HEAD/branch/status counts and seven supplemental
identities: dependencies/features/generated inputs, actual toolchain, execution
environment, tests/fixtures, requirements, policy rules and verifier identity.
Required paths are normalized, sorted and deduplicated. Repository RPC revision
counters are excluded: they increment on reads and are not source generations.
The digest is the existing `omp_core::Hash32` SHA-256 primitive.

`VerificationSnapshot::policy` additionally binds the exact ordered S1 check
inventory, including required/advisory status, to rules and requirements.
`applicability_key` binds that policy, the complete snapshot, declared check ID
and trusted per-check configuration digest. A policy from another snapshot or
with an unrelated policy identity cannot supply applicability. Unknown check IDs
are rejected. An applicability key identifies inputs; it is not a result,
provenance attestation or permission to reuse an old PASS.

## Completeness and race limits

Supplemental digests are **trusted host admissions**, not discoveries performed
by this API. A caller must establish actual dependency closure, enabled features,
tool binaries/configuration, test inputs and execution environment before
supplying them. `None` is unknown; an explicitly established empty category may
be hashed. Any declared unresolved input refuses capture. Raw secret values do
not belong in context records.

The native capture walks Git-index paths at their working-tree bytes and
nonignored untracked paths. Ignored inputs are not added by `allow_paths`;
required ignored inputs therefore fail rather than silently disappearing.
Supplemental generated or external inputs need their own admitted identities.
Directories/submodules and other nonregular candidates are not recursively
captured by this contract. The host adapter must account for them or mark the
closure unresolved. A successful source capture alone does not prove complete
inputs for arbitrary commands, Git-sensitive checks or networked tests.

Two matching captures and repository reads detect observed changes. They do
**not** create a transaction against external writers, prevent an ABA change or
prove that all file bytes existed together at one instant. Repository metadata
is also collected through separate reads. S4 must execute frozen captured bytes
with admitted supplemental inputs, or establish a separately justified live
execution fence. It must not run unrestricted commands over the current tree
and label their outputs with an earlier snapshot.

Keys conservatively cover the entire admitted closure. Symbol-level pruning,
cross-revision applicability receipts and fine-grained invalidation remain later
work; matching changed-file hashes alone cannot authorize reuse. Branch/HEAD and
status inclusion may produce safe cache misses. No token, latency or cache-hit
improvement is claimed.

## Validation record

Environment: Linux x86_64, pinned `nightly-2026-08-08`, local task toolchain from
the S1 validation note. No new repository dependency or linker setting was added.

- `cargo nextest run -p omp-driver --test verification_policy --locked`: **11
  passed, 0 skipped** after the S2 API additions.
- `just fmt-check-rust`: **exit 0**. A final targeted `rustfmt --edition 2024
  --check` on all changed Rust files also returned **0** after fixture correction.
- Real-host `verification_snapshot` executable, `--test-threads=1`: **7 passed,
  0 failed, 0 ignored**. The first execution failed all seven in fixture setup
  because its native state directory was missing; creating that directory fixed
  the fixture. No production behavior was changed for this failure.
- Private snapshot fault tests: **7 passed, 0 failed, 568 filtered out**. These
  exercise malformed identities, omissions, all unknown context categories,
  deterministic observed drift, repository counters, paths and unavailable metadata.
- `cargo test --doc -p omp-driver --locked`: **1 passed, 0 failed**, exit **0**.
- Relative Markdown link validation across changed documents: **115 targets
  checked, 0 missing**. Staged whitespace validation: **exit 0**.

The ordinary combined nextest build was blocked during linking by the small
workspace disk. Repeated LLVM `rust-lld` attempts reported SIGBUS; free space
was exhausted during builds. A successful GNU BFD image was about 516 MiB before
symbol stripping. Checking section tables in 1,072 cached Rust/native archives
reported zero errors, but this does not independently establish the SIGBUS cause.
The local workaround uses the **same LLVM test-profile objects**, GNU BFD and
the existing vendored Python dependency archives in a final link group. It does
not establish that the ordinary native-test link configuration passes here or on CI.

Private tests were compiled by `cargo nextest run -p omp-driver --lib -E
'test(verification::snapshot::tests)' --locked`, using a local `RUSTC_WRAPPER`
that appended GNU BFD, symbol stripping and the Python archive group only to
the driver test harness. That BFD link was stopped after several minutes;
replaying its exact `cc` arguments with the pinned LLVM linker, final
`--strip-all --no-mmap-output-file` and output in the isolated sandbox's RAM-backed
`/dev/omp2-unit-test` completed. The 447,608,680-byte harness then ran
`verification::snapshot::tests --test-threads=1` successfully. The ordinary
nextest invocation itself did **not** pass. This local resource workaround
changes neither source objects nor the test backend; an adequately provisioned
machine should run the normal nextest command instead. Its 568 unselected tests
are not claimed as passing.

Reproduce the real-host fallback from the prepared S1 toolchain environment:

```bash
s2_link_args=(-C link-arg=-fuse-ld=bfd -C strip=symbols -C link-arg=-Wl,--start-group)
for s2_archive in "$S2_PYTHON_ROOT"/build/lib/*.a; do
  s2_link_args+=(-C "link-arg=$s2_archive")
done
s2_link_args+=(-C link-arg=-Wl,--end-group -C link-arg=-latomic -C link-arg=-lm \
  -C link-arg=-ldl -C link-arg=-lpthread -C link-arg=-lrt -C link-arg=-lutil)
CARGO_BUILD_JOBS=1 cargo rustc -p omp-driver --test verification_snapshot \
  --profile test --locked -- "${s2_link_args[@]}"
# Run the executable reported by Cargo, using --test-threads=1.
```

Set `S2_PYTHON_ROOT` to the prepared bundle root, locally
`/workspace/omp-toolchain/vendor/python`. The executed build used `-C
link-arg=-s` and then GNU `strip --strip-unneeded` on the generated executable;
`-C strip=symbols` above expresses that directly. To reduce disk peak the local
run removed expendable Cargo archive caches and old generated test binaries;
these are not repository changes. Full workspace, macOS, hosted CI and merge
status are not asserted. No model, reranker, benchmark improvement or live gate
was exercised by these tests.

During validation, `origin/omp2` advanced to
`57db854b1c18965414762145332f05c035a9c2dd` through ADR 0050 work. These local
results apply to the branch's pinned `0b4a600` base, not a merged result with
that subsequent work. No production/dependency/lockfile changes outside this
slice are part of its diff.

## Follow-up boundary

S3 must retain immutable evidence and transitive blobs through the existing
journal/CAS, including interrupted publication, replay, corruption and GC proofs.
S4 must admit actual supplemental inputs, execute explicit A1/C1 checks under
existing authority on those inputs, retain complete observed check/test inventory
and publish current-snapshot receipts. Neither S2 keys nor historical Mnemopi
recall can satisfy a gate. ADW acceptance defaults, semantic reviewers, automatic
repair, reranking and commit authority are unchanged.
