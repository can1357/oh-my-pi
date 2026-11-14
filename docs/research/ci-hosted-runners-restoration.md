# Standard GitHub-hosted runner restoration

Date: 2026-11-14. Inspected base: `omp2`
`374eb3a2b0e2149bc4890be40a3b9d5bae621aa5`.
Owner instruction: use GitHub-hosted runners for native jobs; preserve BuildBuddy.

## What the evidence shows

Repository metadata confirms `blyzer/oh-my-pi` is a public fork. GitHub's
[billing documentation](https://docs.github.com/en/actions/concepts/billing-and-usage)
says standard GitHub-hosted compute in public repositories is free; the private-
repository monthly minute allowance does not establish exhaustion here.
[Larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners)
are billed even for public repositories. This change uses standard labels,
not paid larger runners. Concurrency, service capacity, storage and account policy
remain separate limits; no billing bypass is attempted.

Observed runs:

| Evidence | Observation |
|---|---|
| [CI 43557279716](https://github.com/blyzer/oh-my-pi/actions/runs/43557279716) | Hosted Ubuntu jobs succeeded; the Rust acceptance job's configured labels were self-hosted/macOS/ARM64 |
| [CI 43572667550](https://github.com/blyzer/oh-my-pi/actions/runs/43572667550) | Recent GitHub-hosted Ubuntu CI completed successfully |
| [S1 CI 43573448078](https://github.com/blyzer/oh-my-pi/actions/runs/43573448078) | Hosted Ubuntu jobs executed and macOS lint used hosted macos-15; Rust workspace/proofs queued with self-hosted/macOS/ARM64 and no assigned runner |
| [CodeQL 43571586009](https://github.com/blyzer/oh-my-pi/actions/runs/43571586009) | Hosted Ubuntu jobs succeeded while Rust analysis was still running at inspection |

Earlier inspected failures included build/test or lint exit 101, BuildBuddy
verification failure and a recorder build failure. Hosted macOS annotations
included service-capacity queue notices. Neither these observations nor a queued
self-hosted job establish public hosted-minute exhaustion. A self-hosted queue
waits for a matching registered machine, not GitHub's hosted pool.

The repository variables API returned HTTP 403 for this integration, despite
successful repository reads and workflow writes. Actual variable values and
account billing are therefore unverified. Effective job labels prove routing;
they are not a billing report. Workflow routing is changed directly, without
editing repository variables or affecting BuildBuddy's mode selection.

## Routing changes

Six native dynamic CI jobs (`changes`, `format`, `protobuf`,
`extensions_conformance`, `licenses`, `push_verified`) now use literal
`ubuntu-24.04`. `rust` and manual macOS `package` now use literal `macos-15`.
Other native CI, CodeQL, semantic evaluation, labels and baseline recording
already use standard hosted labels and remain there. GitHub's
[runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
lists `macos-15` as standard arm64, matching the existing macOS provisioning.

Preserved byte-for-byte from the inspected base:

- CI job blocks `lintx_ratchet`, `runtime_spec`, `remote_linux`, `remote_seed`,
  including variable-based launcher routing, remote commands, keys and fork checks.
- The complete P8 workflow, including `buildbuddy_linux`.
- Both BuildBuddy composite actions. Optional BuildBuddy cache steps and
  credentials in macOS packaging are retained; only its native host label changes.

Deleting `CI_LINUX_MODE` globally was rejected: it would also change two existing
BuildBuddy-capable fallback jobs, contrary to the owner instruction. No new
secrets, permission grants or self-hosted fork exposure are introduced.

## Validation and fresh runs

Local standard-library checks passed: CI path/required-check/fork validation;
16 existing CI-gate tests; 13 affected-crate tests; 6 new hosted-routing tests;
editing-discipline and whitespace checks. New routing tests run in the existing
format job and include mutations returning native jobs to variable-selected
personal runners. BuildBuddy job/action identity was checked against the base.
Verified `actionlint 1.7.12` also passed for both changed workflows; its optional
shellcheck/pyflakes integrations were disabled, so this is workflow validation,
not a claim of full shell or Python lint coverage.

One existing research comment spelled a prohibited heredoc recipe even though
the micro-experiment changes only in-memory values. This caused the S1 format
gate to fail. Its comment now simply says to execute the Python snippet; the
checker is not weakened and experiment logic/results are unchanged.

A new workflow dispatch or new push is required to exercise these labels.
Rerunning an older workflow run reuses its original definition and cannot reroute
that run's self-hosted job. Long builds remain pending until they actually settle;
runner allocation is not a test pass. Actual dispatch IDs and observed states
are recorded in the delivery report. Manual packaging uploads artifacts but
publishes no release, as specified by its unchanged workflow contract.
