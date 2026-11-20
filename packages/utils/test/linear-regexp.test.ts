import { describe, expect, it } from "bun:test";
import { type EngineLimits, LinearRegExp } from "@oh-my-pi/pi-utils/regex";
import { canUseNativeExec } from "@oh-my-pi/pi-utils/regex/native-exec";
import { CharClasses } from "@oh-my-pi/pi-utils/regex/nfa";
import { parsePattern } from "@oh-my-pi/pi-utils/regex/parse";

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
			// A bare quantified atom takes the engine's single-character-run paths.
			const atom = pick(random, ATOMS);
			return random() < 0.35 ? `${atom}${pick(random, QUANTIFIERS)}` : atom;
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
		scanSteps: Math.floor(random() * 3) * 6,
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

	it("keeps the first eligible match when mandatory fragments jump across possible starts", () => {
		const cases: [string, string, string, number][] = [
			// The first lookbehind hit starts before lastIndex. Its optional trailing space
			// still allows a match just at lastIndex, with captures outside the match.
			[String.raw`(?<=(?<key>password[=:])\s?)(?<value>\S+)(?=!)`, "PASSWORD= one! password:two!", "gid", 10],
			// The indented first hit is mid-line. A Unicode line separator can start the next one.
			[String.raw`^[ \t]*(?<name>def)[ \t]+\w+!`, "not   def x!\u2028\t  def y!", "gmd", 0],
			// Overlapping runs stop at several endpoints; only one has the next required unit.
			[String.raw`(?<run>[a-z]+?)[ae](?=!)`, `${".".repeat(600)}\u00e9cue! blue!`, "gd", 7],
			// The fixed-offset delimiter probe may see an earlier fence with no eligible prefix.
			[String.raw`(?<!\w)(?:sk|rk)_(\w+?)[a-z]![0-9]*`, "rk_? xyz_sk_abc! sk_one!1", "gd", 0],
			// A bounded prefix can put the same literal at several positions.
			[String.raw`[a-c]{0,3}abc(?<suffix>\w+?)!`, "xabcx abaabcdoo!", "gd", 1],
			// Failure at the first backed-up start must not discard later starts at the same fence.
			[String.raw`(?=b)(?<word>[a-z]+)@(?=!)`, "aaa@! aaababa@! aba@!", "gd", 1],
		];
		for (const [source, text, flags, from] of cases) {
			const native = new RegExp(source, flags);
			for (const scanSteps of [0, 256]) {
				const linear = new LinearRegExp(source, flags, { scanSteps, jitAfter: 1 });
				native.lastIndex = linear.lastIndex = from;
				expect(linear.exec(text)).toEqual(native.exec(text));
				expect(linear.lastIndex).toBe(native.lastIndex);
				expect([...text.matchAll(linear)]).toEqual([...text.matchAll(native)]);
			}
		}
	});

	it("hands a start its scanner cannot afford to the memoized search, with the same result", () => {
		// Three nested runs retry cubically in generated code; the budget stops that at any size.
		const source = "(?<lead>x|y)?a*a*a*(?<tail>b)";
		for (const text of ["a".repeat(150), `${"a".repeat(150)}b`, `ya${"a".repeat(150)}b c ab`]) {
			for (const scanSteps of [0, 256, 1e9]) {
				const linear = [...text.matchAll(new LinearRegExp(source, "gd", { scanSteps }))];
				expect(linear).toEqual([...text.matchAll(new RegExp(source, "gd"))]);
			}
		}
		expect(new LinearRegExp(source).test("a".repeat(200_000))).toBe(false);
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
		const unicode = new LinearRegExp("^(?i:(?:😀😀|😀)+)x$", "u");
		expect(unicode.streamsExactly).toBe(true);
		expect(unicode.test("😀".repeat(5_000))).toBe(false);
	});
});

