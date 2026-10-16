import { Text } from "../components/text";
import { ansi } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { getPaddingX } from "../utils";
import { truncateToVisualLines } from "../chrome/visual-truncate";
import { classifySixelRow, getSixelLineMask } from "./sixel";
import { formatExpandHint, replaceTabs } from "./render-utils";

/** Which side of an output stream remains visible when the pane is capped. */
export type OutputPaneEdge = "head" | "tail";

/** Inputs for the shared output capping and styling algorithm. */
export interface OutputPaneFormatOptions {
	lines: readonly string[];
	expanded: boolean;
	collapsedMaxLines: number;
	expandedMaxLines?: number;
	edge?: OutputPaneEdge;
	/** Apply the cap after terminal-width wrapping instead of to logical rows. */
	visual?: boolean;
	/** Content width used by visual capping. Required when `visual` is true. */
	width?: number;
	styleLine?: (line: string, index: number) => string;
	/** Keep sixel payload rows byte-for-byte and show the complete payload. */
	uncapSixel?: boolean;
	showHiddenMarker?: boolean;
	showExpandHint?: boolean;
	showExpandHintWhenUncapped?: boolean;
	formatHidden?: (hidden: number, shown: number, total: number, edge: OutputPaneEdge) => string;
}

/** Result of formatting one bounded output pane. */
export interface OutputPaneFormatResult {
	lines: readonly string[];
	hiddenCount: number;
	hasSixel: boolean;
	/**
	 * Aligned with `lines`: the rows that carry a SIXEL payload. Absent when no
	 * row does, so payload-free streams never pay for the lookup, and left
	 * absent by the visual caps, whose wrapped rows no longer map back to a
	 * source row. A payload row must be emitted byte-for-byte by the caller:
	 * the wrap stage would split its DCS string.
	 */
	sixelRows?: boolean[];
}

/**
 * Split terminal text without allowing carriage-return progress updates to
 * corrupt following TUI rows. The final segment after a bare CR wins, matching
 * a terminal cursor-return overwrite.
 */
export function splitTerminalOutputLines(text: string): string[] {
	return text.split(/\r?\n/u).map(line => {
		const carriageReturn = line.lastIndexOf("\r");
		return carriageReturn < 0 ? line : line.slice(carriageReturn + 1);
	});
}

function defaultHiddenLabel(hidden: number, shown: number, total: number, edge: OutputPaneEdge): string {
	return edge === "tail"
		? `… (${hidden} earlier lines, showing ${shown} of ${total})`
		: `… ${hidden} more line${hidden === 1 ? "" : "s"}`;
}

/**
 * Style and cap output rows for code cells, tool cards, and live execution
 * panes. Sixel rows are never styled or split; with `uncapSixel`, the complete
 * payload is retained so terminal image protocols remain valid.
 */
