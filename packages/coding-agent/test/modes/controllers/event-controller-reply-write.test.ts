import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReplyWriteComponent } from "@oh-my-pi/pi-tui/chat/reply-write";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function message(content: AssistantMessage["content"]): AssistantMessage {
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

/** A `write` call mid-stream: provider-parsed `args` plus the raw argument JSON received so far. */
function streamingWrite(args: Record<string, unknown>, partialJson: string): AssistantMessage {
	return message([
		{ type: "toolCall", id: "w1", name: "write", arguments: args, [kStreamingPartialJson]: partialJson },
	]);
}

async function fixture() {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const ctx = createInteractiveModeContext({
		streamingComponent: new AssistantMessageComponent(),
		streamingMessage: message([]),
	});
	const controller = new EventController(ctx);
	const update = (streaming: AssistantMessage) => {
		ctx.streamingMessage = streaming;
		return controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
	};
	const rendered = (component: Component) => Bun.stripANSI(component.render(100).join("\n"));
	return { ctx, controller, update, rendered };
}

describe("EventController reply writes", () => {
	it("draws a streamed `write out://` as assistant prose once its path tells, never as a card", async () => {
		const { ctx, controller, update, rendered } = await fixture();

		await update(streamingWrite({ path: "ou" }, '{"path":"ou'));
		expect(ctx.chatContainer.children.some(child => child instanceof ToolExecutionComponent)).toBe(false);
		expect(ctx.chatContainer.children.some(child => child instanceof ReplyWriteComponent)).toBe(false);

		await update(
			streamingWrite(
				{ path: "out://", content: "Short answer: **yes**" },
				'{"path":"out://","content":"Short answer: **yes**',
			),
		);
		const reply = ctx.chatContainer.children.find(child => child instanceof ReplyWriteComponent);
		expect(reply).toBeInstanceOf(ReplyWriteComponent);
		expect(rendered(reply!)).toContain("Short answer: yes");
		expect(ctx.chatContainer.children.some(child => child instanceof ToolExecutionComponent)).toBe(false);
		controller.dispose();
	});

	it("draws each reply a tool's frames carry once, after the call", async () => {
		const { ctx, controller, update, rendered } = await fixture();
		await update(message([{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "./report.sh" } }]));
		const frame = (replies: string[]) =>
			controller.handleEvent({
				type: "tool_execution_update",
				toolCallId: "b1",
				toolName: "bash",
				args: { command: "./report.sh" },
				partialResult: { content: [{ type: "text", text: "" }], details: { replies } },
			} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
		const replyTexts = () =>
			ctx.chatContainer.children
				.filter(child => child instanceof AssistantMessageComponent && !(child instanceof ReplyWriteComponent))
				.map(rendered)
				.filter(text => text.trim().length > 0);

		await frame(["step **one** done"]);
		await frame(["step **one** done"]);
		expect(replyTexts()).toEqual([expect.stringContaining("step one done")]);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: { replies: ["step **one** done", "all done"] } },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(replyTexts()).toEqual([expect.stringContaining("step one done"), expect.stringContaining("all done")]);
		const children = ctx.chatContainer.children;
		const card = children.findIndex(child => child instanceof ToolExecutionComponent);
		expect(card).toBeGreaterThanOrEqual(0);
		expect(card).toBeLessThan(children.findIndex(child => rendered(child).includes("all done")));
		controller.dispose();
	});
});
