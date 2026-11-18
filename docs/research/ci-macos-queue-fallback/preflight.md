# S0 read-only preflight

Date:2026-11-16. Source `a4b1325ef85a6c6a309015319026b0c673b0ef59`.
Status at the original inspection: repository inspection complete; direct live
Mac inventory unavailable. See the 2026-11-17 reassessment below for recovered
operational evidence and the existing trust policy.

| Check / raw read-only command | Observed result | Consequence |
| --- | --- | --- |
| `gh api repos/blyzer/oh-my-pi --jq '{default_branch,owner_type:.owner.type}'` | default branch `omp2`, personal owner type `User` | Do not assume enterprise runner-group features |
| `gh api repos/blyzer/oh-my-pi/actions/runners` | HTTP403 `Resource not accessible by integration` | Cannot establish registrations, labels, availability or busy state |
| `gh api repos/blyzer/oh-my-pi/actions/variables` | HTTP403 `Resource not accessible by integration` | Cannot establish actual runner/rollout variable values |
| Native tools/build-state and inline macOS job source | Existing hosted/self-hosted provisioning branches and cache handling present | Reusable seams; source presence is not real Mac proof |

The execution environment is Linux and no direct connection to the owner's Mac
has been established. No guessed SSH target, network scan, credential extraction,
remote command, runner dispatch, cancellation, installation or settings mutation
was attempted. No Mac capacity, memory, running services or installed tools are
claimed verified. No worker or controller implementation exists yet.

## Original operator-evidence checklist (2026-11-16)

The following checklist and blockers record the original inspection, before
historical job evidence and the owner's current-readiness confirmation were
incorporated. They are superseded by the reassessment below.

Obtain runner inventory through an authorized read-only connection or operator
export without secrets. Confirm actual runner count/service accounts/labels,
dedicated workspace and cache roots, and every other job using this physical Mac.
Determine whether this personal repository can restrict that runner to the
reviewed workflow; otherwise record explicit owner acceptance of the broader
repository-writer trust boundary before enabling it. Plan/design approval is not
that acceptance.

On the Mac, verify `uname -m`, pinned rustup/toolchain, `cargo nextest --version`,
`just --version`, `uv --version`, `zstd --version`, `ninja --version`, LLVM22 linker
version, free disk and existing native Seatbelt acceptance proofs. Inspect service
workspace/cache paths and permissions without printing environment or credentials.
Confirm developer files and build caches cannot collide with cleanup. Do not run
heavy tests concurrently with another build just to complete this checklist.

Once the worker is reviewed and deployed in hosted-only mode, record actual API
version, dispatch response/run ID correlation, queue timestamps per attempt,
terminal cancellation semantics, artifact origins, parent check producer and
proved-tree annotation. Then perform hosted-with-Mac-offline and opt-in Mac
cancellation/serialization canaries. These are later implementation acceptance
checks, not preflight results fabricated in a design PR.

## Activation blockers

1. Runner/variable inventory permission or operator evidence missing.
2. Direct Mac access/tool/cache/Seatbelt proof missing.
3. Enforceable workflow-level runner access or explicit broader trust acceptance
   missing; never substitute a runner label for this condition.
4. Live worker/API/cancellation canaries necessarily wait for reviewed code.

No ruleset change, private App key or permanently running Mac dispatcher is
required by the selected proposal. #658 stays open/unmerged by this work.

## 2026-11-17 reassessment: established Mac operation

The owner confirms the Mac is currently ready and directs reuse of the existing
repository-writer trust policy. This is operational authorization, not a new
request for trust acceptance. The historical
[runner policy](../ci-macos-runner-fallback.md#fork-pull-requests) explicitly
states that anyone who can push a branch here, including Apps and agent tokens,
is trusted with the Mac and key because a branch can change `ci.yml`. Labels
select runners; they do not enforce workflow isolation.

Read-only GitHub Actions job API evidence recovered on this date:

| Run / job | Observed operational evidence |
| --- | --- |
| [43383344878 / 131755633290](https://github.com/blyzer/oh-my-pi/actions/runs/43383344878/job/131755633290) | `Rust workspace and acceptance proofs`, `success`; runner `Envers-MacBook-Pro`; requested labels `["self-hosted","macOS","ARM64"]`; 2026-11-13 07:31:27–07:47:50 UTC |
| [43189416262 / 131084739510](https://github.com/blyzer/oh-my-pi/actions/runs/43189416262/job/131084739510) | Same job, runner and requested labels; `success`; 2026-11-12 10:17:29–10:43:00 UTC |

The first run/job records head SHA
`6b415f26a6aa51d1b12cbf20bda9a9697ff51d49`. Its
[commit-pinned workflow](https://github.com/blyzer/oh-my-pi/blob/6b415f26a6aa51d1b12cbf20bda9a9697ff51d49/.github/workflows/ci.yml)
and job step results show successful Apple Silicon assertion (`uname -m =
arm64`), pinned-toolchain selection, provisioned native-tool check, nextest
version-floor check, build-state preparation, workspace tests, doctests, Python
examples, P1–P6, P7, P12 and P8 contract validation. These are actual successful
self-hosted native jobs, not merely workflow source or overall run success.
The suggested runs `43557279716`, `43395532515` and `43237671310` instead have
skipped Rust jobs with null runner names; they demonstrate configured routing,
not execution on the Mac.

At that pinned source, `rust-toolchain.toml` selects `nightly-2026-08-08` and
`.config/nextest.toml` requires nextest >= `0.9.143` (its comment records
`0.9.143` on the Mac). The successful check proves the floor, not the exact
installed version. `macos-native-tools` checks executable
`/opt/homebrew/bin/ld64.lld` plus `uv`, `zstd` and `ninja`; it does not record
their exact versions. The build-state action checks the embedded Python
configuration and invokes the LLVM linker version command. Exact linker/tool
version output could not be recovered: the job-log download returned HTTP403.
No exact installed-version or `just --version` claim is inferred from that.

The pinned build-state action locates persistent state under
`$HOME/Library/Caches/omp-ci/$RUNNER_NAME`, with Python keyed by its inputs and
target state keyed by toolchain plus lockfile, outside checkout cleanup. This
is demonstrated historical state preparation; it does not inventory the current
service account, absolute home/workspace paths, free disk or all other services.

Current runner/variable inventory remains HTTP403 `Resource not accessible by
integration`. That limits fresh inventory visibility; it does not erase the
successful Mac jobs or require resetting the owner's working installation.
Reuse the observed label array and established policy when configuring the
reviewed worker. No external settings, tags, variables, dispatches or Mac services
were changed during this read-only reassessment.

Remaining acceptance work concerns the **new** protocol: hosted-only dispatch
and result provenance, hosted success with the Mac offline, actual fallback
after the queue threshold, lease expiry/cancellation/process-tree cleanup,
restart/supersession and physical-host serialization. Its separate
`omp-macos-worker` state namespace and cleanup ownership must be verified on
the existing Mac, including coordination with other heavy workloads. Historical
Seatbelt/P12 success supports the existing setup; it does not prove the new
worker lease or cleanup protocol. These canaries remain pending reviewed
deployment, not blocked on obtaining a new blanket trust acceptance.
