/**
 * Image target resolution, size math, capability validation, and runtime
 * discovery for the `generate_image` tool.
 *
 * Resolves a requested model/`providers.imageModel`/provider order into an
 * ordered list of concrete backend targets (binding + endpoint). Capability
 * validation is fail-closed: requested knobs a binding does not declare throw
 * {@link ImageCapabilityError} before any HTTP request, so the fallback ladder
 * avoids silent model substitution.
 *
 * Discovery is in-memory only (module-level maps; no disk, no TTL). A remote
 * FAL job that is already accepted throws {@link ImageJobError} which the
 * ladder must not swallow.
 */

import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_IMAGE_MODEL_BY_PROVIDER,
	FALLBACK_PIXELS,
	findImageModelEntry,
	IMAGE_MODEL_CATALOG,
	IMAGE_RESOLUTION_AREA,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageBinding,
	type ImageModelEntry,
	type ImageOutputFormat,
	type ImagePixelConstraints,
	type ImageQuality,
	type ImageResolution,
	parseRawImageModelRef,
} from "./image-models";
import type { ImageProvider } from "./image-providers";

/** Thrown before any HTTP request when a requested knob/model is unsupported. Never a ProviderHttpError, so it fails closed. */
export class ImageCapabilityError extends Error {}

/** Thrown after a remote job was accepted (FAL request_id exists). Stops the fallback ladder. */
export class ImageJobError extends Error {
	constructor(
		message: string,
		readonly requestId: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

export interface ImageTarget {
	readonly entryId: string;
	readonly binding: ImageBinding;
	readonly action: "generate" | "edit" | "unsupported-edit";
	/** Endpoint/model id for the chosen action. */
	readonly endpoint: string;
}

export interface ImageTargetRequest {
	readonly requestedModel?: string;
	readonly requestedProvider?: ImageProvider | "auto";
	readonly defaultModel?: string;
	readonly providerOrder: readonly ImageProvider[];
	readonly hasInputImages: boolean;
}

/** Normalized request handed to each adapter. */
export interface ImageRequestParams {
	readonly prompt: string;
	readonly aspectRatio?: ImageAspectRatio;
	readonly resolution?: ImageResolution;
	readonly n?: number;
	readonly quality?: ImageQuality;
	readonly outputFormat?: ImageOutputFormat;
	readonly background?: ImageBackground;
	readonly seed?: number;
}

const EDIT_CAPABLE_ENTRY_IDS = IMAGE_MODEL_CATALOG.filter(entry => entry.bindings.some(binding => binding.edit)).map(
	entry => entry.id,
);

/** Ranks a provider by its index in `providerOrder`; providers absent from the order rank last. */
function rankProvider(provider: ImageProvider, providerOrder: readonly ImageProvider[]): number {
	const idx = providerOrder.indexOf(provider);
	return idx === -1 ? providerOrder.length : idx;
}

function orderBindings(bindings: readonly ImageBinding[], providerOrder: readonly ImageProvider[]): ImageBinding[] {
	return [...bindings].sort(
		(a, b) => rankProvider(a.provider, providerOrder) - rankProvider(b.provider, providerOrder),
	);
}

function editCapableError(): ImageCapabilityError {
	return new ImageCapabilityError(
		`No selected model accepts input images. Edit-capable models: ${EDIT_CAPABLE_ENTRY_IDS.join(", ")}.`,
	);
}

function entryTarget(entry: ImageModelEntry, binding: ImageBinding, hasInputImages: boolean): ImageTarget {
	if (hasInputImages) {
		if (!binding.edit) {
			throw editCapableError();
		}
		return { entryId: entry.id, binding, action: "edit", endpoint: binding.edit };
	}
	return { entryId: entry.id, binding, action: "generate", endpoint: binding.generate };
}

/** Resolves the candidate bindings for an explicitly named model (catalog alias or raw `fal:`/`openrouter:` ref). */
async function resolveExplicitModel(
	model: string,
	requestedProvider: ImageProvider | "auto" | undefined,
	providerOrder: readonly ImageProvider[],
	hasInputImages: boolean,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<ImageTarget[]> {
	const raw = parseRawImageModelRef(model);
	let entry: ImageModelEntry;
	let candidates: ImageBinding[];

	if (raw) {
		const binding =
			raw.provider === "fal"
				? await loadFalEndpointBinding(raw.id, fetchImpl, signal)
				: await loadOpenRouterImageBinding(raw.id, fetchImpl, signal);
		entry = {
			id: raw.id,
			label: raw.id,
			summary: raw.provider,
			bindings: [binding],
		};
		candidates = [binding];
	} else {
		const found = findImageModelEntry(model);
		if (!found) {
			throw new ImageCapabilityError(
				`Unknown image model "${model}". Catalog aliases: ${IMAGE_MODEL_CATALOG.map(e => e.id).join(", ")}; or use fal:<endpoint-id> / openrouter:<model-id>.`,
			);
		}
		entry = found;
		candidates = orderBindings(found.bindings, providerOrder);
	}

	if (requestedProvider && requestedProvider !== "auto") {
		candidates = candidates.filter(binding => binding.provider === requestedProvider);
		if (candidates.length === 0) {
			const serving = entry.bindings.map(binding => binding.provider).join(", ");
			throw new ImageCapabilityError(
				`Image model "${model}" is not served by provider ${requestedProvider}. Served by: ${serving}.`,
			);
		}
	}

	if (hasInputImages) {
		candidates = candidates.filter(binding => binding.edit);
		if (candidates.length === 0) {
			throw editCapableError();
		}
	}

	return candidates.map(binding => entryTarget(entry, binding, hasInputImages));
}

/**
 * Ordered candidate targets for the request. Empty result never happens:
 * unresolvable input throws {@link ImageCapabilityError}.
 */
export async function resolveImageTargets(
	request: ImageTargetRequest,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<ImageTarget[]> {
	const { requestedModel, requestedProvider, defaultModel, providerOrder, hasInputImages } = request;

	const effectiveModel = requestedModel ?? defaultModel;
	if (effectiveModel) {
		return resolveExplicitModel(effectiveModel, requestedProvider, providerOrder, hasInputImages, fetchImpl, signal);
	}

	// No model anywhere: per-provider default walk, ordered by the provider order.
	// A per-request provider pin ("fal"/"xai"/...) restricts the walk to that provider.
	const targets: ImageTarget[] = [];
	for (const provider of providerOrder) {
		if (requestedProvider && requestedProvider !== "auto" && provider !== requestedProvider) continue;
		const defaultEntry = findImageModelEntry(DEFAULT_IMAGE_MODEL_BY_PROVIDER[provider]);
		if (!defaultEntry) continue;
		const binding = defaultEntry.bindings.find(b => b.provider === provider);
		if (!binding) continue;
		if (hasInputImages && !binding.edit) {
			targets.push({
				entryId: defaultEntry.id,
				binding,
				action: "unsupported-edit",
				endpoint: binding.generate,
			});
			continue;
		}
		targets.push(entryTarget(defaultEntry, binding, hasInputImages));
	}
	if (targets.length === 0) {
		throw new ImageCapabilityError("No image models available for the configured providers.");
	}
	return targets;
}
/**
 * Validates every explicit knob against the binding; throws once, naming every
 * unsupported knob and listing supported values. Aspect-ratio is consumed by
 * dimension math for `image_size`/`hosted_pixels` bindings, so it is only
 * asserted against `binding.aspectRatios` when that list is declared.
 *
 * When `entryId` is provided, capability errors name the concrete binding and —
 * where a sibling binding of the same catalog entry supports the knob — suggest
 * pinning that provider, so a fail-closed rejection is actionable instead of a
 * bare sentence (no silent model/knob substitution). `entryId` is the catalog
 * alias; raw `fal:`/`openrouter:` refs pass through with no sibling lookup.
 */
export function assertBindingSupports(
	binding: ImageBinding,
	params: ImageRequestParams,
	referenceCount: number,
	entryId?: string,
): void {
	const violations: string[] = [];
	const who = entryId
		? `${entryId} via ${binding.provider} (${binding.generate})`
		: `${binding.provider} (${binding.generate})`;
	const hint = (test: (b: ImageBinding) => boolean): string => {
		const entry = entryId ? findImageModelEntry(entryId) : undefined;
		if (!entry) return "";
		// "Sibling" is any other binding of the same entry. For an edit request
		// (referenceCount > 0) only recommend siblings that can accept the input images.
		const siblings = entry.bindings.filter(
			b =>
				b !== binding && (referenceCount === 0 || (b.edit != null && b.maxReferences >= referenceCount)) && test(b),
		);
		if (siblings.length === 0) return "";
		const names = siblings.map(b => `${b.provider} (${b.generate})`).join(", ");
		const pin = siblings.map(b => b.provider).join(" or ");
		return ` Alternatively, set provider: ${pin} (only if that provider's credential is configured), or adjust/omit this knob. Available via: ${names}.`;
	};

	if (params.aspectRatio) {
		if (binding.sizeMode !== "image_size" && !binding.aspectRatios?.includes(params.aspectRatio)) {
			const supported = binding.aspectRatios?.join(", ") ?? "none";
			violations.push(
				`Unsupported aspect ratio ${params.aspectRatio} for ${who}. Supported: ${supported}.${hint(
					b => b.sizeMode === "image_size" || !!b.aspectRatios?.includes(params.aspectRatio!),
				)}`,
			);
		}
	}

	if (params.resolution) {
		if (binding.resolutions) {
			if (!binding.resolutions.includes(params.resolution)) {
				violations.push(
					`Unsupported resolution ${params.resolution} for ${who}. Supported: ${binding.resolutions.join(", ")}.${hint(
						b =>
							(b.resolutions?.includes(params.resolution!) ?? b.sizeMode === "image_size") &&
							(!b.pixels || IMAGE_RESOLUTION_AREA[params.resolution!] <= b.pixels.maxArea),
					)}`,
				);
			}
		} else if (binding.sizeMode !== "image_size") {
			violations.push(
				`Unsupported resolution ${params.resolution} for ${who}. Supported: none.${hint(
					b =>
						(b.resolutions?.includes(params.resolution!) ?? b.sizeMode === "image_size") &&
						(!b.pixels || IMAGE_RESOLUTION_AREA[params.resolution!] <= b.pixels.maxArea),
				)}`,
			);
		}
	}

	if (params.n !== undefined) {
		if (!Number.isInteger(params.n) || params.n < 1 || params.n > binding.maxImages) {
			violations.push(
				`Unsupported image count ${params.n} for ${who}. This binding generates up to ${binding.maxImages} image(s) per request.${hint(b => b.maxImages >= params.n!)}`,
			);
		}
	}

	if (params.quality) {
		const supportsQuality = binding.qualityValues
			? binding.qualityValues.includes(params.quality)
			: binding.supportsQuality;
		if (!supportsQuality) {
			if (binding.qualityValues) {
				const supported = binding.qualityValues.length > 0 ? binding.qualityValues.join(", ") : "none";
				violations.push(
					`Unsupported quality ${params.quality} for ${who}. Supported: ${supported}.${hint(b =>
						b.qualityValues ? b.qualityValues.includes(params.quality!) : b.supportsQuality,
					)}`,
				);
			} else {
				violations.push(`Quality is not supported by ${who}.${hint(b => b.supportsQuality)}`);
			}
		}
	}

	if (params.background) {
		const supportsBackground = binding.backgroundValues
			? binding.backgroundValues.includes(params.background)
			: binding.supportsBackground;
		if (!supportsBackground) {
			if (binding.backgroundValues) {
				const supported = binding.backgroundValues.length > 0 ? binding.backgroundValues.join(", ") : "none";
				violations.push(
					`Unsupported background ${params.background} for ${who}. Supported: ${supported}.${hint(b =>
						b.backgroundValues ? b.backgroundValues.includes(params.background!) : b.supportsBackground,
					)}`,
				);
			} else {
				violations.push(`Background handling is not supported by ${who}.${hint(b => b.supportsBackground)}`);
			}
		}
	}

	if (params.outputFormat) {
		if (!binding.outputFormats?.includes(params.outputFormat)) {
			const supported = binding.outputFormats ? binding.outputFormats.join(", ") : "the provider default only";
			violations.push(
				`Unsupported output format ${params.outputFormat} for ${who}. Supported: ${supported}.${hint(b => !!b.outputFormats?.includes(params.outputFormat!))}`,
			);
		}
	}

	if (params.seed !== undefined && !binding.supportsSeed) {
		violations.push(`Seed is not supported by ${who}.${hint(b => b.supportsSeed)}`);
	}

	if (referenceCount > binding.maxReferences) {
		violations.push(
			`${who} accepts up to ${binding.maxReferences} reference image(s); got ${referenceCount}.${hint(b => b.maxReferences >= referenceCount)}`,
		);
	}

	if (binding.sizeMode === "image_size" && binding.pixels && (params.aspectRatio || params.resolution)) {
		try {
			computeImageSize(params.aspectRatio, params.resolution, binding.pixels);
		} catch (error) {
			if (error instanceof ImageCapabilityError) {
				violations.push(error.message);
			} else {
				throw error;
			}
		}
	}

	if (violations.length > 0) throw new ImageCapabilityError(violations.join(" "));
}

function ratioFromAspect(aspectRatio: ImageAspectRatio | undefined): number {
	if (!aspectRatio || aspectRatio === "auto") return 1;
	const [w, h] = aspectRatio.split(":").map(Number);
	return w / h;
}

/**
 * aspect_ratio + resolution → concrete pixels for `image_size` bindings.
 * Preserves the requested ratio and scales to fit the binding's pixel caps;
 * never clamps axes independently (which would distort the ratio).
 */
export function computeImageSize(
	aspectRatio: ImageAspectRatio | undefined,
	resolution: ImageResolution | undefined,
	pixels: ImagePixelConstraints,
): { width: number; height: number } {
	if (aspectRatio === "auto") {
		throw new ImageCapabilityError(
			"Automatic aspect ratio cannot be represented by image_size bindings; choose an explicit aspect ratio or omit aspect_ratio.",
		);
	}
	const targetArea = resolution ? IMAGE_RESOLUTION_AREA[resolution] : IMAGE_RESOLUTION_AREA["1K"];
	const minArea = pixels.minArea ?? 0;

	if (targetArea > pixels.maxArea || targetArea < minArea) {
		throw new ImageCapabilityError(
			`This model supports ${minArea > 0 ? `${(minArea / 1e6).toFixed(1)}–` : ""}${(pixels.maxArea / 1e6).toFixed(
				1,
			)} MP; requested ${resolution ?? `${(targetArea / 1e6).toFixed(1)} MP`}.`,
		);
	}

	const ratio = ratioFromAspect(aspectRatio);
	const w0 = Math.sqrt(targetArea * ratio);
	const h0 = Math.sqrt(targetArea / ratio);
	const scale = Math.min(1, pixels.maxWidth / w0, pixels.maxHeight / h0, Math.sqrt(pixels.maxArea / targetArea));

	const rawWidth = w0 * scale;
	const rawHeight = h0 * scale;
	const multiple = Math.max(1, pixels.multipleOf);
	const minWidth = Math.ceil(pixels.minWidth / multiple) * multiple;
	const minHeight = Math.ceil(pixels.minHeight / multiple) * multiple;
	let width = Math.max(Math.round(rawWidth / multiple) * multiple, minWidth);
	let height = Math.max(Math.round(rawHeight / multiple) * multiple, minHeight);
	const ratioDeviation = (candidateWidth: number, candidateHeight: number): number =>
		Math.abs(candidateWidth / candidateHeight - ratio) / ratio;

	// Nearest-multiple rounding can cross an area or axis cap. Reduce the
	// least-distorting axis until every hard upper bound is satisfied.
	while (width > pixels.maxWidth || height > pixels.maxHeight || width * height > pixels.maxArea) {
		const candidates: Array<{ width: number; height: number; deviation: number }> = [];
		if (width - multiple >= minWidth) {
			const candidateWidth = width - multiple;
			candidates.push({ width: candidateWidth, height, deviation: ratioDeviation(candidateWidth, height) });
		}
		if (height - multiple >= minHeight) {
			const candidateHeight = height - multiple;
			candidates.push({ width, height: candidateHeight, deviation: ratioDeviation(width, candidateHeight) });
		}
		if (candidates.length === 0) break;
		candidates.sort((a, b) => a.deviation - b.deviation);
		const best = candidates[0]!;
		width = best.width;
		height = best.height;
	}
	// Multiple-of rounding can fall just below a provider's minimum area.
	// Grow the least-distorting axis until the floor is met, without crossing
	// any hard upper bound. If no legal multiple exists, the final validation
	// below reports the nearest achievable dimensions.
	while (width * height < minArea) {
		const candidates: Array<{ width: number; height: number; deviation: number }> = [];
		if (width + multiple <= pixels.maxWidth && (width + multiple) * height <= pixels.maxArea) {
			const candidateWidth = width + multiple;
			candidates.push({ width: candidateWidth, height, deviation: ratioDeviation(candidateWidth, height) });
		}
		if (height + multiple <= pixels.maxHeight && width * (height + multiple) <= pixels.maxArea) {
			const candidateHeight = height + multiple;
			candidates.push({ width, height: candidateHeight, deviation: ratioDeviation(width, candidateHeight) });
		}
		if (candidates.length === 0) break;
		candidates.sort((a, b) => a.deviation - b.deviation);
		const best = candidates[0]!;
		width = best.width;
		height = best.height;
	}

	const area = width * height;
	if (
		width > pixels.maxWidth ||
		height > pixels.maxHeight ||
		area > pixels.maxArea ||
		area < minArea ||
		width < pixels.minWidth ||
		height < pixels.minHeight
	) {
		throw new ImageCapabilityError(
			`This model cannot serve ${aspectRatio ?? "auto"} at the requested size; nearest achievable is ${width}x${height}.`,
		);
	}

	// A ratio after rounding/adjustment that deviates >2% from the request is
	// the honest failure case.
	if (aspectRatio && ratioDeviation(width, height) > 0.02) {
		throw new ImageCapabilityError(
			`This model cannot serve ${aspectRatio} at the requested size; nearest achievable is ${width}x${height}.`,
		);
	}

	return { width, height };
}

// ---------------------------------------------------------------------------
// Runtime discovery (in-memory only)
// ---------------------------------------------------------------------------

const FAL_OPENAPI_URL = "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=";
const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";
const NEGATIVE_CACHE_MS = 60_000;

interface FalCacheEntry {
	binding: ImageBinding;
}
interface NegativeCacheEntry {
	error: unknown;
	at: number;
}
type FalEndpointCacheEntry = FalCacheEntry | NegativeCacheEntry;

const falEndpointCache = new Map<string, FalEndpointCacheEntry>();

interface OpenRouterModelHandle {
	id: string;
	supported_parameters?: {
		resolution?: { type: "enum"; values?: string[] };
		aspect_ratio?: { type: "enum"; values?: string[] };
		output_format?: { type: "enum"; values?: string[] };
		quality?: { type: "enum"; values?: string[] };
		background?: { type: "enum"; values?: string[] };
		n?: { type: "range"; min?: number; max?: number };
		input_references?: { type: "range"; min?: number; max?: number };
		seed?: { type: "boolean" } | Record<string, unknown>;
	};
}
interface OpenRouterListCache {
	models: Map<string, OpenRouterModelHandle>;
	/** Negative-cache entry when the list fetch failed. */
	error?: { error: unknown; at: number };
}
const openRouterListCache: OpenRouterListCache = { models: new Map() };

const CANONICAL_RESOLUTIONS: readonly ImageResolution[] = ["512", "1K", "2K", "4K"];
// FAL lowers `1k`/`2k` and exposes `0.5K` for some models; normalize to canonical tiers.
function mapCanonicalResolution(value: string): ImageResolution | undefined {
	const upper = value.toUpperCase();
	if (upper === "0.5K") return "512";
	return CANONICAL_RESOLUTIONS.find(tier => tier === upper);
}

const CANONICAL_ASPECTS: readonly ImageAspectRatio[] = [
	"auto",
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"4:5",
	"5:4",
	"21:9",
	"9:21",
	"2:1",
	"1:2",
	"20:9",
	"19.5:9",
	"9:20",
	"9:19.5",
];
const CANONICAL_OUTPUT_FORMATS: readonly ImageOutputFormat[] = ["png", "jpeg", "webp", "svg"];
const CANONICAL_QUALITIES: readonly ImageQuality[] = ["auto", "low", "medium", "high"];
const CANONICAL_BACKGROUNDS: readonly ImageBackground[] = ["auto", "transparent", "opaque"];
function schemaEnumValues(schema: unknown): string[] {
	const values: string[] = [];
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (Array.isArray(record.enum)) {
			for (const value of record.enum) {
				if (typeof value === "string") values.push(value);
			}
		}
		for (const branchKey of ["anyOf", "oneOf"]) {
			const branches = record[branchKey];
			if (Array.isArray(branches)) {
				for (const branch of branches) visit(branch);
			}
		}
	};
	visit(schema);
	return [...new Set(values)];
}

function schemaMaxItems(schema: unknown): number | undefined {
	let maximum: number | undefined;
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (typeof record.maxItems === "number" && Number.isFinite(record.maxItems) && record.maxItems >= 1) {
			maximum = maximum === undefined ? record.maxItems : Math.max(maximum, record.maxItems);
		}
		for (const branchKey of ["anyOf", "oneOf"]) {
			const branches = record[branchKey];
			if (Array.isArray(branches)) {
				for (const branch of branches) visit(branch);
			}
		}
	};
	visit(schema);
	return maximum === undefined ? undefined : Math.floor(maximum);
}

function schemaMaximum(schema: unknown): number | undefined {
	let maximum: number | undefined;
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (typeof record.maximum === "number" && Number.isFinite(record.maximum)) {
			maximum = maximum === undefined ? record.maximum : Math.max(maximum, record.maximum);
		}
		for (const branchKey of ["anyOf", "oneOf"]) {
			const branches = record[branchKey];
			if (Array.isArray(branches)) {
				for (const branch of branches) visit(branch);
			}
		}
	};
	visit(schema);
	return maximum;
}

function canonicalMaximum(schema: unknown): number {
	const maximum = schemaMaximum(schema);
	return maximum !== undefined && maximum >= 1 ? Math.floor(maximum) : 1;
}

/** Derives a binding from a FAL endpoint's OpenAPI Input schema. */
export async function loadFalEndpointBinding(
	endpointId: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<ImageBinding> {
	const cached = falEndpointCache.get(endpointId);
	if (cached) {
		if ("binding" in cached) return cached.binding;
		if (Date.now() - cached.at < NEGATIVE_CACHE_MS) throw cached.error;
	}

	try {
		const binding = await fetchFalEndpointBinding(endpointId, fetchImpl, signal);
		falEndpointCache.set(endpointId, { binding });
		return binding;
	} catch (error) {
		// An aborted discovery is not a real failure; don't poison the cache.
		if (signal?.aborted) throw error;
		falEndpointCache.set(endpointId, { error, at: Date.now() });
		throw error;
	}
}

async function fetchFalEndpointBinding(
	endpointId: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<ImageBinding> {
	const response = await fetchImpl(`${FAL_OPENAPI_URL}${encodeURIComponent(endpointId)}`, { signal });
	if (!response.ok) {
		throw new ImageCapabilityError(
			`Failed to load FAL endpoint "${endpointId}" (${response.status}). Verify the id exists; discovery: ${FAL_OPENAPI_URL}<id>.`,
		);
	}
	const doc = (await response.json()) as {
		components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
	};
	const schemas = doc.components?.schemas ?? {};
	const inputKey = Object.keys(schemas).find(key => key.endsWith("Input"));
	if (!inputKey) {
		throw new ImageCapabilityError(`FAL endpoint "${endpointId}" has no input schema; not a valid endpoint id.`);
	}
	const props = schemas[inputKey]?.properties ?? {};
	const promptPresent = props.prompt != null;
	if (!promptPresent) {
		throw new ImageCapabilityError(`FAL endpoint "${endpointId}" is not a prompt-driven image endpoint.`);
	}

	const aspectRatio = props.aspect_ratio;
	const aspectRatioValues = schemaEnumValues(aspectRatio);
	const imageSize = props.image_size as { "x-fal"?: Record<string, number> } | undefined;
	const resolution = props.resolution;
	const resolutionValues = schemaEnumValues(resolution);
	const resolutionWireValues: Partial<Record<ImageResolution, string>> = {};
	for (const wireValue of resolutionValues) {
		const canonical = mapCanonicalResolution(wireValue);
		if (canonical && resolutionWireValues[canonical] === undefined) {
			resolutionWireValues[canonical] = wireValue;
		}
	}
	const outputFormatValues = schemaEnumValues(props.output_format);
	const qualityProperty = props.quality;
	const qualityValues = schemaEnumValues(qualityProperty).filter(value =>
		CANONICAL_QUALITIES.includes(value as ImageQuality),
	) as ImageQuality[];
	const backgroundProperty = props.background;
	const backgroundValues = schemaEnumValues(backgroundProperty).filter(value =>
		CANONICAL_BACKGROUNDS.includes(value as ImageBackground),
	) as ImageBackground[];
	const maxImages = canonicalMaximum(props.num_images);
	const pluralImageUrls = props.image_urls;
	const singularImageUrl = props.image_url;
	const inputImageField = pluralImageUrls != null ? "image_urls" : singularImageUrl != null ? "image_url" : undefined;
	const maxReferences =
		pluralImageUrls != null ? (schemaMaxItems(pluralImageUrls) ?? 4) : singularImageUrl != null ? 1 : 0;

	const sizeMode: "aspect_ratio" | "image_size" = aspectRatio ? "aspect_ratio" : "image_size";

	let pixels: ImagePixelConstraints | undefined;
	if (sizeMode === "image_size") {
		const xfal = imageSize?.["x-fal"];
		pixels = {
			...FALLBACK_PIXELS,
			minWidth: xfal?.min_width ?? FALLBACK_PIXELS.minWidth,
			maxWidth: xfal?.max_width ?? FALLBACK_PIXELS.maxWidth,
			minHeight: xfal?.min_height ?? FALLBACK_PIXELS.minHeight,
			maxHeight: xfal?.max_height ?? FALLBACK_PIXELS.maxHeight,
			...(xfal?.min_area != null ? { minArea: xfal.min_area } : {}),
			maxArea: xfal?.max_area ?? FALLBACK_PIXELS.maxArea,
			multipleOf: xfal?.multiple_of ?? FALLBACK_PIXELS.multipleOf,
		};
	}

	return {
		provider: "fal",
		generate: endpointId,
		// `edit` is set only when this endpoint itself declares an image input field —
		// never by appending `/edit` to the id.
		...(inputImageField ? { edit: endpointId, inputImageField } : {}),
		sizeMode,
		...(aspectRatio
			? {
					aspectRatios: aspectRatioValues.filter(value =>
						CANONICAL_ASPECTS.includes(value as ImageAspectRatio),
					) as ImageAspectRatio[],
				}
			: {}),
		...(resolutionValues.length > 0
			? {
					resolutions: resolutionValues
						.map(mapCanonicalResolution)
						.filter((t): t is ImageResolution => t !== undefined),
				}
			: {}),
		...(Object.keys(resolutionWireValues).length > 0 ? { resolutionWireValues } : {}),
		...(pixels ? { pixels } : {}),
		maxImages,
		maxReferences,
		...(outputFormatValues.length > 0
			? {
					outputFormats: outputFormatValues.filter(value =>
						CANONICAL_OUTPUT_FORMATS.includes(value as ImageOutputFormat),
					) as ImageOutputFormat[],
				}
			: {}),
		...(qualityProperty != null && qualityValues.length > 0 ? { qualityValues } : {}),
		...(backgroundProperty != null && backgroundValues.length > 0 ? { backgroundValues } : {}),
		supportsSeed: props.seed != null,
		supportsQuality: qualityProperty != null,
		supportsBackground: backgroundProperty != null,
	};
}

/** Loads (once per process) and indexes the OpenRouter image model list. */
async function getOpenRouterModelList(
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<Map<string, OpenRouterModelHandle>> {
	if (openRouterListCache.models.size > 0) return openRouterListCache.models;
	const negative = openRouterListCache.error;
	if (negative && Date.now() - negative.at < NEGATIVE_CACHE_MS) throw negative.error;
	try {
		const response = await fetchImpl(OPENROUTER_IMAGE_MODELS_URL, { signal });
		if (!response.ok) {
			throw new ImageCapabilityError(
				`Failed to load OpenRouter image models (${response.status}). Discovery: ${OPENROUTER_IMAGE_MODELS_URL}.`,
			);
		}
		const doc = (await response.json()) as { data?: OpenRouterModelHandle[] };
		for (const model of doc.data ?? []) {
			openRouterListCache.models.set(model.id, model);
		}
		return openRouterListCache.models;
	} catch (error) {
		if (!signal?.aborted) openRouterListCache.error = { error, at: Date.now() };
		throw error;
	}
}

const negativeOrModels = new Map<string, NegativeCacheEntry>();

/** Derives a binding from an OpenRouter image model's supported_parameters. */
export async function loadOpenRouterImageBinding(
	modelId: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<ImageBinding> {
	const models = await getOpenRouterModelList(fetchImpl, signal);
	const handle = models.get(modelId);
	if (!handle) {
		const negative = negativeOrModels.get(modelId);
		if (negative && Date.now() - negative.at < NEGATIVE_CACHE_MS) throw negative.error;
		const error = new ImageCapabilityError(
			`Unknown OpenRouter image model "${modelId}". See the model list at ${OPENROUTER_IMAGE_MODELS_URL}.`,
		);
		negativeOrModels.set(modelId, { error, at: Date.now() });
		throw error;
	}

	const sp = handle.supported_parameters ?? {};
	const aspectRatios = (sp.aspect_ratio?.values ?? []).filter(value =>
		CANONICAL_ASPECTS.includes(value as ImageAspectRatio),
	) as ImageAspectRatio[];
	const resolutions = (sp.resolution?.values ?? [])
		.map(mapCanonicalResolution)
		.filter((t): t is ImageResolution => t !== undefined);
	const outputFormats = (sp.output_format?.values ?? []).filter(value =>
		CANONICAL_OUTPUT_FORMATS.includes(value as ImageOutputFormat),
	) as ImageOutputFormat[];
	const qualityValues = (sp.quality?.values ?? []).filter(value =>
		CANONICAL_QUALITIES.includes(value as ImageQuality),
	) as ImageQuality[];
	const backgroundValues = (sp.background?.values ?? []).filter(value =>
		CANONICAL_BACKGROUNDS.includes(value as ImageBackground),
	) as ImageBackground[];
	const maxImages = sp.n?.max ?? 1;
	const maxReferences = sp.input_references?.max ?? 0;

	return {
		provider: "openrouter",
		generate: modelId,
		// OpenRouter edits ride `input_references` on the same model id.
		...(maxReferences > 0 ? { edit: modelId } : {}),
		sizeMode: "aspect_ratio",
		aspectRatios,
		...(resolutions.length > 0 ? { resolutions } : {}),
		maxImages,
		maxReferences,
		outputFormats,
		...(sp.quality ? { qualityValues } : {}),
		...(sp.background ? { backgroundValues } : {}),
		supportsSeed: sp.seed != null,
		supportsQuality: sp.quality != null,
		supportsBackground: sp.background != null,
	};
}

/** Test helper: clears the in-memory discovery caches. */
export function resetImageDiscoveryCachesForTests(): void {
	falEndpointCache.clear();
	openRouterListCache.models.clear();
	openRouterListCache.error = undefined;
	negativeOrModels.clear();
}
