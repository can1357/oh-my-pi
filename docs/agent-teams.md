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
records which ref ids belong to the team; `/team stop` releases exactly those
ids with tombstones (transcripts kept, revive available) and never touches an
unrelated ref that happens to share a handle.

## What it is

- a **team file** `.omp/teams/<name>.md` or `~/.omp/agent/teams/<name>.md` (project scope wins by team name)
  listing `name`, `description`, optional `workspace`, optional `context`,
  optional initial `tasks` titles, and `members` (each an existing agent
  definition + `handle` + optional `role`);
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
  `/team status [name]`, `/team stop <name|all>`. A spawn whose registry ref
  does not appear in time is reported as *pending* (with its reserved id); a
  retry skips it instead of spawning a duplicate. Once the run registers, the
  member is live; if the run ends without registering, `/team status` and
  `/team stop` report it as failed and the next `/team start` starts it again.
  Member ids are reserved exclusively across every session in the process.
  `team.maxTeammates` (default 4) caps members per start.

## What it is not

- **Not cross-terminal.** Teammates live in the lead's process. Cross-terminal
  delegation is the separate `a2a:<name>` spawn path.
- **No file-backed mailbox, idle notification, split-pane display, or
  shutdown request/approve flow.** Delivery uses the existing IRC queues and
  wake turns; termination is `/team stop` (a lifecycle release), not a
  negotiation.
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
members:
  - agent: scout
    handle: Scout
    role: Collect logs
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
   with `/team stop audit`.

## Implementation

`task/teams.ts` discovers and parses team files, normalizes handles, and renders
the per-member context/prompt. The main-owned team runtime manages membership
and the task ledger; the thread service routes worker operations to it.
`slash-commands/builtin-teams.ts` implements `/team`.
`task/spawn-subagent.ts` forwards team spawn metadata through
`task/structured-subagent.ts` and the session/tool creation path, where a
coordination-only write capability is enforced. Settings:
`team.enabled` / `team.maxTeammates`. The design contract is
[`docs/specs/2026-11-06-agent-teams-design.md`](./specs/2026-11-06-agent-teams-design.md).

## Source

- Teams: `packages/coding-agent/src/task/teams.ts`, `packages/coding-agent/src/slash-commands/builtin-teams.ts`
- Spawn seam: `packages/coding-agent/src/task/spawn-subagent.ts`, `packages/coding-agent/src/task/structured-subagent.ts`
- Peer messaging: `packages/coding-agent/src/irc/`
- Registry / lifecycle: `packages/coding-agent/src/registry/`
- Fork notes: `README-EN.md`, `README-RU.md`, `FORK-RU.md`
