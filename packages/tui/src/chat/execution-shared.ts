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
import { DEFAULT_TERMINAL_PREVIEW_LINES, expandKeyHint } from "../render/render-utils";
import type { TspCardStatus, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { card, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";

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
}): Text | undefined {
	const parts: string[] = [];

	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		parts.push(theme.fg("dim", `… ${opts.hiddenLineCount} more lines (${expandKeyHint()} to expand)`));
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
	/** Body nodes before the output (the eval cell's code). */
	readonly lead?: readonly NativeChild[];
	/** Raw terminal output. */
	readonly output: string;
	readonly images?: readonly NativeChild[];
	readonly exitCode: number | undefined;
	readonly truncation: TruncationMeta | undefined;
	readonly artifactError?: OutputArtifactError;
}

/**
 * Native card shared by user bash/eval runs: the head with a live `elapsed`
 * while running, the output as an `ansi` mini terminal that follows its tail
 * while running, a cancel hint spinner, then exit/truncation notes. The
 * terminal clamps the collapsed body and owns the "N more lines" affordance.
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
		children.push(
			node("ansi", { text: input.output, follow: running, preview: { lines: PREVIEW_LINES } }, undefined, "output"),
		);
	}
	if (input.images) children.push(...input.images);
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
	if (notes.length > 0) children.push(text(notes, { wrap: "word", key: "notes" }));
	return card(
		{
			role: input.role,
			tone: input.muted ? "muted" : undefined,
			status: EXECUTION_CARD_STATUS[input.status],
			collapsible: true,
			collapsed: !input.expanded,
			preview: { lines: PREVIEW_LINES },
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
	/** The command / cell source, shown once in the head. */
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
}

/**
 * A user `!`/`$` run as the agent's `tool` frame (§6.6): the command in the
 * head with a `you` badge (plus `not sent` when excluded from context), the
 * timer, exit chip and cancelled note; the body is the output as an `ansi`
 * mini terminal following its tail, then one quiet truncation line.
 */
export function describeExecutionTool(input: ExecutionToolInput): NativeNode {
	const running = input.status === "running";
	const body: NativeChild[] = [];
	if (input.output) body.push(node("ansi", { text: input.output, follow: running }, undefined, "output"));
	if (input.images) body.push(...input.images);
	const notes: string[] = [];
	if (input.truncation) notes.push(formatTruncationMetaNotice(input.truncation));
	if (input.artifactError) notes.push(formatArtifactErrorNotice(input.artifactError));
	if (notes.length > 0) {
		body.push({
			...text([span(notes.join(" · "), "muted")], { wrap: "word", role: "omp.tool.notice" }),
			key: "foot",
		});
	}
	const ms = Math.max(0, Math.round((input.endedAt ?? performance.now()) - input.startedAt));
	const badges: { text: string; tone?: TspTone; title?: string }[] = [{ text: "you", tone: "user" }];
	if (input.excluded) badges.push({ text: "not sent", title: "Not sent to the model", tone: "muted" });
	const hasBody = body.length > 0;
	return node(
		"tool",
		{
			role: input.role,
			name: input.name,
			title: input.title,
			target: input.command,
			targetKind: "command",
			lang: input.lang,
			badges,
			status: EXECUTION_CARD_STATUS[input.status],
			age: running ? ms : undefined,
			took: running ? undefined : ms,
			exit: input.status === "error" ? input.exitCode : undefined,
			note: input.status === "cancelled" ? "cancelled" : undefined,
			frame: "card",
			collapsible: hasBody,
			collapsed: hasBody ? !input.expanded : undefined,
			preview: hasBody ? { tail: DEFAULT_TERMINAL_PREVIEW_LINES } : undefined,
		},
		body,
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
