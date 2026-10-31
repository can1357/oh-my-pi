import { parseAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import { $env } from "@oh-my-pi/pi-utils";
import { resolveGitHubCopilotBaseUrl } from "./github-copilot-headers";
import { resolveXaiBaseUrl } from "./xai-base-url";

/** Endpoint rules that differ between the OpenAI-family transports. */
export interface OpenAIBaseUrlOptions {
	/** `alibaba-coding-plan` credentials may carry their own `enterpriseUrl`. */
	alibabaCodingPlanAuth?: boolean;
	/** Used when neither the model nor a provider rule names a base URL (`OPENAI_BASE_URL` wins over it). */
	defaultBaseUrl?: string;
}

/** `openai-completions` endpoint rules; `openai-responses` uses none of them. */
export const OPENAI_COMPLETIONS_BASE_URL_OPTIONS: OpenAIBaseUrlOptions = {
	alibabaCodingPlanAuth: true,
	defaultBaseUrl: "https://api.openai.com/v1",
};

function normalizeSakanaRequestBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim();
	if (!value) return undefined;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

/**
 * Base URL an OpenAI-family request for `model` is sent to with credential
 * `apiKey`: the model's configured URL after every provider rule that moves it
 * (`MOONSHOT_BASE_URL`, `SAKANA_BASE_URL`/`FUGU_BASE_URL`, `XAI_BASE_URL`, the
 * Copilot plan host, an Alibaba credential's own endpoint), then the default.
 * Azure's deployment path is added by the caller; it never changes the origin.
 */
export function resolveOpenAIRequestBaseUrl(
	model: { provider: string; baseUrl?: string },
	apiKey: string,
	options: OpenAIBaseUrlOptions = {},
): string | undefined {
	let baseUrl = model.baseUrl;
	switch (model.provider) {
		case "moonshot":
			// Bundled `moonshot` catalog models hardcode the international endpoint
			// (`api.moonshot.ai`). MOONSHOT_BASE_URL lets users redirect the provider
			// at the China platform (`api.moonshot.cn`), which only accepts China keys
			// and rejects the international host. (#2883)
			baseUrl = $env.MOONSHOT_BASE_URL?.trim() || baseUrl;
			break;
		case "sakana":
			baseUrl =
				normalizeSakanaRequestBaseUrl($env.SAKANA_BASE_URL) ??
				normalizeSakanaRequestBaseUrl($env.FUGU_BASE_URL) ??
				baseUrl;
			break;
		case "xai":
		case "xai-oauth":
			baseUrl = resolveXaiBaseUrl(model.provider, baseUrl, apiKey);
			break;
		case "github-copilot":
			baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl;
			break;
		case "alibaba-token-plan":
			baseUrl = parseAlibabaTokenPlanCredential(apiKey)?.baseUrl || baseUrl;
			break;
		case "alibaba-coding-plan":
			if (options.alibabaCodingPlanAuth) {
				try {
					const parsed = JSON.parse(apiKey);
					if (typeof parsed?.enterpriseUrl === "string") baseUrl = parsed.enterpriseUrl;
				} catch {
					// Not JSON — use the catalog baseUrl.
				}
			}
			break;
	}
	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}
	return baseUrl;
}
