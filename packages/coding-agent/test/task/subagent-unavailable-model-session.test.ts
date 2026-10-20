/**
 * A task spawn whose declared model has no working credentials, run end to end:
 * the real executor hands the choice to session creation, which applies the
 * model's own `retry.fallbackChains` entry, and the task result says what served.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/subagent-unavailable-model-session";
const DECLARED = "mistral/mistral-large-latest";

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unavailable-model-"));
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

/**
 * Spawns an agent declaring `DECLARED`, whose key does not work, from a parent
 * on the keyed mock model. `listed` puts the declared model among the
 * registry's available models (a key is configured but does not resolve), so
 * dispatch finds it and sees the failed key itself; unlisted, dispatch finds no
 * model and leaves the request to session creation. `keylessParent` makes the
 * parent's provider keyless by design (a local server), as `kNoAuth` reports it.
 */
async function spawnWithoutCredentials(
	fallbackChains: Record<string, string[]>,
	listed: boolean,
	keylessParent = false,
): Promise<{ result: SingleResult; parentCalls: number }> {
	// Under the isolated HOME, so project discovery stops at os.homedir().
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const parent = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const declared = getBundledModel("mistral", "mistral-large-latest");
	if (!declared) throw new Error("Expected the bundled mistral model");
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [
		parent,
		...(listed ? [declared] : []),
		...catalogAvailable(kind),
	]);
	const catalogAll = modelRegistry.getAll.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(kind => [parent, ...catalogAll(kind)]);
	const resolveKey = modelRegistry.getApiKey.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, ...rest) => {
		if (model.provider === "mistral") return Promise.resolve(undefined);
		if (keylessParent && model.provider === parent.provider) return Promise.resolve(kNoAuth);
		return resolveKey(model, ...rest);
	});
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "astra-api", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: "Unavailable",
			modelOverride: DECLARED,
			parentActiveModelPattern: `${parent.provider}/${parent.id}`,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				"retry.fallbackChains": fallbackChains,
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		return { result, parentCalls: parent.calls.length };
	} finally {
		authStorage.close();
	}
}

it("refuses the spawn when the declared model's own chain is empty, without calling any model", async () => {
	// Listed: dispatch itself finds the declared model's key failing.
	const { result, parentCalls } = await spawnWithoutCredentials({ [DECLARED]: [] }, true);

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain(`retry.fallbackChains["${DECLARED}"] is empty`);
	expect(parentCalls).toBe(0);
}, 30_000);

it("refuses the spawn under an empty own chain when the parent's provider is keyless", async () => {
	// Listed with a failing key, and the parent cannot stand in for it: the
	// declared model's own chain still decides at spawn.
	const { result, parentCalls } = await spawnWithoutCredentials({ [DECLARED]: [] }, true, true);

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain(`retry.fallbackChains["${DECLARED}"] is empty`);
	expect(parentCalls).toBe(0);
}, 30_000);

it("serves from the declared model's own chain when the parent's provider is keyless", async () => {
	const { result } = await spawnWithoutCredentials({ [DECLARED]: ["mock/mock-model"] }, true, true);

	expect(result.exitCode).toBe(0);
	expect(result.resolvedModel).toBe("mock/mock-model");
	expect(result.resolvedModelIsFallback).toBe(true);
	expect(result.resolvedModelFallbackReason).toContain(`retry.fallbackChains["${DECLARED}"] chose the replacement`);
}, 30_000);

it("runs on the parent's model and says so when no chain key owns the declared model", async () => {
	// Unlisted: dispatch finds no model, and session creation finds the key failing.
	const { result, parentCalls } = await spawnWithoutCredentials({}, false);

	expect(result.exitCode).toBe(0);
	expect(parentCalls).toBeGreaterThan(0);
	expect(result.resolvedModel).toBe("mock/mock-model");
	expect(result.resolvedModelIsFallback).toBe(true);
	expect(result.resolvedModelFallbackReason).toContain(`Fallback: ${DECLARED} -> mock/mock-model`);
}, 30_000);
