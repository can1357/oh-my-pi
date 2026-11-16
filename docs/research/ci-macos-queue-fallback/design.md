# S0: native macOS queue fallback design

Status: proposed detailed design; live Mac preflight blocked. Owner approved S0
after plan PR #673. No implementation or CI policy change in this document.
Source: `omp2@a4b1325ef85a6c6a309015319026b0c673b0ef59`, 2026-11-16.
The plan's broader personal-Mac trust acceptance and ruleset exceptions remain
unapproved. PR #658 remains outside this work and must not be merged here.

## Architecture choice

Use the existing two GitHub Actions check jobs as Ubuntu controllers for trusted
events. Each independently dispatches one hosted macOS worker first and, only
after the queue/cancellation protocol, one self-hosted replacement. Each worker
is a separate workflow run with one native objective. Preserve the two existing
check names, their GitHub Actions producer and full-Rust `proved-tree` annotation.
Do not create a check-publishing App or permanent dispatcher on the Mac.

Why: a Linux controller can start, observe and publish ordinary hosted success
without any Mac service. It needs no long-lived App key, incoming Mac network
access or new state server. Its cost is occupying up to two Ubuntu slots while
workers queue/execute. This is concurrency/operational cost, not evidence of
public-repository billing exhaustion. A Mac daemon adds local credentials and
restart supervision without eliminating the need for a reliable final reporter.

The controller's state authority is its parent run/job/attempt plus the selected
candidate IDs and result manifest, not a shared mutable GitHub check. Never run
two controller processes for one objective. Parent reruns use new attempt IDs;
workers of abandoned attempts cannot satisfy them. No exactly-once claim is made.

For outside-repository PRs, the original named jobs still run directly on
GitHub-hosted macOS, without dispatch privileges or fallback. Their `runs-on`
becomes an explicit event/trust expression: external PR -> `macos-15`, eligible
trusted event -> `ubuntu-24.04`. Full-name repository comparison is required;
`head.repo.fork` is not an equivalent test. Existing no-Rust-change and
already-proven skips remain unchanged. Unknown events are not eligible for
self-hosted dispatch and must not be silently promoted to trusted status.

Initial eligibility is explicit: external PRs use direct hosted execution;
same-repository PRs targeting `omp2` and pushes to `omp2` use hosted workers;
merge-group requests targeting `omp2` use hosted workers with their own event
identity. Other branches/events stay on existing hosted behavior. Automatic Mac
admission is default-off and, for the first canary, additionally requires the
original and triggering actors both be `blyzer`, the repository ID match, and
the parent CI workflow blob match the reviewed release's allowlisted digest.
Changes to eligibility require a reviewed worker release, not a dispatch input.
Broader actor eligibility is deferred until explicit writer-trust acceptance.

Before running native work, the worker independently fetches its parent run,
attempt and controller job. Verify the expected repository/workflow IDs, event,
source association and current PR head/base/merge identity against GitHub data.
Check the parent workflow blob and worker revision against the trusted release
manifest; do not trust requested SHAs alone. For Mac admission, require the
recorded hosted candidate for this exact nonce to be terminally cancelled,
belong to the same parent/objective, and have no accepted successful owner.
Permission failure, ambiguous ancestry or stale input refuses execution.

```mermaid
sequenceDiagram
    participant G as Existing named CI gate on Ubuntu
    participant H as Independent hosted macOS run
    participant M as Independent self-hosted Mac run
    G->>H: Dispatch exact request and hosted pool
    loop Poll at 15-second intervals
        G->>H: Inspect run, attempt and job assignment
    end
    alt Assignment observed before fallback admission
        H-->>G: Complete native objective and result artifact
    else Queued for at least 300 seconds
        G->>H: Recheck; cancel this candidate run only
        H-->>G: Terminal cancelled, ownership settled
        G->>M: Dispatch same request, new candidate ID
        M-->>G: Complete native objective and result artifact
    end
    G->>G: Validate current identity, conclusion and manifest
    G-->>G: Original required check succeeds or fails
```

