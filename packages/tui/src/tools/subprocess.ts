import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import { Text } from "../components/text";
import { renderNestedTaskResults, type TaskToolDetails } from "./task";

/** Display callbacks for structured data extracted from a child agent tool. */
export interface SubprocessToolRenderer<TData = unknown> {
	/**
	 * Render a single data item inline during streaming progress.
	 * Called for each tool execution end event.
	 */
	renderInline?: (data: TData, theme: Theme) => Component;

	/**
	 * Render accumulated data in the final result view.
	 * Called once with all accumulated data for this tool.
	 */
	renderFinal?: (allData: TData[], theme: Theme, expanded: boolean) => Component;
}
const renderers = new Map<string, SubprocessToolRenderer>();

/** Renders nested task results extracted from child agents. */
export const taskSubprocessRenderer = {
	renderFinal(allData: TaskToolDetails[], theme: Theme, expanded: boolean): Component {
		return new Text(renderNestedTaskResults(allData, expanded, theme).join("\n"), 0, 0);
	},
} satisfies SubprocessToolRenderer<TaskToolDetails>;

registerSubprocessToolRenderer("task", taskSubprocessRenderer);

/** Registers the display callbacks for a subprocess tool without its execution handler. */
export function registerSubprocessToolRenderer<T>(toolName: string, renderer: SubprocessToolRenderer<T>): void {
	renderers.set(toolName, renderer as SubprocessToolRenderer);
}

/** Looks up the display callbacks for a subprocess tool. */
export function getSubprocessToolRenderer(toolName: string): SubprocessToolRenderer | undefined {
	return renderers.get(toolName);
}
