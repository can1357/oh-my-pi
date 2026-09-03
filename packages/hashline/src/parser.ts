/**
 * Token-driven state machine that turns a stream of {@link Token}s into a
 * flat list of {@link Edit}s. Sits between the {@link Tokenizer} and the
 * applier.
 */
import { HL_PAYLOAD_REPLACE, HL_RANGE_SEP } from "./format";
import {
	type AbsoluteRangeOp,
	BARE_BODY_AUTO_PIPED_WARNING,
	BARE_RANGE_AUTO_PUT_WARNING,
	COLON_ON_REGISTER_PUT,
	COLONLESS_PUT_TAKES_NO_BODY,
	COLONLESS_SPAN_PUT,
	CUT_COLON_IGNORED_WARNING,
	CUT_TAKES_NO_BODY,
	DIFF_OLD_ROWS_IGNORED_WARNING,
	EMPTY_INSERT,
	EMPTY_PUT_AUTO_CUT_WARNING,
	invalidAbsoluteRangeMessage,
	literalOpRowWarning,
	MINUS_BULLET_AUTO_PIPED_WARNING,
	MINUS_ROW_REJECTED,
	MOVE_TAKES_NO_BODY,
	READ_METADATA_IGNORED_WARNING,
	REGISTER_PUT_TAKES_NO_BODY,
	REM_TAKES_NO_BODY,
	REPLACE_PAIR_COALESCED_WARNING,
	repeatedSnapshotRowMessage,
	SNAPSHOT_ROWS_AUTO_PUT_WARNING,
} from "./messages";
import { isReadMetadataLine, stripOneLeadingHashlinePrefix } from "./prefixes";
import { type BlockTarget, cloneCursor, isHunkHeaderText, type ParsedRange, type Token, Tokenizer } from "./tokenizer";
import type { Anchor, BlockSpan, Cursor, Edit, FileOp, PasteTarget } from "./types";

/** Bounds parser amplification before the target file's line count is available. */
const MAX_EXPANDED_RANGE_LINES = 100_000;
/** Parser error carrying enough range metadata for source-aware diagnostic enrichment. */
export class InvalidAbsoluteRangeError extends Error {
	/** Patch-language line containing the invalid range header. */
	readonly patchLine: number;
	/** Absolute first source line authored in the range. */
	readonly startLine: number;
	/** Invalid absolute last source line authored in the range. */
	readonly endLine: number;
	/** Operation whose range was invalid. */
	readonly op: AbsoluteRangeOp;
	readonly register?: string;

	constructor(
		patchLine: number,
		startLine: number,
		endLine: number,
		op: AbsoluteRangeOp,
		block?: BlockSpan,
		register?: string,
	) {
		super(invalidAbsoluteRangeMessage(patchLine, startLine, endLine, op, block, register));
		this.name = "InvalidAbsoluteRangeError";
		this.patchLine = patchLine;
		this.startLine = startLine;
		this.endLine = endLine;
		this.op = op;
		this.register = register;
	}

	/** Rebuild this error with a proven syntactic-block endpoint suggestion. */
	withBlock(block: BlockSpan): InvalidAbsoluteRangeError {
		return new InvalidAbsoluteRangeError(this.patchLine, this.startLine, this.endLine, this.op, block, this.register);
	}
}

function validateRange(range: ParsedRange, lineNum: number, op: AbsoluteRangeOp, register?: string): void {
	if (
		!Number.isSafeInteger(range.start.line) ||
		range.start.line < 1 ||
		!Number.isSafeInteger(range.end.line) ||
		range.end.line < 1
	) {
		throw new Error(
			`line ${lineNum}: ${op} range endpoints must be positive safe integers; got ${range.start.line} and ${range.end.line}.`,
		);
	}
	if (range.end.line < range.start.line) {
		throw new InvalidAbsoluteRangeError(lineNum, range.start.line, range.end.line, op, undefined, register);
	}
	const span = range.end.line - range.start.line + 1;
	if (span > MAX_EXPANDED_RANGE_LINES) {
		throw new Error(
			`line ${lineNum}: ${op} range spans ${span} lines; the maximum is ${MAX_EXPANDED_RANGE_LINES}. Split it into smaller hunks.`,
		);
	}
}

