import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import type { TUI } from "@oh-my-pi/pi-tui";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: zeroUsage(),
		stopReason: undefined,
		createdAt: new Date(0),
	} as unknown as AssistantMessage;
}

function messageUpdate(text: string): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		message: assistantMessage(text),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistantMessage(text) },
	} as unknown as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function createStreamingFixture() {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
	} as unknown as TUI;
	const viewSession = { isStreaming: true, getToolByName: () => undefined };
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui,
		settings,
		chatContainer: { addChild: vi.fn(), children: [] },
		pendingTools: new Map(),
		transcriptMessageComponents: new WeakMap(),
		streamingComponent: {
			setHideThinkingBlock: vi.fn(),
			markTranscriptBlockFinalized: vi.fn(),
			updateContent: vi.fn(),
		},
		noteDisplayableThinkingContent: vi.fn(() => false),
		ensureLoadingAnimation: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		setWorkingMessage: vi.fn(),
		viewSession,
		session: {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
		} as unknown as InteractiveModeContext["session"],
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	controller.subscribeToAgent();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) void listener(event);
	};
	return { controller, ctx, ui, emit };
}
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("EventController message_update coalescing", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("runs the streaming rebuild once per window instead of once per delta, applying the latest snapshot", async () => {
		const { ctx, ui, emit } = createStreamingFixture();

		emit(messageUpdate("tok1"));
		emit(messageUpdate("tok1 tok2"));
		emit(messageUpdate("tok1 tok2 tok3"));
		emit(messageUpdate("tok1 tok2 tok3 tok4"));
		emit(messageUpdate("tok1 tok2 tok3 tok4 tok5"));

		vi.advanceTimersByTime(32);
		expect(ui.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(ui.requestRender).toHaveBeenCalledTimes(1);
		expect((ctx.streamingMessage as AssistantMessage | undefined)?.content).toEqual([
			{ type: "text", text: "tok1 tok2 tok3 tok4 tok5" },
		]);

		emit(messageUpdate("tok1 tok2 tok3 tok4 tok5 tok6"));
		emit(messageUpdate("tok1 tok2 tok3 tok4 tok5 tok6 tok7"));
		vi.advanceTimersByTime(33);
		await flushMicrotasks();

		expect(ui.requestRender).toHaveBeenCalledTimes(2);
		expect((ctx.streamingMessage as AssistantMessage | undefined)?.content).toEqual([
			{ type: "text", text: "tok1 tok2 tok3 tok4 tok5 tok6 tok7" },
		]);
	});

	it("flushes the pending snapshot before a subsequent non-update event", async () => {
		const { ctx, emit } = createStreamingFixture();

		emit(messageUpdate("tok1"));
		emit(messageUpdate("tok1 tok2"));
		emit({ type: "message_end", message: assistantMessage("tok1 tok2") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect((ctx.streamingMessage as AssistantMessage | undefined)?.content).toEqual([
			{ type: "text", text: "tok1 tok2" },
		]);
	});

	it("speaks every delta exactly once even when intermediate snapshots are coalesced away", async () => {
		const { emit } = createStreamingFixture();
		const pushDelta = vi.spyOn(vocalizer, "pushDelta");
		settings.set("speech.enabled", true);
		settings.set("speech.mode", "assistant");

		emit(messageUpdate("one "));
		emit(messageUpdate("one two "));
		emit(messageUpdate("one two three "));

		vi.advanceTimersByTime(33);
		await flushMicrotasks();

		expect(pushDelta).toHaveBeenCalledTimes(3);
		expect(pushDelta).toHaveBeenNthCalledWith(1, "one ");
		expect(pushDelta).toHaveBeenNthCalledWith(2, "one two ");
		expect(pushDelta).toHaveBeenNthCalledWith(3, "one two three ");
	});

	it("serializes a tail event behind an in-flight window flush", async () => {
		// The coalesced flush fires from a 33ms timer, NOT from the listener
		// path, so AgentSession's fire-and-forget dispatch cannot serialize it:
		// a message_end landing mid-flush used to run its handler concurrently,
		// both calling init while the flush was suspended. The dispatch chain
		// must hold the tail event until the window flush completed.
		const { ctx, emit } = createStreamingFixture();
		ctx.isInitialized = false;
		const initGate = Promise.withResolvers<void>();
		let initCalls = 0;
		ctx.init = vi.fn(async () => {
			initCalls += 1;
			if (initCalls === 1) await initGate.promise;
		});

		emit(messageUpdate("tok1 tok2"));
		vi.advanceTimersByTime(33); // window fires; flush suspends on init (call 1)

		emit({ type: "message_end", message: assistantMessage("tok1 tok2") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		await flushMicrotasks();

		// The end handler must be queued behind the suspended flush, not
		// running alongside it (which would double-init).
		expect(initCalls).toBe(1);
		initGate.resolve();
		await flushMicrotasks();

		// Flush completed, then the end handler ran to completion.
		expect(initCalls).toBe(2);
	});

	it("does not run two events queued in the same window concurrently", async () => {
		// A burst that lands while a run is in flight must dispatch strictly
		// one after the other: each waiter is chained onto the current tail,
		// so two events sharing one suspended handler cannot both resume into
		// parallel dispatch after the gate opens (regression: the shared
		// `await this.#dispatchTail` let every queued callback start its own
		// run once the tail settled).
		const { ctx, emit } = createStreamingFixture();
		ctx.isInitialized = false;
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let initCalls = 0;
		ctx.init = vi.fn(async () => {
			initCalls += 1;
			if (initCalls <= 2) await gates[initCalls - 1]!.promise; // first two runs each suspend on their own gate
		});

		emit(messageUpdate("tok1"));
		vi.advanceTimersByTime(33); // window fires; flush run 1 suspends on gate 1

		// Two non-update events land while the flush is still suspended.
		emit({ type: "message_end", message: assistantMessage("tok1") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		emit({ type: "message_end", message: assistantMessage("tok1") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		await flushMicrotasks();

		// Neither queued handler has started yet — both are chained behind
		// the suspended flush.
		expect(initCalls).toBe(1);

		// Release run 1: run 2 starts and suspends on gate 2; run 3 is queued.
		gates[0]!.resolve();
		await flushMicrotasks();
		expect(initCalls).toBe(2);

		// Release run 2: run 3 finally runs to completion.
		gates[1]!.resolve();
		await flushMicrotasks();
		expect(initCalls).toBe(3);
	});
});
