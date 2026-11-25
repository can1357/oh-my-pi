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
import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { canBindAfterStartup } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import { createAgentSession, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import urlSchemeBridge from "../../examples/extensions/url-scheme-bridge/extension";
import {
	type BridgeMessage,
	encodeLine,
	LineDecoder,
	LineWriter,
	type PeerMessage,
	parseBridgeMessage,
	parsePeerMessage,
	parseRoster,
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
	/** Write `text` to the bridge as is (no encoding, no shape check). */
	sendRaw: (text: string) => void;
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
	const decoder = new LineDecoder(parseBridgeMessage, (line, error) => {
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
		sendRaw: text => {
			if (!bridge) throw new Error("peer: bridge not connected");
			bridge.write(text);
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

/** A session loading the bridge, which reads its roster from `OMP_PEER_BRIDGE_ROSTER`. */
interface SessionHarness {
	session: AgentSession;
	runner: ExtensionRunner;
	/** Start the extensions (`session_start` registers the scheme and connects). */
	start: () => Promise<void>;
	/** Whether a `wait` call blocks (for the peer's answer) rather than returning at once. */
	waitBlocks: () => Promise<boolean>;
	/** Deliver injected peer messages the way the session does: each reaches the transcript (`message_start`). Returns the spy. */
	deliverInjected: () => Mock<AgentSession["sendCustomMessage"]>;
}

/** A bridge session talking to the in-process peer. */
interface BridgeHarness extends SessionHarness {
	peer: TestPeer;
	socketPath: string;
}

const EXTENSION_PATH = path.join(import.meta.dir, "../../examples/extensions/url-scheme-bridge/extension.ts");
const PEER_CLI = path.join(import.meta.dir, "../../examples/extensions/url-scheme-bridge/peer-cli.ts");

/** The real `peer-cli.ts`, run as a child process: its stdin is the terminal, its stdout what a human sees. */
interface PeerCli {
	/** Resolves with the first match of `pattern` in the CLI's stdout (so far or still to come). */
	output: (pattern: RegExp) => Promise<RegExpExecArray>;
	/** Type one line into the CLI. */
	type: (line: string) => void;
	exited: Promise<number>;
	stderr: () => Promise<string>;
	kill: () => void;
}

function spawnPeerCli(args: string[]): PeerCli {
	const child = Bun.spawn([process.execPath, PEER_CLI, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	let text = "";
	const waiters: Array<{ pattern: RegExp; resolve: (match: RegExpExecArray) => void }> = [];
	const settle = (): void => {
		// Backwards, so removing a settled waiter does not skip the next one.
		for (let index = waiters.length - 1; index >= 0; index--) {
			const waiter = waiters[index];
			const match = waiter.pattern.exec(text);
			if (!match) continue;
			waiters.splice(index, 1);
			waiter.resolve(match);
		}
	};
	void (async () => {
		const utf8 = new TextDecoder();
		for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
			text += utf8.decode(chunk, { stream: true });
			settle();
		}
	})();
	return {
		output: pattern => {
			const { promise, resolve } = Promise.withResolvers<RegExpExecArray>();
			waiters.push({ pattern, resolve });
			settle();
			return promise;
		},
		type: line => {
			child.stdin.write(`${line}\n`);
			child.stdin.flush();
		},
		exited: child.exited,
		stderr: () => new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		kill: () => child.kill(),
	};
}

describe("examples/extensions/url-scheme-bridge", () => {
	const tempDirs: TempDir[] = [];
	const cleanups: Array<() => Promise<void> | void> = [];
	const savedRoster = Bun.env.OMP_PEER_BRIDGE_ROSTER;

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		if (savedRoster === undefined) delete Bun.env.OMP_PEER_BRIDGE_ROSTER;
		else Bun.env.OMP_PEER_BRIDGE_ROSTER = savedRoster;
		for (const dir of tempDirs.splice(0)) await dir.remove().catch(() => {});
	});

	/** `subagent`: the session is a task's subagent (depth 1), whose load of the bridge stays inactive. */
	async function rosterSession(
		rosterPath: string,
		{ subagent = false }: { subagent?: boolean } = {},
	): Promise<SessionHarness> {
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		Bun.env.OMP_PEER_BRIDGE_ROSTER = rosterPath;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			// No services broker: `wait` would ask it first, and nothing here runs a service.
			settings: Settings.isolated({ "launch.enabled": false }),
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
			...(subagent ? { taskDepth: 1 } : {}),
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
				// Called already aborted, so no clock is involved: a wait owed nothing returns
				// "Nothing to wait for" on its own, and only a wait that goes on to block ends by the abort.
				const abort = new AbortController();
				abort.abort();
				try {
					await waitTool.execute(`wait-${++waitCalls}`, {}, abort.signal);
					return false;
				} catch (error) {
					// The tool wrapper rethrows the abort as a plain error carrying its message.
					if (error instanceof Error && error.message === ToolAbortError.MESSAGE) return true;
					throw error;
				}
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

	/**
	 * A private directory for a roster and a socket, as the bridge requires. Under /tmp with a short
	 * name: Unix socket paths are length-capped (104 bytes on macOS).
	 */
	function bridgeDir(): TempDir {
		const dir = TempDir.createSync("/tmp/omp-usb-");
		tempDirs.push(dir);
		return dir;
	}

	/** A bridge session talking to the in-process peer, the roster and socket in a private directory. */
	async function bridgeSession({ subagent = false }: { subagent?: boolean } = {}): Promise<BridgeHarness> {
		const dir = bridgeDir();
		const socketPath = dir.join("bridge.sock");
		const roster: Roster = { namespace: "demo", socket: socketPath, peers: ["leia", "han"] };
		const rosterPath = dir.join("roster.json");
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		const peer = startPeer(socketPath);
		cleanups.push(() => peer.stop());
		return { ...(await rosterSession(rosterPath, { subagent })), peer, socketPath };
	}

	/** Write to `url` and ack it with `outcome` from the peer; resolves with the write's outcome. */
	async function writeAcked(
		harness: BridgeHarness,
		url: string,
		body: string,
		outcome: "delivered" | "failed" = "delivered",
	): Promise<"delivered" | "failed"> {
		const writing = harness.session.urlRouter.write(url, body);
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
		const router = session.urlRouter;
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

	it.each([
		["a new session", (session: AgentSession) => session.newSession()],
		["/clear", (session: AgentSession) => session.resetSessionContext()],
		[
			"a branch from an earlier prompt",
			async (session: AgentSession) => {
				session.sessionManager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
				const entryId = session.sessionManager.getLeafId();
				if (!entryId) throw new Error("expected a branchable entry");
				expect(await session.branch(entryId)).toMatchObject({ cancelled: false });
			},
		],
	] as const)(
		"skips a question core dropped at %s, so the next answer settles the one still owed",
		async (_label, leave) => {
			const harness = await bridgeSession();
			const { peer, session } = harness;
			await harness.start();
			await peer.next("hello");
			harness.deliverInjected();

			// Asked from the old conversation and never answered: leaving it drops the question.
			expect(await writeAcked(harness, "demo://leia", "old question")).toBe("delivered");
			await leave(session);
			expect(await harness.waitBlocks()).toBe(false);

			// Asked from the new conversation: leia's next message settles it.
			expect(await writeAcked(harness, "demo://leia", "new question")).toBe("delivered");
			expect(await harness.waitBlocks()).toBe(true);
			peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "answer", expectsReply: false });
			await peer.next("receipt");
			expect(await harness.waitBlocks()).toBe(false);
		},
	);

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

	it("skips a peer record of the wrong shape and keeps serving the connection", async () => {
		const harness = await bridgeSession();
		const { peer } = harness;
		await harness.start();
		await peer.next("hello");
		harness.deliverInjected();
		// Valid JSON, but not a peer record: neither may reach the bridge's handler.
		peer.sendRaw('null\n{"type":"inbound","id":"peer-0","from":"leia"}\n');
		peer.send({ type: "inbound", id: "peer-1", from: "leia", body: "still here", expectsReply: false });
		expect(await peer.next("receipt")).toEqual({ type: "receipt", id: "peer-1", receipt: { outcome: "delivered" } });
		expect(peer.openConnections()).toBe(1);
	});

	it("disconnects while a live disable suspends it, and reconnects with its scheme on resume", async () => {
		const harness = await bridgeSession();
		const { peer, runner } = harness;
		const router = harness.session.urlRouter;
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

	/**
	 * Whether the peer gets a(nother) `hello` within a bounded window. Nothing announces a connection
	 * that never opens, so a negative needs a window; the socket is local, a real one shows up in ms.
	 */
	const helloWithin = (peer: TestPeer): Promise<boolean> =>
		Promise.race([peer.next("hello").then(() => true), Bun.sleep(500).then(() => false)]);

	it("keeps a subagent's load off the socket, even when a live disable is lifted", async () => {
		const harness = await bridgeSession({ subagent: true });
		const { peer, runner } = harness;
		await harness.start();
		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		expect(await helloWithin(peer)).toBe(false);
		expect(peer.openConnections()).toBe(0);
	});

	it("keeps one connection when a live disable comes and goes while it is still connecting", async () => {
		const harness = await bridgeSession();
		const { peer, runner } = harness;
		// `session_start` began connecting; the socket has not opened yet.
		await harness.start();
		runner.setSuspendedExtensions(() => true);
		runner.setSuspendedExtensions(() => false);
		expect(await peer.next("hello")).toMatchObject({ agentId: "Main" });
		// A superseded attempt closes without a hello; a second attached connection would send one.
		expect(await helloWithin(peer)).toBe(false);
		expect(peer.openConnections()).toBe(1);
	});

	it("registers its scheme in the factory, so startup never defers it past the first prompt", async () => {
		const tempDir = TempDir.createSync(`@pi-url-scheme-bridge-${Snowflake.next()}-`);
		tempDirs.push(tempDir);
		const roster: Roster = { namespace: "demo", socket: tempDir.join("bridge.sock"), peers: ["leia"] };
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
		expect(loaded.extensions[0].urlSchemes.has("demo")).toBe(true);
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

	/** Load the bridge from its path with the roster at `rosterPath`; resolves with the load errors. */
	async function loadErrors(rosterPath: string): Promise<string[]> {
		Bun.env.OMP_PEER_BRIDGE_ROSTER = rosterPath;
		const loaded = await loadExtensions([EXTENSION_PATH], path.dirname(rosterPath));
		for (const extension of loaded.extensions) extension.registrations?.release();
		return loaded.errors.map(error => error.error);
	}

	/** Write a roster into `dir` naming a socket in `socketDir`; returns the roster path. */
	function writeRoster(dir: string, socketDir: string): string {
		const rosterPath = path.join(dir, "roster.json");
		const roster: Roster = { namespace: "demo", socket: path.join(socketDir, "bridge.sock"), peers: ["leia"] };
		fs.writeFileSync(rosterPath, JSON.stringify(roster));
		return rosterPath;
	}

	it("fails its load when the roster or socket directory is open to other users, or a symlink", async () => {
		const open = bridgeDir();
		fs.chmodSync(open.path(), 0o755);
		expect(await loadErrors(writeRoster(open.path(), bridgeDir().path()))).toEqual([
			expect.stringContaining(`roster directory ${open.path()} is open to other users`),
		]);
		// The roster's directory is private, but the socket it names sits in the shared /tmp.
		expect(await loadErrors(writeRoster(bridgeDir().path(), "/tmp"))).toEqual([
			expect.stringContaining("socket directory /tmp "),
		]);
		// A link to a private directory: whoever controls the link chooses what it points at.
		const target = bridgeDir();
		const link = `${target.path()}-link`;
		fs.symlinkSync(target.path(), link);
		cleanups.push(() => fs.rmSync(link, { force: true }));
		expect(await loadErrors(writeRoster(link, target.path()))).toEqual([
			expect.stringContaining(`roster directory ${link} must be a directory, not a symlink`),
		]);
	});

	it("peer CLI refuses an existing --dir that other users can reach", async () => {
		const open = bridgeDir();
		fs.chmodSync(open.path(), 0o755);
		const cli = spawnPeerCli(["--dir", open.path()]);
		cleanups.push(() => cli.kill());
		expect(await cli.exited).toBe(2);
		expect(await cli.stderr()).toContain(`${open.path()} is open to other users`);
		expect(fs.readdirSync(open.path())).toEqual([]);
	}, 20_000);

	it("peer CLI keeps its roster and socket in a fresh 0700 directory and removes it on /quit", async () => {
		const cli = spawnPeerCli([]);
		cleanups.push(() => cli.kill());
		const [, rosterPath] = await cli.output(/roster written to (\S+)\n/);
		const dir = path.dirname(rosterPath);
		expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
		expect(parseRoster(JSON.parse(fs.readFileSync(rosterPath, "utf8"))).socket).toBe(path.join(dir, "bridge.sock"));
		await cli.output(/listening on /);
		cli.type("/quit");
		expect(await cli.exited).toBe(0);
		expect(fs.existsSync(dir)).toBe(false);
	}, 20_000);

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
		const decoder = new LineDecoder(parsePeerMessage, (line, error) => {
			throw new Error(`malformed ${line}: ${String(error)}`);
		});
		const record: PeerMessage = { type: "inbound", id: "p1", from: "leia", body: "héllo €", expectsReply: false };
		const bytes = new TextEncoder().encode(encodeLine(record));
		// Cut inside the two-byte "é" (C3 A9): a per-chunk decode would yield replacement characters.
		const cut = bytes.indexOf(0xc3) + 1;
		expect(decoder.push(bytes.slice(0, cut))).toEqual([]);
		expect(decoder.push(bytes.slice(cut))).toEqual([record]);
	});

	it("skips and reports each line that is not a record of the expected shape, and keeps decoding", () => {
		const dropped: string[] = [];
		const decoder = new LineDecoder(parsePeerMessage, line => dropped.push(line));
		const valid: PeerMessage = { type: "ack", id: "m1", receipt: { outcome: "delivered" } };
		const invalid = [
			"null",
			"[1]",
			'{"type":"bogus","id":"m0"}',
			'{"type":"ack","id":"m0"}',
			'{"type":"ack","id":"m0","receipt":{"outcome":"maybe"}}',
			'{"type":"inbound","id":"p0","from":"leia","body":7,"expectsReply":false}',
			"not json",
		];
		expect(decoder.push(`${invalid.join("\n")}\n${encodeLine(valid)}`)).toEqual([valid]);
		expect(dropped).toEqual(invalid);
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