function isSkippableCommentLine(line: string): boolean {
	return line.trimStart().startsWith("#");
}

/**
 * Body-row rejection message for ops that take no `+TEXT` rows, or `null`
 * for ops whose header (`:`) promises a body.
 */
function bodylessTargetMessage(target: BlockTarget, hadColon: boolean): string | null {
	if (target.kind === "cut" || target.kind === "cut_block") return CUT_TAKES_NO_BODY;
	if (target.kind === "rem" || target.kind === "move") return null;
	if (target.register !== undefined) return REGISTER_PUT_TAKES_NO_BODY;
	if (!hadColon) return COLONLESS_PUT_TAKES_NO_BODY;
	return null;
}

/**
 * Stripped remainder of a bare `N: <value>` row that is a lone quoted or
 * numeric literal (optionally comma-terminated) — the shape of a numeric-keyed
 * dict/YAML body rather than read-output paste.
 */
const BARE_LITERAL_VALUE_RE = /^\s*(?:"[^"]*"|'[^']*'|[-+]?\d+(?:\.\d+)?)\s*,?\s*$/;

const TOP_LEVEL_SNAPSHOT_ROW_RE = /^\s*([1-9]\d*)[:|](.*)$/;

function parseTopLevelSnapshotRow(text: string): { line: number; text: string } | null {
	const match = TOP_LEVEL_SNAPSHOT_ROW_RE.exec(text);
	if (match === null) return null;
	const line = Number(match[1]);
	if (!Number.isSafeInteger(line)) return null;
	return { line, text: match[2] };
}
const TOP_LEVEL_BARE_RANGE_HEADER_RE = /^\s*([1-9]\d*)(?:\s|[-.=…])+([1-9]\d*)\s*:\s*$/;

function parseTopLevelBareRangeHeader(text: string): ParsedRange | null {
	const match = TOP_LEVEL_BARE_RANGE_HEADER_RE.exec(text);
	if (match === null) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
	return { start: { line: start }, end: { line: end } };
}

/**
 * Markdown-bullet shape: optional indent, `-`, exactly one space, then
 * content. Unified-diff `-` rows almost never match — code lines get the `-`
 * glued on (`-old()`) and indented deletions carry multiple spaces (`-    x`).
 */
const MD_BULLET_ROW_RE = /^\s*- \S/;

function detectApplyPatchContamination(text: string, _hasPending: boolean): string | null {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;
	if (
		trimmed.startsWith("*** Update File:") ||
		trimmed.startsWith("*** Add File:") ||
		trimmed.startsWith("*** Delete File:") ||
		trimmed.startsWith("*** Move to:")
	) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`apply_patch sentinel ${JSON.stringify(preview)} is not valid in hashline. ` +
			"File sections start with `[path#HASH]` (no `Update File:` / `Add File:` keyword). " +
			`Use \`PUT N${HL_RANGE_SEP}M:\`, \`CUT N${HL_RANGE_SEP}M\`, or \`PUT <N:\`/\`PUT >N:\` ops.`
		);
	}
	if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(trimmed)) {
		return (
			"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
			`Use \`PUT N${HL_RANGE_SEP}M:\`, \`CUT N${HL_RANGE_SEP}M\`, or \`PUT <N:\`/\`PUT >N:\` ops.`
		);
	}
	if (trimmed.startsWith("@@")) {
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return (
			`\`@@\`-bracketed hunk header ${JSON.stringify(preview)} is not valid in hashline. ` +
			`Drop the \`@@ ... @@\` brackets and write a header such as \`PUT N${HL_RANGE_SEP}M:\`.`
		);
	}
	if (/^[1-9]\d*\s*$/.test(trimmed)) {
		return `hunk headers need a verb and both endpoints. Use \`PUT ${trimmed}${HL_RANGE_SEP}${trimmed}:\` to replace, or \`CUT ${trimmed}${HL_RANGE_SEP}${trimmed}\` to delete.`;
	}
	const bareRange = /^([1-9]\d*)\s+(?:[1-9]\d*)\s*:?$/.exec(trimmed);
	if (bareRange !== null) {
		return (
			`bare range hunk header ${JSON.stringify(trimmed)} is not valid. ` +
			`Hunk headers need a verb: use \`PUT N${HL_RANGE_SEP}M:\` or \`CUT N${HL_RANGE_SEP}M\`.`
		);
	}
	return null;
}

