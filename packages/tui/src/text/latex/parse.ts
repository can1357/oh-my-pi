/**
 * LaTeX math parsed into a small tree both renderers (one-line unicode and
 * the 2-D block layout) walk. Whitespace runs become one space and are kept:
 * the renderers reproduce the author's spacing rather than TeX's.
 */
import { BIG_OPERATORS, FUNCTIONS, INTEGRALS, LIMIT_FUNCTIONS, SYMBOLS } from "./symbols";

/** Attribute and color changes a style command makes (`false` cancels an enclosing attribute). */
export interface StyleChange {
	readonly bold?: boolean;
	readonly italic?: boolean;
	/** Foreground color as a CSS/xcolor expression, with its model (`HTML`, `RGB`, `rgb`, `gray`). */
	readonly fg?: ColorSpec;
	readonly bg?: ColorSpec;
}

export interface ColorSpec {
	readonly model: string | undefined;
	readonly value: string;
}

export type FontName = "bb" | "cal" | "frak" | "scr" | "bold" | "italic" | "plain";

export type MathNode =
	| { readonly k: "text"; readonly t: string }
	| { readonly k: "group"; readonly c: MathNode[] }
	| { readonly k: "style"; readonly style: StyleChange; readonly c: MathNode[] }
	| { readonly k: "font"; readonly font: FontName; readonly c: MathNode[] }
	| { readonly k: "frac"; readonly num: MathNode[]; readonly den: MathNode[]; readonly bar: boolean }
	| { readonly k: "sqrt"; readonly index: MathNode[] | undefined; readonly c: MathNode[] }
	/** A big operator or limit-taking function; `limits` stacks its scripts in display math. */
	| { readonly k: "op"; readonly t: string; limits: boolean }
	| ScriptsNode
	| { readonly k: "accent"; readonly mark: string; readonly each: boolean; readonly c: MathNode[] }
	| { readonly k: "delim"; readonly left: string; readonly right: string; readonly c: MathNode[] }
	| { readonly k: "middle"; readonly t: string }
	/** `\overbrace` / `\underbrace`; a label is its script. */
	| { readonly k: "brace"; readonly over: boolean; readonly c: MathNode[] }
	| EnvNode
	| { readonly k: "wrap"; readonly open: string; readonly close: string; readonly c: MathNode[] }
	| { readonly k: "xarrow"; readonly t: string; readonly above: MathNode[]; readonly below: MathNode[] | undefined };

export interface ScriptsNode {
	readonly k: "scripts";
	readonly base: MathNode | undefined;
	sub: MathNode[] | undefined;
	sup: MathNode[] | undefined;
	/** Which script the source gave first (one-line output keeps that order). */
	readonly first: "sub" | "sup";
	/** Stacked over/under the base in display math (`\overset`, `\underset`). */
	readonly stack: boolean;
}

