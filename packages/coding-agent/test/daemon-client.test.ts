import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonClient, type DaemonConnectionSnapshot } from "../src/daemon/client";
import { daemonRuntimeDir } from "../src/daemon/paths";
import {
	DAEMON_PROTOCOL_MAJOR,
	type DaemonHelloOk,
	type DaemonResponse,
	type DaemonShard,
	encodeDaemonFrame,
} from "../src/daemon/protocol";

const shard: DaemonShard = { profile: "work" };

async function socketServer(handler: (socket: net.Socket) => void): Promise<{ server: net.Server; endpoint: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-client-test-"));
	const endpoint = path.join(root, "daemon.sock");
	const server = net.createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve());
	});
	return { server, endpoint };
}

function helloOk(): DaemonHelloOk {
	return {
		v: DAEMON_PROTOCOL_MAJOR,
		tag: "hello_ok",
		requestId: "hello-1",
		daemonId: "daemon-1",
		serverVersion: "0.1.0",
		protocolVersion: DAEMON_PROTOCOL_MAJOR,
		shard,
		capabilities: [],
	};
}

describe("daemon profile scope", () => {
	test("uses one runtime directory for the active profile regardless of cwd", () => {
		const configRoot = path.join(os.tmpdir(), "omp-profile");

		expect(daemonRuntimeDir(configRoot)).toBe(path.join(configRoot, "run", "daemon"));
	});
});

