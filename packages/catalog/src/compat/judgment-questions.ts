import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Most questions one System One judgment request to this model may carry
 * (`judgment-questions-max` axis), or `undefined` when the endpoint takes any
 * batch size.
 */
export function resolveJudgmentQuestionsMax(model: Model): number | undefined {
	const value = resolveCatalogPolicy(model).judgmentQuestionsMax;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
