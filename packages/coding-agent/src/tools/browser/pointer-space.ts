/**
 * The coordinate space of a tab's pointer helpers (`clickAt`, `mouseMove`, `drag` points).
 *
 * They take positions read off the tab's latest viewport screenshot. A screenshot normally reaches the model
 * in CSS pixels, so a position on it is a viewport CSS position and nothing is converted. A viewport the
 * model cannot see at that size arrives scaled; its {@link PointerFrame} then maps image positions back, so
 * the agent passes what it reads and never multiplies.
 *
 * ```ts
 * const pointer = new PointerSpace();
 * pointer.use({ viewport: { width: 1920, height: 1080 }, left: 0, top: 0, width: 1568, height: 882 });
 * pointer.toViewport({ x: 784, y: 441 }); // { x: 960, y: 540 }
 * pointer.toViewport({ x: 960, y: 540, css: true }); // { x: 960, y: 540 }
 * ```
 *
 * A frame belongs to the viewport size it pictured. Once the tab is known to have another size, image
 * positions throw rather than land somewhere else, until a new screenshot replaces the frame.
 */
import type { ImageSize } from "@oh-my-pi/pi-catalog/compat/image-tokenization";
import { ToolError } from "../tool-errors";

/** Where a viewport lies on the screenshot of it the model was shown. */
export interface PointerFrame {
	/** The viewport's CSS size when it was captured. */
	viewport: ImageSize;
	/** Left edge of the viewport on the image, in image pixels: 0 unless the image was padded. */
	left: number;
	/** Top edge of the viewport on the image, in image pixels: 0 unless the image was padded. */
	top: number;
	/** Width of the viewport on the image, in image pixels. */
	width: number;
	/** Height of the viewport on the image, in image pixels. */
	height: number;
}

/** A position given to a pointer helper. */
export interface PointerPoint {
	x: number;
	y: number;
	/** `x` and `y` are viewport CSS pixels measured on the page, not positions on a scaled screenshot. */
	css?: boolean;
}

/** One tab's pointer coordinate space: CSS pixels, or the frame of its latest scaled viewport screenshot. */
export class PointerSpace {
	#frame: PointerFrame | undefined;
	/** The viewport's size since the tool last resized it; unset while the frame's own is the latest known. */
	#resized: ImageSize | undefined;

	/**
	 * Read pointer positions on `frame` from now on: the viewport screenshot the model was just shown.
	 * `undefined` returns to CSS pixels, for a screenshot that is already in them.
	 */
	use(frame: PointerFrame | undefined): void {
		this.#frame = frame;
		this.#resized = undefined;
	}

	/** The tool resized the viewport to `viewport`; positions on a screenshot of another size are gone. */
	resized(viewport: ImageSize): void {
		this.#resized = viewport;
	}

	/**
	 * The viewport CSS position `point` names.
	 *
	 * `viewport` is the tab's size now, where the backend can tell without asking the page; otherwise the
	 * size of the last {@link resized} call stands in.
	 *
	 * @throws ToolError when that size is not the one the screenshot pictured: the positions read off it no
	 * longer exist on the page.
	 */
	toViewport(point: PointerPoint, viewport: ImageSize | undefined = this.#resized): { x: number; y: number } {
		const frame = this.#frame;
		if (!frame || point.css) return { x: point.x, y: point.y };
		// The frame's size is the capture's device pixels divided back, so it may sit a pixel off the true one.
		if (
			viewport &&
			(Math.abs(viewport.width - frame.viewport.width) > 1 || Math.abs(viewport.height - frame.viewport.height) > 1)
		) {
			throw new ToolError(
				`The viewport is ${viewport.width}x${viewport.height} now, and the last screenshot shows it at ${frame.viewport.width}x${frame.viewport.height}: pointer positions are read on that image. ` +
					"Take a new screenshot, or pass { css: true } to give viewport CSS pixels.",
			);
		}
		return {
			x: ((point.x - frame.left) * frame.viewport.width) / frame.width,
			y: ((point.y - frame.top) * frame.viewport.height) / frame.height,
		};
	}
}
