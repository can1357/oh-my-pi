/**
 * Apply a parsed list of {@link Edit}s to a text body and return the
 * post-edit lines plus any diagnostic warnings. Pure function: no FS, no
 * mutation of the input.
 *
 * Mis-set replacement range boundaries are repaired by bounded candidate
 * search. Exact line equality, indentation, tree-sitter structure, and a
 * narrow pure-closer shape gate constrain candidates; tree-sitter validates
 * the selected result.
 */

import { resolveClipboardEdits } from "./clipboard";
import {
	afterInsertLandingShiftWarning,
	afterInsertOpenerEscapeWarning,
	ambiguousBoundaryEchoMessage,
	ambiguousBoundaryPlacementMessage,
	blockInsertLandingShiftWarning,
	boundaryVariantRepairWarning,
	editBrokeParseWarning,
	REPLACEMENT_INDENT_AUTO_SHIFT_WARNING,
	textualBoundaryEchoWarning,
	UNRESOLVED_BLOCK_INTERNAL,
	UNRESOLVED_CLIPBOARD_INTERNAL,
} from "./messages";
import { enclosingBoundaries, nodeChain, parsesCleanly } from "./syntax";
import { cloneCursor } from "./tokenizer";
import type { Anchor, ApplyResult, Clipboard, Cursor, Edit } from "./types";

type LineOrigin = "original" | "insert" | "replacement";

type InsertEdit = Extract<Edit, { kind: "insert" }>;
type DeleteEdit = Extract<Edit, { kind: "delete" }>;
type AppliedEdit = InsertEdit | DeleteEdit;

function insertEditAt(edits: readonly AppliedEdit[], index: number): InsertEdit {
	const edit = edits[index];
	if (edit?.kind !== "insert") {
		throw new Error("internal error: after-insert group contains a non-insert edit");
	}
	return edit;
}

interface IndexedEdit {
	edit: AppliedEdit;
	idx: number;
}

function isReplacementInsert(edit: Edit): edit is InsertEdit & { mode: "replacement" } {
	return edit.kind === "insert" && edit.mode === "replacement";
}

function getCursorAnchors(cursor: Cursor): Anchor[] {
	return cursor.kind === "before_anchor" || cursor.kind === "after_anchor" ? [cursor.anchor] : [];
}

function getEditAnchors(edit: AppliedEdit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	return getCursorAnchors(edit.cursor);
}

function trailingPhantomLine(fileLines: readonly string[]): number {
	// `split("\n")` on a newline-terminated file yields a trailing "" sentinel.
	// It is addressable for inserts (append-past-end), but it is not real
	// content. Deleting it only strips the file's final newline, so ignore delete
	// edits that land there; inclusive ranges ending at EOF then do the intended
	// thing and delete through the last concrete line.
	return fileLines.length > 1 && fileLines[fileLines.length - 1] === "" ? fileLines.length : 0;
}

function dropTrailingPhantomDeletes(edits: AppliedEdit[], fileLines: readonly string[]): AppliedEdit[] {
	const phantomLine = trailingPhantomLine(fileLines);
	if (phantomLine === 0) return edits;
	return edits.filter(edit => edit.kind !== "delete" || edit.anchor.line !== phantomLine);
}

/**
 * Verify every anchored edit points at an existing line. File-version binding is
 * checked once per section via the header hash before this function runs.
 */
function validateLineBounds(edits: readonly AppliedEdit[], fileLines: readonly string[]): void {
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) {
			if (anchor.line < 1 || anchor.line > fileLines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
			}
		}
	}
}

function cloneAppliedEdit(edit: AppliedEdit, index: number): AppliedEdit {
	if (edit.kind === "delete") return { ...edit, anchor: { ...edit.anchor }, index };
	return { ...edit, cursor: cloneCursor(edit.cursor), index };
}

function insertAtStart(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): void {
	if (lines.length === 0) return;
	const origins = lines.map((): LineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return;
	}
	fileLines.splice(0, 0, ...lines);
	lineOrigins.splice(0, 0, ...origins);
}

function insertAtEnd(fileLines: string[], lineOrigins: LineOrigin[], lines: string[]): number | undefined {
	if (lines.length === 0) return undefined;
	const origins = lines.map((): LineOrigin => "insert");
	if (fileLines.length === 1 && fileLines[0] === "") {
		fileLines.splice(0, 1, ...lines);
		lineOrigins.splice(0, 1, ...origins);
		return 1;
	}
	const hasTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
	const insertIndex = hasTrailingNewline ? fileLines.length - 1 : fileLines.length;
	fileLines.splice(insertIndex, 0, ...lines);
	lineOrigins.splice(insertIndex, 0, ...origins);
	return insertIndex + 1;
}

function bucketAnchorEditsByLine(edits: IndexedEdit[]): Map<number, IndexedEdit[]> {
	const byLine = new Map<number, IndexedEdit[]>();
	for (const entry of edits) {
		const line =
			entry.edit.kind === "delete"
				? entry.edit.anchor.line
				: entry.edit.cursor.kind === "before_anchor" || entry.edit.cursor.kind === "after_anchor"
					? entry.edit.cursor.anchor.line
					: 0;
		const bucket = byLine.get(line);
		if (bucket) bucket.push(entry);
		else byLine.set(line, [entry]);
	}
	return byLine;
}
// ═══════════════════════════════════════════════════════════════════════════
// Replacement-boundary repair
//
// Models routinely miscount replacement edges: the range swallows an unchanged
// boundary row, or the payload restates rows that survive just outside it.
// Exact outside echoes are normalized from line equality alone. If the authored
// result still does not parse, a bounded whole-patch search may retain the
// selected range's first or effective-last row and may combine that retention
// with exact echo removal.
//
// Retention never follows parse success alone. On a valid baseline, deleting
// the row must itself break syntax; every candidate also requires source-range
// structure and indentation evidence. Distinct candidate texts tied at the
// minimum repair cost are rejected rather than guessed. Pure structural-closer
// rows are recognized only to verify sibling-depth placement.

