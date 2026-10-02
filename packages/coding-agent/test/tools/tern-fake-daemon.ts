/**
 * A fake Tern daemon for browser-backend tests: a Unix socket that speaks
 * Tern's wire frames, records the script's hello and answers `Browser`
 * requests through a handler.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** What a handler answers: `{ ok }`, `{ error }`, or `null` to never answer. */
export type FakeAnswer = { ok: unknown } | { error: { kind: string; message: string } } | null;

/** One browser request the fake daemon received. */
export interface FakeRequest {
	id: bigint;
	op: Record<string, unknown>;
}

/** Handle of a running fake daemon. */
export interface FakeDaemon {
	socketPath: string;
	hellos: Uint8Array[];
	requests: FakeRequest[];
	/** Send a raw reply payload to every connected client. */
	broadcast(payload: Uint8Array): void;
	/** Answer request `id` later (for requests the handler left unanswered). */
	answer(id: bigint, answer: FakeAnswer): void;
	close(): Promise<void>;
}

/** `u32` LE length + payload. */
export function frame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + payload.length);
	new DataView(out.buffer).setUint32(0, payload.length, true);
	out.set(payload, 4);
	return out;
}

/** A reply payload: tag + optional id + optional u32-length string. */
export function replyPayload(tag: number, fields: { id?: bigint; text?: string }): Uint8Array {
	const text = fields.text === undefined ? new Uint8Array(0) : new TextEncoder().encode(fields.text);
	const size = 1 + (fields.id === undefined ? 0 : 8) + (fields.text === undefined ? 0 : 4 + text.length);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	out[0] = tag;
	let offset = 1;
	if (fields.id !== undefined) {
		view.setBigUint64(offset, fields.id, true);
		offset += 8;
	}
	if (fields.text !== undefined) {
		view.setUint32(offset, text.length, true);
		out.set(text, offset + 4);
	}
	return out;
}

/** Start a fake daemon; `welcome: false` refuses every hello with `refusal`. */
export async function startFakeDaemon(
	handler: (op: Record<string, unknown>, id: bigint) => FakeAnswer | Promise<FakeAnswer>,
	opts: { refusal?: string } = {},
): Promise<FakeDaemon> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tern-fake-"));
	const socketPath = path.join(dir, "daemon.sock");
	const hellos: Uint8Array[] = [];
	const requests: FakeRequest[] = [];
	const sockets = new Set<net.Socket>();
	const owners = new Map<bigint, net.Socket>();
	const send = (socket: net.Socket, payload: Uint8Array): void => {
		if (!socket.destroyed) socket.write(frame(payload));
	};
	const answer = (id: bigint, value: FakeAnswer): void => {
		const socket = owners.get(id);
		if (!socket || value === null) return;
		send(socket, replyPayload(30, { id, text: JSON.stringify(value) }));
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
				if (payload[0] === 0) {
					hellos.push(payload);
					if (opts.refusal !== undefined) {
						send(socket, replyPayload(1, { text: opts.refusal }));
						socket.end();
					} else {
						// Welcome carries fields omp ignores; an unknown tag follows to prove it is skipped.
						send(socket, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]));
						send(socket, new Uint8Array([99, 1, 2, 3]));
					}
					continue;
				}
				if (payload[0] !== 40) continue;
				const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
				const id = view.getBigUint64(1, true);
				const length = view.getUint32(9, true);
				const op = JSON.parse(new TextDecoder().decode(payload.subarray(13, 13 + length))) as Record<
					string,
					unknown
				>;
				requests.push({ id, op });
				owners.set(id, socket);
				answer(id, await handler(op, id));
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
		broadcast: payload => {
			for (const socket of sockets) send(socket, payload);
		},
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
