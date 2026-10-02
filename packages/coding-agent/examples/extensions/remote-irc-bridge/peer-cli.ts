#!/usr/bin/env bun
/**
 * Peer CLI: a terminal that plays every remote agent on the other side of `extension.ts`.
 *
 *   bun examples/extensions/remote-irc-bridge/peer-cli.ts --namespace demo --peers leia,han
 *
 * 1. Writes the roster file the bridge reads (`--roster`, default /tmp/omp-remote-irc/roster.json).
 * 2. Listens on the Unix socket named in that roster (`--socket`).
 * 3. Prints every message omp sends to a rostered peer, and acks it so the model gets a receipt.
 * 4. Reads stdin: `leia: hello` delivers "hello" into omp as `@demo/leia`; `leia?: question`
 *    additionally marks the message `expectsReply` and prints omp's next message to leia as the
 *    reply. `/peers` lists the roster, `/quit` exits.
 *
 * Then, in another terminal:
 *
 *   OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json omp -e examples/extensions/remote-irc-bridge/extension.ts
 *
 * and inside omp: `read history://` lists `@demo/leia` as a `remote` peer; `write agent://@demo/leia`
 * arrives here. A standalone CLI (not a TUI), so console output is the intended interface.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type BridgeMessage, LineDecoder, LineWriter, type PeerMessage, type Roster } from "./protocol";

const { values } = parseArgs({
	options: {
		namespace: { type: "string", default: "demo" },
		peers: { type: "string", default: "leia,han" },
		socket: { type: "string", default: "/tmp/omp-remote-irc/bridge.sock" },
		roster: { type: "string", default: "/tmp/omp-remote-irc/roster.json" },
	},
});
const roster: Roster = {
	namespace: values.namespace,
	socket: values.socket,
	peers: values.peers
		.split(",")
		.map(peer => peer.trim())
		.filter(peer => peer.length > 0),
};
if (roster.peers.length === 0) {
	console.error("peer-cli: --peers must name at least one peer");
	process.exit(2);
}

await fs.mkdir(path.dirname(roster.socket), { recursive: true });
await Bun.write(values.roster, `${JSON.stringify(roster, null, 2)}\n`);
await fs.rm(roster.socket, { force: true });

let bridge: Bun.Socket | undefined;
let bridgeAgentId = "Main";
let nextId = 1;
/** Inbound messages sent with `expectsReply`, keyed by peer name: the next outbound to that peer is the reply. */
const awaitingReply = new Map<string, string>();
// Acks and inbound lines go through a drain-aware writer, like the bridge's side (see LineWriter).
const writer = new LineWriter();

const send = (message: PeerMessage): void => {
	if (!writer.write(message)) console.log("(no omp session connected yet)");
};

const handleBridgeMessage = (message: BridgeMessage): void => {
	switch (message.type) {
		case "hello":
			bridgeAgentId = message.agentId;
			console.log(`omp session "${message.agentId}" connected; it addresses us as @${message.namespace}/<peer>`);
			return;
		case "outbound": {
			// Routing is prefix-authoritative: omp forwards `write agent://@demo/<anyone>` whether or not
			// a proxy is registered, so a target this terminal does not play must fail, not read as
			// delivered.
			if (!roster.peers.includes(message.toName)) {
				console.log(`[${message.from} → ${message.to}] rejected: no such peer here`);
				send({
					type: "ack",
					id: message.id,
					receipt: {
						to: message.to,
						outcome: "failed",
						error: `@${roster.namespace}/${message.toName} is not a rostered peer (${roster.peers.join(", ")})`,
					},
				});
				return;
			}
			const replyTo = awaitingReply.get(message.toName);
			if (replyTo) {
				awaitingReply.delete(message.toName);
				console.log(`[${message.from} → ${message.to}] (reply to ${replyTo}) ${message.body}`);
			} else {
				console.log(
					`[${message.from} → ${message.to}]${message.expectsReply ? " (expects reply)" : ""} ${message.body}`,
				);
			}
			send({ type: "ack", id: message.id, receipt: { to: message.to, outcome: "injected" } });
			return;
		}
		case "receipt":
			console.log(
				`  ↳ ${message.id}: ${message.receipt.outcome}${message.receipt.error ? ` — ${message.receipt.error}` : ""}${message.ompId ? ` (omp id ${message.ompId})` : ""}`,
			);
			return;
	}
};

const newDecoder = (): LineDecoder<BridgeMessage> =>
	new LineDecoder<BridgeMessage>((line, error) =>
		console.error(`dropped malformed bridge line: ${line} (${String(error)})`),
	);
// One decoder per connection, so a partial line buffered from a replaced session never prefixes
// the next session's first line.
const decoders = new WeakMap<Bun.Socket, LineDecoder<BridgeMessage>>();

Bun.listen({
	unix: roster.socket,
	socket: {
		open(socket) {
			if (bridge) {
				console.log("(a second omp session connected; replacing the first)");
				bridge.end();
			}
			bridge = socket;
			writer.attach(socket);
			decoders.set(socket, newDecoder());
		},
		drain(socket) {
			if (bridge === socket) writer.flush();
		},
		data(socket, chunk) {
			const decoder = decoders.get(socket);
			if (!decoder) return;
			for (const message of decoder.push(chunk)) handleBridgeMessage(message);
		},
		close(socket) {
			decoders.delete(socket);
			if (bridge === socket) {
				bridge = undefined;
				writer.detach();
				console.log("omp session disconnected");
			}
		},
		error(_socket, error) {
			console.error(`socket error: ${error.message}`);
		},
	},
});

console.log(`roster written to ${values.roster}`);
console.log(`listening on ${roster.socket} as @${roster.namespace}/{${roster.peers.join(",")}}`);
console.log("start omp with:");
console.log(`  OMP_REMOTE_IRC_ROSTER=${values.roster} omp -e ${path.join(import.meta.dir, "extension.ts")}`);
console.log("type `<peer>: message` to send, `<peer>?: message` to send and await a reply, /peers, /quit");

const INPUT_RE = /^([A-Za-z0-9._-]+)(\?)?:\s*(.*)$/;
for await (const rawLine of console) {
	const line = rawLine.trim();
	if (line.length === 0) continue;
	if (line === "/quit") break;
	if (line === "/peers") {
		console.log(roster.peers.map(peer => `@${roster.namespace}/${peer}`).join("\n"));
		continue;
	}
	const match = INPUT_RE.exec(line);
	if (!match) {
		console.log("format: <peer>: message   or   <peer>?: message");
		continue;
	}
	const [, peer, expectsReply, body] = match;
	if (!roster.peers.includes(peer)) {
		console.log(`unknown peer "${peer}"; rostered: ${roster.peers.join(", ")}`);
		continue;
	}
	if (body.length === 0) {
		console.log("empty message");
		continue;
	}
	const id = `peer-${nextId++}`;
	if (expectsReply) awaitingReply.set(peer, id);
	send({ type: "inbound", id, from: peer, to: bridgeAgentId, body, expectsReply: expectsReply !== undefined });
}

bridge?.end();
await fs.rm(roster.socket, { force: true });
process.exit(0);
