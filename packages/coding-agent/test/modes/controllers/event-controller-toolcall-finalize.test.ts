/**
 * Regression: while tool-call args stream, the assistant component above the
 * tool preview must be transcript-finalized as soon as a toolCall block
 * appears in the streaming message. Content blocks stream sequentially, so a
 * toolCall implies every preceding thinking/text block has closed — and an
 * unfinalized assistant block pins the transcript's commit-safe run, which
 * keeps a long streaming preview (a big write/edit/eval) from ever reaching
 * native scrollback: its head is neither committed nor on screen and the
 * transcript reads as cut off for the whole args stream.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { blockText } from "../../helpers/transcript-text";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(() => {
	initTheme();
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
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

// Contexts built by a test; their pending tool cards are sealed in afterEach.
const contexts: ReturnType<typeof createInteractiveModeContext>[] = [];

function createFixture(streamingMessage: AssistantMessage) {
	const ctx = createInteractiveModeContext({ streamingMessage });
	const streaming = ctx.presentAssistant();
	ctx.streaming = streaming;
	contexts.push(ctx);
	const controller = new EventController(ctx);
	return { controller, streaming, ctx };
}

async function dispatchUpdate(message: AssistantMessage) {
	const { controller, streaming } = createFixture(message);
	// #handleMessageUpdate only reads `event.message`; the raw provider stream
	// event is irrelevant to the finalization contract under test.
	const event = {
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>;
	await controller.handleEvent(event);
	return streaming.finalized.peek();
}

function sealMounted(): void {
	for (const ctx of contexts.splice(0)) for (const tool of ctx.pendingTools.values()) tool.seal();
}

describe("EventController finalizes assistant block when tool-call args stream", () => {
	afterEach(() => {
		sealMounted();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("marks the streaming assistant finalized once a toolCall block appears", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const message = makeStreamingMessage([
			{ type: "thinking", thinking: "planning the file" },
			{ type: "toolCall", id: "tc-1", name: "write", arguments: { file_path: "/tmp/a.ts", content: "x" } },
		]);
		const finalized = await dispatchUpdate(message);
		expect(finalized).toBe(true);
	});

	it("keeps the assistant live while only text/thinking is streaming", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const message = makeStreamingMessage([{ type: "thinking", thinking: "still thinking" }]);
		const finalized = await dispatchUpdate(message);
		expect(finalized).toBe(false);
	});

	it("marks the streaming assistant finalized even when the per-turn usage row is enabled", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
		const message = makeStreamingMessage([
			{ type: "thinking", thinking: "planning" },
			{ type: "toolCall", id: "tc-2", name: "write", arguments: { file_path: "/tmp/b.ts", content: "y" } },
		]);
		const finalized = await dispatchUpdate(message);
		expect(finalized).toBe(true);
	});

	it("emits the per-turn usage row with the turn's local timestamp at message_end", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		cfgDisplayShowTokenUsage.set(settings, true);
		// Fixed local wall-clock time; single-digit fields exercise zero-padding.
		const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();
		const message: AssistantMessage = {
			...makeStreamingMessage([{ type: "text", text: "done" }]),
			usage: {
				input: 1234,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1241,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		};
		const { controller, ctx } = createFixture(message);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		const row = ctx.shell.transcript.blocks().at(-1);
		expect(row).toBeDefined();
		expect(row).not.toBe(ctx.transcriptBlocks.get(message));
		// The row stamps the turn's local wall-clock time.
		expect(blockText(row!)).toContain("03:04");
	});
});
describe("EventController finalizes orphaned post-tool assistant segments", () => {
	afterEach(() => {
		sealMounted();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	// Regression: post-tool assistant segments are created unfinalized at
	// message_update and finalized only at message_end. A dropped message_end
	// (mid-stream throw, superseded attempt) used to leave the segment active
	// forever — one unfinalized block at the transcript frontier blocks history
	// retirement, so every later block degraded to its one-line live allocation.
	it("finalizes a segment whose message_end never fired at the next message_start", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const message = makeStreamingMessage([
			{ type: "toolCall", id: "tc-seg", name: "write", arguments: { file_path: "/tmp/c.ts", content: "z" } },
			{ type: "text", text: "post-tool commentary" },
		]);
		const { controller, ctx } = createFixture(message);
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const segment = ctx.shell.transcript
			.blocks()
			.map(block => ctx.transcriptEntry(block))
			.find(entry => entry?.kind === "assistant" && entry.view !== ctx.streaming);
		if (segment?.kind !== "assistant") throw new Error("no post-tool segment");
		expect(segment.view.finalized.peek()).toBe(false);

		await controller.handleEvent({
			type: "message_start",
			message: makeStreamingMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		expect(segment.view.finalized.peek()).toBe(true);
		controller.dispose();
	});
});
