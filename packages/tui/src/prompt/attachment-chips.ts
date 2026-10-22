import type { ImageContent } from "@oh-my-pi/pi-ai";
import { encodeSixelAsync } from "@oh-my-pi/pi-natives";
import {
	type Component,
	getCellDimensions,
	getImageDimensions,
	getKittyGraphics,
	getTerminalBackgroundColor,
	type ImageBudget,
	ImageProtocol,
	renderImage,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { fileHyperlink } from "../render/hyperlink";
import { nativeImageNode } from "../native/blobs";
import { node, row, span } from "../native/describe";
import { plainText } from "../native/spans";
import type { DescribeContext, NativeNode } from "../native/node";
import { wrapTmuxPassthroughIfNeeded } from "../tmux";
import { convertImageToPng } from "../chat/image-loading";
import { attachmentSgr } from "./composer-attachments";
import { cachedImageDimensions, setCachedImageDimensions } from "./image-references";
import { theme } from "../theme/theme";
import type { ComposerChipDescriptor, CustomEditor, TextAttachment } from "./custom-editor";

/** Chip card geometry (mirrors omp2): a 12x4 content area inside a 1-cell rounded border. */
const INNER_COLS = 12;
const INNER_ROWS = 4;
const CARD_COLS = INNER_COLS + 2;
const CARD_GAP = 2;
const RESET_FG = "\x1b[39m";
/** Symbol-keyed PNG conversion cache on the draft image (same pattern as the dimension
 *  probe cache): Kitty's `f=100` transmit accepts only PNG, so non-PNG attachments
 *  (pastes are usually re-encoded JPEG/WebP) convert before transmit — the same pipeline
 *  the transcript uses. `null` = conversion in flight or failed. */
const kImagePng = Symbol("omp.imagePng");

interface ImageContentWithPng extends ImageContent {
	[kImagePng]?: ImageContent | null;
}

/** A SIXEL thumbnail for one image at one fitted size. `sequence` is `undefined` while the
 *  off-thread encode is pending and `null` when it failed (the chip keeps its icon). */
interface SixelThumb {
	key: string;
	sequence: string | null | undefined;
	cols: number;
	rows: number;
}
/** Thumbnails by image: encoded once per fitted size, never on a repaint. */
const kSixelThumbs = new WeakMap<ImageContent, SixelThumb>();
/** Blank 12x4 interior, the canvas a SIXEL thumbnail is drawn over. */
const BLANK_INTERIOR: string[] = Array.from({ length: INNER_ROWS }, () => " ".repeat(INNER_COLS));

/**
 * The composer attachment band: one rounded card per staged attachment, rendered directly above
 * the prompt box. Image and video cards show a live thumbnail (Kitty Unicode placeholders, or a
 * SIXEL placed inside the interior from the bottom border row) with
 * the pixel dimensions as the bottom caption; text-paste cards show the leading snippet with a
 * `+N lines` / `N chars` caption. The top caption is the same `<icon> #N` token that sits in
 * the editor buffer, in the same identity color. Cards that no longer fit the terminal width
 * are omitted rather than wrapped. Renders to nothing while no attachment is staged.
 */
export class AttachmentChipsBand implements Component {
	constructor(
		private readonly editor: CustomEditor,
		private readonly budget: ImageBudget,
		private readonly requestRender: () => void,
	) {
		// Promote speculative placements to last-painted once per emitted frame only.
		// `limitResidentImages` runs once per emission (never per discarded retry),
		// so a discovery pass the budget discards never becomes the delete baseline.
		this.budget.onFrameCommitted(() => {
			this.#lastSixelPlacements = this.#renderSixelPlacements;
		});
	}

	#native:
		| { chips: readonly ComposerChipDescriptor[]; node: NativeNode; images: ReadonlyMap<ImageContent, NativeNode> }
		| undefined;
	#lastSixelPlacements: Array<{ x: number; cols: number; rows: number; below: number; thumb: SixelThumb }> = [];
	#renderSixelPlacements: Array<{ x: number; cols: number; rows: number; below: number; thumb: SixelThumb }> = [];
	#renderSixelPrefixes: string[] = [];
	/**
	 * Promote the last rendered placements to last-painted. Called automatically
	 * once per emitted frame via the budget hook; tests call it explicitly to
	 * simulate emission between renders (a retry pass must not commit).
	 */
	commitSixelPlacements(): void {
		this.#lastSixelPlacements = this.#renderSixelPlacements;
	}

	/**
	 * A wrapping `row` of chip `card`s (`omp.composer.chip`) titled with the
	 * buffer token (`<icon> #N`): images and videos show the image itself,
	 * pastes their leading lines; the caption carries pixel size or line/char
	 * count. Hidden while nothing is staged.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const chips = this.editor.composerChips();
		if (this.#native?.chips === chips) return this.#native.node;
		const cards: NativeNode[] = [];
		const images = new Map<ImageContent, NativeNode>();
		for (const chip of chips) {
			const icon = theme.symbol(
				chip.kind === "paste" ? "chip.paste" : chip.kind === "video" ? "chip.video" : "chip.image",
			);
			const title = `${icon} #${chip.n}`;
			let content: NativeNode;
			let caption: string;
			if (chip.kind === "paste") {
				caption = chip.text.lineCount > 1 ? `+${chip.text.lineCount} lines` : `${chip.text.charCount} chars`;
				content = node("text", {
					spans: [span(plainText(chip.text.content.split("\n", 4).join("\n")), "muted")],
					wrap: "none",
					lines: 4,
				});
			} else {
				const dims = this.#imageDims(chip.image);
				caption = dims ? `${dims.width}x${dims.height}` : "";
				const image = chip.image;
				const native =
					images.get(image) ??
					this.#native?.images.get(image) ??
					nativeImageNode(Buffer.from(image.data, "base64"), image.mimeType);
				images.set(image, native);
				content = node("image", {
					...(native.k === "image" ? native.p : undefined),
					alt: title,
					w: dims?.width,
					h: dims?.height,
					max: { w: "12ch", h: "4lines" },
				});
			}
			const head =
				chip.kind !== "paste" && chip.link ? [span(title, "strong", { href: chip.link })] : [span(title, "strong")];
			const children: NativeNode[] = [content];
			if (caption) children.push(node("text", { spans: [span(caption, "dim")], wrap: "none" }));
			cards.push(
				node("card", { role: "omp.composer.chip", tone: "accent", head }, children, `${chip.kind}:${chip.n}`),
			);
		}
		const described = row(cards, { gap: "sm", wrap: true, role: "omp.composer.chips", hidden: cards.length === 0 });
		this.#native = { chips, node: described, images };
		return described;
	}

	render(width: number): readonly string[] {
		const chips = this.editor.composerChips();
		// Editor geometry only feeds SIXEL placement bookkeeping. Measuring it walks every draft
		// line, so it is skipped unless a SIXEL thumbnail can be placed or retired this frame.
		const sixel = TERMINAL.imageProtocol === ImageProtocol.Sixel;
		if (chips.length === 0) {
			if (this.#lastSixelPlacements.length === 0) return [];
			// Editor rows plus one chrome row: the band's viewport row up to a constant. Editor.render applies the max-height clamp and wrapping.
			const below = this.editor.render(width).length + 1;
			const clearRows = Array.from({ length: 6 }, () => "");
			clearRows[5] = this.#lastSixelPlacements
				.map(placement => this.#clearSixelAt(placement, below - placement.below))
				.join("");
			this.#renderSixelPlacements = [];
			this.#renderSixelPrefixes = [];
			// Do not commit here: the budget hook promotes to last-painted on emission.
			// The emptied band collapses to [] only on the next render, and nothing else schedules it.
			this.requestRender();
			return clearRows;
		}
		// Same editor geometry as the clear path above; only measured when a SIXEL thumbnail can be placed or retired.
		const below = sixel || this.#lastSixelPlacements.length > 0 ? this.editor.render(width).length + 1 : 0;
		this.#renderSixelPlacements = [];
		this.#renderSixelPrefixes = [];
		const rows = ["", "", "", "", "", ""];
		const gap = " ".repeat(CARD_GAP);
		let x = 0;
		for (const chip of chips) {
			if (x + CARD_COLS > width) break;
			const cardX = x + (x > 0 ? CARD_GAP : 0);
			const card = this.#card(chip, cardX, below);
			for (let r = 0; r < rows.length; r++) rows[r] += (x > 0 ? gap : "") + card[r];
			x += (x > 0 ? CARD_GAP : 0) + CARD_COLS;
		}
		// Stale deletes lead the bottom row: a delete cell inside a replacement
		// thumbnail's rect would otherwise erase the new image (Konsole removes
		// every placement covering the cell, SIXEL included). The thumbnail object
		// is part of the key: it changes with the image or its fitted size, so two
		// thumbnails with equal cell geometry are still retired and redrawn.
		let stale = "";
		for (const placement of this.#lastSixelPlacements) {
			if (
				!this.#renderSixelPlacements.some(
					current =>
						current.x === placement.x &&
						current.cols === placement.cols &&
						current.rows === placement.rows &&
						current.below === placement.below &&
						current.thumb === placement.thumb,
				)
			) {
				stale += this.#clearSixelAt(placement, below - placement.below);
			}
		}
		// SIXEL DCS sequences ride immediately after stale deletes, before border text:
		// with budget-suppressed chips ahead of a live thumbnail, border text alone can
		// push the first DCS beyond SIXEL_MARKER_SCAN_LIMIT (128), and line-fit then
		// treats the payload as visible text and truncates. Hoisted prefixes keep the
		// first marker at renderer-recognized row start (stale deletes + one prefix).
		rows[5] = stale + this.#renderSixelPrefixes.join("") + rows[5];
		// Commit happens via the budget's once-per-emission hook (or explicitly in tests).
		return rows;
	}

	#card(chip: ComposerChipDescriptor, x: number, below: number): string[] {
		const sgr = attachmentSgr(chip.kind, chip.n);
		const icon = theme.symbol(
			chip.kind === "paste" ? "chip.paste" : chip.kind === "video" ? "chip.video" : "chip.image",
		);
		let bottomCaption: string;
		let interior: string[];
		let thumb: (SixelThumb & { sequence: string }) | undefined = undefined;
		if (chip.kind !== "paste") {
			const dims = this.#imageDims(chip.image);
			bottomCaption = dims ? `${dims.width}x${dims.height}` : "";
			thumb = dims ? this.#sixelThumbnail(chip.image, dims) : undefined;
			interior = thumb ? BLANK_INTERIOR : this.#imageInterior(chip.image, dims, chip.kind);
		} else {
			bottomCaption = chip.text.lineCount > 1 ? `+${chip.text.lineCount} lines` : `${chip.text.charCount} chars`;
			interior = this.#textInterior(chip.text);
		}
		const vertical = `${sgr}${theme.symbol("boxRound.vertical")}${RESET_FG}`;
		const title =
			chip.kind === "paste" || !chip.link ? `${icon} #${chip.n}` : fileHyperlink(chip.link, `${icon} #${chip.n}`);
		const border = this.#borderRow(sgr, bottomCaption, "bottom");
		return [
			this.#borderRow(sgr, title, "top"),
			...interior.map(row => vertical + row + vertical),
			thumb ? this.#sixelBottomRow(thumb, x, border, below) : border,
		];
	}

	/** Delete the SIXEL placement at `placement`. `rowShift` is how many rows the band moved
	 *  down since that placement was drawn (negative when editor growth pushed the band up):
	 *  the delete aims from the current bottom-border cursor at the old origin cell. Zero keeps
	 *  the legacy straight-up lift, byte for byte. The Kitty `a=d,d=c` APC rides the shared
	 *  tmux passthrough so a Konsole outer terminal behind tmux still receives it. */
	#clearSixelAt(placement: { x: number; cols: number; rows: number }, rowShift = 0): string {
		const leftPad = Math.floor((INNER_COLS - placement.cols) / 2);
		const topPad = Math.floor((INNER_ROWS - placement.rows) / 2);
		const net = rowShift - (INNER_ROWS - topPad);
		const vertical = net < 0 ? `\x1b[${-net}A` : net > 0 ? `\x1b[${net}B` : "";
		const del = wrapTmuxPassthroughIfNeeded("\x1b_Ga=d,d=c,q=2\x1b\\");
		return `\x1b[0m\x1b7${vertical}\x1b[${placement.x + 2 + leftPad}G${del}\x1b8`;
	}
	/** Bottom border for a SIXEL thumbnail card. The DCS cursor-addressed prefix is hoisted
	 *  to the bottom row start (see `render`): the image emits from the centered origin inside
	 *  the interior via save/move/print/restore, then the border text follows. The leading SGR
	 *  reset keeps the line from matching the direct-placement lift pattern, which would erase
	 *  the rows above. Prefixes rebuild per frame (cheap concat; the encode stays cached). */
	#sixelBottomRow(thumb: SixelThumb & { sequence: string }, x: number, border: string, below: number): string {
		this.#renderSixelPlacements.push({ x, cols: thumb.cols, rows: thumb.rows, below, thumb });
		const leftPad = Math.floor((INNER_COLS - thumb.cols) / 2);
		const topPad = Math.floor((INNER_ROWS - thumb.rows) / 2);
		this.#renderSixelPrefixes.push(
			`\x1b[0m\x1b7\x1b[${INNER_ROWS - topPad}A\x1b[${x + 2 + leftPad}G${thumb.sequence}\x1b8`,
		);
		return border;
	}

	/** SIXEL thumbnail of an image chip. `renderImage` owns the fit (6-px band rounding, aspect scale) and
	 *  calls back with the pixel size to encode, so chip thumbnails match every other SIXEL image. Encoded
	 *  off-thread once per fitted size, never on a repaint. Returns `undefined` while the encode is pending
	 *  or failed, when the budget suppresses the image, when no Konsole identity confirms the SIXEL delete
	 *  that retires the raster (`a=d,d=c`), or under any other protocol: the caller keeps the icon. */
	#sixelThumbnail(
		image: ImageContent,
		dims: { width: number; height: number },
	): (SixelThumb & { sequence: string }) | undefined {
		if (TERMINAL.imageProtocol !== ImageProtocol.Sixel || !Bun.env.KONSOLE_VERSION) return undefined;
		const imageId = this.budget.acquireId(`chip:${image.mimeType}:${image.data.length}:${image.data.slice(0, 32)}`);
		if (this.budget.observe(imageId)) return undefined;
		const slot: { thumb?: SixelThumb } = {};
		renderImage(
			image.data,
			{ widthPx: dims.width, heightPx: dims.height },
			{
				maxWidthCells: INNER_COLS,
				maxHeightCells: INNER_ROWS,
				sixel: (widthPx, heightPx) => {
					slot.thumb = this.#sixelEntry(image, widthPx, heightPx);
					return slot.thumb.sequence;
				},
			},
		);
		const thumb = slot.thumb;
		return typeof thumb?.sequence === "string" ? (thumb as SixelThumb & { sequence: string }) : undefined;
	}

	/** The cache entry for `image` at a fitted pixel size. A size change replaces the entry and starts its
	 *  encode; `sequence` stays `undefined` until that encode settles. */
	#sixelEntry(image: ImageContent, widthPx: number, heightPx: number): SixelThumb {
		const backgroundRgb = getTerminalBackgroundColor();
		const key = `${widthPx}x${heightPx}:${backgroundRgb}`;
		const entry = kSixelThumbs.get(image);
		if (entry !== undefined && entry.key === key) return entry;
		const cell = getCellDimensions();
		const pending: SixelThumb = {
			key,
			sequence: undefined,
			cols: Math.ceil(widthPx / cell.widthPx),
			rows: Math.ceil(heightPx / cell.heightPx),
		};
		kSixelThumbs.set(image, pending);
		encodeSixelAsync(new Uint8Array(Buffer.from(image.data, "base64")), widthPx, heightPx, backgroundRgb).then(
			sequence => this.#settleSixel(image, pending, sequence),
			() => this.#settleSixel(image, pending, null),
		);
		return pending;
	}

	/** Store an off-thread encode result if it is still the image's current size, then repaint. */
	#settleSixel(image: ImageContent, entry: SixelThumb, sequence: string | null): void {
		if (kSixelThumbs.get(image) !== entry) return;
		entry.sequence = sequence;
		this.requestRender();
	}

	/** Horizontal border with an optional centered, bold caption padded by one space per side. */
	#borderRow(sgr: string, caption: string, edge: "top" | "bottom"): string {
		const left = theme.symbol(edge === "top" ? "boxRound.topLeft" : "boxRound.bottomLeft");
		const right = theme.symbol(edge === "top" ? "boxRound.topRight" : "boxRound.bottomRight");
		const horizontal = theme.symbol("boxRound.horizontal");
		if (!caption) return `${sgr}${left}${horizontal.repeat(INNER_COLS)}${right}${RESET_FG}`;
		const cut = truncateToWidth(caption, INNER_COLS - 2);
		const fill = INNER_COLS - visibleWidth(cut) - 2;
		const leftFill = Math.max(0, Math.floor(fill / 2));
		const rightFill = Math.max(0, fill - leftFill);
		return `${sgr}${left}${horizontal.repeat(leftFill)} \x1b[1m${cut}\x1b[22m ${horizontal.repeat(rightFill)}${right}${RESET_FG}`;
	}

	/** Pixel dimensions for the caption/thumbnail fit, probed once from the header bytes and
	 *  cached on the image object (`null` = undecodable header, never re-probed). */
	#imageDims(image: ImageContent): { width: number; height: number } | null {
		let dims = cachedImageDimensions(image);
		if (dims === undefined) {
			const probed = getImageDimensions(image.data, image.mimeType);
			dims = probed ? { width: probed.widthPx, height: probed.heightPx } : null;
			setCachedImageDimensions(image, dims);
		}
		return dims;
	}

	/** 12x4 thumbnail as Kitty Unicode-placeholder cell rows, centered. SIXEL is placed by #card
	 *  instead; any other protocol, a budget-suppressed image, or a pending encode falls back to a
	 *  centered icon, as do direct placements and iTerm2 output (cursor-addressed sequences that
	 *  cannot be composed into a border row). */
	#imageInterior(
		image: ImageContent,
		dims: { width: number; height: number } | null,
		kind: "image" | "video",
	): string[] {
		if (dims && TERMINAL.imageProtocol === ImageProtocol.Kitty && getKittyGraphics().unicodePlaceholders) {
			const display = this.#kittyDisplayImage(image);
			if (display) {
				const budget = this.budget;
				const imageId = budget.acquireId(
					`chip:${display.mimeType}:${display.data.length}:${display.data.slice(0, 32)}`,
				);
				// observe() keeps chip thumbnails inside the shared live-graphics budget so a
				// paste-heavy session cannot pile up placements the way unbudgeted images would.
				if (!budget.observe(imageId)) {
					const result = renderImage(
						display.data,
						{ widthPx: dims.width, heightPx: dims.height },
						{
							maxWidthCells: INNER_COLS,
							maxHeightCells: INNER_ROWS,
							imageId,
							includeTransmit: budget.shouldTransmit(imageId),
						},
					);
					if (result?.transmit) budget.enqueueTransmit(imageId, result.transmit);
					if (result?.lines) return this.#centerGrid(result.lines);
				}
			}
		}
		const icon = theme.symbol(kind === "video" ? "chip.video" : "chip.image");
		const pad = INNER_COLS - visibleWidth(icon);
		const iconRow = " ".repeat(Math.floor(pad / 2)) + theme.fg("muted", icon) + " ".repeat(Math.ceil(pad / 2));
		return [" ".repeat(INNER_COLS), iconRow, " ".repeat(INNER_COLS), " ".repeat(INNER_COLS)];
	}

	/** PNG form of `image` for the Kitty transmit; non-PNG sources convert asynchronously.
	 *  Returns undefined while the conversion is pending (or after it failed), letting the
	 *  caller fall back to the icon; a finished conversion triggers a repaint. */
	#kittyDisplayImage(image: ImageContent): ImageContent | undefined {
		if (image.mimeType === "image/png") return image;
		const cached = (image as ImageContentWithPng)[kImagePng];
		if (cached !== undefined) return cached ?? undefined;
		(image as ImageContentWithPng)[kImagePng] = null;
		convertImageToPng(image)
			.then(converted => {
				(image as ImageContentWithPng)[kImagePng] = converted;
				this.requestRender();
			})
			.catch(() => {});
		return undefined;
	}

	/** Center a placeholder cell grid (≤ 12 columns, ≤ 4 rows) inside the content area. */
	#centerGrid(lines: string[]): string[] {
		const rows: string[] = [];
		const topPad = Math.floor((INNER_ROWS - lines.length) / 2);
		for (let r = 0; r < INNER_ROWS; r++) {
			const line = lines[r - topPad];
			if (line === undefined) {
				rows.push(" ".repeat(INNER_COLS));
				continue;
			}
			const pad = Math.max(0, INNER_COLS - visibleWidth(line));
			rows.push(" ".repeat(Math.floor(pad / 2)) + line + " ".repeat(Math.ceil(pad / 2)));
		}
		return rows;
	}

	/** Leading 4 rows x 12 cols of the pasted text, muted. */
	#textInterior(entry: TextAttachment): string[] {
		// Only the leading rows are drawn; don't split a multi-KB paste every frame.
		const lines = entry.content.split("\n", INNER_ROWS);
		const rows: string[] = [];
		for (let r = 0; r < INNER_ROWS; r++) {
			const cut = truncateToWidth(replaceTabs(lines[r] ?? ""), INNER_COLS);
			const pad = INNER_COLS - visibleWidth(cut);
			rows.push(theme.fg("muted", cut) + " ".repeat(Math.max(0, pad)));
		}
		return rows;
	}
}
