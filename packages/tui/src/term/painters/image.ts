/**
 * `image`: a registered blob drawn inline through the terminal's image
 * protocol (kitty, iTerm2, SIXEL) at its natural size in cells, shrunk
 * (never grown) to the width it got, its `max` box and the rows its parent
 * fixes.
 *
 * Without a drawable picture (no image protocol, no blob, no pixel size, a
 * format the protocol cannot draw, past the image budget) it shows its `alt`
 * text in `muted`, cut to the width, in the rows the picture would take.
 */
import type { TspExtent, TspImageProps } from "@oh-my-pi/pi-wire";
import type { ImageRows } from "../../driver/images/store";
import type { UiNode } from "../../node";
import { type BlobEntry, getBlob } from "../../native/blobs";
import { truncate } from "../../text/width";
import { type Block, definePainter, type PaintContext } from "../paint";

const kBase64 = Symbol("pi-tui.image.base64");

interface EncodedBlob extends BlobEntry {
	[kBase64]?: string;
}

/** The base64 text of a blob's bytes (encoded once per blob). */
function base64Of(entry: EncodedBlob): string {
	let data = entry[kBase64];
	if (data === undefined) {
		data = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength).toString("base64");
		entry[kBase64] = data;
	}
	return data;
}

/** Cells an extent stands for on an axis `full` cells long (`"20ch"`, `"4lines"`, or a share). */
function extentCells(extent: TspExtent | undefined, full: number | undefined): number | undefined {
	if (extent === undefined) return undefined;
	if (typeof extent === "number") return full === undefined ? undefined : Math.max(1, Math.floor(extent * full));
	const cells = Number.parseInt(extent, 10);
	return Number.isFinite(cells) && cells > 0 ? cells : undefined;
}

/** The fallback label of an image node, styled. */
export function imageLabel(node: UiNode, cx: PaintContext): string {
	const props = node.props() as TspImageProps;
	return cx.theme.fg("muted", props.alt ?? "[Image]");
}

/** A picture to draw: a registered blob, its pixel size and an optional cell cap. */
export interface Picture {
	readonly blob?: string;
	readonly w?: number;
	readonly h?: number;
	readonly max?: TspImageProps["max"];
	/** Terminal-specific bounds used when the wire node leaves them unset. */
	readonly term?: { readonly max?: TspImageProps["max"] };
}

/**
 * What the terminal draws for `picture` at the context's size: its rows, the
 * cells they span and whether they show the image, with `label` (styled) as
 * the text fallback. Undefined when there is nothing to ask the terminal for
 * (no image protocol, no registered blob, no pixel size). `cells` draws it
 * only as cells of text, for a caller that puts other text on its rows.
 */
export function pictureRows(
	picture: Picture,
	cx: PaintContext,
	options: { readonly label: string; readonly cells?: boolean },
): ImageRows | undefined {
	const fallback = truncate(options.label, cx.width);
	const entry = picture.blob ? getBlob(picture.blob) : undefined;
	if (!cx.images || !entry || !picture.blob || !picture.w || !picture.h) return undefined;
	const cell = cx.images.cell();
	const max = picture.max ?? picture.term?.max;
	const maxColumns = Math.max(1, Math.min(cx.width, extentCells(max?.w, cx.width) ?? cx.width));
	const maxRows = Math.max(
		1,
		Math.min(cx.height ?? Number.POSITIVE_INFINITY, extentCells(max?.h, cx.height) ?? Number.POSITIVE_INFINITY),
	);
	// Natural size when it fits; else the caps (the store scales to fit both, either way).
	const fits = Math.ceil(picture.w / cell.w) <= maxColumns && Math.ceil(picture.h / cell.h) <= maxRows;
	return cx.images.rows(
		{ key: picture.blob, data: base64Of(entry), mime: entry.mime, widthPx: picture.w, heightPx: picture.h },
		{
			...(fits ? {} : { maxColumns, ...(Number.isFinite(maxRows) ? { maxRows } : {}) }),
			fallback,
			...(options.cells ? { cells: true } : {}),
		},
	);
}

/**
 * The rows of `picture` at the context's size, with `label` (styled) as the
 * text shown when it cannot be drawn.
 */
export function paintPicture(picture: Picture, cx: PaintContext, label: string): Block {
	return { rows: pictureRows(picture, cx, { label })?.rows ?? [truncate(label, cx.width)] };
}

/** How image `node` draws at this size, when the terminal can try its blob. */
export function imageRows(node: UiNode, cx: PaintContext, label: string): ImageRows | undefined {
	return pictureRows(node.props() as TspImageProps, cx, { label });
}

/** The rows of image `node` at the context's size (`label`: its fallback text, styled). */
export function paintImage(node: UiNode, cx: PaintContext, label = imageLabel(node, cx)): Block {
	return { rows: imageRows(node, cx, label)?.rows ?? [truncate(label, cx.width)] };
}

definePainter("image", (node, cx) => paintImage(node, cx));
