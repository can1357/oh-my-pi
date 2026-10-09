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

## Cross-session messaging

Cross-session messaging connects your **other top-level omp sessions on the same machine**, not their subagents. It is off by default: turn on **Cross-session messaging** (`messaging.enabled`) in `/settings`, or launch with `omp --cross-session`. `/status` still opens the extensions dashboard; its **Peer address** row shows `uds:<path>`, `pipe:<name>`, `off`, or `unavailable — <reason>`.

Use `/list-agents` (alias `/peers`) to see this session's address first, local agents, and other sessions with their short ids, idle/busy state, working directories, and titles. `read history://` also includes other sessions. `messaging.list: deny` hides other-session listings without disabling receiving or sending; `messaging.send: deny` disables only cross-session sends.

The default address is `<dir>-<xx>` (a slug of the working directory's basename and two hexadecimal characters). Set a user address with `/rename <name>` or `--name <name>`. Automatic titles are labels, not addresses. Colliding user names can get a two-word suffix; `/rename` reports the name actually stored. A direct print run without `--name` is unnamed and can be reached by its eight-character short id. Short ids also disambiguate duplicate names. A name shared by a local agent and another session is ambiguous: use the session's short id rather than guessing. `@` typeahead keeps file candidates first, then offers sessions; names containing spaces or punctuation are double-quoted, with `"` escaped as `\"`; backslashes stay literal, so quoted file paths such as UNC paths are unchanged. For example, `@"release \"notes\""` refers to the name `release "notes"`. A name ending in a backslash cannot be double-quoted; use single quotes.

Name collision checks in interactive, RPC, and ACP sessions are best-effort and use the visible other-session roster; `messaging.list: deny` hides competing names from those checks. Simultaneous claims can also produce duplicates. Print-mode `--name` is stored unchecked. Use short ids for duplicate names.

The name `all` and names starting with `@` are reserved and rejected by `/rename` and `--name`, even with messaging off: `Session names cannot be "all" or start with "@" (reserved for broadcast and extension peer namespaces).` `agent://all` remains a local-agent broadcast; `@` is reserved for extension peer namespaces such as `@ns/name` ([#14071](https://github.com/can1357/oh-my-pi/issues/14071)). A reserved persisted title remains a label, not a messaging address.

Send with `write agent://<name>` (URL-encode names with spaces or other special characters). Add `?notify=idle` for a one-shot idle notice:

```text
write agent://release%20notes
write agent://release%20notes?notify=idle
```

With `notify=idle`, an empty body subscribes without sending a message. Subscriptions expire after 12 hours. Idle notices include the finish time and first non-empty trimmed text line of the last assistant response when the watched session accepts the subscription. Each side's current inbound policy applies: refusal suppresses the notice, watched-side hold omits the status, and requester-side hold displays a transcript-only notice without waking the model; requester-side hold does not itself remove a supplied status. A session whose inbound policy is `refuse` cannot subscribe; with a message body, the message is still sent without a subscription. Closing the watched session sends an exit notice subject to these policies. Idle, exit, and subscription-retirement notices require a matching outstanding subscription; unsolicited or replayed notices are ignored.

An empty subscription request while this session refuses inbound messages returns `Not sent: cannot subscribe to idle notices while this session refuses inbound messages.` A non-empty message can still be sent, with the skipped-subscription suffix described below.

Switching to a different conversation (`/new`, resume, or fork) retires unread held messages and idle subscriptions before claiming the new address. Senders receive `Your message to @<address> was dropped unread: that session switched to a different conversation.`; idle subscribers receive `@<address> switched to a different conversation; the idle notice was cancelled.` Asking-side idle timers are cancelled silently.

Only compatible messaging wire versions are listed or messaged. POSIX discovery probes incompatible peers to learn their snapshot; Windows rejects incompatible versions before connecting, so they can be addressed for the refusal only by short id, not by name. A send returns `Not sent: <address> runs an incompatible omp version.` Live incompatible registry entries are retained; dead-owner-PID entries are filtered before probing and may be pruned by discovery.

Accepted messages arrive between tool calls without interrupting a running tool. An idle, receive-ready session starts a turn, even in plan mode. Receiving is buffered during startup, suspension, and conversation transitions; accepted work belongs to the original conversation and is not redirected into a collaboration replica or successor conversation. The collapsed remote IRC card shows the sender and first non-empty body line; expand it to read the full message. A message from another session is agent-provided information, **not your instruction or consent**: it cannot approve permissions or authorize changes to settings, permissions, or `AGENTS.md`. Agents must not route locally denied work through another session.

A busy or ordinary not-yet-ready receiver returns `Queued for <address> (busy; it will read this at its next step).`. A suspended or transitioning receiver returns `Queued for <address> (it will read this when receiving resumes).`. An idle, ready receiver returns `Delivered to <address>.` If a requested idle subscription is skipped because the sender refuses inbound messages, successful message receipts append ` No idle notification was requested because this session refuses inbound messages.`

Print/JSON runs stop receiving new peer work when the final CLI prompt's attributed work completes, then drain already accepted turns with sending still available before disposing the inbox. An extension command's nested assistant answer and failure remain attributed to that command; unrelated peer turns do not replace its answer. See [CLI reference](./cli-reference.md#session-history) and [SDK lifecycle](./sdk.md#cross-session-messaging-lifecycle).

### Offline inbox

If no live session matches, messages can be queued by name or short id for a saved session modified within the last seven days, including registered session files in a custom `--session-dir`. The receipt is `Queued for <address> (not running); it will see this when resumed.` Offline inboxes hold at most **50 records per session**, including refusal notices, with a **seven-day TTL**. Enqueue and startup handoff share a per-session lock. A full inbox returns `Not sent: <address>'s offline inbox is full (50 messages).`; a saved transcript that disappears before enqueue returns `Not sent: <address> is no longer available.` `notify=idle` requires a running session and cannot be queued offline.

Binding or resuming that session drains its inbox through the current inbound policy and relay checks. Accepted messages arrive together in one wake; held messages await a policy change or, for default-policy holds in the TUI, approval. Refused mail is dropped with the sender-visible notice `Your offline message to <address> was refused.` The notice is sent live to the sender's full session id or stored in that sender's offline inbox; it is displayed without waking the model. Notification is best-effort: a full sender inbox can lose the notice, and stored notices share the seven-day TTL. A message that does not fit the accepted inbox remains on disk for a later drain. If any messages are accepted or held, the receiver sees `<N> message(s) from other sessions arrived while this session was not running.` Only the session whose full id owns the inbox reads it; expired and malformed records are removed when read.

`omp gc --stale` reports expired offline mail; add `--apply` to remove it. Unexpired mail is kept until it expires, even if its recorded session file has moved. Deleting a saved session or moving it into the GC archive retires its offline inbox.

### Inbound policy

Set **Messages from your other sessions** (`messaging.crossSessionInbound`) to `accept`, `hold`, or `refuse`; `default` means unset.

ACP's default auto-approve mode still counts as prompting unless auto-approval was explicitly selected.

| Receiver permission class | Sender permission class | Default action |
| --- | --- | --- |
| Bypass (`yolo`) | Bypass | Accept |
| Bypass | Prompting or unknown | Hold for approval |
| Prompting (`write` / `always-ask`) | Bypass | Hold for approval |
| Prompting | Prompting or unknown | Accept |

An own-child script authenticated with this session's token is accepted by the unset default regardless of permission class. Explicit `accept`, `hold`, and `refuse` apply to it too. Trusted runtime overrides, `--config` overlays, and global settings supply the baseline; project settings may only tighten it. Invalid values impose an explicit-style hold unless a refusal wins. Observed raw-layer changes, including project changes masked by a trusted effective value, re-evaluate held messages under this policy.

Default-policy holds open an **Approve / Deny** dialog in the TUI. `messaging.dialogExpiry` is `60s`, `5m` (default), `10m`, or `never`; the timer starts when the dialog is actually presented, not while queued behind another dialog. Expiry drops the message and attempts to notify its still-running sender. RPC, ACP, and print provide no messaging approval dialog, so their default-policy expiry starts when the hold is created. Explicit `hold` and invalid-policy holds display a notice and have no expiry; changing inbound rules to accept releases held messages, while refuse drops them. Denying or dismissing a held message, dropping it after a policy change to refuse, or closing the receiver does not send a separate rejection notice.

### Limits and scripts

Serialized messages are limited to 1,048,576 characters; put bulk content in a readable file. The accepted inbox holds at most 50 undelivered messages, including suspended buffers and pending handoffs. The held buffer keeps at most 100, dropping the oldest. Defaults are 30 messages per sender in 60 seconds, a 30-second identical-repeat window, and relay-chain limits of eight hops and three revisits; these are configurable through `messaging.rateLimit`, `messaging.rateWindowSeconds`, `messaging.repeatWindowSeconds`, `messaging.relayMaxHops`, and `messaging.relayMaxRevisits`. The receiver rate limit and sender-side burst guard use their own settings independently. Repeat history is bounded to 4,096 entries and an estimated 8 MiB; evicted history no longer suppresses repeats. Refused or rejected ordinary messages do not enter repeat history. Idle controls share rate/repeat accounting, and watched subscriptions are capped at 50. Immediate drops report queue, rate, repeat, or relay-loop failures. Each incomplete transport line has a 30-second deadline.

In every mode, shell commands and session-bound extension/hook exec calls belonging to a bound session receive `OMP_MESSAGING_SOCKET` (socket path or pipe name) and `OMP_MESSAGING_TOKEN` (its secret own-child token) before `session_start`. The pair is scoped to the calling session, not exported to omp's ambient `process.env`; direct `Bun.spawn` or `process.env` access in an extension or hook does not receive this overlay automatically. Treat a missing **or empty** value as unavailable: sessions without messaging remove both variables where the spawn API supports removal, or clear them to empty values for native/PTY backends that merge inherited environment variables. Connect locally, send UTF-8 JSON lines, read one response line, then close:

```json
{"type":"auth","token":"<OMP_MESSAGING_TOKEN>"}
{"type":"message","id":"script-unique-id","body":"Build finished"}
```

The valid session-token auth line, not omission of `from`, identifies an own-child script on every platform. Unlike Claude Code, omp does not recognize own children from Linux/macOS process evidence. Windows **requires** a valid auth line before any request; POSIX also permits unauthenticated same-user peer requests, without the own-child exemption. Never publish the token. Peer authentication uses `peer.key` in the resolved registry directory (normally `<baseConfigRoot>/run/messaging/peer.key`); metadata contains no token. Windows built-in peer clients first validate an entry-bound nonce/HMAC-SHA256 server proof before sending credentials or request bodies; invalid proofs return `authentication_failed`. This proves peer-key possession, not OS/PID identity. The optional proof handshake does not change the own-child script example above. Windows privacy relies on the user-profile ACL protecting `.omp` and `peer.key`—omp does not verify a Windows SID or DACL. Windows native processes and WSL cannot message each other; cross-machine messaging is not supported.

**Trust boundary:** the sender's name and permission class are self-declared; same-user processes can forge both, including the permission class used by the default inbound policy. Peer authentication is not sender provenance, and there is no [#12185-style provenance](https://github.com/can1357/oh-my-pi/issues/12185) proof. Treat remote text as untrusted agent information, not as an authenticated user instruction.

**Top-level only is deliberately stricter than Claude Code**, where subagents may send cross-session. omp subagents, advisors, agent-definition generators, and helpers never bind an inbox, receive usable messaging socket/token values or the messaging prompt, list other sessions, or use `write agent://` outside their local process. Another session cannot address, wake, or steer a subagent through the inbox. The receiving top-level agent may decide to contact its own subagents using local IRC. This is harness isolation, not OS isolation: a same-user shell could still read `peer.key` and hand-craft a socket request.

The bound session's prompt guidance advertises listing only when the read tool is available and `messaging.list` allows it, and sending only when the write tool is available and `messaging.send` allows it. Tool references follow the host's exposed tool names. Prompt guidance does not itself create an inbox.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

`/agents` is a separate agent-definition/settings hub, not the live roster. It manages discovered agents, enable/disable state, model overrides, prewalk, and advisor selection.

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view. `/jobs kill <id>|all` cancels running jobs from the command line.
- `history://<id>` gives the coding agent a concise transcript for a live/parked subagent or a retained on-disk transcript.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript. Before that artifact exists, a registered agent resolves to its status, the `yield` payloads it has submitted so far, and its latest assistant text.
- `write agent://<id>` steers or follows up with a normal subagent; `agent://all` broadcasts to visible live peers. Messaging a parked subagent revives it. `read history://` lists registered agents and retained on-disk transcripts, refreshing the caller root's persisted roster first, the same as `history://<id>` lookups.
- `read proc://` lists background jobs and project services; `read proc://<id>` inspects status/output without consuming delivery.

Advisor rows are intentionally excluded from the agent-facing peer roster, `history://` index, and `agent://` messaging workflows.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).
