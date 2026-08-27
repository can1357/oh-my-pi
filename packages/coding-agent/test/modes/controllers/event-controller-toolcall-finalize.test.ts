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
		setHasToolTimeline: vi.fn(),
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
		chatContainer: { addChild: vi.fn((child: { seal?(): void }) => mountedComponents.push(child)) },
		toolOutputExpanded: false,
		settings,
		session: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		viewSession: { getToolByName: () => undefined, hasBuiltInTool: () => true },
		clearTransientSessionUi: () => {},
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, markTranscriptBlockFinalized };
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
