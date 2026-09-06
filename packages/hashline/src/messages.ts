/** Centralized error/warning text for the hashline parser, applier, and patcher. */

import {
	formatNumberedLine,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_PAYLOAD_REPLACE,
	HL_RANGE_SEP,
} from "./format";
import type { BlockSpan } from "./types";

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/**
 * Numbered `LINE:TEXT` rows around `anchorLines` (±{@link MISMATCH_CONTEXT}),
 * `*`-marking anchors, `...` between non-adjacent runs. Out-of-range anchors
 * contribute no rows.
 */
export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	const anchorSet = new Set(anchorLines);
	const rows: string[] = [];
	let previous = -1;
	for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
		if (previous !== -1 && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		const marker = anchorSet.has(lineNum) ? "*" : " ";
		rows.push(`${marker}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`);
	}
	return rows;
}
/** Concrete range operation rejected because its absolute end precedes its start. */
export type AbsoluteRangeOp = "replace" | "cut";

/** Format a register suffix (` @name` or empty). */
function regSuffix(register?: string): string {
	return register ? ` @${register}` : "";
}

/** Header composers per concrete-range op, used in retry suggestions. */
const RANGE_OP_FORMS: Record<
	AbsoluteRangeOp,
	{ single: (line: number, reg?: string) => string; range: (start: number, end: number, reg?: string) => string }
> = {
	replace: {
		single: (line, reg) => (reg ? `PUT ${line}${regSuffix(reg)}` : `PUT ${line}:`),
		range: (start, end, reg) =>
			reg ? `PUT ${start}${HL_RANGE_SEP}${end}${regSuffix(reg)}` : `PUT ${start}${HL_RANGE_SEP}${end}:`,
	},
	cut: {
		single: (line, reg) => `CUT ${line}${regSuffix(reg)}`,
		range: (start, end, reg) => `CUT ${start}${HL_RANGE_SEP}${end}${regSuffix(reg)}`,
	},
};

/** Block-locator header for a concrete-range op (`PUT 5*:` / `CUT 5*`). */
function blockFormAt(op: AbsoluteRangeOp, line: number, reg?: string): string {
	return op === "replace"
		? reg
			? `PUT ${line}*${regSuffix(reg)}`
			: `PUT ${line}*:`
		: `CUT ${line}*${regSuffix(reg)}`;
}

/** Explain absolute range endpoints and provide safe, non-applying retry forms. */
export function invalidAbsoluteRangeMessage(
	patchLine: number,
	start: number,
	end: number,
	op: AbsoluteRangeOp,
	block?: BlockSpan,
	register?: string,
): string {
	const forms = RANGE_OP_FORMS[op];
	const single = forms.single(start, register);
	const countedEnd = start + end - 1;
	const counted =
		Number.isSafeInteger(countedEnd) && countedEnd >= start ? forms.range(start, countedEnd, register) : null;
	const blockForm = blockFormAt(op, start, register);
	let message =
		`line ${patchLine}: Invalid absolute range: start ${start}, end ${end}. ` +
		`The value after \`${HL_RANGE_SEP}\` is an absolute source line, not a line count or replacement length. ` +
		`For one line use \`${single}\`.`;
	if (counted !== null) {
		message += ` For ${end} lines starting at ${start}, use \`${counted}\`.`;
	}
	if (block?.start === start && block.end > start) {
		message +=
			` The syntactic block beginning at ${start} ends at ${block.end}, ` + `so \`${blockForm}\` is also valid.`;
	}
	return message;
}

/** Optional patch envelope start marker; silently consumed. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Truncation sentinel emitted by an agent loop mid-call. Ends parsing like
 * {@link END_PATCH_MARKER}, without a warning.
 */
export const ABORT_MARKER = "*** Abort";

/** Exact-range duplicate hunks were normalized to the final hunk. */
export const REPLACE_PAIR_COALESCED_WARNING =
	"Multiple hunks targeted the same exact range; kept only the last. Issue one `PUT` or `CUT` hunk per range.";