export interface EnvNode {
	readonly k: "env";
	readonly name: string;
	readonly rows: MathNode[][][];
	/** `array` column specification (`lcr`). */
	readonly spec: string | undefined;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

type Token =
	| { readonly kind: "cmd"; readonly name: string; readonly start: number; readonly end: number }
	| {
			readonly kind: "char";
			readonly ch: string;
			readonly start: number;
			readonly end: number;
			/** A whitespace run that spans a line break. */
			readonly newline?: boolean;
	  };

function tokenize(source: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		if (ch === "%") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (/\s/.test(ch)) {
			const start = i;
			while (i < source.length && /\s/.test(source[i]!)) i++;
			out.push({ kind: "char", ch: " ", start, end: i, newline: source.slice(start, i).includes("\n") });
			continue;
		}
		if (ch === "\\") {
			const start = i;
			i++;
			if (i >= source.length) {
				out.push({ kind: "char", ch: "\\", start, end: i });
				break;
			}
			if (/[A-Za-z]/.test(source[i]!)) {
				while (i < source.length && /[A-Za-z]/.test(source[i]!)) i++;
				// A starred environment-like command keeps its star (`\operatorname*`).
				if (source[i] === "*" && source.slice(start + 1, i) === "operatorname") i++;
			} else {
				i++;
			}
			out.push({ kind: "cmd", name: source.slice(start + 1, i), start, end: i });
			continue;
		}
		const code = source.codePointAt(i)!;
		const char = String.fromCodePoint(code);
		out.push({ kind: "char", ch: char, start: i, end: i + char.length });
		i += char.length;
	}
	return out;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

interface Stops {
	/** Inside an environment: `&`, `\\` and `\end` end a cell. */
	readonly env?: boolean;
	/** Inside `\left … \right`. */
	readonly left?: boolean;
	/** Inside an optional `[…]` argument. */
	readonly bracket?: boolean;
	/** At the top level of display math: `\\` and a line break end a row. */
	readonly row?: boolean;
}

const ACCENTS: Readonly<Record<string, readonly [string, boolean]>> = {
	hat: ["\u0302", false],
	widehat: ["\u0302", false],
	check: ["\u030c", false],
	tilde: ["\u0303", false],
	widetilde: ["\u0303", false],
	bar: ["\u0304", false],
	overline: ["\u0305", true],
	underline: ["\u0332", true],
	vec: ["\u20d7", false],
	overrightarrow: ["\u20d7", false],
	overleftarrow: ["\u20d6", false],
	dot: ["\u0307", false],
	ddot: ["\u0308", false],
	dddot: ["\u20db", false],
	acute: ["\u0301", false],
	grave: ["\u0300", false],
	breve: ["\u0306", false],
	mathring: ["\u030a", false],
};

const FONTS: Readonly<Record<string, FontName>> = {
	mathbb: "bb",
	Bbb: "bb",
	mathcal: "cal",
	mathscr: "scr",
	mathfrak: "frak",
	mathbf: "bold",
	boldsymbol: "bold",
	bm: "bold",
	pmb: "bold",
	mathit: "italic",
	mathrm: "plain",
	mathsf: "plain",
	mathtt: "plain",
	text: "plain",
	textrm: "plain",
	texttt: "plain",
	textsf: "plain",
	textnormal: "plain",
	mbox: "plain",
	hbox: "plain",
	operatorname: "plain",
	"operatorname*": "plain",
};

const STYLES: Readonly<Record<string, StyleChange>> = {
	textbf: { bold: true },
	textit: { italic: true },
	textsl: { italic: true },
	emph: { italic: true },
	textmd: { bold: false },
	textup: { italic: false },
	textnormal: { bold: false, italic: false },
};

/** `\left`/`\big` delimiter tokens by command name. */
const DELIMITER_COMMANDS: Readonly<Record<string, string>> = {
	"{": "{",
	"}": "}",
	"|": "‖",
	langle: "⟨",
	rangle: "⟩",
	lfloor: "⌊",
	rfloor: "⌋",
	lceil: "⌈",
	rceil: "⌉",
	vert: "|",
	lvert: "|",
	rvert: "|",
	Vert: "‖",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	uparrow: "↑",
	downarrow: "↓",
};

const SIZE_COMMANDS: Readonly<Record<string, true>> = {
	big: true,
	Big: true,
	bigg: true,
	Bigg: true,
	bigl: true,
	bigr: true,
	Bigl: true,
	Bigr: true,
	biggl: true,
	biggr: true,
	Biggl: true,
	Biggr: true,
	bigm: true,
	Bigm: true,
};

const IGNORED: Readonly<Record<string, true>> = {
	displaystyle: true,
	textstyle: true,
	scriptstyle: true,
	scriptscriptstyle: true,
	nonumber: true,
	notag: true,
	hline: true,
	"left.": true,
	"right.": true,
	limits: true,
	nolimits: true,
	allowbreak: true,
	"middle.": true,
	centering: true,
	rm: true,
	it: true,
	bf: true,
	cal: true,
	mathstrut: true,
	strut: true,
};

const SPACES: Readonly<Record<string, string>> = {
	",": " ",
	":": " ",
	";": " ",
	">": " ",
	" ": " ",
	"!": "",
	quad: "  ",
	qquad: "    ",
	enspace: " ",
	thinspace: " ",
	medspace: " ",
	thickspace: " ",
	negthinspace: "",
};

const ARROWS: Readonly<Record<string, string>> = {
	xrightarrow: "→",
	xleftarrow: "←",
	xRightarrow: "⇒",
	xLeftarrow: "⇐",
	xleftrightarrow: "↔",
	xLeftrightarrow: "⇔",
	xmapsto: "↦",
	xhookrightarrow: "↪",
	xhookleftarrow: "↩",
};

const NEGATED: Readonly<Record<string, string>> = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≤": "≰",
	"≥": "≱",
	"≡": "≢",
	"∼": "≁",
	"≈": "≉",
	"≃": "≄",
	"≅": "≇",
	"∣": "∤",
	"∥": "∦",
	"∃": "∄",
};

