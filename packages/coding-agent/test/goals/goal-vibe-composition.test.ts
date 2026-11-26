/**
 * Contracts: goal mode combined with vibe mode (director + persistent workers
 * driven by a persistent objective).
 *
 * 1. Goal and vibe compose in either entry order; the director keeps the goal
 *    tool alongside the vibe toolset.
 * 2. While combined, the journal's latest mode_change is the vibe entry and it
 *    carries goal state (latest-wins journal: one record rehydrates both).
 * 3. Exiting vibe pauses an active goal and journals a bare goal_paused tail;
 *    the goal tool and vibe tools both leave the active set.
 * 4. Goal continuation stays quiet while a vibe worker turn is in flight —
 *    worker result delivery owns waking the director.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "../../src/ui/theme/service";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { aggregateVibeWorkerUsage, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createModeTerminal } from "../helpers/mode-terminal";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function lastModeChange(manager: SessionManager) {
	return manager.getEntries().findLast(entry => entry.type === "mode_change");
}

function flushMacroTaskQueue(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

async function flushMicrotasks(): Promise<void> {
	// Deterministic under fake timers: let queued promise callbacks settle so a
	// fired continuation tick is observed before asserting it was dropped.
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

async function armInputWaiter(mode: InteractiveMode): Promise<{
	inputPromise: Promise<void>;
	getResolvedInput: () => SubmittedUserInput | undefined;
}> {
	let resolvedInput: SubmittedUserInput | undefined;
	const inputPromise = mode.getUserInput().then(input => {
		resolvedInput = input;
	});
	// getUserInput resolves its promise only after onInputCallback fires; the
	// scheduler needs the waiter armed synchronously, so flush once it is.
	await Promise.resolve();
	return {
		inputPromise,
		getResolvedInput: () => resolvedInput,
	};
}

describe("goal + vibe composition", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		initTheme();
		tempDir = TempDir.createSync("@pi-goal-vibe-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		streamFn = (_model, _context) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			});
			return stream;
		};

		const settings = Settings.isolated({ "goal.enabled": true });
		const registryTools = [stubTool("read"), stubTool("todo")];
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool] as const));
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: (...args) => {
					if (!streamFn) throw new Error("No test stream configured");
					return streamFn(...args);
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry,
			builtInToolNames: [...toolRegistry.keys()],
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		// The goal tool needs the session's live goal runtime; register it into
		// the shared registry map after the session exists (sdk.ts pattern).
		toolRegistry.set(
			"goal",
			new GoalTool({
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
				getGoalModeState: () => session.getGoalModeState(),
				getGoalRuntime: () => session.goalRuntime,
			}) as unknown as AgentTool,
		);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			new EventBus(),
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("enters goal while vibe is active and keeps the goal tool in the director set", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);

		await mode.handleGoalModeCommand("Ship the refactor");
		expect(mode.goalModeEnabled).toBe(true);
		const active = session.getActiveToolNames();
		expect(active).toContain("goal");
		for (const name of VIBE_TOOL_NAMES) {
			expect(active).toContain(name);
		}
		expect(active).toContain("read");

		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("vibe");
		expect(tail?.data?.goalEnabled).toBe(true);
		const goal = tail?.data?.goal as { objective?: string } | undefined;
		expect(goal?.objective).toBe("Ship the refactor");
	});

	it("enters vibe while goal is active and keeps the goal tool", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleGoalModeCommand("Ship the refactor");
		expect(mode.goalModeEnabled).toBe(true);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(mode.goalModeEnabled).toBe(true);
		const active = session.getActiveToolNames();
		expect(active).toContain("goal");
		for (const name of VIBE_TOOL_NAMES) {
			expect(active).toContain(name);
		}

		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("vibe");
		const goal = tail?.data?.goal as { objective?: string } | undefined;
		expect(goal?.objective).toBe("Ship the refactor");
	});

	it("exiting vibe pauses the goal and journals a bare goal_paused tail", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(mode.goalModeEnabled).toBe(false);
		expect(mode.goalModePaused).toBe(true);

		const active = session.getActiveToolNames();
		expect(active).not.toContain("goal");
		for (const name of VIBE_TOOL_NAMES) {
			expect(active).not.toContain(name);
		}

		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("goal_paused");
		const goal = tail?.data?.goal as { status?: string } | undefined;
		expect(goal?.status).toBe("paused");
	});

	it("goal continuation stays silent while a worker turn is in flight, then fires with the vibe prompt", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");
		expect(mode.goalModeEnabled).toBe(true);

		const inFlight = vi.spyOn(VibeSessionRegistry.global(), "hasInFlightTurns").mockReturnValue(true);

		// Worker in flight: the armed 800ms continuation timer must produce no
		// submission at all — delivery owns waking the director.
		vi.useFakeTimers();
		let waiter = await armInputWaiter(mode);
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(waiter.getResolvedInput()).toBeUndefined();
		const cleanup = waiter.getResolvedInput() ?? mode.startPendingSubmission({ text: "cleanup" });
		mode.onInputCallback?.(cleanup);
		await waiter.inputPromise;
		// Release the reservation so the next scheduler pass is not blocked.
		mode.finishPendingSubmission(cleanup);
		vi.useRealTimers();

		// All workers idle: the continuation fires and carries the vibe variant.
		inFlight.mockReturnValue(false);
		vi.useFakeTimers();
		waiter = await armInputWaiter(mode);
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		vi.useRealTimers();
		const input = waiter.getResolvedInput();
		expect(input?.customType).toBe("goal-continuation");
		expect(input?.text).toContain("Ship the refactor");
		expect(input?.text).toContain("read/todo/vibe tools only");
		expect(input?.text).toContain("vibe_send");
		expect(input?.text).not.toContain("run commands/tests");
		const drain = input ?? mode.startPendingSubmission({ text: "cleanup" });
		mode.onInputCallback?.(drain);
		await waiter.inputPromise;
		mode.finishPendingSubmission(drain);
	});

	it("entering vibe while a goal is paused keeps the objective on the vibe journal entry", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleGoalModeCommand("Ship the refactor");
		await session.goalRuntime.pauseGoal();
		expect(mode.goalModePaused).toBe(true);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(mode.goalModeEnabled).toBe(false);

		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("vibe");
		expect(tail?.data?.goalEnabled).toBe(false);
		const goal = tail?.data?.goal as { objective?: string; status?: string } | undefined;
		expect(goal?.objective).toBe("Ship the refactor");
		expect(goal?.status).toBe("paused");
	});

	it("does not re-charge worker spend when a paused goal resumes and vibe starts again", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");

		const registry = VibeSessionRegistry.global();
		registry.registerRecordForTests({
			id: "w-spent",
			ownerId: MAIN_AGENT_ID,
			state: "dead",
			usage: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const spent = registry.listWorkerRecordsByOwner(MAIN_AGENT_ID).find(record => record.id === "w-spent");
		if (spent) {
			spent.killed = true;
			spent.terminalPersisted = true;
		}

		const before = session.getGoalModeState()?.goal.tokensUsed ?? 0;
		await session.goalRuntime.flushUsage("suppressed");
		expect((session.getGoalModeState()?.goal.tokensUsed ?? 0) - before).toBe(80);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(mode.goalModePaused).toBe(true);
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});

		const pausedUsed = session.getGoalModeState()?.goal.tokensUsed ?? 0;
		await mode.handleGoalModeCommand("resume");
		expect(mode.goalModeEnabled).toBe(true);
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		await session.goalRuntime.flushUsage("suppressed");
		expect(session.getGoalModeState()?.goal.tokensUsed).toBe(pausedUsed);

		registry.registerRecordForTests({
			id: "w-new",
			ownerId: MAIN_AGENT_ID,
			state: "idle",
			usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		await session.goalRuntime.flushUsage("suppressed");
		expect(session.getGoalModeState()?.goal.tokensUsed).toBe(pausedUsed + 5);
	});

	it("preserves an already-paused goal when exiting vibe", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");
		await session.goalRuntime.pauseGoal();
		await mode.handleVibeModeCommand();

		expect(mode.vibeModeEnabled).toBe(false);
		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("goal_paused");
		const goal = tail?.data?.goal as { status?: string } | undefined;
		expect(goal?.status).toBe("paused");
	});

	it("journals the vibe carrier when the goal completes inside vibe", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");

		await session.goalRuntime.completeGoalFromTool();
		// The goal's mode is "exiting"; the next agent_end tears it down the way
		// #handleGoalSessionEvent does in the live TUI.
		await session.prompt("wrap up");
		await flushMacroTaskQueue();

		const tail = lastModeChange(session.sessionManager);
		expect(tail?.mode).toBe("vibe");
		expect(tail?.data?.goal).toBeUndefined();
		expect(mode.vibeModeEnabled).toBe(true);
	});
});
