import { describe, expect, it } from "bun:test";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import taskDescriptionTemplate from "../../src/prompts/tools/task.md" with { type: "text" };

// Contract: the task tool description the model sees advertises the `role`
// parameter (in both the batch and flat shapes) and steers toward tailored
// specialists. Without this the `role` field added in #2467 stays dormant.

function render(batchEnabled: boolean): string {
	return prompt.render(taskDescriptionTemplate, {
		agents: [{ name: "explore", description: "scout", readOnly: true }],
		spawningDisabled: false,
		MAX_CONCURRENCY: 32,
		isolationEnabled: true,
		batchEnabled,
		asyncEnabled: true,
		ircEnabled: true,
	});
}

describe("task tool description: role parameter", () => {
	it("documents `role` in the batch parameter list", () => {
		const out = render(true);
		expect(out).toContain("`role?`:");
		expect(out).toMatch(/specialist identity/i);
	});

	it("documents `role` in the flat (single-spawn) parameter list", () => {
		const out = render(false);
		expect(out).toContain("`role?`:");
	});

	it("makes tailored specialists the default, not the exception, in the rules", () => {
		const out = render(true);
		// Stable invariant — tailoring tied to `role` on one directive line —
		// rather than the exact copy-edited wording/capitalization.
		expect(out).toMatch(/tailor[^\n]*role/i);
	});
});
