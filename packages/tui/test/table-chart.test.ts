import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	buildChart,
	type ChartKind,
	type ChartPlan,
	planChart,
	worthCharting,
} from "@oh-my-pi/pi-tui/charts/chart-plan";
import { renderChartSvg } from "@oh-my-pi/pi-tui/charts/chart-svg";
import { analyzeTable, parseCell } from "@oh-my-pi/pi-tui/charts/table-data";
import { svgFigurePalette } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import {
	lookupTableChart,
	setTableCharts,
	splitTableCharts,
	TableChartFigure,
	type TableChartPlanner,
} from "@oh-my-pi/pi-tui/chat/table-chart";
import { lexDocument } from "@oh-my-pi/pi-tui/components/markdown";
import { trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Tokens } from "@oh-my-pi/pi-utils/marked";

function table(markdown: string): Tokens.Table {
	const token = lexDocument(markdown).find((entry): entry is Tokens.Table => entry.type === "table");
	if (!token) throw new Error("no table in fixture");
	return token;
}

function analyze(markdown: string) {
	const parsed = table(markdown);
	return analyzeTable(
		parsed.header.map(cell => cell.text),
		parsed.rows.map(row => row.map(cell => cell.text)),
	);
}

const TIMINGS = `| Section | Time |
|---|---|
| generate_analysis | **10879 ms (98.6%)** |
| git_commit | 20.5 ms |
| collect_context | 1.2 s |
| everything else | <10 ms each |`;

const SHARES = `| # | Bucket | Tokens | Share |
|---|---|---:|---:|
| 1 | Tool results | 2,020,235 | 74.6% |
| 2 | Tool args | 544,859 | 20.1% |
| 3 | User text | 92,905 | 3.4% |
| 4 | Assistant text | 48,834 | 1.9% |
| | **Total** | 2,706,833 | 100% |`;

const BEFORE_AFTER = `| Category | Before | After |
|---|---|---|
| Dead files | 287 | 28 |
| Orphan modules | 327 | 29 |
| Package boundaries | 219 | 13 |
| Unsafe casts | 36 | 23 |`;

const TRANSITIONS = `| Config | out tokens r5 → r6 |
|---|---|
| luna:low | 2,049 → 1,973 |
| luna:high | 3,969 → 3,135 |
| sol:med | 2,456 → 2,544 |
| sol:high | 4,100 → 3,900 |`;

const RUNS = `| Run | gemini | haiku |
|---|---|---|
| Run 1 | 58.3 | 66.7 |
| Run 2 | 58.3 | 66.7 |
| Run 3 | 66.7 | 66.7 |
| Run 4 | 50.0 | 58.3 |`;

const METRICS = `| Metric | Gemini 3 Flash | Grok Code Fast 1 | Kimi |
|---|---|---|---|
| Success rate | 50.0% | 65.0% | 70% |
| Edit calls | 275 | 198 | 240 |
| Cost | $0.30 | $0.35 | $0.12 |
| Mean latency | 1.2 s | 900 ms | 2 s |`;

const DELTAS = `| Model | Δ pass rate |
|---|---|
| Sonnet 4.5 | +14.4pp |
| GLM-4.5 Air | +20.0pp |
| Haiku 4.5 | +5.4pp |
| GPT-5.1 Codex Mini | -33pp |`;

const MATRIX = `| Area | run1 | run2 | run3 | run4 |
|---|---|---|---|---|
| architecture | 183,317 | 179,196 | 248,189 | 156,253 |
| funds-flow | 180,410 | 139,295 | 293,007 | 94,004 |
| protocol | 275,285 | 211,444 | 236,247 | 281,011 |`;

const PROFILE = `| % | Self | Function |
|---|---:|---|
| 41.9% | 1.56 s | isSseResponse |
| 22.6% | 844 ms | mergeDynamicModel |
| 6.0% | 223 ms | appendAndFlushLines |
| 3.3% | 126 ms | anon |`;

const PROSE = `| File | Change |
|---|---|
| a.ts | renamed the helper |
| b.ts | dropped the shim |`;

// Rows in their own units, two of them prose that keeps the columns from reading as measures.
const IMPROVEMENTS = `| Metric | Before | After |
|---|---|---|
| Time to return | 59.4 s | 1.23 s |
| UI thread blocked | ~58 s | none seen |
| Memory | 3.65 GB | 197 MB |
| Characters drawn | 1,847,791 | 4,096 + "… 1843695 more" |
| Text sent for highlighting | the whole line | the first 4,096 bytes |
| Dropped frames | 12 | 0 |`;

const VARIANTS = `| | A: old commit | B: short prompt | C: new headers |
|---|---|---|---|
| Verified runs | 155/160 | 149/160 | 154/159 |
| Edit tool errors | 11 | 13 | **7** |
| Input tokens | 681,772 | 597,914 | 543,357 |`;

const ARROW_METRICS = `| Metric | r5 → r6 |
|---|---|
| Wall time | 59.4 s → 1.23 s |
| Memory | 3.65 GB → 197 MB |
| Errors | 11 → 7 |`;