/** Replacement body indentation was aligned from unchanged structural rows. */
export const REPLACEMENT_INDENT_AUTO_SHIFT_WARNING =
	"Auto-indented a replacement body to match unchanged structural rows in its source range.";

/** Bare body rows auto-converted to literal `+` rows. */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";

/** Top-level read-output rows recovered as single-line replacements. */
export const SNAPSHOT_ROWS_AUTO_PUT_WARNING = `Recovered top-level \`N:TEXT\` snapshot row(s) as single-line \`PUT N${HL_RANGE_SEP}N:\` replacements. Use explicit \`PUT\` headers for reliable edits.`;
/**
 * Two or more top-level `N:TEXT` read-output rows named the same source line.
 * Each recovered row lowers to a single-line `PUT N.=N:`, so the coalescer would
 * keep only the last and silently drop the others — reject and teach the format
 * instead.
 */
export function repeatedSnapshotRowMessage(line: number): string {
	return (
		`two or more pasted \`${line}:TEXT\` read-output rows name line ${line}. ` +
		`Such rows are recovered as single-line \`PUT ${line}${HL_RANGE_SEP}${line}:\` replacements, so repeating a ` +
		`number would keep only the last row and drop the rest. Write the hunk explicitly: one ` +
		`\`PUT ${line}${HL_RANGE_SEP}M:\` header covering exactly the lines that change, followed by \`+TEXT\` body ` +
		`rows holding their complete final content.`
	);
}
/**
 * A `+` body row whose text is itself a valid hunk header — the op was written
 * with the payload prefix, so it is inserted into the file as literal text
 * instead of executing. Warned rather than rejected: a literal `CUT …` line is
 * legitimate content in documentation and test fixtures.
 */
export function literalOpRowWarning(line: number, text: string): string {
	return (
		`line ${line}: body row \`${HL_PAYLOAD_REPLACE}${text}\` is itself a valid hunk header, so it was inserted ` +
		`into the file as literal text rather than executed. Ops are never \`${HL_PAYLOAD_REPLACE}\`-prefixed — drop ` +
		`the \`${HL_PAYLOAD_REPLACE}\` to run it, and re-issue if this line landed in the file by mistake.`
	);
}
/** Bare range header recovered as an implicit replacement hunk. */
export const BARE_RANGE_AUTO_PUT_WARNING = `Recovered a bare \`N${HL_RANGE_SEP}M:\` header as \`PUT N${HL_RANGE_SEP}M:\`. Prefix replacement ranges with \`PUT\`.`;

/** Copied read-output elision rows were ignored rather than written as source. */
export const READ_METADATA_IGNORED_WARNING =
	"Ignored copied read-output elision row(s). Re-read elided ranges before editing them.";

/** Empty span/block PUT recovered as a delete-only edit. */
export const EMPTY_PUT_AUTO_CUT_WARNING = `Interpreted an empty \`PUT\` body as deletion. Use \`CUT N${HL_RANGE_SEP}M\` or \`CUT N*\` for bodyless deletes.`;

/** A bodyless CUT carried a harmless trailing colon. */
export const CUT_COLON_IGNORED_WARNING = `Ignored a trailing \`:\` on bodyless \`CUT\`. Prefer \`CUT N${HL_RANGE_SEP}M\` / \`CUT N*\` without a colon.`;

/**
 * Bare `-` body rows accepted as literal Markdown bullets. Only emitted when
 * the hunk is unambiguously a bullet list: every `-` row is bullet-shaped

 * (`- item`) and the body has no unified-diff `+new` counterpart rows.
 */
export const MINUS_BULLET_AUTO_PIPED_WARNING =
	"Auto-prefixed bare `- ` bullet row(s) as literal content. `-` rows never remove lines — the range does that; always prefix literal body rows with `+`: `+- item`.";
/** Unified-diff old rows were discarded; explicit `+` rows are final content. */
export const DIFF_OLD_ROWS_IGNORED_WARNING =
	"Ignored unified-diff `-old` row(s); the range already removes old content, so only `+new` rows were kept.";

