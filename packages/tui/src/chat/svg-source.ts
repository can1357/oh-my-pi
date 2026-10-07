/**
 * Source-level handling of ```svg fences in assistant Markdown: splitting
 * prose around them ({@link splitSvgFences}), turning a fence that is still
 * streaming into a document an SVG parser accepts ({@link closePartialSvg}),
 * and resolving the theme tokens figures color themselves with
 * ({@link prepareSvg}). `FigureMarkdown` lifts the fences out as `SvgFigure`
 * images.
 */

/** One run of an assistant text block: prose, or the body of a ```svg fence. */
export type FigureSegment =
	| { readonly kind: "markdown"; readonly text: string }
	/** `closed` once the fence's closing line arrived. */
	| { readonly kind: "svg"; readonly source: string; readonly closed: boolean };

/** A top-level (≤3-space indent) ```svg / ~~~svg fence opener, info string compared ASCII-case-insensitively. */
const SVG_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*svg(?:[ \t]|$)/im;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Whether `markdown` holds a ```svg fence {@link splitSvgFences} would lift. */
export function hasSvgFence(markdown: string): boolean {
	return markdown.includes("svg") && SVG_FENCE.test(markdown);
}

/**
 * Split `markdown` into prose and ```svg fence bodies, in order. Only
 * top-level fences lift; an svg fence nested in another fence, a list's
 * indented block or a blockquote stays prose. Blank prose runs are dropped.
 * An svg fence still open at the end is the last segment, `closed: false`.
 */
export function splitSvgFences(markdown: string): FigureSegment[] {
	const segments: FigureSegment[] = [];
	/** Open fence: its marker run, and where an svg fence's body starts (-1 for other fences). */
	let fence: { marker: string; body: number } | undefined;
	let proseStart = 0;
	let lineStart = 0;
	while (lineStart <= markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const next = newline < 0 ? markdown.length + 1 : newline + 1;
		const line = markdown.slice(lineStart, lineEnd);
		if (fence) {
			if (closesFence(line, fence.marker)) {
				if (fence.body >= 0) {
					segments.push({ kind: "svg", source: markdown.slice(fence.body, lineStart), closed: true });
					proseStart = Math.min(next, markdown.length);
				}
				fence = undefined;
			}
		} else {
			const open = FENCE_OPEN.exec(line);
			// A backtick fence's info string cannot hold backticks (CommonMark).
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				const isSvg = open[2]!.trim().split(/[ \t]/, 1)[0]!.toLowerCase() === "svg";
				if (isSvg) {
					const prose = markdown.slice(proseStart, lineStart);
					if (prose.trim()) segments.push({ kind: "markdown", text: prose });
					fence = { marker: open[1]!, body: Math.min(next, markdown.length) };
				} else {
					fence = { marker: open[1]!, body: -1 };
				}
			}
		}
		lineStart = next;
	}
	if (fence && fence.body >= 0) {
		segments.push({ kind: "svg", source: markdown.slice(fence.body), closed: false });
	} else if (markdown.slice(proseStart).trim()) {
		segments.push({ kind: "markdown", text: markdown.slice(proseStart) });
	}
	return segments;
}

/** Whether `line` closes a fence opened by `marker`: same character, at least as long, nothing after. */
function closesFence(line: string, marker: string): boolean {
	let index = 0;
	while (index < 3 && line[index] === " ") index++;
	let run = 0;
	while (line[index + run] === marker[0]) run++;
	return run >= marker.length && line.slice(index + run).trim() === "";
}

/**
 * Turn a possibly truncated SVG source into a well-formed document: cut the
 * trailing construct still being written (a tag without its `>`, an
 * unterminated comment, CDATA section, processing instruction or declaration,
 * a dangling `&entity`) and close every element left open, innermost first.
 * A complete document passes through unchanged. Returns null until the root
 * `<svg …>` start tag is complete — before that there is nothing to draw.
 */
export function closePartialSvg(source: string): string | null {
	const open: string[] = [];
	let rootSeen = false;
	let end = 0;
	let index = 0;
	for (;;) {
		const lt = source.indexOf("<", index);
		if (lt < 0) {
			// Trailing text: an entity reference still being written would not parse.
			const amp = source.lastIndexOf("&");
			end = amp >= index && !source.includes(";", amp) ? amp : source.length;
			break;
		}
		end = lt;
		const close = constructEnd(source, lt);
		if (close < 0) break;
		if (source.startsWith("</", lt)) {
			const name = source.slice(lt + 2, close - 1).trim();
			const at = open.lastIndexOf(name);
			if (at >= 0) open.length = at;
		} else if (source[lt + 1] !== "!" && source[lt + 1] !== "?") {
			const name = /^<([^\s/>]+)/.exec(source.slice(lt, close))?.[1];
			if (name !== undefined) {
				if (source[close - 2] !== "/") open.push(name);
				if (!rootSeen && (name === "svg" || name.endsWith(":svg"))) rootSeen = true;
			}
		}
		index = close;
		end = close;
	}
	if (!rootSeen) return null;
	let document = source.slice(0, end);
	for (let at = open.length - 1; at >= 0; at--) document += `</${open[at]}>`;
	return document;
}

/** `var(--name)` / `var(--name, fallback)`; the fallback may hold one level of parentheses (`rgb(…)`). */
const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
/** The first `<svg …>` start tag (namespace prefix allowed). */
const ROOT_TAG = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

/**
 * Make a figure's source what an SVG rasterizer draws as written, in the
 * reader's theme. Rasterizers resolve neither CSS custom properties nor an
 * inherited text color, and reject a root without the SVG namespace, so:
 * - `var(--name)` / `var(--name, fallback)` become `palette[name]` (an
 *   unknown name takes its fallback, else `palette.fg`);
 * - a root `<svg>` lacking them gets `color` = `palette.fg` (so
 *   `currentColor` follows the theme), a sans-serif `font-family` (instead
 *   of the rasterizer's Times), `xmlns`, and `xmlns:xlink` when the source
 *   uses `xlink:` attributes.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const resolved = svg.replace(
		VAR_REFERENCE,
		(_match, name: string, fallback: string | undefined) => palette[name] ?? (fallback?.trim() || fg),
	);
	const usesXlink = resolved.includes("xlink:");
	return resolved.replace(ROOT_TAG, tag => {
		let added = "";
		if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
		if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="sans-serif"`;
		if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
		if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
		return added ? tag.replace(/^<[^\s/>]+/, `$&${added}`) : tag;
	});
}

/** Index just past the markup construct starting at `<` (`lt`), or -1 when it is not complete yet. */
function constructEnd(source: string, lt: number): number {
	const after = (terminator: string, from: number): number => {
		const at = source.indexOf(terminator, from);
		return at < 0 ? -1 : at + terminator.length;
	};
	if (source.startsWith("<!--", lt)) return after("-->", lt + 4);
	if (source.startsWith("<![CDATA[", lt)) return after("]]>", lt + 9);
	if (source.startsWith("<?", lt)) return after("?>", lt + 2);
	// Tags and declarations end at the first `>` outside a quoted value; a
	// doctype's internal subset (`[…]`) may hold `>` of its own.
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[" && source[lt + 1] === "!") {
			subset = true;
		} else if (char === "]") {
			subset = false;
		} else if (char === ">" && !subset) {
			return at + 1;
		}
	}
	return -1;
}