describe("LinearRegExp native search with bounded retries", () => {
	it("keeps leftmost matches, indices and captures with lookaround and word backreferences", () => {
		const cases: [string, string][] = [
			[
				String.raw`(?<![\w-])(?:user|admin)(?<number>[0-9]*)@(?<host>[a-z0-9.]+)(?![\w-])`,
				"-user7@skip.test user123@bad.test- admin0@ok.test USER42@HOST éuser@ok.test",
			],
			[String.raw`\b(?<word>\w+)\s\k<word>\b`, "alpha alphabet one ONE étwo\ttwo two-two text TEXT"],
		];
		for (const [source, text] of cases) {
			const native = new RegExp(source, "gid");
			const linear = new LinearRegExp(source, "gid");
			native.lastIndex = linear.lastIndex = 2;
			expect([...text.matchAll(linear)]).toEqual([...text.matchAll(native)]);
			expect(linear.lastIndex).toBe(2);
			expect(linear.stream()).toBeDefined();
			expect(linear.streamsExactly).toBe(false);
		}
	});

	it("refuses native search when retries could rescan an unbounded span", () => {
		for (const source of [
			// The separator can be tried at every position of the left run.
			String.raw`user[0-9]*0[0-9]+(?=!)`,
			// Distinct starts can enter the left run at each position.
			String.raw`1[0-9]*@[a-z]+(?=!)`,
			// Distinct separators can enter the same long right run.
			String.raw`user[0-9]*@[a-z@]+(?=!)`,
			// A mismatch may rescan the suffix of the first word from every position.
			String.raw`(?:^|\B)(\w+)\s\1\b`,
			// Unbounded suffixes are not covered by the proof.
			String.raw`\b(\w+)\s\1\b[ \t]*!`,
			// Finite quantifiers can still have too many retry paths.
			String.raw`(?:a|aa){24}!`,
			// Every position within a maximal run can satisfy this lookbehind.
			String.raw`(?<=a)a+!`,
		]) {
			const pattern = parsePattern(source);
			const classes = new CharClasses(pattern, { ignoreCase: false, multiline: false, dotAll: false });
			expect(canUseNativeExec(pattern, classes)).toBe(false);
		}
	});
});

