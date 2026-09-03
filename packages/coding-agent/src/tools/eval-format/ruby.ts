const INDENT = "    ";

const OPENING_KEYWORDS: Record<string, true> = {
	begin: true,
	case: true,
	class: true,
	def: true,
	for: true,
	if: true,
	module: true,
	unless: true,
	until: true,
	while: true,
};

const BRANCH_KEYWORDS: Record<string, true> = {
	else: true,
	elsif: true,
	ensure: true,
	rescue: true,
	when: true,
};

const PAIRED_DELIMITERS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
	"<": ">",
};

type Quote = "'" | '"' | "`";

interface QuotedContext {
	kind: "quoted";
	quote: Quote;
	interpolated: boolean;
	escaped: boolean;
}

interface PercentContext {
	kind: "percent";
	open: string;
	close: string;
	depth: number;
	interpolated: boolean;
	escaped: boolean;
}

interface InterpolationContext {
	kind: "interpolation";
	braceDepth: number;
}

interface CommentContext {
	kind: "comment";
}

type LexicalContext = QuotedContext | PercentContext | InterpolationContext | CommentContext;

interface PercentLiteralStart {
	end: number;
	open: string;
	close: string;
	interpolated: boolean;
}

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\f" || character === "\v";
}

function isIdentifierStart(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_";
}

function isIdentifierPart(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return isIdentifierStart(character) || (code >= 48 && code <= 57);
}

function findPercentLiteral(source: string, start: number): PercentLiteralStart | undefined {
	let delimiterIndex = start + 1;
	let type = "";
	const candidateType = source[delimiterIndex];
	if (candidateType !== undefined && "qQwWiIxrs".includes(candidateType)) {
		type = candidateType;
		delimiterIndex++;
	}

	const open = source[delimiterIndex];
	if (open === undefined || isIdentifierPart(open) || /\s/.test(open)) return undefined;
	return {
		end: delimiterIndex + 1,
		open,
		close: PAIRED_DELIMITERS[open] ?? open,
		interpolated: type === "" || type === "Q" || type === "W" || type === "I" || type === "x" || type === "r",
	};
}

