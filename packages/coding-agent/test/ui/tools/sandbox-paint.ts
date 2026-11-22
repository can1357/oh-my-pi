/**
 * Presents a tool call through its presenter and paints the result as the
 * terminal look does, for the sandbox card tests: the view, its body nodes,
 * and the plain rows at a width.
 */
import { createRoot, isUiNode, jsx, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TspCardStatus } from "@oh-my-pi/pi-wire";
import { paintToolLook } from "../../../src/ui/styles/tools/block";
import "../../../src/ui/styles/tools";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "../../../src/ui/tools/contract";
import { toolNodeProps } from "../../../src/ui/transcript/tool-block";

const LOOK_ROLE = "omp.test.sandbox-look";
defineRolePainter("tool", LOOK_ROLE, paintToolLook);

export const theme = loadThemeSync("dark");
const env = staticEnvironment(theme, { now: 0 });

const SETTLED: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: true };
const WAITING: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: false };

/** What one call shows: its view, body nodes and terminal rows (escapes stripped unless `raw`). */
export interface Presented {
	readonly view: ToolView;
	readonly body: readonly UiNode[];
	rows(width?: number, raw?: boolean): string[];
}

/** `presenter`'s view of the call (no `result`) or of its result, painted as tool `name`. */
export function present<TArgs, TDetails>(
	name: string,
	presenter: ToolPresenter<TArgs, TDetails>,
	args: TArgs,
	result?: ToolResult<TDetails>,
): Presented {
	const view = result ? presenter.result!(result, SETTLED, args)! : presenter.call!(args, WAITING)!;
	const status: TspCardStatus = !result ? "pending" : result.isError ? "error" : "done";
	return {
		view,
		body: view.body === undefined ? [] : resolveChildren(view.body)(),
		rows(width = 100, raw = false) {
			return createRoot(dispose => {
				try {
					const body = view.body === undefined ? [] : resolveChildren(view.body)();
					const props = toolNodeProps({
						name,
						label: name,
						view: presenter.inline && view.inline === undefined ? { ...view, inline: true } : view,
						status,
						expanded: false,
						hasBody: body.length > 0,
						args,
					});
					const node = jsx("tool", { ...props, role: LOOK_ROLE, children: [...body] });
					if (!isUiNode(node)) throw new Error("tool node expected");
					const rows = paintNode(env, node, width).rows;
					return raw ? [...rows] : rows.map(row => stripEscapes(row).trimEnd());
				} finally {
					dispose();
				}
			});
		},
	};
}

/** The text of a `text` node's spans. */
export function spanText(node: UiNode): string {
	return ((node.props() as { spans?: readonly { t: string }[] }).spans ?? []).map(span => span.t).join("");
}
