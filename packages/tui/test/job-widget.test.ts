import { beforeAll, describe, expect, it } from "bun:test";
import type { TspChartProps, TspPropNode } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import {
	describeJobTile,
	describeJobWidget,
	describeJobWidgetsHovercard,
	jobWidgetGlance,
	type JobTile,
	type JobWidgetView,
	renderJobTileLines,
	renderJobWidgetLines,
} from "@oh-my-pi/pi-tui/tools/job-widget";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { ciRun, DECODE_VALUES, decodeBench, FIXTURE_VIEWS, modelEval, trialSweep } from "./fixtures/job-widget-views";

/** Every described node under `root`, depth first. */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function prop(node: NativeNode | TspPropNode | undefined, name: string): unknown {
	return node?.p ? Reflect.get(node.p, name) : undefined;
}

/** The plain text a subtree shows: `text` props and span runs. */
function texts(root: NativeNode): string {
	return nodes(root)
		.map(node => {
			const value = prop(node, "text");
			if (typeof value === "string") return value;
			const spans = prop(node, "spans");
			return Array.isArray(spans) ? spans.map(part => part.t).join("") : "";
		})
		.join("\n");
}

const ofKind = (root: NativeNode, kind: NativeNode["k"]) => nodes(root).filter(node => node.k === kind);

describe("describeJobWidget", () => {
	it("draws a spark as a bars chart with its domain, toned target mark and per-point tooltips", () => {
		const [chart] = ofKind(describeJobWidget(decodeBench), "chart");
		const p = chart?.p as TspChartProps;
		expect(p).toMatchObject({ kind: "bars", size: "md", min: 0, max: 220 });
		expect(p.marks).toEqual([{ value: 200, tone: "warning", title: "target 200 tok/s" }]);
		expect(p.series).toHaveLength(DECODE_VALUES.length);
		expect(p.series?.[3]).toEqual({ value: DECODE_VALUES[3], title: `12:04:03 · ${DECODE_VALUES[3]} tok/s` });
	});

	it("maps bars, meter, grid and stat blocks onto meters, badges and toned spans", () => {
		const bars = ofKind(describeJobWidget(modelEval), "meter");
		expect(bars.map(meter => [prop(meter, "value"), prop(meter, "label"), prop(meter, "tone")])).toEqual([
			[26 / 30, "26/30", "success"],
			[24 / 30, "24/30", undefined],
			[21 / 30, "21/30", "warning"],
		]);

		const [meter] = ofKind(describeJobWidget(trialSweep), "meter");
		expect(prop(meter, "value")).toBeCloseTo(7 / 9);
		expect(prop(meter, "label")).toBe("7/9 trials");

		const badges = ofKind(describeJobWidget(ciRun), "badge");
		expect(badges.map(badge => [prop(badge, "text"), prop(badge, "tone"), prop(badge, "title")])).toEqual([
			["lint", "success", "passed"],
			["build", "success", "passed"],
			["test (ubuntu)", "error", "failed: 2 tests"],
			["test (macos-14)", "pending", "running"],
			["docs", "muted", "queued"],
		]);

		const stat = nodes(describeJobWidget(decodeBench)).find(node => prop(node, "role") === "omp.job.widget.stat");
		expect(prop(stat, "spans")).toContainEqual({ t: " ▼ 3.2%", s: "success" });
		expect(texts(stat!)).toBe("p50 41 ms · p99 212 ms ▼ 3.2% · errors 0");
	});

	it("puts the headline and a sanitized stage in the head row", () => {
		const head = nodes(describeJobWidget(ciRun)).find(node => prop(node, "role") === "omp.job.widget.head")!;
		expect(texts(head).trim()).toBe("CI · pull/4821\ntest (macos-14) running");
		const decodeHead = describeJobWidget(decodeBench).c?.[0] as NativeNode;
		expect(texts(decodeHead)).toContain("decode 186 tok/s ▲ 15%");
		expect(texts(decodeHead)).toContain("nvfp4 b1 run 32/48");
	});

	it("lays four running jobs out as clockless tiles in an id-less hover card and counts the rest", () => {
		const entries = [decodeBench, modelEval, ciRun, trialSweep, decodeBench].map((view, i) => ({
			id: `bg_${i}`,
			type: "bash" as const,
			view,
		}));
		const card = describeJobWidgetsHovercard(entries)!;
		expect(card).toMatchObject({ k: "col", p: { role: "omp.jobs.hovercard" } });
		const [strip] = card.c ?? [];
		expect(strip).toMatchObject({ k: "row", p: { role: "omp.job.tiles", wrap: true } });
		expect(strip?.c).toHaveLength(4);
		// Tern draws the card only when hovered: a clock would start from the program's last write.
		expect(JSON.stringify(strip)).not.toContain('"k":"elapsed"');
		expect(JSON.stringify(strip?.c?.[0])).toContain('"fx":"pulse"');
		expect(JSON.stringify(card)).not.toContain('"id"');
		expect(JSON.stringify(card.c?.at(-1))).toContain("+1 more job");
		expect(describeJobWidgetsHovercard([])).toBeUndefined();
	});
});

