/**
 * Pure Julia-1 judge serialization: row layout + batch shape for tensor allocation.
 *
 * Exact port of the non-strict path of `serialize()` in `/tmp/julia-index.js`
 * (which mirrors `sequence()` in `/tmp/julia-data.py`): `${type} question: …`
 * head, mask-prefixed options capped at 48 tokens each, head budget with the
 * graceful option-trim fallback, then state appended and truncated to fit.
 *
 * Zero runtime dependencies: no ORT, no tokenizer import. The caller injects
 * `encode` (tokenizer ids for raw text, no special tokens) plus the numeric
 * special ids. Unlike the reference this never throws on budget: an overfull
 * head trims options (never errors like strict/MacJev-style budget checks) and
 * an overfull state truncates to the remaining room. The `cls` fallback
 * (`cls_token_id ?? bos_token_id ?? 2`) and the tokenizer ids from the
 * Julia-1-ONNX root layout (mask 4, sep 1, pad 0) are resolved by the caller.
 * Reserved-marker scrubbing (reference `clean()`) is also the caller's job
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
 * `padId` names the pad token the caller fills unused slots with; padding
 * itself happens at tensor fill time, not here.
 */
export function packJudgeBatch(
	rows: readonly JudgeSerializedRow[],
	padId = 0,
): { length: number; count: number; qtypes: number[] } {
	void padId;
	if (rows.length === 0) return { length: 0, count: 0, qtypes: [] };
	const longest = rows.reduce((max, row) => Math.max(max, row.ids.length), 0);
	const mostOptions = rows.reduce((max, row) => Math.max(max, row.markers.length), 0);
	return {
		length: Math.ceil(longest / 8) * 8,
		count: mostOptions,
		qtypes: rows.map(row => row.qtype),
	};
}
