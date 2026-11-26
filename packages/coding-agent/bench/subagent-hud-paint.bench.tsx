/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Benchmark: subagent HUD paint cost.
 *
 * The dock's subagents HUD repaints whenever a running agent's live tool call
 * changes. Each measured paint moves one agent's call detail (as progress
 * events do) and paints the HUD at the given width; `cached` repaints with
 * nothing changed (the paint cache's hit path).
 */
import { createRoot, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type SubagentEntry, SubagentHud, SubagentHudModel } from "../src/ui/dock";

const WARMUP_PAINTS = 1_000;
const MEASURED_PAINTS = 3_000;
const SAMPLES = 5;
const env = staticEnvironment(loadThemeSync("dark"), { now: 0 });

function median(values: number[]): number {
	return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function entries(count: number, revision: number): SubagentEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `Agent${index}`,
		displayId: `Agent${index}`,
		agent: index % 2 ? "scout" : "task",
		description: "inspect the current repository state and summarize active tool progress",
		call: {
			tool: "grep",
			detail: `pattern ${index === revision % count ? revision : 0} in src/**`,
			live: true,
			startedAt: 0,
		},
	}));
}

function measure(agentCount: number, width: number): void {
	createRoot(dispose => {
		const model = new SubagentHudModel();
		model.livePreview.set(true);
		model.expanded.set(true);
		model.entries.set(entries(agentCount, 0));
		const node = (<col>{SubagentHud({ model })}</col>) as UiNode;
		let revision = 0;
		let rowCount = 0;
		const paint = (changed: boolean) => {
			if (changed) model.entries.set(entries(agentCount, ++revision));
			rowCount += paintNode(env, node, width).rows.length;
		};
		const run = (changed: boolean) => {
			for (let i = 0; i < WARMUP_PAINTS; i++) paint(changed);
			const cpuPerPaint: number[] = [];
			const wallPerPaint: number[] = [];
			for (let sample = 0; sample < SAMPLES; sample++) {
				const cpuStarted = process.cpuUsage();
				const wallStarted = performance.now();
				for (let i = 0; i < MEASURED_PAINTS; i++) paint(changed);
				const cpu = process.cpuUsage(cpuStarted);
				cpuPerPaint.push((cpu.user + cpu.system) / MEASURED_PAINTS);
				wallPerPaint.push(((performance.now() - wallStarted) * 1_000) / MEASURED_PAINTS);
			}
			return { cpu: Number(median(cpuPerPaint).toFixed(3)), wall: Number(median(wallPerPaint).toFixed(3)) };
		};
		const changed = run(true);
		const cached = run(false);
		console.log(
			JSON.stringify({
				agents: agentCount,
				width,
				cpuUsPerPaint: changed.cpu,
				wallUsPerPaint: changed.wall,
				cachedWallUsPerPaint: cached.wall,
				rowsPerPaint: rowCount / (2 * (WARMUP_PAINTS + SAMPLES * MEASURED_PAINTS)),
			}),
		);
		dispose();
	});
}

for (const agentCount of [3, 10]) {
	for (const width of [40, 120]) measure(agentCount, width);
}
