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
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
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

	it("reports a session dialog nobody has answered as blocked, not as a working run", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());
		const prompt = "whether to leave openai-codex/gpt-5.6-terra at its coding-plan reserve";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "user_wait_start", prompt });
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("leaves a session idle, not working, when a dialog outside any run settles", async () => {
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent({ type: "user_wait_start", prompt: "an MCP sign-in for linear" });
		expect(report).toHaveBeenLastCalledWith({
			state: "blocked",
			kind: "question",
			msg: "an MCP sign-in for linear",
		});

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
	});

	it("keeps reporting an unanswered dialog when a run starts behind it", async () => {
		// An MCP sign-in or a reserve prompt can be open when the next run starts
		// (a queued prompt, an extension turn). The person still owes an answer,
		// so the title and the OSC record must not report progress over it.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());
		const prompt = "an MCP sign-in for linear";

		await controller.handleEvent({ type: "user_wait_start", prompt });
		await controller.handleEvent(AGENT_START);
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps an unanswered dialog across the cleanup of a run that ended beside it", async () => {
		// The run's cleanup clears the per-call prompt map. A session dialog
		// outlives the run, so the settled run must not be the last word and the
		// answer that arrives later must still be honoured.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());
		const prompt = "an MCP sign-in for linear";

		await controller.handleEvent({ type: "user_wait_start", prompt });
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd([assistant("stop")]));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
	});

	it("keeps naming an unanswered dialog when a blocking tool starts behind it", async () => {
		// A run can reach an `ask` (or an approval prompt) while a session dialog
		// is still unanswered. The dialog outranks the run's own prompt, so the
		// OSC record must keep naming the dialog instead of the tool's question,
		// and the answer that arrives later must still be honoured.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());
		const prompt = "an MCP sign-in for linear";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "user_wait_start", prompt });
		await controller.handleEvent(toolStart("ask-1", "ask", askArgs("Use Postgres?")));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });

		await controller.handleEvent(toolEnd("ask-1", "ask"));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps the title's attention mark while a dialog waits across an async-work settle", async () => {
		// A run that hands control to a background job settles non-terminally and
		// the title goes idle — but an unanswered dialog outranks it: the OSC
		// record reports `blocked`, and the title must not drop the attention mark
		// the person is owed while the background work runs.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const titleState = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const controller = new EventController(createInteractiveModeContext());
		const prompt = "an MCP sign-in for linear";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "user_wait_start", prompt });
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
			awaitingAsyncWork: true,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);

		expect(titleState).toHaveBeenLastCalledWith("attention");
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "question", msg: prompt });
	});

	it("restores the idle title but keeps the working record when a dialog ends during async work", async () => {
		// The dialog's answer arrives before the background job ends. The run is
		// still active, so the OSC record returns to `working` — but the title
		// must stay idle (the async-only policy), not flip back to working for the
		// rest of the job wait.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const titleState = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		// The job is still running when the dialog is answered, which is the case
		// this covers. The settle watch parks on `waitForIdle` meanwhile — a stub
		// that returns at once would spin that loop — and is let go at the end so
		// the watch can finish.
		const jobRunning = Promise.withResolvers<void>();
		let asyncWorkPending = true;
		const controller = new EventController(
			createInteractiveModeContext({
				session: {
					hasPendingAsyncWork: () => asyncWorkPending,
					waitForIdle: () => jobRunning.promise,
				},
			}),
		);
		const prompt = "an MCP sign-in for linear";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "user_wait_start", prompt });
		await controller.handleEvent({
			type: "agent_end",
			messages: [],
			isTerminal: false,
			awaitingAsyncWork: true,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);
		await controller.handleEvent({ type: "user_wait_end" });

		expect(report).toHaveBeenLastCalledWith({ state: "working" });
		expect(titleState).toHaveBeenLastCalledWith("idle");

		asyncWorkPending = false;
		jobRunning.resolve();
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
	});

	it("keeps a tool's own question when its dialog opens the session wait", async () => {
		// The tool UI brackets its approval through `trackUserWaits`, whose label
		// is generic. The prompt recorded for that tool call names the question
		// and its kind, so that is what the title and the OSC record report.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "rm -rf build" }));
		await controller.handleEvent({ type: "user_wait_start", prompt: "an extension approve dialog" });
		expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps the permission kind and names the approval still waiting when an overlapping one ends", async () => {
		// Two approvals overlap. The session publishes the oldest open dialog as
		// its wait, with that dialog's own words and kind, and republishes the
		// next one when it settles. Both the tool-start of the second approval
		// and the tool-end of the first report through the session wait, so a
		// frame that lost its classification would leave the OSC 7501 consumer
		// reading `question` with no idea which operation is being approved.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = {
			name: "bash",
			label: "Bash",
			formatApprovalDetails: (args: { command: string }) => [`Command: ${args.command}`],
		} as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const firstDialog = "Allow tool: bash\nCommand: echo first";
		const secondDialog = "Allow tool: bash\nCommand: echo second";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo first" }));
		await controller.handleEvent({ type: "user_wait_start", prompt: firstDialog, kind: "permission" });
		await controller.handleEvent(toolStart("bash-2", "bash", { command: "echo second" }));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: firstDialog });

		// The first dialog is answered: the session republishes the one still
		// open, and only then does the first tool call end.
		await controller.handleEvent({ type: "user_wait_start", prompt: secondDialog, kind: "permission" });
		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: secondDialog });

		await controller.handleEvent({ type: "user_wait_end" });
		await controller.handleEvent(toolEnd("bash-2", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});
});
