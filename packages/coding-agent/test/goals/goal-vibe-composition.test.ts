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
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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

describe("goal + vibe composition", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		await initTheme();
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
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
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

	it("goal continuation does not fire while a vibe worker turn is in flight", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await mode.handleGoalModeCommand("Ship the refactor");
		expect(mode.goalModeEnabled).toBe(true);

		const buildPrompt = vi.spyOn(session.goalRuntime, "buildContinuationPrompt");
		const inFlight = vi.spyOn(VibeSessionRegistry.global(), "hasInFlightTurns").mockReturnValue(true);

		// A settled director turn asks for continuation scheduling; with a worker
		// turn in flight the scheduler must not even build a continuation prompt.
		await session.prompt("direct the workers");
		await flushMacroTaskQueue();
		expect(buildPrompt).not.toHaveBeenCalled();

		inFlight.mockReturnValue(false);
		await session.prompt("check on the workers");
		await flushMacroTaskQueue();
		expect(buildPrompt.mock.calls.every(([options]) => options?.vibe === true)).toBe(true);
	});
});
