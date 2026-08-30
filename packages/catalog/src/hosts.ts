/**
 * Known model-endpoint host classification — the single vocabulary for the
 * `provider === id || baseUrl.includes(marker)` idiom that gates wire-level
 * behavior (compat detection, routing, header shaping, watchdog floors).
 *
 * Markers are case-insensitive substrings matched against the base URL, NOT
 * parsed hostnames: proxies regularly embed the upstream host in a path
 * segment, and the historical call sites all used substring semantics.
 * Callers that need strict hostname matching — where a substring false
 * positive is dangerous, e.g. the Anthropic official-endpoint OAuth gate —
 * parse the URL and compare the hostname themselves.
 */

interface HostClassSpec {
	/** Provider ids that imply this host class regardless of baseUrl. */
	readonly providers?: readonly string[];
	/** Provider-id prefixes that imply this host class (e.g. `xiaomi-token-plan-`). */
	readonly providerPrefixes?: readonly string[];
	/** Lowercase ASCII substrings matched case-insensitively against the base URL. */
	readonly urlMarkers: readonly string[];
	// Strict hostname matching is intentionally not modeled here: the one
	// auth-sensitive consumer (Anthropic official-endpoint) parses the URL
	// itself; every other call site is benign and uses substring matching.
}

export const KNOWN_HOSTS = {
	openai: { providers: ["openai"], urlMarkers: ["api.openai.com"] },
	azureOpenAI: {
		providers: ["azure"],
		urlMarkers: [".openai.azure.com", "azure.com/openai", "models.inference.ai.azure.com"],
	},
	openrouter: { providers: ["openrouter"], urlMarkers: ["openrouter.ai"] },
	vercelAIGateway: { providers: ["vercel-ai-gateway"], urlMarkers: ["ai-gateway.vercel.sh"] },
	githubCopilot: { providers: ["github-copilot"], urlMarkers: ["githubcopilot.com", "copilot-api."] },
	anthropic: { providers: ["anthropic"], urlMarkers: ["api.anthropic.com"] },
	/** DeepSeek's first-party API only — gates direct-API quirks (max_tokens field, thinking extraBody). */
	deepseekDirect: { providers: ["deepseek"], urlMarkers: ["api.deepseek.com"] },
	/** Any DeepSeek-operated host (first-party API, web-chat fronts). Wider than `deepseekDirect` on purpose. */
	deepseekFamily: { providers: ["deepseek"], urlMarkers: ["deepseek.com"] },
	cerebras: { providers: ["cerebras"], urlMarkers: ["cerebras.ai"] },
	zai: { providers: ["zai"], urlMarkers: ["api.z.ai"] },
	zhipu: { providers: ["zhipu-coding-plan"], urlMarkers: ["open.bigmodel.cn"] },
	kilo: { providers: ["kilo"], urlMarkers: ["api.kilo.ai"] },
	alibabaDashscope: {
		providers: ["alibaba-coding-plan", "alibaba-token-plan"],
		urlMarkers: ["dashscope", "token-plan."],
	},
	umans: { providers: ["umans"], urlMarkers: ["api.code.umans.ai"] },
	xiaomi: { providers: ["xiaomi"], providerPrefixes: ["xiaomi-token-plan-"], urlMarkers: ["xiaomimimo.com"] },
	xai: { providers: ["xai", "xai-oauth"], urlMarkers: ["api.x.ai"] },
	mistral: { providers: ["mistral"], urlMarkers: ["mistral.ai"] },
	together: { providers: ["together"], urlMarkers: ["api.together.xyz"] },
	baseten: { providers: ["baseten"], urlMarkers: ["baseten.co"] },
	/** URL-only on purpose: the `fireworks`/`firepass` providers route per-model and not every model is Fireworks-shaped. */
	fireworks: { urlMarkers: ["fireworks.ai"] },
	friendli: { providers: ["friendli"], urlMarkers: ["api.friendli.ai"] },
	groq: { providers: ["groq"], urlMarkers: ["api.groq.com"] },
	minimax: {
		providers: ["minimax", "minimax-code", "minimax-code-cn"],
		urlMarkers: ["api.minimax.io", "api.minimaxi.com"],
	},
	qwenPortal: { providers: ["qwen-portal"], urlMarkers: ["portal.qwen.ai"] },
	/** NVIDIA NIM (`integrate.api.nvidia.com`). Qwen NIM endpoints take `chat_template_kwargs.enable_thinking`, never top-level `enable_thinking`. */
	nvidia: { providers: ["nvidia"], urlMarkers: ["integrate.api.nvidia.com"] },
	/** Venice AI (`api.venice.ai`). OpenAI-compatible; drives reasoning via top-level `reasoning_effort` (and `venice_parameters.disable_thinking`), and rejects DashScope's top-level `enable_thinking` with a 400 (`additionalProperties: false` request schema). */
	venice: { providers: ["venice"], urlMarkers: ["api.venice.ai"] },
	moonshotNative: { providers: ["moonshot", "kimi-code"], urlMarkers: ["api.moonshot.ai", "api.kimi.com"] },
	/** Google AI Studio's OpenAI-compatible shim (`/v1beta/openai`) — a subset of chat-completions; rejects `store` with a 400. Native Gemini uses `google-generative-ai` api instead. */
	googleAistudio: { providers: [], urlMarkers: ["generativelanguage.googleapis.com"] },
	opencode: { providers: ["opencode-go", "opencode-zen"], urlMarkers: ["opencode.ai"] },
	/** ZenMux's Anthropic-compatible proxy (`zenmux.ai/api/anthropic`) forwards to signature-enforcing Anthropic. */
	zenmux: { providers: ["zenmux"], urlMarkers: ["zenmux.ai"] },
	chutes: { urlMarkers: ["chutes.ai"] },
} as const satisfies Record<string, HostClassSpec>;

