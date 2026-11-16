/**
 * Source-level handling of the HTML embeds an assistant reply may hold: an
 * `<img src>` picture or an `<iframe src>` page, on a line of their own.
 * {@link splitEmbeds} splits prose around those lines; `FigureMarkdown` lifts
 * them out as `EmbedFigure`s.
 *
 * @example
 * splitEmbeds('Before\n<img src="shot.png" alt="Shot" width="50%">\nAfter');
 * // [markdown "Before\n", embed { kind: "img", src: "shot.png", label: "Shot", … }, markdown "After"]
 */
import { decodeEntities } from "@oh-my-pi/pi-utils/dom/parser";
import { type FigureSize, parseFigureLength } from "./figure-size";
import { closesFence, fenceMarker } from "./svg-source";

/** One `<img>` or `<iframe>` tag of a reply. */
export interface Embed {
	readonly kind: "img" | "iframe";
	/** Where the picture or page loads from, as written. */
	readonly src: string;
	/** What it shows: the tag's `alt`, else its `title`; empty when it has neither. */
	readonly label: string;
	/** The tag's `width` and `height`. */
	readonly size: FigureSize;
}

/** One run of an assistant text block: prose, or an embed tag. */
export type EmbedSegment =
	| { readonly kind: "markdown"; readonly text: string }
	| { readonly kind: "embed"; readonly embed: Embed };

export interface SplitEmbedOptions {
	/** The text may still grow: its last line stays prose until its line break arrives. */
	streaming?: boolean;
	/** Lift only lines of `<iframe>` tags, for a terminal that draws `<img>` itself. */
	iframesOnly?: boolean;
}

/** A top-level (≤3-space indent) line opening with an embed tag. */
const EMBED_LINE = /^ {0,3}<(?:img|iframe)\b/im;
const IFRAME_LINE = /^ {0,3}<iframe\b/im;
/** One embed tag, with its closing tag when written; a quoted attribute value may hold `>`. */
const EMBED_TAG = /<(img|iframe)\b((?:"[^"]*"|'[^']*'|[^'">])*)>(?:\s*<\/\1\s*>)?/giy;
/** `name`, `name=value` or a quoted value; an unquoted one runs to the next space and may hold `=`, as browsers read it. */
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

/** Whether `markdown` may hold a line {@link splitEmbeds} would lift. */
export function hasEmbed(markdown: string, options: Pick<SplitEmbedOptions, "iframesOnly"> = {}): boolean {
	return (options.iframesOnly ? IFRAME_LINE : EMBED_LINE).test(markdown);
}

/** Whether `a` and `b` load and draw the same thing. */
export function sameEmbed(a: Embed, b: Embed): boolean {
	return (
		a.kind === b.kind &&
		a.src === b.src &&
		a.label === b.label &&
		a.size.width?.value === b.size.width?.value &&
		a.size.width?.unit === b.size.width?.unit &&
		a.size.height?.value === b.size.height?.value &&
		a.size.height?.unit === b.size.height?.unit
	);
}

/**
 * Split `markdown` into prose and embeds, in order. A line lifts when it is
 * top-level (≤3-space indent, outside code fences) and holds nothing but
 * `<img>`/`<iframe>` tags that each have a `src`; several tags on one line
 * become one embed each. Blank prose runs are dropped.
 */
export function splitEmbeds(markdown: string, options: SplitEmbedOptions = {}): EmbedSegment[] {
	const segments: EmbedSegment[] = [];
	let fence: string | undefined;
	let proseStart = 0;
	let lineStart = 0;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const next = newline < 0 ? markdown.length : newline + 1;
		const line = markdown.slice(lineStart, newline < 0 ? markdown.length : newline).replace(/\r$/, "");
		if (fence !== undefined) {
			if (closesFence(line, fence)) fence = undefined;
		} else {
			fence = fenceMarker(line);
			const embeds = fence === undefined && !(options.streaming && newline < 0) ? embedsOn(line) : undefined;
			if (embeds && (!options.iframesOnly || embeds.every(embed => embed.kind === "iframe"))) {
				const prose = markdown.slice(proseStart, lineStart);
				if (prose.trim()) segments.push({ kind: "markdown", text: prose });
				for (const embed of embeds) segments.push({ kind: "embed", embed });
				proseStart = next;
			}
		}
		lineStart = next;
	}
	const rest = markdown.slice(proseStart);
	if (rest.trim()) segments.push({ kind: "markdown", text: rest });
	return segments;
}

/** The embeds `line` consists of, or undefined when it holds anything else or a tag without a `src`. */
function embedsOn(line: string): Embed[] | undefined {
	if (!EMBED_LINE.test(line)) return undefined;
	const embeds: Embed[] = [];
	let at = line.search(/\S/);
	while (at < line.length) {
		EMBED_TAG.lastIndex = at;
		const match = EMBED_TAG.exec(line);
		const embed = match && readEmbed(match[1]!, match[2]!);
		if (!embed) return undefined;
		embeds.push(embed);
		at = EMBED_TAG.lastIndex;
		while (line[at] === " " || line[at] === "\t") at++;
	}
	return embeds;
}

function readEmbed(tag: string, attributes: string): Embed | undefined {
	const values = new Map<string, string>();
	for (const match of attributes.replace(/\/\s*$/, "").matchAll(ATTRIBUTE)) {
		const name = match[1]!.toLowerCase();
		// The first of a repeated attribute wins, as in a browser.
		if (!values.has(name)) values.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
	}
	const src = values.get("src")?.trim();
	if (!src) return undefined;
	return {
		kind: tag.toLowerCase() === "img" ? "img" : "iframe",
		src,
		label: (values.get("alt") || values.get("title") || "").trim(),
		size: {
			width: parseFigureLength(values.get("width") ?? ""),
			height: parseFigureLength(values.get("height") ?? ""),
		},
	};
}
