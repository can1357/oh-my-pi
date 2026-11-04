/**
 * Lossless compaction of data dumps: JSON (including pretty JSON cut mid-value) and Python reprs as `key: value`
 * lines and `(N rows) a|b|c` tables, CSV quotes stripped, fixed-width padding collapsed. Every transform applies only
 * where it makes the text shorter.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObj = (v: Json): v is { [key: string]: Json } => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: Json) => v === null || typeof v !== "object";

/** Appends `items` one by one: a dump's rendered tables can be too long to spread into one call. */
function pushAll(out: string[], items: readonly string[]): void {
	for (const item of items) out.push(item);
}

/** A record whose every value is a scalar. */
function isFlat(o: { [key: string]: Json }): boolean {
	for (const k in o) if (!isScalar(o[k])) return false;
	return true;
}

/** Scalar as a table cell: bare unless ambiguous. */
function cell(v: Json): string {
	if (typeof v !== "string") return JSON.stringify(v);
	if (v === "" || /[|\n\r\t]|^\s|\s$/.test(v) || /^(null|true|false|-?\d[\d.eE+-]*)$/.test(v))
		return JSON.stringify(v);
	return v;
}

/** Long strings with newlines (DDL, messages) collapse whitespace runs to one space. */
function inlineString(v: string): string {
	return v.includes("\n") ? v.replace(/\s*\n\s*/g, " ") : v;
}

function render(v: Json, indent: string): string[] {
	if (isScalar(v)) return [`${indent}${typeof v === "string" ? inlineString(v) : JSON.stringify(v)}`];
	if (Array.isArray(v)) {
		if (v.length === 0) return [`${indent}[]`];
		if (v.every(isScalar)) return [`${indent}${JSON.stringify(v)}`];
		if (v.every(x => Array.isArray(x) && x.every(isScalar))) {
			return [`${indent}(${v.length} rows)`, ...v.map(row => `${indent}${(row as Json[]).map(cell).join("|")}`)];
		}
		if (v.every(isObj)) {
			const objs = v as { [key: string]: Json }[];
			const seen = new Set<string>();
			for (const o of objs) for (const k in o) seen.add(k);
			const keys = [...seen];
			if (objs.every(isFlat)) {
				return [
					`${indent}(${objs.length} rows) ${keys.join("|")}`,
					...objs.map(
						o =>
							`${indent}${keys.map(k => (k in o ? cell(typeof o[k] === "string" ? inlineString(o[k] as string) : o[k]) : "")).join("|")}`,
					),
				];
			}
		}
		const out: string[] = [];
		for (const x of v) {
			const lines = render(x, `${indent}  `);
			lines[0] = `${indent}- ${lines[0].slice(indent.length + 2)}`;
			pushAll(out, lines);
		}
		return out;
	}
	const out: string[] = [];
	for (const k in v) {
		const x = v[k];
		if (isScalar(x)) out.push(`${indent}${k}: ${typeof x === "string" ? inlineString(x) : JSON.stringify(x)}`);
		else if (Array.isArray(x) && x.every(isScalar)) out.push(`${indent}${k}: ${JSON.stringify(x)}`);
		else {
			const lines = render(x, `${indent}  `);
			if (lines.length === 1) out.push(`${indent}${k}: ${lines[0].trim()}`);
			else {
				out.push(`${indent}${k}:`);
				pushAll(out, lines);
			}
		}
	}
	return out.length ? out : [`${indent}{}`];
}

/** Index just past the bracket closing the one at `start`, string-aware; -1 if unbalanced. */
function matchBracket(text: string, start: number): number {
	let depth = 0;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
			continue;
		}
		if (c === '"') quote = c;
		else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Python repr (single quotes, None/True/False, tuples) → JSON text, or undefined when it isn't a plain literal. */
function pyToJson(src: string): string | undefined {
	let out = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "'" || c === '"') {
			let s = "";
			let j = i + 1;
			for (; j < src.length && src[j] !== c; j++) {
				if (src[j] === "\\") {
					const n = src[++j];
					s += n === "n" ? "\n" : n === "t" ? "\t" : n;
				} else s += src[j];
			}
			if (j >= src.length) return undefined;
			out += JSON.stringify(s);
			i = j;
		} else if (c === "(") out += "[";
		else if (c === ")") out += "]";
		else if (/[A-Za-z_]/.test(c)) {
			const word = /^[A-Za-z_][A-Za-z_0-9.]*/.exec(src.slice(i))?.[0] ?? c;
			if (word === "None") out += "null";
			else if (word === "True") out += "true";
			else if (word === "False") out += "false";
			else if (/^(nan|inf)$/i.test(word)) out += JSON.stringify(word);
			else return undefined;
			i += word.length - 1;
		} else out += c;
	}
	return out.replace(/,\s*([\]}])/g, "$1");
}

