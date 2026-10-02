/**
 * Remote IRC bridge (reference implementation).
 *
 * Connects this omp session to agents that live in other processes, using the three seams the
 * cross-process IRC work adds to the extension API:
 *
 * - `pi.irc.setRemoteTransport(namespace, transport)` — claims `@<namespace>/…` and installs the
 *   outbound path: every `write agent://@<namespace>/<peer>` from the model lands in
 *   `transport.send`, which here writes a JSON line to the peer socket and awaits its ack.
 * - `pi.irc.registerRemotePeer({ name })` — seeds `remote` roster entries so the model can discover
 *   its peers with `read history://` and spell them.
 * - `pi.irc.deliverInbound({ from, to, body })` — hands a message that arrived on the socket to the
 *   local agent exactly as a local peer's `send` would (wake / steer / queue).
 *
 * The peer side is `peer-cli.ts`, which writes the roster file, listens on the socket, prints what
 * omp sends and lets a human type replies as any rostered peer. Only the top-level session claims
 * and connects; subagents share the root's claim through the common registry.
 *
 * Configuration: `OMP_REMOTE_IRC_ROSTER=<path>` names the roster JSON written by the peer CLI.
 *
 *   OMP_REMOTE_IRC_ROSTER=/tmp/omp-remote-irc/roster.json omp -e examples/extensions/remote-irc-bridge/extension.ts
 */
import type { ExtensionAPI, IrcDeliveryReceipt, IrcMessage, RemoteTransport } from "@oh-my-pi/pi-coding-agent";
import { type BridgeMessage, LineDecoder, LineWriter, type PeerMessage, parseRoster, type Roster } from "./protocol";

/** How long an outbound message waits for the peer's ack before failing the receipt. */
const ACK_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export default function remoteIrcBridge(pi: ExtensionAPI): void {
	const rosterPath = Bun.env.OMP_REMOTE_IRC_ROSTER;
	if (!rosterPath) {
		pi.logger.warn("remote-irc-bridge: OMP_REMOTE_IRC_ROSTER is not set; bridge inactive");
		return;
	}

	let roster: Roster | undefined;
	let agentId = "";
	let socket: Bun.Socket | undefined;
	let shuttingDown = false;
	let reconnectDelay = RECONNECT_MIN_MS;
	let reconnectTimer: Timer | undefined;
	const pendingAcks = new Map<string, { to: string; resolve: (receipt: IrcDeliveryReceipt) => void; timer: Timer }>();
	// Records are queued and drained rather than written blind: a long body or a backed-up peer can
	// make `socket.write` accept a prefix, and a truncated line would time out its ack and corrupt
	// the next record (see LineWriter).
	const writer = new LineWriter();
	const write = (message: BridgeMessage): boolean => writer.write(message);

	const failPendingAcks = (error: string): void => {
		for (const pending of pendingAcks.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ to: pending.to, outcome: "failed", error });
		}
		pendingAcks.clear();
	};

	/** Outbound: `write agent://@<ns>/<peer>` → one JSON line → the peer's ack becomes the receipt. */
	const transport: RemoteTransport = {
		send(message: IrcMessage, opts): Promise<IrcDeliveryReceipt> {
			if (!writer.connected) {
				return Promise.resolve({
					to: message.to,
					outcome: "failed",
					error: `remote-irc-bridge: peer socket ${roster?.socket ?? "(unknown)"} is not connected`,
				});
			}
			const { promise, resolve } = Promise.withResolvers<IrcDeliveryReceipt>();
			const timer = setTimeout(() => {
				pendingAcks.delete(message.id);
				resolve({ to: message.to, outcome: "failed", error: "remote-irc-bridge: peer did not ack in time" });
			}, ACK_TIMEOUT_MS);
			pendingAcks.set(message.id, { to: message.to, resolve, timer });
			write({
				type: "outbound",
				id: message.id,
				from: message.from,
				to: message.to,
				toName: opts?.toName ?? message.to,
				body: message.body,
				expectsReply: opts?.expectsReply === true,
			});
			return promise;
		},
	};

	/** Inbound: a peer line → `pi.irc.deliverInbound` → the receipt goes back on the same socket. */
	const handlePeerMessage = async (message: PeerMessage): Promise<void> => {
		if (message.type === "ack") {
			const pending = pendingAcks.get(message.id);
			if (!pending) return;
			pendingAcks.delete(message.id);
			clearTimeout(pending.timer);
			pending.resolve(message.receipt);
			return;
		}
		if (!roster) return;
		const from = `@${roster.namespace}/${message.from}`;
		try {
			const { receipt, id } = await pi.irc.deliverInbound(
				{ from, to: message.to, body: message.body },
				{ expectsReply: message.expectsReply },
			);
			write({ type: "receipt", id: message.id, receipt, ompId: id });
		} catch (error) {
			write({
				type: "receipt",
				id: message.id,
				receipt: {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	const connect = (): void => {
		if (shuttingDown || !roster) return;
		const decoder = new LineDecoder<PeerMessage>((line, error) =>
			pi.logger.warn("remote-irc-bridge: dropped malformed peer line", { line, error: String(error) }),
		);
		const path = roster.socket;
		Bun.connect({
			unix: path,
			socket: {
				open(connected) {
					socket = connected;
					writer.attach(connected);
					reconnectDelay = RECONNECT_MIN_MS;
					write({ type: "hello", agentId, namespace: roster?.namespace ?? "" });
					pi.logger.info("remote-irc-bridge: connected", { socket: path });
				},
				drain() {
					writer.flush();
				},
				data(_connected, chunk) {
					for (const message of decoder.push(chunk)) void handlePeerMessage(message);
				},
				close() {
					socket = undefined;
					writer.detach();
					failPendingAcks("remote-irc-bridge: peer disconnected before acking");
					scheduleReconnect();
				},
				error(_connected, error) {
					pi.logger.warn("remote-irc-bridge: socket error", { socket: path, error: error.message });
				},
			},
		}).catch(error => {
			pi.logger.debug("remote-irc-bridge: connect failed, retrying", { socket: path, error: String(error) });
			scheduleReconnect();
		});
	};

	const scheduleReconnect = (): void => {
		if (shuttingDown) return;
		reconnectTimer = setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	};

	pi.on("session_start", async (_event, ctx) => {
		// Only the top-level session originates the claim and the socket; a subagent that reloads
		// this extension shares the root's registry, bus and transport.
		if (ctx.agent.kind !== "main") return;
		agentId = ctx.agent.id;
		roster = parseRoster(await Bun.file(rosterPath).json());

		const { setRemoteTransport, registerRemotePeer } = pi.irc;
		if (!setRemoteTransport || !registerRemotePeer) {
			throw new Error("remote-irc-bridge: this omp build has no pi.irc remote-transport seam");
		}
		setRemoteTransport(roster.namespace, transport);
		for (const name of roster.peers) registerRemotePeer({ name, displayName: name, status: "running" });
		connect();
	});

	pi.on("session_shutdown", async () => {
		// The namespace claim, transport and remote proxies are released by omp's own teardown;
		// only the socket is ours to close.
		shuttingDown = true;
		clearTimeout(reconnectTimer);
		failPendingAcks("remote-irc-bridge: session shut down");
		socket?.end();
		socket = undefined;
		writer.detach();
	});
}
