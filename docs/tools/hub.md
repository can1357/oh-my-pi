# hub

> The single agent-coordination surface: peer messaging over the process-global mailbox bus, background-job control, and supervision of shared long-running processes.

Merged from the former `irc`, `job`, and `launch` tools; each op family keeps its old behavior and rendering.

## Source
- Entry: `packages/coding-agent/src/tools/hub/index.ts` (schema, `HubTool`, unified `wait`, renderer dispatch)
- Messaging half: `packages/coding-agent/src/tools/hub/messaging.ts`
- Jobs half: `packages/coding-agent/src/tools/hub/jobs.ts`
- Launch half: `packages/coding-agent/src/tools/hub/launch.ts`
- Shared types: `packages/coding-agent/src/tools/hub/types.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/hub.md`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — process-global `IrcBus`: per-agent mailboxes, delivery, waiter matching.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory and status.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — revival of parked recipients on direct send.
  - `packages/coding-agent/src/session/agent-session.ts` — recipient-side message, progress, and completion injection and wake turns.
  - `packages/coding-agent/src/session/async-job-delivery.ts` — shared ordered progress batching and model-facing progress messages.
  - `packages/coding-agent/src/async/job-manager.ts` — job registry, cancellation, delivery suppression, adaptive wait ladder.
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — process-supervision broker.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs` (awaited sends), `launch.enabled`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "jobs" \| "cancel" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe" \| "monitor"` | Yes | Operation. |
| `to` | `string` | `send` (peer) | Recipient agent id, or `"all"` for broadcast. Mutually exclusive with `name`. |
| `message` | `string` | `send` (peer) | Message body. Empty-after-trim is rejected. |
| `replyTo` | `string` | No | `send`: message id being answered. |
| `await` | `boolean` | No | Peer `send`: after delivery, block until the next message from that peer arrives. Invalid with `to: "all"`. |
| `from` | `string` | No | `wait`: only accept a message from this agent id (pure message wait). |
| `ids` | `string[]` | No | `wait`: job ids to watch (omit = all running jobs); `cancel`: job ids to kill (required); `monitor`: running background jobs whose progress mode to retune (mutually exclusive with `name`). |
| `peek` | `boolean` | No | `inbox`: leave messages in the process-global bus mailbox. Note that messages already buffered on the live recipient session are still drained into this result by the current implementation. |
| `name` | `string` | process ops | Stable project-scoped launch name (1-48 chars). On `send`/`wait` it routes the op to the process broker. |
| `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` | — | `start` | Launch spec, unchanged from the former `launch` tool. |
| `progress` | `"wake" \| "ambient" \| "off"` | No | `start`: attach live progress with `wake`/`ambient`, or explicitly leave monitoring off with `off`; omitted also defaults off. `monitor` with `name`: attach or retune with `wake`/`ambient`, or detach with `off`. `monitor` with `ids`: required, `wake` or `ambient` only — `off` is rejected because a job's progress channel cannot be detached. |
| `lines`, `head`, `grep`, `follow`, `cursor` | — | `logs` | Log window controls, unchanged. |
| `for`, `pattern` | — | `wait` (name) | Process lifecycle condition / output regex. |
| `text`, `enter`, `keys`, `signal` | — | `send` (name) | Process stdin / terminal keys / signal. |
| `timeout` | `number` | No | `logs`/`stop`/`wait`-with-`name`: seconds; default 30 (stop: 5). |

## Op families and dispatch
- **Messaging** — `send` (with `to`), `inbox`, `list`, and `wait` with `from`. Fire-and-forget sends return delivery receipts (`injected`/`woken`/`revived`/`failed`); direct sends can revive parked agents, while broadcasts target visible live peers without reviving every parked agent. `await: true` waits for one reply after delivery. A busy recipient with async execution disabled may auto-reply rather than strand an awaiting sender.
- **Jobs** — `wait` (bare or with `ids`), `cancel`, `jobs`, and `monitor` with `ids`. Owner-scoped visibility, watch/unwatch delivery suppression, `acknowledgeDeliveries` on returned completions, 500 ms `onUpdate` snapshots while waiting, and the adaptive wait window. `jobs` is the former job-list snapshot plus the roster of running subagents with no running job entry. `monitor` with `ids` retunes a running job's progress mode (see "Retuning background jobs").
- **Processes** — `start`, `ps`, `logs`, `stop`, `restart`, `describe`, `monitor`, plus `send`/`wait` when they carry `name`. `monitor` controls the calling session's live-output subscription; `ps` is the broker's `list`. See the launch sections below.

