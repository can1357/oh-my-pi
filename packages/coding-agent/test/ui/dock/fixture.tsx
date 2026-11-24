/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The dock as a text terminal stacks it, for corpus comparison: the HUD slots
 * this suite covers in terminal order (queued messages, todo, subagents,
 * model cycle, status, editor gap, widgets above), and the widgets below the
 * composer.
 */
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import {
	EditorGap,
	HookWidgets,
	HookWidgetsModel,
	ModelCycleModel,
	ModelCycleTrack,
	QueuedMessages,
	QueueModel,
	StatusHud,
	StatusHudModel,
	SubagentHud,
	SubagentHudModel,
	TodoHud,
	TodoHudModel,
} from "../../../src/ui/dock";

/** Every model the stack reads. */
export class DockModels {
	readonly todo = new TodoHudModel();
	readonly status = new StatusHudModel(this.todo);
	readonly subagents = new SubagentHudModel();
	readonly queue = new QueueModel();
	readonly cycle = new ModelCycleModel();
	readonly widgets = new HookWidgetsModel();
	/** The corpus composer is band-shaped. */
	readonly band = signal(true);
}

/** The slots above the composer, top to bottom. */
export function DockAbove(props: { readonly models: DockModels }): JSXNode {
	const m = props.models;
	return (
		<col>
			<QueuedMessages model={m.queue} />
			<TodoHud model={m.todo} />
			<SubagentHud model={m.subagents} />
			<ModelCycleTrack model={m.cycle} />
			<StatusHud model={m.status} />
			<EditorGap widgets={m.widgets} statusOccupied={m.status.occupied} band={m.band} />
			<HookWidgets model={m.widgets} placement="aboveEditor" />
		</col>
	);
}

/** The slot under the composer. */
export function DockBelow(props: { readonly models: DockModels }): JSXNode {
	return (
		<col>
			<HookWidgets model={props.models.widgets} placement="belowEditor" />
		</col>
	);
}
