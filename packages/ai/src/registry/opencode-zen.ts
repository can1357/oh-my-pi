/**
 * OpenCode Zen request routing.
 *
 * Zen has two lanes and one credential shape per login kind:
 *
 * - **API key** (`sk-…`, the `OPENCODE_API_KEY` fallback) keeps the catalog's
 *   `/zen/v1` base URL untouched.
 * - **Console OAuth** (`st_…`, see `./oauth/opencode-zen`) is rejected by
 *   `/zen/v1` and only works against the console inference lane with the
 *   `x-opencode-org-id` workspace header.
 *
 * The stored credential for the OAuth case is a JSON envelope, so this
 * transport unpacks it into a bearer + base URL + workspace header per
 * request. Everything else — the OpenCode client-identity headers in
 * `providers/inference-headers.ts` — applies to both lanes.
 */
import type { ProviderTransport } from "./build";
import {
	OPENCODE_CONSOLE_INFERENCE_BASE_URL,
	OPENCODE_CONSOLE_ORG_HEADER,
	parseOpenCodeZenCredential,
} from "./oauth/opencode-zen";

export const openCodeZenTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		const credential = parseOpenCodeZenCredential(options.apiKey);
		if (!credential) return { model, options };
		return {
			model: { ...model, baseUrl: credential.baseUrl ?? OPENCODE_CONSOLE_INFERENCE_BASE_URL },
			options: {
				...options,
				apiKey: credential.token,
				headers: { [OPENCODE_CONSOLE_ORG_HEADER]: credential.orgId, ...options.headers },
			},
		};
	},
	prepareModelDiscovery: config => {
		const credential = parseOpenCodeZenCredential(config.apiKey);
		if (!credential) return config;
		// The model list still comes from the key lane (`/zen/v1/models` accepts
		// a console token); only the bearer has to be unwrapped from the envelope.
		return { ...config, apiKey: credential.token, authenticated: true };
	},
};