## Identity and trusted workflow selection

Request schema version1 contains repository ID/full name, parent workflow ID,
parent run ID/attempt, objective (`rust` or `lint_macos`), event type, PR number
if applicable, PR head/base SHAs, tested commit SHA and tree SHA, full/affected
mode and validated package selection, worker workflow commit, and a random
request nonce. Pool and candidate generation are separate fields. Hash a
canonical sorted JSON encoding; never use free-form shell fragments as inputs.

PR mode pins the parent's actual synthetic merge checkout and records head/base
independently. Push and merge-group modes pin the event's exact commit/tree.
Resolve identities before dispatch and revalidate before fallback and before
accepting results. A base/head change before publication is stale and fails
closed. The current non-strict ruleset does not revoke an already published
success after a later base update; this design preserves that inherited merge
policy and does not claim atomic commit admission or request a ruleset change.

Dispatch trusted worker code from an immutable, versioned tag created from a
reviewed `omp2` commit during rollout, for example `ci-macos-worker-v1`.
Verify its resolved commit on each dispatch. The worker independently compares
`github.workflow_sha` to the request's allowed workflow commit before source
checkout. A changed/deleted tag blocks execution rather than selecting a newer
workflow. The tag and allowlisted SHA are release configuration, not PR inputs.
Bootstrap the worker on default branch `omp2` before exercising dispatch.
Do not assume arbitrary raw SHA is a supported dispatch `ref`.

Use two checkouts: reviewed worker/control files from the workflow revision,
then tested source from the exact commit into a separate directory. Local
composite actions resolve from the control checkout, while compilation/tests
run in the source checkout. Never check out a moving branch after admission.
Controller code also comes from the pinned reviewed control revision, not the
candidate source. Disable checkout credential persistence in both checkouts;
never execute candidate code in the Ubuntu controller. The outer PR workflow
can still be modified by repository writers, which is part of the explicit
runner-admission/trust blocker below, not solved by pinning a helper script.
Any source-path input added to existing provisioning/state actions must preserve
current callers' defaults. Test setup, artifact names and shell arguments come
from validated enums/paths, not raw request strings.

## Dispatch, timing and ownership state machine

| State | Allowed transition | Refusal / failure behavior |
| --- | --- | --- |
| NEW | Validate event, trust, identities and worker revision; dispatch hosted candidate | Missing permission/configuration -> failure, not fallback to Mac |
| DISPATCH_PENDING | Correlate returned run ID or discover the exact nonce in the worker's run name | Ambiguous response: discover before retry; multiple matches -> quarantine/fail |
| HOSTED_QUEUED | Observe current candidate attempt and job every15s | No verified queue timing -> keep hosted; never inherit an earlier run attempt's age |
| HOSTED_OWNED | Any observed assignment/in-progress/native start commits to hosted | Native failure/timeout -> report failure; do not try another machine to obtain PASS |
| CANCEL_PENDING | After300s queued, revalidate request and assignment, then cancel only this run |202 acceptance is not settlement; wait up to10min for terminal state |
| HOSTED_DONE | Hosted completed successfully while cancellation raced | Validate that result; never launch fallback merely to replace it |
| FALLBACK_QUEUED | Only after terminal cancelled, dispatch one Mac candidate generation | Unexpected terminal failure, unsettled cancellation or conflicting owner -> fail/escalate |
| FALLBACK_OWNED | Assigned native Mac worker runs original objective | Failure stays failure; no loop back to hosted or repeated repair attempts |
| RESULT | Validate selected candidate and original request; report via parent job | Missing/stale/malformed/partial evidence -> failure |