function tryParse(text: string, py: boolean): Json | undefined {
	try {
		return JSON.parse(text) as Json;
	} catch {
		if (!py) return undefined;
		const converted = pyToJson(text);
		if (converted === undefined) return undefined;
		try {
			return JSON.parse(converted) as Json;
		} catch {
			return undefined;
		}
	}
}

/** Worth rendering: holds records/rows (not a lone scalar), and the render is under 80% of the original. */
function compactValue(value: Json, original: string): string[] | undefined {
	if (!isObj(value) && !Array.isArray(value)) return undefined;
	const lines = render(value, "");
	return lines.join("\n").length < original.length * 0.8 ? lines : undefined;
}

/**
 * Every JSON / Python-literal block of `text` densified: multi-line JSON blocks over 300 chars, runs of 3+ one-line
 * flat dicts, one-line JSON or reprs on lines over 300 chars. `strict` (file reads) converts only multi-line JSON.
 */
export function densify(text: string, strict: boolean): { text: string; blocks: number } {
	const lines = text.split("\n");
	const out: string[] = [];
	let blocks = 0;
	const starts: number[] = [];
	let off = 0;
	for (const line of lines) {
		starts.push(off);
		off += line.length + 1;
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimEnd();
		if (trimmed.endsWith("{") || trimmed.endsWith("[")) {
			const open = starts[i] + trimmed.length - 1;
			const end = matchBracket(text, open);
			if (end > 0 && end - open > 300) {
				const src = text.slice(open, end);
				const value = tryParse(src, false);
				const rendered = value === undefined ? undefined : compactValue(value, src);
				if (rendered) {
					blocks++;
					const prefix = trimmed.slice(0, -1).trimEnd();
					if (prefix) out.push(prefix);
					pushAll(out, rendered);
					let j = i;
					while (j + 1 < lines.length && starts[j + 1] < end) j++;
					const rest = text.slice(end, starts[j] + lines[j].length).trim();
					if (rest) out.push(rest);
					i = j;
					continue;
				}
			}
		}
		if (!strict && /^\s*\{/.test(line)) {
			const run: { [key: string]: Json }[] = [];
			let j = i;
			for (; j < lines.length && /^\s*\{.*\}\s*$/.test(lines[j]); j++) {
				const value = tryParse(lines[j].trim(), true);
				if (value === undefined || !isObj(value) || !isFlat(value)) break;
				run.push(value);
			}
			const rendered = run.length >= 3 ? compactValue(run, lines.slice(i, j).join("\n")) : undefined;
			if (rendered) {
				blocks++;
				pushAll(out, rendered);
				i = j - 1;
				continue;
			}
		}
		if (!strict && line.length > 300) {
			const at = line.search(/[[{]/);
			if (at >= 0) {
				const src = line.slice(at).trim();
				const value = tryParse(src, true);
				const rendered = value === undefined ? undefined : compactValue(value, src);
				if (rendered) {
					blocks++;
					const prefix = line.slice(0, at).trimEnd();
					if (prefix) out.push(prefix);
					pushAll(out, rendered);
					continue;
				}
			}
		}
		out.push(line);
	}
	return { text: out.join("\n"), blocks };
}

/**
 * Pretty JSON the command itself cut mid-value, closed after its last complete nested value so `densify` can
 * tabulate the complete part; the incomplete tail stays as printed, after a note. Nothing is dropped.
 */
function salvageTruncated(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		out.push(line);
		if (!/^\S/.test(line) || !/[{[]$/.test(line.trimEnd()) || !/^\s+\S/.test(lines[i + 1] ?? "")) continue;
		let j = i + 1;
		while (j < lines.length && /^\s/.test(lines[j])) j++;
		if ((j < lines.length && /^[}\]]/.test(lines[j])) || j - i < 20) continue;
		for (let k = j - 1; k > i; k--) {
			if (!/^\s+[}\]],?$/.test(lines[k])) continue;
			const head = [line, ...lines.slice(i + 1, k), lines[k].replace(/,$/, "")].join("\n");
			const stack: string[] = [];
			let quote = false;
			for (let c = 0; c < head.length; c++) {
				const ch = head[c];
				if (quote) {
					if (ch === "\\") c++;
					else if (ch === '"') quote = false;
				} else if (ch === '"') quote = true;
				else if (ch === "{") stack.push("}");
				else if (ch === "[") stack.push("]");
				else if (ch === "}" || ch === "]") stack.pop();
			}
			const open = line.search(/[{[]\s*$/);
			const repaired = `${head}\n${stack.reverse().join("\n")}`;
			try {
				JSON.parse(repaired.slice(open));
			} catch {
				continue;
			}
			out.pop();
			pushAll(out, repaired.split("\n"));
			out.push(
				"[the command's own output stops mid-value here (cut by the command, not by this display); the incomplete rest follows exactly as printed:]",
			);
			pushAll(out, lines.slice(k + 1, j));
			i = j - 1;
			break;
		}
	}
	return out.join("\n");
}

interface LineBlock {
	start: number;
	/** Exclusive. */
	end: number;
	delim?: string;
}

/** Longest run of ≥ `minRun` lines where `ok` holds; -1s when none. */
function longestRun(lines: readonly string[], ok: (line: string) => boolean, minRun: number): LineBlock {
	let best = { start: -1, end: -1 };
	let start = -1;
	for (let i = 0; i <= lines.length; i++) {
		if (i < lines.length && ok(lines[i])) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			if (i - start >= minRun && i - start > best.end - best.start) best = { start, end: i };
			start = -1;
		}
	}
	return best;
}

const delimCount = (line: string, delim: string) => (line.match(delim === "\t" ? /\t/g : /,/g) ?? []).length;

/** CSV/TSV: ≥ 6 lines with the same delimiter count (≥ 2), no leading whitespace. */
function csvBlock(lines: readonly string[]): LineBlock | undefined {
	let best: LineBlock | undefined;
	for (const delim of ["\t", ","]) {
		const run = longestRun(lines, l => delimCount(l, delim) >= 2 && !/^\s/.test(l), 6);
		if (run.start < 0) continue;
		const count = delimCount(lines[run.start], delim);
		if (lines.slice(run.start, run.end).some(l => delimCount(l, delim) !== count)) continue;
		if (!best || run.end - run.start > best.end - best.start) best = { ...run, delim };
	}
	return best;
}

/** Fixed-width table: ≥ 8 lines whose 2+-space gaps sit at consistent columns (pandas, psql, `column`). */
function alignedBlock(lines: readonly string[]): LineBlock | undefined {
	const run = longestRun(
		lines,
		l => (l.match(/\S {2,}\S/g) ?? []).length >= 2 && (l.match(/ {2,}/g) ?? []).length >= 2,
		8,
	);
	if (run.start < 0) return undefined;
	const positions: number[] = [];
	for (let i = run.start; i < run.end; i++) for (const m of lines[i].matchAll(/ {2,}/g)) positions.push(m.index ?? 0);
	if (!positions.length) return undefined;
	const counts = new Map<number, number>();
	for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1);
	let covered = 0;
	for (const p of positions) {
		let best = 0;
		for (const [c, n] of counts) if (Math.abs(c - p) <= 2 && n > best) best = n;
		if (best >= (run.end - run.start) * 0.6) covered++;
	}
	if (covered < positions.length * 0.7) return undefined;
	let suspicious = 0;
	for (let i = run.start; i < run.end; i++) {
		if (/[.;:]$/.test(lines[i].trim()) || (lines[i].match(/[{}]/g) ?? []).length > 2) suspicious++;
	}
	if (suspicious > (run.end - run.start) * 0.3) return undefined;
	return run;
}

