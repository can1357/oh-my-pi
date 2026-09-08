import type { TodoPhase } from "../tools/todo";

/** Cap leftover-todo dumps so a huge list cannot overflow summarizer / nudge prompts. */
export const INCOMPLETE_TODOS_SNAPSHOT_CAP = 40;
const INCOMPLETE_TODOS_HEADING = "## Incomplete Todos";
/** Unique marker emitted by {@link formatIncompleteTodosSection}; required for durable parse. */
export const INCOMPLETE_TODOS_MARKER = "<!-- omp-incomplete-todos-v1 -->";
/** Exact h2 plus required durable marker on the following line. */
const INCOMPLETE_TODOS_HEADING_RE = /^## Incomplete Todos(?:[ \t]*:.*|[ \t]+.+)?[ \t]*\n[ \t]*<!-- omp-incomplete-todos-v1 -->[ \t]*$/m;

export type IncompleteTodoStatus = "pending" | "in_progress" | "abandoned" | "blocked";

export interface IncompleteTodoRow {
	phase: string;
	status: IncompleteTodoStatus;
	title: string;
	/** When `status === "blocked"`, optional note on what the task is waiting for. */
	blocker?: string;
}

export interface CappedIncompleteTodos {
	rows: IncompleteTodoRow[];
	overflow: number;
}

function isIncompleteTodoTask(task: TodoPhase["tasks"][number]): boolean {
	if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") return true;
	// Model-abandoned rows stay incomplete at settle; user drops are intentional cancels.
	return task.status === "abandoned" && task.droppedBy !== "user";
}

