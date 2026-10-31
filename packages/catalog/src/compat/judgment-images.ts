import { isRecord } from "../utils";
import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/** Bounds a judgment model applies to image inputs. */
export interface JudgmentImageInput {
	/** Accepted lowercase MIME types; unset adds no model-specific format restriction. */
	mimeTypes?: readonly string[];
	/** Images per request. */
	maxCount?: number;
	/** Decoded bytes per image. */
	maxBytes?: number;
	/** Decoded bytes across all images. */
	maxTotalBytes?: number;
	/** Pixels per image, when the image header reports dimensions. */
	maxPixels?: number;
	/** Minimum pixels per image, when the image header reports dimensions. */
	minPixels?: number;
	/** Inclusive bounds on each side, when the image header reports dimensions. */
	minSide?: number;
	maxSide?: number;
}

type NumericField = "maxCount" | "maxBytes" | "maxTotalBytes" | "maxPixels" | "minPixels" | "minSide" | "maxSide";

const NUMERIC_FIELDS: readonly NumericField[] = [
	"maxCount",
	"maxBytes",
	"maxTotalBytes",
	"maxPixels",
	"minPixels",
	"minSide",
	"maxSide",
];
const POLICY_FIELDS: Record<string, true> = {
	mimeTypes: true,
	maxCount: true,
	maxBytes: true,
	maxTotalBytes: true,
	maxPixels: true,
	minPixels: true,
	minSide: true,
	maxSide: true,
};
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Resolve image bounds assigned to this model by the catalog cascade. KDL
 * object payloads have scalar children, so `mime-types` is authored as a
 * comma-separated string and normalized here to the public array type.
 */
export function resolveJudgmentImageInput(model: Model): JudgmentImageInput | undefined {
	const value = resolveCatalogPolicy(model).judgmentImageInput;
	if (!isRecord(value) || Object.keys(value).some(key => !Object.hasOwn(POLICY_FIELDS, key))) return undefined;

	let mimeTypes: readonly string[] | undefined;
	if (value.mimeTypes !== undefined) {
		if (typeof value.mimeTypes !== "string") return undefined;
		const parsed = value.mimeTypes.split(",");
		if (parsed.some(mimeType => !MIME_TYPE.test(mimeType))) return undefined;
		mimeTypes = Object.freeze(parsed);
	}

	const numeric: Partial<Record<NumericField, number>> = {};
	for (const field of NUMERIC_FIELDS) {
		const bound = value[field];
		if (bound === undefined) continue;
		if (!positiveInteger(bound)) return undefined;
		numeric[field] = bound;
	}
	if (
		(numeric.minPixels !== undefined && numeric.maxPixels !== undefined && numeric.minPixels > numeric.maxPixels) ||
		(numeric.minSide !== undefined && numeric.maxSide !== undefined && numeric.minSide > numeric.maxSide)
	) {
		return undefined;
	}

	return { ...(mimeTypes !== undefined && { mimeTypes }), ...numeric };
}
