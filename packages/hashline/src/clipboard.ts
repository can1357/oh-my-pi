/**
 * Clipboard register support for `CUT` and register `PUT` ops.
 *
 * `CUT` captures source lines before ordinary delete edits apply. Register
 * `PUT`s expand captured lines into inserts (plus per-line deletes when the
 * target is a `span`). Named registers (`named: Map`) persist across edit
 * batches when host-owned (`PatcherOptions.clipboard`); the anonymous register
 * (`lines`) is batch-local and resets between calls.
 */
import { HL_CUT_KEYWORD, HL_PUT_KEYWORD, HL_RANGE_SEP } from "./format";
import {
	ambiguousAnonymousPasteMessage,
	EMPTY_PASTE,
	emptyRegisterPasteWarning,
	emptyRegisterSpanPasteMessage,
} from "./messages";
import { cloneCursor } from "./tokenizer";
import type { Clipboard, Edit } from "./types";

type CutEdit = Extract<Edit, { kind: "cut" }>;

function describeCutEdit(edit: CutEdit): string {
	const { start, end } = edit.range;
	const span = start.line === end.line ? `${start.line}` : `${start.line}${HL_RANGE_SEP}${end.line}`;
	const reg = edit.register ? ` @${edit.register}` : "";
	return `${HL_CUT_KEYWORD} ${span}${reg}`;
}

/** True when at least one edit reads or writes a clipboard register. */
export function hasClipboardEdit(edits: readonly Edit[]): boolean {
	return edits.some(
		edit =>
			edit.kind === "cut" ||
			edit.kind === "paste" ||
			(edit.kind === "block" && (edit.mode === "cut" || edit.mode === "paste_after" || edit.register !== undefined)),
	);
}

/** Optional knobs for {@link resolveClipboardEdits}. */
export interface ResolveClipboardEditsOptions {
	/** `PUT` with an empty register: `throw` (default) or `drop` (streaming previews). Named registers never throw — an empty named paste warns and pastes nothing. */
	onEmptyPaste?: "throw" | "drop";
	/** Receives non-fatal diagnostics (e.g. an empty named-register paste). */
	onWarning?: (message: string) => void;
}

/**
 * Read lines from a register. A missing named register reads as empty for a gap
 * paste (a harmless no-op, warned) but throws for a `span` target, where pasting
 * empty would delete the range; anonymous misuse throws unless
 * `onEmptyPaste === "drop"`.
 */
function readRegister(
	register: string | undefined,
	target: "gap" | "span",
	clipboard: Clipboard,
	lineNum: number,
	onEmptyPaste: "throw" | "drop",
	onWarning?: (message: string) => void,
): readonly string[] | null {
	if (register !== undefined) {
		const lines = clipboard.named?.get(register);
		if (lines !== undefined) return lines;
		if (onEmptyPaste === "drop") return null;
		const known = clipboard.named ? [...clipboard.named.keys()] : [];
		if (target === "span") {
			throw new Error(`line ${lineNum}: ${emptyRegisterSpanPasteMessage(register, known)}`);
		}
		onWarning?.(`line ${lineNum}: ${emptyRegisterPasteWarning(register, known)}`);
		return [];
	}

	const pending = clipboard.pendingAnonCuts ?? [];
	if (pending.length > 1) {
		if (onEmptyPaste === "drop") return null;
		throw new Error(`line ${lineNum}: ${ambiguousAnonymousPasteMessage(pending)}`);
	}

	const lines = clipboard.lines;
	if (lines === undefined) {
		if (onEmptyPaste === "drop") return null;
		throw new Error(`line ${lineNum}: ${EMPTY_PASTE}`);
	}
	// Successful anonymous read clears the pending ambiguity counter for follow-up pastes.
	clipboard.pendingAnonCuts = [];
	return lines;
}

/**
 * Write lines into a register (named or anonymous).
 */
function writeRegister(edit: CutEdit, fileLines: readonly string[], clipboard: Clipboard): void {
	const { start, end } = edit.range;
	if (start.line < 1 || end.line > fileLines.length) {
		throw new Error(
			`line ${edit.lineNum}: \`${describeCutEdit(edit)}\` is out of range (file has ${fileLines.length} lines).`,
		);
	}
	const captured = fileLines.slice(start.line - 1, end.line);
	if (edit.register !== undefined) {
		clipboard.named ??= new Map();
		clipboard.named.set(edit.register, captured);
	} else {
		clipboard.lines = captured;
		clipboard.pendingAnonCuts ??= [];
		clipboard.pendingAnonCuts.push(describeCutEdit(edit));
	}
}

