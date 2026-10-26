/**
 * A local image file drawn inline, for an assistant line that is nothing but
 * a Markdown image (`![alt](/path/shot.png)`). The file is read once per
 * path, its format sniffed from the header, and the picture drawn through
 * {@link Image} within the shared inline-image budget. A file that cannot be
 * read, or is not a format the terminal draws, falls back to the line as
 * written so the reader still has the path.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Image, type ImageBudget, imageMaxColumns } from "../components/image";
import type { Markdown } from "../components/markdown";
import { fencedCode } from "../components/markdown";
import { getImageDimensions } from "../terminal-capabilities";
import { ensureThemeSync, theme } from "../theme";
import type { Component } from "../tui";

/** Share of the viewport's rows one picture may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.6;

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
	#loading = false;
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

	/** Whether the current file's bytes are still being read. */
	get pending(): boolean {
		return this.#loading;
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

	/** Read the file once, unless its bytes are already here, a read is in flight, or it already failed. */
	#load(): void {
		if (this.#disposed || this.#loading || this.#picture?.path === this.#path || this.#failedPath === this.#path)
			return;
		const path = this.#path;
		this.#loading = true;
		void readFile(path)
			.then(
				(bytes): Picture | undefined => {
					const mime = sniffMime(bytes);
					if (mime === undefined) return undefined;
					const data = bytes.toBase64();
					const size = getImageDimensions(data, mime);
					return size ? { path, data, mime, widthPx: size.widthPx, heightPx: size.heightPx } : undefined;
				},
				() => undefined,
			)
			.then(picture => {
				if (this.#disposed || path !== this.#path) return;
				this.#loading = false;
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
