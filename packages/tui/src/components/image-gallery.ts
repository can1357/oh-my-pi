import { matchesKey } from "../keys";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import {
	calculateImageFit,
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";
import { visibleWidth } from "../utils";
import { Image, type ImageTheme } from "./image";

/** Image payload accepted by {@link ImageGallery} and {@link TUI.openImageGallery}. */
export interface ImageGalleryImage {
	data: string;
	mimeType: string;
	filename?: string;
	dimensions?: ImageDimensions;
}

export interface ImageGalleryOptions {
	/** Called after Escape/q or a close request. */
	onClose?: () => void;
	/** Called after a mouse/keyboard navigation or zoom change. */
	onChange?: () => void;
	/** Colorizer used by the text fallback when no image protocol is available. */
	fallbackColor?: (text: string) => string;
	/** Height of the fullscreen viewport in terminal rows. */
	viewportHeight?: number;
}

const DEFAULT_VIEWPORT_HEIGHT = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/**
 * Fullscreen image viewer shared by TUI hosts. The selected image is rendered
 * as one complete component frame; cursor-positioned protocols are never
 * horizontally composed with another image, preserving direct-placement safety.
 */
export class ImageGallery implements Component, MouseRoutable {
	readonly images: readonly ImageGalleryImage[];
	#selectedIndex: number;
	#zoom = 1;
	#onClose?: () => void;
	#onChange?: () => void;
	#fallbackColor: (text: string) => string;
	#viewportHeight: number;
	#selectedImage?: Image;
	#selectedImageKey = "";
	#lastImageTop = 0;
	#lastImageBottom = 0;
	#lastImageLeft = 0;
	#lastImageRight = 0;

	constructor(images: readonly ImageGalleryImage[], initialIndex = 0, options: ImageGalleryOptions = {}) {
		this.images = [...images];
		this.#selectedIndex = this.#clampIndex(initialIndex);
		this.#onClose = options.onClose;
		this.#onChange = options.onChange;
		this.#fallbackColor = options.fallbackColor ?? (text => text);
		this.#viewportHeight = Math.max(1, Math.trunc(options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT));
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	get zoom(): number {
		return this.#zoom;
	}

	setViewportHeight(height: number): void {
		const next = Math.max(1, Math.trunc(height));
		if (next === this.#viewportHeight) return;
		this.#viewportHeight = next;
		this.#selectedImage?.invalidate();
	}

	hasMouseTargets(): boolean {
		return this.images.length > 0 && TERMINAL.imageProtocol !== null;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (!this.hasMouseTargets()) return false;
		if (event.wheel !== null) {
			this.#setZoom(event.wheel < 0 ? ZOOM_STEP : -ZOOM_STEP);
			return true;
		}
		if (!event.leftClick) return false;
		if (line < this.#lastImageTop || line >= this.#lastImageBottom) return false;
		if (col < this.#lastImageLeft) {
			this.#select(-1);
			return true;
		}
		if (col >= this.#lastImageRight) {
			this.#select(1);
			return true;
		}
		this.#setZoom(ZOOM_STEP);
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.#onClose?.();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.#select(-1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			this.#select(1);
			return;
		}
		if (matchesKey(data, "+") || matchesKey(data, "=")) {
			this.#setZoom(ZOOM_STEP);
			return;
		}
		if (matchesKey(data, "-")) this.#setZoom(-ZOOM_STEP);
	}

	invalidate(): void {
		this.#selectedImage?.invalidate();
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, Math.trunc(width));
		const lines = new Array<string>(this.#viewportHeight).fill("");
		if (this.images.length === 0) {
			lines[0] = "No images";
			return lines;
		}

		const contentHeight = Math.max(1, this.#viewportHeight - 3);
		const contentWidth = Math.max(1, safeWidth - 2);
		const item = this.images[this.#selectedIndex]!;
		const dimensions = item.dimensions ?? getImageDimensions(item.data, item.mimeType);
		const fit = calculateImageFit(
			dimensions ?? { widthPx: 800, heightPx: 600 },
			{
				maxWidthCells: Math.max(1, Math.min(contentWidth, Math.round(contentWidth * this.#zoom))),
				maxHeightCells: Math.max(1, Math.min(contentHeight, Math.round(contentHeight * this.#zoom))),
			},
			getCellDimensions(),
		);
		const image = this.#getSelectedImage(fit.columns, fit.rows);
		const imageLines = image.render(Math.max(1, fit.columns + 2));
		const imageWidth = Math.max(1, Math.min(contentWidth, fit.columns));
		const imageTop = Math.max(0, Math.floor((contentHeight - imageLines.length) / 2));
		const imageStartRow = Math.max(0, Math.floor((this.#viewportHeight - (imageLines.length + 3)) / 2) + imageTop);
		const imageLeft = Math.max(0, Math.floor((safeWidth - imageWidth) / 2));
		this.#lastImageTop = imageStartRow;
		this.#lastImageBottom = imageStartRow + imageLines.length;
		this.#lastImageLeft = imageLeft;
		this.#lastImageRight = imageLeft + imageWidth;

		for (let i = 0; i < imageLines.length; i++) {
			const row = imageStartRow + i;
			if (row < 0 || row >= lines.length) continue;
			lines[row] = " ".repeat(imageLeft) + imageLines[i];
		}
		const statusRow = Math.min(lines.length - 2, this.#lastImageBottom + 1);
		const status = `[${this.#selectedIndex + 1}/${this.images.length}] ${Math.round(this.#zoom * 100)}%  use h/l or ←/→`;
		lines[statusRow] = " ".repeat(Math.max(0, Math.floor((safeWidth - visibleWidth(status)) / 2))) + status;
		const helpRow = Math.min(lines.length - 1, statusRow + 1);
		const help = "click sides: previous/next · wheel/click: zoom · +/-: zoom · Esc/q: close";
		lines[helpRow] = " ".repeat(Math.max(0, Math.floor((safeWidth - visibleWidth(help)) / 2))) + help;
		return lines;
	}

	#getSelectedImage(maxWidthCells: number, maxHeightCells: number): Image {
		const item = this.images[this.#selectedIndex]!;
		const key = `${this.#selectedIndex}:${item.data.length}:${item.mimeType}:${maxWidthCells}:${maxHeightCells}`;
		if (this.#selectedImage !== undefined && this.#selectedImageKey === key) return this.#selectedImage;
		this.#selectedImageKey = key;
		this.#selectedImage = new Image(
			item.data,
			item.mimeType,
			this.#galleryTheme(),
			{
				filename: item.filename,
				maxWidthCells,
				maxHeightCells,
			},
			item.dimensions,
		);
		return this.#selectedImage;
	}

	#galleryTheme(): ImageTheme {
		return { fallbackColor: this.#fallbackColor };
	}

	#clampIndex(index: number): number {
		if (this.images.length === 0) return 0;
		return Math.max(0, Math.min(this.images.length - 1, Math.trunc(index)));
	}
	#select(delta: -1 | 1): void {
		if (this.images.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + this.images.length) % this.images.length;
		this.#selectedImage = undefined;
		this.#onChange?.();
	}

	#setZoom(delta: number): void {
		const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round((this.#zoom + delta) * 100) / 100));
		if (next === this.#zoom) return;
		this.#zoom = next;
		this.#selectedImage?.invalidate();
		this.#onChange?.();
	}
}
