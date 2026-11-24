/**
 * A transcript rebuild while a tool is still executing (subagent focus
 * attach/unfocus, overlay close) must not hide the in-flight call: the
 * assistant turn is persisted at message_end but its toolResult is not, so a
 * rebuild used to strip the dangling toolCall and the agent looked idle while
 * still waiting on the tool.
 *
 * Contracts under test:
 *  - renderSessionContext renders a dangling toolCall as a pending block and,
 *    while the viewed session streams, keeps it tracked in `pendingTools` so
 *    the live event stream lands the result in the SAME component.
 *  - Idle rebuilds seal leftover danglers instead of pinning the transcript
 *    live region with a spinner that can never resolve.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { isSettled } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Assistant turn persisted mid-execution: toolCall present, no toolResult. */
const danglingAssistant = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "sleep 60" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

function createFixture(opts: { isStreaming: boolean }) {
	const ctx = createInteractiveModeContext({
		session: { isStreaming: opts.isStreaming },
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	const controller = new EventController(ctx);
	ctx.eventController = controller;
	return { ctx, helpers, controller };
}

const imageMarks = (ctx: ReturnType<typeof createFixture>["ctx"]) =>
	renderTranscript(ctx)
		.join("\n")
		.match(/\[Image: image\/png\]/g);

describe("mid-turn transcript rebuild keeps in-flight tool calls", () => {
	const created: PendingTool[] = [];

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		for (const tool of created.splice(0)) tool.seal();
		vi.restoreAllMocks();
	});

	it("renders a dangling toolCall as pending, tracks it, and routes the live result into it", async () => {
		const { ctx, helpers, controller } = createFixture({ isStreaming: true });

		helpers.renderSessionContext({
			messages: [danglingAssistant],
		} as SessionContext);

		// Still awaiting its result: the block stays live and the map keeps
		// routing events into it after the rebuild.
		const component = ctx.pendingTools.get("call-1")!;
		expect(component).toBeDefined();
		created.push(component);
		expect(ctx.shell.transcript.blocks()).toContain(component.block);
		expect(isSettled(component.block.node)).toBe(false);

		// The tool finishes after the rebuild: the result must land in the same
		// rebuilt component instead of being dropped.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});

		expect(isSettled(component.block.node)).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
		expect(renderTranscript(ctx).join("\n")).toContain("done");
	});

	for (const arrival of ["buffered", "live", "persisted", "during-replay"] as const) {
		it(`keeps replayed read images visible after ${arrival} completion`, async () => {
			const { ctx, helpers, controller } = createFixture({ isStreaming: true });
			const showImages = cfgTerminalShowImages.get(ctx.settings);
			cfgTerminalShowImages.set(ctx.settings, true);
			try {
				const assistant: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "Inspecting the image." },
						{
							type: "toolCall",
							id: "image-read",
							name: "read",
							arguments: { path: "pixel.png" },
						},
						{ type: "text", text: "Continuing after the read." },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					usage,
					timestamp: 1,
				};
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "image-read",
					toolName: "read",
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
						},
					],
					isError: false,
					timestamp: 2,
				};
				ctx.viewSession.agent.getPendingToolResults = () => (arrival === "buffered" ? [result] : []);
				controller.resetTranscriptAnchors();
				if (arrival === "during-replay") {
					let completion: Promise<void> | undefined;
					const messages: AgentMessage[] = [assistant];
					for (let i = 0; i < 100; i++) {
						messages.push({
							role: "user",
							content: `Replay message ${i}`,
							timestamp: i + 3,
						});
					}
					await helpers.renderSessionContextIncrementally({ messages } as SessionContext, {}, () => {
						completion ??= controller.handleEvent({
							type: "tool_execution_end",
							toolCallId: result.toolCallId,
							toolName: result.toolName,
							result: { content: result.content },
							isError: false,
						});
					});
					await completion;
				} else {
					helpers.renderSessionContext({
						messages: arrival === "persisted" ? [assistant, result] : [assistant],
					} as SessionContext);
				}
				controller.restorePendingToolResults();
				if (arrival !== "live") {
					expect(imageMarks(ctx)).toHaveLength(1);
					expect(ctx.pendingTools.size).toBe(0);
				}
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					result: { content: result.content },
					isError: false,
				});
				expect(imageMarks(ctx)).toHaveLength(1);
				expect(ctx.pendingTools.size).toBe(0);
			} finally {
				cfgTerminalShowImages.set(ctx.settings, showImages);
			}
		});
	}

	it("seals dangling toolCalls on idle rebuilds instead of leaving a live spinner", async () => {
		const { ctx, helpers } = createFixture({ isStreaming: false });

		helpers.renderSessionContext({
			messages: [danglingAssistant],
		} as SessionContext);
		await Promise.resolve();

		// No result is coming: the block freezes as history and live tracking
		// stays empty so historical components never receive live events.
		expect(renderTranscript(ctx).join("\n")).toContain("sleep 60");
		expect(ctx.shell.transcript.blocks().every(block => isSettled(block.node))).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
	});
});
