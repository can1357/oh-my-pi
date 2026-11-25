/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Benchmark: transcript compose cost vs session depth.
 *
 * A long interactive session finalizes assistant blocks and the terminal
 * backend retires their rows into native scrollback. Once retired, history is
 * immutable rows the terminal owns: a live tail mutation must not re-walk or
 * repaint sealed history.
 *
 * This bench mounts N settled assistant blocks (prose + closed code fences) and
 * a streaming tail in the app's {@link Transcript}, runs them on the real
 * `TermBackend` (in-memory driver) so the history is retired, then times one
 * frame per tail delta. `resizeMs` is one frame after a width change, which
 * re-verifies every committed block against history at the new width.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { signal } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Transcript } from "../src/ui/shell/transcript";
import { AssistantMessageBlock } from "../src/ui/transcript/messages/assistant-message";

const WIDTH = 100;
const ROWS = 24;
const SIZES = [500, 5000, 20_000];
const WARMUP = 20;
const SAMPLES = 200;
const theme = loadThemeSync("dark");

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

/** Build N retired finalized blocks + a live tail; per-delta frame median/p95, and a resize frame. */
function measure(n: number): { median: number; p95: number; resizeMs: number; historyRows: number } {
	const history = makeTextMessage(makeMarkdownCorpus(240));
	const transcript = new Transcript();
	for (let i = 0; i < n; i++) {
		const block = transcript.append(() =>
			AssistantMessageBlock({ model: { message: signal(history), finalized: signal(true) } }),
		);
		transcript.settle(block);
	}
	const tailText = signal(makeTextMessage("Live answer in progress."));
	transcript.append(() =>
		AssistantMessageBlock({ model: { message: tailText, transient: signal(true), finalized: signal(false) } }),
	);
	const term = createTestTerminal(() => ({ main: transcript.nodes }), {
		columns: WIDTH,
		rows: ROWS,
		theme,
		separator: transcript.separator,
	});
	const historyRows = term.history().length;
	if (historyRows === 0) throw new Error("Expected finalized history in scrollback");

	let delta = 0;
	const tick = () => {
		tailText.set(makeTextMessage(`Live answer in progress, delta ${delta++}.`));
		term.render();
	};
	for (let i = 0; i < WARMUP; i++) tick();
	const samples: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const start = Bun.nanoseconds();
		tick();
		samples.push((Bun.nanoseconds() - start) / 1e6);
	}
	samples.sort((a, b) => a - b);
	const started = Bun.nanoseconds();
	term.resize(WIDTH - 1, ROWS);
	const resizeMs = (Bun.nanoseconds() - started) / 1e6;
	term.dispose();
	transcript.clear();
	return { median: percentile(samples, 50), p95: percentile(samples, 95), resizeMs, historyRows };
}

console.log(`\nBenchmark: transcript-compose (live tail frame after retired finalized history, width ${WIDTH})\n`);

const results = SIZES.map(n => {
	const r = measure(n);
	console.log(
		`  N=${n}: median ${r.median.toFixed(4)}ms  p95 ${r.p95.toFixed(4)}ms  ` +
			`resize ${r.resizeMs.toFixed(2)}ms (${r.historyRows} history rows)`,
	);
	return r;
});

const small = results[0]!;
const large = results[results.length - 1]!;
const ratio = large.median / small.median;
console.log(
	`\n  ratio(N${SIZES[SIZES.length - 1]}/N${SIZES[0]}) median = ${ratio.toFixed(3)}  ` +
		`(N${SIZES[SIZES.length - 1]} p95 = ${large.p95.toFixed(4)}ms)\n`,
);
