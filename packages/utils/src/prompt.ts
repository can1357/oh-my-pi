import type { HelperDelegate, Template } from "./template";
import * as Handlebars from "./template";

export type { HelperDelegate, HelperOptions, Template, TemplateDelegate } from "./template";

export type PromptRenderPhase = "pre-render" | "post-render";

export interface PromptFormatOptions {
	renderPhase?: PromptRenderPhase;
	replaceAsciiSymbols?: boolean;
	normalizeRfc2119?: boolean;
}

// Opening XML tag (not self-closing, not closing)
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;

/**
 * Closing XML tag matcher, manual equivalent of `/^<\/([a-z_-]+)>$/` — avoids a
 * RegExp exec (and match array allocation) per `<`-prefixed line. Caller
 * guarantees `s` starts `</`.
 */
function closingTagName(s: string): string | null {
	const n = s.length;
	if (n < 4 || s.charCodeAt(n - 1) !== 62 /* > */) return null;
	for (let j = 2; j < n - 1; j++) {
		const c = s.charCodeAt(j);
		if (!((c >= 97 /* a */ && c <= 122) /* z */ || c === 45 /* - */ || c === 95) /* _ */) return null;
	}
	return s.slice(2, n - 1);
}

/**
 * Manual equivalent of {@link OPENING_XML}. Caller guarantees `s` starts with
 * `<` but not `</`. Falls back to the regex when the char after the tag name
 * is non-ASCII (possible unicode whitespace).
 */
function openingTagName(s: string): string | null {
	const n = s.length;
	if (n < 3 || s.charCodeAt(n - 1) !== 62 /* > */) return null;
	let j = 1;
	while (j < n - 1) {
		const c = s.charCodeAt(j);
		if ((c >= 97 /* a */ && c <= 122) /* z */ || c === 45 /* - */ || c === 95 /* _ */) j++;
		else break;
	}
	if (j === 1) return null;
	if (j === n - 1) return s.slice(1, j); // `<tag>`
	const c = s.charCodeAt(j);
	if (c !== 32 /* space */ && c !== 9 /* tab */) {
		if (c < 128) return null;
		const match = OPENING_XML.exec(s);
		return match ? match[1] : null;
	}
	// `\s+[^>]*>$` ⇔ no further `>` before the final char.
	return s.indexOf(">", j + 1) === n - 1 ? s.slice(1, j) : null;
}
// Table row
const TABLE_ROW = /^\|.*\|$/;
// Table separator (|---|---|)
const TABLE_SEP = /^\|[-:\s|]+\|$/;
// Any non-whitespace char — blank-line check without allocating a trimmed copy
const NON_BLANK = /\S/;

/**
 * RFC 2119 keywords (plus project aliases NEVER/AVOID) wrapped in markdown bold
 * — `**MUST**`, `**MUST NOT**`, `**NEVER**`, etc.
 */
const RFC2119_BOLD = /\*\*(MUST NOT|SHOULD NOT|RECOMMENDED|REQUIRED|OPTIONAL|SHOULD|MUST|MAY|NEVER|AVOID)\*\*/g;

/**
 * Fast pre-check for {@link normalizeRfc2119}: a line that lacks every one of
 * these substrings is untouched by all three replacements, so the
 * split/replace/join machinery can be skipped entirely.
 */
const RFC2119_GUARD = /\*\*(?:MUST|SHOULD|RECOMMENDED|REQUIRED|OPTIONAL|MAY|NEVER|AVOID)|MUST NOT|SHOULD NOT/;
const MUST_NOT = /\bMUST NOT\b/g;
const SHOULD_NOT = /\bSHOULD NOT\b/g;

function applyRfc2119(text: string): string {
	return text.replace(RFC2119_BOLD, "$1").replace(MUST_NOT, "NEVER").replace(SHOULD_NOT, "AVOID");
}

/**
 * Normalize RFC 2119 markers per project convention:
 *   - Strip `**KEYWORD**` bold (visual noise, no semantics).
 *   - Alias `MUST NOT` → `NEVER` and `SHOULD NOT` → `AVOID` (single-token equivalents).
 * Skips spans inside inline code (`` `…` ``) so alias definitions can be quoted literally.
 */
