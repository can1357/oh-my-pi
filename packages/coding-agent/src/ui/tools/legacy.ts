/**
 * Render hooks of extension and custom tools (`renderCall` / `renderResult`).
 *
 * A hook returns an extension render (`ExtensionRender`): pi-tui nodes or a
 * rows object (`{ render(width) }`). Nodes are the view's body, drawn by both
 * backends. Rows are drawn by the terminal alone: Tern keeps the tool's
 * semantic view (the base presenter's, else the generic card), as it always
 * did for row-drawing tools. The view carries every part, in order, under
 * `term.parts`, and the `legacy` look paints them inside the custom-tool box.
 *
 * A hook that throws or returns something unusable is reported through
 * `onRenderError`; when no hook drew anything because of that, the base view
 * shows.
 */
import { isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { ExtensionRows, ExtensionTheme } from "../../extensibility/extensions/render-types";
import { extensionOutput, extensionTheme, isExtensionRows, singleNode } from "../extensions/render-output";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";

/** One part a tool's hooks drew: rows (terminal only) or a node (both backends). */
export type ToolRenderPart = ExtensionRows | UiNode;

/** Options the render hooks receive. */
export interface LegacyRenderOptions {
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly argsComplete?: boolean;
	readonly executionStarted?: boolean;
	readonly elapsedMs?: number;
	readonly renderContext?: Readonly<Record<string, unknown>>;
}

/** A tool's render hooks. */
export interface LegacyToolRenderer {
	renderCall?(args: never, options: LegacyRenderOptions, theme: ExtensionTheme): unknown;
	renderResult?(result: never, options: LegacyRenderOptions, theme: ExtensionTheme, args?: never): unknown;
	readonly mergeCallAndResult?: boolean;
	/** A hook threw or returned neither nodes nor rows. */
	onRenderError?(error: unknown, phase: "call" | "result"): void;
}

/** The parts a legacy look draws, in order (call then result). */
export interface LegacyTerm {
	readonly look: "legacy";
	/** Draw the parts inside one padded box (the transcript's custom-tool box). */
	readonly boxed: boolean;
	readonly parts: readonly ToolRenderPart[];
}

/** What a tool's hooks drew for one view. */
export interface LegacyDrawing {
	readonly parts: readonly ToolRenderPart[];
	/** A hook threw or returned unusable output. */
	readonly failed: boolean;
}

function optionsOf(state: ToolViewState, partial = state.isPartial): LegacyRenderOptions {
	return {
		expanded: state.expanded,
		isPartial: partial,
		argsComplete: state.argsComplete,
		executionStarted: state.executionStarted,
		...(state.elapsedMs !== undefined ? { elapsedMs: state.elapsedMs } : {}),
		...(state.renderContext ? { renderContext: state.renderContext } : {}),
	};
}

/** What a renderer draws for a call (and its result, when there is one), with the current theme. */
export function legacyParts(
	renderer: LegacyToolRenderer,
	args: unknown,
	state: ToolViewState,
	result?: ToolResult,
): LegacyDrawing {
	const theme = extensionTheme(currentTheme());
	const parts: ToolRenderPart[] = [];
	let failed = false;
	const draw = (phase: "call" | "result", render: () => unknown): void => {
		const onError = (error: unknown): void => {
			failed = true;
			renderer.onRenderError?.(error, phase);
		};
		let output: unknown;
		try {
			output = render();
		} catch (error) {
			onError(error);
			return;
		}
		if (isExtensionRows(output)) {
			parts.push(output);
			return;
		}
		const node = extensionOutput(output, { onError });
		if (node !== undefined) parts.push(singleNode(node));
	};
	const call = (): void => {
		if (!renderer.renderCall) return;
		draw("call", () =>
			renderer.renderCall?.(
				structuredClone(args ?? {}) as never,
				optionsOf(state, result ? false : state.isPartial),
				theme,
			),
		);
	};
	if (!result) {
		call();
		return { parts, failed };
	}
	if (!renderer.mergeCallAndResult) call();
	if (renderer.renderResult) {
		draw("result", () => renderer.renderResult?.(result as never, optionsOf(state), theme, args as never));
	}
	return { parts, failed };
}

/** `base` with the hooks' drawing: node parts as the body, every part for the terminal. */
export function legacyView(base: ToolView | undefined, drawing: LegacyDrawing): ToolView | undefined {
	if (drawing.parts.length === 0 && drawing.failed) return base;
	const nodes = drawing.parts.filter(isUiNode);
	return {
		...base,
		...(nodes.length > 0 ? { body: nodes } : {}),
		term: { ...base?.term, look: "legacy", boxed: true, parts: drawing.parts } satisfies LegacyTerm,
	};
}

/**
 * A presenter for a tool with render hooks: `base` (the tool's registered
 * presenter, else the generic card) gives the view, the hooks its body and
 * terminal rows.
 */
export function legacyPresenter(renderer: LegacyToolRenderer, base: ToolPresenter): ToolPresenter {
	return {
		merge: renderer.mergeCallAndResult,
		inline: base.inline,
		call: (args, state) => legacyView(base.call?.(args, state), legacyParts(renderer, args, state)),
		result: (result, state, args) =>
			legacyView(
				base.result?.(result, state, args) ?? base.call?.(args, state),
				legacyParts(renderer, args, state, result),
			),
	};
}
