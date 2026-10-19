/**
 * The run status `EventController` publishes (title separator + OSC 7501
 * record): what a settled turn leaves behind, and how user-blocking prompts
 * move the run between `blocked` and `working`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
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

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args } as unknown as AgentSessionEvent;
}

function toolEnd(toolCallId: string, toolName: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	} as unknown as AgentSessionEvent;
}

function askArgs(question: string): Record<string, unknown> {
	return { questions: [{ id: "q", question, options: [{ label: "Yes" }, { label: "No" }] }] };
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

describe("EventController run status while prompts wait on the user", () => {
	it("reports the prompt still waiting when another resolves, and working once none is left", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("ask-1", "ask", askArgs("Use Postgres?")));
		await controller.handleEvent(toolStart("ask-2", "ask", askArgs("Deploy now?")));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: "Deploy now?" });

		await controller.handleEvent(toolEnd("ask-2", "ask"));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: "Use Postgres?" });

		await controller.handleEvent(toolEnd("ask-1", "ask"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("reports a tool call that needs approval as blocked on permission", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "rm -rf build" }));

		expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));
	});
});
