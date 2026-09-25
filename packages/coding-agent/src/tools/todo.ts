import {
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { hasIncompleteTodosSection, parseIncompleteTodosFromSummary } from "../session/incomplete-todos";
import type { SessionEntry } from "../session/session-entries";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

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

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors and pure `view` reads. A direct call lands these on the branch
 * through its own toolResult entry; a caller that produces no `todo`
 * toolResult (the eval bridge) must persist them itself or the next branch
 * rehydration (resume, rewind, fork, /btw) silently reverts the change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view"');

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").array().describe("tasks for flat init or append"),
	"reason?": type("string").describe("blocker note for block"),
});

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

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	// A compaction entry carrying an incomplete-todos section is itself an
	// authoritative snapshot (post-feature compacts, including `(none)` after
	// RPC clear). Once one compaction has been seen, leftover sections in older
	// compactions are stale and must not resurrect dropped tasks.
	let skipCompactionSections = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			if (skipCompactionSections) continue;
			if (hasIncompleteTodosSection(entry.summary)) {
				return clonePhases(parseIncompleteTodosFromSummary(entry.summary));
			}
			skipCompactionSections = true;
			continue;
		}
		const phases = canonicalTodoPhases(entry);
		if (phases) return clonePhases(phases);
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

/** HUD "done": completed only. Abandoned is a handoff, not progress. */
export function isCompletedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed";
}

/** HUD auto-clear settle: completed, or abandoned with an explicit user cancel. */
export function isHudSettledTodo<T extends { status: TodoStatus; droppedBy?: "user" }>(task: T): boolean {
	return task.status === "completed" || (task.status === "abandoned" && task.droppedBy === "user");
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
			const replacementContents = new Set(next.flatMap(phase => phase.tasks.map(task => task.content)));
			const retained: TodoPhase[] = [];
			for (const phase of phases) {
				const drops = phase.tasks.filter(t => t.status === "abandoned" && t.droppedBy !== "user");
				if (drops.length === 0) continue;
				const existing = next.find(p => p.name === phase.name);
				if (existing) {
					for (const drop of drops) {
						if (replacementContents.has(drop.content)) continue;
						if (!existing.tasks.some(t => t.content === drop.content)) {
							existing.tasks.push(cloneTask(drop));
						}
					}
				} else {
					const unmatched = drops.filter(drop => !replacementContents.has(drop.content));
					if (unmatched.length > 0) retained.push({ name: phase.name, tasks: unmatched.map(cloneTask) });
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

	// Reserve content matches across renamed phases before positional matching,
	// so inserted rows cannot consume an unchanged task's provenance.
	for (const phase of exact) {
		for (const item of phase.tasks) {
			item.prev ??= takePriorOccurrenceAnyPhase(queues, item.next.content);
		}
	}
	const unmatchedAbandoned = [...queues.values()].flatMap(byContent =>
		[...byContent.values()].flatMap(tasks => tasks.filter(task => task.status === "abandoned")),
	);
	return exact.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(({ next, prev: matched }) => {
			if (next.status !== "abandoned") return next;
			const prev = matched ?? unmatchedAbandoned.shift();
			if (shouldStampAbandonedAsUser(prev, empty, next)) next.droppedBy = "user";
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