/** A line that is nothing but closing delimiters: `}`, `)`, `];`, `})`, `},`. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

/**
 * Grammar node kinds for attribute/decorator/annotation rows, per bundled
 * tree-sitter grammar. Statements may repeat verbatim on adjacent lines by
 * intent, but annotations on one item never do — an exact adjacent copy is a
 * boundary echo. This classification is the extra evidence that lets
 * one-sided echo normalization act on single-line ranges (the
 * doc-restoration incident: a `PUT N.=N` landed one line high and its body
 * restated the `#[napi]` surviving just below the range, duplicating the
 * attribute — a result that PARSES, attributes being repeatable syntax, so
 * neither the probe advisory nor the variant search could catch it).
 *
 * Kinds are grammar-blessed names, verified against the bundled parsers —
 * not lexical guesses; `@media` in CSS or `@x` inside a string never
 * classify. Extend per grammar as needed.
 */
const ANNOTATION_NODE_KINDS: Record<string, true> = {
	attribute_item: true, // rust `#[...]`
	inner_attribute_item: true, // rust `#![...]`
	decorator: true, // typescript/tsx/javascript/python
	annotation: true, // kotlin, java `@Foo(...)`
	marker_annotation: true, // java `@Override`
	attribute_list: true, // c# `[Fact]`
};

/** File line `line` is exactly a single-line annotation node. */
function isAnnotationLine(fileLines: readonly string[], path: string, line: number): boolean {
	return nodeChain(fileLines, path, line).some(
		node => node.startLine === line && node.endLine === line && ANNOTATION_NODE_KINDS[node.kind] === true,
	);
}

/** Every file line in the inclusive range is an annotation node. */
function isAnnotationEchoRun(
	fileLines: readonly string[],
	path: string | undefined,
	first: number,
	last: number,
): boolean {
	if (path === undefined) return false;
	for (let line = first; line <= last; line++) {
		if (!isAnnotationLine(fileLines, path, line)) return false;
	}
	return true;
}

interface ReplacementGroup {
	/** Positions in the edit array of the payload inserts, in payload order. */
	insertIndices: number[];
	/** Positions in the edit array of the range deletes, ascending by line. */
	deleteIndices: number[];
	payload: string[];
	/** First deleted line (1-indexed). */
	startLine: number;
	/** Last deleted line (1-indexed). */
	endLine: number;
}

/**
 * Detect a replacement group starting at `start`: a run of `before_anchor`
 * replacement inserts sharing one source op line, immediately followed by the
 * contiguous range deletes for that same op. Mirrors how the parser lowers an
 * `replace N.=M:` hunk with a body.
 */
function findReplacementGroup(edits: readonly AppliedEdit[], start: number): ReplacementGroup | undefined {
	const first = edits[start];
	if (first?.kind !== "insert" || first.mode !== "replacement" || first.cursor.kind !== "before_anchor") {
		return undefined;
	}
	const { lineNum } = first;
	const anchorLine = first.cursor.anchor.line;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "insert" || edit.mode !== "replacement" || edit.lineNum !== lineNum) break;
		if (edit.cursor.kind !== "before_anchor" || edit.cursor.anchor.line !== anchorLine) break;
		insertIndices.push(i);
		payload.push(edit.text);
	}
	const deleteIndices: number[] = [];
	let expectedLine = anchorLine;
	for (; i < edits.length; i++) {
		const edit = edits[i];
		if (edit.kind !== "delete" || edit.lineNum !== lineNum || edit.anchor.line !== expectedLine) break;
		deleteIndices.push(i);
		expectedLine++;
	}
	if (deleteIndices.length === 0) return undefined;
	return {
		insertIndices,
		deleteIndices,
		payload,
		startLine: anchorLine,
		endLine: anchorLine + deleteIndices.length - 1,
	};
}

/**
 * Restore a uniformly omitted base indent only when the payload would escape
 * a surviving `{` opener immediately above the replacement. Matching unchanged
 * rows then prove the uniform shift; ordinary indentation-only edits stay exact.
 */
function repairReplacementIndentation(edits: AppliedEdit[], fileLines: readonly string[]): string[] {
	let repaired = false;
	for (let start = 0; start < edits.length;) {
		const group = findReplacementGroup(edits, start);
		if (group === undefined) {
			start++;
			continue;
		}
		const lastDeleteIndex = group.deleteIndices.at(-1);
		if (lastDeleteIndex === undefined) continue;
		start = lastDeleteIndex + 1;
		if (group.payload.length !== group.deleteIndices.length) continue;
		const preceding = fileLines[group.startLine - 2] ?? "";
		const sourceFirst = fileLines[group.startLine - 1] ?? "";
		const payloadFirst = group.payload[0] ?? "";
		if (
			!preceding.trimEnd().endsWith("{") ||
			!isIndentDeeper(leadingIndent(sourceFirst), leadingIndent(preceding)) ||
			isIndentDeeper(leadingIndent(payloadFirst), leadingIndent(preceding))
		) {
			continue;
		}

		let shift: string | undefined;
		let matches = 0;
		let consistent = true;
		for (let offset = 0; offset < group.payload.length; offset++) {
			const source = fileLines[group.startLine - 1 + offset] ?? "";
			const payload = group.payload[offset];
			if (source.trim().length === 0 || source.trimStart() !== payload.trimStart()) continue;
			const sourceIndent = leadingIndent(source);
			const payloadIndent = leadingIndent(payload);
			if (!sourceIndent.endsWith(payloadIndent)) {
				consistent = false;
				break;
			}
			const candidate = sourceIndent.slice(0, sourceIndent.length - payloadIndent.length);
			if (shift === undefined) shift = candidate;
			else if (shift !== candidate) {
				consistent = false;
				break;
			}
			matches++;
		}
		if (!consistent || !shift || matches < 2 || matches * 2 <= group.payload.length) continue;
		for (const index of group.insertIndices) {
			const edit = edits[index];
			if (edit.kind !== "insert" || edit.text.trim().length === 0) continue;
			edits[index] = { ...edit, text: `${shift}${edit.text}` };
		}
		repaired = true;
	}
	return repaired ? [REPLACEMENT_INDENT_AUTO_SHIFT_WARNING] : [];
}

function hasNonWhitespace(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) return true;
	}
	return false;
}

function countDuplicateLeadingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, startLine } = group;
	const max = Math.min(payload.length, startLine - 1);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[offset];
			if (line !== fileLines[startLine - 1 - count + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}

function countDuplicateTrailingBoundaryLines(group: ReplacementGroup, fileLines: readonly string[]): number {
	const { payload, endLine } = group;
	const max = Math.min(payload.length, fileLines.length - endLine);
	for (let count = max; count >= 1; count--) {
		let matches = true;
		let hasContent = false;
		for (let offset = 0; offset < count; offset++) {
			const line = payload[payload.length - count + offset];
			if (line !== fileLines[endLine + offset]) {
				matches = false;
				break;
			}
			hasContent ||= hasNonWhitespace(line);
		}
		if (matches && hasContent) return count;
	}
	return 0;
}
interface TextualBoundaryAmbiguity {
	readonly startLine: number;
	readonly endLine: number;
	readonly side: "leading" | "trailing";
	readonly count: number;
}

interface TextualBoundaryNormalization {
	readonly edits: AppliedEdit[];
	readonly warnings: string[];
	readonly ambiguities: TextualBoundaryAmbiguity[];
}

/**
 * Normalize exact boundary echoes.
 *
 * Two-sided echoes are removed when stripping both copies leaves one payload
 * row per deleted range line. One-sided echoes are removed when the remaining
 * payload still covers the full range — on multi-line ranges from line
 * equality alone, on single-line ranges only when every echoed row is a
 * grammar-classified annotation ({@link ANNOTATION_NODE_KINDS}), where an
 * adjacent duplicate is never intentional. An under-filled one-sided echo is
 * recorded as ambiguous so the syntax-probe search gets first chance to
 * resolve it, then rejected rather than silently dropping unique range
 * content.
 */
function normalizeTextualBoundaryEchoes(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
	path: string | undefined,
): TextualBoundaryNormalization {
	const out: AppliedEdit[] = [];
	const warnings: string[] = [];
	const ambiguities: TextualBoundaryAmbiguity[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = findReplacementGroup(edits, i);
		if (!group) {
			out.push(cloneAppliedEdit(edits[i], i));
			i++;
			continue;
		}
		const inserts = replacementInserts(group, edits);
		const deletes = replacementDeletes(group, edits);
		const leading = countDuplicateLeadingBoundaryLines(group, fileLines);
		const trailing = countDuplicateTrailingBoundaryLines(group, fileLines);
		const rangeLength = group.deleteIndices.length;
		let dropLeading = 0;
		let dropTrailing = 0;
		if (leading > 0 && trailing > 0) {
			if (group.payload.length - leading - trailing === rangeLength) {
				dropLeading = leading;
				dropTrailing = trailing;
			}
		} else if (
			leading > 0 &&
			(rangeLength > 1 || isAnnotationEchoRun(fileLines, path, group.startLine - leading, group.startLine - 1))
		) {
			if (group.payload.length - leading >= rangeLength) {
				dropLeading = leading;
			} else {
				ambiguities.push({
					startLine: group.startLine,
					endLine: group.endLine,
					side: "leading",
					count: leading,
				});
			}
		} else if (
			trailing > 0 &&
			(rangeLength > 1 || isAnnotationEchoRun(fileLines, path, group.endLine + 1, group.endLine + trailing))
		) {
			if (group.payload.length - trailing >= rangeLength) {
				dropTrailing = trailing;
			} else {
				ambiguities.push({
					startLine: group.startLine,
					endLine: group.endLine,
					side: "trailing",
					count: trailing,
				});
			}
		}
		if (dropLeading > 0 || dropTrailing > 0) {
			out.push(...inserts.slice(dropLeading, inserts.length - dropTrailing), ...deletes);
			warnings.push(textualBoundaryEchoWarning(group.startLine, dropLeading, dropTrailing));
		} else {
			for (const idx of group.insertIndices) out.push(cloneAppliedEdit(edits[idx], idx));
			for (const idx of group.deleteIndices) out.push(cloneAppliedEdit(edits[idx], idx));
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
	}
	return { edits: out, warnings, ambiguities };
}

interface KeepPlan {
	readonly beforeLine?: number;
	readonly afterLine?: number;
	readonly kept: number;
}

interface GroupVariant {
	readonly edits: AppliedEdit[];
	/** Original boundary rows retained from the selected range. */
	readonly kept: number;
	/** Exact payload echoes removed from outside the selected range. */
	readonly dropped: number;
}

interface GroupVariants {
	readonly variants: GroupVariant[];
	readonly ambiguous: boolean;
}

const INDENT_TAB_WIDTH = 4;

function indentColumns(line: string): number {
	let column = 0;
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 32) {
			column++;
		} else if (code === 9) {
			column += INDENT_TAB_WIDTH - (column % INDENT_TAB_WIDTH);
		} else {
			break;
		}
	}
	return column;
}

function nearestContentLine(fileLines: readonly string[], start: number, step: 1 | -1): string | undefined {
	for (let index = start; index >= 0 && index < fileLines.length; index += step) {
		const line = fileLines[index];
		if (line !== undefined && hasNonWhitespace(line)) return line;
	}
	return undefined;
}

function payloadEdge(payload: readonly string[], side: "leading" | "trailing"): string | undefined {
	if (side === "leading") {
		for (const line of payload) {
			if (hasNonWhitespace(line)) return line;
		}
		return undefined;
	}
	for (let index = payload.length - 1; index >= 0; index--) {
		const line = payload[index];
		if (line !== undefined && hasNonWhitespace(line)) return line;
	}
	return undefined;
}

function replacementInserts(group: ReplacementGroup, edits: readonly AppliedEdit[]): InsertEdit[] {
	const inserts: InsertEdit[] = [];
	for (const index of group.insertIndices) {
		const edit = edits[index];
		if (edit?.kind === "insert") inserts.push(edit);
	}
	return inserts;
}

function replacementDeletes(group: ReplacementGroup, edits: readonly AppliedEdit[]): DeleteEdit[] {
	const deletes: DeleteEdit[] = [];
	for (const index of group.deleteIndices) {
		const edit = edits[index];
		if (edit?.kind === "delete") deletes.push(edit);
	}
	return deletes;
}

function isSourceLineDeleted(edits: readonly AppliedEdit[], line: number): boolean {
	return edits.some(edit => edit.kind === "delete" && edit.anchor.line === line);
}

/**
 * Ignore a deleted trailing row only when the identical next source row
 * survives every hunk. The preceding deleted row then becomes the effective
 * range edge without resurrecting arbitrary interior content.
 */
function effectiveTrailingBoundary(
	group: ReplacementGroup,
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
): number {
	let line = group.endLine;
	let survivor = group.endLine + 1;
	while (
		line > group.startLine &&
		survivor <= fileLines.length &&
		!isSourceLineDeleted(edits, survivor) &&
		fileLines[line - 1] === fileLines[survivor - 1]
	) {
		line--;
		survivor++;
	}
	return line;
}

