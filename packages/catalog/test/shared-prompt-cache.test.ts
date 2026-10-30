import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { buildModel } from "../src/build";
import { resolveCatalogPolicy } from "../src/compat/catalog-policy";
import { resolveCascadeRules } from "../src/compat/cascade";
import { getBundledModel, getBundledModels } from "../src/models";
import { museCodeModelManagerOptions } from "../src/provider-models/openai-compat";
import type { Model } from "../src/types";

describe("task sibling prompt-cache opt-in", () => {
	const muse = getBundledModel("muse-code", "muse-spark-1.3-contributor");

	test("enables the six exact Spark and Wonder models only on the Muse Code Responses route", async () => {
		const ids = [
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
			"muse-wonder-1.0",
			"muse-wonder-1.0-contributor",
			"muse-wonder-full-1.0",
			"muse-wonder-full-1.0-contributor",
		];
		const options = museCodeModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				Response.json({ data: ids.map(id => ({ id, object: "model", created: 0, owned_by: "meta" })) }),
		});
		const models = (await options.fetchDynamicModels?.())?.map(buildModel);
		expect(models?.map(model => model.id).sort()).toEqual([...ids].sort());
		for (const model of models ?? []) {
			expect(resolveCatalogPolicy(model).sharedPromptCache, model.id).toBe(true);
		}
		const unsupported: Model[] = [
			{ ...muse, id: "muse-spark-1.2-contributor" },
			{ ...muse, id: "muse-spark-1.4-contributor" },
			{ ...muse, id: "muse-wonder-1.1" },
			{ ...muse, id: "muse-wonder-full-1.1-contributor" },
			{ ...muse, id: "muse-wonder-1.0", provider: "meta", providerType: undefined },
			{ ...muse, id: "muse-wonder-full-1.0-contributor", api: "openai-completions" },
			{ ...muse, provider: "meta", providerType: undefined },
			{ ...muse, provider: "custom-host", providerType: undefined },
			{ ...muse, api: "openai-completions" },
			getBundledModel("openai-codex", "gpt-6-luna"),
			getBundledModel("google-antigravity", "gemini-3.8-flash"),
		];
		for (const model of unsupported) {
			expect(resolveCatalogPolicy(model).sharedPromptCache, `${model.provider}/${model.id}/${model.api}`).not.toBe(
				true,
			);
		}
	});

	test("enables the probe-verified Go Responses and Completions lanes and no other Go or Zen route", () => {
		const go = (id: string) => getBundledModel("opencode-go", id);
		const responses = [
			"gpt-5.6-luna",
			"gpt-6-luna",
			"grok-4.6",
			"muse-spark-1.3-contributor",
			"muse-spark-1.2-contributor",
		];
		const completions = ["deepseek-v4-pro", "omen-alpha"];
		// Live Go discovery serves `omen-alpha` but the bundle ships no row;
		// the verified sibling on the same Completions lane supplies the wire
		// facts, like the gateway-only standard Muse ids below.
		const laneModel = (id: string): Model => (id === "omen-alpha" ? { ...go("deepseek-v4-pro"), id } : go(id));
		const optedIn = [...responses, ...completions].map(laneModel);
		for (const model of optedIn) {
			expect(resolveCatalogPolicy(model).sharedPromptCache, `${model.provider}/${model.id}/${model.api}`).toBe(true);
		}
		// The opt-in matches the lane each id was measured on, so the same id
		// declared on any other wire never inherits the shared key.
		const wrongApi: Model[] = [
			...responses.map(id => ({ ...laneModel(id), api: "openai-completions" })),
			...completions.map(id => ({ ...laneModel(id), api: "openai-responses" })),
		];
		for (const model of wrongApi) {
			expect(resolveCatalogPolicy(model).sharedPromptCache, `${model.provider}/${model.id}/${model.api}`).not.toBe(
				true,
			);
		}
		const unsupported: Model[] = [
			// Warmed under a different key too (key-independent) or inconsistently.
			go("grok-4.7"),
			go("glm-5.1"),
			go("glm-5.3-flash"),
			go("kimi-k2.7-code"),
			go("mimo-v2.6-flash"),
			go("deepseek-v4.1-flash"),
			go("claude-haiku-5-5"),
			// Argon showed no material warm hit (unproven) and DeepSeek V4
			// Flash was not measured; Minimax and Beam warmed under any key,
			// so a shared key buys nothing there.
			go("gemini-4-argon-contributor"),
			go("deepseek-v4-flash"),
			go("minimax-m2.7"),
			go("beam-free"),
			// Qwen 3.6 Plus likewise showed no material warm hit (unproven,
			// not shown broken), and the upstream rejects the MiMo 2.5 Pro
			// lane outright (HTTP 400 "Unsupported model").
			go("qwen3.6-plus"),
			go("mimo-v2.5-pro"),
			// Gateway-only standard ids ship no bundled row; the verified
			// Contributor sibling supplies the wire facts. Only Contributor
			// 1.3 and 1.2 were exactly lane-verified, so the standard ids
			// stay off.
			{ ...go("muse-spark-1.3-contributor"), id: "muse-spark-1.3" },
			{ ...go("muse-spark-1.2-contributor"), id: "muse-spark-1.2" },
			// Zen shares the gateway family but is not opted in.
			getBundledModel("opencode-zen", "claude-haiku-5-5"),
			getBundledModel("opencode-zen", "kimi-k2.7-code"),
			getBundledModel("opencode-zen", "muse-spark-1.3-contributor-free"),
			// Native Muse keeps only its six opted-in Spark and Wonder lanes.
			{ ...muse, id: "muse-spark-1.2-contributor" },
		];
		for (const model of unsupported) {
			expect(resolveCatalogPolicy(model).sharedPromptCache, `${model.provider}/${model.id}/${model.api}`).not.toBe(
				true,
			);
		}
		// Complement sweep: the cache-compatible-but-non-isolating lanes, the
		// unproven routes and every other bundled Go route keep per-child
		// routing — nothing outside the opted-in set may resolve the flag.
		const optedIds = new Set(optedIn.map(model => model.id));
		for (const model of getBundledModels("opencode-go")) {
			expect(
				resolveCatalogPolicy(model).sharedPromptCache === true,
				`${model.provider}/${model.id}/${model.api}`,
			).toBe(optedIds.has(model.id));
		}
	});

	test("honors an explicitly declared backend for custom provider names", () => {
		expect(
			resolveCatalogPolicy({ ...muse, provider: "custom-muse", providerType: "muse-code" }).sharedPromptCache,
		).toBe(true);
		expect(resolveCatalogPolicy({ ...muse, providerType: "meta" }).sharedPromptCache).not.toBe(true);
	});

	test("allows a narrower false rule to disable sharing and rejects string booleans", () => {
		const cascade = compileCascade([
			{
				file: "providers/test.kdl",
				text: 'provider "test" { shared-prompt-cache #true; models "disabled" { shared-prompt-cache #false } }',
			},
		]);
		expect(
			resolveCascadeRules(cascade, {
				provider: "test",
				api: "openai-responses",
				class: "unknown",
				model: "disabled",
				reasoning: false,
			}).catalog.sharedPromptCache,
		).toBe(false);
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "test" { shared-prompt-cache "false" }',
				},
			]),
		).toThrow(/shared-prompt-cache.*rejects value/);
	});
});