/** Unified-diff-style `-` row in a hunk body. */
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";

/** Optional source-aware suggestions appended to block-anchor diagnostics. */
export interface BlockDiagnosticSuggestions {
	/** Closest following multi-line block that begins after the authored anchor. */
	nextBlock?: BlockSpan;
	/** Closest preceding multi-line block whose span contains the authored anchor. */
	enclosingBlock?: BlockSpan;
}

/**
 * A block-anchored replace/cut could not resolve to a syntactic block.
 * Appends a {@link formatAnchoredContext} preview when `fileLines` is given.
 * `PUT >N*` never reaches this path; it lowers to `PUT >N`.
 */
export function blockUnresolvedMessage(
	line: number,
	op: AbsoluteRangeOp = "replace",
	fileLines?: readonly string[],
	suggestions: BlockDiagnosticSuggestions = {},
	register?: string,
): string {
	const phrase = blockFormAt(op, line, register);
	const fallback =
		op === "replace"
			? register
				? `PUT ${line}${HL_RANGE_SEP}M @${register}`
				: `PUT ${line}${HL_RANGE_SEP}M:`
			: register
				? `CUT ${line}${HL_RANGE_SEP}M @${register}`
				: `CUT ${line}${HL_RANGE_SEP}M`;
	const anchorText = fileLines?.[line - 1];
	const nextBlock = suggestions.nextBlock;
	let message: string;
	if (anchorText !== undefined && anchorText.trim().length === 0 && nextBlock) {
		const retry = blockFormAt(op, nextBlock.start, register);
		message =
			`Line ${line} is blank; no syntactic block can begin there. ` +
			`The next multi-line block begins at line ${nextBlock.start} and ends at line ${nextBlock.end}. ` +
			`Retry \`${retry}\`.`;
	} else {
		message =
			`\`${phrase}\` could not resolve a syntactic block beginning on line ${line} ` +
			`(unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	}
	const enclosingBlock = suggestions.enclosingBlock;
	if (enclosingBlock) {
		const retry = blockFormAt(op, enclosingBlock.start, register);
		message +=
			` The nearest enclosing multi-line block begins at line ${enclosingBlock.start} ` +
			`and ends at line ${enclosingBlock.end}; use \`${retry}\` to target it.`;
	}
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

/** Block-anchored edit reached a path with no {@link BlockResolver} wired in. */
export const BLOCK_RESOLVER_UNAVAILABLE =
	"Block locators (`N*` in `PUT N*:`, `PUT >N*`, `CUT N*`) are not available here (no block resolver configured). Use a concrete line range.";

/**
 * An after-block op anchored on a closing-delimiter line, lowered to its
 * plain after-line form — the closer ends a block, and inserting after it is
 * exactly what the plain form does.
 */
function closerLoweredWarning(blockForm: string, plainForm: string): string {
	return `\`${blockForm}\` anchors on a closing delimiter, so it was applied as plain \`${plainForm}\`. Anchor on the line that OPENS the construct.`;
}

/**
 * An after-block op whose anchor was unresolvable (unsupported language,
 * blank line, parse error, or no resolver), lowered to its plain after-line
 * form — applying with a warning beats failing the patch.
 */
function unresolvedLoweredWarning(blockForm: string, line: number, plainForm: string): string {
	return `\`${blockForm}\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`${plainForm}\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}

/** `PUT >N*:` anchored on a closing-delimiter line; applied as `PUT >N:`. */
export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*:`, `PUT >${line}:`);
}

/** `PUT >N*:` anchor unresolvable; applied as `PUT >N:`. */
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*:`, line, `PUT >${line}:`);
}

/** Register `PUT >N*` anchored on a closing-delimiter line; applied as `PUT >N`. */
export function pasteAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*`, `PUT >${line}`);
}

/** Register `PUT >N*` anchor unresolvable; applied as `PUT >N`. */
export function pasteAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*`, line, `PUT >${line}`);
}
/**
 * A one-sided exact boundary echo cannot cover the selected range after the
 * duplicated body rows are removed. Applying or dropping it would lose
 * distinct range content, so the edit is rejected unless a parse-restoring
 * boundary combination proves another reading.
 */
