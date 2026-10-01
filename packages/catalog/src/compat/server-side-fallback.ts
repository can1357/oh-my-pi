import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Ordered model ids for Anthropic's server-side refusal `fallbacks` chain,
 * authored on the `server-side-fallback-models` catalog axis. Empty when no
 * rule assigns a chain (the model or host does not support the feature).
 */
export function serverSideFallbackModels(model: Model): readonly string[] {
	const value = resolveCatalogPolicy(model).serverSideFallbackModels;
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}
