import { parseMuseCodeCredential } from "./oauth/muse-code";
import type { ProviderTransport } from "./build";

/** Muse stores both the Meta account token and its subscription-minted Model API key in one OAuth bearer. */
export const museCodeTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		if (!options.apiKey) return { model, options };
		const { apiKey } = parseMuseCodeCredential(options.apiKey);
		return {
			model,
			options: {
				...options,
				apiKey,
				headers: { "x-api-version": "1.0.0", ...options.headers },
			},
		};
	},
	prepareModelDiscovery: config => {
		if (!config.apiKey) return { ...config, authenticated: false };
		const { apiKey } = parseMuseCodeCredential(config.apiKey);
		return { ...config, apiKey, authenticated: true };
	},
};
