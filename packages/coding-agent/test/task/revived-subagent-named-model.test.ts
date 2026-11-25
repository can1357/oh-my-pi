/**
 * With `task.namedModelFallback` off, a subagent whose model a selector named is held to its own list: its
 * session walks only its `subagent:<id>` chain, with context promotion and server-side fallback off. A parked
 * subagent is rebuilt on a warm revive, so the rebuild must carry the hold its spawn had, or the revived agent
 * walks the configured chains it was held from. (Cold revival is covered in `persisted-revive.test.ts`.)
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
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "HeldWarm";
const MOCK_API_SOURCE = "test/revived-subagent-named-model";
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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-named-model-"));
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

/** Runs `AGENT_ID` on the named model `mock/mock-model` to a finished keep-alive state, then parks it. */
async function spawnAndPark(namedModelFallback: boolean): Promise<void> {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			context.messages.at(-1)?.role === "toolResult"
				? { content: ["ack"] }
				: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "report done",
			description: "test",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the test parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"task.namedModelFallback": namedModelFallback,
				"async.enabled": false,
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
		await AgentLifecycleManager.global().park(AGENT_ID);
	} finally {
		authStorage.close();
	}
}

it.each([
	["off", false, `subagent:${AGENT_ID}`],
	["at its default", true, undefined],
] as const)(
	"with task.namedModelFallback %s, a warm revive builds on the hold its spawn had",
	async (_label, namedModelFallback, heldRole) => {
		const createAgentSession = vi.spyOn(sdkModule, "createAgentSession");
		await spawnAndPark(namedModelFallback);
		await AgentLifecycleManager.global().ensureLive(AGENT_ID);

		const builds = createAgentSession.mock.calls.flatMap(([options]) =>
			options?.agentId === AGENT_ID ? [options.exclusiveRetryFallbackRole] : [],
		);
		// The spawn's session, then the warm revive's rebuild.
		expect(builds).toEqual([heldRole, heldRole]);
	},
	30_000,
);
