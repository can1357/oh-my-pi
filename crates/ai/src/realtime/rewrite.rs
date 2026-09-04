//! Fence-aware enhanced-speech rewriting with bounded local-model fallback.

use std::{error, future::Future, mem, time::Duration};

use omp_audio::segmentation::normalize_speakable;
use omp_core::Str;
use thiserror::Error;
use tokio::time;

/// Stable instruction passed to the `@tiny` speech-rewrite role.
pub const SPEECH_REWRITE_PROMPT: &str =
	"Rewrite the text as concise natural spoken prose. Preserve facts, names, numbers, warnings, \
	 and intent. Remove Markdown scaffolding, code, tables, URLs, file paths, and tool syntax. \
	 Return only words to speak. Return an empty string when the block is not useful aloud.";

/// Why enhanced rewriting fell back to deterministic mechanical speech.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RewriteFallback {
	/// Rewriting was disabled for this call.
	Disabled,
	/// The local model exceeded its deadline.
	Timeout,
	/// The local model failed.
	Backend,
	/// The local model produced no speakable text.
	Unspeakable,
}

/// One enhanced-speech output block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewriteOutput {
	/// Speakable text, or `None` when the entire block is unspeakable.
	pub text:     Option<Str>,
	/// Mechanical-fallback reason; absent when `@tiny` supplied the output.
	pub fallback: Option<RewriteFallback>,
}

/// Typed backend failures may be logged by the composition boundary without
/// stringifying them in the voice domain.
#[derive(Debug, Error)]
pub enum SpeechRewriteError<E>
where
	E: error::Error + Send + Sync + 'static,
{
	/// The local rewrite backend failed.
	#[error("local speech rewrite failed")]
	Backend {
		/// Typed backend source.
		#[source]
		source: E,
	},
}

/// Unboxed local-model contract used by [`rewrite_for_speech`].
pub trait SpeechRewriteBackend {
	/// Typed inference failure.
	type Error: error::Error + Send + Sync + 'static;

	/// Runs the stable speech prompt against one complete prose block.
	fn rewrite(
		&mut self,
		instruction: &'static str,
		text: Str,
	) -> impl Future<Output = Result<Str, Self::Error>> + Send;
}

/// Rewrites one block through `@tiny`, with a deterministic bounded fallback.
pub async fn rewrite_for_speech<B: SpeechRewriteBackend>(
	backend: &mut B,
	text: &str,
	enhanced: bool,
	timeout: Duration,
) -> Result<RewriteOutput, SpeechRewriteError<B::Error>> {
	let mechanical = normalize_speakable(text);
	if mechanical.is_empty() {
		return Ok(RewriteOutput { text: None, fallback: Some(RewriteFallback::Unspeakable) });
	}
	if !enhanced {
		return Ok(RewriteOutput {
			text:     Some(Str::from(mechanical)),
			fallback: Some(RewriteFallback::Disabled),
		});
	}
	match time::timeout(timeout, backend.rewrite(SPEECH_REWRITE_PROMPT, Str::from(text.trim())))
		.await
	{
		Ok(Ok(rewritten)) => {
			let rewritten = normalize_speakable(rewritten.as_str());
			if rewritten.is_empty() {
				Ok(RewriteOutput {
					text:     Some(Str::from(mechanical)),
					fallback: Some(RewriteFallback::Unspeakable),
				})
			} else {
				Ok(RewriteOutput { text: Some(Str::from(rewritten)), fallback: None })
			}
		},
		Ok(Err(source)) => {
			let _typed = SpeechRewriteError::Backend { source };
			Ok(RewriteOutput {
				text:     Some(Str::from(mechanical)),
				fallback: Some(RewriteFallback::Backend),
			})
		},
		Err(_) => Ok(RewriteOutput {
			text:     Some(Str::from(mechanical)),
			fallback: Some(RewriteFallback::Timeout),
		}),
	}
}

/// Fence-aware block accumulator for streaming assistant output.
///
/// Paragraphs are emitted only outside code fences. Entire fenced blocks and
/// table rows are swallowed, so they never reach either the model or fallback.
#[derive(Debug, Default)]
pub struct RewriteBlockAccumulator {
	buffer: String,
	line:   String,
	fence:  Option<char>,
}

