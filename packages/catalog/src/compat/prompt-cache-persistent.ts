import type { Model } from "../types";
import { isCatalogEndpointUrl } from "./catalog-endpoint";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether {@link model}'s prompt-cache entries never expire
 * (`prompt-cache-persistent` axis). Only the provider's own endpoint
 * qualifies: a gateway or proxy reusing the provider id makes no such promise.
 */
export function isPromptCachePersistent(model: Model): boolean {
	return resolveCatalogPolicy(model).promptCachePersistent === true && isCatalogEndpointUrl(model, model.baseUrl);
}
