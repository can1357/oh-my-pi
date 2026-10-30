import { SubagentHudComponent } from "../src/modes/interactive-mode";

const WARMUP_PAINTS = 1_000;
const MEASURED_PAINTS = 3_000;
const SAMPLES = 5;

function median(values: number[]): number {
	return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function measure(agentCount: number, width: number): void {
	const order = Array.from({ length: agentCount }, (_, index) => `Agent${index}`);
	const lines = [
		"",
		"Subagents",
		...order.map(
			(id, index) =>
				` \x1b[36m${index + 1} ${id}\x1b[0m: inspect the current repository state and summarize active tool progress`,
		),
	];
	const hud = new SubagentHudComponent(lines, order);
	let rowCount = 0;
	for (let paint = 0; paint < WARMUP_PAINTS; paint++) rowCount += hud.render(width).length;
	const cpuPerPaint: number[] = [];
	const wallPerPaint: number[] = [];
	for (let sample = 0; sample < SAMPLES; sample++) {
		const cpuStarted = process.cpuUsage();
		const wallStarted = performance.now();
		for (let paint = 0; paint < MEASURED_PAINTS; paint++) rowCount += hud.render(width).length;
		const cpu = process.cpuUsage(cpuStarted);
		cpuPerPaint.push((cpu.user + cpu.system) / MEASURED_PAINTS);
		wallPerPaint.push(((performance.now() - wallStarted) * 1_000) / MEASURED_PAINTS);
	}
	console.log(
		JSON.stringify({
			agents: agentCount,
			width,
			cpuUsPerPaint: Number(median(cpuPerPaint).toFixed(3)),
			wallUsPerPaint: Number(median(wallPerPaint).toFixed(3)),
			rowCount,
		}),
	);
}

for (const agentCount of [3, 10]) {
	for (const width of [40, 120]) measure(agentCount, width);
}
