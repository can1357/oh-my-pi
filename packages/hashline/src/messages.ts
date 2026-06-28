/** Centralized error/warning text for the hashline parser, applier, and patcher. */

import { formatNumberedLine, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_RANGE_SEP } from "./format";

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

/** Optional patch envelope start marker; silently consumed. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";

/** Optional patch envelope end marker; terminates parsing. */
export const END_PATCH_MARKER = "*** End Patch";

/**
 * Truncation sentinel emitted by an agent loop mid-call. Ends parsing like
 * {@link END_PATCH_MARKER}, without a warning.
 */
export const ABORT_MARKER = "*** Abort";

/** Two consecutive hunks targeted the exact same concrete range. */
export const REPLACE_PAIR_COALESCED_WARNING = `Two hunks targeted the same range; kept only the second. One \`SWAP N${HL_RANGE_SEP}M:\` hunk per range — the body is the final content, never old+new.`;

/** Bare bodyless hunk followed by an overlapping concrete hunk. */
`Dropped a bare hunk overlapped by the concrete hunk after it. One \`SWAP N${HL_RANGE_SEP}M:\` hunk per range — the body is the final content, never old+new.`;

/** Bare body rows auto-converted to literal `+` rows. */
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";

/** Unified-diff-style `-` row in a hunk body. */
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.";

/** Replace hunk with no body. */
export const EMPTY_REPLACE = `\`SWAP N${HL_RANGE_SEP}M:\` needs at least one \`+TEXT\` body row. To delete lines, use \`DEL N${HL_RANGE_SEP}M\`.`;

/** `replace_block N:` hunk with no body. */
export const EMPTY_BLOCK = "`SWAP.BLK N:` needs at least one `+TEXT` body row. To delete a block, use `DEL.BLK N`.";

/**
 * Block-anchored replace/delete could not resolve to a syntactic block
 * (unsupported language, blank/out-of-range line, no node beginning on N, or
 * parse error). Appends a {@link formatAnchoredContext} preview when
 * `fileLines` is given. `insert_after_block N:` never reaches this — it is
 * lowered to plain `insert after N:` instead (see
 * {@link insertAfterBlockUnresolvedLoweredWarning}).
 */
export function blockUnresolvedMessage(
	line: number,
	op: "replace" | "delete" = "replace",
	fileLines?: readonly string[],
): string {
	const phrase = op === "delete" ? `DEL.BLK ${line}` : `SWAP.BLK ${line}:`;
	const fallback = op === "delete" ? `DEL ${line}${HL_RANGE_SEP}M` : `SWAP ${line}${HL_RANGE_SEP}M:`;
	let message =
		`\`${phrase}\` could not resolve a syntactic block beginning on line ${line} ` +
		`(unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

/** Block-anchored edit reached a path with no {@link BlockResolver} wired in — a host-configuration bug. */
export const BLOCK_RESOLVER_UNAVAILABLE =
	"`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` are not available here (no block resolver configured). Use a concrete line range.";

/**
 * `insert_after_block N:` anchored on a closing-delimiter line, lowered to
 * plain `insert after N:` — the closer ends a block, and inserting after it
 * is exactly what the plain form does.
 */
export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return `\`INS.BLK.POST ${line}:\` anchors on a closing delimiter, so it was applied as plain \`INS.POST ${line}:\`. Anchor on the line that OPENS the construct.`;
}

/**
 * `insert_after_block N:` anchor unresolvable (unsupported language, blank
 * line, parse error, or no resolver), lowered to plain `insert after N:` —
 * applying with a warning beats failing the patch.
 */
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return `\`INS.BLK.POST ${line}:\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`INS.POST ${line}:\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}

/**
 * Internal invariant: `applyEdits` received an unresolved `replace_block N:`
 * edit; `resolveBlockEdits` must run first. Wiring bug, not authored input.
 */
export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved `SWAP.BLK` edit reached the applier (resolveBlockEdits was not run).";

/** Delete hunk received a body row. */
export const DELETE_TAKES_NO_BODY = `\`DEL N${HL_RANGE_SEP}M\` does not take body rows. Remove the body, or use \`SWAP N${HL_RANGE_SEP}M:\`.`;