export function ambiguousBoundaryEchoMessage(
	startLine: number,
	endLine: number,
	side: "leading" | "trailing",
	count: number,
): string {
	const where =
		side === "leading"
			? `opens by restating the ${count} line(s) just above the range`
			: `ends by restating the ${count} line(s) just below the range`;
	return (
		`\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: the body ${where}, ` +
		`but is too short to be the full final content of the selected range. ` +
		`Re-issue with the range covering exactly the lines that change and the body as their complete final content.`
	);
}

/**
 * A syntax-essential selected edge can be retained on either side of the
 * payload, but indentation does not establish which placement was intended.
 */
export function ambiguousBoundaryPlacementMessage(startLine: number, endLine: number): string {
	return (
		`\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: a selected boundary row is required for the file to parse, ` +
		`but the body indentation does not establish whether it belongs before or after that row. ` +
		`Re-read the region and re-issue with a range that excludes every unchanged boundary row.`
	);
}

/**
 * Exact-text boundary rows were removed because the remaining payload covers
 * the selected range and the same rows already survive immediately outside it.
 */
export function textualBoundaryEchoWarning(startLine: number, leading: number, trailing: number): string {
	const parts: string[] = [];
	if (leading > 0) parts.push(`${leading} leading`);
	if (trailing > 0) parts.push(`${trailing} trailing`);
	return (
		`Auto-repaired a replacement boundary echo at line ${startLine}: dropped ${parts.join(" and ")} body line(s) ` +
		`already present outside the range. Issue the body as final content for the selected range only.`
	);
}

/**
 * A replacement range's boundary disposition was corrected by the
 * syntax-probe-judged search: syntax-essential source boundary rows were
 * retained, or exact body echoes of surviving outside rows were removed. The
 * authored result did not parse and the selected result does.
 */
export function boundaryVariantRepairWarning(startLine: number, kept: number, dropped: number): string {
	const keptPart = kept === 0 ? "" : `retained ${kept} syntax-essential source boundary row(s) selected by the range`;
	const droppedPart = dropped === 0 ? "" : `dropped ${dropped} body row(s) duplicated just outside the range`;
	const action = [keptPart, droppedPart].filter(Boolean).join(" and ");
	return (
		`Auto-repaired replacement boundaries at line ${startLine}: ${action}. ` +
		`The result was verified by the syntax probe — re-issue with the range covering exactly the changed ` +
		`lines and the body as their complete final content.`
	);
}

/**
 * The applied result no longer parses while the pre-edit content did: the
 * patch introduced a syntax error. Advisory, never a rejection — the applier
 * honors the authored edit — but the breakage is machine-confirmed by
 * tree-sitter and surfaced in the same response instead of waiting for a
 * compiler pass.
 */
export function editBrokeParseWarning(firstChangedLine: number | undefined): string {
	const at = firstChangedLine === undefined ? "" : ` near line ${firstChangedLine}`;
	return (
		`This edit introduced a syntax error${at}: the file parsed before the patch and no longer does. ` +
		`It was applied exactly as written, so a line number or range endpoint is likely wrong — ` +
		`re-read the touched region and re-issue a correcting edit.`
	);
}

/**
 * Internal invariant: `applyEdits` received an unresolved block edit;
 * `resolveBlockEdits` must run first.
 */
export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved block edit reached the applier (resolveBlockEdits was not run).";

/** Internal invariant: clipboard edits must be concrete before application. */
export const UNRESOLVED_CLIPBOARD_INTERNAL =
	"internal error: unresolved clipboard edit reached the applier (resolveClipboardEdits was not run).";

/** `REM` received a body row or coexists with line edits. */
export const REM_TAKES_NO_BODY =
	"`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";

/** `MV` received a body row. */
export const MOVE_TAKES_NO_BODY =
	"`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";