`send` with both `to` and `name` is rejected as ambiguous. `wait` routes by target: `name` → process wait; otherwise the unified coordination wait.

## The unified `wait`
One blocking primitive. It resolves job legs (explicit `ids`, owner-scoped and silently filtered, or every running job the caller owns) and — when the session can message peers — parks a bus waiter, then races:
- every watched running job's `job.promise`,
- the first matching incoming message (`from`-filtered when given),
- the adaptive wait window (`manager.nextPollWaitMs(owner)`),
- the tool-call abort signal.

Outcomes:
- A message wins (even a photo-finish: a message consumed by the bus waiter is never dropped) → the message is returned exactly like the former `irc wait` (`details.waited`), and the jobs keep running; their results still self-deliver.
- A job settles or the window elapses → a job snapshot exactly like the former `job` poll (`details.jobs`, `## Completed` / `## Still Running` sections). An all-running snapshot is flagged `useless` and rendered as a displaceable waiting frame that the next `hub` call supersedes.
- No job legs: pure message wait with peer liveness (bounded by the same adaptive window); with no running peers either, it returns `No running background jobs to wait for.` immediately (plus the jobless running-agent roster when one exists).
- Explicit `ids` that match nothing visible → `No matching jobs found for IDs: ...` with per-id agent hints (`history://<id>`), never a hang.
- A message already buffered on the session satisfies the wait before anything is watched.

Ladder bookkeeping (`nextPollWaitMs` / `recordPollWaitEnd`) runs only on paths that actually block; immediate returns leave the rung untouched.

## Outputs
- Messaging and job results: single text block plus `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`. Shapes are unchanged from the former tools except that job-op details now carry `op` (`"wait" | "cancel" | "jobs"`).
- Process results: `details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec?, monitoring?, monitorDetached?, monitors? }` (internally `ps` stores the broker op `list`; only `monitor` sets `monitoring` and `monitorDetached`; `ps` and `describe` carry `monitors`, the watcher list).
- Streaming: job-watching waits emit `onUpdate` every 500 ms with fresh snapshots. Process progress is delivered later as harness-injected progress messages, not as `onUpdate` output from the `start` or `monitor` call.

## Availability
- The tool is always registered (`loadMode: "essential"`).
- Messaging ops require an `AgentRegistry` and a caller agent id; otherwise they return `Peer messaging is unavailable in this session.` (`isIrcEnabled` still gates the peer-roster prompt sections: true for every subagent and for any session that can still spawn subagents).
- Job ops require `session.asyncJobManager`; otherwise `Async execution is disabled; no background jobs are available.`
- Process ops require `launch.enabled`; otherwise `Process supervision is disabled (launch.enabled=false).`

## Approval
`hubApproval` (per-call): `start`, `stop`, `restart`, and `send`-to-process are `exec`; everything else — messaging, job control, `ps`/`logs`/`describe`/`wait`/`monitor` — is `read`.

## Starting and readiness (processes)
`application` and `args` are separate fields, so callers do not need shell quoting:

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 },
  "progress": "wake"
}
```

Defaults: `cwd` = session directory, `args: []`, `env: {}`, `pty: true`, `restart: "no"`, `persist: false`, `detached: false`, readiness timeout 30 s. `detached: true` implies `persist`, forces `pty: false`, and disables stdin. `ready.log` is a regex over captured output; `ready.port` probes TCP at `ready.host` (default `127.0.0.1`); when both are present, both must pass. A readiness timeout leaves the process running and reports its state.

Names are stable and unique within one project directory. A live name must be stopped or restarted; starting a completed name creates a new launch and rotates its prior output log.

## Push monitoring (processes)

`progress: "wake"` on `start` subscribes the calling agent session to future process output. `progress: "ambient"` uses the same capture path without starting a turn. Monitoring is opt-in and defaults off; `progress: "off"` makes that choice explicit for helpers that must not expose output.

```json
{"op":"monitor","name":"web","progress":"wake"}
{"op":"monitor","name":"web","progress":"ambient"}
{"op":"monitor","name":"web","progress":"off"}
```

`monitor` attaches to, retunes, or detaches the calling session's subscription for an already-running named process. It begins at the current output cursor and does not replay older logs. Each complete non-empty merged stdout/stderr line enters a trailing 200 ms event; an oversized line retains its first and last 250 characters. Each monitor has a token bucket with capacity 10 and continuous refill of one event permit every two seconds. At a sustained five events per second, refill allows eleven initial deliveries before suppression. Permitted events produced while the model is busy arrive together in order. Each model-facing process preview retains at most 3,000 UTF-8 bytes, split between its head and tail. A final unterminated line is flushed when the process exits.

### Retuning background jobs

`monitor` with `ids` instead of `name` retunes running background jobs launched by `bash` with `progress` (an `async` job): each id switches between `wake` and `ambient` in place, without restarting the command or touching its artifact. `progress` is required and must be `wake` or `ambient`; `name` and `ids` together are rejected.

```json
{"op":"monitor","ids":["bg_1"],"progress":"ambient"}
{"op":"monitor","ids":["bg_1","bg_2"],"progress":"wake"}
```

The result reports one line per id: retuned, already delivering as the requested mode, not a job you own, already settled, launched without `progress`, or withheld while a `wait` watches it. Retuning changes routing only. Output already queued under the old mode is merged into the new queue, so a wake batch permitted before the switch can still start one more turn, and switching to `wake` delivers queued ambient output at the next wake. Two forms are rejected outright: `progress: "off"`, because a job's progress channel cannot be detached (let it finish or `cancel` it), and retuning a job launched without `progress`, because no channel exists to retune — relaunch it with `progress`. A job's `artifact://<id>` capture is unaffected by retuning; a job launched without `progress` gains no artifact link from being addressed here.

