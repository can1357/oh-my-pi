import { type ImageBudget, type ImageDimensions, InlineImage } from "@oh-my-pi/pi-natives";
import { imageFallback, type InlineImagePass, inlineImageRequest } from "../inline-image";
import { getTerminalBackgroundColor, TERMINAL } from "../terminal-capabilities";
import { nativeImageNode, openableImageProps } from "../native/blobs";
import { imageLinksEnabled, linkedImageText, transcriptImageLink } from "../prompt/image-references";
import type { DescribeContext, NativeNode } from "../native/node";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** File the image was read from; its link target. Images without one link to a blob copy of their bytes. */
	sourcePath?: string;
	/** Shared budget that caps how many inline images render as live graphics. */
	budget?: ImageBudget;
	/**
	 * Stable identity for the underlying image (e.g. `toolCallId:index`). Lets the
	 * budget hand back the same graphics id across component re-creations so a
	 * repaint replaces the placement instead of stacking a duplicate.
	 */
	imageKey?: string;
	/**
	 * Schedules a repaint once this image's off-thread SIXEL encode lands.
	 * Defaults to the budget's repaint; a host without a budget must pass one,
	 * or the image's reserved rows stay blank until an unrelated repaint.
	 */
	requestRender?: () => void;
}

/** Renders in progress whose rows are bound for native scrollback. */
let scrollbackRenderDepth = 0;

/**
 * Run `render` for rows bound for native scrollback. Those rows are never
 * repainted, so an image whose off-thread SIXEL encode has not landed encodes
 * synchronously instead of committing its reserved blank rows.
 */
export function renderForScrollback<T>(render: () => T): T {
	scrollbackRenderDepth++;
	try {
		return render();
	} finally {
		scrollbackRenderDepth--;
	}
}

/** Renders in progress that measure rows outside display order; see {@link measureRender}. */
let measureRenderDepth = 0;
/** Budgeted image observations made under {@link measureRender}; only differences are meaningful. */
let measuredImageObservations = 0;

/**
 * Run `render` to measure rows outside display order — a newest-first height
 * walk, say. The `ImageBudget` derives demotion from the order images are
 * observed in, so a budgeted {@link Image} inside this scope claims no display
 * slot: it replays the decision its slot in the surface's last full pass
 * implies. `images` reports whether any budgeted image was observed; the caller
 * MUST render every such block it lays out again, outside this scope and in
 * display order, or its images keep no slot in the pass.
 */
export function measureRender<T>(render: () => T): { value: T; images: boolean } {
	const before = measuredImageObservations;
	measureRenderDepth++;
	try {
		const value = render();
		return { value, images: measuredImageObservations !== before };
	} finally {
		measureRenderDepth--;
	}
}

/**
 * How an `InlineImage.render` call made now is bound: for native scrollback
 * ({@link renderForScrollback}) and/or as a measuring observation
 * ({@link measureRender}). Every renderer of an `InlineImage` builds its pass
 * here — the image observes its budget slot inside the render, so a budgeted
 * one (`budgeted`) counts toward the enclosing measure scope.
 */
export function inlineImagePass(budgeted: boolean, cached: boolean): InlineImagePass {
	const measuring = measureRenderDepth > 0;
	// Only graphics-capable frames observe the budget.
	if (measuring && budgeted && TERMINAL.imageProtocol !== null) measuredImageObservations++;
	return { scrollback: scrollbackRenderDepth > 0, measuring, cached };
}

// Direct placements reserve height with leading zero-width rows. Keep them
// non-plain so transcript blank-edge trimming does not collapse image-only blocks.
const RESERVED_IMAGE_ROW = "\x1b[0m";

