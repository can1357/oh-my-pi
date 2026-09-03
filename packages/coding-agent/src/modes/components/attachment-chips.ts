import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type Component,
	getImageDimensions,
	getKittyGraphics,
	type ImageBudget,
	ImageProtocol,
	renderImage,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { fileHyperlink } from "../../tui/hyperlink";
import { convertImageToPng } from "../../utils/image-loading";
import { attachmentSgr } from "../composer-attachments";
import { cachedImageDimensions, setCachedImageDimensions } from "../image-references";
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

/**
 * The composer attachment band: one rounded card per staged attachment, rendered directly above
 * the prompt box. Image and video cards show a live thumbnail (Kitty Unicode placeholders — the only
 * protocol whose output is plain text cells and therefore composable inside a border row) with
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
	) {}

	render(width: number): readonly string[] {
		const chips = this.editor.composerChips();
		if (chips.length === 0) return [];
		const rows = ["", "", "", "", "", ""];
		const gap = " ".repeat(CARD_GAP);
		let x = 0;
		for (const chip of chips) {
			if (x + CARD_COLS > width) break;
			const card = this.#card(chip);
			for (let r = 0; r < rows.length; r++) rows[r] += (x > 0 ? gap : "") + card[r];
			x += (x > 0 ? CARD_GAP : 0) + CARD_COLS;
		}
		return rows;
	}

	#card(chip: ComposerChipDescriptor): string[] {
		const sgr = attachmentSgr(chip.kind, chip.n);
		const icon = theme.symbol(
			chip.kind === "paste" ? "chip.paste" : chip.kind === "video" ? "chip.video" : "chip.image",
		);
		let bottomCaption: string;
		let interior: string[];
		if (chip.kind !== "paste") {
			const dims = this.#imageDims(chip.image);
			bottomCaption = dims ? `${dims.width}x${dims.height}` : "";
			interior = this.#imageInterior(chip.image, dims, chip.kind);
		} else {
			bottomCaption = chip.text.lineCount > 1 ? `+${chip.text.lineCount} lines` : `${chip.text.charCount} chars`;
			interior = this.#textInterior(chip.text);
		}
		const vertical = `${sgr}${theme.symbol("boxRound.vertical")}${RESET_FG}`;
		const title =
			chip.kind === "paste" || !chip.link ? `${icon} #${chip.n}` : fileHyperlink(chip.link, `${icon} #${chip.n}`);
		return [
			this.#borderRow(sgr, title, "top"),
			...interior.map(row => vertical + row + vertical),
			this.#borderRow(sgr, bottomCaption, "bottom"),
		];
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

	/** 12x4 thumbnail as Kitty Unicode-placeholder cell rows, centered; any other protocol (or a
	 *  budget-suppressed image) falls back to a centered icon — direct placements, SIXEL, and
	 *  iTerm2 output cursor-addressed sequences that cannot be composed into a border row. */
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
		const lines = entry.content.split("\n");
		const rows: string[] = [];
		for (let r = 0; r < INNER_ROWS; r++) {
			const cut = truncateToWidth(replaceTabs(lines[r] ?? ""), INNER_COLS);
			const pad = INNER_COLS - visibleWidth(cut);
			rows.push(theme.fg("muted", cut) + " ".repeat(Math.max(0, pad)));
		}
		return rows;
	}
}