/** Whether deleting one source row from an otherwise valid file breaks it. */
function isSyntaxEssentialRow(
	fileLines: readonly string[],
	path: string,
	line: number,
	baselineParses: boolean,
): boolean {
	if (!baselineParses) return true;
	const without = [...fileLines.slice(0, line - 1), ...fileLines.slice(line)].join("\n");
	return !parsesCleanly(path, without);
}

interface EdgeEvidence {
	readonly first: boolean;
	readonly last: boolean;
	readonly leadingStructure: boolean;
}

function edgeEvidence(
	fileLines: readonly string[],
	path: string,
	group: ReplacementGroup,
	trailingLine: number,
	baselineParses: boolean,
): EdgeEvidence {
	if (!baselineParses) {
		return { first: true, last: true, leadingStructure: false };
	}
	const first = isSyntaxEssentialRow(fileLines, path, group.startLine, true);
	const last = trailingLine === group.startLine ? first : isSyntaxEssentialRow(fileLines, path, trailingLine, true);
	const innerStart = group.startLine + 1;
	const leadingStructure =
		innerStart <= trailingLine &&
		enclosingBoundaries(fileLines, path, innerStart, trailingLine).includes(group.startLine);
	return { first, last, leadingStructure };
}

/**
 * Retention is limited to the selected range's first and effective-last rows.
 * On a valid baseline, deleting the row must break syntax; every candidate
 * must also satisfy source-range structure or indentation evidence.
 */
function buildKeepPlans(
	group: ReplacementGroup,
	trailingLine: number,
	payload: readonly string[],
	fileLines: readonly string[],
	evidence: EdgeEvidence,
	path: string,
	baselineParses: boolean,
): { plans: KeepPlan[]; ambiguous: boolean } {
	const leadingPayload = payloadEdge(payload, "leading");
	const trailingPayload = payloadEdge(payload, "trailing");
	const plans: KeepPlan[] = [{ kept: 0 }];
	if (leadingPayload === undefined || trailingPayload === undefined) return { plans, ambiguous: false };

	const first = fileLines[group.startLine - 1] ?? "";
	const last = fileLines[trailingLine - 1] ?? "";
	const leadingIndent = indentColumns(leadingPayload);
	const trailingIndent = indentColumns(trailingPayload);
	const firstIndent = indentColumns(first);
	const lastIndent = indentColumns(last);
	let ambiguous = false;

	if (group.startLine === trailingLine) {
		const previous = nearestContentLine(fileLines, group.startLine - 2, -1);
		const fitsBefore = previous === undefined || indentColumns(previous) === trailingIndent;
		if (evidence.first && fitsBefore && trailingIndent > firstIndent) {
			plans.push({ afterLine: group.startLine, kept: 1 });
		} else if (baselineParses && evidence.first && trailingIndent === firstIndent) {
			ambiguous = true;
		}
		return { plans, ambiguous };
	}

	const next = nearestContentLine(fileLines, group.startLine, 1);
	const previous = nearestContentLine(fileLines, trailingLine - 2, -1);
	const beforeFirst = nearestContentLine(fileLines, group.startLine - 2, -1);
	const selectedLeadingBoundary = enclosingBoundaries(fileLines, path, group.startLine + 1, group.endLine).includes(
		group.startLine,
	);
	const firstText = (fileLines[group.startLine - 1] ?? "").trim();
	const selectedStructuralEdge =
		STRUCTURAL_CLOSER_RE.test(firstText) &&
		firstIndent === leadingIndent &&
		firstIndent === indentColumns(fileLines[group.endLine - 1] ?? "");
	const underfilledEffectiveEdge =
		trailingLine < group.endLine && payload.length < group.endLine - group.startLine + 1;
	const keepsLeading =
		evidence.first &&
		(evidence.leadingStructure || selectedLeadingBoundary || selectedStructuralEdge || underfilledEffectiveEdge) &&
		(next === undefined || selectedStructuralEdge
			? leadingIndent >= firstIndent
			: indentColumns(next) === leadingIndent);
	const keepsTrailing =
		(evidence.last || underfilledEffectiveEdge) &&
		!keepsLeading &&
		trailingIndent > lastIndent &&
		(previous === undefined || indentColumns(previous) === trailingIndent);
	if (keepsLeading) plans.push({ beforeLine: group.startLine, kept: 1 });
	if (keepsTrailing) plans.push({ afterLine: trailingLine, kept: 1 });
	// Retaining both edges can silently resurrect an intentionally removed
	// wrapper or signature; parsing cannot distinguish that from omission.
	if (
		baselineParses &&
		evidence.first &&
		beforeFirst !== undefined &&
		firstIndent < indentColumns(beforeFirst) &&
		leadingIndent > firstIndent
	) {
		ambiguous = true;
	}
	return { plans, ambiguous };
}

/**
 * Enumerate repair hypotheses for one replacement group. Exact outside echoes
 * may be removed; edge retention requires syntax, source structure,
 * indentation, or the narrow pure-closer sibling-depth shape. Tree-sitter
 * validates every candidate result.
 */
function buildGroupVariants(
	group: ReplacementGroup,
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
	path: string,
	baselineParses: boolean,
): GroupVariants {
	const inserts = replacementInserts(group, edits);
	const deletes = replacementDeletes(group, edits);
	const trailingLine = effectiveTrailingBoundary(group, edits, fileLines);
	const evidence = edgeEvidence(fileLines, path, group, trailingLine, baselineParses);
	const dropJ = countDuplicateLeadingBoundaryLines(group, fileLines);
	const dropK = countDuplicateTrailingBoundaryLines(group, fileLines);
	const leadingDrops = dropJ > 0 ? [0, dropJ] : [0];
	const trailingDrops = dropK > 0 ? [0, dropK] : [0];
	const variants: GroupVariant[] = [];
	let ambiguous = false;

	for (const leadingDrop of leadingDrops) {
		for (const trailingDrop of trailingDrops) {
			const dropped = leadingDrop + trailingDrop;
			if (dropped >= inserts.length) continue;
			const payload = group.payload.slice(leadingDrop, group.payload.length - trailingDrop);
			const keepResult = buildKeepPlans(group, trailingLine, payload, fileLines, evidence, path, baselineParses);
			ambiguous ||= keepResult.ambiguous;
			for (const keep of keepResult.plans) {
				if (keep.kept === 0 && dropped === 0) continue;
				if (keep.kept > 0 && group.deleteIndices.length > 1 && payload.length > group.deleteIndices.length) {
					continue;
				}
				variants.push({
					kept: keep.kept,
					dropped,
					edits: applyGroupVariant(
						inserts,
						deletes,
						keep.beforeLine,
						keep.afterLine,
						leadingDrop,
						trailingDrop,
						fileLines.length,
					),
				});
			}
		}
	}
	variants.sort(compareGroupVariant);
	return { variants, ambiguous };
}

