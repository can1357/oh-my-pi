/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A collapsed todo card lights a pending task a running subagent's description matches (as the
 * dock's todo HUD does), follows the descriptions as they change, and shows plain statuses expanded.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createRoot, isUiNode } from "@oh-my-pi/pi-tui";
import type { TspChecklistPhase } from "@oh-my-pi/pi-wire";
import type { ToolViewState } from "../../../src/ui/tools/contract";
import { setActiveTodoDescriptions, todoPresenter } from "../../../src/ui/tools/todo";

const RESULT = {
	content: [{ type: "text" as const, text: "ok" }],
	details: {
		phases: [
			{
				name: "Ship",
				tasks: [
					{ content: "Write the parser", status: "completed" as const },
					{ content: "Port the renderer tests", status: "pending" as const },
				],
			},
		],
	},
};

function state(expanded: boolean): ToolViewState {
	return { expanded, isPartial: false, argsComplete: true, executionStarted: true };
}

/** The card's result view, mounted: its checklist's item statuses, and its disposal. */
function card(expanded: boolean): { statuses: () => string[]; dispose: () => void } {
	return createRoot(dispose => {
		const checklist = todoPresenter.result!(RESULT, state(expanded), undefined)!.body;
		if (!isUiNode(checklist)) throw new Error("expected the checklist node");
		const statuses = (): string[] =>
			(checklist.props() as { phases: TspChecklistPhase[] }).phases.flatMap(phase =>
				phase.items.map(item => item.status),
			);
		return { statuses, dispose };
	});
}

afterEach(() => setActiveTodoDescriptions([]));

describe("todo card and running subagents", () => {
	it("lights the pending task a running subagent works on while collapsed, following the descriptions", () => {
		const collapsed = card(false);
		expect(collapsed.statuses()).toEqual(["done", "pending"]);
		setActiveTodoDescriptions(["Port the renderer tests"]);
		expect(collapsed.statuses()).toEqual(["done", "active"]);
		setActiveTodoDescriptions([]);
		expect(collapsed.statuses()).toEqual(["done", "pending"]);
		collapsed.dispose();
	});

	it("shows the plain statuses while expanded", () => {
		setActiveTodoDescriptions(["Port the renderer tests"]);
		const expanded = card(true);
		expect(expanded.statuses()).toEqual(["done", "pending"]);
		expanded.dispose();
	});
});
