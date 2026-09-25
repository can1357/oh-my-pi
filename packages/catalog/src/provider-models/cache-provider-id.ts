import { CHARM_HYPER_API_BASE_URL, normalizeCharmHyperBaseUrl } from "../wire/charm-hyper";
import { CODEX_CLIENT_VERSION } from "../wire/codex";
import { PERSONAL_GITHUB_COPILOT_BASE_URL } from "../wire/github-copilot";
import {
	SINGULARITYAPI_DEV_API_BASE_URL,
	SINGULARITYAPI_TECH_API_BASE_URL,
	normalizeSingularityApiBaseUrl,
} from "../wire/singularityapi";

export interface ModelCacheProviderIdOptions {
	apiKey?: string;
	baseUrl?: string;
}

const CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS: Readonly<Record<string, true>> = {
	"opencode-go": true,
	"opencode-zen": true,
	"github-copilot": true,
	"muse-code": true,
	// Both SingularityAPI rosters are issued per key, so the namespace must be
	// resolved with the credential (`hydrateCredentialScopedModelCaches`) rather
	// than from the synchronous, credential-less startup read.
	"singularityapi-dev": true,
	"singularityapi-tech": true,
	"merge-gateway": true,
};

/** Whether a provider's model-cache namespace requires its resolved credential. */
export function isCredentialScopedModelCacheProvider(providerId: string): boolean {
	return CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS[providerId] === true;
}

export function getDefaultModelDiscoveryBaseUrl(providerId: string): string | undefined {
	switch (providerId) {
		case "charm-hyper":
			return CHARM_HYPER_API_BASE_URL;
		case "meta":
		case "muse-code":
			return "https://api.meta.ai/v1";
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
		case "openai-codex":
			// The backend filters the roster by client version.
			return `${providerId}:${CODEX_CLIENT_VERSION}`;
		case "ollama":
			return resolveOllamaModelCacheProviderId(providerId, options.baseUrl);
		case "cursor":
			// v4: Grok 4.5/4.6 rows cached before the effort-less default-tier fix
			// carry `requestModelId: *-low`, which the Start plan refuses; refetch
			// so the collapsed default is re-pointed to `-medium` (issue #9478).
			return "cursor:default-effort-v4";
		case "charm-hyper": {
			// Discovery is authoritative for this gateway, so a warm cache is served
			// for its full TTL without re-probing: the namespace must follow the
			// configured endpoint, or a self-hosted proxy keeps serving the canonical
			// host's roster, capabilities and tariffs until expiry.
			//
			// Endpoint-only scope is deliberate. `/v1/models` is public here, so the
			// roster does not vary by key, and `charm-hyper` is absent from
			// CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS — `ModelRegistry` resolves this
			// namespace with no credential at all, so hashing one would split it
			// against the namespace discovery computes and miss forever.
			//
			// Normalized through the shared helper because the registry passes the
			// raw configured value while `charmHyperModelManagerOptions` passes a
			// `/v1`-suffixed one; both must land on one namespace.
			return `charm-hyper:models-v1:${Bun.hash(normalizeCharmHyperBaseUrl(options.baseUrl)).toString(36)}`;
		}
		case "muse-code": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `muse-code:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "singularityapi-dev":
		case "singularityapi-tech": {
			// Both products issue their roster per key, and a configured proxy
			// publishes its own. Discovery is authoritative, so a shared namespace
			// would serve the previous key's roster for the full 24h TTL — including
			// ids the current key cannot call. Hashing the pair means switching
			// either re-runs discovery instead, and the provider-id prefix keeps the
			// two products from ever reading each other's rows behind one proxy.
			//
			// Both call paths must land on one namespace: `ModelRegistry` resolves
			// this provider through the credential-scoped hydration pass (it is in
			// CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS), while discovery hashes the
			// `/v1`-suffixed endpoint the matching `singularityApi*ModelManagerOptions`
			// passes — which is why both normalize through
			// `normalizeSingularityApiBaseUrl` against their own canonical host.
			const canonical =
				providerId === "singularityapi-tech" ? SINGULARITYAPI_TECH_API_BASE_URL : SINGULARITYAPI_DEV_API_BASE_URL;
			const baseUrl = normalizeSingularityApiBaseUrl(options.baseUrl, canonical);
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `${providerId}:models-v1:${Bun.hash(scope).toString(36)}`;
		}
		case "litellm": {
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			// rich-v11 invalidates rows that inherited ClinePass gateway metadata
			// through generic models.dev bare-id enrichment (issue #10932). rich-v10
			// filtered known non-conversational LiteLLM modes, unioned compat across
			// the management endpoints, and keyed the deployment's `supports_vision`
			// declaration into it; earlier versions invalidated rows whose
			// `compatConfig` retained a colliding bundled model's provider-specific
			// transport (e.g. Fireworks `wireModelIdMode`) (issue #9938).
			return `litellm:rich-v11:${Bun.hash(baseUrl).toString(36)}`;
		}
		case "gmi-cloud":
		case "siliconflow":
		case "siliconflow-cn":
			// models-v1 moves rows enriched before cross-provider reference
			// isolation out of the legacy bare-provider namespaces (#10932).
			return `${providerId}:models-v1`;
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
			// v2: rows cached before the cross-provider routing strip inherit
			// Cursor collapsed-family wire ids (e.g. enterprise-only
			// `gpt-5.6-sol-fast` pinned to `-none-fast`); use a fresh namespace
			// so they refetch instead of serving the poisoned rows. Listing ids
			// cannot cover this class — any enterprise-only sibling can carry
			// another provider's routing — so version the namespace instead.
			const baseUrl = options.baseUrl ?? PERSONAL_GITHUB_COPILOT_BASE_URL;
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `github-copilot:models-v2:${Bun.hash(scope).toString(36)}`;
		}
		case "merge-gateway": {
			const baseUrl = (options.baseUrl ?? "https://api-gateway.merge.dev/v1/openai").replace(/\/+$/g, "");
			const scope = `${options.apiKey ?? ""}\u0000${baseUrl}`;
			return `merge-gateway:models-v2:${Bun.hash(scope).toString(36)}`;
		}
		case "openrouter":
			return "openrouter:pseudo-api";
		case "vllm": {
			// v2: qwen3.8 rows cached before the reasoning/template-effort upgrade
			// carry `reasoning: false` and must be refetched.
			const baseUrl = options.baseUrl ?? getDefaultModelDiscoveryBaseUrl(providerId)!;
			return `vllm:models-v2:${Bun.hash(baseUrl).toString(36)}`;
		}
		case "devin":
			// v2: rows cached before Fusion pairings carried their lead uid as
			// `requestModelId` send the composite uid and fail with
			// `permission_denied: no API providers are available`.
			return "devin:models-v2";
		default:
			return providerId;
	}
}