Rate limiting drops whole post-batch events by timing, not severity. A suppression count names events, not lines. When delivery resumes, the next batch includes bounded previews from the first and last suppressed windows but omits text from the windows between them. Delivered progress therefore cannot prove that an error or state transition did not occur. The full artifact or process logs are authoritative. Each monitor has an independent event bucket, so aggregate progress traffic grows with concurrent monitors; the number of idle wake-ups those events can start does not, because every wake monitor draws on the session-wide wake-turn budget described below.

The broker writes each subscription's raw output directly to one stable artifact before it emits progress. When the inline batch or one source line is truncated, or rate limiting suppresses events, the model and TUI show `artifact://<id>` for that capture. The artifact closes before the process completion notification. A late attachment starts at the current cursor, and the reconnect limit below still applies.

Wake progress starts a follow-up model turn when the agent is idle. Ambient progress is delivered only at an already-active step boundary and never wakes an idle agent. Process termination is a separate completion notification, ordered after any final progress batch.

When a supervised process exits with a nonzero code without an explicit diagnostic,
the broker records `exitReason` as `process exited with code <n> without a reported
termination reason`. This neutral reason is included in `start`, `wait`, `ps`/`describe`,
and owner completion output; it reports missing evidence rather than inferring whether
the code came from the child or an external terminator. If the runtime provides a signal,
the reason names that signal instead.

