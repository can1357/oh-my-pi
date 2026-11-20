import { applyPalette, GIFEncoder, quantize } from "gifenc";
import type { GifFrame, Size } from "../messages";
import { dragHead, frameLayout, labelBox, type Point } from "./layout";
import type { EncodeGifRequest, EncodeGifResult } from "./messages";

const CYAN = "#5ad8e6";
const PINK = "#ed4abf";
const OMP_MARK = new Path2D("M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z");

function drawClick(ctx: CanvasRenderingContext2D, point: Point): void {
	ctx.lineWidth = 2;
	ctx.strokeStyle = "rgba(90,216,230,.5)";
	ctx.beginPath();
	ctx.arc(point.x, point.y, 11, 0, 2 * Math.PI);
	ctx.stroke();
	ctx.strokeStyle = "rgba(90,216,230,.3)";
	ctx.beginPath();
	ctx.arc(point.x, point.y, 15, 0, 2 * Math.PI);
	ctx.stroke();
}

function drawDrag(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
	ctx.strokeStyle = PINK;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(from.x, from.y);
	ctx.lineTo(to.x, to.y);
	ctx.stroke();
	const head = dragHead(from, to);
	if (head) {
		ctx.fillStyle = PINK;
		ctx.beginPath();
		ctx.moveTo(head.tip.x, head.tip.y);
		ctx.lineTo(head.left.x, head.left.y);
		ctx.lineTo(head.right.x, head.right.y);
		ctx.closePath();
		ctx.fill();
	}
	ctx.fillStyle = "#ededef";
	ctx.lineWidth = 2;
	for (const point of [from, to]) {
		ctx.beginPath();
		ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
		ctx.fill();
		ctx.stroke();
	}
}

function drawLabel(ctx: CanvasRenderingContext2D, viewport: Size, label: string, anchor?: Point): void {
	const padding = 8;
	ctx.font = "500 14px system-ui, sans-serif";
	ctx.textBaseline = "middle";
	const width = Math.min(ctx.measureText(label).width + 2 * padding, viewport.width - 2 * padding);
	if (width <= 2 * padding) return;
	const { x, y, height } = labelBox(viewport, width, anchor);
	ctx.fillStyle = "rgba(10,10,11,.92)";
	ctx.beginPath();
	ctx.roundRect(x, y, width, height, 8);
	ctx.fill();
	ctx.fillStyle = "#ededef";
	ctx.fillText(label, x + padding, y + height / 2, width - 2 * padding);
}

function drawAction(ctx: CanvasRenderingContext2D, viewport: Size, action: NonNullable<GifFrame["action"]>): void {
	switch (action.kind) {
		case "click":
			drawClick(ctx, action);
			drawLabel(ctx, viewport, action.label || "Clicking", action);
			break;
		case "drag":
			drawDrag(ctx, action.from, action.to);
			drawLabel(ctx, viewport, action.label || "Dragging", action.to);
			break;
		case "scroll":
			drawLabel(ctx, viewport, action.label || "Scrolling", action);
			break;
		case "type":
			drawLabel(ctx, viewport, action.label || "Typing");
			break;
	}
}

function drawMark(ctx: CanvasRenderingContext2D, { x, y, size }: Point & { size: number }): void {
	ctx.save();
	ctx.translate(x, y);
	ctx.scale(size / 64, size / 64);
	ctx.fillStyle = "rgba(10,10,11,.75)";
	ctx.beginPath();
	ctx.roundRect(0, 0, 64, 64, 16);
	ctx.fill();
	const gradient = ctx.createLinearGradient(10, 14, 54, 56);
	gradient.addColorStop(0, "oklch(0.7 0.24 340)");
	gradient.addColorStop(0.5, "oklch(0.62 0.21 295)");
	gradient.addColorStop(1, "oklch(0.81 0.14 200)");
	ctx.fillStyle = gradient;
	ctx.fill(OMP_MARK);
	ctx.restore();
}

async function decode({ image }: GifFrame): Promise<ImageBitmap> {
	const encoded = await fetch(`data:${image.mimeType};base64,${image.data}`);
	return createImageBitmap(await encoded.blob());
}

async function encode(frames: GifFrame[]): Promise<string> {
	const first = frames[0];
	if (!first) throw new Error("There are no screenshots to export");
	const encoder = GIFEncoder();
	let firstImage: ImageBitmap | undefined = await decode(first);
	try {
		const canvas = document.createElement("canvas");
		canvas.width = firstImage.width;
		canvas.height = firstImage.height;
		const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
		if (!ctx) throw new Error("Chrome could not allocate a GIF canvas");
		for (const [index, frame] of frames.entries()) {
			const layout = frameLayout(canvas, frame, index, frames.length);
			const image = firstImage ?? (await decode(frame));
			firstImage = undefined;
			try {
				ctx.resetTransform();
				ctx.fillStyle = "#09090a";
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(image, 0, 0, canvas.width, (canvas.width * image.height) / image.width);
			} finally {
				image.close();
			}
			ctx.setTransform(layout.scale, 0, 0, layout.scale, 0, 0);
			if (frame.action) drawAction(ctx, layout, frame.action);
			drawMark(ctx, layout.mark);
			const gradient = ctx.createLinearGradient(0, 0, layout.width, 0);
			gradient.addColorStop(0, CYAN);
			gradient.addColorStop(1, PINK);
			ctx.fillStyle = gradient;
			const bar = layout.progress;
			ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
			const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const palette = quantize(data, 256);
			encoder.writeFrame(applyPalette(data, palette), canvas.width, canvas.height, { palette, delay: layout.delay });
		}
		encoder.finish();
	} finally {
		firstImage?.close();
	}
	const blob = new Blob([encoder.bytesView()], { type: "image/gif" });
	const reader = new FileReader();
	const result = Promise.withResolvers<string>();
	reader.addEventListener("load", () => {
		if (typeof reader.result === "string") result.resolve(reader.result);
		else result.reject(new Error("Could not read the GIF data URL"));
	}, { once: true });
	reader.addEventListener("error", () => result.reject(reader.error ?? new Error("Could not read the GIF")), { once: true });
	reader.readAsDataURL(blob);
	return result.promise;
}

chrome.runtime.onMessage.addListener((message: EncodeGifRequest, _sender, sendResponse: (reply: EncodeGifResult) => void) => {
	if (message?.omp !== "encode-gif") return false;
	void encode(message.frames).then(
		url => sendResponse({ ok: true, url }),
		error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
	return true;
});
