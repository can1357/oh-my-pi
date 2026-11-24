/**
 * Corpus parity: the Markdown samples, the streaming sample and the Markdown
 * blocks of assistant messages render the rows today's UI shows, compared as
 * rendered cells (text, colors, attributes, link targets).
 */
import { describe, expect, it } from "bun:test";
import { cellGrid, firstCellDiff, plainRows } from "../../src/testing/cells";
import { type CorpusCase, listCases, loadCase, stageNative } from "../../src/testing/corpus";
import { type MarkdownOptions, renderMarkdown } from "../../src/text/markdown";
import { loadThemeSync } from "../../src/theme";

interface SampleInputs {
	readonly text: string;
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly hyperlinks?: boolean;
	readonly mermaid?: boolean;
	readonly defaultTextStyle?: unknown;
	readonly prefixes?: readonly string[];
}

/**
 * Cases captured after the capture script switched colorful Markdown off. It
 * is on by default: the `colorful: false` input of the default cases is
 * mislabeled.
 */
const PLAIN_CASES: Readonly<Record<string, true>> = {
	"default text style muted italic": true,
	"hyperlinks on": true,
	"mermaid off": true,
	"growing prefixes": true,
};

function sampleOptions(corpusCase: CorpusCase): MarkdownOptions {
	const inputs = corpusCase.inputs as SampleInputs;
	return {
		theme: loadThemeSync(corpusCase.theme),
		paddingX: inputs.paddingX ?? 1,
		paddingY: inputs.paddingY ?? 0,
		colorful: !PLAIN_CASES[corpusCase.case],
		hyperlinks: inputs.hyperlinks === true,
		mermaid: inputs.mermaid !== false,
		textStyle: inputs.defaultTextStyle ? "muted em" : undefined,
	};
}

function expectRows(actual: readonly string[], expected: readonly string[]): void {
	expect(plainRows(actual)).toEqual(plainRows(expected));
	expect(firstCellDiff(expected, actual)).toBeNull();
}

const samples = (await listCases("markdown/*")).filter(file => !file.startsWith("markdown/streaming/"));

describe("markdown samples", () => {
	for (const file of samples) {
		describe(file, async () => {
			const corpusCase = await loadCase(file);
			const inputs = corpusCase.inputs as SampleInputs;
			const options = sampleOptions(corpusCase);
			const stage = corpusCase.stages[0]!;
			for (const width in stage.rows) {
				const expected = stage.rows[width]!;
				it(`width ${width}`, () => expectRows(renderMarkdown(inputs.text, Number(width), options), expected));
			}
		});
	}
});

describe("markdown streaming sample", async () => {
	const corpusCase = await loadCase("markdown/streaming/growing-prefixes.dark");
	const prefixes = (corpusCase.inputs as SampleInputs).prefixes!;
	const options = sampleOptions(corpusCase);
	corpusCase.stages.forEach((stage, index) => {
		// Stage 0 is the empty node; one stage per prefix; the last stage ends the stream.
		const done = index === corpusCase.stages.length - 1;
		const text = index === 0 ? "" : (prefixes[index - 1] ?? prefixes.at(-1)!);
		for (const width in stage.rows) {
			const expected = stage.rows[width]!;
			it(`${stage.label} width ${width}`, () =>
				expectRows(renderMarkdown(text, Number(width), { ...options, stream: !done }), expected));
		}
	});
});

interface NativeNode {
	readonly k: string;
	readonly p?: {
		readonly text?: string;
		readonly stream?: boolean;
		readonly role?: string;
		readonly collapsed?: boolean;
	};
	readonly c?: readonly NativeNode[];
}

interface MarkdownBlock {
	readonly text: string;
	readonly stream: boolean;
	readonly thinking: boolean;
}

/** The `md` nodes a transcript draws, in order (collapsed sections draw none). */
function markdownBlocks(node: NativeNode, thinking = false, out: MarkdownBlock[] = []): MarkdownBlock[] {
	if (node.k === "md") out.push({ text: node.p?.text ?? "", stream: node.p?.stream === true, thinking });
	const inThinking = thinking || node.p?.role === "omp.thinking";
	for (const child of node.c ?? []) markdownBlocks(child, inThinking, out);
	return out;
}

/** Where `block` occurs as consecutive rows of `rows` at or after `from`, compared as cells; -1 when nowhere. */
function findRows(rows: readonly string[], block: readonly string[], from: number): number {
	const haystack = cellGrid(rows).map(row => JSON.stringify(row));
	const needle = cellGrid(block).map(row => JSON.stringify(row));
	for (let at = from; at + needle.length <= haystack.length; at++) {
		if (needle.every((row, i) => row === haystack[at + i])) return at;
	}
	return -1;
}

/**
 * Transcript screens resolve relative link targets into the node's text but
 * keep showing the written href; that rewrite belongs to the screen.
 */
const SCREEN_OWNED: Readonly<Record<string, true>> = {
	"relative link with resolved target|link targets resolved": true,
	// Thinking hidden: the section draws a placeholder instead of its body.
	"streaming with thinking hidden|streaming 10%": true,
	"streaming with thinking hidden|streaming 30%": true,
	"streaming with thinking hidden|streaming 55%": true,
	"streaming with thinking hidden|streaming 80%": true,
	"streaming with thinking hidden|streaming 100%": true,
	"streaming with thinking hidden|final message": true,
	"streaming with thinking hidden|finalized": true,
};

describe("assistant message markdown", async () => {
	const theme = loadThemeSync("dark");
	for (const file of await listCases("transcript/assistant-message", "dark")) {
		const corpusCase = await loadCase(file);
		corpusCase.stages.forEach((stage, index) => {
			const blocks = markdownBlocks(stageNative(corpusCase, index) as NativeNode);
			if (blocks.length === 0) return;
			const skip = SCREEN_OWNED[`${corpusCase.case}|${stage.label}`] === true;
			for (const width in stage.rows) {
				const expected = stage.rows[width]!;
				it.skipIf(skip)(`${corpusCase.case} / ${stage.label} width ${width}`, () => {
					let from = 0;
					for (const block of blocks) {
						// Transcripts pad prose by one cell and draw code bodies literally at column 0.
						const rows = renderMarkdown(block.text, Number(width), {
							theme,
							paddingX: 1,
							codeIndent: 0,
							stream: block.stream,
							textStyle: block.thinking ? "muted em" : undefined,
						});
						if (rows.length === 0) continue;
						const at = findRows(expected, rows, from);
						if (at === -1) expect(firstCellDiff(expected.slice(from, from + rows.length), rows)).toBeNull();
						expect(at).toBeGreaterThanOrEqual(from);
						from = at + rows.length;
					}
				});
			}
		});
	}
});
