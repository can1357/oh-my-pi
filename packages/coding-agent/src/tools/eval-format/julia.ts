const INDENT = "    ";

const BLOCK_OPENERS: Record<string, true> = {
	function: true,
	macro: true,
	struct: true,
	if: true,
	for: true,
	while: true,
	let: true,
	begin: true,
	quote: true,
	try: true,
	module: true,
	baremodule: true,
	do: true,
};

const BRANCH_CLAUSES: Record<string, true> = {
	else: true,
	elseif: true,
	catch: true,
	finally: true,
};

const EXPRESSION_PREFIX_WORDS: Record<string, true> = {
	baremodule: true,
	begin: true,
	catch: true,
	const: true,
	do: true,
	else: true,
	elseif: true,
	finally: true,
	for: true,
	function: true,
	global: true,
	if: true,
	in: true,
	isa: true,
	let: true,
	local: true,
	macro: true,
	module: true,
	mutable: true,
	quote: true,
	return: true,
	struct: true,
	throw: true,
	try: true,
	where: true,
	while: true,
};

type QuoteKind = "double" | "triple" | "command" | "char";

interface QuoteFrame {
	type: "quote";
	kind: QuoteKind;
	escaped: boolean;
}

interface InterpolationFrame {
	type: "interpolation";
	closers: string[];
	canEndExpression: boolean;
}

type LiteralFrame = QuoteFrame | InterpolationFrame;

type PrefixToken = "none" | "dot" | "colon" | "at" | "other";

function isIdentifierStart(character: string): boolean {
	const code = character.charCodeAt(0);
	return character === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 0x80;
}

function isIdentifierContinue(character: string): boolean {
	const code = character.charCodeAt(0);
	return isIdentifierStart(character) || (code >= 48 && code <= 57) || character === "!" || character === "?";
}

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\v" || character === "\f";
}

function isExpressionSeparator(character: string): boolean {
	return (
		character === "=" ||
		character === "," ||
		character === ";" ||
		character === ":" ||
		character === "." ||
		character === "@" ||
		character === "+" ||
		character === "-" ||
		character === "*" ||
		character === "/" ||
		character === "\\" ||
		character === "%" ||
		character === "^" ||
		character === "&" ||
		character === "|" ||
		character === "<" ||
		character === ">" ||
		character === "~"
	);
}

function consumeLineComment(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
	return index;
}

function consumeBlockComment(source: string, start: number): number {
	let depth = 1;
	let index = start + 2;

	while (index < source.length) {
		if (source[index] === "#" && source[index + 1] === "=") {
			depth++;
			index += 2;
			continue;
		}
		if (source[index] === "=" && source[index + 1] === "#") {
			depth--;
			index += 2;
			if (depth === 0) return index;
			continue;
		}
		index++;
	}

	return source.length;
}

function quoteWidth(kind: QuoteKind): number {
	return kind === "triple" ? 3 : 1;
}

function quoteCloses(source: string, index: number, kind: QuoteKind): boolean {
	if (kind === "triple") {
		return source[index] === '"' && source[index + 1] === '"' && source[index + 2] === '"';
	}
	if (kind === "double") return source[index] === '"';
	if (kind === "command") return source[index] === "`";
	return source[index] === "'";
}

function pushQuote(frames: LiteralFrame[], kind: QuoteKind): void {
	frames.push({ type: "quote", kind, escaped: false });
}

/**
 * Finds the end of a quoted literal while treating interpolation as opaque code.
 * The small lexer is deliberately independent from display layout: its only job
 * is to keep separators and block words inside a literal out of the formatter.
 */
