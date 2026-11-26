/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The todo HUD: the session's plan, docked above the composer.
 *
 * Both renderers show one stage window. Collapsed: the active stage (its
 * open tasks, at most five, the last closed ones leading and a summary row
 * for the rest) and up to four following stages as their titles, then
 * `… n more stages`. Expanded (`/todo expand`): every stage with every task.
 *
 * - Terminal (`todo` slot, `src/ui/styles/dock/todo.ts`): a blank row, `TODO`,
 *   then the window on a spine (`├─` per stage, `│` between) that ends in a
 *   short elbow tail; overall progress fills the spine, bend and tail in
 *   reading order. Under 18 terminal rows the HUD folds into the status row
 *   (`TODO 2/5 · ☐ next task`) instead.
 * - Natively the todo lives in the activity line of the `status` slot:
 *   {@link TodoChecklist}, a `checklist` HUD pill holding the whole plan, or
 *   on a host without `checklist` {@link TodoHud}'s tree with a progress bar.
 */
import { type Accessor, computed, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import type { TspChecklistItem, TspChecklistPhase, TspSpan, TspTreeNode } from "@oh-my-pi/pi-wire";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	type TodoItem,
	type TodoPhase,
	todoMatchesAnyDescription,
} from "../../tools/details/todo";
import { formatMoreItems } from "../../utils/render-utils";
import "../styles/dock";

/** Stages shown after the active one while collapsed. */
const FOLLOWING_STAGES = 4;
/** Open tasks of the active stage previewed while collapsed. */
const ACTIVE_TASKS = 5;
/** Terminal heights below this fold the HUD into the status row. */
export const TODO_COMPACT_ROWS = 18;

/** What the HUD shows; the controller feeds it from the session's todo state. */
export class TodoHudModel {
	/** The plan (phases without tasks are skipped). */
	readonly phases = signal<readonly TodoPhase[]>([]);
	/** `/todo expand`: every stage and task. */
	readonly expanded = signal(false);
	/** Dismissed (`/todo hide`, the auto-clear after a finished plan). */
	readonly hidden = signal(false);
	/** The terminal is shorter than {@link TODO_COMPACT_ROWS}: the status row carries the plan. */
	readonly compact = signal(false);
	/** Descriptions of the running subagents: a pending task they match lights up. */
	readonly descriptions = signal<readonly string[]>([]);

	/** The window to show, or undefined while hidden or empty (reactive). */
	readonly window: Accessor<TodoWindow | undefined> = computed(() =>
		this.hidden() ? undefined : todoWindow(this.phases(), this.expanded(), this.descriptions()),
	);
}

/** One stage of the window. */
export interface TodoStageView {
	readonly phase: TodoPhase;
	/** Index among the non-empty phases. */
	readonly index: number;
	/** `I. Investigate` (the bare name with a single stage). */
	readonly name: string;
	readonly active: boolean;
	readonly closed: number;
	/** Tasks shown under the title (active or expanded stages), and the collapsed summary row. */
	readonly tasks?: {
		readonly items: readonly TodoItem[];
		readonly summary: string;
	};
}

/** The stage window both renderers draw. */
export interface TodoWindow {
	/** Every non-empty phase. */
	readonly phases: readonly TodoPhase[];
	readonly multi: boolean;
	readonly stages: readonly TodoStageView[];
	/** Stages after the window (`… n more stages`). */
	readonly hiddenStages: number;
	readonly closed: number;
	readonly total: number;
	/** A pending task a running subagent works on. */
	readonly matched: (todo: TodoItem) => boolean;
}

/** The stage the plan is at: the first with open work, else the last. */
function activeIndex(phases: readonly TodoPhase[]): number {
	const index = phases.findIndex(phase => phase.tasks.some(task => !isClosedTodo(task)));
	return index < 0 ? phases.length - 1 : index;
}

/** The window of `phases` (see the module docs); undefined without tasks. */
export function todoWindow(
	allPhases: readonly TodoPhase[],
	expanded: boolean,
	descriptions: readonly string[],
): TodoWindow | undefined {
	const phases = allPhases.filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return undefined;
	const matched = (todo: TodoItem): boolean =>
		descriptions.length > 0 && todoMatchesAnyDescription(todo.content, descriptions);
	const multi = phases.length > 1;
	const active = activeIndex(phases);
	const base = expanded ? 0 : active;
	const end = expanded ? phases.length : Math.min(phases.length, base + 1 + FOLLOWING_STAGES);
	const stages: TodoStageView[] = [];
	for (let index = base; index < end; index++) {
		const phase = phases[index]!;
		const isActive = index === active;
		const open = expanded || isActive;
		stages.push({
			phase,
			index,
			name: multi ? formatPhaseDisplayName(phase.name, index + 1) : phase.name,
			active: isActive,
			closed: phase.tasks.filter(isClosedTodo).length,
			...(open
				? {
						tasks: expanded
							? { items: phase.tasks, summary: "" }
							: selectCollapsedTodos(phase.tasks, matched, ACTIVE_TASKS),
					}
				: {}),
		});
	}
	let closed = 0;
	let total = 0;
	for (const phase of phases) {
		total += phase.tasks.length;
		closed += phase.tasks.filter(isClosedTodo).length;
	}
	return {
		phases,
		multi,
		stages,
		hiddenStages: phases.length - end,
		closed,
		total,
		matched,
	};
}