class Parser {
	readonly #source: string;
	readonly #tokens: Token[];
	#at = 0;

	constructor(source: string) {
		this.#source = source;
		this.#tokens = tokenize(source);
	}

	parse(): MathNode[] {
		const nodes: MathNode[] = [];
		while (this.#at < this.#tokens.length) {
			nodes.push(...this.#sequence({}));
			// A stray closer at top level is kept as text.
			const token = this.#tokens[this.#at];
			if (token === undefined) break;
			this.#at++;
			nodes.push({ k: "text", t: token.kind === "char" ? token.ch : `\\${token.name}` });
		}
		return nodes;
	}

	parseRows(): MathNode[][] {
		const rows: MathNode[][] = [];
		let row: MathNode[] = [];
		while (this.#at < this.#tokens.length) {
			row.push(...this.#sequence({ row: true }));
			const token = this.#tokens[this.#at];
			if (token === undefined) break;
			this.#at++;
			if ((token.kind === "char" && token.newline === true) || (token.kind === "cmd" && token.name === "\\")) {
				if (token.kind === "cmd") this.#rawOptional();
				rows.push(row);
				row = [];
				continue;
			}
			row.push({ k: "text", t: token.kind === "char" ? token.ch : `\\${token.name}` });
		}
		rows.push(row);
		return rows;
	}

	#peek(): Token | undefined {
		return this.#tokens[this.#at];
	}

	#isChar(ch: string): boolean {
		const token = this.#tokens[this.#at];
		return token?.kind === "char" && token.ch === ch;
	}