function consumeQuotedLiteral(source: string, start: number, kind: QuoteKind): number {
	const frames: LiteralFrame[] = [];
	pushQuote(frames, kind);
	let index = start + quoteWidth(kind);

	while (index < source.length) {
		const frame = frames.at(-1);
		if (!frame) return index;

		if (frame.type === "quote") {
			const character = source[index];
			if (frame.escaped) {
				frame.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				frame.escaped = true;
				index++;
				continue;
			}
			if (frame.kind !== "char" && character === "$" && source[index + 1] === "(") {
				frames.push({ type: "interpolation", closers: [")"], canEndExpression: false });
				index += 2;
				continue;
			}
			if (quoteCloses(source, index, frame.kind)) {
				index += quoteWidth(frame.kind);
				frames.pop();
				const parent = frames.at(-1);
				if (!parent) return index;
				if (parent.type === "interpolation") parent.canEndExpression = true;
				continue;
			}
			index++;
			continue;
		}

		const character = source[index];
		if (character === "#") {
			index = source[index + 1] === "=" ? consumeBlockComment(source, index) : consumeLineComment(source, index);
			continue;
		}
		if (character === '"') {
			const nestedKind = source.startsWith('"""', index) ? "triple" : "double";
			pushQuote(frames, nestedKind);
			index += quoteWidth(nestedKind);
			continue;
		}
		if (character === "`") {
			pushQuote(frames, "command");
			index++;
			continue;
		}
		if (character === "'") {
			if (frame.canEndExpression) {
				index++;
				continue;
			}
			pushQuote(frames, "char");
			index++;
			continue;
		}
		if (isIdentifierStart(character)) {
			const wordStart = index;
			index++;
			while (index < source.length && isIdentifierContinue(source[index])) index++;
			frame.canEndExpression = EXPRESSION_PREFIX_WORDS[source.slice(wordStart, index)] !== true;
			continue;
		}
		if (character === "(" || character === "[" || character === "{") {
			frame.closers.push(character === "(" ? ")" : character === "[" ? "]" : "}");
			frame.canEndExpression = false;
			index++;
			continue;
		}
		if (character === ")" || character === "]" || character === "}") {
			if (frame.closers.at(-1) === character) {
				frame.closers.pop();
				index++;
				if (frame.closers.length === 0) frames.pop();
				else frame.canEndExpression = true;
				continue;
			}
			frame.canEndExpression = true;
			index++;
			continue;
		}
		if (character === "\n" || character === "\r" || isExpressionSeparator(character)) {
			frame.canEndExpression = false;
			index++;
			continue;
		}
		if (!isHorizontalWhitespace(character)) frame.canEndExpression = true;
		index++;
	}

	return source.length;
}

