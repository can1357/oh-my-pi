# Guarded macOS cache reuse

Base: `omp2@7aedb5bd571a2d7777ead86b3d6df39bdda1659b` (merged #685).
This fixes the gap where the guarded GitHub worker skipped `macos-build-state`
and therefore missed its Python/Cargo download caches. Hosted-first runner
ownership, native guard/lease/receipts, the physical Mac and BuildBuddy stay intact.

## What is reused

The candidate native composite action restores two hosted-only caches through
the existing pinned GitHub cache action. Python stores both dev/release trees
and a preparation marker. Its exact key covers OS/architecture, absolute workspace
path (generated configs contain absolute linker/executable paths), fetch/packing/
notice scripts, requirements and the preparation implementation. It deliberately
has no prefix fallback. Cargo stores registry archives/index and Git databases,
keyed by OS/architecture and Cargo.lock with a same-platform prefix fallback.
It stores neither Cargo credentials nor `target/` or compiled release binaries.
Existing sccache remains enabled; no hit-rate or speed improvement is claimed yet.

Cache restoration runs after source admission, as trusted workflow infrastructure.
It does not run Python preparation, install the cached interpreter or grant gate
authority. Cache reuse/preparation stays inside the existing supervised native
process. A matching marker is necessary but insufficient: both trees must contain
stdlib/config/archive stamps, native library and executable paths inside their
own vendor tree, and a matching bundled-requirements stamp when packages exist.
Incomplete, malformed, moved-workspace or changed-input state is discarded only
from the checkout's two Python trees and rebuilt by the existing fetch script.
An incomplete rebuild cannot write a ready marker. Linker/native checks still run.

These are structural checks on trusted cache inputs, not signatures or exhaustive
hash verification of every restored byte. Source-bound checks and real test/lint
execution remain mandatory. Cache hits never satisfy verification objectives.
The existing cache action saves on job success; failures/cancellation cannot
publish the normal successful-worker cache through that post step. GitHub cache
quota/eviction or unavailable downloads can still produce cold builds.
Cache entries are immutable: a corrupt exact entry is rebuilt safely for the
current run, but may require cache eviction to populate a repaired entry under
the same key. This change does not add cache-administration privileges.
No new server, cache service, dependency, runner label or worker release pin is needed:
the pinned worker already invokes actions/state from the admitted candidate.

The Mac continues using its private persistent Python/Cargo state under the
physical-host lock, with sccache disabled there. Other direct/package workflows
retain their existing cache action and configuration.

## Validation

Local standard-library tests exercise cold fetch, unchanged warm reuse, input
invalidation, incomplete restore, stale absolute paths, malformed markers,
incomplete preparation, vendor symlink rejection and token scrubbing. Workflow
policy tests check hosted-only admission, complete key inputs and absence of
target/credential caching. Actionlint and repository policy checks validate wiring.

Live acceptance requires two successful hosted runs with the same Python inputs
and workspace: first populate the cache, then observe `guarded Python cache:
validated reuse`, no repeated Python fetch/packing, and successful native checks.
Record cache-hit diagnostics, timings and sccache statistics before making any
performance claim. This Linux environment cannot execute a real macOS canary.

For distributing validated release packages rather than speeding CI builds,
see the separate release-packaging change. It must preserve the exact release
profile and publish the smoke-tested bytes, rather than rebuild after validation.
