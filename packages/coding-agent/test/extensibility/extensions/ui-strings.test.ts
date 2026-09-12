import { describe, expect, it } from "bun:test";
import {
	clearAll as clearAllUiStrings,
	clearUiStringsFor,
	registerUiStrings,
	resolveUiString,
} from "../../../src/extensibility/extensions/ui-strings";

// ── Helpers ─────────────────────────────────────────────────────────────────

function reset(): void {
	clearAllUiStrings();
}

// ── Registry / resolveUiString ──────────────────────────────────────────────

describe("resolveUiString", () => {
	it("returns fallback when no override is registered", () => {
		reset();
		expect(resolveUiString("tab.model", "Model")).toBe("Model");
	});

	it("returns override when registered", () => {
		reset();
		registerUiStrings({ strings: { "tab.model": "Model-CN" } }, "/path/to/plugin");
		expect(resolveUiString("tab.model", "Model")).toBe("Model-CN");
	});

	it("falls back when only a partial key is overridden", () => {
		reset();
		registerUiStrings({ strings: { "tab.model": "Model-CN" } }, "/path/to/plugin");
		// "tab.appearance" has no override
		expect(resolveUiString("tab.appearance", "Appearance")).toBe("Appearance");
	});
});

// ── registerUiStrings ───────────────────────────────────────────────────────

describe("registerUiStrings", () => {
	it("rejects null/undefined entry", () => {
		reset();
		// @ts-expect-error — testing runtime safety
		registerUiStrings(null, "/path");
		expect(resolveUiString("key", "fallback")).toBe("fallback");
	});

	it("rejects empty strings record", () => {
		reset();
		registerUiStrings({ strings: {} }, "/path");
		expect(resolveUiString("key", "fallback")).toBe("fallback");
	});

	it("skips empty keys", () => {
		reset();
		registerUiStrings({ strings: { "": "should not appear" } }, "/path");
		expect(resolveUiString("", "fallback")).toBe("fallback");
	});

	it("skips empty string values", () => {
		reset();
		registerUiStrings({ strings: { key: " " } }, "/path");
		expect(resolveUiString("key", "fallback")).toBe("fallback");
	});

	it("overwrites earlier registration for the same key", () => {
		reset();
		registerUiStrings({ strings: { "tab.model": "Model v1" } }, "/path/a");
		registerUiStrings({ strings: { "tab.model": "Model v2" } }, "/path/b");
		expect(resolveUiString("tab.model", "Default")).toBe("Model v2");
	});

	it("clearUiStringsFor removes only that extension's keys", () => {
		reset();
		registerUiStrings({ strings: { "key-a": "value-a" } }, "/path/a");
		registerUiStrings({ strings: { "key-b": "value-b" } }, "/path/b");
		expect(resolveUiString("key-a", "fallback")).toBe("value-a");
		expect(resolveUiString("key-b", "fallback")).toBe("value-b");

		clearUiStringsFor("/path/a");
		expect(resolveUiString("key-a", "fallback")).toBe("fallback");
		expect(resolveUiString("key-b", "fallback")).toBe("value-b");
	});

	it("clearAll removes everything", () => {
		reset();
		registerUiStrings({ strings: { x: "y" } }, "/path");
		expect(resolveUiString("x", "fallback")).toBe("y");
		clearAllUiStrings();
		expect(resolveUiString("x", "fallback")).toBe("fallback");
	});
});

// ── Default fallback (no plugin loaded) ──────────────────────────────────────

describe("default fallback", () => {
	it("settings-defs resolver returns schema values when no overrides", () => {
		reset();
		// Verify that resolveUiString simply returns the fallback
		// This is what settings-defs and settings-selector see
		expect(resolveUiString("tab.model", "Model")).toBe("Model");
		expect(resolveUiString("setting.compaction.enabled.label", "Enable compaction")).toBe("Enable compaction");
		expect(resolveUiString("settings.title", "Settings")).toBe("Settings");
	});

	it("chrome strings fall through to hardcoded defaults", () => {
		reset();
		// The settings-selector uses resolveUiString for all chrome strings.
		// Without any override, every call returns the hardcoded default.
		expect(resolveUiString("settings.hint.search", "Enter to change · Tab to jump tabs · Esc to exit search")).toBe(
			"Enter to change · Tab to jump tabs · Esc to exit search",
		);
		expect(resolveUiString("settings.match.one", "1 match")).toBe("1 match");
	});
});

// ── Real key resolution ──────────────────────────────────────────────────────

describe("real keys", () => {
	it("resolves a real group key through the plugin registration", () => {
		reset();
		registerUiStrings(
			{
				strings: {
					"group.appearance.Theme": "Theme-CN",
				},
			},
			"/path/to/test-plugin",
		);
		expect(resolveUiString("group.appearance.Theme", "Theme")).toBe("Theme-CN");
	});

	it("resolves a real setting key through the plugin registration", () => {
		reset();
		registerUiStrings(
			{
				strings: {
					"setting.theme.dark.label": "Dark theme (zh)",
				},
			},
			"/path/to/test-plugin",
		);
		expect(resolveUiString("setting.theme.dark.label", "Dark theme")).toBe("Dark theme (zh)");
	});
});
