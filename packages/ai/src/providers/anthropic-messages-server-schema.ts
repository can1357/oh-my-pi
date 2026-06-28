/**
 * ArkType schemas for the Anthropic Messages API request shape we accept on the
 * gateway. Maps canonical wire variants to our internal normalized omp Context
 * and options.
 */

import { type } from "arktype";
import type {
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParams,
	MessageParam,
	TextBlockParam,
	Tool,
	ToolChoice,
} from "./anthropic-wire";

// `cache_control` is accepted and translated to pi-ai's per-request
// `cacheRetention` (any `ttl: "1h"` marker upgrades the request to "long";
// any other ephemeral marker maps to "short"). The walker doesn't try to
// preserve per-block breakpoints — pi-ai's anthropic provider re-applies them
// against the rebuilt outbound request anyway.
export const cacheControlSchema = type({
	type: "'ephemeral'",
	"ttl?": "'1h' | '5m'",
});

// ─── Sources / inner shapes ─────────────────────────────────────────────────

export const base64ImageSourceSchema = type({
	type: "'base64'",
	data: "string >= 1",
	media_type: "string >= 1",
});

export const urlImageSourceSchema = type({
	type: "'url'",
	url: "string.url",
});

export const fileImageSourceSchema = type({
	type: "'file'",
	file_id: "string >= 1",
});

export const imageSourceSchema = base64ImageSourceSchema.or(urlImageSourceSchema).or(fileImageSourceSchema);

const textBlockSchema = type({
	type: "'text'",
	text: "string",
	"cache_control?": cacheControlSchema,
});

const imageBlockSchema = type({
	type: "'image'",
	source: imageSourceSchema,
	"cache_control?": cacheControlSchema,
});

const thinkingBlockSchema = type({
	type: "'thinking'",
	thinking: "string",
	"signature?": "string",
	"cache_control?": cacheControlSchema,
});

const redactedThinkingBlockSchema = type({
	type: "'redacted_thinking'",
	data: "string",
	"cache_control?": cacheControlSchema,
});

const toolUseBlockSchema = type({
	type: "'tool_use'",
	id: "string >= 1",
	name: "string >= 1",
	"input?": { "[string]": "unknown" },
	"cache_control?": cacheControlSchema,
});

const toolResultContentBlockSchema = textBlockSchema.or(imageBlockSchema);

const toolResultBlockSchema = type({
	type: "'tool_result'",
	tool_use_id: "string >= 1",
	"content?": type("string").or(toolResultContentBlockSchema.array()),
	"is_error?": "boolean",
	"cache_control?": cacheControlSchema,
});

// Catch-all for content block variants Anthropic ships that the gateway doesn't
// natively understand (server_tool_use, web_search_tool_result, mcp_*,
// container_upload, code_execution_*, document, …). The walker flattens these
// to a text placeholder so legitimate Anthropic clients don't get rejected.
// Known `type` values are excluded so a malformed known block (e.g.
// `{type:"text", text: 123}`) fails validation with a clean 400 instead of
// slipping past the discriminated union and throwing a TypeError downstream.
function unknownContentBlockSchema(knownTypes: readonly string[]) {
	const known = new Set(knownTypes);
	return type({
		type: "string",
	}).narrow((d, ctx) => {
		if (known.has(d.type)) {
			return ctx.mustBe(`an unknown block type (not ${knownTypes.join(", ")})`);
		}
		return true;
	});
}

// ─── System ────────────────────────────────────────────────────────────────

const systemBlockSchema = type({
	type: "'text'",
	text: "string",
	"cache_control?": cacheControlSchema,
});

export const systemSchema = type("string").or(systemBlockSchema.array()).or("undefined");

// ─── Messages ──────────────────────────────────────────────────────────────

const userContentBlockSchema = textBlockSchema
	.or(imageBlockSchema)
	.or(toolResultBlockSchema)
	.or(unknownContentBlockSchema(["text", "image", "tool_result"]));

const assistantContentBlockSchema = textBlockSchema
	.or(thinkingBlockSchema)
	.or(redactedThinkingBlockSchema)
	.or(toolUseBlockSchema)
	.or(unknownContentBlockSchema(["text", "thinking", "redacted_thinking", "tool_use"]));

