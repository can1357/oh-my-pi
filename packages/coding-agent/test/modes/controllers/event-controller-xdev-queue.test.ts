/**
 * Exclusive `write xd://…` calls stay queued after `message_end` (which marks
 * every pending call args-complete) until that call's own `tool_execution_start`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	await initTheme();
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "xai-oauth",
		model: "grok-4.6",
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

function deviceWrite(id: string, name: string, inner: Record<string, unknown>) {
	return {
		type: "toolCall" as const,
		id,
		name: "write",
		arguments: {
			path: `xd://${name}`,
			content: JSON.stringify(inner),
		},
	};
}

function createFixture(streamingMessage: AssistantMessage) {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent: { updateContent: vi.fn(), markTranscriptBlockFinalized: vi.fn() },
		streamingMessage,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer: { addChild: vi.fn(), canRemoveBlock: () => true },
		toolOutputExpanded: false,
		lastAssistantUsage: undefined,
		showPinnedError: vi.fn(),
		session: {
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			isTtsrAbortPending: false,
			retryAttempt: 0,
		},
		viewSession: {
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			isTtsrAbortPending: false,
			retryAttempt: 0,
		},
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	ctx.eventController = controller;
	return { controller, pendingTools };
}

function cardText(pendingTools: Map<string, ToolExecutionComponent>, id: string): string {
	const component = pendingTools.get(id);
	if (!component) throw new Error(`expected pending tool ${id}`);
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("EventController queues exclusive device writes until execution starts", () => {
	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("keeps the second exclusive xd:// write queued after message_end until its own start", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.smoothStreaming", false);

		const searchArgs = { action: "grep_all", pattern: "Broken", scope: "game.StarterPlayer" };
		const scriptsArgs = { action: "get_source", instancePath: "game.Workspace.Thumper" };
		const streaming = makeStreamingMessage([
			deviceWrite("write-1", "mcp__ecoport_search", searchArgs),
			deviceWrite("write-2", "mcp__ecoport_scripts", scriptsArgs),
		]);
		const { controller, pendingTools } = createFixture(streaming);

		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(pendingTools.size).toBe(2);
		expect(cardText(pendingTools, "write-1")).toContain("queued");
		expect(cardText(pendingTools, "write-1")).toContain("ecoport/search");
		expect(cardText(pendingTools, "write-2")).toContain("queued");
		expect(cardText(pendingTools, "write-2")).toContain("ecoport/scripts");

		await controller.handleEvent({
			type: "message_end",
			message: streaming,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(cardText(pendingTools, "write-1")).toContain("queued");
		expect(cardText(pendingTools, "write-2")).toContain("queued");
		expect(controller.hasToolExecutionStarted("write-1")).toBe(false);
		expect(controller.hasToolExecutionStarted("write-2")).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: deviceWrite("write-1", "mcp__ecoport_search", searchArgs).arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(controller.hasToolExecutionStarted("write-1")).toBe(true);
		expect(controller.hasToolExecutionStarted("write-2")).toBe(false);
		expect(cardText(pendingTools, "write-1")).not.toContain("queued");
		expect(cardText(pendingTools, "write-2")).toContain("queued");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "write-2",
			toolName: "write",
			args: deviceWrite("write-2", "mcp__ecoport_scripts", scriptsArgs).arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(controller.hasToolExecutionStarted("write-2")).toBe(true);
		expect(cardText(pendingTools, "write-2")).not.toContain("queued");
	});
});
