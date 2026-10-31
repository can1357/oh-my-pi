import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
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

const perCallSettings = (model: Model, extra: Record<string, unknown> = {}) =>
	Settings.isolated({
		"task.maxRecursionDepth": 2,
		"task.perCallModel": "on",
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		modelRoles: { review: `mock/${model.id}` },
		...extra,
	});

const cleanups: (() => Promise<void>)[] = [];
let runs = 0;

/** Runs a bundled `worker` through the real executor against the supplied catalog. */
async function runWorker(options: {
	model: Model;
	models?: Model[];
	perCallModel: string | string[];
	settings?: Settings;
	assignment?: string;
	setup?: (modelRegistry: ModelRegistry) => void;
}) {
	const { model } = options;
	const models = options.models ?? [model];
	const run = ++runs;
	const sourceId = `executor-exact-model-${run}`;
	const agentId = `ExactModel${run}`;
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-exact-model-"));
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(async () => {
		await AgentRegistry.global().get(agentId)?.session?.dispose();
		AgentRegistry.global().unregister(agentId);
		unregisterCustomApis(sourceId);
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	authStorage.keys.setRuntime("mock", "test-key");
	registerMockApi(sourceId);
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation(
		(provider, id) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id) ?? find(provider, id),
	);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => models);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => models);
	options.setup?.(modelRegistry);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
		projectAgentsDir: null,
	});
	const session = {
		cwd,
		hasUI: false,
		settings: options.settings ?? perCallSettings(model),
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
		assignment: options.assignment ?? "Answer the question.",
		agent: "worker",
		perCallModel: options.perCallModel,
		structured: false,
		identity: { id: agentId },
		keepAlive: false,
	});
	return execution.result;
}

const failure = (result: { error?: string; stderr: string; output: string }) =>
	`${result.error ?? ""}${result.stderr}${result.output}`;

