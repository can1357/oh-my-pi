import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression coverage for the `#hasPendingAsyncWake()` gate shared by the
 * stop-time passes in the `agent_end` settle path: a background async job
 * (bash/task) owned by this agent re-wakes the loop when it completes — its
 * result delivery enqueues an async-result follow-up that continues the run,
 * and the stop-time passes re-run at that settle. A text-only stop with such a
 * job in flight is a scheduling pause, not a terminal stop, so both:
 *
 * - the todo reminder (`todo_reminder` event + injected `<system-reminder>`
 *   continuation in `#checkTodoCompletion`), and
 * - the `session_stop` extension hook pass (`#emitSessionStopEvent`)
 *
 * must stay silent and defer to the settle reached once the session is fully
 * idle.
 *
 * The contract these tests defend:
 * 1. A running job owned by this session's `agentId` (delivery not
 *    suppressed) defers the reminder: no `todo_reminder` event, no scheduled
 *    `agent.continue`.
 * 2. Jobs owned by a DIFFERENT agent do not defer — the stop still fires
 *    reminder attempt 1.
 * 3. The deferral is temporary: once the owned job completes and its delivery
 *    drains, the next text-only stop fires the reminder.
 * 4. With no incomplete todos at all, the same running owned job still defers
 *    the `session_stop` hook pass.
 * 5. That deferral lifts too: after the job completes and its delivery
 *    drains, the next stop invokes `session_stop` exactly once.
 *
 * Negative assertions rely on `session.waitForIdle()` being deterministic
 * here: the agent's synchronous `#emit` invokes the session's `agent_end`
 * handler, which registers itself as a tracked post-prompt task BEFORE its
 * first await, and anything it schedules (e.g. `agent.continue`) is tracked
 * the same way — so once `waitForIdle()` resolves, the settle has definitively
 * decided whether to fire the stop-time passes. No wall-clock sleeps needed.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
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
	let gates: Array<PromiseWithResolvers<string>>;
	let reminderAttempts: number[];
	let agentEndTerminalStates: Array<boolean | undefined>;

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
		extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry: sharedModelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});
		// Override the session's self-registered sink with a no-op: these tests
		// exercise the async-wake deferral gates, not result injection.
		manager.registerDeliverySink("Main", () => {});

		reminderAttempts = [];
		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(
					(event as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal?: boolean }).isTerminal,
				);
			}
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
		expect(agentEndTerminalStates).toEqual([false]);
	});

	it("does not defer for a running job owned by a different agent", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("OtherAgent");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
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

	it("defers the session_stop hook pass while an owned async job is running", async () => {
		// No todo phases: the stop reaches the session_stop pass directly, and
		// only the async-wake gate can defer it.
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
	});

	it("invokes session_stop exactly once on the next stop after the owned job drains", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// Deferred while the job is in flight.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});
