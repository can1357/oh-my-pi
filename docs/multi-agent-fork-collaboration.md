# Multi-agent fork collaboration

This is the operating policy for agents working from Linear on the same repository. It applies to root agents, remote runners, task subagents that own a code slice, reviewers, and the merge integrator.

## When Linear is mandatory

Linear is required the moment work crosses a session or ownership boundary; work that dies inside one interactive session may skip it. Any one of these conditions requires an issue before proceeding:

- Another party must act: review, a merge by someone other than the author, unblocking, or a handoff.
- More than one agent or session will own code: task fan-out with owned slices, remote runners, or work resumed later.
- The work claims paths or shared resources a concurrent agent could also touch. Claims exist only inside an issue contract; no issue means no claim and no protection.
- Execution is unattended. Relay-dispatched work is Linear-born by construction and cannot exist without an issue.

Solo interactive edits with the human present, merged within the session, are exempt. Branch names make the rule checkable: `linear/<issue-key>-…` is required wherever any condition above holds, so a boundary-crossing branch without an issue key is a policy violation, not a style choice.

## Project resolution

One repository maps to exactly one Linear project. Identity is the canonical repo key — `owner/repo`, normalized and lowercased from the git remote URL — never a human-typed project name.

- The committed registry `.ompk/linear.json` is the source of truth; changes to it ship through review. The worker's `ALLOWED_PROJECT_IDS` allowlist is generated from it, not hand-maintained.
- A bound project embeds the exact line `repo-key: <owner/repo>` in its description. Matching is line-exact, so `owner/repo` never matches `owner/repo-two`.
- Resolution is fail-closed via `bun run resolve:project` in `packages/ompk-linear-agent`:
  1. Registry hit → verify the project is live. Archived or deleted targets stop for a human decision; never recreate silently.
  2. No entry → scan project descriptions for the token. Exactly one match is adopted into the registry; zero matches create only with `--create` plus a configured `defaults.teamId`; two or more matches stop and list the candidates. The resolver never tie-breaks.
- Creation is deliberate and rare. Search-then-create races cannot be locked through Linear itself, so a duplicate created out-of-band is caught by the multiple-match stop on the next resolution instead of compounding.

## Repository decision

Use one shared GitHub fork and isolate work with branches and git worktrees.

Do not create one fork per agent. Separate forks are reserved for an actual trust, permission, billing, or release boundary. Per-agent forks fragment CI, tags, release state, and the canonical `main` branch without preventing merge conflicts.

The unit of ownership is:

```text
one Linear child issue = one owning agent = one branch = one worktree = one PR
```

- Branch: `linear/<issue-key-lowercase>-<short-slug>`.
- Worktree: `.worktrees/linear/<issue-key-lowercase>` or the runner's equivalent external worktree directory.
- Base: the fork's current `main`, recorded by commit SHA when the worktree is created.
- Writer: only the owning agent may edit that worktree or branch.
- Merge owner: one human or explicitly designated integrator serializes merges into `main`.

Agents never share a mutable checkout. A session fork is not repository isolation; it copies conversation state. Use a git worktree for repository isolation.

## Roles

### Orchestrator

- Owns the parent Linear issue, decomposition, dependency graph, and child work contracts.
- Creates child issues that are independently verifiable and normally produce one PR.
- May mark children `Queue/Ready`; it does not dispatch workers or own WIP accounting.
- Does not edit worker branches or absorb worker transcripts into its context.
- Reads only bounded status/result records and linked artifacts.
- Selects a merge owner and records it on the parent issue.

### Queue dispatcher

- Exactly one dispatcher owns admission and WIP accounting for a queue.
- Re-reads blockers, retained path claims, and shared-resource claims immediately before dispatch.
- Records resolved `baseSha`, unique `attemptId`, actual worktree, and the AgentSession/run ID.
- Is the only role allowed to set `delegate` or start a worker. It does not own decomposition or merging.

### Worker

- Owns exactly one child issue, branch, and worktree at a time.
- Changes only the declared path scope. Newly discovered scope is reported before editing it.
- Reuses the issue contract; it does not ask the orchestrator to replay project history.
- Runs focused verification, publishes evidence, and opens or updates one PR.
- Never merges its own PR unless explicitly designated as merge owner.

### Reviewer

- Uses a separate read-only checkout or review worktree.
- Reviews the PR contract, diff, tests, and merge risk; it does not rewrite the worker branch.
- Returns bounded findings with file/line evidence. The worker owns corrections.

### Merge owner

- Rebases or requires the worker to rebase onto current `main`.
- Merges one PR at a time per repository.
- Runs the final union verification after all constituent PRs are integrated.
- Moves the Linear issue to Done only after merge and verification.

## Launching roles from Linear

The installed Linear app appears as one visible delegate, `ompk`. Select the internal agent by adding exactly one role label before delegating or mentioning `ompk`:

