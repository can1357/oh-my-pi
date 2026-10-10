/**
 * Contract: a live tool card keeps the model's intent (`i`) after execution
 * starts. agent-loop strips `i` from the args it hands to `tool_execution_start`
 * and ships it as `event.intent`; the card must still carry it so the native
 * head (bash target) and the tool node's `intent` match a resumed session,
 * whose cards rebuild from the stored assistant message that still has `i`.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	resetSettingsForTest();
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function fixture(streamingMessage: AssistantMessage) {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = createInteractiveModeContext({
		streamingComponent: new AssistantMessageComponent(),
		streamingMessage,
		pendingTools,
		session: { getToolByName: () => undefined, extensionRunner: undefined },
	});
	return { controller: new EventController(ctx), pendingTools };
}

/** The `tool` node's head props the native surface receives. */
function toolProps(card: ToolExecutionComponent | undefined): Record<string, unknown> {
	const root = card?.describe(cx);
	expect(root?.k).toBe("tool");
	return (root?.p ?? {}) as Record<string, unknown>;
}

async function startExecution(controller: EventController) {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId: "tc-1",
		toolName: "bash",
		args: { command: "ls" },
		intent: "Listing files",
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
}

describe("live tool card intent", () => {
	it("keeps the streamed intent once execution starts with stripped args", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const message = assistant([
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: { i: "Listing files", command: "ls" } },
		]);
		const { controller, pendingTools } = fixture(message);
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await startExecution(controller);

		expect(toolProps(pendingTools.get("tc-1"))).toMatchObject({
			title: "Bash",
			target: "Listing files",
			command: "ls",
			intent: "Listing files",
		});
	});

	it("carries the intent on a card first mounted by tool_execution_start", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const { controller, pendingTools } = fixture(assistant([]));
		await startExecution(controller);

		expect(toolProps(pendingTools.get("tc-1"))).toMatchObject({ target: "Listing files", intent: "Listing files" });
	});
});
