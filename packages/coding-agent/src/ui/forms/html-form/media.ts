/**
 * Pictures of a form: an inline `<svg>` is ready at once (its markup, sized
 * from its viewBox) and rasterized in the background for terminals; an
 * `<img>` loads from its source (an http(s) or `data:`
 * URL, a `file:` URL, or a path relative to the working directory).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { signal } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { HtmlForm } from "../../../tools/html-form/parse";
import {
	DEFAULT_FIGURE_CELL,
	type FigureCell,
	type FigureRaster,
	figurePalette,
	prepareSvg,
	rasterizeFigure,
	trackFigureWork,
} from "../../transcript/figures/svg";

/** What became of one picture. */
export type MediaState =
	| { readonly kind: "loading" }
	| {
			readonly kind: "ready";
			readonly blob: string;
			readonly mime: string;
			/** An svg's terminal raster: absent while drawing, null when it does not draw. */
			readonly raster?: FigureRaster | null;
	  }
	| { readonly kind: "failed"; readonly message: string };

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** An inline svg as a standalone document: a namespace, and a size from its viewBox when it has none. */
function standaloneSvg(markup: string): string {
	const open = /<svg\b[^>]*>/i.exec(markup)?.[0];
	if (!open) return markup;
	const added: string[] = [];
	if (!/\bxmlns\s*=/i.test(open)) added.push(`xmlns="${SVG_NAMESPACE}"`);
	const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open);
	if (box && !/\swidth\s*=/i.test(open) && !/\sheight\s*=/i.test(open))
		added.push(`width="${box[1]}"`, `height="${box[2]}"`);
	return added.length > 0 ? markup.replace(/<svg\b/i, `<svg ${added.join(" ")}`) : markup;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

async function loadImage(src: string, cwd: string): Promise<{ bytes: Uint8Array; mime: string }> {
	if (/^https?:/i.test(src) || src.startsWith("data:")) {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			mime: response.headers.get("content-type") ?? "image/png",
		};
	}
	const file = src.startsWith("file:") ? new URL(src).pathname : path.resolve(cwd, src);
	const bytes = new Uint8Array(await fs.readFile(file));
	return { bytes, mime: MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "image/png" };
}

/** How svg rasters are drawn for the terminal. */
export interface FormMediaOptions {
	/** The terminal cell in device pixels (the default figure cell when unknown). */
	readonly cell?: FigureCell;
	/** Most rows a picture may take. */
	readonly maxRows?: number;
}

/** The pictures of `form` by content key (`c<section>.<block>`), loading in the background. */
export function formMedia(form: HtmlForm, cwd: string, options: FormMediaOptions = {}) {
	const states = signal<ReadonlyMap<string, MediaState>>(new Map());
	const set = (key: string, state: MediaState): void => {
		const next = new Map(states.peek());
		next.set(key, state);
		states.set(next);
	};
	form.sections.forEach((section, s) => {
		section.blocks.forEach((block, b) => {
			const key = `c${s}.${b}`;
			if (block.kind === "svg") {
				const svg = standaloneSvg(block.markup);
				const ready = {
					kind: "ready",
					blob: registerBlob(new TextEncoder().encode(svg), "image/svg+xml"),
					mime: "image/svg+xml",
				} as const;
				set(key, ready);
				void trackFigureWork(
					rasterizeFigure(
						prepareSvg(svg, figurePalette(currentTheme())),
						options.cell ?? DEFAULT_FIGURE_CELL,
						options.maxRows,
					).then(
						raster => set(key, { ...ready, raster }),
						() => set(key, { ...ready, raster: null }),
					),
				);
			} else if (block.kind === "image") {
				set(key, { kind: "loading" });
				loadImage(block.src, cwd).then(
					({ bytes, mime }) => set(key, { kind: "ready", blob: registerBlob(bytes, mime), mime }),
					(error: unknown) =>
						set(key, { kind: "failed", message: error instanceof Error ? error.message : String(error) }),
				);
			}
		});
	});
	return states;
}
