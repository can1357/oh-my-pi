import { expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCascadeRules } from "@oh-my-pi/pi-catalog/compat/cascade";
import { supportsOutputTokenLimit } from "@oh-my-pi/pi-catalog/compat/output-limits";
import { requiresNativeTools, requiresToolFreeHistoryForToolOptOut } from "@oh-my-pi/pi-catalog/compat/tools";
import { getBundledModel, getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { compileCompatRules } from "../scripts/compat-compiler";

function fixture(provider: GeneratedProvider, predicate?: (candidate: Model) => boolean): Model {
	const models = getBundledModels(provider);
	const found = predicate ? models.find(predicate) : models[0];
	if (!found) throw new Error(`missing bundled fixture for ${provider}`);
	return found;
}

test("google-antigravity vetoes caller output caps while the gemini-cli lane preserves them", () => {
	// Both providers ride the google-gemini-cli api; only the provider-scoped
	// preserves-max-output-tokens rule may separate them.
	expect(fixture("google-antigravity").api).toBe(fixture("google-gemini-cli").api);
	expect(supportsOutputTokenLimit(fixture("google-antigravity"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("google-gemini-cli"))).toBe(true);
});

test("transports that cannot encode output limits are omitted", () => {
	expect(supportsOutputTokenLimit(fixture("openai-codex", m => m.api === "openai-codex-responses"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("cursor", m => m.api === "cursor-agent"))).toBe(false);
	expect(supportsOutputTokenLimit(fixture("gitlab-duo-agent"))).toBe(false);
	// Model-level omitMaxOutputTokens still vetoes through the same helper.
	expect(supportsOutputTokenLimit(fixture("ollama-cloud"))).toBe(false);
	// Providers riding encoding-capable apis are unaffected.
	expect(supportsOutputTokenLimit(fixture("gitlab-duo", m => m.api === "anthropic-messages"))).toBe(true);
	expect(supportsOutputTokenLimit(getBundledModel("anthropic", "claude-sonnet-4-6")!)).toBe(true);
});

test("requiresNativeTools marks only cursor-agent transports", () => {
	expect(requiresNativeTools(fixture("cursor", m => m.api === "cursor-agent"))).toBe(true);
	expect(requiresNativeTools(fixture("gitlab-duo", m => m.api === "anthropic-messages"))).toBe(false);
});

test("requiresToolFreeHistoryForToolOptOut marks only bedrock-converse-stream", () => {
	expect(requiresToolFreeHistoryForToolOptOut(fixture("amazon-bedrock", m => m.reasoning))).toBe(true);
	expect(requiresToolFreeHistoryForToolOptOut(getBundledModel("anthropic", "claude-sonnet-4-6")!)).toBe(false);
});

test("KDL opts only the verified Codex image deployment into explicit backgrounds", async () => {
	const { cascade } = await compileCompatRules(path.join(import.meta.dir, "../src/compat/rules"));
	const optIns = cascade.rules.filter(rule => rule.catalog?.imageBackground === true);
	expect(optIns).toHaveLength(1);
	expect(optIns[0]).toMatchObject({
		providers: ["openai-codex"],
		apis: ["openai-codex-responses"],
		models: [{ kind: "exact", value: "gpt-image-2" }],
	});
	const target = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-image-2",
		class: "openai",
		reasoning: false,
	};
	expect(resolveCascadeRules(cascade, target).catalog.imageBackground).toBe(true);
	for (const overrides of [
		{ provider: "openai", api: "openai-images" },
		{ provider: "openai", api: "openai-responses" },
		{ provider: "deepinfra", api: "openai-images", model: "black-forest-labs/FLUX-2-pro" },
		{ provider: "custom-images", api: "openai-images" },
		{ api: "openai-images" },
		{ model: "gpt-image-1" },
		{ model: "gpt-5.4" },
	]) {
		expect(resolveCascadeRules(cascade, { ...target, ...overrides }).catalog.imageBackground).toBeUndefined();
	}
});

test("authored image background metadata opts in only the official Codex deployment and clears stale copies", () => {
	const spec: ModelSpec = {
		id: "gpt-image-2",
		name: "GPT Image 2",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
	const model = buildModel(spec);
	expect(model.imageBackground).toBe(true);
	const unsupportedDeployments: Partial<ModelSpec>[] = [
		{ provider: "openai", api: "openai-images", baseUrl: "https://api.openai.com/v1" },
		{
			provider: "deepinfra",
			api: "openai-images",
			id: "black-forest-labs/FLUX-2-pro",
			baseUrl: "https://api.deepinfra.com/v1/openai",
		},
		{ provider: "custom-images", api: "openai-images" },
		{ api: "openai-images" },
		{ id: "gpt-image-1" },
		{ baseUrl: "https://gateway.example/backend-api/codex" },
	];
	for (const overrides of unsupportedDeployments) {
		expect(buildModel({ ...spec, ...overrides }).imageBackground).toBeUndefined();
		expect(buildModel({ ...model, ...overrides }).imageBackground).toBeUndefined();
	}
});
