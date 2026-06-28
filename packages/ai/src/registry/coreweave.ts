import { coreWeaveProjectHeaders } from "@pk-nerdsaver-ai/pi-catalog/wire/coreweave";
import { $env } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROJECT_SETUP_INSTRUCTIONS =
	"Create or select a CoreWeave Serverless Inference project, set COREWEAVE_PROJECT=<team>/<project> for the OpenAI-Project header, then copy your API key from account settings";

function requireCoreWeaveProjectHeaders(): Record<string, string> {
	const headers = coreWeaveProjectHeaders($env);
	if (!headers) {
		throw new AIError.ConfigurationError(
			"CoreWeave Serverless Inference requires OpenAI-Project. Set COREWEAVE_PROJECT=<team>/<project> before running /login coreweave.",
		);
	}
	return headers;
}

export const loginCoreWeave = createApiKeyLogin({
	providerLabel: "CoreWeave Serverless Inference",
	authUrl: "https://wandb.ai/settings",
	instructions: PROJECT_SETUP_INSTRUCTIONS,
	promptMessage: "Paste your CoreWeave Serverless Inference API key",
	placeholder: "api-key",
	validation: {
		kind: "models-endpoint",
		provider: "CoreWeave Serverless Inference",
		modelsUrl: "https://api.inference.wandb.ai/v1/models",
		headers: requireCoreWeaveProjectHeaders,
	},
});

export const coreWeaveProvider = {
	id: "coreweave",
	name: "CoreWeave Serverless Inference",
	login: (cb: OAuthLoginCallbacks) => loginCoreWeave(cb),
} as const satisfies ProviderDefinition;
