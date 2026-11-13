/**
 * Pictures an HTML form shows: `<img src>` loaded from a URL, a `data:` URI or
 * a local file, and inline `<svg>` drawings, as bytes plus a MIME type —
 * a raster (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) or
 * `image/svg+xml`.
 *
 * @example
 * const media = await loadFormImage("docs/arch.png", { cwd, signal });
 * media.mime; // "image/png"
 */
import * as os from "node:os";
import * as path from "node:path";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/** An image's bytes and MIME type. */
export interface FormMedia {
	bytes: Uint8Array;
	mime: string;
}

/** Where relative paths resolve, and the abort for in-flight loads. */
export interface FormMediaOptions {
	cwd: string;
	signal?: AbortSignal;
}

/** Largest picture a form loads. */
export const MAX_FORM_IMAGE_BYTES = 10 * 1024 * 1024;
/** Longest a remote picture may take to arrive. */
const FETCH_TIMEOUT_MS = 10_000;
const SVG_MIME = "image/svg+xml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Load an `<img src>`: an `http(s):` URL, a `data:` URI (base64 or URL-encoded),
 * a `file:` URL, or a path (`~/`-relative, absolute, or relative to `cwd`).
 *
 * @throws {Error} the source cannot be read, exceeds {@link MAX_FORM_IMAGE_BYTES},
 * times out, or is not a PNG, JPEG, GIF, WebP or SVG image.
 */
export async function loadFormImage(src: string, options: FormMediaOptions): Promise<FormMedia> {
	const bytes = await readSource(src, options);
	if (bytes.byteLength > MAX_FORM_IMAGE_BYTES) throw new Error(`larger than ${MAX_FORM_IMAGE_BYTES >> 20} MiB`);
	const raster = parseImageMetadata(bytes.subarray(0, 64));
	if (raster) return { bytes, mime: raster.mimeType };
	const text = new TextDecoder().decode(bytes.subarray(0, 4096));
	if (/<svg[\s>]/i.test(text)) return svgMedia(new TextDecoder().decode(bytes));
	throw new Error("not a PNG, JPEG, GIF, WebP or SVG image");
}

/**
 * An `<svg>` as standalone media: the SVG namespace added when missing, and a
 * drawing sized only by its `viewBox` given that size as `width`/`height`, since
 * renderers drop a drawing without one.
 */
export function svgMedia(markup: string): FormMedia {
	const open = /<svg\b[^>]*>/i.exec(markup)?.[0];
	if (!open) return { bytes: new TextEncoder().encode(markup), mime: SVG_MIME };
	const added: string[] = [];
	if (!/\bxmlns\s*=/i.test(open)) added.push(`xmlns="${SVG_NAMESPACE}"`);
	const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open);
	if (box && !/\swidth\s*=/i.test(open) && !/\sheight\s*=/i.test(open)) {
		added.push(`width="${box[1]}"`, `height="${box[2]}"`);
	}
	const sized = added.length > 0 ? markup.replace(/<svg\b/i, `<svg ${added.join(" ")}`) : markup;
	return { bytes: new TextEncoder().encode(sized), mime: SVG_MIME };
}

/** Whether `media` is an SVG drawing rather than a raster. */
export function isSvgMedia(media: FormMedia): boolean {
	return media.mime === SVG_MIME;
}

async function readSource(src: string, options: FormMediaOptions): Promise<Uint8Array> {
	if (/^data:/i.test(src)) return decodeDataUri(src);
	if (/^https?:\/\//i.test(src)) {
		const signal = options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
			: AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const response = await fetch(src, { signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > MAX_FORM_IMAGE_BYTES) throw new Error(`larger than ${MAX_FORM_IMAGE_BYTES >> 20} MiB`);
		return new Uint8Array(await response.arrayBuffer());
	}
	const file = /^file:/i.test(src) ? Bun.fileURLToPath(src) : resolvePath(src, options.cwd);
	const handle = Bun.file(file);
	if (handle.size > MAX_FORM_IMAGE_BYTES) throw new Error(`larger than ${MAX_FORM_IMAGE_BYTES >> 20} MiB`);
	return new Uint8Array(await handle.arrayBuffer());
}

function resolvePath(src: string, cwd: string): string {
	if (src === "~" || src.startsWith("~/")) return path.join(os.homedir(), src.slice(1));
	return path.resolve(cwd, src);
}

/** The payload of a `data:` URI; base64 when marked so, else percent-encoded text. */
function decodeDataUri(uri: string): Uint8Array {
	const comma = uri.indexOf(",");
	if (comma === -1) throw new Error("malformed data: URI");
	const header = uri.slice(5, comma);
	const payload = uri.slice(comma + 1);
	if (/;base64$/i.test(header)) return Uint8Array.fromBase64(payload.replace(/\s+/g, ""));
	return new TextEncoder().encode(decodeURIComponent(payload));
}
