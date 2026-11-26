/**
 * Billed input tokens per image, from the `image-tokenization` rules in the
 * compat cascade: a model line's lineage rule (`rules/classes/*.kdl`) applies
 * on every host, and readers without one fall back to the rule for the wire
 * API carrying the request (`rules/providers/image-tokenization.kdl`).
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { classifyModel } from "../identity";
import { resolveCascade } from "./cascade";
import type { ModelIdentity } from "./types";

/** OpenAI image `detail` levels; `undefined` means the provider default (`auto`). */
export type ImageDetail = "auto" | "low" | "high" | "original";

export interface ImageSize {
	width: number;
	height: number;
}

/** One OpenAI `detail` level's sizing: a pixel-dimension limit, then an optional patch budget. */
export interface PatchSizing {
	/** Longest side after the pixel-dimension fit. */
	maxEdge: number;
	/** Resizing patch budget; absent when the level keeps the image's size. */
	patchBudget?: number;
}

/** OpenAI 32px patches × a per-model multiplier, sized per `detail` level. */
export interface OpenAiPatchTokenization {
	regime: "openai-patch";
	multiplier: number;
	low: PatchSizing;
	high: PatchSizing;
	original: PatchSizing;
	/** The level `auto` (and an omitted `detail`) sizes like. */
	auto: "high" | "original";
}

/** DeepSeek ViT patches merged `downsample`² into one token, plus a newline per row and two delimiters. */
export interface DeepSeekPatchTokenization {
	regime: "deepseek-patch";
	/** ViT patch edge in pixels. */
	patchSize: number;
	/** Patches merged per token along each axis. */
	downsample: number;
	/** Token budget per image, layout tokens included. */
	maxTokens: number;
	/** Smaller images are upscaled to this pixel area. */
	minPixels: number;
}

/** One model line's image billing rule: the vendor formula and its per-model numbers. */
export type ImageTokenization = (
	| OpenAiPatchTokenization
	/** Anthropic 28px patches, resized to fit a padded-edge limit and a visual-token budget. */
	| { regime: "anthropic-patch"; maxEdge: number; maxTokens: number }
	| DeepSeekPatchTokenization
	/** A fixed per-image budget regardless of pixels (Gemini 3 `media_resolution`). */
	| { regime: "fixed"; tokens: number }
) & {
	/** Provider billing was measured to match this rule; unset for docs-only rules and wire fallbacks. */
	verified?: boolean;
};

/** A `class: "unknown"` identity for targets resolved by wire API alone. */
const UNCLASSIFIED: Pick<ModelIdentity, "class"> = { class: "unknown" };

function isImageTokenization(value: unknown): value is ImageTokenization {
	return (
		isRecord(value) &&
		(value.regime === "openai-patch" ||
			value.regime === "anthropic-patch" ||
			value.regime === "deepseek-patch" ||
			value.regime === "fixed")
	);
}

/** What reads the image: a built model, any `{ id }` with optional host and identity, or just a wire `{ api }`. */
export interface ImageTokenizationTarget {
	id?: string;
	provider?: string;
	api?: string;
	identity?: Pick<ModelIdentity, "class" | "family" | "revision">;
}

