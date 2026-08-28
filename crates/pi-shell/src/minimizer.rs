//! Opt-in output minimizer for `Shell::run` / `execute_shell`.
//!
//! Compresses a shell command's stdout/stderr before it reaches the JS
//! caller.
//!
//! The engine is inert unless a [`MinimizerConfig`] explicitly opts in.

pub mod config;
pub mod detect;
pub mod engine;
pub mod filters;
pub mod primitives;

pub mod pipeline;

pub mod plan;

use std::borrow::Cow;

pub use config::{MinimizerConfig, MinimizerOptions};

/// Per-invocation context passed to every filter.
#[derive(Debug, Clone)]
pub struct MinimizerCtx<'a> {
	/// Resolved program name (lowercased, e.g. `"git"`).
	pub program:    &'a str,
	/// Detected subcommand (lowercased, e.g. `"status"`), if any.
	pub subcommand: Option<&'a str>,
	/// Raw command string as the caller supplied it.
	pub command:    &'a str,
	/// Effective configuration.
	pub config:     &'a MinimizerConfig,
}

/// Output produced by a filter.
#[derive(Debug, Clone)]
pub struct MinimizerOutput {
	/// Rewritten output.
	pub text:          String,
	/// Whether the filter modified the input at all.
	pub changed:       bool,
	/// Byte length of the captured buffer before minimization.
	pub input_bytes:   usize,
	/// Byte length of `text` after minimization.
	pub output_bytes:  usize,
	/// Label for the dispatch path that produced this output (e.g. `"git"`,
	/// `"pipeline:gradle"`, or `"passthrough"`). For non-rewrite misses, this
	/// carries the reason label (e.g. `"compound"`, `"piped"`, `"parse-error"`,
	/// `"too-short"`, `"too-large"`, `"disabled"`, `"unknown"`, `"unsupported"`,
	/// `"pipeline-noop"`).
	pub filter:        &'static str,
	/// Original (un-minimized) capture, surfaced only when the filter
	/// actually rewrote the output. The caller (JS session layer) is expected
	/// to persist this via its session-scoped `ArtifactManager` and splice an
	/// `artifact://<id>` reference into [`text`](Self::text) before
	/// presenting it to the agent. The minimizer itself does not hold onto
	/// the original past this struct.
	pub original_text: Option<String>,
}

impl MinimizerOutput {
	/// Pass-through constructor — the filter emits the original text unchanged.
	pub fn passthrough<'a>(text: impl Into<Cow<'a, str>>) -> Self {
		let text = text.into().into_owned();
		let bytes = text.len();
		Self {
			text,
			changed: false,
			input_bytes: bytes,
			output_bytes: bytes,
			filter: "passthrough",
			original_text: None,
		}
	}

	/// Transformed output. Caller-supplied `input_bytes` lets the savings
	/// metric compare pre- and post-filter sizes.
	#[must_use]
	pub const fn transformed(text: String, input_bytes: usize) -> Self {
		let output_bytes = text.len();
		Self { text, changed: true, input_bytes, output_bytes, filter: "", original_text: None }
	}

	/// Attach a `filter` label (e.g. `"git"`, `"pipeline:gradle"`) to an
	/// output for telemetry, including non-rewrite miss reasons.
	#[must_use]
	pub const fn labeled(mut self, filter: &'static str) -> Self {
		self.filter = filter;
		self
	}

	/// Record the original capture buffer on this output so the caller can
	/// persist it as a session artifact and surface an `artifact://<id>`
	/// reference in [`text`](Self::text). No-op on passthrough outputs.
	#[must_use]
	pub fn with_original(mut self, original: impl Into<String>) -> Self {
		if self.changed {
			self.original_text = Some(original.into());
		}
		self
	}

	/// Replace the transformed text while keeping minimization telemetry
	/// coherent.
	#[must_use]
	pub fn with_text(mut self, text: String) -> Self {
		self.output_bytes = text.len();
		self.text = text;
		self
	}

	/// Byte count saved by this filter (0 for passthrough).
	#[must_use]
	pub const fn bytes_saved(&self) -> usize {
		self.input_bytes.saturating_sub(self.output_bytes)
	}
}

/// Aggregate output for a segmented chain.
#[allow(
	clippy::missing_const_for_fn,
	reason = "kept non-const because this constructs owned output used only at runtime"
)]
pub(crate) fn chain_output(
	text: String,
	original_text: String,
	input_bytes: usize,
	changed: bool,
) -> MinimizerOutput {
	let filter = if changed { "chain" } else { "chain-noop" };
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed,
		input_bytes,
		output_bytes,
		filter,
		original_text: Some(original_text),
	}
}
/// Apply the configured filter pipeline to a captured buffer.
/// Returns the original text unchanged when minimization is disabled, no
/// filter matches, or a filter panics.
#[must_use]
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	engine::apply(command, captured, exit_code, config)
}
