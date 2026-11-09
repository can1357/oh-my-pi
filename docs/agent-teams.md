# Agent Teams

> Declarative, in-session teams: `/team start` spawns subagents from one
> markdown file and gives them handles for `agent://` messaging. Tasks are
> coordinated through `team://` and can persist in an optional shared workspace.
> Enable with `team.enabled: true` (off by default).

## Status

Implemented. A team is a group of **in-session teammates** spawned through the
shared subagent seam (`spawnSubagentForSession`) - not separate terminals, not
A2A peers, and not a new kind of session. They are ordinary kept-alive
subagents with their own context, registry rows and transcripts. `/team start`
records which refs belong to the team. `/team stop` requests cooperative release;
`/team stop --force` releases matching refs immediately with tombstones
(transcripts kept, revive available). Neither targets an unrelated replacement
that happens to share a handle.

## What it is

- a **team file** `.omp/teams/<name>.md` or `~/.omp/agent/teams/<name>.md` (project scope wins by team name)
  listing `name`, `description`, optional `workspace`, optional `context`,
  optional initial `tasks` titles, optional `planApproval`, and `members` (each
  an existing agent definition + `handle` + optional `role` and `planApproval`);
- **teammates**: one subagent per member, spawned with the normalized handle as
  its registry id. The handle is normalized by the same `sanitizeAgentId` the
  registry uses (48-character cap), so `agent://<handle>` always addresses the
  real id, and status, stop and the rendered context/peer list agree on it;
- **direct messaging**: team members without full `write` access receive a
  coordination-only write capability limited to `agent://` and `team://`.
  It does not grant disk, `local://`, `xd://`, or other writes. Definitions
  that already grant `write` keep that access. In plan mode the team grant is
  withheld, preserving plan-mode restrictions. Bundled scout/reviewer spawns
  outside teams are unchanged. Messages use the existing IrcBus and ingress
  guard;
- **idle notices**: when a member finishes a running turn and becomes idle,
  the team's lead receives its id, a short excerpt and an `agent://` link.
  The notice is not a request and does not require an automatic reply.
- **plan approval**: a team or member with `planApproval: true` starts with a
  separate tool gate. It can read, search, wait and coordinate while waiting
  for its actual lead to approve its submitted plan. A member's explicit
  `planApproval: false` overrides a team-wide requirement. Approval removes
  only this gate; it never grants new tools or disk write permission to
  read-only roles.
- **team role prompts**: read-only definitions and definitions with
  `team: false` require a `team-prompt` to join a team. The path must be a
  non-empty relative path whose resolved real path stays inside the agent
  definition's directory. Invalid or unreadable prompts are recorded on the
  definition; `/team start` rejects the affected member before creating a
  workspace or spawning members, while normal subagent spawns remain available.
  A team prompt replaces the normal role body for team spawns only. Writable
  definitions need no team prompt unless `team: false`;
  bundled scout and reviewer include team variants;
- **task coordination**: `read team://<team>/tasks` lists task IDs, titles,
  owners, statuses and notes. The lead adds a title with
  `write team://<team>/tasks`. A member claims an open task with
  `write team://<team>/tasks/<id>/claim`; its owner or the lead can release it
  with `/release` or complete it with `/done` (the write body becomes the note).
  Claims are atomic across teams sharing a workspace. A released task is open
  again. The caller's session determines its identity, not the write body.
  Added titles are trimmed and must not contain line breaks. Multi-line completion
  notes remain intact, with continuation lines indented in the generated view.
  If a view update fails after the ledger commit, the error says the mutation
  committed; the view is regenerated on the next operation.
- an optional **shared workspace**: `workspace:` is resolved relative to the
  team file and added to each child's additional directories, not substituted
  for its working directory. The workspace's `tasks.json` is the authoritative
  ledger; `TASKS.md` is a generated view. Teams using the same canonical
  workspace share one ledger. Without a workspace the ledger is in memory and
  isolated to the team generation. Existing ledgers are never reseeded; if an
  old `TASKS.md` exists without `tasks.json`, startup refuses to overwrite it
  and requires migration.
- **commands**: `/team list`, `/team start <name> [assignment]`,
  `/team status [name]`, `/team stop [--force] <name|handle|all>`,
  `/team approve <handle>`, and `/team reject <handle> <reason>`. A spawn whose registry ref
  does not appear in time is reported as *pending* (with its reserved id); a
  retry skips it instead of spawning a duplicate. Once the run registers, the
  member is live; if the run ends without registering, `/team status` and
  `/team stop` report it as failed and the next `/team start` starts it again.
  Member ids are reserved exclusively across every session in the process.
  `team.maxTeammates` (default 4) caps members per start.

