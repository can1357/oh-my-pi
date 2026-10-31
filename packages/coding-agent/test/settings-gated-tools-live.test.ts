import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgGoalEnabled, cfgGoalToolDefault } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { cfgGithubEnabled, cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(settings: Settings, toolNames?: string[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({});
		cfgGrepEnabled.set(settings, false);
		cfgGithubEnabled.set(settings, false);
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		expect(cfgGrepEnabled.get(settings)).toBe(true);
		expect(cfgGithubEnabled.get(settings)).toBe(true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});

	it.each([
		{ name: "goal.toolDefault", gate: cfgGoalToolDefault },
		{ name: "goal.enabled", gate: cfgGoalEnabled },
	])("reconciles $name in both directions without losing lazy registration", async ({ gate }) => {
		const settings = Settings.isolated({ "tools.xdev": true });
		cfgGoalEnabled.set(settings, true);
		cfgGoalToolDefault.set(settings, true);
		gate.set(settings, false);
		expect(gate.get(settings)).toBe(false);
		const session = await startSession(settings);
		expect(session.getEnabledToolNames()).not.toContain("goal");

		gate.set(settings, true);
		expect(gate.get(settings)).toBe(true);
		await settle(session);
		expect(session.getEnabledToolNames()).toContain("goal");

		gate.set(settings, false);
		expect(gate.get(settings)).toBe(false);
		await settle(session);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.getMountedXdevToolNames()).not.toContain("goal");
		// Keep the hidden registry entry so /goal still has an activation path.
		expect(session.getToolByName("goal")).toBeDefined();

		gate.set(settings, true);
		expect(gate.get(settings)).toBe(true);
		await settle(session);
		expect(session.getEnabledToolNames()).toContain("goal");
		const write = session.agent.state.tools.find(tool => tool.name === "write");
		expect(write).toBeDefined();
		await write!.execute("live_create", {
			path: "xd://goal",
			content: JSON.stringify({ op: "create", objective: "Live policy goal" }),
		} as never);
		expect(session.getGoalModeState()?.goal.objective).toBe("Live policy goal");
	});

	it.each([{ toolNames: [] }, { toolNames: ["read"] }])(
		"keeps explicit $toolNames narrow across live goal toggles",
		async ({ toolNames }) => {
			const settings = Settings.isolated({});
			cfgGoalEnabled.set(settings, false);
			cfgGoalToolDefault.set(settings, false);
			const session = await startSession(settings, toolNames.slice());
			cfgGoalEnabled.set(settings, true);
			cfgGoalToolDefault.set(settings, true);
			expect(cfgGoalEnabled.get(settings)).toBe(true);
			expect(cfgGoalToolDefault.get(settings)).toBe(true);
			await settle(session);
			expect(session.getEnabledToolNames()).not.toContain("goal");
			expect(session.getMountedXdevToolNames()).not.toContain("goal");
		},
	);

	it("restores explicit goal selection on feature enable without enabling the default policy", async () => {
		const settings = Settings.isolated({ "goal.toolDefault": false });
		cfgGoalEnabled.set(settings, false);
		const session = await startSession(settings, ["read", "goal"]);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		cfgGoalEnabled.set(settings, true);
		expect(cfgGoalEnabled.get(settings)).toBe(true);
		await settle(session);
		expect(session.getEnabledToolNames()).toContain("goal");
		cfgGoalEnabled.set(settings, false);
		expect(cfgGoalEnabled.get(settings)).toBe(false);
		await settle(session);
		expect(session.getEnabledToolNames()).not.toContain("goal");
		cfgGoalEnabled.set(settings, true);
		expect(cfgGoalEnabled.get(settings)).toBe(true);
		await settle(session);
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it.each(["complete", "drop"] as const)(
		"retains active controls after creation is disabled and hides creation after %s",
		async operation => {
			const settings = Settings.isolated({ "tools.xdev": true });
			cfgGoalToolDefault.set(settings, true);
			const session = await startSession(settings);
			await session.goalRuntime.createGoal({ objective: "Manage after disable" });
			cfgGoalToolDefault.set(settings, false);
			expect(cfgGoalToolDefault.get(settings)).toBe(false);
			await settle(session);
			expect(session.getEnabledToolNames()).toContain("goal");
			cfgGoalEnabled.set(settings, false);
			expect(cfgGoalEnabled.get(settings)).toBe(false);
			await settle(session);
			expect(session.getEnabledToolNames()).toContain("goal");
			expect(session.getGoalModeState()).toMatchObject({
				enabled: true,
				goal: { objective: "Manage after disable", status: "active" },
			});
			const write = session.agent.state.tools.find(tool => tool.name === "write");
			expect(write).toBeDefined();
			const get = await write!.execute("disabled_get", {
				path: "xd://goal",
				content: JSON.stringify({ op: "get" }),
			} as never);
			expect(get.isError ?? false).toBe(false);
			const result = await write!.execute("disabled_terminal", {
				path: "xd://goal",
				content: JSON.stringify({ op: operation }),
			} as never);
			expect(result.isError ?? false).toBe(false);
			if (operation === "complete") session.setGoalModeState(undefined);
			await session.reconcileBuiltinTools();
			expect(session.getEnabledToolNames()).not.toContain("goal");
			expect(session.getMountedXdevToolNames()).not.toContain("goal");
		},
	);
});
