import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { InteractiveModeContext, TranscriptEntry } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TranscriptBlock } from "../../../src/ui/shell";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { blockText } from "../../helpers/transcript-text";

beforeAll(() => {
	initTheme();
});

/** Transcript blocks with what they show. */
function entries(ctx: InteractiveModeContext): { block: TranscriptBlock; entry: TranscriptEntry | undefined }[] {
	return ctx.shell.transcript.blocks().map(block => ({ block, entry: ctx.transcriptEntry(block) }));
}

const isCard = (entry: TranscriptEntry | undefined) => entry?.kind === "tool" && entry.tool.call !== undefined;
const isReplyWrite = (entry: TranscriptEntry | undefined) => entry?.kind === "tool" && entry.tool.reply !== undefined;

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
	const ctx = createInteractiveModeContext({ streamingMessage: message([]) });
	ctx.streaming = ctx.presentAssistant();
	const controller = new EventController(ctx);
	const update = (streaming: AssistantMessage) => {
		ctx.streamingMessage = streaming;
		return controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
	};
	const rendered = (block: TranscriptBlock) => blockText(block, 100);
	return { ctx, controller, update, rendered };
}

describe("EventController reply writes", () => {
	it("draws a streamed `write out://` as assistant prose once its path tells, never as a card", async () => {
		const { ctx, controller, update, rendered } = await fixture();
		// `toolcall_start` (no argument text yet) still streams; neither it nor `ou` tells a reply from a card.
		await update(streamingWrite({}, ""));
		await update(streamingWrite({ path: "ou" }, '{"path":"ou'));
		expect(entries(ctx).filter(({ entry }) => entry?.kind === "tool")).toEqual([]);

		await update(
			streamingWrite(
				{ path: "out://status.md", content: "Short answer: **yes**" },
				'{"path":"out://status.md","content":"Short answer: **yes**',
			),
		);
		const reply = entries(ctx).find(({ entry }) => isReplyWrite(entry));
		expect(reply).toBeDefined();
		expect(rendered(reply!.block)).toContain("Short answer: yes");
		expect(entries(ctx).some(({ entry }) => isCard(entry))).toBe(false);
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
			entries(ctx)
				.filter(({ entry }) => entry?.kind === "assistant")
				.map(({ block }) => rendered(block))
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
		const shown = entries(ctx);
		const card = shown.findIndex(({ entry }) => isCard(entry));
		expect(card).toBeGreaterThanOrEqual(0);
		expect(card).toBeLessThan(shown.findIndex(({ block }) => rendered(block).includes("all done")));
		controller.dispose();
	});
});
