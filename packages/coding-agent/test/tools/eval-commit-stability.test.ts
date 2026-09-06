import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

function makeEvalComponent() {
	return new ToolExecutionComponent("eval", { code: "parallel([...])", language: "python" }, {}, undefined, uiStub);
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

function expectLive(component: ToolExecutionComponent): void {
	expect(component.isTranscriptBlockFinalized()).toBe(false);
}

function expectFinal(component: ToolExecutionComponent): void {
	expect(component.isTranscriptBlockFinalized()).toBe(true);
}

describe("eval tool transcript finalization", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("keeps partial eval results in the native-scrollback live region", () => {
		const component = makeEvalComponent();

		component.updateResult(evalAgentResult([{ op: "agent", id: "a1", status: "running" }]), true);

		expectLive(component);
	});

	it("moves the block out of the live region as soon as the eval result settles", () => {
		const component = makeEvalComponent();
		component.updateResult(evalAgentResult([{ op: "agent", id: "a1", status: "running" }]), true);
		expectLive(component);

		component.updateResult({ content: [{ type: "text" as const, text: "done\n" }] }, false);

		expectFinal(component);
	});

	it("stays in the live region across agent-progress shape churn while partial", () => {
		const component = makeEvalComponent();

		component.updateResult(
			evalAgentResult([{ op: "agent", id: "a1", status: "running", currentTool: "read" }]),
			true,
		);
		expectLive(component);

		component.updateResult(
			evalAgentResult([
				{ op: "agent", id: "a1", status: "running" },
				{ op: "agent", id: "a2", status: "running", currentTool: "bash" },
			]),
			true,
		);

		expectLive(component);
	});
});
