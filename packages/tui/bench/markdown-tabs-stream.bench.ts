/**
 * Benchmark: Markdown streaming with tab-heavy content (TUI finding 5).
 *
 * The B+ append-only fast path re-renders only the last content row per
 * streamed frame — but render() used to run replaceTabs over the WHOLE
 * document before reaching that branch, so every frame paid an O(n) scan plus
 * a full-size string copy it never read. The tab scan/normalization now runs
 * after the fast-path branch; streamed frames only tab-expand the delta.
 *
 * Run: bun packages/tui/bench/markdown-tabs-stream.bench.ts
 */
import { Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "../test/test-themes";

const WIDTH = 100;
const BASE = "# T\n\nSome prose with\ttabs in it.\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```\n\n";
const CHUNK = "more streamed text with a\ttab ";

function streamOnce(doc: string, frames: number): number {
	const component = new Markdown("", 0, 0, defaultMarkdownTheme);
	component.transientRenderCache = true;
	const start = Bun.nanoseconds();
	let current = doc;
	for (let i = 0; i < frames; i++) {
		current += CHUNK;
		component.setText(current);
		component.render(WIDTH);
	}
	return (Bun.nanoseconds() - start) / 1e6;
}

const doc = BASE.repeat(40);
console.log(`doc: ${(doc.length / 1024).toFixed(0)}KB tab-heavy, 200 streamed frames per run`);
streamOnce(doc.slice(0, 2000), 20); // warmup
streamOnce(doc.slice(0, 2000), 20);

const runs: number[] = [];
for (let i = 0; i < 5; i++) runs.push(streamOnce(doc, 200));
runs.sort((a, b) => a - b);
console.log(`streamed tab-heavy render (5 runs): median ${runs[2]!.toFixed(1)}ms`);
