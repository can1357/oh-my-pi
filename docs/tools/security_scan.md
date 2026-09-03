# security_scan

> Plan and run OMP-native security reviews, validate stored findings, and explicitly interact with Codex Security cloud scans.

## Availability and prerequisites

- `security.enabled` defaults to `false`. When disabled, `security_scan` is omitted from the available tool set and `security://` reads fail with an enablement message. Enable it in **Settings → Tools → Security** or set `security.enabled = true`.
- The tool is discoverable, strict-schema, and classified as `exec`.
- Native `preflight` requires a Git repository, an active model, the session model and authentication registries, and a stored OAuth credential for the active model's provider. API-key-only authentication is not accepted.
- If several OAuth accounts exist and none is active, pass `credential_id`; a lone account is selected automatically. The immutable plan pins the credential row and recorded account/workspace identity. Execution and token refresh stay on that row rather than rotating to another account.
- Cloud actions require an `openai-codex` ChatGPT OAuth credential. They call ChatGPT's Codex Security cloud control plane, not the public OpenAI API, and are never a fallback from a native scan.

## Source

- Public tool and schema: `packages/coding-agent/src/tools/security-scan.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/security-scan.md`
- Native planning and freshness: `packages/coding-agent/src/security/preflight.ts`
- Background execution: `packages/coding-agent/src/security/coordinator.ts`
- Scan-only publication tool: `packages/coding-agent/src/security/publication.ts`
- Canonical store and output files: `packages/coding-agent/src/security/store.ts`
- Cloud client/import: `packages/coding-agent/src/security/cloud.ts`
- Read-only resources: `packages/coding-agent/src/internal-urls/security-protocol.ts`

## Inputs

| Field | Type | Used by | Description |
| --- | --- | --- | --- |
| `action` | `"preflight" \| "start" \| "status" \| "cancel" \| "validate" \| "cloud_scans" \| "cloud_start" \| "cloud_status" \| "cloud_pull"` | All | Required dispatch selector. |
| `plan_id` | `string` | `start` | Plan ID returned by `preflight`. |
| `operation_id` | `string` | `status`, `cancel` | Operation ID returned by `start`. |
| `target_kind` | `"repository" \| "scoped_path" \| "ref_diff" \| "working_tree"` | `preflight` | Defaults to `repository`. |
| `include_paths` | `string[]` | `preflight` | Repository-relative paths included in the immutable scope. At least one nonblank value is required for `scoped_path`. |
| `exclude_paths` | `string[]` | `preflight` | Repository-relative paths removed from the scope. Exclusion wins over inclusion. |
| `base_revision` | `string` | `preflight` with `ref_diff` | Required with `head_revision`; resolved to a commit during preflight. |
| `head_revision` | `string` | `preflight` with `ref_diff` | Required with `base_revision`; resolved to a commit during preflight. |
| `knowledge_base_paths` | `string[]` | `preflight` | Files resolved relative to the repository root, canonicalized, and pinned by SHA-256 and size. |
| `output_root` | `string` | `preflight` | Optional external result directory. It must be outside the repository, canonical, non-symlinked, and empty unless `archive_existing=true`. |
| `archive_existing` | `boolean` | `preflight` | Defaults to `false`. Allows a nonempty output directory to be renamed to `<output_root>.archive-<scan-id>` when execution begins. |
| `credential_id` | positive integer | Native `preflight`; every cloud action | Pins one OAuth credential. Native scans select it for the active model provider; cloud actions select it for `openai-codex`. |
| `scan_id` | `string` | `validate` | Stored scan containing the finding. |
| `finding_id` | `string` | `validate` | Stored finding to update. |
| `validation_status` | `"unvalidated" \| "validated" \| "rejected" \| "partial" \| "error"` | `validate` | New validation state. |
| `validation_summary` | `string` | `validate` | Required, nonblank validation explanation. |
| `validation_evidence` | `{label: string, explanation: string}[]` | `validate` | Optional evidence appended as validation evidence; labels must be nonempty. |
| `cloud_configuration_id` | `string` | `cloud_status`, `cloud_pull` | Codex Security cloud configuration ID. |
| `repository_id` | `string` | `cloud_start` | Required cloud repository identifier. |
| `repository_url` | `string` | `cloud_start` | Required cloud repository URL. |
| `environment_id` | `string` | `cloud_start` | Required cloud environment identifier. |
| `lookback_days` | positive integer or `"all"` | `cloud_start` | Defaults to `30`; `"all"` sends an unlimited lookback. |

Unused optional fields are ignored by actions that do not read them.