describe("daemon client", () => {
	test("authenticates and correlates out-of-order responses over a real socket", async () => {
		let requests = 0;
		const eventSeqs: number[] = [];
		const snapshotTags: string[] = [];
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const frame = JSON.parse(line) as { tag: string; requestId: string; operation?: string };
					if (frame.tag === "hello") {
						socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "snapshot_begin",
								sessionId: "s1",
								attachmentId: "a1",
								barrierSeq: 0,
							}),
						);
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "snapshot_chunk",
								sessionId: "s1",
								attachmentId: "a1",
								barrierSeq: 0,
								index: 0,
								chunk: { messages: [] },
							}),
						);
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "event",
								sessionId: "s1",
								seq: 1,
								event: { type: "message_update" },
							}),
						);
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "snapshot_end",
								sessionId: "s1",
								attachmentId: "a1",
								barrierSeq: 0,
								nextSeq: 1,
							}),
						);
					} else {
						requests++;
						const response: DaemonResponse = {
							v: DAEMON_PROTOCOL_MAJOR,
							tag: "response",
							requestId: frame.requestId,
							ok: true,
							result: { operation: frame.operation },
						};
						setTimeout(() => socket.write(encodeDaemonFrame(response)), frame.operation === "ping" ? 10 : 0);
					}
				}
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		client.onSnapshotFrame(frame => snapshotTags.push(frame.tag));
		client.onEvent(frame => eventSeqs.push(frame.seq));
		try {
			const first = client.request("server_status");
			const second = client.request("ping");
			expect(await second).toEqual({ operation: { op: "ping" } });
			expect(await first).toEqual({ operation: { op: "server_status" } });
			expect(requests).toBe(2);
			expect(eventSeqs).toEqual([1]);
			expect(snapshotTags).toEqual(["snapshot_begin", "snapshot_chunk", "snapshot_end"]);
			expect(client.snapshot.state).toBe("connected");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("rejects incompatible hello and exposes a stable snapshot", async () => {
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				socket.write(
					encodeDaemonFrame({
						...helloOk(),
						requestId: frame.requestId,
						protocolVersion: DAEMON_PROTOCOL_MAJOR + 1,
					}),
				);
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		try {
			await expect(client.connect()).rejects.toThrow(/incompatible protocol/);
			expect(client.snapshot.state).toBe("incompatible");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("surfaces authenticated token rejection from the hello response", async () => {
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { requestId: string };
				socket.write(
					encodeDaemonFrame({
						v: DAEMON_PROTOCOL_MAJOR,
						tag: "response",
						requestId: frame.requestId,
						ok: false,
						error: { code: "authentication_failed", message: "token rejected" },
					}),
				);
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "wrong", connectTimeoutMs: 100 });
		try {
			await expect(client.connect()).rejects.toThrow(/authentication_failed: token rejected/);
			expect(client.snapshot.state).toBe("unavailable");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("treats an unanswered request as a dead transport and requests recovery", async () => {
		let recoveryRequests = 0;
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const frame = JSON.parse(line) as { tag: string; requestId: string };
					if (frame.tag === "hello") socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
					// Deliberately leave requests unanswered: a live socket with
					// no event-loop progress is an unavailable daemon, not a
					// healthy connection that callers should keep using.
				}
			});
		});
		const client = new DaemonClient({
			profile: shard.profile,
			endpoint,
			token: "secret",
			requestTimeoutMs: 20,
			recoverUnavailable: () => {
				recoveryRequests++;
			},
		});
		try {
			await expect(client.request("ping")).rejects.toThrow(/timed out/);
			expect(recoveryRequests).toBe(1);
			expect(client.snapshot.state).toBe("reconnecting");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test("accepts a server status event without resolving requests", async () => {
		let eventSeen: DaemonConnectionSnapshot | undefined;
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				if (frame.tag !== "hello") return;
				socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
				socket.write(
					encodeDaemonFrame({
						v: DAEMON_PROTOCOL_MAJOR,
						tag: "server_status",
						status: {
							daemonId: "daemon-1",
							serverVersion: "0.1.0",
							protocolVersion: DAEMON_PROTOCOL_MAJOR,
							shard,
							sessionCount: 3,
							attachmentCount: 1,
							protectedJobCount: 0,
							uptimeMs: 10,
						},
					}),
				);
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		try {
			await client.connect();
			eventSeen = client.snapshot;
			if (eventSeen.state !== "connected") throw new Error("expected connected snapshot");
			expect(eventSeen.sessionCount).toBe(3);
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("applies authoritative status fetched during capability negotiation", async () => {
		const status = {
			daemonId: "daemon-1",
			serverVersion: "0.1.0",
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			shard,
			sessionCount: 8,
			attachmentCount: 2,
			protectedJobCount: 1,
			uptimeMs: 42,
		};
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as {
					tag: string;
					requestId: string;
					operation?: { op: string };
				};
				if (frame.tag === "hello") {
					socket.write(
						encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId, capabilities: ["server_status"] }),
					);
				} else if (frame.operation?.op === "server_status") {
					socket.write(
						encodeDaemonFrame({
							v: DAEMON_PROTOCOL_MAJOR,
							tag: "response",
							requestId: frame.requestId,
							ok: true,
							result: status,
						}),
					);
				}
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		try {
			await client.connect();
			const snapshot = client.snapshot;
			if (snapshot.state !== "connected") throw new Error("expected connected snapshot");
			expect(snapshot.sessionCount).toBe(8);
			expect(snapshot.attachmentCount).toBe(2);
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("retires a live socket before explicit reconnect", async () => {
		let connections = 0;
		const { server, endpoint } = await socketServer(socket => {
			connections++;
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				if (frame.tag === "hello") socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		try {
			await client.connect();
			await client.reconnect();
			expect(connections).toBe(2);
			expect(client.snapshot.state).toBe("connected");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("requests shard recovery when an established daemon becomes unavailable", async () => {
		let acceptedSocket: net.Socket | undefined;
		const { server, endpoint } = await socketServer(socket => {
			acceptedSocket = socket;
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				if (frame.tag === "hello") socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
			});
		});
		let recoveryRequests = 0;
		const client = new DaemonClient({
			profile: shard.profile,
			endpoint,
			token: "secret",
			connectTimeoutMs: 25,
			recoverUnavailable: () => {
				recoveryRequests++;
			},
		});
		try {
			await client.connect();
			acceptedSocket?.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			const deadline = Date.now() + 2_000;
			while (recoveryRequests === 0 && Date.now() < deadline) await Bun.sleep(10);
			expect(recoveryRequests).toBe(1);
		} finally {
			client.close();
			if (server.listening) {
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				await closed.promise;
			}
		}
	});
	test("aborts an in-flight handshake when closed", async () => {
		let acceptedResolve: (() => void) | undefined;
		const accepted = new Promise<void>(resolve => {
			acceptedResolve = resolve;
		});
		const { server, endpoint } = await socketServer(socket => {
			acceptedResolve?.();
			socket.resume();
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret", connectTimeoutMs: 100 });
		try {
			const connecting = client.connect();
			await accepted;
			client.close();
			await expect(connecting).rejects.toThrow(/closed/);
			expect(client.snapshot.state).toBe("unavailable");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("clears a failed handshake timer before reconnecting", async () => {
		let connections = 0;
		const { server, endpoint } = await socketServer(socket => {
			connections++;
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				if (connections === 1) {
					socket.write("{malformed}\\n");
					socket.destroy();
				} else if (frame.tag === "hello") {
					socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
				}
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret", connectTimeoutMs: 50 });
		try {
			await expect(client.connect()).rejects.toThrow(/invalid JSON|invalid frame|connection closed/);
			await client.connect();
			expect(client.snapshot.state).toBe("connected");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("automatically retries a dropped connection with bounded backoff", async () => {
		let connections = 0;
		let connectedCount = 0;
		let secondConnectedResolve: (() => void) | undefined;
		const secondConnected = new Promise<void>(resolve => {
			secondConnectedResolve = resolve;
		});
		const { server, endpoint } = await socketServer(socket => {
			connections++;
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				const frame = JSON.parse(String(chunk).trim()) as { tag: string; requestId: string };
				if (frame.tag !== "hello") return;
				socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
				if (connections === 1) socket.end();
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		client.onSnapshot(snapshot => {
			if (snapshot.state === "connected") {
				connectedCount++;
				if (connectedCount === 2) secondConnectedResolve?.();
			}
		});
		try {
			await client.connect();
			await secondConnected;
			expect(connections).toBeGreaterThanOrEqual(2);
			expect(client.snapshot.state).toBe("connected");
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("serializes writes while waiting for drain", async () => {
		const { server, endpoint } = await socketServer(socket => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const frame = JSON.parse(buffer.slice(0, newline)) as { tag: string; requestId: string };
					buffer = buffer.slice(newline + 1);
					if (frame.tag === "hello") {
						socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
					} else {
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "response",
								requestId: frame.requestId,
								ok: true,
								result: { accepted: true },
							}),
						);
					}
				}
			});
		});
		const originalWrite = net.Socket.prototype.write;
		let forcedBackpressure = false;
		const patchedWrite = function (this: net.Socket, ...args: Parameters<typeof originalWrite>): boolean {
			const accepted = originalWrite.apply(this, args);
			const firstRequest = !forcedBackpressure && String(args[0]).includes('"tag":"request"');
			if (firstRequest) {
				forcedBackpressure = true;
				queueMicrotask(() => this.emit("drain"));
				return false;
			}
			return accepted;
		};
		Object.defineProperty(net.Socket.prototype, "write", { configurable: true, writable: true, value: patchedWrite });
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret" });
		try {
			await expect(client.request("ping")).resolves.toEqual({ accepted: true });
			expect(forcedBackpressure).toBe(true);
		} finally {
			client.close();
			Object.defineProperty(net.Socket.prototype, "write", {
				configurable: true,
				writable: true,
				value: originalWrite,
			});
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test("rejects pending requests when reconnect replaces the socket", async () => {
		let connections = 0;
		let requestSeenResolve: (() => void) | undefined;
		const requestSeen = new Promise<void>(resolve => {
			requestSeenResolve = resolve;
		});
		const { server, endpoint } = await socketServer(socket => {
			connections++;
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const frame = JSON.parse(buffer.slice(0, newline)) as { tag: string; requestId: string };
					buffer = buffer.slice(newline + 1);
					if (frame.tag === "hello") {
						socket.write(encodeDaemonFrame({ ...helloOk(), requestId: frame.requestId }));
					} else if (connections === 1) {
						requestSeenResolve?.();
					} else {
						socket.write(
							encodeDaemonFrame({
								v: DAEMON_PROTOCOL_MAJOR,
								tag: "response",
								requestId: frame.requestId,
								ok: true,
								result: { fresh: true },
							}),
						);
					}
				}
			});
		});
		const client = new DaemonClient({ profile: shard.profile, endpoint, token: "secret", requestTimeoutMs: 5_000 });
		try {
			await client.connect();
			const pending = client.request("ping");
			await requestSeen;
			const reconnect = client.reconnect();
			await expect(pending).rejects.toThrow(/connection replaced/);
			await reconnect;
			await expect(client.request("ping")).resolves.toEqual({ fresh: true });
			expect(connections).toBe(2);
		} finally {
			client.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
