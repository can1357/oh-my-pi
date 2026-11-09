# A2A inter-terminal agent networking

> Every omp process serves an Agent2Agent v1.0 bridge on `127.0.0.1`, so
> sessions running in separate terminals discover each other, address each
> other's agents by name, and exchange tasks and replies over JSON-RPC 2.0.

## What it is

The unit of communication is a *terminal*: one omp process (usually one
interactive session). Two mechanisms cover all agent-to-agent traffic:

- **In-session peer messaging** — subagents inside one omp process message each
  other directly through `write agent://<id>` over the IRC bus (rate, dedup, and
  hop limits guard it). `write agent://` reaches **local** session agents only.
  See [Agent Hub](./agent-hub.md) for the roster UI.
- **Inter-terminal A2A** — agents in *different processes* reach each other
  through each terminal's A2A bridge: the local loopback server exposing the
  Agent2Agent protocol (agent card at `/.well-known/agent-card.json`, JSON-RPC
  2.0 over HTTP, optional SSE task streaming), plus a client that registers peer
  bridges and spawns their agents through the task tool.

```mermaid
flowchart LR
  subgraph terminalA["Terminal A (omp process)"]
    A1["main agent"] <-->|"agent://id in-session"| A2["subagents"]
  end
  subgraph terminalB["Terminal B (omp process)"]
    B1["main agent"] <-->|"agent://id in-session"| B2["subagents"]
  end
  A1 -->|"spawn a2a:&lt;peer-name&gt;\nJSON-RPC SendMessage"| BR["A2A bridge\n127.0.0.1:port"]
  BR -->|"delivery into B's chat\nvia IRC bus"| B1
  B1 -.->|"correlated reply: spawn a2a:&lt;sender-name&gt;\nmetadata.inReplyTo"| A1
```

The A2A protocol is only served on the loopback interface; a bridge never
accepts connections from other hosts, and every request must present the
bearer token. Terminals sharing one profile share the token file, which is
what makes the zero-config auto-registration below work.

## Quick start

Nothing to enable: `a2a.enabled` is on by default and `a2a.port: 0` picks a
free ephemeral port per terminal. With `a2a.autoRegister` enabled, each
terminal registers live peers at session start and discovers later terminals
on demand:

1. Terminal A and terminal B each run `omp`. With no `--a2a-name` and an
   empty `a2a.name`, each gets a unique auto name `<slug(basename(cwd))>-<pid>`
   (skill-id-safe); with `--a2a-name` / `a2a.name`, that configured name is used instead. There is no default
   `Main` name.
2. In A, ask the agent to spawn a peer's main agent by its `a2a:` name, e.g.
   "spawn `a2a:<B's name>` with the prompt: what are you working on?".
3. The task travels to B and lands in the addressed agent's conversation. A
   successful delivery returns a receipt and a running reply-job ID, not the
   answer. Use `wait` on that job to receive the correlated reply.
   The addressed agent can explicitly reply by spawning `a2a:<sender>` with
   the task tool; otherwise Main can relay its final text, and a subagent can
   relay its wake-turn published output or final text. Failed, aborted, or empty
   turns leave the request open for an explicit reply. The process-wide incoming
   ledger covers Main, subagents, and worker links; only the addressed agent
   can claim its request. Automatic relays atomically claim before sending
   detached, so remote transport does not hold up turn settlement.

Terminals that start later become visible on demand: a bare `read agent://`
roster, or a task-tool spawn of an unknown `a2a:` name, triggers a debounced
(2 s) rescan of the live bridge registry, registering new peers and dropping
peers whose bridge is gone.

Manual commands: `/a2a auto` (re-scan the bridge registry), `/a2a add <url>
--token <t>`, `/a2a list`, `/a2a remove <name>`.

## Addressing and delivery

Each terminal writes **one file per process**,
`<agent dir>/a2a-bridges/<pid>.json`, atomically (tmp + rename). Each entry
carries `pid`, `port`, `name`, `startedAt`, and a random `instanceId` that is
also present on the served agent card. Readers list the directory, keep only
entries whose pid is alive, delete dead entries, and (when registering a peer)
confirm the card at that port reports the same `instanceId`. The bridge removes
its own file on shutdown. The old single-file `a2a-bridges.json` format is no
longer read or written. Concurrent registrations never clobber each other
because each process owns its own file.

The terminal's configured or auto name is its card's main skill id, its local
bridge entry name, its sender identity name, and an alias for addressing Main;
peers register it as `a2a:<name>`. Re-registering the same endpoint replaces that
endpoint's entries (no `Main-3`-style duplicates); distinct endpoints sharing
a name still get `-2`/`-3` suffixes: `a2a:Main`, `a2a:Main-2`, ...

A spawn of `a2a:<name>` goes through the task tool like any agent:

