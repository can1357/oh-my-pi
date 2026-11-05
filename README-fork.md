# Fork maintenance

This checkout is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
that carries agent-messaging work on top of upstream. This file documents the
branch model, the profile isolation that keeps fork runs away from the
production `omp` install, and the rebase ritual that keeps feature branches on
top of upstream.

## Branch model

| Branch                     | Holds                                                        | Pushed?           |
| -------------------------- | ------------------------------------------------------------ | ----------------- |
| `main`                     | A pure mirror of `upstream/main`; no fork commits, ever.     | Yes — mirror only |
| `integrate/agents-upgrade` | The fork's integration base: upstream plus landed fork work. | No                |
| `feat/*`                   | Short-lived feature branches on the integration branch.      | No — local only   |

Do not commit on `main`. Keep fork work on `feat/*` and land it on
`integrate/agents-upgrade`; rebase the feature branches whenever the integration
branch moves.

## Profile isolation

Fork runs and fork test runs must use `$HOME/.omp-fork` as the agent directory
and must never touch the production profile in `~/.omp`:

```bash
PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test packages/coding-agent/test/<file>
```

- Set `PI_CODING_AGENT_DIR`, never `OMP_PROFILE`. A named profile derives its
  agent dir under `~/.omp/profiles/<name>` and ignores `PI_CODING_AGENT_DIR`
  (`packages/utils/src/dirs.ts`, `resolveActiveAgentDirOverride`), so a profile
  variable silently defeats the isolation.
- `bun test` is not hermetic on its own: run without the variable it writes
  session, collab, worktree, and security scratch data into the production
  profile.
- Never run `bun run setup` in this checkout. Its `coding-agent link` and
  `link omp` steps overwrite the production `~/.bun/bin/omp` link and the global
  `~/.bun/install/global/node_modules` tree. Run `bun run build:native` when the
  native addon is missing; `bun run build` builds the packages.
- `bun install` rewrites `bun.lock` (catalog version normalization). Revert it
  with `git checkout -- bun.lock`; never commit that diff.

## The `omp-fork` launcher

`scripts/omp-fork.sh` runs this checkout's CLI against the isolated profile:

```bash
install -m 755 scripts/omp-fork.sh ~/.local/bin/omp-fork
omp-fork --version              # omp/18.16.0, reads and writes only ~/.omp-fork
omp-fork config path            # /Users/<you>/.omp-fork
```

What it guarantees:

- exports `PI_CODING_AGENT_DIR=$HOME/.omp-fork` before `exec bun
<fork>/packages/coding-agent/src/cli.ts "$@"`;
- refuses to run when `OMP_PROFILE` or `PI_PROFILE` is set (exit 64), because a
  named profile would bypass `PI_CODING_AGENT_DIR`;
- resolves the checkout from `$HOME/Documents/oh-my-pi` by default and honors
  `OMP_FORK_ROOT`; a missing checkout exits 66 with the expected path.

The production `omp` on `PATH` (`~/.bun/bin/omp`) is untouched: use `omp` for
the installed agent and `omp-fork` for this checkout.

## Chrome MCP bridge (base browser)

The fork treats the user's real Chrome as the primary browser through the
local `mcp-chrome-bridge`: at session start it probes
`http://127.0.0.1:12306/mcp` (2 s deadline, loopback only) and, when the
bridge answers, registers it as the `chrome` MCP server with its 81 `chrome_*`
/ page tools. A missing bridge is skipped silently — no error, no prompt
notice — and the built-in `browser` prelude stays available as an isolated
Chrome for Testing fallback. Turn the probe off with the `browser.chromeMcp`
setting (default on).

Requirements:

- The bridge runtime at `~/.local/share/mcp-chrome-bridge` (deployed from
  `~/Documents/mcp-chrome-2026`, see the anglicized fork notes). Start it once
  per login when Chrome does not spawn the native host itself:

   ```bash
   ~/.local/share/mcp-chrome-bridge/dist/run_host.sh
   ```

