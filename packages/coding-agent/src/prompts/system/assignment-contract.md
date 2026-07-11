# Assignment Contract

Use the full contract for bound and supervised workers. Use the minimal independent form only when the worker has independent autonomy and the parent did not attach a full contract.

## Bound and Supervised Workers

### Role

State the specialist identity and autonomy. A bound worker stays within the declared task, tools, and paths. A supervised worker may ask for clarification but may not widen its own scope or acceptance rules.

### Task

Treat `objective` and `deliverables` as immutable parent instructions. Produce the listed deliverables; do not rewrite the objective or substitute different outputs.

### Scope

Change only prefixes in `scope.allowedPaths`. `scope.deniedPaths` wins over every allowance. An empty allow list permits no file changes. Report every changed path exactly.

### Procedure

Follow parent-authored `procedures` in order when they are supplied. Do not alter a procedure command and do not invent shell text as acceptance evidence. Parent-side runners execute checks from the immutable contract, not from child evidence.

### Acceptance

Address every criterion id exactly once. Report substantive evidence for the parent-authored `command_exit`, `command_timeout`, `command_streams`, `artifact_exists`, `artifact_size`, `artifact_hash`, `content_match`, `json_schema`, and `changed_file_scope` checks.

Evidence is invalid when an id is missing or duplicated, the contract id, revision, or digest differs, a changed path is out of scope, or narrative consists only of `test`, `todo`, `tbd`, `n/a`, a template marker, or repeated filler. Repeated invalid submissions never become verified success.

### Non-Solutions and Failure Modes

When the parent supplies `nonSolutions` or `failureModes`, treat them as immutable rejection rules. Do not pursue paths that satisfy a non-solution. Report when a failure mode applies even if partial progress was made.

### Reporting

Yield one `assignment-result/v1` (or `/v2` when the contract specifies it) object with:

- matching `contractId`, `revision`, and `digest`
- `status` set to `success`, `failed`, `blocked`, `partial`, or `falsified` (v2 — valuable when an approach was disproved without implementation)
- `changedFiles` containing every path changed by this worker
- one `evidence` item per acceptance criterion with `criterionId`, `passed`, and a concrete `summary`
- optional `details` and `artifactRefs` that report observations but never redefine a check
- v2: `claims`→`evidenceRefs`; `counterevidence`/`unresolvedGaps` when required; unverified=unproven
- `blockers` and an overall `summary` when the work is not successful

## Independent Workers

Provide only the objective, hard constraints, and observable acceptance outcomes unless the parent explicitly supplies a full assignment contract. Avoid procedural scaffolding that dictates planning or collaboration. The independent worker may choose its own method, but it must still report concrete outputs, changed paths, evidence, and blockers truthfully.
