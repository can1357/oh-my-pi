/**
 * A ```svg fence drawn as an inline terminal image. The source is rasterized
 * off the JS thread and shown through {@link Image}; while the fence streams,
 * each throttled revision repairs the partial source and replaces the
 * previous raster, which stays on screen until the next one lands.
 *
 * Sizing is natural rather than preview-capped: one terminal row spans
 * {@link UNITS_PER_ROW} SVG user units, so `font-size="14"` text lands near
 * the terminal's own glyph size and the figure takes as many columns as its
 * drawing needs — up to the full width, and a viewport-relative height. The
 * raster is drawn at the terminal's device pixels per unit, padded to whole
 * cells, and redrawn when the room it is shown in changes, so the terminal
 * places it 1:1: any resampling, even 0.99×, blurs every glyph edge.
 */
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { Image, type ImageBudget, imageMaxColumns } from "../components/image";
import type { Markdown } from "../components/markdown";
import { type CellDimensions, getCellDimensions, getImageDimensions } from "../terminal-capabilities";
import { getThemeEpoch, type ThemeColor, theme } from "../theme";
import type { Component } from "../tui";
import { closePartialSvg, prepareSvg } from "./svg-source";

/** SVG user units per terminal row; a 1000-unit-wide drawing spans ~125 columns of 1:2 cells. */
const UNITS_PER_ROW = 16;
/** Least time between rasters of a fence that is still streaming. */
const STREAM_INTERVAL_MS = 200;
/** Longest raster edge; the native rasterizer caps the surface at 4096² pixels. */
const MAX_EDGE_PX = 4096;
/** Share of the terminal's rows one figure may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.8;

/** Foreground theme colors behind the figure tokens (`var(--name)`); `surface` is the selection background. */
const PALETTE: Readonly<Record<string, ThemeColor>> = {
	fg: "text",
	muted: "muted",
	border: "borderMuted",
	accent: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	c1: "syntaxKeyword",
	c2: "syntaxString",
	c3: "syntaxFunction",
	c4: "syntaxType",
	c5: "syntaxNumber",
	c6: "syntaxVariable",
};

/** The active theme's color per figure token, for resolving a figure with `prepareSvg`. */
export function svgFigurePalette(): Record<string, string> {
	const palette: Record<string, string> = { surface: theme.getBgHex("selectedBg") };
	for (const token in PALETTE) palette[token] = theme.getColorHex(PALETTE[token]!);
	return palette;
}

let figuresEnabled = true;

/** Turn lifting ```svg fences into images on or off (the host's `tui.renderSvg`); the host rebuilds the transcript after. */
export function setSvgFigureRendering(enabled: boolean): void {
	figuresEnabled = enabled;
}

/** Whether assistant ```svg fences render as images where the terminal can show them. */
export function svgFigureRendering(): boolean {
	return figuresEnabled;
}

export interface SvgFigureOptions {
	/**
	 * Markdown for the fenced-code fallback shown when the final source does not
	 * render. Without it the figure decorates content shown elsewhere (a chart
	 * under its table): it stays blank until drawn, and when it cannot be.
	 */
	markdown?: (text: string) => Markdown;
	/** Shared inline-image budget; superseded rasters are released from it. */
	budget?: ImageBudget;
	/** The figure's rows changed outside a text update: a raster landed or rendering fell back to code. */
	onChange: () => void;
}

/** Cells a figure may fill. */
interface Limits {
	columns: number;
	rows: number;
}

/** One rasterized revision and the inputs that produced it. */
interface Raster {
	source: string;
	/** Cell size the raster was padded to; its pixels are whole cells of it. */
	cell: CellDimensions;
	limits: Limits;
	themeEpoch: number;
	/** Base64 PNG. */
	data: string;
	widthPx: number;
	heightPx: number;
	/** Budget key; one per revision so a new raster is a new terminal image. */
	key: string;
}

/** Inputs of a raster attempt, successful or not. */
interface Attempt {
	source: string;
	cell: CellDimensions;
	limits: Limits;
	themeEpoch: number;
	final: boolean;
}

let nextFigureId = 0;

