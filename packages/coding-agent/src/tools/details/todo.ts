import { sanitizeText } from "@oh-my-pi/pi-utils";
import { formatMoreItems } from "../../utils/render-utils";
import { pluralize } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../../utils/text-width";

// =============================================================================
// Types
// =============================================================================

/** Lifecycle state of a todo item. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

/** A task displayed within a todo phase. */
export interface TodoItem {
	content: string;
	status: TodoStatus;
	details?: string;
	notes?: string[];
}

/** A named group of todo tasks. */
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** A task that became complete in the latest update. */
export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

/** Todo snapshot and transitions displayed after an operation. */
export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	/** The todo backend kept a valid change from committing: the payload was fine, so the call gets no retry reminder. */
	uncommitted?: "refused" | "stale";
}

/** How a `todo` call's change fared with the selected todo backend. Host-only: the package root does not export it. */
export type TodoApplyOutcome =
	| { kind: "committed" }
	/** The backend's `apply` returned `{ block: true }`. */
	| { kind: "refused"; message: string }
	/** Nothing committed for another reason: `apply` threw or timed out, list, session or backend changed, abort, closing. */
	| { kind: "stale"; message: string };

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

/** Bound on {@link normalizedTodoCache}; cleared wholesale when exceeded. */
const NORMALIZED_TODO_CACHE_LIMIT = 1024;

const normalizedTodoCache = new Map<string, string>();

function normalizeForTodoMatch(value: string): string {
	let normalized = normalizedTodoCache.get(value);
	if (normalized !== undefined) return normalized;
	normalized = value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	if (normalizedTodoCache.size >= NORMALIZED_TODO_CACHE_LIMIT) normalizedTodoCache.clear();
	normalizedTodoCache.set(value, normalized);
	return normalized;
}

/** Match a pre-normalized target against pre-normalized, non-empty candidates. */
function matchesNormalizedCandidates(target: string, candidates: readonly string[]): boolean {
	if (!target) return false;
	for (const candidate of candidates) {
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Used by the sticky todo panel to light up a pending todo
 * when an in-flight subagent is doing the work for it, without requiring
 * the caller to flip the todo's status.
 *
 * Matching is normalize-then-equal first (lowercased; punctuation and
 * whitespace runs both collapsed to a single space; trimmed), with a
 * substring fallback in either direction so minor wording drift
 * ("Sonnet #2: bug scan" vs "Sonnet #2") still links up. The substring
 * fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP} chars on
 * the contained side.
 *
 * Display-only: the fallback deliberately over-matches (a "Review auth"
 * subagent also lights "Review auth deployment"), and even an exact match
 * does not show that a subagent owns a todo, so never change a todo's
 * status from it.
 */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	const candidates: string[] = [];
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (candidate) candidates.push(candidate);
	}
	return matchesNormalizedCandidates(target, candidates);
}

/** Whether a todo is settled: completed or deliberately abandoned. Shared so
 *  the collapsed viewport, the HUD progress counters, and the HUD's closed-todo
 *  auto-clear can never disagree about what "done" hides. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/**
 * Delimiters tried, in order, on a `task` string that names no task verbatim, mirroring path-list
 * recovery: a split wins when every part names a task; `partial` delimiters also win when only some
 * do, so the error names each missing part instead of the whole flattened string.
 */
const TASK_LIST_DELIMITERS: readonly { pattern: RegExp; partial: boolean }[] = [
	{ pattern: /\r?\n/, partial: true },
	{ pattern: /;/, partial: true },
	{ pattern: /,/, partial: true },
	{ pattern: /\s+/, partial: false },
	{ pattern: /[\s,;]+/, partial: false },
];