function compareGroupVariant(a: GroupVariant, b: GroupVariant): number {
	return a.kept - b.kept || a.dropped - b.dropped;
}

function applyGroupVariant(
	inserts: readonly InsertEdit[],
	deletes: readonly DeleteEdit[],
	beforeLine: number | undefined,
	afterLine: number | undefined,
	dropLeading: number,
	dropTrailing: number,
	fileLineCount: number,
): AppliedEdit[] {
	let retainedInserts = inserts.slice(dropLeading, inserts.length - dropTrailing);
	const retainedDeletes = deletes.filter(edit => edit.anchor.line !== beforeLine && edit.anchor.line !== afterLine);
	if (beforeLine !== undefined) {
		const cursor: Cursor =
			beforeLine >= fileLineCount ? { kind: "eof" } : { kind: "before_anchor", anchor: { line: beforeLine + 1 } };
		retainedInserts = retainedInserts.map(edit => ({ ...edit, cursor }));
	}
	return [...retainedInserts, ...retainedDeletes];
}

/** One choice per broken group; `null` keeps the group as authored. */
interface BoundaryCombo {
	readonly variants: readonly (GroupVariant | null)[];
	readonly touched: number;
	readonly kept: number;
	readonly dropped: number;
}

/** Combinatorial cap after each group is added to the candidate beam. */
const MAX_BOUNDARY_COMBOS = 512;

function compareBoundaryCombo(a: BoundaryCombo, b: BoundaryCombo): number {
	return a.touched - b.touched || a.kept - b.kept || a.dropped - b.dropped;
}

/**
 * Search boundary hypotheses across the whole patch. Parsing is the semantic
 * filter; the deterministic cost prefers fewer touched groups, retained rows,
 * then exact echo drops. Different texts tied at that full cost are not
 * guessed.
 */
function repairBoundaryVariants(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
	path: string | undefined,
	baselineParses: boolean,
): { edits: AppliedEdit[]; warnings: string[] } | undefined {
	if (path === undefined) return undefined;

	const groups: { group: ReplacementGroup; variants: GroupVariant[] }[] = [];
	let ambiguousGroup: ReplacementGroup | undefined;
	let i = 0;
	while (i < edits.length) {
		const group = findReplacementGroup(edits, i);
		if (group) {
			const built = buildGroupVariants(group, edits, fileLines, path, baselineParses);
			if (built.ambiguous && ambiguousGroup === undefined) ambiguousGroup = group;
			if (built.variants.length > 0) groups.push({ group, variants: built.variants });
			i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
		} else {
			i++;
		}
	}
	if (groups.length === 0) {
		if (ambiguousGroup) {
			throw new Error(ambiguousBoundaryPlacementMessage(ambiguousGroup.startLine, ambiguousGroup.endLine));
		}
		return undefined;
	}

	let combos: BoundaryCombo[] = [{ variants: [], touched: 0, kept: 0, dropped: 0 }];
	for (const { variants } of groups) {
		const next: BoundaryCombo[] = [];
		for (const combo of combos) {
			next.push({ ...combo, variants: [...combo.variants, null] });
			for (const variant of variants) {
				next.push({
					variants: [...combo.variants, variant],
					touched: combo.touched + 1,
					kept: combo.kept + variant.kept,
					dropped: combo.dropped + variant.dropped,
				});
			}
		}
		next.sort(compareBoundaryCombo);
		combos = next.slice(0, MAX_BOUNDARY_COMBOS);
	}

	const authored = materializeEdits(
		fileLines,
		edits.map((edit, index) => cloneAppliedEdit(edit, index)),
	).text;
	const candidates = combos.filter(combo => combo.touched > 0).sort(compareBoundaryCombo);

	let bestText: string | undefined;
	let bestCombo: BoundaryCombo | undefined;
	for (const combo of candidates) {
		if (bestCombo !== undefined && compareBoundaryCombo(combo, bestCombo) > 0) break;
		const candidate = spliceBoundaryCombo(edits, groups, combo);
		const text = materializeEdits(fileLines, candidate).text;
		if (text === authored || !parsesCleanly(path, text)) continue;
		if (bestCombo === undefined) {
			bestCombo = combo;
			bestText = text;
			continue;
		}
		if (text !== bestText) {
			if (ambiguousGroup) {
				throw new Error(ambiguousBoundaryPlacementMessage(ambiguousGroup.startLine, ambiguousGroup.endLine));
			}
			return undefined;
		}
	}
	if (bestCombo === undefined) {
		if (ambiguousGroup) {
			throw new Error(ambiguousBoundaryPlacementMessage(ambiguousGroup.startLine, ambiguousGroup.endLine));
		}
		return undefined;
	}

	const warnings: string[] = [];
	groups.forEach((entry, index) => {
		const variant = bestCombo.variants[index];
		if (variant) warnings.push(boundaryVariantRepairWarning(entry.group.startLine, variant.kept, variant.dropped));
	});
	return { edits: spliceBoundaryCombo(edits, groups, bestCombo), warnings };
}

/** Replace each group's authored edits with its combo variant (or the authored
 *  edits where the combo leaves a group untouched). Groups are keyed by their
 *  first insert index — `findReplacementGroup` builds fresh objects per scan,
 *  so object identity cannot be the key. */
