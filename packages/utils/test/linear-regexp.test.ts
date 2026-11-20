import { describe, expect, it } from "bun:test";
import { type EngineLimits, LinearRegExp } from "@oh-my-pi/pi-utils/regex";

/** Deterministic xorshift32, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
	let state = seed;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 2 ** 32;
	};
}

function pick<T>(random: () => number, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)]!;
}

// Atoms chosen where JavaScript semantics are easy to get wrong: case folding of
// K/k/U+212A, line terminators beyond `\n`, `\w`/`\b` under `i`, empty and full
// classes, Annex B literals and legacy octal escapes.
const ATOMS = [
	"a",
	"b",
	"A",
	"k",
	"_",
	" ",
	"-",
	"\\.",
	".",
	"\\n",
	"\\r",
	"\\s",
	"\\S",
	"\\w",
	"\\W",
	"\\d",
	"\\x41",
	"\\u212A",
	"\\-",
	"\\141",
	"\\07",
	"[ab]",
	"[^a]",
	"[a-c]",
	"[^\\n]",
	"[\\s\\S]",
	"[^]",
	"[]",
	"[A-Z_]",
	"[\\w-]",
	"[^k]",
	"]",
	"{",
];
const QUANTIFIERS = ["*", "+", "?", "{0,2}", "{1,3}", "{2}", "{1,}", "*?", "+?", "??", "{0,2}?", "{1,}?"];
const ASSERTIONS = ["^", "$", "\\b", "\\B"];
const LOOKAROUNDS = ["(?=", "(?!", "(?<=", "(?<!"];
const INPUT_UNITS = [
	"a",
	"b",
	"A",
	"B",
	"k",
	"K",
	"\u212A",
	"_",
	" ",
	"\n",
	"\r",
	"\u2028",
	"-",
	"1",
	"é",
	"\uD83D",
	"\uDE00",
];

/** A random pattern; `nonRegular` mixes in lookarounds and backreferences to earlier groups. */
function pattern(random: () => number, nonRegular: boolean): string {
	let groups = 0;
	const node = (depth: number): string => {
		const roll = random();
		if (depth <= 0 || roll < 0.35) {
			if (nonRegular && groups > 0 && random() < 0.15) return `\\${1 + Math.floor(random() * groups)}`;
			if (random() < 0.12) return pick(random, ASSERTIONS);
			return pick(random, ATOMS);
		}
		if (roll < 0.55) return Array.from({ length: 2 + Math.floor(random() * 3) }, () => node(depth - 1)).join("");
		if (roll < 0.7) {
			const options = Array.from({ length: 2 + Math.floor(random() * 2) }, () => node(depth - 1));
			return `(?:${options.join("|")})`;
		}
		if (nonRegular && roll < 0.8) return `${pick(random, LOOKAROUNDS)}${node(depth - 1)})`;
		const capture = random() < 0.5;
		if (capture) groups++;
		const group = capture ? `(${node(depth - 1)})` : `(?:${node(depth - 1)})`;
		return `${group}${pick(random, QUANTIFIERS)}`;
	};
	return node(3);
}

function flags(random: () => number): string {
	return ["i", "m", "s", "y", "g"].filter(() => random() < 0.3).join("");
}

/** Limits small enough that short inputs cross window edges and force memo and cache resets. */
function tinyLimits(random: () => number): EngineLimits {
	return {
		window: 1 + Math.floor(random() * 3),
		lookbehindContext: Math.floor(random() * 3),
		dfaEntries: 1 + Math.floor(random() * 40),
		jitAfter: Math.floor(random() * 3),
		memoAfter: Math.floor(random() * 2) * 3,
		memoPages: Math.floor(random() * 3),
		memoContexts: 1 + Math.floor(random() * 3),
	};
}

function input(random: () => number): string {
	return Array.from({ length: Math.floor(random() * 11) }, () => pick(random, INPUT_UNITS)).join("");
}

/** Everything `exec` reports, so arrays with holes and explicit `undefined` compare equal. */
function describeMatch(match: RegExpExecArray | null): string {
	return match === null ? "null" : JSON.stringify({ index: match.index, values: [...match], groups: match.groups });
}

/** Every match a global search reports, with `lastIndex` after each. */
function scan(regex: RegExp, text: string): string {
	const out: string[] = [];
	regex.lastIndex = 0;
	for (let round = 0; round < 20; round++) {
		const match = regex.exec(text);
		out.push(`${describeMatch(match)}@${regex.lastIndex}`);
		if (!match || !(regex.global || regex.sticky)) break;
		if (match[0].length === 0) regex.lastIndex++;
	}
	return out.join(" ");
}

