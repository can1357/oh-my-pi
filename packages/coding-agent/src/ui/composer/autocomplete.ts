/**
 * Completion for the composer: a provider proposes items for the text before
 * the caret (`/command` names, `@path`s, …) and applies the one picked.
 *
 * Eligibility is lexical: ordinary prose never starts an asynchronous file
 * or model lookup. The provider owns ranking, lookup and application.
 */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { AutocompleteProvider as LiveProvider } from "../../autocomplete/autocomplete";
import type {
	MentionCategoryId,
	MentionItem,
	MentionPaletteView,
	UnifiedMentionSnapshot,
} from "../../autocomplete/mentions";
import {
	extractAtFilePrefix,
	extractPathPrefix,
	findEmojiNameStart,
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	getPromptActionPrefix,
	hasPromptTextBeforeSlash,
	isExplicitFilePath,
	MODEL_MENTION_CONTEXT_RE,
	URL_TOKEN_RE,
} from "../../autocomplete/tokens";

/** One proposal. */
export interface AutocompleteItem {
	/** What the provider inserts (and the popup item's key). */
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
	/** Type glyph supplied by the provider for the terminal's icon column. */
	readonly icon?: string;
	/** Icon drawn by name in Tern instead of the glyph. */
	readonly iconName?: string;
	/** Tern's detail when it differs from `description` (a command's static text, a file's parent directory). */
	readonly nativeDetail?: string;
	/** Live state Tern draws right-aligned (`parity/alpha`, `off`). */
	readonly state?: string;
	/** Matched only by its description (the typed name matches no part of it). */
	readonly descriptionMatch?: boolean;
	/** Dim ghost text at the line end while the item is selected (a command's argument hint). */
	readonly hint?: string;
}

/** Proposals for the token before the caret; `prefix` is that token (`/co`, `@src`). */
export interface AutocompleteSuggestions {
	readonly items: readonly AutocompleteItem[];
	readonly prefix: string;
	/** Present when suggestions come from the unified mention palette (`@`, `^`, `#<N>`). */
	readonly mention?: MentionPaletteView;
}

/** The text after applying a completion, with the caret's line and column. */
export interface AutocompleteResult {
	readonly lines: readonly string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
	/** Runs once the composer applied the result (a prompt action the item stands for). */
	readonly onApplied?: () => void;
}

/** A completion source. Lines are the draft's `\n`-separated lines; columns are UTF-16 offsets. */
export interface AutocompleteProvider extends Pick<
	LiveProvider,
	| "trySyncSlashCompletion"
	| "trySyncModelMentionCompletion"
	| "trySyncInlineReplace"
	| "getForceFileSuggestions"
	| "shouldTriggerFileCompletion"
> {
	getSuggestions(
		lines: string[],
		line: number,
		col: number,
		signal?: AbortSignal,
		onPartial?: (suggestions: AutocompleteSuggestions) => void,
	): AutocompleteSuggestions | null | Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		line: number,
		col: number,
		item: AutocompleteItem,
		prefix: string,
	): AutocompleteResult;
	/** Dim ghost text for the caret at its line end: the arguments still to type (`/git-sync ` → `[base branch]`). */
	getInlineHint?(lines: string[], line: number, col: number): string | null;
	/** Pre-warm background mention caches (non-blocking). */
	warmMentions?(): void;
	/** Synchronously resolve Tier 0 unified mention suggestions (`@`, `^`, `#<N>`). */
	trySyncMentionCompletion?(
		lines: string[],
		line: number,
		col: number,
		pinnedScope?: MentionCategoryId | null,
	): UnifiedMentionSnapshot | null;
	/** Async streaming refinement for unified mention suggestions (`@`, `^`, `#<N>`). */
	getMentionSuggestions?(
		lines: string[],
		line: number,
		col: number,
		pinnedScope: MentionCategoryId | null | undefined,
		signal?: AbortSignal,
		onPartial?: (snapshot: UnifiedMentionSnapshot) => void,
	): Promise<UnifiedMentionSnapshot | null>;
	/** Apply a unified mention item with an optional interactive thinking-effort override. */
	applyMentionCompletion?(
		lines: string[],
		line: number,
		col: number,
		item: MentionItem,
		prefix: string,
		effortOverride?: Effort | "auto",
	): AutocompleteResult;
}

/** An open popup. */
export interface Completion {
	readonly items: readonly AutocompleteItem[];
	readonly prefix: string;
	readonly selected: number;
	/** The user moved the selection (Enter then applies even a description-only hit). */
	readonly chosen?: boolean;
	/** The draft revision used by the provider, absent on a prediction or replacement picker. */
	readonly revision?: number;
	/** Structured palette metadata when showing unified `@` / `^` / `#<N>` mentions. */
	readonly mention?: MentionPaletteView;
	/** User-selected category scope from Shift+Tab or clicking a scope pill (`null` = All). */
	readonly pinnedScope?: MentionCategoryId | null;
	/** Interactive thinking-effort override chosen via Shift+←/→ or Tern's level slider. */
	readonly effortOverride?: Effort | "auto";
	/** Timestamp when the query last changed, for 120ms anti-thrash focus stability. */
	readonly openedAt?: number;
}

/** Only a leading slash in the submitted prompt runs commands; later slash tokens look up skills. */
export function inSubmittedSlashContext(before: string, lines: readonly string[], line: number): boolean {
	const slash = findLeadingSlashCommandStart(before);
	return slash !== null && !hasPromptTextBeforeSlash(lines, line, before, slash);
}

/** All automatic sources, without inspecting models, skills, files, or the URL registry. */
export function inCompletionContext(before: string, lines: readonly string[], line: number): boolean {
	if (!before) return false;
	if (inSubmittedSlashContext(before, lines, line) || findTrailingSlashCommandStart(before) !== null) return true;
	if (before.includes("@") && extractAtFilePrefix(before) !== null) return true;
	if (before.includes("^") && MODEL_MENTION_CONTEXT_RE.test(before)) return true;
	if (before.includes("#") && getPromptActionPrefix(before) !== null) return true;
	if (before.includes(":")) {
		const nameStart = findEmojiNameStart(before);
		if ((nameStart >= 0 && nameStart < before.length) || URL_TOKEN_RE.test(before)) return true;
	}
	// Quoted prose and bare relative paths are file candidates on explicit Tab only.
	if (!before.includes("/") && !before.includes("\\")) return false;
	const path = extractPathPrefix(before);
	return path !== null && (!path.startsWith('"') || isExplicitFilePath(path.slice(1)));
}
