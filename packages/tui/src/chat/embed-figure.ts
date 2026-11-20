/**
 * An `<img>` or `<iframe>` of an assistant reply, drawn in terminal cells.
 *
 * An image is its picture, fitted to the tag's `width`/`height`
 * ({@link figureBox}) or shown at its natural size. An iframe is one
 * screenshot of its page over a row that names it and links to it
 * (`[Visit]`). The picture loads in the background ({@link loadEmbed}); a
 * one-row note stands in until it lands, when it cannot be shown, and on a
 * terminal without graphics.
 */
import { sanitizeStatusText } from "../chrome/shared";
import { Image, type ImageBudget } from "../components/image";
import { isSvgMedia } from "../media";
import { fileHyperlink, isHyperlinkEnabled, uriHyperlink } from "../render/hyperlink";
import {
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	ImageProtocol,
	TERMINAL,
} from "../terminal-capabilities";
import { theme } from "../theme";
import type { Component } from "../tui";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";
import { embedHost, loadEmbed } from "./embed-host";
import { type Embed, sameEmbed } from "./embed-source";
import { type EmbedTarget, embedTargetUrl, resolveEmbedSource } from "./embed-target";
import { figureBox, figureRoom } from "./figure-size";
import { convertImageToPngShared } from "../png-conversion";
import { SvgFigure } from "./svg-figure";

export interface EmbedFigureOptions {
	/** Shared inline-image budget for the picture. */
	budget?: ImageBudget;
	/** Rows the embed may fill, an iframe's link row included, read on every render; zero hides it. Unset or `undefined` takes a share of the terminal viewport. */
	maxRows?: () => number | undefined;
	/** Whether the transcript shows pictures (the host's image setting); off, the note stands in. */
	showImages: boolean;
	/** The embed's rows changed outside an update: its picture landed or failed to. */
	onChange: () => void;
}

/** A loaded picture before it is shown: a raster's payload, or an SVG's source. */
type Loaded =
	| { readonly kind: "raster"; readonly data: string; readonly mime: string; readonly natural: ImageDimensions }
	| { readonly kind: "svg"; readonly source: string };

type Picture =
	| { readonly kind: "raster"; readonly image: Image; readonly natural: ImageDimensions }
	| { readonly kind: "svg"; readonly figure: SvgFigure };

type Load =
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly picture: Picture }
	| { readonly state: "failed"; readonly reason: string };

const NO_ROWS: readonly string[] = [];
const VISIT = "[Visit]";

let nextEmbedId = 0;

export class EmbedFigure implements Component {
	readonly #options: EmbedFigureOptions;
	readonly #id = nextEmbedId++;
	#embed: Embed | undefined;
	/** What the embed's `src` names, read once per embed; undefined when it names nothing showable. */
	#target: EmbedTarget | undefined;
	/** Counts embeds shown; a load landing for an earlier one is dropped. */
	#revision = 0;
	#load: Load | undefined;
	#disposed = false;
	/** The last render's parts and the rows built from them, returned again while both parts stand. */
	#rendered: { picture: readonly string[]; note: string | undefined; rows: readonly string[] } | undefined;

	constructor(options: EmbedFigureOptions) {
		this.#options = options;
	}

	/** Show `embed`; one that loads and draws the same as the current keeps its picture. */
	update(embed: Embed): void {
		if (this.#embed && sameEmbed(this.#embed, embed)) return;
		this.#retire();
		this.#embed = embed;
		this.#target = resolveEmbedSource(embed.src, embedHost()?.cwd() ?? process.cwd());
		this.#revision++;
		if (this.#drawsPictures()) this.#start(embed);
	}

	/** Whether the picture is still on its way: loading, or an SVG waiting for its raster. */
	get pending(): boolean {
		if (!this.#embed || !this.#drawsPictures() || this.#maxRows() === 0) return false;
		const load = this.#load;
		if (load?.state === "ready") return load.picture.kind === "svg" && load.picture.figure.pending;
		return load?.state !== "failed";
	}

	render(width: number): readonly string[] {
		const embed = this.#embed;
		if (!embed || this.#maxRows() === 0) return NO_ROWS;
		let picture = NO_ROWS;
		if (this.#drawsPictures()) {
			if (!this.#load) this.#start(embed);
			picture = this.#pictureRows(embed, width);
		}
		const note = embed.kind === "iframe" || picture.length === 0 ? this.#note(embed, width) : undefined;
		const rendered = this.#rendered;
		if (rendered?.picture === picture && rendered.note === note) return rendered.rows;
		const rows = note === undefined ? picture : [...picture, note];
		this.#rendered = { picture, note, rows };
		return rows;
	}

	invalidate(): void {
		this.#rendered = undefined;
		const picture = this.#load?.state === "ready" ? this.#load.picture : undefined;
		if (picture?.kind === "raster") picture.image.invalidate();
		else picture?.figure.invalidate();
	}

	releaseRenderCaches(): void {
		this.#rendered = undefined;
		const picture = this.#load?.state === "ready" ? this.#load.picture : undefined;
		if (picture?.kind === "raster") picture.image.releaseRenderCaches();
		else picture?.figure.releaseRenderCaches();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#load?.state === "ready" && this.#load.picture.kind === "svg") this.#load.picture.figure.dispose();
	}

	debugState(): Record<string, unknown> {
		return {
			kind: this.#embed?.kind ?? null,
			src: this.#embed?.src.slice(0, 200) ?? null,
			load: this.#load?.state ?? null,
		};
	}

	/** Whether this terminal and transcript show pictures at all. */
	#drawsPictures(): boolean {
		return TERMINAL.imageProtocol !== null && this.#options.showImages;
	}

	/** The caller's row ceiling, if any. */
	#maxRows(): number | undefined {
		const rows = this.#options.maxRows?.();
		return rows === undefined ? undefined : Math.max(0, Math.floor(rows));
	}

	/** Rows left for the picture: an iframe keeps one of the ceiling for its link row. */
	#pictureMaxRows(): number | undefined {
		const rows = this.#maxRows();
		return rows !== undefined && this.#embed?.kind === "iframe" ? rows - 1 : rows;
	}

	/** Retire the shown picture for good: its embed changed. */
	#retire(): void {
		const load = this.#load;
		this.#load = undefined;
		this.#rendered = undefined;
		if (load?.state !== "ready") return;
		if (load.picture.kind === "raster") {
			load.picture.image.release();
		} else {
			load.picture.figure.release();
			load.picture.figure.dispose();
		}
	}

	#start(embed: Embed): void {
		const revision = this.#revision;
		this.#load = { state: "loading" };
		void loadPicture(embed).then(
			// A picture landing for a replaced embed or a closed figure must not take an image id nobody will release.
			loaded => this.#current(revision) && this.#settle({ state: "ready", picture: this.#show(embed, loaded) }),
			(error: unknown) =>
				this.#current(revision) &&
				this.#settle({ state: "failed", reason: error instanceof Error ? error.message : String(error) }),
		);
	}