/** numpy array body: ≥ 5 lines of only digits, brackets, dots and padding. */
function numarrayBlock(lines: readonly string[]): LineBlock | undefined {
	const run = longestRun(
		lines,
		l => l.length > 10 && /^[\s[\].,eE+\-\d]*$/.test(l) && /\d/.test(l) && / {2,}/.test(l),
		5,
	);
	return run.start < 0 ? undefined : run;
}

const csvFields = (line: string, delim: string) =>
	line
		.split(delim)
		.map(f =>
			f.length >= 2 && f.startsWith('"') && f.endsWith('"') && !f.slice(1, -1).includes('"') ? f.slice(1, -1) : f,
		);

/**
 * The lossless view of an output: truncated JSON salvaged, JSON/reprs densified, CSV quotes stripped, fixed-width
 * padding to `|` (when it saves ≥ 20% of the block and > 100 chars), numeric-array padding to one space (> 100 chars).
 */
export function losslessView(output: string): string {
	const lines = densify(salvageTruncated(output), false).text.split("\n");
	const csv = csvBlock(lines);
	if (csv) {
		const delim = csv.delim ?? ",";
		for (let i = csv.start; i < csv.end; i++) {
			const stripped = csvFields(lines[i], delim).join(delim);
			if (stripped.length < lines[i].length) lines[i] = stripped;
		}
	}
	const aligned = alignedBlock(lines);
	if (aligned && (!csv || aligned.start >= csv.end || csv.start >= aligned.end)) {
		const block = lines.slice(aligned.start, aligned.end);
		const collapsed = block.map(l => l.trimEnd().replace(/ {2,}/g, "|"));
		const before = block.join("\n").length;
		const saved = before - collapsed.join("\n").length;
		if (saved >= 0.2 * before && saved > 100) collapsed.forEach((l, k) => (lines[aligned.start + k] = l));
	}
	const num = numarrayBlock(lines);
	if (num) {
		const block = lines.slice(num.start, num.end);
		const collapsed = block.map(l => l.replace(/ {2,}/g, " ").trimEnd());
		if (block.join("\n").length - collapsed.join("\n").length > 100) {
			collapsed.forEach((l, k) => (lines[num.start + k] = l));
		}
	}
	return lines.join("\n");
}
