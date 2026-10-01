import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAsyncEnabled, cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { cfgEvalJs } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgProvidersOpenaiCodexCodeMode } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";

async function waitForMicrotasks(): Promise<void> {
	// getUserInput awaits its internal promise before the observer's .then runs.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("goal tool registration when goal mode is enabled at runtime", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-repro-9444-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function makeSession(
		goalEnabledAtStartup: boolean,
		options?: { restricted?: boolean; codeMode?: boolean; xdev?: boolean; sessionManager?: SessionManager },
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = options?.sessionManager ?? SessionManager.inMemory(tempDir.path());
		const settings = Settings.instance;
		cfgAsyncEnabled.set(settings, false);
		cfgToolsXdev.set(settings, options?.xdev ?? true);
		cfgGoalEnabled.set(settings, goalEnabledAtStartup);
		if (options?.codeMode) {
			cfgProvidersOpenaiCodexCodeMode.set(settings, "auto");
			cfgEvalJs.set(settings, true);
		}
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const { session: created } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model: options?.codeMode
				? { ...model, provider: "openai-codex", api: "openai-codex-responses", toolMode: "code_mode_only" }
				: model,
			restrictToolNames: options?.restricted,
			toolNames: options?.restricted ? ["read", "goal"] : undefined,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return created;
	}

	it("exposes the goal tool when goal.enabled is set at startup", async () => {
		session = await makeSession(true);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("exposes the goal tool when goal.enabled is turned on after session start", async () => {
		// Regression for #9444: enabling goal mode at runtime (settings UI / config
		// reload) left the tool registry without `goal`, so entering goal mode
		// silently dropped the name and `xd://goal` failed with "No such tool".
		session = await makeSession(false);
		cfgGoalEnabled.set(Settings.instance, true);

		await session.reconcileBuiltinTools();

		expect(session.getEnabledToolNames()).toContain("goal");

		// The failing path in the report: a real xd://goal dispatch via the write
		// transport must now resolve the tool instead of throwing.
		const writeTool = session.agent.state.tools.find(t => t.name === "write");
		expect(writeTool).toBeDefined();
		const result = await writeTool!.execute("call_goal", {
			path: "xd://goal",
			content: JSON.stringify({ op: "create", objective: "test goal" }),
		} as never);
		expect(result.isError ?? false).toBe(false);
		expect(session.getGoalModeState()?.goal.objective).toBe("test goal");
		expect(session.getGoalModeState()?.goal.status).toBe("active");
	});

	for (const initiallyPaused of [false, true]) {
		it(`stops ${initiallyPaused ? "paused" : "active"} Goal execution before hot disable and requires explicit resume`, async () => {
			session = await makeSession(true);
			initTheme();
			mode = new InteractiveMode(session, "test");
			vi.spyOn(vcs, "repo").mockReturnValue(null);
			vi.spyOn(vcs, "git").mockReturnValue(null);
			await mode.init({ suppressWelcomeIntro: true });
			await session.goalRuntime.createGoal({ objective: "Ship safely", tokenBudget: 100 });
			if (initiallyPaused) await session.goalRuntime.pauseGoal();
			const goalId = session.getGoalModeState()!.goal.id;
			session.goalRuntime.onTurnStart("in-flight", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			vi.useFakeTimers();
			let submitted: SubmittedUserInput | undefined;
			const input = mode.getUserInput().then(value => {
				submitted = value;
			});
			cfgGoalEnabled.set(Settings.instance, false);
			await session.reconcileBuiltinTools();
			expect(session.getEnabledToolNames()).not.toContain("goal");
			expect(session.getGoalModeState()).toMatchObject({ enabled: false, goal: { id: goalId, status: "paused" } });
			expect(mode.goalModeEnabled).toBe(false);
			expect(mode.goalModePaused).toBe(true);
			expect(session.goalRuntime.buildActivePrompt()).toBeUndefined();
			expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
			const paused = structuredClone(session.getGoalModeState());
			await session.goalRuntime.onAgentEnd({
				currentUsage: { input: 500, output: 500, cacheWrite: 500, cacheRead: 500 },
			});
			expect(session.getGoalModeState()).toEqual(paused);
			vi.advanceTimersByTime(800);
			await waitForMicrotasks();
			expect(submitted).toBeUndefined();
			cfgGoalEnabled.set(Settings.instance, true);
			await session.reconcileBuiltinTools();
			expect(session.getEnabledToolNames()).toContain("goal");
			expect(session.getGoalModeState()).toEqual(paused);
			vi.advanceTimersByTime(800);
			await waitForMicrotasks();
			expect(submitted).toBeUndefined();
			await mode.handleGoalModeCommand("resume");
			expect(session.getGoalModeState()?.goal.status).toBe("active");
			vi.advanceTimersByTime(800);
			await input;
			expect(submitted?.customType).toBe("goal-continuation");
		});
	}

	it("rejects SDK and interactive starts after explicit removal without changing the selection", async () => {
		session = await makeSession(true);
		initTheme();
		mode = new InteractiveMode(session, "test");
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		await session.setActiveToolsByName(["read"]);
		const selected = session.getEnabledToolNames();
		await expect(session.goalRuntime.createGoal({ objective: "No permission" })).rejects.toThrow();
		expect(await mode.handleGoalModeCommand("No permission")).toBe(false);
		expect(await mode.handleGuidedGoalCommand("No permission")).toBe(false);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(mode.isGuidedGoalInterviewActive()).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(session.getEnabledToolNames()).toEqual(selected);
		await session.setActiveToolsByName([...selected, "goal"]);
		expect(await mode.handleGuidedGoalCommand("Ship safely")).toBe(true);
		await mode.handleGoalModeCommand("Ship safely");
		await mode.handleGoalModeCommand("pause");
		const paused = structuredClone(session.getGoalModeState());
		await session.setActiveToolsByName(selected);
		await expect(session.goalRuntime.resumeGoal()).rejects.toThrow();
		await mode.handleGoalModeCommand("resume");
		expect(session.getGoalModeState()).toEqual(paused);
		expect(session.getEnabledToolNames()).toEqual(selected);
		await session.setActiveToolsByName([...selected, "goal"]);
		await mode.handleGoalModeCommand("resume");
		expect(session.getGoalModeState()?.goal.status).toBe("active");
	});

	it("withdraws queued Goal work before revocation without rewriting history or unrelated input", async () => {
		session = await makeSession(true);
		await session.goalRuntime.createGoal({ objective: "Ship safely" });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const historical = {
			role: "custom" as const,
			customType: "goal-mode-context",
			content: "Delivered goal context",
			display: false,
			timestamp: 1,
		};
		session.agent.replaceMessages([historical]);
		const user = { role: "user" as const, content: "Unrelated work", timestamp: 2 };
		session.agent.steer({ ...historical, customType: "goal-budget-limit" });
		session.agent.followUp({ ...historical, customType: "goal-continuation" });
		session.agent.followUp(user);
		let pausedBeforeRevocation = false;
		const unsubscribe = session.subscribe(event => {
			if (event.type === "goal_updated" && event.state?.goal.status === "paused") {
				pausedBeforeRevocation = session!.getEnabledToolNames().includes("goal");
			}
		});
		cfgGoalEnabled.set(Settings.instance, false);
		await session.reconcileBuiltinTools();
		unsubscribe();
		expect(pausedBeforeRevocation).toBe(true);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.peekFollowUpQueue()).toEqual([user]);
		expect(session.agent.state.messages).toEqual([historical]);
		expect(session.getEnabledToolNames()).not.toContain("goal");
	});

	it("preserves terminal Goal states across capability changes", async () => {
		session = await makeSession(true);
		await session.goalRuntime.createGoal({ objective: "Ship safely" });
		await session.goalRuntime.completeGoalFromTool();
		const completed = structuredClone(session.getGoalModeState());
		cfgGoalEnabled.set(Settings.instance, false);
		await session.reconcileBuiltinTools();
		cfgGoalEnabled.set(Settings.instance, true);
		await session.reconcileBuiltinTools();
		expect(session.getGoalModeState()).toEqual(completed);
		await session.goalRuntime.dropGoal();
		cfgGoalEnabled.set(Settings.instance, false);
		await session.reconcileBuiltinTools();
		cfgGoalEnabled.set(Settings.instance, true);
		await session.reconcileBuiltinTools();
		expect(session.getGoalModeState()).toBeUndefined();
	});

	it("honors live SDK Plan and Vibe states as well as paused Plan history", async () => {
		session = await makeSession(true);
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		await expect(session.goalRuntime.createGoal({ objective: "Blocked" })).rejects.toThrow();
		session.setPlanModeState(undefined);
		session.setVibeModeState({ enabled: true });
		await expect(session.goalRuntime.createGoal({ objective: "Blocked" })).rejects.toThrow();
		session.setVibeModeState(undefined);
		session.sessionManager.appendModeChange("plan_paused");
		await expect(session.goalRuntime.createGoal({ objective: "Blocked" })).rejects.toThrow();
		expect(session.getGoalModeState()).toBeUndefined();
		session.sessionManager.appendModeChange("none");
		await session.goalRuntime.createGoal({ objective: "Allowed" });
		await session.goalRuntime.pauseGoal();
		session.setVibeModeState({ enabled: true });
		await expect(session.goalRuntime.resumeGoal()).rejects.toThrow();
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		session.setVibeModeState(undefined);
		await session.goalRuntime.resumeGoal();
		expect(session.getGoalModeState()?.goal.status).toBe("active");
	});

	it("keeps schemas, ordering and static system stable throughout the Goal lifecycle", async () => {
		session = await makeSession(true);
		const enabled = session.getEnabledToolNames();
		const tools = session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		const system = [...session.agent.state.systemPrompt];
		await session.goalRuntime.createGoal({ objective: "Ship safely" });
		for (const transition of [
			() => session!.goalRuntime.pauseGoal(),
			() => session!.goalRuntime.resumeGoal(),
			() => session!.goalRuntime.completeGoalFromTool(),
			() => session!.goalRuntime.dropGoal(),
		]) {
			await transition();
			expect(session.getEnabledToolNames()).toEqual(enabled);
			expect(
				session.agent.state.tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			).toEqual(tools);
			expect(session.agent.state.systemPrompt).toEqual(system);
		}
	});

	it("restores a disabled Goal as paused without widening the selected tools", async () => {
		session = await makeSession(true, {
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		});
		await session.goalRuntime.createGoal({ objective: "Persisted work" });
		const goalId = session.getGoalModeState()!.goal.id;
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await session.dispose();
		// Disposal seals the old manager and releases its journal; cold restore
		// must read the durable Goal through a new manager, not reuse that object.
		const sessionManager = await SessionManager.open(sessionFile, tempDir.path());
		session = await makeSession(false, { sessionManager });
		await session.setActiveToolsByName(["read"]);
		const selected = session.getEnabledToolNames();
		initTheme();
		mode = new InteractiveMode(session, "test");
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		vi.spyOn(vcs, "git").mockReturnValue(null);
		await mode.init({ suppressWelcomeIntro: true });
		expect(session.getGoalModeState()).toMatchObject({ enabled: false, goal: { id: goalId, status: "paused" } });
		expect(mode.goalModePaused).toBe(true);
		expect(session.getEnabledToolNames()).toEqual(selected);
		expect(session.goalRuntime.buildActivePrompt()).toBeUndefined();
	});

	it("clears Goal and interview state on a real SDK new-session transition", async () => {
		session = await makeSession(true);
		initTheme();
		mode = new InteractiveMode(session, "test");
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		vi.spyOn(vcs, "git").mockReturnValue(null);
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(session, "prompt").mockResolvedValue(true);
		const enabled = session.getEnabledToolNames();
		await mode.handleGuidedGoalCommand("Old interview");
		expect(mode.isGuidedGoalInterviewActive()).toBe(true);
		await session.newSession();
		expect(mode.isGuidedGoalInterviewActive()).toBe(false);
		await session.goalRuntime.createGoal({ objective: "Old goal" });
		await session.newSession();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(mode.goalModeEnabled).toBe(false);
		expect(mode.goalModePaused).toBe(false);
		expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(enabled);
	});

	it("keeps restricted sessions denied even when Goal is explicitly requested", async () => {
		session = await makeSession(true, { restricted: true });
		expect(session.getEnabledToolNames()).not.toContain("goal");
		await expect(session.goalRuntime.createGoal({ objective: "Denied" })).rejects.toThrow();
		expect(session.getGoalModeState()).toBeUndefined();
		await session.setActiveToolsByName(["read", "goal"]);
		expect(session.getEnabledToolNames()).not.toContain("goal");
	});

	it("preserves Code Mode bridge reachability without advertising a native Goal declaration", async () => {
		session = await makeSession(true, { codeMode: true });
		expect(session.getEnabledToolNames()).toContain("goal");
		expect(session.getActiveToolNames()).not.toContain("goal");
		const goal = session.getToolForEvalBridge("goal");
		expect(goal).toBeDefined();
		await goal!.execute("goal-create", { op: "create", objective: "Bridge work" });
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		await session.goalRuntime.pauseGoal();
		await session.setActiveToolsByName(["eval", "read"]);
		expect(session.getToolForEvalBridge("goal")).toBeUndefined();
		await expect(session.goalRuntime.resumeGoal()).rejects.toThrow();
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
	});
});
