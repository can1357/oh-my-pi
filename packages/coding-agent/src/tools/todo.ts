import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { hasIncompleteTodosSection, parseIncompleteTodosFromSummary } from "../session/incomplete-todos";
import type { SessionEntry } from "../session/session-entries";
import { framedBlock, renderStatusLine, renderTreeList } from "../tui";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { formatErrorDetail, formatMoreItems, PREVIEW_LIMITS, pluralize, replaceTabs } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
	/**
	 * Set when the user abandoned this task via `/todo drop` (interactive or ACP).
	 * Settle treats model-authored `abandoned` as incomplete work that should
	 * continue, but a user-authored drop is an explicit cancel and must not.
	 */
	droppedBy?: "user";
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			typeof task.content === "string" &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view"').describe(
	"operation to apply",
);

const InitListEntry = type({
	phase: type("string").describe("phase name"),
	items: type("string").describe("task content").array().atLeastLength(1).describe("tasks for this phase"),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phased task list (init)"),
	"task?": type("string").describe("task content"),
	"phase?": type("string").describe("phase name"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").describe("task content").array().describe("tasks for single-phase init or append"),
	"reason?": type("string").describe("blocker note (block op)"),
}).describe("apply a single todo operation");

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	const cloned: TodoItem = { content: task.content, status: task.status };
	if (task.blocker !== undefined) cloned.blocker = task.blocker;
	if (task.droppedBy === "user") cloned.droppedBy = "user";
	return cloned;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	let skipCompactionSections = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			if (data && Array.isArray(data.phases)) {
				return clonePhases(data.phases as TodoPhase[]);
			}
			continue;
		}
		if (entry.type === "compaction") {
			if (skipCompactionSections) continue;
			if (hasIncompleteTodosSection(entry.summary)) {
				// Post-feature compact (including `(none)` after RPC clear) is authoritative.
				return clonePhases(parseIncompleteTodosFromSummary(entry.summary));
			}
			// Pre-feature compact: keep walking for an older toolResult / user_todo_edit,
			// but ignore leftover sections from earlier compacts.
			skipCompactionSections = true;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

/**
 * Authoritative todo list for user `/todo` mutations (slash + TUI).
 * Always returns the live session cache — including an explicit empty list after
 * RPC `set_todos([])` — so a host clear is not resurrected from a stale branch
 * snapshot. {@link AgentSession} initializes the cache from the branch on load.
 */
export function selectAuthoritativeTodoPhases(live: TodoPhase[]): TodoPhase[] {
	return live;
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

/** HUD "done": completed only. Abandoned is a handoff, not progress. */
export function isCompletedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed";
}

/** HUD auto-clear settle: completed, or abandoned with an explicit user cancel. */
export function isHudSettledTodo<T extends { status: TodoStatus; droppedBy?: "user" }>(task: T): boolean {
	return task.status === "completed" || (task.status === "abandoned" && task.droppedBy === "user");
}

/** Hidden from the open collapsed viewport: completed or deliberately abandoned. */
export function isSettledTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

export function todoHudCounts(tasks: ReadonlyArray<{ status: TodoStatus }>): {
	completed: number;
	abandoned: number;
	total: number;
} {
	let completed = 0;
	let abandoned = 0;
	for (const task of tasks) {
		if (task.status === "completed") completed++;
		else if (task.status === "abandoned") abandoned++;
	}
	return { completed, abandoned, total: tasks.length };
}

/** `2/5` or `2/5 · 1 dropped`. */
export function formatTodoHudRatio(counts: { completed: number; abandoned: number; total: number }): string {
	const base = `${counts.completed}/${counts.total}`;
	return counts.abandoned > 0 ? `${base} · ${counts.abandoned} dropped` : base;
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
	const open = tasks.filter(task => !isSettledTodo(task));
	// Settled tasks are never active, so a fully settled phase selects over itself.
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	// `done`/`drop` accept any named task, so settled tasks are not necessarily a prefix.
	const lead = tasks.filter(isSettledTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	options?: { userAuthored?: boolean },
): TodoPhase[] {
	switch (entry.op) {
		case "init": {
			const next = initPhases(entry, errors);
			if (options?.userAuthored) return next;
			// Model init must not erase unresolved model drops the settle gate protects.
			const retained: TodoPhase[] = [];
			for (const phase of phases) {
				const drops = phase.tasks.filter(
					t => t.status === "abandoned" && t.droppedBy !== "user",
				);
				if (drops.length === 0) continue;
				const existing = next.find(p => p.name === phase.name);
				if (existing) {
					for (const drop of drops) {
						if (!existing.tasks.some(t => t.content === drop.content && t.status === "abandoned")) {
							existing.tasks.push(cloneTask(drop));
						}
					}
				} else {
					retained.push({ name: phase.name, tasks: drops.map(cloneTask) });
				}
			}
			return retained.length === 0 ? next : [...next, ...retained];
		}
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
						candidate.droppedBy = undefined;
					}
				}
			}
			hit.task.status = "in_progress";
			hit.task.droppedBy = undefined;
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
				task.droppedBy = undefined;
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (!options?.userAuthored) {
					// Phase-wide/untargeted model drops must not reopen finished or
					// blocked work — same settle-gate contract as model `rm`. A
					// targeted `drop` (explicit `task`) honors the tool contract and
					// can abandon blocked/completed work the model no longer tracks.
					// Keep existing user cancels (incl. droppedBy) untouched.
					if (!entry.task && (task.status === "completed" || task.status === "blocked")) continue;
					if (task.status === "abandoned" && task.droppedBy === "user") continue;
				}
				task.status = "abandoned";
				delete task.blocker;
				if (options?.userAuthored) task.droppedBy = "user";
				else delete task.droppedBy;
			}
			return phases;
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
				task.droppedBy = undefined;
			}
			return phases;
		}
		case "unblock": {
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
					task.droppedBy = undefined;
				}
			}
			return phases;
		}
		case "rm":
			if (options?.userAuthored) return removeTasks(phases, entry, errors);
			// Model `rm` is a settle cheat: abandon in place like `drop`.
			// Leave completed/blocked alone, and keep existing abandoned (incl. user
			// droppedBy) so rm cannot rewrite terminals into unprovenanced drops.
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "completed" || task.status === "blocked") continue;
				if (task.status === "abandoned") continue; // keep droppedBy
				task.status = "abandoned";
				task.droppedBy = undefined;
			}
			return phases;
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry.
 */
