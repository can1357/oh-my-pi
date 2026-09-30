import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
		["complete", "complete"],
		["drop", "dropped"],
	] as const)("keeps an opted-in goal tool available after %s", async (op, status) => {
		session = await makeSession(true, op === "complete" ? { toolNames: ["read", "goal"] } : { toolDefault: true });
		const goalTool = session.agent.state.tools.find(t => t.name === "goal");
		expect(goalTool).toBeDefined();
		await goalTool!.execute("create", { op: "create", objective: "small goal" });
		const result = await goalTool!.execute("finish", { op });
		expect(result.details?.goal?.status).toBe(status);
		if (op === "complete") session.setGoalModeState(undefined);
		await session.setActiveToolsByName(session.getEnabledToolNames());
		const activeGoalTool = session.agent.state.tools.find(t => t.name === "goal");
		expect(activeGoalTool).toBeDefined();
		const next = await activeGoalTool!.execute("new_goal", { op: "create", objective: "next goal" });
		expect(next.details?.goal?.objective).toBe("next goal");
	});
});
