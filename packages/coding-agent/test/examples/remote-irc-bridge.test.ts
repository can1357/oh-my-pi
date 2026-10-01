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

			// Inbound: a peer line becomes deliverInbound(@demo/leia -> Main) with expectsReply forwarded;
			// the delivery outcome goes back on the wire with omp's own message id.
			const delivered = vi.spyOn(session, "deliverIrcMessage").mockResolvedValue("injected");
			peer.send({ type: "inbound", id: "peer-1", from: "leia", to: "Main", body: "ping", expectsReply: true });
			const receipt = await peer.next("receipt");
			expect(receipt).toMatchObject({ id: "peer-1", receipt: { to: "Main", outcome: "injected" } });
			expect(typeof receipt.ompId).toBe("string");
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(delivered.mock.calls[0][0]).toMatchObject({ from: "@demo/leia", to: "Main", body: "ping" });
		} finally {
			await session.dispose();
			peer.stop();
			fs.rmSync(socketPath, { force: true });
		}
	});
});
