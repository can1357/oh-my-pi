# Remote IRC bridge (reference)

A minimal, open implementation of the cross-process IRC seams: an extension that connects an omp
session to agents in other processes, and a terminal client that plays those agents. The production
consumer of these seams is the murmur bridge, which is closed source; this example exists so the feature
can be run, reviewed and demonstrated entirely from this repository.

```
 omp session ──(-e extension.ts)──┐                         ┌── peer-cli.ts (one terminal)
   write agent://@demo/leia  ───► │  JSON lines over a Unix │ ◄── prints "[Main → @demo/leia] …", acks
   read history://  (roster) ◄─── │  domain socket          │ ──► you type "leia: …" → delivered to omp
```

## Files

| File           | Role                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension.ts` | Inside omp. On `session_start` of the top-level session: reads the roster, `setRemoteTransport`, `registerRemotePeer` per name, connects to the socket (reconnects). |
| `peer-cli.ts`  | Outside omp. Writes the roster, listens on the socket, prints omp's messages and acks them, reads stdin to send messages as any rostered peer.                      |
| `protocol.ts`  | The wire types and line codec shared by both.                                                                                                                      |

## Demo: two terminals, five minutes

Everything below runs from `packages/coding-agent` in a checkout of this repo and stays isolated from
any other omp sessions on the machine: unique socket/roster paths, `--no-extensions` (no auto-discovered
extensions; the explicit `-e` still loads), `--no-session` (nothing written to your session store), and a
scratch `--cwd` (no project `AGENTS.md` or `.mcp.json`). Your normal model auth is used as is.

Setup, once:

```bash
cd packages/coding-agent
mkdir -p /tmp/omp-remote-irc/project
```

Terminal A — the mesh (plays `leia` and `han`):

```bash
cd packages/coding-agent
bun examples/extensions/remote-irc-bridge/peer-cli.ts \
  --namespace demo --peers leia,han \
  --socket /tmp/omp-remote-irc/bridge.sock --roster /tmp/omp-remote-irc/roster.json
# roster written to /tmp/omp-remote-irc/roster.json
# listening on /tmp/omp-remote-irc/bridge.sock as @demo/{leia,han}
# start omp with: …   (prints the exact terminal-B command with an absolute path)
```

Terminal B — omp, from source or an installed binary (swap `bun src/cli.ts` for `omp`):

```bash
cd packages/coding-agent
OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json \
  bun src/cli.ts --no-extensions --no-session --cwd /tmp/omp-remote-irc/project \
  -e "$PWD/examples/extensions/remote-irc-bridge/extension.ts"
```

Use an absolute `-e` path: it resolves against omp's working directory, so a relative path breaks as soon
as `--cwd` is set. If omp reports `Failed to load extension …`, that is the cause. Warnings about MCP
servers from your global `mcp.json` are expected and harmless.

Terminal A prints `omp session "Main" connected; it addresses us as @demo/<peer>`. Then:

1. In omp: `read history://` — the index lists `@demo/leia` and `@demo/han` as `remote`, with a footer
   explaining the form. Only these two peers appear, which also confirms the run is isolated.
2. In omp: `send "hello from omp" to @demo/leia via write agent://@demo/leia` — terminal A prints
   `[Main → @demo/leia] hello from omp` and acks; the model gets `Delivered to @demo/leia.`
3. In omp: `read agent://@demo/leia` — "remote peer, no local output to read; message it with …".
4. In terminal A: `leia: are you there?` — omp receives it as a peer message from `@demo/leia` (an idle
   session wakes, a streaming one is steered); A prints the receipt (`↳ peer-1: woken`).
5. In terminal A: `leia?: what is 2+2` — sent with `expectsReply`; the CLI remembers the question and
   prints omp's next message to leia as `[Main → @demo/leia] (reply to peer-2) …`.
6. `/peers` lists the roster; `/quit` exits terminal A and removes the socket. Cleanup:
   `rm -rf /tmp/omp-remote-irc`.

Headless works too, and is the exchange `test/examples/remote-irc-bridge.test.ts` reproduces:

```bash
OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json \
  bun src/cli.ts -p --no-extensions --no-session --cwd /tmp/omp-remote-irc/project \
  -e "$PWD/examples/extensions/remote-irc-bridge/extension.ts" \
  "Call wait to receive the first peer message, reply to its sender with 'pong: <body>' via write agent://<sender>, then summarise."
# terminal A:  leia?: ping
#              ↳ peer-1: injected (omp id …)
#              [Main → @demo/leia] (reply to peer-1) pong: ping
```

## Wire protocol

Newline-delimited JSON; the peer listens, the bridge connects (one connection per root session).

| Direction     | Message                                                               | Meaning                                                                 |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| bridge → peer | `{type:"hello", agentId, namespace}`                                  | Session connected; `agentId` is what inbound `to` should name.          |
| bridge → peer | `{type:"outbound", id, from, to, toName, body, expectsReply}`         | `write agent://@ns/<toName>`; the peer must answer with an `ack`.       |
| peer → bridge | `{type:"ack", id, receipt}`                                           | Becomes the sender's `IrcDeliveryReceipt`. Unacked after 10 s → failed. |
| peer → bridge | `{type:"inbound", id, from, to, body, expectsReply}`                  | `from` is a bare rostered name; delivered as `@ns/<from>` → `to`.       |
| bridge → peer | `{type:"receipt", id, receipt, ompId}`                                | Delivery outcome of that inbound plus omp's native message id.          |

Trust model: the socket is a user-owned local path and both ends are the same user's processes, so peer
lines are parsed as JSON and used without shape validation (only the roster file is validated). A bridge
that crosses a trust boundary must validate every line and authenticate the peer before `deliverInbound`.

## What it deliberately does not do

- Authentication, multiple namespaces per process, or more than one connected session. A real bridge
  (murmur) adds those; the omp seams support them (`setRemoteTransport` per namespace, ownership-checked
  `registerRemotePeer`, inbound sender gating to the claimed namespace).
- Claim from a subagent. Only `ctx.agent.kind === "main"` connects; subagents share the root's
  registry, bus and transport.
