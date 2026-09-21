/**
 * Amazon Bedrock runtime-region resolution shared by the Converse and Chat
 * (OpenAI-compatible) transports. Extracted unchanged from
 * `providers/amazon-bedrock.ts` so both APIs route geo-prefixed inference
 * profiles identically.
 */
import { resolveAwsAmbientRegion } from "./aws-profile";

/** Region inputs shared by every Bedrock wire transport. */
export interface BedrockRegionSource {
	/** Explicit per-request AWS region; wins outright. */
	region?: string;
	/** Named AWS shared-credentials/config profile (ambient region source). */
	profile?: string;
	/** Guardrail id or ARN; an ARN in the profile's geo may supply the region. */
	guardrailIdentifier?: string;
}

/**
 * Default AWS region for each Bedrock cross-region inference-profile geo prefix.
 * A geo-prefixed profile (e.g. `eu.anthropic.claude-…`) is only servable from
 * regions in its own geo, so routing one to `us-east-1` yields HTTP 400 "The
 * provided model identifier is invalid." `global.` profiles are anchored in the
 * us regions and intentionally absent here (they resolve fine via `us-east-1`).
 */
export const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

/**
 * AWS's own regional host, which every bundled catalog entry carries as a required
 * placeholder `baseUrl` — no routing info, so its region segment is re-derived.
 * FIPS, VPC-endpoint and gateway hosts don't match and are used as configured.
 */
export const AWS_REGIONAL_BEDROCK_HOST = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

/** Extract the region embedded in a Bedrock model/guardrail ARN, if any. */
export function inferRegionFromBedrockArn(modelId: string): string | undefined {
	const parts = modelId.split(":", 6);
	if (parts[0] !== "arn" || parts[2] !== "bedrock") return undefined;
	const region = parts[3];
	return region || undefined;
}

/** Geo prefix of a cross-region inference-profile id, e.g. `eu.anthropic.…` → `eu`. */
export function inferenceProfileGeo(modelId: string): string | undefined {
	const dot = modelId.indexOf(".");
	if (dot <= 0) return undefined;
	const prefix = modelId.slice(0, dot);
	return prefix in INFERENCE_PROFILE_GEO_DEFAULT_REGION ? prefix : undefined;
}

/**
 * Whether a concrete AWS region can serve a given inference-profile geo. The
 * `ap-` regions overlap across `apac`/`au`/`jp` profiles, so the Australia and
 * Japan geos pin their specific source regions rather than matching all `ap-*`.
 */
export function regionServesGeo(region: string, geo: string): boolean {
	switch (geo) {
		case "us-gov":
			return region.startsWith("us-gov-");
		case "us":
			return region.startsWith("us-") && !region.startsWith("us-gov-");
		case "eu":
			return region.startsWith("eu-");
		case "apac":
			return region.startsWith("ap-");
		case "au":
			return region === "ap-southeast-2" || region === "ap-southeast-4";
		case "jp":
			return region === "ap-northeast-1" || region === "ap-northeast-3";
		default:
			return false;
	}
}

/**
 * Resolve the Bedrock runtime region for a request. An explicit per-request
 * region and an ARN-embedded model region win outright. Otherwise, for a
 * geo-prefixed cross-region inference profile (`us.`/`eu.`/`apac.`/`au.`/`jp.`/
 * `us-gov.`), an ambient region (`AWS_REGION` / `AWS_DEFAULT_REGION`) is
 * honored only when it can serve the profile's geo. If the ambient region is
 * absent or mismatched, a same-geo guardrail ARN region is used when available;
 * otherwise the geo default is used. `global.` profiles have no geo entry, so
 * the ambient region (or, when absent, a guardrail ARN's region or
 * `us-east-1`) is used unchanged.
 */
export function resolveBedrockRegion(modelId: string, options: BedrockRegionSource): string {
	const explicit = options.region || inferRegionFromBedrockArn(modelId);
	if (explicit) return explicit;
	const ambient = resolveAwsAmbientRegion(options.profile);
	const guardrailRegion = inferRegionFromBedrockArn(options.guardrailIdentifier ?? "");
	const geo = inferenceProfileGeo(modelId);
	if (geo) {
		if (ambient && regionServesGeo(ambient, geo)) return ambient;
		if (guardrailRegion && regionServesGeo(guardrailRegion, geo)) return guardrailRegion;
		return INFERENCE_PROFILE_GEO_DEFAULT_REGION[geo];
	}
	return ambient || guardrailRegion || "us-east-1";
}
