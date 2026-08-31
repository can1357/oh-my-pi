import { describe, expect, test } from "bun:test";
import { normalizeGrokbotAvailableModels } from "../src/discovery/grokbot";
import {
	decodeGrokbotAvailableModelsResponse,
	encodeGrokbotAvailableModelsRequest,
} from "../src/discovery/grokbot-available-models";

const FIXTURE = {
	models: [
		{
			name: "default",
			clientDisplayName: "Auto",
			supportsThinking: false,
			supportsImages: true,
			idAliases: ["auto"],
			parameterDefinitions: [],
			variants: [{ displayName: "Auto", isDefaultNonMaxConfig: true, parameterValues: [] }],
		},
		{
			name: "grok-4.6",
			clientDisplayName: "Cursor Grok 4.6",
			supportsThinking: true,
			supportsImages: true,
			contextTokenLimit: 256_000,
			parameterDefinitions: [{ id: "effort" }, { id: "fast" }],
			variants: [
				{
					parameterValues: [
						{ id: "effort", value: "low" },
						{ id: "fast", value: "false" },
					],
				},
				{
					parameterValues: [
						{ id: "effort", value: "xhigh" },
						{ id: "fast", value: "true" },
					],
				},
			],
		},
		{
			name: "composer-2.5",
			clientDisplayName: "Composer 2.5",
			supportsThinking: true,
			supportsImages: false,
			idAliases: ["composer-latest", "composer", "composer-2-5"],
			parameterDefinitions: [{ id: "fast" }],
			variants: [
				{
					parameterValues: [{ id: "fast", value: "false" }],
					legacySlug: "composer-2",
				},
			],
		},
		{
			name: "max-only-model",
			clientDisplayName: "Max Only",
			supportsThinking: true,
			supportsImages: true,
			supportsMaxMode: true,
			supportsNonMaxMode: false,
			contextTokenLimit: 200_000,
			contextTokenLimitForMaxMode: 1_000_000,
			parameterDefinitions: [{ id: "effort" }],
			variants: [
				{
					isDefaultMaxConfig: true,
					parameterValues: [{ id: "effort", value: "high" }],
				},
			],
		},
		{
			name: "max-only-omitted-nonmax",
			clientDisplayName: "Max Only Omitted NonMax",
			supportsThinking: true,
			supportsImages: true,
			supportsMaxMode: true,
			// proto3 omits false — supportsNonMaxMode absent
			contextTokenLimit: 200_000,
			contextTokenLimitForMaxMode: 900_000,
			parameterDefinitions: [{ id: "effort" }],
			variants: [
				{
					isDefaultMaxConfig: true,
					parameterValues: [{ id: "effort", value: "high" }],
				},
			],
		},
		{
			name: "hidden-legacy",
			clientDisplayName: "Hidden",
			isHidden: true,
			supportsThinking: false,
			parameterDefinitions: [],
		},
		{
			name: "gpt-5.6-sol",
			clientDisplayName: "GPT-5.6 Sol",
			supportsThinking: true,
			supportsImages: true,
			contextTokenLimit: 272_000,
			idAliases: ["gpt-latest", "gpt"],
			parameterDefinitions: [{ id: "context" }, { id: "reasoning" }, { id: "fast" }],
			variants: [
				{
					parameterValues: [
						{ id: "reasoning", value: "medium" },
						{ id: "context", value: "272k" },
						{ id: "fast", value: "false" },
					],
				},
			],
		},
		{
			name: "text-only-omitted-images",
			clientDisplayName: "Text Only Omitted Images",
			supportsThinking: false,
			// proto3 omits false — supportsImages absent
			parameterDefinitions: [],
			variants: [{ parameterValues: [] }],
		},
		{
			name: "effort-with-minimal",
			clientDisplayName: "Effort With Minimal",
			supportsThinking: true,
			supportsImages: true,
			parameterDefinitions: [{ id: "effort" }],
			variants: [
				{ parameterValues: [{ id: "effort", value: "xhigh" }] },
				{ parameterValues: [{ id: "effort", value: "minimal" }] },
				{ parameterValues: [{ id: "effort", value: "low" }] },
				{ parameterValues: [{ id: "effort", value: "max" }] },
			],
		},
	],
};

