import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSharedWorkerHandle,
	NdjsonLineBuffer,
} from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/shared-worker-client";
import type { Socket, UnixSocketListener } from "bun";

type Inbound = { type: "ping"; id: string } | { type: "complete"; id: string; text: string };
type Outbound =
	| { type: "pong"; id: string }
	| { type: "completion"; id: string; text: string }
	| { type: "log"; msg: string };

function tmpSocketPath(tag: string): string {
	return path.join(os.tmpdir(), `ompk-swc-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/** Echo daemon stand-in: pong for ping, `ok:<text>` for complete, plus an unsolicited log line. */
function startEchoServer(socketPath: string): {
	server: UnixSocketListener<undefined>;
	clients: Socket[];
	/** Resolves when the server observes its first client disconnect. */
	firstClientClosed: Promise<void>;
} {
	const clients: Socket[] = [];
	const closed = Promise.withResolvers<void>();
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open(s) {
				clients.push(s);
				s.write(`${JSON.stringify({ type: "log", msg: "hello" })}\n`);
			},
			data(s, chunk) {
				for (const line of chunk.toString("utf8").split("\n")) {
					if (!line) continue;
					const msg = JSON.parse(line) as Inbound;
					const reply: Outbound =
						msg.type === "ping"
							? { type: "pong", id: msg.id }
							: { type: "completion", id: msg.id, text: `ok:${msg.text}` };
					s.write(`${JSON.stringify(reply)}\n`);
				}
			},
			close() {
				closed.resolve();
			},
		},
	});
	return { server, clients, firstClientClosed: closed.promise };
}

const servers: UnixSocketListener<undefined>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("NdjsonLineBuffer", () => {
	it("reassembles lines split across chunks and skips empty lines", () => {
		const buf = new NdjsonLineBuffer();
		const enc = new TextEncoder();
		expect(buf.push(enc.encode('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
		expect(buf.push(enc.encode('2}\n\n{"c":3}\n'))).toEqual(['{"b":2}', '{"c":3}']);
	});
});

describe("createSharedWorkerHandle", () => {
	it("flushes queued sends in order once connected and routes replies", async () => {
		const socketPath = tmpSocketPath("order");
		const { server } = startEchoServer(socketPath);
		servers.push(server);

		const handle = createSharedWorkerHandle<Inbound, Outbound>({
			socketPath,
			spawnCommand: { cmd: [process.execPath, "-e", "process.exit(0)"] },
			env: {},
			label: "echo",
		});
		const received: Outbound[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		handle.onMessage(msg => {
			received.push(msg);
			if (received.filter(m => m.type !== "log").length === 2) resolve();
		});
		// Both sends land before the async connect resolves → exercised the queue.
		handle.send({ type: "ping", id: "1" });
		handle.send({ type: "complete", id: "2", text: "hi" });
		await promise;

		expect(received.find(m => m.type === "log")).toEqual({ type: "log", msg: "hello" });
		expect(received.filter(m => m.type !== "log")).toEqual([
			{ type: "pong", id: "1" },
			{ type: "completion", id: "2", text: "ok:hi" },
		]);
		await handle.terminate();
	});

	it("terminate() disconnects without firing onError", async () => {
		const socketPath = tmpSocketPath("term");
		const { server, clients, firstClientClosed } = startEchoServer(socketPath);
		servers.push(server);

		const handle = createSharedWorkerHandle<Inbound, Outbound>({
			socketPath,
			spawnCommand: { cmd: [process.execPath, "-e", "process.exit(0)"] },
			env: {},
			label: "echo",
		});
		const errors: Error[] = [];
		handle.onError(err => errors.push(err));
		const { promise, resolve } = Promise.withResolvers<void>();
		handle.onMessage(msg => {
			if (msg.type === "pong") resolve();
		});
		handle.send({ type: "ping", id: "p" });
		await promise;
		expect(clients.length).toBe(1);

		await handle.terminate();
		// The server-side close is the observable proof the disconnect happened;
		// by then any spurious client-side error would already have fired.
		await firstClientClosed;
		expect(errors).toEqual([]);
	});

	it("fires onError exactly once when the daemon closes the connection", async () => {
		const socketPath = tmpSocketPath("close");
		const { server, clients } = startEchoServer(socketPath);
		servers.push(server);

		const handle = createSharedWorkerHandle<Inbound, Outbound>({
			socketPath,
			spawnCommand: { cmd: [process.execPath, "-e", "process.exit(0)"] },
			env: {},
			label: "echo",
		});
		const errors: Error[] = [];
		handle.onError(err => errors.push(err));
		const { promise, resolve } = Promise.withResolvers<void>();
		handle.onMessage(msg => {
			if (msg.type === "pong") resolve();
		});
		handle.send({ type: "ping", id: "p" });
		await promise;

		const { promise: firstError, resolve: onFirstError } = Promise.withResolvers<Error>();
		handle.onError(onFirstError);
		clients[0]?.end();
		const err = await firstError;
		expect(err.message).toBe("echo connection closed");
		expect(errors.length).toBe(1);
		expect(errors[0]?.message).toBe("echo connection closed");
		await handle.terminate();
	});

	it("reports the daemon unreachable after the connect budget when nothing binds the socket", async () => {
		// Real clock on purpose: the retry loop polls `Bun.connect` against the
		// platform socket layer, which fake timers cannot drive. 600 ms is the
		// smallest budget that still covers the 100 ms fast-retry window.
		const socketPath = tmpSocketPath("dead");
		const handle = createSharedWorkerHandle<Inbound, Outbound>({
			socketPath,
			// A "daemon" that exits immediately without ever listening.
			spawnCommand: { cmd: [process.execPath, "-e", "process.exit(0)"] },
			env: { PATH: process.env.PATH ?? "" },
			label: "dead daemon",
			connectTimeoutMs: 600,
		});
		const { promise, resolve } = Promise.withResolvers<Error>();
		handle.onError(resolve);
		const err = await promise;
		expect(err.message).toBe(`dead daemon unreachable at ${socketPath} after 600ms`);
		await handle.terminate();
	});
});
