import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/** Whether discovery and transport policy allow preserving a caller's output cap. */
export function supportsOutputTokenLimit(model: Model): boolean {
	const policy = resolveCatalogPolicy(model);
	return (
		model.omitMaxOutputTokens !== true &&
		policy.omitMaxOutputTokens !== true &&
		policy.preservesMaxOutputTokens !== false
	);
}