/** Cells a figure rendered at `width` may fill: the image's width, a share of the viewport, and the raster edge cap. */
function limitsFor(width: number, cell: CellDimensions): Limits {
	const viewportRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE);
	return {
		columns: Math.min(imageMaxColumns(width), Math.floor(MAX_EDGE_PX / cell.widthPx)),
		rows: Math.max(1, Math.min(viewportRows, Math.floor(MAX_EDGE_PX / cell.heightPx))),
	};
}

export class SvgFigure implements Component {
	readonly #options: SvgFigureOptions;
	readonly #id = nextFigureId++;
	#source = "";
	/** No more text arrives for this fence: no throttling, and a failed raster falls back to code. */
	#final = false;
	#revision = 0;
	#raster: Raster | undefined;
	#attempt: Attempt | undefined;
	/** Final source that could not be drawn; rendered as a fenced code block. */
	#failed: string | undefined;
	#rasterizing = false;
	#startedAt = Number.NEGATIVE_INFINITY;
	#timer: NodeJS.Timeout | undefined;
	/** A {@link #schedule} is queued for the end of the current task. */
	#queued = false;
	#disposed = false;
	/** Last render width; rasters wait for the first render to know their room. */
	#width: number | undefined;
	#image: { raster: Raster; component: Image } | undefined;
	#fallback: { source: string; md: Markdown } | undefined;
	#placeholder: readonly string[] | undefined;

	constructor(options: SvgFigureOptions) {
		this.#options = options;
	}

