import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { getDialectDefinition } from "./factory";

/**
 * Wrap a prior-turn reasoning string for demotion into native conversation
 * history — the cross-provider / cross-model case where the target cannot
 * replay it as a structured thinking block (verified end-to-end against Gemini
 * 3: a replayed unsigned `thought` part is schema-accepted but silently
 * discarded — neither recalled nor influencing generation).
 *
 * Readers whose catalog policy sets `classifierCotExtraction` (Claude) get an
 * empty string: Anthropic's `reasoning_extraction` classifier treats prior
 * reasoning quoted back as text — tagged or bare — as extraction, so callers
 * omit the block instead of demoting it.
 *
 * Harmony and Gemma fall back to a plain `<think>` block: their
 * `renderThinking` emits chat-template control tokens that must not appear
 * inside a structured native message. Every other dialect's thinking form is
 * inline-safe XML tags or a markdown fence.
 *
 * The result does not append a delimiter; callers that flatten adjacent blocks
 * into a single string must insert their own separator.
 */
export function renderDemotedThinking(model: string | CatalogPolicyInputs, text: string): string {
	if (!text) return "";
	const reader =
		typeof model === "string"
			? { id: model, provider: "", api: "openai-completions" as const, reasoning: true }
			: model;
	if (resolveCatalogPolicy(reader).classifierCotExtraction === true) return "";
	text = text.toWellFormed();
	const dialect = preferredDialect(reader.id);
	if (dialect === "harmony" || dialect === "gemma") return `<think>\n${text}\n</think>`;
	return getDialectDefinition(dialect).renderThinking(text);
}
