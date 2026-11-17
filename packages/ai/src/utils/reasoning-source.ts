/**
 * `thinkingSignature` markers that record where a thinking block's text
 * arrived instead of carrying a provider signature: an OpenAI-compatible
 * reasoning field, or Mistral typed content parts. The openai-completions
 * encoder reads them to echo reasoning back in the field it came from, so
 * they are replay state, not opaque provider material.
 *
 * A chat-completions turn that streamed `reasoning_details` stores a JSON
 * envelope instead: the entries as received, which replay verbatim, plus the
 * reasoning field marker the block would otherwise carry. The entries cover
 * the whole turn (every thinking block's text and each tool call's encrypted
 * signature), so a pass that rewrites any of that drops the envelope with
 * {@link dropReasoningDetailsEnvelopes}.
 */
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { isRecord, tryParseJson } from "@oh-my-pi/pi-utils";
import type { AssistantMessage } from "../types";

/** `thinkingSignature` marking thinking decoded from Mistral typed content parts. */
export const MISTRAL_CONTENT_PARTS_SIGNATURE = "mistral-content-parts";

/** OpenAI-compatible delta fields that stream plain reasoning text. */
export type ReasoningField = NonNullable<OpenAICompat["reasoningContentField"]>;

/** `thinkingSignature` envelope of a chat-completions turn that streamed `reasoning_details`. */
export interface ReasoningDetailsSignature {
	/** The `reasoning_details` entries as received, replayed verbatim. */
	reasoningDetails: Record<string, unknown>[];
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

/** The `reasoning_details` envelope `signature` holds, if it is one. */
export function parseReasoningDetailsSignature(signature: string | undefined): ReasoningDetailsSignature | undefined {
	if (!signature?.startsWith("{")) return undefined;
	const stored = tryParseJson(signature);
	if (!isRecord(stored) || !Array.isArray(stored.reasoningDetails)) return undefined;
	const reasoningDetails = stored.reasoningDetails as Record<string, unknown>[];
	return isReasoningField(stored.field) ? { reasoningDetails, field: stored.field } : { reasoningDetails };
}

/** The reasoning field a thinking block's text arrived in, read from its bare marker or `reasoning_details` envelope. */
export function signatureReasoningField(signature: string | undefined): ReasoningField | undefined {
	return isReasoningField(signature) ? signature : parseReasoningDetailsSignature(signature)?.field;
}

/**
 * `content` with every `reasoning_details` envelope reduced to its field
 * marker. A pass that rewrote any thinking text or tool call arguments of the
 * turn calls this: the entries still hold the original bytes, so replaying
 * them would resend what the pass removed. Encrypted entries stay on the tool
 * calls whose arguments were left unchanged and replay from there.
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
