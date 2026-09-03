/**
 * Expand deferred block edits into concrete inserts, cuts, pastes, and deletes.
 *
 * The parser cannot expand a block edit until file text and language are
 * available. This transform resolves each anchored span, then emits the same
 * low-level edits as the corresponding concrete operation. After it runs, no
 * `block` edits remain, so {@link applyEdits} and recovery see concrete edits.
 */
import { STRUCTURAL_CLOSER_RE } from "./apply";
import {
	BLOCK_RESOLVER_UNAVAILABLE,
	type BlockDiagnosticSuggestions,
	type BlockOp,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	pasteAfterBlockCloserLoweredWarning,
	pasteAfterBlockUnresolvedLoweredWarning,
} from "./messages";
import type { BlockResolution, BlockResolver, BlockSpan, Cursor, Edit } from "./types";

/** Maximum nearby lines inspected only after a block anchor has already failed. */
const BLOCK_SUGGESTION_SCAN_LIMIT = 64;

function resolveDiagnosticBlock(resolver: BlockResolver, path: string, text: string, line: number): BlockSpan | null {
	try {
		return resolver({ path, text, line });
	} catch {
		// Suggestions are best-effort and must never hide the authoritative anchor error.
		return null;
	}
}

function findNextBlock(
	anchorLine: number,
	lines: readonly string[],
	path: string,
	text: string,
	resolver: BlockResolver,
): BlockSpan | null {
	const lastLine = Math.min(lines.length, anchorLine + BLOCK_SUGGESTION_SCAN_LIMIT);
	for (let line = anchorLine + 1; line <= lastLine; line++) {
		if (lines[line - 1]?.trim().length === 0) continue;
		const span = resolveDiagnosticBlock(resolver, path, text, line);
		if (span?.start === line && span.end > line) return span;
	}
	return null;
}

function findEnclosingBlock(
	anchorLine: number,
	lines: readonly string[],
	path: string,
	text: string,
	resolver: BlockResolver,
): BlockSpan | null {
	const firstLine = Math.max(1, anchorLine - BLOCK_SUGGESTION_SCAN_LIMIT);
	for (let line = anchorLine - 1; line >= firstLine; line--) {
		if (lines[line - 1]?.trim().length === 0) continue;
		const span = resolveDiagnosticBlock(resolver, path, text, line);
		if (span?.start === line && span.end >= anchorLine && span.end > line) return span;
	}
	return null;
}

/** Optional knobs for {@link resolveBlockEdits}. */
export interface ResolveBlockEditsOptions {
	/**
	 * How to handle a replace/cut block edit that cannot be resolved. `"throw"`
	 * (default) raises a block error; `"drop"` skips it for streaming previews.
	 * Unresolvable after-block edits lower to their plain after-line form.
	 */
	onUnresolved?: "throw" | "drop";
	/**
	 * Invoked once per successfully resolved block edit, in patch order, with
	 * the anchor line and the concrete span it resolved to. Lets the host echo
	 * the resolution back to the caller. Never fired for dropped/unresolvable
	 * edits.
	 */
	onResolved?: (resolution: BlockResolution) => void;
	/**
	 * Invoked once per diagnostic produced while resolving — currently the
	 * `insert_after_block N:` lowerings (closer anchor or unresolvable block).
	 * Hosts should surface these on the apply result's `warnings`.
	 */
	onWarning?: (message: string) => void;
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => edit.kind === "block");
}

