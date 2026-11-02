//! Pure data types shared across the hashline tokenizer, parser, applier,
//! and patcher. Port of `packages/hashline/src/types.ts`; nothing here
//! touches a filesystem.

pub use crate::store::Clipboard;

/// A 1-indexed line anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Anchor {
	pub line: u32,
}

/// Where an `insert` edit lands relative to existing content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cursor {
	Bof,
	Eof,
	BeforeAnchor(Anchor),
	AfterAnchor(Anchor),
}

/// A parsed `A-B` inclusive line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedRange {
	pub start: Anchor,
	pub end:   Anchor,
}

/// Where a `paste` edit lands: an insertion gap, or a span it replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteTarget {
	Gap { cursor: Cursor },
	Span { range: ParsedRange },
}

/// Deferred block-op mode (`None` = block replacement).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockMode {
	InsertAfter,
	Cut,
	PasteAfter,
}

/// One low-level edit produced by the parser and consumed by the applier.
/// Multi-line replacements decompose to one `Insert` per replacement line
/// plus one `Delete` per consumed line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
	Insert {
		cursor:      Cursor,
		text:        String,
		/// 1-indexed payload line this edit came from (for messages).
		line_num:    u32,
		/// Position in the section's op list.
		index:       u32,
		/// True for replacement-payload inserts (vs. literal insertion).
		replacement: bool,
		/// Resolved block's first line for inserts lowered from
		/// `insert_after_block`; bounds landing correction.
		block_start: Option<u32>,
	},
	Delete {
		anchor:        Anchor,
		line_num:      u32,
		index:         u32,
		/// Expected old content (`-` assertion row) when the payload carried one.
		old_assertion: Option<String>,
	},
	/// Clipboard cut (`CUT N-M @r`); captures range lines during the
	/// clipboard pre-pass and lowers to per-line deletes.
	Cut { range: ParsedRange, register: Option<String>, line_num: u32, index: u32 },
	/// Clipboard insertion or replacement (`PUT <N @r` / `PUT >N @r` /
	/// `PUT N-M @r` or the anonymous equivalents).
	Paste {
		at:          PasteTarget,
		register:    Option<String>,
		line_num:    u32,
		index:       u32,
		block_start: Option<u32>,
	},
	/// Deferred block edit (`PUT N*:`, `PUT >N*:`, `CUT N*`, `@register`
	/// forms); resolved to concrete edits once file text is available.
	Block {
		anchor:   Anchor,
		payloads: Vec<String>,
		mode:     Option<BlockMode>,
		register: Option<String>,
		line_num: u32,
		index:    u32,
	},
}

impl Edit {
	/// Payload line number the edit was parsed from.
	pub const fn line_num(&self) -> u32 {
		match self {
			Self::Insert { line_num, .. }
			| Self::Delete { line_num, .. }
			| Self::Cut { line_num, .. }
			| Self::Paste { line_num, .. }
			| Self::Block { line_num, .. } => *line_num,
		}
	}

	/// Position in the section's op list.
	pub const fn index(&self) -> u32 {
		match self {
			Self::Insert { index, .. }
			| Self::Delete { index, .. }
			| Self::Cut { index, .. }
			| Self::Paste { index, .. }
			| Self::Block { index, .. } => *index,
		}
	}
}

/// File-level operation parsed from a section body (`REM` / `MV`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOp {
	Rem,
	Move { dest: String },
}

/// Which block op produced a [`BlockResolution`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockOpKind {
	Replace,
	InsertAfter,
	Cut,
	PasteAfter,
}

/// One block-op anchor resolved to its concrete line span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockResolution {
	/// The 1-indexed line the block op was anchored on (the `N`).
	pub anchor_line: u32,
	pub start:       u32,
	pub end:         u32,
	pub op:          BlockOpKind,
}

/// Resolved 1-indexed inclusive line span of a block target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockSpan {
	pub start: u32,
	pub end:   u32,
}

/// Result of applying a parsed set of edits to a text body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyResult {
	pub text:               String,
	/// 1-indexed first changed line; `None` for a no-op apply.
	pub first_changed_line: Option<u32>,
	pub warnings:           Vec<String>,
	/// Resolved spans for each block op, in patch order (only when the apply
	/// matched the tagged content).
	pub block_resolutions:  Vec<BlockResolution>,
}
