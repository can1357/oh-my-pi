# Agent Teams

> A lead session coordinating several persistent teammates — full agent
> sessions with their own context — that message each other directly over a
> shared workspace. Enabled with `team.enabled: true` (off by default).

## What it is

The unit of delegation is a *team*, not a single spawn:

- a **lead** session the human talks to, which carries the team's task list
  and configuration;
- several **teammates**, each a separate full session with its own context
  window, spawned from an existing subagent definition (the same markdown
  frontmatter — `tools`, `model`, `effort`, and the prompt body — that the fork's
  agent discovery already reads);
- **direct teammate-to-teammate messaging** — a teammate can message another
  teammate without routing everything through the lead;
- a **shared task list** that teammates claim items from, so the team
  self-schedules instead of the lead dispatching every unit of work;
- a **mailbox per agent** (file-backed message queue) so messages survive while
  their recipient is busy, plus an **idle notification**: a teammate that goes
  idle notifies the lead with its final answer;
- a **team config file** listing the members (the lead carries type
  `team-lead`), and a **shutdown request/approve flow** for ending a teammate
  cleanly;
- an **in-process vs split-pane** display: teammates either render as inline
  cards in the lead's TUI or as separate tmux/iTerm2 panes;
- the whole surface gated behind an experimental env flag, not on by default.

The fork's analog keeps that shape but grounds it in mechanisms omp already
has: teammates are real omp sessions reachable over the A2A bridge (full
context, own transcript, steerable — unlike an in-context subagent spawn),
coordination rides the same `agent://`/IrcBus messaging, and the shared
workspace is the plain filesystem the sessions already share.

## Quick start

1. Enable the gate: `/settings` → Tasks → Teams → **Agent Teams** (or `team.enabled: true`).
2. Create `.omp/teams/audit.md`:

```markdown
---
name: audit
description: Log-audit crew
workspace: ./ws
members:
  - agent: scout
    handle: Scout
    role: Collect logs
  - agent: reviewer
    handle: Reviewer
    role: Verify findings
context: |
  Claim tasks in TASKS.md (owner: <handle>).
---
Audit covers services X and Y; the lead collects the final report.
```

3. `/team start audit "run the audit"` — members spawn with stable handles
   (`Scout`, `Reviewer`), visible in the Agent Hub; message them via
   `write agent://Scout`; `/team status audit`, `/team stop audit`.

## Implementation

Members spawn through the shared subagent seam (`handle` → registry id,
`teamWorkspace` → the child's additional directories); teammate↔teammate and
lead↔teammate messaging ride the existing `agent://` IrcBus with its ingress
guard; the lead receives final answers through the existing wake relay;
`/team stop` releases members through the lifecycle manager with tombstones
(transcripts kept, revive available). Files: `task/teams.ts` (discovery +
parsing + render), `slash-commands/builtin-teams.ts` (`/team`), settings
`team.enabled` / `team.maxTeammates`. Design contract:
[`specs/2026-11-06-agent-teams-design.md`](./specs/2026-11-06-agent-teams-design.md).

### Built on

These primitives were already implemented and are reused:

| Primitive | What it provides | Where |
| --- | --- | --- |
| A2A bridge | Every terminal runs an Agent2Agent v1.0 JSON-RPC server on `127.0.0.1` (bearer-token auth); sessions in different processes discover and address each other | [`a2a/` sources](#source) |
| Peer auto-registration | Live local bridges register each other's skills as spawnable `a2a:<name>` agents at session start | `a2a.autoRegister` |
| Addressed delivery + reply channel | A message to a peer's agent is delivered into its chat; the peer's reply comes back as an incoming message via a reply-envelope spawn | `sendA2aMessage` |
| IrcBus | In-session `agent://` messaging between any two agents, with the ingress guard (rate, dedup, hop limits) | `irc/bus.ts` |
| Markdown agent definitions | Teammate definitions would reuse the existing per-agent frontmatter (`tools`, `model`, `effort`, prompt body) from agent discovery | [task agent discovery](./task-agent-discovery.md) |
| Workflow orchestration | Deterministic `agent()`/`parallel()`/`pipeline()` scripting with journal resume — a lead-side fan-out mechanism already exists | [workflow](./tools/workflow.md) |
| Agent Hub | The human-facing live roster for watching and steering agents | [Agent Hub](./agent-hub.md) |

What separates today's state from a team: there is no persistent team
membership (the roster is a flat set of discovered peers), no shared task list
or claim protocol, no per-agent mailbox with idle notification, no team
config file, and no lifecycle flow for asking a teammate to shut down. The
`a2a:` agents that exist today are request/response spawn targets; a teammate
must be a long-lived peer with standing membership.

## Design

The design for this feature is being developed in
[`docs/specs/2026-11-06-agent-teams-design.md`](./specs/2026-11-06-agent-teams-design.md).
Once implemented, that document is the contract and this page becomes the
user-facing reference.

## Source

- Bridge: `packages/coding-agent/src/a2a/` (server, client, agent bridge, RPC)
- Peer messaging: `packages/coding-agent/src/irc/` (bus, ingress guard)
- Agent definitions: `packages/coding-agent/src/discovery/agent-plugin-format.ts`
- Fork notes: `README-fork.md`, `FORK-RU.md`
