---
title: Workflow Recipes
description: End-to-end workflows that combine omp's modes, commands, skills, and tools — plan-to-PR delivery, autonomous fix-it sessions, batch triage, code review passes, benchmark-driven optimization, and security gates.
coverage: B
---

The recipes on this page chain the mechanisms documented elsewhere in this site — [modes](/oh-my-pi/modes/plan-mode/), [slash commands](/oh-my-pi/reference/slash-commands/), [subagents](/oh-my-pi/features/subagents/), [skills](/oh-my-pi/extending/skills/), and the [GitHub](/oh-my-pi/features/github/) and [security](/oh-my-pi/features/security/) tooling — into complete workflows. Each recipe states a goal, lists the commands and modes it uses, gives a step sequence, and explains why the combination works. Treat them as starting points: every mechanism is individually optional, so adapt the steps to the size and shape of your task.

| Recipe | Goal | Key mechanisms |
| --- | --- | --- |
| [Plan, implement, review, ship](#plan-implement-review-ship) | Take a feature from design to a reviewed PR | Plan mode, goal mode, `/review`, `omp commit`, `pr_create` |
| [Autonomous fix-it session](#autonomous-fix-it-session) | Run a bounded repair campaign to green | Goal mode, loop mode, skills, `omp commit`, `omp cleanse` |
| [Batch triage without interrupting](#batch-triage-without-interrupting) | Work through a task queue in one session | `/queue`, `/tan`, compaction |
| [Code review pass on a PR](#code-review-pass-on-a-pr) | Review and fix a pull request in isolation | `/review`, `pr_checkout`/`pr_push`, code intelligence, `conflict://` |
| [Measure first, then implement](#measure-first-then-implement) | Optimize against a benchmark, then land the result | Autoresearch, plan mode, subagents |
| [Security gate before merge](#security-gate-before-merge) | Scan the merge surface and record a decision trail | `security_scan`, approvals, `security://` |

## Plan, implement, review, ship

The full delivery loop: design under plan mode's read-only guard, execute autonomously, commit atomically, open a PR, and review it with the `/review` fan-out before pushing.

### Commands and modes

- [`/plan`](/oh-my-pi/modes/plan-mode/) — planning phase; the agent inspects the workspace with read-only tools and proposes a structured plan (title, ordered steps, files, acceptance criteria) before any modifying tool runs.
- [`/goal`](/oh-my-pi/modes/goal-mode/) — persistent autonomous objective with a token budget.
- [`omp commit`](/oh-my-pi/features/atomic-commits/) — Conventional Commit generation, with split proposals for unrelated changes.
- [`/review`](/oh-my-pi/features/code-review/) — structured diff review with prioritized findings and a ship/no-ship verdict.
- `github` tool — `pr_create`, `run_watch`; requires `gh` installed and authenticated (`gh auth login`).

### Steps

1. Enter plan mode and submit the objective:

   ```text
   /plan migrate the auth flow to the claims API
   ```

   Ask the agent to refine the plan in place until the steps and acceptance criteria look right. If you dismissed the review overlay, `/plan-review` re-opens it.

2. Approve. The plan dispatches into a fresh session; the plan title seeds the new session's name.

3. In the execution session, set a goal with a budget so the agent keeps driving without running away:

   ```text
   /goal migrate the auth flow to the claims API
   /goal budget 200000
   ```

   For large slices, let the agent fan out with a `task` batch — each item gets its own prompt, and the batch `context` carries shared background. Adding the `orchestrate` keyword to a prompt adds the multi-agent orchestration contract (scope the task, delegate independent work in parallel, verify each phase).

4. Commit the result atomically. Preview first, then commit:

   ```bash
   omp commit --dry-run
   omp commit
   ```

   If the agent proposes a split, the changes are unrelated and land as separate commits in dependency order — confirm the plan.

5. Open the PR with the `github` tool (`pr_create` with `title`/`body`, or `fill=true`), then review it by URL:

   ```text
   /review https://github.com/<owner>/<repo>/pull/<number>
   ```

   `/review` accepts a GitHub PR URL or a `pr://<owner>/<repo>/<number>` URI and jumps straight to PR review. Reviewer agents scale with the diff (one for tiny diffs up to 8–16 for huge ones) and return findings with `priority` and `confidence` plus an overall `correct`/`incorrect` verdict.

6. Address the findings. Follow up with a reviewer agent directly via `hub` — its id is in the spawn summary — then fix and push with `omp commit --push`.

7. Watch CI to green with the `github` tool's `run_watch` op in commit mode; it polls all runs for the branch commit and reports failed-job logs.

### Why this combination works

Plan mode front-loads design decisions while nothing can be modified, so the execution session starts from an approved contract instead of a vague prompt. Goal mode sustains autonomy across many turns while the budget caps the blast radius. `/review` scales its review effort to the diff and returns an explicit verdict, and `omp commit` keeps the PR's history reviewable by splitting unrelated changes.

## Autonomous fix-it session

A bounded, self-driving repair campaign: point goal mode at an objective, let loop mode replay a fix-until-green pass, and finish with atomic commits and a diagnostics sweep.

### Commands and modes

- [`/goal`](/oh-my-pi/modes/goal-mode/) — objective, `pause`/`resume`, and `budget`.
- [`/loop`](/oh-my-pi/modes/loop-mode/) — re-submits a fixed prompt after every yield, optionally bounded by a count or duration.
- [`/queue`](/oh-my-pi/modes/queue-mode/) — schedules the next prompt for after the agent yields.
- [Skills](/oh-my-pi/extending/skills/) — the agent reads `skill://<name>` content on demand; `/skill:<name>` invokes one directly when skill commands are enabled.
- [`omp commit`](/oh-my-pi/features/atomic-commits/) and [`omp cleanse`](/oh-my-pi/features/cleanse/) — history and diagnostics cleanup.

### Steps

1. Declare the objective and cap spending:

   ```text
   /goal make the integration suite pass
   /goal budget 150000
   ```

2. Add a bounded repeat for the mechanical part. Loop mode can run on top of goal mode:

   ```text
   /loop 10 run the test suite and fix any failures
   ```

   Each yield re-submits the prompt; Esc cancels the current iteration without disabling the loop, and the count limit turns it off after 10 passes. If a new instruction occurs to you mid-turn, `/queue also update the docs for the fixed endpoints` — it lands as the next prompt without interrupting the in-flight work.

3. Let the agent use the session's skills as needed (the agent discovers them from the system prompt and reads `skill://<name>`); subagents spawned during the session inherit the discovered skill list.

4. When the goal reports `complete` (or you `pause` it), turn the session's mixed edits into atomic history:

   ```bash
   omp commit --dry-run
   omp commit
   ```

5. Sweep what the tests did not catch. `omp cleanse` detects the project's language-ecosystem checkers (for example `cargo clippy`), parses their diagnostics, distributes file-disjoint repair workloads across concurrent subagents, and re-runs the checkers to verify:

   ```bash
   omp cleanse --agents 4 --tests
   ```

   If no supported checker is installed it reports `unsupported` and exits; otherwise it finishes `clean`, `unresolved`, or `cancelled`.

### Why this combination works

Goal mode supplies the direction and the budget pressure; loop mode automates the repetitive fix-until-green cycle that would otherwise need a human to keep re-sending the same prompt. `omp commit`'s split proposals turn one long session's unrelated edits into readable history, and `omp cleanse` catches diagnostics — clippy-style lints, test-script failures — that the functional tests never exercised.

## Batch triage without interrupting

Work through a queue of issues in one session while the agent stays busy: feed the next task in without cancelling the current turn, and shunt tangential work into background agents.

### Commands and modes

- [`/queue`](/oh-my-pi/modes/queue-mode/) — schedules a message for delivery right after the agent yields; multiple queued messages deliver in order, and a queued message can queue another.
- `/tan` — runs a full background agent on tangential work (see [Slash Commands](/oh-my-pi/reference/slash-commands/)).
- [Compaction](/oh-my-pi/features/compaction/) — automatic threshold maintenance plus manual `/compact [instructions]` and `/handoff [focus instructions]`.
- `github` tool — `search_issues`; `issue://<owner>/<repo>/<number>` URLs read single issues.

### Steps

1. Pull the backlog into the session with the `github` tool's `search_issues` op, or open a list view with a bare `issue://<owner>/<repo>` URL, and read the issues you plan to fix.

2. Give the agent the first task. While it works, queue the next one instead of interrupting:

   ```text
   /queue next: fix the timeout regression in client.ts
   /queue then: update the changelog entry
   ```

   The current turn finishes untouched; the queued prompts arrive one at a time as full turns, in order.

3. For items that are real work but not on the critical path, hand them to a background agent:

   ```text
   /tan investigate the flaky CI job on Windows
   ```

   The main session keeps triaging while the tangential agent works. Use `/btw <question>` for quick side questions that do not need an agent at all.

4. Keep the session context under control. Compaction runs automatically after turns that cross the threshold; run `/compact focus on the triage log` when you want it now, or `/handoff` to move context into a fresh session for a long-running triage effort.

### Why this combination works

Queue mode removes the interrupt-or-wait dilemma: the agent finishes its current turn, so no partial state is discarded, and the queued prompts arrive in order as ordinary user prompts. `/tan` keeps genuinely tangential work moving in parallel without derailing the main line. Compaction's automatic threshold maintenance keeps a long triage session working past the context window, and `/handoff` starts a clean session when the backlog outlives the current one.

## Code review pass on a PR

Review a pull request with the `/review` fan-out, fix the findings with structural tooling, and push updates through the PR worktree — including resolving merge drift block by block.

### Commands and modes

- `github` tool — `pr_checkout` (worktree at `~/.omp/wt/<number>-<repo-hash>`, branch `pr-<number>`) and `pr_push` (the only push path for a `pr-<number>` branch; reads the metadata `pr_checkout` wrote).
- [`/review`](/oh-my-pi/features/code-review/) — PR review by URL or `pr://` URI.
- [Code intelligence](/oh-my-pi/features/code-intelligence/) — `lsp` diagnostics and refactors, `ast_grep` pattern search, `ast_edit` structural rewrites.
- [Merge conflicts](/oh-my-pi/features/merge-conflicts/) — `conflict://<id>` resolution.
- `github` tool — `run_watch` for CI.

### Steps

1. Ask the agent to run the `github` tool's `pr_checkout` op for the PR so the review happens in its own worktree (`~/.omp/wt/<number>-<repo-hash>`, local branch `pr-<number>`) without disturbing your working tree. Existing worktrees are reused; pass `force=true` to reset the branch to the PR head.

2. Run the review fan-out against the PR — either by URL or `pr://` URI:

   ```text
   /review https://github.com/<owner>/<repo>/pull/1234
   ```

   Reviewer agents are chosen by diff size and grouped by locality (same module, tests with their implementations); each returns findings with `priority` and `confidence`, and the summary carries a ship/no-ship `overall_correctness` verdict. Large diffs (> 50,000 characters or 20+ files) switch to per-file previews and tell reviewers to fetch their slice with `git` themselves.

3. Triage the findings by priority. If a finding is unclear, message its reviewer agent via `hub` — the spawn summary lists the id — for the reasoning behind it.

4. Fix, using structural tooling to keep edits safe:

   - `lsp` workspace diagnostics runs the project-type check (`cargo check`, `npx tsc --noEmit`, `go build ./...`, or `pyright`) and reports deduplicated, severity-sorted messages.
   - `ast_grep` finds every occurrence of a pattern; `ast_edit` previews a structural rewrite and applies it on a follow-up `write /xdev/resolve`.
   - `lsp` `rename` updates a symbol and notifies the language server, or preview with `apply: false`.

5. If the branch drifted, resolve merge conflicts one block at a time: `read` the conflicted file (the footer lists registered conflict ids), inspect sides with `conflict://<id>/ours` and `/theirs`, and splice a resolution with a `write` to `conflict://<id>`. For pick-one blocks use the `@ours` / `@theirs` shorthand; `conflict://*` resolves many blocks in one call.

6. Push the updates with `pr_push` — it maps the local branch to the recorded PR head ref — then watch CI with `run_watch` in commit mode until the runs are green. Re-run `/review` on the updated PR for a second pass if the changes were substantial.

### Why this combination works

The worktree checkout isolates the PR branch and gives `pr_push` the metadata it needs for updates. The review fan-out scales with diff weight, so a tiny change does not pay for a huge review and a huge change is not reviewed by a single agent. Code intelligence turns fixes into verified structural edits instead of blind find-and-replace, and `conflict://` splices resolve merge drift surgically without rewriting the file.

## Measure first, then implement

Optimize against a real benchmark before committing to an approach: autoresearch runs a branch-isolated experiment loop, then plan mode and subagents turn the winning experiment into reviewed code.

### Commands and modes

- `/autoresearch` — toggles builtin autoresearch mode; accepts a goal message, `off`, or `clear` (see [Auto-research](/oh-my-pi/features/autoresearch/)).
- Autoresearch tools — `init_experiment`, `run_experiment`, `log_experiment`, `update_notes`.
- [`/plan`](/oh-my-pi/modes/plan-mode/) and [subagents](/oh-my-pi/features/subagents/) for the implementation phase.
- [`workflowz`](/oh-my-pi/features/magic-workflowz/) — magic keyword that adds a deterministic multi-subagent workflow contract through the `task` tool.

### Steps

1. Start a measured optimization campaign:

   ```text
   /autoresearch reduce p95 latency of the batch endpoint
   ```

   Mode on, the agent first builds the harness (Phase 1): a `./autoresearch.sh` that exits 0 on success and prints the primary metric as `METRIC <name>=<value>`, validated with `bash autoresearch.sh`.

2. Baseline it with `init_experiment` — `name`, `goal`, `primary_metric`, `metric_unit`, `direction`, plus optional `secondary_metrics`, `scope_paths`, `off_limits`, `constraints`, and `max_iterations`. This snapshots the worktree as the baseline on a dedicated `autoresearch/*` branch and auto-commits the harness.

3. Iterate: `run_experiment` runs the fixed harness, `log_experiment` records the result — `keep` auto-commits the change, `discard`/`crash`/`checks_failed` reverts the worktree, and `flag_runs` marks earlier runs as suspect so they drop out of the baseline math. `update_notes` persists the durable playbook and the ideas backlog. The session's dashboard widget tracks runs. When `max_iterations` is reached the mode turns itself off.

4. Leave the campaign when the metric says so:

   ```text
   /autoresearch off
   ```

   `/autoresearch clear` instead resets the worktree to the recorded baseline commit and closes the session — use it to discard the campaign entirely.

5. Implement the winning approach properly. Plan first, then execute:

   ```text
   /plan implement the winning query plan from the experiments
   ```

   Approve, then let the execution session fan independent slices out as a `task` batch. Prefixing the prompt with `workflowz` adds a deterministic multi-subagent workflow contract (injected only when `task` is available), and `orchestrate` adds the parallel-delegation contract.

### Why this combination works

Autoresearch makes optimization honest: a fixed harness, a recorded baseline, and auto-commits/reverts on a dedicated branch mean every iteration is comparable and nothing is lost. Keeping the harness stable within a segment protects the measurements from scope creep. The plan-and-subagents phase then converts the measured winner into ordinary, reviewable code instead of leaving it as an experiment artifact.

## Security gate before merge

Scan the exact merge surface before shipping, record a validation decision for every finding, and keep a human checkpoint on execution during the gate.

### Commands and modes

- `security_scan` tool — `preflight`, `start`, `status`, `cancel`, `validate`, plus the `cloud_*` actions (see [Security Scanning](/oh-my-pi/features/security/)).
- [`security://` URLs](/oh-my-pi/features/security/) — read-only scan results.
- [Approval modes](/oh-my-pi/configuration/approvals/) — `tools.approvalMode` and per-tool `tools.approval` overrides.
- [`/review`](/oh-my-pi/features/code-review/) — human-readable verdict on the same diff.

### Steps

1. Enable the scanner once: `security.enabled` defaults to `false`; turn it on in **Settings → Tools → Security**. Native scans require a git repository, an active model, and a stored OAuth credential for that provider — API-key-only authentication is not accepted.

2. Tighten approvals for the gate so execution-tier actions prompt instead of auto-approving (`yolo` is the default):

   ```yaml
   tools:
     approvalMode: write
   ```

   `write` auto-approves `read` and `write` tiers and prompts for `exec`. Per-tool overrides (`tools.approval.bash: prompt`) apply in every mode.

3. Plan and start a scan of exactly the merge surface — the ref-diff target pins base and head revisions:

   ```json
   { "action": "preflight", "target_kind": "ref_diff", "base_revision": "origin/main", "head_revision": "HEAD" }
   { "action": "start", "plan_id": "secplan_<id>" }
   ```

   The plan is immutable: it pins the scope, the resolved revisions, the model, and the OAuth credential. `start` recomputes the fingerprint and fails if anything drifted. The scan itself runs in a restricted session with read-only inspection tools, read-only LSP, and only `security-reviewer` workers.

4. Poll with `security_scan status` (`operation_id=...`) through the phases `queued → preparing → reviewing → publishing → completed`, then read the results:

   ```text
   security://scans/<scan-id>/findings
   security://scans/<scan-id>/report
   security://scans/<scan-id>/sarif
   ```

5. Record a decision for every finding with `validate` — `validation_status` is `validated`, `rejected`, `partial`, or `error`, with a required summary and optional evidence records:

   ```json
   { "action": "validate", "scan_id": "secscan_<id>", "finding_id": "secfinding_<id>", "validation_status": "validated", "validation_summary": "Reproduced and fixed in commit ..." }
   ```

6. Fix what the scan flagged, re-run the gate on the new head, and only then merge. CI stays visible with the `github` tool's `run_watch`, and `/review` on the PR provides the code-level verdict in parallel. Codex Security cloud scans are available through `cloud_start`/`cloud_status`/`cloud_pull` when a ChatGPT OAuth credential is configured.

### Why this combination works

The ref-diff target scans exactly what is about to merge, and the immutable plan plus pinned credential make the scan reproducible and attributable. The restricted scan session limits the scanner's blast radius to read-only inspection and review agents. `validate` leaves a decision trail on every finding, and a stricter approval mode during the gate puts a human checkpoint between the scanner's findings and the merge.

## See also

- [Steering the Agent](/oh-my-pi/guides/steering-the-agent/) — prompting patterns that shape agent behavior
- [Multi-Agent Workflows](/oh-my-pi/guides/multi-agent/) — deeper coverage of subagent topologies
- [Automation & Headless](/oh-my-pi/guides/automation-headless/) — running the same mechanisms without a TUI
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — every built-in `/command` and its arguments
