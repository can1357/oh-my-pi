/**
 * Transcript renderer for the subagent `yield` tool ("Submit Result"). Its
 * reply ("Result submitted.") is for the model; the card shows what was
 * submitted: the section labels or workpool item in the head, the data as a
 * JSON tree (Markdown when it is a string), and the reported or rejected error.
 */
import { formatCount, isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { compact, md } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import type { NativeChild } from "../native/node";
import { formatOutputPaneLines, styleToolOutputLine } from "../render/output-pane";
import { formatExpandHint, sanitizeDisplayLines, truncateToWidth } from "../render/render-utils";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard, type ToolCardPhase } from "../render/tool-card";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { wrapTextWithAnsi } from "../utils";
import {
	describeJsonTree,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { errorText, noteText, resultText } from "./native-view";
import type {
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolRenderer,
	ToolRenderResult,
} from "./renderer";
import type { YieldItem } from "./task";

const TITLE = "Submit Result";

/** Collapsed rows of string data (a report) in the ANSI card. */
const TEXT_ROWS_COLLAPSED = 4;

/** `yield` arguments as sent; strict-mode providers send omitted optionals as `null`. */
interface YieldRenderArgs {
	type?: string | string[] | null;
	data?: unknown;
	error?: string | null;
	/** 1-based workpool item number. */
	key?: number;
}

/** One `yield` call as its card shows it, read from the args and, once settled, the result. */
interface Submission {
	/** Section labels or workpool item the call fills; absent for a whole result. */
	target?: string;
	/** The accepted (normalized) data once settled, else the data as sent. */
	data: unknown;
	/** The failure the call reports, or why the tool rejected it. */
	error?: string;
	settled: boolean;
	/** Accepted although it failed the output schema. */
	overridden: boolean;
	/** Where a settled call without data takes its result from. */
	note?: string;
}

function readSubmission(
	args: YieldRenderArgs | undefined,
	result: ToolRenderResult<YieldItem> | undefined,
): Submission {
	const details = result?.isError ? undefined : result?.details;
	const type = details?.type ?? args?.type ?? undefined;
	const incremental = Array.isArray(type) && type.length > 0;
	const data = details?.data !== undefined ? details.data : (args?.data ?? undefined);
	let error = args?.error || undefined;
	if (result?.isError) error = resultText(result) || `${TITLE} failed`;
	else if (result && details?.status === "aborted") error = details.error || resultText(result) || "Aborted";
	const settled = result !== undefined;
	return {
		target: typeof args?.key === "number" ? `item ${args.key}` : incremental ? type.join(", ") : undefined,
		data,
		error,
		settled,
		overridden: details?.schemaOverridden === true,
		note:
			settled && error === undefined && data === undefined
				? incremental
					? "Takes the last message as this section"
					: "Ends with the sections submitted earlier, or the last message"
				: undefined,
	};
}

/** Head fact for container data (`13 fields`, `4 items`). */
function sizeMeta(data: unknown): string | undefined {
	if (Array.isArray(data)) return formatCount("item", data.length);
	if (isRecord(data)) return formatCount("field", Object.keys(data).length);
	return undefined;
}

function describeData(data: unknown, streaming: boolean): NativeChild | undefined {
	if (data === undefined) return undefined;
	if (typeof data === "string") return data.trim() ? md(data, { stream: streaming }) : noteText("(empty)");
	// Open to the depth cap: the data is the card's whole point, and the
	// collapsed card's preview clamp already bounds what shows.
	return describeJsonTree(data, { hiddenRootKeys: [], openDepth: JSON_TREE_MAX_DEPTH_EXPANDED });
}

function describeSubmission(s: Submission, streaming: boolean): NativeToolView {
	const size = sizeMeta(s.data);
	return {
		tool: {
			title: TITLE,
			target: s.target,
			targetKind: s.target ? "text" : undefined,
			meta: size ? [size] : undefined,
			badges: s.overridden ? [{ text: "schema overridden", tone: "warning" }] : undefined,
		},
		tone: s.settled && s.error !== undefined ? "error" : undefined,
		body: compact([
			s.error !== undefined ? errorText(s.error) : undefined,
			describeData(s.data, streaming),
			s.note ? noteText(s.note, "dim") : undefined,
		]),
	};
}

function dataLines(data: unknown, expanded: boolean, width: number, theme: Theme): string[] {
	if (data === undefined) return [];
	if (typeof data === "string") {
		return [
			...formatOutputPaneLines(
				{
					lines: sanitizeText(data).trimEnd().split("\n"),
					expanded,
					collapsedMaxLines: TEXT_ROWS_COLLAPSED,
					styleLine: line => truncateToWidth(styleToolOutputLine(line, theme), width),
				},
				theme,
			).lines,
		];
	}
	const tree = renderJsonTreeLines(data, theme, {
		maxDepth: expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED,
		maxLines: expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED,
		maxScalarLen: expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED,
		sanitizeText,
		hiddenRootKeys: [],
	});
	if (tree.truncated) tree.lines.push(expanded ? theme.fg("dim", "…") : formatExpandHint(theme, false, true));
	return tree.lines;
}

function renderSubmission(s: Submission, options: RenderResultOptions, theme: Theme): Component {
	// The body is spinner-invariant; rebuild it only on expansion or width change.
	let memo: { expanded: boolean; width: number; lines: readonly string[] } | undefined;
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const running = options.spinnerFrame !== undefined;
			const failed = s.settled && s.error !== undefined;
			const size = sizeMeta(s.data);
			const status: StatusLineOptions = {
				icon: !s.settled ? (running ? "running" : "pending") : failed ? "error" : "done",
				spinnerFrame: options.spinnerFrame,
				title: TITLE,
				description: s.target,
				badge: s.overridden ? { label: "schema overridden", color: "warning" } : undefined,
				meta: size ? [size] : undefined,
			};
			const phase: ToolCardPhase = !s.settled ? (running ? "running" : "partial") : failed ? "error" : "success";
			if (memo === undefined || memo.expanded !== options.expanded || memo.width !== contentWidth) {
				const lines: string[] = [];
				// Wrapped in full: a schema rejection names every offending field.
				if (s.error !== undefined) {
					for (const line of sanitizeDisplayLines(s.error)) {
						lines.push(...wrapTextWithAnsi(theme.fg("error", line), Math.max(1, contentWidth)));
					}
				}
				lines.push(...dataLines(s.data, options.expanded, contentWidth, theme));
				if (s.note) lines.push(theme.fg("dim", s.note));
				memo = { expanded: options.expanded, width: contentWidth, lines };
			}
			return { status, phase, body: memo.lines };
		},
		{ paddingX: 1, paddingY: 1, ignoreTight: true, onInvalidate: () => (memo = undefined) },
	);
}