impl RewriteBlockAccumulator {
	/// Creates an empty accumulator.
	pub const fn new() -> Self {
		Self { buffer: String::new(), line: String::new(), fence: None }
	}

	/// Consumes a streamed text delta and returns complete prose blocks.
	pub fn push(&mut self, delta: &str) -> Vec<Str> {
		let mut output = Vec::new();
		for ch in delta.chars() {
			if ch == '\n' {
				self.finish_line(&mut output);
			} else {
				self.line.push(ch);
			}
		}
		output
	}

	/// Drains trailing prose at end-of-message.
	pub fn flush(&mut self) -> Vec<Str> {
		let mut output = Vec::new();
		if !self.line.is_empty() {
			self.finish_line(&mut output);
		}
		if self.fence.is_some() {
			self.buffer.clear();
		} else {
			self.emit_buffer(&mut output);
		}
		output
	}

	/// Drains a stalled partial prose block while preserving an open code
	/// fence. Half a fenced block is never sent to the rewrite backend.
	pub fn flush_partial(&mut self) -> Option<Str> {
		if self.fence.is_some() {
			return None;
		}
		let mut output = Vec::new();
		if !self.line.is_empty() {
			self.finish_line(&mut output);
		}
		self.emit_buffer(&mut output);
		if output.is_empty() {
			None
		} else {
			let mut joined = String::new();
			for block in output {
				if !joined.is_empty() {
					joined.push_str("\n\n");
				}
				joined.push_str(block.as_str());
			}
			Some(Str::new(joined))
		}
	}

	fn finish_line(&mut self, output: &mut Vec<Str>) {
		let line = mem::take(&mut self.line);
		let trimmed = line.trim_start();
		if let Some(marker) = fence_marker(trimmed) {
			if self.fence == Some(marker) {
				self.fence = None;
			} else if self.fence.is_none() {
				self.emit_buffer(output);
				self.fence = Some(marker);
			}
			return;
		}
		if self.fence.is_some() || trimmed.starts_with('|') || is_table_divider(trimmed) {
			return;
		}
		if trimmed.is_empty() {
			self.emit_buffer(output);
			return;
		}
		if !self.buffer.is_empty() {
			self.buffer.push(' ');
		}
		self.buffer.push_str(trimmed);
	}

	fn emit_buffer(&mut self, output: &mut Vec<Str>) {
		let block = self.buffer.trim();
		if !block.is_empty() {
			output.push(Str::from(block));
		}
		self.buffer.clear();
	}
}

fn fence_marker(line: &str) -> Option<char> {
	let marker = line.chars().next()?;
	matches!(marker, '`' | '~')
		.then(|| line.chars().take_while(|ch| *ch == marker).count())
		.filter(|length| *length >= 3)
		.map(|_| marker)
}

fn is_table_divider(line: &str) -> bool {
	let mut saw_dash = false;
	for ch in line.chars() {
		match ch {
			'-' => saw_dash = true,
			'|' | ':' | ' ' | '\t' => {},
			_ => return false,
		}
	}
	saw_dash
}

#[cfg(test)]
mod tests {
	use super::RewriteBlockAccumulator;

	#[test]
	fn stalled_partial_flushes_prose_and_keeps_fence_silent() {
		let mut blocks = RewriteBlockAccumulator::new();
		assert_eq!(blocks.flush_partial(), None);
		assert_eq!(blocks.push("A useful partial thought").len(), 0,);
		assert_eq!(blocks.flush_partial().as_deref(), Some("A useful partial thought"),);
		assert!(blocks.push("```rust\nsecret();").is_empty());
		assert_eq!(blocks.flush_partial(), None);
		assert!(blocks.push("\n```\nAfter fence").is_empty());
		assert_eq!(blocks.flush_partial().as_deref(), Some("After fence"));
	}

	#[test]
	fn final_flush_drops_an_unterminated_fence() {
		let mut blocks = RewriteBlockAccumulator::new();
		let ready = blocks.push("Before fence\n\n```text\nnever speak");
		assert_eq!(ready.len(), 1);
		assert_eq!(ready[0].as_str(), "Before fence");
		assert!(blocks.flush().is_empty());
	}
}
