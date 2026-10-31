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
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
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
 * model and leaves the request to session creation. `parent` is the parent's
 * model: keyed, on a provider keyless by design (a local server, which reports
 * `kNoAuth`), or absent, as for a prepared seance, which passes no parent.
 *
 * `declaredKey` says why the declared model cannot serve the child: its key
 * resolves to nothing (`"none"`), or a working process-wide key exists but the
 * child's `task.agentAccountPools` entry permits no account on that provider
 * (`"pooled-out-of-reach"`), which rejects the child's lookup.
 */
async function spawnWithoutCredentials(
	fallbackChains: Record<string, string[]>,
	listed: boolean,
	parent: "keyed" | "keyless" | "absent" = "keyed",
	declaredKey: "none" | "pooled-out-of-reach" = "none",
): Promise<{ result: SingleResult; parentCalls: number; spawnIdStillPooled: boolean }> {
	// Under the isolated HOME, so project discovery stops at os.homedir().
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	// A process-wide key the parent resolves; only the child's pool shuts it out.
	if (declaredKey === "pooled-out-of-reach") authStorage.keys.setRuntime("mistral", "mistral-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const parentModel = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const declared = getBundledModel("mistral", "mistral-large-latest");
	if (!declared) throw new Error("Expected the bundled mistral model");
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [
		parentModel,
		...(listed ? [declared] : []),
		...catalogAvailable(kind),
	]);
	const catalogAll = modelRegistry.getAll.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(kind => [parentModel, ...catalogAll(kind)]);
	const resolveKey = modelRegistry.getApiKey.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, ...rest) => {
		if (model.provider === "mistral" && declaredKey === "none") return Promise.resolve(undefined);
		if (parent === "keyless" && model.provider === parentModel.provider) return Promise.resolve(kNoAuth);
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
			oauthAccountPools: declaredKey === "pooled-out-of-reach" ? { mistral: [] } : undefined,
			modelOverride: DECLARED,
			parentActiveModelPattern: parent === "absent" ? undefined : `${parentModel.provider}/${parentModel.id}`,
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
		return {
			result,
			parentCalls: parentModel.calls.length,
			// A restriction the pre-flight left on the spawn id keeps rejecting that
			// id's lookups; lifted, the process-wide key resolves again.
			spawnIdStillPooled: await resolveKey(declared, "Unavailable").then(
				() => false,
				() => true,
			),
		};
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
	const { result, parentCalls } = await spawnWithoutCredentials({ [DECLARED]: [] }, true, "keyless");

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain(`retry.fallbackChains["${DECLARED}"] is empty`);
	expect(parentCalls).toBe(0);
}, 30_000);

it("serves from the declared model's own chain when the parent's provider is keyless", async () => {
	const { result } = await spawnWithoutCredentials({ [DECLARED]: ["mock/mock-model"] }, true, "keyless");

	expect(result.exitCode).toBe(0);
	expect(result.resolvedModel).toBe("mock/mock-model");
	expect(result.resolvedModelIsFallback).toBe(true);
	expect(result.resolvedModelFallbackReason).toContain(`retry.fallbackChains["${DECLARED}"] chose the replacement`);
}, 30_000);

it("refuses the spawn under an empty own chain when no parent model is passed, as for a seance", async () => {
	const { result, parentCalls } = await spawnWithoutCredentials({ [DECLARED]: [] }, true, "absent");

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain(`retry.fallbackChains["${DECLARED}"] is empty`);
	expect(parentCalls).toBe(0);
}, 30_000);

it("serves from the declared model's own chain when no parent model is passed, as for a seance", async () => {
	const { result } = await spawnWithoutCredentials({ [DECLARED]: ["mock/mock-model"] }, true, "absent");

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

it("carries the substitution into the task result a reader gets, not only the settled fields", async () => {
	// The settled fields the tests above assert, and `formatTaskResultSummary`'s
	// own hand-built fixtures, each pass while the wiring between them is broken.
	// This envelope is the parent's only record that a model other than the one
	// it dispatched answered: lose `served`, `requested` or the reason here and a
	// substituted run reads as the model the agent names, with nothing in the
	// child's own artifact to contradict it.
	const { result } = await spawnWithoutCredentials({}, false);

	const summary = formatTaskResultSummary(result, { totalDurationMs: 5 });
	const line = /<model\b[^>]*>(?:([\s\S]*?)<\/model>)?/.exec(summary);
	expect(line?.[0]).toContain('fallback="true"');
	expect(line?.[0]).toContain('served="mock/mock-model"');
	expect(line?.[0]).toContain(`requested="${DECLARED}"`);
	expect(line?.[1]).toContain("has no working credentials");
}, 30_000);

it("refuses the spawn under an empty own chain when only the child's account pool shuts the declared model out", async () => {
	// The process-wide key works, so dispatch's pre-flight must ask under the
	// child's pool; otherwise it hands over a concrete model with no chain
	// fallback and the child's first prompt dies on its pooled key lookup.
	const { result, parentCalls, spawnIdStillPooled } = await spawnWithoutCredentials(
		{ [DECLARED]: [] },
		true,
		"keyed",
		"pooled-out-of-reach",
	);

	expect(result.exitCode).not.toBe(0);
	expect(result.error).toContain(`retry.fallbackChains["${DECLARED}"] is empty`);
	expect(parentCalls).toBe(0);
	// A restriction left on the spawn id would pool the next spawn that reuses it.
	expect(spawnIdStillPooled).toBe(false);
}, 30_000);

it("serves from the declared model's own chain when only the child's account pool shuts it out", async () => {
	const { result } = await spawnWithoutCredentials(
		{ [DECLARED]: ["mock/mock-model"] },
		true,
		"keyed",
		"pooled-out-of-reach",
	);

	expect(result.exitCode).toBe(0);
	expect(result.resolvedModel).toBe("mock/mock-model");
	expect(result.resolvedModelIsFallback).toBe(true);
	expect(result.resolvedModelFallbackReason).toContain(`retry.fallbackChains["${DECLARED}"] chose the replacement`);
}, 30_000);
