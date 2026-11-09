import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import type { RpcClientConn } from "../src/modes/rpc/client-connection";
import { RpcFrameDecoder } from "../src/modes/rpc/rpc-frame";
import {
	RpcSessionSocket,
	type RpcSessionSocketIdentity,
	type RpcSessionSocketSurface,
	type RpcSessionSocketTerminal,
} from "../src/modes/rpc/rpc-socket";

type Frame = Record<string, unknown> & { type?: string };

const FRAME_TIMEOUT_MS = 5000;

class SocketPeer {
	readonly seen: Frame[] = [];
	#queue: Frame[] = [];
	#wake: (() => void) | undefined;
	readonly #closedSignal = Promise.withResolvers<void>();
	closed = false;

	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 4000 });
		const peer = new SocketPeer(conn);
		conn.start(
			line => {
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					return;
				}
				peer.seen.push(frame);
				peer.#queue.push(frame);
				peer.#wake?.();
			},
			() => {
				peer.closed = true;
				peer.#closedSignal.resolve();
			},
		);
		return peer;
	}

	async next(predicate: (frame: Frame) => boolean, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
		for (;;) {
			const index = this.#queue.findIndex(predicate);
			if (index >= 0) return this.#queue.splice(index, 1)[0]!;
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await withTimeout(
				arrived.promise,
				timeoutMs,
				`timed out waiting for frame; saw ${JSON.stringify(this.#queue)}`,
			);
			this.#wake = undefined;
		}
	}

	async closedByRemote(timeoutMs = FRAME_TIMEOUT_MS): Promise<void> {
		if (this.closed) return;
		await withTimeout(this.#closedSignal.promise, timeoutMs, "connection did not close");
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	close(): void {
		this.conn.destroy();
	}
}

interface FakeSession {
	identity: RpcSessionSocketIdentity;
	subscribe(listener: (event: object) => void): () => void;
	emit(event: object): void;
}

function fakeSession(identity: RpcSessionSocketIdentity): FakeSession {
	const listeners = new Set<(event: object) => void>();
	return {
		identity,
		subscribe(listener: (event: object) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: object): void {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

function startServer(
	directory: string,
	session: FakeSession,
	createSurface: (conn: RpcClientConn) => RpcSessionSocketSurface,
	terminal?: () => RpcSessionSocketTerminal | undefined,
): Promise<RpcSessionSocket> {
	const socket = new RpcSessionSocket({
		endpointDir: directory,
		identity: () => session.identity,
		subscribe: listener => session.subscribe(listener),
		...(terminal ? { terminal } : {}),
	});
	return socket.listen(createSurface).then(() => socket);
}

function readSidecar(directory: string): Record<string, unknown> {
	const name = fs.readdirSync(directory).find(entry => entry.endsWith(".json"));
	if (!name) throw new Error("no sidecar published");
	return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>;
}

const quietSurface = (): RpcSessionSocketSurface => ({ dispatch: () => {} });

/** Leave a socket file with no listener behind by SIGKILLing its owner. */
async function leaveStaleSocket(endpoint: string): Promise<void> {
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(endpoint)}, () => process.kill(process.pid, "SIGKILL"))`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await child.exited;
}

describe("RPC session socket", () => {
	let directory: string;
	let session: FakeSession;
	let sockets: RpcSessionSocket[];

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), `omp-rpc-socket-${Snowflake.next()}-`));
		session = fakeSession({
			sessionId: "sess-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			agent: "anthropic/claude-sonnet-4-5",
		});
		sockets = [];
	});

	afterEach(async () => {
		for (const socket of sockets) await socket.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	async function publish(
		createSurface: (conn: RpcClientConn) => RpcSessionSocketSurface = () => quietSurface(),
		terminal?: () => RpcSessionSocketTerminal | undefined,
	): Promise<{ socket: RpcSessionSocket; endpoint: string }> {
		const socket = await startServer(directory, session, createSurface, terminal);
		sockets.push(socket);
		const endpoint = path.join(directory, "sess-1.sock");
		return { socket, endpoint };
	}

	it("publishes owner-only session metadata", async () => {
		const { socket, endpoint } = await publish();

		expect(socket.endpoint).toBe(endpoint);
		expect(socket.sidecarPath).toBe(path.join(directory, "sess-1.json"));
		expect(fs.statSync(endpoint).mode & 0o777).toBe(0o600);

		const sidecarPath = path.join(directory, "sess-1.json");
		expect(fs.statSync(sidecarPath).mode & 0o777).toBe(0o600);
		const metadata = readSidecar(directory);
		expect(metadata).toEqual({
			pid: process.pid,
			sessionId: "sess-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			agent: "anthropic/claude-sonnet-4-5",
			startedAt: expect.any(Number),
		});
	});

	it("sends ready before any frame the surface produces", async () => {
		const { endpoint } = await publish(conn => {
			conn.send({ type: "surface_frame" });
			return quietSurface();
		});

		const peer = await SocketPeer.connect(endpoint);
		await peer.next(frame => frame.type === "surface_frame");
		expect(peer.seen[0]).toMatchObject({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
		});
	});

	it("broadcasts session events to every attached connection", async () => {
		const { endpoint } = await publish();
		const first = await SocketPeer.connect(endpoint);
		const second = await SocketPeer.connect(endpoint);
		await first.next(frame => frame.type === "ready");
		await second.next(frame => frame.type === "ready");

		session.emit({ type: "agent_start" });

		expect(await first.next(frame => frame.type === "agent_start")).toEqual({ type: "agent_start" });
		expect(await second.next(frame => frame.type === "agent_start")).toEqual({ type: "agent_start" });
	});

	it("negotiates protocol v2 per connection so v1 and v2 clients coexist", async () => {
		const connections: RpcClientConn[] = [];
		const { endpoint } = await publish(conn => {
			connections.push(conn);
			return {
				dispatch: raw => {
					const frame = raw as { type?: string; id?: string };
					if (frame.type !== "negotiate_protocol") return;
					conn.send({
						id: frame.id,
						type: "response",
						command: "negotiate_protocol",
						success: true,
						data: { protocolVersion: 2 },
					});
				},
			};
		});
		const modern = await SocketPeer.connect(endpoint);
		const legacy = await SocketPeer.connect(endpoint);
		await modern.next(frame => frame.type === "ready");
		await legacy.next(frame => frame.type === "ready");

		modern.send({ type: "negotiate_protocol", id: "n1", protocolVersion: 2 });
		await modern.next(frame => frame.type === "response" && frame.id === "n1");

		const text = "x".repeat(2 * 1024 * 1024);
		const large = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } };
		connections[0]!.send(large);
		connections[1]!.send(large);

		const decoder = new RpcFrameDecoder();
		const reassembled: object[] = [];
		while (reassembled.length === 0) {
			await modern.next(frame => {
				if (frame.type !== "rpc_chunk") return false;
				const decoded = decoder.push(frame);
				if (decoded) reassembled.push(decoded);
				return true;
			});
		}
		expect(reassembled).toEqual([large]);

		const single = await legacy.next(() => true);
		expect(single.type).not.toBe("rpc_chunk");
		expect(legacy.seen.some(frame => frame.type === "rpc_chunk")).toBe(false);
	});

	it("recovers a stale socket but leaves a live listener alone", async () => {
		const endpoint = path.join(directory, "sess-1.sock");
		await leaveStaleSocket(endpoint);
		expect(fs.lstatSync(endpoint).isSocket()).toBe(true);

		const { socket } = await publish();
		const live = await SocketPeer.connect(endpoint);
		await live.next(frame => frame.type === "ready");

		const owner = readSidecar(directory);
		const intruder = new RpcSessionSocket({
			endpointDir: directory,
			identity: () => session.identity,
			subscribe: listener => session.subscribe(listener),
		});
		sockets.push(intruder);
		await expect(intruder.listen(() => quietSurface())).rejects.toMatchObject({ code: "EADDRINUSE" });

		expect(readSidecar(directory)).toEqual(owner);
		const stillLive = await SocketPeer.connect(endpoint);
		expect(await stillLive.next(frame => frame.type === "ready")).toMatchObject({ type: "ready" });

		await socket.close();
		expect(fs.existsSync(endpoint)).toBe(false);
	});

	it("keeps the endpoint and other clients when one client disconnects", async () => {
		const closed = Promise.withResolvers<string>();
		const { endpoint } = await publish(conn => ({
			dispatch: () => {},
			close: reason => {
				closed.resolve(`${conn.id}:${reason}`);
			},
		}));
		const first = await SocketPeer.connect(endpoint);
		const second = await SocketPeer.connect(endpoint);
		await first.next(frame => frame.type === "ready");
		await second.next(frame => frame.type === "ready");

		first.close();
		await first.closedByRemote();

		expect(await withTimeout(closed.promise, FRAME_TIMEOUT_MS, "surface close never ran")).toContain("socket-1:");
		expect(fs.existsSync(endpoint)).toBe(true);

		session.emit({ type: "agent_end", messages: [] });
		expect(await second.next(frame => frame.type === "agent_end")).toMatchObject({ type: "agent_end" });

		const third = await SocketPeer.connect(endpoint);
		expect(await third.next(frame => frame.type === "ready")).toMatchObject({ type: "ready" });
		expect(second.closed).toBe(false);
	});

	it("rebinds to the new session id and keeps attached connections", async () => {
		const { socket, endpoint } = await publish();
		const peer = await SocketPeer.connect(endpoint);
		await peer.next(frame => frame.type === "ready");

		session.identity = {
			...session.identity,
			sessionId: "sess-2",
			sessionFile: "/tmp/other.jsonl",
		};
		await socket.rebind();

		expect(fs.existsSync(endpoint)).toBe(false);
		expect(fs.existsSync(path.join(directory, "sess-1.json"))).toBe(false);
		const rebound = path.join(directory, "sess-2.sock");
		expect(socket.endpoint).toBe(rebound);
		expect(fs.existsSync(rebound)).toBe(true);
		expect(readSidecar(directory)).toMatchObject({
			pid: process.pid,
			sessionId: "sess-2",
			sessionFile: "/tmp/other.jsonl",
		});

		session.emit({ type: "agent_start" });
		expect(await peer.next(frame => frame.type === "agent_start")).toMatchObject({ type: "agent_start" });

		const attached = await SocketPeer.connect(rebound);
		expect(await attached.next(frame => frame.type === "ready")).toMatchObject({ type: "ready" });
	});

	it("refreshes the sidecar when the session id did not change", async () => {
		const { socket } = await publish();
		session.identity = { ...session.identity, sessionFile: "/tmp/renamed.jsonl" };

		await socket.rebind();

		expect(readSidecar(directory)).toMatchObject({
			sessionId: "sess-1",
			sessionFile: "/tmp/renamed.jsonl",
		});
		expect(fs.existsSync(path.join(directory, "sess-1.sock"))).toBe(true);
	});

	it("publishes broker terminal coordinates only when the process owns a broker PTY", async () => {
		const coordinates: RpcSessionSocketTerminal = {
			protocolVersion: 1,
			projectDir: "/fixture/project",
			name: "mind-a",
			id: "generation-a",
		};
		const { socket } = await publish(undefined, () => coordinates);
		expect(readSidecar(directory).terminal).toEqual(coordinates);
		await socket.close();

		await publish();
		expect(readSidecar(directory)).not.toHaveProperty("terminal");
	});

	it("keeps broker coordinates and a consistent discovery pair across a session rebind", async () => {
		const coordinates: RpcSessionSocketTerminal = {
			protocolVersion: 1,
			projectDir: "/fixture/project",
			name: "mind-a",
			id: "generation-a",
		};
		const { socket } = await publish(undefined, () => coordinates);
		let polling = true;
		const poll = (async () => {
			while (polling) {
				const names = fs.readdirSync(directory);
				const sidecars = names.filter(entry => entry.endsWith(".json"));
				const sockets = names.filter(entry => entry.endsWith(".sock"));
				if (sidecars.length === 1) {
					const metadata = JSON.parse(fs.readFileSync(path.join(directory, sidecars[0]!), "utf8")) as {
						sessionId?: string;
						terminal?: unknown;
					};
					expect(metadata.terminal).toEqual(coordinates);
					if (sockets.length === 1) expect(sockets[0]).toBe(`${metadata.sessionId}.sock`);
				}
				const yielded = Promise.withResolvers<void>();
				setImmediate(yielded.resolve);
				await yielded.promise;
			}
		})();

		session.identity = { ...session.identity, sessionId: "sess-2", sessionFile: "/tmp/other.jsonl" };
		await socket.rebind();
		polling = false;
		await poll;

		expect(fs.existsSync(path.join(directory, "sess-1.sock"))).toBe(false);
		expect(fs.existsSync(path.join(directory, "sess-1.json"))).toBe(false);
		expect(fs.existsSync(path.join(directory, "sess-2.sock"))).toBe(true);
		const metadata = readSidecar(directory);
		expect(metadata).toMatchObject({ pid: process.pid, sessionId: "sess-2" });
		expect(metadata.terminal).toEqual(coordinates);
	});

	it("close unlinks its artifacts and severs attached clients", async () => {
		const { socket, endpoint } = await publish();
		const peer = await SocketPeer.connect(endpoint);
		await peer.next(frame => frame.type === "ready");

		await socket.close();

		expect(fs.existsSync(endpoint)).toBe(false);
		expect(fs.existsSync(path.join(directory, "sess-1.json"))).toBe(false);
		await peer.closedByRemote();
	});
});
