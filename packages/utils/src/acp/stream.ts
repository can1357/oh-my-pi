import type { AnyMessage, JsonRpcId } from "./transport";

/** Bidirectional JSON-RPC message transport. */
export interface Stream {
	writable: WritableStream<AnyMessage>;
	readable: ReadableStream<AnyMessage>;
}

/** Converts byte-oriented newline-delimited JSON streams to an ACP message transport. */
export function ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let writeTail: Promise<void> = Promise.resolve();
	// Serializes every write to `output`, including protocol-error responses
	// emitted from the read loop, so concurrent writer locks never collide.
	const writeLine = (message: unknown): Promise<void> => {
		const write = writeTail.then(async () => {
			const writer = output.getWriter();
			try {
				await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
			} finally {
				writer.releaseLock();
			}
		});
		writeTail = write.catch(() => {});
		return write;
	};
	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			await writeLine(message);
		},
		async close() {
			const close = writeTail.then(async () => {
				const writer = output.getWriter();
				try {
					await writer.close();
				} finally {
					writer.releaseLock();
				}
			});
			writeTail = close.catch(() => {});
			return close;
		},
		async abort(reason) {
			const abort = writeTail.then(async () => {
				const writer = output.getWriter();
				try {
					await writer.abort(reason);
				} finally {
					writer.releaseLock();
				}
			});
			writeTail = abort.catch(() => {});
			return abort;
		},
	});
	let buffered = "";
	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			const reader = input.getReader();
			const enqueueLine = async (line: string) => {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					// Error replies are best-effort: a dead output must not error the read side.
					await writeLine({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }).catch(
						() => {},
					);
					return;
				}
				if (!isProtocolMessage(value)) {
					await writeLine({
						jsonrpc: "2.0",
						id: requestId(value),
						error: { code: -32600, message: "Invalid request" },
					}).catch(() => {});
					return;
				}
				controller.enqueue(value);
			};
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					buffered += decoder.decode(next.value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline >= 0) {
						const line = buffered.slice(0, newline).trimEnd();
						buffered = buffered.slice(newline + 1);
						if (line.length > 0) await enqueueLine(line);
						newline = buffered.indexOf("\n");
					}
				}
				buffered += decoder.decode();
				const finalLine = buffered.trim();
				if (finalLine.length > 0) await enqueueLine(finalLine);
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				reader.releaseLock();
			}
		},
	});
	return { writable, readable };
}

function isProtocolMessage(value: unknown): value is AnyMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("jsonrpc" in value) || value.jsonrpc !== "2.0") return false;
	const message = value as Record<string, unknown>;
	// A string method means a request or notification; anything else must be a
	// complete response envelope, so bare id frames can never be mistaken for
	// responses and resolve outstanding requests with `undefined`.
	// Keep only valid request ids; shape-invalid ids fall through to the
	// -32600 path instead of echoing unusable ids back to clients.
	if (typeof message.method === "string") {
		const id = message.id;
		return id === undefined || typeof id === "string" || typeof id === "number" || id === null;
	}
	return isResponseEnvelope(message);
}

function isResponseEnvelope(message: Record<string, unknown>): boolean {
	const id = message.id;
	if (typeof id !== "string" && typeof id !== "number" && id !== null) return false;
	const hasResult = "result" in message;
	const error = message.error;
	const hasError =
		error !== undefined &&
		error !== null &&
		typeof error === "object" &&
		!Array.isArray(error) &&
		typeof (error as Record<string, unknown>).code === "number" &&
		typeof (error as Record<string, unknown>).message === "string";
	return hasResult !== hasError;
}

function requestId(value: unknown): JsonRpcId {
	if (typeof value === "object" && value !== null) {
		const id = (value as Record<string, unknown>).id;
		if (typeof id === "string" || typeof id === "number" || id === null) return id;
	}
	return null;
}
