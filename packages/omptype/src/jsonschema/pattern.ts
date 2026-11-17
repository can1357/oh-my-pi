/**
 * Compiles simple anchored `pattern`s into char-code checks for generated
 * validators: `^[0-9a-f]{8}-…$`, `^\d{4}-\d{2}-\d{2}$`, `^[A-Za-z0-9._-]+$`.
 *
 * Supported: ASCII literals and escaped punctuation, `\d`, `\w`, non-negated
 * ASCII classes, and quantifiers, with at most one variable-length segment.
 * Fixed segments then pin every position (from the start before the variable
 * segment, from the end after it), so the check is exact without
 * backtracking. ASCII-only classes reject every UTF-16 surrogate, so counting
 * code units agrees with the `u` flag's code points. Anything else returns
 * `undefined` and stays a `RegExp`.
 */

type Range = readonly [number, number];

interface Segment {
	readonly ranges: readonly Range[];
	readonly min: number;
	readonly max: number;
}

const DIGIT: Range[] = [[48, 57]];
const WORD: Range[] = [
	[48, 57],
	[65, 90],
	[95, 95],
	[97, 122],
];

function isPunctuation(code: number): boolean {
	return code < 128 && !(code >= 48 && code <= 57) && !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122);
}

/** Ranges of an escape (`\d`, `\w`, `\.`), or `undefined` when unsupported. */
function escapeRanges(code: number | undefined): Range[] | undefined {
	if (code === undefined) return undefined;
	if (code === 100) return DIGIT;
	if (code === 119) return WORD;
	return isPunctuation(code) ? [[code, code]] : undefined;
}

function parseClass(body: string, start: number): { ranges: Range[]; end: number } | undefined {
	const ranges: Range[] = [];
	let index = start;
	if (body.charCodeAt(index) === 94) return undefined; // negated
	const single = (): number | undefined => {
		const code = body.charCodeAt(index);
		if (code === 92) {
			const escaped = body.charCodeAt(index + 1);
			if (!isPunctuation(escaped)) return undefined;
			index += 2;
			return escaped;
		}
		if (Number.isNaN(code) || code >= 128 || code === 91 || code === 93) return undefined;
		index++;
		return code;
	};
	while (index < body.length && body.charCodeAt(index) !== 93) {
		if (body.charCodeAt(index) === 92) {
			const named = body.charCodeAt(index + 1);
			if (named === 100 || named === 119) {
				ranges.push(...escapeRanges(named)!);
				index += 2;
				continue;
			}
		}
		const low = single();
		if (low === undefined) return undefined;
		if (body.charCodeAt(index) === 45 && index + 1 < body.length && body.charCodeAt(index + 1) !== 93) {
			index++;
			const high = single();
			if (high === undefined || high < low) return undefined;
			ranges.push([low, high]);
		} else {
			ranges.push([low, low]);
		}
	}
	if (index >= body.length || ranges.length === 0) return undefined;
	return { ranges, end: index + 1 };
}

function parseQuantifier(body: string, start: number): { min: number; max: number; end: number } | undefined {
	const code = body.charCodeAt(start);
	let result: { min: number; max: number; end: number };
	if (code === 43) result = { min: 1, max: Infinity, end: start + 1 };
	else if (code === 42) result = { min: 0, max: Infinity, end: start + 1 };
	else if (code === 63) result = { min: 0, max: 1, end: start + 1 };
	else if (code === 123) {
		const match = /^\{(\d+)(,(\d*))?\}/.exec(body.slice(start));
		if (match === null) return undefined;
		const min = Number(match[1]);
		const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
		if (max < min) return undefined;
		result = { min, max, end: start + match[0].length };
	} else {
		return { min: 1, max: 1, end: start };
	}
	// Lazy and possessive-looking suffixes change nothing here but are rare; keep them as regexes.
	return body.charCodeAt(result.end) === 63 || body.charCodeAt(result.end) === 43 ? undefined : result;
}

