// A live tool card renders the model's intent, as a card rebuilt from the transcript does.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui/tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/** The native node a TSP terminal draws for the card. */
function toolNode(component: ToolExecutionComponent): NativeNode {
	const cx: DescribeContext = {
		cols: 100,
		reduceMotion: false,
		dark: true,
		supports: kind => kind === "tool" || kind === "media",
		feature: () => true,
	};
	const node = component.describe(cx);
	if (!node) throw new Error("card described nothing");
	return node;
}

function headTarget(component: ToolExecutionComponent): unknown {
	return (toolNode(component).p as Record<string, unknown>).target;
}

describe("EventController tool intent", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function fixture() {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming: true, hasBuiltInTool: () => true, getToolByName: () => undefined },
		});
		return { controller: new EventController(ctx), pendingTools, ctx };
	}

	const start = (intent: string | undefined) => ({
		type: "tool_execution_start" as const,
		toolCallId: "tc-bash",
		toolName: "bash",
		// The executed args: the harness strips `i` before running the tool.
		args: { command: "ls -la" },
		...(intent === undefined ? {} : { intent }),
	});

	it("shows the intent on a card created by tool_execution_start", async () => {
		const { controller, pendingTools } = fixture();
		await controller.handleEvent(start("Listing the working tree"));
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no card for the call");
		expect(headTarget(card)).toBe("Listing the working tree");
	});

	it("keeps the intent when tool_execution_start refreshes a streamed card", async () => {
		const { controller, pendingTools, ctx } = fixture();
		const streamed = new ToolExecutionComponent(
			"bash",
			{ command: "ls -la", i: "Listing the working tree" },
			{ useBuiltInRenderer: true },
			undefined,
			ctx.ui as unknown as TUI,
			"/tmp",
			"tc-bash",
		);
		pendingTools.set("tc-bash", streamed);
		await controller.handleEvent(start("Listing the working tree"));
		expect(headTarget(streamed)).toBe("Listing the working tree");
	});
});