/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
	edits: readonly Edit[],
	text: string,
	path: string,
	resolver: BlockResolver | undefined,
	options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
	if (!hasBlockEdit(edits)) return edits;
	const onUnresolved = options.onUnresolved ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const op: BlockOp = edit.mode ?? "replace";
		const span = resolver ? resolver({ path, text, line: edit.anchor.line }) : null;
		if (span === null) {
			// `insert_after_block N:` never fails the patch — lower it to plain
			// `insert after N:` with a warning instead. Two flavors:
			// - anchored on a pure closing-delimiter line: no block begins
			//   there, but line N IS the end of one, and "after the end of the
			//   block" is exactly the plain form — warn with the opener rule.
			// - otherwise (unsupported language, blank line, unparsable block,
			//   or no resolver wired): "after the block at N" degrades to
			//   "after line N" — warn to verify the landing line.
			if (op === "insert_after" || op === "paste_after") {
				const anchorText = text.split("\n")[edit.anchor.line - 1];
				const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
				if (op === "paste_after") {
					options.onWarning?.(
						isCloser
							? pasteAfterBlockCloserLoweredWarning(edit.anchor.line)
							: pasteAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
					);
					const cursor: Cursor = { kind: "after_anchor", anchor: { line: edit.anchor.line } };
					resolved.push({
						kind: "paste",
						at: { kind: "gap", cursor },
						...(edit.register === undefined ? {} : { register: edit.register }),
						lineNum: edit.lineNum,
						index: synthIndex++,
					});
					continue;
				}
				options.onWarning?.(
					isCloser
						? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
						: insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
				);
				for (const payload of edit.payloads) {
					const cursor: Cursor = { kind: "after_anchor", anchor: { line: edit.anchor.line } };
					resolved.push({ kind: "insert", cursor, text: payload, lineNum: edit.lineNum, index: synthIndex++ });
				}
				continue;
			}
			if (onUnresolved === "drop") continue;
			if (!resolver) throw new Error(`line ${edit.lineNum}: ${BLOCK_RESOLVER_UNAVAILABLE}`);
			const lines = text.split("\n");
			const nextBlock =
				lines[edit.anchor.line - 1]?.trim().length === 0
					? findNextBlock(edit.anchor.line, lines, path, text, resolver)
					: null;
			const enclosingBlock =
				nextBlock === null ? findEnclosingBlock(edit.anchor.line, lines, path, text, resolver) : null;
			const suggestions: BlockDiagnosticSuggestions = {};
			if (nextBlock) suggestions.nextBlock = nextBlock;
			if (enclosingBlock) suggestions.enclosingBlock = enclosingBlock;
			throw new Error(
				`line ${edit.lineNum}: ${blockUnresolvedMessage(edit.anchor.line, op, lines, suggestions, edit.register)}`,
			);
		}
		if (span.start === span.end) {
			// A single-line block resolution means line N is a bare statement, not
			// the opening line of a multi-line construct — the common mis-anchor
			// that lands a body in the wrong scope (e.g. between a `case` body line
			// and its `break;`). The plain op is exact for one line, so reject and
			// point at it; drop instead on the lenient preview path.
			if (onUnresolved === "drop") continue;
			const enclosingBlock = resolver
				? findEnclosingBlock(edit.anchor.line, text.split("\n"), path, text, resolver)
				: null;
			throw new Error(
				`line ${edit.lineNum}: ${blockSingleLineMessage(edit.anchor.line, op, enclosingBlock ?? undefined)}`,
			);
		}
		options.onResolved?.({
			anchorLine: edit.anchor.line,
			start: span.start,
			end: span.end,
			op,
		});
		if (op === "paste_after") {
			// Mirror the block-lowered insert: paste after the block's last
			// line, tagging `blockStart` so landing correction can slide a body
			// claiming a depth inside the block back across its trailing closers.
			resolved.push({
				kind: "paste",
				at: { kind: "gap", cursor: { kind: "after_anchor", anchor: { line: span.end } } },
				...(edit.register === undefined ? {} : { register: edit.register }),
				lineNum: edit.lineNum,
				index: synthIndex++,
				blockStart: span.start,
			});
			continue;
		}
		if (op === "cut") {
			// Capture the resolved span before deleting it line-by-line.
			resolved.push({
				kind: "cut",
				range: { start: { line: span.start }, end: { line: span.end } },
				...(edit.register === undefined ? {} : { register: edit.register }),
				lineNum: edit.lineNum,
				index: synthIndex++,
			});
			for (let line = span.start; line <= span.end; line++) {
				resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ });
			}
			continue;
		}
		if (op === "insert_after") {
			// Mirror the parser's `insert after N:` lowering: one `after_anchor`
			// insert per payload row, anchored on the block's last line. The
			// `blockStart` tag lets the applier's landing correction slide a
			// body that claims a depth inside the block back across the block's
			// trailing closer lines.
			for (const payload of edit.payloads) {
				const cursor: Cursor = { kind: "after_anchor", anchor: { line: span.end } };
				resolved.push({
					kind: "insert",
					cursor,
					text: payload,
					lineNum: edit.lineNum,
					index: synthIndex++,
					blockStart: span.start,
				});
			}
			continue;
		}
		if (edit.register !== undefined) {
			// Register-backed block replace (`PUT N* @reg`): expand to a span paste
			// over the resolved block range.
			resolved.push({
				kind: "paste",
				at: { kind: "span", range: { start: { line: span.start }, end: { line: span.end } } },
				register: edit.register,
				lineNum: edit.lineNum,
				index: synthIndex++,
			});
			continue;
		}
		// Body-backed block replace (`PUT N*:` + body): replacement inserts at
		// `span.start`, then one delete per line across the resolved span.
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
			resolved.push({
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: synthIndex++,
				mode: "replacement",
			});
		}
		for (let line = span.start; line <= span.end; line++) {
			resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ });
		}
	}
	return resolved;
}
