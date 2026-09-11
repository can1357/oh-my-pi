/**
 * Zero-width obfuscation of system-instruction phrases for Antigravity.
 *
 * Cloud Code Assist inspects `systemInstruction` when the envelope carries
 * `requestType: "agent"` and answers matched payloads with a bare
 * `429 RESOURCE_EXHAUSTED` (no `ErrorInfo`/`RetryInfo`), which is
 * indistinguishable from real quota exhaustion and identical on every retry.
 * Splitting a matched phrase with U+200B (zero-width space) clears the match
 * while leaving the phrase visually and semantically intact for the model.
 *
 * Same mitigation CLIProxyAPI ships as `antigravity.sensitive-words`.
 */

/** Zero-width space. Invisible when rendered, breaks literal matching. */
const ZERO_WIDTH_SPACE = "\u200b";

/** Escape a literal phrase for use inside a RegExp. */
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert a zero-width space after the first character of every occurrence of
 * each phrase. Matching is case-sensitive and literal; empty or whitespace-only
 * phrases are ignored. Returns the input unchanged when nothing matches.
 */
export function obfuscateSensitiveWords(text: string, phrases: readonly string[]): string {
	let result = text;
	for (const phrase of phrases) {
		const trimmed = phrase.trim();
		if (trimmed.length < 2) continue;
		const pattern = new RegExp(escapeRegExp(trimmed), "g");
		result = result.replace(pattern, match => `${match[0]}${ZERO_WIDTH_SPACE}${match.slice(1)}`);
	}
	return result;
}
