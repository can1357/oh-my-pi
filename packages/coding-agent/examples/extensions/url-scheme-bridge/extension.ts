/**
 * URL-scheme bridge (reference implementation).
 *
 * Connects an omp session to agents in other processes using only the public extension API
 * (`pi.registerUrlScheme` from #18059, `pi.replies.expect` from #18058):
 *
 * - `pi.registerUrlScheme(handler)` — serves `<namespace>://`. `read <namespace>://` lists the
 *   peers, `read <namespace>://<peer>` describes one, `write <namespace>://<peer>` sends the written
 *   text to that peer over the socket (the peer's ack is the write result), and composer tab
 *   completion offers the peer names.
 * - `pi.replies.expect(peerId)` — a message written to a peer expects an answer (unless the URL
 *   carries `?notify`), so `wait` blocks for it instead of reporting "Nothing to wait for". Each
 *   message from that peer that reaches the transcript answers its oldest outstanding question; a
 *   failed send releases its own expectation, and a dropped socket releases them all.
 * - `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })` — a message arriving on the
 *   socket is injected into the session: it steers a running turn (ending a `wait`) or starts one.
 * - `pi.onSuspensionChange(listener)` — a live `disabledExtensions` edit suspends this load without
 *   a `session_shutdown`; the bridge then disconnects (no peer message reaches a session whose
 *   bridge is disabled) and reconnects on resume. The scheme pauses and returns with the load.
 *
 * The peer side is `peer-cli.ts`, which writes the roster file, listens on the socket, prints what
 * omp sends and lets a human type messages as any rostered peer. Only the top-level session talks
 * to the mesh: every load registers the scheme (in the factory, so startup sees it), but only the
 * top-level session's load connects, and a subagent's writes, routed to its own load, are refused.
 *
 * Configuration: `OMP_PEER_BRIDGE_ROSTER=<path>` names the roster JSON written by the peer CLI.
 *
 *   OMP_PEER_BRIDGE_ROSTER=/tmp/omp-peer-bridge/roster.json omp -e "$PWD/examples/extensions/url-scheme-bridge/extension.ts"
 */
import type { ExtensionAPI, InternalUrl, ProtocolHandler, WriteContext } from "@oh-my-pi/pi-coding-agent";
import {
	type BridgeMessage,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	parseRoster,
	type Receipt,
	type Roster,
} from "./protocol";

/** How long an outbound message waits for the peer's ack before the write fails. */
const ACK_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Custom message type of injected peer messages. */
const PEER_MESSAGE_TYPE = "url-scheme-bridge";

export interface PeerMessageDetails {
	/** Display id of the sender, `@<namespace>/<peer>`. */
	from: string;
	/** Whether the peer asked for an answer. */
	expectsReply: boolean;
	/** Id of the peer's inbound record, receipted once the message reaches the transcript. */
	id: string;
}