// Rows told apart only by a second text column; the `Notes` column is unique too but describes rather than names.
const NESTED = `| Model | Harness | Notes | Input | Cached | Output | Reasoning |
|---|---|---|---|---|---|---|
| Sonnet 5.5 | baseline | first pass | 104k | 91.6k | 7.0k | 0 |
| Sonnet 5.5 | bash | retried once | 49.5k | 38.7k | 5.1k | 0 |
| Sonnet 5.5 | http | clean | 98.2k | 83.7k | 6.1k | 0 |
| GPT-6-Luna | baseline | clean run | 45.2k | 30.9k | 3.1k | 0.6k |
| GPT-6-Luna | bash | slow | 15.5k | 7.2k | 2.7k | 0.7k |
| GPT-6-Luna | http | fast | 41.1k | 27.8k | 3.2k | 0.8k |`;

// Input = Cached + Uncached input, Total = Input + Output: the values prove the parts.
const TOKENS = `| Model | Harness | Input | Cached | Uncached input | Output | Reasoning | Total |
|---|---|---|---|---|---|---|---|
| Sonnet 5.5 | baseline | 104k | 91.6k | 12.4k | 7.0k | 0 | 111k |
| Sonnet 5.5 | bash | 49.5k | 38.7k | 10.8k | 5.1k | 0 | 54.6k |
| Sonnet 5.5 | http | 98.2k | 83.7k | 14.5k | 6.1k | 0 | 104k |
| GPT-6-Luna | baseline | 45.2k | 30.9k | 14.3k | 3.1k | 0.6k | 48.2k |
| GPT-6-Luna | bash | 15.5k | 7.2k | 8.3k | 2.7k | 0.7k | 18.2k |
| GPT-6-Luna | http | 41.1k | 27.8k | 13.3k | 3.2k | 0.8k | 44.3k |`;

const CI_STEPS = `| Step | Duration | Notes |
|---|---|---|
| Setup + checkout + bun | 8s | Fine |
| apt-get install | 17s | Fine |
| bun install | 10s | Fine |
| **build:native** | **4:14** | Compiles all crate deps cold |
| **bun run check** | **1:21** | Recompiles everything again |
| bun run test | 24s | Fast |
| CLI smoke | 2s | Fast |`;

const BUDGET = `| Bucket | Amount | Notes |
|---|---|---|
| Payroll (10 people) | ~$5.0M | fully loaded |
| Compute | ~$0.9M | sandboxes, CI |
| Ops | ~$0.7M | legal, accounting |
| Buffer | ~$1.4M | contingency |`;

const RATIOS = `| Corpus | Ratio |
|---|---:|
| ASCII | 0.28–0.36× |
| Lines | 0.30–0.34× |
| UTF-8 | 0.22–0.33× |
| Styled | 0.45–0.83× |
| Unicode | 0.38–0.47× |
| Git log | 0.20–0.56× |
| Mixed | 2.51–2.52× |
| OSC | ~10× |`;

const LOOKUPS = `| Scenario | \`Record\` | \`Map\` | \`string[]\` sparse | \`toIntMap\` (frozen) |
|---|---|---|---|---|
| **Hit-only** | ~1.2 ns | ~2.9 ns | ~1.3 ns | **~11–12 ns** |
| **Mixed hit+miss** | ~4.4 ns | ~2.9 ns | ~1.6 ns | **~13 ns** |
| **Single key** | ~0.4 ns | ~0.4 ns | ~0.4 ns | **~7 ns** |`;

const STATUSES = `| | count | |
|---|---|---|
| ported | 248 | evidence-cited |
| redesigned | 125 | covered by the architecture |
| partial | 368 | missing-piece sentence each |
| missing | 786 | |
| na | 16 | legacy |`;

const OUTCOMES = `| Input | ok | fail |
|---|---|---|
| request anthropic-messages | 340 | 40 |
| request openai-chat | 279 | 1 |
| request openai-responses | 327 | 9 |
| request gemini (harvested) | 20 | 0 |`;

const STAGES = `| Model | Baseline | Best (Iter 3) | Iter 4 |
|---|---|---|---|
| kimi | 7 | 3 | 6 |
| haiku | 2 | 2 | 2 |
| gemini | 3 | 2 | 2 |
| glm | 8 | 2 | 2 |`;

const DIFF = `| Part | Files | Added | Removed |
|---|---|---|---|
| Non-test Go code | 29 | 1,980 | 294 |
| Go unit tests | 12 | 1,536 | 2 |
| Compiler test cases | 16 | 386 | 0 |`;

const BUDGETS = `| Measure | Result | Budget |
|---|---|---|
| Open to first paint | 11.0 ms | ≤ 120 ms |
| Scroll frame p95 | 0.13 ms | ≤ 4 ms |
| Keystroke p95 | 0.12 ms | ≤ 2 ms |
| Allocations, steady scroll | 7,246 | ≤ 0 |`;

const QUANTILES = `| tool | calls | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|---:|
| read | 437,382 | 775 | 3,156 | 9,207 | 66,999 |
| search | 42,234 | 292 | 1,703 | 6,980 | 21,563 |
| edit | 112,230 | 268 | 1,083 | 4,090 | 55,711 |`;

