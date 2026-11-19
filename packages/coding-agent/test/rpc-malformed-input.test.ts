import { describe, expect, test } from "bun:test";
import { readRpcInputFrames } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";

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
});