function normalizeRfc2119(line: string): string {
	if (!RFC2119_GUARD.test(line)) return line;
	if (!line.includes("`")) return applyRfc2119(line);
	const segments = line.split("`");
	for (let i = 0; i < segments.length; i += 2) {
		segments[i] = applyRfc2119(segments[i]);
	}
	return segments.join("`");
}

/** Compact a table row by trimming cell padding */
function compactTableRow(line: string): string {
	const cells = line.split("|");
	return cells.map(c => c.trim()).join("|");
}

/** Compact a table separator row */
function compactTableSep(line: string): string {
	const cells = line.split("|").filter(c => c.trim());
	const normalized = cells.map(c => {
		const trimmed = c.trim();
		const left = trimmed.startsWith(":");
		const right = trimmed.endsWith(":");
		if (left && right) return ":---:";
		if (left) return ":---";
		if (right) return "---:";
		return "---";
	});
	return `|${normalized.join("|")}|`;
}

const HTML_COMMENT_OPEN = "<!--";
const HTML_COMMENT_CLOSE = "-->";

type HtmlCommentState = {
	inHtmlComment: boolean;
};

// Single-pass alternation equivalent to the former chain of seven .replace()
// calls. Alternative order mirrors the old sequential order (`<->` before
// `->`/`<-`), and every replacement emits a non-ASCII char, so one pass
// produces byte-identical output to the sequential passes.
const ASCII_SYMBOLS = /\.{3}|<->|->|<-|!=|<=|>=/g;
const ASCII_SYMBOL_REPLACEMENTS: Record<string, string> = {
	"...": "…",
	"<->": "↔",
	"->": "→",
	"<-": "←",
	"!=": "≠",
	"<=": "≤",
	">=": "≥",
};
const replaceAsciiSymbol = (match: string): string => ASCII_SYMBOL_REPLACEMENTS[match];

function replaceCommonAsciiSymbols(line: string): string {
	return line.replace(ASCII_SYMBOLS, replaceAsciiSymbol);
}

function replaceCommonAsciiSymbolsOutsideHtmlComments(line: string, state: HtmlCommentState): string {
	// When not inside a comment, a line without `<!--` takes the fast path even
	// if it contains `-->`: the slow path would hit openIndex === -1 and replace
	// the whole line identically.
	if (!state.inHtmlComment && !line.includes(HTML_COMMENT_OPEN)) {
		return replaceCommonAsciiSymbols(line);
	}

	let result = "";
	let cursor = 0;

	while (cursor < line.length) {
		if (state.inHtmlComment) {
			const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, cursor);
			if (closeIndex === -1) {
				return result + line.slice(cursor);
			}
			result += line.slice(cursor, closeIndex + HTML_COMMENT_CLOSE.length);
			cursor = closeIndex + HTML_COMMENT_CLOSE.length;
			state.inHtmlComment = false;
			continue;
		}

		const openIndex = line.indexOf(HTML_COMMENT_OPEN, cursor);
		if (openIndex === -1) {
			result += replaceCommonAsciiSymbols(line.slice(cursor));
			return result;
		}

		result += replaceCommonAsciiSymbols(line.slice(cursor, openIndex));
		const closeIndex = line.indexOf(HTML_COMMENT_CLOSE, openIndex + HTML_COMMENT_OPEN.length);
		if (closeIndex === -1) {
			result += line.slice(openIndex);
			state.inHtmlComment = true;
			return result;
		}

		result += line.slice(openIndex, closeIndex + HTML_COMMENT_CLOSE.length);
		cursor = closeIndex + HTML_COMMENT_CLOSE.length;
	}

	return result;
}

