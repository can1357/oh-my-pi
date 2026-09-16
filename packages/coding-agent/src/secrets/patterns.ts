import { SENSITIVE_TOKEN_RE } from "@oh-my-pi/pi-ai/providers/transform-messages";

export interface CredentialPattern {
	/** Model-visible friendly label for reversible placeholders. */
	name: string;
	source: string;
	flags?: string;
}

const B = "(?<![A-Za-z0-9_-])"; // left boundary
const E = "(?![A-Za-z0-9_-])"; // right boundary

// Standard PEM private-key block: five dashes, BEGIN, optional algorithm label,
// PRIVATE KEY, five dashes, lazy body, matching END armor line.
const PEM_PRIVATE_KEY_SOURCE = "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----";

/** Anchored vendor-prefix credential shapes. No generic keyword/entropy rules: a coding agent must still be able to read identifiers like `token_expiry_seconds`. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
	{ name: "Credential", source: SENSITIVE_TOKEN_RE.source, flags: "i" },
	{ name: "AWSAccessKey", source: `${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}` },
	{ name: "GoogleAPIKey", source: `${B}AIza[A-Za-z0-9_-]{30,}${E}` },
	{ name: "SlackToken", source: `${B}xox[abprs]-[A-Za-z0-9-]{10,}${E}` },
	{ name: "NpmToken", source: `${B}npm_[A-Za-z0-9]{30,}${E}` },
	{ name: "StripeKey", source: `${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}${E}` },
	{ name: "StripeWebhookSecret", source: `${B}whsec_[A-Za-z0-9]{20,}${E}` },
	{ name: "HuggingFaceToken", source: `${B}hf_[A-Za-z0-9]{30,}${E}` },
	{ name: "SendGridKey", source: `${B}SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}${E}` },
	{ name: "JWT", source: `${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}${E}` },
	{ name: "BearerToken", source: `(?<=\\bBearer )[A-Za-z0-9._~+/=-]{20,}${E}`, flags: "i" },
	{ name: "PrivateKey", source: PEM_PRIVATE_KEY_SOURCE },
];