/** Widest an {@link Image} rendered at `width` columns draws; callers sizing a raster for it (`SvgFigure`) match it. */
export function imageMaxColumns(width: number): number {
	return Math.max(1, width - 2);
}

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#budget?: ImageBudget;
	/** Native encoder: protocol rows, budget observation, transmits, SIXEL encodes. */
	#image: InlineImage;
	/**
	 * Repaint once an off-thread SIXEL encode lands. Passed per render, so the
	 * native side holds it only while an encode runs and never pins this image.
	 */
	#onEncoded = (backgroundRgb: number): void => {
		// An encode composited against a background the terminal has since left
		// is replaced by the next render's own encode.
		if (getTerminalBackgroundColor() !== backgroundRgb) return;
		if (this.#options.requestRender) this.#options.requestRender();
		else this.#budget?.requestRender();
	};

	#cachedLines?: string[];
	/** Text-fallback height the cached lines were built for; undefined for graphic rows. */
	#cachedFallbackRows?: number;
	/** Link policy the cached fallback was built under (an `off` switch drops its link). */
	#cachedLinked = false;
	/** Described node and the link policy it was built under (an `off` switch drops its `href`). */
	#native?: { linked: boolean; node: NativeNode };

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#budget = options.budget;
		this.#image = new InlineImage(base64Data, mimeType, dimensions);
		this.#dimensions = { widthPx: this.#image.widthPx, heightPx: this.#image.heightPx };
		if (options.budget) this.#image.useBudget(options.budget, options.imageKey);
	}
	/** Return source metadata without exposing the encoded image buffer. */
	debugState(): Record<string, unknown> {
		return {
			mimeType: this.#mimeType,
			widthPx: this.#dimensions.widthPx,
			heightPx: this.#dimensions.heightPx,
			filename: this.#options.filename ?? null,
			imageId: this.#image.imageId ?? null,
			suppressed: this.#image.suppressed,
		};
	}

	invalidate(): void {
		this.#cachedLines = undefined;
	}

	/** Refit to a new column ceiling. */
	setMaxWidthCells(maxWidthCells: number): void {
		if (this.#options.maxWidthCells === maxWidthCells) return;
		this.#options.maxWidthCells = maxWidthCells;
		this.#native = undefined;
		this.invalidate();
	}

	/**
	 * Refit to a new row ceiling; a SIXEL reserves its rows until the off-thread
	 * encode lands. A demoted fallback keeps the height already drawn only
	 * within the new ceiling: the owner chose to shrink the block.
	 */
	setMaxHeightCells(maxHeightCells: number): void {
		if (this.#options.maxHeightCells === maxHeightCells) return;
		this.#options.maxHeightCells = maxHeightCells;
		this.#native = undefined;
		this.invalidate();
	}

	releaseRenderCaches(): void {
		this.#cachedLines = undefined;
	}

	/** Retire this image's graphic as soon as no frame shows it: for an owner closing it for good. */
	release(): void {
		this.#image.release();
	}

	/**
	 * A native `image` backed by a content-addressed blob; the terminal fits
	 * it. Cell caps become `ch`/`lines` bounds. The inline-image budget and
	 * graphics protocols do not apply.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const linked = imageLinksEnabled();
		if (this.#native?.linked === linked) return this.#native.node;
		const maxW = this.#options.maxWidthCells;
		const maxH = this.#options.maxHeightCells;
		const href = transcriptImageLink({ data: this.#base64Data, mimeType: this.#mimeType }, this.#options.sourcePath);
		const node = nativeImageNode(Buffer.from(this.#base64Data, "base64"), this.#mimeType, {
			alt: imageFallback(this.#mimeType, this.#dimensions, this.#options.filename),
			w: this.#dimensions.widthPx,
			h: this.#dimensions.heightPx,
			max:
				(maxW ?? 0) > 0 || (maxH ?? 0) > 0
					? {
							w: maxW && maxW > 0 ? `${maxW}ch` : undefined,
							h: maxH && maxH > 0 ? `${maxH}lines` : undefined,
						}
					: undefined,
			...openableImageProps(href),
		});
		this.#native = { linked, node };
		return node;
	}

	render(width: number): readonly string[] {
		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(imageMaxColumns(width), cap) : imageMaxColumns(width);
		// One native call per pass: it observes the budget slot (even when the
		// rows are unchanged), queues a pending Kitty transmit, and answers the
		// rows, the fallback height, or null to keep the cached rows.
		const result = this.#image.render(
			inlineImageRequest(
				maxWidth,
				this.#options.maxHeightCells,
				inlineImagePass(this.#budget !== undefined, this.#cachedLines !== undefined),
			),
			this.#onEncoded,
		);
		const linked = imageLinksEnabled();
		if (result === null) {
			const cached = this.#cachedLines!;
			// The text fallback embeds a link only under an enabled hyperlink policy.
			if (this.#cachedFallbackRows === undefined || this.#cachedLinked === linked) return cached;
			return this.#cacheFallback(this.#cachedFallbackRows, linked);
		}
		if (typeof result === "number") return this.#cacheFallback(result, linked);
		this.#cachedLines = result;
		this.#cachedFallbackRows = undefined;
		return result;
	}

	/**
	 * Text fallback, height-preserving once a graphic has rendered: a demoted
	 * image must keep occupying the rows its placement used (`rows`), because
	 * those rows may already be committed to native scrollback — shrinking the
	 * block would shift everything below it and force the renderer's
	 * commit-resync (stale band + recommit). Reserved rows stay non-plain so
	 * blank-edge trimming cannot collapse the block either.
	 */
	#cacheFallback(rows: number, linked: boolean): string[] {
		const fallback = this.#theme.fallbackColor(
			linkedImageText(
				imageFallback(this.#mimeType, this.#dimensions, this.#options.filename),
				{ data: this.#base64Data, mimeType: this.#mimeType },
				this.#options.sourcePath,
			),
		);
		const lines: string[] = [];
		for (let i = 0; i < rows - 1; i++) {
			lines.push(RESERVED_IMAGE_ROW);
		}
		lines.push(fallback);
		this.#cachedLines = lines;
		this.#cachedFallbackRows = rows;
		this.#cachedLinked = linked;
		return lines;
	}
}
