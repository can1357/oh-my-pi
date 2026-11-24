/**
 * Markdown → tokens: GFM via the shared marked lexer plus omp's dialect —
 * LaTeX math (inline `$…$`/`\(…\)`, own-line `$$`/`\[` blocks, bare math
 * environments), rules drawn with any box/dash character, strict `~~`
 * strikethrough and autolinks only at a word boundary.
 */
import {
	Lexer,
	Marked,
	type Token,
	type TokenizerAndRendererExtension,
	type TokenizerThis,
	type Tokens,
	type TokensList,
} from "@oh-my-pi/pi-utils/marked";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { mathBlockInContext, mathSpanInContext, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";

/** A math span or block. */
export interface MathToken {
	readonly type: "math";
	readonly raw: string;
	readonly text: string;
	readonly display: boolean;
}

/** A horizontal rule, remembering the character it was drawn with. */
export interface RuleToken {
	readonly type: "hr";
	readonly raw: string;
	readonly char: string;
}

export type { Token, Tokens, TokensList };

const RULE = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

const ruleExtension: TokenizerAndRendererExtension = {
	name: "omp-rule",
	level: "block",
	tokenizer(src) {
		const match = RULE.exec(src);
		return match ? { type: "hr", raw: match[0], char: match[1] } : undefined;
	},
};

const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "omp-math-block",
	level: "block",
	tokenizer(src) {
		const block = mathBlockInContext(this, src);
		return block ? { type: "math", raw: block.raw, text: block.body, display: true } : undefined;
	},
};

/** LaTeX environments that are math on their own, without `$$` fences. */
const MATH_ENVIRONMENTS: Readonly<Record<string, true>> = {
	equation: true,
	"equation*": true,
	align: true,
	"align*": true,
	aligned: true,
	alignat: true,
	"alignat*": true,
	gather: true,
	"gather*": true,
	gathered: true,
	multline: true,
	"multline*": true,
	split: true,
	flalign: true,
	"flalign*": true,
	cases: true,
	matrix: true,
	pmatrix: true,
	bmatrix: true,
	Bmatrix: true,
	vmatrix: true,
	Vmatrix: true,
	smallmatrix: true,
	array: true,
	eqnarray: true,
	"eqnarray*": true,
	displaymath: true,
	math: true,
};