/** Formats an arbitrary Julia source prefix for stable, readable display. */
export function formatJuliaForDisplay(source: string): string {
	const output: string[] = [];
	const delimiterClosers: string[] = [];
	let index = 0;
	let blockDepth = 0;
	let atLineStart = true;
	let pendingWhitespace = "";
	let suppressSourceNewline = false;
	let canEndExpression = false;
	let previousToken: PrefixToken = "none";

	function beginContent(dedentBlock: boolean, dedentDelimiter: boolean): void {
		if (atLineStart) {
			pendingWhitespace = "";
			const indentation = Math.max(
				0,
				blockDepth - (dedentBlock ? 1 : 0) + delimiterClosers.length - (dedentDelimiter ? 1 : 0),
			);
			if (indentation > 0) output.push(INDENT.repeat(indentation));
			atLineStart = false;
		} else if (pendingWhitespace.length > 0) {
			output.push(pendingWhitespace);
			pendingWhitespace = "";
		}
		suppressSourceNewline = false;
	}

	function appendOpaque(start: number, end: number): boolean {
		output.push(source.slice(start, end));
		let containsNewline = false;
		for (let cursor = start; cursor < end; cursor++) {
			if (source[cursor] === "\n" || source[cursor] === "\r") {
				containsNewline = true;
				atLineStart = true;
			} else {
				atLineStart = false;
			}
		}
		return containsNewline;
	}

	while (index < source.length) {
		const character = source[index];

		if (isHorizontalWhitespace(character)) {
			const whitespaceStart = index;
			index++;
			while (index < source.length && isHorizontalWhitespace(source[index])) index++;
			if (!atLineStart) pendingWhitespace = source.slice(whitespaceStart, index);
			continue;
		}

		if (character === "\n" || character === "\r") {
			pendingWhitespace = "";
			const newlineWidth = character === "\r" && source[index + 1] === "\n" ? 2 : 1;
			index += newlineWidth;
			if (suppressSourceNewline && atLineStart) {
				suppressSourceNewline = false;
				continue;
			}
			output.push("\n");
			atLineStart = true;
			suppressSourceNewline = false;
			canEndExpression = false;
			previousToken = "none";
			continue;
		}

		if (character === "#") {
			beginContent(false, false);
			const commentEnd =
				source[index + 1] === "=" ? consumeBlockComment(source, index) : consumeLineComment(source, index);
			const containsNewline = appendOpaque(index, commentEnd);
			if (containsNewline) {
				canEndExpression = false;
				previousToken = "none";
			}
			index = commentEnd;
			continue;
		}

		if (character === '"') {
			beginContent(false, false);
			const literalKind = source.startsWith('"""', index) ? "triple" : "double";
			const literalEnd = consumeQuotedLiteral(source, index, literalKind);
			appendOpaque(index, literalEnd);
			index = literalEnd;
			canEndExpression = true;
			previousToken = "other";
			continue;
		}

		if (character === "`") {
			beginContent(false, false);
			const literalEnd = consumeQuotedLiteral(source, index, "command");
			appendOpaque(index, literalEnd);
			index = literalEnd;
			canEndExpression = true;
			previousToken = "other";
			continue;
		}

		if (character === "'") {
			beginContent(false, false);
			if (canEndExpression) {
				output.push(character);
				index++;
				previousToken = "other";
				continue;
			}
			const literalEnd = consumeQuotedLiteral(source, index, "char");
			appendOpaque(index, literalEnd);
			index = literalEnd;
			canEndExpression = true;
			previousToken = "other";
			continue;
		}

		if (isIdentifierStart(character)) {
			const wordStart = index;
			index++;
			while (index < source.length && isIdentifierContinue(source[index])) index++;
			const word = source.slice(wordStart, index);
			const isStructural =
				delimiterClosers.length === 0 &&
				previousToken !== "dot" &&
				previousToken !== "colon" &&
				previousToken !== "at";
			const isEnd = isStructural && word === "end";
			const isBranch = isStructural && BRANCH_CLAUSES[word] === true;
			beginContent(isEnd || isBranch, false);
			output.push(word);

			if (isEnd) blockDepth = Math.max(0, blockDepth - 1);
			else if (isStructural && BLOCK_OPENERS[word] === true) blockDepth++;

			canEndExpression = EXPRESSION_PREFIX_WORDS[word] !== true;
			previousToken = "other";
			continue;
		}

		if (character === "(" || character === "[" || character === "{") {
			beginContent(false, false);
			output.push(character);
			delimiterClosers.push(character === "(" ? ")" : character === "[" ? "]" : "}");
			canEndExpression = false;
			previousToken = "other";
			index++;
			continue;
		}

		if (character === ")" || character === "]" || character === "}") {
			const matchesDelimiter = delimiterClosers.at(-1) === character;
			beginContent(false, matchesDelimiter);
			output.push(character);
			if (matchesDelimiter) delimiterClosers.pop();
			canEndExpression = true;
			previousToken = "other";
			index++;
			continue;
		}

		if (character === ";" && delimiterClosers.length === 0) {
			beginContent(false, false);
			output.push(";\n");
			atLineStart = true;
			pendingWhitespace = "";
			suppressSourceNewline = true;
			canEndExpression = false;
			previousToken = "none";
			index++;
			continue;
		}

		beginContent(false, false);
		output.push(character);
		if (character === ".") previousToken = "dot";
		else if (character === ":") previousToken = "colon";
		else if (character === "@") previousToken = "at";
		else previousToken = "other";
		canEndExpression = !isExpressionSeparator(character);
		index++;
	}

	return output.join("");
}
