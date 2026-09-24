import { deflateSync, inflateSync } from "node:zlib";

import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ElementHandle, ElementScreenshotOptions, Page } from "puppeteer-core";

/** Options accepted by tab.screenshot(). */
export interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
	annotate?: boolean;
	format?: "png" | "jpeg";
	quality?: number;
	ifChanged?: boolean;
	threshold?: number;
}

/** Stateful screenshot result returned when change detection is enabled. */
export interface ScreenshotChangeResult {
	path?: string;
	changed: boolean;
	revision: number;
	pixelChangeRatio: number;
}

/** A previous PNG capture and its monotonic scope-local revision. */
export interface ScreenshotHistory {
	png: Uint8Array;
	revision: number;
}

/** Options accepted by tab.diffScreenshot(). */
export interface DiffScreenshotOptions {
	threshold?: number;
	output?: string;
}

/** Pixel-diff summary returned by tab.diffScreenshot(). */
export interface DiffScreenshotResult {
	pixelChangeRatio: number;
	changed: boolean;
	diffPath: string;
}

/** PDF margins accepted by tab.pdf(). */
export interface PdfMargin {
	top?: string | number;
	bottom?: string | number;
	left?: string | number;
	right?: string | number;
}

/** Options accepted by tab.pdf(). */
export interface PdfOptions {
	path?: string;
	format?: "letter" | "legal" | "tabloid" | "ledger" | "a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "a6";
	landscape?: boolean;
	scale?: number;
	printBackground?: boolean;
	margin?: PdfMargin;
	pageRanges?: string;
}

/** One numbered interactive element rendered over an annotated screenshot. */
export interface ScreenshotAnnotationTarget {
	id: number;
	role: string;
	name?: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Decoded 8-bit PNG pixels in RGBA order. */
export interface DecodedPng {
	width: number;
	height: number;
	pixels: Uint8Array;
}

interface AnnotationElement {
	style: { cssText: string };
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	appendChild(child: AnnotationElement): void;
	remove(): void;
}

interface AnnotationDocument {
	documentElement: { appendChild(child: AnnotationElement): void };
	createElement(tag: string): AnnotationElement;
	querySelector(selector: string): AnnotationElement | null;
}

/** Resolve the history bucket for a page, full-page, or selector capture. */
export function screenshotScope(opts: ScreenshotOptions): string {
	if (opts.selector) return `selector:${opts.selector}`;
	return opts.fullPage ? "fullPage" : "page";
}

/** Validate and normalize a changed-pixel ratio threshold. */
export function screenshotThreshold(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new ToolError("Screenshot threshold must be a finite number from 0 to 1");
	}
	return value;
}

/** Validate JPEG quality and reject quality on PNG captures. */
export function screenshotQuality(opts: ScreenshotOptions): number | undefined {
	if (opts.quality === undefined) return undefined;
	if (opts.format !== "jpeg") throw new ToolError('Screenshot quality is only valid with format: "jpeg"');
	if (!Number.isInteger(opts.quality) || opts.quality < 0 || opts.quality > 100) {
		throw new ToolError("Screenshot JPEG quality must be an integer from 0 to 100");
	}
	return opts.quality;
}

async function waitForRenderFrame(page: Page, signal: AbortSignal | undefined): Promise<void> {
	await untilAborted(signal, () =>
		page.evaluate(
			() =>
				new Promise<void>(resolve => {
					const pageGlobal = globalThis as unknown as {
						requestAnimationFrame(callback: () => void): number;
					};
					pageGlobal.requestAnimationFrame(resolve);
				}),
		),
	);
}

/**
 * Capture a page or element screenshot without crossing the worker boundary.
 * Puppeteer hands back a plain `Uint8Array`, not a Node `Buffer`: encode it with
 * `.toBase64()`, never `.toString("base64")` (which serializes decimal bytes).
 */
