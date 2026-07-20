import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import packageJson from "../../package.json" with { type: "json" };

const OPENROUTER_APP_TITLE = APP_NAME.replace(/\b\w/g, character => character.toUpperCase()).replace(/Pk$/, "PK");

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `${APP_NAME}/${packageJson.version}`,
		"HTTP-Referer": "https://oh-my-pk.pkking.computer/",
		"X-OpenRouter-Title": OPENROUTER_APP_TITLE,
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