/** `CUT` hunk received a body row. */
export const CUT_TAKES_NO_BODY = `\`CUT\` deletes (and captures) the named lines and takes no body rows. To write new content, use \`PUT N${HL_RANGE_SEP}M:\` with \`+TEXT\` rows.`;

/** Register `PUT` header carried a `:`. */
export const COLON_ON_REGISTER_PUT =
	"`PUT … @name` pastes the register and never takes `:` — the colon promises body rows. Drop the colon (`PUT >40 @name`), or drop `@name` and write `+TEXT` body rows.";

/** Register `PUT` hunk received a body row. */
export const REGISTER_PUT_TAKES_NO_BODY =
	"A register `PUT` pastes captured lines and takes no `+` body rows. To write literal text, drop the `@name` and use `PUT …:` with body rows.";

/** Colonless `PUT` hunk received a body row. */
export const COLONLESS_PUT_TAKES_NO_BODY =
	"`PUT` without `:` is clipboard-backed and takes no body rows. Add `:` after the locator to write literal content (`PUT >40:` then `+TEXT` rows).";

/** Colonless anonymous `PUT` on a span target. */
export const COLONLESS_SPAN_PUT = `Colonless \`PUT\` is clipboard-backed, and span targets need a named register (\`PUT 5${HL_RANGE_SEP}9 @name\`); the anonymous register pastes only at gaps (\`PUT >40\`). To write literal content, add \`:\` and \`+TEXT\` body rows.`;

/** Anonymous paste ran with an empty anonymous register. */
export const EMPTY_PASTE = `Nothing to paste: no unlabeled \`CUT\` precedes this \`PUT\` in this call, and the anonymous register never carries across calls. Put \`CUT N${HL_RANGE_SEP}M\` / \`CUT N*\` above it, or use named registers (\`CUT … @name\` → \`PUT … @name\`) for cross-call moves.`;

/** Named paste read a register that holds nothing; a gap paste applies as empty. */
export function emptyRegisterPasteWarning(name: string, known: readonly string[]): string {
	const base = `\`@${name}\` was empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register has that name — so nothing was pasted.`;
	return known.length === 0 ? base : `${base} Available registers: ${known.map(k => `\`@${k}\``).join(", ")}.`;
}

/**
 * Named paste over a *span* read a register that holds nothing. Pasting empty
 * would delete the span, which the author never asked for — almost always a
 * mistyped or never-captured register name — so the edit is rejected instead.
 */
export function emptyRegisterSpanPasteMessage(name: string, known: readonly string[]): string {
	const base =
		`\`@${name}\` is empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register ` +
		`has that name — so pasting it over a range would delete those lines and write nothing back. ` +
		`Capture the register first (\`CUT … @${name}\`), or use \`CUT\` if deleting the range is what you meant.`;
	return known.length === 0 ? base : `${base} Available registers: ${known.map(k => `\`@${k}\``).join(", ")}.`;
}

/** Unlabeled paste with two or more unlabeled cuts pending. */
export function ambiguousAnonymousPasteMessage(pending: readonly string[]): string {
	return (
		`${pending.length} unlabeled \`CUT\`s are pending (${pending.join(", ")}) — an unlabeled paste cannot tell which one you meant. ` +
		"Label the moves (`CUT … @name` → `PUT … @name`), or keep at most one unlabeled `CUT` before each unlabeled paste."
	);
}

/**
 * Clipboard ops inside a same-path section that was merged across another
 * file's section. Same-path sections coalesce into their first occurrence, so
 * an interleaved layout would silently reorder the register sequence.
 */
export const CLIPBOARD_INTERLEAVED_SECTIONS =
	"`CUT`/register-`PUT` ops cannot be used in a file whose sections are interleaved with another file's: same-path sections merge into the first occurrence, which would reorder the register sequence. Keep each file's ops under ONE `[path#TAG]` header.";

/** Gap `PUT` with `:` but no body. */
export const EMPTY_INSERT =
	"`PUT <N:` / `PUT >N:` promises body rows and got none. Write `+TEXT` rows, or drop the `:` to paste a register (`PUT >N` = anonymous, `PUT >N @name` = named).";

