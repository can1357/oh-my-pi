/**
 * Image model catalog.
 *
 * Leaf module (no runtime deps) shared by the image_gen tool, the settings
 * schema, and the tool prompt — mirrors `image-providers.ts` conventions.
 *
 * Model-first selection: each catalog entry curates a flagship model and the
 * ordered backend bindings (provider → endpoint/model id) that serve it. Uncurated
 * ids reach any FAL endpoint or OpenRouter image model via the `fal:`/`openrouter:`
 * raw-reference forms resolved through runtime discovery (see `image-targets.ts`).
 *
 * All ids and per-binding knob sets below were verified live against the FAL queue
 * OpenAPI (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`) and
 * OpenRouter's `/api/v1/images/models` list.
 */

import type { ImageProvider } from "./image-providers";

export type ImageResolution = "512" | "1K" | "2K" | "4K";
export type ImageAspectRatio =
	| "auto"
	| "1:1"
	| "16:9"
	| "9:16"
	| "4:3"
	| "3:4"
	| "3:2"
	| "2:3"
	| "4:5"
	| "5:4"
	| "21:9"
	| "9:21"
	| "2:1"
	| "1:2"
	| "20:9"
	| "19.5:9"
	| "9:20"
	| "9:19.5";
export type ImageOutputFormat = "png" | "jpeg" | "webp" | "svg";
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageBackground = "auto" | "transparent" | "opaque";

/** How a binding expresses output dimensions. */
export type ImageSizeMode = "aspect_ratio" | "image_size" | "hosted_pixels";

export interface ImagePixelConstraints {
	readonly minWidth: number;
	readonly maxWidth: number;
	readonly minHeight: number;
	readonly maxHeight: number;
	/** Minimum output area when the provider exposes an area floor. */
	readonly minArea?: number;
	readonly maxArea: number;
	readonly multipleOf: number;
}

export interface ImageBinding {
	readonly provider: ImageProvider;
	/** FAL endpoint id, OpenRouter/Gemini/xAI/Antigravity model id, or "hosted" for the OpenAI Responses path. */
	readonly generate: string;
	/** Separate edit endpoint/model. Absent means the binding cannot accept input images. */
	readonly edit?: string;
	/** FAL request field used for uploaded edit images; plural is the default. */
	readonly inputImageField?: "image_urls" | "image_url";
	readonly sizeMode: ImageSizeMode;
	readonly aspectRatios?: readonly ImageAspectRatio[];
	readonly resolutions?: readonly ImageResolution[];
	/** Canonical resolution tier → provider wire value for discovered schemas. */
	readonly resolutionWireValues?: Partial<Record<ImageResolution, string>>;
	readonly pixels?: ImagePixelConstraints;
	readonly maxImages: number;
	readonly maxReferences: number;
	readonly outputFormats?: readonly ImageOutputFormat[];
	/** Discovered quality values; omitted for static boolean-only bindings. */
	readonly qualityValues?: readonly ImageQuality[];
	/** Discovered background values; omitted for static boolean-only bindings. */
	readonly backgroundValues?: readonly ImageBackground[];
	readonly supportsSeed: boolean;
	readonly supportsQuality: boolean;
	readonly supportsBackground: boolean;
}

export interface ImageModelEntry {
	readonly id: string;
	readonly label: string;
	/** One line for the tool prompt table. */
	readonly summary: string;
	readonly bindings: readonly ImageBinding[];
}

export const IMAGE_RESOLUTION_AREA: Record<ImageResolution, number> = {
	"512": 262_144,
	"1K": 1_048_576,
	"2K": 4_194_304,
	"4K": 16_777_216,
};

/**
 * Conservative fallback when an endpoint's `image_size` member exposes no
 * `x-fal` constraints: 256–2048 per axis, 4 MP total, multiple of 8.
 */
export const FALLBACK_PIXELS: ImagePixelConstraints = {
	minWidth: 256,
	maxWidth: 2048,
	minHeight: 256,
	maxHeight: 2048,
	maxArea: 4_194_304,
	multipleOf: 8,
};

// FAL GPT Image 2 image_size bounds from the endpoint schema: concrete
// dimensions are multiples of 16, max edge 3840, and total area is
// 0.655–8.294 MP. The endpoint exposes no 512/4K resolution enum.
const GPT_FAL_PIXELS: ImagePixelConstraints = {
	minWidth: 16,
	maxWidth: 3840,
	minHeight: 16,
	maxHeight: 3840,
	minArea: 655_360,
	maxArea: 8_294_400,
	multipleOf: 16,
};

