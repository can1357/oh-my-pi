import { describe, expect, it } from "bun:test";
import "../../../src/ui/styles/tools/goal";
import type { ToolViewState } from "../../../src/ui/tools/contract";
import { type GoalTerm, goalPresenter } from "../../../src/ui/tools/goal";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("goal", "goal", goalPresenter);

describe("goal objective update previews", () => {
	const objective = `Fix\t\x1b[31mparser\x1b[0m\x07\nedge cases`;
	const state: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: true };

	it("labels a pending update call with its objective on one line, without terminal controls", () => {
		const view = goalPresenter.call!({ op: "update", objective }, state)!;
		const label = typeof view.label === "string" ? view.label : (view.label ?? []).map(span => span.t).join("");
		const term = view.term as GoalTerm;
		expect(term.op).toBe("update");
		expect(term.objective).toMatch(/^Fix +parser edge cases$/);
		expect(label).toContain("update");
		expect(label).toMatch(/Fix +parser edge cases/);
		expect(label).not.toMatch(/[\x00-\x1f]/);
	});

	it("shows the updated goal's objective without terminal controls", () => {
		const view = goalPresenter.result!(
			{
				content: [{ type: "text", text: "Goal updated" }],
				details: { op: "update", goal: { objective, status: "active", tokensUsed: 10 } },
			},
			state,
		)!;
		const term = view.term as GoalTerm;
		expect(term.op).toBe("update");
		expect(term.objective).toMatch(/^Fix +parser edge cases$/);
	});
});