export const userMessageSchema = type({
	role: "'user'",
	content: type("string").or(userContentBlockSchema.array()),
});

export const systemMessageSchema = type({
	role: "'system'",
	content: type("string").or(systemBlockSchema.array()),
});

export const assistantMessageSchema = type({
	role: "'assistant'",
	content: type("string").or(assistantContentBlockSchema.array()),
});

export const messageSchema = userMessageSchema.or(assistantMessageSchema).or(systemMessageSchema);

// ─── Tools ─────────────────────────────────────────────────────────────────

export const toolSchema = type({
	name: "string >= 1",
	"description?": "string",
	input_schema: { "[string]": "unknown" },
	"cache_control?": cacheControlSchema,
});

// ─── Tool choice ───────────────────────────────────────────────────────────

// `disable_parallel_tool_use` is accepted on every variant; the walker maps it
// onto `options.parallelToolCalls = !disable_parallel_tool_use`.
export const toolChoiceSchema = type({
	type: "'auto'",
	"disable_parallel_tool_use?": "boolean",
})
	.or({
		type: "'any'",
		"disable_parallel_tool_use?": "boolean",
	})
	.or({
		type: "'none'",
		"disable_parallel_tool_use?": "boolean",
	})
	.or({
		type: "'tool'",
		name: "string >= 1",
		"disable_parallel_tool_use?": "boolean",
	});

// ─── Thinking ──────────────────────────────────────────────────────────────

// Anthropic's three thinking shapes. `enabled` requires a budget; `disabled`
// suppresses reasoning even on models that default it on; `adaptive` lets the
// provider pick the budget on the fly. Extra hints (`display: "omitted"`, …)
// are accepted but ignored on the translate path.
export const thinkingConfigSchema = type({
	type: "'enabled'",
	budget_tokens: "number",
	"display?": "unknown",
})
	.or({
		type: "'disabled'",
		"display?": "unknown",
	})
	.or({
		type: "'adaptive'",
		"budget_tokens?": "number",
		"display?": "unknown",
	});

const taskBudgetSchema = type({
	type: "'tokens'",
	total: "number",
	"remaining?": "number",
});

const outputConfigSchema = type({
	"effort?": "'low' | 'medium' | 'high' | 'xhigh' | 'max'",
	"task_budget?": taskBudgetSchema,
	"format?": "unknown",
});

// ─── Top-level request ─────────────────────────────────────────────────────

export const anthropicMessagesRequestSchema = type({
	model: "string >= 1",
	messages: messageSchema.array(),
	max_tokens: "number",
	"system?": systemSchema,
	"tools?": toolSchema.array(),
	"tool_choice?": toolChoiceSchema,
	"temperature?": "number",
	"top_p?": "number",
	"top_k?": "number",
	"stop_sequences?": "string[]",
	"stream?": "boolean",
	"thinking?": thinkingConfigSchema,
	"output_config?": outputConfigSchema,
	// Anthropic clients commonly send `metadata: { user_id }`; the walker
	// surfaces it on `options.metadata` for downstream provider forwarding.
	"metadata?": { "[string]": "unknown" },
	// Spec fields that the gateway tolerates but doesn't translate yet.
	"container?": "unknown",
	"context_management?": "unknown",
	"mcp_servers?": "unknown",
	"service_tier?": "unknown",
});

/**
 * Public types are sourced from the upstream Anthropic SDK so the gateway
 * stays in lock-step with the canonical API surface; the schemas above are
 * runtime validators for the subset we actually accept.
 */
export type AnthropicMessagesRequest = MessageCreateParams;
export type AnthropicSystem = MessageCreateParams["system"];
export type AnthropicMessage = MessageParam;
export type AnthropicUserContentBlock = ContentBlockParam;
export type AnthropicAssistantContentBlock = ContentBlockParam;
export type AnthropicTool = Tool;
export type AnthropicToolChoice = ToolChoice;
export type AnthropicToolResultContent = TextBlockParam | ImageBlockParam;
