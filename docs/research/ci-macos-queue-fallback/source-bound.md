# Source-bound fallback for CI changes

Status: PR #685 update, 2026-11-17. This supersedes the v1 opt-in configuration
and direct-hosted-only exception documented in the earlier rollout record.

## Why

The original #685 run completed Linux/BuildBuddy checks, but GitHub could not
assign either `macos-15` job. Both were cancelled without running any steps.
GitHub annotations explicitly reported macOS ARM64 capacity constraints.
The control-change exception and frozen `ci.yml` digest prevented the requested
fallback precisely when the PR changed CI itself.

## Execution and authority

For eligible same-repository `omp2` PR/push/merge-group requests, an Ubuntu
controller queues a dedicated GitHub-hosted macOS attempt first. After 300 seconds
observed unassigned queue time, it rechecks current source and assignment,
cancels only that attempt, confirms cancellation, drains the admission lease,
then queues the same objective/source on the Mac. An assigned hosted attempt
retains ownership. Test failures never become fallback opportunities or PASS.

The worker initially checks out its pinned control release and admits the
request. It then checks out the exact admitted source SHA at the workspace root,
restores pinned admission control separately under `.ci-control`, and invokes
the candidate's native composite action. Its nested local provisioning actions,
`macos_worker_state.py` and `ci-macos-objective.sh` therefore come from the tested
source, including CI changes. The separate pinned guard supervises state/native
commands, renews source/parent admission, enforces the physical-host lock, checks
source/tree cleanliness and publishes a receipt only after successful settlement.

The tested revision for PRs remains the exact current merge snapshot, with both
base/head fences; it is not silently replaced by the branch head. The worker
workflow and admission/transport implementation remain versioned infrastructure.
Changing candidate guard/controller code exercises their Python tests; it does
not claim that the running guard was replaced with that candidate revision.
Upgrading protocol infrastructure requires another explicit worker release pin.

The `source-bound` policy reuses the owner's existing repository-writer trust
decision. Both original and triggering actor must be `blyzer`, the repository
must be `blyzer/oh-my-pi`, the parent must still be live and the source current.
Fork PRs remain direct-hosted. Live GitHub observations independently validate
these identities; a request envelope alone cannot grant Mac access. A frozen
parent-workflow hash is no longer the authority in this mode. Legacy digest mode
remains supported by the protocol for other explicit configurations.

This is trusted code execution on the owner's Mac, not a sandbox against hostile
repository writers. Candidate composite/provisioning actions are trusted workflow
code and execute outside the supervised native process group; candidate source
must already be within the admitted owner trust boundary. The process lock covers
the heavy native objective, not all unrelated workflows or provisioning actions.

## Configuration

The parent workflow now pins admission release `ci-macos-worker-source-bound-v4`
to commit `6e361f2d70c505aa38c9ad6aaf359cb9b5cd457b` in versioned workflow
environment values. The tag must resolve to that exact commit at every dispatch;
a missing/moved tag fails closed. Old repository worker-ref/SHA variables do not
override this pin. Keep old tags while old generations may still need draining.

Following the owner's explicit instruction to use the existing Mac, eligible
owner requests default to fallback enabled, `repository-writers` trust, and
historically used labels `["self-hosted","macOS","ARM64"]`. Repository variables
`CI_MACOS_FALLBACK_ENABLED`, `CI_MACOS_FALLBACK_TRUST` and
`CI_MACOS_FALLBACK_LABELS` can still override these values. Literal `false` for
the enabled variable retains hosted-only execution; invalid trust/labels prevent
Mac admission before hosted cancellation. Disabling also revokes Mac leases.
No runner registration, BuildBuddy settings, Linux routing or required check
names change. Manual/main/outside-repository requests stay direct-hosted.

Rollback: set `CI_MACOS_FALLBACK_ENABLED=false` and allow admitted work to drain,
or revert the parent workflow pin/routing change. Do not delete active release tags.

## Verification

Local validation passed: 134 tests through the existing CI runner/policy suite,
`check-ci-paths.py`, editing-discipline checks, whitespace checks and Actionlint
1.7.12 for CI, worker, CodeQL and P8 (Shellcheck unavailable/disabled).
Offline tests cover changed-parent admission without the previous workflow hash,
rejection of stale source/cancelled parent/fork identity/foreign actors, explicit
disable and invalid labels, candidate-root versus pinned-guard checkout order,
and existing queue/ownership/cancellation/artifact/state behavior. Local test
counts and live rollout results are recorded in the PR. A passing offline suite
does not prove a live GitHub dispatch, real Mac availability or native test success.

The first v2 live attempt exposed an API contract mismatch: GitHub API
`2026-03-10` omits `merge_commit_sha`, while `2022-11-28` returns it for the same
PR. Both queries were executed against PR #685; its merge commit's parents
matched the base/head identities. V3 explicitly pins the compatible `2022-11-28`
API contract and keeps the existing exact-merge fence. V2 did not dispatch work
and does not establish native verification success.

The v3 attempt at source `0db9c2e1e6dcee2d1251fee398afd476fa1b26af`
did exercise hosted cancellation and generation-1 dispatch. However, its worker
`runs-on` default still used `["macos-15"]`, while admission defaulted to
`["self-hosted","macOS","ARM64"]`. With no label variable configured, both
fallback jobs landed on GitHub-hosted runners and failed admission; neither
executed native verification. See [Rust fallback](https://github.com/blyzer/oh-my-pi/actions/runs/44198306165)
and [lint fallback](https://github.com/blyzer/oh-my-pi/actions/runs/44198285861).
V4 aligns runner selection and admission defaults, with a regression test covering
both expressions and preserving the hosted branch. This is a routing correction,
not evidence that the physical Mac has executed the new worker successfully.
