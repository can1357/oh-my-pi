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
	});

	test("auto stays off for Antigravity models: schemas already travel in request.tools", () => {
		// The Cloud Code Assist backend 429s large non-official system prompts, and
		// both Antigravity transports send tool schemas in request.tools anyway.
		expect(shouldInlineToolDescriptors("auto", "antigravity-cli/gemini-4-neon")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", "google-antigravity/gemini-3-pro")).toBe(false);
		// Explicit on still wins for users who want the catalog back.
		expect(shouldInlineToolDescriptors("on", "antigravity-cli/gemini-4-neon")).toBe(true);
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