interface PendingComment {
	lineNum: number;
	text: string;
}

type PayloadRow = { kind: "literal"; text: string; lineNum: number; bare?: boolean; minus?: boolean };

interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	/** Whether the header carried `:` — the promise that body rows follow. */
	hadColon: boolean;
	/**
	 * Blank rows seen after the body started. Interior blanks are committed to
	 * the payload when the next non-blank row arrives; trailing blanks before
	 * the next header/op are layout separators and are discarded on flush.
	 */
	deferredBlanks: PayloadRow[];
}

export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#fileOp: FileOp | undefined;
	#terminated = false;
	#skippableComments: PendingComment[] = [];
	/** Source lines already recovered from top-level `N:TEXT` rows in this section. */
	#recoveredSnapshotLines = new Set<number>();

	#discardPendingSkippableComments(): void {
		this.#skippableComments = [];
	}

	#consumePendingSkippableComments(): void {
		if (this.#skippableComments.length === 0) return;
		for (const comment of this.#skippableComments) this.#handleRaw(comment.text, comment.lineNum);
		this.#skippableComments = [];
	}

	feed(token: Token): void {
		if (this.#terminated) return;
		switch (token.kind) {
			case "envelope-begin":
				this.#consumePendingSkippableComments();
				return;
			case "envelope-end":
				this.#consumePendingSkippableComments();
				this.#terminated = true;
				return;
			case "abort":
				this.#terminated = true;
				return;
			case "header":
				this.#consumePendingSkippableComments();
				this.#flushPending();
				return;
			case "blank":
				this.#consumePendingSkippableComments();
				this.#handleBlank("", token.lineNum);
				return;
			case "payload-literal":
				this.#consumePendingSkippableComments();
				this.#handleLiteralPayload(token.text, token.lineNum);
				return;
			case "raw":
				if (this.#pending === undefined && isSkippableCommentLine(token.text)) {
					this.#skippableComments.push({ text: token.text, lineNum: token.lineNum });
					return;
				}
				this.#consumePendingSkippableComments();
				this.#handleRaw(token.text, token.lineNum);
				return;
			case "op-block": {
				this.#discardPendingSkippableComments();
				const target = token.target;
				if (target.kind === "replace") {
					validateRange(target.range, token.lineNum, "replace", target.register);
				}
				if (target.kind === "cut") {
					validateRange(target.range, token.lineNum, "cut", target.register);
				}
				// `:` exclusively promises body rows; ops that never take a body
				// reject it outright so the sigil keeps one meaning.
				if (token.hadColon && (target.kind === "cut" || target.kind === "cut_block")) {
					if (!this.#warnings.includes(CUT_COLON_IGNORED_WARNING)) {
						this.#warnings.push(CUT_COLON_IGNORED_WARNING);
					}
				}
				if (token.hadColon && target.kind !== "rem" && target.kind !== "move" && target.register !== undefined) {
					throw new Error(`line ${token.lineNum}: ${COLON_ON_REGISTER_PUT}`);
				}
				if (target.kind === "rem") {
					this.#flushPending();
					this.#setFileOp({ kind: "rem" }, token.lineNum);
					return;
				}
				if (target.kind === "move") {
					this.#flushPending();
					this.#setFileOp({ kind: "move", dest: target.dest }, token.lineNum);
					return;
				}
				this.#flushPending();
				this.#pending = {
					target,
					lineNum: token.lineNum,
					payloads: [],
					hadColon: token.hadColon,
					deferredBlanks: [],
				};
				return;
			}
		}
	}

	end(): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
		this.#consumePendingSkippableComments();
		this.#flushPending();
		this.#validateFileOp();
		this.#normalizeOverlappingRanges();
		return {
			edits: this.#edits,
			...(this.#fileOp === undefined ? {} : { fileOp: this.#fileOp }),
			warnings: this.#warnings,
		};
	}

	endStreaming(): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
		this.#consumePendingSkippableComments();
		const pending = this.#pending;
		if (pending && (pending.payloads.length > 0 || this.#isCompleteBodylessOp(pending))) this.#flushPending();
		else this.#pending = undefined;
		this.#validateFileOp();
		this.#normalizeOverlappingRanges();
		return {
			edits: this.#edits,
			...(this.#fileOp === undefined ? {} : { fileOp: this.#fileOp }),
			warnings: this.#warnings,
		};
	}

	/**
	 * True when a payload-less pending op is already a complete, valid op —
	 * safe to flush at the end of a streaming parse. A `:`-op still awaiting
	 * body rows and the invalid colonless-span shape (possibly a truncated
	 * `PUT 5-9 @reg` line) are dropped instead.
	 */
	#isCompleteBodylessOp(pending: Pending): boolean {
		const { target, hadColon } = pending;
		if (target.kind === "cut" || target.kind === "cut_block") return true;
		if (target.kind === "rem" || target.kind === "move") return false;
		if (target.register !== undefined) return true;
		if (hadColon) return false;
		return (
			target.kind === "insert_before" ||
			target.kind === "insert_after" ||
			target.kind === "insert_after_block" ||
			target.kind === "bof" ||
			target.kind === "eof"
		);
	}

	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#fileOp = undefined;
		this.#skippableComments = [];
		this.#terminated = false;
	}

	#setFileOp(fileOp: FileOp, lineNum: number): void {
		if (this.#fileOp !== undefined) {
			throw new Error(
				`line ${lineNum}: only one file-level op (\`REM\` or \`MV\`) per section. Merge them under one header.`,
			);
		}
		if (fileOp.kind === "rem" && this.#edits.length > 0) {
			throw new Error(`line ${lineNum}: ${REM_TAKES_NO_BODY}`);
		}
		this.#fileOp = fileOp;
	}

	#validateFileOp(): void {
		if (this.#fileOp?.kind !== "rem") return;
		if (this.#edits.length > 0) {
			throw new Error("`REM` deletes the whole file and cannot be combined with line ops.");
		}
	}

	#normalizeOverlappingRanges(): void {
		type ConcreteHunk = {
			lineNum: number;
			sourceLines: Set<number>;
			clipboardDependent: boolean;
		};
		const hunks = new Map<number, ConcreteHunk>();
		const hunkFor = (lineNum: number): ConcreteHunk => {
			let hunk = hunks.get(lineNum);
			if (hunk === undefined) {
				hunk = { lineNum, sourceLines: new Set(), clipboardDependent: false };
				hunks.set(lineNum, hunk);
			}
			return hunk;
		};
		for (const edit of this.#edits) {
			if (edit.kind === "cut") {
				hunkFor(edit.lineNum).clipboardDependent = true;
				continue;
			}
			if (edit.kind === "paste" && edit.at.kind === "span") {
				const hunk = hunkFor(edit.lineNum);
				hunk.clipboardDependent = true;
				for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line++) {
					hunk.sourceLines.add(line);
				}
				continue;
			}
			if (edit.kind === "delete") hunkFor(edit.lineNum).sourceLines.add(edit.anchor.line);
		}

		const ownerByLine = new Map<number, ConcreteHunk>();
		const dropped = new Set<number>();
		const claim = (hunk: ConcreteHunk): void => {
			for (const line of hunk.sourceLines) ownerByLine.set(line, hunk);
		};
		for (const hunk of hunks.values()) {
			if (hunk.sourceLines.size === 0) continue;
			const overlaps = new Set<ConcreteHunk>();
			let firstOverlap: number | undefined;
			for (const line of hunk.sourceLines) {
				const owner = ownerByLine.get(line);
				if (owner === undefined) continue;
				overlaps.add(owner);
				firstOverlap ??= line;
			}
			if (overlaps.size === 0) {
				claim(hunk);
				continue;
			}
			const previous = overlaps.size === 1 ? overlaps.values().next().value : undefined;
			const exact =
				previous !== undefined &&
				previous.sourceLines.size === hunk.sourceLines.size &&
				[...hunk.sourceLines].every(line => previous.sourceLines.has(line));
			if (exact && !previous.clipboardDependent) {
				dropped.add(previous.lineNum);
				for (const line of previous.sourceLines) {
					if (ownerByLine.get(line) === previous) ownerByLine.delete(line);
				}
				claim(hunk);
				if (!this.#warnings.includes(REPLACE_PAIR_COALESCED_WARNING)) {
					this.#warnings.push(REPLACE_PAIR_COALESCED_WARNING);
				}
				continue;
			}
			throw new Error(
				`line ${hunk.lineNum}: anchor line ${firstOverlap} is already targeted by another hunk on line ${previous?.lineNum ?? "an earlier line"}. ` +
					"Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.",
			);
		}
		if (dropped.size > 0) this.#edits = this.#edits.filter(edit => !dropped.has(edit.lineNum));
	}

	#handleLiteralPayload(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) {
			if (this.#fileOp !== undefined) throw new Error(`line ${lineNum}: ${MOVE_TAKES_NO_BODY}`);
			throw new Error(
				`line ${lineNum}: payload line has no preceding hunk header. ` +
					`Got ${JSON.stringify(`${HL_PAYLOAD_REPLACE}${text}`)}.`,
			);
		}
		const noBodyOnLiteral = bodylessTargetMessage(pending.target, pending.hadColon);
		if (noBodyOnLiteral !== null) throw new Error(`line ${lineNum}: ${noBodyOnLiteral}`);
		this.#commitDeferredBlanks(pending);
		// An op written with the payload prefix is inserted as literal text. That
		// is the correct reading of `+TEXT`, but it silently plants a `CUT …` line
		// in the file, so name it at the moment it happens.
		if (isHunkHeaderText(text)) this.#warnings.push(literalOpRowWarning(lineNum, text));
		pending.payloads.push({ kind: "literal", text, lineNum });
	}

	#handleRaw(text: string, lineNum: number): void {
		if (this.#pending === undefined && isReadMetadataLine(text)) {
			if (!this.#warnings.includes(READ_METADATA_IGNORED_WARNING)) {
				this.#warnings.push(READ_METADATA_IGNORED_WARNING);
			}
			return;
		}
		const contamination = detectApplyPatchContamination(text, this.#pending !== undefined);
		if (contamination !== null) throw new Error(`line ${lineNum}: ${contamination}`);
		if (this.#fileOp !== undefined) throw new Error(`line ${lineNum}: ${MOVE_TAKES_NO_BODY}`);
		if (this.#pending) {
			if (text.trim().length === 0) {
				this.#handleBlank(text, lineNum);
				return;
			}
			const noBodyOnRaw = bodylessTargetMessage(this.#pending.target, this.#pending.hadColon);
			if (noBodyOnRaw !== null) throw new Error(`line ${lineNum}: ${noBodyOnRaw}`);
			const row: PayloadRow = { kind: "literal", text, lineNum, bare: true };
			// `-` rows are held and judged at flush time by #resolveMinusRows,
			// once the whole body is visible.
			if (text.trimStart().charCodeAt(0) === 45 /* - */) row.minus = true;
			else if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING))
				this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
			this.#commitDeferredBlanks(this.#pending);
			// Defer read-output line-number stripping to #flushPending: a bare
			// "N:text" row is only a copy-paste artifact from snapshot output
			// when *every* bare row in the hunk carries that prefix. Stripping a
			// row in isolation would corrupt a genuine body that merely starts
			// with "digits:" (YAML ports "42:hello", timestamps "12:30") when it
			// sits next to an unprefixed sibling. Rows with an explicit "+" go
			// through #handleLiteralPayload and are never bare, never stripped.
			this.#pending.payloads.push(row);
			return;
		}
		if (text.trim().length === 0) return;
		const bareRange = parseTopLevelBareRangeHeader(text);
		if (bareRange !== null) {
			validateRange(bareRange, lineNum, "replace");
			this.#pending = {
				target: { kind: "replace", range: bareRange },
				lineNum,
				payloads: [],
				hadColon: true,
				deferredBlanks: [],
			};
			if (!this.#warnings.includes(BARE_RANGE_AUTO_PUT_WARNING)) {
				this.#warnings.push(BARE_RANGE_AUTO_PUT_WARNING);
			}
			return;
		}
		const snapshotRow = parseTopLevelSnapshotRow(text);
		if (snapshotRow !== null) {
			// Each recovered row becomes a single-line replacement, so a repeated
			// line number is never a set of replacements — it is a body written as
			// consecutive lines under one number. Collapsing it would silently keep
			// only the last row and drop the rest.
			if (this.#recoveredSnapshotLines.has(snapshotRow.line)) {
				throw new Error(`line ${lineNum}: ${repeatedSnapshotRowMessage(snapshotRow.line)}`);
			}
			this.#recoveredSnapshotLines.add(snapshotRow.line);
			const range = { start: { line: snapshotRow.line }, end: { line: snapshotRow.line } };
			validateRange(range, lineNum, "replace");
			this.#pushInsert(
				{ kind: "before_anchor", anchor: { line: snapshotRow.line } },
				snapshotRow.text,
				lineNum,
				"replacement",
			);
			this.#pushDeleteRange(range, lineNum);
			if (!this.#warnings.includes(SNAPSHOT_ROWS_AUTO_PUT_WARNING)) {
				this.#warnings.push(SNAPSHOT_ROWS_AUTO_PUT_WARNING);
			}
			return;
		}
		throw new Error(
			`line ${lineNum}: payload line has no preceding hunk header. ` +
				`Use \`PUT N${HL_RANGE_SEP}M:\`, \`CUT N${HL_RANGE_SEP}M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got ${JSON.stringify(text)}.`,
		);
	}

	/**
	 * A blank row inside a hunk body is ambiguous: interior blanks are body
	 * content (a bare-pasted body legitimately contains empty lines), while
	 * blanks before the body starts or trailing into the next op are layout.
	 * Defer them; {@link #commitDeferredBlanks} folds them in only when a later
	 * non-blank row proves they were interior.
	 */
	#handleBlank(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (!pending) return;
		if (bodylessTargetMessage(pending.target, pending.hadColon) !== null) return;
		if (pending.payloads.length === 0) return;
		pending.deferredBlanks.push({ kind: "literal", text, lineNum, bare: true });
	}

	#commitDeferredBlanks(pending: Pending): void {
		if (pending.deferredBlanks.length === 0) return;
		if (!this.#warnings.includes(BARE_BODY_AUTO_PIPED_WARNING)) this.#warnings.push(BARE_BODY_AUTO_PIPED_WARNING);
		pending.payloads.push(...pending.deferredBlanks);
		pending.deferredBlanks = [];
	}

	/**
	 * Judge bare `-` body rows once the whole hunk body is known. Non-bullet
	 * rows paired with explicit `+new` rows are unified-diff contamination, so
	 * discard the redundant old rows. Unambiguously literal Markdown bullets
	 * are kept. Other `-` rows remain rejected rather than silently corrupting
	 * source.
	 */
	#resolveMinusRows(payloads: PayloadRow[]): void {
		let firstMinus: PayloadRow | undefined;
		let allBulletShaped = true;
		let hasExplicit = false;
		let hasExplicitBullet = false;
		for (const row of payloads) {
			if (row.minus) {
				firstMinus ??= row;
				allBulletShaped &&= MD_BULLET_ROW_RE.test(row.text);
			} else if (!row.bare) {
				hasExplicit = true;
				hasExplicitBullet ||= MD_BULLET_ROW_RE.test(row.text);
			}
		}
		if (firstMinus === undefined) return;
		if (allBulletShaped && (!hasExplicit || hasExplicitBullet)) {
			if (!this.#warnings.includes(MINUS_BULLET_AUTO_PIPED_WARNING))
				this.#warnings.push(MINUS_BULLET_AUTO_PIPED_WARNING);
			return;
		}
		if (hasExplicit && !allBulletShaped) {
			for (let i = payloads.length - 1; i >= 0; i--) {
				if (payloads[i].minus) payloads.splice(i, 1);
			}
			if (!this.#warnings.includes(DIFF_OLD_ROWS_IGNORED_WARNING)) {
				this.#warnings.push(DIFF_OLD_ROWS_IGNORED_WARNING);
			}
			return;
		}
		throw new Error(`line ${firstMinus.lineNum}: ${MINUS_ROW_REJECTED}`);
	}

	/**
	 * Strip a single read-output line-number prefix (`N:` or `N|`) from every
	 * bare body row, but only when *all* bare rows carry one. A uniform set of
	 * prefixes is the signature of content pasted straight from `read`/`search`
	 * output; a mixed set means the prefix is genuine payload content and must
	 * stay. Rows authored with an explicit `+` are not bare and are never touched.
	 */
	#stripBarePrefixesIfUniform(payloads: PayloadRow[]): void {
		let sawBare = false;
		let allLiteralValues = true;
		for (const row of payloads) {
			if (!row.bare || row.text.trim().length === 0) continue;
			sawBare = true;
			const stripped = stripOneLeadingHashlinePrefix(row.text);
			if (stripped === row.text) return;
			allLiteralValues &&= BARE_LITERAL_VALUE_RE.test(stripped);
		}
		if (!sawBare) return;
		// A body where every stripped remainder is a lone quoted/numeric literal
		// (optionally comma-terminated) is the shape of a numeric-keyed dict or
		// YAML mapping (`1: "one",`), not read-output paste; stripping the "N:"
		// keys would mangle every line. Leave such bodies untouched.
		if (allLiteralValues) return;
		for (const row of payloads) {
			if (row.bare && row.text.trim().length > 0) row.text = stripOneLeadingHashlinePrefix(row.text);
		}
	}

	#pushInsert(cursor: Cursor, text: string, lineNum: number, mode?: "replacement"): void {
		this.#edits.push({
			kind: "insert",
			cursor: cloneCursor(cursor),
			text,
			lineNum,
			index: this.#editIndex++,
			...(mode === undefined ? {} : { mode }),
		});
	}

	#pushDelete(anchor: Anchor, lineNum: number): void {
		this.#edits.push({ kind: "delete", anchor: { ...anchor }, lineNum, index: this.#editIndex++ });
	}

	#pushDeleteRange(range: ParsedRange, lineNum: number): void {
		for (let line = range.start.line; line <= range.end.line; line++) this.#pushDelete({ line }, lineNum);
	}

	#pushCut(range: ParsedRange, lineNum: number, register: string | undefined): void {
		this.#edits.push({
			kind: "cut",
			range: { start: { ...range.start }, end: { ...range.end } },
			...(register === undefined ? {} : { register }),
			lineNum,
			index: this.#editIndex++,
		});
		// Capture before ordinary per-line deletes are applied. Keeping deletion
		// as low-level edits preserves overlap validation and recovery remapping.
		this.#pushDeleteRange(range, lineNum);
	}

	#pushPaste(at: PasteTarget, register: string | undefined, lineNum: number): void {
		this.#edits.push({
			kind: "paste",
			at,
			...(register === undefined ? {} : { register }),
			lineNum,
			index: this.#editIndex++,
		});
	}

	#pushBlock(
		anchor: Anchor,
		payloads: readonly PayloadRow[],
		lineNum: number,
		mode?: "insert_after" | "cut" | "paste_after",
		register?: string,
	): void {
		this.#edits.push({
			kind: "block",
			anchor: { ...anchor },
			payloads: payloads.map(payload => payload.text),
			...(mode === undefined ? {} : { mode }),
			...(register === undefined ? {} : { register }),
			lineNum,
			index: this.#editIndex++,
		});
	}

	#emitPayloadRows(cursor: Cursor, payloads: readonly PayloadRow[], lineNum: number, mode?: "replacement"): void {
		for (const payload of payloads) this.#pushInsert(cursor, payload.text, lineNum, mode);
	}

	#flushPending(): void {
		const pending = this.#pending;
		if (!pending) return;
		const { target, lineNum, payloads, hadColon } = pending;
		this.#resolveMinusRows(payloads);
		this.#stripBarePrefixesIfUniform(payloads);
		this.#pending = undefined;
		if (target.kind === "rem" || target.kind === "move") return;
		if (target.kind === "cut") {
			this.#pushCut(target.range, lineNum, target.register);
			return;
		}
		if (target.kind === "cut_block") {
			this.#pushBlock(target.anchor, [], lineNum, "cut", target.register);
			return;
		}
		// Span targets: body writes, register pastes over the span; the
		// anonymous register never pastes over a span (too easy to fire by
		// forgetting `:` + body on a replace).
		if (target.kind === "replace") {
			if (target.register !== undefined) {
				this.#pushPaste(
					{ kind: "span", range: { start: { ...target.range.start }, end: { ...target.range.end } } },
					target.register,
					lineNum,
				);
				return;
			}
			if (payloads.length === 0) {
				if (!hadColon) throw new Error(`line ${lineNum}: ${COLONLESS_SPAN_PUT}`);
				this.#pushDeleteRange(target.range, lineNum);
				if (!this.#warnings.includes(EMPTY_PUT_AUTO_CUT_WARNING)) {
					this.#warnings.push(EMPTY_PUT_AUTO_CUT_WARNING);
				}
				return;
			}
			const cursor: Cursor = { kind: "before_anchor", anchor: { ...target.range.start } };
			this.#emitPayloadRows(cursor, payloads, lineNum, "replacement");
			this.#pushDeleteRange(target.range, lineNum);
			return;
		}
		if (target.kind === "block") {
			if (target.register !== undefined) {
				this.#pushBlock(target.anchor, [], lineNum, undefined, target.register);
				return;
			}
			if (payloads.length === 0) {
				if (!hadColon) throw new Error(`line ${lineNum}: ${COLONLESS_SPAN_PUT}`);
				this.#pushBlock(target.anchor, [], lineNum);
				if (!this.#warnings.includes(EMPTY_PUT_AUTO_CUT_WARNING)) {
					this.#warnings.push(EMPTY_PUT_AUTO_CUT_WARNING);
				}
				return;
			}
			this.#pushBlock(target.anchor, payloads, lineNum);
			return;
		}
		// Gap targets: body inserts, register pastes, and the colonless
		// bodyless form is an anonymous paste.
		if (target.kind === "insert_after_block") {
			if (target.register !== undefined || (!hadColon && payloads.length === 0)) {
				this.#pushBlock(target.anchor, [], lineNum, "paste_after", target.register);
				return;
			}
			if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_INSERT}`);
			this.#pushBlock(target.anchor, payloads, lineNum, "insert_after");
			return;
		}
		const cursor: Cursor =
			target.kind === "insert_before"
				? { kind: "before_anchor", anchor: { ...target.anchor } }
				: target.kind === "insert_after"
					? { kind: "after_anchor", anchor: { ...target.anchor } }
					: target.kind === "bof"
						? { kind: "bof" }
						: { kind: "eof" };
		if (target.register !== undefined || (!hadColon && payloads.length === 0)) {
			this.#pushPaste({ kind: "gap", cursor }, target.register, lineNum);
			return;
		}
		if (payloads.length === 0) throw new Error(`line ${lineNum}: ${EMPTY_INSERT}`);
		this.#emitPayloadRows(cursor, payloads, lineNum);
	}
}

function drain(executor: Executor, tokenizer: Tokenizer): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.end();
}

export function parsePatch(diff: string): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	return drain(executor, tokenizer);
}

export function parsePatchStreaming(diff: string): { edits: Edit[]; fileOp?: FileOp; warnings: string[] } {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	for (const token of tokenizer.feed(diff)) executor.feed(token);
	for (const token of tokenizer.end()) executor.feed(token);
	return executor.endStreaming();
}
