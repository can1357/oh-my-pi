/**
 * Shared types for the unified `@` / `^` / `#<N>` mention palette engine.
 *
 * Every category source implements {@link MentionSource}, returning ranked items
 * alongside a normalized {@link MatchTier} so the Intent Arbiter keeps Files on
 * top while letting explicit namespaces (`@model:`, `@agent:`, `@session:`, …)
 * and unambiguous strong matches shine cleanly.
 */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { TspPickerColumn, TspPickerGroup, TspPickerItem, TspPickerScope } from "@oh-my-pi/pi-wire";
import type { AutocompleteItem } from "../autocomplete";

/** Built-in mention categories, with Files first by default. */
export type MentionCategoryId = "files" | "models" | "agents" | "sessions" | "vcs" | "forge" | "mcp" | "ssh";

/** Canonical display order: Files always lead unless another scope is locked or clearly wins. */
export const MENTION_CATEGORY_ORDER: readonly MentionCategoryId[] = [
	"files",
	"models",
	"agents",
	"sessions",
	"vcs",
	"forge",
	"mcp",
	"ssh",
];

/**
 * Normalized match strength across heterogeneous sources. Lower is stronger.
 * Sources keep their own domain ranker internally and emit a tier solely for
 * cross-category arbitration and noise suppression.
 */
export const MATCH_TIER = {
	SyntaxLock: 0,
	Exact: 1,
	Strong: 2,
	Medium: 3,
	Weak: 4,
	None: 5,
} as const;

export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** Sub-category filter implied by an explicit namespace prefix (`@pr:`, `@branch:`, `@peer:`, …). */
export type MentionSubKind = "pr" | "issue" | "branch" | "commit" | "tag" | "diff" | "peer";

/** Parsed state of the mention token currently under the composer caret. */
export interface MentionQuery {
	/** Opening sigil that triggered this mention (`@`, `^`, or `#` for `#<N>`). */
	readonly trigger: "@" | "^" | "#";
	/** Exact buffer substring from trigger start to caret (used for replacement). */
	readonly prefix: string;
	/** Effective search query after stripping the trigger, namespace, and typed suffixes. */
	readonly query: string;
	/** Raw body immediately after the trigger character(s), before namespace stripping. */
	readonly rawBody: string;
	/** Unambiguous syntactic lock (`^`, `#123`, `@model:`, `@./`, `@#42`, …). */
	readonly syntaxLock?: MentionCategoryId;
	/** Explicit sub-kind filter (`@pr:`, `@branch:`, `@peer:`, `pr #123`, …). */
	readonly subKind?: MentionSubKind;
	/** User-selected scope from Shift+Tab or clicking a scope pill (`null` = All). */
	readonly pinnedScope?: MentionCategoryId | null;
	/** Whether the `@` token opened with a double quote (`@"…`). */
	readonly quoted?: boolean;
	/** Preserved `:line` or `:start-end` suffix on a file mention. */
	readonly fileLineSuffix?: string;
	/** Typed `:effort` fragment on a model mention (`""` right after `:`, `"h"` for `:h`). */
	readonly modelEffortSuffix?: string;
}

/** Interactive thinking-effort metadata attached to model mention items. */
export interface MentionModelEffort {
	/** Canonical `provider/id` selector without effort suffix. */
	readonly selector: string;
	/** Human-readable model display name. */
	readonly displayName: string;
	/** Supported effort steps in low→high order. */
	readonly supported: readonly Effort[];
	/** Effort preselected from inline `:level`, or `"auto"` when none was typed. */
	readonly selected: Effort | "auto";
	/** Provider id shown as dim context beside the effort slider. */
	readonly provider: string;
}

/** One candidate item emitted by a {@link MentionSource}. */
export interface MentionItem extends AutocompleteItem {
	readonly category: MentionCategoryId;
	readonly tier: MatchTier;
	/** Canonical token written into the draft on accept (`^provider/id`, `@path`, `agent://…`, `session://…`, `git://…`, `pr://…`). */
	readonly insertText: string;
	/** Append a trailing space after `insertText` (false for directories and `@category:` shortcuts). */
	readonly appendSpace?: boolean;
	/** Directory entry that keeps completion open after acceptance. */
	readonly isDirectory?: boolean;
	/** Namespace jump row (`@model:`, `@agent:`, `@session:`, …) that chains straight into that scope. */
	readonly isNamespaceShortcut?: boolean;
	/** Native Tern picker row representation. */
	readonly pickerItem: TspPickerItem;
	/** Present on model rows so the contextual thinking-effort slider renders. */
	readonly modelEffort?: MentionModelEffort;
}

/** Result returned by one source for a single query. */
export interface MentionSourceResult {
	readonly category: MentionCategoryId;
	readonly items: readonly MentionItem[];
	readonly bestTier: MatchTier;
	/** Total matches before per-source display slicing. */
	readonly total: number;
	/** Source still has an in-flight async pass. */
	readonly loading?: boolean;
	/** False when this category does not apply (e.g. Git outside a repo, Agents when empty). */
	readonly available: boolean;
}

/** Metadata describing one registered mention category. */
export interface MentionSourceMeta {
	readonly id: MentionCategoryId;
	readonly label: string;
	readonly icon: string;
}

/** Pluggable mention source participating in the unified selector. */
export interface MentionSource extends MentionSourceMeta {
	/** Synchronous Tier 0 / warm-cache query. Must be fast (<2ms) and never throw. */
	querySync(q: MentionQuery): MentionSourceResult;
	/** Optional cancellable async refinement (Tier 1 / Tier 2). */
	queryAsync?(
		q: MentionQuery,
		signal: AbortSignal,
		onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null>;
	/** Optional non-blocking background cache warm. */
	warm?(): void;
}

/** Structured palette payload attached to {@link AutocompleteSuggestions} for unified mentions. */
export interface MentionPaletteView {
	readonly scopes: readonly TspPickerScope[];
	readonly activeScope: string;
	readonly lockedScope?: MentionCategoryId;
	readonly columns: readonly TspPickerColumn[];
	readonly pickerItems: readonly TspPickerItem[];
	readonly order: readonly (string | TspPickerGroup)[];
	readonly loading: boolean;
	readonly query: string;
	readonly prefix: string;
	readonly trigger: "@" | "^" | "#";
}
