import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentEndEvent, SessionStopEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

/**
 * Regression coverage for the wake-source gate shared by the stop-time passes
 * of loop-end routing: a background async job (bash/task) owned by this agent
 * re-wakes the run when it completes — its result delivery enqueues an
 * async-result follow-up that continues the run, and the stop-time passes
 * re-run at that loop's end. A text-only stop with such a job in flight pauses
 * the run instead of ending it, so both:
 *
 * - the todo reminder (`todo_reminder` event + injected `<system-reminder>`
 *   continuation in `#checkTodoCompletion`) stays silent and defers to the
 *   settle reached once the session is fully idle, while
 * - the `session_stop` extension hook pass (`#emitSessionStopEvent`) RUNS at
 *   the pause — every settle the user sees must be judged — flagged with
 *   `awaiting_async_work: true` so hooks can tell a scheduling pause from a
 *   terminal stop. A `block`/`continue` result there must NOT schedule a
 *   hidden continuation: that would start a second agent loop racing the
 *   async-result delivery. Scheduling defers to the next settle, which
 *   re-runs the pass, so the block reason reaches the agent exactly once.
 *
 * The contract these tests defend:
 * 1. A running job owned by this session's `agentId` (delivery not
 *    suppressed) defers the reminder: no `todo_reminder` event, no scheduled
 *    `agent.continue`.
 * 2. Jobs owned by a DIFFERENT agent do not defer — the stop still fires
 *    reminder attempt 1.
 * 3. The deferral is temporary: once the owned job completes and its
 *    delivery drains, the next text-only stop fires the reminder.
 * 4. With no incomplete todos at all, the same running owned job still runs
 *    the `session_stop` hook pass at the pause, once, with
 *    `awaiting_async_work: true` on the payload.
 * 5. The pass re-runs at the settle after the job drains, unflagged, so a
 *    pause settle and its terminal successor are each judged exactly once.
 * 6. A `block` at the pause is judged but schedules nothing; the reason is
 *    delivered by the single hidden continuation scheduled at the terminal
 *    settle — exactly once, with no second loop racing the async delivery.
 *
 * Negative assertions rely on `session.waitForIdle()` being deterministic
 * here: the agent's synchronous `#emit` invokes the session's `agent_end`
 * handler, which registers itself as a tracked post-prompt task BEFORE its
 * first await, and anything it schedules (e.g. `agent.continue`) is tracked
 * the same way — so once `waitForIdle()` resolves, the settle has definitively
 * decided whether to fire the stop-time passes. No wall-clock sleeps needed.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession todo reminder async-job deferral", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let manager: AsyncJobManager;
	let extensionRunner: ExtensionRunner;
	let extensionEnds: AgentEndEvent[];
	let gates: Array<PromiseWithResolvers<string>>;
	let reminderAttempts: number[];
	/** `yielded` of every `agent_pause`. */
	let pauses: boolean[];
	let agentEnds: number;
	/** Result the session_stop mock returns; undefined means "no hook feedback". */
	let sessionStopResult: SessionStopEventResult | undefined;

	function textOnlyAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused at your instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Register a job that stays running until the returned resolver fires. */
	function registerGatedJob(ownerId: string): { resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", `gated job owned by ${ownerId}`, async () => await gate.promise, { ownerId });
		return { resolve: () => gate.resolve("done") };
	}

	/** Give the session incomplete todos so the stop-time reminder is armed. */
	function setIncompleteTodos(): void {
		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-reminder-async-jobs-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		manager = new AsyncJobManager({});
		gates = [];
		extensionEnds = [];
		sessionStopResult = undefined;
		extensionRunner = {
			emit: vi.fn(async (event: ExtensionEvent) => {
				if (event.type === "agent_end") extensionEnds.push(event);
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(async () => sessionStopResult),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 3,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [new TodoTool(toolSession)],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});
		// Override the session's self-registered sink with a no-op: these tests
		// exercise the async-wake deferral gates, not result injection.
		manager.registerDeliverySink("Main", () => {});

		reminderAttempts = [];
		pauses = [];
		agentEnds = 0;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
			if (event.type === "agent_pause") pauses.push(event.yielded);
			if (event.type === "agent_end") agentEnds++;
		});
	});

	afterEach(async () => {
		// Unblock any still-gated job body so the manager can settle promptly.
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("defers the reminder while an owned async job is running", async () => {
		setIncompleteTodos();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(continueSpy).not.toHaveBeenCalled();
		// The model yielded and only the job's result can resume the run: it pauses, open.
		expect(pauses).toEqual([true]);
		expect(agentEnds).toBe(0);
		expect(session.isRunActive).toBe(true);
		expect(session.wakeSources?.jobs).toHaveLength(1);
		// Extensions keep their per-loop agent_end: this one continues, waiting on background work.
		expect(extensionEnds).toEqual([expect.objectContaining({ willContinue: true, awaitingAsyncWork: true })]);
	});

	it("does not defer for a running job owned by a different agent", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("OtherAgent");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		// The reminder is the agent's own continuation: the loop pauses without yielding. The
		// mocked continue never starts a loop, so nothing is left and the run ends once.
		expect(pauses).toEqual([false]);
		expect(agentEnds).toBe(1);
		// Extensions see the continuing loop, then the run's end.
		expect(extensionEnds.map(event => event.willContinue)).toEqual([true, undefined]);
		expect(extensionEnds[0]).not.toHaveProperty("awaitingAsyncWork");
	});

	it("fires the reminder on the next stop once the owned job completes and its delivery drains", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// While the job runs, the stop stays silent.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([]);

		// Complete the job and drain its result delivery — nothing is left to
		// re-wake the loop, so the deferral must lift.
		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
	});

	it("runs the session_stop hook pass with awaiting_async_work while an owned async job is running", async () => {
		// No todo phases: the stop reaches the session_stop pass directly, with
		// only the async-wake gate distinguishing this pause from a terminal stop.
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledWith(
			expect.objectContaining({ awaiting_async_work: true }),
		);
		// The settle is still a scheduling pause: the hook judged it but
		// scheduled nothing, and the notification still says the async
		// delivery resumes the run.
		expect(extensionEnds).toEqual([expect.objectContaining({ willContinue: true, awaitingAsyncWork: true })]);
	});

	it("re-runs the session_stop pass at the settle after the owned job drains", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// Judged while the job is in flight, flagged as a scheduling pause.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledWith(
			expect.objectContaining({ awaiting_async_work: true }),
		);

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		// The next stop is a terminal settle: the pass runs again, unflagged,
		// so both settles were judged — each exactly once.
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(2);
		expect(extensionRunner.emitSessionStop).toHaveBeenLastCalledWith(
			expect.objectContaining({ awaiting_async_work: false }),
		);
	});

	it("delivers a session_stop block exactly once and never races the async delivery", async () => {
		// The hook blocks every settle it judges; only where the block's
		// hidden continuation is scheduled matters here.
		sessionStopResult = { decision: "block", reason: "finish the plan" };
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const job = registerGatedJob("Main");

		// Pause settle: judged, but a block here must not start a second agent
		// loop that races the async-result delivery still going to re-wake the run.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		// The terminal settle schedules the single hidden continuation, which
		// delivers the block reason to the agent exactly once.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(2);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const prompted = promptSpy.mock.calls.flatMap(call => (Array.isArray(call[0]) ? call[0] : [call[0]]));
		const continuations = prompted.filter(
			message => message.role === "custom" && (message as CustomMessage).customType === "session-stop-continuation",
		);
		expect(continuations).toHaveLength(1);
		expect((continuations[0] as CustomMessage).content).toContain("finish the plan");
	});
});
