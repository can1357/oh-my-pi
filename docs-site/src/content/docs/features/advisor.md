---
title: Advisor
description: The optional second model that reviews each primary turn and injects weighted advice back into your session.
coverage: B
---

The advisor is an optional second model that watches your session from the side. After each primary turn it reviews the new transcript, inspects the workspace with its own tools, and injects concise advice back into your chat as `<advisory>` notes. It is a reviewer, not a peer — it cannot approve actions or change primary session state directly.

## Enabling it

Two things are required:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

Without `modelRoles.advisor` resolving to an available model, `/advisor status` reports the setting is enabled but no advisor model is assigned.

For one-off headless runs, `--advisor` enables the advisor for a single print-mode process without persisting `advisor.enabled`:

```bash
omp -p --advisor "Review this task."
```

In print mode, advisor notes continue to steer the live turn while a primary prompt is running. After the final prompt settles, print mode preserves late advisor notes without starting hidden primary turns, then waits up to ten minutes for final reviews. Failed automation exits after a 30-second drain budget.

## Slash commands

| Command | Effect |
| --- | --- |
| `/advisor` | Toggle the advisor for this session (session-scoped; does not change persisted `advisor.enabled`). |
| `/advisor on` | Enable the advisor for this session. Session-scoped; not persisted. |
| `/advisor off` | Disable the advisor and stop the runtime. Session-scoped; not persisted. |
| `/advisor status` | Show active model, context usage, token usage, and cost. |
| `/advisor dump` | Copy the advisor's compact transcript to the clipboard. |
| `/advisor dump raw` | Copy the advisor's full transcript (system prompt, tools, thinking, and calls) to the clipboard. |

## Severity: nit / concern / blocker

The advisor's `advise` tool takes a note and an optional severity. How the note is delivered depends on the severity:

| Severity | Delivery | Use it for |
| --- | --- | --- |
| omitted / `nit` | Non-interrupting aside, batched into the primary transcript at the next step boundary. | Cleanup, simplification, low-risk edge cases. |
| `concern` | Interrupting steering message when delivery constraints allow it; otherwise preserved as a visible card. A late terminal-answer `concern` is preserved as a card rather than waking the agent. | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker` | Interrupting steering message when delivery constraints allow it. Unlike `concern`, a `blocker` raised on a terminal answer normally steers a triggered turn. | Continuing would clearly waste work or produce broken output. |

Each note renders into the primary transcript as `<advisory severity="…" guidance="weigh, don't blindly obey">note text</advisory>`. Notes are XML-escaped so a `<` or `>` inside the advice cannot break the wrapper.

A normal agent-driven yield is treated differently from a deliberate interrupt (Esc, or a cancel from collab, ACP, RPC, the SDK, or an extension):

- **While the loop is still streaming**, the note normally steers into the live turn.
- **Once the loop has yielded and gone idle**, delivery keys on how the turn ended. If the primary's tail is a terminal text answer with no queued work, a late `concern` is preserved as a card rather than waking the agent to restate a completed turn; it re-enters context on the next resume (a new message, `.`/`c`, or a steer/follow-up). A `blocker` is the exception — it normally steers a triggered turn.
- **Otherwise** (the agent yielded mid-work, no terminal answer), an idle `concern`/`blocker` normally triggers a fresh turn.

Two session/client constraints override that:

- **Plan mode** preserves every would-be advisor steer as a visible card, even while the primary loop is streaming, because only user-driven turns converge on ask/resolve.
- **ACP with `deferAgentInitiatedTurns`** preserves an idle would-be steer when the bridge has not allowed agent-initiated turns.

## Dedupe and escalation behavior

Two mechanisms keep the advisor from spamming the primary transcript with the same note or firing too often.

**Emission guard (dedupe).** Before a note reaches the steering channel or the transcript, it is normalized (lowercase, NFKC, runs of non-alphanumeric characters collapsed to single spaces, trimmed) and:

1. Content-free phrases from a small allowlist (`stop`, `done`, `complete`, `no issue continue`, `lgtm`, `nothing to add`, `no further input`, and similar) are suppressed silently — silence is the correct expression of "no concerns".
2. Any normalized note already accepted in this session is dropped. The dedupe history is bounded by a FIFO ring (default 4096 entries).
3. At most one note per advisor model `prompt()` cycle is accepted; a noise call doesn't displace a real concern that follows in the same update.

Suppression is invisible to the advisor model — `AdviseTool` still returns `Recorded.` for a dropped call, so the advisor can't see "suppressed" and rephrase around it. The guard's state clears on every advisor reset (compaction, session switch, `/new`).

**Interruption cooldown.** `advisor.immuneTurns` limits how often the advisor can interrupt. After a successful `concern` or `blocker` is delivered through the steering channel, later concerns/blockers are routed as non-interrupting asides until the configured number of primary turns has completed. The default is `3`. `nit` notes are unaffected.

**Bounded catch-up with `advisor.syncBacklog`.** This isn't lockstep execution — it's a bounded wait so the primary agent doesn't run ahead of review. Allowed values are `off`, `1`, `3`, or `5`. On primary turn end, if `advisor.syncBacklog` is not `off`, the primary waits only while advisor backlog is at or above the configured threshold, capped at 30 seconds. `1` is closest to synchronous review; `3` and `5` allow more lag. After three consecutive advisor failures, the runtime logs a warning, drops the backlog, and lets the session continue.

## What the advisor sees and when it resets

Each advisor update receives only the new transcript delta since the last update, rendered with thinking and tool intent included. Advisor messages already injected into the primary transcript are filtered out before the next delta so the advisor doesn't recursively review its own advice. Most hidden `custom` messages collapse to a one-line summary; the exception is primary agent constraint context (e.g. plan-mode rules), which renders verbatim inside a `<primary-context kind="…">` wrapper.

The advisor runtime resets when the primary transcript is rewritten:

- compaction
- session switch/resume
- branch/fork-style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor; the next advisor update replays the current bounded primary transcript. When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length instead of replaying everything.

## Tools and isolation

The advisor has its own agent and a `ToolSession` id suffixed `-advisor`. It does not share the primary agent's file snapshots, seen-lines tracking, conflict state, summary cache, or edit/yield capabilities. Its default toolset is read-only: `read`, `grep`, `glob`, plus `advise`.

A `WATCHDOG.yml` roster entry can broaden `tools:` to any built-in, including mutating ones (`edit`, `write`, `bash`, `eval`, `browser`, `debug`, `ast_edit`, `task`, `hub`, and the memory tools). Grant those only when the advisor model and workspace are trusted — advisor grants are not routed through the primary agent's approval wrapper, so a granted mutating tool invokes directly, subject only to its own runtime guards.

:::caution
Tool names outside `BUILTIN_TOOL_NAMES` are dropped with a warning. Legacy aliases (`search`→`grep`, `find`→`glob`) are normalized.
:::

## Transcript persistence and observability

Every finalized advisor turn is appended to a JSONL inside the owning session's artifacts dir:

- main session: `<session>/__advisor.jsonl`
- subagent advisor (`advisor.subagents: true`): `<session>/<SubId>/__advisor.jsonl`

The path is derived from the session file (not the artifacts dir, which subagents share with their parent), so each advisor writes a distinct file. The reserved `__advisor` stem cannot collide with a task subagent's `<id>.jsonl`. The file follows session switches: on `/new`, resume/switch, and branch, the recorder reopens at the new session's path on the next advisor turn; before a `/drop` deletes the old artifacts dir, the recorder feed is detached and drained so a queued write cannot recreate the deleted file. The on-disk log is append-only and independent of the in-memory context — re-primes and compaction never truncate it.

Two practical consequences:

- **`omp stats` attribution.** Because `omp stats` scans each session folder recursively, advisor assistant turns (with their usage and cost) are attributed to the same project/session like any other subagent. Advisor "session update" prompts are persisted as `synthetic`, agent-attributed user messages so they never inflate user-message metrics.
- **Agent Hub.** The Agent Hub discovers `__advisor.jsonl` on open and shows it as a read-only `advisor`-kind transcript under its owning session.

The advisor is never a peer. The `advisor`-kind registry ref is excluded from the `hub` peer roster, broadcast targets, the subagent peer prompt, and the `history://` index/lookup/completions — it cannot be messaged (`hub` send and collab chat refuse it) or revived/killed from the Agent Hub or collab.

## Subagents

`advisor.subagents` controls whether spawned task/eval subagents also get an advisor runtime:

- `false` (default): only the main session can run an advisor.
- `true`: eligible subagent sessions build their own advisor with the same settings/model-role resolution, then re-run `WATCHDOG.md` discovery for that subagent session's `cwd` and agent directory.

Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `advisor.enabled` | `false` | Master switch for the advisor runtime. |
| `modelRoles.advisor` | unset | Model assigned to the advisor role. Provider-prefixed ids, canonical ids, and `:level` thinking suffixes are supported. |
| `advisor.immuneTurns` | `3` | Primary turns to wait before another `concern`/`blocker` can interrupt. `nit` notes are unaffected. |
| `advisor.syncBacklog` | `off` | Bounded catch-up wait: `off`, `1`, `3`, or `5`. Caps the wait at 30 seconds. |
| `advisor.subagents` | `false` | Whether spawned task/eval subagents also get an advisor runtime. |
| `WATCHDOG.md` | — | Advisor-only guidance; loaded from `<active agent dir>/WATCHDOG.md` plus project files walked from `cwd` upward. |
| `WATCHDOG.yml` | — | Advisor roster declaring one or more named advisors, each with its own model, tool grant, and specialization prompt. |
