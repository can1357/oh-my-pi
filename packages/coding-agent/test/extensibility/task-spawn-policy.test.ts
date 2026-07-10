import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { LLMRouter } from "../../../llm-router-agent/src/agent";
import { cloneDefaultConfig } from "../../../llm-router-agent/src/defaults";
import llmRouterExtension from "../../../llm-router-agent/src/extension";
import type { OmpLikeExtensionApi } from "../../../llm-router-agent/src/omp-compat";
import { ModelRegistry } from "../../src/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionFactory } from "../../src/extensibility/extensions/types";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import {
	composeTaskSpawnPolicyResult,
	createSpawnPlan,
	type SpawnPlan,
	type TaskSpawnPolicyInput,
} from "../../src/task/spawn-plan";
import { EventBus } from "../../src/utils/event-bus";

type RouterHandler = (event: unknown) => unknown | Promise<unknown>;

function policyPlan(): SpawnPlan {
	const planned = createSpawnPlan({
		correlationId: "policy-correlation",
		agentName: "task",
		assignment: "Apply policy before allocation.",
		eligible: [
			{ selector: "cheap/light", tier: "light", maxRequests: 30, maxRuntimeMs: 30_000 },
			{ selector: "reliable/mid", tier: "mid", maxRequests: 30, maxRuntimeMs: 30_000 },
			{ selector: "frontier/heavy", tier: "frontier", maxRequests: 30, maxRuntimeMs: 30_000 },
		],
	});
	if (!planned.ok) throw new Error("Expected policy test plan");
	return planned.plan;
}

function policyInput(plan: SpawnPlan): TaskSpawnPolicyInput {
	return {
		correlationId: plan.correlationId,
		agentName: plan.agentName,
		assignment: plan.assignment,
		workClass: plan.profile.workClass,
		autonomy: plan.profile.autonomy,
		eligible: plan.eligible,
		fusionSidekick: false,
		manualModelSelection: false,
	};
}