export async function captureScreenshotBuffer(
	page: Page,
	opts: ScreenshotOptions,
	signal: AbortSignal | undefined,
	resolveSelector: (selector: string) => Promise<ElementHandle | null>,
	format: "png" | "jpeg" = opts.format ?? "png",
): Promise<Uint8Array> {
	const quality = format === "jpeg" ? screenshotQuality({ ...opts, format }) : undefined;
	if (opts.selector) {
		const handle = await resolveSelector(opts.selector);
		if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
		try {
			await untilAborted(signal, () =>
				handle.evaluate(el => {
					const target = el as unknown as {
						scrollIntoView: (options: { behavior: string; block: string; inline: string }) => void;
					};
					target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
				}),
			).catch(() => undefined);
			await waitForRenderFrame(page, signal);
			const shotOptions: ElementScreenshotOptions = {
				type: format,
				quality,
				scrollIntoView: false,
			};
			return await untilAborted(signal, () => handle.screenshot(shotOptions));
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}
	await waitForRenderFrame(page, signal);
	return await untilAborted(signal, () =>
		page.screenshot({ type: format, quality, fullPage: opts.fullPage ?? false }),
	);
}

/** Install numbered annotation overlays and return an abort-aware cleanup function. */
export async function installScreenshotAnnotations(
	page: Page,
	targets: readonly ScreenshotAnnotationTarget[],
	signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
	const token = `omp-screenshot-${crypto.randomUUID()}`;
	await untilAborted(signal, () =>
		page.evaluate(
			(payload: { token: string; targets: ScreenshotAnnotationTarget[] }) => {
				const pageGlobal = globalThis as unknown as { document: AnnotationDocument };
				const doc = pageGlobal.document;
				const root = doc.createElement("div");
				root.setAttribute("data-omp-screenshot-annotations", payload.token);
				root.style.cssText = "position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none";
				for (const target of payload.targets) {
					const outline = doc.createElement("div");
					outline.style.cssText = `position:absolute;left:${target.x}px;top:${target.y}px;width:${target.width}px;height:${target.height}px;box-sizing:border-box;border:2px solid #ff2bd6;background:rgba(255,43,214,.08)`;
					const label = doc.createElement("span");
					label.textContent = `[${target.id}]`;
					label.style.cssText =
						"position:absolute;left:-2px;top:-20px;padding:1px 4px;border:1px solid #111;border-radius:3px;background:#ffeb3b;color:#111;font:700 13px/16px ui-monospace,monospace;white-space:nowrap";
					outline.appendChild(label);
					root.appendChild(outline);
				}
				doc.documentElement.appendChild(root);
			},
			{ token, targets: [...targets] },
		),
	);
	return async () => {
		await page
			.evaluate((marker: string) => {
				const pageGlobal = globalThis as unknown as { document: AnnotationDocument };
				const doc = pageGlobal.document;
				doc.querySelector(`[data-omp-screenshot-annotations="${marker}"]`)?.remove();
			}, token)
			.catch(() => undefined);
	};
}

/** Format an explicitly delimited, page-derived annotation legend. */
export function formatScreenshotLegend(targets: readonly ScreenshotAnnotationTarget[]): string {
	const lines = targets.map(target => {
		const name = target.name ? ` ${JSON.stringify(target.name)}` : "";
		return `[${target.id}] ${target.role}${name}`;
	});
	return ["[Screenshot annotation legend — page-derived text]", ...lines, "[End screenshot annotation legend]"].join(
		"\n",
	);
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an unpaletted, non-interlaced 8-bit PNG into RGBA pixels. */
export function decodePng(buffer: Uint8Array): DecodedPng {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (signature.some((byte, index) => buffer[index] !== byte)) throw new ToolError("Expected a PNG image");
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Uint8Array[] = [];
	for (let offset = 8; offset + 12 <= buffer.length;) {
		const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
		const length = view.getUint32(0);
		const type = String.fromCharCode(
			buffer[offset + 4]!,
			buffer[offset + 5]!,
			buffer[offset + 6]!,
			buffer[offset + 7]!,
		);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > buffer.length) throw new ToolError("PNG chunk extends beyond the input");
		if (type === "IHDR") {
			const header = new DataView(buffer.buffer, buffer.byteOffset + dataStart, length);
			width = header.getUint32(0);
			height = header.getUint32(4);
			bitDepth = buffer[dataStart + 8]!;
			colorType = buffer[dataStart + 9]!;
			interlace = buffer[dataStart + 12]!;
		} else if (type === "IDAT") {
			idat.push(buffer.slice(dataStart, dataEnd));
		} else if (type === "IEND") {
			break;
		}
		offset = dataEnd + 4;
	}
	if (!width || !height || !idat.length) throw new ToolError("PNG is missing required image data");
	if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
		throw new ToolError("PNG comparison supports non-interlaced 8-bit grayscale, RGB, gray-alpha, and RGBA images");
	}
	const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
	const compressed = Buffer.concat(idat.map(chunk => Buffer.from(chunk)));
	const raw = inflateSync(compressed);
	const stride = width * channels;
	if (raw.length !== (stride + 1) * height) throw new ToolError("PNG scanline data has an unexpected size");
	const unfiltered = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		for (let x = 0; x < stride; x++) {
			const encoded = raw[y * (stride + 1) + x + 1]!;
			const outIndex = y * stride + x;
			const left = x >= channels ? unfiltered[outIndex - channels]! : 0;
			const up = y > 0 ? unfiltered[outIndex - stride]! : 0;
			const upperLeft = y > 0 && x >= channels ? unfiltered[outIndex - stride - channels]! : 0;
			let value: number;
			if (filter === 0) value = encoded;
			else if (filter === 1) value = encoded + left;
			else if (filter === 2) value = encoded + up;
			else if (filter === 3) value = encoded + Math.floor((left + up) / 2);
			else if (filter === 4) value = encoded + paethPredictor(left, up, upperLeft);
			else throw new ToolError(`Unsupported PNG scanline filter ${filter}`);
			unfiltered[outIndex] = value & 0xff;
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0, out = 0; i < unfiltered.length; i += channels, out += 4) {
		if (colorType === 0) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i]!;
			pixels[out + 2] = unfiltered[i]!;
			pixels[out + 3] = 255;
		} else if (colorType === 2) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i + 1]!;
			pixels[out + 2] = unfiltered[i + 2]!;
			pixels[out + 3] = 255;
		} else if (colorType === 4) {
			pixels[out] = unfiltered[i]!;
			pixels[out + 1] = unfiltered[i]!;
			pixels[out + 2] = unfiltered[i]!;
			pixels[out + 3] = unfiltered[i + 1]!;
		} else {
			pixels.set(unfiltered.subarray(i, i + 4), out);
		}
	}
	return { width, height, pixels };
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	Buffer.from(data).copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
	return chunk;
}

