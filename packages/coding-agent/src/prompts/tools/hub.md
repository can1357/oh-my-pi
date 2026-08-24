Agent coordination: peer messaging, background-job control, and supervised long-running processes. Main agent is `Main`; subagents inherit task ID.
Use `op: "list"` to discover live peers. Default is running+idle plus running/idle/parked/shown/truncated counts — never an unbounded parked name dump. Pass `status: "parked"` for parked archaeology; optional `limit` bounds rows (default 32, max 100). Address peers by exact roster ID — NEVER invent names. `send` to a known parked id still revives it; `history://<id>` and `agent://<id>` stay readable.

# Messaging & Jobs

Background jobs auto-deliver when they finish. Do not call `jobs`/`wait` merely to watch them; if either observes a settled job first, that snapshot is the delivery and suppresses duplicate `async-result`.

- **The user is NOT a peer.** `Main` answers the user ONLY in a plain text block; a `send` shows them a tool-card preview (2 lines while collapsed). Thinking is not output either.
- **`send`** (with `to`): fire-and-forget, NEVER blocks. Delivery receipts (`delivered`/`failed`) immediate; `failed` → peer gone, don't retry.
  Sending wakes `idle`/`parked` peers. Answering: lead with answer, NEVER quote, set `replyTo`.
- **Format**: plain prose ONLY. No JSON status objects. Share paths via `local://`/`artifact://` URLs, not pasted blobs.
- **`wait`**: use ONLY when completely blocked with no other work. Returns on the FIRST of: an incoming message, a watched job finishing, the wait window elapsing, or a steering interrupt — NOT when all jobs finish; re-issue to keep waiting.
  - Bare `wait` watches every running job AND incoming messages. NEVER pass an array of every running ID; `ids` narrows to specific jobs, `from` to one peer (or use `await: true` on send).
  - A **user** message arriving as steering is not a wake reason to poll past: answer it in a text block BEFORE re-issuing `wait`. Parent/peer steering is answered with `send`; advisor and budget steers need no reply.
- **`inbox`**: drain queued messages without blocking.
- **`cancel`**: kill background jobs by `ids` when they have hung, stalled, or are no longer needed. Returns immediately.
- **`jobs`**: status snapshot of every job without waiting. A settled row consumes auto-delivery. Also names running subagents with no job entry — coordinate with those via `send`.
- Job rows are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `send`, `agent://<id>`, or `history://<id>`.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use hub messaging for something a tool can answer (e.g., grepping codebase, running a build).

# Processes

Project-scoped long-running processes shared by every omp instance in the same directory. A long-running service, watcher, debugger, REPL, or process needing later input MUST use `op:"start"`, not `bash`.

- **`start`** launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
  - `ready.log` is a regex; `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds. Readiness MUST be observed; process creation alone is not readiness.
  - Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
  - `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
  - `persist: true` opts out of last-omp teardown; `detached: true` survives broker shutdown and all omp exits (implies persist, disables PTY input). Omit both unless their survival guarantees are required.
  - For actionable output, set `progress: "wake"`. Complete non-empty merged lines join a trailing 200 ms batch; a final partial line joins the last batch before completion. Wake starts a follow-up turn while idle; `progress: "ambient"` waits for an active turn.
  - Cost: `wake` is not free — every wake-up spends a real model turn and its tokens. All wake-ups in this session (monitors and background jobs alike) share one session-wide wake budget, so a chatty wake monitor delays other wake-ups. `ambient` costs nothing extra: it rides along with turns that happen anyway. Prefer `ambient` unless the output should change your next action.
  - Truncated or suppressed progress links the monitor's full `artifact://<id>` capture.
- `progress` on `start` stays attached. Use **`monitor`** only to attach later, retune, or detach (`progress: "off"`). Monitoring starts with future output; it does not replay logs.
- If progress is noisy, lower source verbosity or use a filtering wrapper executable/script. If safe, stop then start with quieter arguments; `restart` reuses the noisy launch spec. If relaunch is unsafe, retune the monitor to `ambient` or `off`. Suppression reports repeat this guidance a few times with increasing spacing, then stop.
- Monitoring and process lifetime are independent. `persist`/`detached` govern survival; monitoring never keeps a process alive. Detached processes cannot be live-monitored: start without `detached: true`, or read their output with `logs` (`follow: true`).
- `ps` and `describe` list each process's watchers (owner session, wake/ambient, attached since, artifact, disconnected/awaiting-start state) so you can see who is monitoring what.
- Progress and completion are separate. Do not poll `logs`/`ps`/`wait` for progress or to keep the turn alive; end the turn and let progress wake you. `wait` with `name` plus `for`/`pattern`/`timeout` is fine when you need readiness or exit before continuing.
- **`ps`**, **`logs`**, **`wait`** (with `name`), **`send`** (with `name`), **`stop`**, **`restart`**, **`describe`**, and **`monitor`** address the stable `name`.
- **`logs`** defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a regex. `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
- **`wait`** with `name` blocks until readiness/exit/`pattern` or `timeout` (seconds).
- **`send`** with `name`: `text` writes stdin (`enter` defaults true); `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT; `signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; writes share one input stream.
- **`stop`** performs graceful process-tree termination before hard-kill; NEVER kill an unverified PID through bash. **`restart`** reuses the retained launch spec.
