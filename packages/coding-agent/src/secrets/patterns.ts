import { SENSITIVE_TOKEN_RE } from "@oh-my-pi/pi-ai/providers/transform-messages";

export interface CredentialPattern {
	/** Model-visible friendly label for reversible placeholders. */
	name: string;
	source: string;
	flags?: string;
	/**
	 * Literal substrings at least one of which every match of `source`
	 * contains. The obfuscator skips the regex over text containing none of
	 * them (`includes` beats a lookbehind regex by orders of magnitude, and the
	 * whole provider context is scanned on every request). Must be exhaustive
	 * for the pattern's alternatives; a pattern without this field is always
	 * scanned. Case-insensitive patterns are matched case-insensitively.
	 */
	literalPrefixes?: readonly string[];
}

const B = "(?<![A-Za-z0-9_-])"; // left boundary
const E = "(?![A-Za-z0-9_-])"; // right boundary

// Standard PEM private-key block: five dashes, BEGIN, optional algorithm label,
// PRIVATE KEY, five dashes, lazy body, matching END armor line.
const PEM_PRIVATE_KEY_SOURCE = "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----";

export interface CredentialPrefixRule {
	/** Regex source matching the fixed provider prefix. */
	readonly source: string;
	/** `token` redacts from the prefix through non-whitespace; the special modes preserve their introducer semantics. */
	readonly mode: "token" | "line" | "bearer-token";
}

/**
 * Credential introducers which are sensitive before a complete high-entropy token
 * has been typed. Stream redaction deliberately applies these without the normal
 * length or entropy gates.
 */
export const CREDENTIAL_PREFIX_RULES: readonly CredentialPrefixRule[] = [
	{ source: "sk-ant-", mode: "token" },
	{ source: "sk-proj-", mode: "token" },
	{ source: "sk-", mode: "token" },
	{ source: "gh[opusr]_", mode: "token" },
	{ source: "github_pat_", mode: "token" },
	{ source: "glpat-", mode: "token" },
	{ source: "xox[abprs]-", mode: "token" },
	{ source: "AKIA", mode: "token" },
	{ source: "ASIA", mode: "token" },
	{ source: "AIza", mode: "token" },
	{ source: "npm_", mode: "token" },
	{ source: "hf_", mode: "token" },
	{ source: "whsec_", mode: "token" },
	{ source: "rk_live_", mode: "token" },
	{ source: "sk_live_", mode: "token" },
	{ source: "sk_test_", mode: "token" },
	{ source: "eyJ", mode: "token" },
	{ source: "-----BEGIN", mode: "line" },
	{ source: "Bearer ", mode: "bearer-token" },
];

/** Anchored vendor-prefix credential shapes. No generic keyword/entropy rules: a coding agent must still be able to read identifiers like `token_expiry_seconds`. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
	{
		name: "Credential",
		source: SENSITIVE_TOKEN_RE.source,
		flags: "i",
		literalPrefixes: ["gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "sk-"],
	},
	{ name: "AWSAccessKey", source: `${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`, literalPrefixes: ["AKIA", "ASIA"] },
	{ name: "GoogleAPIKey", source: `${B}AIza[A-Za-z0-9_-]{30,}${E}`, literalPrefixes: ["AIza"] },
	{
		name: "SlackToken",
		source: `${B}xox[abprs]-[A-Za-z0-9-]{10,}${E}`,
		literalPrefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
	},
	{ name: "NpmToken", source: `${B}npm_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["npm_"] },
	{
		name: "StripeKey",
		source: `${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}`,
		literalPrefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
	},
	{ name: "StripeWebhookSecret", source: `${B}whsec_[A-Za-z0-9]{20,}${E}`, literalPrefixes: ["whsec_"] },
	{ name: "HuggingFaceToken", source: `${B}hf_[A-Za-z0-9]{30,}${E}`, literalPrefixes: ["hf_"] },
	{ name: "SendGridKey", source: `${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}${E}`, literalPrefixes: ["SG."] },
	{
		name: "JWT",
		source: `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}`,
		literalPrefixes: ["eyJ"],
	},
	{
		name: "BearerToken",
		source: `(?<=\\bBearer )[A-Za-z0-9._~+/=-]{20,}${E}`,
		flags: "i",
		literalPrefixes: ["Bearer "],
	},
	{ name: "PrivateKey", source: PEM_PRIVATE_KEY_SOURCE, literalPrefixes: ["-----BEGIN "] },
];
