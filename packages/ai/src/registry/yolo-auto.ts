import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Yolo-Auto login flow (API key paste, validated via `/v1/models`).
 *
 * Yolo-Auto is a flat-rate OpenAI-compatible API. `GET /v1/models` 401s any
 * missing or invalid bearer (verified against the live endpoint), so it doubles
 * as the canonical "who am I" check — the same role OpenRouter's `/auth/key`
 * plays there.
 */
export const loginYoloAuto = createApiKeyLogin({
	providerLabel: "Yolo-Auto",
	authUrl: "https://yolo-auto.com/app",
	instructions: "Create or copy your Yolo-Auto API key (yolo_...)",
	promptMessage: "Paste your Yolo-Auto API key",
	placeholder: "yolo_...",
	validation: {
		kind: "models-endpoint",
		provider: "Yolo-Auto",
		modelsUrl: "https://yolo-auto.com/v1/models",
	},
});

export const yoloAutoProvider = {
	id: "yolo-auto",
	name: "Yolo-Auto",
	login: (cb: OAuthLoginCallbacks) => loginYoloAuto(cb),
} as const satisfies ProviderDefinition;
