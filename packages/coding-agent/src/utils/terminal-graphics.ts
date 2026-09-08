import { deflateSync, inflateSync } from "node:zlib";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { decodeSixelToPng } from "@oh-my-pi/pi-natives";
import { MAX_IMAGE_INPUT_BYTES, convertImageToPng } from "./image-loading";

const ESC = "\x1b";
const KITTY_CHUNK_BYTES = 3072;
const MAX_IMAGE_COUNT = 32;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8192;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4;
const MAX_FRAME_CHARS = MAX_BASE64_CHARS + 4096;
const MAX_FRAME_PARTS = 8192;
const MAX_KITTY_CHUNKS = 8192;
const MAX_SIXEL_CHARS = MAX_IMAGE_INPUT_BYTES;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

type FrameKind = "kitty" | "sixel";
type ParserMode = "ground" | FrameKind | "discard";

interface KittyTransfer {
	accepted: boolean;
	format: number;
	width?: number;
	height?: number;
	compression?: string;
	parts: string[];
	base64Chars: number;
}

type EncodedImage =
	| { kind: "kitty"; format: number; width?: number; height?: number; compression?: string; base64: string }
	| { kind: "sixel"; bytes: Uint8Array };

/**
 * Incrementally removes terminal image control strings from subprocess output
 * and retains their images independently of the text sink's truncation policy.
 * Feed raw output here before ANSI sanitization or OutputSink buffering.
 */
export class TerminalGraphicsDecoder {
	#mode: ParserMode = "ground";
	#groundPrefix = "";
	#frameParts: string[] = [];
	#frameChars = 0;
	#frameEsc = false;
	#kittyTransfer?: KittyTransfer;
	#encodedImages: EncodedImage[] = [];
	#queuedBytes = 0;
	#decodedImages: ImageContent[] = [];
	#decodedImageBytes = 0;
	#decodedCount = 0;
	#decodeChain: Promise<void> = Promise.resolve();

	push(chunk: string): string {
		if (!chunk && !this.#groundPrefix) return "";
		let input = this.#groundPrefix + chunk;
		this.#groundPrefix = "";
		let output = "";

		while (input.length > 0) {
			if (this.#mode !== "ground") {
				const consumed = this.#consumeFrame(input);
				if (consumed < 0) break;
				input = input.slice(consumed);
				continue;
			}

			let cursor = 0;
			const textStart = 0;
			let enteredFrame = false;
			while (cursor < input.length) {
				const code = input.charCodeAt(cursor);
				if (code !== 0x1b && code !== 0x90 && code !== 0x9f) {
					cursor++;
					continue;
				}

				const introduction = this.#introductionAt(input, cursor);
				if (introduction === "partial") {
					output += input.slice(textStart, cursor);
					this.#groundPrefix = input.slice(cursor);
					return output;
				}
				if (!introduction) {
					cursor++;
					continue;
				}

				output += input.slice(textStart, cursor);
				this.#mode = introduction.kind;
				this.#frameParts = introduction.kind === "sixel" ? [input.slice(cursor, introduction.end)] : [];
				this.#frameChars = introduction.kind === "sixel" ? introduction.end - cursor : 0;
				this.#frameEsc = false;
				input = input.slice(introduction.end);
				enteredFrame = true;
				break;
			}
			if (!enteredFrame) {
				output += input.slice(textStart);
				break;
			}
		}
		return output;
	}

	/** Finish parsing, returning text that only resembled a partial introducer. */
	finish(): string {
		const text = this.#mode === "ground" ? this.#groundPrefix : "";
		this.#groundPrefix = "";
		this.#mode = "ground";
		this.#frameParts = [];
		this.#frameChars = 0;
		this.#frameEsc = false;
		this.#kittyTransfer = undefined;
		return text;
	}

	/** Decode every completed image in stream order. Invalid frames are omitted. */
	images(): Promise<ImageContent[]> {
		const through = this.#encodedImages.length;
		const run = this.#decodeChain.then(() => this.#decodeThrough(through));
		this.#decodeChain = run;
		return run.then(() => this.#decodedImages.slice());
	}

	#introductionAt(input: string, start: number): { kind: FrameKind; end: number } | "partial" | undefined {
		const first = input.charCodeAt(start);
		if (first === 0x1b) {
			if (start + 1 >= input.length) return "partial";
			const second = input[start + 1];
			if (second === "_") {
				if (start + 2 >= input.length) return "partial";
				return input[start + 2] === "G" ? { kind: "kitty", end: start + 3 } : undefined;
			}
			if (second !== "P") return undefined;
			return this.#sixelIntroduction(input, start, start + 2);
		}
		if (first === 0x9f) {
			if (start + 1 >= input.length) return "partial";
			return input[start + 1] === "G" ? { kind: "kitty", end: start + 2 } : undefined;
		}
		return this.#sixelIntroduction(input, start, start + 1);
	}

	#sixelIntroduction(
		input: string,
		start: number,
		paramsStart: number,
	): { kind: "sixel"; end: number } | "partial" | undefined {
		let cursor = paramsStart;
		while (cursor < input.length && /[0-9;]/u.test(input[cursor]!)) cursor++;
		if (cursor >= input.length) {
			return input.length - start <= 64 ? "partial" : undefined;
		}
		return input[cursor] === "q" ? { kind: "sixel", end: cursor + 1 } : undefined;
	}

