import { preferredDialect } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { getDialectDefinition } from "./factory";

/**
 * Wrap a prior-turn reasoning string for demotion into native conversation
 * history — the cross-provider / cross-model case where the target cannot replay
 * it as a structured thinking block (verified end-to-end against Gemini 3: a
 * replayed unsigned `thought` part is schema-accepted but silently discarded —
 * neither recalled nor influencing generation).
 *
 * The reasoning is rendered in the TARGET model's canonical inline thinking
 * delimiters so it reads as reasoning in that model's own idiom instead of bare
 * prose the model might continue. Harmony and Gemma are the exception: their
 * `renderThinking` emits chat-template control tokens (`<|channel|>analysis`,
 * `<|channel>thought`) that must not appear inside a structured native message,
 * so they fall back to a plain `<think>` block. Every other dialect's thinking
 * form is inline-safe XML tags or a markdown fence.
 *
 * The result ends with a trailing newline so the block stays separated from the
 * turn's reply text when the wire encoder concatenates parts.
 *
 * Distinct from {@link DialectDefinition.renderThinking}, which targets the
 * owned-dialect *text transport* where those control tokens are legal.
 */
export function renderDemotedThinking(modelId: string, text: string): string {
	if (!text) return "";
	text = text.toWellFormed();
	const dialect = preferredDialect(modelId);
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>\n`;
	return `${getDialectDefinition(dialect).renderThinking(text)}\n`;
}
