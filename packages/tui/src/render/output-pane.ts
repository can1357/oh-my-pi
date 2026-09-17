import { Text } from "../components/text";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import { getPaddingX } from "../utils";
import { truncateToVisualLines } from "../chrome/visual-truncate";
import { getSixelLineMask } from "./sixel";
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

	if (limit !== undefined && Number.isFinite(limit)) {
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (boundedLimit === 0) {
			visibleLines = [];
			hiddenCount = styledLines.length;
		} else if (options.visual && edge === "tail") {
			const visual = truncateToVisualLines(styledLines.join("\n"), boundedLimit, Math.max(1, options.width ?? 1));
			visibleLines = visual.visualLines;
			hiddenCount = visual.skippedCount;
		} else if (options.visual) {
			const rendered = new Text(styledLines.join("\n"), 0, 0).render(Math.max(1, options.width ?? 1));
			visibleLines = rendered.slice(0, boundedLimit);
			hiddenCount = Math.max(0, rendered.length - visibleLines.length);
		} else if (styledLines.length > boundedLimit) {
			hiddenCount = styledLines.length - boundedLimit;
			visibleLines = edge === "tail" ? styledLines.slice(-boundedLimit) : styledLines.slice(0, boundedLimit);
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

	return { lines, hiddenCount, hasSixel };
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
	#text: Text;
	#renderKey = "";

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
		const normalizeLine = this.#options.normalizeLine;
		const normalized = normalizeLine ? lines.map(line => normalizeLine(line)) : [...lines];
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
		const content = `${this.#options.leadingBlank && formatted.lines.length > 0 ? "\n" : ""}${formatted.lines.join("\n")}`;
		const key = `${width}:${content.length}:${Bun.hash(content).toString(36)}`;
		if (key !== this.#renderKey) {
			this.#renderKey = key;
			this.#text.setText(content);
		}
		return this.#text.render(width);
	}

	invalidate(): void {
		this.#renderKey = "";
		this.#text.invalidate();
	}

	#appendToTail(text: string): void {
		if (!text) return;
		if (this.#lines.length === 0) this.#lines.push("");
		const last = this.#lines.length - 1;
		this.#replaceTail(`${this.#lines[last]}${text}`);
	}

	#replaceTail(text: string): void {
		const normalizeLine = this.#options.normalizeLine;
		const normalized = normalizeLine ? normalizeLine(text) : text;
		if (this.#lines.length === 0) this.#lines.push(normalized);
		else this.#lines[this.#lines.length - 1] = normalized;
	}

	#startLine(): void {
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
