import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import type { FetchImpl, ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { isScalewayChatModelId, scalewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

/** One Scaleway card ladder: [id, on-tiers, default level]. */
const SCALEWAY_LADDERS: Array<[string, Effort[], Effort | undefined]> = [
	// GLM 5.3/5.2 accept `none` as a wire off value (verified live:
	// reasoning_tokens 0), diverging from the lineage glob's cannot-disable
	// contract; the residue must outrank it.
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
	// gpt-oss keeps its Harmony ladder; its card has no `none` tier.
	["gpt-oss-120b", [Effort.Low, Effort.Medium, Effort.High], undefined],
];

const NON_REASONING_IDS = [
	"qwen3-235b-a22b-instruct-2507",
	"mistral-small-3.2-24b-instruct-2506",
	"llama-3.3-70b-instruct",
];

function bundledScalewayModels() {
	return getBundledModels("scaleway");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Scaleway provider support", () => {
	test("resolves each card's documented effort ladder with `none` as the off value", () => {
		const byId = new Map(bundledScalewayModels().map(model => [model.id, model]));

		for (const [id, efforts, defaultLevel] of SCALEWAY_LADDERS) {
			const model = byId.get(id);
			expect(model?.reasoning).toBe(true);
			expect(model?.thinking?.mode).toBe("effort");
			expect(model?.thinking?.efforts).toEqual(efforts);
			expect(model?.thinking?.defaultLevel).toBe(defaultLevel);
			// The lineage glob marks glm-5.3 thinking as mandatory; Scaleway's
			// `none` tier must keep these disableable (undefined, not true).
			expect(model?.thinking?.requiresEffort).not.toBe(true);
			// Thinking-off must send reasoning_effort `none`: omitting the
			// field falls back to the server default (medium) and leaves
			// reasoning on. gpt-oss documents no `none`, so it keeps the
			// lowest-effort fallback instead.
			const compat = model?.compat as ResolvedOpenAICompat | undefined;
			const disableMode = compat?.reasoningDisableMode;
			if (id === "gpt-oss-120b") {
				expect(disableMode).not.toBe("none-effort");
			} else {
				expect(disableMode).toBe("none-effort");
			}
		}

		for (const id of NON_REASONING_IDS) {
			const model = byId.get(id);
			expect(model?.reasoning).toBe(false);
			expect(model?.thinking).toBeUndefined();
		}
	});

	test("pins serverless limits and EUR-converted pricing over same-id vendor rows", () => {
		const byId = new Map(bundledScalewayModels().map(model => [model.id, model]));

		// The same ids on first-party hosts carry different ceilings (zai
		// serves glm-5.3 at 1M/131k); Scaleway's serverless caps and
		// EUR/Mtok card (converted at the 2026-10-21 ECB rate
		// 1 EUR = 1.1234 USD) must win.
		expect(byId.get("glm-5.3")?.contextWindow).toBe(262_144);
		expect(byId.get("glm-5.3")?.maxTokens).toBe(16_384);
		expect(byId.get("glm-5.3")?.cost).toEqual({ input: 2.02, output: 6.18, cacheRead: 0, cacheWrite: 0 });
		expect(byId.get("qwen3.5-397b-a17b")?.contextWindow).toBe(256_000);
		expect(byId.get("qwen3.5-397b-a17b")?.maxTokens).toBe(16_384);
		expect(byId.get("qwen3.5-397b-a17b")?.cost).toEqual({ input: 0.67, output: 4.04, cacheRead: 0, cacheWrite: 0 });
		expect(byId.get("mistral-medium-3.5-128b")?.contextWindow).toBe(184_320);
		expect(byId.get("mistral-medium-3.5-128b")?.maxTokens).toBe(16_384);
		expect(byId.get("llama-3.3-70b-instruct")?.contextWindow).toBe(102_400);
		expect(byId.get("gpt-oss-120b")?.contextWindow).toBe(131_072);
		expect(byId.get("deepseek-v4.1-flash")?.cost).toEqual({
			input: 0.67,
			output: 2.02,
			cacheRead: 0.13,
			cacheWrite: 0,
		});
		expect(byId.get("qwen3.8-27b")?.cost).toEqual({ input: 0.67, output: 3.71, cacheRead: 0.13, cacheWrite: 0 });

		// V4.1 Flash is natively multimodal while its id carries no `vision`
		// token, so the class-wide strip carve-out must keep image input on
		// this host; the dated V4 Flash stays text-only.
		expect(byId.get("deepseek-v4.1-flash")?.input).toEqual(["text", "image"]);
		expect(byId.get("deepseek-v4-flash-0731")?.input).toEqual(["text"]);
		expect(byId.get("glm-5.3")?.input).toEqual(["text"]);

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

		expect(models?.map(model => model.id)).toEqual(["glm-5.3", "llama-3.3-70b-instruct"]);
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
