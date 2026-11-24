/**
 * SVG figures: drawable prefixes of streaming sources, theme tokens, and
 * rasters for terminals.
 *
 * A figure is drawn in CSS px where a terminal row is {@link PX_PER_ROW} px
 * (`font-size="14"` text lands near the terminal's own glyphs), at the
 * terminal's device pixels per px, and padded with transparency to whole
 * cells so a terminal places it 1:1.
 */
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** CSS px per terminal row. */
export const PX_PER_ROW = 16;
/** Longest raster edge in device pixels (the rasterizer's surface cap). */
const MAX_EDGE_PX = 4096;

/** A terminal cell in device pixels. */
export interface FigureCell {
	readonly w: number;
	readonly h: number;
}

/** The cell the figure captures and most terminals use. */
export const DEFAULT_FIGURE_CELL: FigureCell = { w: 8, h: 16 };

/** A raster registered as a blob. */
export interface FigureRaster {
	readonly blob: string;
	readonly w: number;
	readonly h: number;
}

/**
 * Where the markup construct opening at `lt` ends (just past its `>`), or -1
 * while it is incomplete. Quoted attribute values and a doctype's internal
 * subset may hold `>`.
 */
function constructEnd(source: string, lt: number): number {
	for (const [open, close] of [
		["<!--", "-->"],
		["<![CDATA[", "]]>"],
		["<?", "?>"],
	] as const) {
		if (!source.startsWith(open, lt)) continue;
		const at = source.indexOf(close, lt + open.length);
		return at < 0 ? -1 : at + close.length;
	}
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at]!;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "[" && source[lt + 1] === "!") subset = true;
		else if (char === "]") subset = false;
		else if (char === ">" && !subset) return at + 1;
	}
	return -1;
}

/**
 * The drawable part of a (possibly partial) SVG source: everything through
 * its last complete markup construct, with the elements still open closed in
 * order. Null until the root `<svg …>` tag is complete.
 */
export function closePartialSvg(source: string): string | null {
	const start = source.search(/<svg[\s>/]/i);
	if (start < 0) return null;
	const open: string[] = [];
	let rooted = false;
	let end = start;
	while (end < source.length) {
		const lt = source.indexOf("<", end);
		if (lt < 0) {
			end = source.length;
			break;
		}
		const close = constructEnd(source, lt);
		if (close < 0) {
			end = lt;
			break;
		}
		const markup = source.slice(lt, close);
		const tag = /^<(\/)?([A-Za-z][\w:.-]*)/.exec(markup);
		if (tag) {
			if (tag[1]) {
				const index = open.lastIndexOf(tag[2]!);
				if (index >= 0) open.length = index;
			} else if (!/\/\s*>$/.test(markup)) open.push(tag[2]!);
			rooted = true;
		}
		end = close;
		// Whatever follows the closed root is not part of the drawing.
		if (rooted && open.length === 0) break;
	}
	if (!rooted) return null;
	let out = source.slice(start, end);
	for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`;
	return out;
}

const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)/g;
const ROOT_TAG = /<svg\b[^>]*>/i;

/** The theme colors figure tokens (`var(--name)`) stand for. */
export function figurePalette(theme: Theme): Record<string, string> {
	const hex = (key: string, fallback: string): string => {
		try {
			return theme.has(key) ? theme.hex(key) : fallback;
		} catch {
			return fallback;
		}
	};
	const fg = hex("text", theme.dark ? "#e5e5e7" : "#1a1a1a");
	const palette: Record<string, string> = {
		fg,
		muted: hex("muted", fg),
		border: hex("borderMuted", fg),
		accent: hex("accent", fg),
		success: hex("success", fg),
		warning: hex("warning", fg),
		error: hex("error", fg),
		surface: hex("selectedBg", theme.dark ? "#2a2a2e" : "#ececec"),
	};
	const series = ["accent", "borderAccent", "success", "warning", "error", "mdLink"];
	series.forEach((key, i) => {
		palette[`c${i + 1}`] = hex(key, fg);
	});
	return palette;
}

/**
 * An SVG ready to draw in a theme: `var(--token)` colors resolved from the
 * palette, and the root given the text color (`currentColor`), a sans-serif
 * default font and the namespaces it needs.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const resolved = svg.replace(VAR_REFERENCE, (_match, name: string, fallback: string | undefined) => {
		return palette[name] ?? (fallback?.trim() || fg);
	});
	const xlink = resolved.includes("xlink:");
	return resolved.replace(ROOT_TAG, tag => {
		let added = "";
		if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
		if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="sans-serif"`;
		if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
		if (xlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
		return added ? tag.replace(/^<svg/i, `<svg${added}`) : tag;
	});
}

/** The pixel size a PNG's header states. */
function pngSize(png: Uint8Array): { w: number; h: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { w: view.getUint32(16), h: view.getUint32(20) };
}

/**
 * Rasterize `svg` (prepared) at its natural size for `cell`, at most
 * `maxRows` rows tall, padded to whole cells; registered as a blob.
 * Rejects when the SVG does not draw.
 */
export async function rasterizeFigure(svg: string, cell: FigureCell, maxRows?: number): Promise<FigureRaster> {
	const maxHeight = maxRows === undefined ? MAX_EDGE_PX : Math.min(MAX_EDGE_PX, maxRows * cell.h);
	const png = await rasterizeSvg(new TextEncoder().encode(svg), MAX_EDGE_PX, maxHeight, cell.h / PX_PER_ROW, {
		widthPx: cell.w,
		heightPx: cell.h,
	});
	const size = pngSize(png);
	return { blob: registerBlob(png, "image/png"), ...size };
}

const pending = new Set<Promise<unknown>>();

/** Count `work` (a raster, a load) as figure work in flight until it settles. */
export function trackFigureWork<T>(work: Promise<T>): Promise<T> {
	pending.add(work);
	const done = (): void => {
		pending.delete(work);
	};
	work.then(done, done);
	return work;
}

/** Resolves once no figure work is in flight (work started meanwhile included). */
export async function figureWorkSettled(): Promise<void> {
	while (pending.size > 0) await Promise.allSettled(pending);
}

/** The fallback label of a figure raster (what a terminal without images shows). */
export function rasterLabel(name: string, raster: FigureRaster): string {
	return `[Image: ${name} [image/png] ${raster.w}x${raster.h}]`;
}
