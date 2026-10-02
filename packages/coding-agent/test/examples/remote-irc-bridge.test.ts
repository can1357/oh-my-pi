/**
 * The reference cross-process bridge (examples/extensions/remote-irc-bridge) exercised the way a
 * real embedder uses the seams: loaded as an extension into createAgentSession, claiming on
 * `session_start`, speaking the JSON-lines protocol to an in-process stand-in for `peer-cli.ts`.
 *
 * Contracts: peers from the roster become `remote` registry entries; an outbound `@ns/peer` send
 * reaches the peer with the bare name and the peer's ack becomes the sender's receipt; an inbound
 * line is delivered to the addressed local agent as `@ns/peer` with `expectsReply` forwarded and
 * the receipt goes back on the wire.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import remoteIrcBridge from "../../examples/extensions/remote-irc-bridge/extension";
import {
	type BridgeMessage,
	encodeLine,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	type Roster,
} from "../../examples/extensions/remote-irc-bridge/protocol";

const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

/** In-process stand-in for peer-cli.ts: listens, records bridge lines, lets the test answer. */
function startPeer(socketPath: string): {
	next: <T extends BridgeMessage["type"]>(type: T) => Promise<Extract<BridgeMessage, { type: T }>>;
	send: (message: PeerMessage) => void;
	stop: () => void;
} {
	const received: BridgeMessage[] = [];
	const waiters: Array<{ type: BridgeMessage["type"]; resolve: (message: BridgeMessage) => void }> = [];
	let bridge: Bun.Socket | undefined;
	let stopped = false;
	const decoder = new LineDecoder<BridgeMessage>((line, error) => {
		throw new Error(`peer: malformed bridge line ${line}: ${String(error)}`);
	});
	const deliver = (message: BridgeMessage): void => {
		const index = waiters.findIndex(waiter => waiter.type === message.type);
		if (index === -1) {
			received.push(message);
			return;
		}
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
	};
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open(socket) {
				bridge = socket;
			},
			data(_socket, chunk) {
				for (const message of decoder.push(chunk)) deliver(message);
			},
			close() {
				bridge = undefined;
			},
			error() {},
		},
	});
	return {
		next: <T extends BridgeMessage["type"]>(type: T) => {
			const { promise, resolve } = Promise.withResolvers<Extract<BridgeMessage, { type: T }>>();
			const matches = (message: BridgeMessage): message is Extract<BridgeMessage, { type: T }> =>
				message.type === type;
			const index = received.findIndex(matches);
			if (index !== -1) {
				const [message] = received.splice(index, 1);
				if (matches(message)) resolve(message);
			} else {
				waiters.push({
					type,
					resolve: message => {
						if (matches(message)) resolve(message);
					},
				});
			}
			return promise;
		},
		send: message => {
			if (!bridge) throw new Error("peer: bridge not connected");
			bridge.write(encodeLine(message));
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			bridge?.end();
			server.stop(true);
		},
	};
}