/** Escape title so a newline cannot inject fake phase/task markdown structure. */
export function encodeIncompleteTodoTitle(title: string): string {
	// Encode CRLF / CR / LF distinctly so accepted strings round-trip exactly.
	// Also escape `<` so a literal `<!-- blocker: … -->` in a title cannot be
	// mistaken for the durable blocker sentinel on parse.
	return title
		.replace(/\\/g, "\\\\")
		.replace(/</g, "\\<")
		.replace(/\r\n/g, "\\r\\n")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/** Inverse of {@link encodeIncompleteTodoTitle}. */
export function decodeIncompleteTodoTitle(title: string): string {
	let out = "";
	for (let i = 0; i < title.length; i++) {
		if (title[i] === "\\" && i + 1 < title.length) {
			const next = title[i + 1];
			if (next === "r" && title[i + 2] === "\\" && title[i + 3] === "n") {
				out += "\r\n";
				i += 3;
				continue;
			}
			if (next === "r") {
				out += "\r";
				i++;
				continue;
			}
			if (next === "n") {
				out += "\n";
				i++;
				continue;
			}
			if (next === "<") {
				out += "<";
				i++;
				continue;
			}
			if (next === "\\") {
				out += "\\";
				i++;
				continue;
			}
		}
		out += title[i];
	}
	return out;
}

/** Flatten pending/in_progress/model-abandoned items as phase + status + title rows. */
export function collectIncompleteTodoRows(phases: readonly TodoPhase[]): IncompleteTodoRow[] {
	const rows: IncompleteTodoRow[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (!isIncompleteTodoTask(task)) continue;
			rows.push({
				phase: phase.name,
				status:
					task.status === "abandoned"
						? "abandoned"
						: task.status === "blocked"
							? "blocked"
							: task.status === "in_progress"
								? "in_progress"
								: "pending",
				title: task.content,
				...(task.status === "blocked" && task.blocker ? { blocker: task.blocker } : {}),
			});
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
	const lines = capped.rows.map(row => {
		const base = `[${encodeIncompleteTodoTitle(row.phase)}] [${row.status}] ${encodeIncompleteTodoTitle(row.title)}`;
		if (row.status !== "blocked" || !row.blocker) return base;
		return `${base} <!-- blocker: ${encodeIncompleteTodoTitle(row.blocker)} -->`;
	});
	if (capped.overflow > 0) lines.push(`+ ${capped.overflow} more`);
	return lines;
}

/** Group rows back into phase lists for markdown / prompt rendering. */
export function groupIncompleteTodoRowsByPhase(rows: readonly IncompleteTodoRow[]): Array<{
	name: string;
	tasks: Array<{ content: string; status: IncompleteTodoStatus; blocker?: string }>;
}> {
	const phases: Array<{
		name: string;
		tasks: Array<{ content: string; status: IncompleteTodoStatus; blocker?: string }>;
	}> = [];
	for (const row of rows) {
		const task = {
			content: row.title,
			status: row.status,
			...(row.blocker ? { blocker: row.blocker } : {}),
		};
		const last = phases.at(-1);
		if (last?.name === row.phase) {
			last.tasks.push(task);
			continue;
		}
		phases.push({ name: row.phase, tasks: [task] });
	}
	return phases;
}

/**
 * Standing summary section used for durable reconstruction after compaction.
 * Intentionally uncapped so a large live list is not permanently truncated when
 * {@link getLatestTodoPhasesFromEntries} rehydrates from this section.
 * Always emits the heading — including `(none)` when empty — so a post-feature
 * compact is distinguishable from a pre-feature summary with no section.
 */
export function formatIncompleteTodosSection(rows: readonly IncompleteTodoRow[]): string {
	if (rows.length === 0) {
		return `${INCOMPLETE_TODOS_HEADING}\n${INCOMPLETE_TODOS_MARKER}\n\n(none)`;
	}
	const phases = groupIncompleteTodoRowsByPhase(rows);
	const lines = [
		INCOMPLETE_TODOS_HEADING,
		INCOMPLETE_TODOS_MARKER,
		"These incomplete items remain after compaction; continue them. A text-only stop is not completion.",
		...phases.flatMap(phase => [
			`- ${encodeIncompleteTodoTitle(phase.name)}`,
			...phase.tasks.map(task => {
				const line = `  - [${task.status}] ${encodeIncompleteTodoTitle(task.content)}`;
				if (task.status !== "blocked" || !task.blocker) return line;
				return `${line} <!-- blocker: ${encodeIncompleteTodoTitle(task.blocker)} -->`;
			}),
		]),
	];
	return lines.join("\n");
}

/** True when a compaction summary carries the standing Incomplete Todos section. */
export function hasIncompleteTodosSection(summary: string): boolean {
	return splitIncompleteTodosSection(summary) !== undefined;
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

const INCOMPLETE_TODO_TASK_RE =
	/^\s+- \[(pending|in_progress|abandoned|blocked)\] (.*?)(?:\s+<!--\s*blocker:\s*(.*?)\s*-->)?$/;
const INCOMPLETE_TODO_PHASE_RE = /^- (.*)$/;

/**
 * Reconstruct leftover incomplete phases from a compaction summary's standing
 * `## Incomplete Todos` section. Used after the latest todo toolResult has been
 * summarized away.
 */
export function parseIncompleteTodosFromSummary(summary: string): TodoPhase[] {
	const split = splitIncompleteTodosSection(summary);
	if (!split) return [];
	const phases: TodoPhase[] = [];
	for (const line of split.body.split(/\r?\n/)) {
		if (INCOMPLETE_TODOS_HEADING_RE.test(line)) continue;
		if (line.trim() === "(none)") continue;
		// Durable section never emits `- + N more`; treat that shape as a real phase name.
		const task = INCOMPLETE_TODO_TASK_RE.exec(line);
		if (task) {
			const last = phases.at(-1);
			if (!last) continue;
			const status = task[1] as IncompleteTodoStatus;
			last.tasks.push({
				content: decodeIncompleteTodoTitle(task[2]),
				status,
				...(status === "blocked" && task[3] ? { blocker: decodeIncompleteTodoTitle(task[3]) } : {}),
			});
			continue;
		}
		const phase = INCOMPLETE_TODO_PHASE_RE.exec(line);
		if (phase) {
			phases.push({ name: decodeIncompleteTodoTitle(phase[1]), tasks: [] });
		}
	}
	return phases.filter(phase => phase.tasks.length > 0);
}
