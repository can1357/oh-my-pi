# Agent Teams

> Declarative, in-session teams: `/team start` spawns subagents from one
> Markdown file, with direct `agent://` messaging and `team://` task coordination.
> Enable with `team.enabled: true` (off by default).

## Status and scope

Implemented. Teammates are ordinary kept-alive subagents with their own context,
registry rows and transcripts, spawned through `spawnSubagentForSession`. They
live in the lead's omp process, not separate terminals or A2A peers. The lead is
the actual session that starts the team; it need not be Main. Team prompts direct
members to coordinate with peers and report to that lead, not an assumed Main.

There is no separate team-lead agent type, file-backed mailbox, team panel or
split-pane display. Members appear in the existing Agent Hub; `/team status`
provides textual status. Cross-terminal delegation remains the separate
`a2a:<name>` spawn path, not cross-terminal team membership.

## Quick start

1. Enable `/settings` → Tasks → Teams → **Agent Teams** (or set
   `team.enabled: true`).
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

3. Run `/team start audit run the audit`. With no ID collisions, members spawn
   as `Scout` and `Reviewer` and appear in the Agent Hub. The optional workspace
   gets an authoritative `tasks.json` ledger and a generated `TASKS.md` view.
4. Read `team://audit/tasks`, message a member with `write agent://Scout`, and
   inspect `/team status audit`. The reviewer must submit a plan before mutation
   tools can pass the approval gate; approval still does not grant this read-only
   role repository write access.