	/** Returns bytes consumed through ST, or -1 when the frame remains open. */
	#consumeFrame(input: string): number {
		let cursor = 0;
		if (this.#frameEsc) {
			this.#frameEsc = false;
			if (input[0] === "\\") {
				this.#completeFrame();
				return 1;
			}
			this.#appendFrame(ESC);
		}

		const segmentStart = 0;
		while (cursor < input.length) {
			const code = input.charCodeAt(cursor);
			if (code === 0x9c) {
				this.#appendFrame(input.slice(segmentStart, cursor));
				this.#completeFrame();
				return cursor + 1;
			}
			if (code === 0x1b) {
				if (cursor + 1 >= input.length) {
					this.#appendFrame(input.slice(segmentStart, cursor));
					this.#frameEsc = true;
					return -1;
				}
				if (input[cursor + 1] === "\\") {
					this.#appendFrame(input.slice(segmentStart, cursor));
					this.#completeFrame();
					return cursor + 2;
				}
			}
			cursor++;
		}
		this.#appendFrame(input.slice(segmentStart));
		return -1;
	}

	#appendFrame(value: string): void {
		if (this.#mode === "discard" || value.length === 0) return;
		this.#frameChars += value.length;
		const limit = this.#mode === "sixel" ? MAX_SIXEL_CHARS : MAX_FRAME_CHARS;
		if (this.#frameChars > limit || this.#frameParts.length >= MAX_FRAME_PARTS) {
			this.#mode = "discard";
			this.#frameParts = [];
			this.#frameChars = 0;
			return;
		}
		this.#frameParts.push(value);
	}

	#completeFrame(): void {
		const mode = this.#mode;
		const body = mode === "discard" ? "" : this.#frameParts.join("");
		this.#mode = "ground";
		this.#frameParts = [];
		this.#frameChars = 0;
		this.#frameEsc = false;
		if (mode === "kitty") this.#handleKitty(body);
		else if (mode === "sixel") this.#handleSixel(body);
	}

	#handleKitty(body: string): void {
		const separator = body.indexOf(";");
		if (separator < 0) return;
		const controls = new Map<string, string>();
		for (const field of body.slice(0, separator).split(",")) {
			const equals = field.indexOf("=");
			if (equals <= 0 || equals === field.length - 1) continue;
			controls.set(field.slice(0, equals), field.slice(equals + 1));
		}
		const payload = body.slice(separator + 1);
		const action = controls.get("a");
		if (action && action !== "t" && action !== "T") return;
		const transmission = controls.get("t");
		if (transmission && transmission !== "d") {
			// File and shared-memory payloads are untrusted identifiers, never paths
			// that subprocess output can authorize this process to read or delete.
			this.#kittyTransfer =
				controls.get("m") === "1" ? { accepted: false, format: 32, parts: [], base64Chars: 0 } : undefined;
			return;
		}

		const beginsTransfer = !this.#kittyTransfer || ["f", "s", "v", "o", "t", "a"].some(key => controls.has(key));
		if (beginsTransfer) {
			const format = parsePositiveInteger(controls.get("f")) ?? 32;
			this.#kittyTransfer = {
				accepted: true,
				format,
				width: parsePositiveInteger(controls.get("s")),
				height: parsePositiveInteger(controls.get("v")),
				compression: controls.get("o"),
				parts: [],
				base64Chars: 0,
			};
		}
		const transfer = this.#kittyTransfer!;
		if (transfer.accepted) {
			transfer.base64Chars += payload.length;
			if (
				transfer.base64Chars > MAX_BASE64_CHARS ||
				transfer.parts.length >= MAX_KITTY_CHUNKS ||
				this.#queuedBytes + Math.floor((transfer.base64Chars * 3) / 4) > MAX_TOTAL_IMAGE_BYTES
			) {
				transfer.accepted = false;
				transfer.parts = [];
			} else {
				transfer.parts.push(payload);
			}
		}

		if (controls.get("m") === "1") return;
		this.#kittyTransfer = undefined;
		if (!transfer.accepted || this.#encodedImages.length >= MAX_IMAGE_COUNT) return;
		const base64 = transfer.parts.join("");
		if (!isStrictBase64(base64)) return;
		const estimatedBytes = Math.floor((base64.length * 3) / 4);
		if (this.#queuedBytes + estimatedBytes > MAX_TOTAL_IMAGE_BYTES) return;
		this.#queuedBytes += estimatedBytes;
		this.#encodedImages.push({
			kind: "kitty",
			format: transfer.format,
			width: transfer.width,
			height: transfer.height,
			compression: transfer.compression,
			base64,
		});
	}

	#handleSixel(frame: string): void {
		if (this.#encodedImages.length >= MAX_IMAGE_COUNT || frame.length > MAX_SIXEL_CHARS) return;
		const bytes = latin1Bytes(`${frame}${ESC}\\`);
		if (this.#queuedBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) return;
		this.#queuedBytes += bytes.length;
		this.#encodedImages.push({ kind: "sixel", bytes });
	}

	async #decodeThrough(through: number): Promise<void> {
		while (this.#decodedCount < through) {
			const encoded = this.#encodedImages[this.#decodedCount++]!;
			try {
				const image = encoded.kind === "sixel" ? await decodeSixel(encoded.bytes) : await decodeKitty(encoded);
				if (!image) continue;
				const bytes = Buffer.from(image.data, "base64").length;
				if (bytes > MAX_IMAGE_INPUT_BYTES || this.#decodedImageBytes + bytes > MAX_TOTAL_IMAGE_BYTES) continue;
				this.#decodedImageBytes += bytes;
				this.#decodedImages.push(image);
			} catch {
				// Graphics in command output is untrusted. A bad frame is omitted while
				// surrounding text and later valid frames remain usable.
			}
		}
	}
}