## What it is not

- **Not cross-terminal.** Teammates live in the lead's process. Cross-terminal
  delegation is the separate `a2a:<name>` spawn path.
- **No file-backed mailbox or split-pane display.** Delivery and cooperative
  stop requests use existing IRC queues and wake turns; notifications are
  not requests and do not create automatic reply obligations.
- **No team-lead type or team config file beyond the `.md` itself.** The lead
  is whatever session ran `/team`.

## Quick start

1. Enable the gate: `/settings` → Tasks → Teams → **Agent Teams** (or `team.enabled: true`).
2. Create `.omp/teams/audit.md`:

```markdown
---
name: audit
description: Log-audit crew
workspace: ./ws
tasks:
  - Collect logs
  - Verify findings
planApproval: true
members:
  - agent: scout
    handle: Scout
    role: Collect logs
    planApproval: false
  - agent: reviewer
    handle: Reviewer
    role: Verify findings
context: |
  Coordinate task ownership through team://audit/tasks.
---
Audit covers services X and Y; the lead collects the final report.
```

3. `/team start audit run the audit` - members spawn with handles `Scout` and
   `Reviewer`, the workspace ledger and view are created, and they appear in the
   Agent Hub. Read `team://audit/tasks` to inspect work. Message members with
   `write agent://Scout`; inspect them with `/team status audit`; release them
   with `/team stop audit` (or `/team stop --force audit` for immediate release).

## Plan submission and approval

`planApproval` must be a YAML boolean. Set it on the team to require approval
for all members, or on individual members; an explicit member value always
overrides the team value. Omitted settings do not add a gate. Malformed values
are refused rather than silently starting an ungated teammate.

Until approval, the exact allowed tool names are `read`, `grep`, `glob`,
`lsp`, `web_search`, `wait`, and `write` targeting `agent://` or `team://`
coordination URLs. `lsp` is limited to read-only actions (for example, hover,
definitions and diagnostics); rename, all `code_actions` calls (including
listing), raw requests and other state-changing actions are blocked. Other tools, disk writes and `xd://`
dispatch are blocked:

```text
plan approval required: send it via write team://audit/plan
```

This is not session plan mode: IRC wake turns remain enabled. Gated sessions
consult the main runtime for each call, including worker calls and
extension-rewritten arguments. The gate remains closed if its authority cannot
be reached, including after revival with stale membership. Teammates started
without an approval requirement remain usable after their team ends or they
are cold-revived; approval itself is never persisted as a grant.

1. The member submits its plan as the content of `write team://audit/plan`.
   Its trusted session identifies the author; the URL/body cannot select
   another author. The actual lead receives a non-request notification.
2. The lead runs `/team reject Reviewer Explain how you will verify the result`.
   The member receives the reason, and the gate stays closed. The member can
   revise and submit again through the same URL.
3. The lead runs `/team approve Reviewer` after submission. Approving without
   a submitted plan is refused and leaves the gate closed.

Only the current lead can approve or reject its members. Ambiguous handles,
nonmembers, stale generations and replaced refs are refused. Approval belongs
to that member's generation, not to any later replacement. A writable member
can mutate after approval; a read-only scout/reviewer still has only its
original tools and coordination-only write capability.

## Implementation

`task/teams.ts` discovers and parses team files, normalizes handles, and renders
the per-member context/prompt. The main-owned team runtime manages membership
and the task ledger; the thread service routes worker operations to it.
`slash-commands/builtin-teams.ts` implements `/team`.
`task/spawn-subagent.ts` forwards team spawn metadata through
`task/structured-subagent.ts` and the session/tool creation path, where a
coordination-only write capability is enforced. Settings:
`team.enabled` / `team.maxTeammates` / `team.stopAckTimeoutMs`. The design contract is
[`docs/specs/2026-11-06-agent-teams-design.md`](./specs/2026-11-06-agent-teams-design.md).

## Source

- Teams: `packages/coding-agent/src/task/teams.ts`, `packages/coding-agent/src/slash-commands/builtin-teams.ts`
- Spawn seam: `packages/coding-agent/src/task/spawn-subagent.ts`, `packages/coding-agent/src/task/structured-subagent.ts`
- Peer messaging: `packages/coding-agent/src/irc/`
- Registry / lifecycle: `packages/coding-agent/src/registry/`
- Fork notes: `README-EN.md`, `README-RU.md`, `FORK-RU.md`
