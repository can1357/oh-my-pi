/**
 * A tool call's {@link ToolFigure} drawn under its card, the way assistant
 * Markdown draws that fence: ```svg as an inline image ({@link SvgFigure}),
 * redrawn as the body streams; ```mermaid as ASCII art once the body is
 * final. The card already shows the source, so unlike the assistant's fence
 * it never falls back to code: {@link FenceFigure.draws} turns down fences
 * this terminal shows as code, and an svg that does not rasterize stays blank.
 */
import type { ImageBudget } from "../components/image";
import { fencedCode, Markdown } from "../components/markdown";
import { TERMINAL } from "../terminal-capabilities";
import { getMarkdownTheme } from "../theme";
import type { ToolFigure } from "../tools/renderer";
import type { Component } from "../tui";
import { SvgFigure, svgFigureRendering } from "./svg-figure";

/** Fence languages a {@link FenceFigure} draws. */
export type FenceFigureLang = "svg" | "mermaid";

export interface FenceFigureOptions {
	/** Shared inline-image budget for an svg's rasters. */
	budget?: ImageBudget;
	/** The figure's rows changed outside a render: a raster landed. */
	onChange: () => void;
}

export class FenceFigure implements Component {
	/**
	 * Whether this terminal draws `figure` now: an svg where inline images show
	 * (`showImages` and a graphics protocol), a closed mermaid fence when
	 * diagram rendering is on and the source renders.
	 */
	static draws(
		figure: ToolFigure,
		options: { showImages: boolean },
	): figure is ToolFigure & { readonly lang: FenceFigureLang } {
		if (figure.lang === "svg") return options.showImages && TERMINAL.imageProtocol !== null && svgFigureRendering();
		if (figure.lang !== "mermaid" || !figure.closed) return false;
		return getMarkdownTheme().resolveMermaidAscii?.(figure.source.trimEnd()) != null;
	}

	readonly lang: FenceFigureLang;
	readonly #svg: SvgFigure | undefined;
	#source = "";
	/** The mermaid fence as assistant Markdown renders it; rebuilt after a theme change. */
	#diagram: Markdown | undefined;

	constructor(lang: FenceFigureLang, options: FenceFigureOptions) {
		this.lang = lang;
		if (lang === "svg") this.#svg = new SvgFigure({ budget: options.budget, onChange: options.onChange });
	}

	/** Feed the fence as it stands; its `lang` is this figure's. */
	update(figure: ToolFigure): void {
		if (figure.source !== this.#source) this.#diagram = undefined;
		this.#source = figure.source;
		this.#svg?.update(figure.source, figure.closed);
	}

	/** Whether a closed svg's raster is still on its way. */
	get pending(): boolean {
		return this.#svg?.pending === true;
	}

	/** The drawing; no rows while an svg draws, or when it does not. */
	render(width: number): readonly string[] {
		if (this.#svg) return this.#svg.render(width);
		this.#diagram ??= new Markdown(fencedCode("mermaid", this.#source), 1, 0, getMarkdownTheme());
		return this.#diagram.render(width);
	}

	invalidate(): void {
		this.#svg?.invalidate();
		this.#diagram = undefined;
	}

	dispose(): void {
		this.#svg?.dispose();
	}
}
