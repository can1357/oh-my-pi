/**
 * A fake Tern daemon for browser-backend tests: a Unix socket that speaks
 * Tern's JSON script protocol (`u32` LE length-prefixed JSON objects), records
 * the script's hellos and answers browser ops through a handler.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** What a handler answers: `{ ok }`, `{ error }`, or `null` to never answer. */
export type FakeAnswer = { ok: unknown } | { error: { kind: string; message: string } } | null;

/** One browser request the fake daemon received. */
export interface FakeRequest {
	id: number;
	op: Record<string, unknown>;
}

/** Handle of a running fake daemon. */
export interface FakeDaemon {
	socketPath: string;
	/** Every hello frame's raw payload, in order. */
	hellos: Uint8Array[];
	requests: FakeRequest[];
	/** Answer request `id` later (for requests the handler left unanswered). */
	answer(id: number, answer: FakeAnswer): void;
	close(): Promise<void>;
}

/** `u32` LE length + payload. */
export function frame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + payload.length);
	new DataView(out.buffer).setUint32(0, payload.length, true);
	out.set(payload, 4);
	return out;
}

/** `message` as a frame payload. */
export function jsonPayload(message: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(message));
}

/**
 * Start a fake daemon. `hangUp` makes it a Tern from before the JSON protocol:
 * it reads the hello and closes the connection without a word.
 */
export async function startFakeDaemon(
	handler: (op: Record<string, unknown>, id: number) => FakeAnswer | Promise<FakeAnswer>,
	opts: { hangUp?: boolean } = {},
): Promise<FakeDaemon> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-fake-"));
	const socketPath = path.join(dir, "daemon.sock");
	const hellos: Uint8Array[] = [];
	const requests: FakeRequest[] = [];
	const sockets = new Set<net.Socket>();
	const owners = new Map<number, net.Socket>();
	const send = (socket: net.Socket, payload: Uint8Array): void => {
		if (!socket.destroyed) socket.write(frame(payload));
	};
	const answer = (id: number, value: FakeAnswer): void => {
		const socket = owners.get(id);
		if (!socket || value === null) return;
		send(socket, jsonPayload({ id, browser: value }));
	};
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = new Uint8Array(0);
		socket.on("data", async data => {
			const chunk = typeof data === "string" ? Buffer.from(data) : data;
			const joined = new Uint8Array(buffer.length + chunk.length);
			joined.set(buffer);
			joined.set(chunk, buffer.length);
			let offset = 0;
			const payloads: Uint8Array[] = [];
			while (joined.length - offset >= 4) {
				const length = new DataView(joined.buffer, offset, 4).getUint32(0, true);
				if (joined.length - offset - 4 < length) break;
				payloads.push(joined.slice(offset + 4, offset + 4 + length));
				offset += 4 + length;
			}
			buffer = joined.slice(offset);
			for (const payload of payloads) {
				if (opts.hangUp) {
					socket.end();
					return;
				}
				const message = JSON.parse(new TextDecoder().decode(payload)) as {
					hello?: unknown;
					id?: number;
					browser?: Record<string, unknown>;
				};
				if (message.hello !== undefined) {
					hellos.push(payload);
					// A welcome with members omp does not know, then a message kind it does not know, to prove both are skipped.
					send(socket, jsonPayload({ welcome: { version: 99 } }));
					send(socket, jsonPayload({ id: 0, output: { pane: 7 } }));
				} else if (message.browser !== undefined && message.id !== undefined) {
					const { id, browser: op } = message;
					requests.push({ id, op });
					owners.set(id, socket);
					answer(id, await handler(op, id));
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => listening.resolve());
	await listening.promise;
	return {
		socketPath,
		hellos,
		requests,
		answer,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}
