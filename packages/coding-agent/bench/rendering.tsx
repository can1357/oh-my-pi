/** @jsxImportSource @oh-my-pi/pi-tui */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRoot, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Settings } from "../src/config/settings";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	nextStep,
	visibleUnits,
} from "../src/modes/controllers/streaming-reveal";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";
import { Composer } from "../src/ui/composer/composer";
import { AssistantMessageBlock } from "../src/ui/transcript/messages/assistant-message";
import { Welcome } from "../src/ui/welcome/welcome";

// Frame cost against transcript length (the former E3 section) lives in
// bench/transcript-compose.bench.tsx, on the real terminal backend.

const ITERATIONS = 500;
const WIDTH = 100;
const theme = loadThemeSync("dark");

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

/** A streaming assistant block and its painter: `step` publishes a message and paints it at WIDTH. */
function assistantPainter(): { step: (message: AssistantMessage) => void; dispose: () => void } {
	return createRoot(dispose => {
		const message = signal<AssistantMessage | undefined>(undefined);
		const node = (
			<col>
				{AssistantMessageBlock({ model: { message, transient: signal(true), expandThinking: signal(true) } })}
			</col>
		) as UiNode;
		const env = staticEnvironment(theme, { now: 0 });
		return {
			step: next => {
				message.set(next);
				paintNode(env, node, WIDTH);
			},
			dispose,
		};
	});
}

await Settings.init({ inMemory: true });

console.log(`Rendering benchmark (${ITERATIONS} iterations)\n`);

// Welcome card, painted cold each time (a fresh environment drops the paint cache).
createRoot(dispose => {
	const welcome = (
		<col>
			{Welcome({
				version: () => "8.12.3",
				update: () => null,
				tip: () => undefined,
				keys: () => ({}),
				introStart: () => null,
			})}
		</col>
	) as UiNode;
	bench("Welcome paint", () => {
		paintNode(staticEnvironment(theme, { now: 0 }), welcome, WIDTH);
	});
	dispose();
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
// buildDisplayMessage is O(delta)/tick. The Markdown render (the block paint)
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
		const painter = assistantPainter();
		const start = Bun.nanoseconds();
		let revealed = 0;
		let steps = 0;
		while (revealed < total) {
			revealed = Math.min(total, revealed + nextStep(total - revealed));
			painter.step(buildDisplayMessage(full, revealed, false, true, countOf, sliceOf));
			steps++;
		}
		const ms = (Bun.nanoseconds() - start) / 1e6;
		painter.dispose();
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
		const painter = assistantPainter();
		const start = Bun.nanoseconds();
		let revealed = 0;
		let steps = 0;
		while (revealed < total) {
			revealed = Math.min(total, revealed + nextStep(total - revealed));
			painter.step(buildDisplayMessage(full, revealed, false, true, countOf, sliceOf));
			steps++;
		}
		const ms = (Bun.nanoseconds() - start) / 1e6;
		painter.dispose();
		console.log(
			`  text=${n} (+2500 thinking): ${ms.toFixed(2)}ms total over ${steps} steps (${(ms / steps).toFixed(4)}ms/step)`,
		);
	}
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}

console.log("\neditorKeystroke (C3: composer frame with no mutation vs keystroke):");
try {
	const buffer = Array.from({ length: 50 })
		.map((_, i) => `Line ${i + 1}: some editor content with words to wrap at width ${WIDTH} and more text here`)
		.join("\n");
	const composer = new Composer({ text: buffer });
	const term = createTestTerminal(() => ({ dock: composer.node }), { columns: WIDTH, rows: 80, theme });
	term.focus(composer.field);
	const noMutMs = benchStep(200, () => {
		term.render();
	});
	console.log(`  no-mutation frame: ${noMutMs.toFixed(4)}ms/frame`);
	const editMs = benchStep(200, () => {
		term.press("x");
	});
	console.log(`  keystroke + frame: ${editMs.toFixed(4)}ms/op`);
	term.dispose();
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
			allocateOutputArtifact: async () => ({ id: "a", path: path.join(dir, "a.log") }),
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
