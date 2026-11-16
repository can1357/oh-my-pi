# EGM evaluation record

Status: one fresh-context review round completed; findings incorporated into the
approval plan. No second round, convergence or implementation readiness claimed.

Uses repository-vendored EGM personas and standards pinned in
[EGM-PROVENANCE.md](../../../.claude/skills/EGM-PROVENANCE.md). Elephant synthesis
uses source audits. Reviewers receive the plan, standards and explicit reading
list with `fork_turns: none`; no parent conversation is supplied.

Host limitation: subagent tools expose no reviewer tool allowlist. Read-only
instructions are a prompt constraint, not enforced tool sandboxing. Project/user
instruction exclusion and memory isolation beyond fresh conversation turns are
unverified. This is an EGM-based evaluation, not a certified plugin execution.

The owner requested approval before design and implementation. This is a
concept/plan review, deliberately not the zero-decision implementation-readiness
gate. One review round is planned before the approval pause; EGM review-loop
convergence requires two consecutive clean rounds and is not claimed here.

## Configuration and execution

Target before review: `README.md` lines 1–193 and `sources.md` full file.
After resolution the target expanded; the final document was not independently
re-reviewed in this round. All three reviewers completed and reported their
mandatory reads. No failed or missing review was treated as a clean result.

| Reviewer | Persona / standard | Explicit source context | Outcome |
| --- | --- | --- | --- |
| `mac_egm_design` | `design_critic.md` / feature-spec standard | CI workflow, ruleset, vendoring provenance | Completed; 3 Major findings |
| `mac_egm_codebase` | `codebase_details.md` / feature-spec standard | CI workflow, native tools/build-state actions, hosted policy and path tests, ruleset, restoration and branch-protection docs | Completed; 2 Major and 1 Nit |
| `mac_egm_zoom` | `zoom_out.md` / zoom-out standard | CI workflow, hosted policy, native build state, current and historical runner research; repository reuse searches | Completed; 1 Major duplicating outage finding, 1 Nit |

Fresh context was requested through the actual native `fork_turns: none`
parameter. Reviewers reported reading persona, standard, target and supplied
context; the design reviewer explicitly recovered from an initially truncated
CI read by re-reading relevant sections. No reviewer reported writes, tests or
external mutations. This is evidence of reported compliance, not OS enforcement
or a verified instruction-exclusion probe.

Separate read-only source workers inspected current native CI and external
GitHub implementations. They were research workers, not additional Goldfish
reviews or independent clean rounds. Source pins are in `sources.md`.

## Findings and Elephant resolutions

IDs stay stable even where final document lines moved. All findings were
accepted as plan refinements; no code repair or runtime fix was performed.

| ID | Severity / scope | Finding | Resolution and remaining obligation |
| --- | --- | --- | --- |
| design-1-1 | Major / Mac admission | Another workflow can target runner labels directly and bypass controller decisions | Added enforceable runner-access boundary and direct-dispatch bypass canary to S0/S3. If platform controls cannot enforce it, explicit owner acceptance of broader writer trust is required before enabling the Mac; this plan is not that acceptance |
| design-1-2 | Major / base freshness | Current non-strict ruleset cannot revoke a successful check atomically when the PR base later changes | Limited unconditional requirement to stale-publication rejection. Stronger post-publication merge freshness is an explicit S0 decision requiring an approved mechanism and canary; not silently asserted or enabled |
| design-1-3 | Major / outage | A Mac-only final publisher could block ordinary hosted success when the Mac is offline | Added hard requirement that hosted dispatch/execution/final publication work independently of Mac/controller; reject sole-Mac publisher and require outage canary |
| codebase-1-1 | Major / file boundaries | Proposed and existing files lacked explicit operation labels | Added Create/Modify declarations, no deletions, concrete existing paths and S0 final allowlist obligation; exact final gate files depend on approved design |
| codebase-1-2 | Major / proof reuse | Existing reuse consumer filters `github-actions` producer and reads `proved-tree` annotations | Added preservation/migration requirement and S1 actual producer/annotation tests; same-name App checks alone are insufficient |
| codebase-1-3 | Nit / tests | Existing `test_check_ci_paths.py` infrastructure assumed inline workflow scripts and annotations | Added that test file and its fixture/mutation/extraction seams to S1; do not replace with duplicate unconnected tests |
| zoom-1-1 | Major / outage | Duplicate of design-1-3 | Deduplicated; same hosted-without-Mac acceptance requirement |
| zoom-1-2 | Nit / complexity | Local daemon preferred before comparing concurrency and maintenance cost | Made preference conditional on S0 comparison; clarified no assumption that standard public hosted compute is billed/exhausted |

These edits address plan wording and design obligations. They do not establish
that runner admission, cancellation settlement or gate migration is implemented
or proven. No finding was marked runtime-fixed or counted as independently
validated by the final edited plan. The round was not clean before resolution;
therefore no convergence or clean-round credit is claimed.

## Approval handoff

Wait for owner approval of the evaluation/plan before detailed design. The
design must resolve the explicit S0 choices and then undergo implementation
readiness review, including supported credentials and live Mac preflight.
Nothing in this record authorizes silently accepting broader Mac trust or
modifying required-check policy.

## Research validation

Checked five relative Markdown links and eight pinned OMP2 source file/range
targets against the inspected worktree; all resolve and ranges are in bounds.
Markdown fences are balanced and `git diff --cached --check` passed. The staged
diff contains only the three files in this research directory. The Mermaid
source was inspected but not rendered. No production test, fake controller test,
live runner dispatch/cancellation or Mac installation was run for this docs-only
change. Those checks belong to the proposed later slices.
