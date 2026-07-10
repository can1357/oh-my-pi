import { describe, expect, it } from "bun:test";
import type { EvalCancellationCause } from "@pk-nerdsaver-ai/pi-coding-agent/eval/types";
import { formatEvalCancellationMessage } from "@pk-nerdsaver-ai/pi-coding-agent/tools/eval";
import { clampTimeout, TOOL_TIMEOUTS } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-timeouts";

describe("eval timeout observability", () => {
	it("uses the shared 30-second default when timeout is omitted", () => {
		expect(TOOL_TIMEOUTS.eval.default).toBe(30);
		expect(clampTimeout("eval")).toBe(TOOL_TIMEOUTS.eval.default);
	});

	it("honors an explicit 120-second timeout", () => {
		expect(clampTimeout("eval", 120)).toBe(120);
	});

	it("names the idle watchdog cause and effective duration", () => {
		const cause: EvalCancellationCause = "idle_watchdog_timeout";
		const message = formatEvalCancellationMessage(cause, 30);

		expect(message).toContain("idle watchdog timeout");
		expect(message).toContain("30 seconds");
	});

	it("distinguishes an abort from the idle watchdog", () => {
		const cause: EvalCancellationCause = "abort";
		const message = formatEvalCancellationMessage(cause, 120);

		expect(message).toContain("abort");
		expect(message).toContain("effective timeout: 120 seconds");
	});
});
