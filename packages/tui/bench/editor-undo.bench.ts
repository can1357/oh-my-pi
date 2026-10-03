/**
 * Benchmark: Editor undo snapshot cost — structuredClone vs slice (finding TUI-1).
 *
 * EditorState is { lines: string[], cursorLine: number, cursorCol: number }:
 * primitives plus immutable strings, so a shallow array copy is a complete
 * snapshot. Measures both approaches over a 20k-line buffer.
 *
 * Run: bun packages/tui/bench/editor-undo.bench.ts
 */
import { makeBench } from "./_harness";

const LINES = 20_000;
const OPS = 200;

const lines: string[] = [];
for (let i = 0; i < LINES; i++) lines.push(`line ${i} with some content to copy ${"x".repeat(40)}`);
const state = { lines, cursorLine: LINES - 1, cursorCol: 10 };

const bench = makeBench(1);

console.log(`Editor undo snapshot benchmark (${LINES} lines, ${OPS} snapshots per op)\n`);

bench("structuredClone(state)", () => {
	for (let i = 0; i < OPS; i++) structuredClone(state);
});

bench("slice-snapshot(state)", () => {
	for (let i = 0; i < OPS; i++) {
		const snap = { lines: state.lines.slice(), cursorLine: state.cursorLine, cursorCol: state.cursorCol };
		if (snap.cursorLine < 0) console.log("unreachable");
	}
});
