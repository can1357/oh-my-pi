/**
 * How a child agent's extracted tool data shows on its task row.
 *
 * Tools a subagent runs can register extractors (`subprocessToolRegistry`);
 * what they extract lands in `extractedToolData[tool]` of the agent's
 * progress and result. A tool that wants that data on the task card
 * registers a view here: `inline` draws one item under a live agent (the
 * last three while collapsed), `final` draws every item under a settled
 * agent below a `Tool: <name>` label. Both return text (styled spans), never
 * rows.
 */
import type { TspText } from "@oh-my-pi/pi-wire";

/** The task card's view of one tool's extracted data. */
export interface SubprocessToolView<TData = unknown> {
	inline?(data: TData): TspText;
	final?(all: readonly TData[], expanded: boolean): TspText;
}

const views = new Map<string, SubprocessToolView>();

/** Register the task card view of tool `name`'s extracted data; a later one replaces it. */
export function registerSubprocessToolView<TData>(name: string, view: SubprocessToolView<TData>): void {
	views.set(name, view as SubprocessToolView);
}

/** The view registered for tool `name`. */
export function subprocessToolView(name: string): SubprocessToolView | undefined {
	return views.get(name);
}
