/**
 * Pure Julia-1 judge serialization: row layout + batch shape for tensor allocation.
 *
 * Mirrors `serialize()` in `SupersonicLabs/Julia-1-ONNX@82a2fadf8fccfccdc5fd4e1009ba8f1a265eb7a8/index.js`
 * (same `"${type} question: …"` head + option/state graph contract as `export.py` in that repo):
 * head, mask-prefixed options capped at 48 tokens each, head budget with the
 * option-trim fallback, then state appended and truncated to fit.
 *
 * Zero runtime dependencies: no ORT, no tokenizer import. The caller injects
 * `encode` (tokenizer ids for raw text, no special tokens) plus the numeric
 * special ids. This never throws on budget: an overfull head trims options
 * (the reference strict mode throws instead) and an overfull state truncates
 * to the remaining room. The `cls` fallback (`cls_token_id ?? bos_token_id ?? 2`)
 * and the tokenizer ids from the Julia-1-ONNX root layout (mask 4, sep 1, pad 0)
 * are resolved by the caller. Reserved-marker scrubbing is also the caller's job
 * when needed: only numeric ids are injected here, never the marker string.
 */

/** Judge question kind; wire ids are `choice: 0, score: 1, noul: 2`. */
export type JudgeRowType = "choice" | "score" | "noul";

/** One judge row: the question head, its options, and the state to score. */
export interface JudgeSerializeRow {
	type: JudgeRowType;
	question: string;
	options: string[];
	state: string;
}

/** Numeric special ids injected by the caller (Julia-1-ONNX: mask 4, sep 1). */
export interface JudgeSpecialIds {
	mask: number;
	cls: number;
	sep: number;
}

export interface JudgeSerializeOptions {
	headLength?: number;
	maxLength?: number;
}

export interface JudgeSerializedRow {
	ids: number[];
	markers: number[];
	qtype: number;
}

const JUDGE_QTYPES: Record<JudgeRowType, number> = { choice: 0, score: 1, noul: 2 };
const JUDGE_MAX_OPTION_TOKENS = 48;
const JUDGE_DEFAULT_HEAD_LENGTH = 256;
// Matches Python `sequence(max_length=8192)`; the 1024 in index.js is the WebGPU-demo cap, not the model contract.
const JUDGE_DEFAULT_MAX_LENGTH = 8192;
/**
 * Serialize one judge row to token ids with per-option marker positions.
 * Never throws on budget: overfull heads trim options, overfull states truncate.
 */
export function serializeJudgeRow(
	row: JudgeSerializeRow,
	encode: (text: string) => number[],
	specialIds: JudgeSpecialIds,
	opts: JudgeSerializeOptions = {},
): JudgeSerializedRow {
	const headLength = opts.headLength ?? JUDGE_DEFAULT_HEAD_LENGTH;
	const maxLength = opts.maxLength ?? JUDGE_DEFAULT_MAX_LENGTH;
	const head = encode(`${row.type} question: ${row.question}`);
	let options = row.options.map(option => [
		specialIds.mask,
		...encode(` ${option}`).slice(0, JUDGE_MAX_OPTION_TOKENS),
	]);
	let budget = headLength - options.reduce((sum, option) => sum + option.length, 0);
	if (budget < 16) {
		const perOption = Math.max(4, Math.floor((headLength - 16) / options.length));
		options = options.map(option => option.slice(0, perOption));
		budget = headLength - options.reduce((sum, option) => sum + option.length, 0);
	}
	const ids = [specialIds.cls, ...head.slice(0, Math.max(8, budget)), specialIds.sep];
	const markers: number[] = [];
	for (const option of options) {
		markers.push(ids.length);
		ids.push(...option);
	}
	ids.push(specialIds.sep);
	const room = Math.max(0, maxLength - ids.length - 1);
	ids.push(...encode(row.state).slice(0, room), specialIds.sep);
	return { ids, markers, qtype: JUDGE_QTYPES[row.type] };
}

/**
 * Batch shape for tensor allocation over serialized rows: `length` is the
 * longest row padded up to a multiple of 8, `count` the max option count.
 * Padding itself happens at tensor fill time (the caller fills unused slots
 * with the pad id), not here.
 */
