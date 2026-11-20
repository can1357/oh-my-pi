import type { GifFrame, Size } from "../messages";

/** A location in the screenshot's original viewport coordinates. */
export interface Point {
	x: number;
	y: number;
}

/** Convert the fixed output canvas into the frame's CSS space; never derive positions from DPR. */
export function frameLayout(canvas: Size, frame: GifFrame, index: number, count: number) {
	const scale = canvas.width / frame.viewport.width;
	if (!Number.isFinite(scale) || scale <= 0) throw new Error("GIF frame has no viewport width");
	const width = frame.viewport.width;
	const height = canvas.height / scale;
	const markSize = 28;
	const action = frame.action?.kind;
	return {
		scale,
		width,
		height,
		mark: { x: width - markSize - 8, y: height - markSize - 12, size: markSize },
		progress: { x: 0, y: height - 3, width: width * ((index + 1) / count), height: 3 },
		delay: (frame.delayMs ?? (action === "click" || action === "drag" ? 1500 : 800)) + (index + 1 === count ? 2000 : 0),
	};
}

/** Keep a 28px pill in view, flipping it to the left of a marker near the right edge. */
export function labelBox(viewport: Size, labelWidth: number, anchor?: Point): Point & { height: number } {
	const inset = 8;
	const height = 28;
	const maxX = Math.max(0, viewport.width - labelWidth - inset);
	const maxY = Math.max(0, viewport.height - height - inset);
	if (!anchor) return { x: Math.min(inset, maxX), y: maxY, height };
	const right = anchor.x + 20;
	const x = right <= maxX ? right : anchor.x - 20 - labelWidth;
	return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(anchor.y - 10, maxY)), height };
}

/** Place a 14px arrowhead just before the end disk, shrinking it for short drags. */
export function dragHead(from: Point, to: Point): { tip: Point; left: Point; right: Point } | undefined {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	const length = Math.min(14, distance - 12);
	if (length <= 0) return undefined;
	const ux = dx / distance;
	const uy = dy / distance;
	const tip = { x: to.x - 6 * ux, y: to.y - 6 * uy };
	const base = { x: tip.x - length * ux, y: tip.y - length * uy };
	const halfWidth = length / 2;
	return {
		tip,
		left: { x: base.x - uy * halfWidth, y: base.y + ux * halfWidth },
		right: { x: base.x + uy * halfWidth, y: base.y - ux * halfWidth },
	};
}
