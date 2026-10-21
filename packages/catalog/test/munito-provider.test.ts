import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { isMunitoChatModelId, munitoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { bundledSeedRows } from "../scripts/generate-models";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Munito's public chat roster as probed on 2026-10-12 (OCR ids interleaved). */
const LIVE_PUBLIC_ROSTER = [
	{ id: "lightonai/lightonocr-2-1b" },
	{ id: "qwen/qwen3.8-27b" },
	{ id: "zai-org/glm-5.3-flash" },
	{ id: "aleph-alpha/kolibri-1" },
	{ id: "deepseek-ai/deepseek-v4-flash" },
	{ id: "google/gemma-4-12b" },
	{ id: "mistralai/mistral-small-4-119b-2603" },
	{ id: "qwen/qwen3.6-35b-a3b" },
	{ id: "munito/ocr-auto" },
	{ id: "munito/ocr-fast" },
];

const OCR_IDS = ["munito/ocr-auto", "munito/ocr-fast", "lightonai/lightonocr-2-1b"];

const CHAT_IDS = LIVE_PUBLIC_ROSTER.map(entry => entry.id)
	.filter(id => !OCR_IDS.includes(id))
	.sort();

function munitoModelsFetch(seen?: { url?: string; authorization?: string }): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
		if (seen) {
			seen.url = typeof input === "string" ? input : String(input);
			seen.authorization = init?.headers?.Authorization;
		}
		return new Response(
			JSON.stringify({
				object: "list",
				data: LIVE_PUBLIC_ROSTER.map(entry => ({ owned_by: "munito", object: "model", created: 0, ...entry })),
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as FetchImpl;
}

describe("Munito provider support", () => {
	test("discovery snapshots the chat roster and drops the interleaved OCR SKUs", async () => {
		const seen: { url?: string; authorization?: string } = {};
		const models = await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(CHAT_IDS);

		const first = models?.[0];
		expect(first?.provider).toBe("munito");
		expect(first?.api).toBe("openai-completions");
		expect(seen.url).toBe("https://api.munito.ai/inference/v1/models");
		expect(seen.authorization).toBe("Bearer munito-key");
	});

	test("the keyless endpoint still serves discovery when no key is configured", async () => {
		// /models is public (an invalid key 401s the probe): no key required.
		const seen: { url?: string; authorization?: string } = {};
		const models = await munitoModelManagerOptions({
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(CHAT_IDS);
		expect(seen.url).toBe("https://api.munito.ai/inference/v1/models");
		expect(seen.authorization).toBeUndefined();
	});

	test("an id bundled nowhere recovers canonical params and clamps maxTokens", async () => {
		// The id must be absent from Munito's bundle: a same-provider reference
		// takes the mapWithBundledReference branch and skips canonical recovery,
		// so the test would pass for the wrong reason.
		const index = getBundledModelReferenceIndex();
		const upstream = [...index.exact.values()].find(
			model =>
				model.provider !== "munito" &&
				model.id.includes("/") &&
				model.reasoning === true &&
				(model.contextWindow ?? 0) > 0 &&
				!seedModels("munito").some(seed => seed.id === model.id),
		);
		expect(upstream).toBeDefined();
		if (!upstream) throw new Error("no upstream reasoning model available");

		const fetch = (async () =>
			new Response(JSON.stringify({ object: "list", data: [{ id: upstream.id, owned_by: "munito" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as FetchImpl;
		const models = (await munitoModelManagerOptions({ apiKey: "k", fetch }).fetchDynamicModels?.()) ?? [];
		expect(models.map(model => model.id)).toEqual([upstream.id]);
		const recovered = models[0];
		const canonical = resolveModelReference(upstream.id, index);

		// Intrinsic capabilities survive; pricing never crosses providers.
		expect(recovered.reasoning).toBe(true);
		// Thinking is host policy: the canonical reference's ladder is never
		// copied; provider KDL resolves the wire dialect.
		expect(recovered.thinking).toBeUndefined();
		expect(recovered.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered.maxTokens ?? Infinity).toBeLessThanOrEqual(recovered.contextWindow ?? Infinity);
		if (canonical?.maxTokens != null) {
			expect(recovered.maxTokens).toBe(Math.min(canonical.maxTokens, canonical.contextWindow ?? Infinity));
		}
		expect(recovered.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("a discovered id bundled nowhere recovers nothing and stays neutral", async () => {
		const futureFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ object: "list", data: [{ id: "munito/test-chat-1", owned_by: "munito" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const models = await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: futureFetch,
		}).fetchDynamicModels?.();
		const future = models?.find(model => model.id === "munito/test-chat-1");
		expect(future?.reasoning).toBe(false);
		expect(future?.thinking).toBeUndefined();
		expect(future?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(future?.input).toEqual(["text"]);
		expect(future?.contextWindow).toBeNull();
	});

	test("a retired model is pruned through the manager options, not just the descriptor", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-munito-prune-"));
		const dbPath = path.join(tempDir, "models.db");
		// A bundled-only id must disappear when the live roster serves its
		// neighbors; synthesized seed rows decouple the assertion from regen.
		const bundled: ModelSpec<"openai-completions">[] = ["qwen/qwen3.8-27b", "munito/retired-chat-1"].map(id => ({
			id,
			name: id,
			api: "openai-completions",
			provider: "munito",
			baseUrl: "https://api.munito.ai/inference/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		}));
		const retired = "munito/retired-chat-1";
		const liveRoster = bundled.filter(model => model.id !== retired);
		const options = {
			...munitoModelManagerOptions({
				apiKey: "munito-key",
				fetch: (async () =>
					new Response(
						JSON.stringify({
							object: "list",
							data: liveRoster.map(model => ({ id: model.id, owned_by: "munito" })),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)) as unknown as FetchImpl,
			}),
			staticModels: bundled,
			cacheDbPath: dbPath,
		};

		try {
			expect(options.dynamicModelsAuthoritative).toBe(true);

			const result = await resolveProviderModels(options, "online");

			expect(result.models.map(model => model.id)).not.toContain(retired);
			expect(result.models.map(model => model.id)).toContain("qwen/qwen3.8-27b");
			expect(result.stale).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("generation bundles the seed rows only when discovery cannot reach /models", () => {
		// The generator, not the seed KDL, decides whether a regen without a live
		// roster carries the declared default into models.json.
		const entry = providerEntry("munito");
		expect(entry?.defaultModel).toBe("qwen/qwen3.8-27b");
		if (!entry) throw new Error("munito provider entry missing");

		const fallback = bundledSeedRows(entry, [], new Set<string>());
		expect(fallback.map(model => model.id)).toContain(entry.defaultModel);

		// Authoritative discovery replaces the fallback, so retired ids do not
		// linger as bundled rows.
		expect(bundledSeedRows(entry, [], new Set(["munito"]))).toEqual([]);
	});

	test("the bundled fallback keeps the declared default selectable before discovery", async () => {
		// Offline startup composes the bundled rows (getBundledModels) instead of
		// the KDL seed: if generation stops carrying the seed, the declared
		// defaultModel is unresolvable at boot, before discovery fires.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-munito-fallback-"));
		try {
			const defaultModel = providerEntry("munito")?.defaultModel;
			if (!defaultModel) throw new Error("munito default model missing");
			const result = await resolveProviderModels(
				{
					...munitoModelManagerOptions({ apiKey: "munito-key" }),
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"offline",
			);

			const row = result.models.find(model => model.id === defaultModel);
			expect(row).toBeDefined();
			expect(row?.provider).toBe("munito");
			expect(row?.api).toBe("openai-completions");
			expect(row?.baseUrl).toBe("https://api.munito.ai/inference/v1");
			expect(row?.reasoning).toBe(true);
			// Munito publishes no per-model tariff: the fallback row stays free.
			expect(row?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

			// The discovery-hydration correction survives composition too.
			const gemma = result.models.find(model => model.id === "google/gemma-4-12b");
			expect(gemma?.reasoning).toBe(true);
			expect(gemma?.thinking).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("roster exclusion classifies Munito's OCR SKUs without touching chat ids", () => {
		expect(isMunitoChatModelId("qwen/qwen3.8-27b")).toBe(true);
		expect(isMunitoChatModelId("munito/ocr-auto")).toBe(false);
		expect(isMunitoChatModelId("   ")).toBe(false);
	});

	test("a neutral Gemma discovery row is repaired to always-on reasoning with no ladder", () => {
		// Discovery reports no capabilities for Gemma; the exact
		// `thinking-upgrade-neutral` correction must repair the
		// `reasoning: false` default without inventing a ladder.
		const spec: ModelSpec<"openai-completions"> = {
			id: "google/gemma-4-12b",
			name: "gemma-4-12b",
			api: "openai-completions",
			provider: "munito",
			baseUrl: "https://api.munito.ai/inference/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		};
		const gemma = buildModel(spec);
		expect(gemma.reasoning).toBe(true);
		expect(gemma.thinking).toBeUndefined();
		expect(gemma.compat.supportsReasoningEffort).toBe(false);
		// The repair must not leak to a lane whose contract did not opt in.
		const other: ModelSpec<"openai-completions"> = { ...spec, id: "nutshell/test-chat-1" };
		expect(buildModel(other).reasoning).toBe(false);
	});

	test("the wire dialect is openai reasoning_effort, with the rejected lanes ladder-free", () => {
		const spec = (id: string): ModelSpec<"openai-completions"> => ({
			id,
			name: id,
			api: "openai-completions",
			provider: "munito",
			baseUrl: "https://api.munito.ai/inference/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
		// The qwen identity dialect is rejected here; Munito's ladder reaches
		// `max` instead of collapsing to `xhigh`.
		const qwen38 = buildModel(spec("qwen/qwen3.8-27b"));
		expect(qwen38.compat.thinkingFormat).toBe("openai");
		expect(qwen38.compat.reasoningContentField).toBe("reasoning");
		expect(qwen38.compat.supportsReasoningEffort).toBe(true);
		expect(qwen38.thinking?.mode).toBe("effort");
		expect(qwen38.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(clampThinkingLevelForModel(qwen38, Effort.Max)).toBe(Effort.Max);

		// Class ladders (zai's glm-5.3 SKUs wire-exact low/high/max) must not
		// out-rank Munito's authored ladder on its own host: metadata callers
		// would otherwise lose the documented minimal/medium tiers.
		const glm = buildModel(spec("zai-org/glm-5.3-flash"));
		expect(glm.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.Max]);

		// These lanes 400 `reasoning_effort`: no ladder, param never emitted.
		for (const id of ["qwen/qwen3.6-35b-a3b", "google/gemma-4-12b"]) {
			const model = buildModel(spec(id));
			expect(model.thinking).toBeUndefined();
			expect(model.compat.supportsReasoningEffort).toBe(false);
			expect(model.compat.thinkingFormat).toBe("openai");
			expect(model.compat.reasoningContentField).toBe("reasoning");
		}
	});
});
