import type { Api, AuthStorage, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import type { ModelRegistry } from "../../../config/model-registry";
import type { StructuredQuery } from "../query";
import type { SearchProviderId, SearchResponse } from "../types";

/**
 * Shared web search parameters passed to providers.
 *
 * `authStorage` is the **only** credential source providers may consult.
 * Opening a sibling SQLite handle or calling provider-direct refresh helpers
 * (e.g. `refreshOpenAICodexToken`, `refreshGoogleCloudToken`) is prohibited:
 * it races the broker's per-credential refresh and POSTs the broker sentinel
 * (`REMOTE_REFRESH_SENTINEL`) to the upstream token endpoint, which classifies
 * as `invalid_grant` and disables the row.
 */
export interface SearchParams {
	query: string;
	/**
	 * Structured view of `query`, parsed once by the search pipeline:
	 * Google-style directives (`site:`, `before:`/`after:`, `inurl:`,
	 * `intitle:`, `filetype:`, quoted phrases, `OR` groups, `-exclusions`)
	 * extracted into fields.
	 *
	 * Providers SHOULD map constraints onto native API parameters
	 * (domain/date filters) or engine query syntax (`formatQuery`) where the
	 * upstream supports them, and lean lenient otherwise: the pipeline
	 * post-filters every response with `applyQueryConstraints`, which
	 * always enforces scope directives (`site:`, `inurl:`, exclusions) and
	 * relaxes any other constraint that would eliminate all results. When
	 * absent (direct provider calls), parse with `parseSearchQuery(params.query)`.
	 */
	parsedQuery?: StructuredQuery;
	limit?: number;
	/**
	 * Temporal filter narrowing results to the specified time window.
	 *
	 * Providers MUST interpret this as a pure time filter. Providers MUST NOT
	 * use recency as an implicit signal to change topic scope, content domain,
	 * or ranking strategy. If a provider API couples temporal filtering with
	 * other dimensions (e.g. Tavily's `topic=news`), the provider implementation
	 * is responsible for decoupling them before calling the upstream API.
	 *
	 * Providers that do not support temporal filtering MUST ignore this field
	 * silently; they MUST NOT approximate it by rewriting the query or altering
	 * any other request parameter.
	 */
	recency?: "day" | "week" | "month" | "year";
	systemPrompt: string;
	signal?: AbortSignal;
	/** Hard timeout for this provider's search transport, in milliseconds. */
	timeoutMs?: number;
	fetch?: FetchImpl;
	maxOutputTokens?: number;
	numSearchResults?: number;
	temperature?: number;
	googleSearch?: Record<string, unknown>;
	codeExecution?: Record<string, unknown>;
	urlContext?: Record<string, unknown>;
	/**
	 * The single source of truth for credentials. Providers MUST consult this
	 * handle exclusively (`getApiKey` for bearer-style auth, `getOAuthAccess`
	 * when identity metadata is required). Do not open `AgentStorage` or any
	 * `AuthCredentialStore` directly — that bypasses the broker pipeline and
	 * the per-credential single-flight refresh.
	 */
	authStorage: AuthStorage;
	/** Selected catalog model that chose this engine or grounding backend. */
	model: Model<Api>;
	/** Thinking selector resolved from the model-role candidate. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Provider/model transport settings used by native search endpoints. */
	modelRegistry: ModelRegistry;
	/** Whether the selected model came from an explicit role-chain entry. */
	explicit?: boolean;
	/**
	 * Optional session id used as the round-robin / sticky key when selecting
	 * among multiple credentials for the same provider. Pass through from the
	 * caller's agent session when available; otherwise omit.
	 */
	sessionId?: string;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Indicates whether this provider has the credentials/config it needs to
	 * service a request right now. Implementations consult the passed
	 * {@link AuthStorage} — never a sibling store.
	 *
	 * Drives role-chain admission: providers that return `false` are skipped.
	 * Explicit selection uses {@link isExplicitlyAvailable} instead. The model
	 * is supplied for providers whose authentication depends on its transport.
	 */
	abstract isAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean;

	/**
	 * Returns `true` when this provider should run when the user explicitly
	 * selects it, even if {@link isAvailable} would reject it for the auto
	 * chain. Providers with an unauthenticated fallback kept out of the auto
	 * chain (e.g. Perplexity's anonymous ask endpoint) override this so explicit
	 * selection still routes through it rather than failing.
	 *
	 * Defaults to mirroring {@link isAvailable}.
	 */
	isExplicitlyAvailable(authStorage: AuthStorage, model?: Model<Api>): Promise<boolean> | boolean {
		return this.isAvailable(authStorage, model);
	}

	/**
	 * Whether a search now would reach a third party without a credential or
	 * endpoint the user configured: a public MCP, an anonymous API tier, or a
	 * scraped search page. With `providers.webKeyless` off, `web_search` skips
	 * such candidates unless the request names the model itself.
	 *
	 * Defaults to `false`, which holds for providers that only run on the
	 * user's own credential; every provider with a keyless path MUST override it.
	 */
	isKeyless(_authStorage: AuthStorage, _model?: Model<Api>): Promise<boolean> | boolean {
		return false;
	}

	/**
	 * Execute a search. Credentials MUST be resolved through `params.authStorage`.
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
