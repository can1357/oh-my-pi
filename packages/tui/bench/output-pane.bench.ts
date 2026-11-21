/**
 * Benchmark: OutputPane per-frame render cost.
 *
 * `OutputPane.render()` styles every stored output row and joins the whole
 * styled set into one string — per frame, per live execution block while the
 * memo misses. The memoized result is keyed on the content width, the width
 * config epoch, the theme epoch and the image protocol; the pane's rows reach
 * it only through `invalidate()` dropping the memo.
 *
 * A pane re-renders every frame while it sits in the live transcript tail, so
 * this measures the repeated-frame cost of a pane whose content is settled.
 *
 * Run: bun packages/tui/bench/output-pane.bench.ts
 */
import { OutputPane } from "../src/render/output-pane";
import { ensureThemeSync, theme } from "../src/theme";
import { makeBench } from "./_harness";

ensureThemeSync();

const FRAMES = 300;
/** A representative command-output line, ~52 bytes. */
const LINE_BYTES = 52;
/** `tools.artifactSpillThreshold` defaults to 50 KB — the inline output cap a completed command lands under. */
const KB50_LINES = Math.floor((50 * 1024) / LINE_BYTES);

/** Build a pane holding `lineCount` lines, the way `bash-execution` installs a completed command's output. */
function makePane(lineCount: number): OutputPane {
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		lines.push(`line ${i}: some representative command output text here`);
	}
	const pane = new OutputPane(theme, {
		expanded: false,
		collapsedMaxLines: 20,
		edge: "tail",
		visual: true,
		paddingX: 1,
		leadingBlank: true,
		showHiddenMarker: false,
		showExpandHint: false,
		styleLine: line => theme.fg("muted", line),
	});
	pane.setLines(lines);
	return pane;
}

/** Microseconds per frame for a settled pane re-rendered `FRAMES` times. */
function perFrameUs(lineCount: number): number {
	const pane = makePane(lineCount);
	for (let i = 0; i < 30; i++) pane.render(100); // warm up
	const bench = makeBench(1);
	const elapsed = bench(`${lineCount} lines`, () => {
		for (let i = 0; i < FRAMES; i++) pane.render(100);
	});
	return (elapsed / FRAMES) * 1000;
}

const CASES: [label: string, lines: number][] = [
	["settled-small", 100],
	["50KB-cap", KB50_LINES],
	["large", 10_000],
];

console.log(`OutputPane.render per-frame cost (${FRAMES} frames each)\n`);

// Interleave the cases so a JIT warm-up in one case cannot masquerade as a
// win in another: each case runs once per round, and the rounds are reported
// together.
const rounds = 3;
const results = new Map<string, number[]>();
for (const [label] of CASES) results.set(label, []);
for (let round = 0; round < rounds; round++) {
	for (const [label, lines] of CASES) {
		results.get(label)!.push(perFrameUs(lines));
	}
}

console.log("per-frame microseconds (median of rounds):");
for (const [label, lines] of CASES) {
	const runs = results.get(label)!;
	const sorted = [...runs].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	console.log(
		`  ${label.padEnd(10)} ${median.toFixed(2).padStart(7)} us/frame  (${lines} lines; runs: ${runs.map(r => r.toFixed(2)).join(", ")})`,
	);
}