The queue threshold is conservative: persist the first observed queued time for
the current candidate attempt, plus a monotonic local timer. An earlier API
timestamp can aid diagnosis but cannot advance fallback eligibility. Controller
restart is a new attempt, not continuation from undocumented local state.
Before a new controller dispatches, list worker generations for the same parent
run/objective across attempts. Reconcile every nonterminal older generation:
cancel its isolated run, await terminal cancellation and worker admission expiry,
then admit a replacement. Pagination is mandatory; an incomplete history scan
fails closed. A rerun does not authorize overlapping old native work. Completed
old results remain diagnostic and cannot satisfy the new attempt.

Assignment and cancellation are not atomic. Before cancel, re-read job status
and runner assignment. If assignment is observed, hosted wins. If assignment
races after that read and the run is terminally cancelled, fallback may take
ownership only after cancellation settlement. Literal precedence for every
unobservable assignment cannot be guaranteed by REST. This is the observable
precedence formulation disclosed in the approved plan, not an exactly-once
execution guarantee. Never accept two candidates' successful results.

Poll with bounded jitter/backoff on429/5xx, honoring retry headers. Authentication
and authorization failures are terminal. A dispatch timeout or uncertain response
must first list candidate runs and correlate workflow ID, nonce, event, workflow
revision, creation window and parent generation; never blindly redispatch.
Pin API version `2026-03-10` and contract-test its documented dispatch response.
Accept a200 response only
with a verified run ID; handle legacy204 through correlation. Do not assume
dispatch always returns204 or invent an undocumented run-ID field.

Hosted queue ownership window:300s. Cancellation settlement budget:10min.
Self-hosted queue budget:150min to allow serialization behind the other native
objective. Native execution retains existing120min Rust and45min lint limits.
Controller timeout:330min, with cleanup reserved before exit. These are initial
conservative limits, not measured latency targets. Two controller jobs may hold
Ubuntu slots for hours; assess actual concurrency in the canary.

Parent cancellation/supersession stops acceptance immediately. Controllers
attempt bounded cancellation of only their recorded candidates in cleanup.
Because abrupt parent termination can bypass cleanup, workers must check parent
liveness/current generation before starting and at bounded intervals while native
work runs, terminating their own child process group when admission expires.
They must not retain an Actions-write token to do this: read-only API inspection
and the worker's own process supervision suffice. A disconnected worker cannot
prove liveness indefinitely; expiry stops it. Admission is renewed only by a
successful GitHub read showing the same parent attempt and owning controller
job both in progress, plus current request identity. Poll every15s; expire
after90s without that valid observation. A terminal parent, new attempt or
superseded source revokes immediately. Verify initial admission positively
before native work; API failure cannot create it. On revocation, send TERM to
the owned native process group, wait10s, then KILL and allow5s for confirmation.
Missing settlement fails the worker and blocks replacement/result acceptance;
never issue a broad host kill. This guard is not an OS sandbox or a proof
against escaping process groups. Real canaries must test descendant cleanup
and the runner's own cancellation cleanup; an unresolved escape blocks rollout.
The supervision code needs fake-clock and real macOS tests before enablement.

## Results and gate enforcement

The selected worker must finish the expected native job successfully and upload
one schema-versioned result artifact containing the request digest, parent and
candidate run/attempt IDs, objective, workflow revision, pool/runner architecture,
tested commit/tree, coverage mode and command completion inventory. Record tool
versions and terminal native result. Artifact identity alone is not sufficient:
the controller verifies the actual run/job/step conclusions and expected artifact
origin through the API. Exclude skipped, cancelled and partial native commands.

Artifact download is bounded; reject path traversal, duplicate JSON keys,
unknown schema, excessive size and inconsistent identity. Never execute artifact
content or evaluate its strings as shell. Keep failure output visible and upload
diagnostic artifacts on failure without giving them success authority.

The parent named job returns success only after verified selected-worker success.
Only a complete Rust objective relays the existing `proved-tree` notice, using
the validated tree digest, preserving GitHub Actions producer and existing
`push_verified` lookup. Affected Rust cannot emit full proof. Native lint keeps
its own required check. Existing push reuse's lint skip remains historical policy,
not new lint evidence. Do not change ruleset names or check producer.

