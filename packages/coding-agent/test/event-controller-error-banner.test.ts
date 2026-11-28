/**
 * EventController error-banner wiring.
 *
 * A turn that ends on a provider error (e.g. Anthropic's "Output blocked by
 * content filtering policy") must pin a persistent banner above the editor via
 * `ctx.showPinnedError`, and the banner must be cleared at the next turn's
 * `agent_start` via `ctx.clearPinnedError`. Aborts and normal stops must NOT
 * pin a banner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { workingMessage, type WorkingSpec } from "../src/ui/dock/working";
import { initTheme } from "../src/ui/theme/service";
import { blockText } from "./helpers/transcript-text";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

import { cfgDisplaySmoothStreaming } from "@oh-my-pi/pi-coding-agent/modes/settings";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
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
		...overrides,
	};
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	cfgDisplaySmoothStreaming.set(settings, false);
});

afterEach(() => {
	setSystemTime();
	resetSettingsForTest();
});

function createFixture(streamingMessage?: AssistantMessage) {
	const sessionState = { isStreaming: false };
	let hasDisplayableThinkingContent = false;
	const noteDisplayableThinkingContent = vi.fn((message: AssistantMessage) => {
		const hasThinking = message.content.some(
			content => content.type === "thinking" && content.thinking.trim() !== "",
		);
		if (!hasThinking || hasDisplayableThinkingContent) return false;
		hasDisplayableThinkingContent = true;
		return true;
	});
	const ctx = createInteractiveModeContext({
		streamingMessage,
		session: {
			get isStreaming() {
				return sessionState.isStreaming;
			},
		},
		noteDisplayableThinkingContent,
		get hasDisplayableThinkingContent() {
			return hasDisplayableThinkingContent;
		},
		get effectiveHideThinkingBlock() {
			return !hasDisplayableThinkingContent;
		},
	});
	// The streaming reply the turn ends on.
	const streaming = ctx.presentAssistant();
	if (streamingMessage) ctx.streaming = streaming;
	const setErrorPinned = vi.spyOn(streaming.errorPinned, "set");

	const showPinnedError = vi.spyOn(ctx, "showPinnedError");
	const clearPinnedError = vi.spyOn(ctx, "clearPinnedError");
	const showError = vi.spyOn(ctx, "showError");
	const controller = new EventController(ctx);
	return {
		controller,
		ctx,
		showPinnedError,
		clearPinnedError,
		showError,
		streaming,
		setErrorPinned,
		sessionState,
	};
}

describe("EventController error banner", () => {
	it("bounds and sanitizes multiline provider errors in fallback warnings", async () => {
		const { controller, ctx } = createFixture();
		const showWarning = vi.spyOn(ctx, "showWarning");
		const reason = `Request failed: \u001b[31m503 unavailable\u001b[0m\n${"<html>error</html>\n".repeat(1000)}`;
		await controller.handleEvent({
			type: "retry_fallback_applied",
			from: "source/model",
			to: "target/model",
			role: "default",
			reason,
		});
		const warning = showWarning.mock.calls[0][0];
		expect(warning).toContain("source/model -> target/model");
		const lines = warning.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("503 unavailable");
		expect(lines[1]).not.toContain("\u001b");
		expect(Bun.stringWidth(lines[1])).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE * PREVIEW_LIMITS.COLLAPSED_LINES);
	});

	it("pins the provider error above the editor when an assistant turn ends on stopReason error", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, showPinnedError, setErrorPinned } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).toHaveBeenCalledTimes(1);
		expect(showPinnedError).toHaveBeenCalledWith(errorMessage);
		// The same error is mirrored in the banner, so the transcript's inline
		// `Error: …` line is suppressed to avoid a duplicate render.
		expect(setErrorPinned).toHaveBeenCalledWith(true);
	});

	it("shows the same Beijing-time quota reset in the banner and retry row", async () => {
		setSystemTime(new Date("2026-01-05T00:00:00Z"));
		const errorMessage = "Usage limit reached. Your limit will reset at 2026-01-05 09:00:00";
		const message = makeAssistantMessage({
			provider: "zai",
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.UsageLimit),
			errorMessage,
		});
		const { controller, ctx, showPinnedError } = createFixture(message);
		await controller.handleEvent({ type: "message_end", message });
		const label = "Zai account usage limit reached; resets in 1h";
		expect(showPinnedError).toHaveBeenCalledWith(label);
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 3_600_000,
			errorMessage,
			errorId: message.errorId,
		});
		expect(ctx.showWorking).toHaveBeenCalledWith(
			"retry",
			expect.objectContaining({ variant: expect.objectContaining({ reason: label }) }),
		);
	});

	it("suppresses a recoverable empty-output error while session continuation starts", async () => {
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "Reasoning finished without final output." }],
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.Transient, AIError.Flag.EmptyResponse),
			errorMessage: "Gemini API returned a thought-only response without final output",
		});
		const { controller, showPinnedError, setErrorPinned } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(setErrorPinned).toHaveBeenCalledWith(true);
		expect(showPinnedError).not.toHaveBeenCalled();
		setErrorPinned.mockClear();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(setErrorPinned).not.toHaveBeenCalled();
	});

	it("keeps a terminal empty-output error pinned without adding a duplicate failure banner", async () => {
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "Reasoning finished without final output." }],
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.Transient, AIError.Flag.EmptyResponse),
			errorMessage: "Gemini API returned a thought-only response without final output",
		});
		const { controller, showPinnedError, clearPinnedError, showError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		expect(showPinnedError).not.toHaveBeenCalled();

		const finalError = "Assistant returned no final output after retry cap; try switching models";
		message.errorId = AIError.create();
		message.errorMessage = finalError;
		clearPinnedError.mockClear();
		showPinnedError.mockClear();

		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);

		expect(clearPinnedError).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(showPinnedError).toHaveBeenCalledWith(finalError);
	});

	it("keeps retry-attempt context when a terminal provider error is pinned", async () => {
		const errorMessage = "Service unavailable";
		const message = makeAssistantMessage({
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.Transient),
			errorMessage,
		});
		const { controller, showPinnedError, showError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		showPinnedError.mockClear();

		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: errorMessage,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);

		expect(showError).not.toHaveBeenCalled();
		expect(showPinnedError).toHaveBeenCalledWith("Retry failed after 3 attempts: Service unavailable");
	});

	it("surfaces a local continuation failure instead of the stale pinned provider error", async () => {
		const providerError = "Service unavailable";
		const message = makeAssistantMessage({
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.Transient),
			errorMessage: providerError,
		});
		const { controller, showPinnedError, clearPinnedError, showError, setErrorPinned } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 0,
			errorMessage: providerError,
			errorId: message.errorId,
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		expect(clearPinnedError).toHaveBeenCalled();
		showPinnedError.mockClear();
		showError.mockClear();
		setErrorPinned.mockClear();

		const finalError = `Retry continuation failed locally: local hook failed. Original error: ${providerError}`;
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);

		expect(showPinnedError).not.toHaveBeenCalled();
		expect(setErrorPinned).toHaveBeenCalledWith(false);
		expect(showError).toHaveBeenCalledWith(`Retry failed after 1 attempts: ${finalError}`);
	});

	it("shows a failed retry banner when no terminal assistant error exists", async () => {
		const { controller, showError } = createFixture();

		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "Assistant returned empty stop after retry cap",
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);

		expect(showError).toHaveBeenCalledWith(
			"Retry failed after 3 attempts: Assistant returned empty stop after retry cap",
		);
	});

	it("restores the transcript inline error when the next turn starts", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, clearPinnedError, setErrorPinned } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		setErrorPinned.mockClear();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(setErrorPinned).toHaveBeenCalledWith(false);
	});

	it("keeps a recovered attempt's error out of the banner and transcript", async () => {
		const errorMessage = "The socket connection was closed unexpectedly before the response completed";
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "Partial reasoning" }],
			stopReason: "error",
			errorMessage,
			errorId: AIError.create(AIError.Flag.Transient),
		});
		const { controller, ctx, clearPinnedError, setErrorPinned, streaming } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		clearPinnedError.mockClear();
		setErrorPinned.mockClear();

		// The retry row counts its delay down from the wall clock, which runs on between the retry's
		// start and this render; hold the clock still so the row shows the whole delay on any machine.
		setSystemTime(Date.now());
		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 500,
			errorMessage,
			errorId: message.errorId,
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(ctx.working).toBe("retry");
		const showWorking = ctx.showWorking as unknown as { mock: { calls: [string, WorkingSpec][] } };
		const spec = showWorking.mock.calls.at(-1)![1];
		const status = workingMessage(spec, spec.startedAt, key => key);
		expect(status).toContain("Retrying (1/3) in 500ms · The socket connection was closed");

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		expect(setErrorPinned).not.toHaveBeenCalledWith(false);

		const retryRecovery = {
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recovery: "plain",
			note: "error; retried",
		} as const;
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
			retryErrors: [
				{ entryId: "entry", persistenceKey: "test-persistence-key", note: "error; retried", retryRecovery },
			],
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);

		expect(streaming.message.peek()?.retryRecovery as unknown).toEqual(retryRecovery);
		const transcript = blockText(streaming.block);
		expect(transcript).not.toContain(errorMessage);
		expect(transcript).toContain("error; retried");
	});

	it("does not pin a banner for a normal assistant stop", async () => {
		const message = makeAssistantMessage({ stopReason: "stop" });
		const { controller, showPinnedError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("does not pin a banner for an aborted assistant turn", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: "Operation aborted" });
		const { controller, showPinnedError } = createFixture(message);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("clears the pinned banner when the next turn starts", async () => {
		const { controller, clearPinnedError } = createFixture();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
	});

	it("initializes a new provider error from the active expanded mode", async () => {
		const initial = makeAssistantMessage({ content: [] });
		const errorMessage = Array.from({ length: 30 }, (_, i) => `provider error detail line ${i}`).join("\n");
		const { controller, ctx } = createFixture();
		ctx.toolOutputExpanded = true;

		await controller.handleEvent({
			type: "message_start",
			message: initial,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		const view = ctx.streaming;
		if (!view) throw new Error("Expected the streaming reply");

		view.message.set(
			makeAssistantMessage({
				content: [],
				stopReason: "error",
				errorMessage,
			}),
		);
		const rendered = blockText(view.block);
		expect(rendered).toContain("provider error detail line 29");
		expect(rendered).not.toContain("more lines");
	});
});

describe("EventController thinking visibility", () => {
	it("shows the first observed thinking delta on the active streaming component", async () => {
		const initial = makeAssistantMessage({ content: [] });
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "server-side reasoning" }],
		});
		const { controller, ctx } = createFixture();

		await controller.handleEvent({
			type: "message_start",
			message: initial,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		const view = ctx.streaming;
		if (!view) throw new Error("Expected the streaming reply");

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				delta: "server-side reasoning",
				contentIndex: 0,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(blockText(view.block, 80)).toContain("server-side reasoning");
	});
});

describe("EventController working row reconciliation", () => {
	it("restores the working row after compaction while the focused session streams", async () => {
		const { controller, ctx, sessionState } = createFixture();
		ctx.showWorking("compaction", { label: "Compacting…", startedAt: 0, variant: { kind: "compaction" } });
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(ctx.clearWorking).toHaveBeenCalledWith("compaction");
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(ctx.ensureWorkingRow).toHaveBeenCalledTimes(1);
		expect(ctx.working).toBe("turn");
	});

	it("self-heals a missing working row on live tool updates", async () => {
		const { controller, ctx, sessionState } = createFixture();
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureWorkingRow).toHaveBeenCalledTimes(1);
	});

	it("self-heals a missing working row when a task subagent finishes mid-turn (#3858)", async () => {
		// `task` subagents run inside the parent's streaming turn. A transient row
		// (auto-compaction / auto-retry) can take the working row down while the
		// task runs; `tool_execution_end` is the next streaming event that lands and
		// must restore it, mirroring the `tool_execution_update` reconciler.
		const { controller, ctx, sessionState } = createFixture();
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-1",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureWorkingRow).toHaveBeenCalledTimes(1);
	});

	it("does not restore the working row while a retry countdown holds it at tool_execution_end", async () => {
		const { controller, ctx, sessionState } = createFixture();
		ctx.showWorking("retry", {
			label: "Retrying",
			startedAt: 0,
			variant: { kind: "retry", attempt: 1, max: 3, delayMs: 1000 },
		});
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-2",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureWorkingRow).not.toHaveBeenCalled();
		expect(ctx.working).toBe("retry");
	});

	it("keeps the retry countdown exclusive on tool updates", async () => {
		const { controller, ctx, sessionState } = createFixture();
		ctx.showWorking("retry", {
			label: "Retrying",
			startedAt: 0,
			variant: { kind: "retry", attempt: 1, max: 3, delayMs: 1000 },
		});
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureWorkingRow).not.toHaveBeenCalled();
		expect(ctx.working).toBe("retry");
	});
});

describe("assistant reply error pinning", () => {
	it("hides the inline error while pinned and restores it afterwards", () => {
		const message = makeAssistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "400 invalid reasoning value",
		});
		const { ctx } = createFixture();
		const view = ctx.presentAssistant(message);

		expect(blockText(view.block)).toContain("400 invalid reasoning value");

		view.errorPinned.set(true);
		expect(blockText(view.block)).not.toContain("400 invalid reasoning value");

		view.errorPinned.set(false);
		expect(blockText(view.block)).toContain("400 invalid reasoning value");
	});
});
