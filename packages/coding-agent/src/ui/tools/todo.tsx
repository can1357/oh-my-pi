/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Todo: the call names its operations (`done 2 tasks`, `append Ship 2
 * items`); the result is the phased list as one `checklist` (`closed/total`
 * in the head), always open.
 *
 * Terminal look: `todo` (`src/ui/styles/tools/todo.ts`). The checklist's
 * `term` carries what only the terminal's collapsed view uses: the phases
 * this update touched and the items it just completed (their strike sweeps
 * in on the spinner clock).
 *
 * While collapsed, a pending task a running subagent's description matches reads as active
 * ({@link setActiveTodoDescriptions}), as the dock's todo HUD lights it.
 */
import { signal } from "@oh-my-pi/pi-tui";
import type { TspChecklistItem, TspChecklistPhase } from "@oh-my-pi/pi-wire";
import { todoMatchesAnyDescription } from "../../tools/details/todo";
import type { ToolPresenter, ToolView } from "./contract";
import { cleanText, countText, ErrorText, NoteText } from "./agent-common";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

export interface TodoPhase {
	readonly name: string;
	readonly tasks: readonly TodoItem[];
}

export interface TodoDetails {
	readonly phases?: readonly TodoPhase[];
	readonly storage?: string;
	/** Tasks this update completed. */
	readonly completedTasks?: readonly {
		readonly phase: string;
		readonly content: string;
	}[];
}

interface TodoOp {
	readonly op?: unknown;
	readonly task?: unknown;
	readonly phase?: unknown;
	readonly items?: unknown;
}

/** The single-op args, or the legacy `{ ops: [...] }` batch. */
export interface TodoArgs extends TodoOp {
	readonly ops?: unknown;
}

const STATUS: Record<TodoStatus, TspChecklistItem["status"]> = {
	pending: "pending",
	in_progress: "active",
	completed: "done",
	abandoned: "dropped",
};

/** The ops of streaming or legacy args (malformed deltas give none). */
function todoOps(args: TodoArgs | undefined): TodoOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops))
		return args.ops.filter((entry): entry is TodoOp => !!entry && typeof entry === "object");
	return typeof args.op === "string" ? [args] : [];
}

function opTasks(op: TodoOp): string[] {
	if (typeof op.task === "string") return op.task ? [op.task] : [];
	return Array.isArray(op.task)
		? op.task.filter((entry): entry is string => typeof entry === "string" && !!entry)
		: [];
}

/** `verb [task | N tasks] [phase] [N items]`. */
function describeOp(op: TodoOp): string {
	const parts = [cleanText(typeof op.op === "string" ? op.op : "update")];
	const tasks = opTasks(op);
	if (tasks.length === 1) parts.push(cleanText(tasks[0]!));
	else if (tasks.length > 1) parts.push(countText(tasks.length, "task"));
	if (typeof op.phase === "string" && op.phase) parts.push(cleanText(op.phase));
	if (Array.isArray(op.items) && op.items.length) parts.push(countText(op.items.length, "item"));
	return parts.join(" ");
}

