/**
 * A subagent whose model request the session cost cap refuses must report the refusal to its
 * parent, not a generic missing-result failure (#18362).
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/subagent-cost-cap";
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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-cost-cap-"));
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
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it.each([
	{ label: "its first request", spentBefore: 3, structured: true },
	{ label: "a request after a tool call", spentBefore: 0, structured: true },
	{ label: "a message-result run's request after a tool call", spentBefore: 0, structured: false },
])(
	"reports the cost cap when the gate refuses $label",
	async ({ spentBefore, structured }) => {
		const cwd = path.join(root, "home", "work");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(cwd, "notes.txt"), "notes\n");

		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"session.maxCost": 2.5,
			modelRoles: { default: "mock/mock-model" },
		});
		const gate = new CostGate(settings, spentBefore, () => {});
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		let requests = 0;
		const mock = createMockModel({
			handler: () => {
				requests++;
				// The first wave's cost lands while this subagent's tool runs.
				gate.record(3);
				return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
			},
		});
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

		try {
			const result = await runSubprocess({
				cwd,
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: "Read notes.txt and report.",
				index: 0,
				id: "Capped",
				modelOverride: "mock/mock-model",
				parentAgentId: MAIN_AGENT_ID,
				authStorage,
				modelRegistry,
				settings,
				costGate: gate,
				structured,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			expect(requests).toBe(spentBefore > 0 ? 0 : 1);
			expect(result.exitCode).toBe(1);
			expect(result.error).toContain("Cost cap reached");
		} finally {
			authStorage.close();
		}
	},
	30_000,
);