const QUOTED_TASK_RE = /^(["'`])(.*)\1$/s;

function normalizeTaskPart(part: string): string {
	const trimmed = part.trim();
	return QUOTED_TASK_RE.exec(trimmed)?.[2].trim() ?? trimmed;
}

function splitTaskList(content: string, known: ReadonlySet<string>): string[] {
	if (known.has(content)) return [content];
	let partial: string[] | undefined;
	for (const delimiter of TASK_LIST_DELIMITERS) {
		const parts = content
			.split(delimiter.pattern)
			.map(normalizeTaskPart)
			.filter(part => part.length > 0);
		const named = parts.filter(part => known.has(part)).length;
		if (named > 0 && named === parts.length) return parts;
		if (!partial && delimiter.partial && named > 0 && parts.length > 1) partial = parts;
	}
	return partial ?? [content];
}

/**
 * Task contents a todo `task` arg targets, shared by the todo tool and its renderer. A string naming
 * a task verbatim is one target; otherwise a string flattening several tasks (`"a; b"`, `"a, b"`,
 * newline- or space-separated) splits like a path list, with parts trimmed and unquoted (see
 * {@link TASK_LIST_DELIMITERS}). Array entries expand the same way; absent, `""` and `[]` target none.
 */
export function todoTaskTargets(phases: readonly TodoPhase[], task: string | readonly string[] | undefined): string[] {
	if (task === undefined || task === "") return [];
	const known = new Set(phases.flatMap(phase => phase.tasks.map(item => item.content)));
	return (typeof task === "string" ? [task] : task).flatMap(content => splitTaskList(content, known));
}

/**
 * A todo the collapsed viewport treats as current work: the literal
 * `in_progress` task or a pending task a live subagent is executing. Both
 * collapsed views (transient tool result + sticky HUD) run this same policy so
 * they can never disagree about what the agent is doing (#5873).
 */
function isActiveTodo<T extends { status: TodoStatus }>(task: T, isMatched: (task: T) => boolean): boolean {
	return task.status === "in_progress" || (task.status === "pending" && isMatched(task));
}

/** Result of {@link selectCollapsedTodos}: the rows to render plus an optional
 *  summary line (empty string ⇒ no summary row). */
export interface CollapsedTodoSelection<T> {
	items: T[];
	summary: string;
}

/**
 * Closed rows kept directly above the open window so finishing a task is
 * visible as it happens. Without this the collapsed viewport only ever renders
 * unchecked boxes while a phase has open work: every completion silently
 * removes a row, so a plan mid-flight looks untouched, and the card's
 * completion strike animation (`completedTasks` → {@link TODO_STRIKE_TOTAL_FRAMES})
 * animated a row that was never rendered.
 */
const COLLAPSED_CLOSED_CONTEXT = 1;

/**
 * Rows to show for a display base already reduced to the relevant tasks.
 *
 * 1. Every active task (in-progress, or pending matched to a live subagent) is
 *    placed at the head in stable todo order — never dropped for lying outside
 *    an ordinary window.
 * 2. Remaining rows up to `cap` are filled with the pending tasks that follow
 *    the first active one, in todo order (falling back to leading pending tasks
 *    when no active task exists), so a freshly-promoted task leads the preview.
 * 3. When active tasks alone exceed `cap`, only the first `cap` active tasks are
 *    shown and the summary counts the hidden *active* todos, never replacing
 *    them with unrelated pending rows.
 *
 * The summary occupies a row, so a summary that would hide exactly one task is
 * replaced by that task: the selection spends at most `cap + 1` rows.
 */
function selectWithinCap<T extends { status: TodoStatus }>(
	base: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap + 1) return { items: base, summary: "" };

	const active = base.filter(task => isActiveTodo(task, isMatched));
	// Only when active work strictly exceeds the cap do we drop pending rows and
	// count hidden *actives*. At exactly `cap` actives, fall through so the normal
	// branch still surfaces any following pending work in the summary.
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${pluralize("todo", hiddenActive)}`,
		};
	}

	// Fill trailing rows with tasks following the first active one, so the
	// promoted/current task leads and its successors follow in todo order.
	const firstActiveIdx = active.length > 0 ? base.indexOf(active[0]) : 0;
	const fill: T[] = [];
	for (let i = firstActiveIdx; i < base.length && active.length + fill.length < cap; i++) {
		const task = base[i];
		if (isActiveTodo(task, isMatched)) continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? formatMoreItems(hidden, "todo") : "" };
}

/**
 * Walking-viewport selection for a phase's collapsed todo preview (#5873).
 *
 * Applied to `tasks` in todo order: the open tasks run through
 * {@link selectWithinCap}, led by the last {@link COLLAPSED_CLOSED_CONTEXT}
 * closed tasks in todo order so a checked row remains visible even when callers
 * complete work out of sequence. The lead is additive — it never costs an open
 * row — and a phase with no open work left falls back to its closed tasks so the
 * sticky HUD's closed-todo persistence still has something to render.
 *
 * `summary` counts the open tasks that did not fit; the closed lead is context,
 * not part of the budget.
 */
export function selectCollapsedTodos<T extends { status: TodoStatus }>(
	tasks: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	const open = tasks.filter(task => !isClosedTodo(task));
	// Closed tasks are never active, so a settled phase selects over itself.
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	// `done` accepts any named task, so closed tasks are not necessarily a prefix.
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/**
 * Every render boundary in this file funnels display text through here.
 *
 * `sanitizeText` strips ANSI/C0 sequences but deliberately preserves tabs, and
 * a raw tab punches holes in bordered TUI output, so both are needed. The raw
 * value stays untouched everywhere else: task content and phase names are the
 * identity keys the local list is looked up by, and what gets persisted.
 */
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/**
 * Display-only phase header: `I. Foundation`. State and prompts never see this.
 *
 * Sanitized for the same reason task labels are: this is a render boundary and
 * the name may carry provider or session text holding control sequences. The
 * raw `phase.name` stays the lookup key everywhere else.
 */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(name)}`;
}

/** Frames held before revealing a completion strike. */
export const TODO_STRIKE_HOLD_FRAMES = 2;

/** Frames used to reveal a completion strike. */
export const TODO_STRIKE_REVEAL_FRAMES = 12;

/** Total frames in the completion strike animation. */
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
