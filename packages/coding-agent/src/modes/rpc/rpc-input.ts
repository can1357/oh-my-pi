import { readLines } from "@oh-my-pi/pi-utils";

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
 * subsequent protocol frames.
 */
export async function readRpcInputFrames(
	input: ReadableStream<Uint8Array>,
	onFrame: (frame: unknown) => void,
	onParseError: (message: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const line of readLines(input)) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			onParseError(`Failed to parse command: ${message}`);
			continue;
		}
		onFrame(parsed);
	}
}