	/** Feed the fence body; `final` once the fence closed or the message stopped streaming. */
	update(source: string, final: boolean): void {
		if (source === this.#source && final === this.#final) return;
		this.#source = source;
		this.#final = final;
		// Deferred: a block built mid-stream is marked streaming right after it
		// is built, and must not first rasterize (and fail) its prefix as final.
		if (this.#queued) return;
		this.#queued = true;
		queueMicrotask(() => {
			this.#queued = false;
			this.#schedule();
		});
	}

	/** Whether the final source still waits for its raster (or for failing to render). */
	get pending(): boolean {
		return this.#final && this.#raster?.source !== this.#source && this.#failed !== this.#source;
	}

	render(width: number): readonly string[] {
		// Width, cell size and theme are render-time inputs; a change re-rasterizes.
		this.#width = width;
		this.#schedule();
		if (this.#failed === this.#source) return this.#fallbackRows(width);
		const raster = this.#raster;
		if (!raster) {
			if (!this.#options.markdown) return [];
			this.#placeholder ??= [` ${theme.fg("dim", "Drawing SVG…")}`];
			return this.#placeholder;
		}
		return this.#imageFor(raster).render(width);
	}

	invalidate(): void {
		this.#placeholder = undefined;
		this.#image?.component.invalidate();
		// Rebuilt through the Markdown factory, which may carry a new theme.
		this.#fallback = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	debugState(): Record<string, unknown> {
		return {
			final: this.#final,
			failed: this.#failed === this.#source,
			raster: this.#raster ? `${this.#raster.widthPx}x${this.#raster.heightPx}` : null,
			current: this.#raster?.source === this.#source,
		};
	}

	/** Whether the current source, cell size, theme or room at `width` has not been attempted yet. */
	#stale(width: number): boolean {
		const attempt = this.#attempt;
		if (this.#failed === this.#source) return false;
		const cell = getCellDimensions();
		const limits = limitsFor(width, cell);
		return (
			attempt === undefined ||
			attempt.source !== this.#source ||
			attempt.cell.widthPx !== cell.widthPx ||
			attempt.cell.heightPx !== cell.heightPx ||
			attempt.themeEpoch !== getThemeEpoch() ||
			// A streaming attempt that failed is retried once as final.
			(this.#final && !attempt.final && this.#raster?.source !== this.#source) ||
			((attempt.limits.columns !== limits.columns || attempt.limits.rows !== limits.rows) && this.#outgrown(limits))
		);
	}

	/**
	 * Whether the current raster would come out differently in `limits`. One
	 * below both of its limits drew at its natural size and redraws only once
	 * it no longer fits; one that filled a limit redraws whenever they change.
	 */
	#outgrown(limits: Limits): boolean {
		const raster = this.#raster;
		if (raster?.source !== this.#source) return false;
		const columns = raster.widthPx / raster.cell.widthPx;
		const rows = raster.heightPx / raster.cell.heightPx;
		if (columns < raster.limits.columns && rows < raster.limits.rows) {
			return columns > limits.columns || rows > limits.rows;
		}
		return raster.limits.columns !== limits.columns || raster.limits.rows !== limits.rows;
	}

	/** Start a raster when one is due: single-flight, throttled while streaming, immediate once final. */
	#schedule(): void {
		const width = this.#width;
		if (this.#disposed || this.#rasterizing || width === undefined) return;
		if (this.#final && this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#timer || !this.#stale(width)) return;
		const wait = this.#final ? 0 : this.#startedAt + STREAM_INTERVAL_MS - performance.now();
		if (wait > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#schedule();
			}, wait);
			this.#timer.unref?.();
			return;
		}
		void this.#rasterize(width);
	}

	async #rasterize(width: number): Promise<void> {
		const cell = getCellDimensions();
		const attempt: Attempt = {
			source: this.#source,
			cell,
			limits: limitsFor(width, cell),
			themeEpoch: getThemeEpoch(),
			final: this.#final,
		};
		this.#attempt = attempt;
		const svg = closePartialSvg(attempt.source);
		let png: Uint8Array | undefined;
		if (svg !== null) {
			this.#rasterizing = true;
			this.#startedAt = performance.now();
			try {
				const prepared = prepareSvg(svg, svgFigurePalette());
				png = await rasterizeSvg(
					new TextEncoder().encode(prepared),
					attempt.limits.columns * cell.widthPx,
					attempt.limits.rows * cell.heightPx,
					cell.heightPx / UNITS_PER_ROW,
					cell,
				);
			} catch (error) {
				// A streaming prefix that does not parse yet keeps the previous raster.
				if (attempt.final) logger.debug("SVG figure did not render", { error: String(error) });
			} finally {
				this.#rasterizing = false;
			}
		}
		if (this.#disposed) return;
		const data = png?.toBase64();
		const size = data ? getImageDimensions(data, "image/png") : null;
		if (data && size) {
			this.#show(attempt, data, size.widthPx, size.heightPx);
		} else if (attempt.final) {
			this.#failed = attempt.source;
			this.#options.onChange();
		}
		// The source, cell size, theme or room moved on while this raster ran.
		this.#schedule();
	}

	#show(attempt: Attempt, data: string, widthPx: number, heightPx: number): void {
		const previous = this.#raster;
		this.#raster = {
			source: attempt.source,
			cell: attempt.cell,
			limits: attempt.limits,
			themeEpoch: attempt.themeEpoch,
			data,
			widthPx,
			heightPx,
			key: `svg${this.#id}:${++this.#revision}`,
		};
		// A streaming revision is gone for good: free its terminal image now
		// rather than letting it crowd older images out of the store. A
		// re-raster of the same source (cell size, theme or room change) may still be
		// standing in scrollback, so the residency sweep keeps deciding for it.
		if (previous && previous.source !== attempt.source) this.#options.budget?.release(previous.key);
		this.#options.onChange();
	}

	/**
	 * The image for `raster` over the whole cells it was padded to. At the
	 * cell size and room it was drawn for that box is its pixels exactly; a
	 * raster outdated by a resize is scaled by {@link Image} until its redraw lands.
	 */
	#imageFor(raster: Raster): Image {
		const current = this.#image;
		if (current?.raster === raster) return current.component;
		const columns = raster.widthPx / raster.cell.widthPx;
		const rows = raster.heightPx / raster.cell.heightPx;
		const component = new Image(
			raster.data,
			"image/png",
			{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
			{
				maxWidthCells: columns,
				maxHeightCells: rows,
				filename: "svg",
				budget: this.#options.budget,
				imageKey: raster.key,
				requestRender: this.#options.onChange,
			},
			{ widthPx: raster.widthPx, heightPx: raster.heightPx },
		);
		this.#image = { raster, component };
		return component;
	}

	/** The source as the fenced code block it was written as, fenced longer than any backtick run inside. */
	#fallbackRows(width: number): readonly string[] {
		const source = this.#source;
		if (!this.#options.markdown) return [];
		if (this.#fallback?.source !== source) {
			const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map(run => run.length));
			const fence = "`".repeat(longest + 1);
			this.#fallback = { source, md: this.#options.markdown(`${fence}svg\n${source.trimEnd()}\n${fence}`) };
		}
		return this.#fallback.md.render(width);
	}
}
