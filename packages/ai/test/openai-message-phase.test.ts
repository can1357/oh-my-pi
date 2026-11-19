import { describe, expect, it } from "bun:test";
import {
	encodeTextSignatureV1,
	parseAssistantMessagePhase,
	parseTextSignature,
} from "@oh-my-pi/pi-ai/providers/openai-shared";

describe("assistant message phase", () => {
	it("round-trips every Responses phase through the text signature", () => {
		for (const phase of ["commentary", "final_answer", "partial_answer"] as const) {
			expect(parseTextSignature(encodeTextSignatureV1("msg_1", phase))).toEqual({ id: "msg_1", phase });
		}
	});

	it("drops unknown phases instead of replaying them", () => {
		expect(parseAssistantMessagePhase("draft")).toBeUndefined();
		expect(parseAssistantMessagePhase(null)).toBeUndefined();
		expect(parseTextSignature(JSON.stringify({ v: 1, id: "msg_1", phase: "draft" }))).toEqual({ id: "msg_1" });
	});
});