export function packJudgeBatch(rows: readonly JudgeSerializedRow[]): {
	length: number;
	count: number;
	qtypes: number[];
} {
	if (rows.length === 0) return { length: 0, count: 0, qtypes: [] };
	const longest = rows.reduce((max, row) => Math.max(max, row.ids.length), 0);
	const mostOptions = rows.reduce((max, row) => Math.max(max, row.markers.length), 0);
	return {
		length: Math.ceil(longest / 8) * 8,
		count: mostOptions,
		qtypes: rows.map(row => row.qtype),
	};
}

/**
 * Render a judgment state the way the Julia-1 reference `pythonJSON()` does:
 * strings pass through untouched; objects/arrays use Python `json.dumps`
 * default separators (`, ` after items, `: ` after keys).
 *
 * Failure mode without this: compact `JSON.stringify` shifts every token id
 * after the first separator, so the state tokens no longer match training.
 * The scan inserts separators outside string literals only: it tracks quotes
 * and backslash escapes, so a `,`/`:` (or an escaped quote) inside a value
 * never splits. A quote-counting regex lookahead canNOT do this — an escaped
 * `\"` flips the parity and corrupts the rest of the string.
 */
export function renderJudgeStateValue(
	state: string | { readonly [key: string]: unknown } | readonly unknown[],
): string {
	if (typeof state === "string") return state;
	// Mirror Python `json.dumps` WITH `ensure_ascii=True` (the default): every
	// non-ASCII char becomes `\uXXXX`, so token ids after the first non-ASCII
	// char match training. JS emits raw UTF-8 — without this the ids diverge.
	const json = JSON.stringify(state).replace(
		// Astral chars (surrogate pairs) first: Python emits the pair, not per-half escapes.
		/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u0080-\uFFFF]/g,
		char =>
			char.length === 2
				? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}\\u${char.charCodeAt(1).toString(16).padStart(4, "0")}`
				: `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	let out = "";
	let inString = false;
	for (let index = 0; index < json.length; index++) {
		const ch = json[index]!;
		if (inString) {
			out += ch;
			if (ch === "\\") out += json[++index] ?? "";
			else if (ch === '"') inString = false;
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "," || ch === ":") {
			out += `${ch} `;
		} else out += ch;
	}
	return out;
}

/** Dense ORT feed buffers for one judge batch (zeroed; the worker fills the used slots). */
export interface JudgeBatchTensors {
	ids: BigInt64Array;
	attention: BigInt64Array;
	positions: BigInt64Array;
	mask: Uint8Array;
	qtype: BigInt64Array;
}

/**
 * Fill zeroed `(rows × length)` / `(rows × count)` feed buffers from
 * serialized rows: token ids + attention on the left block, marker positions
 * + presence mask on the option block, qtype per row. Unused slots stay zero
 * (pad id 0 / no attention / no marker), matching the previous inline loop.
 */
export function fillJudgeBatch(
	rows: readonly JudgeSerializedRow[],
	batch: { length: number; count: number },
): JudgeBatchTensors {
	const ids = new BigInt64Array(rows.length * batch.length);
	const attention = new BigInt64Array(rows.length * batch.length);
	const positions = new BigInt64Array(rows.length * batch.count);
	const mask = new Uint8Array(rows.length * batch.count);
	const qtype = new BigInt64Array(rows.length);
	rows.forEach((row, rowIndex) => {
		row.ids.forEach((id, tokenIndex) => {
			ids[rowIndex * batch.length + tokenIndex] = BigInt(id);
			attention[rowIndex * batch.length + tokenIndex] = 1n;
		});
		row.markers.forEach((marker, optionIndex) => {
			positions[rowIndex * batch.count + optionIndex] = BigInt(marker);
			mask[rowIndex * batch.count + optionIndex] = 1;
		});
		qtype[rowIndex] = BigInt(row.qtype);
	});
	return { ids, attention, positions, mask, qtype };
}

/**
 * Slice one flat per-row logit vector (`rows × count`) back into per-question
 * logits: row `i` keeps its first `markersLengths[i]` entries (padded option
 * slots carry no logits).
 */
export function sliceJudgeLogits(
	names: readonly string[],
	markersLengths: readonly number[],
	values: readonly number[],
	count: number,
): Record<string, number[]> {
	const logits: Record<string, number[]> = {};
	names.forEach((name, rowIndex) => {
		logits[name] = values.slice(rowIndex * count, rowIndex * count + markersLengths[rowIndex]!);
	});
	return logits;
}
