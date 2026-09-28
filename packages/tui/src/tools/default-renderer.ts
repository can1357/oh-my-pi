import type { Component } from "../index";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "./renderer";
import type { Theme } from "../theme/theme";
import { formatOutputPaneLines, styleToolOutputLine } from "../render/output-pane";
import { renderStatusLine, type StatusLineOptions } from "../render/status-line";
import { plainToolCard, type ToolCardPhase } from "../render/tool-card";
import { truncateToWidth } from "../render/render-utils";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatExpandHint } from "../render/render-utils";

/** Inputs rendered by the fallback card used when a tool has no bespoke renderer. */
export interface DefaultToolRenderInput {
	/** Human-readable tool label. */
	label: string;
	/** Tool arguments, shown inline when collapsed and as a tree when expanded. */
	args: unknown;
	/** Settled or streaming result; omitted while only the call is available. */
	result?: {
		output: string;
		isError?: boolean;
		/** Synthetic placeholder for a call skipped mid-batch to service steering/peer
		 * input — the tool never ran, so it renders neutral (info) rather than as an error. */
		skipped?: boolean;
	};
	/** Current expansion and lifecycle state. */
	options: RenderResultOptions;
}

/** Header/body assembly shared by the string and Component APIs. */
interface DefaultToolSnapshot {
	status: StatusLineOptions;
	phase: ToolCardPhase;
	body: readonly string[];
}

/** Compute the single header/body assembly behind both default-tool entry points. */
function buildDefaultToolSnapshot(
	input: DefaultToolRenderInput,
	uiTheme: Theme,
	contentWidth: number,
): DefaultToolSnapshot {
	const { options, result } = input;
	const status: StatusLineOptions = {
		icon: options.isPartial
			? options.spinnerFrame !== undefined
				? "running"
				: "pending"
			: result?.skipped
				? "info"
				: result?.isError
					? "error"
					: "done",
		spinnerFrame: options.spinnerFrame,
		title: input.label,
	};
	if (result?.skipped) status.titleColor = "muted";
	const phase: ToolCardPhase = options.isPartial
		? options.spinnerFrame !== undefined
			? "running"
			: "partial"
		: result?.skipped
			? "info"
			: result?.isError
				? "error"
				: "success";

	const body: string[] = [];
	const args = isRecord(input.args) ? input.args : undefined;
	if (!options.expanded && args && Object.keys(args).length > 0) {
		const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(uiTheme.tree.last) - 2);
		const preview = formatArgsInline(args, inlineBudget);
		if (preview) {
			body.push(` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", preview)}`);
		}
	}

	if (options.expanded && input.args !== undefined) {
		body.push("");
		body.push(uiTheme.fg("dim", "Args"));
		const tree = renderJsonTreeLines(
			input.args,
			uiTheme,
			JSON_TREE_MAX_DEPTH_EXPANDED,
			JSON_TREE_MAX_LINES_EXPANDED,
			JSON_TREE_SCALAR_LEN_EXPANDED,
		);
		body.push(...tree.lines);
		if (tree.truncated) {
			body.push(uiTheme.fg("dim", "…"));
		}
		body.push("");
	}

	if (result) {
		const textContent = result.output.trimEnd();
		if (!textContent) {
			body.push(uiTheme.fg("dim", "(no output)"));
		} else {
			let renderedAsJson = false;
			if (textContent.startsWith("{") || textContent.startsWith("[")) {
				try {
					const parsed = JSON.parse(textContent);
					const maxDepth = options.expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
					const maxLines = options.expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
					const maxScalarLen = options.expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
					const tree = renderJsonTreeLines(parsed, uiTheme, maxDepth, maxLines, maxScalarLen);

					if (tree.lines.length > 0) {
						body.push(...tree.lines);
						if (!options.expanded) {
							body.push(formatExpandHint(uiTheme, options.expanded, true));
						} else if (tree.truncated) {
							body.push(uiTheme.fg("dim", "…"));
						}
						renderedAsJson = true;
					}
				} catch {
					// Non-JSON output that starts with a bracket is rendered as plain text.
				}
			}
			if (!renderedAsJson) {
				body.push(
					...formatOutputPaneLines(
						{
							lines: textContent.split("\n"),
							expanded: options.expanded,
							collapsedMaxLines: 4,
							expandedMaxLines: 12,
							styleLine: line => truncateToWidth(styleToolOutputLine(line, uiTheme), contentWidth),
							showExpandHintWhenUncapped: true,
						},
						uiTheme,
					).lines,
				);
			}
		}
	}

	return { status, phase, body };
}

/** Format one generic tool call/result card at the available content width. */
export function formatDefaultToolExecution(
	input: DefaultToolRenderInput,
	contentWidth: number,
	uiTheme: Theme,
): string {
	const snapshot = buildDefaultToolSnapshot(input, uiTheme, contentWidth);
	return [renderStatusLine(snapshot.status, uiTheme), ...snapshot.body].join("\n");
}

/** Render the generic fallback as the state-tinted card used by direct custom tools. */
export function renderDefaultToolExecution(input: DefaultToolRenderInput, uiTheme: Theme): Component {
	return plainToolCard(
		uiTheme,
		({ contentWidth }) => {
			const snapshot = buildDefaultToolSnapshot(input, uiTheme, contentWidth);
			return { status: snapshot.status, phase: snapshot.phase, body: snapshot.body };
		},
		{ paddingX: 1, paddingY: 1, ignoreTight: true },
	);
}
