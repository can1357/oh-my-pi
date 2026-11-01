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
import { UNNAMED_USER_WAIT_PROMPT } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
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

	it("reports a dialog that named nothing as itself, never as an outstanding approval", async () => {
		// A dialog with no words of its own is published under the generic label
		// its wrapper's method explains, and an ordinary question is what it
		// stays. Nothing correlates it with the approval record a tool call
		// carries — that call may already be approved and merely running — so
		// substituting the record's words would name the wrong operation and
		// substituting its `permission` would contradict the open dialog.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "rm -rf build" }));
		await controller.handleEvent({ type: "user_wait_start", prompt: "an extension custom dialog" });
		expect(report).toHaveBeenLastCalledWith({
			state: "blocked",
			kind: "question",
			msg: "an extension custom dialog",
		});

		// An opener that stated its classification keeps it too.
		await controller.handleEvent({ type: "user_wait_start", prompt: "a dialog waiting for you", kind: "question" });
		expect(report).toHaveBeenLastCalledWith({
			state: "blocked",
			kind: "question",
			msg: "a dialog waiting for you",
		});

		// Neither dialog ever named the approval, so answering them leaves the
		// call's own prompt standing: a person still owes it an answer.
		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: bash" });

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps a legacy host's untracked approval while an unrelated dialog is answered", async () => {
		// A host that drives its own approval UI raises no wait bracket for it,
		// so the call's own record is the only evidence a person owes an answer.
		// An unrelated session question opening and settling over it says nothing
		// about that approval, and must not retire its record — the terminal
		// would lose its blocked indication for as long as the tool stays
		// suspended.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = {
			name: "bash",
			label: "Bash",
			formatApprovalDetails: () => ["Command: publish-release"],
		} as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const untracked = "Allow tool: bash\nCommand: publish-release";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "publish-release" }));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: untracked });

		await controller.handleEvent({ type: "user_wait_start", prompt: "Unrelated extension question" });
		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: untracked });

		// The approval is answered where this session cannot see it; the call
		// ends, and only then is nobody owed anything.
		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("retires only the call whose own dialog the session published", async () => {
		// One approval is raised through a dialog that names its call, another on
		// a host the session cannot see. Answering the named one returns its call
		// to `working` and leaves the unnamed call reported as the approval it
		// still is — the two are told apart by identity, never by what the words
		// of one dialog resemble.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt", deploy: "prompt" });
		const tools: Record<string, AgentTool> = {
			bash: {
				name: "bash",
				label: "Bash",
				formatApprovalDetails: (args: { command: string }) => [`Command: ${args.command}`],
			} as unknown as AgentTool,
			deploy: { name: "deploy", label: "Deploy" } as unknown as AgentTool,
		};
		const controller = new EventController(
			createInteractiveModeContext({ session: { getToolByName: (name: string) => tools[name] } }),
		);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("deploy-1", "deploy", {}));
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo one" }));
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: "Allow tool: bash — echo one",
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		await controller.handleEvent({ type: "user_wait_end" });

		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: deploy" });

		await controller.handleEvent(toolEnd("deploy-1", "deploy"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("retires a call whose dialog named it but nothing else", async () => {
		// A host that drives its own approval UI can open the bracket with no
		// words of its own. What it says about the operation is useless, but the
		// call it names is not: that call's wait ends with the dialog.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo dangerous" }));
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: UNNAMED_USER_WAIT_PROMPT,
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		expect(report).toHaveBeenLastCalledWith({
			state: "blocked",
			kind: "permission",
			msg: UNNAMED_USER_WAIT_PROMPT,
		});

		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("retires a younger call answered behind the dialog that is still published", async () => {
		// The oldest dialog is the one published, so a younger one can open and
		// be answered without its words ever reaching a surface. Its call still
		// leaves the published list, and that is what retires its record: the
		// approved call runs on, and nothing reports it as waiting.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = {
			name: "bash",
			label: "Bash",
			formatApprovalDetails: (args: { command: string }) => [`Command: ${args.command}`],
		} as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const first = "Allow tool: bash\nCommand: echo first";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo first" }));
		await controller.handleEvent(toolStart("bash-2", "bash", { command: "echo second" }));
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: first,
			kind: "permission",
			toolCalls: ["bash-1", "bash-2"],
		});
		// The second is approved and starts running; the first still waits, and
		// the dialog on screen is unchanged.
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: first,
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: first });

		// The first is denied and ends; the second is still executing and must
		// not be reported as an approval nobody is being asked for.
		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("records no prompt for a call whose dialog was answered before its start arrived", async () => {
		// A dialog is published when it opens, which the loop's
		// `tool_execution_start` for the same call can follow: a host raises its
		// approval from inside `execute`, while the start is still buffered. The
		// start must not record a prompt for an answer already given.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: "Allow tool: bash",
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		await controller.handleEvent({ type: "user_wait_end" });
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo one" }));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("records no prompt for a start that arrives after its call already ended", async () => {
		// A view fed out of order can see the end before the start. The answer
		// the call's dialog received outlives that end, so the late start still
		// records nothing — the alternative is a run reported `blocked` on a
		// call that has finished, with no card left to answer.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: "Allow tool: bash",
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		await controller.handleEvent({ type: "user_wait_end" });
		await controller.handleEvent(toolEnd("bash-1", "bash"));
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo one" }));

		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps a session's own approval record across a focus change, and lends it to no one", async () => {
		// A host that drives its own approval UI raises no session dialog, so
		// this record is the only evidence the call is owed an answer — and
		// nothing republishes it on the way back. It is kept for the session it
		// belongs to, and the session focused in its place never sees it.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const mine = {} as object;
		const other = {} as object;

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "publish-release" }));
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: bash" });

		// Focus away: the record is parked against the run it describes, and the
		// session arriving inherits none.
		const live = { mark: "run:1", live: true };
		controller.resetTranscriptAnchors(mine, () => live);
		controller.adoptApprovalRecords(other, () => live);
		await controller.handleEvent(AGENT_START);
		expect(report).toHaveBeenLastCalledWith({ state: "working" });

		// Focus back while that same run is still open: the call is still owed an
		// answer, and says so again.
		controller.resetTranscriptAnchors(other, () => undefined);
		controller.adoptApprovalRecords(mine, () => live);
		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: bash" });

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("drops a parked record whose own run ended or was replaced while the view was away", async () => {
		// The view saw none of the events while it was elsewhere: the run it
		// parked may have been answered, aborted or disposed, and the id may be
		// running again for something else — and a logical reset can recycle the
		// id altogether. Only the same run, still open, brings the record back;
		// the same mark on a run that is over is a reason to drop it.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const ctx = createInteractiveModeContext({ session: { getToolByName: () => bash } });
		const onReturn = [
			{ mark: "settled:1", live: false },
			{ mark: "run:2", live: true },
			{ mark: "disposed", live: false },
			undefined,
		];

		for (const current of onReturn) {
			const controller = new EventController(ctx);
			const mine = {} as object;
			await controller.handleEvent(AGENT_START);
			await controller.handleEvent(toolStart("bash-1", "bash", { command: "publish-release" }));
			expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: bash" });

			controller.resetTranscriptAnchors(mine, () => ({ mark: "run:1", live: true }));
			controller.adoptApprovalRecords(mine, () => current);
			expect(report).toHaveBeenLastCalledWith({ state: "working" });
		}
	});

	it("drops a parked record whose run had already ended when it was parked", async () => {
		// The end can reach the session before the view has consumed it, so the
		// mark captured at parking is already terminal. The same terminal mark on
		// the way back describes a call that is over either way.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const mine = {} as object;
		const ended = { mark: "settled:1", live: false };

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "publish-release" }));
		controller.resetTranscriptAnchors(mine, () => ended);
		controller.adoptApprovalRecords(mine, () => ended);
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});

	it("keeps a parked record for a call the session never ran, across repeated returns", async () => {
		// A record the view holds for a call the session never announced is not
		// the session's to retire: it has no mark either side, and survives.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const mine = {} as object;

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "publish-release" }));
		for (let round = 0; round < 2; round++) {
			controller.resetTranscriptAnchors(mine, () => undefined);
			controller.adoptApprovalRecords(mine, () => undefined);
			expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: "Allow tool: bash" });
		}
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

	it("names the approval still waiting as soon as its frame is published", async () => {
		// The first approval is answered while its call runs on: the session
		// publishes the second dialog at once, but the first call's
		// `tool_execution_end` can be far later (a long command, a tool awaiting
		// another). Reporting the record of the answered call until then leaves
		// the status line naming an operation nobody is being asked about.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = {
			name: "bash",
			label: "Bash",
			formatApprovalDetails: (args: { command: string }) => [`Command: ${args.command}`],
		} as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));
		const secondDialog = "Allow tool: bash\nCommand: echo second";

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "echo first" }));
		await controller.handleEvent({ type: "user_wait_start", prompt: "Allow tool: bash\nCommand: echo first" });
		await controller.handleEvent(toolStart("bash-2", "bash", { command: "echo second" }));
		await controller.handleEvent({ type: "user_wait_start", prompt: secondDialog, kind: "permission" });

		expect(report).toHaveBeenLastCalledWith({ state: "blocked", kind: "permission", msg: secondDialog });
	});

	it("returns to working when the last dialog settles while an approved call runs on", async () => {
		// Nothing waits on a person once the bracket closes. The approved call is
		// executing, not asking, so its approval record must not hold the run at
		// `blocked` for the rest of the command.
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cfgToolsApproval.override(settings, { bash: "prompt" });
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const controller = new EventController(createInteractiveModeContext({ session: { getToolByName: () => bash } }));

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(toolStart("bash-1", "bash", { command: "sleep 60" }));
		await controller.handleEvent({
			type: "user_wait_start",
			prompt: "Allow tool: bash",
			kind: "permission",
			toolCalls: ["bash-1"],
		});
		await controller.handleEvent({ type: "user_wait_end" });
		expect(report).toHaveBeenLastCalledWith({ state: "working" });

		await controller.handleEvent(toolEnd("bash-1", "bash"));
		expect(report).toHaveBeenLastCalledWith({ state: "working" });
	});
});
