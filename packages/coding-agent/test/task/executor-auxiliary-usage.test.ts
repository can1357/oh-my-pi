/**
 * A subagent's returned `usage` must cover every model call journaled on its
 * session ledger during the run — including off-transcript auxiliary calls
 * (judgments, auto-thinking, cache warming) recorded as `model_usage`
 * entries, which never surface as assistant `message_end` events (#14945).
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { journalJudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "AuxUsage";
const MOCK_API_SOURCE = "test/executor-auxiliary-usage";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aux-usage-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

function usage(input: number, output: number, totalTokens: number) {
	return {
		input,
		output,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens / 1000 },
	};
}

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	tools: ["read"],
	source: "bundled",
};

/** One yield turn (11 tokens) plus one auxiliary call journaled on the child ledger (25 tokens). */
const RUN_USAGE = { input: 6, output: 24, cacheRead: 4, cacheWrite: 2, totalTokens: 36 };

it("each run returns its own auxiliary model calls journaled on the child ledger", async () => {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
			// An auxiliary model call (judgment, auto-thinking, …) made on behalf
			// of the child mid-turn: journaled on its ledger, never a transcript turn.
			const journal = journalJudgmentUsage(AgentRegistry.global().get(AGENT_ID)?.session?.sessionManager);
			if (!journal) throw new Error("child session ledger unavailable");
			journal({
				purpose: "find",
				role: "smol",
				api: "mock",
				provider: "mock",
				model: "aux-model",
				usage: usage(3, 19, 25),
				stopReason: "stop",
			});
			return {
				content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }],
				usage: usage(3, 5, 11),
			};
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const ledger = () => AgentRegistry.global().get(AGENT_ID)?.session?.sessionManager.getUsageStatistics();

	try {
		const first = await runSubprocess({
			cwd,
			artifactsDir,
			agent,
			task: "report",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(first.exitCode).toBe(0);
		expect(ledger()?.totalTokens).toBe(36);
		expect(first.usage).toMatchObject(RUN_USAGE);
		expect(first.usage?.cost.total).toBeCloseTo(0.036, 9);

		// A kept-alive follow-up reports only its own turn, not the session's lifetime spend.
		const followUp = await runSubagentFollowUpTurn({ id: AGENT_ID, agent, message: "again", artifactsDir });
		expect(followUp.exitCode).toBe(0);
		expect(ledger()?.totalTokens).toBe(72);
		expect(followUp.usage).toMatchObject(RUN_USAGE);
	} finally {
		authStorage.close();
	}
}, 15_000);