describe("per-call exact selection after background discovery", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	it.each([false, true])("holds exact selection through cold discovery (%s)", async exact => {
		const model = createMockModel({
			id: "requested-model-complete",
			handler: () => ({ content: ["Exact answer."] }),
		});
		let options: sdk.CreateAgentSessionOptions | undefined;
		const result = await runWorker({
			model,
			perCallModel: exact ? `mock/${model.id}` : "mock/requested-model",
			setup: modelRegistry => {
				let warm = false;
				vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (warm ? [model] : []));
				vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
					warm = true;
				});
				const createAgentSession = sdk.createAgentSession;
				vi.spyOn(sdk, "createAgentSession").mockImplementation(created => {
					warm = true;
					options ??= created;
					return createAgentSession(created);
				});
			},
		});
		if (exact) {
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Exact answer.");
			expect(model.calls).toHaveLength(1);
			// The worker never switches models.
			expect(options?.disableModelFallback).toBe(true);
			expect(options?.disableServerSideFallback).toBe(true);
			expect(options?.prewalk).toBeUndefined();
		} else {
			expect(model.calls).toHaveLength(0);
			expect(result.exitCode).not.toBe(0);
			expect(failure(result)).toMatch(/exact model|unavailable/);
		}
	});

	it("refuses the next request once the operator revokes the grant mid-run", async () => {
		const settings = perCallSettings(createMockModel({ id: "revoked-model" }), { "retry.enabled": false });
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
		const result = await runWorker({
			model,
			settings,
			perCallModel: `mock/${model.id}`,
			assignment: "Read notes.txt, then answer.",
		});
		// Only the request admitted before the revocation reached the model.
		expect(model.calls).toHaveLength(1);
		expect(result.output).not.toContain("Answer after revocation.");
		expect(failure(result)).toMatch(/not approved/);
	});

	it.each([
		{ label: "clamps a :high selector to task.maxEffort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		{ label: "fails a model whose lowest effort is above task.maxEffort", efforts: [Effort.High] },
	])("$label on the running worker", async ({ efforts }) => {
		const model = Object.assign(
			createMockModel({ id: "laddered", reasoning: true, handler: () => ({ content: ["Capped answer."] }) }),
			{ thinking: { mode: "effort", efforts } satisfies ThinkingConfig },
		);
		const result = await runWorker({
			model,
			settings: perCallSettings(model, { "task.maxEffort": "low" }),
			perCallModel: `mock/${model.id}:high`,
		});
		if (efforts.length > 1) {
			expect(result.exitCode).toBe(0);
			// The request the provider receives runs at the ceiling, not the requested `:high`.
			expect(model.calls.map(call => call.options?.reasoning)).toEqual([Effort.Low]);
		} else {
			expect(model.calls).toHaveLength(0);
			expect(result.exitCode).not.toBe(0);
			expect(failure(result)).toMatch(/no supported thinking effort at or below task\.maxEffort=low/);
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
		const model = Object.assign(
			createMockModel({ id, reasoning: true, handler: () => ({ content: ["Persisted."] }) }),
			{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig },
		);
		const init = vi.spyOn(SessionManager.prototype, "appendSessionInit");
		const result = await runWorker({
			model,
			settings: perCallSettings(model, { "task.maxEffort": "high" }),
			perCallModel: selector,
		});
		expect(result.exitCode).toBe(0);
		expect(init.mock.calls[0]?.[0]).toMatchObject({
			perCallModel: true,
			perCallModelIdentity: identity,
			perCallThinkingLevel: level,
		});
	});

	it.each([false, true])("skips uncredentialed candidates without runtime fallback (failure: %s)", async fails => {
		const locked = createMockModel({ provider: "nokey", id: "locked" });
		const open = Object.assign(
			createMockModel({
				id: "open",
				reasoning: true,
				handler: () =>
					fails
						? { stopReason: "error", errorMessage: "503 overloaded: Candidate request failed." }
						: { content: ["Open answer."] },
			}),
			{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig },
		);
		const tail = createMockModel({ id: "tail", handler: () => ({ content: ["Wrong runtime fallback."] }) });
		const backup = createMockModel({ id: "backup" });
		const init = vi.spyOn(SessionManager.prototype, "appendSessionInit");
		const result = await runWorker({
			model: open,
			models: [locked, open, tail, backup],
			perCallModel: ["nokey/locked", "@review", "mock/tail"],
			settings: perCallSettings(open, {
				"task.maxEffort": "high",
				"retry.enabled": true,
				"retry.modelFallback": true,
				"retry.maxRetries": 1,
				"retry.baseDelayMs": 1,
				modelRoles: { locked: "nokey/locked", review: "mock/open:high", tail: "mock/tail" },
				"retry.fallbackChains": { default: ["mock/tail", "mock/backup"], review: ["mock/backup"] },
			}),
		});
		expect(locked.calls).toHaveLength(0);
		expect(open.calls.length).toBeGreaterThan(0);
		expect(tail.calls).toHaveLength(0);
		expect(backup.calls).toHaveLength(0);
		expect(open.calls.every(call => call.options?.reasoning === Effort.High)).toBe(true);
		expect(init.mock.calls[0]?.[0]).toMatchObject({
			perCallModel: true,
			perCallModelIdentity: "mock/open",
			perCallThinkingLevel: Effort.High,
		});
		if (fails) {
			expect(result.exitCode).not.toBe(0);
			expect(failure(result)).toContain("Candidate request failed.");
		} else {
			expect(result.exitCode).toBe(0);
			expect(open.calls).toHaveLength(1);
			expect(result.output).toBe("Open answer.");
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
				vi.spyOn(modelRegistry, "getAll").mockImplementation(() => models);
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
				expect(options?.disableServerSideFallback).toBe(true);
				expect(options?.prewalk).toBeUndefined();
				// Even with runtime fallbacks, a model nobody configured stays out of reach.
				expect(() => options?.assertDispatchModel?.(createMockModel({ id: "other" }))).toThrow(
					/not.*(approved|available)/,
				);
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
				vi.spyOn(modelRegistry, "getAll").mockImplementation(() => models);
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

	it.each([false, true])("checks runtime fallback effort before dispatch (high-only: %s)", async highOnly => {
		const primary = Object.assign(
			createMockModel({
				id: "effort-primary",
				reasoning: true,
				handler: () => ({ throw: "overloaded_error: provider returned error 503" }),
			}),
			{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig },
		);
		const backup = Object.assign(
			createMockModel({ id: "effort-backup", reasoning: true, handler: () => ({ content: ["Capped backup."] }) }),
			{
				thinking: {
					mode: "effort",
					efforts: highOnly ? [Effort.High] : [Effort.Low, Effort.High],
				} satisfies ThinkingConfig,
			},
		);
		const result = await runWorker({
			model: primary,
			models: [primary, backup],
			perCallModel: "@review:high",
			settings: perCallSettings(primary, {
				"task.perCallModelFallbacks": "runtime",
				"task.maxEffort": "low",
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 1,
				"retry.fallbackChains": { review: ["mock/effort-backup:high"] },
			}),
		});
		if (highOnly) {
			expect(result.exitCode).not.toBe(0);
			expect(backup.calls).toHaveLength(0);
		} else {
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Capped backup.");
			expect(backup.calls.map(call => call.options?.reasoning)).toEqual([Effort.Low]);
		}
	});

	it("retries its ordered candidates without granting selection through the installed worker chain", async () => {
		const primary = createMockModel({
			id: "candidate-primary",
			handler: () => ({ throw: "overloaded_error: provider returned error 503" }),
		});
		const backup = createMockModel({ id: "candidate-backup", handler: () => ({ content: ["Candidate backup."] }) });
		const result = await runWorker({
			model: primary,
			models: [primary, backup],
			perCallModel: ["mock/candidate-primary", "mock/candidate-backup"],
			settings: perCallSettings(primary, {
				"task.perCallModelFallbacks": "runtime",
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 1,
				modelRoles: { review: "mock/candidate-primary,mock/candidate-backup" },
			}),
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Candidate backup.");
	});
});