export function formatOutputPaneLines(options: OutputPaneFormatOptions, theme: Theme): OutputPaneFormatResult {
	const edge = options.edge ?? "head";
	const rawLines = options.lines;
	const sixelMask =
		TERMINAL.imageProtocol === ImageProtocol.Sixel && rawLines.length > 0 ? getSixelLineMask(rawLines) : undefined;
	const hasSixel = sixelMask?.some(Boolean) ?? false;
	const styledLines = rawLines.map((line, index) =>
		sixelMask?.[index] ? line : (options.styleLine?.(line, index) ?? line),
	);

	const configuredLimit = options.expanded ? options.expandedMaxLines : options.collapsedMaxLines;
	const limit = hasSixel && options.uncapSixel ? undefined : configuredLimit;
	let visibleLines: readonly string[] = styledLines;
	let hiddenCount = 0;
	let sixelRows: boolean[] | undefined = hasSixel ? styledLines.map((_, i) => sixelMask?.[i] === true) : undefined;

	if (limit !== undefined && Number.isFinite(limit)) {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) {
			visibleLines = [];
			sixelRows = undefined;
			hiddenCount = styledLines.length;
		} else if (options.visual && edge === "tail") {
			// The wrapped output is capped below, so the payload survives whole in
			// the visual window but its position among the surviving rows is no
			// longer derivable here. The mask is only reported for the paths that
			// preserve the row-for-row correspondence this caller needs.
			const visual = truncateToVisualLines(styledLines.join("\n"), boundedLimit, Math.max(1, options.width ?? 1));
			visibleLines = visual.visualLines;
			sixelRows = undefined;
			hiddenCount = visual.skippedCount;
		} else if (options.visual) {
			const rendered = new Text(styledLines.join("\n"), 0, 0).render(Math.max(1, options.width ?? 1));
			visibleLines = rendered.slice(0, boundedLimit);
			sixelRows = undefined;
			hiddenCount = Math.max(0, rendered.length - visibleLines.length);
		} else if (styledLines.length > boundedLimit) {
			hiddenCount = styledLines.length - boundedLimit;
			visibleLines = edge === "tail" ? styledLines.slice(-boundedLimit) : styledLines.slice(0, boundedLimit);
			if (sixelRows) {
				sixelRows = edge === "tail" ? sixelRows.slice(-boundedLimit) : sixelRows.slice(0, boundedLimit);
			}
		}
	}

	const lines = [...visibleLines];
	if (hiddenCount > 0 && options.showHiddenMarker !== false) {
		const label = (options.formatHidden ?? defaultHiddenLabel)(
			hiddenCount,
			visibleLines.length,
			hiddenCount + visibleLines.length,
			edge,
		);
		const hint = options.showExpandHint === false ? "" : formatExpandHint(theme, options.expanded, true);
		const marker = theme.fg("dim", `${label}${hint ? ` ${hint}` : ""}`);
		if (edge === "tail") lines.unshift(marker);
		else lines.push(marker);
	} else if (!options.expanded && options.showExpandHintWhenUncapped) {
		const hint = formatExpandHint(theme, false, true);
		if (hint) lines.push(hint);
	}

	return { lines, hiddenCount, hasSixel, sixelRows };
}

/** Display policy for {@link describeOutputLines}. */
export interface NativeOutputOptions {
	expanded: boolean;
	collapsedMaxLines: number;
	expandedMaxLines?: number;
	edge?: OutputPaneEdge;
	key?: string;
}

/**
 * Raw output rows as a native `ansi` mini-terminal: the terminal wraps and
 * styles them. The row cap becomes a `preview` clamp (with its own "N more"
 * affordance); a tail edge follows the stream.
 */
export function describeOutputLines(lines: readonly string[], options: NativeOutputOptions): NativeNode {
	const limit = options.expanded ? options.expandedMaxLines : options.collapsedMaxLines;
	const preview =
		limit !== undefined && Number.isFinite(limit) ? { lines: Math.max(0, Math.floor(limit)) } : undefined;
	const described = ansi(lines.join("\n"), { follow: options.edge === "tail" ? true : undefined, preview });
	return options.key === undefined ? described : { ...described, key: options.key };
}

/** Mutable options for a live {@link OutputPane}. */
export interface OutputPaneOptions extends Omit<OutputPaneFormatOptions, "lines"> {
	paddingX?: number;
	leadingBlank?: boolean;
	maxStoredLines?: number;
	/** Normalize each logical row before it enters the retained stream. */
	normalizeLine?: (line: string) => string;
}

/**
 * Stateful, cached output viewport. Streaming callers append chunks while
 * settled callers may replace all rows. Unchanged renders preserve array
 * identity through the inner Text cache.
 */
export class OutputPane implements Component {
	readonly #theme: Theme;
	#options: OutputPaneOptions;
	#lines: string[] = [];
	#pendingCarriageReturn = false;
	// DCS state that entered the row currently being appended to. A streamed row
	// is re-classified every time a chunk grows it, so the classification is
	// derived from this entry snapshot (idempotent per row) instead of advancing
	// a shared classifier, which would reclassify a continuation row as plain
	// text once its terminator had already been seen and clamp the payload.
	#sixelRowState = false;
	#text: Text;
	#renderKey = "";
	#native: NativeNode | undefined;