	#current(revision: number): boolean {
		return !this.#disposed && revision === this.#revision;
	}

	#settle(load: Load): void {
		this.#load = load;
		this.#options.onChange();
	}

	#show(embed: Embed, loaded: Loaded): Picture {
		const { budget, onChange } = this.#options;
		if (loaded.kind === "svg") {
			const figure = new SvgFigure({ budget, size: embed.size, maxRows: () => this.#pictureMaxRows(), onChange });
			figure.update(loaded.source, true);
			return { kind: "svg", figure };
		}
		const target = this.#target;
		const image = new Image(
			loaded.data,
			loaded.mime,
			{ fallbackColor: text => theme.fg("dim", text) },
			{
				filename: sanitizeStatusText(embed.label) || undefined,
				sourcePath: embed.kind === "img" && target?.kind === "file" ? target.path : undefined,
				budget,
				imageKey: `embed${this.#id}:${this.#revision}`,
				requestRender: onChange,
			},
			loaded.natural,
		);
		return { kind: "raster", image, natural: loaded.natural };
	}

	/** The picture's rows; none while it loads, when it failed, or when it does not fit the ceiling. */
	#pictureRows(embed: Embed, width: number): readonly string[] {
		const load = this.#load;
		const maxRows = this.#pictureMaxRows();
		if (load?.state !== "ready" || (maxRows !== undefined && maxRows <= 0)) return NO_ROWS;
		if (load.picture.kind === "svg") return load.picture.figure.render(width);
		const { image, natural } = load.picture;
		const box = figureBox(embed.size, { room: figureRoom(width, maxRows), cell: getCellDimensions(), natural });
		image.setMaxWidthCells(box.columns);
		image.setMaxHeightCells(box.rows);
		const rows = image.render(width);
		// A SIXEL band is six pixels whole and may reserve more rows than the ceiling.
		return maxRows !== undefined && rows.length > maxRows ? NO_ROWS : rows;
	}

	/** One row naming the embed and what its picture is doing; an iframe's also links to its page. */
	#note(embed: Embed, width: number): string {
		const load = this.#drawsPictures() ? this.#load : undefined;
		const page = embed.kind === "iframe";
		const name = sanitizeStatusText(embed.label || (/^data:/i.test(embed.src) ? "image" : embed.src));
		let text = `▣ ${name}`;
		if (load?.state === "loading") text += page ? " — capturing…" : " — loading…";
		else if (load?.state === "failed")
			text += ` — couldn't ${page ? "capture" : "load"}: ${sanitizeStatusText(load.reason)}`;
		const target = this.#target;
		if (!page) {
			const row = theme.fg("dim", truncateToWidth(text, width - 1, Ellipsis.Unicode));
			if (target?.kind === "url") return ` ${uriHyperlink(target.url, row)}`;
			return ` ${target?.kind === "file" ? fileHyperlink(target.path, row) : row}`;
		}
		const url = target && embedTargetUrl(target);
		if (!url) return ` ${theme.fg("dim", truncateToWidth(text, width - 1, Ellipsis.Unicode))}`;
		if (!isHyperlinkEnabled()) {
			// No link to click: the address itself, once.
			if (embed.label) text += ` — ${sanitizeStatusText(url)}`;
			return ` ${theme.fg("dim", truncateToWidth(text, width - 1, Ellipsis.Unicode))}`;
		}
		const room = width - 2 - visibleWidth(VISIT);
		return ` ${theme.fg("dim", truncateToWidth(text, room, Ellipsis.Unicode))} ${uriHyperlink(url, theme.fg("accent", VISIT))}`;
	}
}

/** Load `embed`'s picture in the form this terminal draws: Kitty takes PNG only. */
async function loadPicture(embed: Embed): Promise<Loaded> {
	const media = await loadEmbed(embed);
	if (isSvgMedia(media)) return { kind: "svg", source: new TextDecoder().decode(media.bytes) };
	let data = media.bytes.toBase64();
	let mime = media.mime;
	if (TERMINAL.imageProtocol === ImageProtocol.Kitty && mime !== "image/png") {
		({ data, mimeType: mime } = await convertImageToPngShared({ type: "image", data, mimeType: mime }));
	}
	const natural = getImageDimensions(data, mime);
	if (!natural) throw new Error("unreadable image size");
	return { kind: "raster", data, mime, natural };
}
