/**
 * SingularityAPI gateways, shared so a host migration — or a self-hosted
 * proxy override — touches a single module.
 *
 * SingularityAPI ships two unrelated products behind one brand: the
 * pay-as-you-go universal gateway (`singularityapi-dev`) and the
 * slot-reserved DeepSeek lanes (`singularityapi-tech`). They accept disjoint
 * keys, so each provider resolves its own canonical endpoint from here.
 */
import { normalizeV1BaseUrl } from "./v1-base-url";

export const SINGULARITYAPI_DEV_API_BASE_URL = "https://api.singularityapi.dev/v1";
export const SINGULARITYAPI_TECH_API_BASE_URL = "https://api.singularityapi.tech/v1";

/**
 * Resolve a configured SingularityAPI base URL onto its gateway's `/v1`
 * surface. See `normalizeV1BaseUrl` for why every consumer must share it;
 * `canonical` is the caller's own product host and has no default.
 */
export function normalizeSingularityApiBaseUrl(baseUrl: string | undefined, canonical: string): string {
	return normalizeV1BaseUrl(baseUrl, canonical);
}
