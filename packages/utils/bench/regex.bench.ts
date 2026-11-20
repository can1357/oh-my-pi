/**
 * Benchmark: LinearRegExp against the native engine, on the shapes TTSR rules
 * and secret redaction run: a scan that finds nothing, a global scan with many
 * matches, lookaround and backreference patterns, and a pattern on which the
 * native engine backtracks exponentially (kept small enough for it to finish).
 *
 * Run: bun packages/utils/bench/regex.bench.ts
 */
import { LinearRegExp } from "../src/regex";
import { group } from "./harness";

const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
const filler = "lorem ipsum dolor sit amet ";
const prose = filler.repeat(40_000);
const dense = Array.from({ length: 20_000 }, (_, i) => `${filler.repeat(4)}user${i}@host${i % 97}.example.com`).join(
	"\n",
);

/** Native and linear cases counting the matches of one global pattern in `text`. */
function scanCases(source: string, flags: string, text: string): Record<string, () => number> {
	const cases: Record<string, () => number> = {};
	for (const [name, regex] of [
		["native", new RegExp(source, flags)],
		["linear", new LinearRegExp(source, flags)],
	] as const) {
		cases[name] = () => {
			let count = 0;
			regex.lastIndex = 0;
			while (regex.exec(text)) count++;
			return count;
		};
	}
	return cases;
}

await group("email, no match, 1 MB of prose", { units: prose.length, unit: "char" }, scanCases(EMAIL, "gi", prose));
await group("email, 20,000 matches in 2.6 MB", { units: 20_000, unit: "match" }, scanCases(EMAIL, "gi", dense));
await group(
	"alternation with lookaround boundaries, 20,000 matches",
	{ units: 20_000, unit: "match" },
	scanCases("(?<![A-Za-z0-9_-])(?:user|admin)[0-9]*@[a-z0-9.]+(?![A-Za-z0-9_-])", "g", dense),
);
await group(
	"repeated word (backreference), 1 MB",
	{ units: prose.length, unit: "char" },
	scanCases("\\b(\\w+)\\s\\1\\b", "g", prose),
);

for (const [name, source, flags] of [
	["positive lookbehind", String.raw`(?<=password[=:]\s?)\S+`, "gi"],
	["word and space lookbehind", String.raw`(?<=\bBearer )[A-Za-z0-9._~+/=-]{20,}(?![\w-])`, "gi"],
	["fixed-offset delimiter", String.raw`(?<![\w-])(?:sk|rk)_(?:live|test)_[a-z0-9]{20,}(?![\w-])`, "g"],
	["bounded alternation", String.raw`\b(?:TODO|FIXME|HACK|XXX)\b`, "g"],
	["multiline anchor after an indentation run", String.raw`^[ \t]*def[ \t]+[^\n]+`, "gm"],
] as const) {
	await group(`${name}, no match, 1 MB`, { units: prose.length, unit: "char" }, scanCases(source, flags, prose));
}
await group(
	"lookahead and delimiter-separated runs, 20,000 matches",
	{ units: 20_000, unit: "match" },
	scanCases(String.raw`(?=\w+@)\w+@[a-z0-9.]+`, "g", dense),
);

// The #19147 rule shape: every extra body line multiplies the native engine's work.
const rule = "^[ \\t]*def[ \\t]+[^\\n]+\\n(?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*?[ \\t]+import ";
const body = (lines: number): string =>
	`def handler():\n${Array.from({ length: lines }, (_, i) => (i % 2 ? "    \n" : "    value = compute()\n")).join("")}    return value\n`;
await group("backtracking rule, 9 body lines (no match)", { samples: 5 }, scanCases(rule, "gm", body(9)));
const long = body(5_000);
const linearRule = new LinearRegExp(rule, "m");
await group(
	"backtracking rule, 5,000 body lines (linear only)",
	{ units: long.length, unit: "char" },
	{
		linear: () => linearRule.test(long),
	},
);