## Outputs and execution model

Every action returns one text content block plus structured `details` containing `action` and the action-specific object described below. The tool itself does not stream partial arguments or progress updates. `start` returns a queued operation immediately; its separately registered OMP job reports progress, and callers use `status` for durable operation state.

## Action reference

### `preflight`

`preflight` resolves and persists an immutable plan, then returns:

```text
Security plan <plan-id> is ready. Fingerprint: <fingerprint>. Start it with action=start and plan_id=<plan-id>.
```

`details` is `{ action: "preflight", plan: { id, fingerprint } }`.

The plan pins:

- the canonical repository root and normalized include/exclude scope;
- the target snapshot;
- resolved ref-diff revisions and diff digest, when applicable;
- the active provider/model and optional thinking level;
- the exact OAuth credential and recorded account/workspace identity;
- knowledge-base file identities;
- output policy;
- the security setting snapshot and fingerprints of the coordinator prompts/workflow.

For `repository`, `scoped_path`, and `working_tree`, the target digest covers in-scope tracked and untracked file paths and contents, executable bits, symlink targets, and the current HEAD (or `unborn`). `ref_diff` instead fingerprints the resolved base/head commits and their raw tree diff. Scope paths must be repository-relative, must exist and resolve inside the repository, and are normalized, deduplicated, and sorted.

If `output_root` is omitted, preflight allocates a private unique directory under the project's OMP security state. A caller-supplied output directory is created during preflight if absent; its parent must already have a canonical identity. Nonempty directories require `archive_existing=true`.

### `start`

`start` loads the stored plan and recomputes its fingerprint from the current target, security setting, knowledge bases, output policy, and workflow. A mismatch fails with:

```text
Security scan plan is stale: expected <old>, got <new>. Run security preflight again.
```

On success it returns immediately after registering background work:

```text
Security scan <scan-id> started as <operation-id>.
```

`details.operation` contains `operationId`, `planId`, `scanId`, `phase`, timestamps, `findingCount`, and, when available, `jobId`, `sessionFile`, or `error`.

Operation phases are:

```text
queued → preparing → reviewing → publishing → completed
```

Terminal alternatives are `partial`, `cancelled`, and `failed`. The coordinator creates a restricted, auto-approved scan session with read-only repository inspection tools, read-only LSP, and only `security-reviewer` task workers. Extension discovery, MCP, and IRC are disabled. Model fallback and account rotation are disabled.

For `ref_diff`, execution creates a detached temporary worktree at the pinned head revision and supplies the pinned diff to the review session; cleanup removes that worktree. Other target kinds review the repository root directly.

### `status`

Requires `operation_id`. It returns:

```text
Security scan <scan-id>: <phase>; <count> finding(s).
```

The full operation snapshot is in `details.operation`. Terminal operations are recovered from the project store across sessions. A process restart marks persisted `running` or `planned` scans as `failed` with `Security scan was interrupted by a process restart` and cleans up a ref-diff target worktree. An unknown ID throws `Unknown security operation: <id>`.

### `cancel`

Requires `operation_id`. Running async jobs are cancelled through the job manager; otherwise the coordinator aborts its local controller and scan session. The result is either:

```text
Cancellation requested for <operation-id>.
No running operation <operation-id>.
```

`details.cancelled` reports whether a request was accepted, and `details.operation` is included when the operation exists. Already-terminal and unknown operations return `false`.

### `validate`

Requires `scan_id`, `finding_id`, `validation_status`, and a nonblank `validation_summary`. It updates the canonical stored finding and optionally appends generated validation-evidence records:

```text
Finding <finding-id> validation is now <status>.
```

`details.finding` contains the finding ID and validation status. Missing scans/findings or required fields fail rather than creating a new finding.

### `cloud_scans`

Lists every paginated configuration visible to the selected ChatGPT account. Each line contains configuration ID, current step, repository ID, environment ID, and repository URL. If none exist, the tool says so. Structured configurations are returned in `details.cloudConfigurations`.

### `cloud_start`

Requires `repository_id`, `repository_url`, and `environment_id`. It creates an enabled Codex Security cloud scan configuration and consumes the account's separate cloud scan allowance. `lookback_days` defaults to `30`.

The text identifies the configuration and repository. `details.cloudScan` contains `{ id, repositoryUrl }`.

### `cloud_status`

Requires `cloud_configuration_id`. It reports the current step and finished/pending commit counts. `details.cloudStats` also contains failed commits, per-severity finding counts, and any last scanned commit/timestamps exposed by the service.

