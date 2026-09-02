import { $env } from "@oh-my-pi/pi-utils";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "openzoo";
const DEFAULT_LOCAL_BASE_URL = "http://localhost:8402/v1";
/**
 * Placeholder bearer for the keyless local proxy. openzoo pays per call from
 * its own local wallet and ignores `Authorization` on localhost; only a public
 * tunnel URL checks the bearer printed at proxy startup.
 */
export const OPENZOO_LOCAL_TOKEN = "openzoo-local";

export const loginOpenzoo = createApiKeyLogin({
	providerLabel: PROVIDER_ID,
	authUrl: "https://openzoo.fun",
	instructions: `Run \`npx openzoo\` (default base URL: ${DEFAULT_LOCAL_BASE_URL}; set OPENZOO_BASE_URL to customize). The local proxy is keyless — leave this empty. Paste the oz_… bearer only when pointing OMP at an openzoo public tunnel URL.`,
	promptMessage: "Paste your openzoo tunnel bearer (optional; the local proxy is keyless)",
	placeholder: OPENZOO_LOCAL_TOKEN,
	validation: null,
	emptyKeyFallback: OPENZOO_LOCAL_TOKEN,
});

export const openzooProvider = {
	id: PROVIDER_ID,
	name: "openzoo (local x402 pay-per-call proxy)",
	// Keyless by design: resolve a placeholder so the provider counts as
	// authenticated with no env var and no login. `OPENZOO_API_KEY` still wins
	// (any value works locally; a tunnel URL needs the printed bearer).
	envKeys: () => $env.OPENZOO_API_KEY?.trim() || OPENZOO_LOCAL_TOKEN,
	login: (cb: OAuthLoginCallbacks) => loginOpenzoo(cb),
} as const satisfies ProviderDefinition;