// Google's Gemini Image `ImageConfig` supports exactly these aspect ratios.
const GEMINI_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
];
// FAL's Nano Banana endpoints accept `auto` plus the provider's documented
// ratio set; this is intentionally separate from Gemini's ImageConfig list.
const FAL_NANO_BANANA_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
	"auto",
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
];

// Existing OpenAI Responses hosted-image tool always requests WebP output.
const OPENAI_HOSTED_OUTPUT_FORMATS: readonly ImageOutputFormat[] = ["webp"];

// Gemini 3 Pro's `ImageConfig.imageSize` supports 1K, 2K, and 4K.
const GEMINI_RESOLUTIONS: readonly ImageResolution[] = ["1K", "2K", "4K"];

// Existing OpenAI Responses hosted-image tool size mapping (5 ratios).
const OPENAI_HOSTED_ASPECT_RATIOS: readonly ImageAspectRatio[] = ["1:1", "3:4", "4:3", "9:16", "16:9"];

// xAI direct (api.x.ai) aspect ratio set — matches the pre-catalog XAI_IMAGE_ASPECT_RATIOS.
const XAI_DEFAULT_ASPECT_RATIOS: readonly ImageAspectRatio[] = ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3"];

export const IMAGE_MODEL_CATALOG: readonly ImageModelEntry[] = [
	{
		id: "nano-banana-pro",
		label: "Nano Banana Pro (Gemini 3 Pro Image)",
		summary: "Google's flagship image model: aspect_ratio + resolution 1K/2K/4K, seed, edits",
		bindings: [
			{
				provider: "gemini",
				generate: "gemini-3-pro-image-preview",
				edit: "gemini-3-pro-image-preview",
				sizeMode: "aspect_ratio",
				aspectRatios: GEMINI_ASPECT_RATIOS,
				resolutions: GEMINI_RESOLUTIONS,
				maxImages: 1,
				maxReferences: 14,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "antigravity",
				generate: "gemini-3-pro-image",
				edit: "gemini-3-pro-image",
				sizeMode: "aspect_ratio",
				aspectRatios: GEMINI_ASPECT_RATIOS,
				resolutions: GEMINI_RESOLUTIONS,
				maxImages: 1,
				maxReferences: 14,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "openrouter",
				generate: "google/gemini-3-pro-image",
				edit: "google/gemini-3-pro-image",
				sizeMode: "aspect_ratio",
				aspectRatios: GEMINI_ASPECT_RATIOS,
				resolutions: ["1K", "2K", "4K"],
				maxImages: 1,
				maxReferences: 14,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "fal-ai/nano-banana-pro",
				edit: "fal-ai/nano-banana-pro/edit",
				sizeMode: "aspect_ratio",
				aspectRatios: FAL_NANO_BANANA_ASPECT_RATIOS,
				resolutions: ["1K", "2K", "4K"],
				maxImages: 4,
				maxReferences: 4,
				outputFormats: ["jpeg", "png", "webp"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "nano-banana-2",
		label: "Nano Banana 2 (Gemini 3.1 Flash Image)",
		summary: "Google's flash-tier image model: aspect_ratio + resolution, seed, edits",
		bindings: [
			{
				provider: "openrouter",
				generate: "google/gemini-3.1-flash-image",
				edit: "google/gemini-3.1-flash-image",
				sizeMode: "aspect_ratio",
				aspectRatios: GEMINI_ASPECT_RATIOS,
				resolutions: ["512", "1K", "2K", "4K"],
				maxImages: 1,
				maxReferences: 14,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "fal-ai/nano-banana-2",
				edit: "fal-ai/nano-banana-2/edit",
				sizeMode: "aspect_ratio",
				aspectRatios: FAL_NANO_BANANA_ASPECT_RATIOS,
				resolutions: ["512", "1K", "2K", "4K"],
				resolutionWireValues: { "512": "0.5K" },
				maxImages: 4,
				maxReferences: 4,
				outputFormats: ["jpeg", "png", "webp"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "gpt-image-2",
		label: "GPT Image 2",
		summary: "OpenAI's GPT Image 2 (hosted/OpenRouter/FAL): quality, background, edits",
		bindings: [
			{
				provider: "openai",
				generate: "hosted",
				edit: "hosted",
				sizeMode: "hosted_pixels",
				aspectRatios: OPENAI_HOSTED_ASPECT_RATIOS,
				outputFormats: OPENAI_HOSTED_OUTPUT_FORMATS,
				maxImages: 1,
				maxReferences: 4,
				qualityValues: ["auto", "low", "medium", "high"],
				backgroundValues: ["auto", "opaque"],
				supportsSeed: false,
				supportsQuality: true,
				supportsBackground: true,
			},
			{
				provider: "openai-codex",
				generate: "hosted",
				edit: "hosted",
				sizeMode: "hosted_pixels",
				aspectRatios: OPENAI_HOSTED_ASPECT_RATIOS,
				outputFormats: OPENAI_HOSTED_OUTPUT_FORMATS,
				maxImages: 1,
				maxReferences: 4,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "openrouter",
				generate: "openai/gpt-image-2",
				edit: "openai/gpt-image-2",
				sizeMode: "aspect_ratio",
				aspectRatios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
				maxImages: 10,
				maxReferences: 16,
				supportsSeed: false,
				qualityValues: ["auto", "low", "medium", "high"],
				backgroundValues: ["auto", "opaque"],
				supportsQuality: true,
				supportsBackground: true,
			},
			{
				provider: "fal",
				generate: "openai/gpt-image-2",
				edit: "openai/gpt-image-2/edit",
				sizeMode: "image_size",
				// FAL GPT Image 2 image_size bounds from the endpoint schema:
				// dimensions are multiples of 16, max edge 3840, and total
				// area is 0.655–8.294 MP.
				pixels: GPT_FAL_PIXELS,
				resolutions: ["1K", "2K"],
				maxImages: 4,
				maxReferences: 16,
				outputFormats: ["jpeg", "png", "webp"],
				qualityValues: ["auto", "low", "medium", "high"],
				supportsSeed: false,
				supportsQuality: true,
				supportsBackground: false,
			},
		],
	},
	{
		id: "flux-2-pro",
		label: "FLUX.2 Pro",
		summary: "Black Forest Labs FLUX.2 Pro: image_size (≤2560², 4 MP), seed, edits",
		bindings: [
			{
				provider: "fal",
				generate: "fal-ai/flux-2-pro",
				edit: "fal-ai/flux-2-pro/edit",
				sizeMode: "image_size",
				pixels: {
					minWidth: 256,
					maxWidth: 2560,
					minHeight: 256,
					maxHeight: 2560,
					maxArea: 4_194_304,
					multipleOf: 16,
				},
				resolutions: ["512", "1K", "2K"],
				maxImages: 1,
				maxReferences: 4,
				outputFormats: ["jpeg", "png"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "openrouter",
				generate: "black-forest-labs/flux.2-pro",
				edit: "black-forest-labs/flux.2-pro",
				sizeMode: "aspect_ratio",
				aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
				maxImages: 1,
				maxReferences: 8,
				outputFormats: ["png", "jpeg"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "deepinfra",
				generate: "black-forest-labs/FLUX-2-pro",
				sizeMode: "hosted_pixels",
				aspectRatios: OPENAI_HOSTED_ASPECT_RATIOS,
				maxImages: 1,
				maxReferences: 0,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "flux-2-max",
		label: "FLUX.2 Max",
		summary: "Black Forest Labs FLUX.2 Max: image_size (≤2560², 4 MP), seed, edits",
		bindings: [
			{
				provider: "fal",
				generate: "fal-ai/flux-2-max",
				edit: "fal-ai/flux-2-max/edit",
				sizeMode: "image_size",
				pixels: {
					minWidth: 256,
					maxWidth: 2560,
					minHeight: 256,
					maxHeight: 2560,
					maxArea: 4_194_304,
					multipleOf: 16,
				},
				resolutions: ["512", "1K", "2K"],
				maxImages: 1,
				maxReferences: 4,
				outputFormats: ["jpeg", "png"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "openrouter",
				generate: "black-forest-labs/flux.2-max",
				edit: "black-forest-labs/flux.2-max",
				sizeMode: "aspect_ratio",
				aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
				maxImages: 1,
				maxReferences: 8,
				outputFormats: ["png", "jpeg"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "seedream-4.5",
		label: "Seedream 4.5",
		summary: "ByteDance Seedream 4.5: high-res image_size (≥1920px), seed, edits",
		bindings: [
			{
				provider: "openrouter",
				generate: "bytedance-seed/seedream-4.5",
				edit: "bytedance-seed/seedream-4.5",
				sizeMode: "aspect_ratio",
				aspectRatios: [
					"auto",
					"1:1",
					"1:2",
					"2:1",
					"2:3",
					"3:2",
					"3:4",
					"4:3",
					"4:5",
					"5:4",
					"9:16",
					"16:9",
					"21:9",
					"9:21",
				],
				resolutions: ["1K", "2K", "4K"],
				maxImages: 10,
				maxReferences: 14,
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "fal-ai/bytedance/seedream/v4.5/text-to-image",
				edit: "fal-ai/bytedance/seedream/v4.5/edit",
				sizeMode: "image_size",
				// FAL seedream v4.5 image_size has no x-fal block → fallback bounds.
				// (Actual endpoint: dims 1920–4096 or area ≥ 2560x1440; misses surface as provider errors.)
				pixels: FALLBACK_PIXELS,
				resolutions: ["512", "1K", "2K"],
				maxImages: 4,
				maxReferences: 4,
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "seedream-5-pro",
		label: "Seedream 5 Pro",
		summary: "ByteDance Seedream 5 Pro: image_size (1–4 MP area), edits",
		bindings: [
			{
				provider: "fal",
				generate: "bytedance/seedream/v5/pro/text-to-image",
				edit: "bytedance/seedream/v5/pro/edit",
				sizeMode: "image_size",
				pixels: {
					// Seedream v5 declares area bounds, not per-axis bounds.
					minWidth: 256,
					maxWidth: 4096,
					minHeight: 256,
					maxHeight: 4096,
					minArea: 1_048_576,
					maxArea: 4_194_304,
					multipleOf: 8,
				},
				resolutions: ["1K", "2K"],
				maxImages: 6,
				maxReferences: 10,
				outputFormats: ["jpeg", "png"],
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "qwen-image-3",
		label: "Qwen Image 3",
		summary: "Alibaba Qwen Image 3: image_size (512–2048²), seed, edits",
		bindings: [
			{
				provider: "openrouter",
				generate: "qwen/qwen-image-3",
				edit: "qwen/qwen-image-3",
				sizeMode: "aspect_ratio",
				aspectRatios: ["1:1", "1:2", "2:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"],
				resolutions: ["1K", "2K"],
				maxImages: 6,
				maxReferences: 4,
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "alibaba/qwen-image-3/text-to-image",
				edit: "alibaba/qwen-image-3/edit",
				sizeMode: "image_size",
				pixels: {
					minWidth: 512,
					maxWidth: 2048,
					minHeight: 512,
					maxHeight: 2048,
					maxArea: 4_194_304,
					multipleOf: 8,
				},
				resolutions: ["512", "1K", "2K"],
				maxImages: 4,
				maxReferences: 4,
				outputFormats: ["jpeg", "png", "webp"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "recraft-v4",
		label: "Recraft V4",
		summary: "Recraft V4: image_size, single image",
		bindings: [
			{
				provider: "openrouter",
				generate: "recraft/recraft-v4",
				edit: "recraft/recraft-v4",
				sizeMode: "aspect_ratio",
				aspectRatios: ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"],
				maxImages: 6,
				maxReferences: 1,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "fal-ai/recraft/v4/text-to-image",
				sizeMode: "image_size",
				// FAL recraft v4 image_size has no x-fal block → fallback bounds.
				pixels: FALLBACK_PIXELS,
				resolutions: ["512", "1K", "2K"],
				maxImages: 1,
				maxReferences: 0,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "recraft-v4-vector",
		label: "Recraft V4 Vector",
		summary: "Recraft vector output (SVG): image_size, single image",
		bindings: [
			{
				provider: "openrouter",
				generate: "recraft/recraft-v4-vector",
				edit: "recraft/recraft-v4-vector",
				sizeMode: "aspect_ratio",
				aspectRatios: ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"],
				maxImages: 6,
				maxReferences: 1,
				outputFormats: ["svg"],
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "fal-ai/recraft/v4/text-to-vector",
				sizeMode: "image_size",
				pixels: FALLBACK_PIXELS,
				resolutions: ["512", "1K", "2K"],
				maxImages: 1,
				maxReferences: 0,
				outputFormats: ["svg"],
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "krea-2-large",
		label: "Krea 2 Large",
		summary: "Krea 2 Large: aspect_ratio + seed, single image",
		bindings: [
			{
				provider: "openrouter",
				generate: "krea/krea-2-large",
				edit: "krea/krea-2-large",
				sizeMode: "aspect_ratio",
				aspectRatios: ["1:1", "4:3", "3:2", "16:9", "4:5", "2:3", "9:16"],
				resolutions: ["1K"],
				maxImages: 1,
				maxReferences: 1,
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "krea/v2/large/text-to-image",
				sizeMode: "aspect_ratio",
				aspectRatios: ["1:1", "4:3", "3:2", "16:9", "4:5", "2:3", "9:16"],
				maxImages: 1,
				maxReferences: 0,
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "grok-imagine",
		label: "Grok Imagine",
		summary: "xAI Grok Imagine: resolution 1K/2K, edits",
		bindings: [
			{
				provider: "xai",
				generate: "grok-imagine-image",
				edit: "grok-imagine-image",
				sizeMode: "aspect_ratio",
				aspectRatios: XAI_DEFAULT_ASPECT_RATIOS,
				resolutions: ["1K", "2K"],
				maxImages: 1,
				maxReferences: 3,
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
			{
				provider: "openrouter",
				generate: "x-ai/grok-imagine-image-2.0",
				edit: "x-ai/grok-imagine-image-2.0",
				sizeMode: "aspect_ratio",
				aspectRatios: [
					"auto",
					"1:1",
					"3:4",
					"4:3",
					"9:16",
					"16:9",
					"2:3",
					"3:2",
					"9:19.5",
					"19.5:9",
					"9:20",
					"20:9",
					"1:2",
					"2:1",
				],
				resolutions: ["1K", "2K"],
				maxImages: 1,
				maxReferences: 3,
				qualityValues: ["low", "medium"],
				supportsSeed: false,
				supportsQuality: true,
				supportsBackground: false,
			},
			{
				provider: "fal",
				generate: "xai/grok-imagine-image",
				edit: "xai/grok-imagine-image/edit",
				sizeMode: "aspect_ratio",
				aspectRatios: [
					"2:1",
					"20:9",
					"19.5:9",
					"16:9",
					"4:3",
					"3:2",
					"1:1",
					"2:3",
					"3:4",
					"9:16",
					"9:19.5",
					"9:20",
					"1:2",
				],
				resolutions: ["1K", "2K"],
				maxImages: 4,
				maxReferences: 4,
				outputFormats: ["jpeg", "png", "webp"],
				supportsSeed: false,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
	{
		id: "flux-schnell",
		label: "FLUX.1 Schnell",
		summary: "Cheap FLUX.1 Schnell draft: image_size, seed — generation only",
		bindings: [
			{
				provider: "fal",
				generate: "fal-ai/flux/schnell",
				sizeMode: "image_size",
				pixels: FALLBACK_PIXELS,
				resolutions: ["512", "1K", "2K"],
				maxImages: 4,
				maxReferences: 0,
				outputFormats: ["jpeg", "png"],
				supportsSeed: true,
				supportsQuality: false,
				supportsBackground: false,
			},
		],
	},
];

/** Per-provider default entry id used by the credential walk when no model was named. */
export const DEFAULT_IMAGE_MODEL_BY_PROVIDER: Record<ImageProvider, string> = {
	openai: "gpt-image-2",
	"openai-codex": "gpt-image-2",
	antigravity: "nano-banana-pro",
	xai: "grok-imagine",
	openrouter: "nano-banana-pro",
	gemini: "nano-banana-pro",
	fal: "nano-banana-pro",
	deepinfra: "flux-2-pro",
};

const CATALOG_BY_ID: Record<string, ImageModelEntry> = Object.fromEntries(
	IMAGE_MODEL_CATALOG.map(entry => [entry.id, entry]),
);

export function findImageModelEntry(id: string): ImageModelEntry | undefined {
	return CATALOG_BY_ID[id];
}

/**
 * Parses `fal:<endpoint-id>` / `openrouter:<model-id>` raw references.
 * Returns null for anything else (catalog aliases, unknown ids).
 */
export function parseRawImageModelRef(value: string): { provider: ImageProvider; id: string } | null {
	const colon = value.indexOf(":");
	if (colon === -1) return null;
	const prefix = value.slice(0, colon);
	const id = value.slice(colon + 1);
	if (prefix === "fal" || prefix === "openrouter") {
		return { provider: prefix, id };
	}
	return null;
}
