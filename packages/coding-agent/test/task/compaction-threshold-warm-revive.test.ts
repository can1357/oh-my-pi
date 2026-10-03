/**
 * A parked subagent spawned with a `task.agentCompactionThresholdOverrides` entry must revive with
 * that entry still outranking `compaction.modelThresholds`; its own children carry no entry and
 * resolve their model match.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { compactionSettingsForModel } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { createSubagentSettings, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "WarmThreshold";
const MOCK_API_SOURCE = "test/compaction-threshold-warm-revive";
const WINDOW = 200_000;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-threshold-warm-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

it("revives a parked subagent with its agent threshold ahead of model thresholds", async () => {
	const cwd = path.join(root, "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		contextWindow: WINDOW,
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			compactionThresholdOverride: { thresholdPercent: 25, thresholdTokens: -1 },
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				"compaction.thresholdPercent": 80,
				"compaction.modelThresholds": { "mock/*": 120_000 },
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);

		await AgentLifecycleManager.global().park(AGENT_ID);
		const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
		const model = revived.model;
		if (!model) throw new Error("Expected the revived subagent to have a model");

		expect(resolveThresholdTokens(WINDOW, compactionSettingsForModel(revived.settings, model))).toBe(50_000);
		const grandchild = createSubagentSettings(revived.settings);
		expect(resolveThresholdTokens(WINDOW, compactionSettingsForModel(grandchild, model))).toBe(120_000);
	} finally {
		authStorage.close();
	}
}, 30_000);
