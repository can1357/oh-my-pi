import { describe, expect, test } from "bun:test";
import { shouldInlineToolDescriptors } from "@oh-my-pi/pi-coding-agent/config/inline-tool-descriptors-mode";

describe("shouldInlineToolDescriptors", () => {
	test("honors explicit on and off regardless of model", () => {
		expect(shouldInlineToolDescriptors("on", "claude-opus-4-8")).toBe(true);
		expect(shouldInlineToolDescriptors("on", undefined)).toBe(true);
		expect(shouldInlineToolDescriptors("off", "gemini-3-pro")).toBe(false);
	});

	test("auto inlines for Gemini models", () => {
		expect(shouldInlineToolDescriptors("auto", "gemini-3-pro")).toBe(true);
		expect(shouldInlineToolDescriptors("auto", "gemini-3.1-flash")).toBe(true);
		// Namespaced/aggregator ids fold onto the gemini lineage too.
		expect(shouldInlineToolDescriptors("auto", "google-gemini-cli/gemini-3-pro")).toBe(true);
	});

	test("auto stays off for non-Gemini models and missing model", () => {
		expect(shouldInlineToolDescriptors("auto", "claude-opus-4-8")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", "gpt-5.4")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", undefined)).toBe(false);
	});

	test("undefined setting defaults to auto", () => {
		expect(shouldInlineToolDescriptors(undefined, "gemini-3-pro")).toBe(true);
		expect(shouldInlineToolDescriptors(undefined, "claude-opus-4-8")).toBe(false);
	});
});
