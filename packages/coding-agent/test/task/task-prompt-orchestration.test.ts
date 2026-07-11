import { describe, expect, it } from "bun:test";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import taskDescriptionTemplate from "../../src/prompts/tools/task.md" with { type: "text" };

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

describe("task tool description: orchestration prompts", () => {
	it("prefers useful independence over raw fan-out", () => {
		const out = render(true);
		expect(out).toMatch(/useful independence/i);
		expect(out).not.toMatch(/Maximize fan-out/i);
	});

	it("documents strategyFamily and contextPolicy", () => {
		const out = render(true);
		expect(out).toContain("`strategyFamily?`");
		expect(out).toContain("`contextPolicy?`");
	});

	it("documents assignment NonSolutions and FailureModes", () => {
		const out = render(false);
		expect(out).toContain("NonSolutions");
		expect(out).toContain("FailureModes");
	});

	it("documents work-class verification rules", () => {
		const out = render(true);
		expect(out).toMatch(/falsification workers/i);
		expect(out).toMatch(/Acceptance auditors/i);
	});
});
