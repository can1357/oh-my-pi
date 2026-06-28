/**
 * Wafer Serverless login flow.
 *
 * Wafer (https://wafer.ai) exposes a pay-as-you-go OpenAI-compatible SKU at
 * `https://pass.wafer.ai/v1`. Keys use the `wfr_…` prefix and are validated
 * against `/v1/models`, which is cheap (no token spend).
 */
import { createApiKeyLogin } from "../api-key-login";

const WAFER_AUTH_URL = "https://wafer.ai/dashboard";
const WAFER_MODELS_URL = "https://pass.wafer.ai/v1/models";

export const loginWaferServerless = createApiKeyLogin({
	providerLabel: "Wafer Serverless",
	authUrl: WAFER_AUTH_URL,
	instructions: "Create or copy your Wafer Serverless API key from the Wafer dashboard",
	promptMessage: "Paste your Wafer Serverless API key",
	placeholder: "wfr_...",
	validation: {
		kind: "models-endpoint",
		provider: "Wafer Serverless",
		modelsUrl: WAFER_MODELS_URL,
	},
});
