/**
 * Step captions (`display.stepSummaries`) are written against the request the
 * current run serves: the operator's own prompt, never an agent-attributed
 * redirect, and never an earlier run's prompt carried into a run that has none.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayShowTokenUsage, cfgDisplayStepSummaries } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StepSummarizer } from "@oh-my-pi/pi-coding-agent/step-summary/step-summarizer";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

let requests: (string | undefined)[] = [];

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	cfgDisplayShowTokenUsage.set(settings, true);
	cfgDisplayStepSummaries.set(settings, true);
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
	requests = [];
	// Record the request each step is captioned against instead of calling a model.
	vi.spyOn(StepSummarizer.prototype, "summarize").mockImplementation(async input => {
		requests.push(input.request);
		return undefined;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

const AGENT_START = { type: "agent_start" } as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;

let clock = Date.UTC(2026, 0, 1);

function userMessage(text: string, attribution?: "agent"): AgentSessionEvent {
	const message = { role: "user", content: text, timestamp: ++clock, ...(attribution ? { attribution } : {}) };
	return { type: "message_end", message } as unknown as AgentSessionEvent;
}

function syntheticPrompt(text: string): AgentSessionEvent {
	const message = { role: "developer", content: text, synthetic: true, timestamp: ++clock };
	return { type: "message_start", message } as unknown as AgentSessionEvent;
}

/** One billed tool-calling step: its usage row, then `turn_end`, which requests the caption. */
async function runStep(controller: EventController, id: string): Promise<void> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "bun test" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: ++clock,
	};
	const toolResults: ToolResultMessage[] = [
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: ++clock,
		},
	];
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "turn_end", message, toolResults } as unknown as AgentSessionEvent);
}

describe("EventController step caption request", () => {
	it("captions against the current run's operator request only", async () => {
		const controller = new EventController(createInteractiveModeContext());

		// An agent-attributed redirect does not replace the operator's request.
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(userMessage("Fix the flaky parser test"));
		await controller.handleEvent(userMessage("Advisor: look at the lexer instead", "agent"));
		await runStep(controller, "a");
		await controller.handleEvent(AGENT_END);

		// A synthetic-only run (`/goal`, approved plan) has no request of its own.
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(syntheticPrompt("Continue toward the goal"));
		await runStep(controller, "b");
		await controller.handleEvent(AGENT_END);

		// A later operator prompt is captioned against; a synthetic prompt drained inside its run drops it.
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(userMessage("Rename the config flag"));
		await runStep(controller, "c");
		await controller.handleEvent(syntheticPrompt("Execute the approved plan"));
		await runStep(controller, "d");

		// A transcript reset (focus moved, new session) does not carry the request across.
		await controller.handleEvent(userMessage("Update the changelog"));
		controller.resetTranscriptAnchors();
		await runStep(controller, "e");

		expect(requests).toEqual([
			"Fix the flaky parser test",
			undefined,
			"Rename the config flag",
			undefined,
			undefined,
		]);
	});
});
