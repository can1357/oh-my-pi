# Hosted-first macOS routing implementation and rollout

Status: implementation under review; no live fallback activation or Mac canary
claimed. Base `omp2@98303fde57bcaeb4d34149df5ec6f302c3ed8179`, 2026-11-17.
Follows the approved [plan](README.md) and [S0 design](design.md).

## Implemented behavior

Without new configuration, native CI stays on GitHub `macos-15`, retaining
Rust's 120-minute and lint's 45-minute limits. Linux, BuildBuddy, packaging, P8,
their execution/routing/secrets and branch protection are unchanged. The two
required check names, GitHub Actions producer and `proved-tree` lookup remain.

With a reviewed worker tag/SHA configured, eligible same-repository `omp2`
requests use Ubuntu controllers. Each queues an independent GitHub-hosted
macOS worker first. Different requests can run on GitHub and the owner's Mac
concurrently. External-repository PRs remain directly hosted.

Mac fallback is a separate opt-in. After 300 seconds observed unassigned queue
time, the controller rechecks source, assignment and accepted policy, cancels
only its isolated worker run, confirms terminal cancellation and waits 150 seconds
for admission/cleanup expiry before dispatching the same source/objective to the
Mac. Observed hosted ownership wins. Real test failures are not retried on a
different pool to obtain PASS. Assignment/cancellation is not an atomic operation.

The drain is a 135-second worker lease plus TERM10/KILL5 cleanup. Compared with
S0's initial timings, queued controllers poll every 30 seconds, assigned ones
every 60, and workers every 45 with 135-second leases. Grants begin at read start,
not late response arrival. Parent generation, current source and worker-run
cancellation participate in renewal. Full provenance and actual checkout identity
are checked before native work and publication. These refinements reduce GitHub
API usage; they are not latency measurements or an exactly-once guarantee.

Guarded setup and native work run inside one locked, supervised process group
with inherited `GH_TOKEN`/`GITHUB_TOKEN` removed. Worker state uses a dedicated
`omp-macos-worker` namespace and never evicts BuildBuddy/other workflow caches.
Credential scrubbing is not OS isolation against hostile code running as the
same user; the explicit repository-writer trust prerequisite remains necessary.

## Code boundaries