5. Request `/team stop audit`, or use `/team stop --force audit` for immediate
   release. See [Cooperative stop](#cooperative-stop) for responses and timeouts.

## Team definitions and startup

Team files are discovered in project `.omp/teams/<name>.md` and user
`~/.omp/agent/teams/<name>.md` directories; project scope wins by team name.
`name`, `description` and a non-empty valid `members` list are required. Members
reference existing agent definitions by `agent`, with a `handle` and optional
`role`. The file body is the standing instruction; `context` is shared with every
member, and `/team start <name> [assignment]` adds the assignment to the body.
Malformed files are warned about and skipped; an unknown agent prevents startup.

Optional fields:

| Field | Meaning |
|---|---|
| `workspace` | Directory resolved relative to the team file. Added to each child's additional directories, not substituted for its working directory. Omit it for an in-memory task ledger. |
| `tasks` | Initial list of non-empty, single-line task titles, in ID order. An empty list is valid. Only seeds a newly created ledger. |
| `planApproval` | YAML boolean requiring approval for all members when `true`; omitted means no requirement. |
| Member `planApproval` | YAML boolean overriding the team value, including explicit `false`. Invalid boolean values cause the team file to be skipped. |

Handles use the registry's `sanitizeAgentId` normalization, including its
48-character cap. Handles that collide after normalization within the selected
members are refused. Existing process-wide IDs can produce a suffixed reserved
ID; use the actual ID shown by startup/status and in the rendered peer list for
`agent://` messages. Reservations are exclusive across sessions in the process.

`team.maxTeammates` defaults to 4: each start selects the first members up to the
cap and reports skipped members. Repeating start skips already recorded live or
pending members rather than duplicating them. A spawn that has not registered
within the spawn wait is **pending**, with its reserved ID, not failed merely
because time elapsed. Registration makes it live; a rejected registration (a
run ending without registering, a spawn that fails before it, or a worker lost
before its ref appears) is reported as failed by status/stop, and the next
start can retry it.

## Role prompts and permissions

An agent definition may declare `team-prompt: worker-team.md` in its frontmatter.
The non-empty path is relative to that definition's directory; its resolved real
path must stay inside that directory, including through symlinks. Missing,
unreadable or invalid references are recorded with the definition and path;
`/team start` refuses an affected selected member before workspace creation,
ID reservation or spawning. A broken team prompt does not disable ordinary
non-team spawns.

A team prompt replaces the normal role body **only for team spawns**. Writable
definitions may use their normal body if no team prompt is supplied. Read-only
or empty-tool definitions, and definitions declaring `team: false`, need a team
prompt to join. `team: false` with a valid team prompt is accepted; `team: true`
alone does not make a read-only definition compatible. Bundled scout/reviewer
include embedded team variants retaining their substantive investigation/review
instructions and repository mutation prohibition while allowing coordination
and a report to the actual lead. Ordinary scout/reviewer spawns are unchanged.

Members without a full `write` grant receive **coordination-only write** to
`agent://` and `team://`, not disk, `local://`, `xd://` or other targets. The
normalized scheme and coordination scope are checked regardless of xdev; tools
remain directly callable rather than requiring forbidden device writes. Existing
full-write grants stay full. The restricted capability survives tool rebuilding
and cold revival. Session plan mode still withholds the added grant; the team
approval gate below is separate from session plan mode.

## Task protocol

The main-owned runtime authenticates every `team://` call against the trusted
session, current team generation and registered lead/member ref. The URL and
write body cannot impersonate a member. Workers route to the same runtime through
the thread service. Nonmembers, stale generations and replaced refs are refused.
`team://` is handler-backed coordination, not an editable path to `tasks.json`.

These are all supported operations; examples use the team above. `write` bodies
are tool content, not extra URL segments.

| Operation | Authorized caller | Example body / result |
|---|---|---|
| `read team://audit/tasks` | Lead or member | JSON array of `{id, title, owner, status, note}` rows. |
| `write team://audit/tasks` | Lead only | `Inspect service Z` adds a title. |
| `write team://audit/tasks/1/claim` | Lead or member | Empty body; identity comes from the session. Returns `claimed` or `already-owned` with `owner`; a conflict errors with the current owner's ID. |
| `write team://audit/tasks/1/release` | Owner or lead | Empty body; clears owner and note and reopens the task. |
| `write team://audit/tasks/1/done` | Owner or lead | `Collected logs; report sent to lead.` becomes the completion note. |
| `write team://audit/plan` | Member only | `Inspect the logs, compare findings, then report evidence.` submits the caller's plan. |
| `write team://audit/stop/<requestId>` | Targeted current member only | `ack` or `decline: Still collecting evidence`; use the request ID from the stop message. |

Task IDs are positive decimal strings (`"1"`, `"2"`, …). Only the task-list URL
can be read; plan and stop URLs are write-only. Unknown IDs, malformed paths,
query parameters and fragments are refused.

For example, after Scout writes to `team://audit/tasks/1/claim`, the first row is:

```json
{"id":"1","title":"Collect logs","owner":"Scout","status":"open","note":""}
```

A second claimant gets a conflict naming `Scout`; repeating Scout's claim is an
idempotent `already-owned` result. Completion changes status to `done`, retains
the owner and records the body verbatim as the note. A done task cannot be
claimed until its owner or lead releases it. Added titles are trimmed, non-empty
and single-line; multi-line completion notes remain intact, with continuation
lines indented in the generated view.

### Persistence and migration

With a workspace, `tasks.json` is the authoritative JSON array. New ledgers seed
`tasks` in input order with `owner: null`, `status: "open"` and `note: ""`;
lead additions use the next unused positive numeric ID. Existing ledgers retain
tasks and ownership across team restarts and are never reseeded. `TASKS.md` is a
generated view: **do not edit it to change tasks**.

Initialization, reads and read-check-write operations share a process-wide mutex
keyed by the canonical `tasks.json` path. Two teams sharing a canonical workspace
intentionally share its ledger and lock. Ledger replacement uses a same-directory
temporary file and atomic rename, then regenerates the view. If view generation
fails after commit, the error explicitly says the mutation committed; the next
operation/start regenerates the view. Do not assume that error means no change.

**The mutex protects only one omp process.** It does not prevent direct external
edits to `tasks.json`. Other omp processes must not share the workspace
concurrently; this is not a cross-process lock or a multi-process task service.
Without a workspace, the ledger is isolated in memory to the team generation;
it is not saved to the session cwd and is lost when that generation ends.

An existing `TASKS.md` without `tasks.json` causes startup to refuse with
`exists without tasks.json; migrate the existing tasks before starting` rather
than overwriting legacy data. Before restarting, preserve the old file and either
convert its tasks to the JSON row format above or move it aside so a fresh ledger
can be seeded. Do this while no process is using the workspace. Invalid JSON or
malformed ledger rows also fail closed; they are not silently replaced.

## Idle notices and messaging

On each real `running → idle` transition, the runtime sends the current member's
actual lead one non-request notice containing the member ID and an
`agent://<actual-id>` link. When the registered session exposes the completed
assistant turn, the notice includes its first three lines, capped at 500
characters. If that turn has no text, the excerpt comes from its final
`yield`/`handback` call arguments; without either, the summary line is omitted.
Repeated idle events do not duplicate a notice; a later completed running turn
produces a new one. A text stop followed by a yield-reminder turn can therefore
produce two notices. Delayed events from replaced refs or old team generations
do not notify for replacements. Delivery can fail under the ordinary IRC guard
or recipient availability constraints.

Idle notices, plan submissions, approval/rejection notices and stop
decline/timeout notices are displayed as **team notices, no reply needed**.
They are informational: they impose no automatic reply obligation or wake-relay
loop, and they count as neither a reply nor a promise of one. A notice addressed
to an agent wakes that agent's reply `wait` (including a member waiting for plan
approval), but it never interrupts a wait on its own background jobs or
services: there it stays queued and is delivered as an aside once the wait
returns. Ordinary progress messages retain their “reply follows later”
presentation and do not end waits. This is different from ordinary request
wake-relay, which returns a woken subagent's turn output to the requester and is
not an idle notification. Direct peer messages keep the existing IRC ingress
guard.

