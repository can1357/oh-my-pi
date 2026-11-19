import type { AnyMessage } from "./transport";

/** Bidirectional JSON-RPC message transport. */
export interface Stream {
	writable: WritableStream<AnyMessage>;
	readable: ReadableStream<AnyMessage>;
}

/** Converts byte-oriented newline-delimited JSON streams to an ACP message transport. */
export function ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			const writer = output.getWriter();
			try {
				await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
			} finally {
				writer.releaseLock();
			}
		},
		async close() {
			const writer = output.getWriter();
			try {
				await writer.close();
			} finally {
				writer.releaseLock();
			}
		},
		async abort(reason) {
			const writer = output.getWriter();
			try {
				await writer.abort(reason);
			} finally {
				writer.releaseLock();
			}
		},
	});
	let buffered = "";
	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			const reader = input.getReader();
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					buffered += decoder.decode(next.value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline >= 0) {
						const line = buffered.slice(0, newline).trimEnd();
						buffered = buffered.slice(newline + 1);
						if (line.length > 0) controller.enqueue(parseMessage(line));
						newline = buffered.indexOf("\n");
					}
				}
				buffered += decoder.decode();
				const finalLine = buffered.trim();
				if (finalLine.length > 0) controller.enqueue(parseMessage(finalLine));
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

function parseMessage(line: string): AnyMessage {
	const value: unknown = JSON.parse(line);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("jsonrpc" in value) ||
		value.jsonrpc !== "2.0"
	) {
		throw new Error("Invalid JSON-RPC message");
	}
	return value as AnyMessage;
}
