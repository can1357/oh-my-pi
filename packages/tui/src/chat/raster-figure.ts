/**
 * A local image file drawn inline, for an assistant line that is nothing but
 * a Markdown image (`![alt](/path/shot.png)`). The file is read once per
 * path, its format sniffed from the header, and the picture drawn through
 * {@link Image} within the shared inline-image budget. A file that cannot be
 * read, or is not a format the terminal draws, falls back to the line as
 * written so the reader still has the path.
 */
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Image, type ImageBudget, imageMaxColumns } from "../components/image";
import type { Markdown } from "../components/markdown";
import { fencedCode } from "../components/markdown";
import { getImageDimensions } from "../terminal-capabilities";
import { ensureThemeSync, theme } from "../theme";
import type { Component } from "../tui";
import { MAX_PICTURE_BYTES } from "./image-source";

/** Share of the viewport's rows one picture may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.6;

/**
 * The file's bytes, or undefined when it is not a picture this figure draws.
 *
 * The path comes from a model-written line, so nothing about it is trusted: a
 * device (`/dev/zero` fills memory before the read returns), a directory, or a
 * file past {@link MAX_PICTURE_BYTES} is refused. `stat` runs before the open so
 * a FIFO cannot block the load waiting for a writer, and the opened handle is
 * re-checked because the name may be replaced between the two calls.
 */
async function readPicture(path: string): Promise<Uint8Array | undefined> {
	const named = await stat(path);
	if (!named.isFile() || named.size === 0 || named.size > MAX_PICTURE_BYTES) return undefined;
	const handle = await open(path, "r");
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > MAX_PICTURE_BYTES) return undefined;
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

let figuresEnabled = true;

/** Turn lifting image lines into drawn files on or off (`tui.renderImages`); the host rebuilds the transcript after. */
export function setRasterFigureRendering(enabled: boolean): void {
	figuresEnabled = enabled;
}

/** Whether assistant image lines render as images where the terminal can show them. */
export function rasterFigureRendering(): boolean {
	return figuresEnabled;
}

export interface RasterFigureOptions {
	/** Markdown for the line as written, shown when the file does not draw. Without it the figure stays blank. */
	markdown?: (text: string) => Markdown;
	/** Shared inline-image budget; a superseded picture is released from it. */
	budget?: ImageBudget;
	/** The figure's rows changed outside a text update: bytes landed or the load failed. */
	onChange: () => void;
}

/** One file's decoded picture. */
interface Picture {
	path: string;
	/** Base64 of the file's bytes. */
	data: string;
	mime: string;
	widthPx: number;
	heightPx: number;
}

let nextFigureId = 0;

export class RasterFigure implements Component {
	readonly #options: RasterFigureOptions;
	readonly #id = nextFigureId++;
	#path = "";
	#alt = "";
	#picture: Picture | undefined;
	/** A path whose bytes could not be read or decoded: draw the line instead. */
	#failedPath: string | undefined;
	/** The path a read is in flight for, if any. Cleared on completion, including for a path since replaced. */
	#loadingPath: string | undefined;
	#disposed = false;
	#width: number | undefined;
	#image: { picture: Picture; component: Image } | undefined;
	#fallback: { alt: string; path: string; md: Markdown } | undefined;
	#placeholder: readonly string[] | undefined;

	constructor(options: RasterFigureOptions) {
		ensureThemeSync();
		this.#options = options;
	}