/** `REM` received a body row or coexists with line edits. */
export const REM_TAKES_NO_BODY =
	"`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";

/** `MV` received a body row. */
export const MOVE_TAKES_NO_BODY =
	"`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";

/** `delete_block N` hunk received a body row. */
export const DELETE_BLOCK_TAKES_NO_BODY = "`DEL.BLK N` does not take body rows. Remove the body, or use `SWAP.BLK N:`.";

/** Insert hunk with no body. */
export const EMPTY_INSERT = "`INS` needs at least one `+TEXT` body row.";

/**
 * `insert after` body indented shallower than the anchor: the landing slid
 * forward past trailing closer lines — the common "anchored on the last line
 * I read instead of after the block" mistake.
 */
export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	return `INS.POST ${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

/**
 * `insert_after_block N:` body indented deeper than the block's closer: the
 * landing was pulled inside the block — a deeper body almost always means
 * "append inside the block's body".
 */
export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return `INS.BLK.POST ${blockStart}: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`INS.BLK.POST\` lands AFTER the block at sibling depth — if inside was intended, use plain \`INS.POST ${closerLine}:\`.`;
}

/** `Recovery`: an external write matched a cached snapshot. */
export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";

/** `Recovery`: a prior in-session edit advanced the hash. */
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";

/**
 * `Recovery`: session-chain replay fast-path. Less certain than
 * {@link RECOVERY_SESSION_CHAIN_WARNING} — the 3-way merge refused, the
 * anchor-content gate passed, but a coincidental insert+delete earlier in
 * the chain could still misplace an anchor — hence the verify hedge.
 */
export const RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content (a prior in-session edit changed the lines you re-targeted with a stale hash). Verify the diff matches your intent.";

/**
 * `insert head:`/`insert tail:` applied despite a stale snapshot tag.
 * Head/tail position is content-independent, so drift is non-fatal: apply
 * onto live content and warn instead of hard-failing.
 */
export const HEADTAIL_DRIFT_WARNING =
	"Applied the `INS.HEAD:`/`INS.TAIL:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

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

/**
 * An anchored edit referenced lines the read that minted the cited tag never
 * displayed (a partial range, or a structural summary that collapsed bodies).
 * Editing lines you have not read is the off-by-memory failure that mangles
 * files; reject and make the model re-read those exact lines first.
 */
export function unseenLinesMessage(sectionPath: string, unseenLines: readonly number[], tag: string): string {
	const ranges = formatLineRanges(unseenLines);
	const selector = ranges.replace(/, /g, ",");
	return (
		`This edit anchors to lines ${ranges} of ${sectionPath} that ` +
		`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it showed a ` +
		`partial range, a search hit, or a folded summary). Re-read them in full first with a ranged read like ` +
		`\`${sectionPath}:${selector}\` — it skips summarization and mints a fresh tag (a plain re-read just re-folds ` +
		`them) — then re-issue the edit.`
	);
}

/** Op kind of a deferred block edit, for {@link blockSingleLineMessage}. */
export type BlockOp = "replace" | "delete" | "insert_after";

/**
 * A `replace_block`/`delete_block`/`insert_after_block` anchor resolved to a
 * single line — almost always a bare statement the model mis-anchored, not a
 * multi-line construct. The plain op is unambiguous for one line; the block
 * form only earns its keep when it spares counting a closing line you cannot
 * see. Reject and point at both fixes.
 */
export function blockSingleLineMessage(line: number, op: BlockOp): string {
	const blockForm = op === "insert_after" ? "INS.BLK.POST" : op === "delete" ? "DEL.BLK" : "SWAP.BLK";
	const plainForm =
		op === "insert_after"
			? `INS.POST ${line}:`
			: op === "delete"
				? `DEL ${line}`
				: `SWAP ${line}${HL_RANGE_SEP}${line}:`;
	return (
		`\`${blockForm} ${line}\` resolved a single-line block — line ${line} is a bare statement, not the opening line ` +
		`of a multi-line construct. For that one line use \`${plainForm}\`; to act on an enclosing construct, anchor ${blockForm} ` +
		`on the line that OPENS it (e.g. its \`function\`/\`if\`/\`case\` header), never a statement inside it.`
	);
}
