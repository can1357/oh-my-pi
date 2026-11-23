import type { Model } from "../types";
import { isCatalogEndpointUrl } from "./catalog-endpoint";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether {@link model}'s endpoint accepts a `max_tokens: 0` prompt-cache
 * pre-warm request (`prompt-cache-prewarm` axis). Only the provider's own
 * endpoint qualifies: a gateway or proxy reusing the provider id may reject it.
 */
export function isPromptCachePrewarmSupported(model: Model): boolean {
	return resolveCatalogPolicy(model).promptCachePrewarm === true && isCatalogEndpointUrl(model, model.baseUrl);
}