export function format(content: string, options: PromptFormatOptions = {}): string {
	const {
		renderPhase = "post-render",
		replaceAsciiSymbols = false,
		normalizeRfc2119: shouldNormalizeRfc2119 = false,
	} = options;
	const isPreRender = renderPhase === "pre-render";
	const lines = content.split("\n");
	const result: string[] = new Array(lines.length);
	let n = 0; // logical length of `result` (pops are n--)
	let inCodeBlock = false;

	const htmlCommentState: HtmlCommentState = { inHtmlComment: false };
	const topLevelTags: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		// charCode fast paths: only pay for trimEnd when the last char might be
		// whitespace (<= 0x20 ASCII ws/controls, >= 0x80 unicode ws). Untouched
		// lines are pushed as the original string — no allocation.
		const last = raw.charCodeAt(raw.length - 1);
		let line = last <= 32 || last >= 128 ? raw.trimEnd() : raw;
		// Locate the first non-whitespace char without allocating a trimStart
		// copy; `s` is the indent width, `first` the char code there (NaN when
		// the line is blank).
		let s = 0;
		let first = line.charCodeAt(0);
		while (first === 32 /* space */ || first === 9 /* tab */) first = line.charCodeAt(++s);
		if (first >= 128) {
			// Possible unicode leading whitespace — defer to trimStart for exactness.
			s = line.length - line.trimStart().length;
			first = line.charCodeAt(s);
		}

		if ((first === 96 /* ` */ || first === 126) /* ~ */ && (line.startsWith("```", s) || line.startsWith("~~~", s))) {
			inCodeBlock = !inCodeBlock;
			result[n++] = line;
			continue;
		}

		if (inCodeBlock) {
			result[n++] = line;
			continue;
		}

		if (replaceAsciiSymbols) {
			const replaced = replaceCommonAsciiSymbolsOutsideHtmlComments(line, htmlCommentState);
			if (replaced !== line) {
				line = replaced;
				s = 0;
				first = line.charCodeAt(0);
				while (first === 32 || first === 9) first = line.charCodeAt(++s);
				if (first >= 128) {
					s = line.length - line.trimStart().length;
					first = line.charCodeAt(s);
				}
			}
		}

		let isClosingLine = false;
		if (first === 60 /* < */) {
			const trimmedStart = s === 0 ? line : line.slice(s);
			if (trimmedStart.charCodeAt(1) === 47 /* / */) {
				const tagName = closingTagName(trimmedStart);
				if (tagName !== null) {
					isClosingLine = true;
					if (topLevelTags.length > 0 && topLevelTags[topLevelTags.length - 1] === tagName) {
						topLevelTags.pop();
					}
				}
			} else if (s === 0 && !trimmedStart.endsWith("/>")) {
				const tagName = openingTagName(trimmedStart);
				if (tagName !== null) topLevelTags.push(tagName);
			}
		} else if (first === 124 /* | */) {
			const trimmedStart = s === 0 ? line : line.slice(s);
			if (TABLE_SEP.test(trimmedStart)) {
				line = `${line.slice(0, s)}${compactTableSep(trimmedStart)}`;
			} else if (TABLE_ROW.test(trimmedStart)) {
				line = `${line.slice(0, s)}${compactTableRow(trimmedStart)}`;
			}
		}

		if (shouldNormalizeRfc2119) {
			line = normalizeRfc2119(line);
		}

		if (s >= line.length) {
			// Blank line (`line` carries no trailing whitespace, so it is "").
			const next = lines[i + 1];
			// Strip any run of 2+ consecutive blank lines entirely; preserve a single blank.
			if (next === undefined || next.length === 0 || !NON_BLANK.test(next)) {
				while (n > 0 && result[n - 1].length === 0) n--;
				let j = i + 1;
				while (j < lines.length && (lines[j].length === 0 || !NON_BLANK.test(lines[j]))) j++;
				i = j - 1;
				continue;
			}
			if (n === 0 || result[n - 1].length === 0) {
				continue;
			}
		}

		// CLOSING_HBS (`/^\{\{\//`) ⇔ startsWith("{{/") at the indent offset.
		if (isClosingLine || (isPreRender && first === 123 /* { */ && line.startsWith("{{/", s))) {
			while (n > 0 && result[n - 1].length === 0) n--;
		}

		result[n++] = line;
	}

	while (n > 0 && result[n - 1].length === 0) n--;
	result.length = n;

	return result.join("\n");
}