function parse(source: string): Segment[] | undefined {
	if (source.length < 2 || source.charCodeAt(0) !== 94 || source.charCodeAt(source.length - 1) !== 36) {
		return undefined;
	}
	const body = source.slice(1, -1);
	// `\$` at the end is a literal dollar followed by no anchor.
	let slashes = 0;
	for (let index = body.length - 1; index >= 0 && body.charCodeAt(index) === 92; index--) slashes++;
	if (slashes % 2 === 1) return undefined;
	const segments: Segment[] = [];
	let index = 0;
	while (index < body.length) {
		const code = body.charCodeAt(index);
		let ranges: Range[] | undefined;
		if (code === 91) {
			const parsed = parseClass(body, index + 1);
			if (parsed === undefined) return undefined;
			ranges = parsed.ranges;
			index = parsed.end;
		} else if (code === 92) {
			ranges = escapeRanges(body.charCodeAt(index + 1));
			index += 2;
		} else if (code < 128 && !"()|.*+?{}^$]".includes(body[index])) {
			ranges = [[code, code]];
			index++;
		}
		if (ranges === undefined) return undefined;
		const quantifier = parseQuantifier(body, index);
		if (quantifier === undefined) return undefined;
		index = quantifier.end;
		segments.push({ ranges, min: quantifier.min, max: quantifier.max });
	}
	let variable = 0;
	for (const segment of segments) if (segment.min !== segment.max) variable++;
	return variable <= 1 ? segments : undefined;
}

function rangeTest(ranges: readonly Range[]): string {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [low, high] of sorted) {
		const last = merged[merged.length - 1];
		if (last !== undefined && low <= last[1] + 1) last[1] = Math.max(last[1], high);
		else merged.push([low, high]);
	}
	return merged.map(([low, high]) => (low === high ? `c===${low}` : `(c>=${low}&&c<=${high})`)).join("||");
}

/** Statements checking positions `[from, to)` (`to` may be an expression) against `ranges`. */
function positions(ranges: readonly Range[], from: string, to: string, count: number | undefined): string {
	const test = rangeTest(ranges);
	if (count !== undefined && count <= 4) {
		let out = "";
		for (let offset = 0; offset < count; offset++) {
			out += `c=s.charCodeAt(${from}+${offset});if(!(${test}))return false;`;
		}
		return out;
	}
	return `for(let i=${from};i<${to};i++){c=s.charCodeAt(i);if(!(${test}))return false;}`;
}

/**
 * Source of `function name(s)` testing a string against `source` with the
 * `u` flag's semantics, or `undefined` when the pattern is not simple.
 */
export function compileSimplePattern(source: string, name: string): string | undefined {
	const segments = parse(source);
	if (segments === undefined) return undefined;
	let fixed = 0;
	let variable: Segment | undefined;
	for (const segment of segments) {
		if (segment.min === segment.max) fixed += segment.min;
		else variable = segment;
	}
	let body = "const n=s.length;let c;";
	if (variable === undefined) body += `if(n!==${fixed})return false;`;
	else {
		body += `if(n<${fixed + variable.min})return false;`;
		if (variable.max !== Infinity) body += `if(n>${fixed + variable.max})return false;`;
	}
	// Positions before the variable segment count from 0, after it from the end.
	let position = 0;
	let fromEnd = false;
	let suffix = 0;
	if (variable !== undefined) {
		for (let index = segments.length - 1; segments[index] !== variable; index--) suffix += segments[index].min;
	}
	for (const segment of segments) {
		if (segment === variable) {
			body += positions(segment.ranges, String(position), `n-${suffix}`, undefined);
			fromEnd = true;
			continue;
		}
		if (segment.min === 0) continue;
		const start = fromEnd ? `n-${suffix}` : String(position);
		body += positions(segment.ranges, start, `${start}+${segment.min}`, segment.min);
		if (fromEnd) suffix -= segment.min;
		else position += segment.min;
	}
	return `function ${name}(s){${body}return true}`;
}
