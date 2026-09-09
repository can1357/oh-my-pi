import { describe, expect, it } from "bun:test";
import { addKeyAliases, canonicalKeyId, KeybindingsManager, parseKey, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		expect(keybindings.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+enter"]);
		expect(keybindings.getKeys("tui.select.confirm")).toEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		expect(keybindings.getKeys("tui.select.up")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["up"]);
	});

	it("preserves Shift when matching printable uppercase letters", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "shift+a",
		});

		expect(keybindings.matches("A", "tui.input.copy")).toBe(true);
		expect(keybindings.matches("a", "tui.input.copy")).toBe(false);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toEqual(["left", "ctrl+b"]);
	});

	it("ships ctrl+j alongside shift+enter as default newline keys", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		const newLineKeys = keybindings.getKeys("tui.input.newLine");
		expect(newLineKeys).toContain("ctrl+j");
		expect(newLineKeys).toContain("shift+enter");
	});

	it("exports the canonical alias helpers used by matching", () => {
		const aliases = new Set<string>();
		for (const key of ["esc", "return", "?", "shift+a"] as const) {
			addKeyAliases(aliases, key);
		}

		expect([...aliases].sort()).toEqual(["?", "enter", "escape", "shift+?", "shift+a"]);
		expect(canonicalKeyId("A")).toBe("shift+a");
		expect(canonicalKeyId("shift+?")).toBe("shift+?");

		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": ["esc", "return", "?", "shift+a"],
		});

		for (const input of ["\x1b", "\r", "?", "A"]) {
			const parsed = parseKey(input);
			if (parsed === undefined) throw new Error(`Expected ${JSON.stringify(input)} to parse`);
			expect(aliases.has(canonicalKeyId(parsed))).toBe(true);
			expect(keybindings.matches(input, "tui.input.copy")).toBe(true);
		}
	});
});
