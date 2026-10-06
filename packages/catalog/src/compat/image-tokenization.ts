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

/** One model line's image billing rule: the vendor formula and its per-model numbers. */
export type ImageTokenization =
	| OpenAiPatchTokenization
	/** Anthropic 28px patches, resized to fit a padded-edge limit and a visual-token budget. */
	| { regime: "anthropic-patch"; maxEdge: number; maxTokens: number }
	/** A fixed per-image budget regardless of pixels (Gemini 3 `media_resolution`). */
	| { regime: "fixed"; tokens: number };

/** A `class: "unknown"` identity for targets resolved by wire API alone. */
const UNCLASSIFIED: Pick<ModelIdentity, "class"> = { class: "unknown" };

function isImageTokenization(value: unknown): value is ImageTokenization {
	return (
		isRecord(value) &&
		(value.regime === "openai-patch" || value.regime === "anthropic-patch" || value.regime === "fixed")
	);
}

/** What reads the image: a built model, any `{ id }` with optional host and identity, or just a wire `{ api }`. */
export interface ImageTokenizationTarget {
	id?: string;
	provider?: string;
	api?: string;
	identity?: Pick<ModelIdentity, "class" | "family" | "revision">;
}

/**
 * The reader's image billing rule: its lineage rule, else its wire API's
 * fallback; undefined when neither covers it (an unclassified model on an
 * unregistered API).
 */
export function resolveImageTokenization(target: ImageTokenizationTarget): ImageTokenization | undefined {
	const provider = target.provider ?? "";
	const model = target.id ?? "";
	const identity: Pick<ModelIdentity, "class" | "family" | "revision"> =
		target.identity ?? (model ? classifyModel(provider, model, { lenient: true }) : UNCLASSIFIED);
	const rule = resolveCascade({
		provider,
		api: target.api ?? "",
		class: identity.class,
		model,
		reasoning: false,
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.imageTokenization;
	return isImageTokenization(rule) ? rule : undefined;
}

/** Scale `size` down (never up) so its longest side is at most `maxEdge`. */
function fitLongEdge(size: ImageSize, maxEdge: number): ImageSize {
	const longest = Math.max(size.width, size.height);
	if (longest <= maxEdge) return size;
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

const OPENAI_PATCH_PX = 32;

/** <https://developers.openai.com/api/docs/guides/images-vision#patch-based-image-tokenization> */
function openAiPatches(size: ImageSize, sizing: PatchSizing): number {
	const { width, height } = fitLongEdge(size, sizing.maxEdge);
	const patches = Math.ceil(width / OPENAI_PATCH_PX) * Math.ceil(height / OPENAI_PATCH_PX);
	const budget = sizing.patchBudget;
	if (budget === undefined || patches <= budget) return patches;

	const shrink = Math.sqrt((OPENAI_PATCH_PX * OPENAI_PATCH_PX * budget) / (width * height));
	const scaledW = (width * shrink) / OPENAI_PATCH_PX;
	const scaledH = (height * shrink) / OPENAI_PATCH_PX;
	const adjusted = shrink * Math.min(Math.floor(scaledW) / scaledW, Math.floor(scaledH) / scaledH);
	const resizedW = Math.floor(width * adjusted);
	const resizedH = Math.floor(height * adjusted);
	if (resizedW <= 0 || resizedH <= 0) return budget;
	return Math.min(budget, Math.ceil(resizedW / OPENAI_PATCH_PX) * Math.ceil(resizedH / OPENAI_PATCH_PX));
}

const ANTHROPIC_PATCH_PX = 28;

/** Round half to even, like the API's resize (and Python's `round`). */
function roundTiesToEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Anthropic visual tokens after the API's resize: the largest
 * aspect-preserving size whose 28px-padded edges fit `maxEdge` and whose
 * patch count fits `maxTokens`, found by bisecting the long edge. Port of the
 * reference implementation:
 * <https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading>
 */
function anthropicTokens(size: ImageSize, maxEdge: number, maxTokens: number): number {
	const long = Math.max(size.width, size.height);
	const shortSide = Math.min(size.width, size.height);
	const aspect = long / shortSide;
	const patches = (l: number, s: number) => Math.ceil(l / ANTHROPIC_PATCH_PX) * Math.ceil(s / ANTHROPIC_PATCH_PX);
	const fits = (l: number, s: number) =>
		Math.ceil(l / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		Math.ceil(s / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		patches(l, s) <= maxTokens;
	const short = (l: number) => Math.max(roundTiesToEven(l / aspect), 1);
	if (fits(long, shortSide)) return patches(long, shortSide);
	let lo = 1; // always fits
	let hi = long; // never fits
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (fits(mid, short(mid))) lo = mid;
		else hi = mid;
	}
	return patches(lo, short(lo));
}

/** Billed input tokens for one image of `size` under `rule`; only `openai-patch` reads `detail`. */
export function imageTokens(rule: ImageTokenization, size: ImageSize, detail?: ImageDetail): number {
	switch (rule.regime) {
		case "fixed":
			return rule.tokens;
		case "openai-patch": {
			const level = detail === "low" || detail === "high" || detail === "original" ? detail : rule.auto;
			return Math.ceil(openAiPatches(size, rule[level]) * rule.multiplier);
		}
		case "anthropic-patch":
			return anthropicTokens(size, rule.maxEdge, rule.maxTokens);
	}
}
