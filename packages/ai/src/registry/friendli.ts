import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginFriendli = createApiKeyLogin({
	providerLabel: "FriendliAI",
	authUrl: "https://friendli.ai/suite",
	instructions: "Copy your Personal API key from Friendli Suite",
	promptMessage: "Paste your FriendliAI API key",
	placeholder: "flp_...",
	validation: {
		kind: "chat-completions",
		provider: "FriendliAI",
		baseUrl: "https://api.friendli.ai/serverless/v1",
		model: "zai-org/GLM-5.3",
	},
});

export const friendliProvider = {
	id: "friendli",
	name: "FriendliAI",
	login: (cb: OAuthLoginCallbacks) => loginFriendli(cb),
} as const satisfies ProviderDefinition;