	#isStop(token: Token, stops: Stops): boolean {
		if (token.kind === "char") {
			if (token.ch === "}") return true;
			if (stops.row && token.newline === true) return true;
			if (stops.env && token.ch === "&") return true;
			if (stops.bracket && token.ch === "]") return true;
			return false;
		}
		if (stops.row && token.name === "\\") return true;
		if (stops.env && (token.name === "\\" || token.name === "end" || token.name === "cr")) return true;
		if (stops.left && token.name === "right") return true;
		return false;
	}

	/** Nodes up to (not including) a stop token, `}` or the end. */
	#sequence(stops: Stops): MathNode[] {
		const nodes: MathNode[] = [];
		let depth = 0;
		for (let token = this.#peek(); token !== undefined; token = this.#peek()) {
			if (stops.bracket && token.kind === "char" && token.ch === "[") depth++;
			if (stops.bracket && token.kind === "char" && token.ch === "]" && depth > 0) {
				depth--;
				this.#at++;
				nodes.push({ k: "text", t: "]" });
				continue;
			}
			if (this.#isStop(token, stops)) break;
			if (token.kind === "char" && (token.ch === "^" || token.ch === "_")) {
				this.#at++;
				this.#attachScript(nodes, token.ch === "^" ? "sup" : "sub", this.#argument());
				continue;
			}
			if (token.kind === "char" && token.ch === "'") {
				this.#at++;
				let primes = "′";
				while (this.#isChar("'")) {
					this.#at++;
					primes += "′";
				}
				this.#attachScript(nodes, "sup", [
					{ k: "text", t: primes === "′′" ? "″" : primes === "′′′" ? "‴" : primes },
				]);
				continue;
			}
			if (token.kind === "cmd" && (token.name === "limits" || token.name === "nolimits")) {
				this.#at++;
				const last = nodes[nodes.length - 1];
				if (last?.k === "op") last.limits = token.name === "limits";
				continue;
			}
			if (token.kind === "cmd" && token.name === "middle" && stops.left) {
				this.#at++;
				nodes.push({ k: "middle", t: this.#delimiter() });
				continue;
			}
			if (token.kind === "cmd" && (token.name === "color" || token.name === "bf" || token.name === "it")) {
				this.#at++;
				const style: StyleChange =
					token.name === "color"
						? { fg: this.#colorArgument() }
						: token.name === "bf"
							? { bold: true }
							: { italic: true };
				nodes.push({ k: "style", style, c: this.#sequence(stops) });
				continue;
			}
			nodes.push(...this.#atom());
		}
		return nodes;
	}

	#attachScript(nodes: MathNode[], slot: "sub" | "sup", content: MathNode[]): void {
		const last = nodes[nodes.length - 1];
		if (last?.k === "scripts" && last[slot] === undefined && !last.stack) {
			last[slot] = content;
			return;
		}
		if (last !== undefined) nodes.pop();
		const base = last?.k === "text" && last.t === " " ? undefined : last;
		if (last !== undefined && base === undefined) nodes.push(last);
		nodes.push({
			k: "scripts",
			base,
			sub: slot === "sub" ? content : undefined,
			sup: slot === "sup" ? content : undefined,
			first: slot,
			stack: false,
		});
	}

	#skipSpaces(): void {
		while (this.#isChar(" ")) this.#at++;
	}

	/** A required argument: a braced group's nodes, or one atom. */
	#argument(): MathNode[] {
		this.#skipSpaces();
		const token = this.#peek();
		if (token === undefined) return [];
		if (token.kind === "char" && token.ch === "{") {
			this.#at++;
			const nodes = this.#sequence({});
			this.#closeBrace();
			return nodes;
		}
		if (token.kind === "char" && token.ch === "}") return [];
		return this.#atom();
	}

	#closeBrace(): void {
		const token = this.#peek();
		if (token?.kind === "char" && token.ch === "}") this.#at++;
	}

	/** An optional `[…]` argument, or undefined. */
	#optional(): MathNode[] | undefined {
		const save = this.#at;
		this.#skipSpaces();
		const token = this.#peek();
		if (token?.kind !== "char" || token.ch !== "[") {
			this.#at = save;
			return undefined;
		}
		this.#at++;
		const nodes = this.#sequence({ bracket: true });
		const close = this.#peek();
		if (close?.kind === "char" && close.ch === "]") this.#at++;
		return nodes;
	}

	/** The raw source of a braced argument (names, colors, column specs). */
	#rawArgument(): string {
		this.#skipSpaces();
		const open = this.#peek();
		if (open === undefined) return "";
		if (open.kind !== "char" || open.ch !== "{") {
			this.#at++;
			return open.kind === "char" ? open.ch : open.name;
		}
		let depth = 0;
		for (let i = this.#at; i < this.#tokens.length; i++) {
			const token = this.#tokens[i]!;
			if (token.kind !== "char") continue;
			if (token.ch === "{") depth++;
			else if (token.ch === "}" && --depth === 0) {
				this.#at = i + 1;
				return this.#source.slice(open.end, token.start).trim();
			}
		}
		this.#at = this.#tokens.length;
		return this.#source.slice(open.end).trim();
	}

	/** The raw source of an optional `[…]` argument, or undefined. */
	#rawOptional(): string | undefined {
		const save = this.#at;
		this.#skipSpaces();
		const open = this.#peek();
		if (open?.kind !== "char" || open.ch !== "[") {
			this.#at = save;
			return undefined;
		}
		for (let i = this.#at + 1; i < this.#tokens.length; i++) {
			const token = this.#tokens[i]!;
			if (token.kind === "char" && token.ch === "]") {
				this.#at = i + 1;
				return this.#source.slice(open.end, token.start).trim();
			}
		}
		this.#at = save;
		return undefined;
	}

	#colorArgument(): ColorSpec {
		const model = this.#rawOptional();
		return { model, value: this.#rawArgument() };
	}

	/** The delimiter after `\left`, `\right`, `\middle` or `\big`. */
	#delimiter(): string {
		this.#skipSpaces();
		const token = this.#peek();
		if (token === undefined) return "";
		this.#at++;
		if (token.kind === "char") return token.ch === "." ? "" : token.ch;
		if (token.name === ".") return "";
		return DELIMITER_COMMANDS[token.name] ?? SYMBOLS[token.name] ?? "";
	}

	/** One atom: a group, a character, or a command with its arguments. */
	#atom(): MathNode[] {
		const token = this.#peek()!;
		this.#at++;
		if (token.kind === "char") {
			if (token.ch === "{") {
				const nodes = this.#sequence({});
				this.#closeBrace();
				return [{ k: "group", c: nodes }];
			}
			if (token.ch === "~") return [{ k: "text", t: " " }];
			return [{ k: "text", t: token.ch === "-" ? "-" : token.ch }];
		}
		return this.#command(token.name);
	}

	#command(name: string): MathNode[] {
		const symbol = SYMBOLS[name];
		if (symbol !== undefined) return [{ k: "text", t: symbol }];
		const space = SPACES[name];
		if (space !== undefined) return space === "" ? [] : [{ k: "text", t: space }];
		if (BIG_OPERATORS[name] !== undefined) return [{ k: "op", t: BIG_OPERATORS[name]!, limits: true }];
		if (INTEGRALS[name] !== undefined) return [{ k: "op", t: INTEGRALS[name]!, limits: false }];
		if (LIMIT_FUNCTIONS[name]) return [{ k: "op", t: name, limits: true }];
		if (FUNCTIONS[name]) return [{ k: "text", t: name }];
		if (IGNORED[name]) return [];
		const accent = ACCENTS[name];
		if (accent !== undefined) return [{ k: "accent", mark: accent[0], each: accent[1], c: this.#argument() }];
		const style = STYLES[name];
		const font = FONTS[name];
		if (style !== undefined && font !== undefined) {
			return [{ k: "style", style, c: [{ k: "font", font, c: this.#argument() }] }];
		}
		if (style !== undefined) return [{ k: "style", style, c: this.#argument() }];
		if (font !== undefined) return [{ k: "font", font, c: this.#argument() }];
		const arrow = ARROWS[name];
		if (arrow !== undefined) {
			const below = this.#optional();
			return [{ k: "xarrow", t: arrow, above: this.#argument(), below }];
		}
		if (SIZE_COMMANDS[name]) {
			const delimiter = this.#delimiter();
			return delimiter === "" ? [] : [{ k: "text", t: delimiter }];
		}
		switch (name) {
			case "frac":
			case "dfrac":
			case "tfrac":
			case "cfrac":
				return [{ k: "frac", num: this.#argument(), den: this.#argument(), bar: true }];
			case "binom":
			case "dbinom":
			case "tbinom":
				return [{ k: "frac", num: this.#argument(), den: this.#argument(), bar: false }];
			case "sqrt": {
				const index = this.#optional();
				return [{ k: "sqrt", index, c: this.#argument() }];
			}
			case "textcolor": {
				const fg = this.#colorArgument();
				return [{ k: "style", style: { fg }, c: this.#argument() }];
			}
			case "colorbox": {
				const bg = this.#colorArgument();
				return [{ k: "style", style: { bg }, c: this.#argument() }];
			}
			case "fcolorbox": {
				const frame = this.#colorArgument();
				const bg = this.#colorArgument();
				const body = this.#argument();
				return [
					{ k: "style", style: { fg: frame }, c: [{ k: "text", t: "[" }] },
					{ k: "style", style: { bg }, c: body },
					{ k: "style", style: { fg: frame }, c: [{ k: "text", t: "]" }] },
				];
			}
			case "left": {
				const left = this.#delimiter();
				const body = this.#sequence({ left: true });
				const close = this.#peek();
				let right = "";
				if (close?.kind === "cmd" && close.name === "right") {
					this.#at++;
					right = this.#delimiter();
				}
				return [{ k: "delim", left, right, c: body }];
			}
			case "right":
				return [{ k: "text", t: this.#delimiter() }];
			case "middle":
				return [{ k: "text", t: this.#delimiter() }];
			case "begin":
				return [this.#environment(this.#rawArgument())];
			case "end":
				this.#rawArgument();
				return [];
			case "boxed":
			case "fbox":
				return [{ k: "wrap", open: "[", close: "]", c: this.#argument() }];
			case "pmod":
				return [{ k: "wrap", open: "(mod ", close: ")", c: this.#argument() }];
			case "bmod":
			case "mod":
				return [{ k: "text", t: "mod" }];
			case "pod":
				return [{ k: "wrap", open: "(", close: ")", c: this.#argument() }];
			case "tag":
				return [{ k: "wrap", open: " (", close: ")", c: this.#argument() }];
			case "overset":
			case "stackrel": {
				const over = this.#argument();
				const base = this.#argument();
				return [
					{ k: "scripts", base: { k: "group", c: base }, sup: over, sub: undefined, first: "sup", stack: true },
				];
			}
			case "underset": {
				const under = this.#argument();
				const base = this.#argument();
				return [
					{ k: "scripts", base: { k: "group", c: base }, sub: under, sup: undefined, first: "sub", stack: true },
				];
			}
			case "overbrace":
			case "underbrace":
				return [{ k: "brace", over: name === "overbrace", c: this.#argument() }];
			case "mathop":
			case "mathrel":
			case "mathbin":
			case "mathord":
			case "mathopen":
			case "mathclose":
			case "mathpunct":
			case "displaylimits":
				return [{ k: "group", c: this.#argument() }];
			case "phantom":
			case "hphantom":
			case "vphantom":
			case "label":
			case "ref":
			case "eqref":
				this.#argument();
				return [];
			case "not": {
				const next = this.#argument();
				const first = next[0];
				if (next.length === 1 && first?.k === "text") {
					return [{ k: "text", t: NEGATED[first.t] ?? `${first.t}\u0338` }];
				}
				return next;
			}
			case "\\":
			case "cr":
				return [{ k: "text", t: " " }];
			default:
				return [{ k: "text", t: `\\${name}` }];
		}
	}

	#environment(name: string): MathNode {
		let spec: string | undefined;
		if (name === "array" || name === "subarray") spec = this.#rawArgument();
		else if (name.startsWith("alignat") || name.startsWith("xalignat")) this.#rawArgument();
		else if (name === "tabular") spec = this.#rawArgument();
		const rows: MathNode[][][] = [];
		let row: MathNode[][] = [];
		for (;;) {
			row.push(this.#sequence({ env: true }));
			const token = this.#peek();
			if (token === undefined) break;
			if (token.kind === "char" && token.ch === "&") {
				this.#at++;
				continue;
			}
			if (token.kind === "char" && token.ch === "}") {
				// Unbalanced closer inside an environment: keep going past it.
				this.#at++;
				continue;
			}
			if (token.kind === "cmd" && (token.name === "\\" || token.name === "cr")) {
				this.#at++;
				this.#rawOptional();
				rows.push(row);
				row = [];
				continue;
			}
			// \end{name}
			this.#at++;
			this.#rawArgument();
			break;
		}
		const empty = row.length === 1 && row[0]!.every(node => node.k === "text" && node.t.trim() === "");
		if (!empty || rows.length === 0) rows.push(row);
		return { k: "env", name, rows, spec };
	}
}

/** Parse LaTeX math (no surrounding delimiters) into its tree; line breaks are spaces. */
export function parseMath(source: string): MathNode[] {
	return new Parser(source).parse();
}

/**
 * Parse display math into rows: a top-level `\\` or line break ends a row,
 * unless a command is still reading its arguments across it.
 */
export function parseMathRows(source: string): MathNode[][] {
	return new Parser(source).parseRows();
}
