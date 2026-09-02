---
title: Security Scanning
description: Plan and run OMP-native repository security reviews, import SARIF and Codex Security findings, and validate or triage results from the security:// store.
coverage: B
---

Security scanning plans, runs, and stores OMP-native security reviews of your repository, and can import findings from SARIF files or Codex Security cloud scans into the same store. Scans run as background OMP jobs with read-only access to the repository, and every result — findings, coverage, reports, SARIF — is available read-only through the `security://` scheme.

## How security scanning works

A scan has two phases: a preflight plan, then background execution.

**Preflight** (`preflight`) resolves an immutable plan pinned to the exact repository state. The plan records the repository root and normalized include/exclude scope, the target snapshot digest, the active provider/model, the exact OAuth credential, knowledge-base file identities, the output policy, the security settings snapshot, and a fingerprint of the review workflow. For `repository`, `scoped_path`, and `working_tree` targets the digest covers in-scope tracked and untracked file paths and contents, executable bits, symlink targets, and the current HEAD. A `ref_diff` target instead pins the resolved base and head commits and their raw tree diff.

**Execution** (`start`) loads the stored plan, verifies it is still fresh (a mismatch fails with `Security scan plan is stale: expected <old>, got <new>. Run security preflight again.`), and registers a background job. The scan runs as a restricted, auto-approved agent session with only read-only repository tools (`read`, `grep`, `glob`, `lsp`, `ast_grep`, `task` with `security-reviewer` workers, and the internal `security_publish` tool), read-only LSP, and no extension discovery, MCP, or IRC. Model fallback and OAuth account rotation are disabled: execution stays on the pinned model and credential. A `ref_diff` scan runs in a detached temporary worktree at the pinned head revision with the pinned diff supplied to the review session; other target kinds review the repository root directly.

Operation phases progress `queued → preparing → reviewing → publishing → completed`, with terminal alternatives `partial`, `cancelled`, and `failed`. The review session must publish its findings through the internal `security_publish` tool — deduplicated findings with severity, confidence, taxonomy, and at least one in-scope location, honest coverage, and a Markdown report. If the session ends without publishing, the scan is recorded as `partial`. Cancellation is cooperative: the operation reaches `cancelled` only after the background run handles the abort and persists its terminal bundle. If the process restarts mid-scan, the persisted scan is marked `failed` with `Security scan was interrupted by a process restart`, and any ref-diff worktree is cleaned up.

Canonical state is stored per project under the OMP security state directory (`~/.omp/security/<project-key>`), hardened to mode `0700` directories and `0600` files. Each scan directory contains `findings.json` and `scan.json` (the commit marker, written last); published scans also carry `report.md` and `results.sarif`. A completed scan's output directory mirrors these files and adds a redacted `provenance.json`.

## Enabling security scanning

Security scanning is gated by the `security.enabled` setting, which defaults to `false` ([Settings — Tools](/oh-my-pi/reference/settings/tools/), or set `security.enabled = true`). While disabled:

- the `security_scan` tool is not offered to the agent, and calling it directly fails;
- the `/security` command returns a usage error;
- `security://` reads fail with an enablement message.

Native scans additionally require a Git repository, an active model, and a stored OAuth credential for the active model's provider — API-key-only authentication is not accepted. If several OAuth accounts exist and none is active, pass `credential_id` to pin one; a lone account is selected automatically. The plan pins the exact credential row, and execution and token refresh stay on that row.

Codex Security cloud actions (`cloud_scans`, `cloud_start`, `cloud_status`, `cloud_pull`) require an `openai-codex` ChatGPT OAuth credential and call ChatGPT's Codex Security cloud control plane, not the public OpenAI API. Cloud scans consume the account's separate cloud scan allowance and are never used as a fallback for a native scan.

## The security_scan tool

`security_scan` (tier `exec`, discoverable, strict schema) is the agent-facing surface for the [Built-in Tools](/oh-my-pi/features/tools/). Its actions:

| Action | Purpose |
| --- | --- |
| `preflight` | Create an immutable scan plan; returns a plan ID and fingerprint |
| `start` | Run a planned scan as a background OMP job; returns a scan ID and operation ID |
| `status` | Report an operation's phase and finding count (`operation_id`) |
| `cancel` | Request cooperative cancellation of a running operation |
| `validate` | Record a validation verdict on one stored finding |
| `cloud_scans` | List Codex Security cloud scan configurations for the selected account |
| `cloud_start` | Create and enable a cloud scan configuration (`repository_id`, `repository_url`, `environment_id`; `lookback_days` defaults to 30) |
| `cloud_status` | Report cloud scan progress (current step, finished/pending commits) |
| `cloud_pull` | Import cloud findings into the local security store as a new scan |

Plan-target parameters: `target_kind` (`repository` default, `scoped_path`, `ref_diff`, `working_tree`), `include_paths`, `exclude_paths`, `base_revision`/`head_revision` (required for `ref_diff`), `knowledge_base_paths`, `output_root`, `archive_existing`, and `credential_id`. `scoped_path` requires at least one `include_paths` entry.

