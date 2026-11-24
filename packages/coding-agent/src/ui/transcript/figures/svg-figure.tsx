/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * SVG figures and fenced figures.
 *
 * {@link SvgRaster} turns a (streaming) SVG source into a raster `image`:
 * each update draws the source's drawable prefix, a failed partial draw keeps
 * the last raster, and a final source that does not draw fails. Rasters
 * follow the cell size, the room (`maxRows`) and the theme. A final source
 * holds its transcript block's settling ({@link holdSettle}) until its
 * raster lands or fails, so scrollback gets the figure, not its stand-in.
 *
 * Terminal looks: `src/ui/styles/figures/figure.ts`.
 */
import {
	type Accessor,
	effect,
	type JSXNode,
	type Reactive,
	read,
	type Signal,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { holdSettle } from "../../shell/transcript";
import {
	closePartialSvg,
	DEFAULT_FIGURE_CELL,
	type FigureCell,
	type FigureRaster,
	figurePalette,
	prepareSvg,
	rasterizeFigure,
	rasterLabel,
	trackFigureWork,
} from "./svg";

/** Where a figure's raster stands. */
export type RasterState =
	| { readonly status: "pending" }
	| { readonly status: "ready"; readonly raster: FigureRaster }
	| { readonly status: "failed" };

/** What a figure's rasters depend on. */
export interface FigureOptions {
	/** The terminal's cell in device pixels (default 8×16). */
	readonly cell?: Reactive<FigureCell>;
	/** Rows a figure may take (the viewport's share); undefined: as tall as it draws. */
	readonly maxRows?: Reactive<number | undefined>;
	/** The theme figure tokens resolve in (default the active one). */
	readonly theme?: Accessor<Theme>;
}

/** Rasters of one SVG source as it streams in. Create inside a component (it follows its options reactively). */
export class SvgRaster {
	readonly #options: FigureOptions;
	readonly #state: Signal<RasterState> = signal<RasterState>({ status: "pending" });
	readonly #source: Signal<string> = signal("");
	/** The final source waits for its raster (or for failing to draw). */
	readonly #awaiting: Signal<boolean> = signal(false);
	#final = false;
	#generation = 0;

	constructor(options: FigureOptions = {}) {
		this.#options = options;
		holdSettle(this.#awaiting);
		effect(() => {
			read(options.cell);
			read(options.maxRows);
			options.theme?.();
			untrack(() => this.#draw());
		});
	}

	/** The raster state. */
	get state(): Accessor<RasterState> {
		return this.#state;
	}

	/** The latest source. */
	get source(): Accessor<string> {
		return this.#source;
	}

	/** Draw `source` (`final`: the source is complete; a failure then is final). */
	update(source: string, final: boolean): void {
		if (source === this.#source.peek() && final === this.#final) return;
		this.#source.set(source);
		this.#final = final;
		this.#awaiting.set(final);
		this.#draw();
	}

	#draw(): void {
		const generation = ++this.#generation;
		const final = this.#final;
		const svg = closePartialSvg(this.#source.peek());
		if (svg === null) {
			if (final) this.#fail();
			return;
		}
		const theme = this.#options.theme?.() ?? currentTheme();
		const cell = read(this.#options.cell) ?? DEFAULT_FIGURE_CELL;
		const maxRows = read(this.#options.maxRows);
		void trackFigureWork(
			(async () => {
				try {
					if (maxRows !== undefined && maxRows < 1) throw new Error("no room for the figure");
					const raster = await rasterizeFigure(prepareSvg(svg, figurePalette(theme)), cell, maxRows);
					if (generation !== this.#generation) return;
					this.#state.set({ status: "ready", raster });
					this.#awaiting.set(false);
				} catch {
					// A streaming prefix that does not draw yet keeps the previous raster.
					if (generation === this.#generation && final) this.#fail();
				}
			})(),
		);
	}

	#fail(): void {
		this.#state.set({ status: "failed" });
		this.#awaiting.set(false);
	}
}

/** Terminal facts of a figure raster. */
export type FigureTerm = {
	/** The figure's Markdown source, drawn where the raster cannot be (figures inside Markdown). */
	readonly code?: string;
};

/** The raster of a ready figure as an `image` node. */
export function RasterImage(props: {
	readonly raster: FigureRaster;
	readonly role: string;
	readonly name?: string;
	readonly term?: Readonly<Record<string, unknown>>;
}): JSXNode {
	const raster = props.raster;
	return (
		<image
			role={props.role}
			blob={raster.blob}
			w={raster.w}
			h={raster.h}
			alt={rasterLabel(props.name ?? "svg", raster)}
			term={props.term}
		/>
	);
}

/** A fenced block's Markdown. */
export function fenced(lang: string, source: string): string {
	return `\`\`\`${lang}\n${source}\n\`\`\``;
}

/**
 * An SVG figure: the raster once drawn. Before that, `Drawing SVG…` when a
 * code fallback exists (else nothing); a source that never draws shows as
 * its fenced code with a code fallback (else nothing).
 */
export function SvgFigure(props: { readonly raster: SvgRaster; readonly codeFallback?: boolean }): JSXNode {
	const raster = props.raster;
	return () => {
		const state = raster.state();
		if (state.status === "ready") return untrack(() => <RasterImage raster={state.raster} role="omp.figure" />);
		if (!props.codeFallback) return undefined;
		if (state.status === "failed") return <md role="omp.figure.code" text={() => fenced("svg", raster.source())} />;
		return <text role="omp.figure.pending" spans={[{ t: "Drawing SVG…", s: "dim" }]} />;
	};
}

/**
 * A fenced block shown as a figure: `svg` as its raster (nothing until it
 * draws), any other language (`mermaid` diagrams) as the fence's Markdown,
 * closed while it streams.
 */
export function FenceFigure(
	props: {
		readonly lang: string;
		readonly source: Reactive<string>;
		readonly closed: Reactive<boolean>;
	} & FigureOptions,
): JSXNode {
	if (props.lang !== "svg") return <md role="omp.figure.code" text={() => fenced(props.lang, read(props.source))} />;
	const raster = new SvgRaster(props);
	effect(() => {
		const source = read(props.source);
		const closed = read(props.closed);
		untrack(() => raster.update(source, closed));
	});
	return <SvgFigure raster={raster} />;
}
