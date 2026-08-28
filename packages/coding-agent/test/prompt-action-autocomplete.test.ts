import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	KeybindingsManager as AppKeybindingsManager,
	setKeyHintPlatform,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/modes/prompt-action-autocomplete";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";

describe("prompt action autocomplete", () => {
	beforeEach(() => {
		setKeybindings(
			new KeybindingsManager({
				"tui.editor.cursorLineStart": { defaultKeys: ["home", "f6"], description: "Move cursor to line start" },
				"tui.editor.cursorLineEnd": { defaultKeys: "f7", description: "Move cursor to line end" },
				"tui.editor.undo": { defaultKeys: "f8", description: "Undo" },
			}),
		);
		setKeyHintPlatform("linux");
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		setKeyHintPlatform(undefined);
	});

	it("shows prompt actions with configured shortcut hints", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({
				"app.clipboard.copyLine": "ctrl+shift+l",
				"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
			}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);
		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("#");
		expect(suggestions?.items.map(item => item.label)).toEqual([
			"Copy current line",
			"Copy whole prompt",
			"Undo",
			"Move cursor to end of message",
			"Move cursor to beginning of message",
			"Move cursor to beginning of line",
			"Move cursor to end of line",
		]);
		expect(suggestions?.items.find(item => item.label === "Copy current line")?.description).toBe("Ctrl+Shift+L");
		expect(suggestions?.items.find(item => item.label === "Copy whole prompt")?.description).toBe(
			"Alt+Shift+C/Ctrl+Shift+C",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to beginning of line")?.description).toBe(
			"Home/F6",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to end of line")?.description).toBe("F7");
		expect(suggestions?.items.find(item => item.label === "Undo")?.description).toBe("F8");
	});

	it("passes the typed trigger to undo and leaves text removal to the editor", async () => {
		let undoCalls = 0;
		let undoPrefix = "";
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: prefix => {
				undoCalls += 1;
				undoPrefix = prefix;
			},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["hello #undo"], 0, 11);
		const item = suggestions?.items.find(entry => entry.label === "Undo");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected undo suggestion");
		}

		const result = provider.applyCompletion(["hello #undo"], 0, 11, item, suggestions.prefix);
		expect(result.lines).toEqual(["hello #undo"]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(11);
		result.onApplied?.();
		expect(undoCalls).toBe(1);
		expect(undoPrefix).toBe("#undo");
	});

	it("falls back to normal typing for literal hashtags with no matching action", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["release #v1"], 0, 11);
		expect(suggestions).toBeNull();
	});

	it("treats # prompt-action tokens as literal text inside slash command arguments without completions", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "rename", description: "Rename current session", allowArgs: true }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/rename repro #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).toBeNull();
	});

	it("returns # prompt-action completions for matched slash commands that reject arguments", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "settings", description: "Open settings", allowArgs: false }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/settings #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("#copy");
		expect(suggestions?.items.map(item => item.label)).toEqual(["Copy current line", "Copy whole prompt"]);
	});

	it("returns slash command argument completions instead of # prompt actions when the command defines them", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [
				{
					name: "rename",
					description: "Rename current session",
					allowArgs: true,
					getArgumentCompletions: argumentPrefix =>
						argumentPrefix === "repro #copy"
							? [{ value: "repro #copy-title", label: "Keep #copy in the title" }]
							: null,
				},
			],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/rename repro #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).toEqual({
			prefix: "repro #copy",
			items: [{ value: "repro #copy-title", label: "Keep #copy in the title" }],
		});
	});

	it("falls through to internal-url completion for allowArgs commands without argument completions", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "btw", description: "By the way", allowArgs: true }],
			basePath: process.cwd(),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/btw omp://";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("omp://");
		expect(suggestions?.items.length).toBeGreaterThan(0);
	});

	it("falls through to internal-url completion when getArgumentCompletions yields no match", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [
				{
					name: "mcp",
					description: "MCP",
					allowArgs: true,
					getArgumentCompletions: () => null,
				},
			],
			basePath: process.cwd(),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/mcp omp://";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("omp://");
		expect(suggestions?.items.length).toBeGreaterThan(0);
	});

	it("delegates trySyncSlashCompletion to CombinedAutocompleteProvider", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("model");
	});

	it("returns null from trySyncSlashCompletion for non-slash text", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
	});
});