describe("grokbot AvailableModels normalize", () => {
	test("encodes parameterized request body", () => {
		expect(JSON.parse(encodeGrokbotAvailableModelsRequest())).toEqual({ useModelParameters: true });
	});

	test("drops isHidden, unions sand routers, keeps aliases and param ids", () => {
		const rows = decodeGrokbotAvailableModelsResponse(FIXTURE);
		expect(rows).not.toBeNull();
		const models = normalizeGrokbotAvailableModels(rows!, "https://api2.cursor.sh");
		const ids = models.map(m => m.id);
		expect(ids).not.toContain("hidden-legacy");
		expect(ids).toContain("sand-default");
		expect(ids).toContain("sand-cua");
		expect(ids).toContain("sand-automation");
		expect(ids).toContain("grok-4.6");
		expect(ids).toContain("composer-2.5");

		const composer = models.find(m => m.id === "composer-2.5");
		expect(composer?.aliases).toEqual(["composer-latest", "composer", "composer-2-5", "composer-2"]);
		expect(composer?.sandParameterIds).toEqual(["fast"]);
		const composerLegacy = models.find(m => m.id === "composer-2");
		expect(composerLegacy?.requestModelId).toBe("composer-2.5");
		expect(composerLegacy?.sandParameterIds).toEqual(["fast"]);
		expect(composer?.input).toEqual(["text"]);
		expect(composer?.sandMaxMode).toBe(false);

		const textOnlyOmitted = models.find(m => m.id === "text-only-omitted-images");
		expect(textOnlyOmitted?.input).toEqual(["text"]);

		const maxOnly = models.find(m => m.id === "max-only-model");
		expect(maxOnly?.sandMaxMode).toBe(true);
		expect(maxOnly?.contextWindow).toBe(1_000_000);

		const maxOnlyOmitted = models.find(m => m.id === "max-only-omitted-nonmax");
		expect(maxOnlyOmitted?.sandMaxMode).toBe(true);
		expect(maxOnlyOmitted?.contextWindow).toBe(900_000);

		const grok = models.find(m => m.id === "grok-4.6");
		expect(grok?.sandParameterIds).toEqual(["effort", "fast"]);
		expect([...((grok?.thinking?.efforts as readonly string[] | undefined) ?? [])]).toEqual(["low", "xhigh"]);
		expect(grok?.contextWindow).toBe(256_000);
		expect(grok?.sandMaxMode).toBe(false);
		expect(grok?.input).toEqual(["text", "image"]);
		// Discovery must not invent output/context caps the response never supplied.
		expect(grok?.maxTokens).toBeNull();
		expect(composer?.maxTokens).toBeNull();
		expect(composer?.contextWindow).toBeNull();
		expect(textOnlyOmitted?.contextWindow).toBeNull();
		expect(models.find(m => m.id === "sand-default")?.maxTokens).toBeNull();
		expect(models.find(m => m.id === "sand-default")?.contextWindow).toBeNull();

		const sol = models.find(m => m.id === "gpt-5.6-sol");
		expect(sol?.sandParameterIds).toEqual(["context", "reasoning", "fast"]);
		expect(sol?.sandParameterDefaults).toEqual({
			reasoning: "medium",
			context: "272k",
			fast: "false",
		});
		expect(sol?.aliases).toContain("gpt");

		const auto = models.find(m => m.id === "default");
		expect(auto?.sandParameterIds).toEqual([]);
		expect(auto?.aliases).toEqual(["auto"]);
		expect(auto?.contextWindow).toBeNull();

		const sandDefault = models.find(m => m.id === "sand-default");
		expect(sandDefault?.sandParameterIds).toEqual([]);
		expect(sandDefault?.reasoning).toBe(true);
		expect(sandDefault?.input).toEqual(["text"]);
		expect(models.find(m => m.id === "sand-cua")?.input).toEqual(["text"]);

		const withMinimal = models.find(m => m.id === "effort-with-minimal");
		expect([...((withMinimal?.thinking?.efforts as readonly string[] | undefined) ?? [])]).toEqual([
			"minimal",
			"low",
			"xhigh",
			"max",
		]);
	});

	test("trims whitespace from AvailableModels model ids", () => {
		const rows = decodeGrokbotAvailableModelsResponse({
			models: [
				{
					name: " sand-default ",
					clientDisplayName: "Sand Default",
					supportsThinking: true,
					idAliases: [" sand-default "],
					parameterDefinitions: [],
					variants: [{ parameterValues: [] }],
				},
			],
		});
		expect(rows).not.toBeNull();
		const models = normalizeGrokbotAvailableModels(rows!);
		expect(models.filter(m => m.id === "sand-default")).toHaveLength(1);
		const sandDefault = models.find(m => m.id === "sand-default");
		expect(sandDefault?.name).toBe("Sand Default");
		expect(sandDefault?.aliases).toBeUndefined();
	});

	test("does not invent common ladder when upstream values are all unrecognized", () => {
		const rows = decodeGrokbotAvailableModelsResponse({
			models: [
				{
					name: "adaptive-only",
					clientDisplayName: "Adaptive Only",
					supportsThinking: true,
					supportsImages: true,
					parameterDefinitions: [
						{
							id: "effort",
							values: [{ value: "adaptive", displayName: "Adaptive" }],
						},
					],
					variants: [{ parameterValues: [{ id: "effort", value: "adaptive" }] }],
				},
				{
					name: "effort-param-no-values",
					clientDisplayName: "Effort Param No Values",
					supportsThinking: true,
					supportsImages: true,
					parameterDefinitions: [{ id: "effort" }],
					variants: [{ parameterValues: [] }],
				},
			],
		});
		expect(rows).not.toBeNull();
		const models = normalizeGrokbotAvailableModels(rows!, "https://api2.cursor.sh");
		const adaptive = models.find(m => m.id === "adaptive-only");
		expect(adaptive?.sandParameterIds).toEqual(["effort"]);
		expect(adaptive?.thinking).toEqual({ mode: "effort", efforts: [] });
		const emptyValues = models.find(m => m.id === "effort-param-no-values");
		expect(emptyValues?.sandParameterIds).toEqual(["effort"]);
		expect([...((emptyValues?.thinking?.efforts as readonly string[] | undefined) ?? [])]).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	test("rejects envelopes without a models array; empty models is valid", () => {
		expect(decodeGrokbotAvailableModelsResponse(null)).toBeNull();
		expect(decodeGrokbotAvailableModelsResponse({})).toBeNull();
		expect(decodeGrokbotAvailableModelsResponse({ error: "upstream" })).toBeNull();
		expect(decodeGrokbotAvailableModelsResponse({ models: "not-an-array" })).toBeNull();
		expect(decodeGrokbotAvailableModelsResponse({ models: [] })).toEqual([]);
	});
});
