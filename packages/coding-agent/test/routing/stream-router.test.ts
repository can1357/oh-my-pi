import { describe, expect, it } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { ModelPoolManager } from "../../src/routing/pool-manager";
import type { ResolvedModelPool } from "../../src/routing/types";

function createMockModel(provider: string, id: string, contextWindow = 128_000): Model {
	return {
		id,
		name: `${provider} ${id}`,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		compat: undefined,
	};
}

describe("ModelPoolManager", () => {
	it.each([false, undefined])("disables configured manual pools when enabled is %s", enabled => {
		const modelA = createMockModel("provider-a", "shared");
		const modelB = createMockModel("provider-b", "shared");
		const manager = new ModelPoolManager({
			enabled,
			pools: { manual: { enabled: true, members: ["provider-a/shared", "provider-b/shared"] } },
		});
		expect(manager.resolvePool(modelA, [modelA, modelB])).toBeNull();
	});

	it("is disabled by default (opt-in)", () => {
		const manager = new ModelPoolManager();
		expect(manager.isEnabled).toBe(false);

		const sonnetDirect = createMockModel("anthropic", "claude-3-7-sonnet");
		const sonnetOpenRouter = createMockModel("openrouter", "anthropic/claude-3.7-sonnet");
		const pool = manager.resolvePool(sonnetDirect, [sonnetDirect, sonnetOpenRouter]);
		expect(pool).toBeNull();
	});

	it("respects user manual pools with overwrite power regardless of model names", () => {
		const modelA = createMockModel("custom-proxy", "fast-chat");
		const modelB = createMockModel("huggingface", "openai/gpt-oss-120b");

		const manager = new ModelPoolManager({
			enabled: true,
			pools: {
				"my-fast-pool": {
					name: "My Fast Group",
					members: ["custom-proxy/fast-chat", "huggingface/openai/gpt-oss-120b"],
					strategy: "round-robin",
				},
			},
		});

		const pool = manager.resolvePool(modelA, [modelA, modelB]);
		expect(pool).not.toBeNull();
		expect(pool?.id).toBe("my-fast-pool");
		expect(pool?.name).toBe("My Fast Group");
		expect(pool?.strategy).toBe("round-robin");
		expect(pool?.candidates).toHaveLength(2);
	});

	it("enforces explicit user vetoes between model pairs", () => {
		const modelA = createMockModel("provider-a", "model-x");
		const modelB = createMockModel("provider-b", "model-x");

		const manager = new ModelPoolManager({
			enabled: true,
			vetoes: [["provider-a/model-x", "provider-b/model-x"]],
			pools: {
				"test-pool": {
					members: ["provider-a/model-x", "provider-b/model-x"],
				},
			},
		});

		expect(manager.isVetoed(modelA, modelB)).toBe(true);
		expect(manager.isVetoed(modelB, modelA)).toBe(true);

		// With veto in place, pool resolution will not include modelB
		const pool = manager.resolvePool(modelA, [modelA, modelB]);
		expect(pool).toBeNull(); // Only 1 candidate remains, so no multi-provider pool
	});

	it("filters out candidates when context window is smaller than session tokens", () => {
		const bigContextModel = createMockModel("anthropic", "claude-3-7-sonnet", 200_000);
		const smallContextModel = createMockModel("cheap-proxy", "claude-3-7-sonnet", 32_000);

		const pool: ResolvedModelPool = {
			id: "claude-pool",
			name: "Claude Pool",
			strategy: "affinity-fallback",
			candidates: [bigContextModel, smallContextModel],
		};

		const manager = new ModelPoolManager({ enabled: true });

		// Under 32k: both are eligible
		const smallTurn = manager.evaluateCandidates(pool, 10_000);
		expect(smallTurn.every(e => e.isContextSufficient)).toBe(true);

		// At 50k: smallContextModel is ineligible
		const largeTurn = manager.evaluateCandidates(pool, 50_000);
		const bigCandidate = largeTurn.find(e => e.model.provider === "anthropic");
		const smallCandidate = largeTurn.find(e => e.model.provider === "cheap-proxy");

		expect(bigCandidate?.isContextSufficient).toBe(true);
		expect(smallCandidate?.isContextSufficient).toBe(false);

		// Target selection automatically picks the bigContextModel
		const selected = manager.selectTarget(pool, { currentContextTokens: 50_000 });
		expect(selected.provider).toBe("anthropic");
	});

	it("manages cooldowns on rate-limit / capacity failure and rotates to healthy sibling", () => {
		const primary = createMockModel("provider-a", "shared-model");
		const secondary = createMockModel("provider-b", "shared-model");

		const pool: ResolvedModelPool = {
			id: "shared-pool",
			name: "Shared Pool",
			strategy: "affinity-fallback",
			candidates: [primary, secondary],
		};

		const manager = new ModelPoolManager({
			enabled: true,
			cooldownDurationMs: 30_000,
		});

		// Initial selection picks primary
		const firstPick = manager.selectTarget(pool, { preferredModel: primary });
		expect(firstPick.provider).toBe("provider-a");

		// Simulate HTTP 429 failure on primary
		manager.markFailure(primary, new Error("429 Too Many Requests"));

		// Subsequent selection bypasses cooling primary and picks healthy secondary
		const failoverPick = manager.selectTarget(pool, { preferredModel: primary });
		expect(failoverPick.provider).toBe("provider-b");
	});

	it("round-robin strategy evenly balances targets", () => {
		const modelA = createMockModel("p1", "model");
		const modelB = createMockModel("p2", "model");
		const modelC = createMockModel("p3", "model");

		const pool: ResolvedModelPool = {
			id: "rr-pool",
			name: "Round Robin Pool",
			strategy: "round-robin",
			candidates: [modelA, modelB, modelC],
		};

		const manager = new ModelPoolManager({ enabled: true });

		expect(manager.selectTarget(pool).provider).toBe("p1");
		expect(manager.selectTarget(pool).provider).toBe("p2");
		expect(manager.selectTarget(pool).provider).toBe("p3");
		expect(manager.selectTarget(pool).provider).toBe("p1");
	});
});
