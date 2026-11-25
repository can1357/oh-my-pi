import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment, describeTree, firstDiff, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { stageTest } from "../deviations";
import "../../../src/ui/styles/tools/task";
import type { TaskToolDetails } from "../../../src/task/task-details";
import { noteAgentArrival, resetAgentIdentities } from "../../../src/ui/tools/agent-identity";
import { NestedTaskResults, taskPresenter } from "../../../src/ui/tools/task";
import { registerSubprocessToolView } from "../../../src/ui/tools/task/subprocess-views";
import { checkFlowCase, flowCaseFiles, loadFlowCase } from "../transcript/tool-flows";
import { loadScreenCase, plainToolRows, screenCaseFiles, type ToolScreen, toolScreenSuite } from "./screens";
import { ToolCall } from "../../../src/ui/transcript/tool-block";

/**
 * The fixtures register every agent id they draw, sorted, before any case
 * (subagent colours follow arrival order); `agentColorSlots` records it.
 */
const slots = screenCaseFiles("tools/task")
	.map(
		file =>
			(
				loadScreenCase("tools/task", file).inputs as {
					agentColorSlots?: string[];
				}
			).agentColorSlots,
	)
	.find(Boolean);
// Colour slots are session state: start from the capture's arrivals, not whatever earlier files left.
resetAgentIdentities();
slots?.forEach((id, index) => {
	noteAgentArrival(id, index);
});

/** The capture's child tool: inline `lint N` (dim), final `lint final N`. */
registerSubprocessToolView<{ n: number }>("lint_case", {
	inline: data => [{ s: "dim", t: `lint ${data.n}` }],
	final: all => all.map(data => `lint final ${data.n}`).join("\n"),
});

export const taskScreen: ToolScreen = {
	dir: "tools/task",
	name: "task",
	presenter: taskPresenter,
};

toolScreenSuite(taskScreen);

const NESTED = "tools/task-nested";
const nestedFiles = screenCaseFiles(NESTED);

describe.skipIf(nestedFiles.length === 0)(`${NESTED} corpus`, () => {
	for (const file of nestedFiles) {
		const corpusCase = loadScreenCase(NESTED, file);
		const inputs = corpusCase.inputs as {
			data: TaskToolDetails[];
			expanded: boolean;
		};
		test(file, () => {
			const env = corpusEnvironment(corpusCase.theme);
			createRoot(dispose => {
				const node = NestedTaskResults({
					snapshots: inputs.data,
					expanded: inputs.expanded,
				});
				if (!isUiNode(node)) throw new Error("task-nested: node expected");
				const failures: string[] = [];
				corpusCase.stages.forEach((stage, index) => {
					const native = firstDiff(stageNative(corpusCase, index), describeTree(node as UiNode, env));
					if (native) failures.push(`${stage.label} native: ${native}`);
					for (const width of corpusCase.widths) {
						const diff = firstCellDiff(
							stage.rows[String(width)] ?? [],
							paintNode(env, node as UiNode, width).rows,
						);
						if (diff) failures.push(`${stage.label} @${width}: ${diff}`);
					}
				});
				dispose();
				expect(failures).toEqual([]);
			});
		});
	}
});

/** transcript/tool/task: rows only; the native tree is a listed deviation (the capture described the generic card). */
const flowFiles = flowCaseFiles("task");
describe.skipIf(flowFiles.length === 0)("transcript/tool/task corpus", () => {
	for (const file of flowFiles) {
		const results = checkFlowCase(loadFlowCase("task", file));
		for (const result of results) stageTest("transcript/tool/task", file, result);
	}
});

/**
 * A TASK result saved by the abort and synthetic paths carries details without
 * a `results` array; resuming a session holding one crashed the transcript.
 * The card shows the cancellation text cleaned, with the home path shortened.
 */
test("a saved task result without results paints the cancellation text", () => {
	const home = homedir();
	const call = new ToolCall({ id: "call_task_saved", name: "task", args: { i: "saved task" } });
	call.setExecutionStarted();
	call.updateResult(
		{
			content: [
				{
					type: "text",
					text: `Tool was not executed: ${home}/.omp/settings.json is unreadable\t(raw)`,
				},
			],
			details: {},
			isError: true,
		},
		false,
	);
	const rendered = plainToolRows(call, corpusEnvironment("dark")).join("\n");
	expect(rendered).toContain("Tool was not executed");
	expect(rendered).toContain("~/.omp/settings.json");
	expect(rendered).not.toContain(home);
	expect(rendered).not.toContain("\t");
});
