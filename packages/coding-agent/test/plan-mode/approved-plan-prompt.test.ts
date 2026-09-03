import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeApprovedPrompt from "../../src/prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../../src/prompts/system/plan-mode-compact-instructions.md" with { type: "text" };
import planModeReferencePrompt from "../../src/prompts/system/plan-mode-reference.md" with { type: "text" };

const PLAN_FILE_PATH = "local://durable-plan.md";
const PLAN_SENTINEL = "SENTINEL_HEADROOM_COMPRESSED_PLAN_CONTENT";

describe("approved plan execution prompts", () => {
	it("requires reading the durable plan file without inlining plan content", () => {
		const approved = prompt.render(planModeApprovedPrompt, {
			planContent: PLAN_SENTINEL,
			planFilePath: PLAN_FILE_PATH,
			contextPreserved: false,
		});
		const reference = prompt.render(planModeReferencePrompt, {
			planContent: PLAN_SENTINEL,
			planFilePath: PLAN_FILE_PATH,
		});
		const compact = prompt.render(planModeCompactInstructionsPrompt, {
			planFilePath: PLAN_FILE_PATH,
		});

		for (const rendered of [approved, reference, compact]) {
			expect(rendered).toContain(PLAN_FILE_PATH);
		}
		for (const rendered of [approved, reference, compact]) {
			expect(rendered).not.toContain(PLAN_SENTINEL);
		}
		expect(approved).toContain("MUST read `local://durable-plan.md`");
		expect(reference).toContain("MUST read `local://durable-plan.md`");
	});
});
