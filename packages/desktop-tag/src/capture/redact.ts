/**
 * Outbound sanitization for collaboration surfaces. Collaboration adapters
 * only ever receive summarized text, but summaries can still quote assistant
 * output; scrub common credential shapes before anything leaves the process.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// API keys and tokens with recognizable prefixes.
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bghp_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}\b/g,
	// Telegram bot tokens (numeric id + secret part).
	/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
	// Bearer/authorization headers.
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	// key=value style assignments for sensitive names (quoted or unquoted values).
	/\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*(?:"[^"\r\n]{6,}"|'[^'\r\n]{6,}'|[^\s"']{6,})/gi,
	// Private key blocks.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED_PLACEHOLDER = "[redacted]";

/** Replace credential-shaped substrings and bound the overall length. */
export function sanitizeForCollaboration(text: string, maxChars = 3_500): string {
	let sanitized = text;
	for (const pattern of SECRET_PATTERNS) {
		sanitized = sanitized.replace(pattern, match => {
			// Preserve `password=` style prefixes so the message stays readable.
			const separator = match.search(/[=:]/);
			if (separator > 0 && separator < 24 && !match.startsWith("-----")) {
				return `${match.slice(0, separator + 1)}${REDACTED_PLACEHOLDER}`;
			}
			return REDACTED_PLACEHOLDER;
		});
	}
	sanitized = sanitized.replaceAll("\0", "");
	if (sanitized.length > maxChars) {
		sanitized = `${sanitized.slice(0, maxChars)}\n[truncated]`;
	}
	return sanitized;
}