	constructor(theme: Theme, options: OutputPaneOptions, text = "") {
		this.#theme = theme;
		this.#options = { ...options };
		this.#text = new Text("", options.paddingX ?? 0, 0);
		if (text) this.setText(text);
	}

	/** Replace the complete output snapshot. */
	setText(text: string): void {
		this.setLines(text ? splitTerminalOutputLines(text) : []);
	}

	/** Replace the complete output snapshot with caller-owned immutable rows. */
	setLines(lines: readonly string[]): void {
		// The snapshot is a complete row stream: sequence state restarts from its
		// first row, and its last row's exit state stays in force so a later
		// append that continues that row is still classified as payload.
		let inSequence = false;
		const normalizeLine = this.#options.normalizeLine;
		const normalized = lines.map(line => {
			const row = classifySixelRow(line, inSequence);
			inSequence = row.inSequenceAtExit;
			return row.isSixel || normalizeLine === undefined ? line : normalizeLine(line);
		});
		this.#sixelRowState = inSequence;
		this.#lines = this.#clampStoredLines(normalized);
		this.#pendingCarriageReturn = false;
		this.invalidate();
	}

	/**
	 * Append a streaming chunk. Bare CR overwrites the current logical row;
	 * a CRLF split across chunks remains a newline, so chunked and whole-text
	 * ingestion produce the same settled rows.
	 */
	append(chunk: string): void {
		if (!chunk) return;
		let index = 0;
		if (this.#pendingCarriageReturn) {
			this.#pendingCarriageReturn = false;
			if (chunk[0] === "\n") {
				this.#startLine();
				index = 1;
			} else {
				this.#replaceTail("");
			}
		}

		let segmentStart = index;
		while (index < chunk.length) {
			const char = chunk[index];
			if (char !== "\r" && char !== "\n") {
				index++;
				continue;
			}
			this.#appendToTail(chunk.slice(segmentStart, index));
			if (char === "\n") {
				this.#startLine();
			} else if (index + 1 < chunk.length) {
				if (chunk[index + 1] === "\n") {
					this.#startLine();
					index++;
				} else {
					this.#replaceTail("");
				}
			} else {
				this.#pendingCarriageReturn = true;
			}
			index++;
			segmentStart = index;
		}
		this.#appendToTail(chunk.slice(segmentStart));
		this.#lines = this.#clampStoredLines(this.#lines);
		this.invalidate();
	}

