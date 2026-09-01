import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { filterModelsDevCatalogRows } from "@oh-my-pi/pi-catalog/provider-models/models-dev-policies";
import {
	BEDROCK_MANTLE_STATIC_MODELS,
	bedrockMantleModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec, Usage } from "@oh-my-pi/pi-catalog/types";

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

	test("us.openai.gpt-5.6-sol gets automatic caching and no sampling params; Anthropic Bedrock ids keep explicit checkpoints and sampling", () => {
		const gpt56 = buildModel(bedrockModel("amazon-bedrock", "us.openai.gpt-5.6-sol"));
		expect(gpt56.compat.promptCacheMode).toBe("automatic");
		expect(gpt56.compat.supportsSamplingParams).toBe(false);

		const claude = buildModel(bedrockModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"));
		expect(claude.compat.promptCacheMode).toBe("explicit");
		expect(claude.compat.supportsSamplingParams).toBe(true);
	});

	test("routes GPT-5.6 Converse ids to effort-mode thinking; gpt-oss stays budget-mode", () => {
		const gpt56 = buildModel(bedrockModel("amazon-bedrock", "us.openai.gpt-5.6-sol"));
		expect(gpt56.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});

		const gptOss = buildModel(bedrockModel("amazon-bedrock", "openai.gpt-oss-120b"));
		expect(gptOss.thinking?.mode).toBe("budget");
	});

	test("prices Bedrock's automatic-cache buckets and the long-context tier for GPT-5.6 Sol (US)", () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.openai.gpt-5.6-sol");

		// First call: ordinary prompt tokens land in cacheWriteInputTokens (Bedrock's automatic
		// caching), not inputTokens — the short-tier write rate must price them, not the read rate.
		const first: Usage = {
			input: 2,
			output: 5,
			cacheRead: 0,
			cacheWrite: 3020,
			totalTokens: 3027,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, first);
		expect(first.cost.input).toBeCloseTo((2 * 5.5) / 1_000_000, 10);
		expect(first.cost.cacheWrite).toBeCloseTo((3020 * 6.875) / 1_000_000, 10);
		expect(first.cost.output).toBeCloseTo((5 * 33) / 1_000_000, 10);
		expect(first.cost.cacheRead).toBe(0);

		// Second call: the same tokens now come back as a cache read.
		const second: Usage = {
			input: 2,
			output: 5,
			cacheRead: 3020,
			cacheWrite: 0,
			totalTokens: 3027,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, second);
		expect(second.cost.cacheRead).toBeCloseTo((3020 * 0.55) / 1_000_000, 10);

		// Crossing the 272K long-context threshold prices the whole request at the long tier.
		const longContext: Usage = {
			input: 300_000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 301_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, longContext);
		expect(longContext.cost.input).toBeCloseTo((300_000 * 11) / 1_000_000, 10);
		expect(longContext.cost.output).toBeCloseTo((1000 * 49.5) / 1_000_000, 10);
	});
});
