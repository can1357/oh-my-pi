import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";

import { deliveredImageSize, fitLongEdge, type ImageSize } from "@oh-my-pi/pi-catalog/compat/image-tokenization";
import { logger, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CDPSession, ElementHandle, ElementScreenshotOptions, Page } from "puppeteer-core";
import {
	DEFAULT_MIN_DIMENSION,
	paddedMapping,
	type ResizedImage,
	readImageHeaderDimensions,
	resizeImage,
} from "../../utils/image-resize";
import { encodeRawPng } from "../../utils/png-encode";
import { throwIfAborted } from "../tool-errors";
import { untilAbortedOrReleased } from "./op-timeouts";
import type { PointerFrame, PointerSpace } from "./pointer-space";
import type { RunOutput } from "./run-output";
import type { ScreenshotLimits, ScreenshotResult, SessionSnapshot } from "./tab-protocol";

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

/** What a browser screenshot covers, which sets the CSS pixel space its image coordinates map to. */
export type ScreenshotArea = "viewport" | "page" | "element";

/** One capture for {@link emitScreenshot} to size, store and show. */
export interface ScreenshotCapture {
	/** The capture as the browser encoded it, at device resolution. */
	bytes: Uint8Array;
	mimeType: "image/png" | "image/jpeg";
	area: ScreenshotArea;
	/** Capture pixels per CSS pixel; `undefined` when the surface could not report it. */
	scale: number | undefined;
	/** Store `bytes` rather than the model-visible image even without `browser.screenshotDir` (an explicit `format`). */
	keepCapture?: boolean;
	/** Captured through a frame handle: filed as a frame screenshot. */
	inFrame?: boolean;
	/** Store the capture without showing it. */
	silent?: boolean;
	/** Lines shown under the screenshot's own (annotation legend, surface caveats). */
	notes?: readonly string[];
}

/** Where {@link emitScreenshot} files and shows a capture: one run of one tab. */
export interface ScreenshotRun {
	session: SessionSnapshot;
	/** The run's displays; a shown capture adds its line and image. */
	output: RunOutput;
	/** The run's screenshot list; every stored capture joins it. */
	screenshots: ScreenshotResult[];
	/** The tab's pointer space; a shown viewport capture sets what its positions mean. */
	pointer: PointerSpace;
}

/** Resolve the history bucket for a page, full-page, or selector capture. */
export function screenshotScope(opts: ScreenshotOptions): string {
	if (opts.selector) return `selector:${opts.selector}`;
	return opts.fullPage ? "fullPage" : "page";
}

