/**
 * Regression tests for `EventController`'s post-turn desktop notifications
 * (`sendCompletionNotification` / `sendErrorNotification`).
 *
 * Both read the settled turn's outcome from the `agent_end` event's own
 * `messages`, not the mutable `viewSession` active context: a classifier-
 * refusal failure ends with `stopReason === "error"` but is pruned from
 * active context before the public `agent_end` fires (see
 * `#removeAssistantMessageFromActiveContext` in `agent-session.ts`), and a
 * user Ctrl+C on the `ask` tool selector similarly leaves `stopReason ===
 * "aborted"` on the terminal message. Reading the mutable context for either
 * check risks a stale/absent lookup — dropping the intended notification, or
 * worse, pairing a misleading "Complete" toast with an error/abort.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const originalWarpProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

function restoreWarpProtocolEnvironment(): void {
	if (originalWarpProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalWarpProtocolVersion;
	}
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	// Neutral baseline for notification gates; afterEach restores the suite's inherited value.
	delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-abortguard-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	restoreWarpProtocolEnvironment();
});

type StopReason = "stop" | "aborted" | "error";

function makeAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeContext() {
	return createInteractiveModeContext({
		sessionManager: {
			getSessionName: () => "test-session",
		},
	});
}

function makeAgentEndEvent(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

/** Full context needed to drive `#handleAgentEnd` -> `#finishAgentEnd` end to end. */
function makeTurnEndContext(options: { lastAssistantMessage?: AssistantMessage } = {}) {
	return createInteractiveModeContext({
		sessionManager: { getSessionName: () => "test-session" },
		viewSession: {
			getLastAssistantMessage: () => options.lastAssistantMessage,
		},
	});
}

describe("EventController.sendCompletionNotification — abort guard", () => {
	it("skips notification when the terminal assistant message stopReason === 'aborted'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("aborted")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips notification when the terminal assistant message stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("fires notification when stopReason === 'stop' (normal completion)", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(1);
		// Completion now sends a structured notification (title=session, body="Complete").
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
	});

	it("fires notification when agent_end carries no assistant message (e.g. brand-new session)", () => {
		// Defensive: `findLast` returns undefined; treat as 'no abort flag', proceed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([]));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors the existing completion.notify=off gate", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "off");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips legacy completion notify when Warp CLI-agent protocol is active", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});
});

describe("EventController.sendErrorNotification", () => {
	it("defaults error notifications to opt-in", () => {
		expect(SETTINGS_SCHEMA["error.notify"].default).toBe("off");
	});

	it("fires an error notification when stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Stopped with error", type: "error", title: "test-session" }),
		);
	});

	it("uses the last assistant message when agent_end carries multiple messages", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(
			makeAgentEndEvent([makeAssistantMessage("stop"), makeAssistantMessage("error")]),
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors error.notify=off without changing completion notifications", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "off");
		settings.override("completion.notify", "on");

		const errorController = new EventController(makeContext());
		errorController.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(0);

		const completionController = new EventController(makeContext());
		completionController.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
	});

	it("skips user-aborted turns", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("aborted")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips normal completion turns", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});
	it("skips an error turn marked as a non-terminal scheduling pause", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeContext());
		const event = {
			...makeAgentEndEvent([makeAssistantMessage("error")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal: false };

		controller.sendErrorNotification(event);

		expect(spy).not.toHaveBeenCalled();
	});
});

describe("EventController — notifications through the real turn-end path (#handleAgentEnd)", () => {
	it("fires the error notification when the dispatched turn settles with stopReason === 'error', even with a stale active-context snapshot", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "off");
		// viewSession (active context) reports no assistant at all — the shape a
		// classifier-refusal prune leaves behind — while the terminal agent_end
		// event still carries the failed turn.
		const controller = new EventController(makeTurnEndContext({ lastAssistantMessage: undefined }));
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});

	it("skips the error notification when the dispatched turn settles with stopReason === 'aborted'", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "off");
		const controller = new EventController(makeTurnEndContext());
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("aborted")]));
		expect(spy).not.toHaveBeenCalled();
	});

	it("fires only the error toast — never a paired 'Complete' toast — for one error-ending turn", async () => {
		// Regression for the exact coupling bug: with both notify settings on,
		// a classifier-refusal turn's stale active context must not let
		// sendCompletionNotification's own stopReason check pass by reading a
		// different (non-error) snapshot than sendErrorNotification just used.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "on");
		const controller = new EventController(makeTurnEndContext({ lastAssistantMessage: undefined }));
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});
});

describe("EventController — error toast gated while auto-retry is pending", () => {
	it("suppresses the error toast for the agent_end that lands mid-retry, then still fires on the real final failure", async () => {
		// `#handleRetryableError` emits `auto_retry_start`, then still publishes the
		// failed turn's `agent_end` (stopReason === 'error') before the retry has a
		// chance to recover. That agent_end must not raise a toast — only the
		// retry's own eventual settle (success or exhausted) should.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "off");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).not.toHaveBeenCalled();

		// Retries exhausted: the session falls through to its own final agent_end
		// for the same failed message, now that the retry saga is over.
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "still overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});

	it("keeps retry suppression when the next attempt starts before a deferred failed agent_end settles", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));

		expect(spy).not.toHaveBeenCalled();
	});

	it("clears a retry latch when the view retargets to a session that is not retrying", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		controller.resetTranscriptAnchors();
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("fires no error toast at all when the retry recovers", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "off");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		// The recovered turn settles normally with stopReason 'stop'.
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).not.toHaveBeenCalled();
	});

	it("keeps suppressing every agent_end that lands while a retry is outstanding, with no auto_retry_end in between", async () => {
		// The wire-level `agent_end` is coalesced by `AgentSession` while a prompt
		// is in flight (every mid-retry attempt supersedes the previous one), so
		// this controller cannot use "have I seen an agent_end yet" to decide
		// whether a retry settled — only `auto_retry_end` can. Two agent_ends
		// landing back-to-back with no `auto_retry_end` between them must both
		// stay suppressed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("error.notify", "on");
		settings.override("completion.notify", "off");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).not.toHaveBeenCalled();

		// Only once the lifecycle explicitly settles does the next agent_end notify.
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "still overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});
});

describe("EventController — terminal title across a non-terminal agent_end", () => {
	it("keeps the working title and skips loader teardown but still flushes a deferred model switch during a pending async-wake pause (isTerminal:false)", async () => {
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const ctx = makeTurnEndContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const flushPendingModelSwitch = vi.spyOn(ctx, "flushPendingModelSwitch");
		const controller = new EventController(ctx);
		await controller.handleEvent({
			...makeAgentEndEvent([makeAssistantMessage("stop")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal: false });
		// The async job still runs: never drop to `idle`, never run #finishAgentEnd teardown.
		expect(stateSpy).not.toHaveBeenCalledWith("idle");
		expect(markActivityEnd).not.toHaveBeenCalled();
		// The automatic continuation must still pick up a queued plan-mode model switch.
		expect(flushPendingModelSwitch).toHaveBeenCalledTimes(1);
	});

	it("transitions to idle and tears down on the terminal agent_end", async () => {
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const ctx = makeTurnEndContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const controller = new EventController(ctx);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(stateSpy).toHaveBeenCalledWith("idle");
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});
});