/** Encode an image as a Kitty direct PNG transmission. */
export async function encodeTerminalImage(image: ImageContent): Promise<string> {
	const sourceBytes = Buffer.from(image.data, "base64");
	if (sourceBytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("Terminal image exceeds the 20 MiB limit");
	let png: ImageContent;
	if (image.mimeType === "image/png") {
		png = await normalizePng(sourceBytes);
	} else {
		const sourceMetadata = await new Bun.Image(sourceBytes, { maxPixels: MAX_IMAGE_PIXELS }).metadata();
		if (!dimensionsAllowed(sourceMetadata.width, sourceMetadata.height)) {
			throw new Error("Terminal image dimensions exceed the encode limit");
		}
		png = await convertImageToPng(image);
	}
	const bytes = Buffer.from(png.data, "base64");
	if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("Encoded terminal PNG exceeds the 20 MiB limit");
	await validatePng(bytes);

	const chunks: string[] = [];
	const count = Math.max(1, Math.ceil(bytes.length / KITTY_CHUNK_BYTES));
	for (let index = 0; index < count; index++) {
		const payload = bytes.subarray(index * KITTY_CHUNK_BYTES, (index + 1) * KITTY_CHUNK_BYTES).toString("base64");
		const more = index + 1 < count ? 1 : 0;
		const controls = index === 0 ? `a=T,t=d,f=100,q=2,m=${more}` : `m=${more}`;
		chunks.push(`${ESC}_G${controls};${payload}${ESC}\\`);
	}
	return chunks.join("");
}

async function decodeSixel(bytes: Uint8Array): Promise<ImageContent | undefined> {
	const png = decodeSixelToPng(bytes);
	if (png.length > MAX_IMAGE_INPUT_BYTES) return undefined;
	return normalizePng(png);
}

async function decodeKitty(encoded: Extract<EncodedImage, { kind: "kitty" }>): Promise<ImageContent | undefined> {
	if (encoded.format !== 100 && encoded.format !== 24 && encoded.format !== 32) return undefined;
	const width = encoded.width;
	const height = encoded.height;
	const channels = encoded.format === 24 ? 3 : 4;
	const expected =
		encoded.format === 100
			? undefined
			: width && height && dimensionsAllowed(width, height)
				? width * height * channels
				: undefined;
	if (encoded.format !== 100 && (!expected || expected > MAX_IMAGE_INPUT_BYTES)) return undefined;

	let bytes: Uint8Array = Buffer.from(encoded.base64, "base64");
	if (encoded.compression) {
		if (encoded.compression !== "z") return undefined;
		bytes = inflateSync(bytes, { maxOutputLength: expected ?? MAX_IMAGE_INPUT_BYTES });
	}
	if (bytes.length > MAX_IMAGE_INPUT_BYTES) return undefined;
	if (encoded.format === 100) return normalizePng(bytes);
	if (bytes.length !== expected) return undefined;
	const png = encodeRawPng(bytes, width!, height!, channels);
	if (png.length > MAX_IMAGE_INPUT_BYTES) return undefined;
	return normalizePng(png);
}

async function normalizePng(bytes: Uint8Array): Promise<ImageContent> {
	await validatePng(bytes);
	return convertImageToPng({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" });
}

async function validatePng(bytes: Uint8Array): Promise<void> {
	if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
		throw new Error("Terminal image is not a PNG");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error("PNG is missing IHDR");
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (!dimensionsAllowed(width, height)) throw new Error("PNG dimensions exceed the terminal image limit");
	const metadata = await new Bun.Image(bytes, { maxPixels: MAX_IMAGE_PIXELS }).metadata();
	if (metadata.format !== "png" || metadata.width !== width || metadata.height !== height) {
		throw new Error("PNG metadata is inconsistent");
	}
}

function dimensionsAllowed(width: number, height: number): boolean {
	return (
		Number.isSafeInteger(width) &&
		Number.isSafeInteger(height) &&
		width > 0 &&
		height > 0 &&
		width <= MAX_IMAGE_EDGE &&
		height <= MAX_IMAGE_EDGE &&
		width * height <= MAX_IMAGE_PIXELS
	);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/u.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isStrictBase64(value: string): boolean {
	if (value.length === 0 || value.length % 4 !== 0) return false;
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function latin1Bytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
	return bytes;
}

function encodeRawPng(bytes: Uint8Array, width: number, height: number, channels: 3 | 4): Uint8Array {
	const stride = width * channels;
	const scanlines = Buffer.allocUnsafe((stride + 1) * height);
	for (let row = 0; row < height; row++) {
		const outputOffset = row * (stride + 1);
		scanlines[outputOffset] = 0;
		scanlines.set(bytes.subarray(row * stride, (row + 1) * stride), outputOffset + 1);
	}
	const header = Buffer.allocUnsafe(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = channels === 3 ? 2 : 6;
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", new Uint8Array()),
	]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const chunk = Buffer.allocUnsafe(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, 4, "ascii");
	chunk.set(data, 8);
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
	return chunk;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
	crcTable ??= makeCrcTable();
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
}
