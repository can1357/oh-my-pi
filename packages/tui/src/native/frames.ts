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

/** An op with its encoded JSON size in bytes. */
export interface SizedOp {
	readonly op: TspOp;
	readonly bytes: number;
}

function sized(op: TspOp): SizedOp {
	return { op, bytes: Buffer.byteLength(JSON.stringify(op), "utf8") };
}

/**
 * Cut `text` into pieces of at most `units` UTF-16 code units, never between
 * a surrogate pair. JSON encodes a code unit in at most 6 bytes.
 */
function textPieces(text: string, units: number): string[] {
	const pieces: string[] = [];
	for (let at = 0; at < text.length;) {
		let end = Math.min(text.length, at + units);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff) end--;
		pieces.push(text.slice(at, end));
		at = end;
	}
	return pieces;
}

/**
 * `ops` in order, each encoded within `budget` bytes. An op over it becomes
 * ops with the same effect: an `add` adds its node bare, then sets its props
 * (the primary text of a text kind by `text` appends) and adds its children;
 * `text` and `splice` send their string in pieces; a `set` sends one key at
 * a time. A single prop value that still cannot fit is dropped with a
 * warning, so the frame stays deliverable.
 */
export function boundOps(ops: readonly TspOp[], budget: number): SizedOp[] {
	// Room for the op's JSON around its text piece (op name, id, quotes).
	const units = Math.max(1, Math.floor((budget - 1024) / 6));
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
				logger.warn("TSP: prop too large for one frame; dropped", { id, key: only, bytes: entry.bytes });
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
