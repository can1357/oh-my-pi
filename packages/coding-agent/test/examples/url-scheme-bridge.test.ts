/**
 * The reference URL-scheme bridge (examples/extensions/url-scheme-bridge) exercised the way an
 * embedder uses it: loaded as an extension into createAgentSession, connecting on `session_start`,
 * speaking the JSON-lines protocol to an in-process stand-in for `peer-cli.ts`.
 *
 * Contracts: `read <ns>://` lists the roster and completion offers the peers; `write <ns>://<peer>`
 * reaches the peer as one intact record and the peer's ack is the write result; a written message
 * makes `wait` block for the peer's answer; an inbound line is injected into the session as a
 * steered message, and each one that reaches the transcript settles one outstanding question; a
 * failed send owes nothing; a dropped peer fails a write in flight; a live disable disconnects the
 * bridge until resume; a connection that opens after shutdown is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { canBindAfterStartup } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import { createAgentSession, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-tui/chat/messages";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import urlSchemeBridge from "../../examples/extensions/url-scheme-bridge/extension";
import {
	type BridgeMessage,
	encodeLine,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	type Roster,
} from "../../examples/extensions/url-scheme-bridge/protocol";

const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

/** The test's side of the socket: what the in-process peer exposes. */
interface TestPeer {
	next: <T extends BridgeMessage["type"]>(type: T) => Promise<Extract<BridgeMessage, { type: T }>>;
	send: (message: PeerMessage) => void;
	/** Connections currently open from the bridge. */
	openConnections: () => number;
	/** Resolves when the current bridge connection closes. */
	closed: () => Promise<void>;
	stop: () => void;
}

/** In-process stand-in for peer-cli.ts: listens, records bridge lines, lets the test answer. */
function startPeer(socketPath: string): TestPeer {
	const received: BridgeMessage[] = [];
	const waiters: Array<{ type: BridgeMessage["type"]; resolve: (message: BridgeMessage) => void }> = [];
	const sockets = new Set<Bun.Socket>();
	let bridge: Bun.Socket | undefined;
	let onClose = Promise.withResolvers<void>();
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
				sockets.add(socket);
				bridge = socket;
				onClose = Promise.withResolvers<void>();
			},
			data(_socket, chunk) {
				for (const message of decoder.push(chunk)) deliver(message);
			},
			close(socket) {
				sockets.delete(socket);
				if (bridge !== socket) return;
				bridge = undefined;
				onClose.resolve();
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
		openConnections: () => sockets.size,
		closed: () => onClose.promise,
		stop: () => {
			if (stopped) return;
			stopped = true;
			bridge?.end();
			server.stop(true);
		},
	};
}

interface BridgeHarness {
	session: AgentSession;
	runner: ExtensionRunner;
	peer: TestPeer;
	socketPath: string;
	/** Start the extensions (`session_start` registers the scheme and connects). */
	start: () => Promise<void>;
	/** Whether a `wait` call blocks (for the peer's answer) rather than returning at once. */
	waitBlocks: () => Promise<boolean>;
	/** Deliver injected peer messages the way the session does: each reaches the transcript (`message_start`). Returns the spy. */
	deliverInjected: () => Mock<AgentSession["sendCustomMessage"]>;
}

