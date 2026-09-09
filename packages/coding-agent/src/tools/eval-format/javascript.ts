type PendingBreak = "brace" | "statement" | "close";

interface ParenFrame {
	forHeader: boolean;
	controlHeader: boolean;
}

interface TemplateTextFrame {
	kind: "text";
}

interface TemplateExpressionFrame {
	kind: "expression";
	braceDepth: number;
	regexAllowed: boolean;
}

type TemplateFrame = TemplateTextFrame | TemplateExpressionFrame;

const CONTROL_HEADER_WORDS: Record<string, true> = {
	catch: true,
	for: true,
	if: true,
	switch: true,
	while: true,
	with: true,
};
const REGEX_PREFIX_WORDS: Record<string, true> = {
	await: true,
	case: true,
	delete: true,
	do: true,
	else: true,
	extends: true,
	in: true,
	instanceof: true,
	new: true,
	of: true,
	return: true,
	throw: true,
	typeof: true,
	void: true,
	yield: true,
};
const CLOSE_CONTINUATIONS = ["else", "catch", "finally"];

function isIdentifierStart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return char === "$" || char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128;
}

function isIdentifierPart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function scanIdentifier(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && isIdentifierPart(source[index])) index++;
	return index;
}

function scanNumber(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && /[\w.]/.test(source[index])) index++;
	return index;
}

function scanQuoted(source: string, start: number): number {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (source[index] === quote) return index + 1;
		index++;
	}
	return source.length;
}

function scanLineComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
	return index;
}

function scanBlockComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length) {
		if (source[index] === "*" && source[index + 1] === "/") return index + 2;
		index++;
	}
	return source.length;
}

function scanRegex(source: string, start: number): number {
	let index = start + 1;
	let inCharacterClass = false;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === "[") inCharacterClass = true;
		else if (char === "]") inCharacterClass = false;
		else if (char === "/" && !inCharacterClass) {
			index++;
			while (index < source.length && isIdentifierPart(source[index])) index++;
			return index;
		}
		index++;
	}
	return source.length;
}