/**
 * Resolve clipboard edits against the original file lines in authored order.
 * Cuts fill the register and emit nothing; pastes expand to inserts (+ deletes for span targets).
 */
export function resolveClipboardEdits(
	edits: readonly Edit[],
	fileLines: readonly string[],
	clipboard: Clipboard,
	options: ResolveClipboardEditsOptions = {},
): readonly Edit[] {
	if (!hasClipboardEdit(edits)) return edits;
	const onEmptyPaste = options.onEmptyPaste ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;

	for (const edit of edits) {
		if (edit.kind === "cut") {
			writeRegister(edit, fileLines, clipboard);
			continue;
		}
		if (edit.kind === "paste") {
			const lines = readRegister(
				edit.register,
				edit.at.kind,
				clipboard,
				edit.lineNum,
				onEmptyPaste,
				options.onWarning,
			);
			if (lines === null) continue;

			if (edit.at.kind === "gap") {
				for (const text of lines) {
					resolved.push({
						kind: "insert",
						cursor: cloneCursor(edit.at.cursor),
						text,
						lineNum: edit.lineNum,
						index: synthIndex++,
						...(edit.blockStart === undefined ? {} : { blockStart: edit.blockStart }),
					});
				}
			} else {
				// Span paste: insert replacement lines before start, then delete span lines.
				const range = edit.at.range;
				if (range.start.line < 1 || range.end.line > fileLines.length) {
					const reg = edit.register ? ` @${edit.register}` : "";
					throw new Error(
						`line ${edit.lineNum}: \`${HL_PUT_KEYWORD} ${range.start.line}${HL_RANGE_SEP}${range.end.line}${reg}\` is out of range (file has ${fileLines.length} lines).`,
					);
				}
				const cursor = { kind: "before_anchor" as const, anchor: { line: range.start.line } };
				for (const text of lines) {
					resolved.push({
						kind: "insert",
						cursor: cloneCursor(cursor),
						text,
						lineNum: edit.lineNum,
						index: synthIndex++,
						mode: "replacement",
					});
				}
				for (let line = range.start.line; line <= range.end.line; line++) {
					resolved.push({
						kind: "delete",
						anchor: { line },
						lineNum: edit.lineNum,
						index: synthIndex++,
					});
				}
			}
			continue;
		}
		resolved.push(edit);
	}
	return resolved;
}

/** Start a batch with persisted named registers but no anonymous state. */
export function startClipboardBatch(source?: Clipboard): Clipboard {
	if (source?.named === undefined) return {};
	return { named: new Map(source.named) };
}

/** Create a transactional working copy of a clipboard register. */
export function forkClipboard(source?: Clipboard): Clipboard {
	if (source === undefined) return {};
	return {
		...(source.lines === undefined ? {} : { lines: [...source.lines] }),
		...(source.named === undefined ? {} : { named: new Map(source.named) }),
		...(source.pendingAnonCuts === undefined ? {} : { pendingAnonCuts: [...source.pendingAnonCuts] }),
	};
}

/** Publish a clipboard fork back to its source register (only named registers persist across batches). */
export function commitClipboard(fork: Clipboard, target: Clipboard): void {
	if (fork.named !== undefined) {
		target.named ??= new Map();
		for (const [k, v] of fork.named) target.named.set(k, v);
	}
}

/**
 * Validate anonymous clipboard sequencing (empty or ambiguous unlabeled paste)
 * without mutating the register or reading file content. Empty named-register
 * pastes are non-fatal — they surface as apply-time warnings instead.
 */
export function validateClipboardSequence(edits: readonly Edit[], clipboard: Clipboard): void {
	const fork = forkClipboard(clipboard);
	for (const edit of edits) {
		if (edit.kind === "cut") {
			if (edit.register !== undefined) {
				fork.named ??= new Map();
				fork.named.set(edit.register, []);
			} else {
				fork.lines = [];
				fork.pendingAnonCuts ??= [];
				fork.pendingAnonCuts.push(describeCutEdit(edit));
			}
		} else if (edit.kind === "paste") {
			readRegister(edit.register, edit.at.kind, fork, edit.lineNum, "throw");
		}
	}
}
