import { PERSONAL_GITHUB_COPILOT_BASE_URL } from "../wire/github-copilot";

export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
}

const CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS: Readonly<Record<string, true>> = {
	"opencode-go": true,
	"opencode-zen": true,
	"github-copilot": true,
};

/** Whether a provider's model-cache namespace requires its resolved credential. */
export function isCredentialScopedModelCacheProvider(providerId: string): boolean {
	return CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS[providerId] === true;
}

export function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined {
	switch (providerId) {
		case "ollama":
			return "http://127.0.0.1:11434";
		case "litellm":
			return Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
		case "opencode-go":
			return "https://opencode.ai/zen/go/v1";
		case "opencode-zen":
			return "https://opencode.ai/zen/v1";
		case "vllm":
			return "http://127.0.0.1:8000/v1";
		default:
			return undefined;
	}
}

/** Resolve an Ollama model-cache namespace scoped to the normalized discovery endpoint. */
export function resolveOllamaModelCacheProviderId(providerId: string, baseUrl?: string): string {
	const defaultBaseUrl = getDefaultModelDiscoveryBaseUrl("ollama")!;
	let endpoint = defaultBaseUrl;
	try {
		const parsed = new URL(baseUrl ?? defaultBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		const nativePath = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) : trimmedPath;
		endpoint = `${parsed.protocol}//${parsed.host}${nativePath}`;
	} catch {
		// Malformed URLs fall back during discovery, so share the default endpoint's cache.
	}
	return `${providerId}:ollama-models-v1:${Bun.hash(endpoint).toString(36)}`;
}

/** Resolve the cache namespace used by a provider's model-manager options without constructing those options. */
export function resolveModelCacheProviderId(providerId: string, options: ModelCacheProviderIdOptions = {}): string {
	switch (providerId) {
		case "ollama":
			return resolveOllamaModelCacheProviderId(providerId, options.baseUrl);
		case "cursor":
			// v4: Grok 4.5/4.6 rows cached before the effort-less default-tier fix
			// carry `requestModelId: *-low`, which the Start plan refuses; refetch
			// so the collapsed default is re-pointed to `-medium` (issue #9478).
			return "cursor:default-effort-v4";
		case "litellm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `litellm:rich-v7:${Bun.hash(baseUrl).toString(36)}`;
		}
		case "opencode-go":
		case "opencode-zen": {
			// v3: gateway-first rows cached before stencil enrichment carry null
			// limits and `reasoning: false`; use a fresh namespace so they refetch.
			const configuredBaseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			const trimmedBaseUrl = configuredBaseUrl.endsWith("/") ? configuredBaseUrl.slice(0, -1) : configuredBaseUrl;
			const discoveryBaseUrl = trimmedBaseUrl.endsWith("/v1") ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`;
			const scope = `${options.apiKey ?? ""}\u0000${discoveryBaseUrl}`;
			return `${providerId}:models-v3:${Bun.hash(scope).toString(36)}`;
		}
		case "github-copilot": {
			// Copilot model specs bake in the plan-specific endpoint (personal vs
			// Business/Enterprise) resolved from the credential. Discovery writes an
			// authoritative cache, so `online-if-uncached` serves it for the full
			// TTL without re-probing. Keying the namespace on the credential means
			// switching `COPILOT_GITHUB_TOKEN` to a different account misses the
			// prior endpoint's cache and re-runs discovery instead of hitting the
			// stale host and 403ing (PR #8510 review).
			const baseUrl = options.baseUrl ?? PERSONAL_GITHUB_COPILOT_BASE_URL;
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `github-copilot:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "openrouter":
			return "openrouter:pseudo-api";
		case "vllm": {
			// v2: qwen3.8 rows cached before the reasoning/template-effort upgrade
			// carry `reasoning: false` and must be refetched.
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `vllm:models-v2:${Bun.hash(baseUrl).toString(36)}`;
		}
		default:
			return providerId;
	}
}