export type KnownHost = keyof typeof KNOWN_HOSTS;

// Host checks fan out across every compatibility field for a model. Bound the
// cache because custom providers may contribute arbitrary endpoints at runtime.
const MAX_URL_HOST_MATCHES = 512;
const urlHostMatches = new Map<string, Map<KnownHost, boolean>>();

function getUrlHostMatches(baseUrl: string): Map<KnownHost, boolean> {
	let matches = urlHostMatches.get(baseUrl);
	if (matches !== undefined) return matches;
	if (urlHostMatches.size === MAX_URL_HOST_MATCHES) urlHostMatches.clear();
	matches = new Map<KnownHost, boolean>();
	urlHostMatches.set(baseUrl, matches);
	return matches;
}

/** URL-only host check (for call sites that have no provider id, e.g. raw env config). */
export function hostMatchesUrl(baseUrl: string | undefined, host: KnownHost): boolean {
	if (!baseUrl) return false;
	const matches = getUrlHostMatches(baseUrl);
	const cached = matches.get(host);
	if (cached !== undefined) return cached;
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	for (const marker of spec.urlMarkers) {
		if (includesAsciiCaseInsensitive(baseUrl, marker)) {
			matches.set(host, true);
			return true;
		}
	}
	matches.set(host, false);
	return false;
}

/** Provider-or-URL host check — the canonical `provider === id || baseUrl.includes(marker)` idiom. */
export function modelMatchesHost(model: { provider: string; baseUrl: string }, host: KnownHost): boolean {
	const spec: HostClassSpec = KNOWN_HOSTS[host];
	if (spec.providers) {
		for (const provider of spec.providers) {
			if (model.provider === provider) return true;
		}
	}
	if (spec.providerPrefixes) {
		for (const prefix of spec.providerPrefixes) {
			if (model.provider.startsWith(prefix)) return true;
		}
	}
	return hostMatchesUrl(model.baseUrl, host);
}

function includesAsciiCaseInsensitive(value: string, lowerNeedle: string): boolean {
	const needleLength = lowerNeedle.length;
	const end = value.length - needleLength;
	for (let start = 0; start <= end; start++) {
		let offset = 0;
		for (; offset < needleLength; offset++) {
			if ((value.charCodeAt(start + offset) | 0x20) !== lowerNeedle.charCodeAt(offset)) break;
		}
		if (offset === needleLength) return true;
	}
	return false;
}

// --- Endpoint-shape predicates (URL path/verb shapes, not vendor hosts) ---

/**
 * Hostname for a Vertex AI GenerateContent / rawPredict / OpenAI-compat
 * request for the given location.
 *
 * - `global` → global endpoint (`aiplatform.googleapis.com`)
 * - `eu` / `us` multi-regions → REP endpoints (`aiplatform.{eu|us}.rep.googleapis.com`)
 * - every other location → regional (`{location}-aiplatform.googleapis.com`)
 *
 * Multi-region codes do NOT follow the regional `{location}-aiplatform` pattern;
 * interpolating them that way yields hosts like `eu-aiplatform.googleapis.com`
 * that 404.
 */
export function resolveVertexEndpointHost(location: string): string {
	if (location === "global") return "aiplatform.googleapis.com";
	if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`;
	return `${location}-aiplatform.googleapis.com`;
}

/** Vertex AI express-mode OpenAI-compatible endpoint (`…/endpoints/openapi`). */
export function isVertexExpressOpenAIUrl(baseUrl: string): boolean {
	return baseUrl.includes("/endpoints/openapi");
}

/** Vertex AI Anthropic raw-predict endpoints (`:streamRawPredict` / `:rawPredict`). */
export function isVertexRawPredictUrl(baseUrl: string): boolean {
	return baseUrl.includes(":streamRawPredict") || baseUrl.includes(":rawPredict");
}

/** Azure OpenAI deployment-scoped path (`…/deployments/<name>/…`). */
export function isAzureDeploymentsUrl(baseUrl: string): boolean {
	return baseUrl.includes("/deployments/");
}

/** Alibaba DashScope consumer `compatible-mode` endpoint (rejects multimodal arrays for some text-only SKUs). */
export function isDashscopeCompatibleModeUrl(baseUrl: string): boolean {
	const normalized = baseUrl.toLowerCase();
	return (
		normalized.includes("dashscope") && normalized.includes("aliyuncs.com") && normalized.includes("/compatible-mode")
	);
}
