//! Pure data types shared across the hashline tokenizer, parser, applier,
//! and patcher. Port of `packages/hashline/src/types.ts`; nothing here
//! touches a filesystem.

pub use crate::store::Clipboard;

/// A 1-indexed line anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Anchor {
	/// Line.
	pub line: u32,
}

/// Where an `insert` edit lands relative to existing content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cursor {
	/// Bof.
	Bof,
	/// Eof.
	Eof,
	/// Before anchor.
	BeforeAnchor(Anchor),
	/// After anchor.
	AfterAnchor(Anchor),
}

/// A parsed `A-B` inclusive line range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedRange {
	/// Start.
	pub start: Anchor,
	/// End.
	pub end:   Anchor,
}

/// Where a `paste` edit lands: an insertion gap, or a span it replaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteTarget {
	/// Gap.
	Gap {
		/// Cursor.
		cursor: Cursor,
	},
	/// Span.
	Span {
		/// Range.
		range: ParsedRange,
	},
}

/// Deferred block-op mode (`None` = block replacement).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockMode {
	/// Insert after.
	InsertAfter,
	/// Cut.
	Cut,
	/// Paste after.
	PasteAfter,
}

/// One low-level edit produced by the parser and consumed by the applier.
/// Multi-line replacements decompose to one `Insert` per replacement line
/// plus one `Delete` per consumed line.
#[derive(Debug, Clone, PartialEq, Eq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum Edit {
	/// Insert.
	Insert {
		/// Cursor.
		cursor:      Cursor,
		/// Text.
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
	/// Delete.
	Delete {
		/// Anchor.
		anchor:        Anchor,
		/// Line num.
		line_num:      u32,
		/// Index.
		index:         u32,
		/// Expected old content (`-` assertion row) when the payload carried one.
		old_assertion: Option<String>,
	},
	/// Clipboard cut (`CUT N-M @r`); captures range lines during the
	/// clipboard pre-pass and lowers to per-line deletes.
	Cut {
		/// Range.
		range:    ParsedRange,
		/// Register.
		register: Option<String>,
		/// Line num.
		line_num: u32,
		/// Index.
		index:    u32,
	},
	/// Clipboard insertion or replacement (`PUT <N @r` / `PUT >N @r` /
	/// `PUT N-M @r` or the anonymous equivalents).
	Paste {
		/// At.
		at:          PasteTarget,
		/// Register.
		register:    Option<String>,
		/// Line num.
		line_num:    u32,
		/// Index.
		index:       u32,
		/// Block start.
		block_start: Option<u32>,
	},
	/// Deferred block edit (`PUT N*:`, `PUT >N*:`, `CUT N*`, `@register`
	/// forms); resolved to concrete edits once file text is available.
	Block {
		/// Anchor.
		anchor:   Anchor,
		/// Payloads.
		payloads: Vec<String>,
		/// Mode.
		mode:     Option<BlockMode>,
		/// Register.
		register: Option<String>,
		/// Line num.
		line_num: u32,
		/// Index.
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
	/// Rem.
	Rem,
	/// Move.
	Move {
		/// Dest.
		dest: String,
	},
}

/// Which block op produced a [`BlockResolution`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockOpKind {
	/// Replace.
	Replace,
	/// Insert after.
	InsertAfter,
	/// Cut.
	Cut,
	/// Paste after.
	PasteAfter,
}

/// One block-op anchor resolved to its concrete line span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockResolution {
	/// The 1-indexed line the block op was anchored on (the `N`).
	pub anchor_line: u32,
	/// Start.
	pub start:       u32,
	/// End.
	pub end:         u32,
	/// Op.
	pub op:          BlockOpKind,
}

/// Resolved 1-indexed inclusive line span of a block target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockSpan {
	/// Start.
	pub start: u32,
	/// End.
	pub end:   u32,
}

/// Result of applying a parsed set of edits to a text body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyResult {
	/// Text.
	pub text:               String,
	/// 1-indexed first changed line; `None` for a no-op apply.
	pub first_changed_line: Option<u32>,
	/// Warnings.
	pub warnings:           Vec<String>,
	/// Resolved spans for each block op, in patch order (only when the apply
	/// matched the tagged content).
	pub block_resolutions:  Vec<BlockResolution>,
}
