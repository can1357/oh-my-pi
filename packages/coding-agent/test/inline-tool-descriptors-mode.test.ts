import { describe, expect, test } from "bun:test";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { shouldInlineToolDescriptors } from "@oh-my-pi/pi-coding-agent/config/inline-tool-descriptors-mode";

function model(id: string): CatalogPolicyInputs {
	return { id, api: "openai-completions", provider: "openai", reasoning: false };
}

describe("shouldInlineToolDescriptors", () => {
	test("honors explicit on and off regardless of model", () => {
		expect(shouldInlineToolDescriptors("on", model("claude-opus-4-8"))).toBe(true);
		expect(shouldInlineToolDescriptors("on", undefined)).toBe(true);
		expect(shouldInlineToolDescriptors("off", model("gemini-3-pro"))).toBe(false);
	});

	test("auto inlines for Gemini models", () => {
		expect(shouldInlineToolDescriptors("auto", model("gemini-3-pro"))).toBe(true);
		expect(shouldInlineToolDescriptors("auto", model("gemini-3.1-flash"))).toBe(true);
		// Namespaced/aggregator ids fold onto the gemini lineage too.
		expect(shouldInlineToolDescriptors("auto", model("openrouter/google/gemini-3-pro"))).toBe(true);
	});

	test("auto keeps Antigravity CLI descriptors in schemas without changing other Gemini providers", () => {
		const argon = getBundledModel("antigravity-cli", "gemini-4-argon");
		const hydrogen = getBundledModel("antigravity-cli", "gemini-4-hydrogen");
		const google = getBundledModel("google", "gemini-3-pro-preview");
		expect(shouldInlineToolDescriptors("auto", argon)).toBe(false);
		expect(shouldInlineToolDescriptors(undefined, hydrogen)).toBe(false);
		expect(shouldInlineToolDescriptors("auto", google)).toBe(true);
		expect(shouldInlineToolDescriptors("on", hydrogen)).toBe(true);
	});

	test("auto stays off for non-Gemini models and missing model", () => {
		expect(shouldInlineToolDescriptors("auto", model("claude-opus-4-8"))).toBe(false);
		expect(shouldInlineToolDescriptors("auto", model("gpt-5.4"))).toBe(false);
		expect(shouldInlineToolDescriptors("auto", undefined)).toBe(false);
	});

	test("undefined setting defaults to auto", () => {
		expect(shouldInlineToolDescriptors(undefined, model("gemini-3-pro"))).toBe(true);
		expect(shouldInlineToolDescriptors(undefined, model("claude-opus-4-8"))).toBe(false);
	});
});
