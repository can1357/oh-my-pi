import { describe, expect, it } from "bun:test";
import { normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";

describe("normalizeResponsesToolCallId", () => {
	it("preserves opaque call ids while truncating oversized item ids", () => {
		const callId = `googleai-ts1:${"a".repeat(80)}.signature`;
		const itemId = `fcr_${"b".repeat(120)}`;

		const normalized = normalizeResponsesToolCallId(`${callId}|${itemId}`);

		expect(normalized.callId).toBe(callId);
		expect(normalized.itemId.startsWith("fcr_")).toBe(true);
		expect(normalized.itemId.length).toBeLessThanOrEqual(64);
	});

	it("keeps valid responses item ids unchanged", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|fcr_12345");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId).toBe("fcr_12345");
	});

	it("uses fc-prefixed item id for single-part tool call ids", () => {
		const normalized = normalizeResponsesToolCallId("call_gemini_123");

		expect(normalized.callId.startsWith("call_")).toBe(true);
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toStartWith("item_");
	});

	it("rehashes non-fc item ids to fc-prefixed ids", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|item_legacy");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toBe("item_legacy");
	});

	it("rehashes item ids without explicit prefixes to fc-prefixed ids by default", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|legacy");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("fc_")).toBe(true);
		expect(normalized.itemId).not.toBe("legacy");
	});

	it("preserves ctc-prefixed item ids for custom tool calls", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|ctc_12345", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId).toBe("ctc_12345");
	});

	it("rehashes non-ctc item ids to ctc-prefixed ids for custom tool calls", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|fc_legacy", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("ctc_")).toBe(true);
		expect(normalized.itemId).not.toBe("fc_legacy");
	});

	it("rehashes custom item ids without explicit ctc prefixes to ctc-prefixed ids", () => {
		const normalized = normalizeResponsesToolCallId("call_abc|legacy", "ctc");

		expect(normalized.callId).toBe("call_abc");
		expect(normalized.itemId.startsWith("ctc_")).toBe(true);
		expect(normalized.itemId).not.toBe("legacy");
	});
});