/** The CSS pixel space a page, full-page, or selector capture maps to. */
export function screenshotArea(opts: ScreenshotOptions): ScreenshotArea {
	if (opts.selector) return "element";
	return opts.fullPage ? "page" : "viewport";
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

/**
 * Longest edge of a model-visible screenshot. A larger image is rescaled on its way to the model without the
 * tool hearing of it, which moves every position read off it: Eval's display pass caps images at 1568px, and
 * an Anthropic request carrying more than 20 images caps each at 2000px.
 */
const SCREENSHOT_MAX_EDGE = 1568;

/** Encoded size cap of a model-visible screenshot; encoding quality gives way before its size does. */
const SCREENSHOT_MAX_BYTES = 150 * 1024;

/** The CSS space positions on a full-page or element capture map to. */
const SCREENSHOT_AREA_TARGET = {
	page: "CSS pixels from the page's top-left corner (tab.clickAt takes viewport positions)",
	element: "CSS pixels from the element's top-left corner",
} as const;

/**
 * The longest edge a capture of `size` CSS pixels is resized to. The model sees it in CSS pixels where the
 * tool cap, the host's edge cap and the model's own resize all allow, and at the largest size they pass
 * otherwise: each would rescale a larger image after its size was reported.
 */
function modelVisibleEdge(size: ImageSize | undefined, limits: ScreenshotLimits | undefined): number {
	const cap = Math.min(SCREENSHOT_MAX_EDGE, limits?.maxEdge ?? SCREENSHOT_MAX_EDGE);
	// resizeImage enlarges or pads a capture under the vision floor, so it cannot stay in CSS pixels.
	if (!size || Math.min(size.width, size.height) < DEFAULT_MIN_DIMENSION) return cap;
	const capped = fitLongEdge(size, cap);
	const edge = Math.max(capped.width, capped.height);
	const delivered = limits?.tokenization && deliveredImageSize(limits.tokenization, capped);
	// A vendor that enlarges small images names a larger size; only a smaller one binds.
	return delivered ? Math.min(edge, Math.max(delivered.width, delivered.height)) : edge;
}

/**
 * Where the viewport lies on a capture of it taken at `scale` device pixels per CSS pixel, or `undefined`
 * when the image is the viewport in CSS pixels.
 */
function pointerFrame(resized: ResizedImage, scale: number): PointerFrame | undefined {
	if (!resized.originalWidth || !resized.originalHeight || !resized.width || !resized.height) return undefined;
	const viewport = {
		width: Math.round(resized.originalWidth / scale),
		height: Math.round(resized.originalHeight / scale),
	};
	// Padding edges are fractions of the image; the rectangle they bound is whole pixels.
	const content = resized.paddedContent ?? { left: 0, top: 0, right: 1, bottom: 1 };
	const width = Math.round((content.right - content.left) * resized.width);
	const height = Math.round((content.bottom - content.top) * resized.height);
	// A pixel of difference is the capture's device size rounding, not a scale.
	if (!resized.paddedContent && Math.abs(width - viewport.width) <= 1 && Math.abs(height - viewport.height) <= 1) {
		return undefined;
	}
	return {
		viewport,
		left: Math.round(content.left * resized.width),
		top: Math.round(content.top * resized.height),
		width,
		height,
	};
}

/** How positions on a capture map to CSS pixels, or `undefined` when its pixels already are CSS pixels. */
function coordinateNote(
	area: ScreenshotArea,
	scale: number | undefined,
	resized: ResizedImage,
	frame: PointerFrame | undefined,
): string | undefined {
	if (!resized.originalWidth || !resized.width) return undefined;
	if (scale === undefined) {
		return "The screenshot's scale to CSS pixels could not be read; target elements by selector or id rather than tab.clickAt.";
	}
	if (area === "viewport") {
		if (!frame) return undefined;
		// No scale factor: a rounded one invites multiplying page positions by it, which lands pixels off.
		return `This image is the ${frame.viewport.width}x${frame.viewport.height} viewport rescaled: clickAt, mouseMove and drag points are positions on this image. Pass {css: true} with a position measured on the page (box, evaluate) instead of rescaling it.`;
	}
	const target = SCREENSHOT_AREA_TARGET[area];
	if (resized.paddedContent) return paddedMapping(resized, resized.paddedContent, scale, target);
	const factor = (resized.originalWidth / resized.width / scale).toFixed(2);
	return factor === "1.00" ? undefined : `Multiply image coordinates by ${factor} to get ${target}.`;
}

/**
 * Size a capture for the model, store it, and show it in the run's output.
 *
 * The model-visible image is in CSS pixels wherever the session's model takes the capture at that size, so a
 * position read off it is a position on the page. Its line says the size the model sees, the kept capture's
 * path, and, only when the image's pixels are not CSS pixels, how its positions map. A shown viewport
 * capture also sets the tab's pointer space, which does that mapping for the pointer helpers.
 *
 * @returns the stored file: the capture when it is kept (`browser.screenshotDir`, `keepCapture`), else the
 * model-visible image.
 * @throws ToolAbortError when `signal` aborts before the capture is stored or shown.
 */
export async function emitScreenshot(
	capture: ScreenshotCapture,
	run: ScreenshotRun,
	signal?: AbortSignal,
): Promise<string> {
	const { session } = run;
	const scale = capture.scale !== undefined && capture.scale > 0 ? capture.scale : undefined;
	const header = readImageHeaderDimensions(capture.bytes);
	// An unread scale leaves the capture's own pixels as the nearest thing to its CSS size.
	const density = scale ?? 1;
	const edge = modelVisibleEdge(
		header && { width: Math.round(header.width / density), height: Math.round(header.height / density) },
		session.screenshotLimits,
	);
	const resized = await resizeImage(
		{ bytes: capture.bytes, mimeType: capture.mimeType },
		{
			maxWidth: edge,
			maxHeight: edge,
			maxBytes: SCREENSHOT_MAX_BYTES,
			jpegQuality: 70,
			excludeWebP: session.excludeWebP,
		},
	);
	throwIfAborted(signal);
	const kept = capture.keepCapture === true || !!session.browserScreenshotDir;
	const saved = kept ? capture.bytes : resized.buffer;
	const mimeType = kept ? capture.mimeType : resized.mimeType;
	const ext = mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
	const dest = session.browserScreenshotDir
		? path.join(
				session.browserScreenshotDir,
				`${capture.inFrame ? "frame-screenshot" : "screenshot"}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
			)
		: path.join(os.tmpdir(), `${capture.inFrame ? "omp-frame-sshots" : "omp-sshots"}-${Snowflake.next()}.${ext}`);
	await Bun.write(dest, saved);
	throwIfAborted(signal);
	run.screenshots.push({ dest, mimeType, bytes: saved.length, width: resized.width, height: resized.height });
	if (capture.silent) return dest;

	const frame = capture.area === "viewport" && scale !== undefined ? pointerFrame(resized, scale) : undefined;
	let line = `Screenshot ${resized.width}x${resized.height}`;
	if (kept) line += `, full size saved to ${shortenPath(dest)}`;
	line += ".";
	if (resized.decodeFailed) line += " The image decoder failed, so this is the original image.";
	const note = coordinateNote(capture.area, scale, resized, frame);
	if (note) line += ` ${note}`;
	run.output.push({ type: "text", text: [line, ...(capture.notes ?? [])].join("\n") });
	run.output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
	// The pointer helpers now read positions on this image, or CSS pixels when it is in them.
	if (capture.area === "viewport") run.pointer.use(frame);
	return dest;
}

/**
 * Let pending style and layout changes paint before a capture. A hidden page (a
 * background tab, a minimized or fully covered window) runs no animation frames,
 * so the wait ends at once there, or as soon as the page turns hidden mid-wait.
 */
async function waitForRenderFrame(page: Page, signal: AbortSignal | undefined): Promise<void> {
	await untilAborted(signal, () =>
		page.evaluate(
			() =>
				new Promise<void>(resolve => {
					const pageGlobal = globalThis as unknown as {
						document: {
							visibilityState: string;
							addEventListener(type: string, listener: () => void): void;
							removeEventListener(type: string, listener: () => void): void;
						};
						requestAnimationFrame(callback: () => void): number;
					};
					const { document } = pageGlobal;
					if (document.visibilityState === "hidden") return resolve();
					const done = (): void => {
						document.removeEventListener("visibilitychange", done);
						resolve();
					};
					document.addEventListener("visibilitychange", done);
					pageGlobal.requestAnimationFrame(done);
				}),
		),
	);
}

/**
 * Run `capture` while `page` is made to draw. Chromium stops drawing a hidden
 * page (a background tab, a minimized or covered window) shortly after its last
 * change, and `Page.captureScreenshot` waits for a fresh frame, so capturing such
 * a page would wait until the op times out. A DevTools screencast makes Chromium
 * draw the page for capture without showing or activating it and without changing
 * its visibility. A browser that refuses the screencast is captured without it.
 */
export async function whileDrawing<T>(
	page: Page,
	signal: AbortSignal | undefined,
	capture: () => Promise<T>,
): Promise<T> {
	let session: CDPSession | undefined;
	try {
		try {
			const screencast = await untilAbortedOrReleased(signal, page.createCDPSession(), late => late.detach());
			session = screencast;
			await untilAborted(signal, () =>
				screencast.send("Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1 }),
			);
		} catch (error) {
			signal?.throwIfAborted();
			logger.debug("Browser screenshot screencast unavailable; capturing without it", { error: String(error) });
		}
		return await capture();
	} finally {
		if (session) {
			await session.send("Page.stopScreencast").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}
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

/** Page function (self-contained): draw numbered outlines for `payload.targets` under a root tagged with `payload.token`. */
export function installAnnotationOverlayInPage(payload: {
	token: string;
	targets: ScreenshotAnnotationTarget[];
}): void {
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
}

/** Page function (self-contained): remove the overlay installed with `token`. */
export function removeAnnotationOverlayInPage(token: string): void {
	const pageGlobal = globalThis as unknown as { document: AnnotationDocument };
	const doc = pageGlobal.document;
	doc.querySelector(`[data-omp-screenshot-annotations="${token}"]`)?.remove();
}

/** Install numbered annotation overlays and return an abort-aware cleanup function. */
export async function installScreenshotAnnotations(
	page: Page,
	targets: readonly ScreenshotAnnotationTarget[],
	signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
	const token = `omp-screenshot-${crypto.randomUUID()}`;
	await untilAborted(signal, () => page.evaluate(installAnnotationOverlayInPage, { token, targets: [...targets] }));
	return async () => {
		await page.evaluate(removeAnnotationOverlayInPage, token).catch(() => undefined);
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

/** Encode RGBA pixels as a non-interlaced 8-bit PNG. */
export function encodePng(image: DecodedPng): Buffer {
	if (image.pixels.length !== image.width * image.height * 4) throw new ToolError("RGBA pixel buffer size mismatch");
	return encodeRawPng(image.pixels, image.width, image.height, 4);
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
