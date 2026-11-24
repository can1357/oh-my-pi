import { describe, expect, test } from "bun:test";
import { readRpcInputFrames } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import { MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";

/**
 * Regression test for issue #5194: a non-JSON stdin line crashed the whole RPC
 * process with an uncaught parse error escaping the frame loop. A malformed
 * line must instead be reported and the reader must keep yielding later frames.
 */
describe("RPC mode malformed stdin", () => {
	test("reports a bad line and keeps reading subsequent commands", async () => {
		const input = new Blob([
			"this is not json\n",
			`${JSON.stringify({ type: "get_state", id: "probe" })}\n`,
			`${JSON.stringify({ type: "get_messages_page", id: "page-probe", limit: 1 })}\n`,
		]).stream();
		const frames: unknown[] = [];
		const parseErrors: string[] = [];

		await readRpcInputFrames(
			input,
			frame => frames.push(frame),
			message => parseErrors.push(message),
		);

		expect(parseErrors).toHaveLength(1);
		expect(parseErrors[0]).toContain("Failed to parse command");
		expect(frames).toEqual([
			{ type: "get_state", id: "probe" },
			{ type: "get_messages_page", id: "page-probe", limit: 1 },
		]);
	});

	test("reports an oversized line once it passes the cap instead of buffering the rest of the stream", async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(0x78);
		const chunkCount = 100;
		let pulled = 0;
		const input = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled === chunkCount) {
					controller.close();
					return;
				}
				pulled++;
				controller.enqueue(chunk);
			},
		});
		let pulledAtReport: number | undefined;
		const parseErrors: string[] = [];

		await readRpcInputFrames(
			input,
			() => {},
			message => {
				pulledAtReport ??= pulled;
				parseErrors.push(message);
			},
		);

		expect(parseErrors).toHaveLength(1);
		// The line is reported once it passes the cap, not after the 100 MiB stream ends.
		expect(pulledAtReport).toBeLessThanOrEqual(MAX_RPC_REASSEMBLED_BYTES / chunk.length + 2);
		expect(parseErrors[0]).toContain(`line is over the ${MAX_RPC_REASSEMBLED_BYTES}-byte cap`);
	});

	test("refuses a record that is not UTF-8 instead of dispatching a repaired copy", async () => {
		const input = new Blob([
			new TextEncoder().encode(`{"type":"prompt","id":"bad","message":"caf`),
			Uint8Array.of(0xff),
			new TextEncoder().encode(`"}\n`),
			new TextEncoder().encode(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`),
		]).stream();
		const frames: unknown[] = [];
		const parseErrors: string[] = [];

		await readRpcInputFrames(
			input,
			frame => frames.push(frame),
			message => parseErrors.push(message),
		);

		expect(parseErrors).toHaveLength(1);
		expect(parseErrors[0]).toContain("Failed to parse command: line is not valid UTF-8");
		expect(frames).toEqual([{ type: "get_state", id: "probe" }]);
	});

	test("accepts a prompt larger than one outbound frame, since the client writes each command unchunked", async () => {
		const prompt = { type: "prompt", id: "large", message: "x".repeat(2 * 1024 * 1024) };
		const frames: unknown[] = [];
		const parseErrors: string[] = [];

		await readRpcInputFrames(
			new Blob([`${JSON.stringify(prompt)}\n`]).stream(),
			frame => frames.push(frame),
			message => parseErrors.push(message),
		);

		expect(parseErrors).toEqual([]);
		expect(frames).toEqual([prompt]);
	});
});
