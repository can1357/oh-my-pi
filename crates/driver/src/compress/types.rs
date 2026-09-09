//! Semantic-compression command and protocol records.

use std::path::PathBuf;

use omp_core::Str;

/// One declared loss in a submitted draft.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Loss {
	/// Dropped source content, quoted or described precisely.
	pub content: Str,
	/// Why the draft remains correct without it.
	pub reason:  Str,
}

/// One complete submitted draft.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Draft {
	/// One-based submission number.
	pub round:  u32,
	/// Complete replacement text.
	pub text:   Str,
	/// Every deliberate loss.
	pub losses: Vec<Loss>,
}

/// Source-versus-draft size measurements.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
	/// Source word count.
	pub source_words:  usize,
	/// Draft word count.
	pub draft_words:   usize,
	/// Estimated source token count.
	pub source_tokens: usize,
	/// Estimated draft token count.
	pub draft_tokens:  usize,
	/// Fractional token reduction; negative when the draft grew.
	pub ratio:         f64,
}

/// Terminal compression status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
	/// A separately reviewed draft was approved.
	Approved,
	/// Draft budget ended without approval.
	Unapproved,
	/// No draft or approval arrived in a turn.
	Stalled,
	/// Signal cancellation.
	Cancelled,
}

/// One file's observable result.
#[derive(Clone, Debug, PartialEq)]
pub struct FileResult {
	/// Absolute source path.
	pub path:        PathBuf,
	/// Terminal status.
	pub status:      Status,
	/// Newest draft.
	pub draft:       Option<Draft>,
	/// Source/draft size metrics.
	pub metrics:     Option<Metrics>,
	/// Approval verdict.
	pub verdict:     Option<Str>,
	/// Draft count.
	pub rounds:      u32,
	/// Destination path, absent for stdout.
	pub output_path: Option<PathBuf>,
	/// Per-file runtime error.
	pub error:       Option<Str>,
}

/// Aggregate command result.
#[derive(Clone, Debug, PartialEq)]
pub struct CompressExit {
	/// Zero only when every target was approved.
	pub code:          u8,
	/// Per-file outcomes in sorted target order.
	pub files:         Vec<FileResult>,
	/// Approved source token total.
	pub source_tokens: usize,
	/// Approved draft token total.
	pub draft_tokens:  usize,
}

/// User-facing standalone command options.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompressArgs {
	/// Literal files or glob patterns.
	pub files:       Vec<Str>,
	/// Model override; absent uses configured session model.
	pub model:       Option<Str>,
	/// Maximum drafts per file. Default: 3.
	pub rounds:      u32,
	/// Concurrent file children. Default: 4.
	pub concurrency: usize,
	/// Single-file destination.
	pub out:         Option<PathBuf>,
	/// Overwrite each source only after approval.
	pub in_place:    bool,
}

impl Default for CompressArgs {
	fn default() -> Self {
		Self {
			files:       Vec::new(),
			model:       None,
			rounds:      3,
			concurrency: 4,
			out:         None,
			in_place:    false,
		}
	}
}

/// Exactly one model tool action in a compression turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
	/// Submit a complete replacement plus every deliberate loss.
	Rewrite {
		/// Complete draft.
		text:   Str,
		/// Declared losses.
		losses: Vec<Loss>,
	},
	/// Accept the newest separately reviewed draft.
	Approve {
		/// Why the draft is shippable.
		verdict: Str,
	},
}
