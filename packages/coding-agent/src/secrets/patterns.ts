import { SENSITIVE_TOKEN_BODY, SENSITIVE_TOKEN_EDGE } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { compileSecretRegex, type SecretPattern } from "./regex";

export interface CredentialPattern {
	/** Model-visible friendly label for reversible placeholders. */
	name: string;
	/** Rust `regex` pattern; see `compileSecretRegex`. */
	source: string;
	flags?: string;
}

/**
 * `token` not touching a character of the class body `edge` on either side.
 * Rust `regex` has no lookaround, so the boundary characters are matched as
 * context; the `secret` group keeps them out of the redaction.
 */
function bounded(token: string, edge = "A-Za-z0-9_-"): string {
	return `(?:^|[^${edge}])(?P<secret>${token})(?:[^${edge}]|$)`;
}

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
	{ name: "Credential", source: bounded(`(?:${SENSITIVE_TOKEN_BODY})`, SENSITIVE_TOKEN_EDGE), flags: "i" },
	{ name: "AWSAccessKey", source: bounded("(?:AKIA|ASIA)[A-Z0-9]{16}") },
	{ name: "GoogleAPIKey", source: bounded("AIza[A-Za-z0-9_-]{30,}") },
	{ name: "SlackToken", source: bounded("xox[abprs]-[A-Za-z0-9-]{10,}") },
	{ name: "NpmToken", source: bounded("npm_[A-Za-z0-9]{30,}") },
	{ name: "StripeKey", source: bounded("(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}") },
	{ name: "StripeWebhookSecret", source: bounded("whsec_[A-Za-z0-9]{20,}") },
	{ name: "HuggingFaceToken", source: bounded("hf_[A-Za-z0-9]{30,}") },
	{ name: "SendGridKey", source: bounded("SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}") },
	{ name: "JWT", source: bounded("eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}") },
	{
		name: "BearerToken",
		source: `\\bBearer (?P<secret>[A-Za-z0-9._~+/=-]{20,})(?:[^A-Za-z0-9_-]|$)`,
		flags: "i",
	},
	{ name: "PrivateKey", source: PEM_PRIVATE_KEY_SOURCE },
];

let compiledPatterns: ReadonlyArray<{ name: string; regex: SecretPattern }> | undefined;

/** {@link CREDENTIAL_PATTERNS} compiled once, for callers outside the obfuscator. Reset `lastIndex` before each scan. */
export function compiledCredentialPatterns(): ReadonlyArray<{ name: string; regex: SecretPattern }> {
	compiledPatterns ??= CREDENTIAL_PATTERNS.map(pattern => ({
		name: pattern.name,
		regex: compileSecretRegex(pattern.source, pattern.flags),
	}));
	return compiledPatterns;
}
