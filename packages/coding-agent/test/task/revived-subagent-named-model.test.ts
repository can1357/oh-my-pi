/**
 * With `task.namedModelFallback` off, a subagent whose model a selector named is held to its own list: its
 * session walks only its `subagent:<id>` chain, with context promotion and server-side fallback off. A parked
 * subagent is rebuilt on a warm revive, so the rebuild must carry the hold its spawn had, or the revived agent
 * walks the configured chains it was held from. The first test reads the rebuild's options; the second runs the
 * revived agent onto a failing model. (Cold revival is covered in `persisted-revive.test.ts`.)
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
import { localSession } from "../helpers/local-session";

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

it.each([
	["off", false, false],
	["at its default", true, true],
] as const)(
	"with task.namedModelFallback %s, a warm-revived worker whose named model fails reaches a model its list does not name only at the default",
	async (_label, namedModelFallback, reachesOther) => {
		const cwd = path.join(root, "home", "work");
		const artifactsDir = path.join(root, "artifacts");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		authStorage.keys.setRuntime("other", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		let namedFails = false;
		const named = createMockModel({
			handler: context =>
				namedFails
					? { throw: "overloaded_error: provider returned error 503" }
					: context.messages.at(-1)?.role === "toolResult"
						? { content: ["ack"] }
						: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] },
		});
		// Not in the worker's list; only the model-keyed chain below names it.
		const other = createMockModel({
			provider: "other",
			id: "other-model",
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["ack"] }
					: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] },
		});
		const models = [named, other];
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...models, ...catalogAvailable(kind)]);
		const find = modelRegistry.find.bind(modelRegistry);
		vi.spyOn(modelRegistry, "find").mockImplementation(
			(provider, modelId) =>
				models.find(m => m.provider === provider && m.id === modelId) ?? find(provider, modelId),
		);
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(
			provider => models.some(m => m.provider === provider) || hasProvider(provider),
		);
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
					"task.agentIdleTtlMs": 0,
					"task.namedModelFallback": namedModelFallback,
					"retry.baseDelayMs": 1,
					"retry.maxRetries": 1,
					"retry.fallbackChains": { "mock/mock-model": ["other/other-model"] },
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
			expect(other.calls).toHaveLength(0);
			await AgentLifecycleManager.global().park(AGENT_ID);

			namedFails = true;
			const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
			await revived.prompt("report done again");
			// A retry or fallback turn runs after `prompt` returns.
			await revived.waitForIdle();
			expect(named.calls.length).toBeGreaterThan(1);
			expect(other.calls.length > 0).toBe(reachesOther);
		} finally {
			authStorage.close();
		}
	},
	30_000,
);