describe("catalog policy memo key", () => {
	const go = (id: string) => getBundledModel("opencode-go", id);
	/** Custom Go Task alias shape: unknown logical id resolved under its wire id. */
	const alias = (id: string, requestModelId: string | undefined): Model => ({
		...go("gpt-6-luna"),
		id,
		requestModelId,
	});

	test("re-resolves the alias when a projection drops or changes requestModelId after a wire-id prime", () => {
		const id = "review-memo-alias-wire-first";
		// Primary session: the alias opts in through gpt-6-luna, a verified Go
		// Responses lane member, so the memo primes `true`.
		expect(resolveCatalogPolicy(alias(id, "gpt-6-luna")).sharedPromptCache).toBe(true);
		// A compaction-style projection keeps the same logical alias but drops
		// the wire id; the alias itself classifies as unknown, so no lane rule
		// may match it — the axis stays off (absent, feature-off).
		expect(resolveCatalogPolicy(alias(id, undefined)).sharedPromptCache).not.toBe(true);
		// A different wire id must re-resolve too: grok-4.5 was never verified
		// on the Responses lane (grok-4.6/4.7 were).
		expect(resolveCatalogPolicy(alias(id, "grok-4.5")).sharedPromptCache).not.toBe(true);
	});

	test("re-resolves the alias when a projection supplies requestModelId after a bare prime", () => {
		const id = "review-memo-alias-bare-first";
		// The projection arriving bare must not pin the answer for the later
		// wire-id resolution (the reverse prime order of the compaction chain).
		expect(resolveCatalogPolicy(alias(id, undefined)).sharedPromptCache).not.toBe(true);
		expect(resolveCatalogPolicy(alias(id, "gpt-6-luna")).sharedPromptCache).toBe(true);
	});

	test("keeps native lane policy independent of requestModelId in either prime order", () => {
		// Opted native lane member: identical verdict with and without a wire
		// id naming itself, in either prime order.
		expect(resolveCatalogPolicy({ ...go("gpt-6-luna"), requestModelId: "gpt-6-luna" }).sharedPromptCache).toBe(true);
		expect(resolveCatalogPolicy(go("gpt-6-luna")).sharedPromptCache).toBe(true);
		// Non-opted native lane member: its own known id wins over a wire id
		// pointing at an opted sibling, in either prime order.
		expect(resolveCatalogPolicy(go("minimax-m2.7")).sharedPromptCache).not.toBe(true);
		expect(resolveCatalogPolicy({ ...go("minimax-m2.7"), requestModelId: "gpt-6-luna" }).sharedPromptCache).not.toBe(
			true,
		);
	});
});
