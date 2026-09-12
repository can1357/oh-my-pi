//! Internal IR shared by the sloppy parser (`parse.rs`) and matcher/applier
//! (`apply.rs`). Port of the type declarations in
//! `packages/coding-agent/src/edit/sloppy.ts` (lines 27–520).
//!
//! Every offset in these types is a **byte** index into the UTF-8 text it
//! was computed against (the TypeScript source used UTF-16 indices; both are
//! internal and never surface to the model).

/// One `<SM:EDIT path="…">` target of a sloppy payload: a file plus its
/// compiled op stream (`«`/`»` lines).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SloppySection {
	pub path: String,
	pub body: String,
}

/// One stray sloppy payload region located inside plain prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineSloppyRegion {
	/// UTF-16 offset of the opener line's first unit within the scanned text
	/// (JS slices with it).
	pub start:   usize,
	/// UTF-16 offset one past the last payload line (its newline included).
	pub end:     usize,
	/// Verbatim payload text, opener line through last structural line.
	pub payload: String,
}

/// Internal op-stream alphabet; the taught surface is the XML tag format.
pub mod markers {
	pub const OPEN: &str = "«";
	pub const PUT: &str = "»";
	pub const SELECT_OPEN: &str = "⟪";
	pub const SELECT_CLOSE: &str = "⟫";
	pub const GAP: &str = "…";
	pub const SELECT_DIVIDER: &str = "│";
	pub const ADD: &str = "＋";
	pub const REMOVE: &str = "－";
}

/// Upper bound on candidates considered per operation.
pub const MAX_CANDIDATES: usize = 200;
/// Upper bound on candidate combinations explored for `all` ops.
pub const MAX_COMBINATIONS: usize = 20_000;
/// Appended to every apply failure so the model re-sends the whole payload.
pub const ATOMICITY_NOTICE: &str =
	"No operations were applied — ops apply atomically; re-send the full corrected payload.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationRewrite {
	Explicit { text: String },
	Inline { replacements: Vec<String> },
}

/// One compiled `«` … `»` … operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operation {
	pub pattern_text:        String,
	pub source_pattern_text: String,
	pub rewrite:             OperationRewrite,
	pub all:                 bool,
	/// Pattern-only op applied as a deletion; justified only when another op
	/// re-emits the block.
	pub assumed_deletion:    bool,
	/// Marker-less op read as desired text; a no-op means the assertion
	/// already holds.
	pub desired_state:       bool,
	/// Post-apply advisory for a formally invalid payload recovered at parse
	/// time.
	pub recovery_note:       Option<String>,
	/// Marker-line op whose MATCH found the file only after whitespace
	/// normalization.
	pub whitespace_matched:  bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternToken {
	Literal { text: String, normalized: String },
	Gap { capture_index: usize, line_bounded: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteralFallback {
	pub normalized:      String,
	pub selection_start: usize,
	pub selection_end:   usize,
	pub insertion:       bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionPair {
	pub start:           usize,
	pub end:             usize,
	pub capture_indices: Vec<usize>,
	pub line_insertion:  bool,
	/// Old side is purely gap-captured (bare desired-text selection).
	pub gap_only:        bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPattern {
	pub tokens:                   Vec<PatternToken>,
	pub selection_start:          usize,
	pub selection_end:            usize,
	pub insertion:                bool,
	pub line_insertion:           bool,
	pub selected_capture_indices: Vec<usize>,
	pub selection_ranges:         Vec<(usize, usize)>,
	pub selection_pairs:          Vec<SelectionPair>,
	pub literal_fallback:         Option<LiteralFallback>,
}

/// Whitespace/punctuation-normalized text with per-normalized-byte maps back
/// to source byte offsets (`starts[i]` = source start of normalized byte `i`,
/// `ends[i]` = source end).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedText {
	pub text:   String,
	pub starts: Vec<usize>,
	pub ends:   Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Occurrence {
	pub start:             usize,
	pub end:               usize,
	pub distance:          usize,
	pub punctuation_edits: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
	pub start:           usize,
	pub end:             usize,
	pub match_start:     usize,
	pub match_end:       usize,
	pub captures:        Vec<String>,
	pub selection_spans: Vec<(usize, usize)>,
	pub tuple:           Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateResult {
	pub candidates: Vec<Candidate>,
	pub overflow:   bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedEdit {
	pub start:            usize,
	pub end:              usize,
	pub replacement:      String,
	pub operation_number: usize,
}
