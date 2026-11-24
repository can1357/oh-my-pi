/**
 * Corpus parity: rows of the `text` (word-wrapped) and `truncated-text`
 * primitives are reproduced from their inputs with `wrap` / `truncate`.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { padTo, replaceTabs, spaces, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";

interface Fixture {
	widths: number[];
	inputs: { text: string; paddingX?: number; paddingY?: number };
	stages: { rows: Record<string, string[]> }[];
}

const CORPUS = path.join(import.meta.dir, "../corpus/primitives");
const ACCENT = "\x1b[38;2;254;188;56m";

async function fixture(screen: string, name: string): Promise<Fixture> {
	return (await Bun.file(path.join(CORPUS, screen, `${name}.dark.json`)).json()) as Fixture;
}

/** The text the capture styled with theme helpers (its `inputs.text` describes the call). */
const STYLED: Readonly<Record<string, string>> = {
	"ansi-styled-wraps": `${ACCENT}accent words that span\x1b[39m a wrap \x1b[1mbold tail\x1b[22m plain`,
	"ansi-styled-truncated": `${ACCENT}The quick brown fox jumps over the lazy dog while the build pipeline compiles every package and reports progress line by line.\x1b[39m`,
};

describe("wrapped text rows", () => {
	for (const name of [
		"long-wraps",
		"long-wraps-padded",
		"unbreakable-long-word",
		"tabs-and-newlines",
		"unicode-wide-chars",
		"ansi-styled-wraps",
		"short-default-padding",
		"short-no-padding",
		"whitespace-only",
		"empty",
	]) {
		it(name, async () => {
			const { widths, inputs, stages } = await fixture("text", name);
			const text = STYLED[name] ?? inputs.text;
			const px = inputs.paddingX ?? 0;
			const py = inputs.paddingY ?? 0;
			for (const width of widths) {
				const lines = text.trim() === "" ? [] : wrap(replaceTabs(text), width - 2 * px);
				const blank = Array<string>(lines.length > 0 ? py : 0).fill(spaces(width));
				const rows = [...blank, ...lines.map(line => padTo(`${spaces(px)}${line}`, width)), ...blank];
				expect(rows).toEqual(stages[0]!.rows[String(width)]!);
			}
		});
	}
});

describe("truncated text rows", () => {
	for (const name of [
		"long-truncated",
		"unicode-wide-truncated",
		"tabs",
		"ansi-styled-truncated",
		"short-fits",
		"multiline-keeps-first-line",
		"padded",
		"empty",
	]) {
		it(name, async () => {
			const { widths, inputs, stages } = await fixture("truncated-text", name);
			const line = (STYLED[name] ?? inputs.text).split("\n")[0]!;
			const px = inputs.paddingX ?? 0;
			const py = inputs.paddingY ?? 0;
			for (const width of widths) {
				const row = px > 0 ? padTo(`${spaces(px)}${truncate(line, width - 2 * px)}`, width) : truncate(line, width);
				const blank = Array<string>(py).fill(spaces(width));
				expect([...blank, row, ...blank]).toEqual(stages[0]!.rows[String(width)]!);
			}
		});
	}
});