function scanTemplate(source: string, start: number): number {
	const frames: TemplateFrame[] = [{ kind: "text" }];
	let index = start + 1;

	while (index < source.length) {
		const frame = frames[frames.length - 1];
		if (!frame) return index;
		const char = source[index];
		const next = source[index + 1];

		if (frame.kind === "text") {
			if (char === "\\") {
				index += index + 1 < source.length ? 2 : 1;
			} else if (char === "`") {
				frames.pop();
				index++;
				if (frames.length === 0) return index;
				const parent = frames[frames.length - 1];
				if (parent?.kind === "expression") parent.regexAllowed = false;
			} else if (char === "$" && next === "{") {
				frames.push({ kind: "expression", braceDepth: 1, regexAllowed: true });
				index += 2;
			} else {
				index++;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			index = scanQuoted(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "`") {
			frames.push({ kind: "text" });
			index++;
			continue;
		}
		if (char === "/" && next === "/") {
			index = scanLineComment(source, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(source, index);
			continue;
		}
		if (char === "/" && frame.regexAllowed) {
			index = scanRegex(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			frame.regexAllowed = REGEX_PREFIX_WORDS[source.slice(index, end)] === true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			index = scanNumber(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "{") {
			frame.braceDepth++;
			frame.regexAllowed = true;
			index++;
			continue;
		}
		if (char === "}") {
			frame.braceDepth--;
			index++;
			if (frame.braceDepth === 0) frames.pop();
			else frame.regexAllowed = false;
			continue;
		}
		if ((char === "+" && next === "+") || (char === "-" && next === "-")) {
			frame.regexAllowed = false;
			index += 2;
			continue;
		}
		if (char === ")" || char === "]" || char === ".") frame.regexAllowed = false;
		else if (!/\s/.test(char)) frame.regexAllowed = true;
		index++;
	}

	return source.length;
}

function canJoinCloseWithWord(word: string, atSourceEnd: boolean): boolean {
	return CLOSE_CONTINUATIONS.some(keyword => keyword === word || (atSourceEnd && keyword.startsWith(word)));
}

function canAttachToClose(char: string): boolean {
	return "();,.)]:?+-*/%&|^<>=!".includes(char);
}

const JS_DISPLAY_MAX_LINE_WIDTH = 100;
const JS_DISPLAY_INDENT = "    ";
const BLOCK_BRACE_WORDS: Record<string, true> = {
	catch: true,
	class: true,
	do: true,
	else: true,
	finally: true,
	for: true,
	function: true,
	if: true,
	switch: true,
	try: true,
	while: true,
	with: true,
};
const OBJECT_PREFIX_WORDS: Record<string, true> = {
	const: true,
	default: true,
	let: true,
	return: true,
	throw: true,
	var: true,
	yield: true,
};

interface DisplayBraceNode {
	start: number;
	end?: number;
	object: boolean;
	children: DisplayBraceNode[];
}

function classifySourceBraces(source: string): boolean[] {
	const objects: boolean[] = [];
	const statementWords: string[] = [];
	let previousToken = "";
	let previousWord = "";
	let regexAllowed = true;

	for (let index = 0; index < source.length;) {
		const char = source[index];
		const next = source[index + 1];
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === "/" && next === "/") {
			index = scanLineComment(source, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(source, index);
			continue;
		}
		if (char === "'" || char === '"') {
			index = scanQuoted(source, index);
			regexAllowed = false;
			continue;
		}
		if (char === "`") {
			index = scanTemplate(source, index);
			regexAllowed = false;
			continue;
		}
		if (char === "/" && regexAllowed) {
			index = scanRegex(source, index);
			regexAllowed = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			const word = source.slice(index, end);
			statementWords.push(word);
			previousWord = word;
			previousToken = word;
			regexAllowed = REGEX_PREFIX_WORDS[word] === true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			index = scanNumber(source, index);
			previousToken = "value";
			previousWord = "";
			regexAllowed = false;
			continue;
		}
		if (char === "{") {
			const isBlock =
				previousToken === "=>" ||
				previousToken === ")" ||
				previousToken === "}" ||
				BLOCK_BRACE_WORDS[previousWord] === true ||
				statementWords.some(word => word === "class" || word === "function" || word === "switch");
			const isObject =
				!isBlock &&
				(previousToken === "=" ||
					previousToken === ":" ||
					previousToken === "," ||
					previousToken === "(" ||
					previousToken === "[" ||
					previousToken === ";" ||
					previousToken === "" ||
					OBJECT_PREFIX_WORDS[previousWord] === true);
			objects.push(isObject);
			if (isBlock) statementWords.length = 0;
			previousToken = "{";
			previousWord = "";
			regexAllowed = true;
			index++;
			continue;
		}
		if (char === "}") {
			previousToken = "}";
			previousWord = "";
			regexAllowed = false;
			index++;
			continue;
		}
		if (char === ";") {
			statementWords.length = 0;
			previousToken = ";";
			previousWord = "";
			regexAllowed = true;
			index++;
			continue;
		}
		if (char === ")") {
			previousToken = ")";
			previousWord = "";
			regexAllowed = false;
			index++;
			continue;
		}
		if (char === "]" || char === ".") {
			previousToken = char;
			previousWord = "";
			regexAllowed = false;
			index++;
			continue;
		}
		if (char === "=" && next === ">") {
			previousToken = "=>";
			previousWord = "";
			regexAllowed = true;
			index += 2;
			continue;
		}
		previousToken = char;
		previousWord = "";
		regexAllowed = char !== ")" && char !== "]" && char !== ".";
		index++;
	}
	return objects;
}

function collectDisplayBraceNodes(text: string, objectFlags: readonly boolean[]): DisplayBraceNode[] {
	const roots: DisplayBraceNode[] = [];
	const stack: DisplayBraceNode[] = [];
	let openingIndex = 0;

	for (let index = 0; index < text.length;) {
		const char = text[index];
		const next = text[index + 1];
		if (char === "/" && next === "/") {
			index = scanLineComment(text, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(text, index);
			continue;
		}
		if (char === "'" || char === '"') {
			index = scanQuoted(text, index);
			continue;
		}
		if (char === "`") {
			index = scanTemplate(text, index);
			continue;
		}
		if (char === "{") {
			const node: DisplayBraceNode = {
				start: index,
				object: objectFlags[openingIndex] === true,
				children: [],
			};
			openingIndex++;
			const parent = stack[stack.length - 1];
			if (parent) parent.children.push(node);
			else roots.push(node);
			stack.push(node);
			index++;
			continue;
		}
		if (char === "}") {
			const node = stack.pop();
			if (node) node.end = index;
			index++;
			continue;
		}
		index++;
	}
	return roots;
}

function collapseDisplayWhitespace(text: string): string | undefined {
	const output: string[] = [];
	let pendingSpace = false;
	for (let index = 0; index < text.length;) {
		const char = text[index];
		const next = text[index + 1];
		if (char === "\n" || char === "\r" || /\s/.test(char)) {
			pendingSpace = true;
			index++;
			continue;
		}
		if (char === "/" && next === "/") return undefined;
		if (char === "/" && next === "*") {
			const end = scanBlockComment(text, index);
			if (pendingSpace && output.length > 0) output.push(" ");
			output.push(text.slice(index, end));
			pendingSpace = false;
			index = end;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			const end = char === "`" ? scanTemplate(text, index) : scanQuoted(text, index);
			const literal = text.slice(index, end);
			if (literal.includes("\n") || literal.includes("\r")) return undefined;
			if (pendingSpace && output.length > 0) output.push(" ");
			output.push(literal);
			pendingSpace = false;
			index = end;
			continue;
		}
		if (pendingSpace && output.length > 0) output.push(" ");
		pendingSpace = false;
		output.push(char);
		index++;
	}
	return output.join("").trim();
}

function splitDisplayObjectProperties(text: string): string[] {
	const properties: string[] = [];
	let start = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "(") parenDepth++;
		else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
		else if (char === "[") bracketDepth++;
		else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		else if (char === "{") braceDepth++;
		else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
		else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			properties.push(text.slice(start, index + 1));
			start = index + 1;
		}
	}
	properties.push(text.slice(start));
	return properties;
}

function formatDisplayObjectLiterals(formatted: string, source: string): string {
	const roots = collectDisplayBraceNodes(formatted, classifySourceBraces(source));

	function renderRange(
		start: number,
		end: number,
		children: readonly DisplayBraceNode[],
		childIndent: string,
	): string {
		const output: string[] = [];
		let cursor = start;
		for (const child of children) {
			if (child.start < start || child.start >= end) continue;
			output.push(formatted.slice(cursor, child.start));
			output.push(renderNode(child, childIndent));
			cursor = child.end === undefined ? end : child.end + 1;
		}
		output.push(formatted.slice(cursor, end));
		return output.join("");
	}

	function renderNode(node: DisplayBraceNode, parentIndent: string): string {
		const lineStart = Math.max(0, formatted.lastIndexOf("\n", node.start - 1) + 1);
		const linePrefix = formatted.slice(lineStart, node.start);
		const ownIndent = /^[ \t]*$/.test(linePrefix) ? linePrefix : parentIndent;
		const propertyIndent = ownIndent + JS_DISPLAY_INDENT;
		const closed = node.end !== undefined;
		const end = node.end ?? formatted.length;
		if (!node.object) {
			return `{${renderRange(node.start + 1, end, node.children, propertyIndent)}${closed ? "}" : ""}`;
		}

		// Walk the body left to right and decide the layout at the FIRST decisive
		// event, so the decision is a pure function of the source prefix and never
		// flips as more code streams in:
		// - a raw newline or a multi-line block child commits lines with the
		//   original inline layout -> verbatim forever;
		// - a nested object exploding, or the flat width passing the cap,
		//   explodes this object (and, transitively, every enclosing inline
		//   object in this same render pass).
		let mode: "inline" | "verbatim" | "explode" = "inline";
		let width = node.start - lineStart + 4;
		const pieces: string[] = [];
		let cursor = node.start + 1;
		const consume = (text: string, blockLike: boolean) => {
			pieces.push(text);
			if (mode !== "inline" || text.length === 0) return;
			if (text.includes("\n") || text.includes("\r")) {
				mode = blockLike ? "verbatim" : "explode";
				return;
			}
			width += text.length;
			if (width > JS_DISPLAY_MAX_LINE_WIDTH) mode = "explode";
		};
		for (const child of node.children) {
			if (child.start < node.start + 1 || child.start >= end) continue;
			consume(formatted.slice(cursor, child.start), true);
			consume(renderNode(child, propertyIndent), !child.object);
			cursor = child.end === undefined ? end : child.end + 1;
		}
		consume(formatted.slice(cursor, end), true);
		const body = pieces.join("");

		if (mode === "inline") {
			const flat = collapseDisplayWhitespace(body);
			if (flat === undefined) mode = "verbatim";
			else if (!closed) return flat.length > 0 ? `{ ${flat}` : "{";
			else return flat.length > 0 ? `{ ${flat} }` : "{}";
		}
		if (mode === "verbatim") {
			return `{${body}${closed ? "}" : ""}`;
		}

		const properties = splitDisplayObjectProperties(body)
			.map(property => property.trim())
			.filter(property => property.length > 0);
		if (properties.length === 0) return closed ? "{}" : "{";
		const lines = properties.map(property => `${propertyIndent}${property}`);
		return `{\n${lines.join("\n")}${closed ? `\n${ownIndent}}` : ""}`;
	}

	return renderRange(0, formatted.length, roots, "");
}

/**
 * Finds the next operator token eligible for spacing normalization. Angle
 * brackets and bare `*` are intentionally excluded: generics (`Map<K, V>`) and
 * generators (`function*`) would be mangled by binary-operator spacing.
 */
function scanDisplayOperator(source: string, start: number): string | undefined {
	const three = source.slice(start, start + 3);
	if (three === "===" || three === "!==" || three === "**=" || three === "&&=" || three === "||=" || three === "??=") {
		return three;
	}
	const two = source.slice(start, start + 2);
	if (
		two === "=>" ||
		two === "==" ||
		two === "!=" ||
		two === "&&" ||
		two === "||" ||
		two === "??" ||
		two === "++" ||
		two === "--" ||
		two === "+=" ||
		two === "-=" ||
		two === "*=" ||
		two === "/=" ||
		two === "%=" ||
		two === "&=" ||
		two === "|=" ||
		two === "^=" ||
		two === "**"
	) {
		return two;
	}
	return "=+-/%&|^!?:,".includes(source[start]) ? source[start] : undefined;
}

function operatorSpacing(token: string, unary: boolean, ternaryPending: boolean): { before: boolean; after: boolean } {
	if (token === ",") return { before: false, after: true };
	if (token === ":") return { before: ternaryPending, after: true };
	if (token === "?") return { before: true, after: true };
	if (token === "!" || unary || token === "++" || token === "--") {
		return { before: false, after: false };
	}
	return { before: true, after: true };
}

/** Formats JavaScript/TypeScript-like eval source for safe, stable display without requiring valid syntax. */
export function formatJavaScriptForDisplay(source: string): string {
	const output: string[] = [];
	const parens: ParenFrame[] = [];
	const sourceObjectBraces = classifySourceBraces(source);
	const braceKinds: Array<"object" | "block"> = [];
	let sourceBraceIndex = 0;
	let index = 0;
	let indent = 0;
	let atLineStart = true;
	let lastChar = "";
	let pendingWhitespace = "";
	let pendingBreak: PendingBreak | undefined;
	let pendingOperatorSpace = false;
	let ternaryPending = false;
	let afterForSemicolon = false;
	let regexAllowed = true;
	let pendingFor = false;
	let lastWord = "";
	let lastTokenWasWord = false;

	function append(text: string): void {
		if (!text) return;
		output.push(text);
		lastChar = text[text.length - 1];
		const newline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
		atLineStart = newline >= 0 ? newline === text.length - 1 : false;
	}

	function newline(): void {
		output.push("\n");
		lastChar = "\n";
		atLineStart = true;
	}

	function whitespaceWidth(text: string): number {
		let width = 0;
		for (const char of text) width += char === "\t" ? 4 - (width % 4) : 1;
		return width;
	}

	function trimTrailingHorizontalWhitespace(): void {
		for (let index = output.length - 1; index >= 0; index--) {
			const chunk = output[index];
			const trimmed = chunk.replace(/[ \t]+$/, "");
			if (trimmed !== chunk) {
				if (trimmed.length > 0) output[index] = trimmed;
				else output.splice(index, 1);
			}
			if (trimmed.length > 0 || chunk.includes("\n") || chunk.includes("\r")) break;
		}
		for (let index = output.length - 1; index >= 0; index--) {
			const chunk = output[index];
			if (chunk.length > 0) {
				lastChar = chunk[chunk.length - 1];
				return;
			}
		}
		lastChar = "";
	}

	function flushWhitespace(): void {
		if (atLineStart) {
			const width = Math.max(indent * 4, whitespaceWidth(pendingWhitespace));
			if (width > 0) append(" ".repeat(width));
		} else if (pendingWhitespace.length > 0) {
			append(" ");
		}
		pendingWhitespace = "";
	}

	function flushOperatorSpace(nextText: string): void {
		if (!pendingOperatorSpace) return;
		if (!atLineStart && lastChar !== " " && !")]},.;".includes(nextText[0] ?? "")) append(" ");
		pendingWhitespace = "";
		pendingOperatorSpace = false;
	}

	function appendOperator(token: string, before: boolean, after: boolean): void {
		trimTrailingHorizontalWhitespace();
		if (before && !atLineStart && lastChar !== " " && lastChar !== "\n") append(" ");
		append(token);
		pendingOperatorSpace = after;
	}

	function forceBreak(): void {
		pendingWhitespace = "";
		pendingOperatorSpace = false;
		if (!atLineStart) newline();
		pendingBreak = undefined;
	}

	function prepareToken(kind: "word" | "punctuation" | "value", text: string, end: number): void {
		flushOperatorSpace(text);
		if (pendingBreak === "close") {
			if (kind === "word" && canJoinCloseWithWord(text, end === source.length)) {
				pendingWhitespace = "";
				if (!atLineStart && lastChar !== " ") append(" ");
				pendingBreak = undefined;
			} else if (kind === "punctuation" && canAttachToClose(text[0])) {
				pendingWhitespace = "";
				pendingBreak = undefined;
			} else {
				forceBreak();
			}
		} else if (pendingBreak) {
			forceBreak();
		}

		if (afterForSemicolon) {
			if (text !== ";" && text !== ")" && !atLineStart && pendingWhitespace.length === 0) append(" ");
			afterForSemicolon = false;
		}
	}

	function appendComment(end: number): void {
		const comment = source.slice(index, end);
		if (pendingBreak) {
			if (pendingWhitespace.length > 0) append(pendingWhitespace);
			else if (!atLineStart) append(" ");
			pendingWhitespace = "";
		} else {
			flushWhitespace();
		}
		append(comment);
		if (comment.includes("\n") || comment.includes("\r")) pendingBreak = undefined;
		if (afterForSemicolon) afterForSemicolon = false;
	}

	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];

		if (char === "\n" || char === "\r") {
			pendingWhitespace = "";
			pendingOperatorSpace = false;
			pendingBreak = undefined;
			afterForSemicolon = false;
			newline();
			index += char === "\r" && next === "\n" ? 2 : 1;
			continue;
		}
		if (/\s/.test(char)) {
			const start = index;
			while (index < source.length && /[^\S\r\n]/.test(source[index])) index++;
			pendingWhitespace += source.slice(start, index);
			continue;
		}
		if (char === "/" && next === "/") {
			const end = scanLineComment(source, index);
			appendComment(end);
			index = end;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = scanBlockComment(source, index);
			appendComment(end);
			index = end;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = scanQuoted(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "`") {
			const end = scanTemplate(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "/" && regexAllowed) {
			const end = scanRegex(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			const word = source.slice(index, end);
			prepareToken("word", word, end);
			flushWhitespace();
			append(word);
			if (word === "for") pendingFor = true;
			else if (!(pendingFor && word === "await")) pendingFor = false;
			regexAllowed = REGEX_PREFIX_WORDS[word] === true;
			lastWord = word;
			lastTokenWasWord = true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			const end = scanNumber(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "{") {
			const objectBrace = sourceObjectBraces[sourceBraceIndex] === true;
			sourceBraceIndex++;
			braceKinds.push(objectBrace ? "object" : "block");
			prepareToken("punctuation", char, index + 1);
			const hadWhitespace = pendingWhitespace.length > 0;
			flushWhitespace();
			if (!atLineStart && !hadWhitespace && !" ([{".includes(lastChar)) append(" ");
			append(char);
			if (!objectBrace) {
				indent++;
				pendingBreak = "brace";
			}
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === "}") {
			const braceKind = braceKinds.pop() ?? "block";
			prepareToken("punctuation", char, index + 1);
			if (braceKind === "object") {
				// Multi-line object closers keep their line indentation; inline
				// closers attach tight so the post-pass controls the spacing.
				if (atLineStart) flushWhitespace();
				else {
					pendingWhitespace = "";
					trimTrailingHorizontalWhitespace();
				}
				append(char);
				pendingBreak = undefined;
			} else {
				pendingWhitespace = "";
				if (!atLineStart) newline();
				indent = Math.max(0, indent - 1);
				flushWhitespace();
				append(char);
				pendingBreak = "close";
			}
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === ";") {
			prepareToken("punctuation", char, index + 1);
			flushWhitespace();
			append(char);
			const frame = parens[parens.length - 1];
			if (frame?.forHeader) afterForSemicolon = true;
			else pendingBreak = "statement";
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === "(") {
			const forHeader = pendingFor;
			const controlHeader = forHeader || (lastTokenWasWord && CONTROL_HEADER_WORDS[lastWord] === true);
			prepareToken("punctuation", char, index + 1);
			const needsSpace = controlHeader && pendingWhitespace.length === 0 && !atLineStart;
			flushWhitespace();
			if (needsSpace) append(" ");
			append(char);
			parens.push({ forHeader, controlHeader });
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === ")") {
			prepareToken("punctuation", char, index + 1);
			flushWhitespace();
			append(char);
			const frame = parens.pop();
			regexAllowed = frame?.controlHeader ?? false;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}

		const operator = scanDisplayOperator(source, index);
		if (operator && !(operator === "?" && (next === "." || next === ":"))) {
			// In a regex-eligible position the previous token was an operator or
			// keyword, so `+`/`-` here are unary signs, not binary operators.
			const unary = (operator === "+" || operator === "-") && regexAllowed;
			prepareToken("punctuation", operator, index + operator.length);
			flushWhitespace();
			const spacing = operatorSpacing(operator, unary, ternaryPending);
			appendOperator(operator, spacing.before, spacing.after);
			if (operator === "?") ternaryPending = true;
			else if (operator === ":") ternaryPending = false;
			regexAllowed = operator !== "++" && operator !== "--";
			pendingFor = false;
			lastTokenWasWord = false;
			index += operator.length;
			continue;
		}

		const doubledPostfix = (char === "+" && next === "+") || (char === "-" && next === "-");
		const token = doubledPostfix ? source.slice(index, index + 2) : char;
		prepareToken("punctuation", token, index + token.length);
		flushWhitespace();
		append(token);
		if (doubledPostfix || char === "]" || char === ".") regexAllowed = false;
		else regexAllowed = true;
		pendingFor = false;
		lastTokenWasWord = false;
		index += token.length;
	}

	const formatted = output.join("");
	try {
		return formatDisplayObjectLiterals(formatted, source);
	} catch {
		return formatted;
	}
}
