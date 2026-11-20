/**
 * `thinkingSignature` markers that record where a thinking block's text
 * arrived instead of carrying a provider signature: an OpenAI-compatible
 * reasoning field, or Mistral typed content parts. The openai-completions
 * encoder reads them to echo reasoning back in the field it came from, so
 * they are replay state, not opaque provider material.
 *
 * A chat-completions turn that streamed `reasoning_details` or Copilot's
 * `reasoning_opaque` stores a JSON envelope instead: the replay data as
 * received, plus the reasoning field marker the block would otherwise carry.
 * The replay data covers the whole turn, so rewriting its thinking or tool
 * arguments invalidates the envelope; see {@link dropReasoningDetailsEnvelopes}.
 */
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { isRecord, tryParseJson } from "@oh-my-pi/pi-utils";
import type { AssistantMessage } from "../types";

/** `thinkingSignature` marking thinking decoded from Mistral typed content parts. */
export const MISTRAL_CONTENT_PARTS_SIGNATURE = "mistral-content-parts";

/** OpenAI-compatible delta fields that stream plain reasoning text. */
export type ReasoningField = NonNullable<OpenAICompat["reasoningContentField"]>;

/** `thinkingSignature` envelope for chat-completions reasoning replay data. */
export interface ReasoningDetailsSignature {
	/** The `reasoning_details` entries as received, replayed verbatim. */
	reasoningDetails?: Record<string, unknown>[];
	/** Copilot's latest non-empty `reasoning_opaque`, replayed verbatim. */
	reasoningOpaque?: string;
	/** The reasoning field the block's text arrived in, when one streamed. */
	field?: ReasoningField;
}

export function isReasoningField(value: unknown): value is ReasoningField {
	return value === "reasoning_content" || value === "reasoning" || value === "reasoning_text";
}

/** Whether `signature` names the thinking text's source rather than signing it. */
export function isReasoningSourceSignature(signature: string): boolean {
	return isReasoningField(signature) || signature === MISTRAL_CONTENT_PARTS_SIGNATURE;
}

/** The chat-completions reasoning replay envelope `signature` holds, if it is one. */
export function parseReasoningDetailsSignature(signature: string | undefined): ReasoningDetailsSignature | undefined {
	if (!signature?.startsWith("{")) return undefined;
	const stored = tryParseJson(signature);
	if (!isRecord(stored)) return undefined;
	const reasoningDetails = Array.isArray(stored.reasoningDetails)
		? (stored.reasoningDetails as Record<string, unknown>[])
		: undefined;
	const reasoningOpaque =
		typeof stored.reasoningOpaque === "string" && stored.reasoningOpaque.length > 0
			? stored.reasoningOpaque
			: undefined;
	if (reasoningDetails === undefined && reasoningOpaque === undefined) return undefined;
	const field = isReasoningField(stored.field) ? stored.field : undefined;
	return { reasoningDetails, reasoningOpaque, field };
}

/** The reasoning field a thinking block's text arrived in, read from its bare marker or replay envelope. */
export function signatureReasoningField(signature: string | undefined): ReasoningField | undefined {
	return isReasoningField(signature) ? signature : parseReasoningDetailsSignature(signature)?.field;
}

function isReadableReasoningDetail(detail: unknown): boolean {
	return isRecord(detail) && (detail.type === "reasoning.text" || detail.type === "reasoning.summary");
}

function isSignedReasoningDetail(detail: unknown): boolean {
	return isRecord(detail) && (detail.signature != null || detail.data != null);
}

/** The entries a request that drops the model's own thinking still replays: encrypted ones and signed text, which must stay intact. */
export function reasoningDetailsWithoutThinkingText<T>(details: readonly T[]): T[] {
	return details.filter(detail => !isReadableReasoningDetail(detail) || isSignedReasoningDetail(detail));
}

/** Whether `signature` is an envelope whose thinking text replays even where the model's own thinking is dropped. */
export function replaysSignedReasoningText(signature: string | undefined): boolean {
	const details = parseReasoningDetailsSignature(signature)?.reasoningDetails ?? [];
	return details.some(detail => isReadableReasoningDetail(detail) && isSignedReasoningDetail(detail));
}

/**
 * `content` with each chat-completions reasoning replay envelope reduced to
 * its field marker. Rewriting the turn's thinking or tool arguments invalidates
 * its replay data. Per-call encrypted entries on unchanged tool calls still
 * replay from those calls.
 */
export function dropReasoningDetailsEnvelopes(content: AssistantMessage["content"]): AssistantMessage["content"] {
	let result: AssistantMessage["content"] | undefined;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "thinking") continue;
		const envelope = parseReasoningDetailsSignature(block.thinkingSignature);
		if (!envelope) continue;
		result ??= content.slice();
		result[index] = { ...block, thinkingSignature: envelope.field };
	}
	return result ?? content;
}
