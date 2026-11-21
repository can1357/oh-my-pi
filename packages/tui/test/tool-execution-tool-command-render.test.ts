import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { ToolCommandMountedRenderer, ToolCommandMountedState } from "@oh-my-pi/pi-tui/tools/tool-commands";

/**
 * A `bash` card whose result records a dispatched tool command draws each
 * invocation with the wrapped tool's own renderer, while streaming (a partial
 * result) and once the result lands. The TUI forwards the host's canonical
 * resolver (`ToolCommandMountedState.resolve`, wired to `resolveToolCommand`) and must
 * not gate it on `mountedNames` itself: that second predicate is what left a
 * dispatched top-level tool on the generic args/output card.
 */

const ui = () => ({
	requestRender: vi.fn(),
	requestComponentRender: vi.fn(),
	resetDisplay: vi.fn(),
});

const probeTool: ToolCommandMountedRenderer = {
	label: "Probe",
	mergeCallAndResult: false,
	renderCall: () => new Text("PROBE-CALL", 0, 0),
	renderResult: () => new Text("PROBE-RESULT", 0, 0),
};

/** The bash tool instance carries the session's tool command state the renderer resolves through. */
function bashToolWithToolCommands(toolCommands: ToolCommandMountedState): AgentTool {
	return { name: "bash", label: "Bash", session: { toolCommands } } as unknown as AgentTool;
}

/** `mountedNames` stays empty on purpose: the host resolver is the only authority. */
function toolCommandState(resolve: ToolCommandMountedState["resolve"]): ToolCommandMountedState {
	return {
		mountedNames: new Set<string>(),
		tools: new Map<string, ToolCommandMountedRenderer>([["probe", probeTool]]),
		resolve,
	};
}

const executeResult = {
	content: [{ type: "text", text: "42" }],
	details: {
		toolCommands: [
			{
				tool: "probe",
				mode: "execute",
				exitCode: 0,
				args: { command: "Write-Output 42" },
				inner: { output: "42" },
			},
		],
	},
};

function bashExecution(resolve: ToolCommandMountedState["resolve"]): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		{ command: "probe Write-Output 42" },
		{ useBuiltInRenderer: true },
		bashToolWithToolCommands(toolCommandState(resolve)),
		ui(),
	);
	component.setExecutionStarted();
	return component;
}

describe("bash tool command card renderer resolution", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the dispatched tool's card while streaming and after the result", () => {
		const component = bashExecution(() => probeTool);
		component.updateResult(executeResult, true);
		expect(component.render(80).join("\n")).toContain("PROBE-CALL");

		component.updateResult(executeResult, false);
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("PROBE-CALL");
		expect(rendered).toContain("PROBE-RESULT");
	});

	it("draws the same nested card when a transcript rebuild replays the result", () => {
		const component = bashExecution(() => probeTool);
		component.updateResult(executeResult, false);
		expect(component.render(80).join("\n")).toContain("PROBE-RESULT");
	});

	it("renders a one-line card for a --help invocation", () => {
		const component = bashExecution(() => probeTool);
		component.updateResult(
			{
				content: [],
				details: { toolCommands: [{ tool: "probe", mode: "help", exitCode: 0 }] },
			},
			false,
		);
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Probe");
		expect(rendered).toContain("--help");
		expect(rendered).not.toContain("PROBE-RESULT");
	});

	it("falls back to the generic card when the host resolver returns nothing", () => {
		const component = bashExecution(() => undefined);
		component.updateResult(
			{
				content: [{ type: "text", text: "42" }],
				details: {
					toolCommands: [
						{
							tool: "mystery",
							mode: "execute",
							exitCode: 0,
							args: { command: "Write-Output 42" },
							inner: { output: "42" },
						},
					],
				},
			},
			false,
		);
		const rendered = component.render(80).join("\n");
		expect(rendered).not.toContain("PROBE-CALL");
		expect(rendered).not.toContain("PROBE-RESULT");
		expect(rendered).toContain("mystery");
		expect(rendered).toContain("42");
	});
});
