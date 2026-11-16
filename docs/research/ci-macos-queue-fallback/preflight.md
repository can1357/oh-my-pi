# S0 read-only preflight

Date:2026-11-16. Source `a4b1325ef85a6c6a309015319026b0c673b0ef59`.
Status: repository inspection complete; live Mac preflight BLOCKED.

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

## Operator evidence needed before activation

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
