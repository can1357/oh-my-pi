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
			 * Deferred block edit (`replace_block N:` / `delete_block N` /
			 * `insert_after_block N:`). The exact line span is unknown at parse
			 * time — it is computed by {@link resolveBlockEdits} once file text +
			 * path (→ language) are available, then expanded into concrete edits:
			 * a non-empty `payloads` without `mode` (from `replace_block`) becomes
			 * the same `replacement` inserts + deletes that `replace start.=end:`
			 * produces; an empty `payloads` (from `delete_block`) becomes a pure
			 * range deletion; `mode: "insert_after"` becomes plain `after_anchor`
			 * inserts at the block's last line. `applyEdits` never sees this
			 * variant.
			 */
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			mode?: "insert_after";
			lineNum: number;
			index: number;
	  };

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
	 * Resolved spans for each `replace_block`/`delete_block` op in this apply,
	 * in patch order. Present only when the apply matched the tagged content
	 * (the common no-drift path), so the line numbers line up with what the
	 * caller read. Absent when there were no block ops.
	 */
	blockResolutions?: BlockResolution[];
}

/** A parsed `[A.=B]` line range. */
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

/** Result of {@link buildCompactDiffPreview}. */
export interface CompactDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

/** Optional knobs for {@link buildCompactDiffPreview}. */
export interface CompactDiffOptions {
	/** Added lines kept on each side of a long added-run elision (default 2). */
	maxAddedRunContext?: number;
	/** Back-compat alias for {@link maxAddedRunContext}. */
	maxUnchangedRun?: number;
}

/**
 * Resolved 1-indexed inclusive line span of a `replace_block N:` target.
 */
export interface BlockSpan {
	/** First line of the block (1-indexed, inclusive). */
	start: number;
	/** Last line of the block (1-indexed, inclusive). */
	end: number;
}

/**
 * One `replace_block N:` / `delete_block N` / `insert_after_block N:` anchor
 * resolved to its concrete line span. Surfaced on {@link ApplyResult} so the
 * host can echo "block N → lines start.=end" and let the model catch a wrong
 * opener — e.g. a decorator or doc-comment that sits in a separate node
 * outside the resolved block.
 */
export interface BlockResolution {
	/** The 1-indexed line the block op was anchored on (the `N`). */
	anchorLine: number;
	/** First line of the resolved span (1-indexed, inclusive). */
	start: number;
	/** Last line of the resolved span (1-indexed, inclusive). */
	end: number;
	/** Which block op produced this resolution. */
	op: "replace" | "delete" | "insert_after";
}

/** Request handed to a {@link BlockResolver} to resolve one `replace_block N:` anchor. */
export interface BlockResolverRequest {
	/** Target file path (used to infer language by extension). */
	path: string;
	/** Full text the block must be resolved against (the snapshot the tag names). */
	text: string;
	/** 1-indexed line the block must begin on. */
	line: number;
}

/**
 * Resolves a `replace_block N:` anchor to the line span of the syntactic block
 * that begins on line N. Returns `null` when no block can be resolved
 * (unrecognized language, blank/out-of-range line, no node begins there, or the
 * resolved subtree has a syntax error). Pure seam: the hashline core declares
 * the contract; the host injects a tree-sitter-backed implementation.
 */
export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null;
