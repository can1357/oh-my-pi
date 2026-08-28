/**
 * Secret redaction pipeline.
 *
 * Redacts sensitive values from text before it enters durable memory or is
 * sent to an external endpoint. Pure and deterministic — no IO, no ambient
 * state. The `security/` subsystem consumes this module through its
 * `RedactionPort` adapter factories; nothing here imports the guard back.
 *
 * Design notes:
 * - Detection is defined as "redaction would change the text", so
 *   {@link containsSecrets} can never disagree with {@link redactText} (and
 *   the classic `RegExp.test` + global-flag `lastIndex` bug cannot occur).
 * - The AWS secret pattern is contextual (requires the key name) rather than
 *   "any 40 base64-ish characters", which would false-positive on git SHAs.
 * - Anthropic keys are matched before OpenAI keys: `sk-ant-…` is a strict
 *   subset of `sk-…`, so order decides the label.
 */

/** Replacement callback for patterns that decide per match. */
export type RedactionReplacer = (match: string, firstCapture: string) => string;

/** One named secret pattern and how to replace its matches. */
export interface SecretPattern {
	name: string;
	pattern: RegExp;
	replacement: string | RedactionReplacer;
}

/** Keys whose values are always considered sensitive (case-insensitive). */
const SENSITIVE_KEY_PATTERN = /key|secret|pass|pwd|token|api|auth|cred|priv|cert/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key);
}

/** Patterns that match common secrets, applied in order. */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
	// Anthropic before OpenAI: `sk-ant-…` also matches the OpenAI pattern.
	{ name: "anthropic-api-key", pattern: /sk-ant-[a-zA-Z0-9_-]{32,}/g, replacement: "[REDACTED:ANTHROPIC_KEY]" },
	{ name: "openai-api-key", pattern: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g, replacement: "[REDACTED:OPENAI_KEY]" },
	{ name: "github-token", pattern: /gh[ps]_[a-zA-Z0-9]{36}/g, replacement: "[REDACTED:GITHUB_TOKEN]" },
	{ name: "nvidia-api-key", pattern: /nvapi-[a-zA-Z0-9_-]{30,}/g, replacement: "[REDACTED:NVIDIA_KEY]" },
	{
		name: "generic-api-key",
		pattern: /[a-zA-Z0-9_-]*api_?key["'\s:=]+[a-zA-Z0-9_-]{20,}/gi,
		replacement: "[REDACTED:API_KEY]",
	},

	// AWS. The secret pattern is contextual: a bare 40-character base64 run
	// would also match git SHAs and other identifiers.
	{ name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED:AWS_ACCESS_KEY]" },
	{
		name: "aws-secret-key",
		pattern: /\baws_?secret_?access_?key\b["'\s:=]+[a-zA-Z0-9/+=]{30,}/gi,
		replacement: "[REDACTED:AWS_SECRET]",
	},

	// Database URLs with embedded credentials.
	{ name: "postgres-url", pattern: /postgresql:\/\/[^:\s]+:[^@\s]+@[^\s]+/g, replacement: "[REDACTED:POSTGRES_URL]" },
	{ name: "mysql-url", pattern: /mysql:\/\/[^:\s]+:[^@\s]+@[^\s]+/g, replacement: "[REDACTED:MYSQL_URL]" },
	{
		name: "mongodb-url",
		pattern: /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@[^\s]+/g,
		replacement: "[REDACTED:MONGO_URL]",
	},
	{ name: "redis-url", pattern: /redis:\/\/[^:\s]+:[^@\s]+@[^\s]+/g, replacement: "[REDACTED:REDIS_URL]" },

	// JSON Web Tokens.
	{ name: "jwt", pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: "[REDACTED:JWT]" },

	// Private key blocks.
	{
		name: "private-key",
		pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
		replacement: "[REDACTED:PRIVATE_KEY]",
	},
	{
		name: "ssh-private-key",
		pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
		replacement: "[REDACTED:SSH_KEY]",
	},

	// `.env`-style assignments: redact the value only when the key is sensitive.
	{
		name: "env-assignment",
		pattern: /^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$/gm,
		replacement: (match, key) => (isSensitiveKey(key) ? `${key}=[REDACTED]` : match),
	},

	// Generic auth headers.
	{ name: "bearer-token", pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g, replacement: "[REDACTED:BEARER_TOKEN]" },
	{ name: "basic-auth", pattern: /Basic\s+[a-zA-Z0-9+/=]{16,}/g, replacement: "[REDACTED:BASIC_AUTH]" },
];

/** Result of one redaction pass. */
export interface RedactionResult {
	/** The text with all detected secrets replaced. */
	redacted: string;
	/** Which patterns fired and how many matches each actually rewrote. */
	redactions: Array<{ pattern: string; count: number }>;
	/** True when at least one secret was redacted. */
	hasSecrets: boolean;
}

/** Redact secrets from text. Patterns run in order over the running output. */
export function redactText(text: string): RedactionResult {
	const redactions: Array<{ pattern: string; count: number }> = [];
	let redacted = text;

	for (const { name, pattern, replacement } of SECRET_PATTERNS) {
		let count = 0;
		if (typeof replacement === "function") {
			redacted = redacted.replace(pattern, (match: string, ...rest: unknown[]) => {
				const firstCapture = typeof rest[0] === "string" ? rest[0] : "";
				const output = replacement(match, firstCapture);
				if (output !== match) count++;
				return output;
			});
		} else {
			redacted = redacted.replace(pattern, () => {
				count++;
				return replacement;
			});
		}
		if (count > 0) redactions.push({ pattern: name, count });
	}

	return { redacted, redactions, hasSecrets: redactions.length > 0 };
}

/** True when redaction would change the text — for write gating. */
export function containsSecrets(text: string): boolean {
	return redactText(text).hasSecrets;
}

function redactValue(value: unknown, redactString: (text: string) => string): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map(entry => redactValue(entry, redactString));
	if (value && typeof value === "object") {
		return redactRecord(value as Record<string, unknown>, redactString);
	}
	return value;
}

function redactRecord(obj: Record<string, unknown>, redactString: (text: string) => string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(value, redactString);
	}
	return result;
}

/**
 * Redact an object recursively. Values under sensitive keys are replaced
 * wholesale; other string values (including inside arrays and nested objects)
 * go through {@link redactText}. Non-string leaves pass through unchanged.
 */
export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
	return redactRecord(obj, text => redactText(text).redacted);
}

/**
 * Redactor with a bounded memoization cache for hosts that scrub the same
 * payloads repeatedly (e.g. resumed sessions). Construct one per host —
 * there is deliberately no module-level singleton.
 */
export class SecretRedactor {
	static readonly #MAX_CACHE_ENTRIES = 1000;
	readonly #cache = new Map<string, RedactionResult>();

	redact(text: string): RedactionResult {
		// The cache is keyed by the full input. A digest key is not safe here:
		// the previous 32-bit rolling hash collided deterministically (e.g.
		// "Aa" vs "BB"), returning one string's RedactionResult for another —
		// corruption, not a cache miss. The map is size-bounded, so full-text
		// keys cannot grow without limit.
		const cached = this.#cache.get(text);
		if (cached) return cached;

		const result = redactText(text);
		if (this.#cache.size < SecretRedactor.#MAX_CACHE_ENTRIES) {
			this.#cache.set(text, result);
		}
		return result;
	}

	redactObject(obj: Record<string, unknown>): Record<string, unknown> {
		return redactRecord(obj, text => this.redact(text).redacted);
	}

	clearCache(): void {
		this.#cache.clear();
	}
}
