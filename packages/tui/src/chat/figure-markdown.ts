import type { Tokens } from "@oh-my-pi/pi-utils/marked";
import type { ImageBudget } from "../components/image";
import { type Markdown, streamingMarkdownSource } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { type Component, Container } from "../tui";
import { SvgFigure, svgFigureRendering } from "./svg-figure";
import { type FigureSegment, splitSvgFences } from "./svg-source";
import { type ChartSegment, hasChartTable, splitTableCharts, TableChartFigure } from "./table-chart";

export interface FigureMarkdownOptions {
	/** Markdown for one prose run (and a failed figure's code fallback); FigureMarkdown drives its transience. */
	markdown: (text: string) => Markdown;
	/** Draw charts under numeric tables; off for transcripts that are not the main session's. */
	charts: boolean;
	/** Shared inline-image budget for the figures. */
	budget?: ImageBudget;
	/** Row ceiling for child figures; defaults to a share of the terminal viewport. */
	maxRows?: number | (() => number | undefined);
	/** A figure's rows changed outside a text update (raster landed, fell back to code). */
	onChange: () => void;
}

type Part =
	| { readonly kind: "markdown"; readonly md: Markdown; text: string }
	| { readonly kind: "svg"; readonly figure: SvgFigure; source: string; closed: boolean }
	| { readonly kind: "chart"; readonly figure: TableChartFigure; table: Tokens.Table };

interface SurfacePart {
	rows: readonly string[];
	start: number;
	length: number;
	separator: boolean;
}

/**
 * Assistant Markdown whose top-level ```svg fences are lifted out of the prose
 * and drawn as images ({@link SvgFigure}), and whose numeric tables get a chart
 * drawn under them ({@link TableChartFigure}), with ordinary {@link Markdown}
 * for the prose between them. Stands in for Markdown on an assistant text
 * block that holds an svg fence or a chartable table: {@link setText} streams
 * in place, reusing every part whose kind is unchanged, and
 * {@link transientRenderCache} marks the block's tail as still streaming — the
 * last prose run renders transient, the last figure throttles its rasters
 * until its fence closes, and a table at the tail waits for its last row.
 */
export class FigureMarkdown extends Container {
	readonly #options: FigureMarkdownOptions;
	#maxRows?: number | (() => number | undefined);
	#renderMaxRows?: number;
	readonly #figureMaxRows = (): number | undefined =>
		this.#renderMaxRows ?? (typeof this.#maxRows === "function" ? this.#maxRows() : this.#maxRows);
	#text = "";
	#transient = false;
	#parts: Part[] = [];
	#surfaceParts: SurfacePart[] = [];
	#surfaceRows: readonly string[] | undefined;
	#surfaceAnchor: "top" | "bottom" = "top";

	constructor(text: string, options: FigureMarkdownOptions) {
		super();
		this.#options = options;
		this.#maxRows = options.maxRows;
		this.setText(text);
	}

