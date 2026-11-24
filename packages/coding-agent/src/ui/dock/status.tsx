/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `status` slot: the activity line.
 *
 * At most one status row shows: the working row of a turn or of a
 * maintenance run (compaction, a retry countdown), or the idle retry hint.
 * With none, a background compaction in view stands in as the working row,
 * else the idle trailer (the last tok/s reading) docks right in a text
 * terminal.
 *
 * - Natively (role `omp.hud.activity`): the status row in an `omp.hud.status`
 *   column (or, idle on a tray host, the tray's caption), then the todo HUD,
 *   so the todo keeps its place as turns start and end. Nothing to show is the
 *   same row emptied, without its role unless the tray has cards (the host's
 *   seat for them): one node throughout, so the host keeps one element, and
 *   what it drew into it (a tray host's dots), as the line comes and goes.
 * - In a text terminal (`src/ui/styles/dock/status.ts`): the status row's
 *   rows; on a short terminal the todo HUD folds into it, docked right.
 */
import { type Accessor, computed, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import "../styles/dock";
import { TodoChecklist, type TodoHudModel } from "./todo";
import { RetryHint, WorkingRow, type WorkingSpec } from "./working";

/** What occupies the status row. */
export type StatusRow =
	| { readonly kind: "working"; readonly spec: WorkingSpec }
	| { readonly kind: "retry"; readonly retryKey: string };

/** A compaction running in the background: it takes the status row only while no turn holds it. */
export interface BackgroundRun {
	/** `Compacting context in the background`. */
	readonly label: string;
	readonly startedAt: number;
	/** The key that cancels it, when the viewed session can. */
	readonly interruptKey?: string;
}

/** The background compaction: its run and whether the viewed session is the one compacting. */
export class BackgroundCompactionModel {
	readonly run = signal<BackgroundRun | undefined>(undefined);
	readonly inView = signal(true);
	/** The run in view, if any (reactive). */
	readonly visible: Accessor<BackgroundRun | undefined> = () => (this.inView() ? this.run() : undefined);
}

/** The working row a background run shows in the idle status row. */
export function backgroundSpec(run: BackgroundRun): WorkingSpec {
	return {
		label: `${run.label}…`,
		startedAt: run.startedAt,
		variant: { kind: "compaction" },
		...(run.interruptKey !== undefined ? { interruptKey: run.interruptKey } : {}),
	};
}

/** What the activity line shows; the controller feeds it. */
export class StatusHudModel {
	readonly row = signal<StatusRow | undefined>(undefined);
	readonly background = new BackgroundCompactionModel();
	/** Terminal only: the idle stand-in for the working row's trailer, already styled (`⚡ 41.2 tok/s`). */
	readonly idleTrailer = signal<string | undefined>(undefined);
	/** Native, on a tray host while the main agent is idle: the tray's caption (`2 agents in the background`). */
	readonly trayCaption = signal<string | undefined>(undefined);
	/** Native, on a tray host: the tray has cards, so an empty line stays as their seat. */
	readonly traySeat = signal(false);
	/** The todo HUD, shown in the activity line natively and folded in on short terminals. */
	readonly todo: TodoHudModel | undefined;
	/** A click on a working row's stop control (the interrupt key's handler). */
	onInterrupt: (() => void) | undefined;

	constructor(todo?: TodoHudModel) {
		this.todo = todo;
	}

	/** The row shown: the status row, else a background compaction in view (reactive). */
	readonly current: Accessor<StatusRow | undefined> = computed(() => {
		const row = this.row();
		if (row) return row;
		const run = this.background.visible();
		return run ? { kind: "working", spec: backgroundSpec(run) } : undefined;
	});

	/** Whether the text terminal's status row draws anything (the editor gap closes under it). */
	readonly occupied: Accessor<boolean> = () =>
		this.current() !== undefined ||
		this.idleTrailer() !== undefined ||
		(this.todo?.compact() === true && this.todo.window() !== undefined);
}

/** See the module docs. */
export function StatusHud(props: { readonly model: StatusHudModel }): JSXNode {
	const model = props.model;
	const status = (
		<col key="status" role="omp.hud.status">
			{() => {
				const row = model.current();
				if (!row) return undefined;
				return row.kind === "working" ? (
					<WorkingRow spec={row.spec} onInterrupt={() => model.onInterrupt?.()} />
				) : (
					<RetryHint retryKey={row.retryKey} />
				);
			}}
		</col>
	);
	const caption = (): JSXNode => {
		const text = model.current() ? undefined : model.trayCaption();
		return (
			text !== undefined && <text key="caption" role="omp.tray.caption" text={text} wrap="none" truncate="end" />
		);
	};
	const todo = model.todo ? <TodoChecklist model={model.todo} /> : undefined;
	return (
		<row
			role={() =>
				model.current() !== undefined ||
				model.trayCaption() !== undefined ||
				model.todo?.window() !== undefined ||
				model.traySeat()
					? "omp.hud.activity"
					: undefined
			}
			align="center"
			gap="sm"
			term={{ status: model, role: "omp.hud.activity" }}
		>
			{() => model.current() !== undefined && status}
			{caption}
			{todo}
		</row>
	);
}
