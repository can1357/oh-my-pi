/**
 * Benchmark: ScrollView repeated-frame row padding cost with an unchanged window.
 *
 * Exercises the one surviving contribution of this PR after the upstream
 * ScrollView rewrite (which added its own epoch-aware window cache): per-row
 * padding now uses the shared SPACE_BUFFER slice via `padding()` instead of
 * allocating `" ".repeat(n)` per row per frame.
 *
 * Run: bun packages/tui/bench/scroll-view.bench.ts
 */
import { ScrollView } from "../src/components/scroll-view";
import { makeBench } from "./_harness";

const ROWS = 60;
const WIDTH = 100;
const FRAMES = 1000;

const lines = Array.from(
	{ length: ROWS },
	(_, i) => `row ${i} with ansi \x1b[32mcolor\x1b[0m and tabs\tbetween words ${"x".repeat(20)}`,
);
const view = new ScrollView(lines, { height: ROWS, theme: {} });

view.render(WIDTH); // prime cache

const bench = makeBench(1);
console.log(`ScrollView unchanged-window benchmark (${ROWS} rows x ${FRAMES} frames, width ${WIDTH})\n`);

bench("render-unchanged-window", () => {
	for (let i = 0; i < FRAMES; i++) view.render(WIDTH);
});