/**
 * `insert after` body indented shallower than the anchor: the landing slid
 * forward past trailing closer lines — the common "anchored on the last line
 * I read instead of after the block" mistake.
 */
export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	return `PUT >${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

/**
 * `PUT >N*:` body indented deeper than the block's closer: the landing was
 * pulled inside the block — a deeper body almost always means "append inside
 * the block's body".
 */
export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return `PUT >${blockStart}*: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`PUT >N*\` lands AFTER the block at sibling depth — if inside was intended, use plain \`PUT >${closerLine}:\`.`;
}

/**
 * Plain `PUT >N:` anchored on a block-opener line with a shallower construct
 * body: the landing was moved past the whole block — anchoring on an opener
 * places the body between the opener and its first statement, a position a
 * body at the opener's depth or above never intends.
 */
export function afterInsertOpenerEscapeWarning(anchorLine: number, landingLine: number): string {
	return (
		`PUT >${anchorLine}: line ${anchorLine} opens a block, and the body's indentation claims a position ` +
		`outside it, so the body was landed after line ${landingLine} (verified by the syntax probe). ` +
		`To insert after a whole construct, anchor on its closing line or use \`PUT >N*:\`.`
	);
}

/** `Recovery`: an external write matched a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** `Recovery`: a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";

/** `Recovery`: stale anchors were relocated to unchanged live lines after drift. */
export const RECOVERY_LINE_REMAP_WARNING =
	"Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";

/**
 * `insert head:`/`insert tail:` applied despite a stale snapshot tag.
 * Head/tail position is content-independent, so drift is non-fatal: apply
 * onto live content and warn instead of hard-failing.
 */
export const HEADTAIL_DRIFT_WARNING =
	"Applied the `PUT <1:`/`PUT >$:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

/**
 * The `Filesystem` reported that what actually landed on disk differs from
 * what was written (see `WriteResult.text`) — most commonly an ACP-connected
 * editor reformatting the buffer on save (e.g. `format_on_save` with tab/space
 * settings that don't match the file). The recorded snapshot is re-keyed on
 * the real, post-write content so the next edit's tag validation matches
 * reality instead of silently drifting.
 */
export function writeDriftWarning(path: string): string {
	return (
		`${path}: the file on disk after this write differs from what was sent — the client ` +
		"(editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). " +
		"The returned snapshot reflects the actual file; re-read before further edits if the " +
		"extra changes were unexpected."
	);
}

/**
 * Section omitted the mandatory snapshot tag. Shared by the apply
 * ({@link Patcher.prepare}) and preview/diff paths so both stay in lockstep.
 */
export function missingSnapshotTagMessage(sectionPath: string): string {
	return `Missing hashline snapshot tag for ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest read/search output. To create a new file, use the write tool.`;
}

/**
 * A section named a path that does not exist, but its filename and snapshot
 * tag together match exactly one file read earlier this session — the model
 * gave the bare filename (or wrong directory) for a file it just read. The
 * edit was rebound to that file's full path. Surfaced as a warning so the
 * model (and user) learn the corrected path and stop reusing the wrong one.
 */
export function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string {
	return (
		`Path "${authoredPath}" does not exist; matched its filename and snapshot tag ` +
		`${HL_FILE_HASH_SEP}${tag} to ${resolvedPath} (read earlier this session). Anchor future edits on ` +
		`${HL_FILE_PREFIX}${resolvedPath}${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}.`
	);
}

/** Compress a line list into a sorted `1-4, 7, 10-12` range string. */
function formatLineRanges(lines: readonly number[]): string {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	if (sorted.length === 0) return "";
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const current = sorted[i];
		if (current === prev + 1) {
			prev = current;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = current;
		prev = current;
	}
	return parts.join(", ");
}

/** One anchored line whose actual content is being surfaced in an error message. */
export interface RevealedLine {
	line: number;
	text: string;
}

