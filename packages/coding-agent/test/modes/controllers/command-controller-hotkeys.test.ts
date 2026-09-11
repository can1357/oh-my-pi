import { afterEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/hotkeys-markdown";

/** Exit-row wiring for stubs that only care about display strings: no key claims the
 *  forward-delete role, so the exit row renders its plain "Exit" wording. */
const noForwardDelete = { getKeys: () => [], matchesCanonical: () => false };

describe("buildHotkeysMarkdown", () => {
	afterEach(() => setKeyHintPlatform(undefined));

	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				...noForwardDelete,
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `Ctrl+Shift+P` | Copy whole prompt |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
		expect(markdown).toContain("| `Alt+L` | Reset terminal display |");
		expect(markdown).toContain("| `Ctrl+L` | Start/stop live voice mode (/live) |");
		expect(markdown).toContain("| `Alt+R` | Retry last failed assistant turn |");
		expect(markdown).toContain("| `Alt+Shift+P` | Toggle plan mode |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | Toggle tool activity visibility |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR reference");
		expect(markdown).toContain("| `#` / `#<text>` | Prompt actions");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				...noForwardDelete,
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
	});

	it("renders macOS static navigation rows on darwin", () => {
		setKeyHintPlatform("darwin");
		const markdown = buildHotkeysMarkdown({
			keybindings: { ...noForwardDelete, getDisplayString: () => "Disabled" },
		});

		expect(markdown).toContain("| `Option+Left/Right` | Move by word |");
		expect(markdown).toContain("| `Ctrl+A` / `Home` / `Cmd+Left` | Start of line |");
		expect(markdown).toContain("| `Ctrl+W` / `Option+Backspace` | Delete word backwards |");
		expect(markdown).toContain("| `Shift+Enter` / `Option+Enter` | New line |");
	});

	it("drops Option/Cmd static navigation labels off darwin", () => {
		setKeyHintPlatform("linux");
		const markdown = buildHotkeysMarkdown({
			keybindings: { ...noForwardDelete, getDisplayString: () => "Disabled" },
		});

		expect(markdown).toContain("| `Alt+Left/Right` | Move by word |");
		expect(markdown).toContain("| `Ctrl+A` / `Home` | Start of line |");
		expect(markdown).toContain("| `Ctrl+W` / `Alt+Backspace` | Delete word backwards |");
		expect(markdown).not.toContain("Option+");
		expect(markdown).not.toContain("Cmd+");
	});

	it("describes the exit key per its actual forward-delete role", () => {
		const shipped = KeybindingsManager.inMemory();
		expect(buildHotkeysMarkdown({ keybindings: shipped })).toContain(
			"| `Ctrl+D` | Delete char forward (with draft) / exit (empty prompt) |",
		);

		// Remapped exit with no forward-delete role: CustomEditor exits immediately, draft or not.
		const remapped = KeybindingsManager.inMemory({ "app.exit": "ctrl+q" });
		expect(buildHotkeysMarkdown({ keybindings: remapped })).toContain("| `Ctrl+Q` | Exit |");

		// Ctrl+D kept as exit but dropped from forward-delete: exits unconditionally again.
		const noDelete = KeybindingsManager.inMemory({ "tui.editor.deleteCharForward": "delete" });
		expect(buildHotkeysMarkdown({ keybindings: noDelete })).toContain("| `Ctrl+D` | Exit |");
	});
});
