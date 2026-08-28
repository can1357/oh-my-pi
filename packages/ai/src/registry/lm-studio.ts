import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "lm-studio";
export const DEFAULT_LOCAL_TOKEN = "lm-studio-local";

export const loginLmStudio = createApiKeyLogin({
	providerLabel: PROVIDER_ID,
	promptMessage: "Optional: Paste LM Studio API key (to customize endpoint URL, set LM_STUDIO_BASE_URL env var)",
	placeholder: DEFAULT_LOCAL_TOKEN,
	validation: null,
	emptyKeyFallback: DEFAULT_LOCAL_TOKEN,
});

export const lmStudioProvider = {
	id: "lm-studio",
	name: "LM Studio (Local OpenAI-compatible)",
	login: (cb: OAuthLoginCallbacks) => loginLmStudio(cb),
} as const satisfies ProviderDefinition;
