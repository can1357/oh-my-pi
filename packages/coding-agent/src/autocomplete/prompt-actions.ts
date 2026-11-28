import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { Keybinding } from "../config/keybindings/app-keybindings";
import type { KeybindingsManager } from "../config/keybindings/keybindings";
import {
	applyInternalUrlCompletion,
	getInternalUrlSuggestions,
	type InternalUrlCallerContext,
	isInternalUrlPrefix,
} from "../internal-urls/completion";
import { formatKeyHints } from "../ui/keys/hints";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	findLeadingSlashCommandStart,
	type ModelMentionCompletion,
	type SlashCommand,
	subsequenceMatch,
	subsequenceScore,
} from "./autocomplete";
import { applyEmojiCompletion, getEmojiSuggestions, isEmojiPrefix, tryEmojiInlineReplace } from "./emoji";
import { getGithubRefContext, getGithubRefSuggestions } from "./github-ref";
import {
	applyModelMentionCompletion,
	getModelMentionSuggestions,
	isModelMentionPrefix,
	type ModelMentionCandidateSource,
} from "./model-mention";

import {
	type MentionCategoryId,
	type MentionItem,
	type ModelsMentionHost,
	UnifiedMentionEngine,
	type UnifiedMentionSnapshot,
} from "./mentions";
import { getPromptActionPrefix } from "./tokens";

let emojiAutocompleteEnabled = true;

/** Default for standalone providers; an interactive session reads its own live setting. */
export function setEmojiAutocompleteEnabled(enabled: boolean): void {
	emojiAutocompleteEnabled = enabled;
}

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
	/** Session-scoped models available for `^` mentions. */
	modelMentions?: ModelMentionCandidateSource;
	/** Host powering the unified `@` / `^` / `#<N>` mention palette's models source. */
	mentionModels?: ModelsMentionHost;
	/** Recently accessed workspace files to boost in unified `@` mention results. */
	recentFiles?: () => readonly string[];
	/** Pre-configured unified mention engine (overrides default construction). */
	unifiedMentions?: UnifiedMentionEngine;
	emojiAutocomplete?: () => boolean;
	keybindings: KeybindingsManager;
	copyCurrentLine: () => void;
	copyPrompt: () => void;
	undo: (prefix: string) => void;
	moveCursorToMessageEnd: () => void;
	moveCursorToMessageStart: () => void;
	moveCursorToLineStart: () => void;
	moveCursorToLineEnd: () => void;
}

