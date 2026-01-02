/**
 * Web Search Types
 *
 * Unified types for web search responses across Anthropic and Perplexity providers.
 */

/** Supported web search providers */
export type WebSearchProvider = "exa" | "anthropic" | "perplexity";

/** Source returned by search (all providers) */
export interface WebSearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (anthropic, perplexity) */
export interface WebSearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface WebSearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Anthropic: number of web search requests made */
	searchRequests?: number;
	/** Perplexity: combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface WebSearchResponse {
	provider: WebSearchProvider;
	/** Synthesized answer text (anthropic, perplexity) */
	answer?: string;
	/** Search result sources */
	sources: WebSearchSource[];
	/** Text citations with context */
	citations?: WebSearchCitation[];
	/** Follow-up questions (perplexity) */
	relatedQuestions?: string[];
	/** Intermediate search queries (anthropic) */
	searchQueries?: string[];
	/** Token usage metrics */
	usage?: WebSearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
}

/** Auth configuration for Anthropic */
export interface AnthropicAuthConfig {
	apiKey: string;
	baseUrl: string;
	isOAuth: boolean;
}

/** models.json structure for provider resolution */
export interface ModelsJson {
	providers?: Record<
		string,
		{
			baseUrl?: string;
			apiKey?: string;
			api?: string;
		}
	>;
}

/** auth.json structure for OAuth credentials */
export interface AuthJson {
	anthropic?: {
		type: "oauth";
		access: string;
		refresh?: string;
		/** Expiry timestamp in milliseconds */
		expires: number;
	};
}

/** Anthropic API response types */
export interface AnthropicWebSearchResult {
	type: "web_search_result";
	title: string;
	url: string;
	encrypted_content: string;
	page_age: string | null;
}

export interface AnthropicCitation {
	type: "web_search_result_location";
	url: string;
	title: string;
	cited_text: string;
	encrypted_index: string;
}

export interface AnthropicContentBlock {
	type: string;
	/** Text content (for type="text") */
	text?: string;
	/** Citations in text block */
	citations?: AnthropicCitation[];
	/** Tool name (for type="server_tool_use") */
	name?: string;
	/** Tool input (for type="server_tool_use") */
	input?: { query: string };
	/** Search results (for type="web_search_tool_result") */
	content?: AnthropicWebSearchResult[];
}

export interface AnthropicApiResponse {
	id: string;
	model: string;
	content: AnthropicContentBlock[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		server_tool_use?: { web_search_requests: number };
	};
}

/** Perplexity API types */
export interface PerplexityMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface PerplexityRequest {
	model: string;
	messages: PerplexityMessage[];
	temperature?: number;
	max_tokens?: number;
	search_domain_filter?: string[];
	search_recency_filter?: "day" | "week" | "month" | "year";
	return_images?: boolean;
	return_related_questions?: boolean;
	search_context_size?: "low" | "medium" | "high";
}

export interface PerplexitySearchResult {
	title: string;
	url: string;
	date?: string;
	snippet?: string;
}

export interface PerplexityResponse {
	id: string;
	model: string;
	created: number;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		search_context_size?: string;
	};
	citations?: string[];
	search_results?: PerplexitySearchResult[];
	related_questions?: string[];
	choices: Array<{
		index: number;
		finish_reason: string;
		message: {
			role: string;
			content: string;
		};
	}>;
}