```json
{"action": "preflight", "target_kind": "ref_diff", "base_revision": "origin/main", "head_revision": "HEAD", "exclude_paths": ["vendor", "dist"]}
```

```json
{"action": "start", "plan_id": "secplan_<id>"}
```

## The /security command

`/security` is the interactive surface for the same workflow ([Slash Commands](/oh-my-pi/reference/slash-commands/)):

| Subcommand | What it does |
| --- | --- |
| `plan` | Create a scan plan; options `--path`, `--exclude`, `--working-tree`, `--diff <base> <head>`, `--knowledge-base`, `--output`, `--archive-existing`, `--credential` |
| `scan` | Start a scan from an existing plan ID (`secplan_…`) or plan and start in one step |
| `status` | Show one operation (`operation_id`) or all operations as JSON |
| `cancel` | Cancel a running operation |
| `scans` | List stored scans for the project |
| `show` | Render a scan or a `security://` resource |
| `import` | Import a SARIF file or a Codex Security bundle directory |
| `export` | Export a scan as a canonical bundle, SARIF, or report |
| `validate` | Start an agent-driven validation of one finding |
| `compare` | Compare finding lineage across two scans |
| `disposition` | Set a finding disposition with a rationale |
| `cloud` | `scans`, `start`, `status`, or `pull` for Codex Security cloud scans |

```bash
/security plan --diff origin/main HEAD --exclude vendor
/security scan secplan_<id>
/security status <operation-id>
/security scans
/security show security://scans/<scan-id>/report
/security compare <before-scan-id> <after-scan-id>
/security cloud start --repo-id repo_<id> --repo-url https://github.com/owner/repo --environment env_<id>
```

## Importing findings

`/security import <path>` (or the `security_publish`-adjacent importers behind `cloud_pull`) brings external results into the canonical store as new scans:

- **SARIF** — any SARIF 2.1.0 log file. Severity levels map to OMP severities, artifact locations resolve against the repository root, and vendor fingerprints and any existing validation/disposition statuses are preserved.
- **Codex Security bundle** — a directory of Codex Security findings and coverage documents.
- **Codex Security cloud** — `cloud_pull` fetches a cloud configuration's results and converts them to the canonical schema. Import fails closed unless the current project's `origin` remote identity matches the configuration URL; cloud coverage is recorded as `unknown`.

Imported scans are stored like native ones and read the same way through `security://`, `show`, and `export`.

## Validating and disposing of findings

`/security validate <scan-id> <finding-id>` (or a `security://scans/<scan-id>/findings/<finding-id>` URI) hands the agent a prompt to investigate the finding with OMP-native tools. The agent records the result with `action=validate` plus `validation_status` and a required nonblank `validation_summary`, optionally appending `validation_evidence` entries:

| Validation status | Meaning |
| --- | --- |
| `unvalidated` | Not yet reviewed (initial state) |
| `validated` | Confirmed with evidence |
| `rejected` | Not a real issue |
| `partial` | Partly confirmed |
| `error` | Could not be evaluated |

Disposition is an operator decision recorded with a rationale:

```bash
/security disposition <scan-id> <finding-id> false_positive "CWE-79 does not apply: input is escaped before rendering"
```

| Disposition | Meaning |
| --- | --- |
| `open` | Still open (no rationale required) |
| `false_positive` | Not a real vulnerability |
| `accepted_risk` | Known and accepted |
| `fixed` | Remediated |
| `wont_fix` | Will not be fixed |

Every disposition other than `open` requires a rationale. Validation and disposition updates rewrite the stored bundle, including the SARIF export.

## Reading results with security://

The `security://` namespace exposes scans, findings, coverage, reports, SARIF, and provenance as read-only resources ([Internal URLs](/oh-my-pi/guides/internal-urls/)):

| URL | Contents |
| --- | --- |
| `security://` | Namespace index |
| `security://scans` | Stored scan list |
| `security://scans/<scan-id>` | Scan summary and child-resource index |
| `security://scans/<scan-id>/manifest` | Public scan manifest JSON, including the plan |
| `security://scans/<scan-id>/findings` | Finding list |
| `security://scans/<scan-id>/findings/<finding-id>` | Rendered finding with locations, evidence, and remediation |
| `security://scans/<scan-id>/coverage` | Coverage JSON |
| `security://scans/<scan-id>/report` | Markdown report, when present |
| `security://scans/<scan-id>/sarif` | SARIF JSON, when present |
| `security://scans/<scan-id>/provenance` | Redacted provenance JSON |

URI reads never mutate state — use the `security_scan` tool or `/security` commands for validation, disposition, import, and export.

## Exporting results

`/security export <scan-id> --output <path> [--format bundle|sarif|report]` writes a scan to a file of your choice; the default format is the canonical bundle. Completed native scans always carry a `results.sarif` SARIF 2.1.0 export, mapping severities to SARIF levels (`critical`/`high` → `error`, `medium` → `warning`, `low` → `note`, `informational` → `none`) and tagging each result with its OMP finding ID, confidence, validation, and disposition.