describe("ExtensionRunner task spawn policy", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-task-spawn-policy-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function buildRunner(factories: readonly ExtensionFactory[]): Promise<ExtensionRunner> {
		const runtime = new ExtensionRuntime();
		const extensions = await Promise.all(
			factories.map((factory, index) =>
				loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, `<policy-${index}>`),
			),
		);
		return new ExtensionRunner(extensions, runtime, tempDir.path(), SessionManager.inMemory(), modelRegistry);
	}

	it("composes handlers sequentially by selector intersection and budget minima", async () => {
		const calls: string[] = [];
		const runner = await buildRunner([
			api =>
				api.on("task_spawn_policy", () => {
					calls.push("first");
					return { allow: true, candidateSelectors: ["cheap/light", "reliable/mid"], maxRequests: 12 };
				}),
			api =>
				api.on("task_spawn_policy", () => {
					calls.push("second");
					return { allow: true, candidateSelectors: ["reliable/mid"], maxRequests: 5, maxRuntimeMs: 2000 };
				}),
		]);
		const plan = policyPlan();
		const result = await runner.emitTaskSpawnPolicy(policyInput(plan));
		const composed = composeTaskSpawnPolicyResult(plan, result);
		if (!composed.ok) throw new Error("Expected composed policy to allow spawn");

		expect(calls).toEqual(["first", "second"]);
		expect(result).toEqual({
			allow: true,
			candidateSelectors: ["reliable/mid"],
			maxRequests: 5,
			maxRuntimeMs: 2000,
		});
		expect(composed.plan.eligible.map(candidate => candidate.selector)).toEqual(["reliable/mid"]);
		expect(composed.plan.maxRequests).toBe(5);
		expect(composed.plan.maxRuntimeMs).toBe(2000);
		expect(Object.isFrozen(composed.plan)).toBe(true);
	});

	it("keeps denial sticky and does not invoke later handlers", async () => {
		const later = vi.fn(() => ({ allow: true }));
		const runner = await buildRunner([
			api => api.on("task_spawn_policy", () => ({ allow: true, candidateSelectors: ["reliable/mid"] })),
			api => api.on("task_spawn_policy", () => ({ allow: false, reasonCode: "policy-denied" })),
			api => api.on("task_spawn_policy", later),
		]);
		const plan = policyPlan();
		const result = await runner.emitTaskSpawnPolicy(policyInput(plan));
		const denied = composeTaskSpawnPolicyResult(plan, result);

		expect(result).toEqual({ allow: false, reasonCode: "policy-denied" });
		expect(later).not.toHaveBeenCalled();
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.diagnostics[0]?.code).toBe("policy-denied");
	});

	it("aborts policy evaluation before the allocation callback can create a spawn", async () => {
		const controller = new AbortController();
		const allocate = vi.fn();
		const runner = await buildRunner([
			api =>
				api.on("task_spawn_policy", () => {
					controller.abort("caller cancelled");
					return { allow: true };
				}),
		]);
		const emitBeforeAllocation = async (): Promise<void> => {
			await runner.emitTaskSpawnPolicy(policyInput(policyPlan()), controller.signal);
			allocate();
		};

		await expect(emitBeforeAllocation()).rejects.toBeTruthy();
		expect(allocate).not.toHaveBeenCalled();
	});

	it("treats missing task-spawn handlers as a no-op", async () => {
		const runner = await buildRunner([api => api.setLabel("unrelated extension")]);
		expect(await runner.emitTaskSpawnPolicy(policyInput(policyPlan()))).toEqual({ allow: true });
	});

	it("keeps router task-spawn policy disabled by default", async () => {
		const config = cloneDefaultConfig();
		expect(config.taskSpawn?.enabled ?? false).toBe(false);
		vi.spyOn(LLMRouter, "load").mockResolvedValue(new LLMRouter(config));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const handlers = new Map<string, RouterHandler[]>();
		const api = {
			setLabel: () => {},
			on: (eventName: string, handler: RouterHandler) => {
				const registered = handlers.get(eventName) ?? [];
				registered.push(handler);
				handlers.set(eventName, registered);
			},
		};

		await llmRouterExtension(api as unknown as OmpLikeExtensionApi);

		expect(handlers.has("task_spawn_policy")).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("adapts router policy input and output fields without changing selector or budget values", async () => {
		const config = cloneDefaultConfig();
		config.taskSpawn = {
			enabled: true,
			endpoint: "https://classifier.example.test/v1/chat/completions",
			timeoutMs: 1000,
			systemPrompt: "Return light, mid, or heavy.",
			labelMappings: { light: "light", mid: "mid", heavy: "frontier" },
		};
		vi.spyOn(LLMRouter, "load").mockResolvedValue(new LLMRouter(config));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "mid" } }] }), { status: 200 }),
			);
		const handlers = new Map<string, RouterHandler[]>();
		const api = {
			setLabel: () => {},
			on: (eventName: string, handler: RouterHandler) => {
				const registered = handlers.get(eventName) ?? [];
				registered.push(handler);
				handlers.set(eventName, registered);
			},
		};
		await llmRouterExtension(api as unknown as OmpLikeExtensionApi);
		const handler = handlers.get("task_spawn_policy")?.[0];
		if (!handler) throw new Error("Expected enabled router task-spawn handler");

		const result = await handler({
			type: "task_spawn_policy",
			correlationId: "adapter-correlation",
			agentName: "task",
			assignment: "Classify exactly this assignment",
			workClass: "mechanical",
			autonomy: "supervised",
			eligible: [
				{
					selector: "cheap/light",
					tier: "light",
					provider: "cheap",
					modelId: "light",
					maxRequests: 9,
					maxRuntimeMs: 900,
				},
				{
					selector: "reliable/mid",
					tier: "mid",
					provider: "reliable",
					modelId: "mid",
					maxRequests: 5,
					maxRuntimeMs: 500,
				},
			],
			requestedModel: "reliable/mid",
			fusionSidekick: false,
			manualModelSelection: false,
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			config.taskSpawn.endpoint,
			expect.objectContaining({ body: expect.stringContaining("Classify exactly this assignment") }),
		);
		expect(result).toMatchObject({
			allow: true,
			routeLabel: "mid",
			candidateSelectors: ["reliable/mid"],
			maxRequests: 5,
			maxRuntimeMs: 500,
		});
	});
});
