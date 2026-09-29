import { Marked, type Token, type TokenizerAndRendererExtension } from "@oh-my-pi/pi-utils/marked";
import { mathBlockAt, mathSpanAt, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import { isBareMathEnvironment } from "../latex-to-unicode";

export interface LatexSpan {
	tex: string;
	display: boolean;
}

const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;

function bareMathEnvBlock(source: string): readonly [number, number] | null {
	const match = BARE_ENV_BEGIN.exec(source);
	if (!match || !isBareMathEnvironment(match[1])) return null;
	const beginLineStart = match.index === 0 ? 0 : match.index + 1;
	const endToken = `\\end{${match[1]}}`;
	const endAt = source.indexOf(endToken, match.index);
	if (endAt === -1 || /\n[ \t]*\n/.test(source.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (source[blockEnd] === " " || source[blockEnd] === "\t") blockEnd++;
	if (source[blockEnd] === "\n") blockEnd++;
	let start = beginLineStart;
	if (start > 0 && source[start - 1] === "\n") {
		const previousStart = source.lastIndexOf("\n", start - 2) + 1;
		if (/[=([{]\s*$/.test(source.slice(previousStart, start - 1))) start = previousStart;
	}
	return [start, blockEnd];
}

const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start: mathStartIndex,
	tokenizer(source) {
		const span = mathSpanAt(source, 0);
		if (!span || span.body.includes("`")) return undefined;
		return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
	},
};

const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	tokenizer(source) {
		const block = mathBlockAt(source);
		if (!block) return undefined;
		return { type: "math", raw: block.raw, text: block.body, display: true };
	},
};

const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(source) {
		return bareMathEnvBlock(source)?.[0];
	},
	tokenizer(source) {
		const range = bareMathEnvBlock(source);
		if (range?.[0] !== 0) return undefined;
		const raw = source.slice(0, range[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		return text.trim() ? { type: "math", raw, text, display: true } : undefined;
	},
};

const parser = new Marked({ gfm: true, breaks: false });
parser.use({ extensions: [mathBlockExtension, mathEnvBlockExtension, mathExtension] });

function collect(tokens: readonly Token[], spans: LatexSpan[]): void {
	for (const token of tokens) {
		if ((token as { type: string }).type === "math") {
			const math = token as Token & { text?: unknown; display?: unknown };
			if (typeof math.text === "string" && typeof math.display === "boolean") {
				spans.push({ tex: math.text, display: math.display });
			}
			continue;
		}
		if ("tokens" in token && Array.isArray(token.tokens)) collect(token.tokens as Token[], spans);
		if (token.type === "list") {
			for (const item of token.items) collect(item.tokens, spans);
		}
		if (token.type === "table") {
			for (const cell of token.header) collect(cell.tokens, spans);
			for (const row of token.rows) for (const cell of row) collect(cell.tokens, spans);
		}
	}
}

/** Extract displayable LaTeX while honoring Markdown code spans and fences. */
export function latexSpans(markdown: string): LatexSpan[] {
	const spans: LatexSpan[] = [];
	collect(parser.lexer(markdown), spans);
	return spans;
}