function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(phases: TodoPhase[], params: TodoOpEntryValue): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
	options?: { userAuthored?: boolean },
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors, options);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/**
 * Escape HTML comment delimiters in todo task text so a literal
 * `<!-- dropped-by: user -->` (or blocker comment) in content cannot be
 * mistaken for provenance metadata on the next parse.
 *
 * Ampersands are escaped first so a pre-existing `&lt;!--` / `--&gt;` in
 * content round-trips bijectively instead of decoding into real delimiters.
 */
export function escapeTodoMarkdownContent(content: string): string {
	return content.replaceAll("&", "&amp;").replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

/** Inverse of {@link escapeTodoMarkdownContent} after provenance comments are stripped. */
export function unescapeTodoMarkdownContent(content: string): string {
	return content.replaceAll("&lt;!--", "<!--").replaceAll("--&gt;", "-->").replaceAll("&amp;", "&");
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			// Provenance notes ride in trailing HTML comments: invisible in rendered
			// markdown. Task content escapes `<!--`/`-->` so only metadata we emit
			// here can match the parse-time sentinel.
			const visible = escapeTodoMarkdownContent(task.content);
			const blockerNote =
				task.status === "blocked" && task.blocker
					? ` <!-- blocker: ${escapeTodoMarkdownContent(task.blocker)} -->`
					: "";
			const droppedByNote =
				task.status === "abandoned" && task.droppedBy === "user" ? ` <!-- dropped-by: user -->` : "";
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${visible}${blockerNote}${droppedByNote}`);
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		// Tolerate backslash-escaped brackets (`- \[x\]`): some editors and
		// markdown serializers escape `[` (and `]`) when round-tripping, yet the
		// line still renders as a normal `[x]` checkbox. Accept either form.
		const taskMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
				continue;
			}
			// Recover blocker / dropped-by provenance from trailing HTML comments
			// (see phasesToMarkdown), then unescape comment delimiters in content.
			const rawContent = taskMatch[2].trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
			if (status === "blocked" && blockerMatch) {
				currentPhase.tasks.push({
					content: unescapeTodoMarkdownContent(blockerMatch[1].trim()),
					status,
					blocker: unescapeTodoMarkdownContent(blockerMatch[2].trim()),
				});
			} else {
				// Recover an already-stamped user drop from the HTML comment emitted by
				// phasesToMarkdown. Bare `[-]` stays model-shaped here — callers that
				// commit user markdown (edit/import) must run applyUserMarkdownPhases
				// against the prior list so no-op edits do not reclassify model drops.
				const droppedByMatch = /^(.*?)\s*<!--\s*dropped-by:\s*user\s*-->$/.exec(rawContent);
				if (status === "abandoned" && droppedByMatch) {
					currentPhase.tasks.push({
						content: unescapeTodoMarkdownContent(droppedByMatch[1].trim()),
						status,
						droppedBy: "user",
					});
				} else {
					currentPhase.tasks.push({ content: unescapeTodoMarkdownContent(rawContent), status });
				}
			}
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

/**
 * Decide whether an abandoned task from a user-authored replace should carry
 * `droppedBy: "user"` given the matched prior occurrence.
 *
 * - newly abandoned → user cancel
 * - still abandoned + prior `droppedBy: "user"` → keep (comment may have been stripped)
 * - still abandoned + prior was model-abandoned → stay model (no-op edit)
 * - empty prior (fresh import / first RPC set) → all abandoned are user-authored
 */
function shouldStampAbandonedAsUser(prev: TodoItem | undefined, emptyPrior: boolean, task: TodoItem): boolean {
	if (task.droppedBy === "user") return true;
	if (emptyPrior || !prev || prev.status !== "abandoned") return true;
	return prev.droppedBy === "user";
}

/**
 * Prior tasks keyed by phase name, then content, as FIFO occurrence queues.
 * Duplicate texts with different provenance must not collapse to last-content-wins.
 */
function buildPriorOccurrenceLookup(prior: TodoPhase[]): {
	queues: Map<string, Map<string, TodoItem[]>>;
	empty: boolean;
} {
	const queues = new Map<string, Map<string, TodoItem[]>>();
	let empty = true;
	for (const phase of prior) {
		if (phase.tasks.length > 0) empty = false;
		let byContent = queues.get(phase.name);
		if (!byContent) {
			byContent = new Map();
			queues.set(phase.name, byContent);
		}
		for (const task of phase.tasks) {
			let list = byContent.get(task.content);
			if (!list) {
				list = [];
				byContent.set(task.content, list);
			}
			list.push(task);
		}
	}
	return { queues, empty };
}

function takePriorOccurrence(
	queues: Map<string, Map<string, TodoItem[]>>,
	phaseName: string,
	content: string,
): TodoItem | undefined {
	const list = queues.get(phaseName)?.get(content);
	if (list && list.length > 0) return list.shift();
	return undefined;
}

/** Content-only FIFO across all phases — used when a phase was renamed/moved. */
function takePriorOccurrenceAnyPhase(
	queues: Map<string, Map<string, TodoItem[]>>,
	content: string,
): TodoItem | undefined {
	for (const byContent of queues.values()) {
		const list = byContent.get(content);
		if (list && list.length > 0) return list.shift();
	}
	return undefined;
}

/**
 * Merge a user-authored markdown parse against the prior in-memory list.
 *
 * `/todo edit` round-trips through phasesToMarkdown → editor → markdownToPhases.
 * Model drops serialize as bare `[-]` (no HTML comment), so stamping every
 * abandoned parse result as user-authored would fail open on a no-op save.
 * Pass an empty `prior` for `/todo import` so every `[-]`/`[~]` is a user cancel
 * even when the replaced list already held a model-abandoned item with the same content.
 *
 * Matching is by phase name + content occurrence order (not a last-content-wins
 * map), so duplicate texts with different provenance keep their stamps on a no-op edit.
 * When a phase is renamed/moved, fall back to content-only matching so model-drop
 * provenance is not rewritten as `droppedBy: "user"`.
 */
export function applyUserMarkdownPhases(prior: TodoPhase[], parsed: TodoPhase[]): TodoPhase[] {
	const { queues, empty } = buildPriorOccurrenceLookup(prior);

	// Pass 1: reserve every exact phase+content match so a renamed phase that
	// sorts earlier cannot steal another phase's pending occurrence via the
	// content-only fallback (which would mis-stamp model drops as user cancels).
	const exact = parsed.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => {
			const next = cloneTask(task);
			const prev = takePriorOccurrence(queues, phase.name, next.content);
			return { next, prev };
		}),
	}));

	const priorAbandoned = prior.flatMap(phase =>
		phase.tasks.filter(task => task.status === "abandoned").map(task => ({ phase: phase.name, task })),
	);
	let abandonedIdx = 0;
	return exact.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(({ next, prev: exactPrev }) => {
			let prev = exactPrev;
			if (!prev) prev = takePriorOccurrenceAnyPhase(queues, next.content);
			if (!prev && next.status === "abandoned") {
				const positional = priorAbandoned[abandonedIdx];
				if (positional) prev = positional.task;
			}
			if (next.status === "abandoned") abandonedIdx++;
			if (next.status !== "abandoned") return next;
			if (shouldStampAbandonedAsUser(prev, empty, next)) {
				next.droppedBy = "user";
			}
			return next;
		}),
	}));
}

/**
 * Stamp host-authored abandoned provenance for RPC `set_todos` without
 * reconstructing phases/tasks — preserves wire fields such as phase/task `id`,
 * `notes`, and `details` that Python RPC callers round-trip.
 */
export function applyRpcTodoProvenance(prior: TodoPhase[], incoming: TodoPhase[]): TodoPhase[] {
	const { queues, empty } = buildPriorOccurrenceLookup(prior);

	const exact = incoming.map(phase => ({
		phase,
		tasks: phase.tasks.map(task => ({
			task,
			prev: takePriorOccurrence(queues, phase.name, task.content),
		})),
	}));

	return exact.map(({ phase, tasks }) => ({
		...phase,
		tasks: tasks.map(({ task, prev: exactPrev }) => {
			let prev = exactPrev;
			if (!prev) prev = takePriorOccurrenceAnyPhase(queues, task.content);
			if (task.status !== "abandoned") return task;
			if (!shouldStampAbandonedAsUser(prev, empty, task)) return task;
			return { ...task, droppedBy: "user" as const };
		}),
	}));
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(
				task => task.status === "pending" || task.status === "in_progress" || task.status === "abandoned",
			),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		const droppedRemaining = remainingTasks.filter(task => task.status === "abandoned").length;
		lines.push(
			droppedRemaining > 0
				? `Remaining items (${remainingTasks.length - droppedRemaining} open + ${droppedRemaining} dropped):`
				: `Remaining items (${remainingTasks.length}):`,
		);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	const completedAll = tasks.filter(task => task.status === "completed").length;
	const droppedAll = tasks.filter(task => task.status === "abandoned").length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	const openAll = tasks.filter(task => task.status === "pending" || task.status === "in_progress").length;
	// The active phase is the EARLIEST one still holding open work, so the
	// in-progress pointer can sit in a phase whose successors already have
	// completed tasks. Detect that "worked ahead" case to explain the
	// otherwise-surprising backward pointer instead of letting it read as a
	// completed task reverting to pending.
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx && phase.tasks.some(task => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(
		`Overall: ${completedAll}/${tasks.length} done${droppedAll > 0 ? `, ${droppedAll} dropped` : ""}, ${openAll} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly examples: readonly ToolExample<typeof todoSchema.infer>[] = [
		{
			caption: "Initial setup (multi-phase)",
			call: {
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
					{ phase: "Auth", items: ["Port credential store", "Wire OAuth providers"] },
					{ phase: "Verification", items: ["Run cargo test"] },
				],
			},
		},
		{
			caption: "View current state (read-only)",
			call: { op: "view" },
		},
		{
			caption: "Initial setup (single phase)",
			call: {
				op: "init",
				list: [{ phase: "Implementation", items: ["Apply fix", "Run tests"] }],
			},
		},
		{
			caption: "Complete one task",
			call: { op: "done", task: "Wire workspace" },
		},
		{
			caption: "Complete a whole phase",
			call: { op: "done", phase: "Auth" },
		},
		{
			caption: "Remove all tasks",
			call: { op: "rm" },
		},
		{
			caption: "Drop one task",
			call: { op: "drop", task: "Run cargo test" },
		},
		{
			caption: "Append tasks to a phase",
			call: { op: "append", phase: "Auth", items: ["Handle retries", "Run tests"] },
		},
	];
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const op = entry.op;
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const details: TodoToolDetails = { op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}
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

export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
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
			const located = findTaskByContent(phases, op.task);
			if (located) touched.add(located.phase.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

/**
 * Dim `completed/total` suffix for a phase header. Abandoned is not done.
 */
function formatPhaseProgress(phase: TodoPhase, uiTheme: Theme): string {
	return uiTheme.fg("dim", `  ${formatTodoHudRatio(todoHudCounts(phase.tasks))}`);
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
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
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

		return framedBlock(uiTheme, width => {
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
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
