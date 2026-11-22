import { expect, it } from "bun:test";
import type { GifFrame } from "../extension/messages";
import { dragHead, frameLayout, labelBox } from "../extension/offscreen/layout";

const frame: GifFrame = {
	image: { type: "image", mimeType: "image/png", data: "" },
	viewport: { width: 400, height: 280 },
};
const canvas = { width: 1000, height: 700 };

it("scales decorations by canvas-to-viewport width and puts progress along the actual bottom", () => {
	const layout = frameLayout(canvas, frame, 1, 4);
	expect(layout.scale).toBe(2.5);
	expect(layout.mark).toEqual({ x: 364, y: 240, size: 28 });
	expect(layout.progress.width * layout.scale).toBe(canvas.width / 2);
	expect((layout.progress.y + layout.progress.height) * layout.scale).toBe(canvas.height);
	expect(frameLayout(canvas, frame, 3, 4).progress.width).toBe(frame.viewport.width);
});

it("preserves pauses for clicks and drags and extends the final frame after either default or custom timing", () => {
	const click: GifFrame = { ...frame, action: { kind: "click", x: 10, y: 20 } };
	const drag: GifFrame = { ...frame, action: { kind: "drag", from: { x: 10, y: 20 }, to: { x: 40, y: 50 } } };
	const scroll: GifFrame = { ...frame, action: { kind: "scroll", x: 0, y: 50 }, delayMs: 1100 };
	expect(frameLayout(canvas, click, 0, 2).delay).toBe(1500);
	expect(frameLayout(canvas, drag, 1, 2).delay).toBe(3500);
	expect(frameLayout(canvas, frame, 0, 2).delay).toBe(800);
	expect(frameLayout(canvas, scroll, 0, 1).delay).toBe(3100);
});

it("places a pill beside the action, flipping and clamping for markers at the viewport edge", () => {
	expect(labelBox(frame.viewport, 70, { x: 100, y: 70 })).toEqual({ x: 120, y: 60, height: 28 });
	expect(labelBox(frame.viewport, 70, { x: 395, y: 277 })).toEqual({ x: 305, y: 244, height: 28 });
	expect(labelBox(frame.viewport, 70)).toEqual({ x: 8, y: 244, height: 28 });
});

it("keeps a drag arrow clear of its endpoint disks and does not invent a heading for tiny drags", () => {
	const anchor = { x: 20, y: 10 };
	expect(dragHead(anchor, { x: 120, y: 10 })).toEqual({
		tip: { x: 114, y: 10 },
		left: { x: 100, y: 17 },
		right: { x: 100, y: 3 },
	});
	expect(dragHead(anchor, { x: 20, y: 30 })).toEqual({
		tip: { x: 20, y: 24 },
		left: { x: 16, y: 16 },
		right: { x: 24, y: 16 },
	});
	expect(dragHead(anchor, { x: 20, y: 12 })).toBeUndefined();
});
