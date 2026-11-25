# URL-scheme bridge (reference)

A minimal, runnable bridge between an omp session and agents in other processes, built only on the
public extension API: `pi.registerUrlScheme`, `pi.replies.expect`,
`pi.onSuspensionChange`, and `pi.sendMessage`. A terminal client plays the remote agents. It is
the starting point for real bridges (such as murmur's addon) and shows each seam in a few hundred
lines.

```
 omp session ──(-e extension.ts)──┐                         ┌── peer-cli.ts (one terminal)
   write demo://leia  ──────────► │  JSON lines over a Unix │ ◄── prints "[Main → leia] …", acks
   read demo://  (roster)         │  domain socket          │ ──► you type "leia: …" → steered into omp
```

## Files

| File           | Role                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension.ts` | Inside omp. Its factory reads the roster and registers `<namespace>://`; on `session_start` of the top-level session it connects to the socket (reconnects). |
| `peer-cli.ts`  | Outside omp. Writes the roster, listens on the socket, prints omp's messages and acks them, reads stdin to send messages as any rostered peer.        |
| `protocol.ts`  | The wire types and the line codec shared by both (streaming UTF-8 decode, a writer that never truncates a record under socket backpressure).         |

## How it maps onto the API

- **`pi.registerUrlScheme(handler)`** serves `<namespace>://` (the roster's `namespace`, e.g. `demo`):
  - `read demo://` lists the peers and the socket state; `read demo://leia` describes one peer.
  - `write demo://leia` sends the written text to `leia` over the socket. The peer's ack is the
    write result; an unrostered peer, a dropped socket or a missing ack fails the write.
  - Composer tab completion after `demo://` offers the peer names.
  - The spec mirrors `agent://` messaging: `write.via: "handler"`, `scope: "coordination"`, read tier.
  - The scheme follows the extension load: it pauses while a live `disabledExtensions` edit
    suspends the load, returns on resume, and is released at session shutdown. The bridge never
    unregisters it itself.
- **`pi.replies.expect(peerId)`**: a written message expects an answer unless the URL carries
  `?notify` (`write demo://leia?notify`). The bridge records the expectation before sending, so
  `wait` blocks for the answer instead of reporting "Nothing to wait for". Each message from that
  peer that reaches the transcript (`message_start`, after the steer has ended the `wait`) settles
  the oldest question the agent asked it; a failed send withdraws its own expectation, and a dropped
  socket releases them all. Core drops expectations itself at a conversation boundary (`/new`, a
  resume or reload into another conversation, a branch, `/btw`, `/clear`); their releases then
  return `false`, and the bridge skips those questions, so the peer's next message settles the
  oldest question still owed.
- **`pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`**: a line from a peer is
  injected as a `url-scheme-bridge` custom message, `[@demo/leia] …`, with an answer hint when the
  peer asked for one. It steers a running turn (ending a `wait`) or starts a turn when idle.
- **`pi.onSuspensionChange(listener)`**: a live disable sends the load no events (no
  `session_shutdown`), so the bridge listens for its own suspension: it disconnects, so no peer
  message reaches a session whose bridge is disabled, and reconnects on resume. Only a load that
  connected in the top-level `session_start` reconnects, so a resume reaching a subagent's load
  opens nothing, and a resume that lands mid-connect starts an attempt that supersedes the pending
  one, which closes when it opens: the bridge never holds two connections.
- **Registered in the factory.** Startup decides from what a factory registered whether the
  extension may bind after the first prompt; registering the scheme there (not in `session_start`)
  keeps `demo://` completion and prompt docs available from the first prompt.
- **Top-level session only.** Subagents load the same extension and register the scheme too, but
  calls route to each session's own load and only the top-level session's load connects: a
  subagent's `write demo://…` is refused, so every expectation lands on the session whose `wait` the
  answer ends.

## Demo: two terminals

Everything below runs from `packages/coding-agent` in a checkout of this repo and stays isolated from
other omp sessions: a private socket/roster directory, `--no-extensions` (the explicit `-e` still
loads), `--no-session`, and a scratch `--cwd`. Your normal model auth is used as is.

Terminal A — the mesh (plays `leia` and `han`):

```bash
cd packages/coding-agent
bun examples/extensions/url-scheme-bridge/peer-cli.ts --namespace demo --peers leia,han
# roster written to /tmp/omp-peer-bridge-XXXXXX/roster.json
# prints the exact terminal-B command with an absolute -e path
```

The peer CLI makes a fresh 0700 directory under the OS temp dir for the roster and the socket, and
removes it on `/quit`. `--dir <path>` uses a fixed directory instead: created 0700 when missing,
refused when it exists and is not a 0700 directory owned by you. The bridge refuses a roster or
socket anywhere else: the peer is not authenticated, so whoever can place either file steers the
model.

Terminal B — omp, from source or an installed binary (swap `bun src/cli.ts` for `omp`), with the
roster path terminal A printed:

```bash
cd packages/coding-agent
mkdir -p /tmp/omp-peer-bridge-project
OMP_PEER_BRIDGE_ROSTER=/tmp/omp-peer-bridge-XXXXXX/roster.json \
  bun src/cli.ts --no-extensions --no-session --cwd /tmp/omp-peer-bridge-project \
  -e "$PWD/examples/extensions/url-scheme-bridge/extension.ts"
```

Use an absolute `-e` path: it resolves against omp's working directory, so a relative path breaks as
soon as `--cwd` is set.

Terminal A prints `omp session "Main" connected`. Then:

1. In omp: `read demo://` lists `demo://leia` and `demo://han`.
2. In omp: ask the model to send "hello" to leia with `write demo://leia` and then `wait`. Terminal A
   prints `[Main → leia] (expects reply) hello` and acks; the model's `wait` blocks.
3. In terminal A: `leia: hi there` — omp receives `[@demo/leia] hi there`, which ends the `wait`.
4. In terminal A: `leia?: what is 2+2` — sent as expecting an answer; terminal A prints omp's next
   message to leia as `(reply to peer-2) …`.
5. `/peers` lists the roster; `/quit` exits terminal A and removes its directory. Cleanup:
   `rm -rf /tmp/omp-peer-bridge-project`.

Headless works too (`-p`): the bridge connects on `session_start`, and a peer message steers the turn.

## Wire protocol

Newline-delimited JSON; the peer listens, the bridge connects (one connection per omp session).

| Direction     | Message                                                | Meaning                                                                   |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| bridge → peer | `{type:"hello", agentId, namespace}`                   | Session connected.                                                        |
| bridge → peer | `{type:"outbound", id, from, to, body, expectsReply}`  | `write <namespace>://<to>`; the peer must answer with an `ack`.           |
| peer → bridge | `{type:"ack", id, receipt}`                            | `receipt: {outcome: "delivered" \| "failed", error?}`. Unacked after 10 s → failed. |
| peer → bridge | `{type:"inbound", id, from, body, expectsReply}`       | `from` is a bare rostered name; injected as `[@<namespace>/<from>] …`.    |
| bridge → peer | `{type:"receipt", id, receipt}`                        | Sent once that inbound message reaches omp's transcript (`delivered`), or `failed` for an unrostered sender; a message dropped before admission gets none. |

Trust model: both ends are the same user's processes, and the roster and the socket sit in 0700
directories owned by that user. The bridge checks both directories when it loads (not a symlink,
owned by you, no group or other permissions) and fails the load otherwise. Each
side still checks every line against the record shapes above (`parsePeerMessage`,
`parseBridgeMessage`) and skips one that is not JSON or not a valid record, as it skips a malformed
line. A bridge that crosses a trust boundary must also authenticate the peer.

## What it deliberately does not do

- Authentication, several namespaces per process, or more than one connected session.
- Messaging from subagents: only the top-level session talks to the mesh.
- A custom renderer for injected peer messages (they render as plain custom messages).