function formatRubyPrefix(source: string): string {
	const output: string[] = [];
	const contexts: LexicalContext[] = [];
	const delimiters: string[] = [];
	let lineParts: string[] = [];
	let lineHasVisibleText = false;
	let preserveLeadingWhitespace = false;
	let pendingSemicolonBreak = false;
	let blockDepth = 0;
	let hasSignificantToken = false;
	let leadingWord: string | null = null;
	let previousToken = "";
	let hasDo = false;
	let endCount = 0;
	let endlessDefinition = false;

	const append = (text: string): void => {
		lineParts.push(text);
		if (lineHasVisibleText) return;
		for (let index = 0; index < text.length; index++) {
			if (!isHorizontalWhitespace(text[index])) {
				lineHasVisibleText = true;
				return;
			}
		}
	};

	const observeOtherToken = (value: string): void => {
		if (!hasSignificantToken) {
			hasSignificantToken = true;
			leadingWord = null;
		}
		previousToken = value;
	};

	const resetLine = (): void => {
		lineParts = [];
		lineHasVisibleText = false;
		preserveLeadingWhitespace = contexts.length > 0 || delimiters.length > 0;
		hasSignificantToken = false;
		leadingWord = null;
		previousToken = "";
		hasDo = false;
		endCount = 0;
		endlessDefinition = false;
	};

	const flushLine = (ending: string): void => {
		const raw = lineParts.join("");
		const leadingEnd = leadingWord === "end";
		const branch = leadingWord !== null && BRANCH_KEYWORDS[leadingWord] === true;
		const opens =
			!endlessDefinition &&
			((leadingWord !== null && OPENING_KEYWORDS[leadingWord] === true) || (!leadingEnd && !branch && hasDo));
		const indentation = leadingEnd || branch ? Math.max(0, blockDepth - 1) : blockDepth;
		blockDepth = Math.max(0, blockDepth + (opens ? 1 : 0) - endCount);

		if (preserveLeadingWhitespace) {
			output.push(raw, ending);
			return;
		}

		let contentStart = 0;
		while (contentStart < raw.length && isHorizontalWhitespace(raw[contentStart])) contentStart++;
		const content = raw.slice(contentStart);
		output.push(content.length === 0 ? "" : INDENT.repeat(indentation) + content, ending);
	};

	for (let index = 0; index < source.length;) {
		const character = source[index];
		if (character === "\n" || character === "\r") {
			const ending = character === "\r" && source[index + 1] === "\n" ? "\r\n" : character;
			const top = contexts[contexts.length - 1];
			if (top?.kind === "comment") {
				contexts.pop();
			} else if (top?.kind === "quoted" || top?.kind === "percent") {
				top.escaped = false;
			}

			if (pendingSemicolonBreak && !lineHasVisibleText) {
				pendingSemicolonBreak = false;
				resetLine();
			} else {
				flushLine(ending);
				pendingSemicolonBreak = false;
				resetLine();
			}
			index += ending.length;
			continue;
		}

		const top = contexts[contexts.length - 1];
		if (top?.kind === "comment") {
			append(character);
			index++;
			continue;
		}

		if (top?.kind === "quoted") {
			append(character);
			if (top.escaped) {
				top.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				top.escaped = true;
				index++;
				continue;
			}
			if (top.interpolated && character === "#" && source[index + 1] === "{") {
				append("{");
				contexts.push({ kind: "interpolation", braceDepth: 1 });
				index += 2;
				continue;
			}
			if (character === top.quote) contexts.pop();
			index++;
			continue;
		}

		if (top?.kind === "percent") {
			append(character);
			if (top.escaped) {
				top.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				top.escaped = true;
				index++;
				continue;
			}
			if (top.interpolated && character === "#" && source[index + 1] === "{") {
				append("{");
				contexts.push({ kind: "interpolation", braceDepth: 1 });
				index += 2;
				continue;
			}
			if (top.open !== top.close && character === top.open) {
				top.depth++;
			} else if (character === top.close) {
				top.depth--;
				if (top.depth === 0) contexts.pop();
			}
			index++;
			continue;
		}

		const interpolation = top?.kind === "interpolation" ? top : undefined;
		const inRootCode = interpolation === undefined;
		if (interpolation !== undefined && character === "}") {
			append(character);
			interpolation.braceDepth--;
			if (interpolation.braceDepth === 0) contexts.pop();
			index++;
			continue;
		}

		if (character === "#") {
			append(character);
			contexts.push({ kind: "comment" });
			index++;
			continue;
		}

		if (character === "'" || character === '"' || character === "`") {
			if (inRootCode && delimiters.length === 0) observeOtherToken("literal");
			append(character);
			contexts.push({ kind: "quoted", quote: character, interpolated: character !== "'", escaped: false });
			index++;
			continue;
		}

		if (character === "%") {
			const literal = findPercentLiteral(source, index);
			if (literal !== undefined) {
				if (inRootCode && delimiters.length === 0) observeOtherToken("literal");
				append(source.slice(index, literal.end));
				contexts.push({
					kind: "percent",
					open: literal.open,
					close: literal.close,
					depth: 1,
					interpolated: literal.interpolated,
					escaped: false,
				});
				index = literal.end;
				continue;
			}
		}

		if (isIdentifierStart(character)) {
			let end = index + 1;
			while (isIdentifierPart(source[end])) end++;
			if (source[end] === "?" || source[end] === "!") end++;
			const word = source.slice(index, end);
			append(word);

			if (inRootCode && delimiters.length === 0) {
				const blockedByPrefix =
					previousToken === ":" || previousToken === "." || previousToken === "@" || previousToken === "$";
				const label = source[end] === ":" && source[end + 1] !== ":";
				const eligible = !blockedByPrefix && !label;
				if (!hasSignificantToken) {
					hasSignificantToken = true;
					leadingWord = eligible ? word : null;
				}
				if (eligible && word === "do") hasDo = true;
				if (eligible && word === "end") endCount++;
				previousToken = "word";
			}
			index = end;
			continue;
		}

		if (interpolation !== undefined && character === "{") {
			append(character);
			interpolation.braceDepth++;
			index++;
			continue;
		}

		if (inRootCode && (character === "(" || character === "[" || character === "{")) {
			if (delimiters.length === 0) observeOtherToken(character);
			append(character);
			delimiters.push(character);
			index++;
			continue;
		}

		if (inRootCode && (character === ")" || character === "]" || character === "}")) {
			append(character);
			const open = delimiters[delimiters.length - 1];
			if (open !== undefined && PAIRED_DELIMITERS[open] === character) delimiters.pop();
			if (delimiters.length === 0) observeOtherToken(character);
			index++;
			continue;
		}

		if (character === ";") {
			append(character);
			if (inRootCode && delimiters.length === 0) {
				observeOtherToken(character);
				flushLine("\n");
				pendingSemicolonBreak = true;
				resetLine();
			}
			index++;
			continue;
		}

		append(character);
		if (inRootCode && delimiters.length === 0 && !isHorizontalWhitespace(character)) {
			if (
				character === "=" &&
				leadingWord === "def" &&
				/\s/.test(source[index - 1] ?? "") &&
				source[index + 1] !== "="
			) {
				endlessDefinition = true;
			}
			observeOtherToken(character);
		}
		index++;
	}

	if (lineParts.length > 0 && !(pendingSemicolonBreak && !lineHasVisibleText)) flushLine("");
	return output.join("");
}

/** Formats an arbitrary Ruby source prefix for display without requiring valid syntax. */
export function formatRubyForDisplay(source: string): string {
	try {
		return formatRubyPrefix(source);
	} catch {
		return source;
	}
}
