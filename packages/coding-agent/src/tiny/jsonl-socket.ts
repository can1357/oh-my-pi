import * as net from "node:net";

/**
 * Newline-delimited JSON framing over `node:net` sockets, shared by the tiny
 * worker daemon (both halves) and the MLX daemon client.
 */

/** Feed socket chunks and invoke `onLine` per complete, non-blank line. */
export class LineParser {
	#buffer = "";
	constructor(readonly onLine: (line: string) => void) {}

	push(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim()) this.onLine(line);
		}
	}
}

/** Write one JSON line; silently dropped once the socket is gone (the close handler reports that). */
export function writeJsonLine(socket: net.Socket, message: unknown): void {
	if (socket.destroyed) return;
	socket.write(`${JSON.stringify(message)}\n`);
}

/** Dial a Unix socket or named pipe with a bounded connect; the socket is switched to UTF-8 strings. */
export function connectJsonlSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`timed out connecting to ${endpoint}`));
	}, timeoutMs);
	socket.once("connect", () => {
		clearTimeout(timer);
		socket.setEncoding("utf-8");
		resolve(socket);
	});
	socket.once("error", error => {
		clearTimeout(timer);
		reject(error);
	});
	return promise;
}
