/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Exa
export const cfgExaEnabled = register({
	id: "exa.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Exa",
		description: "Enable the Exa web search provider",
	},
});

export const cfgExaSearchDelayMs = register({
	id: "exa.searchDelayMs",
	type: "number",
	default: 1_000,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Exa Search Delay",
		description: "Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
	},
});

// SearXNG
export const cfgSearxngEndpoint = register({
	id: "searxng.endpoint",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_ENDPOINT", fallback: true },
	ui: {
		tab: "providers",
		group: "Services",
		label: "SearXNG Endpoint",
		description: "Base URL of a self-hosted SearXNG instance used for web search",
	},
});

export const cfgSearxngToken = register({
	id: "searxng.token",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_TOKEN", fallback: true },
	credential: true,
});

export const cfgSearxngBasicUsername = register({
	id: "searxng.basicUsername",
	type: "string",
	default: undefined,
	// An empty username/password is a valid RFC 7617 credential, so blank text is kept.
	env: { name: "SEARXNG_BASIC_USERNAME", parse: raw => raw, fallback: true },
});

export const cfgSearxngBasicPassword = register({
	id: "searxng.basicPassword",
	type: "string",
	default: undefined,
	env: { name: "SEARXNG_BASIC_PASSWORD", parse: raw => raw, fallback: true },
	credential: true,
});

export const cfgSearxngCategories = register({ id: "searxng.categories", type: "string", default: undefined });

export const cfgSearxngEngines = register({ id: "searxng.engines", type: "string", default: undefined });

export const cfgSearxngLanguage = register({ id: "searxng.language", type: "string", default: undefined });

export const cfgSearxngSafesearch = register({ id: "searxng.safesearch", type: "number", default: undefined });
