type HeaderKind =
	| "def"
	| "class"
	| "if"
	| "elif"
	| "else"
	| "for"
	| "while"
	| "try"
	| "except"
	| "finally"
	| "with"
	| "match"
	| "case"
	| "async def"
	| "async for"
	| "async with";

type ChainKind = "if" | "loop" | "try" | "match";

interface Word {
	text: string;
	end: number;
}

interface Header {
	kind: HeaderKind;
	end: number;
}

interface BlockFrame {
	kind: HeaderKind;
	chain: ChainKind | null;
	headerIndent: number;
	sourceIndent: number;
	previousChain: number;
}

interface DelimiterFrame {
	opener: string;
	outputIndent: number;
}

interface PendingSuiteColon {
	kind: HeaderKind;
	chain: ChainKind | null;
	headerIndent: number;
	sourceIndent: number;
	afterColon: string[];
}

interface StringState {
	quote: string;
	triple: boolean;
	escaped: boolean;
}

interface ClauseAlignment {
	indent: number;
	chain: ChainKind | null;
}

function isWordStart(char: string | undefined): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWordPart(char: string): boolean {
	const code = char.charCodeAt(0);
	return isWordStart(char) || (code >= 48 && code <= 57);
}

function readWord(source: string, start: number): Word {
	let end = start;
	while (end < source.length && isWordPart(source[end])) end++;
	return { text: source.slice(start, end), end };
}

function simpleHeader(word: Word): Header | null {
	switch (word.text) {
		case "def":
		case "class":
		case "if":
		case "elif":
		case "else":
		case "for":
		case "while":
		case "try":
		case "except":
		case "finally":
		case "with":
		case "match":
		case "case":
			return { kind: word.text, end: word.end };
		default:
			return null;
	}
}

function readHeader(source: string, start: number): Header | null {
	if (!isWordStart(source[start])) return null;
	const first = readWord(source, start);
	if (first.text !== "async") return simpleHeader(first);

	let next = first.end;
	while (source[next] === " " || source[next] === "\t") next++;
	if (!isWordStart(source[next])) return null;
	const second = readWord(source, next);
	switch (second.text) {
		case "def":
			return { kind: "async def", end: second.end };
		case "for":
			return { kind: "async for", end: second.end };
		case "with":
			return { kind: "async with", end: second.end };
		default:
			return null;
	}
}

function defaultChain(kind: HeaderKind): ChainKind | null {
	switch (kind) {
		case "if":
		case "elif":
		case "else":
			return "if";
		case "for":
		case "while":
		case "async for":
			return "loop";
		case "try":
		case "except":
		case "finally":
			return "try";
		case "match":
		case "case":
			return "match";
		default:
			return null;
	}
}

function canOpenSuite(kind: HeaderKind, hasPayload: boolean): boolean {
	switch (kind) {
		case "else":
		case "try":
		case "finally":
			return !hasPayload;
		case "except":
			return true;
		default:
			return hasPayload;
	}
}

function matchingCloser(opener: string, closer: string): boolean {
	return (
		(opener === "(" && closer === ")") || (opener === "[" && closer === "]") || (opener === "{" && closer === "}")
	);
}