function spliceBoundaryCombo(
	edits: readonly AppliedEdit[],
	groups: readonly { group: ReplacementGroup; variants: GroupVariant[] }[],
	combo: BoundaryCombo,
): AppliedEdit[] {
	const chosen = new Map<number, GroupVariant>();
	groups.forEach((entry, idx) => {
		const variant = combo.variants[idx];
		if (variant) chosen.set(entry.group.insertIndices[0], variant);
	});
	const out: AppliedEdit[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = findReplacementGroup(edits, i);
		if (!group) {
			out.push(cloneAppliedEdit(edits[i], i));
			i++;
			continue;
		}
		const variant = chosen.get(group.insertIndices[0]);
		if (variant) {
			out.push(...variant.edits);
		} else {
			for (const idx of group.insertIndices) out.push(cloneAppliedEdit(edits[idx], idx));
			for (const idx of group.deleteIndices) out.push(cloneAppliedEdit(edits[idx], idx));
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
	}
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// After-insert landing correction
//
// The body rows of an `insert after N:` hunk carry an implicit depth claim:
// their leading indentation says how deep the author expects the new lines
// to sit. Two corrections share that claim, in opposite directions:
//
// Outward (any after-insert): when the depth is shallower than line N itself,
// the hunk is inserting a sibling of some enclosing construct while anchored
// inside it — the common shape is anchoring on the last statement of a block
// and writing the body at the parent's depth. Sliding the landing point
// forward across the structural closer lines that follow (and nothing else —
// content lines are never crossed) places the body at the depth its
// indentation names.
//
// Inward (block-lowered inserts only): `insert_after_block N:` anchors on the
// resolved block's closing line, but a body indented deeper than that closer
// claims a depth inside the block — the common misreading of the op as
// "append at the end of block N's body". Sliding the landing point backward
// across the block's trailing closer lines places the body inside, at its
// claimed depth. Scoped to block-lowered inserts because there the author
// named the opener and never saw the closer; a plain `insert after M:` on a
// closer line stays literal (the escape hatch for genuinely-after content
// such as method-chain continuations).
//
// Both shifts are deliberately conservative: they fire only when the body
// and anchor indentation are comparable (one is a prefix of the other),
// cross only pure closing-delimiter lines, stop as soon as depth matches the
// body's claim, and are abandoned when any other edit in the patch targets a
// crossed line. Every shift is reported as a warning so the author can
// re-issue when the original landing was intended.

/** Leading run of tabs and spaces. */
function leadingIndent(line: string): string {
	let end = 0;
	while (end < line.length) {
		const code = line.charCodeAt(end);
		if (code !== 9 && code !== 32) break;
		end++;
	}
	return line.slice(0, end);
}

/** `deeper` strictly extends `shallower` (same indent style, more depth). */
function isIndentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}

interface AfterInsertGroup {
	/** Anchor line shared by every insert row of the hunk. */
	anchor: number;
	/** Indices into the edit list, in patch order. */
	members: number[];
	/** First line of the resolved block when lowered from `insert_after_block N:`. */
	blockStart?: number;
}

/**
 * Depth of an after-insert hunk's body: the shallowest indentation across its
 * non-blank rows. Returns `undefined` when no depth claim can be made — an
 * all-blank or all-closer body, or rows whose indentation styles are not
 * mutually comparable (tabs vs spaces).
 */
function bodyTargetIndent(rows: readonly string[]): string | undefined {
	const nonBlank = rows.filter(hasNonWhitespace);
	if (nonBlank.length === 0) return undefined;
	// A body of pure closers re-balances delimiters; it claims no depth.
	if (nonBlank.every(row => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
	let target = leadingIndent(nonBlank[0] ?? "");
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) continue;
		if (target.startsWith(indent)) target = indent;
		else return undefined;
	}
	return target;
}

/**
 * Resolve where an after-insert hunk anchored on `group.anchor` should land
 * given its body depth `target`: the last structural closer line in the run
 * directly below the anchor whose indentation still covers `target`. Returns
 * `undefined` when the landing stays put.
 */
function resolveShiftedLanding(
	group: AfterInsertGroup,
	target: string,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): { line: number; crossed: number } | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	if (!isIndentDeeper(leadingIndent(anchorText), target)) return undefined;

	let landing = group.anchor;
	let crossed = 0;
	for (let line = group.anchor + 1; line <= fileLines.length; line++) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) continue; // look past blanks, never land on them
		if (!STRUCTURAL_CLOSER_RE.test(text)) break; // content is never crossed
		const indent = leadingIndent(text);
		if (!indent.startsWith(target)) break; // shallower than the body — crossing would over-escape
		if (targetedLines.has(line)) return undefined; // another hunk owns this closer
		landing = line;
		crossed++;
		if (indent.length === target.length) break; // depth returned to the body's level
	}
	return landing === group.anchor ? undefined : { line: landing, crossed };
}

/**
 * Body shape required for an opener-escape relocation: the rows tile into
 * leading single-line nodes (comments, attributes) followed by one multi-line
 * construct reaching the last content row — i.e. the body parses standalone
 * as one self-contained `mod`/`fn`/`class` that can be moved past the block
 * it was mis-anchored into without re-parenting anything. Bare statements and
 * multi-statement bodies fail it and stay literal: an under-indented one-line
 * body more likely names the inside of the block.
 */
function bodyIsRelocatableConstruct(rows: readonly string[], path: string): boolean {
	let last = rows.length;
	while (last > 0 && !hasNonWhitespace(rows[last - 1])) last--;
	if (last === 0) return false;
	let line = 1;
	while (line <= last) {
		if (!hasNonWhitespace(rows[line - 1])) {
			line++;
			continue;
		}
		const spans = nodeChain(rows, path, line);
		let end = 0;
		for (const span of spans) {
			if (span.startLine === line && span.endLine > end) end = span.endLine;
		}
		if (end === 0) return false; // no node begins here — body does not parse as items
		if (end >= last) return end > line; // final node must be one multi-line construct
		line = end + 1;
	}
	return false;
}

/**
 * Resolve where a block-lowered after-insert anchored on the block's closing
 * line should land given a body depth `target` deeper than that closer: just
 * above the block's trailing run of closer lines, bounded below by
 * `blockStart` (an empty block lands the body right after its opener).
 * Returns `undefined` when the landing stays put.
 */
function resolveInwardLanding(
	group: AfterInsertGroup,
	target: string,
	blockStart: number,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): number | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	// Fires only when the block ends in a pure closer the body out-indents.
	// Blocks ending in content (indentation-only languages) already land the
	// body inside the block — nothing to correct.
	if (!STRUCTURAL_CLOSER_RE.test(anchorText)) return undefined;
	if (!isIndentDeeper(target, leadingIndent(anchorText))) return undefined;

	let landing = group.anchor;
	for (let line = group.anchor; line > blockStart; line--) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) {
			landing = line - 1; // look past trailing blanks, never land after one
			continue;
		}
		if (!STRUCTURAL_CLOSER_RE.test(text)) break; // content reached — land right after it
		const indent = leadingIndent(text);
		if (!isIndentDeeper(target, indent)) break; // closer at the body's depth — land after it
		// Another hunk owns this closer (the group's own rows put the anchor
		// itself in `targetedLines`; that one is ours to cross).
		if (line !== group.anchor && targetedLines.has(line)) return undefined;
		landing = line - 1;
	}
	return landing === group.anchor ? undefined : landing;
}