export interface TemplateContext extends Record<string, unknown> {
	args?: string[];
	ARGUMENTS?: string;
	arguments?: string;
}

const handlebars = Handlebars.create();

handlebars.registerHelper("arg", function (this: TemplateContext, index: number | string): string {
	const args = this.args ?? [];
	const parsedIndex = typeof index === "number" ? index : Number.parseInt(index, 10);
	if (!Number.isFinite(parsedIndex)) return "";
	const zeroBased = parsedIndex - 1;
	if (zeroBased < 0) return "";
	return args[zeroBased] ?? "";
});

/**
 * {{#list items prefix="- " suffix="" join="\n"}}{{this}}{{/list}}
 * Renders an array with customizable prefix, suffix, and join separator.
 * Note: Use \n in join for newlines (will be unescaped automatically).
 */
handlebars.registerHelper(
	"list",
	function (this: unknown, context: unknown[], options: Handlebars.HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const prefix = (options.hash.prefix as string) ?? "";
		const suffix = (options.hash.suffix as string) ?? "";
		const rawSeparator = (options.hash.join as string) ?? "\n";
		const separator = rawSeparator.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
		return context.map(item => `${prefix}${options.fn(item)}${suffix}`).join(separator);
	},
);

/**
 * {{join array ", "}}
 * Joins an array with a separator (default: ", ").
 * Note: Use \n/\t in the separator for newlines/tabs (unescaped automatically,
 * same convention as {{#list}} — Handlebars string literals carry no escapes).
 */
handlebars.registerHelper("join", (context: unknown[], separator?: unknown): string => {
	if (!Array.isArray(context)) return "";
	const sep = typeof separator === "string" ? separator.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : ", ";
	return context.join(sep);
});

/**
 * {{default value "fallback"}}
 * Returns the value if truthy, otherwise returns the fallback.
 */
handlebars.registerHelper("default", (value: unknown, defaultValue: unknown): unknown => value || defaultValue);

/**
 * {{pluralize count "item" "items"}}
 * Returns "1 item" or "5 items" based on count.
 */
handlebars.registerHelper(
	"pluralize",
	(count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`,
);

/**
 * {{#when value "==" compare}}...{{else}}...{{/when}}
 * Conditional block with comparison operators: ==, ===, !=, !==, >, <, >=, <=
 */
handlebars.registerHelper(
	"when",
	function (this: unknown, lhs: unknown, operator: string, rhs: unknown, options: Handlebars.HelperOptions): string {
		const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
			"==": (a, b) => a === b,
			"===": (a, b) => a === b,
			"!=": (a, b) => a !== b,
			"!==": (a, b) => a !== b,
			">": (a, b) => (a as number) > (b as number),
			"<": (a, b) => (a as number) < (b as number),
			">=": (a, b) => (a as number) >= (b as number),
			"<=": (a, b) => (a as number) <= (b as number),
		};
		const fn = ops[operator];
		if (!fn) return options.inverse(this);
		return fn(lhs, rhs) ? options.fn(this) : options.inverse(this);
	},
);

/**
 * {{#ifAny a b c}}...{{else}}...{{/ifAny}}
 * True if any argument is truthy.
 */
handlebars.registerHelper("ifAny", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as Handlebars.HelperOptions;
	return args.some(Boolean) ? options.fn(this) : options.inverse(this);
});

/**
 * {{#ifAll a b c}}...{{else}}...{{/ifAll}}
 * True if all arguments are truthy.
 */
handlebars.registerHelper("ifAll", function (this: unknown, ...args: unknown[]): string {
	const options = args.pop() as Handlebars.HelperOptions;
	return args.every(Boolean) ? options.fn(this) : options.inverse(this);
});

/**
 * {{#table rows headers="Col1|Col2"}}{{col1}}|{{col2}}{{/table}}
 * Generates a markdown table from an array of objects.
 */
handlebars.registerHelper(
	"table",
	function (this: unknown, context: unknown[], options: Handlebars.HelperOptions): string {
		if (!Array.isArray(context) || context.length === 0) return "";
		const headersStr = options.hash.headers as string | undefined;
		const headers = headersStr?.split("|") ?? [];
		const separator = headers.map(() => "---").join(" | ");
		const headerRow = headers.length > 0 ? `| ${headers.join(" | ")} |\n| ${separator} |\n` : "";
		const rows = context.map(item => `| ${options.fn(item).trim()} |`).join("\n");
		return headerRow + rows;
	},
);

/**
 * {{#codeblock lang="diff"}}...{{/codeblock}}
 * Wraps content in a fenced code block.
 */
handlebars.registerHelper("codeblock", function (this: unknown, options: Handlebars.HelperOptions): string {
	const lang = (options.hash.lang as string) ?? "";
	const content = options.fn(this).trim();
	return `\`\`\`${lang}\n${content}\n\`\`\``;
});

