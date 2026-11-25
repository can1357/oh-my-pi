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
import { computed, effect, For, type JSXNode, type Reactive, read, Show, untrack } from "@oh-my-pi/pi-tui";
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
	/** Lift SVG fences and HTML embeds independently; both default on for standalone figure Markdown. */
	readonly renderSvg?: boolean;
	readonly renderEmbeds?: boolean;
	readonly host?: EmbedHost;
}

const SVG_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*svg[ \t]*(?=[\r\n]|$)/m;
const EMBED_LINE = /^ {0,3}<(?:img|iframe)\b/im;

/** Cheap check before lexing a reply; false positives stay Markdown. */
export function mightHaveFigures(text: string, svg: boolean, embeds: boolean): boolean {
	return (svg && SVG_FENCE.test(text)) || (embeds && EMBED_LINE.test(text));
}

function closedFence(raw: string): boolean {
	const opener = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
	const closer = /\n {0,3}(`{3,}|~{3,})[ \t]*\n?$/.exec(raw)?.[1];
	return !!opener && !!closer && closer[0] === opener[0] && closer.length >= opener.length;
}

/** `text` split into its runs. */
export function figureSegments(
	text: string,
	options: Pick<FigureMarkdownOptions, "charts" | "showImages" | "renderSvg" | "renderEmbeds">,
): Segment[] {
	const segments: Segment[] = [];
	let prose = "";
	const flush = (): void => {
		const trimmed = prose.replace(/^\n+/, "").trimEnd();
		if (trimmed) segments.push({ kind: "md", text: trimmed });
		prose = "";
	};
	const addEmbed = (html: string): boolean => {
		if (!EMBED_LINE.test(html) || !parseEmbed(html)) return false;
		flush();
		segments.push({ kind: "embed", html: html.trim() });
		return true;
	};
	const tokens = lexMarkdown(text);
	// Reference links can use definitions on either side of a figure.
	const definitions = tokens
		.filter(token => token.type === "def")
		.map(token => token.raw.trimEnd())
		.join("\n");
	for (const token of tokens) {
		if (
			options.showImages &&
			options.renderSvg !== false &&
			token.type === "code" &&
			token.lang?.trim() === "svg" &&
			closedFence(token.raw)
		) {
			flush();
			segments.push({ kind: "svg", source: token.text });
			continue;
		}
		if (options.renderEmbeds !== false) {
			if (token.type === "html" && addEmbed(token.raw)) continue;
			if (token.type === "paragraph" && token.tokens && EMBED_LINE.test(token.raw)) {
				// Lift only a standalone HTML tag, not an example inside an inline code span.
				let start = 0;
				let at = 0;
				for (const inline of token.tokens) {
					const end = at + inline.raw.length;
					if (
						inline.type === "html" &&
						/^ {0,3}$/.test(token.raw.slice(token.raw.lastIndexOf("\n", at - 1) + 1, at)) &&
						/^[ \t]*(?:\n|$)/.test(token.raw.slice(end)) &&
						EMBED_LINE.test(inline.raw) &&
						parseEmbed(inline.raw)
					) {
						prose += token.raw.slice(start, at);
						addEmbed(inline.raw);
						start = end;
					}
					at = end;
				}
				prose += token.raw.slice(start);
				continue;
			}
		}
		prose += token.raw;
		if (options.charts && options.showImages && token.type === "table" && tableChartSvg(token.raw) !== undefined) {
			flush();
			segments.push({ kind: "chart", table: token.raw.trimEnd() });
		}
	}
	flush();
	if (definitions && segments.some(segment => segment.kind !== "md")) {
		return segments.map(segment =>
			segment.kind === "md" ? { kind: "md", text: `${definitions}\n\n${segment.text}` } : segment,
		);
	}
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
export function SvgFence(
	props: { readonly source: Reactive<string>; readonly nodeKey?: string } & FigureOptions,
): JSXNode {
	const raster = new SvgRaster(props);
	const code = computed(() => fenced("svg", read(props.source)));
	effect(() => {
		const source = read(props.source);
		untrack(() => raster.update(source, true));
	});
	return () => {
		const state = raster.state();
		if (state.status !== "ready") return <md key={props.nodeKey} role="omp.figure.code" text={code} />;
		const term: FigureTerm = { code: code() };
		return untrack(() => (
			<RasterImage raster={state.raster} role="omp.figure.svg" nodeKey={props.nodeKey} term={term} />
		));
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
				return <SvgFence source={body} cell={props.cell} maxRows={props.maxRows} theme={props.theme} />;
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