function formatPythonPrefix(source: string): string {
	const chunks: string[] = [];
	const blocks: BlockFrame[] = [];
	const delimiters: DelimiterFrame[] = [];
	const chainTops: Record<ChainKind, number> = { if: -1, loop: -1, try: -1, match: -1 };
	const pendingHorizontal: string[] = [];

	let outputLineStart = true;
	let lineIndent: number | null = null;
	let currentOutputIndent = 0;
	let sourceLineStart = true;
	let sourceIndent = 0;
	let currentSourceIndent = 0;
	let skipGeneratedNewline = false;

	let statementPrepared = false;
	let statementKind: HeaderKind | null = null;
	let statementHeaderEnd = -1;
	let statementHasPayload = false;
	let statementIndent = 0;
	let statementSourceIndent = 0;
	let statementChain: ChainKind | null = null;

	let pendingColon: PendingSuiteColon | null = null;
	let stringState: StringState | null = null;
	let inComment = false;

	function currentBlockIndent(): number {
		const top = blocks[blocks.length - 1];
		return top ? top.headerIndent + 1 : 0;
	}

	function popBlock(): void {
		const index = blocks.length - 1;
		const frame = blocks.pop();
		if (frame?.chain && chainTops[frame.chain] === index) chainTops[frame.chain] = frame.previousChain;
	}

	function popThrough(index: number): void {
		while (blocks.length > index) popBlock();
	}

	function pushBlock(frame: PendingSuiteColon): void {
		const previousChain = frame.chain ? chainTops[frame.chain] : -1;
		blocks.push({
			kind: frame.kind,
			chain: frame.chain,
			headerIndent: frame.headerIndent,
			sourceIndent: frame.sourceIndent,
			previousChain,
		});
		if (frame.chain) chainTops[frame.chain] = blocks.length - 1;
	}

	function resetStatement(): void {
		statementPrepared = false;
		statementKind = null;
		statementHeaderEnd = -1;
		statementHasPayload = false;
		statementIndent = currentBlockIndent();
		statementSourceIndent = currentSourceIndent;
		statementChain = null;
	}

	function flushHorizontal(): void {
		if (pendingHorizontal.length === 0) return;
		chunks.push(pendingHorizontal.join("").replaceAll("\t", "    "));
		pendingHorizontal.length = 0;
	}

	function appendNormal(text: string): void {
		if (outputLineStart) {
			const indent = lineIndent ?? currentBlockIndent();
			if (indent > 0) chunks.push("    ".repeat(indent));
			currentOutputIndent = indent;
			outputLineStart = false;
		}
		flushHorizontal();
		chunks.push(text);
	}

	function appendRaw(text: string): void {
		chunks.push(text);
		if (outputLineStart) {
			outputLineStart = false;
			currentOutputIndent = 0;
		}
	}

	function finishOutputLine(): void {
		pendingHorizontal.length = 0;
		chunks.push("\n");
		outputLineStart = true;
		lineIndent = null;
		currentOutputIndent = 0;
	}

	function consumeSourceNewline(): void {
		sourceLineStart = true;
		sourceIndent = 0;
		currentSourceIndent = 0;
		skipGeneratedNewline = false;
		if (delimiters.length === 0) resetStatement();
	}

	function popSourceDedents(indent: number): void {
		let top = blocks[blocks.length - 1];
		while (top && indent <= top.sourceIndent) {
			popBlock();
			top = blocks[blocks.length - 1];
		}
	}

	function alignTo(index: number, fallback: ChainKind): ClauseAlignment {
		if (index < 0) return { indent: currentBlockIndent(), chain: fallback };
		const frame = blocks[index];
		const alignment = { indent: frame.headerIndent, chain: frame.chain ?? fallback };
		popThrough(index);
		return alignment;
	}

	function alignClause(kind: HeaderKind): ClauseAlignment | null {
		switch (kind) {
			case "elif":
				return alignTo(chainTops.if, "if");
			case "except":
			case "finally":
				return alignTo(chainTops.try, "try");
			case "else": {
				const target = Math.max(chainTops.if, chainTops.loop, chainTops.try);
				return alignTo(target, "if");
			}
			case "case": {
				const target = chainTops.match;
				if (target < 0) return { indent: currentBlockIndent(), chain: "match" };
				const frame = blocks[target];
				if (frame.kind === "match") {
					while (blocks.length > target + 1) popBlock();
					return { indent: frame.headerIndent + 1, chain: "match" };
				}
				const indent = frame.headerIndent;
				popThrough(target);
				return { indent, chain: "match" };
			}
			default:
				return null;
		}
	}

	function prepareStatement(index: number, physicalLineStart: boolean): void {
		if (physicalLineStart) popSourceDedents(currentSourceIndent);
		const header = readHeader(source, index);
		const alignment = header ? alignClause(header.kind) : null;
		statementPrepared = true;
		statementKind = header?.kind ?? null;
		statementHeaderEnd = header?.end ?? -1;
		statementHasPayload = false;
		statementIndent = alignment?.indent ?? currentBlockIndent();
		statementSourceIndent = currentSourceIndent;
		statementChain = alignment?.chain ?? (header ? defaultChain(header.kind) : null);
		lineIndent = statementIndent;
	}

	function prepareToken(index: number, char: string, comment: boolean): void {
		const physicalLineStart = sourceLineStart;
		if (physicalLineStart) {
			currentSourceIndent = sourceIndent;
			sourceLineStart = false;
		}
		if (skipGeneratedNewline) skipGeneratedNewline = false;
		if (!outputLineStart) return;

		const delimiter = delimiters[delimiters.length - 1];
		if (delimiter && statementPrepared) {
			const closes = matchingCloser(delimiter.opener, char);
			const structuralIndent = delimiter.outputIndent + (closes ? 0 : 1);
			lineIndent = Math.max(structuralIndent, Math.ceil(currentSourceIndent / 4));
			return;
		}

		if (comment) {
			lineIndent = physicalLineStart
				? Math.min(currentBlockIndent(), Math.ceil(currentSourceIndent / 4))
				: currentBlockIndent();
			return;
		}
		if (!statementPrepared) prepareStatement(index, physicalLineStart);
		else lineIndent = statementIndent;
	}

	function notePayload(index: number): void {
		if (statementKind && index >= statementHeaderEnd) statementHasPayload = true;
	}

	function openPendingSuite(frame: PendingSuiteColon): void {
		pushBlock(frame);
		resetStatement();
	}

	let index = 0;
	while (index < source.length) {
		let char = source[index];

		if (stringState) {
			const newline = char === "\n" || char === "\r";
			if (newline) {
				const width = char === "\r" && source[index + 1] === "\n" ? 2 : 1;
				appendRaw(source.slice(index, index + width));
				outputLineStart = true;
				lineIndent = null;
				currentOutputIndent = 0;
				sourceLineStart = true;
				sourceIndent = 0;
				stringState.escaped = false;
				index += width;
				continue;
			}

			if (
				stringState.triple &&
				!stringState.escaped &&
				char === stringState.quote &&
				source[index + 1] === char &&
				source[index + 2] === char
			) {
				appendRaw(source.slice(index, index + 3));
				sourceLineStart = false;
				stringState = null;
				index += 3;
				continue;
			}

			appendRaw(char);
			sourceLineStart = false;
			if (stringState.escaped) stringState.escaped = false;
			else if (char === "\\") stringState.escaped = true;
			else if (!stringState.triple && char === stringState.quote) stringState = null;
			index++;
			continue;
		}

		if (inComment) {
			if (char === "\n" || char === "\r") {
				const width = char === "\r" && source[index + 1] === "\n" ? 2 : 1;
				finishOutputLine();
				inComment = false;
				consumeSourceNewline();
				index += width;
				continue;
			}
			appendRaw(char);
			index++;
			continue;
		}

		if (pendingColon) {
			if (char === " " || char === "\t") {
				pendingColon.afterColon.push(char);
				index++;
				continue;
			}
			if (char === "=" && pendingColon.afterColon.length === 0) {
				appendNormal(":");
				pendingColon = null;
			} else if (char === "#") {
				const frame = pendingColon;
				appendNormal(":");
				if (frame.afterColon.length > 0) chunks.push(frame.afterColon.join("").replaceAll("\t", "    "));
				openPendingSuite(frame);
				pendingColon = null;
			} else if (char === "\n" || char === "\r") {
				const frame = pendingColon;
				const width = char === "\r" && source[index + 1] === "\n" ? 2 : 1;
				appendNormal(":");
				openPendingSuite(frame);
				pendingColon = null;
				finishOutputLine();
				consumeSourceNewline();
				index += width;
				continue;
			} else {
				const frame = pendingColon;
				appendNormal(":");
				openPendingSuite(frame);
				pendingColon = null;
				finishOutputLine();
				skipGeneratedNewline = true;
				continue;
			}
			char = source[index];
		}

		if (sourceLineStart && (char === " " || char === "\t")) {
			if (char === "\t") sourceIndent += 4 - (sourceIndent % 4);
			else sourceIndent++;
			index++;
			continue;
		}

		if (char === "\n" || char === "\r") {
			const width = char === "\r" && source[index + 1] === "\n" ? 2 : 1;
			pendingHorizontal.length = 0;
			if (!skipGeneratedNewline) finishOutputLine();
			consumeSourceNewline();
			index += width;
			continue;
		}

		if (char === " " || char === "\t") {
			if (!skipGeneratedNewline && (!outputLineStart || statementPrepared)) pendingHorizontal.push(char);
			index++;
			continue;
		}

		prepareToken(index, char, char === "#");

		if (char === "#") {
			appendNormal(char);
			inComment = true;
			index++;
			continue;
		}

		if (char === "'" || char === '"') {
			notePayload(index);
			const triple = source[index + 1] === char && source[index + 2] === char;
			appendNormal(triple ? source.slice(index, index + 3) : char);
			stringState = { quote: char, triple, escaped: false };
			index += triple ? 3 : 1;
			continue;
		}

		if (
			char === ":" &&
			delimiters.length === 0 &&
			statementKind &&
			canOpenSuite(statementKind, statementHasPayload)
		) {
			flushHorizontal();
			pendingColon = {
				kind: statementKind,
				chain: statementChain,
				headerIndent: statementIndent,
				sourceIndent: statementSourceIndent,
				afterColon: [],
			};
			index++;
			continue;
		}

		if (char === ";" && delimiters.length === 0) {
			appendNormal(char);
			finishOutputLine();
			resetStatement();
			skipGeneratedNewline = true;
			index++;
			continue;
		}

		notePayload(index);
		appendNormal(char);
		if (char === "(" || char === "[" || char === "{") {
			delimiters.push({ opener: char, outputIndent: currentOutputIndent });
		} else {
			const delimiter = delimiters[delimiters.length - 1];
			if (delimiter && matchingCloser(delimiter.opener, char)) delimiters.pop();
		}
		index++;
	}

	if (pendingColon) appendNormal(":");
	return chunks.join("");
}

/** Formats an arbitrary Python source prefix for stable, readable display. */
export function formatPythonForDisplay(source: string): string {
	try {
		return formatPythonPrefix(source);
	} catch {
		return source;
	}
}
