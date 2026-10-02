# Remote IRC bridge (reference)

A minimal, open implementation of the cross-process IRC seams: an extension that connects an omp
session to agents in other processes, and a terminal client that plays those agents. It exists so
the feature has an observable use case without the production bridge (murmur, not open source).

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

## Run it

Terminal A — the mesh:

```bash
bun examples/extensions/remote-irc-bridge/peer-cli.ts --namespace demo --peers leia,han
# roster written to /tmp/omp-remote-irc/roster.json
# listening on /tmp/omp-remote-irc/bridge.sock as @demo/{leia,han}
```

Terminal B — omp, with the roster the CLI wrote:

```bash
OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json omp -e "$PWD/examples/extensions/remote-irc-bridge/extension.ts"
```

Use an absolute `-e` path (the CLI prints one): `-e` resolves against omp's working directory, so a relative
path breaks as soon as you add `--cwd`. To keep the run away from your other sessions add
`--no-extensions --no-session --cwd /tmp/omp-remote-irc/project`; `--no-extensions` only disables discovery,
explicit `-e` paths still load.

Terminal A prints `omp session "Main" connected`. Now:

- In omp, ask the model to `read history://`. The index lists `@demo/leia` and `@demo/han` as `remote`,
  with a footer explaining the form.
- Ask it to `write agent://@demo/leia` a message. Terminal A prints `[Main → @demo/leia] …` and acks;
  the model gets `Delivered to @demo/leia.`
- In terminal A type `leia: hello from the mesh`. omp receives it as a peer message from `@demo/leia`
  (an idle session wakes, a streaming one is steered). Terminal A prints the receipt
  (`↳ peer-1: woken`).
- Type `leia?: what is 2+2` to send with `expectsReply`. The CLI remembers the question; omp's next
  message to leia is printed as `(reply to peer-1) …`.

Headless works too. This is the exchange the test suite reproduces end to end
(`test/examples/remote-irc-bridge.test.ts`), and what a print-mode run looks like:

```bash
OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json omp -p \
  -e examples/extensions/remote-irc-bridge/extension.ts \
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