describe("describeJobTile", () => {
	const tile = (over: Partial<JobTile>): JobTile => ({
		id: "bg_1",
		type: "bash",
		status: "running",
		label: "cargo bench",
		durationMs: 4_000,
		live: true,
		...over,
	});
	const role = (root: NativeNode, name: string) => nodes(root).find(node => prop(node, "role") === name);

	it("puts status, title, id and clock over the split figure, the small primary chart, stats and stage", () => {
		const described = describeJobTile(tile({ widget: decodeBench }));
		expect(texts(role(described, "omp.job.tile.head")!).split("\n").filter(Boolean)).toEqual([
			"●",
			"verb-bench · decode throughput",
			"bg_1",
		]);
		expect(ofKind(role(described, "omp.job.tile.head")!, "elapsed")).toHaveLength(1);
		expect(prop(role(described, "omp.job.tile.dot"), "spans")).toEqual([{ t: "●", s: "accent", fx: "pulse" }]);
		expect(prop(role(described, "omp.job.tile.figure"), "spans")).toEqual([
			{ t: "decode ", s: "dim" },
			{ t: "186" },
			{ t: " tok/s", s: "dim" },
			{ t: " ▲ 15%", s: "success" },
		]);
		const chart = role(described, "omp.job.tile.chart")!.p as TspChartProps;
		expect(chart).toMatchObject({ kind: "bars", size: "sm", max: 220 });
		expect(chart.marks).toHaveLength(1);
		expect(texts(role(described, "omp.job.tile.stats")!)).toBe("p50 41 ms · p99 212 ms ▼ 3.2% · errors 0");
		expect(texts(role(described, "omp.job.tile.stage")!)).toBe("nvfp4 b1 run 32/48");
	});

	it("names a subagent's tile by the subagent, its estimate a labelled ring beside the widget's figure", () => {
		const described = describeJobTile(
			tile({
				id: "ConsumersMigration",
				type: "task",
				label: "ConsumersMigration",
				widget: decodeBench,
				completionPercent: 68.4,
			}),
		);
		expect(texts(role(described, "omp.job.tile.title")!)).toBe("ConsumersMigration");
		expect(role(described, "omp.job.tile.id")).toBeUndefined();
		expect(texts(role(described, "omp.job.tile.figure")!)).toBe("decode 186 tok/s ▲ 15%");
		expect(role(described, "omp.job.tile.ring")?.p).toMatchObject({ style: "ring", value: 0.68, label: "68%" });
	});

	it("splits a ratio figure, lists the first keys of a bars block and counts the rest", () => {
		const described = describeJobTile(tile({ widget: modelEval }));
		expect(texts(role(described, "omp.job.tile.figure")!)).toBe("passed 71 / 90");
		const bars = ofKind(role(described, "omp.job.tile.bars")!, "meter");
		expect(bars.map(meter => prop(meter, "value"))).toEqual([26 / 30, 24 / 30, 21 / 30]);
	});

	it("reads a meter's whole where the headline repeats only its numerator", () => {
		const build: JobWidgetView = {
			title: "flameshot build",
			headline: { text: "140" },
			blocks: [{ kind: "meter", label: "steps", value: 140 / 190, text: "140/190" }],
			state: "live",
			updatedAt: 0,
		};
		expect(jobWidgetGlance(build)?.text).toBe("140/190");
		expect(texts(role(describeJobTile(tile({ widget: build })), "omp.job.tile.figure")!)).toBe("140 / 190");
		// A headline of another quantity still wins over the meter's figure.
		expect(jobWidgetGlance(trialSweep)?.text).toBe("0.842");
	});

	it("gives a tile with nothing to chart its stage as the body, never a clock for a figure", () => {
		const plain = describeJobTile(tile({ status: "failed", live: false, exitCode: 101 }));
		expect(role(plain, "omp.job.tile.figure")).toBeUndefined();
		expect(ofKind(role(plain, "omp.job.tile.head")!, "elapsed")).toHaveLength(1);
		expect(prop(role(plain, "omp.job.tile.dot"), "spans")).toEqual([{ t: "✕", s: "error" }]);
		expect(texts(role(plain, "omp.job.tile.lead")!)).toBe("exit 101");

		const task = describeJobTile(
			tile({ id: "Tuner", type: "task", label: "Tuner", completionPercent: 68, stage: "driver edits done" }),
		);
		expect(role(task, "omp.job.tile.lead")?.p).toMatchObject({ wrap: "word" });
		expect(texts(role(task, "omp.job.tile.lead")!)).toBe("driver edits done");
		// A command's long last line is cut to a few lines of the tile.
		const long = describeJobTile(tile({ stage: "x".repeat(200) }));
		expect(texts(role(long, "omp.job.tile.lead")!)).toHaveLength(120);
		expect(prop(role(task, "omp.job.tile.ring"), "value")).toBeCloseTo(0.68);
	});

	it("draws nothing of a widget no spec drives, and no text line the stage repeats", () => {
		const fallback = describeJobTile(
			tile({
				widget: {
					title: "cargo bench",
					stage: "Compiling verb",
					blocks: trialSweep.blocks,
					state: "fallback",
					updatedAt: 0,
				},
			}),
		);
		expect(texts(fallback).split("\n").filter(Boolean)).toEqual(["●", "cargo bench", "bg_1", "Compiling verb"]);

		const repeated = describeJobTile(
			tile({ widget: { ...trialSweep, stage: "trial 8: lr=3e-4\twarmup=500 seed=7" } }),
		);
		expect(role(repeated, "omp.job.tile.note")).toBeUndefined();
		expect(texts(role(repeated, "omp.job.tile.stage")!)).toBe("trial 8: lr=3e-4 warmup=500 seed=7");
	});
});

