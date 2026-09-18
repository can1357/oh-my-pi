import { describe, expect, it } from "bun:test";
import {
	MULTIPLEXER_REVEAL_FRAME_MS,
	resolveRevealFrameMs,
	STREAMING_REVEAL_FRAME_MS,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/streaming-reveal";

describe("resolveRevealFrameMs", () => {
	it("drops to 10 fps inside a multiplexer", () => {
		expect(resolveRevealFrameMs(true, false)).toBe(MULTIPLEXER_REVEAL_FRAME_MS);
		expect(MULTIPLEXER_REVEAL_FRAME_MS).toBe(100);
	});

	it("keeps the 30 fps base cadence on a direct terminal", () => {
		expect(resolveRevealFrameMs(false, false)).toBe(STREAMING_REVEAL_FRAME_MS);
	});

	it("always uses the base cadence under the test runtime so fake-timer suites stay deterministic", () => {
		expect(resolveRevealFrameMs(true, true)).toBe(STREAMING_REVEAL_FRAME_MS);
	});
});