/**
 * Slide mis-anchored after-insert hunks to the depth their body indentation
 * claims: outward past the structural closer lines that follow the anchor
 * when the body is shallower; for plain inserts anchored on a block opener,
 * past the whole block when the body is a balanced construct claiming a
 * depth strictly above the opener (syntax-probe verified via `path`); or — for
 * `insert_after_block N:` lowerings — inward across the block's trailing
 * closers when the body is deeper than the block's closing line. Returns the
 * corrected edit list plus one warning per shifted hunk.
 */
function repairAfterInsertLandings(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
	path: string | undefined,
): { edits: readonly AppliedEdit[]; warnings: string[] } {
	// Group plain (non-replacement) after-anchor inserts per authored hunk:
	// rows of one hunk share the anchor line and the patch header line.
	const groups = new Map<string, AfterInsertGroup>();
	edits.forEach((edit, idx) => {
		if (edit.kind !== "insert" || edit.mode === "replacement") return;
		if (edit.cursor.kind !== "after_anchor") return;
		const key = `${edit.cursor.anchor.line}:${edit.lineNum}`;
		const group = groups.get(key);
		if (group === undefined)
			groups.set(key, { anchor: edit.cursor.anchor.line, members: [idx], blockStart: edit.blockStart });
		else group.members.push(idx);
	});
	if (groups.size === 0) return { edits, warnings: [] };

	// Lines explicitly targeted by any edit; a shift never crosses them.
	const targetedLines = new Set<number>();
	for (const edit of edits) {
		if (edit.kind === "delete") targetedLines.add(edit.anchor.line);
		else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor")
			targetedLines.add(edit.cursor.anchor.line);
	}

	let out: AppliedEdit[] | undefined;
	const warnings: string[] = [];
	const retarget = (group: AfterInsertGroup, line: number): void => {
		out ??= [...edits];
		for (const idx of group.members) {
			const edit = insertEditAt(out, idx);
			out[idx] = { ...edit, cursor: { kind: "after_anchor", anchor: { line } } };
		}
	};
	for (const group of groups.values()) {
		const target = bodyTargetIndent(group.members.map(idx => insertEditAt(edits, idx).text));
		if (target === undefined) continue;
		const outward = resolveShiftedLanding(group, target, fileLines, targetedLines);
		if (outward !== undefined) {
			retarget(group, outward.line);
			warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.line, outward.crossed));
			continue;
		}
		if (group.blockStart === undefined) {
			// Opener-escape: `PUT >N:` anchored on a line that OPENS a construct,
			// with a self-contained construct body claiming a column depth
			// strictly above the opener — a landing between the opener and its
			// first statement, which no such body can intend, yet one that can
			// parse (items are legal inside Rust fn bodies). Candidates are the
			// enclosing constructs' end lines from the node chain, innermost
			// first, kept only when the construct's own opening depth sits at or
			// above the body's claim (the body could be its sibling); the first
			// candidate whose relocated result passes the syntax probe wins.
			// Equal-depth bodies stay literal, matching the outward shift.
			if (path === undefined) continue;
			const anchorText = fileLines[group.anchor - 1] ?? "";
			const targetCols = indentColumns(target);
			if (targetCols >= indentColumns(anchorText)) continue;
			const chain = nodeChain(fileLines, path, group.anchor);
			if (!chain.some(node => node.startLine === group.anchor && node.endLine > group.anchor)) continue;
			const rows = group.members.map(idx => insertEditAt(edits, idx).text);
			if (!bodyIsRelocatableConstruct(rows, path)) continue;
			const candidates = [
				...new Set(
					chain
						.filter(
							node =>
								node.endLine > group.anchor && indentColumns(fileLines[node.startLine - 1] ?? "") <= targetCols,
						)
						.map(node => node.endLine),
				),
			].sort((a, b) => a - b);
			for (const landing of candidates) {
				// Never relocate across another hunk's target; farther
				// candidates cross the same line, so stop outright.
				let blocked = false;
				for (const targeted of targetedLines) {
					if (targeted > group.anchor && targeted <= landing) {
						blocked = true;
						break;
					}
				}
				if (blocked) break;
				const trial = [...(out ?? edits)];
				for (const idx of group.members) {
					const edit = insertEditAt(trial, idx);
					trial[idx] = { ...edit, cursor: { kind: "after_anchor", anchor: { line: landing } } };
				}
				if (parsesCleanly(path, materializeEdits(fileLines, trial).text)) {
					out = trial;
					warnings.push(afterInsertOpenerEscapeWarning(group.anchor, landing));
					break;
				}
			}
			continue;
		}
		const inward = resolveInwardLanding(group, target, group.blockStart, fileLines, targetedLines);
		if (inward === undefined) continue;
		retarget(group, inward);
		warnings.push(blockInsertLandingShiftWarning(group.blockStart, group.anchor, inward));
	}
	return { edits: out ?? edits, warnings };
}

/** Optional knobs for {@link applyEdits}. */
export interface ApplyEditsOptions {
	/**
	 * Clipboard register filled by `cut` edits and read by `paste` edits.
	 * Thread one register through every section of a batch to move content
	 * across files; omitted, the call gets a private register.
	 */
	clipboard?: Clipboard;
	/** Anonymous `PASTE` with an empty register: `throw` (default) or `drop` (streaming previews). An empty named-register paste never throws — it warns and pastes nothing. */
	onEmptyPaste?: "throw" | "drop";
	/**
	 * Target path used to infer a language for the tree-sitter syntax probe.
	 * Required for syntax-essential boundary retention and post-apply syntax
	 * advisories. Without it, only exact-text boundary normalization and its
	 * evidence-complete rejections run.
	 */
	path?: string;
}

interface Materialized {
	text: string;
	firstChangedLine: number | undefined;
}

/**
 * Splice one candidate edit list into `originalLines` and return the resulting
 * text. Pure and repeatable: the caller materializes the authored edits, probes
 * that result, and only materializes a repaired candidate if the probe casts no
 * veto.
 */