describe("LinearRegExp covers the RegExp surface", () => {
	/** `exec` results of a global scan, with `lastIndex` after each. */
	function scanAll(regex: RegExp, text: string): string {
		const out: string[] = [];
		regex.lastIndex = 0;
		for (let round = 0; round < 12; round++) {
			const match = regex.exec(text);
			out.push(
				`${match === null ? "null" : JSON.stringify({ index: match.index, values: [...match], groups: match.groups })}@${regex.lastIndex}`,
			);
			if (!match || !(regex.global || regex.sticky)) break;
			if (match[0].length === 0) regex.lastIndex++;
		}
		return out.join(" ");
	}

	it("reads every Annex B escape, class, quantifier and group form as the native parser does", () => {
		const raw = String.raw;
		// Each form is one the parser has to read itself; a misread would change what matches.
		const sources = [
			raw`\0`,
			raw`\07a`,
			raw`\8`,
			raw`\18`,
			raw`\101`,
			raw`\400`,
			raw`\x4`,
			raw`\u004`,
			raw`\u{41}`,
			raw`\cj`,
			raw`\c`,
			raw`\c1`,
			raw`\k`,
			raw`\k<a>(?<a>x)`,
			raw`\p{L}`,
			raw`\-\_\/`,
			raw`[\b]`,
			raw`[\d-z]`,
			raw`[a-\d]`,
			raw`[\c1]`,
			raw`[\c]`,
			raw`[\12]`,
			"[]",
			"[^]",
			"[]]",
			"[^]]",
			"[[a]]",
			"[--a]",
			"a{,2}",
			"a{2",
			"a{2,3",
			"a{}",
			"a{1}{",
			"a{01,002}",
			"{",
			"}",
			"]",
			"a||b",
			"(|a)",
			"()*",
			"(?:)*",
			"(?:a|())+",
			"(a?)*?b",
			"(?:a{0})*",
			raw`\1(a)`,
			raw`(a\1)`,
			raw`(a)\2(b)`,
			raw`(a)\10`,
			raw`(a)\01`,
			raw`((a)|(b))\2\3`,
			raw`(?:(?<x>a)|(?<x>b))\k<x>`,
			"(?=a)*a",
			"(?=a){2}a",
			"(?=(a))?\\1b",
			"(?<=\\1(a))b",
			"(?<=(a+?))b",
			"(?<=([ab]+)([bc]+))$",
			"(?:(?=(a))|b)\\1",
		];
		const texts = [
			"",
			"a",
			"aa",
			"ab",
			"aab",
			"abab",
			"bab",
			"b",
			"x",
			"\0",
			"\x078",
			"\x018",
			"A",
			"@",
			"uuu",
			"u{41}",
			"\\c1",
			"k",
			"p{L}",
			"-_/",
			"\b",
			"]",
			"[a]",
			"a{,2}",
			"a{2",
			"a{2,3",
			"a{}",
			"a{",
			"{",
			"}",
			"aXb",
			"abbcc",
		];
		const mismatches: string[] = [];
		for (const source of sources) {
			for (const flagSet of ["", "g", "y", "gi"]) {
				const native = new RegExp(source, flagSet);
				const linear = new LinearRegExp(source, flagSet);
				if (!linear.stream()) mismatches.push(`/${source}/ left to the native engine`);
				for (const text of texts) {
					if (scanAll(linear, text) !== scanAll(native, text))
						mismatches.push(`/${source}/${flagSet} on ${JSON.stringify(text)}`);
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("keeps scoped case folding, dot and line semantics through captures and streaming", () => {
		const cases = [
			[String.raw`(?im:^([a-z]+))(?-i:\1$)`, "!\nFoOFoO"],
			[String.raw`(?<=(?i:\1)(a))!`, "Aa! AA!"],
			[String.raw`(?s:.(?-s:.))`, "\n\n\né"],
			[String.raw`(?<\u0061>x)\k<a>`, "xx"],
		] as const;
		for (const [source, text] of cases) {
			const linear = new LinearRegExp(source, "dg");
			const native = new RegExp(source, "dg");
			expect([...text.matchAll(linear)]).toEqual([...text.matchAll(native)]);
			const stream = linear.stream()!;
			for (let i = 0; i < text.length; i++) {
				stream.push(text[i]!);
				native.lastIndex = 0;
				const found = native.test(text.slice(0, i + 1));
				expect(linear.streamsExactly ? stream.matched : !found || stream.matched).toBe(
					linear.streamsExactly ? found : true,
				);
			}
		}
	});

	it("matches Unicode code points with native capture and offset semantics", () => {
		const cases = [
			[String.raw`^(?<pair>\uD83D\uDE00)+$`, "dgu", "😀😀"],
			[String.raw`[\u{1F3F0}-\u{1F410}]+`, "dgu", "🏯🏰🐀🐐🐑"],
			[String.raw`(?<=(?<tail>\p{Script=Deseret}+))x`, "dgiu", "𐐀𐐨x"],
			[String.raw`(?i:\bK)(?-i:\Bſ)`, "dgu", "Kſ"],
			[String.raw`(\uD83D)\1`, "dgu", "\uD83D😀 \uD83D\uD83D"],
			[String.raw`(?<letter>(?-i:𐐀|K))\k<letter>`, "dgiu", "𐐀𐐨 KK Kk"],
			[String.raw`(?<=\1(𐐀))!`, "dgiu", "𐐨𐐀! 𐐀𐐨!"],
		] as const;
		for (const [source, flags, text] of cases) {
			const linear = new LinearRegExp(source, flags);
			const native = new RegExp(source, flags);
			expect(linear.stream()).toBeDefined();
			for (let from = 0; from <= text.length; from++) {
				linear.lastIndex = native.lastIndex = from;
				expect([...text.matchAll(linear)]).toEqual([...text.matchAll(native)]);
			}
		}
		for (const source of [".", "a"]) {
			const linear = new LinearRegExp(source, "duy");
			const native = new RegExp(source, "duy");
			linear.lastIndex = native.lastIndex = 1;
			expect(linear.exec("😀a")).toEqual(native.exec("😀a"));
			expect(linear.lastIndex).toBe(native.lastIndex);
		}
	});

	it("revisits a streamed high surrogate once its low surrogate arrives", () => {
		for (const source of [String.raw`\p{Surrogate}`, String.raw`\u{1F600}`]) {
			const regex = new LinearRegExp(source, "u");
			const native = new RegExp(source, "u");
			const stream = regex.stream()!;
			expect(regex.streamsExactly).toBe(true);
			const text = "a😀";
			for (let index = 0; index < text.length; index++) {
				stream.push(text[index]!);
				expect(stream.matched).toBe(native.test(text.slice(0, index + 1)));
			}
		}
	});

	it("leaves v-mode sets and oversized quantifiers to the native engine", () => {
		const cases: [string, string, string][] = [
			[String.raw`[\p{L}--[a-z]]`, "v", "aÑb"],
			["a{1,20000}", "", "aaa"],
		];
		for (const [source, flagSet, text] of cases) {
			const linear = new LinearRegExp(source, flagSet);
			expect(linear.stream()).toBeUndefined();
			expect(linear.exec(text)).toEqual(new RegExp(source, flagSet).exec(text));
		}
	});

	it("coerces lastIndex and the input, and feeds replace, split and search, like RegExp", () => {
		for (const lastIndex of [-1, 1.7, "2", null, undefined, Number.NaN, Infinity, 2 ** 40, { valueOf: () => 2 }]) {
			const results = [RegExp, LinearRegExp].map(Kind => {
				const regex = new Kind("a", "g");
				Object.assign(regex, { lastIndex });
				return [regex.exec("aXaXa")?.index, regex.lastIndex];
			});
			expect(results[1]).toEqual(results[0]!);
		}
		for (const Kind of [RegExp, LinearRegExp]) {
			expect(new Kind("\\d+").exec(Object(12) as string)?.[0]).toBe("12");
			expect(
				"john smith".replace(new Kind("(?<first>\\w+)\\s(?<last>\\w+)"), "$<last>, $<first> [$1|$&|$'|$$]"),
			).toBe("smith, john [john|john smith||$]");
			expect("a1b2c3".split(new Kind("(\\d)"), 3)).toEqual(["a", "1", "b"]);
			expect("abc".match(new Kind("x*", "g"))).toEqual(["", "", "", ""]);
			const searched = new Kind("b", "g");
			searched.lastIndex = 2;
			expect(["abcb".search(searched), searched.lastIndex]).toEqual([1, 2]);
		}
	});
});