| Linear label          | Launched role    |
| --------------------- | ---------------- |
| `Agent: Orchestrator` | Orchestrator     |
| `Agent: Dispatcher`   | Queue dispatcher |
| `Agent: Worker`       | Worker           |
| `Agent: Reviewer`     | Reviewer         |
| `Agent: Merge Owner`  | Merge owner      |

Role labels take precedence over generic provider/routing labels. Multiple role labels are invalid and must not launch a runner. The dispatcher or an explicitly acting human still performs queue admission before delegation. A `created` Agent Session event launches the role; `prompted` follow-ups fail closed with a visible response until role-aware session resume is implemented, so they cannot create a second Worker branch.

These are exact internal role profiles behind one OAuth app-user, not five visible Linear identities. Creating five independently mentionable/delegable identities would require five OAuth applications and separate installation records; do that only when separate identity or permissions are a real requirement.

## Linear work contract

A child issue is not queue-ready until it contains this contract:

```yaml
schemaVersion: 1
repo: kingkillery/oh-my-pk
issue: OMP-123
objective: One sentence describing the observable outcome.
baseRef: main
baseSha: set-at-admission
attemptId: set-at-admission
branch: linear/omp-123-short-slug
worktree: .worktrees/linear/omp-123
allowedPaths:
  - packages/example/
dependsOn:
  - OMP-120
acceptance:
  - Observable contract one
  - Observable contract two
verification:
  - bun --cwd=packages/example test
links:
  - label: Design or long context
    url: https://...
mergeOwner: Preston
```

Rules:

- `objective` is one sentence.
- `allowedPaths` is mandatory and normalized to repository-relative paths. Any claim that can touch the same file overlaps and is serialized; disjoint symbols are not an exception.
- `acceptance` has at most 10 items, each at most 200 characters.
- `verification` lists exact commands, not “test it.”
- `dependsOn` uses Linear `blocked by` relations, not prose-only dependencies.
- Long requirements, logs, screenshots, traces, and prior discussions are links, not embedded bodies.
- Shared mutable resources such as ports, databases, caches, browsers, devices, credentials, and deploy targets are declared like path claims. Conflicting or unknown resource safety is serialized.
- At Ready, branch/worktree names and `baseRef` are planned. Before In Progress, the dispatcher records the resolved `baseSha`, unique `attemptId`, and actual worktree; missing or reused attempt metadata blocks start.

## Current manual queue mode

The transport queue enforces atomic idempotent admission, fenced leases with heartbeats, reconcile parking, and dead-letter surfacing (`packages/ompk-linear-agent`); automatic retry classification and redispatch do not exist. Exactly one designated queue dispatcher may set `delegate` or start workers. Parent orchestrators may prepare `Queue/Ready` issues but must not dispatch them. The dispatcher re-reads blockers and retained claims immediately before one delegation and records the resulting AgentSession/run ID. Do not bulk-delegate, automatically redispatch, or infer liveness from Linear status alone.

## Queue states

Linear is the control plane. Transport queues and runners mirror these states; they do not invent a second planning system.

| Linear state                        | Queue meaning        | Required action                                                                |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| Backlog                             | Unrefined            | Orchestrator must produce a complete work contract.                            |
| Todo + `Queue/Ready`                | Eligible             | Contract is valid and dependencies are Done; no worker has started.            |
| Todo + `Queue/Queued`               | Selected, waiting    | Dispatcher selected it, but no delegate, lease, or worker exists yet.          |
| In Progress                         | Started              | Runner acceptance or a manually confirmed start and attempt metadata exist.    |
| Todo + `Queue/Reconcile`            | Liveness uncertain   | Retain claims; confirm or terminate the prior runner before replacement.       |
| Blocked, or Todo + blocked relation | Not runnable         | Record one blocker; release capacity only after the runner is stopped.         |
| In Review                           | Awaiting integration | Release worker capacity but retain claims until merge or explicit abandonment. |
| Done                                | Terminal success     | PR merged and final verification passed; release claims.                       |
| Canceled + `Queue/Dead Letter`      | Terminal failure     | Retry budget exhausted or contract is invalid; human action is required.       |

If the workspace lacks a Blocked status, keep the issue in Todo, preserve its `blocked by` relation, and post the blocker as a bounded status update.

Exactly one `Queue/*` label may be present. A canceled prerequisite requires an explicit dependency decision; it does not silently unblock dependents. Worker capacity and ownership claims are independent: admission checks retained claims from In Progress, In Review, `Queue/Reconcile`, and blocked work with unmerged changes or a live runner.

## Admission and WIP limits

Default limits are conservative:

```text
global active workers: 3
active workers per repository: 2
overlapping path lane: 1
merge lane per repository: 1
active parent orchestration plans: 1 per orchestrator
```

