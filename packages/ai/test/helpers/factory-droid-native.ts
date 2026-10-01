/**
 * Native Droid CLI request parity: the cases captured from the pinned CLI and
 * the projection both sides are compared through. Captures come from
 * `packages/ai/scripts/capture-factory-droid-native.ts`, which records real
 * Factory traffic for a two-turn tool round trip.
 */

/** One captured case: a model on a pinned upstream at one effort (`off`/`none` disable reasoning). */
export interface NativeCase {
	model: string;
	upstream: string;
	effort: string;
}

/** Dialect-relevant slice of one inference request. */
export interface NativeRequest {
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export interface NativeCapture extends NativeCase {
	/** The opening request, then the follow-up that carries the tool result. */
	requests: NativeRequest[];
}

/** Every dialect branch in the Factory KDL rules, per wire. */
export const NATIVE_CASES: readonly NativeCase[] = [
	// Chat Completions dialects.
	{ model: "kimi-k3", upstream: "fireworks", effort: "high" },
	{ model: "kimi-k3", upstream: "fireworks", effort: "off" },
	{ model: "kimi-k3", upstream: "baseten", effort: "high" },
	{ model: "kimi-k3", upstream: "baseten", effort: "off" },
	{ model: "nemotron-3-ultra", upstream: "baseten", effort: "high" },
	{ model: "nemotron-3-ultra", upstream: "baseten", effort: "off" },
	{ model: "nemotron-3-ultra", upstream: "fireworks", effort: "high" },
	{ model: "deepseek-v4.1-flash", upstream: "fireworks", effort: "high" },
	{ model: "deepseek-v4.1-flash", upstream: "baseten", effort: "high" },
	{ model: "deepseek-v4.1-flash", upstream: "baseten", effort: "off" },
	{ model: "glm-5.3", upstream: "fireworks", effort: "high" },
	{ model: "glm-5.3", upstream: "baseten", effort: "high" },
	{ model: "mistral-medium-3.5", upstream: "mistral", effort: "high" },
	{ model: "mistral-medium-3.5", upstream: "mistral", effort: "off" },
	{ model: "minimax-m3", upstream: "fireworks", effort: "high" },
	{ model: "qwen3.8-max", upstream: "fireworks", effort: "xhigh" },
	{ model: "inkling", upstream: "fireworks", effort: "medium" },
	// Responses dialects.
	{ model: "gpt-5.6-sol", upstream: "openai", effort: "high" },
	{ model: "gpt-5.6-sol", upstream: "openai", effort: "none" },
	{ model: "gpt-5.6-sol", upstream: "azure_openai", effort: "high" },
	{ model: "gpt-5.6-sol", upstream: "snowflake", effort: "none" },
	{ model: "gpt-5.6-terra", upstream: "bedrock_openai", effort: "none" },
	{ model: "gpt-5.6-sol-fast", upstream: "openai", effort: "medium" },
	{ model: "gpt-5.2", upstream: "openai", effort: "off" },
	{ model: "gpt-6-sol", upstream: "openai", effort: "max" },
	{ model: "grok-4.7", upstream: "xai", effort: "high" },
	// Anthropic Messages dialects.
	{ model: "claude-opus-4-5-20251101", upstream: "anthropic", effort: "high" },
	{ model: "claude-opus-4-5-20251101", upstream: "bedrock_anthropic", effort: "high" },
	{ model: "claude-sonnet-4-5-20250929", upstream: "anthropic", effort: "high" },
	{ model: "claude-sonnet-4-5-20250929", upstream: "bedrock_anthropic", effort: "high" },
	{ model: "claude-sonnet-4-5-20250929", upstream: "anthropic", effort: "off" },
	{ model: "claude-opus-4-6", upstream: "anthropic", effort: "max" },
	{ model: "claude-opus-4-8", upstream: "vertex_anthropic", effort: "high" },
	{ model: "claude-opus-4-8", upstream: "anthropic", effort: "off" },
	{ model: "claude-opus-4-8", upstream: "azure_anthropic", effort: "high" },
	{ model: "claude-opus-5", upstream: "snowflake", effort: "off" },
	{ model: "claude-fable-5", upstream: "anthropic", effort: "high" },
	{ model: "claude-opus-5-5-fast", upstream: "anthropic", effort: "high" },
	{ model: "minimax-m2.7", upstream: "fireworks", effort: "high" },
	// Gemini generateContent dialects.
	{ model: "gemini-3.8-flash", upstream: "google", effort: "medium" },
	{ model: "gemini-3.6-flash", upstream: "google", effort: "medium" },
	{ model: "gemini-3.1-pro-preview", upstream: "google", effort: "low" },
];

/** Conversation content and per-session values; neither is dialect policy. */
const CONVERSATION_KEYS = new Set([
	"messages",
	"input",
	"instructions",
	"system",
	"tools",
	"contents",
	"systemInstruction",
	"metadata",
]);
const SESSION_KEYS = new Set(["prompt_cache_key", "safety_identifier"]);

/**
 * Headers that express routing, client identity or wire dialect. The Stainless
 * arch/OS entries describe the host and its timeout the transport budget, so
 * those are left out. The last two are headers droid never sends: their
 * presence on an OMP request is an identity leak.
 */
const DIALECT_HEADERS = new Set([
	"x-api-provider",
	"anthropic-beta",
	"x-factory-client",
	"x-client-version",
	"user-agent",
	"x-provider-routing-source",
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"x-stainless-retry-count",
	"x-claude-code-session-id",
	"x-stainless-helper-method",
]);

/**
 * Deliberate differences, dropped from both sides:
 * - OMP keeps prior thinking in context (`context_management` with
 *   `clear_thinking` keep-all and its beta), which Anthropic documents as
 *   preserving prompt-cache hits; droid never sends it.
 * - Tool deferral (`defer_loading`, `execution`, the mid-conversation
 *   tool-changes beta) follows each client's own tool set.
 */
const CLIENT_OWNED_BODY_KEYS = new Set(["context_management"]);
const CLIENT_OWNED_BETAS = new Set(["context-management-2025-06-27", "mid-conversation-tool-changes-2026-07-01"]);

/**
 * Tool-schema structure plus the client-owned deferral markers; any other
 * per-tool key is a dialect flag such as `eager_input_streaming`.
 */
const TOOL_STRUCTURE_KEYS = new Set([
	"type",
	"name",
	"description",
	"input_schema",
	"parameters",
	"function",
	"functionDeclarations",
	"cache_control",
	"defer_loading",
	"execution",
]);

function toolDialectKeys(tools: unknown): string[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const keys = new Set<string>();
	for (const tool of tools) {
		if (tool && typeof tool === "object") {
			for (const key of Object.keys(tool)) if (!TOOL_STRUCTURE_KEYS.has(key)) keys.add(key);
		}
	}
	return [...keys].sort();
}

/**
 * Project one request onto its dialect: drops conversation content and
 * client-owned features, masks per-session values, and reduces tools to their
 * per-tool dialect keys.
 */
export function projectNativeRequest(
	path: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
): NativeRequest {
	const projectedHeaders: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const name = key.toLowerCase();
		if (!DIALECT_HEADERS.has(name)) continue;
		if (name !== "anthropic-beta") {
			projectedHeaders[name] = value;
			continue;
		}
		const betas = value
			.split(",")
			.map(beta => beta.trim())
			.filter(beta => !CLIENT_OWNED_BETAS.has(beta))
			.sort();
		if (betas.length > 0) projectedHeaders[name] = betas.join(",");
	}
	const projectedBody: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (CONVERSATION_KEYS.has(key) || CLIENT_OWNED_BODY_KEYS.has(key)) continue;
		projectedBody[key] = SESSION_KEYS.has(key) ? "<session>" : value;
	}
	const toolKeys = toolDialectKeys(body.tools);
	if (toolKeys) projectedBody["<tool-keys>"] = toolKeys;
	return { path, headers: projectedHeaders, body: projectedBody };
}
