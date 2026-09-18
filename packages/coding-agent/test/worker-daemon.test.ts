import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { NdjsonLineBuffer } from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/shared-worker-client";
import {
	runSocketDaemonWorker,
	splitDaemonId,
	type WorkerTransport,
} from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/worker-daemon";
import type { Socket } from "bun";

type In = { type: "ping"; id: string } | { type: "complete"; id: string; text: string } | { type: "nudge" };
type Out =
	| { type: "pong"; id: string }
	| { type: "completion"; id: string; text: string }
	| { type: "log"; msg: string };

function tmpSocketPath(tag: string): string {
	return path.join(os.tmpdir(), `ompk-wd-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/** Fake worker: echoes with the id it was handed so the test can prove remapping. */
function fakeWorker(transport: WorkerTransport<In, Out>): void {
	transport.onMessage(msg => {
		if (msg.type === "ping") transport.send({ type: "pong", id: msg.id });
		else if (msg.type === "complete") transport.send({ type: "completion", id: msg.id, text: `ok:${msg.id}` });
		else if (msg.type === "nudge") transport.send({ type: "log", msg: "broadcast" });
	});
}

interface TestClient {
	socket: Socket;
	received: Out[];
	next(): Promise<Out>;
	send(msg: In): void;
}

async function connectClient(socketPath: string): Promise<TestClient> {
	const received: Out[] = [];
	const waiters: Array<(m: Out) => void> = [];
	const lines = new NdjsonLineBuffer();
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_s, chunk) {
				for (const line of lines.push(chunk)) {
					const msg = JSON.parse(line) as Out;
					const waiter = waiters.shift();
					if (waiter) waiter(msg);
					else received.push(msg);
				}
			},
		},
	});
	return {
		socket,
		received,
		next() {
			const queued = received.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<Out>();
			waiters.push(resolve);
			return promise;
		},
		send(msg) {
			socket.write(`${JSON.stringify(msg)}\n`);
		},
	};
}

const openClients: Socket[] = [];
afterEach(() => {
	for (const s of openClients.splice(0)) s.end();
});

describe("splitDaemonId", () => {
	it("separates the client sequence from the original id, keeping later colons", () => {
		expect(splitDaemonId("7:abc:def")).toEqual({ clientSeq: 7, originalId: "abc:def" });
		expect(splitDaemonId("nocolon")).toBeUndefined();
		expect(splitDaemonId(":1")).toBeUndefined();
	});
});

describe("runSocketDaemonWorker", () => {
	it("routes replies to the originating client with the client's own id and broadcasts logs", async () => {
		const socketPath = tmpSocketPath("route");
		// Never resolves by design; the daemon serves until the process exits.
		void runSocketDaemonWorker<In, Out>(socketPath, fakeWorker, 60_000, { onIdleExit() {} });

		const a = await connectClient(socketPath);
		const b = await connectClient(socketPath);
		openClients.push(a.socket, b.socket);

		// Both clients use id "1" — only remapping keeps their replies apart.
		a.send({ type: "complete", id: "1", text: "from-a" });
		b.send({ type: "complete", id: "1", text: "from-b" });

		const [ra, rb] = await Promise.all([a.next(), b.next()]);
		expect(ra).toEqual({ type: "completion", id: "1", text: "ok:1:1" });
		expect(rb).toEqual({ type: "completion", id: "1", text: "ok:2:1" });

		a.send({ type: "nudge" });
		const [la, lb] = await Promise.all([a.next(), b.next()]);
		expect(la).toEqual({ type: "log", msg: "broadcast" });
		expect(lb).toEqual({ type: "log", msg: "broadcast" });
	});

	it("drops replies for a client that disconnected before the worker answered", async () => {
		const socketPath = tmpSocketPath("drop");
		let capturedTransport: WorkerTransport<In, Out> | undefined;
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				capturedTransport = transport;
				transport.onMessage(() => {});
			},
			60_000,
			{ onIdleExit() {} },
		);

		const gone = await connectClient(socketPath);
		const stays = await connectClient(socketPath);
		openClients.push(stays.socket);
		gone.socket.end();

		// Reply addressed to the departed client 1 must be dropped; the surviving
		// client 2 must still receive its own reply afterwards.
		capturedTransport?.send({ type: "pong", id: "1:late" });
		capturedTransport?.send({ type: "pong", id: "2:mine" });
		expect(await stays.next()).toEqual({ type: "pong", id: "mine" });
		expect(stays.received).toEqual([]);
	});
});
