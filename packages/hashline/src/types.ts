/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
	line: number;
}

/** Where an `insert` edit should land relative to existing content. */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert` per replacement line plus
 * one `delete` per consumed line. Replacement payloads are tagged so the
 * applier can distinguish literal insertion from new content for a deleted
 * line.
 */
export type Edit =
	| {
			kind: "insert";
			cursor: Cursor;
			text: string;
			lineNum: number;
			index: number;
			mode?: "replacement";
			/**
			 * Present on inserts lowered from `insert_after_block N:`: the
			 * resolved block's first line. Lets the applier slide a body that
			 * claims a depth inside the block back across the block's trailing
			 * closer lines (never above this line).
			 */
			blockStart?: number;
	  }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
	| {
			/**
			 * Clipboard cut (`CUT N-M @r`, or the resolved form of `CUT N* @r`).
			 * Captures the range's current lines into a {@link Clipboard}
			 * register during the applier's clipboard pre-pass and lowers to one
			 * `delete` per range line at parse/resolve time. `register` names the
			 * target slot; absent means the batch-local anonymous register.
			 */
			kind: "cut";
			range: ParsedRange;
			register?: string;
			lineNum: number;
			index: number;
	  }
	| {
			/**
			 * Clipboard insertion or replacement (`PUT <N @r` / `PUT >N @r` /
			 * `PUT N-M @r`, their `>N*` block-resolved forms, or the register-less
			 * anonymous equivalents). Expanded by the clipboard pre-pass into one
			 * plain insert per captured line; `span` targets additionally expand
			 * into per-line deletes there — only after the register read
			 * succeeds, so a dropped paste (streaming preview with an empty
			 * register) never leaves destructive orphan deletes. `blockStart`
			 * mirrors the insert variant's field for block-lowered gap pastes so
			 * landing correction can slide the body across trailing closer lines.
			 */
			kind: "paste";
			at: PasteTarget;
			register?: string;
			lineNum: number;
			index: number;
			blockStart?: number;
	  }
	| {
			/**
			 * Deferred block edit (`PUT N*:`, `PUT >N*:`, `CUT N*`, or their
			 * `@register` forms). The exact line span is unknown at parse time;
			 * {@link resolveBlockEdits} computes it once file text and language
			 * are available, then expands it into concrete edits.
			 * `mode: "insert_after"` becomes plain `after_anchor` inserts,
			 * `"cut"` becomes a clipboard cut plus per-line deletes, and
			 * `"paste_after"` becomes a gap paste after the resolved block. No
			 * mode denotes a block replacement — from body payloads, or from
			 * `register` when one is named (a span paste over the resolved block).
			 */
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			mode?: "insert_after" | "cut" | "paste_after";
			register?: string;
			lineNum: number;
			index: number;
	  };

/** Where a `paste` edit lands: an insertion gap, or a span it replaces. */
export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

/** File-level operation parsed from a section body (`REM` / `MV`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
	/** Post-edit text body. */
	text: string;
	/** First line number (1-indexed) that changed, or `undefined` for a no-op apply. */
	firstChangedLine?: number;
	/** Diagnostic warnings collected by the parser, patcher, or recovery. */
	warnings?: string[];
	/**
	 * Resolved spans for each block op in this apply, in patch order. Present
	 * only when the apply matched the tagged content, so the line numbers match
	 * what the caller read. Absent when there were no block ops.
	 */
	blockResolutions?: BlockResolution[];
	/**
	 * Boundary echoes for each concrete replacement range in this apply, in
	 * patch order. Present only when the apply matched the tagged content,
	 * so the echoed lines match what the caller read. Absent when there were
	 * no concrete replacements.
	 */
	replacementEchoes?: ReplacementEcho[];
}

/** A parsed `A-B` inclusive line range. */
export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

/** Optional hints for {@link splitPatchInput}. */
export interface SplitOptions {
	/** Resolves absolute paths inside hashline headers to cwd-relative form. */
	cwd?: string;
	/**
	 * Fallback path used when the input lacks a `[PATH]` header but contains
	 * recognizable hashline operations. Lets streaming previews work before
	 * the model has written the header.
	 */
	path?: string;
}

/** Streaming-formatter knobs for {@link streamHashLines}. */
export interface StreamOptions {
	/** First line number to use when formatting (1-indexed, default 1). */
	startLine?: number;
	/** Maximum formatted lines per yielded chunk (default 200). */
	maxChunkLines?: number;
	/** Maximum UTF-8 bytes per yielded chunk (default 64 KiB). */
	maxChunkBytes?: number;
}

/**
 * One hunk's line-count shift, keyed to ORIGINAL (pre-edit) numbering: every
 * original line beyond `fromLine` now sits `delta` lines away from where it
 * was. Surfaced on {@link CompactDiffPreview} so the edit response can back
 * the "take next numbers from the edit response" promise for lines below the
 * edited window.
 *
 * Composition rule: hunks are reported top-down and each `fromLine`/`delta`
 * pair is expressed against the ORIGINAL file, so the deltas are independent
 * — a consumer editing below every hunk applies the SUM of the deltas, while
 * a consumer editing between two hunks applies only the deltas of hunks
 * strictly above its anchor. Only non-zero deltas are reported.
 */
export interface RenumberDelta {
	/** Last original (pre-edit) line the hunk touched or preceded: original lines `> fromLine` shifted. */
	fromLine: number;
	/** `added - removed` within the hunk; never `0`. */
	delta: number;
}

/** Result of {@link buildCompactDiffPreview}. */
export interface CompactDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
	/** Per-hunk line-shift info in patch order; empty when no hunk changed the line count. */
	renumbers: RenumberDelta[];
}

/** Optional knobs for {@link buildCompactDiffPreview}. */
export interface CompactDiffOptions {
	/** Added lines kept on each side of a long added-run elision (default 2). */
	maxAddedRunContext?: number;
	/** Back-compat alias for {@link maxAddedRunContext}. */
	maxUnchangedRun?: number;
}

/**
 * Boundary echo of one concrete replacement range (`PUT N.=M:` or
 * `PUT N.=M @reg`): the first and last ORIGINAL line the range actually
 * covered, so the model can catch a mis-scoped range before anything else
 * does. Surfaced on {@link ApplyResult} alongside {@link BlockResolution};
 * like block resolutions, dropped on drift-recovery paths where line numbers
 * were remapped.
 */
export interface ReplacementEcho {
	/** First line of the replaced range (1-indexed, inclusive, original numbering). */
	start: number;
	/** Last line of the replaced range (1-indexed, inclusive, original numbering). */
	end: number;
	/** Original content of line {@link start} (untruncated). */
	first: string;
	/** Original content of line {@link end} (untruncated). */
	last: string;
}

/** Resolved 1-indexed inclusive line span of a block target. */
export interface BlockSpan {
	/** First line of the block (1-indexed, inclusive). */
	start: number;
	/** Last line of the block (1-indexed, inclusive). */
	end: number;
}

/**
 * One block-op anchor resolved to its concrete line span. Surfaced on
 * {@link ApplyResult} so the host can echo the resolved range and let the
 * model catch an anchor on the wrong opener.
 */
export interface BlockResolution {
	/** The 1-indexed line the block op was anchored on (the `N`). */
	anchorLine: number;
	/** First line of the resolved span (1-indexed, inclusive). */
	start: number;
	/** Last line of the resolved span (1-indexed, inclusive). */
	end: number;
	/** Which block op produced this resolution. */
	op: "replace" | "insert_after" | "cut" | "paste_after";
}

/** Request handed to a {@link BlockResolver} to resolve one block-op anchor. */
export interface BlockResolverRequest {
	/** Target file path (used to infer language by extension). */
	path: string;
	/** Full text the block must be resolved against (the snapshot the tag names). */
	text: string;
	/** 1-indexed line the block must begin on. */
	line: number;
}

/**
 * Resolves a block-op anchor to the line span of the syntactic block beginning
 * on that line. Returns `null` for an unsupported language, invalid line, absent
 * opener, or syntax error. The host injects the tree-sitter-backed implementation.
 */
export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null;

/**
 * Mutable clipboard registers threaded through one patch application. Filled
 * by `CUT` edits and read by register `PUT`s in patch source order, across
 * sections, so content can move between files.
 *
 * The anonymous register (`lines`) is batch-local: {@link forkClipboard}
 * never copies it in, so it exists only between a `CUT` and a paste inside
 * one patch. Named registers (`named`) persist across batches when the host
 * owns the Clipboard (`PatcherOptions.clipboard`) — the sanctioned way to
 * move content across separate edit calls.
 */
export interface Clipboard {
	/** Anonymous register: lines captured by the latest unlabeled `CUT` in this batch. */
	lines?: readonly string[];
	/** Named registers captured by `CUT … @name`. */
	named?: Map<string, readonly string[]>;
	/**
	 * Headers of unlabeled `CUT`s seen since the last unlabeled paste in this
	 * batch. Two or more make the next unlabeled paste ambiguous (which cut
	 * did the author mean?) and fail it with a labeling hint.
	 */
	pendingAnonCuts?: string[];
}
