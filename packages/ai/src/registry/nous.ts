import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const NOUS_PROXY_API_KEY = "sk-unused";
const NOUS_PROXY_BASE_URL = "http://127.0.0.1:8645/v1";
const NOUS_PROXY_DOCS_URL =
	"https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/subscription-proxy.md";

/** Connect OMP to the credential-refreshing Nous Portal proxy shipped by Hermes. */
export async function loginNousPortal(options: OAuthController): Promise<string> {
	options.onAuth?.({
		url: NOUS_PROXY_DOCS_URL,
		instructions: "Run `hermes portal`, then keep `hermes proxy start` running before continuing.",
	});
	options.onProgress?.("Checking the local Nous Portal proxy...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "Nous Portal proxy",
		apiKey: NOUS_PROXY_API_KEY,
		modelsUrl: `${NOUS_PROXY_BASE_URL}/models`,
		signal: options.signal,
		fetch: options.fetch,
	});
	return NOUS_PROXY_API_KEY;
}

export const nousProvider = {
	id: "nous",
	name: "Nous Portal (Hermes proxy)",
	login: (callbacks: OAuthLoginCallbacks) => loginNousPortal(callbacks),
} as const satisfies ProviderDefinition;