const BINS = `| k sessions | share of project-busy time |
|---|---|
| 1 | 80.3% |
| 2 | 14.0% |
| 3 | 4.0% |
| 4 | 1.1% |
| 5+ | 0.6% |`;

const OLD_NEW = `| | Wall time | Peak RSS |
|---|---|---|
| Collect (old) | 2,426 ms | ~4.5 GiB |
| Stream (new) | 1,392 ms | ~105 MiB |`;

// The only numbers are a tier and 1–2 findings beside long prose: a chart would restate nothing.
const FINDINGS = `| Utility | Tier | New Findings | Key Issues |
|---|---|---|---|
| **env** | 1 | 2 | \`-S\` single-quote backslash divergence (medium); continuation vs error (low) |
| **runcon** | 1 | 2 | Duplicate component flags silently accepted (medium); argv[0] prefix leak (low) |
| **split** | 1 | 1 | \`$FILE\` env var set via process-global set_var instead of per-child (medium) |
| **csplit** | 2 | 2 | Rust regex vs POSIX BRE flavor mismatch (medium); offset drops I/O errors (medium) |`;

const SCORES = `| Suite | Passed |
|---|---|
| parser | 48/48 |
| layout | 112/130 |
| paint | 9/40 |
| input | 30/32 |`;

describe("parseCell", () => {
	it("normalizes units to base values and keeps the written figure", () => {
		expect(parseCell("1.2 s")).toMatchObject({ value: 1.2, dim: "duration" });
		expect(parseCell("`900 ms`")).toMatchObject({ value: 0.9, dim: "duration", figure: "900 ms" });
		expect(parseCell("1m 56s")).toMatchObject({ value: 116, dim: "duration" });
		expect(parseCell("1.5 KiB")).toMatchObject({ value: 1536, dim: "bytes" });
		expect(parseCell("~$250+")).toMatchObject({ value: 250, dim: "currency", unit: "$", approx: true });
		expect(parseCell("**4** ✅ (2 attempts)")).toMatchObject({ value: 4, emphasis: true, fit: "note" });
		expect(parseCell("24–72 h")).toMatchObject({ value: 86_400, upper: 259_200, fit: "range" });
		expect(parseCell("2,049 → 1,973")).toMatchObject({ value: 2049, to: 1973, toFigure: "1,973" });
		expect(parseCell("5/8")).toMatchObject({ value: 5, denominator: 8, dim: "fraction" });
		expect(parseCell("-33pp")).toMatchObject({ value: -33, dim: "percent", signed: true });
	});

	it("does not read identifiers, versions, dates or prose as quantities", () => {
		expect(parseCell("#618").kind).toBe("id");
		expect(parseCell("v1.2.3").kind).toBe("version");
		expect(parseCell("2026-01-02").kind).toBe("date");
		expect(parseCell("cf89bee60").kind).toBe("id");
		expect(parseCell("renamed the helper").kind).toBe("text");
		expect(parseCell("—").kind).toBe("missing");
	});

	// Regression: unit lookups read inherited keys, and `3 constructor` threw while rendering.
	it("reads words named like object members as nouns, not units", () => {
		expect(parseCell("3 constructor")).toMatchObject({ kind: "number", value: 3, dim: "count", fit: "note" });
		expect(parseCell("constructor").kind).toBe("text");
	});

	// Regression (#16175): `1 988` read as `1` before prose, so space-grouped columns lost to period columns.
	it("reads thousands grouped by spaces like grouped by commas, three digits a group", () => {
		expect(parseCell("17 083")).toMatchObject({ value: 17_083, fit: "pure" });
		expect(parseCell("1\u00a0988\u202f000 ms")).toMatchObject({ value: 1988, dim: "duration", fit: "pure" });
		expect(parseCell("12 5")).toMatchObject({ value: 12, fit: "prose" });
		expect(parseCell("1 2345")).toMatchObject({ value: 1, fit: "prose" });
	});

	it("reads a lone m as millions unless the column holds other durations", () => {
		const millions = analyze("| k | v |\n|---|---|\n| a | 3.3m |\n| b | 1.2m |\n| c | 0.4m |");
		expect(millions.measures[0]!.dim).toBe("count");
		const minutes = analyze("| k | v |\n|---|---|\n| a | 3m |\n| b | 45 s |\n| c | 2m |");
		expect(minutes.measures[0]!.dim).toBe("duration");
	});
});