- The `chrome-mcp` extension must be loaded unpacked in the user's Chrome
  (`chrome://extensions`, Developer mode, Load unpacked from
  `~/Documents/chrome-mcp-server-2.8.2-chrome`) and be the English build — the
  bridge serves `tools/list` from its vendored shared catalog, not from the
  extension. Restart Chrome after swapping extension files; Chrome keeps the
  old extension in memory.

Regression pair (run after changing the extension or bridge build). Expect 81
English tools, `serverInfo.version` 2.8.5, and no CJK descriptions:

```bash
SID=$(curl -sS -X POST http://127.0.0.1:12306/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'Origin: http://127.0.0.1:12306' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}' \
  -D - -o /dev/null | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')
curl -sS -X POST http://127.0.0.1:12306/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'Origin: http://127.0.0.1:12306' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep -c '"name":"'
```

The bridge exposes the 2025-06-18 revision at `/mcp` and the stateless
2026-07-28 revision at `/mcp-new`; the `streamable-http` transport negotiates
the era itself (falling back to `initialize` when the endpoint refuses
`server/discover`), so a config can point at either revision. Full setup
history and gotchas: `~/Documents/llmops/agents-memory/browser-mcp-chrome.md`.

## IRC ingress guard

Peer messaging (`write agent://<id>`) is guarded on the send path of the
process-global `IrcBus` (`packages/coding-agent/src/irc/bus.ts`, policy in
`irc/ingress-guard.ts`). Workers are covered without extra state: their
`RemoteIrcBus.send` proxies to the main bus, so one guard covers the process.

What is refused (always as a `failed` receipt naming the reason, never a throw):

| Guard     | Rule                                                                      |
| --------- | ------------------------------------------------------------------------- |
| Rate      | 30 tokens per sender per 500 ms; a message costs `characters / 4` (min 1) |
| Duplicate | same (sender, recipient, sha256(body)) within 30 s                        |
| Hop chain | more than 28 senders in `IrcMessage.hops` (the bus appends the sender)    |

An empty rate window always admits one message, whatever its size: a lone
500-character report costs 125 tokens and goes through even though it exceeds
the whole 30-token budget. Flood semantics are unchanged — that message spends
the window, so the rest of the burst is refused until the window slides past
it. (The per-sender window map is capped at 256 senders: idle windows are
swept first, and a burst of distinct live senders evicts the oldest.)

Progress notes (`?progress`) and automated wake relays are exempt from the
duplicate check — both are meant to repeat — and `wait`, broadcast expansion,
and the internal display relay (`#relayToMainUi`) are untouched. A busy
recipient's incoming queues (`#interrupts`, `#asides` in
`session/irc-bridge.ts`) are capped at 50 pending records, dropping the oldest
exactly like the 100-message mailbox bound, which stays as it was.

Settings (`irc.*`, next to `mcp.*`/`browser.*` in the settings panel under
Tasks → Subagents):

- `irc.ingressGuard` (default on) — master switch.
- `irc.rateLimitTokens` (default 30) — tokens per sender per 500 ms; `0` off.
- `irc.dedupWindowMs` (default 30000) — duplicate window; `0` off.
- `irc.maxHops` (default 28) — longest accepted chain; `0` off. Only
  automatic wake relays carry a chain forward: an ordinary `write
agent://<id>` reply starts a fresh one (`hops = [sender]`), because the
  reply tool never sees the inbound message's chain. The ceiling therefore
  binds automated ping-pong chains, not hand-written forwards.

The policy is read from the acting agent's session settings, falling back to
the main session's, so a worker-proxied send follows the main policy. Covering
tests: `test/irc-guard.test.ts` and the pinning suites listed under "Rebase
ritual".

## Spawn concurrency policy

