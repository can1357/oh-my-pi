# Agent Hub

Agent Hub is the interactive TUI for watching and controlling subagents associated with the current session. It combines a live roster, per-agent activity and usage, transcript access, steering, revive, and kill controls. The main agent is not listed because its conversation is the ambient session view.

The Hub also discovers parked subagents from the current session's persisted artifacts when a session is resumed. Advisor transcript files appear as read-only rows.

## Open the Hub

| Input          | Behavior                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `Alt+A`        | Open or close Agent Hub through `app.agents.hub`. This opens the roster even when it is empty. |
| `Ctrl+S`       | Open or close the same Hub through the legacy `app.session.observe` action.                    |
| Double-tap `←` | Open the Hub from an empty main-session editor when the current session has an agent to show.  |

Run `/hotkeys` to see the active chords. Remap either action in `~/.omp/agent/keybindings.yml`:

```yaml
app.agents.hub: Alt+A
app.session.observe: Ctrl+S
```

The double-`←` gesture is not a keybinding action. While focused on a subagent, double-`←` returns to the main session instead of opening the Hub.

## Roster and inspector

The roster updates from the session's agent registry and progress events. Its responsive rows show:

- status (`running`, `idle`, `parked`, or `aborted`), agent identity, parent, and unread IRC count;
- model role, resolved model, and age since last activity;
- assigned task or current activity;
- cost, active time or elapsed span, request count, tool-call count, and tokens.

The header aggregates status and usage across measured agents. Press `t` to switch between the stable flat roster and a parent/child tree.

On a wide terminal, the selected agent's inspector appears beside the roster. On a narrow terminal, press `Tab` to replace the roster with it. The inspector adds:

- the current tool and arguments, last intent, and retry state;
- context-window use when available;
- parent and child lineage;
- output and patch paths, plus isolated-worktree branch metadata when present.

Metrics depend on the progress or persisted usage data available for that agent. Missing data appears as `usage —` rather than an estimate.

### Roster controls

| Key or input                | Action                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `j` / `k`, `↑` / `↓`, wheel | Select an agent.                                                             |
| `Enter` or click            | Open the selected agent.                                                     |
| `t`                         | Toggle flat and parent/child views.                                          |
| `Tab`                       | Toggle the inspector on narrow terminals.                                    |
| `PageUp` / `PageDown`       | Scroll an open inspector.                                                    |
| `r`                         | Revive the selected parked agent.                                            |
| `x`                         | Abort a running turn if necessary, then kill and release the selected agent. |
| `Esc`                       | Close the inspector first on narrow terminals, then close the Hub.           |

Only `parked` agents can be revived. `x` is immediate; use it only when you intend to discard that agent instance.

## Read and steer a subagent

For a normal local subagent, `Enter` or click focuses the main TUI on that agent's session and closes the Hub. Focusing a parked agent revives it. The transcript, status line, and editor then belong to that subagent:

1. Read its live transcript and tool activity.
2. Type a message and press `Enter` to steer a running turn or prompt an idle agent.
3. Press `Esc` with an empty editor, or double-tap `←`, to return to the main session.

Steering uses the normal prompt path, so the message and response are written to the subagent's persisted session history. While a subagent is focused, `Esc` returns to the main session; it does not interrupt the subagent.

Contexts without a local focusable session use the Hub's full-screen transcript viewer instead. This includes collab guests and advisor rows. The viewer incrementally tails the file-backed transcript and provides an input line only when the selected agent can be messaged. Sending there has the same semantics: revive if parked, steer if running, and prompt if idle.

## Persisted agents and advisors

Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows; a killed agent's tombstone keeps it aborted. Nested subagents retain their parent/child lineage. Output and patch artifacts are attached to the corresponding inspector row.

Advisor transcript files (`__advisor*.jsonl`) appear as `advisor`-kind rows under their owning session. They are observability records, not peers:

- their transcripts can be opened and followed;
- they cannot be messaged;
- they cannot be revived;
- they cannot be killed.

These restrictions also apply to collab guests controlling the host's Hub.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view.
- `history://<id>` gives the coding agent a concise transcript for a live or parked subagent.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript.
- `hub` `list` exposes the peer roster to the coding agent, and `hub` `send` steers or follows up with a normal subagent programmatically. Messaging a parked subagent revives it.

Advisor rows are intentionally excluded from the agent-facing `hub`, `history://`, and `agent://` peer workflows.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).
