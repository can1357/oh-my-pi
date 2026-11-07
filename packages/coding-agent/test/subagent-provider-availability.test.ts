import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as dirs from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import * as availability from "../src/session/provider-exhaustion";
import { recordProviderFailure } from "../src/session/provider-exhaustion";

describe("subagent runtime fallback on a real provider error", () => {
	const MOCK_API_SOURCE = "test/issue-2750-subagent-runtime-fallback";
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
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-provider-chain-"));
		vi.spyOn(dirs, "getProviderCooldownsPath").mockReturnValue(path.join(root, "cooldowns.json"));
		// Project discovery walks up from cwd to os.homedir(); keep both inside the fake HOME.
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
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
		// The child opened agent.db and models.db under root; Windows cannot delete open files.
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	/**
	 * Spawns a real `pinned-worker` child whose role shares the `default` model. The primary
	 * fails every request with a retryable error; `default`'s chain names a fallback that yields.
	 */
	async function runPinnedWorker(
		id: string,
		roleChain: string[] | undefined,
		mode:
			| "excluded"
			| "quota"
			| "race"
			| "all"
			| "all-midrun"
			| "billing"
			| "expired-billing"
			| "recovered-billing" = "quota",
	) {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("primary", "test-key");
		authStorage.keys.setRuntime("fallback", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const exclusion = availability.providerExhaustionExclusion;
		vi.spyOn(availability, "providerExhaustionExclusion").mockImplementation(provider => {
			const result = exclusion(provider);
			if (result && process.env.QUOTA_TRACE)
				process.stderr.write(`${new Error("excluded provider lookup").stack}\n`);
			return result;
		});
		const primary = createMockModel({
			provider: "primary",
			id: "bad-runtime-model",
			handler: () => ({ throw: '{"error":{"code":"quota_exceeded"}}' }),
		});
		const fallback = createMockModel({
			provider: "fallback",
			id: "working-model",
			handler: context =>
				context.messages.at(-1)?.role === "toolResult"
					? { content: ["ok"] }
					: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "recovered" } }] },
		});
		const billing = mode === "billing" || mode === "expired-billing" || mode === "recovered-billing";
		let billingRequests = 0;
		const server = billing
			? Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					fetch() {
						billingRequests++;
						return Response.json(
							{
								error: {
									message: "Billing account is not in good standing",
									type: "billing_error",
									param: "insufficient_credits",
								},
							},
							{ status: 402 },
						);
					},
				})
			: undefined;
		const billingModel = { ...primary, api: "openai-completions" as const, baseUrl: server?.url.href ?? "" };
		const mocks = [billing ? billingModel : primary, fallback];
		if (mode === "expired-billing" || mode === "recovered-billing") {
			recordProviderFailure(
				"primary",
				{ status: 402, type: "billing_error", code: "insufficient_credits" },
				Date.now() - 2 * availability.PROVIDER_EXHAUSTION_COOLDOWN_MS,
			);
			await availability.probeUnavailableProviders(async () => ({ available: mode === "recovered-billing" }));
		}
		if (mode === "excluded" || mode === "all") recordProviderFailure("primary", { code: "quota_exceeded" });
		if (mode === "all" || mode === "all-midrun") recordProviderFailure("fallback", { status: 401 });
		const originalKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			if (mode === "race" && args[0].provider === "primary") {
				recordProviderFailure("primary", { code: "quota_exceeded" });
			}
			return originalKey(...args);
		});
		const find = modelRegistry.find.bind(modelRegistry);
		vi.spyOn(modelRegistry, "find").mockImplementation(
			(provider, modelId) => mocks.find(m => m.provider === provider && m.id === modelId) ?? find(provider, modelId),
		);
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(
			provider => mocks.some(m => m.provider === provider) || hasProvider(provider),
		);
		const available = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...available(kind)]);
		try {
			const result = await runSubprocess({
				cwd: path.join(root, "home", "work"),
				agent: {
					name: "pinned-worker",
					description: "test",
					systemPrompt: "test",
					tools: ["read"],
					source: "bundled",
					model: ["@pinned-worker"],
				},
				task: "work",
				index: 0,
				id,
				modelOverride: ["primary/bad-runtime-model"],
				modelRole: "pinned-worker",
				authStorage,
				modelRegistry,
				settings: Settings.isolated({
					"task.agentIdleTtlMs": 0,
					"compaction.enabled": false,
					"retry.baseDelayMs": 1,
					"retry.modelFallback": false,
					"retry.enabled": !billing && mode !== "quota" && mode !== "all-midrun",
					"retry.maxRetries": 2,
					"todo.enabled": false,
					"todo.reminders": false,
					"advisor.enabled": false,
					modelRoles: {
						default: "primary/bad-runtime-model",
						"pinned-worker": "primary/bad-runtime-model",
					},
					"retry.fallbackChains": {
						default: ["fallback/working-model"],
						...(roleChain ? { "pinned-worker": roleChain } : {}),
					},
				}),
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			return {
				result,
				primaryRequests: billing ? billingRequests : primary.calls.length,
				fallbackRequests: fallback.calls.length,
			};
		} finally {
			server?.stop(true);
			authStorage.close();
		}
	}

	for (const mode of ["excluded", "quota", "race", "billing", "expired-billing", "recovered-billing"] as const) {
		it(`${mode}: a pinned worker continues on its configured chain without a profile switch`, async () => {
			const { result, primaryRequests, fallbackRequests } = await runPinnedWorker(mode, undefined, mode);
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(result.resolvedModel).toBe("fallback/working-model");
			expect(primaryRequests).toBe(["quota", "billing", "recovered-billing"].includes(mode) ? 1 : 0);
			expect(fallbackRequests).toBeGreaterThan(0);
		});
	}
	for (const mode of ["all", "all-midrun"] as const) {
		it(`${mode}: reports the exhausted chain once with provider recovery times`, async () => {
			const { result, fallbackRequests } = await runPinnedWorker(mode, undefined, mode);
			expect(result.exitCode).toBe(1);
			const notice = JSON.parse(result.error!);
			expect(notice.code).toBe("provider_chain_unavailable");
			expect(notice.providers.map((entry: { provider: string }) => entry.provider).sort()).toEqual([
				"fallback",
				"primary",
			]);
			expect(notice.providers.every((entry: { until: number }) => entry.until > Date.now())).toBe(true);
			expect(fallbackRequests).toBe(0);
		});
	}
});
