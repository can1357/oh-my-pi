/**
 * Contract: the literal-prefix gate in front of every built-in credential
 * regex never changes what is redacted. For each built-in pattern, a
 * representative token of every alternative (and every case variant a
 * case-insensitive pattern accepts) is redacted identically with and without
 * the metadata; a custom regex without metadata is always scanned. The gate
 * exists because the whole provider context is rescanned on every request,
 * and the regex pass was the dominant synchronous cost in a long session.
 */
import { describe, expect, it } from "bun:test";
import { builtinCredentialSecretEntries } from "@oh-my-pi/pi-coding-agent/secrets";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { CREDENTIAL_PATTERNS } from "@oh-my-pi/pi-coding-agent/secrets/patterns";

const KEY = "prefilter-test-key";

/** One token per alternative of every built-in pattern. */
const TOKENS: Record<string, string[]> = {
	Credential: [
		`ghp_${"a".repeat(36)}`,
		`gho_${"b".repeat(36)}`,
		`ghu_${"c".repeat(36)}`,
		`ghs_${"d".repeat(36)}`,
		`ghr_${"e".repeat(36)}`,
		`github_pat_${"f".repeat(36)}`,
		`glpat-${"g".repeat(20)}`,
		`sk-proj-${"h".repeat(36)}`,
		`sk-ant-${"i".repeat(36)}`,
		`sk-${"j".repeat(48)}`,
		// Case-insensitive pattern: an upper-cased prefix must still be caught.
		`GHP_${"K".repeat(36)}`,
		`SK-${"L".repeat(48)}`,
	],
	AWSAccessKey: [`AKIA${"A".repeat(16)}`, `ASIA${"B".repeat(16)}`],
	GoogleAPIKey: [`AIza${"c".repeat(30)}`],
	SlackToken: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"].map(prefix => `${prefix}${"d".repeat(12)}`),
	NpmToken: [`npm_${"e".repeat(30)}`],
	StripeKey: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"].map(prefix => `${prefix}${"f".repeat(20)}`),
	StripeWebhookSecret: [`whsec_${"g".repeat(20)}`],
	HuggingFaceToken: [`hf_${"h".repeat(30)}`],
	SendGridKey: [`SG.${"i".repeat(22)}.${"j".repeat(43)}`],
	JWT: [`eyJ${"k".repeat(10)}.eyJ${"l".repeat(10)}.${"m".repeat(10)}`],
	BearerToken: [`Bearer ${"n".repeat(24)}`, `BEARER ${"o".repeat(24)}`, `bearer ${"p".repeat(24)}`],
	PrivateKey: [
		`${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\nMIIB\n${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`,
	],
};

function withoutMetadata(entries: SecretEntry[]): SecretEntry[] {
	return entries.map(entry => ({ ...entry, literalPrefixes: undefined }));
}

describe("credential regex literal prefilter", () => {
	it("covers every built-in pattern with metadata", () => {
		for (const pattern of CREDENTIAL_PATTERNS) {
			expect(pattern.literalPrefixes?.length ?? 0).toBeGreaterThan(0);
			expect(TOKENS[pattern.name]).toBeDefined();
		}
	});

	it("redacts every alternative of every built-in pattern exactly as the unfiltered scan does", () => {
		const gated = new SecretObfuscator(builtinCredentialSecretEntries(), KEY);
		const full = new SecretObfuscator(withoutMetadata(builtinCredentialSecretEntries()), KEY);
		for (const [name, tokens] of Object.entries(TOKENS)) {
			for (const token of tokens) {
				const text = `prefix text ${token} suffix text`;
				const expected = full.obfuscate(text);
				expect(expected, `${name}: ${token} must be redacted by the unfiltered scan`).not.toContain(token);
				expect(gated.obfuscate(text), `${name}: ${token}`).toBe(expected);
			}
		}
	});

	it("skips the regex over text with no candidate prefix and leaves it untouched", () => {
		const gated = new SecretObfuscator(builtinCredentialSecretEntries(), KEY);
		const text = "token_expiry_seconds = 3600; nothing credential-shaped here";
		expect(gated.obfuscate(text)).toBe(text);
	});

	it("always scans a custom regex without prefix metadata", () => {
		const custom: SecretEntry = { type: "regex", content: "zq[0-9]{6}", mode: "obfuscate", friendlyName: "Custom" };
		const obfuscator = new SecretObfuscator([custom], KEY);
		expect(obfuscator.obfuscate("id zq123456 here")).not.toContain("zq123456");
	});

	it("treats an empty prefix list as no metadata", () => {
		const entry: SecretEntry = {
			type: "regex",
			content: "zq[0-9]{6}",
			mode: "obfuscate",
			friendlyName: "Custom",
			literalPrefixes: [],
		};
		const obfuscator = new SecretObfuscator([entry], KEY);
		expect(obfuscator.obfuscate("id zq123456 here")).not.toContain("zq123456");
	});
});
