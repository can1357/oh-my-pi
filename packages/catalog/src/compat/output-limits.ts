import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether the host truncates generation at the context window rather than
 * rejecting prompt + output cap overflow; the output fitter skips these models.
 */
export function stopsOutputAtContextWindow(model: Model): boolean {
	return resolveCatalogPolicy(model).stopsOutputAtContextWindow === true;
}

/** Whether discovery and transport policy allow preserving a caller's output cap. */
export function supportsOutputTokenLimit(model: Model): boolean {
	const policy = resolveCatalogPolicy(model);
	return (
		model.omitMaxOutputTokens !== true &&
		policy.omitMaxOutputTokens !== true &&
		policy.preservesMaxOutputTokens !== false
	);
}