	/** Replace the configured row ceiling and clear any render-time override. */
	setMaxRows(maxRows?: number | (() => number | undefined)): void {
		this.#maxRows = maxRows;
		this.#renderMaxRows = undefined;
		for (const part of this.#parts) {
			if (part.kind === "svg" || part.kind === "chart") part.figure.setMaxRows(this.#figureMaxRows);
		}
	}

	/** Fit complete figures from the surface's retained edge, separating only visible parts. */
	override render(width: number, maxRows?: number, verticalAnchor: "top" | "bottom" = "top"): readonly string[] {
		this.#renderMaxRows = maxRows;
		if (maxRows === undefined || !Number.isFinite(maxRows)) return super.render(width);
		const bottom = verticalAnchor === "bottom";
		const count = this.#parts.length;
		let unchanged =
			this.#surfaceRows !== undefined &&
			this.#surfaceParts.length === count &&
			this.#surfaceAnchor === verticalAnchor;
		let remainingRows = Math.max(0, Math.floor(maxRows));
		let neighbor: Part | undefined;
		const limits: number[] = [];
		// Measure from the retained edge, then render in display order below.
		// ImageBudget uses render order to keep the most recent images live.
		for (let step = 0; step < count; step++) {
			const index = bottom ? count - step - 1 : step;
			const part = this.#parts[index]!;
			// Charts include their own leading separator. In reverse traversal,
			// the part already selected is the one following this separator.
			const separator = neighbor !== undefined && (bottom ? neighbor.kind : part.kind) !== "chart";
			const available = Math.max(0, remainingRows - Number(separator));
			const measured =
				part.kind === "markdown" ? part.md.render(width).length : part.figure.measureRows(width, available);
			const length = Math.min(measured, available);
			limits[index] = available;
			if (length > 0) {
				remainingRows -= length + Number(separator);
				neighbor = part;
			}
		}
		neighbor = undefined;
		for (let index = 0; index < count; index++) {
			const part = this.#parts[index]!;
			const available = limits[index]!;
			// Render hidden figures with zero too, so pending/planning state uses
			// the current surface even after a resize or anchor change.
			const child: Component = part.kind === "markdown" ? part.md : part.figure;
			const rows = child.render(width, available, verticalAnchor);
			const length = Math.min(rows.length, available);
			const start = bottom ? rows.length - length : 0;
			const separator = length > 0 && neighbor !== undefined && part.kind !== "chart";
			const previous = this.#surfaceParts[index];
			if (
				previous === undefined ||
				previous.length !== length ||
				previous.start !== start ||
				previous.separator !== separator ||
				(length > 0 && previous.rows !== rows)
			) {
				unchanged = false;
				this.#surfaceParts[index] = { rows, start, length, separator };
			}
			if (length > 0) neighbor = part;
		}
		this.#surfaceParts.length = count;
		this.#surfaceAnchor = verticalAnchor;
		if (unchanged) return this.#surfaceRows!;
		const lines: string[] = [];
		for (const { rows, start, length, separator } of this.#surfaceParts) {
			if (separator) lines.push("");
			for (let row = start; row < start + length; row++) lines.push(rows[row]!);
		}
		this.#surfaceRows = lines;
		return lines;
	}

	override invalidate(): void {
		this.#surfaceRows = undefined;
		this.#surfaceParts = [];
		super.invalidate();
	}

	override releaseRenderCaches(): void {
		this.#surfaceRows = undefined;
		this.#surfaceParts = [];
		super.releaseRenderCaches();
	}

	/** Replace the source; returns whether it changed. */
	setText(text: string): boolean {
		if (text === this.#text) return false;
		this.#text = text;
		this.#reconcile();
		return true;
	}

	get transientRenderCache(): boolean {
		return this.#transient;
	}

	set transientRenderCache(value: boolean) {
		if (this.#transient === value) return;
		this.#transient = value;
		// The end of the stream completes a tail table, which may now get its chart.
		this.#reconcile();
	}

	/**
	 * The trimmed prose ahead of the first figure, or "" when the block opens
	 * with one. These are the only rows plain Markdown reproduces byte for
	 * byte, so they are all a transcript may publish ahead of the figure. While
	 * that prose is still the streaming tail (no figure follows it yet), only
	 * its settled prefix ({@link Markdown.getLastRenderStableText}) qualifies:
	 * the rest is still being written. Both forms are in
	 * {@link streamingMarkdownSource} form, so the settled prefix stays a byte
	 * prefix of the whole run once a figure splits it off.
	 */
	get leadingProse(): string {
		const first = this.#parts[0];
		if (first?.kind !== "markdown") return "";
		if (this.#transient && this.#parts.length === 1) return first.md.getLastRenderStableText().trim();
		return streamingMarkdownSource(first.text);
	}

	/** Whether a figure's final source still waits for its raster, or a chart for its pick or raster. */
	get pending(): boolean {
		return this.#parts.some(part => part.kind !== "markdown" && part.figure.pending);
	}

	/** Rebuild the prose runs through the Markdown factory after its theme changed; figures keep their rasters. */
	restyle(): void {
		this.#parts = this.#parts.map(part =>
			part.kind === "markdown" ? { kind: "markdown", md: this.#options.markdown(part.text), text: part.text } : part,
		);
		this.#mount();
		this.#syncTails();
	}

	#reconcile(): void {
		const previous = this.#parts;
		const segments = this.#segments();
		let reshaped = previous.length !== segments.length;
		this.#parts = segments.map((segment, index): Part => {
			const old = previous[index];
			if (segment.kind === "chart") {
				if (old?.kind === "chart") {
					old.table = segment.table;
					return old;
				}
				reshaped = true;
				const { budget, onChange } = this.#options;
				return {
					kind: "chart",
					figure: new TableChartFigure({ budget, maxRows: this.#figureMaxRows, onChange }),
					table: segment.table,
				};
			}
			if (segment.kind === "markdown") {
				const text = segment.text.trim();
				if (old?.kind === "markdown") {
					old.md.setText(text);
					old.text = text;
					return old;
				}
				reshaped = true;
				return { kind: "markdown", md: this.#options.markdown(text), text };
			}
			if (old?.kind === "svg") {
				old.source = segment.source;
				old.closed = segment.closed;
				return old;
			}
			reshaped = true;
			const { markdown, budget, onChange } = this.#options;
			return {
				kind: "svg",
				figure: new SvgFigure({ markdown, budget, maxRows: this.#figureMaxRows, onChange }),
				source: segment.source,
				closed: segment.closed,
			};
		});
		if (reshaped) {
			for (const old of previous) {
				if (old.kind !== "markdown" && !this.#parts.includes(old)) old.figure.dispose();
			}
			this.#mount();
		}
		this.#syncTails();
	}

	/**
	 * The block as prose, ```svg fences (when figures are on) and charts after
	 * complete tables (when charts are on); only the last run can still stream.
	 */
	#segments(): (FigureSegment | ChartSegment)[] {
		const fences: FigureSegment[] = svgFigureRendering()
			? splitSvgFences(this.#text)
			: [{ kind: "markdown", text: this.#text }];
		if (!this.#options.charts || !hasChartTable(this.#text)) return fences;
		const last = fences.length - 1;
		return fences.flatMap((segment, index): (FigureSegment | ChartSegment)[] =>
			segment.kind === "markdown" ? splitTableCharts(segment.text, this.#transient && index === last) : [segment],
		);
	}

	/** Mount the parts as children, a blank row between neighbours; a chart draws its own when it has rows. */
	#mount(): void {
		this.clear();
		this.#parts.forEach((part, index) => {
			if (index > 0 && part.kind !== "chart") this.addChild(new Spacer(1));
			this.addChild(part.kind === "markdown" ? part.md : part.figure);
		});
	}

	/** Push sources and streaming state down: only the last part can still be streaming. */
	#syncTails(): void {
		const last = this.#parts.length - 1;
		this.#parts.forEach((part, index) => {
			const streaming = this.#transient && index === last;
			if (part.kind === "markdown") part.md.transientRenderCache = streaming;
			else if (part.kind === "svg") part.figure.update(part.source, part.closed || !streaming);
			else part.figure.update(part.table);
		});
	}
}
