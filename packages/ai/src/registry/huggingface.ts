import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL =
	"https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained";
const API_BASE_URL = "https://router.huggingface.co/v1";
const VALIDATION_MODEL = "openai/gpt-oss-120b";

export const loginHuggingface = createApiKeyLogin({
	providerLabel: "Hugging Face",
	authUrl: AUTH_URL,
	instructions:
		"Create/copy a token with Make calls to Inference Providers permission (usable as HUGGINGFACE_HUB_TOKEN or HF_TOKEN)",
	promptMessage: "Paste your Hugging Face token (HUGGINGFACE_HUB_TOKEN / HF_TOKEN)",
	placeholder: "hf_...",
	validation: {
		kind: "chat-completions",
		provider: "Hugging Face",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const huggingfaceProvider = {
	id: "huggingface",
	name: "Hugging Face Inference",
	login: (cb: OAuthLoginCallbacks) => loginHuggingface(cb),
} as const satisfies ProviderDefinition;
