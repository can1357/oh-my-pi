# S3: session-rooted verification evidence

Date: 2026-11-14.
Branch: `feat/verification-evidence-store`.
Parent: S2 at `e960c471555c19a3a67afb98a77e3a7d69035c73`, published in
[PR #646](https://github.com/blyzer/oh-my-pi/pull/646) and **not merged** when
this slice started. This is a layered dependency, not a claim that S2 is on
`omp2`. The latest observed `origin/omp2` was
`57db854b1c18965414762145332f05c035a9c2dd`.
Before publication, S3 was rebased onto the updated S2 parent
`65e8c9479f640d19c82ccd17c86801bdc3b518a1`, which includes the fetched `omp2`
at `f2c4a20a24e1522b617fef720d194bbc869f50e8`. The capacity experiment below
continues to pin the original committed S2 tree explicitly.
Status: locally validated implementation; no check execution or joined gate.
The original research source pin and earlier slice validation remain historical.

## Native ownership and publication

`crates/driver/src/verification/evidence.rs` owns the evidence adapter.
`publish_evidence` receives the existing mutable `omp_session::Session`, native
Environment client, S2 snapshot/policy and host-admitted check result. It uses
the existing `EnvironmentInputs` manifest/blob reader in
`crates/driver/src/exec_composer.rs`; there is no second source scanner or CAS.

The Environment capture CAS and session CAS are separate authorities. A native
manifest address does not imply its bytes are retained by a session journal.
The adapter therefore imports the manifest and every captured source child,
the canonical S2 snapshot and supplied evidence payloads into `Session::blobs()`
before publishing their record. Address equality is checked against the actual
consumed bytes. A deduplicating `BlobStore::put` is not sufficient: an existing
path may contain corrupt bytes, and `get` checks length rather than digest.
The adapter instead reads a bounded native blob range, checks the size from the
same opened inode before allocation, then verifies the length and hash of the
consumed bytes. An oversized on-disk corrupt file cannot force an unbounded read.

The retained source closure is the native capture's manifest and regular-file
children. Supplemental dependency, toolchain, environment and fixture identities
in S2 remain opaque host-admitted hashes; this adapter does not automatically
discover or retain the bytes behind them. Supplied payloads are raw leaf bytes,
not recursively traversed manifests. Hashes or artifact-like text inside a log
do not declare additional retained children. A future reproducible execution
adapter must explicitly account for any additional material it needs.

Publication uses `Session::patch_keyed` and structured `omp_dom::Value::Json`
metadata under the existing session DOM. The same journal-first fold supplies
live state and replay; no verification database, custom journal vocabulary or
parallel mutable history is introduced. The canonical evidence-record identity
provides a stable mutation key, so an identical retry does not append a second
receipt. Validation failure or cancellation observed before synchronous
publication makes no journal claim; already written unreferenced blobs may remain
for ordinary collection. Cancellation during synchronous commit does not discard
its acknowledgement. An I/O
error during journal append has uncertain settlement: a complete frame may be
recoverable after reopen. Callers must reconcile through the keyed session
record rather than assume the failed call proves absence.
Receipt metadata lives in the structured journal patch. Its identity is the
canonical record digest, not an assertion that a standalone CAS blob with that
digest exists; the typed publication also carries the journal entry identity.
The publisher's identical retry still requires the Environment source CAS to be
available. Offline reconciliation uses `evidence_publications` and `load_evidence`
over already retained session bytes; offline republishing is not implemented.

## Complete retention closure

`crates/journal/src/gc.rs::collect_value_roots` recursively inspects journal-entry
JSON, including structured `BlobRef {h,n}` values. It does **not** open opaque
manifest blobs and traverse their children. Every source and evidence child must
therefore occur in the record's complete flat retention closure, inline in the
published patch. Rooting only a manifest would allow its leaves to be evicted.

The open Session holds its journal namespace lease throughout publication. The
adapter refuses a session whose journal parent and blob-store root differ,
because the journal's lease would otherwise protect a different namespace.
This reuses existing GC exclusion rather than adding a verification-specific
lock. Final blob writes precede the journal append; no publication advertises
bytes still being staged.

Blob count, individual and aggregate bytes, and encoded record size are bounded.
Preflight also caps artifact count and aggregate metadata bytes. The total-byte
limit caps both distinct retained bytes and the sum of raw payload input bytes,
counting duplicates for work budgeting. Source hashes already verified in the
transaction skip repeated reads. Oversized raw inputs are rejected before hashing.
The record bound accounts for the existing one-MiB journal payload ceiling and
the keyed patch's structured record copies. Exceeding a budget refuses
publication; it never truncates a closure or drops security-relevant evidence.
This accepts a conservative capacity limit in exchange for auditable retention.

## Capacity check: measured inventory and modeled record size

The initial 4,096-blob/64-MiB/256-KiB record caps would reject this repository's
source inventory before a complete evidence record could be published. The
revised caps are 8,192 blobs, 256 MiB total and 480 KiB per record; the individual
blob ceiling remains 8 MiB. The two record copies plus a 4-KiB envelope estimate
fit below the existing one-MiB journal ceiling: `2 × 480 KiB + 4 KiB = 964 KiB`.
Actual publication still validates its bounded record rather than trusting this
estimate or silently omitting files.

Executed from the repository root:

```bash
python3 docs/research/omp2-hybrid-verification/experiments/evidence_capacity.py \
  e960c471555c19a3a67afb98a77e3a7d69035c73
```

The dependency-free, read-only [script](experiments/evidence_capacity.py) runs
`git ls-tree -r -l -z` against that exact commit. Its
[raw JSON output](experiments/evidence-capacity-e960c47.json) records:

| Quantity | Result | Evidence class |
|---|---:|---|
| Tracked regular files, modes `100644`/`100755` | 4,665 | Measured Git inventory |
| Logical Git blob bytes | 85,127,183 | Measured Git inventory |
| Largest Git blob | 4,573,616 bytes | Measured Git inventory |
| Flat closure references, including three auxiliary refs | 4,668 | Serialization model |
| Closure JSON | 383,257 bytes | Serialization model |
| Record including assumed 4-KiB envelope | 387,353 bytes | Serialization model |
| Two record copies plus assumed 4-KiB journal envelope | 778,802 bytes | Serialization model |

The closure model treats **every regular file as distinct**, using ordinal
64-hex placeholders rather than native content hashes. Its three auxiliary
references stand for the source manifest, canonical snapshot and one leaf
artifact; each is conservatively assigned the 8-MiB per-blob ceiling. This
produces a modeled retained-byte upper bound of 110,293,007 bytes under those
assumptions. The original caps fail the model's count, aggregate-byte and record
checks; the revised caps pass all modeled checks. The assumed envelopes are not
formal bounds on arbitrary caller metadata or payload selection.

These are committed Git-tree measurements and a JSON serialization model, not
a native capture or a successfully retained whole-repository evidence receipt.
They do not prove security filters permit every path, that dirty/untracked or
supplemental inputs fit, or that source deduplication has any particular ratio.
No capture latency, retention performance, elapsed time or memory-use result is
claimed. Native publication/reopen tests separately exercise actual journal
headroom; their executed results belong in the validation record below.

## Read and applicability boundaries

`load_evidence` validates the published identity, retained closure and digest of
the same bytes it consumes. `Session::live_entries` follows the selected head's
ancestry, including an in-memory rewind before its next append, so abandoned
branch records cannot become current observations merely because they remain
in `Session::entries()` history.
This is not exhaustive authentication of the entire S2 snapshot schema: the
reader checks its source-related fields and binds all remaining bytes by hash.
Applicability still requires equality with the actual current S2 snapshot.

`evidence_publications` discovers committed receipt identities after restart,
including an append whose caller did not receive acknowledgement. Discovery
validates receipt metadata; it does not replace `load_evidence`'s blob checks or
`evidence_observation`'s applicability checks. The shared native manifest-entry
parser is also reused to check that every captured source child appears in the
published closure.

`evidence_observation` additionally checks the exact current S2 snapshot, policy,
declared check and action configuration. Original evidence remains immutable.
The snapshot is supplied by the trusted caller: this function does not recapture
the live worktree or establish that an old snapshot is still current. S4 owns
freshness and frozen-execution admission.
Matching an old changed-file hash, historical memory or a reviewer assertion
does not rebind it to a new revision. This slice permits exact-input reuse; it
does not implement a proof that an altered dependency closure is equivalent or
issue a new cross-revision applicability receipt.

Result truth, executable coverage and producer provenance remain **trusted host
admissions**. Retaining a record whose admitted outcome is `Passed` proves that
those bytes were published and remain applicable to the supplied identities;
it does not establish that a compiler or test actually ran. Supplied payloads
also need caller-side secret handling before durable publication. S3 introduces
no model invocation or executable authority and changes no ADW acceptance default.

## Validation record

Linux x86_64 with pinned `nightly-2026-08-08`, existing embedded Python and task
toolchain from the S1/S2 notes. No dependency, lockfile or repository linker
configuration changed.
The listed test scopes were repeated after rebasing onto S2 parent `65e8c94`;
the native harnesses therefore exercise that parent's updated Environment host.

| Executed scope | Result |
| --- | --- |
| `just test-pkg omp-session` | 73 tests passed, 1 fixture-writing test ignored; 0 doctests |
| `cargo nextest run -p omp-journal --test gc --locked` | 14 passed, 2 subprocess helpers skipped as standalone tests |
| `cargo nextest run -p omp-driver --test verification_policy --locked` | 11 passed, 0 skipped |
| `verification_snapshot` real-host regression harness | 7 passed, 0 ignored |
| `verification_evidence` real-host harness after targeted driver clean | 16 passed, 0 ignored |
| `cargo test --doc -p omp-driver --locked` | 1 doctest passed |
| `just fmt-check-rust`, final changed-file rustfmt check, whitespace check | exit 0 |
| Capacity script syntax and exact pinned-report reproduction | passed; byte-identical JSON |
| Relative Markdown links across changed documents | 119 targets checked, 0 missing |

That is **121 passing tests and one passing doctest**, with the three explicitly
identified ignored/helper cases above. The new tests cover native source import,
complete leaf retention after GC/reopen, restart discovery, exact idempotence,
missing/same-size/oversized corrupt blobs, corrupt deduplication, forged incomplete
or extra closures, cancellation, metadata/work/record limits, namespace mismatch,
rewind and changed-input/configuration refusal. Failed and effects-unknown outcomes
retain their FAIL/INCONCLUSIVE meaning. A receipt containing a 400-KiB provenance
field publishes both structured copies below the one-MiB journal ceiling and
reopens unchanged. The interruption test simulates put-before-journal abandonment;
it does not kill a process during fsync or prove every crash interleaving.

The small workspace disk could not comfortably hold the large native test
executables. Their **LLVM test-profile builds** used temporary RAM-backed output,
then ran the emitted harness directly. This is not a claim that the ordinary
full-driver or full-workspace nextest suite passed. Reproduce that local fallback
from the prepared toolchain environment:

```python
import os
import pathlib
import subprocess
import tempfile

for target in ("verification_evidence", "verification_snapshot"):
    with tempfile.TemporaryDirectory(prefix="omp2-s3-", dir="/dev/shm") as directory:
        subprocess.run([
            "cargo", "rustc", "-p", "omp-driver", "--test", target,
            "--profile", "test", "--locked", "--",
            "-o", str(pathlib.Path(directory) / target), "-C", "strip=symbols",
        ], env=dict(os.environ, CARGO_BUILD_JOBS="1"), check=True)
        binaries = [p for p in pathlib.Path(directory).iterdir()
                    if p.is_file() and os.access(p, os.X_OK)]
        assert len(binaries) == 1  # rustc appends its metadata suffix
        subprocess.run([str(binaries[0]), "--test-threads=1"], check=True)
```

This host's `/dev/shm` permits execution; other hosts should use their ordinary
nextest targets or an appropriately sized executable temporary filesystem.
An initial local launcher assumed an unsuffixed executable name and ran no tests;
the corrected launcher above produced the recorded results. Full workspace,
macOS, hosted CI and merged-result validation remain separate. No live gate,
model, reranker, token reduction or defect-recall improvement was measured.

## Next boundary

S4 remains the first working verification path: admit actual supplemental input
closure and tool identities, run explicit deterministic A1 and selected C1 checks
on frozen inputs through existing execution authority, retain complete observed
check/test inventory, validate completion and provenance, and publish the result.
Only then can an opt-in required gate use the S1–S3 chain. Semantic reviewers,
reranking, autonomous repair and commit authority remain later work.
