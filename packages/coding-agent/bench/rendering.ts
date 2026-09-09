import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Editor } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { truncateToVisualLines } from "../src/modes/components/visual-truncate";
import { WelcomeComponent } from "../src/modes/components/welcome";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	nextStep,
	visibleUnits,
} from "../src/modes/controllers/streaming-reveal";
import { getEditorTheme, initTheme } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";

const ITERATIONS = 500;
const WIDTH = 100;

const longText = Array.from({ length: 200 })
	.map((_, i) => `Line ${i + 1}: \x1b[32mcolored content\x1b[0m with emojis 🚀✨ and extra padding`)
	.join("\n");

function bench(name: string, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		fn();
	}
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	const perOp = (elapsed / ITERATIONS).toFixed(6);
	console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op)`);
	return elapsed;
}

await Settings.init({ inMemory: true });
await initTheme("dark");

console.log(`Rendering benchmark (${ITERATIONS} iterations)\n`);

bench("truncateToVisualLines", () => {
	truncateToVisualLines(longText, 20, WIDTH, 1);
});

const welcome = new WelcomeComponent(
	"8.12.3",
	"claude-3.7",
	"anthropic",
	[
		{ name: "Test session", timeAgo: "2m" },
		{ name: "Another session", timeAgo: "1h" },
	],
	[
		{ name: "tsserver", status: "ready", fileTypes: ["ts", "tsx", "js"] },
		{ name: "rust-analyzer", status: "connecting", fileTypes: ["rs"] },
	],
);

bench("WelcomeComponent.render", () => {
	welcome.render(WIDTH);
});

// ── A2: streaming reveal + editor render baselines ──────────────────────────
//
// Diagnostic series, not a fixed-iteration micro-op. The full-reveal loops
// mirror the controller: a per-episode BlockUnitCounter feeds countOf + sliceOf
// (memoized, O(delta)/tick). `streamingReveal` (C1) instead measures the DEFAULT
// pure-sliceGraphemes path at a fixed revealed length — the un-memoized cost the
// counter avoids. Representative controller-path throughput lives in
// bench/streaming-throughput.bench.ts.

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

/** Average ms for one call of `fn`, over `reps` repeats. */
function benchStep(reps: number, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < reps; i++) fn();
	return (Bun.nanoseconds() - start) / 1e6 / reps;
}

/** Average ms for one awaited call of `fn`, over `reps` repeats. */
async function benchStepAsync(reps: number, fn: () => Promise<unknown>): Promise<number> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < reps; i++) await fn();
	return (Bun.nanoseconds() - start) / 1e6 / reps;
}

const REVEAL_CORPUS = makeMarkdownCorpus(6000);
const REVEAL_CHECKPOINTS = [1000, 2000, 3000, 4000, 5000, 6000];
const STEP_REPS = 40;

console.log("\nstreamingReveal (C1: default pure-slice path, fixed revealed length, no memoization):");
for (const n of REVEAL_CHECKPOINTS) {
	const msg = makeTextMessage(REVEAL_CORPUS.slice(0, n));
	const revealed = Math.floor(n * 0.9);
	const ms = benchStep(STEP_REPS, () => {
		visibleUnits(msg, false);
		buildDisplayMessage(msg, revealed, false);
	});
	console.log(`  len=${n}: ${ms.toFixed(4)}ms/step`);
}

// Controller path: a per-episode BlockUnitCounter memoizes count + slice, so
// buildDisplayMessage is O(delta)/tick. The Markdown render (component.render)
// still re-lexes the growing text each step here (no { transient: true }), so
// total ms is dominated by the render, not the slice. Total ms to fully reveal
// an N-grapheme message in nextStep increments.
console.log("\nstreamingRevealFull (controller-path counter + Markdown render, growing text):");
try {
	for (const n of REVEAL_CHECKPOINTS) {
		const full = makeTextMessage(REVEAL_CORPUS.slice(0, n));
		const counter = new BlockUnitCounter();
		const countOf = (index: number, text: string): number => counter.count(index, text);
		const sliceOf = (index: number, text: string, units: number): string => counter.slice(index, text, units);
		const total = visibleUnits(full, false);
		const component = new AssistantMessageComponent();
		const start = Bun.nanoseconds();
		let revealed = 0;
		let steps = 0;
		while (revealed < total) {
			revealed = Math.min(total, revealed + nextStep(total - revealed));
			component.updateContent(buildDisplayMessage(full, revealed, false, true, countOf, sliceOf));
			component.render(WIDTH);
			steps++;
		}
		const ms = (Bun.nanoseconds() - start) / 1e6;
		console.log(`  len=${n}: ${ms.toFixed(2)}ms total over ${steps} steps (${(ms / steps).toFixed(4)}ms/step)`);
	}
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}

// Multi-block variant: a finalized thinking block (stable) precedes the growing
// text block — the shape C2 targets. Current code re-lexes BOTH every tick;
// after C2 the finalized thinking block stays L1-cached and only the tail re-lexes.
function makeThinkingPlusText(thinking: string, text: string): AssistantMessage {
	return {
		...makeTextMessage(text),
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
	};
}
console.log("\nstreamingRevealMultiBlock (C2: finalized thinking block + growing text):");
try {
	const thinking = makeMarkdownCorpus(2500);
	for (const n of [2000, 4000, 6000]) {
		const full = makeThinkingPlusText(thinking, REVEAL_CORPUS.slice(0, n));
		const counter = new BlockUnitCounter();
		const countOf = (index: number, text: string): number => counter.count(index, text);
		const sliceOf = (index: number, text: string, units: number): string => counter.slice(index, text, units);
		const total = visibleUnits(full, false);
		const component = new AssistantMessageComponent();
		const start = Bun.nanoseconds();
		let revealed = 0;
		let steps = 0;
		while (revealed < total) {
			revealed = Math.min(total, revealed + nextStep(total - revealed));
			component.updateContent(buildDisplayMessage(full, revealed, false, true, countOf, sliceOf));
			component.render(WIDTH);
			steps++;
		}
		const ms = (Bun.nanoseconds() - start) / 1e6;
		console.log(
			`  text=${n} (+2500 thinking): ${ms.toFixed(2)}ms total over ${steps} steps (${(ms / steps).toFixed(4)}ms/step)`,
		);
	}
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}

console.log("\neditorKeystroke (C3: layout recompute vs no-mutation render):");
try {
	const buffer = Array.from({ length: 50 })
		.map((_, i) => `Line ${i + 1}: some editor content with words to wrap at width ${WIDTH} and more text here`)
		.join("\n");

	const e1 = new Editor(getEditorTheme());
	e1.setText(buffer);
	e1.render(WIDTH); // warm
	const noMutMs = benchStep(200, () => {
		e1.render(WIDTH);
	});
	console.log(`  no-mutation render: ${noMutMs.toFixed(4)}ms/render`);

	const e2 = new Editor(getEditorTheme());
	e2.setText(buffer);
	e2.render(WIDTH); // warm
	const editMs = benchStep(200, () => {
		e2.insertText("x");
		e2.render(WIDTH);
	});
	console.log(`  edit + render: ${editMs.toFixed(4)}ms/op`);
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}

// ── E3: long-transcript frame cost ──────────────────────────────────────────
//
// E3 root cause: Container.render walks EVERY child and concatenates their line
// arrays on every frame. Finalized messages hit their Markdown L1 cache (no
// re-lex) but still pay the tree walk + line-array rebuild/concat per frame.
// Build N finalized assistant messages (prose + closed code fences) + 1 growing
// tail, then time one render(WIDTH) of the whole tree per streaming frame.
// Rising ms/frame in N => the stable history is re-walked/re-concatenated each
// frame (the cost E3 culls); flat => the walk is already cheap.
console.log("\nlongTranscriptFrame (E3: whole-tree render cost vs transcript length N):");
try {
	const histText = makeMarkdownCorpus(800);
	const tailCorpus = makeMarkdownCorpus(1200);
	for (const n of [50, 100, 200]) {
		const container = new TranscriptContainer();
		for (let i = 0; i < n; i++) {
			const c = new AssistantMessageComponent();
			c.updateContent(makeTextMessage(histText));
			container.addChild(c);
		}
		const tail = new AssistantMessageComponent();
		container.addChild(tail);
		let revealed = Math.floor(tailCorpus.length * 0.5);
		tail.updateContent(makeTextMessage(tailCorpus.slice(0, revealed)));
		container.render(WIDTH); // warm finalized history (L1 caches hot)
		const ms = benchStep(60, () => {
			revealed += 20;
			if (revealed > tailCorpus.length) revealed = Math.floor(tailCorpus.length * 0.5);
			tail.updateContent(makeTextMessage(tailCorpus.slice(0, revealed)));
			container.render(WIDTH);
		});
		console.log(`  N=${n}: ${ms.toFixed(4)}ms/frame`);
	}
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}

// ── E4: tool read/parse redundancy ──────────────────────────────────────────
//
// E4 root cause: the read tool re-parses (tree-sitter `summarizeCode`, ~12-18ms
// for a ~1500-line file) on every summary read of the same unchanged file. E4-ii
// memoizes the parse per session keyed on the content hash of the freshly-read
// bytes, so a repeat read of the same file reuses the parse (the file is still
// read fresh, so the result stays correct). A repeated same-session summary read
// should drop from ~17ms to a few ms; a fresh session each call stays full cost.
console.log("\ntoolReadReparse (E4: repeat summary read, memoized parse vs cold):");
try {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-e4-"));
	const file = path.join(dir, "big.ts");
	let src = "";
	for (let i = 0; i < 375; i++) {
		src += `export function fn${i}(a: number, b: string): boolean {\n  const x = a + ${i};\n  return x > 0 && b.length === ${i};\n}\n`;
	}
	fs.writeFileSync(file, src);
	const mkSession = (): ToolSession =>
		({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => path.join(dir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir, "sess"),
			allocateOutputArtifact: async (t: string) => ({ id: "a", path: path.join(dir, `a.${t}.log`) }),
			settings: Settings.isolated(),
		}) as unknown as ToolSession;
	const sameSession = mkSession();
	const rt = new ReadTool(sameSession);
	for (let i = 0; i < 3; i++) await rt.execute("warm", { path: file });
	const repeatMs = await benchStepAsync(20, () => rt.execute("c", { path: file }));
	const coldMs = await benchStepAsync(20, () => new ReadTool(mkSession()).execute("c", { path: file }));
	console.log(`  same-session repeat read: ${repeatMs.toFixed(3)}ms/call (memoized parse)`);
	console.log(`  fresh-session each read:  ${coldMs.toFixed(3)}ms/call (cold parse)`);
	fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}