| Files | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` | Existing named native gates; direct-hosted default or opt-in Ubuntu controllers |
| `.github/workflows/macos-verification.yml` | Independently cancellable worker; admission before candidate checkout |
| `.github/actions/macos-native-objective/action.yml`, `scripts/ci-macos-objective.sh` | Shared complete command inventory, affected modes, nextest/doctests/Python/harness/P1–P8/Seatbelt P12 |
| `scripts/macos_fallback_common.py` | Exact request schema, current source/parent fences, tag resolution, reviewed Mac policy and token-safe REST |
| `scripts/macos_fallback_controller.py` | Uncertain dispatch correlation, queue/ownership protocol, older release/attempt reconciliation and strict artifact/result validation |
| `scripts/macos_worker_guard.py` | Admission, physical-host lock, bounded process/lease cleanup, source mutation refusal and atomic result |
| `scripts/macos_worker_state.py` | Guarded candidate Python/state preparation and native execution handoff |

GET retries are bounded and honor retry delay within their budget. Dispatch POSTs
are never blindly retried. A 409 or uncertain cancellation response still
requires observed terminal settlement. Artifact redirects do not receive the
job token. Only the parent gate relays full Rust proof; affected coverage never
claims full proof. Existing push reuse's lint skip remains historical policy,
not new lint evidence. `TERM` remains scoped to P7.

## Deployment after review

1. Merge reviewed code with new configuration unset. The default branch then
   contains the worker while ordinary hosted execution continues.
2. Create/protect a versioned immutable tag, for example `ci-macos-worker-v1`,
   at the reviewed worker commit. Configure its exact tag and commit below.
   A moved/deleted/mismatched release fails closed; keep old reviewed tags so
   rerun reconciliation can drain their active candidates.
3. Run a trusted hosted-worker canary with Mac fallback off. Check native
   outcomes, result artifact, required-check identity and full Rust proof reuse.
   Hosted success must finish with the personal Mac offline.
4. Complete [Mac preflight](preflight.md): real services/labels, Apple Silicon,
   pinned tools/nextest/LLVM22, Seatbelt, disk, cache ownership, one heavy service
   on the physical host, process-tree cleanup and developer-file isolation.
   Other heavy workloads must share admission or be excluded operationally.
5. If runner controls cannot enforce trusted-workflow access, explicitly accept
   the broader repository-writer boundary before configuring trust acceptance.
   Labels are not admission security, and plan/PR approval alone is not acceptance.
6. Enable an owner-only Mac canary. Exercise a real queued-hosted fallback,
   cancellation race, restart/supersession, stale result and physical-slot cases.
   Immediate hosted success does not prove fallback. Broaden only with evidence.

| Repository variable | Purpose |
| --- | --- |
| `CI_MACOS_WORKER_REF` | Reviewed immutable `ci-macos-worker-*` tag |
| `CI_MACOS_WORKER_SHA` | Its exact 40-character worker/control commit |
| `CI_MACOS_FALLBACK_ENABLED` | Literal `true` to consider Mac fallback; otherwise retain hosted |
| `CI_MACOS_FALLBACK_TRUST` | Literal `repository-writers`: explicit operational trust acceptance |
| `CI_MACOS_FALLBACK_LABELS` | JSON array of actual confirmed labels including `self-hosted`, `macOS`, `ARM64` |
| `CI_MACOS_PARENT_WORKFLOW_SHA256` | SHA256 of reviewed `.github/workflows/ci.yml` bytes; changed parent workflow disables Mac admission until reviewed/configured again |

First Mac canary also requires original and triggering actors both be `blyzer`.
Missing/rejected Mac policy retains hosted work; it does not cancel it to send
an unapproved Mac candidate. Do not change `MACOS_RUNNER`, `CI_LINUX_MODE` or
BuildBuddy settings to use this feature. No Mac daemon, private App key or
check-producer migration is required.

Rollback: disable `CI_MACOS_FALLBACK_ENABLED` and drain admitted candidates; unset
worker REF/SHA to restore direct-hosted CI for new requests. Do not delete release
tags until their work has drained. No auto-merge/admin bypass is implemented.

## Validation and operational limits

Offline tests cover fake-clock queue thresholds, assignment/409 cancellation
races, asynchronous settlement, lost responses, prior releases/attempts,
malformed/stale artifacts, token redirects, expiry and explicit source/worker
revocation, actual Linux descendant cleanup, checked-out source mutation,
native command inventory and unchanged nonmacOS job bodies. These are not
macOS or live dispatch proofs.

On 2026-11-17, read-only runner/variable inventory still returned HTTP403
`Resource not accessible by integration`. No direct Mac connection is established.
No tags, variables, services or live candidates were configured in this session.
Deployment and real Mac canaries remain blocked on those prerequisites. Code
presence does not mean active runner diversification.

Executed local validation:

- `PYTHONPATH=scripts python3 -m unittest test_hosted_runners test_check_ci_paths`:
  88 tests passed, including the 63 protocol/guard/setup tests. The existing CI
  runner-policy entry point discovers those tests, so this is wired coverage,
  not a local-only test command.
- `python3 scripts/check-ci-paths.py`: passed; required checks and fork guards
  remain present. NonmacOS job bodies were compared byte-for-byte with the base.
- `python3 scripts/check-editing-discipline.py`, Bash syntax and
  `git diff --check`: passed.
- actionlint1.7.12, fetched outside the repository and checked against its
  published release checksum: both changed workflows passed. Shellcheck was
  unavailable and explicitly disabled for that invocation.
- A read-only repository API request with version `2026-03-10` succeeded;
  this verifies version acceptance for that GET, not dispatch/cancel behavior.

Independent review found and prompted fixes for pre-guard candidate setup,
source/worker revocation, prior-release draining and direct timeout preservation.
A fresh final source review found no confirmed Blocker/Major findings. This is
not certified EGM convergence or a substitute for real Mac canaries. No Rust
source/dependency changes or production engine implementation is included.
