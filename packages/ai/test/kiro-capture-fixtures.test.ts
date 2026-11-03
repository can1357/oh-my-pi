import { describe, expect, test } from "bun:test";
import { decodeEventStream } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { normalizeKiroFrame } from "@oh-my-pi/pi-ai/providers/kiro/index";
import { createSanitizedKiroStream, SANITIZED_KIRO_STREAM_FRAMES } from "./fixtures/kiro/stream-contracts";

describe("sanitized Kiro stream evidence", () => {
	test("replays observed frames through the production decoder and normalizer", async () => {
		const normalized = [];
		for await (const frame of decodeEventStream(createSanitizedKiroStream())) {
			normalized.push(normalizeKiroFrame(frame));
		}

		expect(normalized).toEqual([
			{ type: "metadata", requestId: "synthetic-request-id" },
			{ type: "metadata", stopReason: "STOP" },
			{ type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
			{ type: "content", content: "synthetic visible output" },
		]);
		expect(SANITIZED_KIRO_STREAM_FRAMES.map(frame => frame.eventType)).toEqual([
			"initial-response",
			"metadataEvent",
			"usageEvent",
			"assistantResponseEvent",
		]);
	});

	test("does not treat metadata or usage as visible output", async () => {
		const normalized = [];
		for await (const frame of decodeEventStream(createSanitizedKiroStream())) {
			const event = normalizeKiroFrame(frame);
			if (event.type === "metadata" || event.type === "usage") normalized.push(event.type);
		}

		expect(normalized).toEqual(["metadata", "metadata", "usage"]);
	});
});