const callMemo = new OwnerMemo<NativeToolView>();
const resultMemo = new OwnerMemo<NativeToolView>();

/** Shows a `yield` call's submitted data instead of its model-facing acknowledgement. */
export const yieldToolRenderer = {
	renderCall(args: YieldRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		return renderSubmission(readSubmission(args, undefined), options, theme);
	},

	renderResult(
		result: ToolRenderResult<YieldItem>,
		options: RenderResultContextOptions,
		theme: Theme,
		args?: YieldRenderArgs,
	): Component {
		return renderSubmission(readSubmission(args, result), options, theme);
	},

	describeCall(args: YieldRenderArgs, options: RenderResultOptions): NativeToolView {
		const streaming = options.argsComplete === false;
		return callMemo.get(args, [streaming], () => describeSubmission(readSubmission(args, undefined), streaming));
	},

	describeResult(
		result: ToolRenderResult<YieldItem>,
		_options: RenderResultContextOptions,
		args?: YieldRenderArgs,
	): NativeToolView {
		return resultMemo.get(result.content, [args, result.details, result.isError], () =>
			describeSubmission(readSubmission(args, result), false),
		);
	},

	mergeCallAndResult: true,
	animatedPendingPreview: true,
} satisfies ToolRenderer<YieldRenderArgs, YieldItem>;
