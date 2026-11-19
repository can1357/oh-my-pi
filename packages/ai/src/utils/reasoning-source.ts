/**
 * `thinkingSignature` markers that record where a thinking block's text
 * arrived instead of carrying a provider signature: an OpenAI-compatible
 * reasoning field, or Mistral typed content parts. The openai-completions
 * encoder reads them to echo reasoning back in the field it came from, so
 * they are replay state, not opaque provider material.
 */

/** `thinkingSignature` marking thinking decoded from Mistral typed content parts. */
export const MISTRAL_CONTENT_PARTS_SIGNATURE = "mistral-content-parts";

/** Whether `signature` names the thinking text's source rather than signing it. */
export function isReasoningSourceSignature(signature: string): boolean {
	return (
		signature === "reasoning_content" ||
		signature === "reasoning" ||
		signature === "reasoning_text" ||
		signature === MISTRAL_CONTENT_PARTS_SIGNATURE
	);
}
