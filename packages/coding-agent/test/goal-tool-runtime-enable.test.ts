import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAsyncEnabled, cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgGoalEnabled, cfgGoalToolDefault } from "@oh-my-pi/pi-coding-agent/goals/settings";

describe("goal tool registration when goal mode is enabled at runtime", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-repro-9444-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function makeSession(
		goalEnabledAtStartup: boolean,
		options: Pick<CreateAgentSessionOptions, "toolNames" | "restrictToolNames" | "taskDepth"> = {},
		toolDefault = false,
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.instance;
		cfgAsyncEnabled.set(settings, false);
		cfgToolsXdev.set(settings, true);
		cfgGoalEnabled.set(settings, goalEnabledAtStartup);
		cfgGoalToolDefault.set(settings, toolDefault);
		const { session: created } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
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
			...options,
		});
		return created;
	}

	/** Mirror InteractiveMode.#enterGoalMode's tool operations. */
	async function enterGoalMode(s: AgentSession): Promise<void> {
		const previousTools = s.getEnabledToolNames().filter(n => n !== "goal");
		const state = await s.goalRuntime.createGoal({ objective: "test goal" });
		await s.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		s.setGoalModeState(state);
	}

	it("creates a goal through xd://goal before goal mode is active", async () => {
		session = await makeSession(true, {}, true);
		expect(session.getGoalModeState()).toBeUndefined();

		const writeTool = session.agent.state.tools.find(t => t.name === "write");
		if (!writeTool) throw new Error("Expected write tool to be active");
		await writeTool.execute("call_goal_create", {
			path: "xd://goal",
			content: JSON.stringify({ op: "create", objective: "Ship the release" }),
		} as never);

		expect(session.getGoalModeState()).toMatchObject({
			enabled: true,
			goal: { objective: "Ship the release", status: "active" },
		});
	});

	it("keeps creation hidden by default while pre-registering manual goal support", async () => {
		session = await makeSession(true);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.getMountedXdevToolNames()).not.toContain("goal");
		expect(session.getToolByName("goal")).toBeDefined();
	});

	it("honors an explicit goal selection without the default opt-in", async () => {
		session = await makeSession(true, { toolNames: ["read", "goal"] });
		expect(session.getEnabledToolNames()).toContain("goal");
		const goal = session.agent.state.tools.find(tool => tool.name === "goal");
		expect(goal).toBeDefined();
		await goal!.execute("explicit_create", { op: "create", objective: "Explicit goal" } as never);
		expect(session.getGoalModeState()?.goal.objective).toBe("Explicit goal");
	});

	it.each([
		{ name: "empty", options: { toolNames: [] } },
		{ name: "read-only", options: { toolNames: ["read"] } },
		{ name: "restricted", options: { toolNames: ["read", "goal"], restrictToolNames: true } },
		{ name: "child", options: { taskDepth: 1 } },
	])("does not widen $name selections when the default opt-in is enabled", async ({ options }) => {
		session = await makeSession(true, { ...options, toolNames: options.toolNames?.slice() }, true);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		await session.reconcileBuiltinTools();
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.getMountedXdevToolNames()).not.toContain("goal");
	});

	it("re-offers opted-in creation after stable terminal cleanup even if the tool was already registered", async () => {
		session = await makeSession(true, {}, true);
		await session.goalRuntime.createGoal({ objective: "Finish and create again" });
		await session.goalRuntime.completeGoalFromTool();
		await session.reconcileBuiltinTools();
		expect(session.getEnabledToolNames()).not.toContain("goal");
		session.setGoalModeState(undefined);
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("keeps paused goals hidden until the host resumes, then re-offers creation after drop", async () => {
		session = await makeSession(true, {}, true);
		await session.goalRuntime.createGoal({ objective: "Pause me" });
		await session.goalRuntime.pauseGoal();
		await session.reconcileBuiltinTools();
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.getMountedXdevToolNames()).not.toContain("goal");
		await session.goalRuntime.resumeGoal();
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getEnabledToolNames()).toContain("goal");
		await session.goalRuntime.dropGoal();
		await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("can register controls for an active host-restored goal even when creation starts disabled", async () => {
		session = await makeSession(false);
		expect(session.getToolByName("goal")).toBeUndefined();
		// Host restoration establishes the active runtime before reconciling tools.
		await session.goalRuntime.createGoal({ objective: "Persisted active goal" });
		await session.reconcileBuiltinTools();
		expect(session.getEnabledToolNames()).toContain("goal");
		const write = session.agent.state.tools.find(tool => tool.name === "write");
		expect(write).toBeDefined();
		const result = await write!.execute("restored_get", {
			path: "xd://goal",
			content: JSON.stringify({ op: "get" }),
		} as never);
		expect(result.isError ?? false).toBe(false);
		await session.goalRuntime.pauseGoal();
		await session.reconcileBuiltinTools({ refreshPrompt: false });
		expect(session.getEnabledToolNames()).not.toContain("goal");
	});

	it("exposes the goal tool when goal.enabled is set at startup", async () => {
		session = await makeSession(true);
		await enterGoalMode(session);
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("exposes the goal tool when goal.enabled is turned on after session start", async () => {
		// Regression for #9444: enabling goal mode at runtime (settings UI / config
		// reload) left the tool registry without `goal`, so entering goal mode
		// silently dropped the name and `xd://goal` failed with "No such tool".
		session = await makeSession(false);
		cfgGoalEnabled.set(Settings.instance, true);

		await enterGoalMode(session);

		expect(session.getEnabledToolNames()).toContain("goal");

		// The failing path in the report: a real xd://goal dispatch via the write
		// transport must now resolve the tool instead of throwing.
		const writeTool = session.agent.state.tools.find(t => t.name === "write");
		expect(writeTool).toBeDefined();
		const result = await writeTool!.execute("call_goal", {
			path: "xd://goal",
			content: JSON.stringify({ op: "get" }),
		} as never);
		expect(result.isError ?? false).toBe(false);
		const text = result.content?.map(c => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
		expect(text).toContain("test goal");
	});
});
