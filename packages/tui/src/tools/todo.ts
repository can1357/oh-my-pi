import type { ToolRenderer } from "./renderer";

import type { Component } from "../index";
import { Text } from "../index";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { RenderResultOptions } from "./renderer";
import type { Theme } from "../theme/theme";

import { renderStatusLine, renderTreeList } from "../render";
import { framedToolCard } from "../render/tool-card";

import { formatErrorDetail, formatMoreItems, PREVIEW_LIMITS, pluralize, replaceTabs } from "../render/render-utils";

// =============================================================================
// Types
// =============================================================================

/** Lifecycle state of a todo item. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

/** A task displayed within a todo phase. */
export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
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
}

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
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
 */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

/** Whether a todo is settled: completed or deliberately abandoned. Shared so
 *  the collapsed viewport, the HUD progress counters, and the HUD's closed-todo
 *  auto-clear can never disagree about what "done" hides. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
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
 */
function selectWithinCap<T extends { status: TodoStatus }>(
	base: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap) return { items: base, summary: "" };

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
// TUI Renderer
// =============================================================================

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

/** New single-op shape `{op,...}`; legacy `{ops:[...]}` still seen in old transcripts. */
type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts the new
 * top-level `{op,...}` shape (returned as a one-element list), the legacy
 * `{ops:[...]}` batch from old transcripts/collab-web, and partially-parsed
 * streaming deltas (non-array `ops`, non-object entries) without crashing.
 */
function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter((entry): entry is TodoRenderOp => !!entry && typeof entry === "object");
	}
	return typeof args.op === "string" ? [args] : [];
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

const EMPTY_COMPLETION_KEYS = new Set<string>();

const STRIKE_START = "\x1b[9m";

const STRIKE_END = "\x1b[29m";

function strikethroughText(text: string): string {
	return `${STRIKE_START}${text}${STRIKE_END}`;
}

