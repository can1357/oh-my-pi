/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A reply's Markdown with its figures: ```` ```svg ```` fences drawn as
 * rasters, chartable tables followed by their chart, and HTML `<img>` /
 * `<iframe>` blocks as embeds; the prose between them stays Markdown.
 *
 * While the reply streams it is one streaming `md` node (figures appear once
 * it settles). With images off, SVG fences and tables stay code and tables;
 * embeds still show as notes. Where a terminal cannot draw a figure, an SVG
 * fence shows its code and a chart nothing (see the terminal look).
 *
 * Terminal look: `src/ui/styles/figures/figure.ts` (`omp.figures`).
 */
import { computed, For, type JSXNode, type Reactive, read, Show, untrack } from "@oh-my-pi/pi-tui";
import { lexMarkdown } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { type EmbedHost, EmbedFigure, parseEmbed } from "./embed";
import { fenced, type FigureOptions, RasterImage, SvgRaster } from "./svg-figure";
import type { FigureTerm } from "./svg-figure";
import { TableChart, tableChartSvg } from "./table-chart";

/** One run of a reply: prose, an SVG fence, a table's chart, or an embed. */
type Segment =
	| { readonly kind: "md"; readonly text: string }
	| { readonly kind: "svg"; readonly source: string }
	| { readonly kind: "chart"; readonly table: string }
	| { readonly kind: "embed"; readonly html: string };

export interface FigureMarkdownOptions extends FigureOptions {
	/** Chart tables. */
	readonly charts: boolean;
	/** Draw figures and load embeds (the images setting). */
	readonly showImages: boolean;
	readonly host?: EmbedHost;
}

/** `text` split into its runs. */
export function figureSegments(text: string, options: Pick<FigureMarkdownOptions, "charts" | "showImages">): Segment[] {
	const segments: Segment[] = [];
	let prose = "";
	const flush = (): void => {
		const trimmed = prose.replace(/^\n+/, "").trimEnd();
		if (trimmed) segments.push({ kind: "md", text: trimmed });
		prose = "";
	};
	for (const token of lexMarkdown(text)) {
		if (
			options.showImages &&
			token.type === "code" &&
			token.lang?.trim() === "svg" &&
			/\n\s*(`{3,}|~{3,})\s*$/.test(token.raw.trimEnd())
		) {
			flush();
			segments.push({ kind: "svg", source: token.text });
			continue;
		}
		if ((token.type === "html" || token.type === "paragraph") && parseEmbed(token.raw)) {
			flush();
			segments.push({ kind: "embed", html: token.raw.trim() });
			continue;
		}
		prose += token.raw;
		if (options.charts && options.showImages && token.type === "table" && tableChartSvg(token.raw) !== undefined) {
			flush();
			segments.push({ kind: "chart", table: token.raw.trimEnd() });
		}
	}
	flush();
	return segments;
}

/** A segment as an identity key (equal runs keep their node, and its raster, across edits). */
function keyOf(segment: Segment): string {
	switch (segment.kind) {
		case "md":
			return `md\0${segment.text}`;
		case "svg":
			return `svg\0${segment.source}`;
		case "chart":
			return `chart\0${segment.table}`;
		case "embed":
			return `embed\0${segment.html}`;
	}
}

/** An SVG fence of a reply: its raster once drawn, its code until then (and wherever it cannot be drawn). */
function SvgSegment(props: { readonly source: string } & FigureOptions): JSXNode {
	const raster = new SvgRaster(props);
	const code = fenced("svg", props.source);
	untrack(() => raster.update(props.source, true));
	const term: FigureTerm = { code };
	return () => {
		const state = raster.state();
		if (state.status !== "ready") return <md role="omp.figure.code" text={code} />;
		return untrack(() => <RasterImage raster={state.raster} role="omp.figure.svg" term={term} />);
	};
}

/** See the module docs. */
export function FigureMarkdown(
	props: { readonly text: Reactive<string>; readonly streaming?: Reactive<boolean> } & FigureMarkdownOptions,
): JSXNode {
	const streaming = (): boolean => read(props.streaming) === true;
	const keys = computed(() => (streaming() ? [] : figureSegments(read(props.text), props).map(keyOf)));
	const segment = (key: string): JSXNode => {
		const at = key.indexOf("\0");
		const kind = key.slice(0, at);
		const body = key.slice(at + 1);
		switch (kind) {
			case "md":
				return <md text={body} />;
			case "svg":
				return <SvgSegment source={body} cell={props.cell} maxRows={props.maxRows} theme={props.theme} />;
			case "chart":
				return <TableChart markdown={body} inline cell={props.cell} maxRows={props.maxRows} theme={props.theme} />;
			default:
				return (
					<EmbedFigure
						embed={parseEmbed(body)}
						showImages={props.showImages}
						host={props.host}
						cell={props.cell}
						maxRows={props.maxRows}
						theme={props.theme}
					/>
				);
		}
	};
	return (
		<col role="omp.figures">
			<Show when={streaming} fallback={<For each={keys}>{key => segment(key)}</For>}>
				<md stream text={() => read(props.text)} />
			</Show>
		</col>
	);
}