function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/** Task contents a `task` arg names: verbatim, or a list split on newlines, `;`, `,` or spaces. */
function taskTargets(phases: readonly TodoPhase[], task: readonly string[]): string[] {
	const known = new Set(phases.flatMap(phase => phase.tasks.map(item => item.content)));
	const split = (content: string): string[] => {
		if (known.has(content)) return [content];
		let partial: string[] | undefined;
		for (const [pattern, allowPartial] of [
			[/\r?\n/, true],
			[/;/, true],
			[/,/, true],
			[/\s+/, false],
			[/[\s,;]+/, false],
		] as const) {
			const parts = content
				.split(pattern)
				.map(part => {
					const trimmed = part.trim();
					return /^(["'`])(.*)\1$/s.exec(trimmed)?.[2]!.trim() ?? trimmed;
				})
				.filter(part => part.length > 0);
			const named = parts.filter(part => known.has(part)).length;
			if (named > 0 && named === parts.length) return parts;
			if (!partial && allowPartial && named > 0 && parts.length > 1) partial = parts;
		}
		return partial ?? [content];
	};
	return task.flatMap(split);
}

/** Phases the update touched (ids), or undefined to show every phase in full. */
function touchedPhases(
	args: TodoArgs | undefined,
	phases: readonly TodoPhase[],
	details: TodoDetails,
): string[] | undefined {
	const touched = new Set<string>();
	for (const phase of phases) if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	for (const done of details.completedTasks ?? []) touched.add(done.phase);
	for (const op of todoOps(args)) {
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase && phases.some(phase => phase.name === op.phase))
			touched.add(op.phase);
		for (const content of taskTargets(phases, opTasks(op))) {
			const phase = phases.find(entry => entry.tasks.some(task => task.content === content));
			if (phase) touched.add(phase.name);
		}
	}
	if (touched.size === 0) return undefined;
	return phases.flatMap((phase, index) => (touched.has(phase.name) ? [`p${index}`] : []));
}

/** Descriptions of the running subagents (the interactive mode feeds them; none elsewhere). */
const activeTodoDescriptions = signal<readonly string[]>([]);

/** Feed the running subagents' descriptions: collapsed todo cards light the pending tasks they match. */
export function setActiveTodoDescriptions(descriptions: readonly string[]): void {
	const current = activeTodoDescriptions.peek();
	if (current.length === descriptions.length && current.every((text, i) => text === descriptions[i])) return;
	activeTodoDescriptions.set(descriptions);
}

function checklistPhases(phases: readonly TodoPhase[], descriptions: readonly string[]): TspChecklistPhase[] {
	const matched = (task: TodoItem): boolean =>
		descriptions.length > 0 && task.status === "pending" && todoMatchesAnyDescription(task.content, descriptions);
	return phases.map((phase, p) => ({
		id: `p${p}`,
		title: cleanText(phase.name),
		items: phase.tasks.map((task, t) => ({
			id: `p${p}.${t}`,
			text: cleanText(task.content),
			status: matched(task) ? "active" : STATUS[task.status],
		})),
		collapsed: phase.tasks.length > 0 && phase.tasks.every(isClosed),
	}));
}

export const todoPresenter: ToolPresenter<TodoArgs, TodoDetails> = {
	merge: true,
	call(args) {
		const ops = todoOps(args).map(describeOp);
		return {
			head: {
				title: "Todo",
				target: ops.length === 0 ? "update" : ops.join(", "),
				targetKind: "text",
			},
			term: { ops: ops.length === 0 ? ["update"] : ops },
		};
	},
	result(result, state, args): ToolView {
		if (result.isError) {
			return {
				head: { title: "Todo" },
				tone: "error",
				body: <ErrorText message={resultText(result) || "Todo operation failed"} />,
			};
		}
		const details = result.details ?? {};
		const phases = (details.phases ?? []).filter(phase => phase.tasks.length > 0);
		const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		if (total === 0)
			return {
				head: { title: "Todo" },
				body: <NoteText message={resultText(result) || "No todos"} />,
			};
		const closed = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosed).length, 0);
		const struck: string[] = [];
		for (const done of details.completedTasks ?? []) {
			phases.forEach((phase, p) => {
				if (phase.name !== done.phase) return;
				phase.tasks.forEach((task, t) => {
					if (task.content === done.content) struck.push(`p${p}.${t}`);
				});
			});
		}
		return {
			head: { title: "Todo", target: `${closed}/${total}`, targetKind: "text" },
			body: (
				<checklist
					key="checklist"
					mode="full"
					phases={() => checklistPhases(phases, state.expanded ? [] : activeTodoDescriptions())}
					term={{ touched: touchedPhases(args, phases, details), struck }}
				/>
			),
			preview: "none",
			open: true,
		};
	},
};

registerToolPresenter("todo", todoPresenter);
