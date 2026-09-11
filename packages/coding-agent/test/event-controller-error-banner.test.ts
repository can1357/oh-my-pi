/**
 * EventController error-banner wiring.
 *
 * A turn that ends on a provider error (e.g. Anthropic's "Output blocked by
 * content filtering policy") must pin a persistent banner above the editor via
 * `ctx.showPinnedError`, and the banner must be cleared at the next turn's
 * `agent_start` via `ctx.clearPinnedError`. Aborts and normal stops must NOT
 * pin a banner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ErrorBannerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/error-banner";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Loader } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

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

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("display.smoothStreaming", false);
});

afterEach(() => {
	resetSettingsForTest();
});

function createFixture(streamingMessage?: AssistantMessage) {
	const componentCalls: string[] = [];
	const streamingComponent = new AssistantMessageComponent();
	const updateContentImpl = streamingComponent.updateContent.bind(streamingComponent);
	vi.spyOn(streamingComponent, "updateContent").mockImplementation((message, opts) => {
		componentCalls.push("update");
		updateContentImpl(message, opts);
	});
	const setHideThinkingBlockImpl = streamingComponent.setHideThinkingBlock.bind(streamingComponent);
	vi.spyOn(streamingComponent, "setHideThinkingBlock").mockImplementation(hide => {
		componentCalls.push(`hide:${hide}`);
		setHideThinkingBlockImpl(hide);
	});
	const setErrorPinned = vi.spyOn(streamingComponent, "setErrorPinned");
	vi.spyOn(streamingComponent, "messagePersistenceKey").mockReturnValue("test-persistence-key");
	vi.spyOn(streamingComponent, "applyRetryRecovery");
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
		streamingComponent: streamingMessage ? streamingComponent : undefined,
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
	vi.spyOn(ctx.statusContainer, "disposeChildren");

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
		streamingComponent,
		setErrorPinned,
		componentCalls,
		sessionState,
	};
}

describe("EventController error banner", () => {
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

	it("suppresses a recoverable empty-output error while session continuation starts", async () => {
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "Reasoning finished without final output." }],
			stopReason: "error",
			errorId: AIError.create(AIError.Flag.Transient, AIError.Flag.EmptyResponse),
			errorMessage: "Cloud Code Assist API returned a thought-only response without final output",
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
			errorMessage: "Cloud Code Assist API returned a thought-only response without final output",
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
		showPinnedError.mockClear();
		clearPinnedError.mockClear();
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
		expect(clearPinnedError).toHaveBeenCalledTimes(1);
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

	it("clears retryable thinking-loop banners without restoring the dropped inline error", async () => {
		const errorMessage = "loop guard stopped repeated reasoning";
		const message = makeAssistantMessage({
			stopReason: "error",
			errorMessage,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		});
		const { controller, clearPinnedError, setErrorPinned } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		clearPinnedError.mockClear();
		setErrorPinned.mockClear();

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 0,
			errorMessage,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(setErrorPinned).not.toHaveBeenCalledWith(false);
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
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
		const component = ctx.streamingComponent;
		if (!(component instanceof AssistantMessageComponent)) {
			throw new Error("Expected streaming assistant component");
		}

		component.updateContent(
			makeAssistantMessage({
				content: [],
				stopReason: "error",
				errorMessage,
			}),
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
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
		const component = ctx.streamingComponent;
		if (!(component instanceof AssistantMessageComponent)) {
			throw new Error("Expected streaming assistant component");
		}

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				delta: "server-side reasoning",
				contentIndex: 0,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("server-side reasoning");
	});
});

describe("EventController working loader reconciliation", () => {
	it("restores the working loader after compaction clears status while the focused session streams", async () => {
		const { controller, ctx, sessionState } = createFixture();
		const loader = new Loader(
			ctx.ui,
			text => text,
			text => text,
		);
		const stop = vi.spyOn(loader, "stop");
		ctx.autoCompactionLoader = loader;
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(stop).toHaveBeenCalledTimes(1);
		expect(ctx.statusContainer.disposeChildren).toHaveBeenCalledTimes(1);
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("self-heals missing working loader on live tool updates", async () => {
		const { controller, ctx, sessionState } = createFixture();
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("self-heals missing working loader when a task subagent finishes mid-turn (#3858)", async () => {
		// `task` subagents run inside the parent's streaming turn. While the task is
		// running a transient overlay (auto-compaction / auto-retry) can drop the
		// working loader by clearing the status container, and the overlay's end
		// handler is the only restorer keyed off the missing loader. If the task
		// finishes between the overlay's start and end (or any other branch where
		// the loader was nulled without a follow-up overlay-end), `tool_execution_end`
		// is the next streaming event that lands and must heal the loader, mirroring
		// the `tool_execution_update` reconciler. Without this the spinner stays
		// gone for the remainder of the parent turn even though the agent keeps
		// streaming (the user-visible regression in #3858).
		const { controller, ctx, sessionState } = createFixture();
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-1",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("does not restore the working loader while an overlay loader (auto-retry) owns the status container at tool_execution_end", async () => {
		const { controller, ctx, sessionState } = createFixture();
		const loader = new Loader(
			ctx.ui,
			text => text,
			text => text,
		);
		ctx.retryLoader = loader;
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-2",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
		loader.stop();
	});

	it("keeps transient retry status exclusive while a retry loader is visible", async () => {
		const { controller, ctx, sessionState } = createFixture();
		const loader = new Loader(
			ctx.ui,
			text => text,
			text => text,
		);
		ctx.retryLoader = loader;
		sessionState.isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
		loader.stop();
	});
});

describe("ErrorBannerComponent", () => {
	it("renders the provider error message", () => {
		const banner = new ErrorBannerComponent("Output blocked by content filtering policy");
		const rendered = Bun.stripANSI(banner.render(120).join("\n"));
		expect(rendered).toContain("Output blocked by content filtering policy");
		expect(rendered).toContain("Dismissed when you send your next message.");
	});

	it("caps an oversized multi-line error to a few rows and points at expansion", () => {
		const huge = Array.from({ length: 50 }, (_, i) => `error detail line ${i}`).join("\n");
		const banner = new ErrorBannerComponent(huge);
		const rendered = Bun.stripANSI(banner.render(120).join("\n"));
		const detailLines = rendered.split("\n").filter(line => line.includes("error detail line"));
		expect(detailLines.length).toBe(4);
		expect(rendered).toMatch(/\+46 more lines \(.+ to expand\)/);
	});

	it("wraps a long single-line error across rows instead of cutting it", () => {
		const body = `400 ${JSON.stringify({ error: { message: "The requested model is not supported.", code: "model_not_supported", param: "model", type: "invalid_request_error" } })}`;
		const banner = new ErrorBannerComponent(body);
		const rendered = Bun.stripANSI(banner.render(60).join("\n"));
		expect(rendered.replace(/\n\s*/g, "")).toContain('"type":"invalid_request_error"}}');
		expect(rendered).not.toContain("more line");
	});
});

describe("AssistantMessageComponent error pinning", () => {
	it("hides the inline error while pinned and restores it afterwards", () => {
		const message = makeAssistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "400 invalid reasoning value",
		});
		const component = new AssistantMessageComponent(message);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(true);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(false);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");
	});
});
