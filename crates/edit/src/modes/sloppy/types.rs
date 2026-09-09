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
	/// Path.
	pub path: String,
	/// Body.
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
	/// Begin a match selection.
	pub const OPEN: &str = "«";
	/// Begin replacement text.
	pub const PUT: &str = "»";
	/// Begin a selected capture.
	pub const SELECT_OPEN: &str = "⟪";
	/// End a selected capture.
	pub const SELECT_CLOSE: &str = "⟫";
	/// Match an elided span.
	pub const GAP: &str = "…";
	/// Divide selected alternatives.
	pub const SELECT_DIVIDER: &str = "│";
	/// Mark an added line.
	pub const ADD: &str = "＋";
	/// Mark a removed line.
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
/// Operation rewrite variants.
pub enum OperationRewrite {
	/// Explicit.
	Explicit {
		/// Text.
		text: String,
	},
	/// Inline.
	Inline {
		/// Replacements.
		replacements: Vec<String>,
	},
}

/// One compiled `«` … `»` … operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operation {
	/// Pattern text.
	pub pattern_text:        String,
	/// Source pattern text.
	pub source_pattern_text: String,
	/// Rewrite.
	pub rewrite:             OperationRewrite,
	/// All.
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
/// Pattern token variants.
pub enum PatternToken {
	/// Literal.
	Literal {
		/// Text.
		text:       String,
		/// Normalized.
		normalized: String,
	},
	/// Gap.
	Gap {
		/// Capture index.
		capture_index: usize,
		/// Line bounded.
		line_bounded:  bool,
	},
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Literal fallback data.
pub struct LiteralFallback {
	/// Normalized.
	pub normalized:      String,
	/// Selection start.
	pub selection_start: usize,
	/// Selection end.
	pub selection_end:   usize,
	/// Insertion.
	pub insertion:       bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Selection pair data.
pub struct SelectionPair {
	/// Start.
	pub start:           usize,
	/// End.
	pub end:             usize,
	/// Capture indices.
	pub capture_indices: Vec<usize>,
	/// Line insertion.
	pub line_insertion:  bool,
	/// Old side is purely gap-captured (bare desired-text selection).
	pub gap_only:        bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Parsed pattern data.
pub struct ParsedPattern {
	/// Tokens.
	pub tokens:                   Vec<PatternToken>,
	/// Selection start.
	pub selection_start:          usize,
	/// Selection end.
	pub selection_end:            usize,
	/// Insertion.
	pub insertion:                bool,
	/// Line insertion.
	pub line_insertion:           bool,
	/// Selected capture indices.
	pub selected_capture_indices: Vec<usize>,
	/// Selection ranges.
	pub selection_ranges:         Vec<(usize, usize)>,
	/// Selection pairs.
	pub selection_pairs:          Vec<SelectionPair>,
	/// Literal fallback.
	pub literal_fallback:         Option<LiteralFallback>,
}

/// Whitespace/punctuation-normalized text with per-normalized-byte maps back
/// to source byte offsets (`starts[i]` = source start of normalized byte `i`,
/// `ends[i]` = source end).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedText {
	/// Text.
	pub text:   String,
	/// Starts.
	pub starts: Vec<usize>,
	/// Ends.
	pub ends:   Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Occurrence data.
pub struct Occurrence {
	/// Start.
	pub start:             usize,
	/// End.
	pub end:               usize,
	/// Distance.
	pub distance:          usize,
	/// Punctuation edits.
	pub punctuation_edits: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Candidate data.
pub struct Candidate {
	/// Start.
	pub start:           usize,
	/// End.
	pub end:             usize,
	/// Match start.
	pub match_start:     usize,
	/// Match end.
	pub match_end:       usize,
	/// Captures.
	pub captures:        Vec<String>,
	/// Selection spans.
	pub selection_spans: Vec<(usize, usize)>,
	/// Tuple.
	pub tuple:           Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Candidate result data.
pub struct CandidateResult {
	/// Candidates.
	pub candidates: Vec<Candidate>,
	/// Overflow.
	pub overflow:   bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Planned edit data.
pub struct PlannedEdit {
	/// Start.
	pub start:            usize,
	/// End.
	pub end:              usize,
	/// Replacement.
	pub replacement:      String,
	/// Operation number.
	pub operation_number: usize,
}
