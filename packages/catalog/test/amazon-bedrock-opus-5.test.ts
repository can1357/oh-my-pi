import { describe, expect, test } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "@oh-my-pi/pi-catalog/provider-models";
import { filterModelsDevCatalogRows } from "@oh-my-pi/pi-catalog/provider-models/models-dev-policies";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// AWS's Bedrock model card for Claude Opus 5 lists these commercial/geo
// Programmatic Access IDs — the bare model ID plus the us./eu./au. Geo and
// global inference profiles. Japan is explicitly marked unsupported for Geo
// inference in the same card's regional-availability table, so no `jp.`
// profile exists for this model (unlike several Opus 4.x generations).
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
//
// The catalog also synthesizes `us-gov.*` Claude geo profiles for AWS GovCloud
// (same path as the derived `eu.*` row) so GovCloud selectors resolve without
// requiring a full inference-profile ARN.
const AWS_DOCUMENTED_OPUS_5_IDS = [
	"anthropic.claude-opus-5",
	"us.anthropic.claude-opus-5",
	"eu.anthropic.claude-opus-5",
	"au.anthropic.claude-opus-5",
	"global.anthropic.claude-opus-5",
	"us-gov.anthropic.claude-opus-5",
];

// A representative `stencil.so` "amazon-bedrock" payload for Claude Opus 5.
// stencil.so lists each inference-profile prefix as its own row (the `eu.`
// row even carries distinct EU pricing), including the `jp.` profile that AWS
// does not actually expose for this model. We reproduce that shape so the test
// exercises the real source → catalog path — `mapModelsDevToModels` plus the
// `dropUnsupportedBedrockGeoIds` generation policy — rather than the committed
// `models.json` snapshot. A non-tool model is included to confirm the
// descriptor's `tool_call` filter still drops it.
const NO_TOOL_ROW_ID = "anthropic.claude-opus-5-no-tools";

const OPUS_5_MODELS_DEV_FIXTURE = {
	"amazon-bedrock": {
		models: {
			...Object.fromEntries(
				[
					"anthropic.claude-opus-5",
					"us.anthropic.claude-opus-5",
					"eu.anthropic.claude-opus-5",
					"au.anthropic.claude-opus-5",
					"global.anthropic.claude-opus-5",
					"jp.anthropic.claude-opus-5",
				].map(id => [
					id,
					{
						name: "Claude Opus 5",
						tool_call: true,
						reasoning: true,
						limit: { context: 1_000_000, output: 128_000 },
						cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
						modalities: { input: ["text", "image"] },
					},
				]),
			),
			[NO_TOOL_ROW_ID]: {
				name: "Claude Opus 5 (no tools)",
				tool_call: false,
				reasoning: true,
				limit: { context: 1_000_000, output: 128_000 },
				cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
				modalities: { input: ["text", "image"] },
			},
		},
	},
};

describe("Amazon Bedrock Claude Opus 5", () => {
	test("source mapping plus generation policy yields exactly the AWS-documented inference-profile IDs", () => {
		// Guard the source (stencil.so descriptor + exclusion policy), not the
		// bundled snapshot: the assertion must break if the mapping or policy
		// stops reproducing the documented IDs, and must not falsely fail when
		// upstream metadata legitimately shifts.
		const allMapped = mapModelsDevToModels(OPUS_5_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS);
		// The descriptor's `tool_call !== true` filter must drop the non-tool row
		// (and never emit a derived `eu.` variant for it) before any policy runs.
		expect(allMapped.some(model => model.id.includes(NO_TOOL_ROW_ID))).toBe(false);
		const mapped = allMapped.filter(
			model => model.provider === "amazon-bedrock" && model.id.endsWith("anthropic.claude-opus-5"),
		);
		const opus5Ids = filterModelsDevCatalogRows(mapped).map(model => model.id);

		// Set semantics: the descriptor also derives `eu.` and `us-gov.` variants
		// from the bare `anthropic.` row, so `eu.` legitimately arrives from both
		// that derivation and the standalone stencil.so row (deduped downstream
		// by the generator). We assert the documented ID coverage, not row count.
		expect(new Set(opus5Ids)).toEqual(new Set(AWS_DOCUMENTED_OPUS_5_IDS));
		// `stencil.so` lists `jp.anthropic.claude-opus-5`, but Bedrock has no such
		// inference profile for this model and would reject it, so the generation
		// policy must drop it before it reaches the catalog.
		expect(opus5Ids).not.toContain("jp.anthropic.claude-opus-5");
	});

	test("dropUnsupportedBedrockGeoIds filters the undocumented jp. profile without touching other providers/ids", () => {
		const bareSpec = (provider: string, id: string): ModelSpec<"bedrock-converse-stream"> => ({
			id,
			name: id,
			api: "bedrock-converse-stream",
			provider,
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		});
		const input = [
			bareSpec("amazon-bedrock", "jp.anthropic.claude-opus-5"),
			bareSpec("amazon-bedrock", "us.anthropic.claude-opus-5"),
			// A `jp.` id on a different Bedrock model, or on a different provider,
			// must survive — only this exact (provider, id) pair is undocumented.
			bareSpec("amazon-bedrock", "jp.anthropic.claude-opus-4-8"),
			bareSpec("some-other-provider", "jp.anthropic.claude-opus-5"),
		];

		expect(filterModelsDevCatalogRows(input).map(model => model.id)).toEqual([
			"us.anthropic.claude-opus-5",
			"jp.anthropic.claude-opus-4-8",
			"jp.anthropic.claude-opus-5",
		]);
	});

	test("resolves the AWS-documented 512-token/four-checkpoint/1h prompt-cache capability", () => {
		for (const id of AWS_DOCUMENTED_OPUS_5_IDS) {
			const spec: ModelSpec<"bedrock-converse-stream"> = {
				id,
				name: id,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			};
			expect(resolveModelPolicy(spec).compat).toEqual({
				promptCacheMode: "explicit",
				supportsLongPromptCacheRetention: true,
				promptCacheMinimumTokens: 512,
				promptCacheMaximumCheckpoints: 4,
				// reasoning:true adaptive-thinking family → 900s keepalive-free idle floor.
				streamIdleTimeoutMs: 900_000,
			});
		}
	});
});
