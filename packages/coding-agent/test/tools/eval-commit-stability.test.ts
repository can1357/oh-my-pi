import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/eval";
import { isSettled } from "@oh-my-pi/pi-tui/surface";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** An eval call presented in the transcript the way the event controller presents it. */
function makeEvalComponent(): PendingTool {
	const ctx = createInteractiveModeContext();
	return ctx.presentToolCall({
		id: "eval-1",
		name: "eval",
		args: { code: "parallel([...])", language: "python" },
		tool: undefined,
		cwd: process.cwd(),
	});
}

/** Build an eval result whose `details.cells` carry agent-fan-out progress. */
function evalAgentResult(events: EvalStatusEvent[], text = "") {
	const details: EvalToolDetails = {
		language: "python",
		languages: ["python"],
		cells: [
			{
				index: 0,
				title: "Investigate",
				code: "results = parallel([...])",
				language: "python",
				output: text,
				status: "running",
				statusEvents: events,
			},
		],
	};
	return { content: [{ type: "text" as const, text }], details };
}

function expectLive(component: PendingTool): void {
	expect(isSettled(component.block.node)).toBe(false);
}

function expectFinal(component: PendingTool): void {
	expect(isSettled(component.block.node)).toBe(true);
}

describe("eval tool transcript finalization", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	it("moves the block out of the live region as soon as the eval result settles", () => {
		const component = makeEvalComponent();
		component.updateResult(evalAgentResult([{ op: "agent", id: "a1", status: "running" }]), true, "eval-1");
		expectLive(component);

		component.updateResult({ content: [{ type: "text" as const, text: "done\n" }] }, false, "eval-1");

		expectFinal(component);
	});

	it("stays in the live region across agent-progress shape churn while partial", () => {
		const component = makeEvalComponent();

		component.updateResult(
			evalAgentResult([{ op: "agent", id: "a1", status: "running", currentTool: "read" }]),
			true,
			"eval-1",
		);
		expectLive(component);

		component.updateResult(
			evalAgentResult([
				{ op: "agent", id: "a1", status: "running" },
				{ op: "agent", id: "a2", status: "running", currentTool: "bash" },
			]),
			true,
			"eval-1",
		);

		expectLive(component);
	});
});
