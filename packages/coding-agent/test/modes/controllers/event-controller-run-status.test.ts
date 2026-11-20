/**
 * The run status `EventController` publishes (title separator + OSC 7501
 * record): what a settled turn leaves behind.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

const AGENT_START = { type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>;

function assistant(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		errorMessage,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function agentEnd(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

describe("EventController run status at turn end", () => {
	it.each([
		["a finished turn leaves its result as done", [assistant("stop")], { state: "done" }],
		[
			"a failed turn reports error with the failure",
			[assistant("error", "429 overloaded")],
			{ state: "error", msg: "429 overloaded" },
		],
		["an interrupted turn goes back to idle", [assistant("aborted", "Interrupted by user")], { state: "idle" }],
		["a turn without a reply goes back to idle", [], { state: "idle" }],
	])("%s", async (_name, messages, expected) => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd(messages));

		expect(report).toHaveBeenLastCalledWith(expected);
	});

	it("reports idle, not error, for a failure an auto-retry is about to start over", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(agentEnd([assistant("error", "overloaded")]));

		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
	});
});

describe("EventController settle with a queued compaction", () => {
	function queuedCompactionContext() {
		const ctx = createInteractiveModeContext();
		const runYieldCompaction = vi.fn();
		const restoreCompactionQueueToEditor = vi.fn();
		Object.assign(ctx, {
			yieldCompaction: { text: "/compact", sessionId: "session", leafId: null },
			runYieldCompaction,
			restoreCompactionQueueToEditor,
		});
		return { ctx, runYieldCompaction, restoreCompactionQueueToEditor };
	}

	it("runs it when the run yields", async () => {
		const { ctx, runYieldCompaction, restoreCompactionQueueToEditor } = queuedCompactionContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd([assistant("stop")]));

		expect(runYieldCompaction).toHaveBeenCalledTimes(1);
		expect(restoreCompactionQueueToEditor).not.toHaveBeenCalled();
	});

	it("hands it back when the user stopped the run (loop-mode Esc aborts without restoring the queue)", async () => {
		const { ctx, runYieldCompaction, restoreCompactionQueueToEditor } = queuedCompactionContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd([assistant("aborted", USER_INTERRUPT_LABEL)]));

		expect(runYieldCompaction).not.toHaveBeenCalled();
		expect(restoreCompactionQueueToEditor).toHaveBeenCalledTimes(1);
	});
});
