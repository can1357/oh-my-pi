/**
 * Factory Droid wire constants shared by catalog discovery, the pi-ai
 * provider, OAuth login and account usage: client identity, upstream/region
 * vocabulary, API hosts and the account-scoped model-cache namespace.
 */
import { isRecord } from "../utils";

/**
 * Client version reported to Factory's API. When bumping it, recapture the
 * native request corpus with `packages/ai/scripts/capture-factory-droid-native.ts`
 * against the matching CLI binary and make `factory-droid-native-parity.test.ts` pass.
 */
export const FACTORY_DROID_CLIENT_VERSION = "0.230.0";

/** Wire protocols the Factory proxy multiplexes; `api-routes provider="factory-droid"` picks one per model. */
export const FACTORY_DROID_WIRES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generate",
] as const;

/** Wire protocol used by the Factory proxy for each model. */
export type FactoryDroidWire = (typeof FACTORY_DROID_WIRES)[number];

/**
 * Upstream routers the proxy dispatches to, sent as the `x-api-provider`
 * header. The KDL compiler validates the rotation and region axes against it.
 */
export const FACTORY_DROID_UPSTREAMS = [
	"fireworks",
	"baseten",
	"mistral",
	"anthropic",
	"azure_anthropic",
	"vertex_anthropic",
	"bedrock_anthropic",
	"openai",
	"azure_openai",
	"bedrock_openai",
	"google",
	"xai",
	"snowflake",
	"databricks",
] as const;

/** Inference serving region; independent from account/API-host residency. */
export type FactoryDroidRegion = "global" | "us" | "eu";

/**
 * Account scope a Factory credential resolves to. Residency (`region`) selects
 * the API host; `inferenceRegion` selects eligible upstreams and capacities.
 * An EU-host account can legitimately have global inference.
 */
export interface AccountScope {
	region?: string;
	inferenceRegion?: FactoryDroidRegion;
	orgId?: string;
}

/** Inference region for an account: explicit scope wins, else EU residency infers EU, else global. */
export function resolveFactoryDroidInferenceRegion(scope: {
	region?: string;
	inferenceRegion?: FactoryDroidRegion;
}): FactoryDroidRegion {
	return scope.inferenceRegion ?? (scope.region === "eu" ? "eu" : "global");
}

/** Factory API host per residency region; EU accounts are served from the EU region. */
export function factoryDroidApiBaseUrl(region: string | undefined): string {
	return region === "eu" ? "https://api.eu.factory.ai" : "https://api.factory.ai";
}

/** Per-wire base URL for an account region; the stream layer appends the path suffix. */
export function factoryDroidWireBaseUrl(wire: FactoryDroidWire, region: string | undefined): string {
	const host = factoryDroidApiBaseUrl(region);
	switch (wire) {
		case "openai-completions":
		case "openai-responses":
			return `${host}/api/llm/o/v1`;
		case "anthropic-messages":
			return `${host}/api/llm/a`;
		case "google-generate":
			return `${host}/api/llm/g/v1`;
	}
}

/**
 * Client identity headers shared by discovery, usage and inference requests.
 * Callers add their own auth, `Accept`, routing and SDK headers.
 */
export function factoryDroidClientHeaders(orgId: string | undefined): Record<string, string> {
	return {
		"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
		"X-Factory-Client": "cli",
		...(orgId ? { "X-Factory-Org-Id": orgId } : {}),
	};
}

/** Model-cache namespace for a Factory credential and its account scope. */
export function factoryDroidModelCacheProviderId(options: { apiKey?: string } & AccountScope): string {
	// WorkOS access tokens rotate, but the proxy roster belongs to the
	// external organization and user. Keep residency in the namespace too.
	// Opaque credentials (including test keys) retain credential isolation.
	const token = options.apiKey ?? "";
	let credentialScope = `bearer\u0000${token}`;
	const parts = token.split(".");
	if (parts.length === 3 && parts.every(Boolean)) {
		try {
			const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			if (
				isRecord(claims) &&
				!Array.isArray(claims) &&
				typeof claims.external_org_id === "string" &&
				claims.external_org_id.trim() &&
				typeof claims.sub === "string" &&
				claims.sub.trim()
			) {
				credentialScope = `account\u0000${claims.external_org_id}\u0000${claims.sub}`;
			}
		} catch {
			// Non-JWT credentials continue to hash the opaque bearer.
		}
	}
	const region = options.region === "eu" ? "eu" : "global";
	const scope = `${credentialScope}\u0000${options.orgId ?? ""}\u0000${region}\u0000${options.inferenceRegion ?? region}`;
	// v4: rows cached before credits became a scalar base rate carry the old
	// `{ input, output, cacheRead }` object and must be refetched.
	return `factory-droid:models-v4:${Bun.hash(scope).toString(36)}`;
}
