import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
			// Available but named by no role: dispatch refuses it as unapproved, not as unavailable.
			const unapproved = createMockModel({ id: "other" });
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const find = modelRegistry.find.bind(modelRegistry);
			vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
				provider === "mock" && id === model.id ? model : find(provider, id),
			);
			let warm = false;
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (warm ? [model, unapproved] : []));
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
			const execution = await runStructuredSubagent({
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
				expect(execution.result.exitCode).toBe(0);
				expect(execution.result.output).toBe("Exact answer.");
				expect(model.calls).toHaveLength(1);
				// The worker never switches models and every request stays held to the grants.
				const options = created.mock.calls[0]?.[0];
				expect(options?.disableModelFallback).toBe(true);
				expect(options?.disableServerSideFallback).toBe(true);
				expect(options?.prewalk).toBeUndefined();
				expect(() => options?.assertDispatchModel?.(unapproved)).toThrow(/not approved/);
				expect(() => options?.assertDispatchModel?.(createMockModel({ id: "missing" }))).toThrow(
					/not an available chat model/,
				);
			} else {
				expect(model.calls).toHaveLength(0);
				expect(execution.result.exitCode).not.toBe(0);
				expect(`${execution.result.error ?? ""}${execution.result.stderr}`).toMatch(/exact model|unavailable/);
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

	it.each([
		{ label: "clamps a :high selector to task.maxEffort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		{ label: "fails a model whose lowest effort is above task.maxEffort", efforts: [Effort.High] },
	])("$label on the running worker", async ({ efforts }) => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-effort-ceiling-"));
		const authStorage = await AuthStorage.create(":memory:");
		const sourceId = `executor-effort-ceiling-${efforts.length}`;
		const agentId = `EffortCeiling${efforts.length}`;
		try {
			authStorage.keys.setRuntime("mock", "test-key");
			registerMockApi(sourceId);
			const model = Object.assign(
				createMockModel({ id: "laddered", reasoning: true, handler: () => ({ content: ["Capped answer."] }) }),
				{ thinking: { mode: "effort", efforts } satisfies ThinkingConfig },
			);
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
				settings: Settings.isolated({
					"task.maxRecursionDepth": 2,
					"task.perCallModel": "on",
					"task.maxEffort": "low",
					"task.isolation.enabled": false,
					"compaction.enabled": false,
					modelRoles: { review: `mock/${model.id}` },
				}),
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
				perCallModel: `mock/${model.id}:high`,
				structured: false,
				identity: { id: agentId },
				keepAlive: false,
			});
			if (efforts.length > 1) {
				expect(execution.result.exitCode).toBe(0);
				// The request the provider receives runs at the ceiling, not the requested `:high`.
				expect(model.calls.map(call => call.options?.reasoning)).toEqual([Effort.Low]);
			} else {
				expect(model.calls).toHaveLength(0);
				expect(execution.result.exitCode).not.toBe(0);
				expect(`${execution.result.error ?? ""}${execution.result.stderr}`).toMatch(
					/no supported thinking effort at or below task\.maxEffort=low/,
				);
			}
		} finally {
			await AgentRegistry.global().get(agentId)?.session?.dispose();
			AgentRegistry.global().unregister(agentId);
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it.each([
		{ id: "coding-router", selector: "mock/coding-router:low", identity: "mock/coding-router", level: Effort.Low },
		{
			id: "coding-router:low",
			selector: "mock/coding-router:low:high",
			identity: "mock/coding-router:low",
			level: Effort.High,
		},
	])("persists $selector as separate identity and thinking fields", async ({ id, selector, identity, level }) => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-per-call-identity-"));
		const authStorage = await AuthStorage.create(":memory:");
		const sourceId = `executor-per-call-identity-${id}`;
		const agentId = `PerCallIdentity${id.length}`;
		try {
			authStorage.keys.setRuntime("mock", "test-key");
			registerMockApi(sourceId);
			const model = Object.assign(
				createMockModel({ id, reasoning: true, handler: () => ({ content: ["Persisted."] }) }),
				{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig },
			);
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [model]);
			vi.spyOn(modelRegistry, "getAll").mockImplementation(() => [model]);
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
				projectAgentsDir: null,
			});
			const init = vi.spyOn(SessionManager.prototype, "appendSessionInit");
			const session = {
				cwd,
				hasUI: false,
				settings: Settings.isolated({
					"task.maxRecursionDepth": 2,
					"task.perCallModel": "on",
					"task.maxEffort": "high",
					"task.isolation.enabled": false,
					"compaction.enabled": false,
					modelRoles: { review: `mock/${id}` },
				}),
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
				perCallModel: selector,
				structured: false,
				identity: { id: agentId },
				keepAlive: false,
			});
			expect(execution.result.exitCode).toBe(0);
			expect(init.mock.calls[0]?.[0]).toMatchObject({
				perCallModel: true,
				perCallModelIdentity: identity,
				perCallThinkingLevel: level,
			});
		} finally {
			await AgentRegistry.global().get(agentId)?.session?.dispose();
			AgentRegistry.global().unregister(agentId);
			unregisterCustomApis(sourceId);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
