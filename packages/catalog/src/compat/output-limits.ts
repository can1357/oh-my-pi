import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/** Whether discovery and transport policy allow preserving a caller's output cap. */
export function supportsOutputTokenLimit(model: Model): boolean {
	const policy = resolveModelPolicy(toModelSpec(model)).catalog;
	return (
		model.omitMaxOutputTokens !== true &&
		policy.omitMaxOutputTokens !== true &&
		policy.preservesMaxOutputTokens !== false
	);
}
