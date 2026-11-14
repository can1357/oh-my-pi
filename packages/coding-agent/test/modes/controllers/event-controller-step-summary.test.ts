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
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { UsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
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

/** One billed tool-calling step (a `bash` call unless given): its usage row, then `turn_end`, which requests the caption. */
async function runStep(
	controller: EventController,
	id: string,
	call: { name: string; arguments: Record<string, unknown> } = { name: "bash", arguments: { command: "bun test" } },
): Promise<void> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: call.name, arguments: call.arguments }],
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
			toolName: call.name,
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

	it("requests no caption for a step whose usage folded into a compact read group", async () => {
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(userMessage("Read the parser"));

		await runStep(controller, "r", { name: "read", arguments: { path: "src/parser.ts" } });
		expect(ctx.chatContainer.children.some(child => child instanceof ReadToolGroupComponent)).toBe(true);
		expect(ctx.chatContainer.children.some(child => child instanceof UsageRowBlock)).toBe(false);
		expect(requests).toEqual([]);

		// A step with a standalone usage row is still captioned.
		await runStep(controller, "b");
		expect(ctx.chatContainer.children.some(child => child instanceof UsageRowBlock)).toBe(true);
		expect(requests).toEqual(["Read the parser"]);
	});

	it("requests no caption for a host's step mirrored onto a collab guest", async () => {
		const ctx = Object.assign(createInteractiveModeContext(), { collabGuest: {} });
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(userMessage("Fix the flaky parser test"));

		await runStep(controller, "a");

		expect(ctx.chatContainer.children.some(child => child instanceof UsageRowBlock)).toBe(true);
		expect(requests).toEqual([]);
	});

	describe("a caption that lands after the step ended", () => {
		const userEntry = (text: string) => ({ role: "user" as const, content: text, timestamp: ++clock });

		/** A step on a persisted branch whose caption request is still open; `land` delivers the caption. */
		async function openStep() {
			const ctx = createInteractiveModeContext();
			const sessionManager = ctx.sessionManager;
			const promptId = sessionManager.appendMessage(userEntry("Fix the flaky parser test"));
			const stepId = sessionManager.appendMessage(userEntry("stands in for the step's last entry"));
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			let reportUsage: ((reply: AssistantMessage) => void) | undefined;
			vi.spyOn(StepSummarizer.prototype, "summarize").mockImplementation((_input, onUsage) => {
				reportUsage = onUsage;
				return promise;
			});
			const controller = new EventController(ctx);
			await controller.handleEvent(AGENT_START);
			await runStep(controller, "a");
			const row = ctx.chatContainer.children.find(child => child instanceof UsageRowBlock) as UsageRowBlock;
			const captions = () =>
				sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "step-summary");
			const land = async () => {
				resolve("Ran the parser tests");
				await promise;
				await Promise.resolve();
			};
			return { sessionManager, promptId, stepId, row, captions, land, reportUsage: () => reportUsage };
		}

		it("lands on the row and in the session while the step is still on the selected branch", async () => {
			const { sessionManager, row, captions, land } = await openStep();
			// The next prompt arrived first: the leaf advanced, but the step is still an ancestor.
			sessionManager.appendMessage(userEntry("Now rename the config flag"));

			await land();

			expect(row.summary).toBe("Ran the parser tests");
			expect(captions()).toHaveLength(1);
		});

		it("is dropped once a rewind left the step off the selected branch", async () => {
			const { sessionManager, promptId, row, captions, land } = await openStep();
			sessionManager.branch(promptId);

			await land();

			expect(row.summary).toBeUndefined();
			expect(captions()).toHaveLength(0);
			// The rewound leaf is untouched, so the re-submitted prompt parents on it.
			expect(sessionManager.getLeafId()).toBe(promptId);
		});

		it("journals the request's usage under the step without moving a rewound leaf", async () => {
			const { sessionManager, promptId, stepId, reportUsage } = await openStep();
			sessionManager.branch(promptId);

			reportUsage()?.({
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "stop",
				usage: { input: 300, output: 12 },
			} as AssistantMessage);

			const usage = sessionManager.getEntries().filter(entry => entry.type === "model_usage");
			expect(usage.map(entry => entry.parentId)).toEqual([stepId]);
			expect(sessionManager.getLeafId()).toBe(promptId);
		});
	});
});
