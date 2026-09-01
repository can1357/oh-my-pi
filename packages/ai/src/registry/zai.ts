import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://z.ai/manage-apikey/apikey-list";
const API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.2";

export const loginZai = createApiKeyLogin({
	providerLabel: "Z.AI",
	authUrl: AUTH_URL,
	instructions: "Copy your API key from the dashboard",
	promptMessage: "Paste your Z.AI API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "Z.AI",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const zaiProvider = {
	id: "zai",
	name: "Z.AI (GLM Coding Plan)",
	login: (cb: OAuthLoginCallbacks) => loginZai(cb),
} as const satisfies ProviderDefinition;

export const zaiCodingPlanProvider = {
	id: "zai-coding-plan",
	name: "Z.AI (GLM Coding Plan · Sign in)",
	// Minted key lives in creds.access; getOAuthApiKey returns it for the `zai`
	// catalog provider verbatim, so store credentials under `zai`.
	storeCredentialsAs: "zai",
	// Loopback callback server on the ZCode-registered CLI port, plus the manual
	// paste-code fallback (PASTE_CODE_LOGIN_PROVIDERS) for when the browser
	// cannot reach this machine. Mirrors the Anthropic sign-in wiring.
	callbackPort: 9999,
	pasteCodeFlow: true,
	login: (cb: OAuthLoginCallbacks) => import("./oauth/zai").then(m => m.loginZaiOAuth(cb)),
} as const satisfies ProviderDefinition;