Both modes use the same batching and rate limiter, and both keep complete raw output in the artifact. `wake` spends a real model request and its tokens for every wake-up; all wake-ups in a session — Hub monitors and background jobs alike — draw on one session-wide wake-turn budget (`WakeTurnBudget`, registered once per `AgentSession` on the shared wake queue), so wake monitors are not budgeted separately and a chatty one delays other wake-ups. `ambient` waits for a turn that would happen anyway, often combining several permitted progress events with process completion or a user message, and costs nothing extra. Use wake for readiness, failures, or other output that changes the next action. Use ambient for benchmark iterations and low-priority diagnostics where only the final state requires action. See [Choosing a Bash progress mode](bash.md#choosing-a-progress-mode) for the full comparison and examples; Hub uses the same delivery channel.

For noisy output, lower the program's verbosity or filter the stream to actionable lines on the next safe relaunch. To keep the current process running, switch its monitor to `ambient` or `off`; this changes only the calling session's subscription. The `restart` operation reuses the existing launch specification, so changing arguments or environment requires `stop` followed by `start`. Suppression-bearing progress messages repeat this guidance in a `<system-reminder>` a few times with increasing spacing, then stop.

Agents should not poll `logs`, `ps`, or `wait` for progress or to keep the turn alive; progress wakes them. `wait` with `name` plus `for`/`pattern`/`timeout` remains the right call when readiness or exit must be observed before continuing.

Monitoring does not alter the daemon's lifecycle. `persist` controls whether the process survives the last omp client exiting; `detached` controls whether it survives broker shutdown. Detaching a monitor does not stop the process, and stopping the process does not require detaching first. Session disposal removes its subscriptions without stopping otherwise-surviving processes. Fully detached daemons cannot use live monitoring because no broker connection remains to deliver events; the error names the alternatives (start without `detached: true`, or read output with `logs` and `follow: true`).

`ps` and `describe` list each process's live watchers so "who is monitoring this" is debuggable across sessions: owner session id (rendered as `this session` for the caller), delivery mode, attachment age, artifact id, and state flags (`disconnected` inside the reconnect grace, `awaiting start` for a monitored start that has not launched yet, `previous incarnation` when the monitor is bound to an earlier same-name process). The client advertises `delivery`, `since`, and `artifactId` on its output subscription; the broker returns `monitors: DaemonMonitorWatcher[]` on `list` and `describe` results, absent from older brokers.

A live broker keeps writing the artifact for 30 seconds after its client disconnects. During that window it retains every bounded progress notification and replays them in order before terminal state. The subscription expires after 30 seconds without a reconnect. This handoff covers local socket replacement; it is not a durable journal across broker-process failure.

The authenticated behavioral eval described in [Bash tool](bash.md#live-model-behavioral-eval) includes a Hub scenario. It checks that a live model chooses persistent `start` with wake progress, receives a pushed marker, and acknowledges it without polling.

## Logs, input, signals (processes)
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
Each logs result returns a byte cursor; `follow: true` waits until output advances beyond it, the process exits, or the timeout elapses. The broker keeps a 25 MiB current log plus one rotated log. Keys: `ENTER`, `TAB`, `ESCAPE`, `CTRL_C`, `CTRL_D`, arrows. Signals: `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGKILL`. Input is one shared stream across all project clients.

## Cross-instance lifecycle (processes)
The first process op starts a detached broker over a private socket under `~/.omp/run/daemons/<project-hash>/`; every omp instance in the project shares names, logs, and state. Progress subscriptions belong to an agent session, not to the shared process. After the last omp process exits, the broker stops non-persistent processes and exits. `persist: true` opts out of last-client teardown; restart policies (`no`/`on-failure`/`always`) use bounded exponential backoff up to 30 s.

## Limits & Caps
- Mailboxes: 100 messages per agent (`MAILBOX_CAP`); oldest dropped beyond the cap.
- Awaited sends: `irc.timeoutMs` default `120_000`; `0` disables; negative/non-finite fall back to the default.
- Message/job `wait` window: adaptive ladder `[5s, 10s, 30s, 1m, 5m]` climbing one rung per back-to-back wait (per owner), resetting to the floor after 60 s without waiting; no per-call or settings override.
- Job retention 5 min; manager max-running fallback 15; `async.maxJobs` clamped 1..100.
- Launch names 1-48 chars; `ready.port` 1..65535; `logs`/`wait`/`stop` timeouts capped at one hour.
- Live progress uses trailing 200 ms batches, a 10-event burst, and one refilled rate-limit permit every two seconds. Suppressed inline events remain in the full artifact.

## Errors
- Most validation/availability failures are text results with `isError: true`: messaging unavailable, missing `to`/`message`, self-send (`Cannot send a message to yourself.`), `await` with `to:"all"`, `to`+`name` on one send, missing `ids` on `cancel`, and launch disabled. The async-disabled `jobs`/`cancel` response is an exception: it returns `Async execution is disabled; no background jobs are available.` with an empty job list and no `isError` flag.
- Launch validation (missing `name`/`application`, bad `ready.port`, unsupported key, or `monitor` targeting a process that is not running) throws `ToolError`. Monitoring a detached process throws `Detached processes cannot be live-monitored; start it without detached: true, or read its output with logs (follow: true)` — the remediation is part of the error contract.
- A `wait` timeout is a normal result (`waited: null` or an all-running snapshot flagged `useless`), never an error.
- Per-recipient delivery failures surface as `failed` receipts; `send` is `isError` only when nothing was delivered.

## Notes
- Process progress reuses the same model-facing batching and yield channel as async Bash progress; Hub and Bash do not maintain separate delivery semantics.
- A running recipient still gets messages injected as non-interrupting asides (`irc:incoming` custom messages, `prompts/system/irc-incoming.md`); replies are real turns.
- Messaging a parked agent revives it — the only resume primitive; the task tool has no `resume` parameter.
- TUI rendering is preserved per family: messaging cards (`IRC ➤ / ⟵` headers), job waiting frames (displaceable, shimmering rows), and launch frames render byte-identically to the pre-merge tools; the `hub` renderer only dispatches.
