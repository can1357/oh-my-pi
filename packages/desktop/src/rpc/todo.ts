import type { TodoItem, TodoPhase, TodoStatus } from "./protocol";

/**
 * Reading the agent's plan.
 *
 * Kept apart from the panel because it is the only logic there is, and because
 * this package has no DOM test environment — what lives in a component here
 * cannot be tested, which is how the panel spent its whole life reading a field
 * that does not exist.
 */

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "abandoned", "blocked"]);

/**
 * A task is *closed* when nothing more will happen to it — dropped counts, the
 * same as done. Counting only completions leaves a phase that abandoned a task
 * reading as permanently stuck, which is why omp shares one predicate
 * (`isClosedTodo`) across its own progress counters.
 */
export function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

export function isOpen(task: TodoItem): boolean {
	return !isClosed(task);
}

/**
 * Narrow whatever arrived into phases.
 *
 * Defensive about the *shape*, not about the field names: `tasks` is what the
 * state carries, and accepting `items` "just in case" is precisely the guess
 * that hid the bug — the tool's input uses `items`, its state never does.
 */
export function parsePhases(raw: readonly unknown[]): TodoPhase[] {
	const phases: TodoPhase[] = [];
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.name !== "string") continue;
		const tasks: TodoItem[] = [];
		for (const task of Array.isArray(entry.tasks) ? entry.tasks : []) {
			if (!isRecord(task) || typeof task.content !== "string") continue;
			const status = STATUSES.has(task.status as TodoStatus) ? (task.status as TodoStatus) : "pending";
			tasks.push({
				content: task.content,
				status,
				blocker: typeof task.blocker === "string" && task.blocker ? task.blocker : undefined,
			});
		}
		phases.push({ name: entry.name, tasks });
	}
	return phases;
}

export function phaseProgress(phase: TodoPhase): { done: number; total: number } {
	return { done: phase.tasks.filter(isClosed).length, total: phase.tasks.length };
}

/**
 * Which phase the agent is on.
 *
 * The tool keeps exactly one task `in_progress` at a time and auto-promotes the
 * earliest pending one, so that task's phase is the answer whenever there is
 * one. Failing that, the first phase with anything still open; failing that,
 * the last — a finished plan should focus its end, not its beginning.
 */
export function activePhaseIndex(phases: readonly TodoPhase[]): number {
	if (phases.length === 0) return -1;
	const running = phases.findIndex(phase => phase.tasks.some(task => task.status === "in_progress"));
	if (running >= 0) return running;
	const open = phases.findIndex(phase => phase.tasks.some(isOpen));
	if (open >= 0) return open;
	return phases.length - 1;
}

export interface PlanSummary {
	done: number;
	total: number;
	open: number;
	blocked: number;
	activeIndex: number;
	activePhase?: TodoPhase;
	/** The task actually in flight, if the agent has started one. */
	activeTask?: TodoItem;
}

export function planSummary(phases: readonly TodoPhase[]): PlanSummary {
	const all = phases.flatMap(phase => phase.tasks);
	const activeIndex = activePhaseIndex(phases);
	const activePhase = activeIndex >= 0 ? phases[activeIndex] : undefined;
	return {
		done: all.filter(isClosed).length,
		total: all.length,
		open: all.filter(isOpen).length,
		blocked: all.filter(task => task.status === "blocked").length,
		activeIndex,
		activePhase,
		activeTask:
			activePhase?.tasks.find(task => task.status === "in_progress") ??
			activePhase?.tasks.find(task => task.status === "pending"),
	};
}

const ROMAN: Array<[number, string]> = [
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** `I.`, `II.`, `III.` — how omp names a phase for display, and only for display. */
export function phaseLabel(name: string, oneBasedIndex: number, multiPhase: boolean): string {
	if (!multiPhase) return name;
	let remaining = oneBasedIndex;
	let numeral = "";
	for (const [value, symbol] of ROMAN) {
		while (remaining >= value) {
			numeral += symbol;
			remaining -= value;
		}
	}
	return `${numeral || String(oneBasedIndex)}. ${name}`;
}

/**
 * The plan carried by a `todo` tool result.
 *
 * This is how the plan arrives in real time: the tool's own result holds the
 * complete new snapshot, so a phase closing mid-turn shows up immediately
 * instead of waiting for the turn to end. It is where omp's own terminal reads
 * it from too.
 */
export function phasesFromToolResult(frame: Record<string, unknown>): TodoPhase[] | null {
	if (frame.toolName !== "todo" || frame.isError === true) return null;
	const result = frame.result;
	if (!isRecord(result)) return null;
	const details = result.details;
	if (!isRecord(details) || !Array.isArray(details.phases)) return null;
	return parsePhases(details.phases);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
