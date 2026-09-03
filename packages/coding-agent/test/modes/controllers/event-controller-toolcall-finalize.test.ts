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
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
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

// Components the controller mounts during a dispatch (pending tool previews).
// Sealed in afterEach so their spinner intervals never outlive the test file.
const mountedComponents: { seal?(): void }[] = [];

function createFixture(streamingMessage: AssistantMessage) {
	const markTranscriptBlockFinalized = vi.fn();
	const streamingComponent = {
		updateContent: vi.fn(),
		markTranscriptBlockFinalized,
	};
	const chatChildren: unknown[] = [];
	const chatContainer = {
		children: chatChildren,
		addChild: vi.fn((child: { seal?(): void }) => {
			chatChildren.push(child);
			mountedComponents.push(child);
		}),
		removeChild: vi.fn((child: unknown) => {
			const index = chatChildren.indexOf(child);
			if (index >= 0) chatChildren.splice(index, 1);
		}),
		canRemoveBlock: vi.fn(() => true),
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent,
		streamingMessage,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer,
		toolOutputExpanded: false,
		settings,
		session: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		clearTransientSessionUi: () => {},
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, markTranscriptBlockFinalized, ctx };
}

async function dispatchUpdate(message: AssistantMessage) {
	const { controller, markTranscriptBlockFinalized } = createFixture(message);
	// #handleMessageUpdate only reads `event.message`; the raw provider stream
	// event is irrelevant to the finalization contract under test.
	const event = {
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>;
	await controller.handleEvent(event);
	return markTranscriptBlockFinalized;
}

describe("EventController finalizes assistant block when tool-call args stream", () => {
	afterEach(() => {
		for (const component of mountedComponents.splice(0)) component.seal?.();
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
		expect(finalized).toHaveBeenCalled();
	});

	it("keeps the assistant live while only text/thinking is streaming", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const message = makeStreamingMessage([{ type: "thinking", thinking: "still thinking" }]);
		const finalized = await dispatchUpdate(message);
		expect(finalized).not.toHaveBeenCalled();
	});

	it("marks the streaming assistant finalized even when the per-turn usage row is enabled", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
		const message = makeStreamingMessage([
			{ type: "thinking", thinking: "planning" },
			{ type: "toolCall", id: "tc-2", name: "write", arguments: { file_path: "/tmp/b.ts", content: "y" } },
		]);
		const finalized = await dispatchUpdate(message);
		expect(finalized).toHaveBeenCalled();
	});

	it("emits the per-turn usage row with the turn's local timestamp at message_end", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
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
		const { controller } = createFixture(message);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		const row = mountedComponents.at(-1) as unknown as { render(width: number): string[] } | undefined;
		expect(row).toBeDefined();
		expect(row?.render(120).join("\n")).toContain("2026-01-02 03:04:05");
	});
});
describe("EventController finalizes orphaned post-tool assistant segments", () => {
	afterEach(() => {
		for (const component of mountedComponents.splice(0)) component.seal?.();
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
		const segment = ctx.chatContainer.children.find(child => child instanceof AssistantMessageComponent);
		expect(segment).toBeInstanceOf(AssistantMessageComponent);
		expect((segment as AssistantMessageComponent).isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "message_start",
			message: makeStreamingMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		expect((segment as AssistantMessageComponent).isTranscriptBlockFinalized()).toBe(true);
		controller.dispose();
	});
});