## Permissions, runner admission and Mac slot

Controller job permissions: contents/read, actions/write and pull-requests/read
where PR identity is inspected. Actions/write necessarily permits run-wide
operations; the code must enforce exact candidate allowlists. The worker uses
contents/read and actions/read; no App key, broad PAT, checks/write or inherited
BuildBuddy secret. Audit pinned actions' actual runtime/cache credentials during
preflight rather than assuming every build environment is credential-free.

Fork gates never dispatch and their tokens remain GitHub's read-only fork tokens.
For same-repository events, runner labels are not admission security: another
writer can change workflows to target the registered Mac directly. The runner
must be restricted to the reviewed worker by an enforceable account feature, or
the owner must explicitly accept the broader repository-writer trust boundary.
Personal-repository runner controls are not assumed equivalent to enterprise
runner groups. Until that fact is established, automatic fallback stays disabled.

Use exactly one dedicated build runner service/account and workspace for the Mac
slot, separate from the developer checkout and any controller account. If other
Mac services/workflows share the physical host, all heavy builds need the same
machine-wide admission lock, or the preflight fails. Do not use a shared GitHub
concurrency group as a FIFO: GitHub can replace pending jobs even with
cancel-in-progress false. One inventoried runner service provides the primary
queue; a local physical-host lock is defense against accidentally overlapping
worker instances. If other workloads do not honor that admission boundary,
activation remains blocked rather than changing BuildBuddy to accommodate it.
Do not install extra runner services to increase throughput on a16GB Mac.

Reuse native tools/build-state actions. Pin/verify LLVM22 linker, arm64, Rust
toolchain, nextest, just, uv, zstd, ninja, Python bundle, free disk and working
Seatbelt. Clear self-hosted `RUSTC_WRAPPER` consistently for both objectives.
Persistent cache root must be dedicated to this runner identity, with cleanup
limited to its own state. No symlink/cleanup may touch the developer checkout.

## Implementation boundaries and rollout

Create `.github/workflows/macos-verification.yml`,
`.github/actions/macos-native-objective/action.yml`,
`scripts/macos-fallback-controller.py`, `scripts/test_macos_fallback_controller.py`,
`scripts/macos-worker-guard.py` and `scripts/test_macos_worker_guard.py`.
Modify only native jobs in `ci.yml`, existing native tools/build-state actions
where source-path support is needed, hosted/path policy tests and CI path lists,
and the runner policy documentation named by S1/S4. No launchd service, App,
ruleset, BuildBuddy file or Linux execution body is part of this selected design.

S1 bootstraps the versioned worker and shared native objective in hosted-only
mode with a complete same-name parent gate; fork direct-hosted execution uses
the same reviewed objective composite. S2 adds fake-API controller/guard tests.
S3 enables fallback only for a trusted canary after preflight; S4 broadens that
eligibility only after real hosted/Mac proofs. A protected release setting turns
fallback off without changing hosted-first execution. It must not be mutable by
an arbitrary dispatch input. Draining/canceling admitted candidates precedes
removing a worker release/tag.

Required tests include every state transition, exact300s boundary, rerun-age
reset, lost dispatch response, duplicate candidates, assigned-during-cancel,
late hosted success, parent death, base/head change, stale result, bad artifact,
fork dispatch refusal, direct runner-label bypass, no-Mac hosted completion,
one physical Mac slot, GitHub Actions producer/proved-tree reuse, full/affected
coverage and unchanged Linux/BuildBuddy jobs. Real macOS process-tree termination,
Seatbelt and source/cache isolation cannot be certified by Linux mocks.

## S0 readiness

The architecture and protocol above are concrete proposals, not deployed APIs.
[Preflight](preflight.md) records access blockers. In particular, worker access
restriction, actual Mac tool/process behavior and live dispatch/cancel/result
contracts remain unproven. Do not classify this as implementation-ready until
those prerequisites and independent design review are resolved. No credential
installation or broad Mac trust acceptance is inferred from approval of S0.
