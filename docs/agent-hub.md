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

The header aggregates status and usage across measured agents. Press `t` to switch between the operationally ordered flat roster and a parent/child tree. Press `/` to filter agents by id or display name.

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
| `/`                         | Filter agents by id or display name.                                        |
| `1` / `2`                   | Switch between Agents and Activity sections.                               |
| `Tab`                       | Toggle the inspector on narrow terminals.                                    |
| `PageUp` / `PageDown`       | Scroll an open inspector.                                                    |
| `r`                         | Revive the selected parked agent.                                            |
| `x`                         | Abort a running turn if necessary, then kill and release the selected agent. |
| `Esc`                       | Clear an active filter first, then close the narrow inspector or the Hub.    |

Only `parked` agents can be revived. `x` is immediate; use it only when you intend to discard that agent instance.

## Activity log

Press `2` for the combined activity log; `1` returns to the roster. The log includes responses, tool calls, IRC messages, and lifecycle activity. `Enter` opens the selected entry's agent transcript at that entry when an anchor is available.

- `f` cycles All, Errors, Responses, and Tools filters.
- `s` cycles the scope between all agents, the selected agent, and its subtree.
- `/` searches the activity log.
- `Space` toggles following the newest entry; manual selection pauses following.
- `Esc` clears the search first, then closes the Hub.

## Read and steer a subagent

For a normal local subagent, `Enter` or click focuses the main TUI on that agent's session and closes the Hub. Focusing a parked agent revives it. The transcript, status line, and editor then belong to that subagent:

1. Read its live transcript and tool activity.
2. Type a message and press `Enter` to steer a running turn or prompt an idle agent.
3. Press `Esc` with an empty editor, or double-tap `←`, to return to the main session.

Steering uses the normal prompt path, so the message and response are written to the subagent's persisted session history. While a subagent is focused, `Esc` returns to the main session; it does not interrupt the subagent.

Contexts without a local focusable session use the Hub's full-screen transcript viewer instead. This includes collab guests, advisor rows, and aborted agents; advisor and aborted transcripts are read-only. The viewer incrementally tails the file-backed transcript and provides an input line only when the selected agent can be messaged. Sending there has the same semantics: revive if parked, steer if running, and prompt if idle.

## Pinned jump list and click to focus

While subagents run, a pinned `Subagents` block above the editor lists every live agent — sync task calls and detached background spawns alike.

The list stays short: it shows a few rows plus an expander (`display.pinnedAgents: collapsed`, the default), lists everything (`full`), or hides entirely (`off`). Clicking the expander toggles between the two while `tui.mouse` is on.

Set `display.subagentLivePreview: true` to add a second line under each row showing what that agent is doing: its current tool call (or, between calls, the most recent one) with a one-line detail, plus the elapsed time once a call runs longer than five seconds. Off by default.

Enable `tui.mouse` to click live subagent cards and jump-list rows directly in the main session, without opening the Hub first. A click focuses that card's most recent agent (a jump-list row focuses its exact agent); focusing a parked agent revives it. Hovering a live target lights it up first, so you can see what a click will open.

Only rows currently in the live viewport are clickable — retired transcript rows live in terminal scrollback, where clicks cannot map back to content. Enabling capture changes terminal gestures while on: text selection becomes Shift+drag and wheel scroll becomes Shift+wheel. Off by default.

## Persisted agents and advisors

Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows; a killed agent's tombstone keeps it aborted. Nested subagents retain their parent/child lineage. Output and patch artifacts are attached to the corresponding inspector row.

Advisor transcript files (`__advisor*.jsonl`) appear as `advisor`-kind rows under their owning session. They are observability records, not peers:

- their transcripts can be opened and followed;
- they cannot be messaged;
- they cannot be revived;
- they cannot be killed.

Collab does not replicate advisor rows or serve their transcripts to guests; the host also rejects advisor chat, revive, and kill requests by id.

## Cross-process peers

Main agents in separate omp processes on the same machine and OS user can message each other. Turn it on with any of:

