/**
 * Benchmark: transcript compose cost vs session depth
 * (perf/transcript-compose-flat-after-commit)
 *
 * A long interactive session finalizes assistant blocks and emits their rows
 * into native terminal scrollback. Once committed, those rows are immutable
 * history the terminal owns; the local {@link TranscriptContainer} should drop
 * them from its frame so a live tail mutation does not re-walk sealed history.
 *
 * This bench builds N finalized assistant blocks (prose + closed code fences),
 * commits every finalized row into native scrollback, then times one pure
 * `TranscriptContainer.render(width)` per streaming tick of a single live tail
 * block. Depth-linear cost (ms rising with N) means sealed history is still
 * walked and re-assembled each tick; flat cost means the committed prefix was
 * compacted and only the live tail composes.
 *
 * Target after the fix: ratio(N5000/N500) <= 1.3, N5000 p95 < 10 ms.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { initTheme } from "../src/modes/theme/theme";

const WIDTH = 100;
const SIZES = [500, 5000];
const WARMUP = 20;
const SAMPLES = 200;

function makeMarkdownCorpus(targetGraphemes: number): string {
	const para =
		"The quick brown fox jumps over the lazy dog while 🚀 emoji and a `code span` " +
		"plus **bold** and _italic_ text exercise the markdown lexer and the grapheme segmenter. ";
	const codeBlock = "\n```ts\nconst x: number = compute(a, b) + delta;\nreturn x.toFixed(2);\n```\n\n";
	const list = "\n- first bullet item\n- second bullet item with `inline`\n- third\n\n";
	let out = "";
	let i = 0;
	while (out.length < targetGraphemes) {
		out += `## Section ${++i}\n\n${para}${para}${codeBlock}${list}`;
	}
	return out.slice(0, targetGraphemes);
}

function makeTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

/** Build N committed finalized blocks + a live tail, return per-tick render medians/p95. */
function measure(n: number): { median: number; p95: number } {
	const histText = makeMarkdownCorpus(240);
	const tailCorpus = makeMarkdownCorpus(1200);
	const container = new TranscriptContainer();
	for (let i = 0; i < n; i++) {
		const c = new AssistantMessageComponent();
		c.updateContent(makeTextMessage(histText));
		c.markTranscriptBlockFinalized();
		container.addChild(c);
	}
	const tail = new AssistantMessageComponent();
	container.addChild(tail);
	let revealed = Math.floor(tailCorpus.length * 0.5);
	tail.updateContent(makeTextMessage(tailCorpus.slice(0, revealed)), { transient: true });

	// Warm every block's markdown L1 cache and establish the assembled frame,
	container.render(WIDTH);

	const tick = () => {
		revealed += 20;
		if (revealed > tailCorpus.length) revealed = Math.floor(tailCorpus.length * 0.5);
		tail.updateContent(makeTextMessage(tailCorpus.slice(0, revealed)), { transient: true });
		container.render(WIDTH);
	};

	for (let i = 0; i < WARMUP; i++) tick();
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const start = Bun.nanoseconds();
		tick();
		samples.push((Bun.nanoseconds() - start) / 1e6);
	}
	samples.sort((a, b) => a - b);
	return { median: percentile(samples, 50), p95: percentile(samples, 95) };
}

await Settings.init({ inMemory: true });
await initTheme("dark");

console.log(`\nBenchmark: transcript-compose (live tail tick after committed finalized history, width ${WIDTH})\n`);

const results = SIZES.map(n => {
	const r = measure(n);
	console.log(`  N=${n}: median ${r.median.toFixed(4)}ms  p95 ${r.p95.toFixed(4)}ms`);
	return r;
});

const small = results[0]!;
const large = results[results.length - 1]!;
const ratio = large.median / small.median;
console.log(
	`\n  ratio(N${SIZES[SIZES.length - 1]}/N${SIZES[0]}) median = ${ratio.toFixed(3)}  ` +
		`(target <= 1.3; N${SIZES[SIZES.length - 1]} p95 = ${large.p95.toFixed(4)}ms, target < 10ms)\n`,
);
