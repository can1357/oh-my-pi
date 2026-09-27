import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	formatDoubleTap,
	formatKeyHint,
	formatTooltipKey,
	getDefaultPasteImageKeys,
	KeybindingsManager,
	setKeyHintPlatform,
} from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { initTheme, setSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("KeybindingsManager.getDisplayString", () => {
	beforeEach(() => setKeyHintPlatform("linux"));
	afterEach(() => setKeyHintPlatform(undefined));

	it("defaults retry to F5 with the Alt+R fallback", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry")).toBe("F5/Alt+R");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});

	it("keeps the default Hub chord off Ctrl+S", () => {
		const keybindings = KeybindingsManager.inMemory();
		expect(keybindings.getKeys("app.agents.hub")).toEqual(["alt+a"]);
		expect(keybindings.getKeys("app.editor.stash")).toEqual(["ctrl+s"]);
		expect(keybindings.getResolvedBindings()).not.toHaveProperty("app.session.observe");
	});

	it("preserves an explicit Hub Ctrl+S remap instead of silently binding stash over it", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.agents.hub": "ctrl+s" });
		expect(keybindings.getKeys("app.agents.hub")).toEqual(["ctrl+s"]);
		expect(keybindings.getKeys("app.editor.stash")).toEqual([]);
		expect(keybindings.getEffectiveConfig()["app.editor.stash"]).toEqual([]);
	});

	it("keeps the editor stash despite a configured session-selector sort shortcut", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.session.toggleSort": "ctrl+s" });
		expect(keybindings.getKeys("app.editor.stash")).toEqual(["ctrl+s"]);
		expect(keybindings.getKeys("app.session.toggleSort")).toEqual(["ctrl+s"]);
		expect(keybindings.getEffectiveConfig()["app.editor.stash"]).toEqual("ctrl+s");
	});

	it("still gives an explicit Hub remap precedence when selector sort shares the chord", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.session.toggleSort": "ctrl+s",
			"app.agents.hub": "ctrl+s",
		});
		expect(keybindings.getKeys("app.editor.stash")).toEqual([]);
		expect(keybindings.getKeys("app.agents.hub")).toEqual(["ctrl+s"]);
	});

	it("keeps Alt and Super labels off macOS", () => {
		setKeyHintPlatform("linux");
		const keybindings = KeybindingsManager.inMemory({
			"app.display.reset": "alt+l",
			"app.clipboard.pasteImage": ["ctrl+v", "super+v"],
		});

		expect(keybindings.getDisplayString("app.display.reset")).toBe("Alt+L");
		expect(keybindings.getDisplayString("app.clipboard.pasteImage")).toBe("Ctrl+V/Super+V");
	});
});

describe("persisted hub shortcut migration", () => {
	beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
	afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

	it("merges both old names with explicit Hub chords regardless of YAML entry order", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hub-keybindings-"));
		const configPath = path.join(agentDir, "keybindings.yml");
		try {
			await Bun.write(
				configPath,
				YAML.stringify({
					observeSessions: ["ctrl+o", "alt+o"],
					"app.session.observe": ["ctrl+s", "ctrl+o"],
					"app.agents.hub": ["ctrl+s", "alt+h"],
				}),
			);

			const manager = KeybindingsManager.create(agentDir);
			expect(manager.getKeys("app.agents.hub")).toEqual(["ctrl+s", "alt+h", "ctrl+o", "alt+o"]);
			expect(manager.getKeys("app.editor.stash")).toEqual([]);
			expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
				"app.agents.hub": ["ctrl+s", "alt+h", "ctrl+o", "alt+o"],
			});
			expect(manager.getResolvedBindings()).not.toHaveProperty("app.session.observe");
			expect(manager.getResolvedBindings()).not.toHaveProperty("observeSessions");
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates old JSON remaps without a new Hub entry", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hub-keybindings-"));
		try {
			await Bun.write(
				path.join(agentDir, "keybindings.json"),
				JSON.stringify({ observeSessions: "ctrl+o", "app.session.observe": "ctrl+s" }),
			);

			const manager = KeybindingsManager.create(agentDir);
			expect(manager.getKeys("app.agents.hub")).toEqual(["ctrl+s", "ctrl+o"]);
			expect(manager.getKeys("app.editor.stash")).toEqual([]);
			expect(YAML.parse(await Bun.file(path.join(agentDir, "keybindings.yml")).text())).toEqual({
				"app.agents.hub": ["ctrl+s", "ctrl+o"],
			});
		} finally {
			await removeWithRetries(agentDir);
		}
	});
});

describe("formatKeyHint with keycap glyphs", () => {
	beforeAll(() => initTheme(false, "unicode"));
	afterAll(() => setSymbolPreset("unicode"));
	afterEach(() => setKeyHintPlatform(undefined));

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

	it("renders a bare modifier and the plus key itself", () => {
		setKeyHintPlatform("linux");
		expect(formatKeyHint("shift")).toBe("⇧");
		expect(formatKeyHint("ctrl++")).toBe("Ctrl++");
		expect(formatKeyHint("+")).toBe("+");
	});

	it("spaces a double tap only when the key renders as a word", async () => {
		expect(formatDoubleTap("left")).toBe("←←");
		await setSymbolPreset("ascii");
		expect(formatDoubleTap("left")).toBe("Left Left");
		await setSymbolPreset("unicode");
	});

	it("separates nerd icons so adjacent keycaps stay legible", async () => {
		setKeyHintPlatform("darwin");
		await setSymbolPreset("nerd");
		expect(formatKeyHint("shift+tab")).toBe("\u{f0636} \u{f0312}");
		expect(formatKeyHint("ctrl+shift+c")).toBe("\u{f0634} \u{f0636} C");
		await setSymbolPreset("unicode");
	});

	it("keeps tooltip keys as abutting keycap glyphs under the nerd preset, Escape as esc", async () => {
		setKeyHintPlatform("darwin");
		await setSymbolPreset("nerd");
		expect(formatTooltipKey("shift+tab")).toBe("⇧⇥");
		expect(formatTooltipKey("ctrl+shift+c")).toBe("⌃⇧C");
		expect(formatTooltipKey("escape")).toBe("esc");
		await setSymbolPreset("unicode");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});
