import { describe, expect, it } from "bun:test";
import type { TaskToolDetails } from "../../src/task/task-details";
import type { ToolResult, ToolViewState } from "../../src/ui/tools/contract";
import { taskPresenter } from "../../src/ui/tools/task";

const state: ToolViewState = {
	expanded: false,
	isPartial: false,
	argsComplete: true,
	executionStarted: true,
};

function abortedResult(details: unknown): ToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text: "Tool was not executed because the run was aborted." }],
		details: details as TaskToolDetails,
		isError: true,
	};
}

describe("task presenter with a saved result that carries no results array", () => {
	// The task tool's abort and synthetic paths persist details without `results`
	// ({} / {"__synthetic":true,…}); the renderer must not throw while drawing
	// them, or a session holding one cannot be resumed.
	const cases: [string, unknown][] = [
		["an empty details object", {}],
		["a synthetic abort marker", { __synthetic: true, source: "assistant_stop_aborted", executed: false }],
		["a validation failure", { isError: true, error: "Tool call arguments are not valid JSON." }],
	];

	for (const [name, details] of cases) {
		it(`renders ${name}`, () => {
			expect(() => taskPresenter.result?.(abortedResult(details), state)).not.toThrow();
		});
	}
});
