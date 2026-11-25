#!/usr/bin/env bun
/**
 * Peer CLI: a terminal that plays every remote agent on the other side of `extension.ts`.
 *
 *   bun examples/extensions/url-scheme-bridge/peer-cli.ts --namespace demo --peers leia,han
 *
 * 1. Makes a directory only this user can reach: a fresh 0700 one under the OS temp dir (removed on
 *    `/quit`), or `--dir <path>`, which is created 0700 when missing and refused when it already
 *    exists and is not a 0700 directory owned by this user. The bridge refuses any other location
 *    for the roster or the socket: whoever can place either one steers the model.
 * 2. Writes the roster file the bridge reads (`<dir>/roster.json`) and listens on the Unix socket it
 *    names (`<dir>/bridge.sock`).
 * 3. Prints every message omp sends to a rostered peer, and acks it so the model's `write` succeeds.
 * 4. Reads stdin: `leia: hello` delivers "hello" into omp from `@demo/leia`; `leia?: question`
 *    additionally marks it as expecting an answer and prints omp's next message to leia as the
 *    reply. `/peers` lists the roster, `/quit` exits.
 *
 * It prints the command for the other terminal:
 *
 *   OMP_PEER_BRIDGE_ROSTER=<dir>/roster.json omp -e "$PWD/examples/extensions/url-scheme-bridge/extension.ts"
 *
 * and inside omp: `read demo://` lists the peers; `write demo://leia` arrives here. A standalone CLI
 * (not a TUI), so console output is the intended interface.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
	assertPrivateDir,
	type BridgeMessage,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	parseBridgeMessage,
	parseRoster,
	type Roster,
} from "./protocol";

const { values } = parseArgs({
	options: {
		namespace: { type: "string", default: "demo" },
		peers: { type: "string", default: "leia,han" },
		dir: { type: "string" },
	},
});

/** Print a usage error and exit 2. */
function usageError(error: unknown): never {
	console.error(`peer-cli: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

/** The namespace and peers from the command line; exits with a usage error when they are invalid. */
function rosterFromArgs(): Omit<Roster, "socket"> {
	try {
		// The socket path is only known once the directory exists; validate the rest first.
		const { namespace, peers } = parseRoster({
			namespace: values.namespace,
			socket: "-",
			peers: values.peers
				.split(",")
				.map(peer => peer.trim())
				.filter(peer => peer.length > 0),
		});
		if (peers.length === 0) throw new Error("--peers must name at least one peer");
		return { namespace, peers };
	} catch (error) {
		usageError(error);
	}
}
const { namespace, peers } = rosterFromArgs();

const freshDir = values.dir === undefined;
// Absolute, so the socket path in the roster means the same from omp's working directory.
const dir = path.resolve(values.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-peer-bridge-"))));
try {
	if (!freshDir) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await assertPrivateDir(dir, "bridge");
} catch (error) {
	usageError(error);
}
const rosterPath = path.join(dir, "roster.json");
const roster: Roster = { namespace, socket: path.join(dir, "bridge.sock"), peers };
await Bun.write(rosterPath, `${JSON.stringify(roster, null, 2)}\n`);
await fs.rm(roster.socket, { force: true });

let bridge: Bun.Socket | undefined;
let nextId = 1;
/**
 * Questions delivered to the connected session, per peer name, oldest first: each outbound to that
 * peer answers the oldest one. Cleared when that session goes away.
 */
const awaitingReply = new Map<string, string[]>();
// Acks and inbound lines go through a drain-aware writer, like the bridge's side (see LineWriter).
const writer = new LineWriter();

/** Queue `message` to the connected session; false (and a notice) when none is connected. */
const send = (message: PeerMessage): boolean => {
	if (writer.write(message)) return true;
	console.log("(no omp session connected yet)");
	return false;
};

const handleBridgeMessage = (message: BridgeMessage): void => {
	switch (message.type) {
		case "hello":
			console.log(`omp session "${message.agentId}" connected; it addresses us as ${message.namespace}://<peer>`);
			return;
		case "outbound": {
			if (!roster.peers.includes(message.to)) {
				console.log(`[${message.from} → ${message.to}] rejected: no such peer here`);
				send({
					type: "ack",
					id: message.id,
					receipt: {
						outcome: "failed",
						error: `${message.to} is not a rostered peer (${roster.peers.join(", ")})`,
					},
				});
				return;
			}
			const questions = awaitingReply.get(message.to);
			const replyTo = questions?.shift();
			if (questions?.length === 0) awaitingReply.delete(message.to);
			if (replyTo) {
				console.log(`[${message.from} → ${message.to}] (reply to ${replyTo}) ${message.body}`);
			} else {
				console.log(
					`[${message.from} → ${message.to}]${message.expectsReply ? " (expects reply)" : ""} ${message.body}`,
				);
			}
			send({ type: "ack", id: message.id, receipt: { outcome: "delivered" } });
			return;
		}
		case "receipt":
			console.log(
				`  ↳ ${message.id}: ${message.receipt.outcome}${message.receipt.error ? ` — ${message.receipt.error}` : ""}`,
			);
			return;
	}
};

const newDecoder = (): LineDecoder<BridgeMessage> =>
	new LineDecoder(parseBridgeMessage, (line, error) =>
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
			// Questions asked of the previous session are not answered by this one.
			awaitingReply.clear();
			bridge = socket;
			writer.attach(socket);
			decoders.set(socket, newDecoder());
		},
		drain(socket) {
			if (bridge === socket) writer.flush();
		},
		data(socket, chunk) {
			// A replaced session's socket can still deliver a queued chunk before it closes; its records
			// (and the acks they would draw on the new connection) belong to no one now.
			if (socket !== bridge) return;
			const decoder = decoders.get(socket);
			if (!decoder) return;
			for (const message of decoder.push(chunk)) handleBridgeMessage(message);
		},
		close(socket) {
			decoders.delete(socket);
			if (bridge === socket) {
				bridge = undefined;
				writer.detach();
				awaitingReply.clear();
				console.log("omp session disconnected");
			}
		},
		error(_socket, error) {
			console.error(`socket error: ${error.message}`);
		},
	},
});

console.log(`roster written to ${rosterPath}`);
console.log(`listening on ${roster.socket} as ${roster.namespace}://{${roster.peers.join(",")}}`);
console.log("start omp with:");
console.log(`  OMP_PEER_BRIDGE_ROSTER=${rosterPath} omp -e ${path.join(import.meta.dir, "extension.ts")}`);
console.log("type `<peer>: message` to send, `<peer>?: message` to send and await a reply, /peers, /quit");

const INPUT_RE = /^([A-Za-z0-9._-]+)(\?)?:\s*(.*)$/;
for await (const rawLine of console) {
	const line = rawLine.trim();
	if (line.length === 0) continue;
	if (line === "/quit") break;
	if (line === "/peers") {
		console.log(roster.peers.map(peer => `${roster.namespace}://${peer}`).join("\n"));
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
	const sent = send({ type: "inbound", id, from: peer, body, expectsReply: expectsReply !== undefined });
	// Only a question the session actually received makes its next write to this peer a reply.
	if (sent && expectsReply) awaitingReply.set(peer, [...(awaitingReply.get(peer) ?? []), id]);
}

bridge?.end();
// A fresh directory is ours to remove; a `--dir` keeps everything but the socket.
if (freshDir) await fs.rm(dir, { recursive: true, force: true });
else await fs.rm(roster.socket, { force: true });
process.exit(0);