	/** Settle a trailing bare carriage return once no later LF can pair with it. */
	finish(): void {
		if (!this.#pendingCarriageReturn) return;
		this.#pendingCarriageReturn = false;
		this.#replaceTail("");
		this.invalidate();
	}

	/** Update presentation without replacing streamed content. */
	configure(options: Partial<OutputPaneOptions>): void {
		const previousPadding = this.#options.paddingX ?? 0;
		this.#options = { ...this.#options, ...options };
		const nextPadding = this.#options.paddingX ?? 0;
		if (previousPadding !== nextPadding) this.#text = new Text("", nextPadding, 0);
		this.#lines = this.#clampStoredLines(this.#lines);
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#options.expanded === expanded) return;
		this.#options = { ...this.#options, expanded };
		this.invalidate();
	}

	get lineCount(): number {
		return this.#lines.length;
	}

	get hasSixel(): boolean {
		if (TERMINAL.imageProtocol !== ImageProtocol.Sixel || this.#lines.length === 0) return false;
		return getSixelLineMask(this.#lines).some(Boolean);
	}

	getText(): string {
		return this.#lines.join("\n");
	}

	/** The retained rows as an `ansi` node; streamed appends grow its text, so the reconciler sends `text append`. */
	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= describeOutputLines(this.#lines, {
			expanded: this.#options.expanded,
			collapsedMaxLines: this.#options.collapsedMaxLines,
			expandedMaxLines: this.#options.expandedMaxLines,
			edge: this.#options.edge,
		});
		return this.#native;
	}

	render(width: number): readonly string[] {
		const paddingX = getPaddingX(this.#options.paddingX ?? 0);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const formatted = formatOutputPaneLines(
			{
				...this.#options,
				lines: this.#lines,
				width: contentWidth,
			},
			this.#theme,
		);
		const sixelRows = formatted.sixelRows;
		if (sixelRows === undefined || !sixelRows.some(Boolean)) {
			const content = `${this.#options.leadingBlank && formatted.lines.length > 0 ? "\n" : ""}${formatted.lines.join("\n")}`;
			const key = `${width}:${content.length}:${Bun.hash(content).toString(36)}`;
			if (key !== this.#renderKey) {
				this.#renderKey = key;
				this.#text.setText(content);
			}
			return this.#text.render(width);
		}
		// A payload row may not go through `Text`: `wrapTextWithAnsi` treats the
		// DCS payload as printable text, so a frame wider than the pane is split
		// across rows and padded with spaces — the terminal then receives sixel
		// data containing newlines and blanks and the image is garbled or
		// dropped. Emit it byte-for-byte and wrap only the rows around it.
		const rows: string[] = [];
		let run: string[] = this.#options.leadingBlank === true && formatted.lines.length > 0 ? [""] : [];
		const flush = (): void => {
			if (run.length === 0) return;
			this.#text.setText(run.join("\n"));
			rows.push(...this.#text.render(width));
			run = [];
		};
		for (let index = 0; index < formatted.lines.length; index++) {
			const line = formatted.lines[index]!;
			if (sixelRows[index] === true) {
				flush();
				rows.push(line);
				continue;
			}
			run.push(line);
		}
		flush();
		return rows;
	}

	invalidate(): void {
		this.#renderKey = "";
		this.#native = undefined;
		this.#text.invalidate();
	}

	releaseRenderCaches(): void {
		this.#renderKey = "";
		this.#text.setText("");
		this.#text.releaseRenderCaches();
	}

	#appendToTail(text: string): void {
		if (!text) return;
		if (this.#lines.length === 0) this.#lines.push("");
		const last = this.#lines.length - 1;
		this.#replaceTail(`${this.#lines[last]}${text}`);
	}

	#replaceTail(text: string): void {
		const normalizeLine = this.#options.normalizeLine;
		// A payload row keeps its bytes: clamping it would cut the DCS sequence.
		// The classification is derived from the state that entered this row, so
		// it holds as the row grows across appends.
		const isSixelRow = classifySixelRow(text, this.#sixelRowState).isSixel;
		const normalized = normalizeLine && !isSixelRow ? normalizeLine(text) : text;
		if (this.#lines.length === 0) this.#lines.push(normalized);
		else this.#lines[this.#lines.length - 1] = normalized;
	}

	#startLine(): void {
		// The row being closed is complete here (appends already landed on it), so
		// its exit state is the state that enters the row that starts now.
		const last = this.#lines[this.#lines.length - 1];
		if (last !== undefined) {
			this.#sixelRowState = classifySixelRow(last, this.#sixelRowState).inSequenceAtExit;
		}
		if (this.#lines.length === 0) this.#lines.push("");
		this.#lines.push("");
	}

	#clampStoredLines(lines: string[]): string[] {
		const maxStoredLines = this.#options.maxStoredLines;
		if (maxStoredLines === undefined || lines.length <= maxStoredLines) return lines;
		const boundedMax = Math.max(0, Math.floor(maxStoredLines));
		return boundedMax === 0 ? [] : lines.slice(-boundedMax);
	}
}

/** Default styling for plain tool output while preserving existing ANSI. */
export function styleToolOutputLine(line: string, theme: Theme): string {
	const normalized = replaceTabs(line);
	return normalized.includes("\x1b[") ? normalized : theme.fg("toolOutput", normalized);
}