- **Cross-Process Peers** in `/settings` (Interaction → Agent), saved as `irc.crossProcess`;
- `/peers on` for this process only (`/peers off` turns this process off even when the setting is saved on);
- `--mailbox` at launch.

Once a process is on, omp prints `Peers: on — this session is <address>` and the footer shows `peers:<address>`. The address is the cwd name plus eight hex characters (`oh-my-pi-a5ad716a`). It stays fixed for the life of the process, including across `/new`, resume, and fork.

- `/peers list` shows the other processes that have peers on; `/peers status` shows this process's state. Peers also appear in the Agent Hub (`/hub`) as send-only rows: `Enter` opens a composer, and transcript, focus, revive, and kill are unavailable for them.
- `/peers name <alias>` gives this process an alias that peers can use instead of the address (`write agent://<alias>`); `/peers name` clears it. Save one with the **Peer Alias** setting (`irc.peerAlias`), globally or in a project's settings file. Aliases use letters, digits, `-`, and `_` (max 48). An alias resolves only when exactly one live peer has it; otherwise the send fails and lists the matching addresses. A local agent with the same id always wins over a peer alias.
- `read history://` lists peers under **Peers (other omp processes)**.
- `write agent://<address>` sends to a peer. A peer receives it exactly like a subagent message to Main: an aside at the next step boundary while busy, a new turn while idle, and appended without a turn in plan mode. The write result says whether the peer started a turn or only added the message to its context. The incoming card shows the sender's address, session title, and workspace.
- A reply sent during a turn that a peer message started is delivered without waking the recipient, so two idle sessions cannot ping-pong.
- When `completion.notify` is on, a peer message raises a terminal notification.
- A peer refuses messages while it is switching sessions or compacting, and when 100 messages or 4 MiB from peers are already waiting; the sender gets a failed delivery to retry later.
- Only main agents publish and send. Subagents keep their in-process messaging and never see peers.

Limits: `agent://all` broadcasts to local agents only, not peers. `write` cannot set a reply-to thread id. `wait` does not block on peer replies alone. A peer's subagents cannot be addressed.

From a shell, `omp peers list [--json]` lists peers and `omp peers send <address|alias> <message>` sends one message (exit code 1 when delivery fails). Neither starts a model or makes the shell discoverable, and both work whether or not the setting is on.

Mode notes:

- **Print** (`-p`, `--mode json`, piped stdin): can send, but does not receive unless launched with `--mailbox`.
- **RPC**: incoming messages arrive as `irc_message` events, followed by the turn they start.
- **ACP**: each editor conversation is a separate peer at `<address>.<8 hex>`, advertised with its own workspace; `/peers on` applies to the conversation it runs in. Peer messages and the turns they start are streamed to the editor, and `session/cancel` stops a peer-started turn.

Each process serves its own endpoint: a named pipe on Windows, a Unix socket elsewhere. Discovery metadata lives in `~/.omp/run/irc-peers/`, which is private to your OS user. Every request carries the publishing process's random bearer token from that metadata. A process that dies without cleaning up is pruned the next time anyone lists peers.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

`/agents` is a separate agent-definition/settings hub, not the live roster. It manages discovered agents, enable/disable state, model overrides, prewalk, and advisor selection.

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view.
- `history://<id>` gives the coding agent a concise transcript for a live/parked subagent or a retained on-disk transcript.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript. Before that artifact exists, a registered agent resolves to its status, the `yield` payloads it has submitted so far, and its latest assistant text.
- `write agent://<id>` steers or follows up with a normal subagent; `agent://all` broadcasts to visible live local agents (not cross-process peers). Messaging a parked subagent revives it. `read history://` lists registered agents and retained on-disk transcripts, refreshing the caller root's persisted roster first, the same as `history://<id>` lookups.
- `read proc://` lists background jobs and project services; `read proc://<id>` inspects status/output without consuming delivery.

Advisor rows are intentionally excluded from the agent-facing peer roster, `history://` index, and `agent://` messaging workflows.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).
