import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Context, ImageContent, Message, Model, ProviderPayload, TextContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import {
	formatBytes,
	isRecord,
	logger,
	parseImageMetadata,
	readImageMetadata,
	SUPPORTED_IMAGE_MIME_TYPES,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;
/** Largest edge rasterized from SVG before it enters the image pipeline. */
const SVG_IMAGE_MAX_EDGE_PX = 2048;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE = 64 * 1024 * 1024;
const MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES = 128;
type NormalizedImagePayload = Pick<ImageContent, "data" | "mimeType">;
const modelBoundaryImageCache = new LRUCache<string, NormalizedImagePayload | null>({
	max: MODEL_BOUNDARY_IMAGE_CACHE_MAX_ENTRIES,
	maxSize: MODEL_BOUNDARY_IMAGE_CACHE_MAX_SIZE,
	sizeCalculation: payload => Math.max(1, payload?.data.length ?? 1),
});
const modelBoundaryImageNormalizations = new Map<string, Promise<NormalizedImagePayload | null>>();
const UNDECODABLE_STB_IMAGE_OMISSION_TEXT = "[image omitted: WebP could not be decoded for this model]";

function createUndecodableStbImageOmission(): TextContent {
	return { type: "text", text: UNDECODABLE_STB_IMAGE_OMISSION_TEXT };
}

function createNativeUndecodableStbImageOmission(): Record<string, unknown> {
	return { type: "input_text", text: UNDECODABLE_STB_IMAGE_OMISSION_TEXT };
}

function hasWebPMagic(data: string): boolean {
	const header = Buffer.from(data.slice(0, 16), "base64");
	return (
		header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
	);
}

function isWebPImage(image: ImageContent): boolean {
	if (typeof image.data !== "string") return false;
	const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : undefined;
	return mimeType === "image/webp" || hasWebPMagic(image.data);
}

function imageFromBase64DataUrl(imageUrl: unknown): ImageContent | undefined {
	if (typeof imageUrl !== "string" || !imageUrl.toLowerCase().startsWith("data:")) return undefined;
	const separator = ";base64,";
	const separatorIndex = imageUrl.toLowerCase().indexOf(separator);
	if (separatorIndex < 5) return undefined;
	const mimeType = imageUrl.slice(5, separatorIndex);
	if (!mimeType.toLowerCase().startsWith("image/")) return undefined;
	return { type: "image", mimeType, data: imageUrl.slice(separatorIndex + separator.length) };
}

function modelBoundaryImageCacheKey(image: ImageContent, resize: ImageResizeOptions | undefined): string {
	const resizeKey = JSON.stringify([
		resize?.maxWidth,
		resize?.maxHeight,
		resize?.minDimension,
		resize?.maxBytes,
		resize?.jpegQuality,
	]);
	return `${resizeKey}:${image.mimeType}:${image.data.length}:${image.data.slice(0, 32)}:${image.data.slice(-32)}:${String(Bun.hash(image.data))}`;
}

async function memoizedStbImageNormalization(
	image: ImageContent,
	resize: ImageResizeOptions | undefined,
): Promise<ImageContent | null> {
	const key = modelBoundaryImageCacheKey(image, resize);
	const cached = modelBoundaryImageCache.get(key);
	if (cached !== undefined) return cached ? { ...image, ...cached } : null;

	let pending = modelBoundaryImageNormalizations.get(key);
	if (!pending) {
		pending = resizeImage(image, { ...resize, excludeWebP: true })
			.then(resized => {
				if (resized.mimeType === "image/webp" || hasWebPMagic(resized.data)) {
					throw new Error("Image normalization retained WebP for an STB-backed model");
				}
				return { data: resized.data, mimeType: resized.mimeType };
			})
			.catch(error => {
				logger.warn("Dropping undecodable WebP for an STB-backed model", { error: String(error) });
				return null;
			})
			.then(payload => {
				modelBoundaryImageCache.set(key, payload);
				return payload;
			})
			.finally(() => modelBoundaryImageNormalizations.delete(key));
		modelBoundaryImageNormalizations.set(key, pending);
	}
	const normalized = await pending;
	return normalized ? { ...image, ...normalized } : null;
}

async function normalizeNativeResponsesImagePart(part: unknown): Promise<unknown> {
	if (!isRecord(part) || part.type !== "input_image") return part;
	const image = imageFromBase64DataUrl(part.image_url);
	if (!image || !isWebPImage(image)) return part;
	const normalized = await memoizedStbImageNormalization(image, undefined);
	if (!normalized) return createNativeUndecodableStbImageOmission();
	return { ...part, image_url: `data:${normalized.mimeType};base64,${normalized.data}` };
}

async function normalizeNativeResponsesItem(item: Record<string, unknown>): Promise<Record<string, unknown>> {
	const normalizedItem = await normalizeNativeResponsesImagePart(item);
	if (normalizedItem !== item) return normalizedItem as Record<string, unknown>;
	if (!Array.isArray(item.content)) return item;

	let content: unknown[] | undefined;
	for (let index = 0; index < item.content.length; index++) {
		const part = item.content[index];
		const normalizedPart = await normalizeNativeResponsesImagePart(part);
		if (normalizedPart !== part) content ??= item.content.slice(0, index);
		content?.push(normalizedPart);
	}
	return content ? { ...item, content } : item;
}

async function normalizeNativeResponsesHistoryPayload(
	payload: ProviderPayload | undefined,
): Promise<ProviderPayload | undefined> {
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return payload;
	let items: Array<Record<string, unknown>> | undefined;
	for (let index = 0; index < payload.items.length; index++) {
		const item = payload.items[index]!;
		const normalizedItem = await normalizeNativeResponsesItem(item);
		if (normalizedItem !== item) items ??= payload.items.slice(0, index);
		items?.push(normalizedItem);
	}
	return items ? { ...payload, items } : payload;
}

/**
 * Ollama and its local-backend family decode image input through llama.cpp /
 * `stb_image`, which is compiled without WebP support, so a WebP upload fails
 * with an opaque HTTP 400. Detect those models so the resize pipeline encodes
 * to PNG/JPEG instead — the automatic equivalent of `OMP_NO_WEBP=1`.
 */
export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

/**
 * `true` when `model` cannot decode WebP, otherwise `undefined` so the
 * `OMP_NO_WEBP` env fallback in {@link resizeImage} still applies. Feed straight
 * into {@link ImageResizeOptions.excludeWebP}.
 */
export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

/** Options for loading an in-memory chat image attachment as a vision-model input. */
export interface LoadImageAttachmentInputOptions {
	image: ImageContent;
	label: string;
	uri: string;
	autoResize: boolean;
	maxBytes?: number;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

/**
 * Raised when image bytes cannot be decoded — a truncated stream, a payload
 * with a hole in the middle, or bytes that are not the container they claim.
 * Failing at ingress keeps them out of the transcript, where they would
 * otherwise be persisted and rejected by the provider on every later request,
 * with no way to resume the session.
 */
export class InvalidImageDataError extends Error {
	readonly reason: string;

	constructor(label: string, mimeType: string, reason: string) {
		super(`${label} is not a decodable ${mimeType} image: ${reason}`);
		this.name = "InvalidImageDataError";
		this.reason = reason;
	}
}

/**
 * Smallest raster the decode probe terminates into. The decode is the oracle,
 * so the output size cannot change the verdict — a 1x1 sink keeps the check
 * from allocating a full-size pixel buffer, a full-size PNG, and a base64
 * string for a payload that may be up to {@link MAX_IMAGE_INPUT_BYTES}.
 */
const DECODE_PROBE_EDGE_PX = 1;

/**
 * Why an image cannot be decoded, or `null` when it decodes.
 *
 * A full decode is the only check that matches what vision backends accept: a
 * middle-elided PNG keeps its signature, its header, and even a well-formed
 * `IEND` trailer, so header sniffing and chunk-framing walks both pass it —
 * while real-world images that decoders render happily do have odd framing, so
 * a structural walk rejects payloads providers accept. Decoding is the ground
 * truth on both sides. Callers on hot paths must cache the verdict.
 */
export async function imageDecodeFailureReason(image: ImageContent): Promise<string | null> {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return "invalid base64 image data";
	const normalizedData = image.data.replace(/=+$/, "");
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length === 0) return "empty image data";
	if (bytes.toString("base64").replace(/=+$/, "") !== normalizedData) return "invalid base64 image data";
	const detected = parseImageMetadata(bytes);
	if (detected && detected.mimeType !== image.mimeType.toLowerCase()) {
		return `declared ${image.mimeType} but contains ${detected.mimeType}`;
	}
	try {
		// Decode in full (that is what catches a hole in the compressed stream),
		// then terminate into a 1x1 raster's bytes instead of re-encoding at the
		// source dimensions and base64-ing a result nobody reads.
		await new Bun.Image(bytes).resize(DECODE_PROBE_EDGE_PX, DECODE_PROBE_EDGE_PX).png().bytes();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

interface LoadInMemoryImageInputOptions {
	image: ImageContent;
	resolvedPath: string;
	textNotePrefix: string;
	autoResize: boolean;
	maxBytes: number;
	excludeWebP: boolean | undefined;
}

async function loadInMemoryImageInput(options: LoadInMemoryImageInputOptions): Promise<LoadedImageInput> {
	const inputBytes = Buffer.byteLength(options.image.data, "base64");
	if (inputBytes > options.maxBytes) {
		throw new ImageInputTooLargeError(inputBytes, options.maxBytes);
	}

	// Decode before anything else: a payload that cannot be decoded is rejected
	// by the provider for the whole request, so it must fail here — where the
	// caller still has a path to act on — instead of entering the transcript.
	const decodeFailure = await imageDecodeFailureReason(options.image);
	if (decodeFailure !== null) {
		throw new InvalidImageDataError(options.resolvedPath, options.image.mimeType, decodeFailure);
	}

	let outputData = options.image.data;
	let outputMimeType = options.image.mimeType;
	let outputBytes = inputBytes;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = options.excludeWebP === true && options.image.mimeType === "image/webp";
	if (options.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(options.image, { excludeWebP: options.excludeWebP });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// Keep the original image when resize fails.
		}
	}

	let textNote = `${options.textNotePrefix} [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: options.resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch {
		return null;
	}
}

export interface NormalizeModelContextImagesOptions {
	/** Model the images are bound for; used to derive encoder constraints (WebP exclusion for Ollama). */
	model?: Model;
	resize?: ImageResizeOptions;
}

/**
 * Normalize image blocks before they enter agent/model context. This keeps
 * provider request construction from having to resize an unbounded batch of
 * large images on the streaming hot path. Images are processed sequentially on
 * purpose: `resizeImage` may fan out multiple encoders for one image, so the
 * outer image batch must stay bounded.
 */
export async function normalizeModelContextImages(
	images: ImageContent[] | undefined,
	options?: NormalizeModelContextImagesOptions,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const excludesWebP = modelLacksWebpSupport(options?.model);
	const resize: ImageResizeOptions | undefined = excludesWebP
		? { ...options?.resize, excludeWebP: true }
		: options?.resize;
	const normalized: ImageContent[] = [];
	for (const image of images) {
		try {
			if (excludesWebP && isWebPImage(image)) {
				const converted = await memoizedStbImageNormalization(image, options?.resize);
				// Mixed-content callers reassemble normalized images positionally, so
				// preserve one output slot per input. The provider-boundary pass replaces
				// an undecodable WebP with an omission note before dispatch.
				normalized.push(converted ?? image);
				continue;
			}
			const resized = await resizeImage(image, resize);
			normalized.push({ ...image, data: resized.data, mimeType: resized.mimeType });
		} catch {
			// Preserve existing caller behavior for decode/resize failures: keep the
			// user's image block rather than dropping it from the turn.
			normalized.push(image);
		}
	}
	return normalized;
}

/**
 * Rewrites historical/resumed WebP blocks in the ephemeral provider request.
 * Persisted session messages remain untouched, while STB-backed local servers
 * never receive a format they cannot decode.
 */
export async function normalizeModelContextMessages(messages: Message[], model: Model | undefined): Promise<Message[]> {
	if (!modelLacksWebpSupport(model)) return messages;
	let output: Message[] | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]!;
		const hasNativePayload = message.role === "user" || message.role === "developer";
		const normalizedProviderPayload = hasNativePayload
			? await normalizeNativeResponsesHistoryPayload(message.providerPayload)
			: undefined;
		const providerPayloadChanged = hasNativePayload && normalizedProviderPayload !== message.providerPayload;
		let content: Array<(typeof message.content)[number]> | undefined;
		if (typeof message.content !== "string") {
			for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
				const part = message.content[partIndex]!;
				if (part.type !== "image" || !isWebPImage(part)) {
					content?.push(part);
					continue;
				}
				content ??= message.content.slice(0, partIndex);
				const normalized = await memoizedStbImageNormalization(part, undefined);
				content.push(normalized ?? createUndecodableStbImageOmission());
			}
		}
		if (!content && !providerPayloadChanged) continue;
		output ??= messages.slice();
		const normalizedMessage = { ...message, ...(content ? { content } : {}) } as Message;
		if (normalizedMessage.role === "user" || normalizedMessage.role === "developer") {
			if (providerPayloadChanged) {
				normalizedMessage.providerPayload = normalizedProviderPayload;
			} else if (content) {
				// Native Responses history takes precedence over message content. If an
				// image changed but no matching native image was found, discard the opaque
				// replay payload rather than risk resending stale bytes.
				delete normalizedMessage.providerPayload;
			}
		}
		output[messageIndex] = normalizedMessage;
	}
	return output ?? messages;
}

/** Normalizes historical image blocks in an ephemeral provider request. */
export async function normalizeProviderContextImagesForModel(context: Context, model: Model): Promise<Context> {
	const messages = await normalizeModelContextMessages(context.messages, model);
	return messages === context.messages ? context : { ...context, messages };
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	return loadInMemoryImageInput({
		image: { type: "image", data: inputBuffer.toBase64(), mimeType },
		resolvedPath,
		textNotePrefix: "Read image file",
		autoResize: options.autoResize,
		maxBytes,
		excludeWebP: options.excludeWebP,
	});
}

/** Rasterizes an explicitly selected local SVG/SVGZ into a vision-model image input. */
export async function loadSvgImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const extension = path.extname(resolvedPath).toLowerCase();
	if (extension !== ".svg" && extension !== ".svgz") return null;

	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const source = await fs.readFile(resolvedPath);
	if (source.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(source.byteLength, maxBytes);
	}

	let png: Uint8Array;
	try {
		png = await rasterizeSvg(source, SVG_IMAGE_MAX_EDGE_PX, SVG_IMAGE_MAX_EDGE_PX);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not rasterize SVG: ${message}`);
	}

	return loadInMemoryImageInput({
		image: {
			type: "image",
			data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64"),
			mimeType: "image/png",
		},
		resolvedPath,
		textNotePrefix: "Read SVG file",
		autoResize: options.autoResize,
		maxBytes,
		excludeWebP: options.excludeWebP,
	});
}

/** Loads a chat attachment image through the same size and encoder policy as file-backed image inputs. */
export async function loadImageAttachmentInput(
	options: LoadImageAttachmentInputOptions,
): Promise<LoadedImageInput | null> {
	if (!SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(options.image.mimeType)) {
		return null;
	}

	return loadInMemoryImageInput({
		image: options.image,
		resolvedPath: options.uri,
		textNotePrefix: `Read image attachment ${options.label}`,
		autoResize: options.autoResize,
		maxBytes: options.maxBytes ?? MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}
