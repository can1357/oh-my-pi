import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

describe("per-call exact selection after background discovery", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([false, true])("holds exact selection through cold discovery (%s)", async exact => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-exact-model-"));
		const authStorage = await AuthStorage.create(":memory:");
		const sourceId = `executor-exact-model-${exact}`;
		const agentId = `ExactModel${exact}`;
		try {
			authStorage.keys.setRuntime("mock", "test-key");
			registerMockApi(sourceId);
			const model = createMockModel({
				id: "requested-model-complete",
				handler: () => ({ content: ["Exact answer."] }),
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
				provider === "mock" && id === model.id ? model : find(provider, id),
			);
			let warm = false;
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (warm ? [model] : []));
			vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
				warm = true;
			});
			const createAgentSession = sdk.createAgentSession;
			const created = vi.spyOn(sdk, "createAgentSession").mockImplementation(options => {
				warm = true;
				return createAgentSession(options);
			});
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
				projectAgentsDir: null,
			});
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.perCallModel": "on",
				"task.isolation.enabled": false,
				"compaction.enabled": false,
				modelRoles: { review: `mock/${model.id}` },
			});
			const session = {
				cwd,
				hasUI: false,
				settings,
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionAgents: () => [],
			} as unknown as ToolSession;
			const execution = runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "Answer the question.",
				agent: "worker",
				perCallModel: exact ? `mock/${model.id}` : "mock/requested-model",
				structured: false,
				identity: { id: agentId },
				keepAlive: false,
			});
			if (exact) {
				const { result } = await execution;
				expect(result.exitCode).toBe(0);
				expect(result.output).toBe("Exact answer.");
				expect(model.calls).toHaveLength(1);
				// The worker never switches models and every request stays held to the grants.
				const options = created.mock.calls[0]?.[0];
				expect(options?.disableModelFallback).toBe(true);
				expect(options?.prewalk).toBeUndefined();
				expect(() => options?.assertDispatchModel?.(createMockModel({ id: "other" }))).toThrow(/not approved/);
			} else {
				// Preflight waits for the discovery that loads the catalog, then refuses the near-miss id
				// instead of matching it fuzzily.
				await expect(execution).rejects.toThrow(/No available model matches/);
				expect(model.calls).toHaveLength(0);
			}
		} finally {
			await AgentRegistry.global().get(agentId)?.session?.dispose();
			AgentRegistry.global().unregister(agentId);
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("refuses the next request once the operator revokes the grant mid-run", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-revoked-model-"));
		const authStorage = await AuthStorage.create(":memory:");
		const sourceId = "executor-revoked-model";
		const agentId = "RevokedModel";
		try {
			authStorage.keys.setRuntime("mock", "test-key");
			registerMockApi(sourceId);
			await Bun.write(path.join(cwd, "notes.txt"), "notes");
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.perCallModel": "on",
				"task.isolation.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				modelRoles: { review: "mock/revoked-model" },
			});
			const model = createMockModel({
				id: "revoked-model",
				responses: [
					() => {
						// The operator points the only granting role elsewhere while the worker is running.
						settings.setModelRole("review", "mock/other-model");
						return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
					},
				],
				handler: () => ({ content: ["Answer after revocation."] }),
			});
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
				provider === "mock" && id === model.id ? model : find(provider, id),
			);
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [model]);
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
				projectAgentsDir: null,
			});
			const session = {
				cwd,
				hasUI: false,
				settings,
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionAgents: () => [],
			} as unknown as ToolSession;
			const execution = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "Read notes.txt, then answer.",
				agent: "worker",
				perCallModel: `mock/${model.id}`,
				structured: false,
				identity: { id: agentId },
				keepAlive: false,
			});
			// Only the request admitted before the revocation reached the model.
			expect(model.calls).toHaveLength(1);
			expect(execution.result.output).not.toContain("Answer after revocation.");
			expect(`${execution.result.error ?? ""}${execution.result.stderr}${execution.result.output}`).toMatch(
				/not approved/,
			);
		} finally {
			await AgentRegistry.global().get(agentId)?.session?.dispose();
			AgentRegistry.global().unregister(agentId);
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("walks the candidates for working credentials and never falls back", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-candidates-"));
		const authStorage = await AuthStorage.create(":memory:");
		const sourceId = "executor-candidates";
		const agentId = "Candidates";
		try {
			// Only the mock provider has credentials, so the first candidate cannot run.
			authStorage.keys.setRuntime("mock", "test-key");
			registerMockApi(sourceId);
			const locked = createMockModel({ provider: "nokey", id: "locked" });
			const open = createMockModel({ id: "open", handler: () => ({ content: ["Open answer."] }) });
			const backup = createMockModel({ id: "backup" });
			const models = [locked, open, backup];
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			vi.spyOn(modelRegistry, "find").mockImplementation(
				(provider, id) =>
					models.find(model => model.provider === provider && model.id === id) ?? find(provider, id),
			);
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
			const created = vi.spyOn(sdk, "createAgentSession");
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
				projectAgentsDir: null,
			});
			const settings = Settings.isolated({
				"task.maxRecursionDepth": 2,
				"task.perCallModel": "on",
				"task.isolation.enabled": false,
				"compaction.enabled": false,
				modelRoles: { review: "mock/open", locked: "nokey/locked" },
				"retry.fallbackChains": { review: ["mock/backup"] },
			});
			const session = {
				cwd,
				hasUI: false,
				settings,
				authStorage,
				modelRegistry,
				restrictToolNames: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionAgents: () => [],
			} as unknown as ToolSession;
			const execution = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "Answer the question.",
				agent: "worker",
				perCallModel: ["nokey/locked", "@review"],
				structured: false,
				identity: { id: agentId },
				keepAlive: false,
			});
			expect(execution.result.exitCode).toBe(0);
			expect(execution.result.output).toBe("Open answer.");
			expect(locked.calls).toHaveLength(0);
			// The role's retry chain is not a grant: the worker still never switches models.
			const options = created.mock.calls[0]?.[0];
			expect(options?.disableModelFallback).toBe(true);
			expect(() => options?.assertDispatchModel?.(backup)).toThrow(/not approved/);
		} finally {
			await AgentRegistry.global().get(agentId)?.session?.dispose();
			AgentRegistry.global().unregister(agentId);
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it.each(["off", "runtime"] as const)(
		"falls back to the role's chain model only under task.perCallModelFallbacks: %s",
		async fallbacks => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-runtime-fallback-"));
			const authStorage = await AuthStorage.create(":memory:");
			const sourceId = `executor-runtime-fallback-${fallbacks}`;
			const agentId = `RuntimeFallback${fallbacks}`;
			try {
				authStorage.keys.setRuntime("mock", "test-key");
				registerMockApi(sourceId);
				const failing = createMockModel({
					id: "failing",
					handler: () => ({ throw: "overloaded_error: provider returned error 503" }),
				});
				const backup = createMockModel({ id: "backup", handler: () => ({ content: ["Backup answer."] }) });
				const models = [failing, backup];
				const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
				const find = modelRegistry.find.bind(modelRegistry);
				vi.spyOn(modelRegistry, "find").mockImplementation(
					(provider, id) =>
						models.find(model => model.provider === provider && model.id === id) ?? find(provider, id),
				);
				vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
				const created = vi.spyOn(sdk, "createAgentSession");
				vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
					agents: [
						{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] },
					],
					projectAgentsDir: null,
				});
				const settings = Settings.isolated({
					"task.maxRecursionDepth": 2,
					"task.perCallModel": "on",
					"task.perCallModelFallbacks": fallbacks,
					"task.isolation.enabled": false,
					"compaction.enabled": false,
					"retry.baseDelayMs": 5,
					"retry.maxRetries": 1,
					modelRoles: { review: "mock/failing" },
					"retry.fallbackChains": { review: ["mock/backup"] },
				});
				const session = {
					cwd,
					hasUI: false,
					settings,
					authStorage,
					modelRegistry,
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					getSessionAgents: () => [],
				} as unknown as ToolSession;
				const execution = await runStructuredSubagent({
					session,
					invocationKind: "task",
					assignment: "Answer the question.",
					agent: "worker",
					perCallModel: "@review",
					structured: false,
					identity: { id: agentId },
					keepAlive: false,
				});
				const options = created.mock.calls[0]?.[0];
				// Context promotion never moves a per-call worker, whatever the fallback mode.
				expect(options?.disableContextPromotion).toBe(true);
				expect(options?.disableModelFallback).toBe(fallbacks === "off");
				// Even with runtime fallbacks, a model nobody configured stays out of reach.
				expect(() => options?.assertDispatchModel?.(createMockModel({ id: "other" }))).toThrow(/not approved/);
				if (fallbacks === "runtime") {
					expect(execution.result.exitCode).toBe(0);
					expect(execution.result.output).toBe("Backup answer.");
				} else {
					expect(backup.calls).toHaveLength(0);
					expect(execution.result.exitCode).not.toBe(0);
				}
			} finally {
				await AgentRegistry.global().get(agentId)?.session?.dispose();
				AgentRegistry.global().unregister(agentId);
				unregisterCustomApis(sourceId);
				authStorage.close();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it.each(["mock/failing", "mock/*"])(
		"walks the worker's own chain before a refused %s chain covering its model",
		async shadowKey => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-chain-shadow-"));
			const authStorage = await AuthStorage.create(":memory:");
			const sourceId = `executor-chain-shadow-${shadowKey}`;
			const agentId = `ChainShadow${shadowKey === "mock/*" ? "Wildcard" : "Model"}`;
			try {
				authStorage.keys.setRuntime("mock", "test-key");
				registerMockApi(sourceId);
				const failing = createMockModel({
					id: "failing",
					handler: () => ({ throw: "overloaded_error: provider returned error 503" }),
				});
				const blocked = createMockModel({ id: "blocked", handler: () => ({ content: ["Blocked answer."] }) });
				const backup = createMockModel({ id: "backup", handler: () => ({ content: ["Backup answer."] }) });
				const models = [failing, blocked, backup];
				const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
				const find = modelRegistry.find.bind(modelRegistry);
				vi.spyOn(modelRegistry, "find").mockImplementation(
					(provider, id) =>
						models.find(model => model.provider === provider && model.id === id) ?? find(provider, id),
				);
				vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
				vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
					agents: [
						{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] },
					],
					projectAgentsDir: null,
				});
				const settings = Settings.isolated({
					"task.maxRecursionDepth": 2,
					"task.perCallModel": "on",
					"task.perCallModelFallbacks": "runtime",
					"task.perCallModelAllow": ["@review", "mock/backup"],
					"task.isolation.enabled": false,
					"compaction.enabled": false,
					"retry.baseDelayMs": 5,
					"retry.maxRetries": 1,
					modelRoles: { review: "mock/failing" },
					// A model-keyed or wildcard chain outranks the role chain for the worker's model.
					"retry.fallbackChains": { review: ["mock/backup"], [shadowKey]: ["mock/blocked"] },
				});
				const session = {
					cwd,
					hasUI: false,
					settings,
					authStorage,
					modelRegistry,
					restrictToolNames: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					getSessionAgents: () => [],
				} as unknown as ToolSession;
				const execution = await runStructuredSubagent({
					session,
					invocationKind: "task",
					assignment: "Answer the question.",
					agent: "worker",
					perCallModel: "@review",
					structured: false,
					identity: { id: agentId },
					keepAlive: false,
				});
				expect(execution.result.exitCode).toBe(0);
				expect(execution.result.output).toBe("Backup answer.");
				expect(blocked.calls).toHaveLength(0);
			} finally {
				await AgentRegistry.global().get(agentId)?.session?.dispose();
				AgentRegistry.global().unregister(agentId);
				unregisterCustomApis(sourceId);
				authStorage.close();
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	);
});
