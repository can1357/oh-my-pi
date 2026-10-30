import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	SecretValueSet,
	sanitizedLabelCollidesWithSecret,
	sanitizeForCollisionCheck,
} from "@oh-my-pi/pi-coding-agent/secrets/placeholder";

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

describe("SecretObfuscator probe gating", () => {
	it("redacts a case-insensitive unicode match whose probe only appears after lower-casing", () => {
		// U+212A KELVIN SIGN lower-cases to "k", and a `u`-flag case-insensitive
		// regex matches it, but a non-unicode `i` probe scan would not: the
		// probe gate must not skip this non-ASCII text.
		const obfuscator = new SecretObfuscator([
			{ type: "regex", content: "kelvin[0-9]{8}", flags: "iu", literalPrefixes: ["kelvin"] },
		]);
		const secret = "\u212Aelvin12345678";

		const output = obfuscator.obfuscate(`token ${secret} here`);

		expect(output).not.toContain(secret);
		expect(obfuscator.deobfuscate(output)).toBe(`token ${secret} here`);
	});
});

describe("SecretObfuscator text that is only placeholders", () => {
	// "TOKABC123" is OTHERSECRET's friendly label and also the normalized form
	// of `tok_abc123`, which the regex protects.
	const entries: SecretEntry[] = [
		{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
		{ type: "regex", content: "tok_[a-z0-9]+" },
	];

	it("leaves already-redacted text unchanged", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		expect(redacted).toMatch(/^use \$\$TOKABC123_[A-Z0-9]+:U\$\$ now$/);
		expect(obfuscator.obfuscate(redacted)).toBe(redacted);
	});

	it("still strips a friendly prefix that a shared collision value makes unsafe", () => {
		const obfuscator = new SecretObfuscator(entries);
		const output = obfuscator.obfuscate("see $$TOKABC123_OLDHASH:L$$ here", new SecretValueSet(["tok_abc123"]));
		expect(output).toBe("see $$OLDHASH:L$$ here");
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

describe("SecretValueSet.collidesWithLabel", () => {
	function naive(values: ReadonlySet<string>, label: string): boolean {
		for (const value of values) {
			if (sanitizedLabelCollidesWithSecret(label, sanitizeForCollisionCheck(value))) return true;
		}
		return false;
	}

	it("tracks values sharing one normalized form across delete", () => {
		const values = new SecretValueSet(["ab-c", "ABC"]);
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ab-c");
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ABC");
		expect(values.collidesWithLabel("XABCX")).toBe(false);
	});

	it("never matches values that normalize to nothing", () => {
		const values = new SecretValueSet(["---", "__"]);
		expect(values.collidesWithLabel("ANYLABEL")).toBe(false);
		expect(values.collidesWithLabel("")).toBe(false);
	});

	it("flags a display-capped label that is a prefix of a longer secret", () => {
		const secret = "A".repeat(20) + "B".repeat(20);
		const values = new SecretValueSet([secret]);
		expect(values.collidesWithLabel(secret.slice(0, 31))).toBe(false);
		expect(values.collidesWithLabel(secret.slice(0, 32))).toBe(true);
		expect(values.collidesWithLabel(secret.slice(0, 33))).toBe(true);
		expect(values.collidesWithLabel(`${secret.slice(0, 32)}Z`)).toBe(false);
	});

	it("matches the per-member check across random add, delete and clear", () => {
		let seed = 0x5eed;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const alphabet = ["A", "B", "1", "_", "-", "a", "b"];
		const word = (length: number) =>
			Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");

		for (let round = 0; round < 500; round++) {
			const values = new SecretValueSet();
			const plain = new Set<string>();
			for (let step = 0; step < 12; step++) {
				const action = random();
				if (action < 0.6) {
					const value = word(Math.floor(random() * 45));
					values.add(value);
					plain.add(value);
				} else if (action < 0.9 && plain.size > 0) {
					const value = [...plain][Math.floor(random() * plain.size)]!;
					values.delete(value);
					plain.delete(value);
				} else if (action >= 0.97) {
					values.clear();
					plain.clear();
				}
				// Labels straddle the 32-char display cap where the prefix rule applies.
				const label = sanitizeForCollisionCheck(word(28 + Math.floor(random() * 10)));
				expect(values.collidesWithLabel(label)).toBe(naive(plain, label));
				const short = sanitizeForCollisionCheck(word(Math.floor(random() * 8)));
				expect(values.collidesWithLabel(short)).toBe(naive(plain, short));
			}
		}
	});
});
