import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": APP_URL,
		"X-OpenRouter-Title": APP_NAME,
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
