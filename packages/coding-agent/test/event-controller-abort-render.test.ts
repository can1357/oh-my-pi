/**
 * Phase 6 — C layer.
 *
 * Asserts `EventController.#handleMessageEnd`'s render labeling for the three
 * abort-classification paths:
 *
 *   C1  errorMessage = SILENT_ABORT_MARKER + aborted
 *       → `updateContent` receives a message with `stopReason: "stop"`;
 *         `errorMessage` is NOT overwritten.
 *   C2  errorMessage = undefined (no threaded reason) + aborted + no TTSR flag
 *       → `streamingMessage.errorMessage` is set to the generic "Operation
 *         aborted"; `updateContent` receives the original message ref.
 *   C2b errorMessage = USER_INTERRUPT_LABEL (threaded via AbortController) + aborted
 *       → the threaded reason is preserved verbatim, NOT replaced by the generic.
 *   C3  isTtsrAbortPending = true + aborted + SilentAbort flag + rule reason
 *       → `updateContent` receives a message with `stopReason: "stop"`; the
 *         persisted reason survives and the shared presentation renders nothing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
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

function createFixture(opts: {
	streamingMessage: AssistantMessage;
	isTtsrAbortPending?: boolean;
	retryAttempt?: number;
}) {
	const streamingComponent = new AssistantMessageComponent();
	const updateContent = vi.spyOn(streamingComponent, "updateContent");
	const ctx = createInteractiveModeContext({
		streamingComponent,
		streamingMessage: opts.streamingMessage,
		session: {
			isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
			retryAttempt: opts.retryAttempt ?? 0,
		},
	});

	const controller = new EventController(ctx);
	return { controller, ctx, updateContent };
}

describe("EventController #handleMessageEnd abort labeling", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("C1: SILENT_ABORT_MARKER + aborted -> updateContent stopReason='stop', errorMessage NOT overwritten", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
		});
		const { controller, ctx, updateContent } = createFixture({ streamingMessage: message });

		const event: Extract<AgentSessionEvent, { type: "message_end" }> = {
			type: "message_end",
			message,
		};
		await controller.handleEvent(event);

		// `updateContent` was called once with a copy whose `stopReason` is "stop".
		// The marker on errorMessage is preserved unchanged on that display copy.
		expect(updateContent).toHaveBeenCalledTimes(1);
		const arg = updateContent.mock.calls[0]![0];
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBe(SILENT_ABORT_MARKER);

		// Per the silent-abort contract: the controller must NOT overwrite errorMessage
		// with the operator-facing string. The marker is what drives replay-side
		// suppression, so it has to survive on the persisted message.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		// And the streamingMessage on ctx was cleared after the handler ran (lifecycle
		// guard — kept for completeness).
		expect(ctx.streamingMessage).toBeUndefined();
	});

	it("C1b: silent-abort errorId without marker suppresses the abort line", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: undefined,
			errorId: AIError.create(AIError.Flag.SilentAbort),
		});
		const { controller, updateContent } = createFixture({ streamingMessage: message });

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBeUndefined();
		expect(updateContent).toHaveBeenCalledTimes(1);
		const arg = updateContent.mock.calls[0]![0];
		expect(arg.stopReason).toBe("stop");
		expect(arg.errorMessage).toBeUndefined();
	});

	it("C2: errorMessage undefined (no threaded reason) + aborted + no TTSR -> errorMessage='Operation aborted', updateContent receives original ref", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, updateContent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
		});

		await controller.handleEvent({ type: "message_end", message });

		// No threaded reason -> generic operator-facing label stamped in-place.
		expect(message.errorMessage).toBe("Operation aborted");

		// `updateContent` saw the original streaming message ref (no `{...streamingMessage, stopReason:"stop"}` spread).
		expect(updateContent).toHaveBeenCalledTimes(1);
		const arg = updateContent.mock.calls[0]![0];
		expect(arg).toBe(message);
		expect(arg.stopReason).toBe("aborted");
		expect(arg.errorMessage).toBe("Operation aborted");
	});

	it("C2b: threaded user-interrupt reason on aborted message is preserved, not replaced by the generic label", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL });
		const { controller, updateContent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
		});

		await controller.handleEvent({ type: "message_end", message });

		// The Esc-interrupt reason rode the AbortController onto errorMessage; the
		// controller must surface it verbatim instead of overwriting with "Operation aborted".
		expect(message.errorMessage).toBe(USER_INTERRUPT_LABEL);
		const arg = updateContent.mock.calls[0]![0];
		expect(arg.errorMessage).toBe(USER_INTERRUPT_LABEL);
		expect(arg.stopReason).toBe("aborted");
	});

	it("C3: a TTSR abort (SilentAbort flag + rule reason) is suppressed live and on rebuild", async () => {
		// AgentSession stamps the SilentAbort flag on TTSR aborts while keeping the
		// rule reason text on the message. The controller must downgrade the display
		// stopReason without overwriting the persisted reason, and the shared
		// presentation path (resume, `/tree`, rebuild) must render nothing.
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: "TTSR matched rule: no-unwrap",
			errorId: AIError.create(AIError.Flag.SilentAbort),
		});
		const { controller, updateContent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: true,
		});

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBe("TTSR matched rule: no-unwrap");
		expect(updateContent).toHaveBeenCalledTimes(1);
		const arg = updateContent.mock.calls[0]![0];
		expect(arg.stopReason).toBe("stop");
		// Rebuild path: the persisted aborted message renders no error line.
		expect(resolveAssistantErrorPresentation(message)).toEqual({ kind: "none" });
	});
});