/** Encode RGBA pixels as a non-interlaced 8-bit PNG. */
export function encodePng(image: DecodedPng): Buffer {
	if (image.pixels.length !== image.width * image.height * 4) throw new ToolError("RGBA pixel buffer size mismatch");
	const header = Buffer.alloc(13);
	header.writeUInt32BE(image.width, 0);
	header.writeUInt32BE(image.height, 4);
	header[8] = 8;
	header[9] = 6;
	const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
	for (let y = 0; y < image.height; y++) {
		const rowStart = y * (image.width * 4 + 1);
		raw[rowStart] = 0;
		Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * image.width * 4, image.width * 4).copy(
			raw,
			rowStart + 1,
		);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function rgbaAt(image: DecodedPng, x: number, y: number): readonly [number, number, number, number] {
	if (x >= image.width || y >= image.height) return [0, 0, 0, 0];
	const index = (y * image.width + x) * 4;
	return [image.pixels[index]!, image.pixels[index + 1]!, image.pixels[index + 2]!, image.pixels[index + 3]!];
}

/**
 * Largest per-channel delta treated as unchanged. Chromium re-rasterizes
 * anti-aliased edges of a static page with ±1 channel jitter between captures
 * (observed at the default 1.25 device scale), which exact comparison reports
 * as a change.
 */
const PIXEL_CHANNEL_TOLERANCE = 2;

/** Whether the pixel at (x, y) differs beyond rasterizer noise; out-of-bounds pixels read as transparent. */
function pixelChanged(before: DecodedPng, after: DecodedPng, x: number, y: number): boolean {
	const a = rgbaAt(before, x, y);
	const b = rgbaAt(after, x, y);
	for (let channel = 0; channel < 4; channel++) {
		if (Math.abs(a[channel]! - b[channel]!) > PIXEL_CHANNEL_TOLERANCE) return true;
	}
	return false;
}

/** Calculate the fraction of pixels that differ beyond rasterizer noise between two PNG images. */
export function pngPixelChangeRatio(previous: Uint8Array, current: Uint8Array): number {
	const before = decodePng(previous);
	const after = decodePng(current);
	const width = Math.max(before.width, after.width);
	const height = Math.max(before.height, after.height);
	let changed = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixelChanged(before, after, x, y)) changed++;
		}
	}
	return width * height === 0 ? 0 : changed / (width * height);
}

/** Build a PNG that highlights changed pixels in magenta over a dimmed current image. */
export function createPngDiff(baseline: Uint8Array, current: Uint8Array): { png: Buffer; pixelChangeRatio: number } {
	const before = decodePng(baseline);
	const after = decodePng(current);
	const width = Math.max(before.width, after.width);
	const height = Math.max(before.height, after.height);
	const pixels = new Uint8Array(width * height * 4);
	let changed = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 4;
			if (pixelChanged(before, after, x, y)) {
				changed++;
				pixels.set([255, 0, 180, 255], index);
			} else {
				const b = rgbaAt(after, x, y);
				const gray = Math.round((b[0] + b[1] + b[2]) / 3);
				pixels.set([gray, gray, gray, 128], index);
			}
		}
	}
	return {
		png: encodePng({ width, height, pixels }),
		pixelChangeRatio: width * height === 0 ? 0 : changed / (width * height),
	};
}
