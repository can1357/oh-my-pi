//! Incremental, deterministic, bounded recovery stages.

use std::fmt;

use bytes::Bytes;
use omp_core::Str;

/// Incremental sans-I/O transform used by every recovery component.
///
/// Implementations retain only incomplete input between calls and must resolve
/// that input deterministically from [`Stage::finish`].
pub trait Stage<I, O> {
	/// Consumes one input fragment and synchronously emits zero or more outputs.
	fn push(&mut self, input: I, emit: &mut dyn FnMut(O)) -> Result<(), RecoveryError>;

	/// Resolves held suffixes and emits terminal recovery output.
	fn finish(&mut self, emit: &mut dyn FnMut(O)) -> Result<(), RecoveryError>;
}

/// Secret-safe bounded context retained for a recovery failure.
///
/// `Debug` deliberately reports only lengths. Callers must explicitly request
/// the preview bytes, and receipts never store them.
#[derive(Clone, Eq, PartialEq)]
pub struct DiagnosticContext {
	preview:     Bytes,
	input_bytes: usize,
	truncated:   bool,
}

impl DiagnosticContext {
	/// Captures at most `limit` bytes from the beginning and end of `input`.
	pub fn capture(input: &[u8], limit: usize) -> Self {
		if input.len() <= limit {
			return Self {
				preview:     Bytes::copy_from_slice(input),
				input_bytes: input.len(),
				truncated:   false,
			};
		}
		let head = limit.div_ceil(2);
		let tail = limit.saturating_sub(head);
		let mut preview = Vec::with_capacity(limit);
		preview.extend_from_slice(&input[..head]);
		preview.extend_from_slice(&input[input.len() - tail..]);
		Self { preview: Bytes::from(preview), input_bytes: input.len(), truncated: true }
	}

	/// Borrows the explicitly bounded byte preview.
	pub fn preview(&self) -> &[u8] {
		&self.preview
	}

	/// Returns the complete input length without retaining the complete input.
	pub const fn input_bytes(&self) -> usize {
		self.input_bytes
	}

	/// Returns whether bytes were omitted between the retained ends.
	pub const fn is_truncated(&self) -> bool {
		self.truncated
	}
}

impl fmt::Debug for DiagnosticContext {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("DiagnosticContext")
			.field("preview_bytes", &self.preview.len())
			.field("input_bytes", &self.input_bytes)
			.field("truncated", &self.truncated)
			.finish()
	}
}

/// Typed failure from an incremental recovery stage.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RecoveryError {
	/// A deterministic resource bound was exceeded.
	#[error("{stage} recovery limit exceeded ({limit})")]
	LimitExceeded {
		/// Recovery stage which exceeded its resource bound.
		stage: &'static str,
		/// Enforced resource bound.
		limit: usize,
	},
	/// Input was complete but invalid for the stage contract.
	#[error("invalid {stage} recovery input: {reason}")]
	InvalidInput {
		/// Recovery stage which rejected the input.
		stage:  &'static str,
		/// Secret-safe structural reason.
		reason: Str,
	},
	/// Invalid input with an explicitly bounded byte diagnostic.
	#[error("invalid {stage} recovery document: {reason}")]
	InvalidDocument {
		/// Recovery stage which rejected the document.
		stage:      &'static str,
		/// Secret-safe structural reason.
		reason:     Str,
		/// Bounded context whose `Debug` output hides its bytes.
		diagnostic: DiagnosticContext,
	},
	/// End of input arrived while a required construct remained incomplete.
	#[error("incomplete {stage} recovery input")]
	Incomplete {
		/// Recovery stage with incomplete terminal input.
		stage: &'static str,
	},
	/// Recovery was available but forbidden by strict enforcement.
	#[error("{stage} repair rejected by strict enforcement")]
	RepairRejected {
		/// Recovery stage whose repair was rejected.
		stage:      &'static str,
		/// Bounded context whose `Debug` output hides its bytes.
		diagnostic: DiagnosticContext,
	},
}

pub mod dialect;
pub mod empty;
pub mod harmony;
pub mod json;
pub mod scanner;
pub mod thinking;

pub mod projection;
pub mod reasoning;
pub mod repetition;
pub mod tools;
