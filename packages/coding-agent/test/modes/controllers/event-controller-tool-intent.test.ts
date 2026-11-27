// A live tool card renders the model's intent, as a card rebuilt from the transcript does.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initTheme } from "../../../src/ui/theme/service";
import { createAssistantMessage } from "../../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/** The primary fact the card's head shows (bash: the intent, else the command). */
function headTarget(tool: PendingTool): unknown {
	return tool.call?.view()?.head?.target;
}

describe("EventController tool intent", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function fixture() {
		const pendingTools = new Map<string, PendingTool>();
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
		const { controller, pendingTools, ctx } = fixture();
		await controller.handleEvent(start("Listing the working tree...: Which files have changed?"));
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no card for the call");
		expect(headTarget(card)).toContain("Listing the working tree...");
		expect(ctx.setWorkingMessage).toHaveBeenLastCalledWith("Listing the working tree");
	});

	it("keeps the intent when tool_execution_start refreshes a streamed card", async () => {
		const { controller, pendingTools, ctx } = fixture();
		const args = { command: "ls -la", i: "Listing the working tree: Which files have changed?" };
		const message = createAssistantMessage("");
		message.content = [{ type: "toolCall", id: "tc-bash", name: "bash", arguments: args }];
		ctx.streaming = ctx.presentAssistant();
		await controller.syncAssistantMessage(message);
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no streamed card for the call");
		expect(headTarget(card)).toContain("Listing the working tree");
		expect(ctx.setWorkingMessage).toHaveBeenLastCalledWith("Listing the working tree");
		await controller.handleEvent(start(args.i));
		expect(headTarget(card)).toContain("Listing the working tree");
	});
});
