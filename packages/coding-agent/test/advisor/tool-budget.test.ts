import { describe, expect, it } from "bun:test";
import {
	ADVISOR_DEFAULT_MAX_TOOL_CALLS_PER_REVIEW,
	consumeAdvisorToolCall,
	normalizeAdvisorToolCallBudget,
} from "../../src/advisor/tool-budget";

describe("Advisor verification tool budget", () => {
	it("defaults to one investigative call per review", () => {
		expect(ADVISOR_DEFAULT_MAX_TOOL_CALLS_PER_REVIEW).toBe(1);
		expect(normalizeAdvisorToolCallBudget(Number.NaN)).toBe(1);
	});

	it("allows control calls without spending the investigative budget", () => {
		expect(consumeAdvisorToolCall("advise", 1, 1)).toEqual({ allowed: true, nextUsed: 1 });
		expect(consumeAdvisorToolCall("check_in", 1, 1)).toEqual({ allowed: true, nextUsed: 1 });
	});

	it("allows one investigative call and blocks the next", () => {
		expect(consumeAdvisorToolCall("grep", 0, 1)).toEqual({ allowed: true, nextUsed: 1 });
		expect(consumeAdvisorToolCall("read", 1, 1)).toMatchObject({ allowed: false, nextUsed: 1 });
	});

	it("supports observe-only mode with a zero budget", () => {
		expect(normalizeAdvisorToolCallBudget(0)).toBe(0);
		expect(consumeAdvisorToolCall("read", 0, 0)).toMatchObject({ allowed: false, nextUsed: 0 });
	});
});
