# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source

- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability

`wait` takes one optional argument, `timeout` (seconds, clamped to 1-3600 and to `tools.maxTimeout` when that is set). It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior

- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- A wait without `timeout` that has nothing new returns a still-running snapshot (`useless`) after a window that climbs 5s → 10s → 30s → 1m → 5m across back-to-back idle waits; any wait that returns news, or 60s away from `wait`, restarts it at 5s. `timeout` replaces that window for this call and bounds the whole call, the service-broker refresh at its start included; an elapsed `timeout` wait still counts towards the streak. From the second back-to-back elapsed wait on, an elapsed wait appends a `<system-notice>` with the time spent waiting, telling the agent to make progress on everything that does not need the result before waiting again.
- With no owned job or service running, `wait` blocks for a reply when the caller sent a direct message (not a broadcast) during its current run to an agent that has not answered it since and is still running. The agent answers by messaging the caller back, or by settling a job of it the caller owns (its spawn job, or the job of a turn the caller's message woke), which delivers its result. Any incoming message ends it, a woken subagent's relayed turn output included. It also ends, without an error, once no agent asked can still answer: each one finished its turn without replying, or is blocked on the caller (a `wait` only the caller's result can end, entered after the question; an inline `task` spawn of it; an untimed eval handle wait on it). A reply that cannot come is what would park both sides.
- A `?progress` message from an agent asked is not its answer: it ends the current wait like any message, but a later `wait` keeps blocking for that agent while it is still live (even idle), and from then on only an explicit message answers — not a settled job of the turn that sent the progress.
- Otherwise, without `timeout`, returns immediately with “Nothing to wait for”, naming any agent asked that finished without replying or cannot reply before the caller finishes. With `timeout` and nothing owed (no agent asked has that news either), it idles instead: it ends on the first direct message (returning every message queued by then), steer, aside or background job result, or returns `Deadline reached: no message, steer or job result arrived.` (flagged as an idle poll) when `timeout` passes. Broadcast legs and progress notes do not end it; they inject as asides once it returns. This is the way to wait for a message another session will send; it replaces starting a `sleep` job to hold a wait open.
- An agent blocked on the caller's result cannot send the message an idle wait is for. Such blocks are: an inline `task` spawn of the caller; a `wait`, or an untimed eval handle wait, on the caller's job or on a workpool the caller is running a turn for; a `vibe_wait` on the caller's turn; and a run that waits for its background jobs to settle and cannot be prompted meanwhile (a subagent past its turn, a print-mode run before exit, a `/tan` clone, a security scan session). Each block covers only work still running: a wait on several jobs stops blocking on each one as it settles, so a finished agent is free even while its siblings run. Blocks chain: an agent blocked on one blocked on the caller is blocked on the caller too. While any such block holds, `wait` with `timeout` and nothing owed returns “Nothing to wait for” at once, naming the blocked agent, as it does without `timeout`. It does so before the service-broker refresh, which an already-refused call skips and a block starting meanwhile cuts short. An idle wait ends the same way, not as an idle poll, once a block starts. A `wait` that can also end on a bash job or a service blocks no one. Top-level sessions, subagents nobody blocks on, and agents whose interactive or RPC session merely waits for their results between prompts idle as described above.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. A wake already queued before execution still lets `wait` drain its message or owned job instead of being skipped; host-owned notices inject at the next boundary after the normal wait result. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.
- A running subagent's row carries its latest progress, e.g. ``- `AcpSurface` [task] — <label> — 5h7m · 90 req · $18.40 · ctx 160K/1M · stage: <stage>``: run time, requests, cost, context fill, self-estimated completion and stage, whichever its progress record reports. Bash and eval rows, and task rows without a progress record, stay ``- `<id>` [<type>] — <label>``. `read proc://` and `read proc://<id>` show the same progress on running task rows.

## Related surfaces

- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers from the main agent only. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