The dispatcher may lower these limits. Raising them requires evidence that runners, CI, and merge throughput can sustain the increase.

Ready work is admitted in this order:

1. All `blocked by` issues are Done.
2. No retained path or shared-resource claim overlaps the candidate.
3. Higher Linear priority first.
4. Older ready timestamp first.
5. Short verification/unblocking tasks may move ahead only when documented on the parent issue.

Delegating every child issue at once is forbidden. In current manual mode, only the designated dispatcher starts one eligible issue after rechecking capacity and claims.

## Target automation contract — not currently enforced

Automated mode requires durable delivery, atomic admission, logical-attempt idempotency, terminal acknowledgement, retry classification, reconciliation, and auditable state transitions. Select the implementation only after comparing the existing runner queues with Cloudflare Queues, Workflows, Durable Objects, and transactional storage; KV is never a lock.

- One logical attempt is keyed `linear:<organizationId>:<agentSessionId>:<attempt>`. Webhook IDs are receipt IDs attached to that attempt, not run identity.
- Only session creation or an explicit resume may create an attempt. Later events attach to the existing attempt, and attempt creation plus dispatch eligibility is atomic.
- Target lease duration is 30 minutes with a heartbeat every 10 minutes and on state transitions.
- Two missed heartbeats move work to `Queue/Reconcile`, never directly to `Queue/Queued`.
- A replacement may start only after the prior runner is confirmed terminated. Automated reassignment requires a fencing token enforced on callbacks and branch mutations.
- Retry only transient timeouts, rate limits, runner unavailability, and provider 5xx responses after 30 seconds, 2 minutes, 5 minutes, 15 minutes, and 30 minutes.
- Do not blindly retry invalid contracts, authentication or permission failures, or deterministic verification failures.
- After five failed attempts, move the job to `Queue/Dead Letter`, release claims only after termination is confirmed, and attach the last error plus recovery action to Linear.
- Queue messages contain identifiers and the bounded work contract, never a transcript. Runner acceptance is not completion; a terminal callback or equivalent terminal observation releases the lease.

## Context and handoff limits

The orchestrator keeps a roster, dependency graph, and bounded result per child. It does not keep worker conversation history.

- Queue envelope: at most 16 KB.
- Task brief: at most 2,000 characters.
- Constraints: at most 800 characters.
- Artifact links: at most 20; label at most 120 characters.
- Worker result summary: at most 1,200 characters.
- Final response echoed to Linear: at most 1,500 characters, followed by a link to the full artifact when truncated.

These limits are authoring targets until the connector has an allowlisted UTF-8 envelope validator. Over-limit issues are not ready and must be rejected rather than silently truncated. Required links must be accessible to the worker and target a bounded section or excerpt; links do not hide unbounded required context.

Never copy these into the orchestration prompt:

- secrets, tokens, environment dumps, or provider credentials;
- full issue descriptions or comment threads when a stable Linear URL exists;
- full agent transcripts or session exports;
- raw build logs, diffs, generated files, screenshots, or traces;
- the full agent profile or unbounded webhook passthrough fields;
- repeated parent context already present in the child contract.

A worker handoff contains only:

```yaml
status: complete | blocked | failed
summary: Bounded outcome or blocker.
changedPaths: []
verification:
  - command: exact command
    result: passed | failed
artifacts: []
pr: https://...
risks: []
nextAction: One concrete action, only when needed.
```

## Conflict protocol

1. An agent that discovers an undeclared path stops before editing it.
2. It checks the active path claims in Linear and the live agent roster.
3. If the path is unclaimed, the orchestrator extends the contract.
4. If claimed, split the work at a stable interface or add a `blocked by` edge. Do not let both agents “work it out later.”
5. The worker rebases and resolves conflicts in its own worktree before review.
6. The merge owner resolves only integration-order conflicts; semantic conflicts return to the owning worker.

In-process agents use IRC for immediate collision coordination. Linear remains the durable record of ownership, dependencies, and decisions.

## Completion rules

A child issue moves to In Review only when:

- acceptance criteria are addressed;
- all required focused verification passed; a proven pre-existing or environment-only failure requires an explicit waiver from the named merge owner;
- changed paths match the declared scope;
- the branch is rebased on current `main`;
- a PR URL and bounded handoff are attached.

It moves to Done only after the merge owner merges it and final verification passes. Parent issues close only after every required child is Done and the integrated behavior is verified.

## Current implementation boundary

Current operation is manual admission: one dispatcher enforces the queue labels, claims, and WIP limits before delegation. The deployed Linear Agent Worker enforces atomic admission, fenced leases with heartbeats, reconcile parking, and dead-letter surfacing; retry classification with backoff, Linear-session attempt identity, and branch-mutation fencing remain unimplemented. Automated delegation remains disabled by policy until the remaining contract is implemented and verified.
