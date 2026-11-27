import type { CatalogPolicyInputs } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether {@link model}'s deployment is a Kimi Code managed `/coding/v1`
 * endpoint (`kimi-code-endpoint` axis, declared at the provider root in
 * `providers/kimi-code*.kdl`). These deployments get the dedicated Kimi
 * stream dispatcher, the shared Kimi CLI client headers, and one prompt-cache
 * affinity identity across their two transports. Provider-scoped, like the
 * registry guard it replaces: a custom base URL on a Kimi Code provider keeps
 * the dispatch.
 */
export function isKimiCodeEndpoint(model: CatalogPolicyInputs): boolean {
	return resolveCatalogPolicy(model).kimiCodeEndpoint === true;
}