## Cooperative stop

```text
/team stop [--force] <name|handle|all>
```

The invoking lead can target a whole live team, one member handle/actual ID, or
all its live teams. Ambiguous targets are refused rather than choosing another
team's member. Stop uses recorded runtime membership, including when a team file
has disappeared, and never releases an unrelated replacement with the same ID.

Without `--force`, stop returns promptly after recording/sending a wakeable IRC
control request, containing a unique request ID and reply URL. It does not
immediately release a running member. For example, if the request provides
`team://audit/stop/abc-123`, the targeted member responds with either:

```text
write team://audit/stop/abc-123    body: ack
write team://audit/stop/abc-123    body: decline: Still collecting evidence
```

These are alternatives for the same request, not sequential replies:

- `ack` releases exactly the matching ref with a tombstone. Transcripts remain
  available and revive is possible; successful release removes team membership.
- `decline: <reason>` closes the request, tells the actual lead the reason and
  leaves the member live.
- No reply by `team.stopAckTimeoutMs` (default **120000 ms**, two minutes) closes
  the request and notifies the lead once. Timeout never forces release. Values
  outside 1000..2147483647 ms clamp into that range: Node/Bun `setTimeout`
  overflows past 2^31-1 ms and would otherwise fire the timeout almost
  immediately.
- Late, duplicate, wrong-member and old-generation replies cannot release a
  member. After decline/timeout, issue another stop or explicitly use `--force`.

`--force` releases matching recorded refs immediately without negotiation. A
member already aborted by cancellation, kill or crash outside `/team stop` is
also released immediately by an ordinary stop: it cannot acknowledge. A release
already in flight reports `stop already pending` instead of releasing twice.
For a still-registering spawn, cooperative or forced stop intent is retained
against its reservation and generation. On registration, the request is sent or
the exact ref is force-released; a spawn that ends without registering — a
rejected spawn, an aborted run or a worker lost before its ref appears —
resolves the intent at once, marks the member failed, and notifies the lead
(`Stop request for <id> released: never registered (<failure>)`). A
replacement generation does not inherit old stop intent.

A whole-team stop (by name or `all`) retires that generation when its members
have been removed, including final acknowledgements and pending force releases.
A handle-only stop, an outside release, a kill or any other removal of the last
member also retires the emptied generation: the runtime stops it and tells the
lead once (`Team <name> finished: no members left.`), after which normal
idle-TTL parking resumes for the lead. A whole-team stop awaiting an
acknowledgement keeps the generation live; the timeout notice leaves the
decision to the lead. A subsequent whole-team start after retirement gets a
fresh generation; a workspace ledger survives, whereas the old in-memory
ledger does not. Retirement never races a concurrent restart: only the
generation that still owns the team name is retired, so a new `/team start`
under the same name is untouched.

A session leading a current team generation is not idle-TTL parked: its timer
is re-armed so the team, active members and the lead's `/team stop` authority
remain live. After all its teams retire, normal idle-TTL parking resumes.
Genuine session termination still retires its generations without changing
member teardown ownership; Main shutdown leaves cleanup to the lifecycle manager.

Runtime-authored team traffic — stop requests, plan approval/rejection notices,
and idle, decline, timeout, failed-registration and team-finished notices sent
on behalf of a member — bypasses **only sender rate charging**. Stop requests
still undergo dedup/hop/delivery checks; the notices are progress deliveries,
which already skip dedup. Agent-authored plan submissions remain rate-limited
like ordinary progress messages. All traffic retains hop, membership/ref and
ordinary delivery/queue checks; this is not an unrestricted messaging bypass,
and the `teamControl` flag is set only by runtime code — an agent cannot claim
the exemption through any tool.