### `cloud_pull`

Requires `cloud_configuration_id`. It fetches the configuration, status, and all attributed finding details, converts them to OMP's canonical schema, generates a report and SARIF, and persists a completed imported scan.

Import fails closed unless the current project has an `origin` remote whose normalized repository identity matches the cloud configuration URL. Cloud coverage is recorded as `unknown` because the findings API does not expose coverage receipts. `details.importedScan` contains the new scan ID and finding count.

## Native publication and persistence

`security_publish` is an internal, strict, write-tier tool available only inside the restricted native scan session; it is not a normal caller action. The coordinator requires the scan agent to call it once with:

- deduplicated findings containing rule, title, summary, severity, confidence, category, at least one in-scope location, optional evidence/remediation/CWE, and validation state;
- honest coverage completeness, reviewed surfaces, exclusions, deferred work, and open questions;
- the final Markdown report.

Publication rejects absolute, parent-traversing, or out-of-scope finding and evidence paths. Repeated findings with the same canonical fingerprint are deduplicated. A second successful publication call fails. If the scan session ends without publication, the scan is persisted as `partial`; a successful publication remains `completed` even if later metrics/output refresh fails.

Canonical state is private and project-keyed under OMP's security state root. A completed native output directory contains:

- `scan.json` — public scan manifest, written last as the commit marker;
- `findings.json`;
- `report.md`;
- `results.sarif`;
- `provenance.json` — private metadata redacted.

Directories are hardened to mode `0700` and files to `0600` on non-Windows platforms.

## Reading results

The `security://` namespace is immutable and project-scoped:

| URL | Result |
| --- | --- |
| `security://` | Namespace index. |
| `security://scans` | Stored scan list. |
| `security://scans/<scan-id>` | Scan summary and child-resource index. |
| `security://scans/<scan-id>/manifest` | Public manifest JSON, including the plan. |
| `security://scans/<scan-id>/findings` | Finding list. |
| `security://scans/<scan-id>/findings/<finding-id>` | Rendered finding, locations, evidence, and remediation. |
| `security://scans/<scan-id>/coverage` | Coverage JSON. |
| `security://scans/<scan-id>/report` | Markdown report, when present. |
| `security://scans/<scan-id>/sarif` | SARIF JSON, when present. |
| `security://scans/<scan-id>/provenance` | Redacted provenance JSON. |

Use `security_scan` actions or explicit security commands for mutations; URI reads never validate, import, cancel, or otherwise modify state.

## Examples

Plan and launch a repository scan:

```json
{"action":"preflight","target_kind":"repository","exclude_paths":["vendor","dist"]}
```

```json
{"action":"start","plan_id":"secplan_<id>"}
```

Plan an exact revision diff with an external output directory:

```json
{
  "action": "preflight",
  "target_kind": "ref_diff",
  "base_revision": "origin/main",
  "head_revision": "HEAD",
  "output_root": "/tmp/omp-security-review"
}
```

Validate a finding:

```json
{
  "action": "validate",
  "scan_id": "secscan_<id>",
  "finding_id": "secfinding_<id>",
  "validation_status": "validated",
  "validation_summary": "Reproduced with an untrusted archive entry.",
  "validation_evidence": [
    {"label":"Reproduction","explanation":"The entry writes outside the extraction root."}
  ]
}
```

Explicitly start and later import a cloud scan:

```json
{
  "action": "cloud_start",
  "repository_id": "repo_<id>",
  "repository_url": "https://github.com/owner/repo",
  "environment_id": "env_<id>",
  "lookback_days": 30,
  "credential_id": 7
}
```

```json
{"action":"cloud_pull","cloud_configuration_id":"scan_<id>","credential_id":7}
```

## Errors and constraints

- Every action first rechecks `security.enabled`; direct execution while disabled throws `Security is disabled. Enable security.enabled before using security_scan.`
- Required strings are trimmed and reject blank values. ArkType rejects invalid enum values, nonpositive credential/lookback IDs, and malformed validation evidence.
- Native scans reject missing Git context, unknown refs, escaping/nonexistent scope paths, invalid knowledge-base files, unsafe output directories, unknown/stale plans, unavailable pinned models, OAuth identity changes, and unavailable pinned credentials.
- Cloud requests retry once on HTTP 401 with a forced refresh, then fail. Other non-success responses report the status and endpoint.
- `cloud_pull` verifies repository identity and configuration attribution before importing.
- Cancellation is cooperative. The operation reaches terminal `cancelled` only after the background run handles the abort and persists its terminal bundle.
