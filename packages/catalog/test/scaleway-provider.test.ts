import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { isScalewayChatModelId, scalewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** One Scaleway card ladder: [id, on-tiers, default level]. */
const SCALEWAY_LADDERS: Array<[string, Effort[], Effort | undefined]> = [
	// GLM 5.3/5.2 accept `none` as a wire off value (verified live:
	// reasoning_tokens 0), diverging from the lineage glob's cannot-disable
	// contract in classes/glm.kdl; the priority=20 residue must outrank it.
	["glm-5.3", [Effort.Low, Effort.High, Effort.Max], Effort.Max],
	["glm-5.2", [Effort.High, Effort.Max], Effort.Max],
	["deepseek-v4.1-flash", [Effort.Low, Effort.High, Effort.Max], undefined],
	["deepseek-v4-flash-0731", [Effort.Low, Effort.High, Effort.Max], undefined],
	// Qwen 3.8 keeps its native xhigh tier; 3.6/3.5 stop at high.
	["qwen3.8-27b", [Effort.Low, Effort.Medium, Effort.XHigh], undefined],
	["qwen3.6-35b-a3b", [Effort.Low, Effort.Medium, Effort.High], undefined],
	["qwen3.5-397b-a17b", [Effort.Low, Effort.Medium, Effort.High], undefined],
	["gemma-4-26b-a4b-it", [Effort.Low, Effort.Medium, Effort.High], undefined],
	// Mistral Medium 3.5 documents none/high only; medium (the server default)
	// is not a valid tier, so the omp default pins high.
	["mistral-medium-3.5-128b", [Effort.High], Effort.High],
];

// No card ladder and no upgrade-neutral promotion: these ids must stay
// dial-free even though the Qwen and Mistral classes serve reasoning lineages
// on other hosts.
const NON_REASONING_IDS = [
	"qwen3-235b-a22b-instruct-2507",
	"mistral-small-3.2-24b-instruct-2506",
	"llama-3.3-70b-instruct",
];

/**
 * A bare row as Scaleway's `/v1/models` reports it: bare OpenAI fields with
 * no capability metadata, no limits, and no prices. Rule resolution sees
 * only what the endpoint would say — no bundled reference, no same-id
 * vendor row.
 */
function bareSpec(
	id: string,
	overrides: Partial<ModelSpec<"openai-completions">> = {},
): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "scaleway",
		baseUrl: "https://api.scaleway.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Scaleway provider support", () => {
	test("resolves each card's documented effort ladder with `none` as the off value", () => {
		for (const [id, efforts, defaultLevel] of SCALEWAY_LADDERS) {
			// The wire row claims no reasoning, so each ladder must arrive
			// through `thinking-upgrade-neutral` promotion of the reviewed
			// card — the repair the runtime performs when discovery meets
			// the KDL rules.
			const model = buildModel(bareSpec(id));
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.mode).toBe("effort");
			expect(model.thinking?.efforts).toEqual(efforts);
			expect(model.thinking?.defaultLevel).toBe(defaultLevel);
			// The lineage glob marks glm-5.3 thinking as mandatory; Scaleway's
			// `none` tier must keep these disableable (undefined, not true).
			expect(model.thinking?.requiresEffort).not.toBe(true);
			// Thinking-off must send reasoning_effort `none`: omitting the
			// field falls back to the server default (medium) and leaves
			// reasoning on.
			expect(model.compat?.reasoningDisableMode).toBe("none-effort");
		}

		for (const id of NON_REASONING_IDS) {
			const model = buildModel(bareSpec(id));
			expect(model.reasoning).toBe(false);
			expect(model.thinking).toBeUndefined();
		}

		// gpt-oss-120b documents no `none` tier, so Scaleway authors no
		// ladder and no promotion for it: its Harmony ladder travels with
		// the bundled reference (asserted in the discovery test below), and
		// thinking-off keeps the class's lowest-effort fallback.
		const gptOss = buildModel(bareSpec("gpt-oss-120b"));
		expect(gptOss.reasoning).toBe(false);
		expect(gptOss.thinking).toBeUndefined();
		expect(gptOss.compat?.reasoningDisableMode).toBe("lowest-effort");
	});

	test("pins serverless limits and EUR-converted pricing over same-id vendor rows", () => {
		// glm-5.3 also exists on first-party hosts (zai serves it at 1M/131k
		// with its own rates); a same-id vendor row flowing in through
		// discovery must lose to Scaleway's serverless caps and EUR card
		// (converted at the 2026-10-21 ECB rate 1 EUR = 1.1234 USD).
		const glm = buildModel(
			bareSpec("glm-5.3", {
				input: ["text", "image"],
				cost: { input: 1.12, output: 4.4, cacheRead: 0.11, cacheWrite: 1.68 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			}),
		);
		expect(glm.contextWindow).toBe(262_144);
		expect(glm.maxTokens).toBe(16_384);
		expect(glm.cost).toEqual({ input: 2.02, output: 6.18, cacheRead: 0, cacheWrite: 0 });

		// The Qwen 3.5 row meets the same 1M vendor pin and must land on
		// its own 250k/16k serverless caps.
		const qwen = buildModel(bareSpec("qwen3.5-397b-a17b", { contextWindow: 1_048_576, maxTokens: 131_072 }));
		expect(qwen.contextWindow).toBe(256_000);
		expect(qwen.maxTokens).toBe(16_384);

		// Credentials resolve from the documented env vars, in order.
		expect(providerEntry("scaleway")?.defaultModel).toBe("glm-5.3");
		expect(providerEntry("scaleway")?.envVars).toEqual(["SCW_SECRET_KEY", "SCW_API_KEY"]);
	});

	test("discovery keeps chat models and drops the transcription/embedding/OCR SKUs interleaved in /v1/models", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "glm-5.3", object: "model", created: 1791474730, owned_by: "zai" },
							{ id: "whisper-large-v3", object: "model", created: 1722263169, owned_by: "openai" },
							{ id: "qwen3-embedding-8b", object: "model", created: 1755006551, owned_by: "qwen" },
							{ id: "bge-multilingual-gemma2", object: "model", created: 1730385501, owned_by: "baai" },
							{ id: "lightonocr-3-0.8b", object: "model", created: 1736258559, owned_by: "" },
							{ id: "gpt-oss-120b", object: "model", created: 1755555555, owned_by: "openai" },
							{ id: "llama-3.3-70b-instruct", object: "model", created: 1736258559, owned_by: "meta" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const models = await scalewayModelManagerOptions({
			apiKey: "scw-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["glm-5.3", "gpt-oss-120b", "llama-3.3-70b-instruct"]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.scaleway.ai/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer scw-key" }),
			}),
		);

		// The runtime discovery path must surface the authored policy, not a
		// generic OpenAI-compatible default: glm-5.3 keeps the Scaleway
		// ladder, limits, and pricing through the bundled-reference merge.
		const glm = models?.find(model => model.id === "glm-5.3");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(glm?.contextWindow).toBe(262_144);
		expect(glm?.maxTokens).toBe(16_384);
		expect(glm?.cost).toEqual({ input: 2.02, output: 6.18, cacheRead: 0, cacheWrite: 0 });

		// gpt-oss-120b is the one ladder not authored for Scaleway; its
		// Harmony contract travels with the bundled reference.
		const gptOss = models?.find(model => model.id === "gpt-oss-120b");
		expect(gptOss?.reasoning).toBe(true);
		expect(gptOss?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);

		// A bare non-reasoning row with no reasoning metadata stays
		// non-reasoning — discovery never fabricates a dial.
		const llama = models?.find(model => model.id === "llama-3.3-70b-instruct");
		expect(llama?.reasoning).toBe(false);
		expect(llama?.thinking).toBeUndefined();
	});

	test("roster exclusion classifies Scaleway's non-chat SKUs without touching chat ids", () => {
		expect(isScalewayChatModelId("glm-5.3")).toBe(true);
		expect(isScalewayChatModelId("GLM-5.3")).toBe(true);
		expect(isScalewayChatModelId("llama-3.3-70b-instruct")).toBe(true);
		expect(isScalewayChatModelId("whisper-large-v3")).toBe(false);
		expect(isScalewayChatModelId("qwen3-embedding-8b")).toBe(false);
		expect(isScalewayChatModelId("bge-multilingual-gemma2")).toBe(false);
		expect(isScalewayChatModelId("lightonocr-3-0.8b")).toBe(false);
		expect(isScalewayChatModelId("   ")).toBe(false);
	});
});
