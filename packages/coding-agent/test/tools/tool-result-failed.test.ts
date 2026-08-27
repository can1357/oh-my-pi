import { describe, expect, it } from "bun:test";
import type { ToolOutcome } from "@oh-my-pi/pi-agent-core/presentation";
import { toolResultFailed } from "@oh-my-pi/pi-coding-agent/tools/tool-result";

const SUCCEEDED: ToolOutcome = { kind: "succeeded" };
const FAILED: ToolOutcome = {
	kind: "failed",
	failure: { reason: "tool_reported", message: "TOOL_RESULT_FAILED_FIXTURE_C41A" },
};

describe("toolResultFailed", () => {
	it("prefers outcome over both legacy flags when present", () => {
		expect(toolResultFailed({ outcome: FAILED })).toBe(true);
		expect(toolResultFailed({ outcome: SUCCEEDED, isError: true })).toBe(false);
		expect(toolResultFailed({ outcome: SUCCEEDED, details: { isError: true } })).toBe(false);
	});

	it("falls back to the top-level isError flag when outcome is absent", () => {
		expect(toolResultFailed({ isError: true })).toBe(true);
		expect(toolResultFailed({ isError: false })).toBe(false);
		expect(toolResultFailed({})).toBe(false);
	});

	// The interim fallback this replay/unmigrated-producer path exists for
	// (a producer that marks failure only in
	// `details.isError`, or a replayed `ToolResultMessage` that never carried
	// `outcome` in the first place, must still be detected as failed.
	it("falls back to details.isError when neither outcome nor the top-level flag is set", () => {
		expect(toolResultFailed({ details: { isError: true } })).toBe(true);
		expect(toolResultFailed({ details: { isError: false } })).toBe(false);
		expect(toolResultFailed({ details: {} })).toBe(false);
		expect(toolResultFailed({ details: null })).toBe(false);
		expect(toolResultFailed({ details: "not an object" })).toBe(false);
	});
});