describe("renderJobTileLines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("draws the title line with the figure and meta at the right, the primary block, then stats and stage", () => {
		const lines = renderJobTileLines(
			{ id: "bg_1", type: "bash", status: "running", label: "", durationMs: 0, live: true, widget: decodeBench },
			100,
			theme,
			{
				lead: "◐ ",
				meta: "12s",
			},
		).map(line => Bun.stripANSI(line));
		expect(lines[0]).toMatch(/^◐ verb-bench · decode throughput bg_1 +decode 186 tok\/s ▲ 15% {2}12s$/);
		expect(visibleWidth(lines[0]!)).toBe(80);
		expect(lines[1]).toMatch(/^ {2}tok\/s · nvfp4 b1 {2}[▁▂▃▄▅▆▇█]+ {2}186 tok\/s {2}┄ target 200 tok\/s$/);
		expect(lines.slice(2)).toEqual(["  p50 41 ms · p99 212 ms ▼ 3.2% · errors 0", "  nvfp4 b1 run 32/48"]);
	});
});

describe("renderJobWidgetLines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const render = (view: JobWidgetView, width: number) =>
		renderJobWidgetLines(view, width, theme).map(line => Bun.stripANSI(line));

	it.each([100, 60, 32])("keeps every line of every block within %i columns, sanitized", width => {
		for (const name in FIXTURE_VIEWS) {
			const view = FIXTURE_VIEWS[name as keyof typeof FIXTURE_VIEWS];
			for (const line of renderJobWidgetLines(view, width, theme)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.min(width, 80));
				const plain = Bun.stripANSI(line);
				expect(plain).not.toMatch(/[\t\r\n\x1b]/);
			}
		}
	});

	it("draws a spark as a block sparkline with the latest value and the target label while it fits", () => {
		const [, spark] = render(decodeBench, 100);
		expect(spark).toMatch(/^ {2}tok\/s · nvfp4 b1 {2}[▁▂▃▄▅▆▇█]+ {2}186 tok\/s {2}┄ target 200 tok\/s$/);
		const [, narrow] = render(decodeBench, 60);
		expect(narrow).toMatch(/[▁▂▃▄▅▆▇█]{12,} {2}186 tok\/s$/);
	});

	it("aligns bars under one label column with right-aligned values", () => {
		const lines = render(modelEval, 100);
		expect(lines[0]).toMatch(/^eval · tests passed per model +passed 71\/90$/);
		const bars = lines.slice(2);
		expect(bars.map(line => line.indexOf("█"))).toEqual([16, 16, 16]);
		expect(bars.map(line => line.slice(-5))).toEqual(["26/30", "24/30", "21/30"]);
		expect(bars[0]!.split("█").length - 1).toBeGreaterThan(bars[2]!.split("█").length - 1);
	});

	it("draws a meter, a wrapped status grid and a sanitized text line", () => {
		expect(render(trialSweep, 60)).toEqual([
			expect.stringMatching(/^ablation · 9 trials +best 0\.842 ▲ 2\.1%$/),
			expect.stringMatching(/^ {2}trials {2}█+░+ {2}7\/9 trials$/),
			"  trial 8: lr=3e-4 warmup=500 seed=7",
		]);
		expect(render(ciRun, 60)).toEqual([
			"CI · pull/4821  test (macos-14) running",
			"  jobs  ● lint  ● build  ● test (ubuntu)  ◌ test (macos-14)",
			"        ◌ docs",
		]);
		expect(render(ciRun, 24).at(-1)).toBe("  jobs  ● ● ● ◌ ◌");
	});
});