/** Catalog axes for `target`'s identity on its host and wire API. */
function resolveImageAxes(target: ImageTokenizationTarget): Record<string, unknown> {
	const provider = target.provider ?? "";
	const model = target.id ?? "";
	const identity: Pick<ModelIdentity, "class" | "family" | "revision"> =
		target.identity ?? (model ? classifyModel(provider, model, { lenient: true }) : UNCLASSIFIED);
	return resolveCascade({
		provider,
		api: target.api ?? "",
		class: identity.class,
		model,
		reasoning: false,
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog;
}

/**
 * The reader's image billing rule: its lineage rule, else its wire API's
 * fallback; undefined when neither covers it (an unclassified model on an
 * unregistered API).
 */
export function resolveImageTokenization(target: ImageTokenizationTarget): ImageTokenization | undefined {
	const rule = resolveImageAxes(target).imageTokenization;
	return isImageTokenization(rule) ? rule : undefined;
}

/**
 * Longest image edge the reader's host passes to the model (`image-max-edge`),
 * or undefined when the host keeps the image's size.
 */
export function resolveImageMaxEdge(target: ImageTokenizationTarget): number | undefined {
	const edge = resolveImageAxes(target).imageMaxEdge;
	return typeof edge === "number" && edge > 0 ? edge : undefined;
}

/**
 * Scale `size` down (never up) so its longest side is at most `maxEdge`: what a host's `image-max-edge` does to
 * an image, and how a caller sizes one to pass such a host untouched.
 */
export function fitLongEdge(size: ImageSize, maxEdge: number): ImageSize {
	const longest = Math.max(size.width, size.height);
	if (longest <= maxEdge) return size;
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

const OPENAI_PATCH_PX = 32;

/** 32px patches `size` covers, counting partial patches whole. */
function openAiPatchCount({ width, height }: ImageSize): number {
	return Math.ceil(width / OPENAI_PATCH_PX) * Math.ceil(height / OPENAI_PATCH_PX);
}

/** The level a `detail` value sizes like: `auto` and an omitted `detail` follow the rule's `auto`. */
function openAiLevel(rule: OpenAiPatchTokenization, detail: ImageDetail | undefined): "low" | "high" | "original" {
	return detail === "low" || detail === "high" || detail === "original" ? detail : rule.auto;
}

/**
 * `size` after one `detail` level's resize: the long-edge fit, then the shrink to its patch budget. A side the
 * budget squeezes out comes back 0.
 * <https://developers.openai.com/api/docs/guides/images-vision#patch-based-image-tokenization>
 */
function openAiResize(size: ImageSize, sizing: PatchSizing): ImageSize {
	const fitted = fitLongEdge(size, sizing.maxEdge);
	const budget = sizing.patchBudget;
	if (budget === undefined || openAiPatchCount(fitted) <= budget) return fitted;

	const { width, height } = fitted;
	const shrink = Math.sqrt((OPENAI_PATCH_PX * OPENAI_PATCH_PX * budget) / (width * height));
	const scaledW = (width * shrink) / OPENAI_PATCH_PX;
	const scaledH = (height * shrink) / OPENAI_PATCH_PX;
	const adjusted = shrink * Math.min(Math.floor(scaledW) / scaledW, Math.floor(scaledH) / scaledH);
	return { width: Math.floor(width * adjusted), height: Math.floor(height * adjusted) };
}

/** Patches billed for `size` at one `detail` level, never more than its budget. */
function openAiPatches(size: ImageSize, sizing: PatchSizing): number {
	const resized = openAiResize(size, sizing);
	const budget = sizing.patchBudget;
	if (budget === undefined) return openAiPatchCount(resized);
	if (resized.width <= 0 || resized.height <= 0) return budget;
	return Math.min(budget, openAiPatchCount(resized));
}

const ANTHROPIC_PATCH_PX = 28;

/** Round half to even, like the API's resize (and Python's `round`). */
function roundTiesToEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}

/** 28px patches along `edge`, counting a partial patch whole. */
function anthropicPatches(edge: number): number {
	return Math.ceil(edge / ANTHROPIC_PATCH_PX);
}

/**
 * `size` after the API's resize: the largest aspect-preserving size whose
 * 28px-padded edges fit `maxEdge` and whose patch count fits `maxTokens`,
 * found by bisecting the long edge. Port of the reference implementation:
 * <https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading>
 */
function anthropicResize(size: ImageSize, maxEdge: number, maxTokens: number): ImageSize {
	const long = Math.max(size.width, size.height);
	const shortSide = Math.min(size.width, size.height);
	const aspect = long / shortSide;
	const fits = (l: number, s: number) =>
		anthropicPatches(l) * ANTHROPIC_PATCH_PX <= maxEdge &&
		anthropicPatches(s) * ANTHROPIC_PATCH_PX <= maxEdge &&
		anthropicPatches(l) * anthropicPatches(s) <= maxTokens;
	const short = (l: number) => Math.max(roundTiesToEven(l / aspect), 1);
	if (fits(long, shortSide)) return size;
	let lo = 1; // always fits
	let hi = long; // never fits
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (fits(mid, short(mid))) lo = mid;
		else hi = mid;
	}
	return size.width >= size.height ? { width: lo, height: short(lo) } : { width: short(lo), height: lo };
}

/**
 * DeepSeek tokens for `size` padded to whole patches: the patches merged
 * `downsample`² into one token, a newline per row and two delimiters.
 */
function deepseekGridTokens({ width, height }: ImageSize, rule: DeepSeekPatchTokenization): number {
	const rows = Math.ceil(Math.ceil(height / rule.patchSize) / rule.downsample);
	const cols = Math.ceil(Math.ceil(width / rule.patchSize) / rule.downsample);
	return rows * (cols + 1) + 2;
}

/**
 * `size` after DeepSeek's resize: upscaled to `minPixels`, and when its
 * padded token grid busts `maxTokens` shrunk to the largest
 * aspect-preserving grid of whole patches that fits. Port of
 * `plan_image_grid` in the reference processor (`max_wh_ratio` is unset in
 * the V4.1 config):
 * <https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/inference/image_processor.py>
 */
function deepseekResize(size: ImageSize, rule: DeepSeekPatchTokenization): ImageSize {
	const { patchSize, downsample, maxTokens, minPixels } = rule;
	const cell = patchSize * downsample;
	let { width, height } = size;
	if (width * height < minPixels) {
		const scale = Math.sqrt(minPixels / (width * height));
		width = Math.trunc(width * scale);
		height = Math.trunc(height * scale);
	}
	if (deepseekGridTokens({ width, height }, rule) <= maxTokens) return { width, height };
	const aspect = height / width;
	const maxCols = Math.sqrt((maxTokens - 2) / aspect + 0.25) - 0.5;
	const maxRows = maxCols * aspect;
	if (maxCols < 1) return { width: cell, height: Math.floor((maxTokens - 2) / 2) * cell };
	if (maxRows < 1) return { width: (maxTokens - 3) * cell, height: cell };
	const beta = Math.min((Math.floor(maxCols) * cell) / width, (Math.floor(maxRows) * cell) / height);
	return {
		width: Math.floor((width * beta) / patchSize) * patchSize,
		height: Math.floor((height * beta) / patchSize) * patchSize,
	};
}

/** Billed input tokens for one image of `size` under `rule`; only `openai-patch` reads `detail`. */
export function imageTokens(rule: ImageTokenization, size: ImageSize, detail?: ImageDetail): number {
	switch (rule.regime) {
		case "fixed":
			return rule.tokens;
		case "openai-patch":
			return Math.ceil(openAiPatches(size, rule[openAiLevel(rule, detail)]) * rule.multiplier);
		case "anthropic-patch": {
			const { width, height } = anthropicResize(size, rule.maxEdge, rule.maxTokens);
			return anthropicPatches(width) * anthropicPatches(height);
		}
		case "deepseek-patch":
			return deepseekGridTokens(deepseekResize(size, rule), rule);
	}
}

/**
 * The size at which `rule`'s model sees an image of `size`, after the vendor's own resize: `size` itself when
 * the image keeps its pixels, `undefined` for a rule that names no pixel grid (`fixed`). Only `openai-patch`
 * reads `detail`.
 *
 * A model locates things on the resized image, so a caller that maps its coordinates back (browser
 * screenshots) sizes the image to this first; the result is a fixed point of the resize.
 */
export function deliveredImageSize(
	rule: ImageTokenization,
	size: ImageSize,
	detail?: ImageDetail,
): ImageSize | undefined {
	switch (rule.regime) {
		case "fixed":
			return undefined;
		case "openai-patch": {
			const { width, height } = openAiResize(size, rule[openAiLevel(rule, detail)]);
			return { width: Math.max(1, width), height: Math.max(1, height) };
		}
		case "anthropic-patch":
			return anthropicResize(size, rule.maxEdge, rule.maxTokens);
		case "deepseek-patch":
			return deepseekResize(size, rule);
	}
}
