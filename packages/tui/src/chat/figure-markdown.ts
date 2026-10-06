import type { Tokens } from "@oh-my-pi/pi-utils/marked";
import type { ImageBudget } from "../components/image";
import type { Markdown } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Container } from "../tui";
import { SvgFigure, svgFigureRendering } from "./svg-figure";
import { type FigureSegment, splitSvgFences } from "./svg-source";
import { type ChartSegment, hasChartTable, splitTableCharts, TableChartFigure } from "./table-chart";

export interface FigureMarkdownOptions {
	/** Markdown for one prose run (and a failed figure's code fallback); FigureMarkdown drives its transience. */
	markdown: (text: string) => Markdown;
	/** Shared inline-image budget for the figures. */
	budget?: ImageBudget;
	/** A figure's rows changed outside a text update (raster landed, fell back to code). */
	onChange: () => void;
}

type Part =
	| { readonly kind: "markdown"; readonly md: Markdown; text: string }
	| { readonly kind: "svg"; readonly figure: SvgFigure; source: string; closed: boolean }
	| { readonly kind: "chart"; readonly figure: TableChartFigure; table: Tokens.Table };

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
	#text = "";
	#transient = false;
	#parts: Part[] = [];

	constructor(text: string, options: FigureMarkdownOptions) {
		super();
		this.#options = options;
		this.setText(text);
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
	 * byte, so they are all a transcript may publish ahead of the figure.
	 */
	get leadingProse(): string {
		const first = this.#parts[0];
		return first?.kind === "markdown" ? first.text : "";
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
				return { kind: "chart", figure: new TableChartFigure({ budget, onChange }), table: segment.table };
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
				figure: new SvgFigure({ markdown, budget, onChange }),
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
		if (!hasChartTable(this.#text)) return fences;
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
