import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/** Read both discovery flags and current transport policy, including for stale bundled models. */
export function omitsOutputTokenLimit(model: Model): boolean {
	return (
		model.omitMaxOutputTokens === true || resolveModelPolicy(toModelSpec(model)).catalog.omitMaxOutputTokens === true
	);
}