1. The client resolves the bridge URL and sends a JSON-RPC `SendMessage` with
   `metadata` carrying the target skill, the sender's identity, and (for a
   batch spawn) the shared `context`. A reply adds `metadata.inReplyTo`.
2. The server validates the bearer token, resolves the target agent, and
   delivers the body into the peer's conversation through the IRC bus (marked
   `external`, which the ingress guard exempts). A *request* is wrapped in a
   reply envelope naming `a2a:<sender>` and telling the recipient that its
   answer will be correlated automatically. The request is recorded as
   outstanding for that peer; a *reply* is labelled as the answer to that
   request with no new envelope.
3. For an addressed request, a successful delivery receipt leaves an owned
   reply job running. `wait` returns its answer when both the original message
   ID and expected peer match `metadata.inReplyTo` and the sender identity.
   A matched reply completes the job without a duplicate IRC delivery. A
   mismatched or late reply instead enters the addressed conversation as a
   labelled IRC reply, with no new reply envelope. Cancelling the reply job
   stops the local wait; it does not cancel the peer's work. If no async job
   manager or owner is available, the caller waits synchronously instead.
   A subagent must `wait` on its reply job before its run ends; otherwise the
   job is cancelled and a late reply arrives at Main over IRC.

An explicit task-tool reply consumes the outstanding request addressed to that
agent from that peer and attaches `metadata.inReplyTo`. Set `a2aSpawn: true`
to spawn a new remote agent instead: this bypasses reply matching and follows
the remote task's result rather than opening an addressed reply job.

For remote spawns, task states follow the A2A task model: `SUBMITTED` ->
`WORKING` -> `COMPLETED`/`FAILED` (via `GetTask` polling or SSE updates).
If a reserved spawn has not registered yet, it remains `SUBMITTED`; registration
failure becomes `FAILED`. A cancellation requested while registration is
pending is applied to that exact agent once it registers. `CancelTask` only
cancels bridge-created tasks; Main and local subagents are not cancelable
through the bridge, including when Main is addressed by its identity alias.

## JSON-RPC surface

- `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SendStreamingMessage`.
- `ListTasks` persists the client's `message.contextId` for tasks created by
  `SendMessage` and filters on it; pages are ordered by creation time/id
  (stable), and an empty `pageToken` is accepted as the first page.
- Requests without an `id` are **notifications**: processed, answered with
  HTTP 204 and no body. Batch arrays return an array of responses with
  notifications omitted; an all-notification batch returns 204.
- `CancelTask` only cancels tasks created through this bridge (spawns
  delivered over A2A); `Main` and local subagents are refused with
  `TASK_NOT_CANCELABLE`. Terminality is re-checked after the abort, and an
  `aborted` status is never written to a stale ref generation.

## Limits and safeguards

| Safeguard | Behavior |
| --- | --- |
| Loopback-only server | The bridge binds `127.0.0.1` and refuses other hosts; bearer token required on every JSON-RPC call. |
| Roster flood guard | `a2a.maxPeerSkills` (default 8) caps skills registered from one peer card — a peer advertising swarms of finished one-shot workers cannot flood the roster. |
| Card filtering | The card lists only the main and currently running agents; finished one-shot workers never appear. |
| Ingress guard | Inbound A2A deliveries are `external` IRC messages, exempt from the rate/dedup/hop guard applied to in-session traffic. |
| Output cap | Published task output is inlined as an artifact capped at 100 k characters; files themselves never travel. |
| Reply deadline | `a2a.replyTimeoutMs` defaults to `1_800_000` ms (30 minutes); `0` means no deadline for an addressed reply. A timeout ends the local wait, not the remote work. |
| Client budget | `a2a.clientTimeoutMs` (default 0, no total budget) bounds transport for the initial `SendMessage` and any `GetTask` polls, not the separate addressed-reply wait. The per-request connect timeout remains 10 s. |
| Plan mode | Every `a2a:` dispatch is refused in plan mode: a remote terminal cannot be held read-only. |

## Settings

All A2A settings live in the tasks tab; see the full table with types and
defaults in [Settings -> Inter-terminal agent networking
(A2A)](./settings.md#inter-terminal-agent-networking-a2a). The same section
colocates `session.retentionDays` (session-file GC) and the IRC guard settings.

## Source

- Bridge (server, client, agent bridge, RPC dispatch): `packages/coding-agent/src/a2a/`
- IRC bus and ingress guard: `packages/coding-agent/src/irc/`
- Registry and peer discovery: `packages/coding-agent/src/registry/`
- Tests: `packages/coding-agent/test/a2a-server.test.ts`,
  `packages/coding-agent/test/a2a-client.test.ts`
- Fork notes: `README-fork.md`, `FORK-RU.md`
