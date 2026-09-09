import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	findLeadingSlashCommandStart,
	getKeybindings,
	type SlashCommand,
} from "@oh-my-pi/pi-tui";
import { formatKeyHints, type KeybindingsManager } from "../config/keybindings";
import { isSettingsInitialized, settings } from "../config/settings";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji-autocomplete";
import { getGithubRefContext, getGithubRefSuggestions } from "./github-ref-autocomplete";
import {
	applyInternalUrlCompletion,
	getInternalUrlSuggestions,
	type InternalUrlCallerContext,
	isInternalUrlPrefix,
} from "./internal-url-autocomplete";

interface PromptActionDefinition {
	id: string;
	label: string;
	description: string;
	keywords: string[];
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteItem extends AutocompleteItem {
	actionId: string;
	execute: (prefix: string) => void;
}

interface PromptActionAutocompleteOptions {
	commands: SlashCommand[];
	basePath: string;
	/** Usage count per command name for frequency-ranked slash completions. */
	commandUsage?: (name: string) => number;
	/** Read the receiving session at lookup time, following focus and session replacement. */
	internalUrlCaller?: () => InternalUrlCallerContext;
	keybindings: KeybindingsManager;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let queryIndex = 0;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			queryIndex += 1;
		}
	}

	return queryIndex === query.length;
}

function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	let queryIndex = 0;
	let gaps = 0;
	let lastMatchIndex = -1;
	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (query[queryIndex] === target[targetIndex]) {
			if (lastMatchIndex >= 0 && targetIndex - lastMatchIndex > 1) {
				gaps += 1;
			}
			lastMatchIndex = targetIndex;
			queryIndex += 1;
		}
	}

	if (queryIndex !== query.length) return 0;
	return Math.max(1, 40 - gaps * 5);
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
}

function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

function applyGithubRefCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } | null {
	if (!getGithubRefContext(prefix)) return null;
	const scheme: "pr" | "issue" | null = item.value.startsWith("pr://")
		? "pr"
		: item.value.startsWith("issue://")
			? "issue"
			: null;
	if (!scheme) return { lines, cursorLine, cursorCol };

	const currentLine = lines[cursorLine] || "";
	const liveContext = getGithubRefContext(currentLine.slice(0, cursorCol));
	if (!liveContext || (liveContext.qualifier && liveContext.qualifier !== scheme)) {
		return { lines, cursorLine, cursorCol };
	}

	return applyInternalUrlCompletion(
		lines,
		cursorLine,
		cursorCol,
		{ ...item, value: `${scheme}://${liveContext.number}` },
		liveContext.prefix,
	);
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#commands: SlashCommand[];
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];
	#internalUrlCaller: () => InternalUrlCallerContext;

	constructor(
		commands: SlashCommand[],
		basePath: string,
		actions: PromptActionDefinition[],
		commandUsage?: (name: string) => number,
		internalUrlCaller?: () => InternalUrlCallerContext,
	) {
		this.#commands = commands;
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath, { commandUsage });
		this.#internalUrlCaller = internalUrlCaller ?? (() => ({ cwd: basePath }));
		this.#actions = actions;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const hasPromptTextBeforeCursorLine = lines.slice(0, cursorLine).some(line => (line || "").trim() !== "");
		const commandText =
			leadingSlashStart !== null && !hasPromptTextBeforeCursorLine
				? textBeforeCursor.slice(leadingSlashStart)
				: null;
		const spaceIndex = commandText?.indexOf(" ") ?? -1;
		if (commandText !== null && spaceIndex !== -1) {
			const commandName = commandText.slice(1, spaceIndex);
			const command = this.#commands.find(cmd => cmd.name === commandName || cmd.aliases?.includes(commandName));
			if (command && (!("allowArgs" in command) || command.allowArgs !== false)) {
				const argumentSuggestions = await this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol, signal);
				if (argumentSuggestions) return argumentSuggestions;
				// No slash-argument completion for this input: preserve numeric
				// GitHub references and internal URLs while keeping prompt-action
				// tokens such as `#copy` literal.
				const githubRefSuggestions = getGithubRefSuggestions(textBeforeCursor);
				if (githubRefSuggestions) return githubRefSuggestions;
				return getInternalUrlSuggestions(textBeforeCursor, undefined, signal, this.#internalUrlCaller);
			}
		}

		const githubRefSuggestions = getGithubRefSuggestions(textBeforeCursor);
		if (githubRefSuggestions) return githubRefSuggestions;
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map(action => {
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!fuzzyMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: fuzzyScore(query, searchable),
					} satisfies PromptActionAutocompleteItem & { score: number };
				})
				.filter(item => item !== null)
				.sort((a, b) => b.score - a.score)
				.map(({ score: _score, ...item }) => item);
			if (items.length > 0) {
				return { items, prefix: promptActionPrefix };
			}
		}

		const urlSuggestions = await getInternalUrlSuggestions(
			textBeforeCursor,
			undefined,
			signal,
			this.#internalUrlCaller,
		);
		if (urlSuggestions) return urlSuggestions;

		if (!isSettingsInitialized() || settings.get("emojiAutocomplete")) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol, signal);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	} {
		const githubRefCompletion = applyGithubRefCompletion(lines, cursorLine, cursorCol, item, prefix);
		if (githubRefCompletion) return githubRefCompletion;
		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				return {
					lines,
					cursorLine,
					cursorCol,
					onApplied: () => item.execute(prefix),
				};
			}
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length,
				onApplied: () => item.execute(prefix),
			};
		}

		if (isInternalUrlPrefix(prefix)) {
			return applyInternalUrlCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		if (isEmojiPrefix(prefix)) {
			return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (isSettingsInitialized() && !settings.get("emojiAutocomplete")) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}
}

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const editorKeybindings = getKeybindings();
	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyLine")),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: formatKeyHints(options.keybindings.getKeys("app.clipboard.copyPrompt")),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.undo")),
			keywords: ["undo", "revert", "edit", "history"],
			execute: options.undo,
		},
		{
			id: "cursor-message-end",
			label: "Move cursor to message end",
			description: "Current message",
			keywords: ["move", "cursor", "message", "end", "prompt", "last", "bottom"],
			execute: options.moveCursorToMessageEnd,
		},
		{
			id: "cursor-message-start",
			label: "Move cursor to message start",
			description: "Current message",
			keywords: ["move", "cursor", "message", "start", "beginning", "prompt", "first", "top"],
			execute: options.moveCursorToMessageStart,
		},
		{
			id: "cursor-line-start",
			label: "Move cursor to line start",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineStart")),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to line end",
			description: formatKeyHints(editorKeybindings.getKeys("tui.editor.cursorLineEnd")),
			keywords: ["move", "cursor", "line", "end"],
			execute: options.moveCursorToLineEnd,
		},
	];

	return new PromptActionAutocompleteProvider(
		options.commands,
		options.basePath,
		actions,
		options.commandUsage,
		options.internalUrlCaller,
	);
}