describe("analyzeTable", () => {
	it("labels by the text column, not the row index, and keeps total rows out of the data", () => {
		const shares = analyze(SHARES);
		expect(shares.label?.header).toBe("Bucket");
		expect(shares.rows).toEqual([0, 1, 2, 3]);
		expect(shares.totals).toEqual([4]);
		expect(shares.measures.map(column => column.header)).toEqual(["Tokens", "Share"]);
	});

	it("drops measure columns that echo one setting", () => {
		const analysis = analyze(
			"| Run | threshold | score |\n|---|---|---|\n| a | 50 | 61 |\n| b | 50 | 63 |\n| c | 50 | 58 |",
		);
		expect(analysis.measures.map(column => column.header)).toEqual(["score"]);
	});

	it("reads whole-number scores as the percent of their total, but not pairs or lists", () => {
		const scores = analyze(SCORES);
		expect(scores.measures[0]).toMatchObject({ dim: "percent", scores: true });
		expect(scores.measures[0]!.cells[1]).toMatchObject({ value: (100 * 112) / 130, figure: "112/130" });
		const listed = analyze(
			"| | old | new |\n|---|---|---|\n| Edit / read calls | 85 / 147 | 83 / 143 |\n| Options | 327 / 333 / 339 | 1 / 2 / 3 |\n| Runs | 155/160 | 154/159 |",
		);
		// The pair row names both values it holds, so it splits into one row each.
		expect(listed.columns[0]!.cells.map(cell => cell.text)).toEqual(["Edit", "read calls", "Options", "Runs"]);
		expect(listed.columns[1]!.cells.map(cell => cell.kind === "number" && [cell.dim, cell.value])).toEqual([
			["count", 85],
			["count", 147],
			["fraction", 327],
			["percent", (100 * 155) / 160],
		]);
		const paired = analyze("| Case | p50 / p95 |\n|---|---|\n| a | 3 / 9 |\n| b | 4 / 8 |\n| c | 2 / 5 |");
		expect(paired.measures[0]).toMatchObject({ dim: "fraction", scores: false });
	});

	// Regression: `1.0/4` and `27.0/36` read as scores beside `0.6/4` fractions, so their bars dropped out.
	it("reads a column's scores all one way: mean scores as percents, beside a plain fraction none", () => {
		const means = analyze(
			"| Task | Tests passed |\n|---|---|\n| a | 1.0/4 (0–3) |\n| b | 0.6/4 (0–3) |\n| c | 27.0/36 |\n| d | 25.8/36 |",
		);
		expect(means.measures[0]!.cells.map(cell => cell.kind === "number" && [cell.dim, cell.value])).toEqual([
			["percent", 25],
			["percent", 15],
			["percent", 75],
			["percent", (100 * 25.8) / 36],
		]);
		const plain = analyze("| Case | ratio |\n|---|---|\n| a | 12/12 |\n| b | 5/3 |\n| c | 1.2/3.4 |");
		expect(plain.measures[0]!.cells.map(cell => cell.kind === "number" && cell.dim)).toEqual([
			"fraction",
			"fraction",
			"fraction",
		]);
	});

	// Regression: `25.0 / 27.8` pairs read as fractions beside single values, so the single-value rows drew no bars.
	it("splits rows whose name and cells list the same pair, keeping single-value rows on the axis", () => {
		const arms = analyze(
			"| Model | Arm | Tests passed | Turns |\n|---|---|---|---|\n| Luna | bash | 27.0 | 6.0 |\n| Luna | pager 24×80 / 48×120 | 25.0 / 27.8 | 12.6 / 9.4 |\n| Sonnet | bash | 26.2 | 8.0 |",
		);
		expect(arms.columns[1]!.cells.map(cell => cell.text)).toEqual(["bash", "pager 24×80", "pager 48×120", "bash"]);
		expect(arms.measures.map(column => column.cells.map(cell => cell.kind === "number" && cell.value))).toEqual([
			[27, 25, 27.8, 26.2],
			[6, 12.6, 9.4, 8],
		]);
	});

	it("keeps a mostly numeric column whose other cells are status words", () => {
		const analysis = analyze(
			"| Input | GNU | uutils |\n|---|---|---|\n| a | 36ms | 112ms |\n| b | 31ms | 1,222ms |\n| c | 30ms | TIMEOUT |",
		);
		expect(analysis.measures.map(column => column.header)).toEqual(["GNU", "uutils"]);
	});

	// Regression (#16175): space-grouped counts read as prose, so the period column became the measure.
	it("labels by the period column when the counts beside it group thousands by spaces", () => {
		const analysis = analyze(
			"| Okres | Commity | Średnio dziennie |\n|---|---|---|\n| ostatnie 24 h | 386 | 386 |\n| 7 dni | 1 988 | ~284 |\n| 30 dni | 7 715 | ~257 |\n| 90 dni | 17 083 | ~190 |\n| 365 dni | 31 489 | ~86 |",
		);
		expect(analysis.label?.header).toBe("Okres");
		expect(analysis.measures.map(column => column.header)).toEqual(["Commity", "Średnio dziennie"]);
		expect(analysis.measures[0]!.cells.map(cell => cell.kind === "number" && cell.value)).toEqual([
			386, 1988, 7715, 17_083, 31_489,
		]);
	});
});

