import { describe, expect, it } from "bun:test";
import {
	type AutoresearchDashboardRuntime,
	createDashboardController,
} from "@oh-my-pi/pi-tui/apps/autoresearch-dashboard";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import type { ExperimentResult, ExperimentState } from "@oh-my-pi/pi-tui/tools/autoresearch";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import type { TspText } from "@oh-my-pi/pi-wire";

const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function result(runNumber: number, metric: number, status: ExperimentResult["status"]): ExperimentResult {
	return {
		runNumber,
		commit: `c0ffee${runNumber}`,
		metric,
		metrics: {},
		status,
		description: `run ${runNumber}`,
		timestamp: runNumber,
		segment: 0,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
	};
}

function runtime(results: ExperimentResult[]): AutoresearchDashboardRuntime {
	const state: ExperimentState = {
		results,
		bestMetric: results[0]?.metric ?? null,
		bestDirection: "lower",
		metricName: "p50_ms",
		metricUnit: "ms",
		secondaryMetrics: [],
		name: "Speed up the parser",
		goal: "Cut parse time.",
		currentSegment: 0,
		maxExperiments: null,
		confidence: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		notes: "",
		branch: null,
		baselineCommit: null,
		sessionId: null,
	};
	return { autoresearchMode: true, dashboardExpanded: false, state, lastRunSummary: null, runningExperiment: null };
}

/** The overlay component the dashboard hands to the host. */
async function openSheet(rt: AutoresearchDashboardRuntime): Promise<Component> {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("no dark theme");
	let sheet: Component | undefined;
	void createDashboardController().showOverlay(
		{
			hasUI: true,
			ui: {
				setWidget() {},
				custom(factory) {
					sheet = factory({ requestRender() {} }, theme, undefined, () => {});
					return Promise.withResolvers<never>().promise;
				},
			},
		},
		rt,
	);
	if (!sheet) throw new Error("the dashboard opened no overlay");
	return sheet;
}

function describeSheet(sheet: Component): NativeNode {
	const root = sheet.describe?.(cx);
	if (!root) throw new Error("the sheet described nothing");
	return root;
}

function find(root: NativeChild, role: string): NativeNode | undefined {
	if (!("k" in root)) return undefined;
	if (root.p && "role" in root.p && root.p.role === role) return root;
	for (const child of root.c ?? []) {
		const hit = find(child, role);
		if (hit) return hit;
	}
	return undefined;
}

function plain(text: TspText | undefined): string {
	return typeof text === "string" ? text : (text ?? []).map(span => span.t).join("");
}

describe("autoresearch dashboard sheet", () => {
	it("lists the segment's runs newest first, marks the best and shows no metric for a crash", async () => {
		const sheet = await openSheet(
			runtime([result(1, 24, "keep"), result(2, 0, "crash"), result(3, 19, "keep"), result(4, 21, "discard")]),
		);
		const table = find(describeSheet(sheet), "omp.autoresearch.runs");
		if (table?.k !== "table") throw new Error("no runs table");
		const rows = table.p?.rows ?? [];
		const cell = (row: number, col: string): string => {
			const value = rows[row]?.cells[col];
			return value === undefined || (typeof value === "object" && "meter" in value) ? "" : plain(value);
		};
		expect(rows.map((_, index) => cell(index, "run"))).toEqual(["4", "3", "2", "1"]);
		expect(cell(1, "status")).toContain("best");
		expect(cell(2, "metric")).toBe("—");
		expect(cell(3, "change")).toBe("baseline");
	});

	it("says what it waits for while the segment has no runs", async () => {
		const root = describeSheet(await openSheet(runtime([])));
		expect(find(root, "omp.autoresearch.runs")).toBeUndefined();
		const title = find(root, "omp.autoresearch.empty.title");
		if (title?.k !== "text") throw new Error("no empty-state title");
		expect(plain(title.p?.spans)).toBe("No baseline yet");
	});

	it("titles the sheet by the experiment and scrolls its body by keys", async () => {
		const sheet = await openSheet(runtime([result(1, 24, "keep"), result(2, 20, "keep")]));
		expect(plain(sheet.nativeOverlay?.head)).toBe("Speed up the parser · Autoresearch");
		expect(describeSheet(sheet).scroll).toBeUndefined();
		sheet.handleInput?.("j");
		expect(describeSheet(sheet).scroll).toEqual({ by: "line-down", n: 1 });
		sheet.handleInput?.("G");
		expect(describeSheet(sheet).scroll).toEqual({ by: "end", n: 2 });
	});

	it("keeps the terminal rendering", async () => {
		const sheet = await openSheet(runtime([result(1, 24, "keep"), result(2, 20, "keep")]));
		const lines = sheet.render(100).join("\n");
		expect(lines).toContain("autoresearch: Speed up the parser");
		expect(lines).toContain("Best: 20ms (#2)");
	});
});
