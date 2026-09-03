/**
 * `env hook=…` resolvers: computed API-key env fallbacks that inspect more
 * than a fixed variable list (Foundry mode, AWS credential chains, Vertex ADC).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $pickenv } from "@oh-my-pi/pi-utils";
import { isFoundryEnabled } from "../../utils/foundry";
import { resolveAwsRegistryApiKey } from "../aws";
import { AUTHENTICATED_SENTINEL } from "../types";
import type { EnvHook } from "./types";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $env.GOOGLE_APPLICATION_CREDENTIALS;
		cachedVertexAdcCredentialsExists = fs.existsSync(
			gacPath ?? path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
		);
	}
	return cachedVertexAdcCredentialsExists;
}

export const ENV_HOOKS: Record<string, EnvHook> = {
	// Foundry mode optionally switches Anthropic auth to enterprise gateway credentials.
	"anthropic-foundry": () =>
		isFoundryEnabled()
			? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
			: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
	// Amazon Bedrock accepts bearer tokens, IAM keys, profiles, ECS/IRSA credential chains.
	"aws-bedrock": () => resolveAwsRegistryApiKey({ allowSkipAuth: true }),
	"aws-bedrock-mantle": () => resolveAwsRegistryApiKey(),
	// openzoo's local proxy pays per call from its own wallet and ignores the
	// bearer, so a missing env var must still read as authenticated — the
	// placeholder is what `empty-fallback` stores after `/login openzoo` too.
	// OPENZOO_API_KEY still wins: a public tunnel URL checks the printed bearer.
	"openzoo-local": () => $env.OPENZOO_API_KEY?.trim() || "openzoo-local",
	// Vertex AI supports either GOOGLE_CLOUD_API_KEY or Application Default Credentials.
	"google-vertex-adc": () => {
		if ($env.GOOGLE_CLOUD_API_KEY) return $env.GOOGLE_CLOUD_API_KEY;
		const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT);
		const hasLocation = !!($env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION);
		return hasVertexAdcCredentials() && hasProject && hasLocation ? AUTHENTICATED_SENTINEL : undefined;
	},
};