describe("LinearRegExp agrees with RegExp", () => {
	it("on matches, captures, lastIndex and streamed prefixes", () => {
		const random = rng(0x9e3779b9);
		const mismatches: string[] = [];
		for (let round = 0; round < 800 && mismatches.length < 10; round++) {
			const source = pattern(random, random() < 0.4);
			const flagSet = flags(random);
			const native = new RegExp(source, flagSet);
			const linear = new LinearRegExp(source, flagSet);
			const limits = tinyLimits(random);
			const cramped = new LinearRegExp(source, flagSet, limits);
			if (!linear.stream()) {
				mismatches.push(`${native}: not compiled`);
				continue;
			}
			for (let sample = 0; sample < 12; sample++) {
				const text = input(random);
				const expected = scan(native, text);
				const actual = scan(linear, text);
				if (actual !== expected)
					mismatches.push(`${native} on ${JSON.stringify(text)}:\n  js ${expected}\n  us ${actual}`);
				const tight = scan(cramped, text);
				if (tight !== expected) {
					mismatches.push(
						`${native} on ${JSON.stringify(text)} with ${JSON.stringify(limits)}:\n  js ${expected}\n  us ${tight}`,
					);
				}
				const prefixes = cramped.stream()!;
				let fed = 0;
				while (fed < text.length) {
					const end = fed + 1 + Math.floor(random() * 3);
					prefixes.push(text.slice(fed, end));
					fed = Math.min(end, text.length);
					native.lastIndex = 0;
					const hit = native.test(text.slice(0, fed));
					// Without lookarounds or backreferences the stream is exact; otherwise it never misses.
					if (linear.streamsExactly ? prefixes.matched !== hit : hit && !prefixes.matched) {
						mismatches.push(`${native} streamed ${JSON.stringify(text.slice(0, fed))}: js ${hit}`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("on named groups, duplicate names, case-folded backreferences and lookbehind captures", () => {
		const cases: [string, string, string[]][] = [
			["(?<word>\\w+) \\k<word>", "", ["hello hello", "hello world"]],
			["(?:(?<v>a)|(?<v>b))\\k<v>", "", ["aa", "bb", "ab"]],
			["(k)\\1", "i", ["kK", "k\u212A", "Kk"]],
			["(?<=(\\d+)px)\\s", "", ["width: 12px ;", "12 px"]],
			["(?<!(a)\\1)b", "", ["aab", "acb"]],
			["((a)|b)+\\2", "", ["aba", "abb"]],
		];
		for (const [source, flagSet, texts] of cases) {
			for (const text of texts) {
				const native = new RegExp(source, `${flagSet}d`);
				const linear = new LinearRegExp(source, `${flagSet}d`);
				expect(describeMatch(linear.exec(text))).toBe(describeMatch(native.exec(text)));
				expect(JSON.stringify(linear.exec(text)?.indices)).toBe(JSON.stringify(native.exec(text)?.indices));
			}
		}
	});

	it("preserves greedy capture boundaries when a run gives units back or exceeds the fast-path budget", () => {
		const cases: [string, string][] = [
			[String.raw`(?<left>a+)(?<middle>a{1,3})(?<empty>)(?<right>a{2})b`, "skip aaaaaab aaaab"],
			[String.raw`(?<stem>[a.]+)\.(?<suffix>a{12,})`, `x aa.${"a".repeat(14)} y aa.${"a".repeat(160)}`],
			[String.raw`(?<run>é{0,128})é`, `x ${"é".repeat(129)} y ééé`],
		];
		for (const [source, text] of cases) {
			const native = [...text.matchAll(new RegExp(source, "gd"))];
			const linear = [...text.matchAll(new LinearRegExp(source, "gd"))];
			expect(linear.map(describeMatch)).toEqual(native.map(describeMatch));
			expect(linear.map(match => match.indices)).toEqual(native.map(match => match.indices));
		}
	});

	it("keeps the leftmost match when probing a required prefix or delimiter", () => {
		const cases: [string, string, number][] = [
			[String.raw`(?<local>[a-z]{1,4})@[a-z]+`, "abcdef@host cdef@other", 3],
			[String.raw`(?<local>[a-z]*)@[a-z]+`, "@!bbb@host @other", 0],
			[String.raw`(?<local>[a-z]+)@[a-z]+`, `${"a".repeat(160)}@host B@other`, 0],
			[String.raw`(?<prefix>🦀=)[^;]+;`, "skip 🦀=no skip 🦀=yes;", 7],
			[String.raw`(?<start>k)[a-z]+;`, "xx Ka; kA; Ka;", 0],
		];
		for (const [source, text, from] of cases) {
			const native = new RegExp(source, "gid");
			const linear = new LinearRegExp(source, "gid");
			native.lastIndex = linear.lastIndex = from;
			expect([...text.matchAll(linear)]).toEqual([...text.matchAll(native)]);
		}
	});

	it("preserves ordered alternatives and restores captures on a failed branch", () => {
		const cases: [string, string][] = [
			[String.raw`(?<head>a*)(?<branch>a|b)`, "aaab aaa"],
			[String.raw`(?:token=(?<digits>\d+)|token=(?<word>\w+));`, "token=12x; token=42; token=X;"],
			[String.raw`x(?:(?<first>a+)|(?<second>ab))c`, "xabc xaaac xabc"],
			[String.raw`a|`, "abba"],
			[String.raw`(?:a+b|a)`, `${"a".repeat(150)}b ax ab`],
			[String.raw`(?:(?<head>(a+|b))c|(?<tail>a+)d)`, "aaad bc aaaac"],
		];
		for (const [source, text] of cases) {
			const native = [...text.matchAll(new RegExp(source, "gd"))];
			const linear = [...text.matchAll(new LinearRegExp(source, "gd"))];
			expect(linear.map(describeMatch)).toEqual(native.map(describeMatch));
			expect(linear.map(match => match.indices)).toEqual(native.map(match => match.indices));
		}
	});

	it("on long text, across search windows and memo pages", () => {
		const random = rng(0x1234567);
		const words = [
			"alpha",
			"beta",
			"key=v1",
			"gamma",
			"gamma",
			"'quoted'",
			"delta",
			"x=1;",
			"key=",
			"Beta",
			"\n",
			"  ",
		];
		const text = Array.from({ length: 6_000 }, () => pick(random, words)).join(" ");
		const patterns: [string, string][] = [
			["\\b(\\w+)\\s\\1\\b", "g"],
			["(?<=key=)\\w+", "g"],
			["(['\"])[^\\n]*?\\1", "g"],
			["(?<![=\\w])\\w+(?==)", "g"],
			["^( *)\\S[^\\n]*\\n\\1\\S", "gm"],
			["(beta|gamma) (?!\\1)\\w+", "gi"],
		];
		for (const [source, flagSet] of patterns) {
			const expected = [...text.matchAll(new RegExp(source, flagSet))].map(
				match => `${match.index}:${[...match].join("|")}`,
			);
			const actual = [...text.matchAll(new LinearRegExp(source, flagSet))].map(
				match => `${match.index}:${[...match].join("|")}`,
			);
			expect(expected.length).toBeGreaterThan(0);
			expect(actual).toEqual(expected);
		}
	});

	it("routes replace, split and matchAll through the engine", () => {
		const source = "(\\w)(\\d)?";
		const text = "a1 b c2";
		const native = new RegExp(source, "g");
		const linear = new LinearRegExp(source, "g");
		expect(text.replace(linear, "[$2$1]")).toBe(text.replace(native, "[$2$1]"));
		expect(text.split(new LinearRegExp("\\s"))).toEqual(text.split(/\s/));
		expect([...text.matchAll(linear)].map(match => [...match])).toEqual(
			[...text.matchAll(native)].map(match => [...match]),
		);
	});

	it("answers catastrophically backtracking patterns in linear time", () => {
		// JSC needs seconds for ~20 body lines of either shape (issues #19147, #19360).
		const lines = Array.from({ length: 5_000 }, (_, line) =>
			line % 2 ? "    \n" : "        total = total + item\n",
		);
		const body = lines.join("");
		const regular = new LinearRegExp(
			"^[ \\t]*def[ \\t]+[^\\n]+\\n(?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*?[ \\t]+import ",
			"m",
		);
		expect(regular.test(`def handler():\n${body}    return value\n`)).toBe(false);
		expect(regular.exec(`def handler():\n${body}    import os\n`)?.[0].length).toBe(26 + body.length);
		const backreference = new LinearRegExp(
			"(?:^|\\n)([ \\t]*)for\\b[^\\n]*:[ \\t]*\\n(?:\\1[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*?\\1[ \\t]+[^\\n]*(?:\\.objects\\.get\\s*\\()",
		);
		const loop = `def total(items):\n    for item in items:\n${body}`;
		expect(backreference.test(`${loop}    user = User.objects.get(pk=1)\n`)).toBe(false);
		expect(backreference.exec(`${loop}        User.objects.get(pk=1)\n`)?.[1]).toBe("    ");
	});
});
