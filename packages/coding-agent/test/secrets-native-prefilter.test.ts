import { describe, expect, it } from "bun:test";
import { SecretScanner } from "@oh-my-pi/pi-natives";
import { builtinCredentialSecretEntries } from "@oh-my-pi/pi-coding-agent/secrets";
import { compileSecretRegex } from "@oh-my-pi/pi-coding-agent/secrets/regex";
import { rustPrefilterPattern } from "@oh-my-pi/pi-coding-agent/secrets/regex-prefilter";

function rule(regex: RegExp) {
	return { source: rustPrefilterPattern(regex) ?? undefined };
}

/** JavaScript's own verdict, as the obfuscator's collector reads it: a non-empty match exists. */
function jsMatches(regex: RegExp, text: string): boolean {
	const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
	for (const match of text.matchAll(re)) if (match[0].length > 0) return true;
	return false;
}

// Fake credentials, assembled so the source holds no scanner-triggering literal.
const AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const GITHUB_TOKEN = ["ghp", "_", "a".repeat(36)].join("");
const PEM = ["-----BEGIN RSA PRIVATE", " KEY-----\nMIIB\n-----END RSA PRIVATE", " KEY-----"].join("");

// Each rule with texts it matches (the prefilter must report them) and a text it does not.
const cases: Array<{ name: string; regex: RegExp; matching: string[]; clean: string }> = [
	{
		name: "a leading lookbehind consumes its context",
		regex: /(?<=password=)[A-Za-z0-9]{6,}/,
		matching: ["password=hunter22", "x password=abcdef y"],
		clean: "hunter22 alone",
	},
	{
		name: "a lookbehind after consumed text is dropped, not consumed",
		regex: /ab(?<=b)c/,
		matching: ["abc"],
		clean: "zzz",
	},
	{
		name: "a lookahead before consumed text is dropped, not consumed",
		regex: /a(?=bc)bc/,
		matching: ["abc"],
		clean: "zzz",
	},
	{
		name: "negative lookarounds widen to nothing",
		regex: /(?<![A-Za-z])tok_[a-z0-9]{6}(?![a-z])/,
		matching: ["(tok_abc123)", "tok_abc123"],
		clean: "token",
	},
	{
		name: "a backreference widens to any text",
		regex: /(['"])secret-\d+\1/,
		matching: [`"secret-42"`, `'secret-7'`],
		clean: "secret",
	},
	{
		name: "word boundaries are dropped",
		regex: /\bAKIA[A-Z0-9]{16}\b/,
		matching: [`key=${AWS_KEY};`, AWS_KEY],
		clean: "AKIA too short",
	},
	{
		name: "JavaScript \\s includes U+3000 and U+FEFF",
		regex: /key:\s+[a-z]{8}/,
		matching: ["key:\u3000abcdefgh", "key:\ufeffabcdefgh", "key:\tabcdefgh"],
		clean: "key:abcdefgh",
	},
	{
		name: "JavaScript \\d and \\w stay ASCII",
		regex: /id-\D\W\w{3}/,
		matching: ["id-x-abc", "id-\u0663-abc"],
		clean: "id-",
	},
	{
		name: "a dot matches what JavaScript's dot matches",
		regex: /begin.end/,
		matching: ["begin-end", "begin\u00e9end"],
		clean: "begin\nend",
	},
	{
		name: "case-insensitive rules fold ASCII case",
		regex: /bearer [a-z0-9]{10}/i,
		matching: ["BEARER ABCDEFGHIJ", "Bearer abcdefghij"],
		clean: "bear abcdefghij",
	},
	{
		name: "Unicode case folding matches the Kelvin sign",
		regex: /key=[0-9]{4}/iu,
		matching: ["\u212Aey=1234", "KEY=1234"],
		clean: "kez=1234",
	},
	{
		name: "a rule spelling the Kelvin sign or long s without u matches them as themselves",
		regex: /\u212Aey-\u017Fecret=[0-9]{4}/i,
		matching: ["\u212Aey-\u017Fecret=1234", "\u212AEY-\u017FECRET=1234"],
		clean: "\u212Aey-\u017Fecret=12",
	},
	{
		name: "a literal brace outside a quantifier",
		regex: /\{"token":"[^"]{8,}"/,
		matching: [`{"token":"abcdefghij"}`],
		clean: `{"token":"x"}`,
	},
	{
		name: "named groups and [^] classes",
		regex: /(?<k>api)[^]{2}(?<v>[0-9]{4})/,
		matching: ["api\n\n1234"],
		clean: "api",
	},
	{
		name: "astral literal characters",
		regex: /🔑=[a-z]{4}/u,
		matching: ["🔑=abcd"],
		clean: "=abcd",
	},
];

describe.skipIf(typeof SecretScanner !== "function")("native secret-scan prefilter", () => {
	for (const { name, regex, matching, clean } of cases) {
		it(name, () => {
			expect(rustPrefilterPattern(regex)).not.toBeNull();
			const scanner = new SecretScanner([rule(regex)], []);
			for (const text of matching) {
				expect(jsMatches(regex, text)).toBe(true);
				expect(scanner.scan(text)?.rules).toEqual([0]);
			}
			expect(jsMatches(regex, clean)).toBe(false);
			expect(scanner.scan(clean)).toBeNull();
		});
	}

	it("leaves a rule it cannot translate to JavaScript", () => {
		for (const regex of [/\p{Lu}{3}/u, /[\p{L}--[a-z]]/v, /\uD83D/]) {
			expect(rustPrefilterPattern(regex)).toBeNull();
			const scanner = new SecretScanner([rule(regex)], []);
			expect(scanner.unfiltered()).toEqual([0]);
			expect(scanner.scan("anything")).toBeNull();
		}
	});

	it("reports every built-in credential rule a text matches", () => {
		const regexes = builtinCredentialSecretEntries().map(entry => compileSecretRegex(entry.content, entry.flags));
		const scanner = new SecretScanner(regexes.map(rule), ["$$"]);
		expect(scanner.unfiltered()).toEqual([]);
		for (const text of [
			`export AWS_ACCESS_KEY_ID=${AWS_KEY}`,
			`Authorization: Bearer ${"x".repeat(32)}`,
			`GITHUB_TOKEN=${GITHUB_TOKEN}`,
			PEM,
		]) {
			const expected = regexes.flatMap((regex, index) => (jsMatches(regex, text) ? [index] : []));
			expect(expected.length).toBeGreaterThan(0);
			expect(scanner.scan(text)?.rules).toEqual(expect.arrayContaining(expected));
		}
		expect(scanner.scan("ordinary prose about tokens and keys")).toBeNull();
		// Assembled at runtime: a literal placeholder token in source is itself something a redactor rewrites.
		const placeholder = ["$", "$AWSACCESSKEY_OGRR8VU7VWGX:U$", "$"].join("");
		expect(scanner.scan(`already redacted ${placeholder}`)).toEqual({ literal: true, rules: [] });
	});

	it("reports matches where the engines' character semantics differ", () => {
		const pairs: Array<[RegExp, string]> = [
			// Rust folds a class before negating it; JavaScript without `u` still matches these.
			[/key=[^s]{4}/i, "key=\u017Fabc"],
			[/key=\W{2}/i, "key=\u212A\u212A"],
			// A case pair one engine's Unicode tables know and the other's may not.
			[/key=\uA7CF/iu, "key=\uA7CE"],
			// Without `u`, JavaScript counts an astral character as two units, also across neighbours.
			[/key=[^"]{8,}/, `key=${"\u{1F600}".repeat(4)}`],
			[/key=.[^"]/, "key=\u{1F600}"],
			// Lone surrogates reach the scanner as U+FFFD.
			[/key=.{2}/, "key=\uD83Dx"],
		];
		for (const [regex, text] of pairs) {
			expect(jsMatches(regex, text)).toBe(true);
			expect(new SecretScanner([rule(regex)], []).scan(text)?.rules).toEqual([0]);
		}
	});

	it("never rules out a text a random rule matches in JavaScript", () => {
		let seed = 0x5eed;
		const rand = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return (seed >>> 8) % n;
		};
		const pick = <T>(xs: readonly T[]) => xs[rand(xs.length)]!;
		const atoms = [
			'[^"]',
			".",
			"\\S",
			"\\W",
			"\\D",
			"[^]",
			"a",
			"[ab]",
			"[^a]",
			"k",
			"s",
			"[k-s]",
			"\\w",
			"[\\S]",
			"[^\\w]",
		];
		const quantifiers = ["", "", "?", "*", "+", "{2}", "{3,}", "{1,3}", "{4,5}", "*?", "+?"];
		const pool = [
			"a",
			"b",
			"k",
			"K",
			"s",
			'"',
			"\u{1F600}",
			"\u{1F601}",
			"\uD83D",
			"\uDE00",
			"\u00E9",
			"\u212A",
			"\u017F",
			"\n",
			" ",
			"_",
		];
		const misses: string[] = [];
		for (const flags of ["", "i", "s", "u", "iu"]) {
			const regexes: RegExp[] = [];
			for (let p = 0; p < 120; p++) {
				let body = "";
				for (let a = 1 + rand(4); a > 0; a--) body += `(?:${pick(atoms)})${pick(quantifiers)}`;
				regexes.push(new RegExp(`ZQ${body}QZ`, flags));
			}
			const texts: string[] = [];
			for (let t = 0; t < 400; t++) {
				let s = "";
				for (let k = rand(9); k > 0; k--) s += pick(pool);
				texts.push(`ZQ${s}QZ`);
			}
			const scanner = new SecretScanner(regexes.map(rule), []);
			const unfiltered = new Set(scanner.unfiltered());
			const hits = scanner.scanMany(texts);
			texts.forEach((text, t) => {
				const reported = new Set(hits[t]?.rules ?? []);
				regexes.forEach((regex, r) => {
					if (!reported.has(r) && !unfiltered.has(r) && regex.test(text)) {
						misses.push(`${regex} on ${JSON.stringify(text)}`);
					}
				});
			});
		}
		expect(misses.slice(0, 5)).toEqual([]);
	});
});