function materializeEdits(originalLines: readonly string[], edits: readonly AppliedEdit[]): Materialized {
	const fileLines = [...originalLines];
	const lineOrigins: LineOrigin[] = fileLines.map(() => "original");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	// Partition edits into bof, eof, and anchor-targeted buckets.
	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	edits.forEach((edit, idx) => {
		if (edit.kind === "insert" && edit.cursor.kind === "bof") {
			bofLines.push(edit.text);
		} else if (edit.kind === "insert" && edit.cursor.kind === "eof") {
			eofLines.push(edit.text);
		} else {
			anchorEdits.push({ edit, idx });
		}
	});

	// Apply per-line buckets bottom-up so earlier indices stay valid.
	const byLine = bucketAnchorEditsByLine(anchorEdits);
	for (const line of [...byLine.keys()].sort((a, b) => b - a)) {
		const bucket = byLine.get(line);
		if (!bucket) continue;
		bucket.sort((a, b) => a.idx - b.idx);

		const idx = line - 1;
		const currentLine = fileLines[idx] ?? "";
		const beforeInsertLines: string[] = [];
		const afterInsertLines: string[] = [];
		const replacementLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (isReplacementInsert(edit)) {
				replacementLines.push(edit.text);
			} else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") {
				afterInsertLines.push(edit.text);
			} else if (edit.kind === "insert") {
				beforeInsertLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (
			beforeInsertLines.length === 0 &&
			replacementLines.length === 0 &&
			afterInsertLines.length === 0 &&
			!deleteLine
		)
			continue;

		const replacement = deleteLine
			? [...beforeInsertLines, ...replacementLines, ...afterInsertLines]
			: [...beforeInsertLines, ...replacementLines, currentLine, ...afterInsertLines];
		const origins: LineOrigin[] = [];
		for (let i = 0; i < beforeInsertLines.length; i++) origins.push("insert");
		for (let i = 0; i < replacementLines.length; i++) origins.push(deleteLine ? "replacement" : "insert");
		if (!deleteLine) origins.push(lineOrigins[idx] ?? "original");
		for (let i = 0; i < afterInsertLines.length; i++) origins.push("insert");

		fileLines.splice(idx, 1, ...replacement);
		lineOrigins.splice(idx, 1, ...origins);
		trackFirstChanged(line);
	}

	if (bofLines.length > 0) {
		insertAtStart(fileLines, lineOrigins, bofLines);
		trackFirstChanged(1);
	}
	const eofChangedLine = insertAtEnd(fileLines, lineOrigins, eofLines);
	if (eofChangedLine !== undefined) trackFirstChanged(eofChangedLine);

	return { text: fileLines.join("\n"), firstChangedLine };
}

/**
 * Apply a parsed list of edits to a text body. Pure function — no I/O.
 *
 * Returns the post-edit text and the first changed line number (1-indexed).
 * Throws if an anchor is out of bounds.
 *
 * Mis-set replacement boundaries are repaired by {@link repairBoundaryVariants}
 * when `options.path` lets tree-sitter judge the result. A parsing authored
 * result is never second-guessed. For a broken result, only syntax-essential
 * edge retention with matching indentation and exact outside-row echo removal
 * are considered; every selected candidate must parse.
 */
export function applyEdits(text: string, edits: readonly Edit[], options: ApplyEditsOptions = {}): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	const fileLines = text.split("\n");

	// Clipboard pre-pass: capture `cut` ranges from the original lines and
	// expand `paste` edits into plain inserts in authored order.
	const clipboardWarnings: string[] = [];
	const concrete = resolveClipboardEdits(edits, fileLines, options.clipboard ?? {}, {
		...(options.onEmptyPaste === undefined ? {} : { onEmptyPaste: options.onEmptyPaste }),
		onWarning: message => clipboardWarnings.push(message),
	});

	// Block edits are deferred until `resolveBlockEdits` expands them into
	// concrete inserts + deletes. Reaching the applier with one still present
	// is an internal wiring bug, not authored-input error.
	const appliedEdits: AppliedEdit[] = [];
	for (const edit of concrete) {
		if (edit.kind === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL);
		if (edit.kind === "cut" || edit.kind === "paste") throw new Error(UNRESOLVED_CLIPBOARD_INTERNAL);
		appliedEdits.push(edit);
	}

	const targetEdits = dropTrailingPhantomDeletes(
		appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index)),
		fileLines,
	);
	validateLineBounds(targetEdits, fileLines);
	const indentationWarnings = repairReplacementIndentation(targetEdits, fileLines);
	const landed = repairAfterInsertLandings(targetEdits, fileLines, options.path);
	const normalized = normalizeTextualBoundaryEchoes(landed.edits, fileLines, options.path);
	const leading = [...clipboardWarnings, ...indentationWarnings, ...landed.warnings, ...normalized.warnings];
	const authoredResult = materializeEdits(fileLines, normalized.edits);
	const baselineParses = parsesCleanly(options.path, text);
	const authoredParses = parsesCleanly(options.path, authoredResult.text);
	const finish = (result: Materialized, warnings: string[]): ApplyResult => {
		const merged = [...warnings];
		// Post-apply syntax advisory: the result stopped parsing while the
		// pre-edit text parsed, so this patch demonstrably introduced the
		// error. Catches misplacements no boundary variant can explain.
		if (!parsesCleanly(options.path, result.text) && baselineParses) {
			merged.push(editBrokeParseWarning(result.firstChangedLine));
		}
		return {
			text: result.text,
			firstChangedLine: result.firstChangedLine,
			...(merged.length > 0 ? { warnings: merged } : {}),
		};
	};
	const ambiguity = normalized.ambiguities[0];
	// Exact-text normalization is evidence-complete. If it leaves a parsing
	// result, no speculative keep/drop variant may second-guess it.
	if (authoredParses) {
		if (ambiguity) {
			throw new Error(
				ambiguousBoundaryEchoMessage(ambiguity.startLine, ambiguity.endLine, ambiguity.side, ambiguity.count),
			);
		}
		return finish(authoredResult, leading);
	}
	const repaired = repairBoundaryVariants(normalized.edits, fileLines, options.path, baselineParses);
	if (repaired) {
		const repairedResult = materializeEdits(fileLines, repaired.edits);
		if (parsesCleanly(options.path, repairedResult.text)) {
			return finish(repairedResult, [...leading, ...repaired.warnings]);
		}
	}
	if (ambiguity) {
		throw new Error(
			ambiguousBoundaryEchoMessage(ambiguity.startLine, ambiguity.endLine, ambiguity.side, ambiguity.count),
		);
	}
	// Nothing proven: leave the authored edit exactly as written. Report the
	// damage — the baseline parsed, so this edit demonstrably caused it.
	return finish(authoredResult, leading);
}