/**
 * Content preview handed to {@link unseenLinesMessage}. `lines` are the
 * unseen anchor lines whose actual file content we surface inline (from the
 * tagged snapshot the caller matched). `truncated` = true means the anchor
 * range exceeded the inline reveal cap; the caller only revealed a prefix
 * and the remaining unseen lines still require a range re-read.
 */
export interface UnseenLinesReveal {
	lines: readonly RevealedLine[];
	truncated: boolean;
}

/**
 * An anchored edit referenced lines the read that minted the cited tag never
 * displayed (a partial range, or a structural summary that collapsed bodies).
 * Editing lines you have not read is the off-by-memory failure that mangles
 * files. When `reveal.lines` is non-empty, the caller has already inlined the
 * actual file content at those lines and merged them into the snapshot's
 * seen-line set, so the message points the model at a straight retry with the
 * same `[path#tag]` header; when the reveal is empty or truncated, the
 * message falls back to instructing a range re-read.
 */
export function unseenLinesMessage(
	sectionPath: string,
	unseenLines: readonly number[],
	tag: string,
	reveal: UnseenLinesReveal = { lines: [], truncated: false },
): string {
	const ranges = formatLineRanges(unseenLines);
	const selector = ranges.replace(/, /g, ",");
	const header =
		`This edit anchors to lines ${ranges} of ${sectionPath} that ` +
		`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it showed a ` +
		`partial range, a search hit, or a folded summary).`;
	if (reveal.lines.length === 0) {
		return (
			`${header} Re-read them in full first with a ranged read like ` +
			`\`${sectionPath}:${selector}\` — it skips summarization and mints a fresh tag (a plain re-read just re-folds ` +
			`them) — then re-issue the edit.`
		);
	}
	const preview = reveal.lines.map(({ line, text }) => `  ${formatNumberedLine(line, text)}`).join("\n");
	if (reveal.truncated) {
		return (
			`${header} Preview of the actual file content at the first ${reveal.lines.length} unseen line(s):\n${preview}\n` +
			`The range exceeds the inline preview cap — re-read the remainder with \`${sectionPath}:${selector}\` before ` +
			`re-issuing the edit.`
		);
	}
	return (
		`${header} Actual file content at those lines:\n${preview}\n` +
		`Verify the content matches what you intend to touch, then re-issue the edit with the same ` +
		`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — a straight retry now succeeds without a re-read. ` +
		`If the content does NOT match, fix your line numbers.`
	);
}

/** Op kind of a deferred block edit, for {@link blockSingleLineMessage}. */
export type BlockOp = "replace" | "insert_after" | "cut" | "paste_after";

/** Display forms per deferred-block op: block keyword, trailing colon, and single-line plain form. */
const BLOCK_OP_FORMS: Record<BlockOp, { form: (line: number) => string; plain: (line: number) => string }> = {
	replace: { form: line => `PUT ${line}*:`, plain: line => `PUT ${line}:` },
	insert_after: { form: line => `PUT >${line}*:`, plain: line => `PUT >${line}:` },
	cut: { form: line => `CUT ${line}*`, plain: line => `CUT ${line}` },
	paste_after: { form: line => `PUT >${line}*`, plain: line => `PUT >${line}` },
};

/**
 * A block-op anchor resolved to a single line: line N is a bare statement,
 * not the opening line of a multi-line construct. The plain op is exact for
 * one line, so reject and point at it.
 */
export function blockSingleLineMessage(line: number, op: BlockOp, enclosingBlock?: BlockSpan): string {
	const forms = BLOCK_OP_FORMS[op];
	const plainForm = forms.plain(line);
	let message =
		`\`${forms.form(line)}\` resolved a single-line block — line ${line} is a bare statement, not the opening line ` +
		`of a multi-line construct. For only this statement use \`${plainForm}\`.`;
	if (enclosingBlock) {
		message +=
			` The nearest enclosing multi-line block begins at line ${enclosingBlock.start} ` +
			`and ends at line ${enclosingBlock.end}; use \`${forms.form(enclosingBlock.start)}\` to target it.`;
	}
	return message;
}
