import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";

describe("SecretObfuscator batch scans", () => {
	it("rescans a string after a mint earlier in the same batch resolves the placeholder key", () => {
		// Collection scans both messages before the key exists, so the second
		// one is literal-free then. Redacting the first mints a placeholder,
		// which resolves the key and registers it as a literal; the second
		// message must be rescanned, not reported clean from the stale scan.
		const key = "lazy-placeholder-key-0123456789";
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }], () => key);
		const messages: Message[] = [
			{ role: "user", content: "use tok_abc123 here", timestamp: 1 },
			{ role: "user", content: `the key is ${key}`, timestamp: 2 },
		];

		const output = JSON.stringify(obfuscateMessages(obfuscator, messages));

		expect(output).not.toContain("tok_abc123");
		expect(output).not.toContain(key);
	});
});

describe("SecretObfuscator native gating", () => {
	it("redacts a case-insensitive match spelled with the Kelvin sign", () => {
		// U+212A KELVIN SIGN folds to "k": the native scan must not rule this
		// non-ASCII text out of a case-insensitive rule's literal prefilter.
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "kelvin[0-9]{8}", flags: "i" }]);
		const secret = "\u212Aelvin12345678";

		const output = obfuscator.obfuscate(`token ${secret} here`);

		expect(output).not.toContain(secret);
		expect(obfuscator.deobfuscate(output)).toBe(`token ${secret} here`);
	});
});

describe("SecretObfuscator text that is only placeholders", () => {
	const entries: SecretEntry[] = [
		{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
		{ type: "regex", content: "tok_[a-z0-9]+" },
	];

	it("leaves already-redacted text unchanged", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		expect(redacted).toMatch(/^use TOKABC123_[a-z]+(?:[A-Z][a-z]+){3} now$/);
		expect(obfuscator.obfuscate(redacted)).toBe(redacted);
	});

	it("still redacts a configured literal next to existing placeholders", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		const output = obfuscator.obfuscate(`${redacted} and OTHERSECRET again`);
		expect(output).not.toContain("OTHERSECRET");
	});

	it("still redacts a regex match next to existing placeholders", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		const output = obfuscator.obfuscate(`${redacted} and tok_abcdef12`);
		expect(output).not.toContain("tok_abcdef12");
		expect(obfuscator.deobfuscate(output)).toBe("use OTHERSECRET now and tok_abcdef12");
	});
});