describe("examples/extensions/remote-irc-bridge", () => {
	const tempDirs: TempDir[] = [];
	const savedRoster = Bun.env.OMP_REMOTE_IRC_ROSTER;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (savedRoster === undefined) delete Bun.env.OMP_REMOTE_IRC_ROSTER;
		else Bun.env.OMP_REMOTE_IRC_ROSTER = savedRoster;
		for (const dir of tempDirs.splice(0)) await dir.remove().catch(() => {});
	});

	it("registers rostered peers, routes outbound sends to the peer, and delivers inbound lines", async () => {
		const tempDir = TempDir.createSync(`@pi-remote-irc-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Unix socket paths are length-capped (104 bytes on macOS); keep it in /tmp.
		const socketPath = `/tmp/omp-rib-${Snowflake.next()}.sock`;
		const roster: Roster = { namespace: "demo", socket: socketPath, peers: ["leia", "han"] };
		const rosterPath = tempDir.join("roster.json");
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		Bun.env.OMP_REMOTE_IRC_ROSTER = rosterPath;

		const peer = startPeer(socketPath);
		const agentRegistry = new AgentRegistry();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			// A leaf root: no spawn-based peers, so every peer the model can see comes from the bridge.
			settings: Settings.isolated({ "task.maxRecursionDepth": 0 }),
			model,
			disableExtensionDiscovery: true,
			extensions: [remoteIrcBridge],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: emptyWorkspaceTree(cwd),
			agentRegistry,
		});
		try {
			// session_start is what the bridge claims on; print/rpc/interactive modes all emit it.
			await initializeExtensions(session, {
				mode: "print",
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: error => {
					throw new Error(`extension error: ${error.error}`);
				},
			});

			const hello = await peer.next("hello");
			expect(hello).toEqual({ type: "hello", agentId: "Main", namespace: "demo" });
			expect(agentRegistry.get("@demo/leia")).toMatchObject({ kind: "remote", status: "running" });
			expect(agentRegistry.get("@demo/han")).toMatchObject({ kind: "remote", status: "running" });
			expect(IrcBus.forRegistry(agentRegistry).hasRemoteTransport()).toBe(true);

			// Outbound: the bus routes @demo/leia to the bridge, the bridge writes one line, the peer's
			// ack is what the sender gets back as the receipt.
			const sending = IrcBus.forRegistry(agentRegistry).send({ from: "Main", to: "@demo/leia", body: "hi leia" });
			const outbound = await peer.next("outbound");
			expect(outbound).toMatchObject({
				from: "Main",
				to: "@demo/leia",
				toName: "leia",
				body: "hi leia",
				expectsReply: false,
			});
			peer.send({ type: "ack", id: outbound.id, receipt: { to: "@demo/leia", outcome: "injected" } });
			expect(await sending).toEqual({ to: "@demo/leia", outcome: "injected" });

			// A body far larger than one socket write can carry still arrives as one intact record
			// (the bridge queues the unwritten suffix and flushes on drain), and the ack comes back.
			const bigBody = "x".repeat(4 * 1024 * 1024);
			const sendingBig = IrcBus.forRegistry(agentRegistry).send({ from: "Main", to: "@demo/han", body: bigBody });
			const big = await peer.next("outbound");
			expect(big.toName).toBe("han");
			expect(big.body.length).toBe(bigBody.length);
			peer.send({ type: "ack", id: big.id, receipt: { to: "@demo/han", outcome: "injected" } });
			expect(await sendingBig).toEqual({ to: "@demo/han", outcome: "injected" });

			// Inbound: a peer line becomes deliverInbound(@demo/leia -> Main) with expectsReply forwarded;
			// the delivery outcome goes back on the wire with omp's own message id.
			const delivered = vi.spyOn(session, "deliverIrcMessage").mockResolvedValue("injected");
			peer.send({ type: "inbound", id: "peer-1", from: "leia", to: "Main", body: "ping", expectsReply: true });
			const receipt = await peer.next("receipt");
			expect(receipt).toMatchObject({ id: "peer-1", receipt: { to: "Main", outcome: "injected" } });
			expect(typeof receipt.ompId).toBe("string");
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(delivered.mock.calls[0][0]).toMatchObject({ from: "@demo/leia", to: "Main", body: "ping" });

			// A send in flight when the peer drops must fail with a receipt that still names the
			// recipient, so the model's "Failed: … is not running" line is about the peer, not a message id.
			const stranded = IrcBus.forRegistry(agentRegistry).send({
				from: "Main",
				to: "@demo/han",
				body: "anyone there",
			});
			await peer.next("outbound");
			peer.stop();
			expect(await stranded).toMatchObject({
				to: "@demo/han",
				outcome: "failed",
				error: expect.stringContaining("disconnected"),
			});
		} finally {
			await session.dispose();
			peer.stop();
			fs.rmSync(socketPath, { force: true });
		}
	});
});

describe("remote-irc-bridge LineDecoder", () => {
	it("reassembles a UTF-8 character split across socket chunks", () => {
		const decoder = new LineDecoder<{ body: string }>((line, error) => {
			throw new Error(`malformed ${line}: ${String(error)}`);
		});
		const bytes = new TextEncoder().encode('{"body":"héllo €"}\n');
		// Cut inside the two-byte "é" (C3 A9): a per-chunk decode would yield replacement characters.
		expect(decoder.push(bytes.slice(0, 11))).toEqual([]);
		expect(decoder.push(bytes.slice(11))).toEqual([{ body: "héllo €" }]);
	});

	it("yields each complete line and keeps a trailing partial line buffered", () => {
		const decoder = new LineDecoder<{ n: number }>(() => {});
		expect(decoder.push('{"n":1}\n{"n":2}\n{"n"')).toEqual([{ n: 1 }, { n: 2 }]);
		expect(decoder.push(":3}\n")).toEqual([{ n: 3 }]);
	});
});

describe("remote-irc-bridge LineWriter", () => {
	/** A socket stand-in that accepts at most `cap` bytes per write and records everything written. */
	function cappedSocket(cap: number): { socket: Bun.Socket; written: () => string } {
		const chunks: Uint8Array[] = [];
		const socket = {
			write(data: Uint8Array) {
				const accepted = data.subarray(0, Math.min(cap, data.byteLength));
				chunks.push(accepted);
				return accepted.byteLength;
			},
		} as unknown as Bun.Socket;
		return { socket, written: () => new TextDecoder().decode(Buffer.concat(chunks)) };
	}

	it("retains the unwritten suffix of a long record and completes it on drain, in order", () => {
		const { socket, written } = cappedSocket(10);
		const writer = new LineWriter();
		writer.attach(socket);
		const first: PeerMessage = {
			type: "inbound",
			id: "p1",
			from: "leia",
			to: "Main",
			body: "a".repeat(50),
			expectsReply: false,
		};
		const second: PeerMessage = { type: "ack", id: "m2", receipt: { to: "@demo/han", outcome: "injected" } };
		expect(writer.write(first)).toBe(true);
		expect(writer.write(second)).toBe(true);
		// Each write flushes one accepted chunk of the head record; the second record waits behind
		// the first's remainder rather than interleaving with it.
		expect(written()).toBe(encodeLine(first).slice(0, 20));
		// Each drain moves one more chunk; eventually both records are on the wire, whole and in order.
		for (let i = 0; i < 20; i++) writer.flush();
		expect(written()).toBe(encodeLine(first) + encodeLine(second));
		const decoder = new LineDecoder<PeerMessage>(() => {
			throw new Error("corrupt line");
		});
		expect(decoder.push(written())).toEqual([first, second]);
	});

	it("reports no socket and drops a replaced connection's backlog on attach", () => {
		const writer = new LineWriter();
		expect(writer.write({ type: "hello", agentId: "Main", namespace: "demo" })).toBe(false);
		const stalled = cappedSocket(1);
		writer.attach(stalled.socket);
		writer.write({ type: "hello", agentId: "Main", namespace: "demo" });
		const fresh = cappedSocket(Number.MAX_SAFE_INTEGER);
		writer.attach(fresh.socket);
		writer.flush();
		expect(fresh.written()).toBe("");
		writer.write({ type: "hello", agentId: "Main", namespace: "demo" });
		expect(fresh.written()).toBe(encodeLine({ type: "hello", agentId: "Main", namespace: "demo" }));
	});
});
