import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { XdevMountedRenderer, XdevMountedState } from "@oh-my-pi/pi-tui/tools/xdev";

/**
 * A `write xd://<tool>` card renders with the dispatched tool's own renderer,
 * while streaming (call branch) and once the result lands, for mounted devices
 * and active top-level tools alike. The TUI forwards the host's canonical
 * resolver (`XdevMountedState.resolve`, wired to `resolveXdevTool`) and must
 * not gate it on `mountedNames` itself: that second predicate is what left a
 * dispatched top-level tool on the generic args/output card.
 */

const ui = () => ({
	requestRender: vi.fn(),
	requestComponentRender: vi.fn(),
	resetDisplay: vi.fn(),
});

const probeTool: XdevMountedRenderer = {
	label: "Probe",
	mergeCallAndResult: true,
	renderCall: () => new Text("PROBE-CALL", 0, 0),
	renderResult: () => new Text("PROBE-RESULT", 0, 0),
};

function writeToolWithXdev(xdev: XdevMountedState): AgentTool {
	return { name: "write", label: "Write", session: { xdev } } as unknown as AgentTool;
}

/** `mountedNames` stays empty on purpose: the host resolver is the only authority. */
function xdevState(resolve: XdevMountedState["resolve"]): XdevMountedState {
	return {
		mountedNames: new Set<string>(),
		tools: new Map<string, XdevMountedRenderer>([["probe", probeTool]]),
		resolve,
	};
}

const dispatchResult = {
	content: [{ type: "text" as const, text: "42" }],
	details: {
		xdev: {
			tool: "probe",
			mode: "execute" as const,
			args: { command: "Write-Output 42" },
			inner: { output: "42" },
		},
	},
};

function deviceWrite(resolve: XdevMountedState["resolve"]): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"write",
		{ path: "xd://probe", content: JSON.stringify({ command: "Write-Output 42" }) },
		{ useBuiltInRenderer: true },
		writeToolWithXdev(xdevState(resolve)),
		ui(),
	);
	component.setExecutionStarted();
	return component;
}

describe("write xd:// device card renderer resolution", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the dispatched tool's card while streaming and after the result", () => {
		const component = deviceWrite(() => probeTool);
		expect(component.render(80).join("\n")).toContain("PROBE-CALL");

		component.updateResult(dispatchResult, false);
		expect(component.render(80).join("\n")).toContain("PROBE-RESULT");
	});

	it("falls back to the generic card when the host resolver returns nothing", () => {
		const component = deviceWrite(() => undefined);
		expect(component.render(80).join("\n")).not.toContain("PROBE-CALL");

		component.updateResult(dispatchResult, false);
		const rendered = component.render(80).join("\n");
		expect(rendered).not.toContain("PROBE-RESULT");
		expect(rendered).toContain("42");
	});
});
