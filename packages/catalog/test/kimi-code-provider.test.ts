import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { kimiCodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const LIVE_K3 = {
	id: "k3",
	display_name: "K3",
	context_length: 1_048_576,
	supports_reasoning: true,
	supports_thinking_type: "only",
	think_efforts: {
		support: true,
		valid_efforts: ["low", "high", "max"],
		default_effort: "max",
	},
	protocol: null,
};

async function discover(models: readonly Record<string, unknown>[]) {
	const fetchImpl: FetchImpl = async () => Response.json({ data: models });
	const fetchDynamicModels = kimiCodeModelManagerOptions({ apiKey: "test-key", fetch: fetchImpl }).fetchDynamicModels;
	if (!fetchDynamicModels) throw new Error("Kimi Code dynamic discovery is not configured");
	return (await fetchDynamicModels())?.map(buildModel) ?? [];
}

describe("Kimi Code provider catalog", () => {
	it("uses live K3 effort, mandatory-thinking, and native-protocol metadata", async () => {
		const models = await discover([LIVE_K3]);
		const model = models.find(candidate => candidate.id === "k3");

		expect(model).toMatchObject({
			id: "k3",
			name: "K3",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				defaultLevel: Effort.Max,
				requiresEffort: true,
			},
			compat: {
				thinkingFormat: "kimi",
				kimiApiFormat: "openai",
			},
		});
	});

	it("uses server protocol while preserving legacy K2 discovery defaults", async () => {
		const models = await discover([
			{ ...LIVE_K3, id: "k3-anthropic", protocol: "anthropic" },
			{
				id: "kimi-for-coding",
				display_name: "K2.7 Code",
				context_length: 262_144,
				supports_reasoning: true,
			},
		]);
		const anthropic = models.find(candidate => candidate.id === "k3-anthropic");
		const legacy = models.find(candidate => candidate.id === "kimi-for-coding");

		expect(anthropic?.compat.kimiApiFormat).toBe("anthropic");
		expect(legacy?.compat).toMatchObject({ thinkingFormat: "zai" });
		// Unreported protocol resolves the provider-root KDL default (kimi-api-format "anthropic").
		expect(legacy?.compat.kimiApiFormat).toBe("anthropic");
		expect(legacy?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("derives per-family output caps instead of a blanket constant (#6711)", async () => {
		const models = await discover([
			LIVE_K3,
			{ ...LIVE_K3, id: "k3-256k", display_name: "K3 256k", context_length: 262_144 },
			{ id: "kimi-for-coding", display_name: "K2.7 Code", context_length: 262_144, supports_reasoning: true },
			{
				id: "kimi-for-coding-highspeed",
				display_name: "K2.7 Code Highspeed",
				context_length: 262_144,
				supports_reasoning: true,
			},
			{ id: "kimi-k2", display_name: "Kimi K2", context_length: 262_144 },
		]);
		const maxTokensFor = (id: string) => models.find(model => model.id === id)?.maxTokens;

		expect(maxTokensFor("k3")).toBe(131_072);
		expect(maxTokensFor("k3-256k")).toBe(131_072);
		expect(maxTokensFor("kimi-for-coding")).toBe(32_768);
		expect(maxTokensFor("kimi-for-coding-highspeed")).toBe(32_768);
		expect(maxTokensFor("kimi-k2")).toBe(32_000);
	});

	it("lets supports_thinking_type override the legacy reasoning flag", async () => {
		const models = await discover([
			{ ...LIVE_K3, id: "non-thinking", supports_thinking_type: "no", think_efforts: undefined },
		]);

		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinking).toBeUndefined();
	});
});
