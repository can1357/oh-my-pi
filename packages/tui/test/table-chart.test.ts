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
	type TableChartPlanner,
} from "@oh-my-pi/pi-tui/chat/table-chart";
import { lexDocument } from "@oh-my-pi/pi-tui/components/markdown";
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

	it("keeps a mostly numeric column whose other cells are status words", () => {
		const analysis = analyze(
			"| Input | GNU | uutils |\n|---|---|---|\n| a | 36ms | 112ms |\n| b | 31ms | 1,222ms |\n| c | 30ms | TIMEOUT |",
		);
		expect(analysis.measures.map(column => column.header)).toEqual(["GNU", "uutils"]);
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
	];
	it.each(kinds)("charts %s as %s", (_name, markdown, kind) => {
		expect(planChart(analyze(markdown))?.kind).toBe(kind);
	});

	it("draws nothing for prose tables or two values", () => {
		expect(planChart(analyze(PROSE))).toBeUndefined();
		expect(planChart(analyze("| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |"))).toBeUndefined();
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
});

describe("renderChartSvg", () => {
	beforeAll(async () => {
		await initTheme(false);
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
		].map(markdown => [markdown, planChart(analyze(markdown))]);
		const scatter = analyze("| a | b |\n|---|---|\n| 1 | 9 |\n| 4 | 2 |\n| 2 | 7 |\n| 8 | 1 |\n| 5 | 3 |\n| 3 | 6 |");
		plans.push(["scatter", { kind: "scatter", label: undefined, series: [0, 1], transpose: false }]);
		for (const [markdown, plan] of plans) {
			const analysis = markdown === "scatter" ? scatter : analyze(markdown);
			const { svg } = renderChartSvg(buildChart(analysis, plan!)!);
			expect(svg).not.toMatch(/(?:fill|stroke)="(?!var\(--|none")/);
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

	it("asks the smart planner only for multi-series tables, once per table", async () => {
		const planner = vi.fn<TableChartPlanner>(async request => ({ ...request.guess, kind: "heatmap" }));
		setTableCharts("smart", planner);
		expect(lookupTableChart(table(TIMINGS))).toMatchObject({ alt: expect.stringContaining("bar chart") });
		const pick = lookupTableChart(table(BEFORE_AFTER));
		expect(pick).toBeInstanceOf(Promise);
		await pick;
		expect(lookupTableChart(table(BEFORE_AFTER))).toMatchObject({ alt: expect.stringContaining("heatmap chart") });
		expect(planner).toHaveBeenCalledTimes(1);
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
		expect(lookupTableChart(table(BEFORE_AFTER))).toMatchObject({ alt: expect.stringContaining("paired chart") });
	});
});