describe("examples/extensions/url-scheme-bridge", () => {
	const tempDirs: TempDir[] = [];
	const cleanups: Array<() => Promise<void> | void> = [];
	const savedRoster = Bun.env.OMP_PEER_BRIDGE_ROSTER;

	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
		if (savedRoster === undefined) delete Bun.env.OMP_PEER_BRIDGE_ROSTER;
		else Bun.env.OMP_PEER_BRIDGE_ROSTER = savedRoster;
		for (const dir of tempDirs.splice(0)) await dir.remove().catch(() => {});
	});

	async function bridgeSession(): Promise<BridgeHarness> {
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Unix socket paths are length-capped (104 bytes on macOS); keep it in /tmp.
		const socketPath = `/tmp/omp-usb-${Snowflake.next()}.sock`;
		const roster: Roster = { namespace: "demo", socket: socketPath, peers: ["leia", "han"] };
		const rosterPath = tempDir.join("roster.json");
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		Bun.env.OMP_PEER_BRIDGE_ROSTER = rosterPath;

		const peer = startPeer(socketPath);
		cleanups.push(() => {
			peer.stop();
			fs.rmSync(socketPath, { force: true });
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model,
			disableExtensionDiscovery: true,
			extensions: [urlSchemeBridge],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: emptyWorkspaceTree(cwd),
			agentRegistry: new AgentRegistry(),
		});
		cleanups.push(() => session.dispose());
		const runner = session.extensionRunner;
		if (!runner) throw new Error("expected an extension runner");
		const waitTool = session.getToolByName("wait");
		if (!waitTool) throw new Error("expected the wait tool");
		let waitCalls = 0;
		return {
			session,
			runner,
			peer,
			socketPath,
			start: async () => {
				await initializeExtensions(session, {
					mode: "print",
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						throw new Error(`extension error: ${error.error}`);
					},
				});
			},
			waitBlocks: async () => {
				const abort = new AbortController();
				const waiting = waitTool.execute(`wait-${++waitCalls}`, {}, abort.signal);
				const outcome = await Promise.race([
					waiting.then(() => "returned" as const),
					Bun.sleep(300).then(() => "blocked" as const),
				]);
				abort.abort();
				await waiting.catch(() => undefined);
				return outcome === "blocked";
			},
			deliverInjected: () =>
				vi.spyOn(session, "sendCustomMessage").mockImplementation(async payload => {
					const message = normalizeCustomMessagePayload(payload);
					await runner.emit({
						type: "message_start",
						message: { role: "custom", ...message, timestamp: Date.now() },
					});
					return true;
				}),
		};
	}

	/** Write to `url` and ack it with `outcome` from the peer; resolves with the write's outcome. */
	async function writeAcked(
		harness: BridgeHarness,
		url: string,
		body: string,
		outcome: "delivered" | "failed" = "delivered",
	): Promise<"delivered" | "failed"> {
		const writing = InternalUrlRouter.instance().write(url, body);
		const outbound = await harness.peer.next("outbound");
		harness.peer.send({
			type: "ack",
			id: outbound.id,
			receipt: outcome === "delivered" ? { outcome } : { outcome, error: "peer refused" },
		});
		return writing.then(
			() => "delivered" as const,
			() => "failed" as const,
		);
	}

	it("serves the roster, sends writes to the peer, injects its messages, and lets wait block for them", async () => {
		const harness = await bridgeSession();
		const { session, peer } = harness;
		const router = InternalUrlRouter.instance();
		await harness.start();
		expect(await peer.next("hello")).toEqual({ type: "hello", agentId: "Main", namespace: "demo" });

		// read demo:// lists the roster; completion offers the peers.
		const listing = await router.resolve("demo://");
		expect(listing.content).toContain("demo://leia");
		expect(listing.content).toContain("demo://han");
		expect((await router.complete("demo", ""))?.map(candidate => candidate.value)).toEqual(["leia", "han"]);

		// write demo://leia: one line to the peer, whose ack is the write result.
		const writing = router.write("demo://leia", "hi leia");
		const outbound = await peer.next("outbound");
		expect(outbound).toMatchObject({ from: "Main", to: "leia", body: "hi leia", expectsReply: true });
		peer.send({ type: "ack", id: outbound.id, receipt: { outcome: "delivered" } });
		const result = await writing;
		expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("@demo/leia") });

		// The written message expects an answer, so wait blocks for leia instead of reporting
		// "Nothing to wait for".
		expect(await harness.waitBlocks()).toBe(true);

		// A body far larger than one socket write still arrives as one intact record.
		const bigBody = "x".repeat(4 * 1024 * 1024);
		const writingBig = router.write("demo://han?notify", bigBody);
		const big = await peer.next("outbound");
		expect(big.to).toBe("han");
		expect(big.expectsReply).toBe(false);
		expect(big.body.length).toBe(bigBody.length);
		peer.send({ type: "ack", id: big.id, receipt: { outcome: "delivered" } });
		await writingBig;

		// Inbound: the peer's line becomes a steered custom message; once it reaches the transcript,
		// the receipt goes back on the wire.
		const injected = harness.deliverInjected();
		peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "pong", expectsReply: true });
		expect(await peer.next("receipt")).toEqual({
			type: "receipt",
			id: "peer-1",
			receipt: { outcome: "delivered" },
		});
		expect(injected).toHaveBeenCalledTimes(1);
		const [payload, options] = injected.mock.calls[0];
		expect(payload).toMatchObject({
			customType: "url-scheme-bridge",
			content: expect.stringContaining("[@demo/leia]"),
			details: { from: "@demo/leia", expectsReply: true, id: "peer-1" },
		});
		expect(options).toMatchObject({ deliverAs: "steer", triggerTurn: true });

		// A write in flight when the peer drops fails, naming the peer.
		const stranded = router.write("demo://han", "anyone there");
		await peer.next("outbound");
		peer.stop();
		await expect(stranded).rejects.toThrow(/@demo\/han.*disconnected/);

		await session.dispose();
		// The scheme went with the session.
		expect(router.canHandle("demo://leia")).toBe(false);
	});

	it("lets each answer settle one question, oldest first, and keeps nothing for a failed send", async () => {
		const harness = await bridgeSession();
		const { peer } = harness;
		await harness.start();
		await peer.next("hello");
		harness.deliverInjected();

		// Refused by the peer: nothing is owed for it.
		expect(await writeAcked(harness, "demo://leia", "first try", "failed")).toBe("failed");
		expect(await harness.waitBlocks()).toBe(false);

		// Two questions to leia: one answer settles one of them, the second settles the other.
		expect(await writeAcked(harness, "demo://leia", "question 1")).toBe("delivered");
		expect(await writeAcked(harness, "demo://leia", "question 2")).toBe("delivered");
		peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "answer 1", expectsReply: false });
		await peer.next("receipt");
		expect(await harness.waitBlocks()).toBe(true);
		peer.send({ type: "inbound", id: "peer-2", from: "leia", body: "answer 2", expectsReply: false });
		await peer.next("receipt");
		expect(await harness.waitBlocks()).toBe(false);
	});

	it("receipts a peer message only once it reaches the transcript", async () => {
		const harness = await bridgeSession();
		const { peer, session } = harness;
		await harness.start();
		await peer.next("hello");

		// Dropped before admission (as during a session switch): no receipt may claim delivery.
		const dropped = Promise.withResolvers<void>();
		vi.spyOn(session, "sendCustomMessage").mockImplementation(async () => {
			dropped.resolve();
			return false;
		});
		peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "lost", expectsReply: false });
		await dropped.promise;
		harness.deliverInjected();
		peer.send({ type: "inbound", id: "peer-2", from: "leia", body: "kept", expectsReply: false });
		expect(await peer.next("receipt")).toEqual({ type: "receipt", id: "peer-2", receipt: { outcome: "delivered" } });
	});

	it("disconnects while a live disable suspends it, and reconnects with its scheme on resume", async () => {
		const harness = await bridgeSession();
		const { peer, runner } = harness;
		const router = InternalUrlRouter.instance();
		await harness.start();
		await peer.next("hello");
		const injected = vi.spyOn(harness.session, "sendCustomMessage").mockResolvedValue(true);
		// Two questions to leia outstanding when the bridge goes away: the disconnect releases both.
		expect(await writeAcked(harness, "demo://leia", "question 1")).toBe("delivered");
		expect(await writeAcked(harness, "demo://leia", "question 2")).toBe("delivered");

		const closed = peer.closed();
		runner.setSuspendedExtensions(() => true);
		await closed;
		// No session_shutdown fired, yet the peer can no longer reach the session, and the scheme pauses.
		expect(() =>
			peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "still there?", expectsReply: false }),
		).toThrow("bridge not connected");
		expect(router.canHandle("demo://leia")).toBe(false);

		runner.setSuspendedExtensions(() => false);
		expect(await peer.next("hello")).toMatchObject({ agentId: "Main" });
		expect(await harness.waitBlocks()).toBe(false);
		expect(router.canHandle("demo://leia")).toBe(true);
		expect(await writeAcked(harness, "demo://leia?notify", "back")).toBe("delivered");
		expect(injected).not.toHaveBeenCalled();
	});

	it("registers its scheme in the factory, so startup never defers it past the first prompt", async () => {
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const roster: Roster = { namespace: "demo", socket: `/tmp/omp-usb-${Snowflake.next()}.sock`, peers: ["leia"] };
		const rosterPath = tempDir.join("roster.json");
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		Bun.env.OMP_PEER_BRIDGE_ROSTER = rosterPath;

		const loaded = await loadExtensions(
			[path.join(import.meta.dir, "../../examples/extensions/url-scheme-bridge/extension.ts")],
			tempDir.path(),
		);
		expect(loaded.errors).toEqual([]);
		// The verdict startup records right after binding: a URL scheme keeps the extension eager.
		expect(canBindAfterStartup(loaded.extensions[0])).toBe(false);
		expect(InternalUrlRouter.instance().canHandle("demo://leia")).toBe(true);
		loaded.extensions[0].registrations?.release();
	});

	it("fails its load when unconfigured, so startup never records it as safe to defer", async () => {
		delete Bun.env.OMP_PEER_BRIDGE_ROSTER;
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);

		const loaded = await loadExtensions(
			[path.join(import.meta.dir, "../../examples/extensions/url-scheme-bridge/extension.ts")],
			tempDir.path(),
		);
		expect(loaded.extensions).toEqual([]);
		expect(loaded.errors[0]?.error).toContain("OMP_PEER_BRIDGE_ROSTER");
	});

	it("drops a connection that opens after the session shut down", async () => {
		const harness = await bridgeSession();
		// session_start starts connecting; the session goes away before that connection opens.
		await harness.start();
		await harness.session.dispose();
		await Bun.sleep(200);
		expect(harness.peer.openConnections()).toBe(0);
	});
});

