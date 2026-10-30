/**
 * Contract: computer runs keep the display awake for the whole agent turn (the `power.sleepPrevention` in-flight
 * bracket), however long its non-computer steps take, and the turn's end lets the display sleep at once; the next
 * turn holds it again. A dialog waiting for the user's answer ends the turn's hold until it settles, and a subagent
 * marks no turns, so its runs keep the native grace period.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, runInToolCall } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { trackUserWaits } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/user-wait";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { UNNAMED_USER_WAIT_PROMPT } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computerTurnInFlight, registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession computer display hold per turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let unregister: (() => void) | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-computer-turn-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		unregister?.();
		unregister = undefined;
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Turns whose end released the display on the session's computer controller. */
	const releases: number[] = [];
	/** Turns that went on after a dialog, as `from->turn`, sent so a run still active in them holds again. */
	const resumes: string[] = [];
	/** Per non-computer step: the turn computer runs would hold the display for, and the releases so far. */
	const steps: Array<{ turn: number | undefined; releases: number }> = [];
	let owner = "";
	const stepSchema = type({});
	/** A non-computer step of the turn (a build, a long read): it never touches the computer session. */
	const stepTool: AgentTool<typeof stepSchema, undefined> = {
		name: "step",
		label: "Step",
		description: "Step",
		parameters: stepSchema,
		async execute() {
			steps.push({ turn: computerTurnInFlight(owner), releases: releases.length });
			return { content: [{ type: "text", text: "stepped" }], details: undefined };
		},
	};
	let asked = Promise.withResolvers<void>();
	let answered = Promise.withResolvers<string>();
	const questionSchema = type({});
	/** A tool that waits for the user's answer, as `ask` and approvals do. */
	const questionTool: AgentTool<typeof questionSchema, undefined> = {
		name: "question",
		label: "Question",
		description: "Question",
		parameters: questionSchema,
		async execute() {
			const answer = await session!.waitForUser(() => {
				asked.resolve();
				return answered.promise;
			}, "a test question");
			return { content: [{ type: "text", text: answer }], details: undefined };
		},
	};
	let streaming = Promise.withResolvers<void>();

	function createSession(responses: MockResponse[], agentKind: "main" | "sub" = "main"): AgentSession {
		streaming = Promise.withResolvers<void>();
		asked = Promise.withResolvers<void>();
		answered = Promise.withResolvers<string>();
		releases.length = 0;
		resumes.length = 0;
		steps.length = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [stepTool as AgentTool, questionTool as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				streaming.resolve();
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[stepTool.name, stepTool as AgentTool],
				[questionTool.name, questionTool as AgentTool],
			]),
			agentKind,
		});
		owner = session.getEvalKernelOwnerId();
		unregister = registerComputerController(owner, {
			async run() {
				throw new Error("not used");
			},
			async capabilities() {
				return undefined;
			},
			releaseDisplay(turn) {
				releases.push(turn);
			},
			resumeDisplay(from, turn) {
				resumes.push(`${from}->${turn}`);
			},
			async close() {},
		});
		return session;
	}

	const step: MockResponse = { content: [{ type: "toolCall", name: "step", arguments: {} }], stopReason: "toolUse" };
	const question: MockResponse = {
		content: [{ type: "toolCall", name: "question", arguments: {} }],
		stopReason: "toolUse",
	};

	it("keeps the hold through every step of a turn, releases at its end, and holds again next turn", async () => {
		const target = createSession([step, step, { content: ["done"] }, step, { content: ["done again"] }]);
		expect(computerTurnInFlight(owner)).toBeUndefined();

		await target.prompt("go");
		expect(steps).toEqual([
			{ turn: 1, releases: 0 },
			{ turn: 1, releases: 0 },
		]);
		expect(releases).toEqual([1]);
		expect(computerTurnInFlight(owner)).toBeUndefined();

		await target.prompt("again");
		expect(steps[2]).toEqual({ turn: 2, releases: 1 });
		expect(releases).toEqual([1, 2]);
		expect(computerTurnInFlight(owner)).toBeUndefined();
	});

	it("releases when the user interrupts the turn", async () => {
		const target = createSession([{ content: ["slow"], delayMs: 5_000 }]);
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		expect(computerTurnInFlight(owner)).toBe(1);
		await target.abort();
		await running;
		expect(releases).toEqual([1]);
		expect(computerTurnInFlight(owner)).toBeUndefined();
	});

	it("releases at an interrupt while the prompt's setup is still unwinding", async () => {
		const entered = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const getApiKey = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => {
			entered.resolve();
			await unblock.promise;
			return "test-key";
		});
		try {
			const target = createSession([{ content: ["done"] }]);
			const running = target.prompt("go").catch(() => undefined);
			await entered.promise;
			expect(computerTurnInFlight(owner)).toBe(1);
			await target.abort();
			expect(computerTurnInFlight(owner)).toBeUndefined();
			expect(releases).toEqual([1]);
			unblock.resolve();
			await running;
			expect(releases).toEqual([1]);
		} finally {
			getApiKey.mockRestore();
		}
	});

	it("lets the display sleep while the user is asked, and holds again once they answer", async () => {
		const target = createSession([question, step, { content: ["done"] }]);
		const running = target.prompt("go");
		await asked.promise;
		expect(computerTurnInFlight(owner)).toBeUndefined();
		expect(releases).toEqual([1]);

		answered.resolve("yes");
		await running;
		expect(steps).toEqual([{ turn: 2, releases: 1 }]);
		expect(resumes).toEqual(["1->2"]);
		expect(releases).toEqual([1, 2]);
		expect(computerTurnInFlight(owner)).toBeUndefined();
	});

	it("holds again only once the last open dialog settles, and not after the turn is over", async () => {
		const target = createSession([{ content: ["slow"], delayMs: 5_000 }]);
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const firstWait = target.waitForUser(() => first.promise, "first");
		const secondWait = target.waitForUser(() => second.promise, "second");
		expect(releases).toEqual([1]);
		first.resolve();
		await firstWait;
		expect(computerTurnInFlight(owner)).toBeUndefined();
		second.resolve();
		await secondWait;
		expect(computerTurnInFlight(owner)).toBe(2);
		expect(resumes).toEqual(["1->2"]);

		// A dialog still open when the user interrupts the turn settles with no prompt in flight.
		const third = Promise.withResolvers<void>();
		const thirdWait = target.waitForUser(() => third.promise, "third");
		expect(releases).toEqual([1, 2]);
		await target.abort();
		await running;
		third.resolve();
		await thirdWait;
		expect(computerTurnInFlight(owner)).toBeUndefined();
		expect(releases).toEqual([1, 2]);
		expect(resumes).toEqual(["1->2"]);
	});

	it("begins a fresh turn, resuming no run, when a prompt starts while a dialog is already open", async () => {
		const target = createSession([{ content: ["done"] }, { content: ["slow"], delayMs: 5_000 }]);
		await target.prompt("first");
		const open = Promise.withResolvers<void>();
		const wait = target.waitForUser(() => open.promise, "open");
		streaming = Promise.withResolvers<void>();
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		expect(computerTurnInFlight(owner)).toBeUndefined();
		open.resolve();
		await wait;
		// Turn 1's runs ended with turn 1: the new turn holds for its own runs only.
		expect(computerTurnInFlight(owner)).toBe(2);
		expect(resumes).toEqual([]);
		await target.abort();
		await running;
	});

	it("runs a plan proposal handler as a wait for the user", async () => {
		const target = createSession([{ content: ["slow"], delayMs: 5_000 }]);
		const running = target.prompt("go").catch(() => undefined);
		await streaming.promise;
		let during: number | undefined = -1;
		target.setPlanProposalHandler(async () => {
			during = computerTurnInFlight(owner);
			return { content: [{ type: "text", text: "approved" }] };
		});
		await target.peekPlanProposalHandler()!("plan");
		expect(during).toBeUndefined();
		expect(computerTurnInFlight(owner)).toBe(2);
		await target.abort();
		await running;
	});

	it("publishes a named wait for an SDK caller that passes no prompt", async () => {
		// `waitForUser` is public API, so a caller written against its
		// one-argument form still compiles; the frame it publishes must still
		// carry a `prompt`, which a strict wire decoder requires.
		const target = createSession([{ content: ["done"] }]);
		const prompts: string[] = [];
		const unsubscribe = target.subscribe(event => {
			if (event.type === "user_wait_start") prompts.push(event.prompt);
		});
		const open = Promise.withResolvers<void>();
		const wait = target.waitForUser(() => open.promise);
		open.resolve();
		await wait;
		unsubscribe();
		expect(prompts).toEqual([UNNAMED_USER_WAIT_PROMPT]);
	});

	it("names the dialog still open after the one it published settles", async () => {
		// Two dialogs overlap (an MCP sign-in behind a reserve prompt). When the
		// published one is answered first, the surfaces that report run state —
		// and the replay a focus attach reads — must name the dialog that is
		// still waiting, not the one that is gone.
		const target = createSession([{ content: ["done"] }]);
		const events: string[] = [];
		const unsubscribe = target.subscribe(event => {
			if (event.type === "user_wait_start") events.push(`start:${event.prompt}`);
			if (event.type === "user_wait_end") events.push("end");
		});
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const firstWait = target.waitForUser(() => first.promise, "first");
		const secondWait = target.waitForUser(() => second.promise, "second");
		expect(events).toEqual(["start:first"]);
		expect(target.activeUserWait()?.prompt).toBe("first");

		first.resolve();
		await firstWait;
		expect(events).toEqual(["start:first", "start:second"]);
		expect(target.activeUserWait()?.prompt).toBe("second");

		second.resolve();
		await secondWait;
		unsubscribe();
		expect(events).toEqual(["start:first", "start:second", "end"]);
		expect(target.activeUserWait()).toBeUndefined();
	});

	it("names the call a tool's own dialog belongs to, without the tool naming it", async () => {
		// A host that opens its own dialog through the plain `waitForUser` — the
		// existing API, no call named — still says which call owes the answer:
		// the dialog is raised inside that call's execution. Nothing reads its
		// words to decide this.
		const target = createSession([
			{ content: [{ type: "toolCall", name: "question", arguments: {} }], stopReason: "toolUse" },
			{ content: ["done"] },
		]);
		const frames: Array<string[] | undefined> = [];
		let startedCallId: string | undefined;
		const unsubscribe = target.subscribe(event => {
			if (event.type === "tool_execution_start") startedCallId = event.toolCallId;
			if (event.type === "user_wait_start") frames.push(event.toolCalls);
		});
		const running = target.prompt("ask me");
		await asked.promise;
		const openCalls = target.activeUserWait()?.toolCalls;
		answered.resolve("yes");
		await running;
		unsubscribe();

		expect(startedCallId).toBeDefined();
		expect(openCalls).toEqual([startedCallId!]);
		expect(frames).toEqual([[startedCallId!]]);
	});

	it("marks its own calls disposed, and says nothing about a call it never ran", async () => {
		// Disposal ends what this session was doing and nothing more. A surface
		// holding a record for a call that was never this session's is still owed
		// an answer: claiming the call is disposed would retire it on a claim
		// this session has no standing to make.
		const target = createSession([
			{ content: [{ type: "toolCall", name: "question", arguments: {} }], stopReason: "toolUse" },
			{ content: ["done"] },
		]);
		let ownCallId: string | undefined;
		const unsubscribe = target.subscribe(event => {
			if (event.type === "tool_execution_start") ownCallId = event.toolCallId;
		});
		const running = target.prompt("ask me");
		await asked.promise;
		answered.resolve("yes");
		await running;
		unsubscribe();
		expect(ownCallId).toBeDefined();
		expect(target.toolCallRun(ownCallId!)).toEqual({ mark: expect.stringMatching(/^settled:\d+$/), live: false });
		expect(target.toolCallRun("never-ran-here")).toBeUndefined();

		await target.dispose();
		expect(target.toolCallRun(ownCallId!)).toEqual({ mark: "disposed", live: false });
		expect(target.toolCallRun("never-ran-here")).toBeUndefined();
		// The plain question is about this session, so it answers for any id.
		expect(target.hasSettledToolCall("never-ran-here")).toBe(true);
	});

	it("ends its runs when disposal begins, not when the teardown after it finishes", async () => {
		// A wrapper awaits other cleanup between `beginDispose()` and `dispose()`,
		// and a focus handover can land in that gap. A call still marked live
		// there would have its parked approval restored over a session that is
		// already going away, with nobody left to answer it.
		const target = createSession([
			{ content: [{ type: "toolCall", name: "question", arguments: {} }], stopReason: "toolUse" },
			{ content: ["done"] },
		]);
		let ownCallId: string | undefined;
		const unsubscribe = target.subscribe(event => {
			if (event.type === "tool_execution_start") ownCallId = event.toolCallId;
		});
		const running = target.prompt("ask me");
		await asked.promise;
		answered.resolve("yes");
		await running;
		unsubscribe();

		target.beginDispose();
		expect(target.toolCallRun(ownCallId!)).toEqual({ mark: "disposed", live: false });
		expect(target.toolCallRun("never-ran-here")).toBeUndefined();
		await target.dispose();
	});

	it("claims no dialog raised inside another agent's call of the same id", async () => {
		// Two sessions can legitimately be executing a call of the same id at
		// once. A dialog raised inside one agent's execution is that agent's; the
		// other session's call is still waiting and must stay so.
		const target = createSession([
			{ content: [{ type: "toolCall", name: "question", arguments: {} }], stopReason: "toolUse" },
			{ content: ["done"] },
		]);
		const other = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: target.model!, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: createMockModel({ responses: [{ content: ["done"] }] }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const foreign = Promise.withResolvers<void>();
		const running = target.prompt("ask me");
		try {
			await asked.promise;
			// Raised from inside the first session's execution, but asked of the
			// second session, which is executing nothing.
			const foreignWait = other.waitForUser(() => foreign.promise, "another session's dialog");
			expect(other.activeUserWait()?.toolCalls).toBeUndefined();
			foreign.resolve();
			await foreignWait;
		} finally {
			answered.resolve("yes");
			await running;
			await other.dispose();
		}
	});

	it("names a call from the run that raised the dialog, not from an executor with no agent", async () => {
		// A bridge that belongs to no agent can be running a call of the same id.
		// Its run is nobody's to answer for: a dialog raised inside it names no
		// call of this session, whose own call of that id is still waiting.
		const target = createSession([{ content: ["done"] }]);
		const answer = Promise.withResolvers<void>();
		await runInToolCall("question-1", async () => {
			const wait = target.waitForUser(() => answer.promise, "a dialog from an unowned run");
			expect(target.activeUserWait()?.toolCalls).toBeUndefined();
			answer.resolve();
			await wait;
		});
	});

	it("attributes a call run again after an interruption to the new run", async () => {
		// `retry` re-executes an interrupted call under the same id. The run that
		// was interrupted is over; this one is not, and its dialog is its own.
		const target = createSession([{ content: ["done"] }]);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const owner = target.agent;
		await runInToolCall(owner, "question-1", async () => {
			const wait = target.waitForUser(() => first.promise, "the interrupted run's dialog");
			expect(target.activeUserWait()?.toolCalls).toEqual(["question-1"]);
			first.resolve();
			await wait;
		});
		await runInToolCall(owner, "question-1", async () => {
			const wait = target.waitForUser(() => second.promise, "the new run's dialog");
			expect(target.activeUserWait()?.toolCalls).toEqual(["question-1"]);
			second.resolve();
			await wait;
		});
	});

	it("stops naming a call the moment the run that claimed it ends, leaving the dialog open", async () => {
		// A dialog can outlive the run that raised it. The id is then free for
		// another run, so the open dialog stops naming it at that moment — not
		// when something else next publishes, which may be never: a surface
		// replaying the snapshot in between would answer for the wrong run.
		const target = createSession([{ content: ["done"] }]);
		const stale = Promise.withResolvers<void>();
		const fresh = Promise.withResolvers<void>();
		const owner = target.agent;
		let staleWait: Promise<void> | undefined;
		await runInToolCall(owner, "question-1", async () => {
			staleWait = target.waitForUser(() => stale.promise, "the dialog left open");
			expect(target.activeUserWait()?.toolCalls).toEqual(["question-1"]);
		});
		// Nothing else has published, and the dialog is still on screen.
		expect(target.activeUserWait()?.prompt).toBe("the dialog left open");
		expect(target.activeUserWait()?.toolCalls).toBeUndefined();
		await runInToolCall(owner, "question-1", async () => {
			const wait = target.waitForUser(() => fresh.promise, "the new run's dialog");
			expect(target.activeUserWait()?.toolCalls).toEqual(["question-1"]);
			fresh.resolve();
			await wait;
		});
		// Only the stale dialog is left, and it names nothing.
		expect(target.activeUserWait()?.toolCalls).toBeUndefined();
		stale.resolve();
		await staleWait;
	});

	it("delivers the newer snapshot last when a listener opens a dialog inside a frame", async () => {
		// A listener that opens its own dialog while handling a frame would
		// otherwise have the newer snapshot delivered inside the older one, and
		// every listener after it would read a list missing a call that is open
		// — which says that call was answered.
		const target = createSession([{ content: ["done"] }]);
		const second = Promise.withResolvers<void>();
		let secondWait: Promise<void> | undefined;
		const seen: Array<string[] | undefined> = [];
		const opener = target.subscribe(event => {
			if (event.type !== "user_wait_start" || secondWait) return;
			secondWait = target.waitForUser(() => second.promise, "second", { toolCallId: "call-b" });
		});
		const observer = target.subscribe(event => {
			if (event.type === "user_wait_start") seen.push(event.toolCalls);
		});
		const first = Promise.withResolvers<void>();
		const firstWait = target.waitForUser(() => first.promise, "first", { toolCallId: "call-a" });

		expect(seen.at(-1)).toEqual(["call-a", "call-b"]);
		expect(target.activeUserWait()?.toolCalls).toEqual(["call-a", "call-b"]);

		first.resolve();
		second.resolve();
		await Promise.all([firstWait, secondWait]);
		opener();
		observer();
	});

	it("republishes the approval still open when an overlapping one is answered", async () => {
		// Two tool approvals overlap. Each publishes its own compact prompt and
		// `permission`, so answering the first emits a replacement frame naming
		// the second: a surface reporting run state never keeps the answered
		// dialog's words, and never downgrades an approval to a question.
		const target = createSession([{ content: ["done"] }]);
		const frames: Array<Record<string, unknown>> = [];
		const unsubscribe = target.subscribe(event => {
			if (event.type === "user_wait_start") frames.push({ prompt: event.prompt, kind: event.kind });
			if (event.type === "user_wait_end") frames.push({ end: true });
		});
		const first = Promise.withResolvers<"once">();
		const second = Promise.withResolvers<"once">();
		const answers = [first, second];
		const ui = trackUserWaits(
			{ approve: async () => answers.shift()!.promise } as unknown as ExtensionUIContext,
			(dialog, frame) => target.waitForUser(dialog, frame.prompt, { kind: frame.kind }),
		);

		const firstApproval = ui.approve?.({
			full: "Allow tool: bash\nCommand: echo first",
			compact: "bash: echo first",
		});
		const secondApproval = ui.approve?.({
			full: "Allow tool: bash\nCommand: echo second",
			compact: "bash: echo second",
		});
		expect(frames).toEqual([{ prompt: "bash: echo first", kind: "permission" }]);

		first.resolve("once");
		await firstApproval;
		expect(frames).toEqual([
			{ prompt: "bash: echo first", kind: "permission" },
			{ prompt: "bash: echo second", kind: "permission" },
		]);
		expect(target.activeUserWait()).toEqual({
			type: "user_wait_start",
			prompt: "bash: echo second",
			kind: "permission",
		});

		second.resolve("once");
		await secondApproval;
		unsubscribe();
		expect(frames.at(-1)).toEqual({ end: true });
		expect(target.activeUserWait()).toBeUndefined();
	});

	it("publishes which calls wait, and drops one answered behind the dialog it keeps publishing", async () => {
		// The oldest dialog is the one published, so a younger one is answered
		// without the published words ever changing. The calls waiting do change,
		// and that is the only record of it: a surface tracking a call cannot
		// read one dialog's words to learn another call's wait is over.
		const target = createSession([{ content: ["done"] }]);
		const frames: Array<Record<string, unknown>> = [];
		const unsubscribe = target.subscribe(event => {
			if (event.type === "user_wait_start") frames.push({ prompt: event.prompt, toolCalls: event.toolCalls });
			if (event.type === "user_wait_end") frames.push({ end: true });
		});
		const first = Promise.withResolvers<"once">();
		const second = Promise.withResolvers<"once">();
		const answers: Record<string, PromiseWithResolvers<"once">> = { "call-1": first, "call-2": second };
		const ui = trackUserWaits(
			{
				approve: async (prompt: { compact: string }, options: { toolCallId: string }) =>
					answers[options.toolCallId]!.promise,
			} as unknown as ExtensionUIContext,
			(dialog, frame) =>
				target.waitForUser(dialog, frame.prompt, { kind: frame.kind, toolCallId: frame.toolCallId }),
		);

		const firstApproval = ui.approve?.({ full: "first", compact: "bash: echo first" }, { toolCallId: "call-1" });
		const secondApproval = ui.approve?.({ full: "second", compact: "bash: echo second" }, { toolCallId: "call-2" });
		expect(frames).toEqual([
			{ prompt: "bash: echo first", toolCalls: ["call-1"] },
			{ prompt: "bash: echo first", toolCalls: ["call-1", "call-2"] },
		]);

		second.resolve("once");
		await secondApproval;
		expect(frames.at(-1)).toEqual({ prompt: "bash: echo first", toolCalls: ["call-1"] });

		first.resolve("once");
		await firstApproval;
		unsubscribe();
		expect(frames.at(-1)).toEqual({ end: true });
		expect(target.activeUserWait()).toBeUndefined();
	});

	it("marks no turn in a subagent, so its runs keep the grace period", async () => {
		const target = createSession([step, { content: ["done"] }], "sub");
		await target.prompt("go");
		expect(steps).toEqual([{ turn: undefined, releases: 0 }]);
		expect(releases).toEqual([]);
	});
});