const ENV_BEGIN = /^(?:([^\n]*[=([{][ \t]*)\n)?[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;

/**
 * A bare math environment at the start of a block: `\begin{env}…\end{env}`
 * with no blank line inside, optionally after one `lhs =` line.
 */
const mathEnvironmentExtension: TokenizerAndRendererExtension = {
	name: "omp-math-env",
	level: "block",
	tokenizer(src) {
		const match = ENV_BEGIN.exec(src);
		if (!match || !MATH_ENVIRONMENTS[match[2]!]) return undefined;
		const close = `\\end{${match[2]}}`;
		const closeAt = src.indexOf(close, match[0].length);
		if (closeAt === -1 || /\n[ \t]*\n/.test(src.slice(0, closeAt))) return undefined;
		let end = closeAt + close.length;
		while (src[end] === " " || src[end] === "\t") end++;
		if (src[end] === "\n") end++;
		const raw = src.slice(0, end);
		return { type: "math", raw, text: raw.replace(/\n[ \t]*$/, ""), display: true };
	},
};

const mathExtension: TokenizerAndRendererExtension = {
	name: "omp-math",
	level: "inline",
	startFrom: mathStartIndex,
	tokenizer(src) {
		const span = mathSpanInContext(this, src);
		return span ? { type: "math", raw: src.slice(0, span.end), text: span.body, display: span.display } : undefined;
	},
};

const AUTOLINK_SCHEME = /^(?:www\.|https?:\/\/|ftp:\/\/)/i;
const AUTOLINK_BOUNDARY = /[\s*_~(]/;

/** GFM autolinks start only at a boundary: a scheme glued to a word or path stays text. */
const boundedAutolinkExtension: TokenizerAndRendererExtension = {
	name: "omp-autolink-boundary",
	level: "inline",
	tokenizer(src, tokens) {
		const match = AUTOLINK_SCHEME.exec(src);
		if (!match) return undefined;
		const previous = tokens.at(-1)?.raw?.at(-1);
		if (previous === undefined || AUTOLINK_BOUNDARY.test(previous)) return undefined;
		return { type: "text", raw: match[0], text: match[0] };
	},
};

/** `~~text~~` with no space inside either delimiter; a single `~` is text. */
function strikeClose(source: string, open: number, end: number): number {
	if (/\s|~/.test(source[open + 2] ?? " ")) return -1;
	for (let at = source.indexOf("~~", open + 3); at !== -1 && at + 2 <= end; at = source.indexOf("~~", at + 1)) {
		if (source[at - 1] === "\\" || /\s/.test(source[at - 1] ?? " ")) continue;
		if (source[at + 2] === "~") continue;
		return at;
	}
	return -1;
}

const strikeExtension: TokenizerAndRendererExtension = {
	name: "omp-strike",
	level: "inline",
	tokenizer(this: TokenizerThis, src) {
		if (!src.startsWith("~~")) return undefined;
		const source = this.source ?? src;
		const end = this.end ?? source.length;
		const open = end - src.length;
		const close = strikeClose(source, open, end);
		if (close === -1) return undefined;
		const text = source.slice(open + 2, close);
		return { type: "del", raw: source.slice(open, close + 2), text, tokens: this.lexer.inlineTokens(text) };
	},
};

const parser = new Marked();
parser.use({
	extensions: [
		ruleExtension,
		mathBlockExtension,
		mathEnvironmentExtension,
		mathExtension,
		boundedAutolinkExtension,
		strikeExtension,
	],
});
parser.use({ tokenizer: { del: () => undefined } });

/** Lex a document. */
export function lexMarkdown(source: string): TokensList {
	return parser.lexer(source);
}

/**
 * Lex top-level blocks one at a time, each resolving reference links only
 * against the definitions before it (and its own): a block's tokens never
 * change when a definition arrives later. Streaming documents lex this way so
 * rows already in terminal history keep their look. Returns the tokens of the
 * blocks from `from` on (the ones before only define).
 */
export function lexWithPriorDefinitions(blocks: readonly Token[], from = 0): { tokens: Token[]; keys: string[] } {
	const tokens: Token[] = [];
	/** Per token: the definitions it resolved against, as a cache key part ("" for none). */
	const keys: string[] = [];
	let links: TokensList["links"] = Object.create(null);
	let key = "";
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!;
		// Without a `[` a block holds no reference and defines nothing: its tokens are the same under any definitions.
		if (!block.raw.includes("[")) {
			if (index >= from) {
				tokens.push(block);
				keys.push(key);
			}
			continue;
		}
		const cacheKey = `${key}\0${block.raw}`;
		let entry = priorLexed.get(cacheKey);
		if (!entry) {
			const lexed = [] as unknown as TokensList;
			lexed.links = Object.assign(Object.create(null), links);
			const lexer = new Lexer(parser.defaults);
			lexer.tokens = lexed;
			lexer.blockTokens(block.raw, lexed);
			for (const queued of lexer.inlineQueue) lexer.inlineTokens(queued.src, queued.tokens);
			let next = "";
			for (const _ in lexed.links) {
				next = JSON.stringify(lexed.links);
				break;
			}
			entry = { tokens: [...lexed], links: lexed.links, key: next };
			priorLexed.set(cacheKey, entry);
		}
		if (index >= from) {
			for (const token of entry.tokens) {
				tokens.push(token);
				keys.push(key);
			}
		}
		links = entry.links;
		key = entry.key;
	}
	return { tokens, keys };
}

/** Blocks lexed against the definitions before them, by those definitions and the block's source. */
const priorLexed = new LRUCache<string, { tokens: Token[]; links: TokensList["links"]; key: string }>({ max: 1024 });

/** Lex inline Markdown (an HTML block's content, a cell's text). */
export function lexInline(source: string): Token[] {
	return new Lexer(parser.defaults).inlineTokens(source);
}
