/**
 * Anthropic on-demand compaction (`compact-2026-09-04` beta).
 *
 * The request sends only the prefix to summarize, with the live conversation's
 * system prompt, tools and thinking settings. The returned signed block
 * replaces that prefix; the retained tail is replayed from session entries.
 */

import type {
	AnthropicCompactionPayload,
	ApiKey,
	Effort,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
	Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { supportsAnthropicCompaction } from "@oh-my-pi/pi-ai/providers/anthropic-compaction";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type InstrumentedChatSpanOptions, instrumentedCompleteSimple } from "../telemetry";
import type { AgentMessage } from "../types";
import anthropicCompactionInstructionsPrompt from "./prompts/anthropic-compaction-instructions.md" with { type: "text" };

export const ANTHROPIC_COMPACTION_PRESERVE_KEY = "anthropicCompaction";

/** Summary persisted under {@link ANTHROPIC_COMPACTION_PRESERVE_KEY}. */
export interface AnthropicCompactionPreserveData {
	provider: string;
	content: string;
	/** Signature attached to an on-demand block; replayed verbatim. */
	signature?: string;
	/** Legacy threshold block state; replay-only. */
	encryptedContent?: string;
	/** Harness file metadata (`<files>` section) replayed after the native block. */
	filesText?: string;
	/** Model that wrote the summary. */
	model?: string;
	/** Prompt tokens the compaction request processed, for display. */
	usedTokens?: number;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

/**
 * Whether a model compacts through the Anthropic compaction beta. Model
 * eligibility is catalog policy (`compat.supportsServerCompaction`, the
 * lineage the beta documents); endpoint eligibility is resolved the way the
 * provider routes requests, so a Foundry or `ANTHROPIC_BASE_URL` reroute of a
 * first-party model is excluded unless the route opted in with
 * `remoteCompaction.enabled`.
 */
export function shouldUseAnthropicNativeCompaction(model: Model): model is Model<"anthropic-messages"> {
	return isAnthropicMessagesModel(model) && supportsAnthropicCompaction(model);
}

export function getPreservedAnthropicCompactionData(
	preserveData: Record<string, unknown> | undefined,
): AnthropicCompactionPreserveData | undefined {
	const candidate = preserveData?.[ANTHROPIC_COMPACTION_PRESERVE_KEY];
	if (!isRecord(candidate)) return undefined;
	if (typeof candidate.provider !== "string" || candidate.provider.length === 0) return undefined;
	if (typeof candidate.content !== "string" || candidate.content.length === 0) return undefined;
	return {
		provider: candidate.provider,
		content: candidate.content,
		...(typeof candidate.signature === "string" && candidate.signature.length > 0
			? { signature: candidate.signature }
			: {}),
		...(typeof candidate.encryptedContent === "string" && candidate.encryptedContent.length > 0
			? { encryptedContent: candidate.encryptedContent }
			: {}),
		...(typeof candidate.filesText === "string" && candidate.filesText.length > 0
			? { filesText: candidate.filesText }
			: {}),
		...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
		...(typeof candidate.usedTokens === "number" ? { usedTokens: candidate.usedTokens } : {}),
	};
}

/** Set or strip the Anthropic compaction slot; a new compaction never inherits a stale summary. */
export function withAnthropicCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	compaction: AnthropicCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (compaction) {
		return { ...preserveData, [ANTHROPIC_COMPACTION_PRESERVE_KEY]: compaction };
	}
	if (!preserveData || !(ANTHROPIC_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}
	const { [ANTHROPIC_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Replay payload for a compaction summary the active model produced natively. */
export function getAnthropicCompactionPayload(
	preserveData: Record<string, unknown> | undefined,
): AnthropicCompactionPayload | undefined {
	const preserved = getPreservedAnthropicCompactionData(preserveData);
	if (!preserved) return undefined;
	return {
		type: "anthropicCompaction",
		provider: preserved.provider,
		content: preserved.content,
		...(preserved.signature ? { signature: preserved.signature } : {}),
		...(preserved.encryptedContent ? { encryptedContent: preserved.encryptedContent } : {}),
		...(preserved.filesText ? { filesText: preserved.filesText } : {}),
	};
}

/**
 * Move the existing keep-tail boundary forward until the summary/tail boundary
 * alternates wire roles and no tool call is separated from its result. If no
 * boundary is safe, the request summarizes the entire snapshot (empty tail).
 */
export function findAnthropicCompactionCut(
	messages: readonly (AgentMessage | { role: "system"; content: string; timestamp: number })[],
	initialCut: number,
): number {
	let calls: Map<string, number> | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") (calls ??= new Map()).set(block.id, i);
		}
	}
	let lastResult: Int32Array | undefined;
	if (calls) {
		lastResult = new Int32Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (message.role !== "toolResult") continue;
			const callIndex = calls.get(message.toolCallId);
			if (callIndex !== undefined) lastResult[callIndex] = i;
		}
	}
	let protectedThrough = -1;
	for (let i = 0; i < initialCut; i++) protectedThrough = Math.max(protectedThrough, lastResult?.[i] ?? -1);
	for (let cut = initialCut; cut < messages.length; cut++) {
		protectedThrough = Math.max(protectedThrough, lastResult?.[cut - 1] ?? -1);
		if (cut <= protectedThrough) continue;
		const first = messages[cut];
		if (first.role === "system" || first.role === "developer") continue;
		const previous = messages[cut - 1];
		if (!previous) continue;
		if ((previous.role === "assistant") !== (first.role === "assistant")) return cut;
	}
	return messages.length;
}

/** Instructions replace the API default; the request contains only summarized messages. */
export function buildAnthropicCompactionInstructions(
	basePrompt: string,
	customInstructions: string | undefined,
	extraContext: string | undefined,
): string {
	return prompt.render(anthropicCompactionInstructionsPrompt, {
		basePrompt,
		customInstructions,
		extraContext,
	});
}

export interface AnthropicNativeCompactionRequest {
	systemPrompt: string[];
	messages: Message[];
	tools?: Tool[];
	instructions: string;
	maxTokens: number;
	reasoning?: Effort;
}

export interface AnthropicNativeCompactionResponse {
	content: string;
	signature: string;
	usage: Usage;
	model: string;
}

export interface AnthropicNativeCompactionOptions
	extends
		Pick<
			SimpleStreamOptions,
			| "initiatorOverride"
			| "metadata"
			| "fetch"
			| "sessionId"
			| "promptCacheKey"
			| "providerSessionState"
			| "maxInFlightRequests"
		>,
		Pick<InstrumentedChatSpanOptions, "completeImpl" | "telemetry" | "retry"> {}

/**
 * Run one compaction request and return the summary and signature the API wrote. `completeSimple`
 * resolves terminal failures as messages, so their classification is restored
 * here: an aborted response is an `AbortError` (a cancellation, never a native
 * failure) and an error response keeps its HTTP status, so auth and timeout
 * handling downstream classify it the same way as the OpenAI lanes. A response
 * without a summary is a native failure, including tool use, refusals and
 * output limits; the configured method order can then choose a fallback.
 */
export async function requestAnthropicNativeCompaction(
	model: Model<"anthropic-messages">,
	apiKey: ApiKey,
	request: AnthropicNativeCompactionRequest,
	signal: AbortSignal | undefined,
	options: AnthropicNativeCompactionOptions,
): Promise<AnthropicNativeCompactionResponse> {
	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools },
		{
			apiKey,
			signal,
			maxTokens: request.maxTokens,
			reasoning: request.reasoning,
			initiatorOverride: options.initiatorOverride,
			metadata: options.metadata,
			fetch: options.fetch,
			sessionId: options.sessionId,
			promptCacheKey: options.promptCacheKey,
			providerSessionState: options.providerSessionState,
			maxInFlightRequests: options.maxInFlightRequests,
			anthropicCompaction: { instructions: request.instructions },
		},
		{
			telemetry: options.telemetry,
			oneshotKind: "compaction_native",
			completeImpl: options.completeImpl,
			retry: options.retry,
		},
	);
	if (response.stopReason === "aborted") {
		throw new AIError.AbortError("Anthropic compaction aborted", { cause: signal?.reason });
	}
	if (response.stopReason === "error") {
		const message = `Anthropic compaction failed: ${response.errorMessage ?? "unknown error"}`;
		throw response.errorStatus === undefined
			? new Error(message)
			: new AIError.ProviderHttpError(message, response.errorStatus);
	}
	const payload = response.providerPayload;
	if (
		response.stopDetails?.type !== "compaction" ||
		payload?.type !== "anthropicCompaction" ||
		!payload.content ||
		!payload.signature
	) {
		throw new Error(
			response.stopDetails?.type === "compaction"
				? "Anthropic compaction returned no signed summary"
				: "Anthropic compaction response carried no compaction block",
		);
	}
	return {
		content: payload.content,
		signature: payload.signature,
		usage: response.usage,
		model: response.model,
	};
}
