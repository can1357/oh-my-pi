/**
 * Restricted shadow-plan projection cost for a complete literal tool-call prefix.
 *
 * This isolates the work performed while an eval candidate is streamed: parsing the
 * current complete prefix and extracting only static literal tool calls. It does not
 * start tools or a JavaScript worker.
 *
 * Run: bun run packages/coding-agent/bench/speculative-shadow-planning.bench.ts
 */
import { projectJavaScriptShadowPlan } from "../src/eval/js/speculation";

const WARMUP_ITERATIONS = 5_000;
const MEASURE_ITERATIONS = 20_000;
const PROGRAM = [
	'tool.read({ path: "src/a.ts" });',
	'tool.read({ path: "src/b.ts" });',
	'tool.read({ path: "src/c.ts" });',
	'tool.read({ path: "src/d.ts" });',
	'tool.read({ path: "src/e.ts" });',
	'tool.read({ path: "src/f.ts" });',
].join("\n");

function project(): number {
	const plan = projectJavaScriptShadowPlan(PROGRAM);
	if (plan.barrier) throw new Error(`Expected a projectable program, got ${plan.barrier.reason}`);
	return plan.operations.length;
}

for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration++) project();

const startedAt = performance.now();
let operations = 0;
for (let iteration = 0; iteration < MEASURE_ITERATIONS; iteration++) operations += project();
const elapsedMs = performance.now() - startedAt;
const msPerProjection = elapsedMs / MEASURE_ITERATIONS;

console.log(`METRIC shadow_plan_ms_per_projection=${msPerProjection.toFixed(6)}`);
console.log(`METRIC shadow_plan_projections_per_second=${(1_000 / msPerProjection).toFixed(1)}`);
console.log(
	`ASI operations_per_projection=${operations / MEASURE_ITERATIONS} iterations=${MEASURE_ITERATIONS} warmup=${WARMUP_ITERATIONS}`,
);
