import type { TodoPhase } from "../tools/todo";

/** Cap leftover-todo dumps so a huge list cannot overflow every compact. */
export const INCOMPLETE_TODOS_SNAPSHOT_CAP = 40;
const INCOMPLETE_TODOS_HEADING = "## Incomplete Todos";
/** Exact h2, or the same heading with a trailing colon / extra text. */
const INCOMPLETE_TODOS_HEADING_RE = /^## Incomplete Todos(?:[ \t]*:.*|[ \t]+.+)?[ \t]*$/m;

export interface IncompleteTodoRow {
	phase: string;
	status: "pending" | "in_progress";
	title: string;
}

export interface CappedIncompleteTodos {
	rows: IncompleteTodoRow[];
	overflow: number;
}

/** Flatten pending/in_progress items as phase + status + title rows. */
export function collectIncompleteTodoRows(phases: readonly TodoPhase[]): IncompleteTodoRow[] {
	const rows: IncompleteTodoRow[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "pending" && task.status !== "in_progress") continue;
			rows.push({ phase: phase.name, status: task.status, title: task.content });
		}
	}
	return rows;
}

/** Keep the first `cap` rows and report how many were omitted. */
export function capIncompleteTodoRows(
	rows: readonly IncompleteTodoRow[],
	cap = INCOMPLETE_TODOS_SNAPSHOT_CAP,
): CappedIncompleteTodos {
	if (rows.length <= cap) return { rows: [...rows], overflow: 0 };
	return { rows: rows.slice(0, cap), overflow: rows.length - cap };
}

/** Snapshot lines: `[phase] [status] title`, plus `+ N more` when capped. */
export function formatIncompleteTodoSnapshotLines(
	rows: readonly IncompleteTodoRow[],
	cap = INCOMPLETE_TODOS_SNAPSHOT_CAP,
): string[] {
	const capped = capIncompleteTodoRows(rows, cap);
	const lines = capped.rows.map(row => `[${row.phase}] [${row.status}] ${row.title}`);
	if (capped.overflow > 0) lines.push(`+ ${capped.overflow} more`);
	return lines;
}

/** Group capped rows back into phase lists for markdown / prompt rendering. */
export function groupIncompleteTodoRowsByPhase(rows: readonly IncompleteTodoRow[]): Array<{
	name: string;
	tasks: Array<{ content: string; status: "pending" | "in_progress" }>;
}> {
	const phases: Array<{
		name: string;
		tasks: Array<{ content: string; status: "pending" | "in_progress" }>;
	}> = [];
	for (const row of rows) {
		const last = phases.at(-1);
		if (last?.name === row.phase) {
			last.tasks.push({ content: row.title, status: row.status });
			continue;
		}
		phases.push({ name: row.phase, tasks: [{ content: row.title, status: row.status }] });
	}
	return phases;
}

/** Standing summary section, or undefined when nothing remains. */
export function formatIncompleteTodosSection(
	rows: readonly IncompleteTodoRow[],
	cap = INCOMPLETE_TODOS_SNAPSHOT_CAP,
): string | undefined {
	const capped = capIncompleteTodoRows(rows, cap);
	if (capped.rows.length === 0) return undefined;
	const phases = groupIncompleteTodoRowsByPhase(capped.rows);
	const lines = [
		INCOMPLETE_TODOS_HEADING,
		"These pending/in_progress items remain after compaction; continue them. A text-only stop is not completion.",
		...phases.flatMap(phase => [
			`- ${phase.name}`,
			...phase.tasks.map(task => `  - [${task.status}] ${task.content}`),
		]),
	];
	if (capped.overflow > 0) lines.push(`- + ${capped.overflow} more`);
	return lines.join("\n");
}

/**
 * Replace a stale `## Incomplete Todos` section with `block`, or strip it when
 * `block` is undefined. The next ATX heading (`## `) ends the section.
 */
export function upsertIncompleteTodosSection(summary: string, block: string | undefined): string {
	const split = splitIncompleteTodosSection(summary);
	if (!split) {
		if (!block) return summary;
		const trimmed = summary.trimEnd();
		return trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
	}
	if (!block) {
		if (split.before.length === 0) return split.after.length === 0 ? "" : `${split.after}\n`;
		if (split.after.length === 0) return `${split.before}\n`;
		return `${split.before}\n\n${split.after}\n`;
	}
	if (split.before.length === 0) {
		return split.after.length === 0 ? `${block}\n` : `${block}\n\n${split.after}\n`;
	}
	if (split.after.length === 0) return `${split.before}\n\n${block}\n`;
	return `${split.before}\n\n${block}\n\n${split.after}\n`;
}

function splitIncompleteTodosSection(summary: string): { before: string; body: string; after: string } | undefined {
	const match = INCOMPLETE_TODOS_HEADING_RE.exec(summary);
	if (!match) return undefined;
	const start = match.index;
	const afterHeading = start + match[0].length;
	const rest = summary.slice(afterHeading);
	const nextHeading = /^## /m.exec(rest);
	const end = nextHeading ? afterHeading + nextHeading.index : summary.length;
	return {
		before: summary.slice(0, start).trimEnd(),
		body: summary.slice(start, end).trim(),
		after: summary.slice(end).replace(/^\n+/, "").trimEnd(),
	};
}

const INCOMPLETE_TODO_TASK_RE = /^\s+- \[(pending|in_progress)\] (.+)$/;
const INCOMPLETE_TODO_PHASE_RE = /^- (.+)$/;
const INCOMPLETE_TODO_OVERFLOW_RE = /^- \+ \d+ more$/;

/**
 * Reconstruct leftover pending/in_progress phases from a compaction summary's
 * standing `## Incomplete Todos` section. Used after the latest todo toolResult
 * has been summarized away.
 */
export function parseIncompleteTodosFromSummary(summary: string): TodoPhase[] {
	const split = splitIncompleteTodosSection(summary);
	if (!split) return [];
	const phases: TodoPhase[] = [];
	for (const line of split.body.split(/\r?\n/)) {
		if (INCOMPLETE_TODOS_HEADING_RE.test(line) || INCOMPLETE_TODO_OVERFLOW_RE.test(line)) continue;
		const task = INCOMPLETE_TODO_TASK_RE.exec(line);
		if (task) {
			const last = phases.at(-1);
			if (!last) continue;
			last.tasks.push({ content: task[2], status: task[1] as "pending" | "in_progress" });
			continue;
		}
		const phase = INCOMPLETE_TODO_PHASE_RE.exec(line);
		if (phase && !INCOMPLETE_TODO_OVERFLOW_RE.test(line)) {
			phases.push({ name: phase[1], tasks: [] });
		}
	}
	return phases.filter(phase => phase.tasks.length > 0);
}
