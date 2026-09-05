import { USER_AGENT } from "@oh-my-pi/pi-utils";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": "https://omp.sh/",
		"X-OpenRouter-Title": "omp",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
		// Opt in to routing metadata on every surface: the terminal response
		// event carries `openrouter_metadata.endpoints.available[]` naming the
		// inference provider that actually served the request.
		"X-OpenRouter-Metadata": "enabled",
	};
}
