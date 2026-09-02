/**
 * Micro-benchmarks for native text primitives vs standard JS/Bun equivalents
 * using the mitata benchmarking framework.
 *
 * Run with: `bun packages/natives/bench/text.ts`
 *
 * Every bench body pipes its result through `do_not_optimize`. Without it JSC
 * dead-code-eliminates pure calls with discarded results after warmup, which
 * reports sub-nanosecond phantoms (e.g. string-width at ~180 ps/iter).
 */

import cliTruncate from "cli-truncate";
import * as diff from "diff";
import { countTokens as gptCountTokens } from "gpt-tokenizer/model/gpt-4o";
import { bench, do_not_optimize, run, summary } from "mitata";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
// The TS-side width measurer every TUI render path actually calls. Backed by
// Bun.stringWidth with a printable-ASCII fast path; the N-API `visibleWidth`
// below is only the raw binding (its ~150 ns floor is per-call FFI overhead:
// UTF-16 -> UTF-8 marshal + result box, not the width algorithm).
import { visibleWidth as tuiVisibleWidth } from "../../tui/src/utils";
import {
	countTokens,
	diffLines,
	extractSegments,
	highlightCode,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../native/index.js";

const testCases = {
	shortAscii: "const x = 42; // standard code snippet",
	longAscii:
		"This is a much longer line of text designed to test how measurement scales when lines are wider in terminal buffers. ".repeat(
			4,
		),
	ansiStyled:
		"\x1b[1m\x1b[38;2;100;200;255mfunction\x1b[0m \x1b[38;2;255;215;0mrenderTerminal\x1b[0m(\x1b[38;2;150;150;150mprops\x1b[0m: \x1b[38;2;80;250;123mTerminalProps\x1b[0m) {\x1b[38;2;98;114;164m // styled output\x1b[0m",
	emojiCjk: "⚡ Status: 🚀 Deploying to 東京 (Tokyo) cluster 🎯 [5/10 completed] 🌸",
	multilineAnsi: (
		"\x1b[32m✔ Loaded config successfully\x1b[0m\n" +
		"\x1b[34mℹ Connecting to server at 127.0.0.1:8080...\x1b[0m\n" +
		"\x1b[33m⚠ Warning: high memory usage detected in worker pool\x1b[0m\n" +
		"\x1b[31m✖ Error: failed to establish connection to database replica\x1b[0m\n" +
		"Stack trace: at ConnectionPool.acquire (/app/src/db.ts:142:18)\n"
	).repeat(3),
	diffOld:
		"import { a, b, c } from 'pkg';\n\nfunction main() {\n  console.log('hello');\n  const x = 1;\n  return x + 2;\n}\n",
	diffNew:
		"import { a, b, c, d } from 'pkg';\n\nfunction main() {\n  console.log('hello world');\n  const x = 2;\n  const y = 3;\n  return x + y;\n}\n",
	tokenArray: [
		"You are a helpful assistant with access to tools.",
		"User prompt: please inspect the code in src/index.ts and summarize findings.",
		"System message: running tool call 'read_file' with arguments {'path': 'src/index.ts'}.",
		"File content: export function run() { console.log('active'); }".repeat(5),
	],
	colors: {
		comment: "\x1b[38;2;98;114;164m",
		keyword: "\x1b[38;2;255;121;198m",
		function: "\x1b[38;2;80;250;123m",
		variable: "\x1b[38;2;248;248;242m",
		string: "\x1b[38;2;241;250;140m",
		number: "\x1b[38;2;189;147;249m",
		type: "\x1b[38;2;139;233;253m",
		operator: "\x1b[38;2;255;121;198m",
		punctuation: "\x1b[38;2;248;248;242m",
	},
};

// Each width bench cycles a pool of 64 distinct strings. This defeats
// constant-argument hoisting in pure comparators (`do_not_optimize` only
// protects the result) and mirrors a real redraw workload: a frame re-measures
// the same visible lines every paint, so pi-tui's bounded width memo hits —
// but the pool is far larger than any cache that merely fits the bench.
const WIDTH_VARIANT_COUNT = 64;

function makeWidthVariants(base: string): string[] {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const variants: string[] = new Array(WIDTH_VARIANT_COUNT);
	for (let i = 0; i < WIDTH_VARIANT_COUNT; i++) {
		variants[i] = `${base} ${String(i).padStart(2, "0")}`;
	}
	return variants;
}

const widthInputVariants = {
	shortAscii: makeWidthVariants(testCases.shortAscii),
	longAscii: makeWidthVariants(testCases.longAscii),
	ansiStyled: makeWidthVariants(testCases.ansiStyled),
	emojiCjk: makeWidthVariants(testCases.emojiCjk),
} as const;
let widthInputVariantIndex = 0;

function nextWidthInput(kind: keyof typeof widthInputVariants): string {
	return widthInputVariants[kind][widthInputVariantIndex++ & (WIDTH_VARIANT_COUNT - 1)];
}

// ============================================================================
// 1. visibleWidth: pi-tui hot path vs raw N-API binding vs Bun.stringWidth vs
//    string-width npm package
// ============================================================================

summary(() => {
	bench("visibleWidth: short ascii (pi-tui)", () => do_not_optimize(tuiVisibleWidth(nextWidthInput("shortAscii"))));
	bench("visibleWidth: short ascii (native N-API)", () =>
		do_not_optimize(visibleWidth(nextWidthInput("shortAscii"), 3)));
	bench("visibleWidth: short ascii (Bun.stringWidth)", () =>
		do_not_optimize(Bun.stringWidth(nextWidthInput("shortAscii"))));
	bench("visibleWidth: short ascii (string-width npm)", () =>
		do_not_optimize(stringWidth(nextWidthInput("shortAscii"))));
});

summary(() => {
	bench("visibleWidth: long ascii (pi-tui)", () => do_not_optimize(tuiVisibleWidth(nextWidthInput("longAscii"))));
	bench("visibleWidth: long ascii (native N-API)", () =>
		do_not_optimize(visibleWidth(nextWidthInput("longAscii"), 3)));
	bench("visibleWidth: long ascii (Bun.stringWidth)", () =>
		do_not_optimize(Bun.stringWidth(nextWidthInput("longAscii"))));
	bench("visibleWidth: long ascii (string-width npm)", () =>
		do_not_optimize(stringWidth(nextWidthInput("longAscii"))));
});

summary(() => {
	bench("visibleWidth: ansi styled (pi-tui)", () => do_not_optimize(tuiVisibleWidth(nextWidthInput("ansiStyled"))));
	bench("visibleWidth: ansi styled (native N-API)", () =>
		do_not_optimize(visibleWidth(nextWidthInput("ansiStyled"), 3)));
	bench("visibleWidth: ansi styled (Bun.stringWidth)", () =>
		do_not_optimize(Bun.stringWidth(nextWidthInput("ansiStyled"))));
	bench("visibleWidth: ansi styled (string-width npm)", () =>
		do_not_optimize(stringWidth(nextWidthInput("ansiStyled"))));
});

summary(() => {
	bench("visibleWidth: emoji / CJK (pi-tui)", () => do_not_optimize(tuiVisibleWidth(nextWidthInput("emojiCjk"))));
	bench("visibleWidth: emoji / CJK (native N-API)", () =>
		do_not_optimize(visibleWidth(nextWidthInput("emojiCjk"), 3)));
	bench("visibleWidth: emoji / CJK (Bun.stringWidth)", () =>
		do_not_optimize(Bun.stringWidth(nextWidthInput("emojiCjk"))));
	bench("visibleWidth: emoji / CJK (string-width npm)", () =>
		do_not_optimize(stringWidth(nextWidthInput("emojiCjk"))));
});

// ============================================================================
// 2. truncateToWidth: Native vs cli-truncate
// ============================================================================

summary(() => {
	bench("truncateToWidth: long ascii (native)", () =>
		do_not_optimize(truncateToWidth(testCases.longAscii, 40, 0, false, 3)));
	bench("truncateToWidth: long ascii (cli-truncate)", () => do_not_optimize(cliTruncate(testCases.longAscii, 40)));
});

summary(() => {
	bench("truncateToWidth: ansi styled (native)", () =>
		do_not_optimize(truncateToWidth(testCases.ansiStyled, 40, 0, false, 3)));
	bench("truncateToWidth: ansi styled (cli-truncate)", () => do_not_optimize(cliTruncate(testCases.ansiStyled, 40)));
});

bench("truncateToWidth: fits no-alloc (native)", () =>
	do_not_optimize(truncateToWidth(testCases.shortAscii, 100, 0, false, 3)));
bench("truncateToWidth: pads with spaces (native)", () =>
	do_not_optimize(truncateToWidth(testCases.shortAscii, 60, 0, true, 3)));

// ============================================================================
// 3. sliceWithWidth: Native vs slice-ansi
// ============================================================================

summary(() => {
	bench("sliceWithWidth: ascii slice (native)", () =>
		do_not_optimize(sliceWithWidth(testCases.shortAscii, 10, 20, false, 3)));
	bench("sliceWithWidth: ascii slice (slice-ansi)", () => do_not_optimize(sliceAnsi(testCases.shortAscii, 10, 30)));
});

summary(() => {
	bench("sliceWithWidth: ansi styled slice (native)", () =>
		do_not_optimize(sliceWithWidth(testCases.ansiStyled, 15, 30, false, 3)));
	bench("sliceWithWidth: ansi styled slice (slice-ansi)", () =>
		do_not_optimize(sliceAnsi(testCases.ansiStyled, 15, 45)));
});

// ============================================================================
// 4. wrapTextWithAnsi: Native vs wrap-ansi
// ============================================================================

summary(() => {
	bench("wrapTextWithAnsi: single line (native)", () =>
		do_not_optimize(wrapTextWithAnsi(testCases.ansiStyled, 30, 3)));
	bench("wrapTextWithAnsi: single line (wrap-ansi)", () =>
		do_not_optimize(wrapAnsi(testCases.ansiStyled, 30, { hard: true })));
});

summary(() => {
	bench("wrapTextWithAnsi: multiline logs (native)", () =>
		do_not_optimize(wrapTextWithAnsi(testCases.multilineAnsi, 60, 3)));
	bench("wrapTextWithAnsi: multiline logs (wrap-ansi)", () =>
		do_not_optimize(wrapAnsi(testCases.multilineAnsi, 60, { hard: true })));
});

// ============================================================================
// 5. diffLines: Native vs jsdiff (diff npm package)
// ============================================================================

summary(() => {
	bench("diffLines: source files (native)", () => do_not_optimize(diffLines(testCases.diffOld, testCases.diffNew)));
	bench("diffLines: source files (diff npm)", () =>
		do_not_optimize(diff.diffLines(testCases.diffOld, testCases.diffNew)));
});

// ============================================================================
// 6. countTokens: Native (o200k_base) vs gpt-tokenizer (pure JS)
// ============================================================================

summary(() => {
	bench("countTokens: single string (native)", () => do_not_optimize(countTokens(testCases.longAscii)));
	bench("countTokens: single string (gpt-tokenizer)", () => do_not_optimize(gptCountTokens(testCases.longAscii)));
});

summary(() => {
	bench("countTokens: array of strings (native)", () => do_not_optimize(countTokens(testCases.tokenArray)));
	bench("countTokens: array of strings (gpt-tokenizer)", () => {
		let total = 0;
		for (const s of testCases.tokenArray) total += gptCountTokens(s);
		do_not_optimize(total);
	});
});

// ============================================================================
// 7. Specialized native primitives (standalone)
// ============================================================================

bench("extractSegments: ansi overlay (native)", () =>
	do_not_optimize(extractSegments(testCases.ansiStyled, 15, 25, 20, false, 3)));

bench("highlightCode: rust snippet (native)", () =>
	do_not_optimize(highlightCode('fn main() { println!("hello"); }', "rust", testCases.colors)));

await run();
