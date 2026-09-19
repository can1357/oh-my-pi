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
		`Running… (esc to cancel)`,
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
		parts.push(theme.fg("dim", `… ${opts.hiddenLineCount} more lines (ctrl+o to expand)`));
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

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
