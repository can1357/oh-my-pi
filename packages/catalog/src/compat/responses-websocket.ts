import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Capability is rule-owned; callers must opt in. Either explicit false vetoes
 * the other preference, including a per-request true for a disabled model.
 */
export function resolveResponsesWebSocketPreference(model: Model, requestPreference?: boolean): boolean {
	if (resolveCatalogPolicy(model).supportsWebsockets !== true) return false;
	if (requestPreference === false || model.preferWebsockets === false) return false;
	return requestPreference === true || model.preferWebsockets === true;
}
