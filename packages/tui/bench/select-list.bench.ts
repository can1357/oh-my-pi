/**
 * Benchmark: SelectList per-frame sanitize cost (TUI finding 6).
 *
 * render() used to run sanitizeSingleLine (3 passes + 2 regex execs) up to 3x
 * per item per frame (column widths, row counts, item render). The per-item
 * WeakMap memo sanitizes once per item object; repeated frames reuse it.
 *
 * Run: bun packages/tui/bench/select-list.bench.ts
 */
import type { SymbolTheme } from "../src/symbols";
import { SelectList } from "../src/components/select-list";
import { makeBench } from "./_harness";

const theme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: { cursor: ">" } as SymbolTheme,
};

const ITEMS = 500;
const FRAMES = 100;

const items = Array.from({ length: ITEMS }, (_, i) => ({
	value: `file-${i}`,
	label: `src/components/module_${i}.ts\twith tab`,
	description: `Handles the stable_prefix_freeze_path_${i}  with   extra   whitespace\nand newline`,
}));
const list = new SelectList(items, 12, theme);

list.render(100); // prime memo

const bench = makeBench(1);
console.log(`SelectList repeated-frame benchmark (${ITEMS} items x ${FRAMES} frames)\n`);

bench("render-repeated-frame", () => {
	for (let i = 0; i < FRAMES; i++) list.render(100);
});
