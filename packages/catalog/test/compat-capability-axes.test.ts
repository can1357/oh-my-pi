import { expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCascadeRules } from "@oh-my-pi/pi-catalog/compat/cascade";
import { supportsOutputTokenLimit } from "@oh-my-pi/pi-catalog/compat/output-limits";
import { requiresNativeTools, requiresToolFreeHistoryForToolOptOut } from "@oh-my-pi/pi-catalog/compat/tools";
import { getBundledModel, getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
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

test("built and bundled image background metadata is conservative across deployment changes", () => {
	const bundled = getBundledModel("openai-codex", "gpt-image-2");
	expect(bundled.imageBackground).toBe(true);
	const model = buildModel(bundled);
	expect(model.imageBackground).toBe(true);
	for (const overrides of [
		{ provider: "openai", api: "openai-images" as const },
		{ provider: "deepinfra", api: "openai-images" as const, id: "black-forest-labs/FLUX-2-pro" },
		{ provider: "custom-images", api: "openai-images" as const },
		{ api: "openai-images" as const },
		{ id: "gpt-image-1" },
	]) {
		expect(buildModel({ ...model, ...overrides }).imageBackground).toBeUndefined();
	}
	expect(getBundledModel("openai", "gpt-image-2").imageBackground).toBeUndefined();
	expect(getBundledModel("deepinfra", "black-forest-labs/FLUX-2-pro").imageBackground).toBeUndefined();
});
