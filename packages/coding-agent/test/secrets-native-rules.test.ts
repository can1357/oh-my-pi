/**
 * Contract: secret regex rules are Rust `regex` patterns run by the native
 * engine. A rule redacts its `secret` group (else its whole match) and leaves
 * the context around it; an invalid rule fails loudly instead of being
 * dropped; every built-in credential shape is redacted with its boundary
 * characters kept.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSecretObfuscator, builtinCredentialSecretEntries } from "@oh-my-pi/pi-coding-agent/secrets";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";

const KEY = "native-rules-test-key";

/** One token per alternative of every built-in pattern; fake credentials assembled so this source holds none. */
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
	PrivateKey: [
		`${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\nMIIB\n${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`,
	],
};

describe("native secret rules", () => {
	it("redacts every alternative of every built-in pattern and keeps the text around it", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries(), KEY);
		for (const [name, tokens] of Object.entries(TOKENS)) {
			for (const token of tokens) {
				const redacted = obfuscator.obfuscate(`prefix (${token}) suffix`);
				expect(redacted, `${name}: ${token}`).not.toContain(token);
				expect(redacted, name).toStartWith("prefix (");
				expect(redacted, name).toEndWith(") suffix");
			}
		}
	});

	it("redacts only the token after Bearer, in any case", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries(), KEY);
		for (const introducer of ["Bearer", "BEARER", "bearer"]) {
			const token = "n".repeat(24);
			const redacted = obfuscator.obfuscate(`Authorization: ${introducer} ${token}`);
			expect(redacted).not.toContain(token);
			expect(redacted).toStartWith(`Authorization: ${introducer} `);
		}
	});

	it("leaves a token touching a word character and redacts adjacent tokens sharing one separator", () => {
		const obfuscator = new SecretObfuscator(builtinCredentialSecretEntries(), KEY);
		const first = `AKIA${"A".repeat(16)}`;
		const second = `ASIA${"B".repeat(16)}`;
		expect(obfuscator.obfuscate(`x${first}`)).toBe(`x${first}`);
		const both = obfuscator.obfuscate(`${first} ${second}`);
		expect(both).not.toContain(first);
		expect(both).not.toContain(second);
		expect(both).toContain(" ");
	});

	it("redacts a rule's secret group and keeps its context, across astral characters", () => {
		const rule: SecretEntry = { type: "regex", content: "password=(?P<secret>[^ ]+)", friendlyName: "Password" };
		const obfuscator = new SecretObfuscator([rule], KEY);
		const redacted = obfuscator.obfuscate("🔑 password=hunter2hunter2 done");
		expect(redacted).not.toContain("hunter2hunter2");
		expect(redacted).toStartWith("🔑 password=");
		expect(redacted).toEndWith(" done");
		expect(obfuscator.deobfuscate(redacted)).toBe("🔑 password=hunter2hunter2 done");
	});

	it("rejects a rule the engine cannot run instead of dropping it", () => {
		expect(() => new SecretObfuscator([{ type: "regex", content: "(?<=password=)\\S+" }], KEY)).toThrow();
		expect(() => new SecretObfuscator([{ type: "regex", content: "abc", flags: "y" }], KEY)).toThrow();
	});

	it("fails to build from a secrets.yml with an invalid regex rule, naming it", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secret-rules-"));
		try {
			await Bun.write(
				path.join(cwd, ".omp", "secrets.yml"),
				'- type: plain\n  content: "fine-plain-secret"\n- type: regex\n  content: "(?<=token=)\\\\w+"\n',
			);
			await expect(buildSecretObfuscator(cwd, path.join(cwd, "agent"), path.join(cwd, "keys"))).rejects.toThrow(
				/secrets\.yml\[1\]/,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
