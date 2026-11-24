import { MAX_RPC_REASSEMBLED_BYTES } from "./rpc-frame";

const LF = 0x0a;

/**
 * Claims Bun's singleton stdin reader immediately and exposes a separately readable stream.
 * RPC startup uses this before extension discovery so in-process modules cannot steal protocol input.
 */
export function claimRpcInput(): ReadableStream<Uint8Array> {
	const reader = Bun.stdin.stream().getReader();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			reader.releaseLock();
		} catch {}
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel() {
			try {
				await reader.cancel();
			} finally {
				release();
			}
		},
	});
}

/**
 * Parses newline-delimited RPC input without letting one malformed line stop
 * subsequent protocol frames. A record over MAX_RPC_REASSEMBLED_BYTES is reported once it passes
 * the cap, and its bytes are skipped through its newline, so the buffer never holds more than the cap.
 * A record that is not UTF-8 is reported and dropped, never repaired.
 */
export async function readRpcInputFrames(
	input: ReadableStream<Uint8Array>,
	onFrame: (frame: unknown) => void,
	onParseError: (message: string) => void,
): Promise<void> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const parseRecord = (bytes: Uint8Array): void => {
		let text: string;
		try {
			text = decoder.decode(bytes).trim();
		} catch {
			onParseError("Failed to parse command: line is not valid UTF-8");
			return;
		}
		if (!text) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			onParseError(`Failed to parse command: ${message}`);
			return;
		}
		onFrame(parsed);
	};

	// The chunks of the record being read. readLines would buffer an unterminated line without bound.
	let record: Uint8Array[] = [];
	let recordBytes = 0;
	let overflowed = false;
	for await (const chunk of input) {
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf(LF, start);
			const end = newline === -1 ? chunk.length : newline;
			if (!overflowed) {
				recordBytes += end - start;
				if (recordBytes > MAX_RPC_REASSEMBLED_BYTES) {
					overflowed = true;
					record = [];
					onParseError(`Failed to parse command: line is over the ${MAX_RPC_REASSEMBLED_BYTES}-byte cap`);
				} else if (end > start) {
					record.push(chunk.subarray(start, end));
				}
			}
			if (newline === -1) break;
			if (!overflowed) parseRecord(Buffer.concat(record));
			record = [];
			recordBytes = 0;
			overflowed = false;
			start = newline + 1;
		}
	}
	if (!overflowed) parseRecord(Buffer.concat(record));
}
