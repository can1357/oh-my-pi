import { describe, expect, it } from "bun:test";
import { composeAdvisorSystemPromptText } from "../../src/advisor/task-contract-block";
import advisorSystemPrompt from "../../src/prompts/advisor/system.md" with { type: "text" };

describe("advisor task contract composition", () => {
	it("includes watchdog and active task contract blocks when provided", () => {
		const text = composeAdvisorSystemPromptText({
			basePrompt: advisorSystemPrompt,
			watchdogPrompt: "Especially pay attention to:\n<attention>\nReject bypass paths\n</attention>",
			activeTaskContract: {
				objective: "Fix the race in session writer",
				deliverables: ["Regression test", "Root-cause fix"],
				completionCriteria: [{ id: "c1", description: "Test passes on Windows" }],
				nonSolutions: ["Disable the failing test"],
				knownFailureModes: [{ id: "f1", description: "Empty input collection" }],
			},
		});

		expect(text).toContain("<active-task-contract>");
		expect(text).toContain("Fix the race in session writer");
		expect(text).toContain("<non-solutions>");
		expect(text).toContain("Disable the failing test");
		expect(text).toContain("task-contract-watchdog");
		expect(text).toContain("Reject bypass paths");
	});

	it("omits injected contract block when no snapshot is set", () => {
		const text = composeAdvisorSystemPromptText({ basePrompt: advisorSystemPrompt });
		expect(text).not.toMatch(/<active-task-contract>\s*\n\s*<objective>/);
	});
});
