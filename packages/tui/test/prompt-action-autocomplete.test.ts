import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { KeybindingsManager as AppKeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import type { ModelBrowserItem } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { setInternalUrlCompletionHost } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { getSelectListTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { KeybindingsManager, SelectList, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";

function modelMentionItem(provider: string, id: string, name: string): ModelBrowserItem {
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		model: buildModel({
			id,
			name,
			api: "ollama-chat",
			provider,
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		}),
	};
}

describe("prompt action autocomplete", () => {
	beforeAll(async () => {
		await initTheme();
		// The coding-agent internal-url router installs the real host; here a stub
		// proves the fall-through contract without the router.
		setInternalUrlCompletionHost({
			completionSchemes: () => ["omp"],
			resolveCompletions: async scheme => (scheme === "omp" ? [{ value: "docs", label: "docs" }] : null),
		});
	});

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
			"Move cursor to message end",
			"Move cursor to message start",
			"Move cursor to line start",
			"Move cursor to line end",
		]);
		const rendered = new SelectList(suggestions?.items ?? [], 10, getSelectListTheme()).render(80).join("\n");
		for (const item of suggestions?.items ?? []) {
			expect(rendered).toContain(item.label);
		}
		expect(suggestions?.items.find(item => item.label === "Copy current line")?.description).toBe("Ctrl+Shift+L");
		expect(suggestions?.items.find(item => item.label === "Copy whole prompt")?.description).toBe(
			"Alt+Shift+C/Ctrl+Shift+C",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to line start")?.description).toBe("Home/F6");
		expect(suggestions?.items.find(item => item.label === "Move cursor to line end")?.description).toBe("F7");
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

	it("suggests model mentions and reanchors completion to the live token", async () => {
		const candidate = modelMentionItem("a", "x", "X One");
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			modelMentions: query => (query === "" || candidate.selector.includes(query) ? [candidate] : []),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["see ^a"], 0, 6);
		expect(suggestions).toEqual({
			prefix: "^a",
			items: [
				{
					value: "a/x",
					label: "a/x",
					description: "X One",
					icon: theme.symbol("icon.model"),
				},
			],
		});
		if (!suggestions) throw new Error("expected model mention suggestion");

		const liveLine = "see ^a-extra";
		const completion = provider.applyCompletion(
			[liveLine],
			0,
			liveLine.length,
			suggestions.items[0]!,
			suggestions.prefix,
		);
		expect(completion).toEqual({
			lines: ["see ^a/x "],
			cursorLine: 0,
			cursorCol: 9,
		});
	});

	it("limits model mention suggestions to the first twenty ranked candidates", async () => {
		const candidates = Array.from({ length: 21 }, (_, index) =>
			modelMentionItem("demo", `model-${index + 1}`, `Model ${index + 1}`),
		);
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			modelMentions: () => candidates,
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["^"], 0, 1);
		expect(suggestions?.items).toHaveLength(20);
		expect(suggestions?.items[0]?.value).toBe("demo/model-1");
		expect(suggestions?.items[19]?.value).toBe("demo/model-20");
	});

	it("does not suggest a model mention without a left token boundary", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			modelMentions: () => [modelMentionItem("a", "x", "X One")],
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		expect(await provider.getSuggestions(["a^b"], 0, 3)).toBeNull();
	});

	it("suggests model mentions inside slash command arguments", async () => {
		const candidate = modelMentionItem("a", "x", "X One");
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "btw", description: "By the way", allowArgs: true }],
			basePath: "/tmp",
			modelMentions: query => (candidate.selector.includes(query) ? [candidate] : []),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/btw ^a";
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		expect(suggestions?.prefix).toBe("^a");
		expect(suggestions?.items.map(item => item.value)).toEqual(["a/x"]);
	});
});