describe("planChart", () => {
	const kinds: [string, string, ChartKind][] = [
		["one measure across categories", TIMINGS, "bar"],
		["a share column summing to 100", SHARES, "share"],
		["before/after headers", BEFORE_AFTER, "paired"],
		["a → b cells", TRANSITIONS, "paired"],
		["measures over a run sequence", RUNS, "line"],
		["rows that are metrics in different units", METRICS, "multiples"],
		["signed deltas", DELTAS, "diverging"],
		["a same-unit matrix", MATRIX, "heatmap"],
		// Regression: a sorted leading % column beside a name column is a measure, not a line's x axis.
		["a sorted measure beside a name column", PROFILE, "multiples"],
		["before/after rows in their own units, some in prose", IMPROVEMENTS, "change"],
		["variants of a baseline across metrics", VARIANTS, "change"],
		["a → b cells in their own units", ARROW_METRICS, "change"],
		["one column of scores", SCORES, "progress"],
		["columns the values prove are parts of a total", TOKENS, "stacked"],
		["outcome counts per row", OUTCOMES, "stacked"],
		["a run's step durations in order", CI_STEPS, "timeline"],
		["amounts building up to their sum", BUDGET, "waterfall"],
		["low–high ranges", RATIOS, "range"],
		["several timings per row spanning decades", LOOKUPS, "dots"],
		["counts that split a whole", STATUSES, "share"],
		["one quantity per row over ordered stages", STAGES, "slope"],
		["lines added against lines removed", DIFF, "butterfly"],
		["results against their own budgets", BUDGETS, "bullet"],
		["quantile columns", QUANTILES, "ladder"],
		["shares over ordered bins", BINS, "histogram"],
		["two conditions on a few metrics", OLD_NEW, "stat"],
	];
	it.each(kinds)("charts %s as %s", (_name, markdown, kind) => {
		expect(planChart(analyze(markdown))?.kind).toBe(kind);
	});

	// Regression: a `Share` column restating the amounts won over them, so crate tables drew a share bar of
	// a dozen slivers (or bars of percents) instead of the amounts building to their total.
	it("builds amounts beside their shares up to the total once there are more parts than a share bar holds", () => {
		const crate = (name: string, lines: number) =>
			`| ${name} | ${lines.toLocaleString("en-US")} | ${((100 * lines) / 885_126).toFixed(1)}% |`;
		const rows = [
			["tern", 239_737],
			["platform", 64_359],
			["term", 58_506],
			["ui", 51_870],
			["mesh", 37_376],
			["editor", 37_254],
			["kit", 30_017],
			["surface", 29_053],
			["39 other crates", 336_954],
		] as const;
		const crates = analyze(
			`| Crate | Lines of Rust | Share |\n|---|---:|---:|\n${rows.map(([name, lines]) => crate(name, lines)).join("\n")}\n| **Total** | **885,126** | **100%** |`,
		);
		const plan = planChart(crates)!;
		expect(plan.kind).toBe("waterfall");
		expect(crates.columns[plan.series[0]!]!.header).toBe("Lines of Rust");
		// Few parts keep their one share bar.
		expect(
			planChart(
				analyze(
					"| Model | Spend | Share |\n|---|---:|---:|\n| a | $10,426 | 45.9% |\n| b | $8,077 | 35.6% |\n| c | $3,770 | 16.6% |\n| d | $437 | 1.9% |\n| **Total** | **$22,710** | **100%** |",
				),
			)?.kind,
		).toBe("share");
		// A pick of a share bar over more parts than it holds ranks them as bars.
		const long = analyze(
			`| Crate | Share |\n|---|---:|\n${Array.from({ length: 14 }, (_, at) => `| c${at} | ${at < 2 ? 30 : 40 / 12}% |`).join("\n")}`,
		);
		expect(buildChart(long, { kind: "share", label: 0, series: [1], transpose: false })?.kind).toBe("bar");
	});

	it("draws nothing for prose tables or two values", () => {
		expect(planChart(analyze(PROSE))).toBeUndefined();
		expect(planChart(analyze(FINDINGS))).toBeUndefined();
		expect(planChart(analyze("| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |"))).toBeUndefined();
	});

	it("stacks the parts a total is made of, leaving out the subtotal and what the sums disprove", () => {
		const analysis = analyze(TOKENS);
		const plan = planChart(analysis)!;
		const header = (index: number) => analysis.columns[index]!.header;
		expect(plan.series.map(header)).toEqual(["Cached", "Uncached input", "Output"]);
		expect(header(plan.whole!)).toBe("Total");
	});

	it("plots one of two columns that restate each other", () => {
		const arms = analyze(
			"| arm | pass | pass% | $/task |\n|---|---|---|---|\n| opus48 | 33/38 | 87% | $2.82 |\n| n12 | 27/38 | 71% | $1.30 |\n| n8 | 25/38 | 66% | $1.24 |\n| haiku | 14/38 | 37% | $0.72 |",
		);
		expect(arms.measures.map(column => column.header)).toEqual(["pass", "$/task"]);
	});

	it("transposes metric-per-row tables so each metric keeps its own unit", () => {
		const analysis = analyze(METRICS);
		const spec = buildChart(analysis, planChart(analysis)!)!;
		expect(spec.categories).toEqual(["Gemini 3 Flash", "Grok Code Fast 1", "Kimi"]);
		expect(spec.series.map(series => [series.name, series.dim])).toEqual([
			["Success rate", "percent"],
			["Edit calls", "count"],
			["Cost", "currency"],
			["Mean latency", "duration"],
		]);
	});

	it("fits a pick to the series it draws: one unit per axis, a series count per kind", () => {
		const shares = analyze(SHARES);
		const mixed = buildChart(shares, { kind: "grouped", label: 1, series: [2, 3], transpose: false });
		expect(mixed?.kind).toBe("multiples");
		const matrix = analyze(MATRIX);
		const three = buildChart(matrix, { kind: "paired", label: 0, series: [1, 2, 3], transpose: false });
		expect(three?.kind).toBe("grouped");
		const one = buildChart(matrix, { kind: "grouped", label: 0, series: [1], transpose: false });
		expect(one?.kind).toBe("bar");
		const lone = buildChart(matrix, { kind: "scatter", label: 0, series: [1], transpose: false });
		expect(lone?.kind).toBe("bar");
		// Tracks fill toward 100%: counts fall back to bars, side by side unless a dumbbell was asked for.
		const counts = buildChart(matrix, { kind: "progress", label: 0, series: [1, 2], transpose: false });
		expect(counts?.kind).toBe("grouped");
	});

	it("measures each after value as a factor of its before value, naming the rows it skips", () => {
		const analysis = analyze(IMPROVEMENTS);
		const spec = buildChart(analysis, planChart(analysis)!)!;
		expect(spec.categories).toEqual(["Time to return", "Memory", "Characters drawn", "Dropped frames"]);
		expect(spec.baseline).toBe("Before");
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([
			1.23 / 59.4,
			197e6 / 3.65e9,
			4096 / 1847791,
			0,
		]);
		expect(spec.series[0]!.points[0]!.text).toBe("59.4 s → 1.23 s");
		expect(spec.caption).toContain("UI thread blocked");
		expect(spec.caption).toContain("Text sent for highlighting");
		expect(spec.caption).not.toContain("Memory");

		const variants = analyze(VARIANTS);
		const grouped = buildChart(variants, planChart(variants)!)!;
		expect(grouped.baseline).toBe("A: old commit");
		expect(grouped.series.map(series => series.name)).toEqual(["B: short prompt", "C: new headers"]);
		expect(grouped.series[1]!.points[1]!.value).toBeCloseTo(7 / 11);
	});

	it("names rows whose labels repeat by the column telling them apart, nesting the label's runs", () => {
		const analysis = analyze(NESTED);
		const spec = buildChart(analysis, planChart(analysis)!)!;
		expect(spec.categories.slice(0, 2)).toEqual(["Sonnet 5.5 · baseline", "Sonnet 5.5 · bash"]);
		expect(spec.groups).toEqual([
			{ name: "Sonnet 5.5", members: ["baseline", "bash", "http"] },
			{ name: "GPT-6-Luna", members: ["baseline", "bash", "http"] },
		]);

		// Interleaved labels: the other naming column runs in blocks, so it nests instead; table order stays.
		const interleaved = analyze(
			"| Model | Harness | Tokens |\n|---|---|---|\n| Sonnet | baseline | 111k |\n| Luna | baseline | 48k |\n| Sonnet | bash | 55k |\n| Luna | bash | 18k |",
		);
		const byHarness = buildChart(interleaved, planChart(interleaved)!)!;
		expect(byHarness.categories).toEqual(["Sonnet · baseline", "Luna · baseline", "Sonnet · bash", "Luna · bash"]);
		expect(byHarness.groups?.map(group => group.name)).toEqual(["baseline", "bash"]);

		// No column runs in blocks: flat joined names, no nesting.
		const scattered = analyze(
			"| Model | Harness | Tokens |\n|---|---|---|\n| Sonnet | baseline | 111k |\n| Luna | bash | 48k |\n| Sonnet | bash | 55k |\n| Luna | baseline | 18k |",
		);
		const flat = buildChart(scattered, planChart(scattered)!)!;
		expect(flat.categories).toEqual(["Sonnet · baseline", "Luna · bash", "Sonnet · bash", "Luna · baseline"]);
		expect(flat.groups).toBeUndefined();

		// A plan's group regroups interleaved rows by first appearance, table order within each group.
		const byModel = buildChart(scattered, { ...planChart(scattered)!, group: 0 })!;
		expect(byModel.categories).toEqual(["Sonnet · baseline", "Sonnet · bash", "Luna · bash", "Luna · baseline"]);
		expect(byModel.groups).toEqual([
			{ name: "Sonnet", members: ["baseline", "bash"] },
			{ name: "Luna", members: ["bash", "baseline"] },
		]);
	});

	it("splits a → b cells into from and to series named by the header", () => {
		const analysis = analyze(TRANSITIONS);
		const spec = buildChart(analysis, planChart(analysis)!)!;
		expect(spec.series.map(series => series.name)).toEqual(["out tokens r5", "r6"]);
		expect(spec.series[1]!.points[0]).toMatchObject({ value: 1973, text: "1,973" });
	});
});