export default async function urlSchemeBridge(pi: ExtensionAPI): Promise<void> {
	const rosterPath = Bun.env.OMP_PEER_BRIDGE_ROSTER;
	// Fail the load rather than load inactive: startup would otherwise record an extension that
	// registered nothing as safe to bind after the first prompt, and keep deferring it (and its
	// `demo://` completion) once the variable is set.
	if (!rosterPath)
		throw new Error("url-scheme-bridge: set OMP_PEER_BRIDGE_ROSTER to the roster file peer-cli.ts wrote");

	let roster: Roster | undefined;
	let agentId = "";
	let socket: Bun.Socket | undefined;
	let shuttingDown = false;
	/** Set while a live `disabledExtensions` edit has this load suspended. */
	let suspended = false;
	let reconnectDelay = RECONNECT_MIN_MS;
	let reconnectTimer: Timer | undefined;
	let nextId = 1;
	const pendingAcks = new Map<string, { resolve: (receipt: Receipt) => void; timer: Timer }>();
	/**
	 * Releases of `pi.replies.expect`, per bare peer name, oldest first: each message from the peer
	 * answers one of them.
	 */
	const awaiting = new Map<string, Array<() => void>>();
	// Records are queued and drained rather than written blind: a long body or a backed-up peer can
	// make `socket.write` accept a prefix, and a truncated line would time out its ack and corrupt
	// the next record (see LineWriter).
	const writer = new LineWriter();

	const displayId = (peer: string): string => `@${roster?.namespace ?? "?"}/${peer}`;

	/** Record that `peer` owes an answer; the returned function withdraws this one expectation. */
	const expectAnswer = (peer: string): (() => void) => {
		const release = pi.replies.expect(displayId(peer));
		const queue = awaiting.get(peer) ?? [];
		queue.push(release);
		awaiting.set(peer, queue);
		return () => {
			const index = queue.indexOf(release);
			if (index !== -1) queue.splice(index, 1);
			if (queue.length === 0 && awaiting.get(peer) === queue) awaiting.delete(peer);
			release();
		};
	};

	/** A message from `peer` reached the transcript: it answers that peer's oldest question. */
	const answered = (peer: string): void => {
		const queue = awaiting.get(peer);
		const release = queue?.shift();
		if (queue?.length === 0) awaiting.delete(peer);
		release?.();
	};

	/** No answer can come any more (the socket is gone): release every expectation. */
	const releaseAllAwaiting = (): void => {
		// Drained before releasing, so nothing a release triggers can observe a half-walked queue.
		const queues = [...awaiting.values()];
		awaiting.clear();
		for (const queue of queues) for (const release of queue.splice(0)) release();
	};

	const failPendingAcks = (error: string): void => {
		for (const pending of pendingAcks.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ outcome: "failed", error });
		}
		pendingAcks.clear();
	};

	/** The peer a `<namespace>://<peer>` URL names, or an error naming the rostered peers. */
	const peerOf = (url: InternalUrl): string => {
		const peer = url.rawHost;
		if (!roster?.peers.includes(peer)) {
			throw new Error(`${displayId(peer)} is not a rostered peer (${roster?.peers.join(", ") ?? "none"})`);
		}
		return peer;
	};

	/** Outbound: one JSON line to the peer; its ack becomes the write result. */
	const sendToPeer = (peer: string, body: string, expectsReply: boolean): Promise<Receipt> => {
		const id = `omp-${nextId++}`;
		const { promise, resolve } = Promise.withResolvers<Receipt>();
		const timer = setTimeout(() => {
			pendingAcks.delete(id);
			resolve({ outcome: "failed", error: "the peer did not ack in time" });
		}, ACK_TIMEOUT_MS);
		pendingAcks.set(id, { resolve, timer });
		const written = writer.write({ type: "outbound", id, from: agentId, to: peer, body, expectsReply });
		if (!written) {
			clearTimeout(timer);
			pendingAcks.delete(id);
			resolve({ outcome: "failed", error: `the peer socket ${roster?.socket ?? ""} is not connected` });
		}
		return promise;
	};

	const handler: ProtocolHandler = {
		scheme: "",
		spec: {
			backing: "remote",
			selectors: "none",
			immutable: false,
			// A message to a peer, like `write agent://<id>`: read tier, and allowed in plan mode.
			write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
		},
		async resolve(url) {
			if (!roster) throw new Error("url-scheme-bridge: not connected yet");
			const scheme = roster.namespace;
			if (url.rawHost === "") {
				const lines = [
					`# Peers on ${scheme}://`,
					"",
					agentId
						? `Socket: ${writer.connected ? "connected" : "disconnected"}`
						: "Socket: held by the top-level session; this session cannot message peers",
					"",
					...roster.peers.map(peer => `- \`${scheme}://${peer}\` (${displayId(peer)})`),
					"",
					`Message a peer with \`write ${scheme}://<peer>\`; it is expected to answer, and its answer arrives as a message (\`wait\` blocks for it). Add \`?notify\` to the URL for a message that needs no answer.`,
				];
				return { url: url.href, content: lines.join("\n"), contentType: "text/markdown" };
			}
			const peer = peerOf(url);
			const content = [
				`# ${displayId(peer)}`,
				"",
				`A peer in another process. It has no transcript here; message it with \`write ${scheme}://${peer}\`.`,
			].join("\n");
			return { url: url.href, content, contentType: "text/markdown" };
		},
		async write(url, content, context?: WriteContext) {
			const peer = peerOf(url);
			const caller = context?.session?.getAgentId?.();
			// A subagent's load never connects (`session_start`), and its calls route to it.
			if (!agentId || (caller !== undefined && caller !== agentId)) {
				throw new Error("url-scheme-bridge: only the top-level session talks to the mesh");
			}
			const expectsReply = !url.searchParams.has("notify");
			// Expect before sending: an answer can arrive before the ack.
			const withdraw = expectsReply ? expectAnswer(peer) : undefined;
			const receipt = await sendToPeer(peer, content, expectsReply);
			if (receipt.outcome === "failed") {
				// Undelivered, so nothing is owed; drop this expectation alone.
				withdraw?.();
				throw new Error(`Not delivered to ${displayId(peer)}: ${receipt.error ?? "unknown error"}`);
			}
			const text = expectsReply
				? `Delivered to ${displayId(peer)}. Its answer arrives as a message.`
				: `Delivered to ${displayId(peer)}.`;
			return { content: [{ type: "text", text }] };
		},
		async complete() {
			return (roster?.peers ?? []).map(peer => ({ value: peer, description: displayId(peer) }));
		},
	};

	/** Inbound: a peer line becomes a steered message; the receipt goes back on the same socket. */
	const handlePeerMessage = (message: PeerMessage): void => {
		if (message.type === "ack") {
			const pending = pendingAcks.get(message.id);
			if (!pending) return;
			pendingAcks.delete(message.id);
			clearTimeout(pending.timer);
			pending.resolve(message.receipt);
			return;
		}
		if (!roster?.peers.includes(message.from)) {
			writer.write({
				type: "receipt",
				id: message.id,
				receipt: { outcome: "failed", error: `${message.from} is not a rostered peer` },
			});
			return;
		}
		const from = displayId(message.from);
		const hint = message.expectsReply ? ` (answer with \`write ${roster.namespace}://${message.from}\`)` : "";
		const details: PeerMessageDetails = { from, expectsReply: message.expectsReply, id: message.id };
		pi.sendMessage(
			{ customType: PEER_MESSAGE_TYPE, content: `[${from}]${hint} ${message.body}`, display: true, details },
			{ deliverAs: "steer", triggerTurn: true },
		);
		// `sendMessage` only queues it: a session switch can still drop it. The receipt and the release
		// of the oldest question the agent asked this peer wait until it reaches the transcript
		// (`message_start` below). Releasing now would also end a running `wait` with "no longer owes a
		// reply" before the steer could.
	};

	const connect = (): void => {
		if (shuttingDown || suspended || !roster) return;
		const decoder = new LineDecoder<PeerMessage>((line, error) =>
			pi.logger.warn("url-scheme-bridge: dropped malformed peer line", { line, error: String(error) }),
		);
		const path = roster.socket;
		Bun.connect({
			unix: path,
			socket: {
				open(connected) {
					// Shut down or suspended while connecting: this connection must not attach.
					if (shuttingDown || suspended) {
						connected.end();
						return;
					}
					socket = connected;
					writer.attach(connected);
					reconnectDelay = RECONNECT_MIN_MS;
					writer.write({ type: "hello", agentId, namespace: roster?.namespace ?? "" } satisfies BridgeMessage);
					pi.logger.info("url-scheme-bridge: connected", { socket: path });
				},
				drain() {
					writer.flush();
				},
				data(connected, chunk) {
					if (connected !== socket) return;
					for (const message of decoder.push(chunk)) handlePeerMessage(message);
				},
				close(closed) {
					// A connection that never attached (or was replaced) owns no bridge state.
					if (closed !== socket) return;
					socket = undefined;
					writer.detach();
					failPendingAcks("the peer disconnected before acking");
					// No answer can come over a dropped connection.
					releaseAllAwaiting();
					scheduleReconnect();
				},
				error(_connected, error) {
					pi.logger.warn("url-scheme-bridge: socket error", { socket: path, error: error.message });
				},
			},
		}).catch(error => {
			pi.logger.debug("url-scheme-bridge: connect failed, retrying", { socket: path, error: String(error) });
			scheduleReconnect();
		});
	};

	/** Drop the connection without reconnecting (shutdown or suspension). */
	const disconnect = (reason: string): void => {
		clearTimeout(reconnectTimer);
		failPendingAcks(reason);
		releaseAllAwaiting();
		const current = socket;
		socket = undefined;
		writer.detach();
		current?.end();
	};

	const scheduleReconnect = (): void => {
		if (shuttingDown || suspended) return;
		reconnectTimer = setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	};

	pi.on("message_start", async event => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== PEER_MESSAGE_TYPE) return;
		const details = typeof message.details === "object" && message.details !== null ? message.details : undefined;
		const from: unknown = details ? Reflect.get(details, "from") : undefined;
		const id: unknown = details ? Reflect.get(details, "id") : undefined;
		if (typeof from === "string") answered(from.slice(`@${roster?.namespace ?? ""}/`.length));
		if (typeof id === "string") writer.write({ type: "receipt", id, receipt: { outcome: "delivered" } });
	});

	// A suspended load gets no events (not even `session_shutdown`), so the socket follows the
	// suspension itself: a peer must not reach a session whose bridge is disabled.
	pi.onSuspensionChange(isSuspended => {
		suspended = isSuspended;
		if (isSuspended) disconnect("the bridge was disabled");
		else connect();
	});

	pi.on("session_start", async (_event, ctx) => {
		// Only the top-level session connects; a subagent's load of this extension stays inactive.
		if (ctx.agent.kind !== "main") return;
		agentId = ctx.agent.id;
		connect();
	});

	pi.on("session_shutdown", async () => {
		// The scheme and any unreleased expectations go with the load; only the socket is ours to close.
		shuttingDown = true;
		disconnect("the session shut down");
	});

	// Registered here, in the (async) factory, rather than in `session_start`: startup decides from
	// what the factory registered whether this extension may bind after the first prompt, and a URL
	// scheme's completion and prompt docs must be there from the start. Every load registers; each
	// session's calls route to its own load, and only the top-level session's load connects. The
	// scheme follows this load (paused while it is suspended, released at shutdown).
	roster = parseRoster(await Bun.file(rosterPath).json());
	pi.registerUrlScheme({ ...handler, scheme: roster.namespace });
}
