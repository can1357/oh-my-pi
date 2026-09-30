import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAsyncEnabled, cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgGoalEnabled, cfgGoalToolDefault } from "@oh-my-pi/pi-coding-agent/goals/settings";

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
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function makeSession(
		goalEnabledAtStartup: boolean,
		options?: { toolNames?: string[]; toolDefault?: boolean; restrictToolNames?: boolean },
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.instance;
		cfgAsyncEnabled.set(settings, false);
		cfgToolsXdev.set(settings, true);
		cfgGoalEnabled.set(settings, goalEnabledAtStartup);
		cfgGoalToolDefault.set(settings, options?.toolDefault ?? false);
		const { session: created } = await createAgentSession({
			toolNames: options?.toolNames,
			restrictToolNames: options?.restrictToolNames,
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

	it("does not advertise goal by default or when goal mode is disabled", async () => {
		session = await makeSession(true);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		await session.dispose();
		session = await makeSession(false, { toolNames: ["read", "goal"], toolDefault: true });
		expect(session.getEnabledToolNames()).not.toContain("goal");
	});

	it("exposes an explicitly requested goal tool without exposing it to restricted sessions", async () => {
		session = await makeSession(true, { toolNames: ["read", "goal"] });
		expect(session.getEnabledToolNames()).toContain("goal");
		await session.dispose();
		session = await makeSession(true, { toolNames: ["read", "goal"], restrictToolNames: true });
		expect(session.getEnabledToolNames()).not.toContain("goal");
	});

	it("exposes goal by default only when opted in", async () => {
		session = await makeSession(true, { toolDefault: true });
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it.each([
		["explicit --tools", false],
		["goal.toolDefault", true],
	] as const)("refuses agent-created goals while plan mode is active with %s", async (_label, toolDefault) => {
		session = await makeSession(true, toolDefault ? { toolDefault: true } : { toolNames: ["read", "goal"] });
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handlePlanModeCommand("plan a tiny task");
		expect(mode.planModeEnabled).toBe(true);
		expect(session.getEnabledToolNames()).toContain("goal");

		const goalTool = session.agent.state.tools.find(t => t.name === "goal");
		expect(goalTool).toBeDefined();
		await expect(goalTool!.execute("create", { op: "create", objective: "tiny goal" })).rejects.toThrow(
			"Exit plan mode before starting a goal.",
		);
		expect(session.getGoalModeState()).toBeUndefined();
		expect(mode.goalModeEnabled).toBe(false);
	});

	it.each([
		["explicit --tools", false],
		["goal.toolDefault", true],
	] as const)("restores %s after goal completion and drop, allowing another goal", async (_label, toolDefault) => {
		session = await makeSession(true, toolDefault ? { toolDefault: true } : { toolNames: ["read", "goal"] });
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });
		const create = async (objective: string) => {
			const goalTool = session!.agent.state.tools.find(t => t.name === "goal");
			expect(goalTool).toBeDefined();
			const result = await goalTool!.execute(objective, { op: "create", objective });
			expect(result.details?.goal?.objective).toBe(objective);
			expect(mode!.goalModeEnabled).toBe(true);
		};

		await create("first goal");
		const goalTool = session.agent.state.tools.find(t => t.name === "goal")!;
		const completed = await goalTool.execute("complete", { op: "complete" });
		expect(completed.details?.goal?.status).toBe("complete");
		const restoredAfterComplete = Promise.withResolvers<void>();
		const setActiveTools = session.setActiveToolsByName.bind(session);
		const restoration = vi.spyOn(session, "setActiveToolsByName").mockImplementation(async names => {
			await setActiveTools(names);
			restoredAfterComplete.resolve();
		});
		void mode.getUserInput();
		await restoredAfterComplete.promise;
		await Promise.resolve();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toContain("goal");

		await create("second goal");
		const restoredAfterDrop = Promise.withResolvers<void>();
		restoration.mockImplementation(async names => {
			await setActiveTools(names);
			restoredAfterDrop.resolve();
		});
		const dropped = await session.agent.state.tools.find(t => t.name === "goal")!.execute("drop", { op: "drop" });
		expect(dropped.details?.goal?.status).toBe("dropped");
		await restoredAfterDrop.promise;
		expect(mode.goalModeEnabled).toBe(false);
		expect(session.getEnabledToolNames()).toContain("goal");
		await create("third goal");
	});
});
