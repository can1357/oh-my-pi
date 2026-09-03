import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { filterModelsDevCatalogRows } from "@oh-my-pi/pi-catalog/provider-models/models-dev-policies";
import {
	BEDROCK_MANTLE_STATIC_MODELS,
	bedrockMantleModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const MANTLE_MODEL_IDS = [
	"openai.gpt-5.4",
	"openai.gpt-5.5",
	"openai.gpt-5.6-luna",
	"openai.gpt-5.6-sol",
	"openai.gpt-5.6-terra",
];

function bedrockModel(provider: string, id: string): ModelSpec<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider,
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

describe("Amazon Bedrock OpenAI routing", () => {
	test("seeds Responses-only models under the Bedrock Mantle provider", () => {
		expect(BEDROCK_MANTLE_STATIC_MODELS.map(model => model.id)).toEqual(MANTLE_MODEL_IDS);
		for (const model of BEDROCK_MANTLE_STATIC_MODELS) {
			expect(model.provider).toBe("bedrock-mantle");
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://bedrock-mantle.{region}.api.aws/openai/v1");
		}
		expect(DEFAULT_MODEL_PER_PROVIDER["bedrock-mantle"]).toBe("openai.gpt-5.6-terra");
	});

	test("uses current Luna and Terra pricing", () => {
		const byId = Object.fromEntries(BEDROCK_MANTLE_STATIC_MODELS.map(model => [model.id, model]));
		expect(byId["openai.gpt-5.6-luna"]?.cost).toEqual({
			input: 0.22,
			output: 1.32,
			cacheRead: 0.022,
			cacheWrite: 0.275,
		});
		expect(byId["openai.gpt-5.6-terra"]?.cost).toEqual({
			input: 2.2,
			output: 13.2,
			cacheRead: 0.22,
			cacheWrite: 2.75,
		});
	});

	test("account-scoped discovery is authoritative over the static seed", async () => {
		let requestedUrl = "";
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				requestedUrl = String(input);
				return Response.json({
					data: [
						{ id: "openai.gpt-5.6-luna", name: "GPT-5.6 Luna" },
						{ id: "openai.gpt-5.7-preview", name: "GPT-5.7 Preview" },
					],
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const managerOptions = bedrockMantleModelManagerOptions({
			authenticated: true,
			baseUrl: "https://bedrock-mantle.eu-west-2.api.aws/openai/v1",
			fetch: fetchImpl,
		});

		const models = await managerOptions.fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://bedrock-mantle.eu-west-2.api.aws/v1/models");
		expect(models).toHaveLength(2);
		expect(models?.[0]).toMatchObject({
			id: "openai.gpt-5.6-luna",
			baseUrl: "https://bedrock-mantle.{region}.api.aws/openai/v1",
			cost: { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
		});
		const descriptor = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "bedrock-mantle");
		expect(descriptor).toMatchObject({ dynamicModelsAuthoritative: true });
		expect(descriptor?.catalogDiscovery).toBeUndefined();

		// The bearer-scoped /v1/models response is the complete account catalog:
		// a successful refresh must prune static seeds the account cannot use.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-bedrock-mantle-"));
		try {
			const refreshed = await resolveProviderModels(
				{ ...managerOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);
			expect(refreshed.stale).toBe(false);
			expect(refreshed.models.map(model => model.id).sort()).toEqual([
				"openai.gpt-5.6-luna",
				"openai.gpt-5.7-preview",
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("drops only the unusable Converse rows for Mantle models", () => {
		const input = [
			...MANTLE_MODEL_IDS.map(id => bedrockModel("amazon-bedrock", id)),
			bedrockModel("amazon-bedrock", "openai.gpt-oss-120b"),
			bedrockModel("bedrock-mantle", "openai.gpt-5.6-sol"),
		];

		expect(filterModelsDevCatalogRows(input).map(model => `${model.provider}/${model.id}`)).toEqual([
			"amazon-bedrock/openai.gpt-oss-120b",
			"bedrock-mantle/openai.gpt-5.6-sol",
		]);
	});
});
