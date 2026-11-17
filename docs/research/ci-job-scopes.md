# Dependency-scoped workflow execution

Status: implementation under review. Base `omp2@0ce64b0ba1a2da38dc2334e77a9594c747b9adc9`.
Owner scope: reduce unnecessary jobs across the repository, not only `scripts/`.
Keep GitHub-hosted macOS first and the existing self-hosted Mac as fallback.

## Selection boundary

The required CI workflow starts a cheap selector on PRs and pushes. Each expensive
job then checks its own dependency scope instead of sharing one global Rust flag.
Required jobs remain declared and report skipped when irrelevant; a workflow-level
PR path filter must not leave required contexts permanently pending.

`.github/ci-job-paths.json` is the reviewed dependency map, and `scripts/ci_scope.py`
applies it. Both belong to the global validation scope: editing the selector or
its rules requires conservative validation of the selection mechanism itself.
Unknown paths and incomplete change discovery cannot silently disable checks.
The old flat path lists are historical compatibility records, not the new
per-job decision authority.

| Input domain | Intended checks |
| --- | --- |
| Known Python CI/controller code and its tests | Fast policy/unit tests; Python security analysis on CodeQL pushes; no unrelated Rust compilation |
| Native macOS workflow/action/command changes | macOS checks and policy validation; not unrelated Linux proof or BuildBuddy execution |
| Rust sources and shared build/test inputs | Relevant native verification, formatting/lint/contracts; conservative cross-platform coverage |
| Protobuf definitions/configuration | Protobuf checks plus compiled consumers where the source/build map requires them |
| Cargo dependency/license inputs | License checks and affected compiled verification |
| Extension/Python API inputs | Extension conformance and native/API consumers where required |
| Documentation/instruction text outside compiled inputs | Lightweight repository policy checks; no Rust formatting or compilation solely for text |
| Unknown input or unavailable trustworthy diff | Full current-workflow checks |

These are declared dependencies, not sound whole-program impact analysis.
Shared workspace changes can require both platform checks even when one filename
looks platform-specific. A newly introduced helper must be added to the map with
its consumers or remain conservatively classified.

## Events and source identity

PR selection uses the complete cumulative PR file list, including old names for
renames. It does not inspect only the last commit and assume earlier changes were
already verified. A docs-only follow-up commit on a code-changing PR can therefore
still require the code's checks; reusing previous evidence safely is a different
cache/provenance problem, not an unproven skip optimization.

Ordinary push selection compares the event's exact `before` and `after` trees,
including removed/renamed paths. It must not use the PR head in place of a tested
merge commit. A missing/zero `before`, forced push, failed fetch/diff, truncated PR
listing or unrecognized event selects full checks. No full history checkout is
required merely to read the two immutable endpoint trees.

Manual, scheduled and merge-queue runs retain full coverage for their workflow.
A failed selector leaves downstream conditions conservative (`!= 'false'`),
including failure/skipped dependency handling through explicit status functions.
The selected format/policy gate precedes jobs that already depended on it, but
Rust toolchain setup and `cargo fmt` are skipped when no Rust-format input changed.

## Other workflows

CodeQL keeps its weekly/manual complete scans. Pushes select the relevant analysis
languages, so Python orchestration changes do not automatically start Rust
extraction. Its Rust extraction scope still excludes test/benchmark-only inputs
where the dependency rules establish that production extraction is unaffected.

P8 keeps complete scheduled/manual recordings. Pushes choose macOS and BuildBuddy
Linux independently through the selector, without a preceding workflow path filter.
Embedded prompts and fixtures under compiled-input directories retain both
platforms even when their extension is Markdown. This changes only whether an irrelevant recording starts;
BuildBuddy's launcher, credential handling, commands, runner and caches remain
unchanged. Metadata/label workflows stay lightweight and event-driven; manual
packaging stays manual. The semantic-index experiment already has narrow paths.

## macOS runner order remains unchanged

Selection decides **what** is needed. It does not reverse **where** work runs:
GitHub-hosted macOS remains first, then the self-hosted Mac when the reviewed
fallback admission conditions permit it. The historical Mac/trust evidence is
recorded in the updated [preflight](ci-macos-queue-fallback/preflight.md).

Worker/control/provisioning changes also retain hosted-first fallback. The
versioned worker supplies admission and transport; the admitted source supplies
the native composite action, provisioning actions, state preparation and commands.
The source and tree are checked before execution and publication. See the
[source-bound fallback update](ci-macos-queue-fallback/source-bound.md) for the
owner-only trust boundary and the distinction between candidate commands and the
pinned protocol guard. This does not make the Mac primary or change BuildBuddy.

Only a fully executed, successful native Rust objective may publish `proved-tree`.
Skipping unrelated jobs is not evidence that those checks ran. Existing proof
reuse and non-strict branch-policy limits remain explicit; this change adds no
atomic merge-freshness or cross-revision cache claim.

## Validation scope

Test representative changes across scripts, crates, protocols, manifests, actions,
workflows, extensions and docs; mixed changes must select the union of consumers.
Include renames/deletions, force/new-branch pushes, diff/API failures, unknown
paths, malformed configuration, manual/scheduled/merge-group events and policy
mutations that would remove required contexts or fail-closed gates.

Record actual commands/results with the implementation PR. Offline selection
tests and workflow lint establish routing behavior, not measured cost savings,
real Mac cancellation or GitHub queue latency. No runner registration, repository
variable or BuildBuddy execution setting is changed by this work.

Local validation: 130 Python unit/policy tests passed; `check-ci-paths.py` passed
for 13 job scopes and 11 required checks. Actionlint 1.7.12 passed for CI, CodeQL
and P8 workflows. Independent review caught and corrected P8 workflow filtering
and embedded-prompt exclusions before publication.