function isPromptActionItem(item: AutocompleteItem): item is PromptActionAutocompleteItem {
	return "actionId" in item && "execute" in item && typeof item.execute === "function";
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

function isMentionItem(item: AutocompleteItem): item is MentionItem {
	return "category" in item && "insertText" in item && "pickerItem" in item;
}

export class PromptActionAutocompleteProvider implements AutocompleteProvider {
	#commands: SlashCommand[];
	#baseProvider: CombinedAutocompleteProvider;
	#actions: PromptActionDefinition[];
	#internalUrlCaller: () => InternalUrlCallerContext;
	#modelMentions: ModelMentionCandidateSource | undefined;
	readonly #unifiedMentions: UnifiedMentionEngine | undefined;
	readonly #emojiAutocomplete: () => boolean;

	constructor(
		commands: SlashCommand[],
		basePath: string,
		actions: PromptActionDefinition[],
		commandUsage?: (name: string) => number,
		internalUrlCaller?: () => InternalUrlCallerContext,
		modelMentions?: ModelMentionCandidateSource,
		emojiAutocomplete: () => boolean = () => emojiAutocompleteEnabled,
		mentionOptions?: {
			mentionModels?: ModelsMentionHost;
			recentFiles?: () => readonly string[];
			unifiedMentions?: UnifiedMentionEngine;
		},
	) {
		this.#commands = commands;
		this.#baseProvider = new CombinedAutocompleteProvider(commands, basePath, { commandUsage });
		this.#internalUrlCaller = internalUrlCaller ?? (() => ({ cwd: basePath }));
		this.#modelMentions = modelMentions;
		this.#emojiAutocomplete = emojiAutocomplete;
		this.#actions = actions;
		this.#unifiedMentions =
			mentionOptions?.unifiedMentions ??
			(mentionOptions?.mentionModels
				? new UnifiedMentionEngine({
						getBasePath: () => this.#internalUrlCaller().cwd ?? basePath,
						getCurrentSessionId: () => this.#internalUrlCaller().sessionId,
						models: mentionOptions.mentionModels,
						recentFiles: mentionOptions.recentFiles,
					})
				: undefined);
	}

	warmMentions(): void {
		this.#unifiedMentions?.warm();
	}

	trySyncMentionCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		lock?: MentionCategoryId,
	): UnifiedMentionSnapshot | null {
		if (!this.#unifiedMentions) return null;
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (this.#isInSlashCommandArguments(lines, cursorLine, textBeforeCursor)) return null;
		return this.#unifiedMentions.querySync(lines, cursorLine, cursorCol, lock);
	}

	getMentionSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
		onPartial?: (snapshot: UnifiedMentionSnapshot) => void,
		lock?: MentionCategoryId,
	): Promise<UnifiedMentionSnapshot | null> {
		if (!this.#unifiedMentions) return Promise.resolve(null);
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (this.#isInSlashCommandArguments(lines, cursorLine, textBeforeCursor)) return Promise.resolve(null);
		return this.#unifiedMentions.queryAsync(lines, cursorLine, cursorCol, signal, onPartial, lock);
	}

	applyMentionCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: MentionItem,
		prefix: string,
		effortOverride?: Effort | "auto",
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (!this.#unifiedMentions) {
			return this.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		return this.#unifiedMentions.applyCompletion(lines, cursorLine, cursorCol, item, prefix, effortOverride);
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
		onPartial?: (suggestions: { items: AutocompleteItem[]; prefix: string }) => void,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
		if (this.#unifiedMentions && !this.#isInSlashCommandArguments(lines, cursorLine, textBeforeCursor)) {
			const snapshot = await this.#unifiedMentions.queryAsync(lines, cursorLine, cursorCol, signal, partial =>
				onPartial?.({ items: [...partial.items], prefix: partial.prefix }),
			);
			if (snapshot) {
				return snapshot.items.length > 0 ? { items: [...snapshot.items], prefix: snapshot.prefix } : null;
			}
		}
		if (!this.#outranksModelMention(lines, cursorLine, textBeforeCursor)) {
			const modelMention = await this.#modelMentionSuggestions(textBeforeCursor, signal, onPartial);
			if (modelMention) return modelMention;
		}
		if (this.#isInSlashCommandArguments(lines, cursorLine, textBeforeCursor)) {
			const argumentSuggestions = await this.#baseProvider.getSuggestions(
				lines,
				cursorLine,
				cursorCol,
				signal,
				onPartial,
			);
			if (argumentSuggestions) return argumentSuggestions;
			const modelMention = await this.#modelMentionSuggestions(textBeforeCursor, signal, onPartial);
			if (modelMention) return modelMention;
			// No slash-argument completion for this input: preserve numeric
			// GitHub references and internal URLs while keeping prompt-action
			// tokens such as `#copy` literal.
			const githubRefSuggestions = getGithubRefSuggestions(textBeforeCursor);
			if (githubRefSuggestions) return githubRefSuggestions;
			return getInternalUrlSuggestions(textBeforeCursor, undefined, signal, this.#internalUrlCaller);
		}

		const githubRefSuggestions = getGithubRefSuggestions(textBeforeCursor);
		if (githubRefSuggestions) return githubRefSuggestions;
		const promptActionPrefix = getPromptActionPrefix(textBeforeCursor);
		if (promptActionPrefix) {
			const query = promptActionPrefix.slice(1).toLowerCase();
			const items = this.#actions
				.map(action => {
					const searchable = [action.label, action.description, ...action.keywords].join(" ").toLowerCase();
					if (!subsequenceMatch(query, searchable)) return null;
					return {
						value: action.label,
						label: action.label,
						description: action.description,
						actionId: action.id,
						execute: action.execute,
						score: subsequenceScore(query, searchable),
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

		if (this.#emojiAutocomplete()) {
			const emojiSuggestions = getEmojiSuggestions(textBeforeCursor);
			if (emojiSuggestions) return emojiSuggestions;
		}

		return this.#baseProvider.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
	}

	#isInSlashCommandArguments(lines: string[], cursorLine: number, textBeforeCursor: string): boolean {
		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (leadingSlashStart === null || lines.slice(0, cursorLine).some(line => (line || "").trim() !== "")) {
			return false;
		}
		const commandText = textBeforeCursor.slice(leadingSlashStart);
		const spaceIndex = commandText.indexOf(" ");
		if (spaceIndex === -1) return false;
		const commandName = commandText.slice(1, spaceIndex);
		const command = this.#commands.find(cmd => cmd.name === commandName || cmd.aliases?.includes(commandName));
		return command !== undefined && (!("allowArgs" in command) || command.allowArgs !== false);
	}

	#outranksModelMention(lines: string[], cursorLine: number, textBeforeCursor: string): boolean {
		return (
			this.#isInSlashCommandArguments(lines, cursorLine, textBeforeCursor) ||
			getGithubRefContext(textBeforeCursor) !== null ||
			getPromptActionPrefix(textBeforeCursor) !== null
		);
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
		if (this.#unifiedMentions && isMentionItem(item)) {
			return this.#unifiedMentions.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		const githubRefCompletion = applyGithubRefCompletion(lines, cursorLine, cursorCol, item, prefix);
		if (githubRefCompletion) return githubRefCompletion;
		if (prefix.startsWith("#") && isPromptActionItem(item)) {
			if (item.actionId === "undo") {
				return { lines, cursorLine, cursorCol, onApplied: () => item.execute(prefix) };
			}
			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = beforePrefix + afterCursor;
			return { lines: newLines, cursorLine, cursorCol: beforePrefix.length, onApplied: () => item.execute(prefix) };
		}

		if (isModelMentionPrefix(prefix)) {
			return applyModelMentionCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		if (isInternalUrlPrefix(prefix)) {
			return applyInternalUrlCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		if (isEmojiPrefix(prefix)) {
			return applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		return this.#baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	getForceFileSuggestions(lines: string[], line: number, col: number, signal?: AbortSignal) {
		return this.#baseProvider.getForceFileSuggestions(lines, line, col, signal);
	}

	shouldTriggerFileCompletion(lines: string[], line: number, col: number): boolean {
		return this.#baseProvider.shouldTriggerFileCompletion(lines, line, col);
	}

	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		return this.#baseProvider.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return this.#baseProvider.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
	}
	/**
	 * `^` mention rows for the token at the cursor. While a discovery retry runs, the current
	 * rows go out as a partial and the result is recomputed once it settles; aborts when the
	 * editor queues a newer request.
	 */
	async #modelMentionSuggestions(
		textBeforeCursor: string,
		signal: AbortSignal | undefined,
		onPartial: ((suggestions: { items: AutocompleteItem[]; prefix: string }) => void) | undefined,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const mention = getModelMentionSuggestions(textBeforeCursor, this.#modelMentions);
		if (mention.kind === "unhandled") return null;
		const suggestions = mention.kind === "matched" ? mention.suggestions : null;
		if (!mention.pending) return suggestions;
		if (suggestions) onPartial?.(suggestions);
		await untilAborted(signal, mention.pending);
		if (signal?.aborted) return null;
		const settled = getModelMentionSuggestions(textBeforeCursor, this.#modelMentions);
		return settled.kind === "matched" ? settled.suggestions : null;
	}

	trySyncModelMentionCompletion(lines: string[], cursorLine: number, cursorCol: number): ModelMentionCompletion {
		const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
		if (this.#outranksModelMention(lines, cursorLine, textBeforeCursor)) return { kind: "unhandled" };
		return getModelMentionSuggestions(textBeforeCursor, this.#modelMentions);
	}
	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		if (!this.#emojiAutocomplete()) return null;
		return tryEmojiInlineReplace(textBeforeCursor);
	}
}

export function createPromptActionAutocompleteProvider(
	options: PromptActionAutocompleteOptions,
): PromptActionAutocompleteProvider {
	const keys = (action: Keybinding) => formatKeyHints(options.keybindings.keysFor(action));
	const actions: PromptActionDefinition[] = [
		{
			id: "copy-line",
			label: "Copy current line",
			description: keys("app.clipboard.copyLine"),
			keywords: ["copy", "line", "clipboard", "current"],
			execute: options.copyCurrentLine,
		},
		{
			id: "copy-prompt",
			label: "Copy whole prompt",
			description: keys("app.clipboard.copyPrompt"),
			keywords: ["copy", "prompt", "clipboard", "message"],
			execute: options.copyPrompt,
		},
		{
			id: "undo",
			label: "Undo",
			description: keys("tui.editor.undo"),
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
			description: keys("tui.editor.cursorLineStart"),
			keywords: ["move", "cursor", "line", "start", "beginning", "home"],
			execute: options.moveCursorToLineStart,
		},
		{
			id: "cursor-line-end",
			label: "Move cursor to line end",
			description: keys("tui.editor.cursorLineEnd"),
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
		options.modelMentions,
		options.emojiAutocomplete,
		options.mentionModels || options.unifiedMentions || options.recentFiles
			? {
					mentionModels: options.mentionModels,
					recentFiles: options.recentFiles,
					unifiedMentions: options.unifiedMentions,
				}
			: undefined,
	);
}
