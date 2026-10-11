/**
 * Frame sizing for the Tern Surface Protocol: Tern drops a chunked message
 * whose joined body passes 24 MiB, so `NativeBackend` sends a large
 * reconciliation as several frames and {@link boundOps} rewrites any single
 * op too large for one frame into equivalent smaller ops.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { TSP_TEXT_KINDS, type TspOp } from "@oh-my-pi/pi-wire";

/** Largest joined `f` body Tern accepts (`over 25165824 bytes` drops it). */
export const MAX_FRAME_BYTES = 24 * 1024 * 1024;

const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);

/** Ends a prop value cut to fit one frame, so the cut reads as one. */
const TRUNCATED_MARK = "\n… [truncated: too large for one Tern frame]";
/** Room in an op for everything around its one large value (op name, id, key, quotes, mark). */
const OP_OVERHEAD_BYTES = 1024;

/** An op with its encoded JSON size in bytes. */
export interface SizedOp {
	readonly op: TspOp;
	readonly bytes: number;
}

function sized(op: TspOp): SizedOp {
	return { op, bytes: Buffer.byteLength(JSON.stringify(op), "utf8") };
}

/**
 * End of the piece of `text` that starts at `at` and holds at most `units`
 * UTF-16 code units, never between a surrogate pair. JSON encodes a code
 * unit in at most 6 bytes.
 */
function pieceEnd(text: string, at: number, units: number): number {
	const end = Math.min(text.length, at + units);
	const last = text.charCodeAt(end - 1);
	return end < text.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function textPieces(text: string, units: number): string[] {
	const pieces: string[] = [];
	for (let at = 0; at < text.length;) {
		const end = pieceEnd(text, at, units);
		pieces.push(text.slice(at, end));
		at = end;
	}
	return pieces;
}

/** Code units of the longest prefix of `text` whose JSON string encoding takes at most `bytes`. */
function fittingPrefix(text: string, bytes: number): number {
	let used = 2; // quotes
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		let cost = 3;
		let width = 1;
		if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) cost = 2;
		else if (c < 0x20) cost = 6;
		else if (c < 0x80) cost = 1;
		else if (c < 0x800) cost = 2;
		else if (c >= 0xd800 && c <= 0xdfff) {
			const next = text.charCodeAt(i + 1);
			// A well-formed pair is 4 UTF-8 bytes; JSON escapes a lone surrogate as `\uXXXX`.
			if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				cost = 4;
				width = 2;
			} else cost = 6;
		}
		if (used + cost > bytes) break;
		used += cost;
		i += width;
	}
	return i;
}

/**
 * The longest leading part of a prop value that one `set` can carry within
 * `budget`: a string's prefix (marked as cut), or an array's first elements.
 * Undefined when no part fits (an object, or a first element over budget).
 */
function truncatedValue(value: unknown, budget: number): unknown {
	if (typeof value === "string")
		return value.slice(0, fittingPrefix(value, budget - OP_OVERHEAD_BYTES)) + TRUNCATED_MARK;
	if (!Array.isArray(value)) return undefined;
	let bytes = OP_OVERHEAD_BYTES;
	let count = 0;
	for (const item of value) {
		bytes += Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8") + 1;
		if (bytes > budget) break;
		count++;
	}
	return count > 0 ? value.slice(0, count) : undefined;
}

/**
 * `ops` in order, each encoded within `budget` bytes. An op over it becomes
 * ops with the same effect: an `add` adds its node bare, then sets its props
 * (the primary text of a text kind by `text` appends) and adds its children;
 * `text` and `splice` send their string in pieces; a `set` sends one key at
 * a time. A single prop value no op can carry whole (a `diff`'s `text`, a
 * `table`'s `rows`) is cut to its longest leading part that fits, with a
 * warning; only a value with no such part (an object) is dropped.
 */
export function boundOps(ops: readonly TspOp[], budget: number): SizedOp[] {
	const units = Math.max(1, Math.floor((budget - OP_OVERHEAD_BYTES) / 6));
	const out: SizedOp[] = [];
	const push = (op: TspOp): void => {
		const entry = sized(op);
		if (entry.bytes <= budget) {
			out.push(entry);
			return;
		}
		switch (op[0]) {
			case "add": {
				const [, id, parent, before, node] = op;
				push(["add", id, parent, before, { ...node, p: undefined, c: undefined }]);
				const textKind = TEXT_KINDS.has(node.k);
				// Prop interfaces have no index signature; `entries` reads them as plain records.
				const props: [string, unknown][] = Object.entries(node.p ?? {});
				for (const [key, value] of props) {
					if (textKind && key === "text" && typeof value === "string") {
						for (const piece of textPieces(value, units)) push(["text", id, "append", piece]);
					} else {
						push(["set", id, { [key]: value }]);
					}
				}
				for (const child of node.c ?? []) push(["add", child.id, id, null, child]);
				return;
			}
			case "text": {
				const [, id, mode, text] = op;
				const pieces = textPieces(text, units);
				for (let i = 0; i < pieces.length; i++) push(["text", id, i === 0 ? mode : "append", pieces[i]!]);
				return;
			}
			case "splice": {
				const [, id, at, del, text] = op;
				let offset = at;
				const pieces = textPieces(text, units);
				for (let i = 0; i < pieces.length; i++) {
					push(["splice", id, offset, i === 0 ? del : 0, pieces[i]!]);
					offset += pieces[i]!.length;
				}
				return;
			}
			case "set": {
				const [, id, props] = op;
				let only: string | undefined;
				let many = false;
				for (const key in props) {
					if (only === undefined) only = key;
					else many = true;
				}
				if (many) {
					for (const key in props) push(["set", id, { [key]: props[key] }]);
					return;
				}
				if (only === undefined) return;
				const value = truncatedValue(props[only], budget);
				const cut = value === undefined ? undefined : sized(["set", id, { [only]: value }]);
				if (cut && cut.bytes <= budget) {
					logger.warn("TSP: prop too large for one frame; truncated", { id, key: only, bytes: entry.bytes });
					out.push(cut);
				} else {
					logger.warn("TSP: prop too large for one frame; dropped", { id, key: only, bytes: entry.bytes });
				}
				return;
			}
			default:
				logger.warn("TSP: op too large for one frame; dropped", { op: op[0], bytes: entry.bytes });
				return;
		}
	};
	for (const op of ops) push(op);
	return out;
}
