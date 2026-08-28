import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * ArkaneCloud login flow (API key paste, validated via `/api/v2/models`).
 *
 * ArkaneCloud is an OpenAI-compatible inference API. Its documented model
 * listing is credential-gated — a missing or invalid bearer returns
 * `401 {"error":{"code":"unauthorized",…}}` (verified against the live
 * endpoint) — so it doubles as the canonical "is this key good" check without
 * spending inference tokens.
 */
export const loginArkaneCloud = createApiKeyLogin({
	providerLabel: "ArkaneCloud",
	authUrl: "https://console.arkanecloud.com/management",
	instructions: "Create or copy your ArkaneCloud API key (ak_...)",
	promptMessage: "Paste your ArkaneCloud API key",
	placeholder: "ak_...",
	validation: {
		kind: "models-endpoint",
		provider: "ArkaneCloud",
		modelsUrl: "https://console.arkanecloud.com/api/v2/models",
	},
});

export const arkaneCloudProvider = {
	id: "arkanecloud",
	name: "ArkaneCloud",
	login: (cb: OAuthLoginCallbacks) => loginArkaneCloud(cb),
} as const satisfies ProviderDefinition;
