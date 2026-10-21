/**
 * Shared rendering primitives for bash/eval execution components.
 *
 * Each helper isolates a piece of structure both components share verbatim
 * (frame layout and post-run status line). Differences in
 * how each component prepares its header, output lines, or sixel masking
 * stay in their respective files.
 */

import { Loader } from "../components/loader";
import { Text } from "../components/text";
import { Container, type TUI } from "../tui";
import { getSymbolTheme, theme } from "../theme/theme";
import type { OutputArtifactError } from "../tools/streaming-output";
import { formatArtifactErrorNotice, formatTruncationMetaNotice, type TruncationMeta } from "../tools/output-meta";
import { DynamicBorder } from "../chrome/dynamic-border";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";
import { interruptKey } from "../chrome/keybinding-hints";
import { DEFAULT_TERMINAL_PREVIEW_LINES, expandKeyHint, PREVIEW_LIMITS } from "../render/render-utils";
import type { TspCardStatus, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { card, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { runBox, runFoot, runInput, runOutput, type RunState } from "../tools/native-view";

/** Output rows shown while an execution is collapsed. */
export const PREVIEW_LINES = 20;

/** Maximum visible columns retained from an execution output line. */
export const MAX_DISPLAY_LINE_CHARS = 4000;

/** Clamp execution output by visible width without splitting ANSI sequences. */
export function clampDisplayLine(line: string): string {
	const visible = visibleWidth(line);
	if (visible <= MAX_DISPLAY_LINE_CHARS) {
		return line;
	}
	const omitted = visible - MAX_DISPLAY_LINE_CHARS;
	return `${truncateToWidth(line, MAX_DISPLAY_LINE_CHARS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
}

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error";

/** Theme color keys valid for an execution frame. */
export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

/**
 * Build the spacer + top border + content container + bottom border scaffold
 * that bash and eval execution components share. The caller appends the
 * header (command vs `>>>` prompt) and the returned loader to
 * `contentContainer` so per-mode order is preserved.
 */
export function buildExecutionFrame(
	parent: Container,
	ui: TUI,
	colorKey: ExecutionColorKey,
): { contentContainer: Container; loader: Loader } {
	const borderColor = (str: string) => theme.fg(colorKey, str);

	parent.addChild(new DynamicBorder(borderColor));

	const contentContainer = new Container();
	parent.addChild(contentContainer);

	const loader = new Loader(
		ui,
		spinner => theme.fg(colorKey, spinner),
		text => theme.fg("muted", text),
		`Running… (${interruptKey()} to cancel)`,
		getSymbolTheme().spinnerFrames,
	);

	parent.addChild(new DynamicBorder(borderColor));
	return { contentContainer, loader };
}

/**
 * Build the post-run status block (hidden-line hint, exit/cancel marker,
 * truncation notice). Returns undefined when there is nothing to display so
 * callers can skip appending a stray Text child.
 */
export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	truncation: TruncationMeta | undefined;
	artifactError?: OutputArtifactError;
	hiddenLineCount: number;
	/** Suppress the "… N more lines" hint (used when sixel passthrough renders the full output). */
	suppressHiddenCount?: boolean;
	/**
	 * Rows the caller discarded while streaming (the live line cap). They are
	 * gone for good, so they are reported apart from `hiddenLineCount`, which
	 * counts retained rows the expand key still delivers.
	 */
	droppedLineCount?: number;
	/**
	 * Rows the output throttle skipped after the retained rows — a mid/tail
	 * gap, not a dropped head. Named apart from `droppedLineCount` so the
	 * visible block is never mistaken for a complete tail.
	 */
	throttledLineCount?: number;
	/**
	 * Set when the throttle skipped a partial-line suffix that contributes no
	 * whole row: the retained last row's tail is gone, so the footer names the
	 * corrupted tail even though the skipped-row count stayed zero.
	 */
	throttledFragmentLost?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		parts.push(theme.fg("dim", `… ${opts.hiddenLineCount} more lines (${expandKeyHint()} to expand)`));
	}
	if (opts.droppedLineCount !== undefined && opts.droppedLineCount > 0) {
		parts.push(theme.fg("dim", `… ${opts.droppedLineCount} earlier lines dropped`));
	}
	if (opts.throttledLineCount !== undefined && opts.throttledLineCount > 0) {
		parts.push(theme.fg("dim", `… ${opts.throttledLineCount} lines skipped in output`));
	}
	if (opts.throttledFragmentLost === true) {
		parts.push(theme.fg("dim", "… partial output skipped in output"));
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	}
	if (opts.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.truncation)));
	}
	if (opts.artifactError) {
		parts.push(theme.fg("warning", formatArtifactErrorNotice(opts.artifactError)));
	}

	if (parts.length === 0) return undefined;
	return new Text(`\n${parts.join("\n")}`, 1, 0);
}

const EXECUTION_CARD_STATUS: Record<ExecutionStatus, TspCardStatus> = {
	running: "running",
	complete: "done",
	cancelled: "cancelled",
	error: "error",
};

/** Inputs for {@link describeExecutionCard}. */
export interface ExecutionCardInput {
	readonly role: string;
	readonly head: TspText;
	/** Excluded from context (`!!`/`$$`): a muted card. */
	readonly muted: boolean;
	readonly status: ExecutionStatus;
	/** `performance.now()` when the run started; drives the live elapsed timer. */
	readonly startedAt: number;
	readonly expanded: boolean;
	/**
	 * Body nodes before the output (the eval cell's code). The card body is not
	 * clamped, so a lead that can grow long carries its own preview.
	 */
	readonly lead?: readonly NativeChild[];
	/** Raw terminal output. */
	readonly output: string;
	readonly images?: readonly NativeChild[];
	readonly exitCode: number | undefined;
	readonly truncation: TruncationMeta | undefined;
	readonly artifactError?: OutputArtifactError;
	/** Rows the live streaming cap discarded; gone for good, so they are named apart from the hidden rows expansion still delivers. */
	readonly droppedLineCount: number;
	/** Rows the output throttle skipped after the retained rows — a mid/tail gap, named apart so the visible block is never mistaken for a complete tail. */
	readonly throttledLineCount: number;
	/** The throttle skipped a partial-line suffix contributing no whole row; the retained last row's tail is gone. */
	readonly throttledFragmentLost: boolean;
}
/**
 * Bound one collapsed card image's drawn height to the card's own preview
 * window. The image node carries its intrinsic pixel size with no max, so
 * without this a single tall emission fills screens behind a nominally
 * collapsed card. Expansion describes the untouched node, revealing it whole.
 * Reuses the image `max` bound convention (not a second mechanism).
 *
 * `maxLines` is the image's SHARE of the collapsed group's preview-height
 * budget: a per-image maximum alone would let every visible image take the
 * whole window.
 */
function clampCollapsedExecutionImage(child: NativeChild, maxLines: number): NativeChild {
	if (typeof child !== "object" || child === null || !("k" in child)) return child;
	if (child.k !== "image") return child;
	return { ...child, p: { ...child.p, max: { ...child.p?.max, h: `${maxLines}lines` } } };
}

/**
 * Native card shared by user bash/eval runs: the head with a live `elapsed`
 * while running, the output as an `ansi` mini terminal pinned to its tail,
 * a cancel hint spinner, then exit/truncation notes. The card body itself is
 * never clamped: the output (and any lead) child carries its own preview, so
 * a collapsed card still shows the notes that a body clamp would hide behind
 * a long output.
 */
export function describeExecutionCard(input: ExecutionCardInput): NativeNode {
	const running = input.status === "running";
	const headChildren: NativeChild[] = [text(input.head, { lines: 1, grow: 1 })];
	if (running) {
		headChildren.push(node("elapsed", { age: Math.max(0, Math.round(performance.now() - input.startedAt)) }));
	}
	const children: NativeChild[] = [
		node("row", { gap: "sm", align: "baseline" }, headChildren, "head"),
		...(input.lead ?? []),
	];
	if (input.output) {
		// Always pinned to the tail: a settled replay describes once, so
		// `follow: false` would anchor the collapsed preview at the earliest
		// rows and hide the result until expansion. Matches runOutput().
		children.push(
			node("ansi", { text: input.output, follow: true, preview: { lines: PREVIEW_LINES } }, undefined, "output"),
		);
	}
	// Images carry no preview of their own, so a collapsed card shows only the
	// first COLLAPSED_ITEMS and names the rest — otherwise up to 32 decoded
	// images fill screens behind a nominally collapsed command.
	// Each visible image also keeps its intrinsic pixel height unbounded, so the
	// collapsed group carries a drawn-height clamp; expansion delivers the
	// untouched nodes.
	const images = input.images ?? [];
	const visibleImages = input.expanded ? images : images.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
	if (input.expanded) {
		children.push(...visibleImages);
	} else {
		// The collapsed image group shares ONE preview-height budget: every
		// visible image takes an equal share of the card's preview window, so
		// several tall emissions cannot fill screens behind a nominally
		// collapsed command (a per-image maximum alone would allow the whole
		// window per image).
		const perImageLines = Math.max(1, Math.floor(PREVIEW_LINES / Math.max(1, visibleImages.length)));
		children.push(...visibleImages.map(child => clampCollapsedExecutionImage(child, perImageLines)));
	}
	if (running) {
		children.push(
			node("spinner", { label: [span(`Running… (${interruptKey()} to cancel)`, "muted")] }, undefined, "running"),
		);
	}
	const notes: TspSpan[] = [];
	const note = (value: string, token: string): void => {
		if (notes.length > 0) notes.push(span("\n"));
		notes.push(span(value, token));
	};
	if (input.status === "cancelled") note("(cancelled)", "warning");
	else if (input.status === "error") note(`(exit ${input.exitCode})`, "error");
	if (input.truncation) note(formatTruncationMetaNotice(input.truncation), "warning");
	if (input.artifactError) note(formatArtifactErrorNotice(input.artifactError), "warning");
	// Same notes the legacy footer prints (buildStatusFooter), so a TSP surface
	// and the fallback card name the dropped head and the throttle gap in the
	// same words.
	if (input.droppedLineCount > 0) note(`… ${input.droppedLineCount} earlier lines dropped`, "dim");
	if (input.throttledLineCount > 0) note(`… ${input.throttledLineCount} lines skipped in output`, "dim");
	if (input.throttledFragmentLost) note("… partial output skipped in output", "dim");
	const hiddenImages = images.length - visibleImages.length;
	if (hiddenImages > 0) note(`… ${hiddenImages} more image${hiddenImages === 1 ? "" : "s"}`, "dim");
	if (notes.length > 0) children.push(text(notes, { wrap: "word", key: "notes" }));
	return card(
		{
			role: input.role,
			tone: input.muted ? "muted" : undefined,
			status: EXECUTION_CARD_STATUS[input.status],
			collapsible: true,
			collapsed: !input.expanded,
		},
		children,
	);
}

/** Inputs for {@link describeExecutionTool}. */
export interface ExecutionToolInput {
	readonly role: string;
	/** Tool name for the head icon (`bash`, `eval`). */
	readonly name: string;
	readonly title: string;
	/** The command / cell source: the run box's input and the head's Copy command. */
	readonly command: string;
	readonly lang: string;
	/** Excluded from context (`!!`/`$$`). */
	readonly excluded: boolean;
	readonly status: ExecutionStatus;
	/** `performance.now()` when the run started / ended. */
	readonly startedAt: number;
	readonly endedAt: number | undefined;
	readonly expanded: boolean;
	/** Raw terminal output. */
	readonly output: string;
	readonly images?: readonly NativeChild[];
	readonly exitCode: number | undefined;
	readonly truncation: TruncationMeta | undefined;
	readonly artifactError?: OutputArtifactError;
	/** Rows the live streaming cap discarded; named in the run foot, apart from the hidden rows the preview still delivers. */
	readonly droppedLineCount: number;
	/** Rows the output throttle skipped after the retained rows — a mid/tail gap, named in the run foot apart from the dropped head. */
	readonly throttledLineCount: number;
	/** The throttle skipped a partial-line suffix contributing no whole row; the retained last row's tail is gone. */
	readonly throttledFragmentLost: boolean;
}

const EXECUTION_RUN_STATE: Record<ExecutionStatus, RunState> = {
	running: "running",
	complete: "done",
	cancelled: "cancelled",
	error: "failed",
};

/**
 * A user `!`/`$` run as the agent's `tool` frame (§6.6): a head with a `you`
 * badge (plus `not sent` when excluded from context) and the command for Copy
 * command; the body is one run box — the source, the output as an `ansi` mini
 * terminal following its tail, and the foot (state, time, truncation) — with
 * any images below it. Timer, exit chip and cancelled note stay head data.
 */
export function describeExecutionTool(input: ExecutionToolInput): NativeNode {
	const running = input.status === "running";
	const shell = input.name === "bash";
	const ms = Math.max(0, Math.round((input.endedAt ?? performance.now()) - input.startedAt));
	const state = EXECUTION_RUN_STATE[input.status];
	const box = runBox(
		[
			runInput(input.command, {
				role: shell ? "omp.tool.bash.command" : "omp.tool.eval.input",
				lang: input.lang,
				wrap: shell,
			}),
			input.output.length > 0 &&
				runOutput(input.output, {
					role: shell ? "omp.tool.bash.output" : "omp.tool.eval.output",
					previewLines: DEFAULT_TERMINAL_PREVIEW_LINES,
				}),
			runFoot({
				state,
				exitCode: input.exitCode,
				elapsedMs: ms,
				meta: {
					truncation: input.truncation,
					artifactError: input.artifactError,
					droppedLines: input.droppedLineCount,
					throttledLines: input.throttledLineCount,
					throttledFragmentLost: input.throttledFragmentLost,
				},
			}),
		],
		{ key: "run", tone: state === "failed" ? "error" : undefined },
	);
	const badges: { text: string; tone?: TspTone; title?: string }[] = [{ text: "you", tone: "user" }];
	if (input.excluded) badges.push({ text: "not sent", title: "Not sent to the model", tone: "muted" });
	return node(
		"tool",
		{
			role: input.role,
			name: input.name,
			title: input.title,
			command: input.command,
			badges,
			status: EXECUTION_CARD_STATUS[input.status],
			age: running ? ms : undefined,
			took: running ? undefined : ms,
			exit: input.status === "error" ? input.exitCode : undefined,
			note: input.status === "cancelled" ? "cancelled" : undefined,
			frame: "card",
			collapsible: true,
			collapsed: !input.expanded,
			preview: "children",
		},
		[box, ...(input.images ?? [])],
	);
}

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