## Plan submission and approval

Until approval, the exact allowed tool names are `read`, `grep`, `glob`, `lsp`,
`web_search`, `wait`, terminal reports via `yield`/`handback`, and `write` targeting
normalized `agent://` or `team://` coordination URLs. This allowlist does not add
tools a role lacks. Terminal reports let a member finish its current turn while
awaiting approval; they do not open the mutation gate.

Allowed `lsp` actions are `diagnostics`, `definition`, `type_definition`,
`implementation`, `references`, `hover`, `symbols`, `status` and `capabilities`.
Rename, all `code_actions` calls (including listing), raw requests and other
unlisted actions are blocked. Other tools, disk writes, `edit`, `bash`, `task`
and `xd://` dispatch are blocked with:

```text
plan approval required: send it via write team://audit/plan
```

This is not session plan mode: IRC wake turns remain enabled. Every team dispatch
consults the main runtime, including worker calls and extension-rewritten final
arguments, even if local identity says approval is not required. Service failure
or invalid live membership fails closed, except `yield`/`handback` remain
available because they do not mutate team state. Only teammates originally
started without an approval requirement may otherwise continue after team/lead
authority ends, including on cold revival; approval itself is never persisted
as a grant.

1. The member submits non-empty plan text as the content of
   `write team://audit/plan`. Its trusted session identifies the author; the
   actual lead receives a non-request notification. Failed delivery does not
   produce an approvable submission.
2. The lead runs `/team reject Reviewer Explain how you will verify the result`.
   The member receives the reason, the gate stays closed and the old submission
   is cleared. It must revise and submit again through the same URL.
3. The lead runs `/team approve Reviewer`. Approval requires a successfully
   submitted plan; otherwise it is refused with instructions to submit one.
   The member receives a non-request approval notice, with no reply required.

Only the current lead can approve/reject its members. Ambiguous handles,
nonmembers, stale generations and replaced refs are refused. Approval applies to
the current submitted plan, not a revision token selected by the command; if a
member resubmits before approval, the command acts on that latest submission.
It removes only the team gate, not role restrictions: a writable member can then
mutate within existing permissions; scout/reviewer remain read-only apart from
coordination writes. Resubmission resets approval for a member that requires it.

Approval and rejection change gate state before sending their notifications.
If that delivery fails, the command reports that the plan was approved/rejected
but the notification failed; it does not roll back the decision.

## Commands and settings

All `/team` commands require `team.enabled: true`.

```text
/team list
/team start <name> [assignment]
/team status [name]
/team stop [--force] <name|handle|all>
/team approve <handle>
/team reject <handle> <reason>
```

| Setting | Default | Purpose |
|---|---|---|
| `team.enabled` | `false` | Enables the experimental `/team` commands. |
| `team.maxTeammates` | `4` | Caps members selected per start; skipped members are reported. |
| `team.stopAckTimeoutMs` | `120000` | Cooperative-stop acknowledgement deadline in milliseconds; clamped to 1000..2147483647, with no forced release on timeout. |

## Source

Paths below are repository-relative:

- Definitions/context: `packages/coding-agent/src/task/teams.ts`
- Authority/control: `packages/coding-agent/src/task/team-runtime.ts`
- Ledger/view: `packages/coding-agent/src/task/team-ledger.ts`
- URI handler: `packages/coding-agent/src/internal-urls/team-protocol.ts`
- Commands/settings: `packages/coding-agent/src/slash-commands/builtin-teams.ts`, `packages/coding-agent/src/task/settings.ts`
- Gate: `packages/coding-agent/src/session/agent-session.ts`
- Prompts: `packages/coding-agent/src/prompts/system/team-*.md`, `packages/coding-agent/src/prompts/agents/*-team.md`
- Tests: `packages/coding-agent/test/teams.test.ts`, `team-ledger.test.ts`, `team-protocol.test.ts`, `team-plan-commands.test.ts`, `agent-session-team-plan.test.ts`, and `thread/team-runtime.test.ts` under the same test directory
- Historical design and current amendment: [Agent Teams design](./specs/2026-11-06-agent-teams-design.md)
