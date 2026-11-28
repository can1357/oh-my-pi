import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
// Exercise the published formatter subpath that existing extensions still import.
import { formatKey, kbdKeys, setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/ui/keys/format";
import {
	actionHintSpans,
	actionKey,
	actionKeys,
	expandKeyLabel,
	formatDoubleTap,
	formatKeyHint,
	formatTooltipDoubleTap,
	formatTooltipKey,
	keyHintSpans,
} from "@oh-my-pi/pi-coding-agent/ui/keys/hints";
import type { SymbolPreset } from "@oh-my-pi/pi-tui/theme/schema";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const original = currentTheme();
const usePreset = (preset: SymbolPreset): void => setCurrentTheme(loadThemeSync("dark", { symbolPreset: preset }));

beforeAll(() => usePreset("unicode"));
afterAll(() => setCurrentTheme(original));
afterEach(() => {
	setKeyHintPlatform(undefined);
	usePreset("unicode");
});

describe("action keys", () => {
	it("defaults retry to F5 with the Alt+R fallback", () => {
		setKeyHintPlatform("linux");
		expect(actionKeys("app.retry", KeybindingsManager.inMemory())).toBe("F5/Alt+R");
		expect(actionKey("app.retry", KeybindingsManager.inMemory())).toBe("F5");
	});

	it("is empty when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.clipboard.copyPrompt": [] });
		expect(actionKeys("app.clipboard.copyPrompt", keybindings)).toBe("");
		expect(actionKey("app.clipboard.copyPrompt", keybindings)).toBe("");
	});

	it("draws the primary tool expansion binding in the supplied preset", () => {
		setKeyHintPlatform("darwin");
		const keybindings = KeybindingsManager.inMemory({ "app.tools.expand": ["alt+k", "ctrl+o"] });
		const nerd = loadThemeSync("dark", { symbolPreset: "nerd" });
		expect(expandKeyLabel(nerd, keybindings)).toBe("\u{f0635} K");
		expect(expandKeyLabel(currentTheme(), keybindings)).toBe("⌥K");
		expect(expandKeyLabel(nerd, KeybindingsManager.inMemory({ "app.tools.expand": [] }))).toBe("\u{f0634} O");
	});

	it("keeps Alt and Super labels off macOS", () => {
		setKeyHintPlatform("linux");
		const keybindings = KeybindingsManager.inMemory({
			"app.display.reset": "alt+l",
			"app.clipboard.pasteImage": ["ctrl+v", "super+v"],
		});
		expect(actionKeys("app.display.reset", keybindings)).toBe("Alt+L");
		expect(actionKeys("app.clipboard.pasteImage", keybindings)).toBe("Ctrl+V/Super+V");
	});

	it("styles hint parts as dim keys and a muted description", () => {
		setKeyHintPlatform("darwin");
		expect(keyHintSpans(["up", "down"], "navigate")).toEqual([
			{ t: "↑/↓", s: "dim" },
			{ t: " navigate", s: "muted" },
		]);
		expect(actionHintSpans("app.tools.expand", "expand", KeybindingsManager.inMemory())).toEqual([
			{ t: "⌃O", s: "dim" },
			{ t: " expand", s: "muted" },
		]);
	});
});

describe("formatKeyHint with keycap glyphs", () => {
	it("abuts macOS glyph modifiers and keeps Ctrl/Alt/Super as words elsewhere", () => {
		setKeyHintPlatform("darwin");
		expect(formatKeyHint("ctrl+shift+c")).toBe("⌃⇧C");
		expect(formatKeyHint("alt+up")).toBe("⌥↑");
		expect(formatKeyHint("super+v")).toBe("⌘V");

		setKeyHintPlatform("linux");
		expect(formatKeyHint("ctrl+shift+c")).toBe("Ctrl+⇧C");
		expect(formatKeyHint("alt+up")).toBe("Alt+↑");
		expect(formatKeyHint("super+v")).toBe("Super+V");
	});

	it("orders modifiers canonically regardless of binding order", () => {
		setKeyHintPlatform("darwin");
		expect(formatKeyHint("shift+ctrl+p")).toBe("⌃⇧P");
		expect(formatKeyHint("super+shift+alt+k")).toBe("⌥⇧⌘K");
	});

	it("keeps a bare letter lowercase but capitalizes it inside a chord", () => {
		expect(formatKeyHint("q")).toBe("q");
		expect(formatKeyHint("shift+g")).toBe("⇧G");
	});

	it("renders a bare modifier, the plus key itself, and word keys", () => {
		setKeyHintPlatform("linux");
		expect(formatKeyHint("shift")).toBe("⇧");
		expect(formatKeyHint("ctrl++")).toBe("Ctrl++");
		expect(formatKeyHint("+")).toBe("+");
		expect(formatKeyHint("pageup")).toBe("PgUp");
		expect(formatKeyHint("f5")).toBe("F5");
	});

	it("spaces a double tap only when the key renders as a word", () => {
		expect(formatDoubleTap("left")).toBe("←←");
		usePreset("ascii");
		expect(formatDoubleTap("left")).toBe("Left Left");
	});

	it("separates nerd icons so adjacent keycaps stay legible", () => {
		setKeyHintPlatform("darwin");
		usePreset("nerd");
		expect(formatKeyHint("shift+tab")).toBe("\u{f0636} \u{f0312}");
		expect(formatKeyHint("ctrl+shift+c")).toBe("\u{f0634} \u{f0636} C");
	});

	it("spells keys out in the ascii preset", () => {
		setKeyHintPlatform("darwin");
		expect(formatKey("ctrl+c", { preset: "ascii", platform: "darwin" })).toBe("Ctrl+C");
		expect(formatKey("alt+enter", { preset: "ascii", platform: "darwin" })).toBe("Option+Enter");
	});

	it("keeps tooltip keys as abutting keycap glyphs under the nerd preset, Escape as esc", () => {
		setKeyHintPlatform("darwin");
		usePreset("nerd");
		expect(formatTooltipKey("shift+tab")).toBe("⇧⇥");
		expect(formatTooltipKey("ctrl+shift+c")).toBe("⌃⇧C");
		expect(formatTooltipKey("escape")).toBe("esc");
		expect(formatTooltipDoubleTap("left")).toBe("←←");
		expect(formatTooltipDoubleTap("tab")).toBe("⇥⇥");
	});

	it("splits chords into kbd keycaps", () => {
		expect(kbdKeys("alt+up")).toEqual(["alt", "up"]);
		expect(kbdKeys("ctrl++")).toEqual(["ctrl", "+"]);
		expect(kbdKeys("+")).toEqual(["+"]);
	});
});