describe("url-scheme-bridge LineDecoder", () => {
	it("reassembles a UTF-8 character split across socket chunks", () => {
		const decoder = new LineDecoder<{ body: string }>((line, error) => {
			throw new Error(`malformed ${line}: ${String(error)}`);
		});
		const bytes = new TextEncoder().encode('{"body":"héllo €"}\n');
		// Cut inside the two-byte "é" (C3 A9): a per-chunk decode would yield replacement characters.
		expect(decoder.push(bytes.slice(0, 11))).toEqual([]);
		expect(decoder.push(bytes.slice(11))).toEqual([{ body: "héllo €" }]);
	});
});

describe("url-scheme-bridge LineWriter", () => {
	it("retains the unwritten suffix of a long record and completes it on drain, in order", () => {
		const chunks: Uint8Array[] = [];
		const socket = {
			write(data: Uint8Array) {
				const accepted = data.subarray(0, Math.min(10, data.byteLength));
				chunks.push(accepted);
				return accepted.byteLength;
			},
		} as unknown as Bun.Socket;
		const written = () => new TextDecoder().decode(Buffer.concat(chunks));
		const writer = new LineWriter();
		writer.attach(socket);
		const first: PeerMessage = { type: "inbound", id: "p1", from: "leia", body: "a".repeat(50), expectsReply: false };
		const second: PeerMessage = { type: "ack", id: "m2", receipt: { outcome: "delivered" } };
		writer.write(first);
		writer.write(second);
		for (let i = 0; i < 20; i++) writer.flush();
		expect(written()).toBe(encodeLine(first) + encodeLine(second));
	});
});