/** The task the plan is on: the one in progress, else the first pending. */
export function nextTodo(phases: readonly TodoPhase[]): TodoItem | undefined {
	let pending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!pending && task.status === "pending") pending = task;
		}
	}
	return pending;
}

/** `… 3 more stages`. */
export function moreStages(count: number): string {
	return formatMoreItems(count, "stage");
}

function taskNode(todo: TodoItem, id: string, matched: boolean): TspTreeNode {
	const token =
		todo.status === "completed"
			? "success del"
			: todo.status === "abandoned"
				? "error del"
				: todo.status === "in_progress" || matched
					? "accent"
					: "dim";
	const label: TspSpan[] = [{ t: todo.content, s: token }];
	const notes = todo.notes?.length ?? 0;
	if (notes > 0) label.push({ t: ` +${notes}`, s: "dim em" });
	return { id, label, icon: todo.status === "completed" ? "check" : "circle" };
}

/** The window as tree nodes: stages (open ones with their tasks) and the summary rows. */
export function todoTreeNodes(view: TodoWindow): TspTreeNode[] {
	const nodes: TspTreeNode[] = view.stages.map(stage => {
		const children = stage.tasks?.items.map(todo =>
			taskNode(todo, `${stage.index}.${stage.phase.tasks.indexOf(todo)}`, view.matched(todo)),
		);
		if (children && stage.tasks?.summary)
			children.push({
				id: `${stage.index}.more`,
				label: [{ t: stage.tasks.summary, s: "muted" }],
			});
		return {
			id: `${stage.index}`,
			label: [
				{ t: stage.name, s: stage.active ? "accent strong" : "muted" },
				{ t: ` · ${stage.closed}/${stage.phase.tasks.length}`, s: "dim" },
			],
			open: stage.tasks !== undefined,
			children,
		};
	});
	if (view.hiddenStages > 0)
		nodes.push({
			id: "more",
			label: [{ t: moreStages(view.hiddenStages), s: "muted" }],
		});
	return nodes;
}

/** The whole plan as checklist phases (the native HUD pill's popover). */
export function todoChecklistPhases(view: TodoWindow): TspChecklistPhase[] {
	return view.phases.map((phase, phaseIndex) => ({
		id: `${phaseIndex}`,
		title: view.multi ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name,
		collapsed: phase.tasks.every(isClosedTodo) || undefined,
		items: phase.tasks.map((todo, taskIndex): TspChecklistItem => ({
			id: `${phaseIndex}.${taskIndex}`,
			text: todo.content,
			status:
				todo.status === "completed"
					? "done"
					: todo.status === "abandoned"
						? "dropped"
						: todo.status === "in_progress" || view.matched(todo)
							? "active"
							: "pending",
			note: todo.notes?.at(-1),
		})),
	}));
}

/**
 * The todo slot: the stage window as a tree under `TODO` and a progress bar
 * (what a host without `checklist` shows natively); the terminal draws it on
 * its spine.
 */
export function TodoHud(props: { readonly model: TodoHudModel }): JSXNode {
	const model = props.model;
	return () => {
		const view = model.window();
		if (!view) return undefined;
		return (
			<col key="todo" role="omp.hud.todo" term={{ todo: model }}>
				<row gap="sm" align="center">
					<text spans={[{ t: "TODO", s: "accent strong" }]} />
					<progress value={view.closed / view.total} label={`${view.closed}/${view.total}`} />
				</row>
				<tree nodes={todoTreeNodes(view)} />
			</col>
		);
	};
}

/** The native activity line's todo: a `checklist` HUD pill with the whole plan. */
export function TodoChecklist(props: { readonly model: TodoHudModel }): JSXNode {
	const model = props.model;
	return () => {
		const view = model.window();
		if (!view) return undefined;
		return <checklist key="todo" phases={todoChecklistPhases(view)} mode="hud" role="omp.hud.todo" />;
	};
}