function partialStrikethrough(text: string, visibleChars: number): string {
	if (visibleChars <= 0) return text;
	const chars = [...text];
	if (visibleChars >= chars.length) return strikethroughText(text);
	return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
	matched = false,
): string {
	const checkbox = uiTheme.checkbox;
	// Sanitize only for display. A mirrored Cursor snapshot carries provider text
	// verbatim, and a label holding ANSI/C0 sequences would otherwise rewrite the
	// terminal every time the list renders or replays. `item.content` stays raw
	// everywhere else: it is the identity key the local list is looked up by
	// (`findTaskByContent`) and what gets persisted.
	const label = forDisplay(item.content);
	switch (item.status) {
		case "completed": {
			const revealCount = completionKeys.has(item.content) ? strikeRevealCount(label, frame) : undefined;
			const content =
				revealCount === undefined ? strikethroughText(label) : partialStrikethrough(label, revealCount);
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${content}`);
		}
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${label}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(label)}`);
		case "blocked": {
			const note = item.blocker ? `blocked: ${forDisplay(item.blocker)}` : "blocked";
			return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${label} (${note})`);
		}
		default:
			// A pending todo lit by a live subagent match renders accent, matching
			// the sticky HUD's convention (#5873).
			return uiTheme.fg(matched ? "accent" : "dim", `${prefix}${checkbox.unchecked} ${label}`);
	}
}

/**
 * Phases the latest update touched, plus the active (in_progress) phase.
 * Returns `null` when there is no usable signal, meaning "render every phase
 * fully" — this preserves the legacy view and the manual-expand path.
 */
function computeTouchedPhases(
	args: TodoRenderArgs | undefined,
	phases: TodoPhase[],
	completedTasks: TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	// The phase holding the in_progress task is where attention sits after the
	// auto-promotion that follows every completion.
	for (const phase of phases) {
		if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	}
	// Phases with a task that just transitioned to completed in this update.
	for (const transition of completedTasks) touched.add(transition.phase);
	// Phases explicitly named by the ops that ran. `init` replaces the whole
	// list, so the entire plan is fresh and every phase counts as touched.
	const ops = normalizeTodoArg(args);
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase) {
			const named = phases.find(phase => phase.name === op.phase);
			if (named) touched.add(named.name);
		}
		if (typeof op.task === "string" && op.task) {
			const phase = phases.find(phase => phase.tasks.some(task => task.content === op.task));
			if (phase) touched.add(phase.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

/**
 * Dim `closed/total` suffix for a phase header. Counts closed tasks, not just
 * completed ones: the collapsed viewport hides both, so an abandoned task has to
 * move the counter or its phase reads as permanently stuck.
 */
function formatPhaseProgress(phase: TodoPhase, uiTheme: Theme): string {
	const done = phase.tasks.filter(isClosedTodo).length;
	return uiTheme.fg("dim", `  ${done}/${phase.tasks.length}`);
}

/** One-line summary for a collapsed (untouched) phase: dim header + progress. */
function formatPhaseSummary(phase: TodoPhase, oneBasedIndex: number, uiTheme: Theme): string {
	const name = uiTheme.fg("dim", chalk.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)));
	return `${name}${formatPhaseProgress(phase, uiTheme)}`;
}

/**
 * Live subagent descriptions the transient tool result uses to detect
 * pending todos being executed by an in-flight subagent, so its collapsed
 * viewport surfaces the same active work the sticky HUD does (#5873). Wired
 * once by interactive mode from its observer registry; returns `[]` outside an
 * interactive session (tests, SDK, transcript rebuilds), where only literal
 * `in_progress` counts as active.
 */
let activeTodoDescriptionsProvider: () => readonly string[] = () => [];

/** Wire the live-subagent description source for {@link todoToolRenderer}. */
export function setActiveTodoDescriptionsProvider(provider: () => readonly string[]): void {
	activeTodoDescriptionsProvider = provider;
}

/** Render todo operations and phased task snapshots. */
export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// `args` is the raw partially-parsed JSON from the streaming tool-call
		// delta and may not satisfy `TodoRenderArgs` at runtime:
		// `parseStreamingJson` can hand back `{ op: 1 }` mid-delta, or a legacy
		// `{ ops: "[" }` shape before fields stream. `normalizeTodoArg` guards
		// both the new single-op and legacy batch shapes so a malformed delta
		// never breaks the TUI render loop (#2005).
		const opsList = normalizeTodoArg(args);
		// Model-authored, partially-streamed strings going straight into a header:
		// `renderStatusLine` only flattens CR/LF and leaves the rest to the caller.
		const ops =
			opsList.length === 0
				? ["update"]
				: opsList.map(e => {
						const parts = [forDisplay(e.op ?? "update")];
						if (e.task) parts.push(forDisplay(e.task));
						if (e.phase) parts.push(forDisplay(e.phase));
						if (Array.isArray(e.items) && e.items.length) {
							parts.push(`${e.items.length} item${e.items.length === 1 ? "" : "s"}`);
						}
						return parts.join(" ");
					});
		// No body worth boxing while the call streams — a lone status line reads
		// cleaner than an empty frame. The container renders it without chrome.
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Todo", meta: ops },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: TodoRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Todo operation failed";
			const header = renderStatusLine({ icon: "error", title: "Todo" }, uiTheme);
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: formatErrorDetail(errorText, uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		const completedTasks = result.details?.completedTasks ?? [];
		const completionKeysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks) {
			let keys = completionKeysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				completionKeysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.todo", "accent"),
				title: "Todo",
				meta: [`${allTasks.length} tasks`],
			},
			uiTheme,
		);
		if (allTasks.length === 0) {
			// Provider text on the Cursor path (the todo summary or a refusal note),
			// so sanitize like every other label. The error branch above already
			// goes through `formatErrorDetail`.
			const fallback = forDisplay(result.content?.find(content => content.type === "text")?.text ?? "No todos");
			return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		return framedToolCard(uiTheme, () => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			const indent = multiPhase ? "  " : "";
			// Collapse phases this update didn't touch down to a one-line summary so
			// a single task flip doesn't redraw every phase's full task list. The
			// manual expand toggle (and the no-signal fallback) still shows all.
			const touched = expanded || !multiPhase ? null : computeTouchedPhases(args, phases, completedTasks);
			// A pending todo counts as active work when an in-flight subagent is
			// executing it — the transient result surfaces the same active set the
			// sticky HUD does (#5873). Empty outside an interactive session.
			const activeDescs = expanded ? [] : activeTodoDescriptionsProvider();
			const isMatched = (task: TodoItem): boolean =>
				activeDescs.length > 0 && todoMatchesAnyDescription(task.content, activeDescs);
			const bodyLines: string[] = [];
			for (let p = 0; p < phases.length; p++) {
				const phase = phases[p];
				if (touched && !touched.has(phase.name)) {
					bodyLines.push(formatPhaseSummary(phase, p + 1, uiTheme));
					continue;
				}
				if (multiPhase) {
					// Progress belongs on the expanded header too: the collapsed
					// viewport below hides closed rows, so without it the phase the
					// agent is actually working in is the one phase with no visible
					// completion signal at all.
					const name = uiTheme.fg("accent", chalk.bold(formatPhaseDisplayName(phase.name, p + 1)));
					bodyLines.push(`${name}${formatPhaseProgress(phase, uiTheme)}`);
				}
				const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
				// Collapsed: walking viewport — the last closed task leads, then
				// active work (in-progress / subagent-matched), then following
				// pending tasks (#5873). Expanded: every task in order.
				const treeLines = expanded
					? renderTreeList(
							{
								items: phase.tasks,
								expanded,
								itemType: "todo",
								renderItem: todo => formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame),
							},
							uiTheme,
						)
					: (() => {
							const selection = selectCollapsedTodos(phase.tasks, isMatched, PREVIEW_LIMITS.COLLAPSED_ITEMS);
							return renderTreeList(
								{
									items: selection.items,
									itemType: "todo",
									trailingSummary: selection.summary,
									renderItem: todo =>
										formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame, isMatched(todo)),
								},
								uiTheme,
							);
						})();
				for (const line of treeLines) {
					bodyLines.push(`${indent}${line}`);
				}
			}
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ content: bodyLines }] : [],
				phase: options.isPartial ? "partial" : "success",
				borderColor: "borderMuted",
				applyBg: false,
			};
		});
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<TodoRenderArgs, TodoToolDetails>;
