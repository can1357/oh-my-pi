import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	CacheRetention,
	Context,
	OpenAIResponseInclude,
	ServiceTier,
	TokenTaskBudget,
} from "../types";

/**
 * Wire types for the omp auth-gateway.
 *
 * The gateway sits between unauthenticated clients (containerized omp,
 * llm-git, …) and the broker. It accepts provider-format HTTP requests
 * (OpenAI chat-completions / Anthropic messages / OpenAI Responses),
 * dispatches them through pi-ai's `streamSimple()`, and translates the
 * canonical event stream back to the matching wire format. The gateway
 * injects `Authorization` server-side so clients never see access tokens.
 */

/** Default bind. Loopback-only — front with reverse proxy for remote access. */
export const DEFAULT_AUTH_GATEWAY_BIND = "127.0.0.1:4000";

export type AuthGatewayToolChoice = "auto" | "none" | "required" | { name: string } | { type: "computer" };

export interface AuthGatewayParsedRequestOptions {
	// ── Sampling ──────────────────────────────────────────────────────────
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	/** OpenAI nucleus-min sampling (`min_p`). */
	minP?: number;
	/** Anthropic `stop_sequences` / OpenAI `stop`. */
	stopSequences?: string[];
	/** OpenAI `presence_penalty`. */
	presencePenalty?: number;
	/** OpenAI `frequency_penalty`. */
	frequencyPenalty?: number;
	/** OpenRouter / vLLM `repetition_penalty`. */
	repetitionPenalty?: number;
	/** OpenAI deterministic-sampling `seed`. */
	seed?: number;
	/** OpenAI `logit_bias` map (token id → bias). */
	logitBias?: Record<string, number>;
	/** OpenAI `response_format` (text | json_object | json_schema). Opaque passthrough. */
	responseFormat?: unknown;

	// ── Tools ─────────────────────────────────────────────────────────────
	toolChoice?: AuthGatewayToolChoice;
	/** OpenAI `parallel_tool_calls`. */
	parallelToolCalls?: boolean;
	/** OpenAI Responses fields requested in the response payload. */
	include?: OpenAIResponseInclude[];
	// ── Reasoning ─────────────────────────────────────────────────────────
	/** Effort-level reasoning request (OpenAI Responses / Chat `reasoning_effort`). */
	reasoning?: Effort;
	/** Force-disable reasoning (Anthropic `thinking: { type: "disabled" }`). */
	disableReasoning?: boolean;
	/**
	 * Explicit Anthropic `thinking.budget_tokens`. Mirrors Rust's
	 * `resolve_thinking_budget`: pins onto whichever effort the client
	 * requested (defaulting to High when unspecified). Preferred over the
	 * removed legacy single-number `thinkingBudget` for new code.
	 */
	explicitThinkingBudgetTokens?: number;
	/** Per-effort thinking budget map. */
	thinkingBudgets?: Partial<Record<Effort, number>>;
	/** Suppress the provider's reasoning summary stream. */
	hideThinkingSummary?: boolean;
	/** Anthropic `output_config.task_budget` advisory loop budget. */
	taskBudget?: TokenTaskBudget;
	/** Anthropic preserved-thinking behavior for a changed conversation prefix. */
	anthropicPrefixMismatchBehavior?: "drop_block" | "error";

	// ── Service / routing ─────────────────────────────────────────────────
	/** OpenAI service tier (auto|default|flex|scale|priority). */
	serviceTier?: ServiceTier;
	/** Cache retention hint derived from inbound `cache_control` markers. */
	cacheRetention?: CacheRetention;
	/** OpenAI Responses `prompt_cache_key`; also seeds provider routing when no separate session id exists. */
	promptCacheKey?: string;
	/** OpenAI Responses `previous_response_id` for response chaining. */
	previousResponseId?: string;
	/** OpenAI / abuse-tracking `user` field. */
	user?: string;

	// ── Passthrough ───────────────────────────────────────────────────────
	/**
	 * Provider-specific metadata. Anthropic uses `metadata.user_id`; OpenRouter
	 * carries routing hints; xAI uses `search_parameters`; OpenAI accepts a
	 * free-form bag. The gateway forwards as-is.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Captured allow-listed passthrough headers (anthropic-beta,
	 * anthropic-version, openai-organization, openai-project, openai-beta,
	 * x-stainless-*). Keys are lowercased.
	 */
	headers?: Record<string, string>;
	/**
	 * Escape hatch for provider-specific request controls that don't yet have a
	 * first-class field. Prefer adding a typed field over widening this.
	 */
	extra?: Record<string, unknown>;
}

export interface AuthGatewayParsedRequest {
	modelId: string;
	context: Context;
	stream: boolean;
	options: AuthGatewayParsedRequestOptions;
}

export interface AuthGatewayStreamControl {
	/** Gateway request signal. Encoders stop producing frames when it aborts. */
	signal?: AbortSignal;
	/** Called when the HTTP response body is cancelled by the client. */
	onCancel?: (reason?: unknown) => void;
}

export interface AuthGatewayFormatModule {
	parseRequest(body: unknown, headers?: Headers): AuthGatewayParsedRequest;
	encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown>;
	encodeStream(
		events: AssistantMessageEventStream,
		requestedModelId: string,
		options?: AuthGatewayParsedRequestOptions,
		control?: AuthGatewayStreamControl,
	): ReadableStream<Uint8Array>;
	/**
	 * Emit a protocol-specific error envelope. OpenAI returns
	 * `{ error: { message, type } }`; Anthropic returns
	 * `{ type: "error", error: { type, message } }`.
	 */
	formatError(status: number, type: string, message: string): Response;
}

export interface AuthGatewayServerOptions {
	/** Listen address. Default `127.0.0.1:4000`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty allows unauthenticated calls. */
	bearerTokens: string[];
	/** Version surfaced on `/healthz`. */
	version?: string;
}

export interface AuthGatewayServerHandle {
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}
