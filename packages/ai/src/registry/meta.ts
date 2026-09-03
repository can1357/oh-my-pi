import type { CompiledApiKeyLogin } from "@oh-my-pi/pi-catalog/compat/types";
import * as AIError from "../error";
import type { ProviderTransport } from "./build";
import { createApiKeyLogin } from "./engine/api-key";
import metaApiKeyInstructions from "./meta-api-key-instructions.md" with { type: "text" };
import metaApiKeyPlaceholder from "./meta-api-key-placeholder.md" with { type: "text" };
import metaApiKeyPrompt from "./meta-api-key-prompt.md" with { type: "text" };
import metaLoginPrompt from "./meta-login.md" with { type: "text" };
import metaLoginPlaceholder from "./meta-login-placeholder.md" with { type: "text" };
import { loginMetaMuse } from "./oauth/meta-muse";
import type { OAuthController, OAuthCredentials } from "./oauth/types";

const loginMetaApiKey = createApiKeyLogin(
	{
		kind: "api-key",
		authUrl: "https://developer.meta.com/ai/",
		instructions: metaApiKeyInstructions,
		prompt: metaApiKeyPrompt,
		placeholder: metaApiKeyPlaceholder,
		validate: {
			kind: "models-endpoint",
			label: "Meta Model API",
			url: "https://api.meta.ai/v1/models",
		},
	} satisfies CompiledApiKeyLogin,
	"Meta Model API",
);

export async function loginMeta(callbacks: OAuthController): Promise<OAuthCredentials | string> {
	if (!callbacks.onPrompt) throw new AIError.OnPromptRequiredError("Meta");
	const method =
		callbacks.authMethod ??
		(
			await callbacks.onPrompt({
				message: metaLoginPrompt,
				placeholder: metaLoginPlaceholder,
			})
		).trim();
	if (callbacks.signal?.aborted || method.length === 0) throw new AIError.LoginCancelledError();
	if (method === "muse" || method === "1") return loginMetaMuse(callbacks);
	if (method === "api-key" || method === "2") return loginMetaApiKey(callbacks);
	throw new AIError.ConfigurationError("Choose 1 for Muse Code or 2 for a Model API key");
}

/** Meta uses the Model API key minted beside the Muse OAuth credential. */
export const metaTransport: ProviderTransport = {
	getApiKey: credentials => {
		if (!credentials.apiKey) throw new Error("Muse Code OAuth credential is missing its Model API key");
		return credentials.apiKey;
	},
};