describe("worthCharting", () => {
	const spec = (markdown: string) => {
		const analysis = analyze(markdown);
		return buildChart(analysis, planChart(analysis)!)!;
	};

	it("needs four categories and either nine values or a 3× spread", () => {
		expect(worthCharting(spec(TIMINGS))).toBe(true);
		expect(worthCharting(spec(MATRIX))).toBe(false);
		expect(worthCharting(spec(RUNS))).toBe(false);
		expect(worthCharting(spec(BEFORE_AFTER))).toBe(true);
	});

	it("counts small-multiple panels like categories", () => {
		expect(worthCharting(spec(METRICS))).toBe(true);
	});

	it("draws a change from three metrics once one moves by half again either way", () => {
		expect(worthCharting(spec(IMPROVEMENTS))).toBe(true);
		const flat = `| Metric | Before | After |\n|---|---|---|\n| Time | 10 s | 9 s |\n| Memory | 100 MB | 90 MB |\n| Errors | 10 | 9 |`;
		expect(spec(flat).kind).toBe("change");
		expect(worthCharting(spec(flat))).toBe(false);
	});
});

describe("renderChartSvg", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("writes a repeated row name once per group", () => {
		const analysis = analyze(NESTED);
		const svg = renderChartSvg(buildChart(analysis, { ...planChart(analysis)!, shading: "shared" })!);
		expect(svg.match(/>Sonnet 5\.5</g)).toHaveLength(1);
		expect(svg.match(/>bash</g)).toHaveLength(2);
	});

	it("draws a heatmap's columns of different quantities as bars on their own axes", () => {
		const analysis = analyze(NESTED);
		const plan = planChart(analysis)!;
		// Input dwarfs Reasoning in every row: shades on one scale would wash Reasoning out.
		expect(plan).toMatchObject({ kind: "heatmap", shading: "series" });
		expect(buildChart(analysis, plan)?.kind).toBe("multiples");
		expect(buildChart(analysis, { ...plan, shading: "shared" })?.kind).toBe("heatmap");
	});

	it("colors every kind only through theme tokens, all of which the figure palette resolves", () => {
		const palette = svgFigurePalette();
		const plans: [string, ChartPlan | undefined][] = [
			TIMINGS,
			SHARES,
			BEFORE_AFTER,
			RUNS,
			METRICS,
			DELTAS,
			MATRIX,
			IMPROVEMENTS,
			VARIANTS,
			ARROW_METRICS,
			SCORES,
			TOKENS,
			OUTCOMES,
			CI_STEPS,
			BUDGET,
			RATIOS,
			LOOKUPS,
			STATUSES,
			STAGES,
			DIFF,
			BUDGETS,
			QUANTILES,
			BINS,
			OLD_NEW,
		].map(markdown => [markdown, planChart(analyze(markdown))]);
		const scatter = analyze("| a | b |\n|---|---|\n| 1 | 9 |\n| 4 | 2 |\n| 2 | 7 |\n| 8 | 1 |\n| 5 | 3 |\n| 3 | 6 |");
		plans.push(["scatter", { kind: "scatter", label: undefined, series: [0, 1], transpose: false }]);
		for (const [markdown, plan] of plans) {
			const analysis = markdown === "scatter" ? scatter : analyze(markdown);
			const svg = renderChartSvg(buildChart(analysis, plan!)!);
			// Gradients count as themed: their stops are tokens too.
			expect(svg).not.toMatch(/(?:fill|stroke|stop-color)="(?!var\(--|none"|url\(#)/);
			for (const [, name] of svg.matchAll(/var\(--([\w-]+)\)/g)) expect(palette[name!]).toBeDefined();
			expect(prepareSvg(svg, palette)).not.toContain("var(--");
		}
	});
});

describe("table charts in assistant Markdown", () => {
	afterEach(() => {
		setTableCharts("off");
		vi.restoreAllMocks();
	});

	const answer = `Timings:\n\n${TIMINGS}\n\nThat is all.`;

	it("counts its separator in a caller's ceiling, and below two rows neither plans nor holds up completion", async () => {
		const protocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const choice = Promise.withResolvers<ChartPlan | null>();
		const planner = vi.fn<TableChartPlanner>(() => choice.promise);
		setTableCharts("smart", planner);
		let maxRows = 1;
		let changed = Promise.withResolvers<void>();
		const chart = new TableChartFigure({ maxRows: () => maxRows, onChange: () => changed.resolve() });
		chart.update(table(BEFORE_AFTER));
		try {
			expect(chart.render(76)).toEqual([]);
			expect(chart.pending).toBe(false);
			expect(planner).not.toHaveBeenCalled();

			maxRows = 4;
			chart.render(76);
			expect(chart.pending).toBe(true);
			choice.resolve(planner.mock.calls[0]![0].guess);
			await changed.promise;
			changed = Promise.withResolvers<void>();
			chart.render(76);
			await changed.promise;
			const drawn = chart.render(76);
			expect(drawn.length).toBeLessThanOrEqual(4);
			expect(drawn[0]).toBe("");
			expect(drawn.some(row => TERMINAL.isImageLine(row))).toBe(true);
		} finally {
			chart.dispose();
			setTerminalImageProtocol(protocol);
		}
	});

	it("leaves a table streaming at the tail whole and charts it once the answer moves on", () => {
		setTableCharts("always");
		expect(splitTableCharts(`Timings:\n\n${TIMINGS}\n`, true).map(segment => segment.kind)).toEqual(["markdown"]);
		expect(splitTableCharts(answer, true).map(segment => segment.kind)).toEqual(["markdown", "chart", "markdown"]);
		expect(splitTableCharts(`Timings:\n\n${TIMINGS}\n`, false).map(segment => segment.kind)).toEqual([
			"markdown",
			"chart",
		]);
	});

	it("does not split around tables that get no chart", () => {
		setTableCharts("always");
		expect(splitTableCharts(`Files:\n\n${PROSE}\n\nDone.`, false)).toHaveLength(1);
		setTableCharts("off");
		expect(splitTableCharts(answer, false)).toHaveLength(1);
	});

	it("draws the chart as a terminal image between its table and the prose after it", async () => {
		const protocol = TERMINAL.imageProtocol;
		await initTheme(false);
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			setTableCharts("always");
			const landed = Promise.withResolvers<void>();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1,
			};
			const component = new AssistantMessageComponent(message, false, () => landed.resolve());
			component.render(100);
			await landed.promise;
			const rows = component.render(100);
			const imageRow = rows.findIndex(row => TERMINAL.isImageLine(row));
			const tableEnd = rows.findLastIndex(row => row.includes("everything else"));
			const after = rows.findIndex(row => row.includes("That is all."));
			expect(tableEnd).toBeGreaterThanOrEqual(0);
			expect(imageRow).toBeGreaterThan(tableEnd);
			expect(after).toBeGreaterThan(imageRow);

			// A subagent's transcript keeps the table bare and holds nothing back for a chart.
			const subagent = new AssistantMessageComponent(message);
			subagent.setTableChartsVisible(false);
			expect(subagent.render(100).some(row => TERMINAL.isImageLine(row))).toBe(false);
			expect(subagent.isTranscriptBlockPending()).toBe(false);
		} finally {
			setTerminalImageProtocol(protocol);
		}
	});

	it("publishes only settled rows while an answer with a table streams", async () => {
		const protocol = TERMINAL.imageProtocol;
		await initTheme(false);
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			setTableCharts("always");
			// TIMINGS gets a chart once the answer moves past it; PROSE never does.
			for (const body of [TIMINGS, PROSE]) {
				const text = `The numbers from the last run, before any table arrives.\n\n${body}\n\nThat is all.`;
				const component = new AssistantMessageComponent();
				for (let end = 1; end <= text.length; end++) {
					component.updateContent(
						{
							role: "assistant",
							content: [{ type: "text", text: text.slice(0, end) }],
							api: "anthropic-messages",
							provider: "anthropic",
							model: "claude-sonnet-4-5",
							stopReason: "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: 1,
						},
						{ transient: true },
					);
					// Published rows may already be in native scrollback: every later
					// render must still open with them, byte for byte.
					const rows = trimBlankEdges(component.render(100));
					const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, 100);
					expect(rows.slice(0, stable.length)).toEqual([...stable]);
				}
				expect(component.getTranscriptStableRows().length).toBeGreaterThan(0);
			}
		} finally {
			setTerminalImageProtocol(protocol);
		}
	});

	it("asks the smart planner once per table the guess would chart, single series included", async () => {
		const planner = vi.fn<TableChartPlanner>(async request =>
			request.table.measures.length > 1 ? { ...request.guess, kind: "heatmap" } : null,
		);
		setTableCharts("smart", planner);
		// Three rows of one measure draw nothing locally: nothing for the judge to veto or refine.
		expect(lookupTableChart(table("| Step | Time |\n|---|---|\n| a | 1 s |\n| b | 2 s |\n| c | 3 s |"))).toBeNull();
		// One measure the guess would draw, which the judge may still read as references rather than quantities.
		await lookupTableChart(table(TIMINGS));
		expect(lookupTableChart(table(TIMINGS))).toBeNull();
		const pick = lookupTableChart(table(BEFORE_AFTER));
		expect(pick).toBeInstanceOf(Promise);
		await pick;
		expect(lookupTableChart(table(BEFORE_AFTER))).toContain("heatmap chart of");
		expect(planner).toHaveBeenCalledTimes(2);
	});

	it("draws no chart when the planner declines, and the local guess when it fails", async () => {
		setTableCharts("smart", async () => null);
		await lookupTableChart(table(BEFORE_AFTER));
		expect(lookupTableChart(table(BEFORE_AFTER))).toBeNull();
		expect(splitTableCharts(`x\n\n${BEFORE_AFTER}\n\ny`, false)).toHaveLength(1);

		setTableCharts("smart", async () => {
			throw new Error("no judge");
		});
		await lookupTableChart(table(BEFORE_AFTER));
		expect(lookupTableChart(table(BEFORE_AFTER))).toContain("paired chart of");

		// No judge to ask (`auto` without a native one): the guess at once, held to the gate `always` applies.
		setTableCharts("smart", () => undefined);
		expect(lookupTableChart(table(BEFORE_AFTER))).toContain("paired chart of");
		expect(lookupTableChart(table(RUNS))).toBeNull();
	});
});
