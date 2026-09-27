import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import type { FetchImpl, ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { isStepfunChatModelId, stepfunModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

/** StepFun's documented three-tier ladder; the relay-host default spans minimal…xhigh. */
const STEPFUN_LADDER = [Effort.Low, Effort.Medium, Effort.High];

const ORIGINAL_STEPFUN_API_KEY = Bun.env.STEPFUN_API_KEY;

afterEach(() => {
	if (ORIGINAL_STEPFUN_API_KEY === undefined) {
		delete Bun.env.STEPFUN_API_KEY;
	} else {
		Bun.env.STEPFUN_API_KEY = ORIGINAL_STEPFUN_API_KEY;
	}
	vi.restoreAllMocks();
});

function bundledStepfunModels() {
	return getBundledModels("stepfun");
}

describe("StepFun provider support", () => {
	test("registers the provider, its STEPFUN_API_KEY fallback, and a login flow", () => {
		Bun.env.STEPFUN_API_KEY = "stepfun-test-key";
		expect(getEnvApiKey("stepfun")).toBe("stepfun-test-key");
		delete Bun.env.STEPFUN_API_KEY;
		expect(getEnvApiKey("stepfun")).toBeUndefined();

		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "stepfun");
		expect(descriptor?.defaultModel).toBe("step-5-preview");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["STEPFUN_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.stepfun).toBe("step-5-preview");
		// A successful `/v1/models` snapshot must replace the seed rows, or an id
		// StepFun retires stays selectable as a dead bundled row.
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);

		const provider = getOAuthProviders().find(item => item.id === "stepfun");
		expect(provider?.name).toBe("StepFun");
	});

	test("keeps StepFun's own effort ladder instead of the relay-host minimal…xhigh default", () => {
		// The stepfun taxonomy extracts no revision, so a revision-scoped rule
		// silently falls through to the neutral ladder — which sends effort
		// values StepFun rejects with a 400.
		for (const model of bundledStepfunModels()) {
			expect(model.thinking?.mode).toBe("effort");
			expect(model.thinking?.efforts).toEqual(STEPFUN_LADDER);
			expect(model.reasoning).toBe(true);
		}
	});

	test("pins StepFun's published limits and pricing rather than relay-host rows", () => {
		const byId = new Map(bundledStepfunModels().map(model => [model.id, model]));

		// Limits from StepFun's model cards, as catalogued on models.dev
		// (`providers/stepfun-ai` + `models/stepfun`). The API accepts a 2M
		// `max_tokens`, so a live probe cannot establish a ceiling.
		expect(byId.get("step-5-preview")?.contextWindow).toBe(1_000_000);
		expect(byId.get("step-5-preview")?.maxTokens).toBe(1_000_000);
		for (const id of ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"]) {
			expect(byId.get(id)?.contextWindow).toBe(256_000);
			expect(byId.get(id)?.maxTokens).toBe(256_000);
		}

		// List prices from https://platform.stepfun.ai/docs/en/guides/pricing/details
		expect(byId.get("step-5-preview")?.cost).toEqual({ input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 0 });
		expect(byId.get("step-3.7-flash")?.cost).toEqual({ input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 });
		expect(byId.get("step-3.5-flash")?.cost).toEqual({ input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 });

		// Multimodal SKUs must carry image input so omp attaches screenshots.
		expect(byId.get("step-5-preview")?.input).toEqual(["text", "image"]);
		expect(byId.get("step-3.7-flash")?.input).toEqual(["text", "image"]);
		expect(byId.get("step-3.5-flash")?.input).toEqual(["text"]);

		// The authored rows above must win over same-id rows on relay hosts,
		// which report different ceilings and ladders for these ids.
		expect(providerEntry("stepfun")?.skipCrossProviderReferenceFills).toBe(true);

		// StepFun's Chat Completions API documents max_tokens only; the
		// OpenAI baseline's max_completion_tokens spelling is silently ignored.
		for (const model of bundledStepfunModels()) {
			const compat = model.compat as ResolvedOpenAICompat;
			expect(compat.maxTokensField).toBe("max_tokens");
			expect(compat.supportsReasoningEffort).toBe(true);
		}
	});

	test("discovery keeps chat models and drops the audio/image SKUs StepFun interleaves in /v1/models", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "step-5-preview", owned_by: "stepai", max_input_tokens: 1024000 },
							{ id: "stepaudio-3-tts", owned_by: "stepai" },
							{ id: "stepaudio-2.5-asr", owned_by: "stepai" },
							{ id: "step-image-edit-2", owned_by: "stepai" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const models = await stepfunModelManagerOptions({
			apiKey: "stepfun-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["step-5-preview"]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.stepfun.ai/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer stepfun-key" }),
			}),
		);

		const discovered = models?.[0];
		expect(discovered?.reasoning).toBe(true);
		expect(discovered?.thinking?.efforts).toEqual(STEPFUN_LADDER);
		expect(discovered?.cost).toEqual({ input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 0 });
		expect(discovered?.contextWindow).toBe(1_000_000);
		expect(discovered?.maxTokens).toBe(1_000_000);
	});

	test("a discovered model with no bundled reference still gets StepFun's advertised reasoning dial", async () => {
		// `mapWithBundledReference` starts an unbundled row from the generic
		// defaults (`reasoning: false`, no thinking), and `mergeDynamicModels`
		// adds it verbatim — so a model StepFun ships after this snapshot would
		// otherwise never send `reasoning_effort`.
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "step-6-preview", reasoning_effort_support_list: ["low", "medium", "high"] },
							// Advertises no tiers: must stay non-reasoning rather than
							// inherit a fabricated ladder.
							{ id: "step-8-chat" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const models = await stepfunModelManagerOptions({
			apiKey: "stepfun-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		const future = models?.find(model => model.id === "step-6-preview");
		expect(future?.reasoning).toBe(true);
		expect(future?.thinking).toEqual({ mode: "effort", efforts: STEPFUN_LADDER });

		const unreasoned = models?.find(model => model.id === "step-8-chat");
		expect(unreasoned?.reasoning).toBe(false);
		expect(unreasoned?.thinking).toBeUndefined();
	});

	test("a retired model is pruned through the manager options, not just the descriptor", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-stepfun-prune-"));
		const dbPath = path.join(tempDir, "models.db");
		// The live roster no longer lists step-3.5-flash; the bundled seed still does.
		const liveRoster = getBundledModels("stepfun").filter(model => model.id !== "step-3.5-flash");
		const options = {
			...stepfunModelManagerOptions({
				apiKey: "stepfun-key",
				fetch: (async () =>
					new Response(JSON.stringify({ data: liveRoster.map(model => ({ id: model.id, owned_by: "stepai" })) }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})) as unknown as FetchImpl,
			}),
			staticModels: getBundledModels("stepfun"),
			cacheDbPath: dbPath,
		};

		try {
			// The flag must be on the options `createModelManager()` consumes; the
			// KDL descriptor alone leaves the additive branch active.
			expect(options.dynamicModelsAuthoritative).toBe(true);

			const result = await resolveProviderModels(options, "online");

			expect(result.models.map(model => model.id)).not.toContain("step-3.5-flash");
			expect(result.models.map(model => model.id)).toContain("step-5-preview");
			expect(result.stale).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("roster exclusion classifies StepFun's non-chat SKUs without touching chat ids", () => {
		expect(isStepfunChatModelId("step-5-preview")).toBe(true);
		expect(isStepfunChatModelId("STEP-5-PREVIEW")).toBe(true);
		expect(isStepfunChatModelId("stepaudio-3-tts")).toBe(false);
		expect(isStepfunChatModelId("stepaudio-2.5-chat")).toBe(false);
		expect(isStepfunChatModelId("step-image-edit-2")).toBe(false);
		expect(isStepfunChatModelId("step-tts-2")).toBe(false);
		expect(isStepfunChatModelId("   ")).toBe(false);
	});
});