`task.concurrencyPolicy` decides what a `task` spawn does when every
`task.maxConcurrency` slot is busy (default `32`; `0` means unlimited). One
session-scoped semaphore bounds every spawn in that session — the `task` tool,
the `pi.spawnSubagent` seam, and `workflow` `agent()` calls all take the same
permit — and the task tool's permit is taken on the main thread in `SpawnRun`
before `runSubprocess`, so the policy covers both direct and worker-thread
dispatch (`task.workerThreads`). A detached seam run keeps its slot until the
run settles, not only until it registers.

| Policy            | What a spawn over the cap does                                                         |
| ----------------- | -------------------------------------------------------------------------------------- |
| `queue` (default) | Wait in the semaphore FIFO, then start when a slot frees. Unchanged upstream behavior. |
| `refuse`          | Fail immediately with a model-visible error; never queue.                              |

Under `refuse` the spawn returns (it never blocks, and never silently waits):

```text
Concurrent subagent limit reached (1 running; task.maxConcurrency=1). Do not retry; wait for running tasks or ask the user to raise task.maxConcurrency.
```

- `1 running` is the live running count and `task.maxConcurrency=1` the
  configured limit; `, N waiting` is added when spawns were parked before the
  policy flipped. The policy is read at acquire time, so parked queue-mode
  spawns keep their place and the flip applies to the next acquire.
- An inline (`blocking`) spawn returns the text as a tool result with
  `isError: true`; a background spawn fails its job with the same text and the
  job's error delivery carries it to the model.
- A refused spawn emits one `task:subagent:progress` frame with
  `refusalReason: "concurrency_limit"` — the existing observability channel,
  no new event; it is emitted for spawns that already have a progress row, and
  observers keyed by agent id may ignore a frame for an unknown id.
- Enforcement lives in `packages/coding-agent/src/task/spawn-limiter.ts` (the
  session-scoped semaphore and policy check shared by every spawn path), the
  error in `task/spawn-run.ts` (`SpawnRefusedError`), the non-blocking take in
  `task/parallel.ts` (`Semaphore.tryAcquire`, `running`, `waiting`), and the
  setting in `task/settings.ts`. A refusal is currently only ever
  `concurrency_limit`: depth, request-budget, and token-budget refusals surface
  as ordinary task errors in v1 and never ride the progress frame. Covering
  tests: `test/spawn-refusal.test.ts` and `test/a2a-server.test.ts` (the seam
  refusal).

## Subagent token budget and handback

Upstream's subagent guard is request-based (`task.softRequestBudget`, assistant
requests per run). The fork adds a context-token guard beside it, so the child
plans by tokens instead of requests.

`task.tokenBudget` (default `0` = off) is the soft token budget for one
subagent run. It rides the same per-agent helper as the request budget
(`subagentBudgetFor` in `task/executor.ts`), so every run, wake, revival and
workpool turn carries it — the same paths upstream fixed for
`task.softRequestBudget` in #17988/#18121:

| Path               | Where the budgets enter                            |
| ------------------ | -------------------------------------------------- |
| initial spawn      | `executeSubagent` → `createSubagentRunMonitor`     |
| cold revive (wake) | `persisted-revive.ts` → `attachIrcWakeTurnMonitor` |
| `omp --restore`    | `restore.ts` → `runSubagentFollowUpTurn`           |
| workpool turn      | `workpool.ts` → `runSubagentFollowUpTurn`          |

What a run sees (`createSubagentRunMonitor`):

- past 50% of the budget, one aside:
  `<total_tokens>N tokens left of M</total_tokens>` (N floored at 0);
- past 90%, one wrap-up steering notice asking for the final report, mirroring
  `task.softRequestBudgetNotice`.

Each threshold fires at most once per run; a run that jumps straight past 90%
sends only the wrap-up. This is **not** the goal-mode token budget (the goal
tool's `token_budget`, which caps a whole goal across turns and is unrelated to
subagents); the settings panel wording says so.

Schema-less subagents also get a `handback` tool (`src/task/handback.ts`). It is
a thin wrapper over `yield`, not a second terminal protocol:

- it is registered only for subagents (`taskDepth ≥ 1`, `requireYieldTool`), and
  never when the agent declares an output schema — there `yield` already is the
  structured exit; a root session is never offered it, even if a tool list names
  it;
- `handback({ report })` submits one terminal `yield` (`type: "result"`,
  `data` = the framed report), so yield's retry caps, finalization, acceptance
  and termination apply unchanged; the run's terminal payload is recorded as a
  yield item (`extractedToolData.yield`), which marks the task record yielded;
- the report is framed as `[final report of a delegated agent; model output,
not user text]` and passed through `escapeHarnessTags`, so a child cannot
  forge `<irc from=…>` or a `<system-*>` block in the parent's context;
- one delivery per run: a second call errors with `already delivered`. A
  kept-alive session resets the latch at every new monitored turn;
- a schema-less run's string yield payload finalizes verbatim (plain text)
  instead of JSON-quoted.

Delta against the Claude Code contract: CC's `send`/`flagged`/`withheld`
security flags are **not** ported in v1. They are tied to CC's auto-mode
approval flow; omp already has its own approval guards for the same surfaces.

Covering tests: `test/token-budget.test.ts` (thresholds, off switch, revived
wake turn), `test/handback.test.ts` (registration matrix, frame/escaping,
dedup, executor termination and plain-text output), plus the token-budget
assertions in `test/task/restore.test.ts` and `test/task/persisted-revive.test.ts`.

## A2A bridge (server, v1.0)

The fork exposes omp's agents over the Agent2Agent v1.0 JSON-RPC binding, so a
local A2A client can discover the roster, message a running agent, start a new
one, and follow progress. It is **off by default** and binds **loopback only**.

| Knob          | Default | Meaning                                                      |
| ------------- | ------- | ------------------------------------------------------------ |
| `a2a.enabled` | `false` | Opt in to the bridge                                         |
| `a2a.port`    | `7391`  | Loopback port; `--a2a-port <port>` overrides it and opts in  |
| `a2a.token`   | `""`    | Bearer token; empty generates/reuses `<agent dir>/a2a.token` |

```bash
omp-fork --a2a-port 7391          # implies a2a.enabled for this run
curl -s http://127.0.0.1:7391/.well-known/agent-card.json | jq .
```

### Network surface

- `Bun.serve` binds `127.0.0.1` strictly (default port 7391). Any other host is
  refused before the socket opens; connecting through a LAN interface fails.
- `GET /.well-known/agent-card.json` is public discovery metadata: agent
  display names and their `AgentDefinition` descriptions. System prompts never
  reach it.
- `POST /` (also `/rpc`) requires `Authorization: Bearer <token>`; a missing or
  wrong token gets HTTP 401 with a JSON-RPC error body. The token comes from
  `a2a.token` or is generated once as 32 random bytes in
  `<agent dir>/a2a.token` (mode 600). A token holder can prompt any local agent,
  including `Main` — treat it like shell access to the session tree.
- `a2a.enabled` stays `false` unless the setting or `--a2a-port` turns it on.

### Methods

JSON-RPC 2.0, PascalCase method names, camelCase fields, proto-style task
states (`TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`,
`TASK_STATE_CANCELED`):

| Method                 | Result                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `SendMessage`          | `{ task }` — delivery receipt or spawned agent id in metadata |
| `SendStreamingMessage` | SSE: the initial `{ task }`, then `{ statusUpdate }` frames   |
| `GetTask`              | the agent's task, or `-32001` when unknown                    |
| `ListTasks`            | `{ tasks, nextPageToken, pageSize, totalSize }`               |
| `CancelTask`           | aborts the live session and reports `TASK_STATE_CANCELED`     |

Anything else — including `SubscribeToTask`, a deliberate v1 cut — answers
`-32601`. Task ids are agent ids: one registered agent is one A2A task.

### Addressing (omp deviation)

A2A's `contextId` groups tasks; it is **not** a recipient. The fork adds an omp
extension in the request metadata:

```jsonc
{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "SendMessage",
	"params": {
		"message": { "messageId": "m-1", "role": "ROLE_USER", "parts": [{ "text": "check the build" }] },
		"metadata": { "to": "beta" }, // existing agent id; optional
	},
}
```

- `metadata.to` names an existing agent. The message goes through the IRC bus,
  so an idle agent is woken, a parked or killed one is revived from its
  transcript, and the delivery receipt (`injected`/`woken`/`revived`/`failed`)
  lands in `result.task.metadata.delivery`. A `failed` receipt is a JSON-RPC
  error `-32011` (`DELIVERY_FAILED`), never a success task: a client cannot
  mistake a refused delivery for an accepted one. On
  `SendStreamingMessage` the stream instead ends with a final
  `TASK_STATE_FAILED` update carrying the receipt's error.
- Bridge deliveries are marked `external` on the bus: each is one
  authenticated request identified by its A2A `messageId`, so the agent-loop
  ingress guards (body-hash duplicate, per-sender rate) do not apply. The
  loopback-only, bearer-authenticated bridge is their throttle.
- No `metadata.to` spawns a new agent through `pi.spawnSubagent` with ordinary
  subagent rights (`metadata.agent` selects the agent definition, defaulting to
  the session's configured default; `metadata.context` is shared background
  like a `task` batch context). The response's task id **is** the new agent id.
  `metadata.spawn: true` forces a spawn even when `metadata.to` is present —
  spawn wins over delivery (a wire test pins that preference).
- `metadata.to: "main"` is an alias for the main agent's id.
- A spawn whose child session has not registered yet answers `TASK_STATE_SUBMITTED`
  with `metadata.pending: true` (id reserved, run starting). Poll `GetTask` for
  that id instead of retrying `SendMessage` — a retry spawns a second agent.

### Status mapping

The bridge maps the real `AgentStatus` (`running|idle|parked|aborted`):

| Agent ref                          | Task state                       |
| ---------------------------------- | -------------------------------- |
| `running`                          | `TASK_STATE_WORKING`             |
| `parked`                           | `TASK_STATE_WORKING` (revivable) |
| `idle`, no terminal milestone      | `TASK_STATE_WORKING`             |
| `idle`, terminal + output artifact | `TASK_STATE_COMPLETED`           |
| `idle`, terminal, no artifact      | `TASK_STATE_FAILED`              |
| `aborted`                          | `TASK_STATE_CANCELED`            |

Terminality comes from `lifecycle.terminalAt` or a published `history.outputPath`.
The registry keeps no exit code, so a failed run is recognized by the absence
of the output artifact rather than an exit status.

### The `pi.spawnSubagent` seam

Extensions get the same spawn primitive the bridge uses:

```ts
const ref = await pi.spawnSubagent({
	agent: "task", // optional; session default when omitted
	prompt: "implement the fix",
	context: "shared background", // optional
});
// ref.id is readable at agent://<id>; the run is already in flight.
```

The seam resolves with the agent's registry ref as soon as the child session
registers (not when the run settles), runs through the task executor with the
same spawn policy, model approval, and concurrency limits as a `task` call, and
rejects with the executor's preflight error when the spawn fails before
registration. It takes the session's shared spawn permit, so
`task.concurrencyPolicy = "refuse"` rejects a seam spawn with the same
`SpawnRefusedError` text a `task` call gets, and the permit is held until the
detached run settles. Hosts without a tool session reject the call.

Covering tests: `test/a2a-server.test.ts` (card contract, auth, method set,
addressing, spawn seam, loopback enforcement, SSE, token file).

## A2A bridge (client)

The client side turns a remote bridge into task-tool agents. `/a2a add` reads
the remote AgentCard and registers one **runtime** agent per card skill in the
session's in-memory bridge — no `.md` files, nothing persisted:

```bash
/a2a add http://127.0.0.1:7391          # card fetched from /.well-known/agent-card.json
/a2a add http://10.0.0.5:7391 --token $REMOTE_TOKEN
/a2a list                               # a2a:main — Main omp agent (http://127.0.0.1:7391/)
/a2a remove a2a:main
```

Spawn one through the ordinary `task` tool; the call goes to the remote
endpoint and the answer comes back in the standard `<task-result>` envelope:

```jsonc
{ "agent": "a2a:main", "task": "summarize the failing tests" }
```

Wire behavior:

- `SendMessage` (PascalCase, role `ROLE_USER`, text parts) then `GetTask`
  polling — A2A is async-first, so an hour-long remote run is normal.
- Final text comes from `artifacts[].parts[].text`, then the status message,
  then the last `ROLE_AGENT` history message. The bridge server inlines a
  completed run's published output as an artifact, so an answer crosses the
  wire; `metadata.outputPath` is never read by the client (it names a file on
  the server's disk).
- `TASK_STATE_INPUT_REQUIRED` / `TASK_STATE_AUTH_REQUIRED` are *interrupted*,
  not terminal: the spawn fails with `waiting for input; unavailable in omp v1`
  (or `authentication required; …`) instead of hanging.
- Connect is bounded at 10s per request. The whole-run budget defaults to
  unlimited; `a2a.clientTimeoutMs` (ms, `0` = no limit) opts into a deadline.
  Polling starts at 2s and backs off to 30s.

| Knob                   | Default | Meaning                                    |
| ---------------------- | ------- | ------------------------------------------ |
| `a2a.clientTimeoutMs`  | `0`     | Total budget for a remote spawn; 0 = none  |

The bearer token used for RPC comes from `--token`, then the `a2a.token`
setting, then `<agent dir>/a2a.token` (read-only: registering never generates
credentials). Registrations are session-scoped: `/resume` starts empty, and a
local subagent does not inherit its parent's remote roster.

Covering tests: `test/a2a-client.test.ts` (wire methods, polling/backoff,
artifact and message text, interrupted states, connect/auth errors,
`/a2a add` registration, task-tool spawn, and the two-instance loop against
`test/a2a-server.test.ts`'s server).

## Workflow VM with journal resume

`src/workflow/` adds a deterministic JavaScript orchestrator over the task
executor. The `workflow` tool takes `{ script, args?, resumeFrom? }`; the script
is an async function body executed in a fresh `node:vm` context:

```js
phase("gather");
const found = await parallel(["auth", "billing", "search"], topic => agent(`find ${topic} entry points`), {
	concurrency: 2,
});
log("scanned", found.length, "areas");
return found.map(f => f.result);
```

| Helper                                        | Contract                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `agent(prompt, opts?)`                        | Spawns one inline `task` subagent (agent/context in `opts`) and resolves `{ result, tokens, cached? }`; takes the session's shared spawn slot |
| `parallel(items, fn, { concurrency })`        | Bounded worker pool, results in item order; concurrency defaults to `4` |
| `pipeline(items, ...stages)`                  | Each item flows through stages in order; items overlap                  |
| `phase(name)` / `log(...)` / `clock()`        | Progress markers, run log, deterministic 1-based counter                |
| `args`                                        | The call's `args` string (default `""`)                                 |

`agent()` acquires the session spawn permit that `task` and the
`pi.spawnSubagent` seam use, so `task.maxConcurrency`/`task.concurrencyPolicy`
bound workflow fan-out too. A child that settles with a non-zero exit code, an
`error`, or an abort is an error, not a result: the journal records `failed`,
the run fails, and `resumeFrom` re-executes the call instead of caching the
failure as a completed answer. Remote `a2a:<skill>` agents are rejected here —
only the task tool routes them to their endpoint.

### Determinism rules

The context is the enforcement point, not a lint pass:

- `require`, `process`, `Date`, `Date.now`, `Math.random`, and
  `Temporal.Now` throw a `ReferenceError` naming the rule and pointing at
  `clock()`/`args`;
- `import` and `import()` are rejected before execution (static import is a
  syntax error, dynamic import is caught with `@babel/parser`);
- `codeGeneration` is disabled, so `eval` and `new Function` throw `EvalError`;
- `ShadowRealm` is removed because `ShadowRealm.evaluate()` would create an
  unguarded realm;
- after the prelude, every global outside a documented allowlist is deleted or
  poisoned, so a runtime-injected host helper (`Bun`, `fetch`, timers,
  `WebSocket`, `crypto`, `performance`, …) is never visible.

Only one `parallel`/`pipeline` fan-out may be in flight at a time; nesting or
overlapping them is rejected. Only primitives, JSON strings, and null-prototype
frozen bridge functions cross the VM boundary, and the bridges are deleted from
the global object before user code runs.

The synchronous portion of a script (everything before its first `await`) is
bounded by `runInContext`'s timeout (30 s). The tool's abort signal cancels the
wait on an asynchronous script, but it cannot stop a tight synchronous loop —
that is what the VM timeout is for — and asynchronous continuations already
queued in the sandbox keep running after an abort.

### Journal and `resumeFrom`

Every `agent()` call appends synchronously to
`<session dir>/workflow/<session>/journal.jsonl` (fallback:
`<agent dir>/workflow/<session id>/journal.jsonl`):

```jsonc
{"runId":"wf-…","index":0,"promptHash":"…","agent":"default","result":null,"tokens":0,"status":"started"}
{"runId":"wf-…","index":0,"promptHash":"…","agent":"default","result":"…","tokens":812,"status":"completed"}
```

`status` is `started`, `completed`, `failed`, or `cached`; a killed run keeps
its completed prefix, and a truncated final line is ignored on read. If the
last line was truncated mid-write, the next append starts on a fresh line so
the new record is not concatenated onto the broken one.

`resumeFrom: "<runId>"` matches the prior run by call index **and** prompt
hash (prompt + agent + context). The matching completed/cached prefix is
replayed with `cached: true` and recorded as `cached` lines under a new run id;
execution starts at the first divergence and continues to the end, even if a
later hash matches. Runs can be resumed repeatedly (a resumed run's own
`cached` lines are valid replay sources).

Covering test (also the kill-resume smoke: a child bun process runs the real
tool with a fake executor, hangs on the second call, is SIGKILLed, then the
parent resumes and asserts the first call is not re-executed):

```bash
PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test packages/coding-agent/test/workflow.test.ts
```

The tool is registered as the `workflow` built-in
(`BUILTIN_TOOLS.workflow` → `WorkflowTool.create`) with `loadMode: "essential"`,
so ordinary sessions see it in the top-level schema. Docs:
`docs/tools/workflow.md`.

## Capability tokens for destructive operations

`src/safety/capability-tokens.ts` gates the operations that can destroy work
with no other copy, following the Claude Code `--discard-unpushed` pattern: the
first attempt is always refused, and the refusal hands back a token that
authorizes exactly one execution.

- `issueCapabilityToken(action, target)` mints `"<8hex>@<id>"` — an unguessable
  8-hex nonce plus the grant number. A token is bound to one `action` and one
  `target`, so a token for an isolation discard cannot cancel a job.
- Tokens are **one-shot** (consuming deletes the grant, so a replay refuses)
  and live **10 minutes** (`CAPABILITY_TOKEN_TTL_MS`). Grants sit in an
  in-memory map with an `unref`'d TTL timer and are never persisted: a restart
  cannot resurrect an authorization the user has not repeated.
- `requireCapabilityToken({ action, target, force, consequence, retry })`
  validates without consuming — the surface that owns the retry channel spends
  the token itself (`proc://<id>/kill` burns it after dispatching the cancel),
  so a replay refuses. A missing, spent, expired, or mismatched token produces
  `CapabilityRequiredError` whose message names the fresh token and the exact
  parameter that carries it; nothing has been destroyed when it is thrown.

Gated surfaces and their graduated rules:

| Surface | Refuses | Stays tokenless |
| --- | --- | --- |
| `task/isolation-runner.ts` → `discardIsolationWorkspace(handle, { force })` | deleting a worktree that still holds staged, unstaged, or untracked files | a provably clean worktree; a run whose delta already reached disk (patch artifacts or a task branch) |
| `internal-urls/proc-protocol.ts` → `write { path: "proc://<id>/kill" }` | cancelling an **agent** (task job or jobless registration) that owes turns to queued peer messages or whose parked/aborted transcript exists only in memory; the retry carries the token as the write's `content` | bash jobs (their output stays readable through `proc://<id>`), services (their log stays on disk), settled rows, and every release with nothing unsaved |
| Agent Hub `x`, RPC `cancel_subagent`, collab guest `kill` | nothing — these are the user's explicit decision and have no force parameter to carry a token back | always |

The gate deliberately lives at the model-facing `proc://<id>/kill` and nowhere
deeper: `AgentLifecycleManager.release` never refuses. An interactive kill
surface that refused could not be completed — the user has no channel to hand
the lifecycle a token — which is worse than the queued-message loss it would
prevent.

The `proc://` gate is backward compatible: it only reuses `content`, which kill
already accepted and ignored, and the prompt doc still advertises "omit
`content`". A failed isolated run never captured its delta, so a dirty worktree
is now **retained** under a `.retained-*` sibling (and logged with its path)
instead of being deleted.

Covering test:

```bash
PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test packages/coding-agent/test/capability-token.test.ts
```

## Rebase ritual

1. Sync the mirror (fast-forward only) and push it:

   ```bash
   git switch main
   git fetch upstream main
   git merge --ff-only upstream/main
   git push origin main            # mirror commits only
   ```

2. Bring upstream into the integration branch. Merge — do not rebase the
   integration branch itself, since feature branches are rebased onto it:

   ```bash
   git switch integrate/agents-upgrade
   git merge main
   ```

3. Move every feature branch onto the integration branch:

   ```bash
   scripts/rebase-forks.sh
   ```

   The script rebases each local branch matching `feat/*` (override with
   `OMP_FORK_BRANCHES`, or the base with `OMP_FORK_BASE`), skips branches already
   on the base, and skips branches checked out in another worktree. It refuses to
   start with uncommitted tracked changes or an unfinished rebase.

4. Resolve conflicts. On the first conflict the script stops, lists the
   conflicted files, and exits 1:

   ```bash
   git status                      # conflicted paths
   # edit the files, then:
   git add <files> && git rebase --continue
   # or abandon this branch's rebase:
   git rebase --abort
   ```

   Re-run `scripts/rebase-forks.sh` afterwards to continue with the remaining
   branches.

5. Re-run the fork's covering tests with the isolated profile before committing:

   ```bash
   PI_CODING_AGENT_DIR=$HOME/.omp-fork bun test \
     packages/coding-agent/test/irc-bus.baseline.test.ts \
     packages/coding-agent/test/tools/irc.test.ts \
     packages/coding-agent/test/session/irc-bridge-relay.test.ts \
     packages/coding-agent/test/task/executor-irc-wake-yield-reset.test.ts
   ```

## Baseline tests

`packages/coding-agent/test/irc-bus.baseline.test.ts` pins the upstream mailbox
contract the fork's messaging work builds on. It is a tripwire, not a copy of
the IRC suite: its header names the upstream tests that already cover the
headline scenarios (waiter resolution, parked revival, busy aside, unknown-id
failure, mailbox cap) and asserts only the gaps — failed sends leave no mailbox
residue, a waiter on a parked recipient still revives it, bus-level delivery to
a streaming recipient queues an interrupt instead of prompting, and the mailbox
cap bounds unread counts while `wait` drains survivors oldest-first.

The full `bun test` run has pre-existing upstream failures (environmental
browser-tab and cross-platform cases, plus parallel-run flakes). Treat only
failures outside that recorded baseline as regressions.