	/** Feed the line's target and alt text. */
	update(path: string, alt: string): void {
		if (path === this.#path && alt === this.#alt) return;
		if (path !== this.#path) {
			this.#picture = undefined;
			this.#failedPath = undefined;
		}
		this.#path = path;
		this.#alt = alt;
		if (this.#width !== undefined) this.#load();
	}

	/** Whether a read is in flight for this figure, including one for a path `update` has since replaced. */
	get pending(): boolean {
		return this.#loadingPath !== undefined;
	}

	render(width: number): readonly string[] {
		this.#width = width;
		if (this.#picture === undefined) {
			if (this.#failedPath === this.#path) return this.#fallbackRows(width);
			this.#load();
			if (this.#failedPath === this.#path) return this.#fallbackRows(width);
			if (!this.#options.markdown) return [];
			this.#placeholder ??= [` ${theme.fg("dim", "Loading image…")}`];
			return this.#placeholder;
		}
		return this.#imageFor(this.#picture).render(width);
	}

	invalidate(): void {
		this.#placeholder = undefined;
		this.#fallback = undefined;
		this.#image?.component.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
	}

	debugState(): Record<string, unknown> {
		return {
			path: this.#path,
			mime: this.#picture?.mime ?? null,
			size: this.#picture ? `${this.#picture.widthPx}x${this.#picture.heightPx}` : null,
			failed: this.#failedPath === this.#path,
		};
	}

	/**
	 * Read the file once, unless its bytes are already here, a read is in flight, or it already failed.
	 *
	 * A read that lands after `update` moved to another path releases the marker and
	 * starts the new path's read: holding the marker for a path nobody is drawing
	 * would leave the figure loading for the rest of the session.
	 */
	#load(): void {
		const path = this.#path;
		if (
			this.#disposed ||
			this.#loadingPath !== undefined ||
			this.#picture?.path === path ||
			this.#failedPath === path
		)
			return;
		this.#loadingPath = path;
		void readPicture(path)
			.then(
				(bytes): Picture | undefined => {
					if (bytes === undefined) return undefined;
					const mime = sniffMime(bytes);
					if (mime === undefined) return undefined;
					const data = bytes.toBase64();
					const size = getImageDimensions(data, mime);
					return size ? { path, data, mime, widthPx: size.widthPx, heightPx: size.heightPx } : undefined;
				},
				() => undefined,
			)
			.then(picture => {
				if (this.#disposed) return;
				if (this.#loadingPath === path) this.#loadingPath = undefined;
				if (path !== this.#path) {
					// The rows are still the placeholder: schedule the repaint the new read
					// needs, then start it.
					this.#options.onChange();
					this.#load();
					return;
				}
				if (picture === undefined) {
					this.#failedPath = path;
					this.#options.onChange();
					return;
				}
				this.#picture = picture;
				this.#placeholder = undefined;
				this.#options.onChange();
			});
	}

	/**
	 * The picture drawn into the columns and rows it may fill. Resizing re-renders
	 * the same {@link Image}: the terminal scales the graphic to the cells it is given.
	 */
	#imageFor(picture: Picture): Image {
		const current = this.#image;
		if (current?.picture === picture) return current.component;
		const width = this.#width ?? 80;
		const rows = Math.max(1, Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE));
		const component = new Image(
			picture.data,
			picture.mime,
			{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
			{
				maxWidthCells: imageMaxColumns(width),
				maxHeightCells: rows,
				filename: basename(picture.path),
				sourcePath: picture.path,
				budget: this.#options.budget,
				imageKey: `image${this.#id}`,
				requestRender: this.#options.onChange,
			},
			{ widthPx: picture.widthPx, heightPx: picture.heightPx },
		);
		this.#image = { picture, component };
		return component;
	}

	/** The line as written, in a fence so its path survives copying and a terminal link policy. */
	#fallbackRows(width: number): readonly string[] {
		if (!this.#options.markdown) return [];
		if (this.#fallback?.alt !== this.#alt || this.#fallback.path !== this.#path) {
			const line = `![${this.#alt}](${this.#path})`;
			this.#fallback = { alt: this.#alt, path: this.#path, md: this.#options.markdown(fencedCode("", line)) };
		}
		return this.#fallback.md.render(width);
	}
}

/** The image format the file's header names, for the four formats {@link getImageDimensions} reads. */
function sniffMime(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "image/webp";
	return undefined;
}