/**
 * {{#xml "tag"}}content{{/xml}}
 * Wraps content in XML-style tags. Returns empty string if content is empty.
 */
handlebars.registerHelper("xml", function (this: unknown, tag: string, options: Handlebars.HelperOptions): string {
	const content = options.fn(this).trim();
	if (!content) return "";
	return `<${tag}>\n${content}\n</${tag}>`;
});

/**
 * {{escapeXml value}}
 * Escapes XML special characters: & < > "
 */
handlebars.registerHelper("escapeXml", (value: unknown): string => {
	if (value == null) return "";
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
});

/**
 * {{len array}}
 * Returns the length of an array or string.
 */
handlebars.registerHelper("len", (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (typeof value === "string") return value.length;
	return 0;
});

/**
 * {{add a b}}
 * Adds two numbers.
 */
handlebars.registerHelper("add", (a: number, b: number): number => (a ?? 0) + (b ?? 0));

/**
 * {{sub a b}}
 * Subtracts b from a.
 */
handlebars.registerHelper("sub", (a: number, b: number): number => (a ?? 0) - (b ?? 0));

/**
 * {{#has collection item}}...{{else}}...{{/has}}
 * Checks if an array includes an item or if a Set/Map has a key.
 */
handlebars.registerHelper(
	"has",
	function (this: unknown, collection: unknown, item: unknown, options: Handlebars.HelperOptions): string {
		let found = false;
		if (Array.isArray(collection)) {
			found = collection.includes(item);
		} else if (collection instanceof Set) {
			found = collection.has(item);
		} else if (collection instanceof Map) {
			found = collection.has(item);
		} else if (collection && typeof collection === "object") {
			if (typeof item === "string" || typeof item === "number" || typeof item === "symbol") {
				found = item in collection;
			}
		}
		return found ? options.fn(this) : options.inverse(this);
	},
);

/**
 * {{includes array item}}
 * Returns true if array includes item. For use in other helpers.
 */
handlebars.registerHelper("includes", (collection: unknown, item: unknown): boolean => {
	if (Array.isArray(collection)) return collection.includes(item);
	if (collection instanceof Set) return collection.has(item);
	if (collection instanceof Map) return collection.has(item);
	return false;
});

/**
 * {{not value}}
 * Returns logical NOT of value. For use in subexpressions.
 */
handlebars.registerHelper("not", (value: unknown): boolean => !value);

handlebars.registerHelper("jsonStringify", (value: unknown): string => JSON.stringify(value));

export function registerHelper(name: string, fn: HelperDelegate): void {
	handlebars.registerHelper(name, fn);
}

export function registerPartial(name: string, fn: Template): void {
	handlebars.registerPartial(name, fn);
}

const compiledTemplateCache = new Map<string, (context: TemplateContext) => string>();

export function compile(template: string): (context: TemplateContext) => string {
	// Keyed on the raw template so repeat renders skip parsing.
	const cached = compiledTemplateCache.get(template);
	if (cached) return cached;
	const compiled = handlebars.compile(template, { noEscape: true, strict: false }) as (
		context: TemplateContext,
	) => string;
	compiledTemplateCache.set(template, compiled);
	return compiled;
}

export function render(template: string, context: TemplateContext = {}): string {
	const compiled = compile(template);
	const rendered = compiled(context ?? {});
	return format(rendered, { renderPhase: "post-render" });
}
