import type { Tokens } from "@oh-my-pi/pi-utils/marked";
import type { ImageBudget } from "../components/image";
import { type Markdown, streamingMarkdownSource, type TableLocks } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { type Component, Container } from "../tui";
import { SvgFigure, svgFigureRendering } from "./svg-figure";
import { type FigureSegment, splitSvgFences } from "./svg-source";
import { type ChartSegment, hasChartTable, splitTableCharts, TableChartFigure } from "./table-chart";

export interface FigureMarkdownOptions {
	/** Markdown for one prose run (and a failed figure's code fallback); FigureMarkdown drives its transience. */
	markdown: (text: string) => Markdown;
	/**
	 * Table locks for the prose run at part `index` (see
	 * {@link Markdown.tableLocks}). The owner renders the run's stable prefix
	 * with the same locks, so both lay a locked table out the same.
	 */
	tableLocks?: (index: number) => TableLocks;
	/** Draw charts under numeric tables; off for transcripts that are not the main session's. */
	charts: boolean;
	/** Shared inline-image budget for the figures. */
	budget?: ImageBudget;
	/** A figure's rows changed outside a text update (raster landed, fell back to code). */
	onChange: () => void;
}

/** One piece of {@link FigureMarkdown.stablePrefix}, in render order. */
export type FigureStablePart =
	/** A prose run (part `index`), in {@link streamingMarkdownSource} form. */
	| { readonly kind: "markdown"; readonly text: string; readonly index: number }
	/**
	 * A drawn figure: its source names it, the live component renders it. Pin
	 * it once published, so a change of room scales it instead of redrawing it.
	 */
	| { readonly kind: "figure"; readonly text: string; readonly component: Component & { pin(): void } }
	/** The blank row between two parts. */
	| { readonly kind: "spacer" };

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
	 * The parts of the block no later text can change, in render order: every
	 * closed prose run, every figure whose rows are final (see
	 * {@link SvgFigure.ready}, {@link TableChartFigure.ready}), the blank rows
	 * between them, and the settled prefix ({@link Markdown.getLastRenderStableText})
	 * of a prose run still streaming at the tail. Stops in front of the first
	 * part that may still change. Prose rendered by a fresh {@link Markdown} and
	 * figures by their live components reproduce the block's rows byte for
	 * byte, so the transcript may publish them ahead of the rest. `complete`
	 * says every part is covered; `openTable` that the last one ends inside a
	 * locked table still streaming (see {@link Markdown.openTableTail}).
	 */
	stablePrefix(): { parts: FigureStablePart[]; complete: boolean; openTable: boolean } {
		const parts: FigureStablePart[] = [];
		let openTable = false;
		let complete = true;
		const last = this.#parts.length - 1;
		for (const [index, part] of this.#parts.entries()) {
			if (index > 0 && part.kind !== "chart") parts.push({ kind: "spacer" });
			if (part.kind === "markdown") {
				if (this.#transient && index === last) {
					const settled = part.md.getLastRenderStableText().trim();
					if (settled) {
						parts.push({ kind: "markdown", text: settled, index });
						openTable = part.md.lastRenderStableTextEndsInOpenTable();
					}
					complete = false;
					break;
				}
				parts.push({ kind: "markdown", text: streamingMarkdownSource(part.text), index });
				continue;
			}
			if (!part.figure.ready) {
				complete = false;
				break;
			}
			parts.push({
				kind: "figure",
				text: part.kind === "svg" ? part.source : part.table.raw,
				component: part.figure,
			});
		}
		while (parts.at(-1)?.kind === "spacer") parts.pop();
		return { parts, complete, openTable };
	}

	/** Lock a table streaming at the tail of the last prose run; see {@link Markdown.lockOpenTable}. */
	lockOpenTable(): boolean {
		const last = this.#parts.at(-1);
		return last?.kind === "markdown" && this.#transient && last.md.lockOpenTable();
	}

	/** Whether a figure's final source still waits for its raster, or a chart for its pick or raster. */
	get pending(): boolean {
		return this.#parts.some(part => part.kind !== "markdown" && part.figure.pending);
	}

	/** Rebuild the prose runs through the Markdown factory after its theme changed; figures keep their rasters. */
	restyle(): void {
		this.#parts = this.#parts.map((part, index) =>
			part.kind === "markdown" ? { kind: "markdown", md: this.#proseRun(part.text, index), text: part.text } : part,
		);
		this.#mount();
		this.#syncTails();
	}

	#proseRun(text: string, index: number): Markdown {
		const md = this.#options.markdown(text);
		md.tableLocks = this.#options.tableLocks?.(index);
		return md;
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
				// A pick that lands declined takes the table's split away: re-split
				// now, so the empty chart part is gone before any render publishes it,
				// even in a block no later text update reaches.
				const changed = (): void => {
					this.#reconcile();
					onChange();
				};
				return { kind: "chart", figure: new TableChartFigure({ budget, onChange: changed }), table: segment.table };
			}
			if (segment.kind === "markdown") {
				const text = segment.text.trim();
				if (old?.kind === "markdown") {
					old.md.setText(text);
					old.text = text;
					return old;
				}
				reshaped = true;
				return { kind: "markdown", md: this.#proseRun(text, index), text };
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
