/** Region resolution shared by Bedrock Converse and Chat Completions. */
import { resolveAwsAmbientRegion } from "./aws-profile";

export interface BedrockRegionSource {
	/** Explicit region takes precedence over model and profile regions. */
	region?: string;
	/** Named AWS profile. */
	profile?: string;
	/** Guardrail ARN used as a region fallback. */
	guardrailIdentifier?: string;
}

// Geographic profiles require a source region in the same geography.
// Global profiles use the ambient region instead.
export const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

// Rewrite standard AWS hosts; preserve FIPS, VPC endpoints, and gateways.
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

/** Match source regions to inference-profile geography. */
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

/** Resolve explicit, model ARN, ambient, guardrail ARN, and geographic fallback regions. */
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
