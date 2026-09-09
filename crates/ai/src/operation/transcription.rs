//! Replay-aware transcription and translation validation plus event accounting.

use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll},
};

use futures::StreamExt;
use omp_core::Str;
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, TranscriptEvent, TranscriptStream},
	body::{AttemptBodyEvidence, ReplayEvidence, RetryDecision, RetryDecisionReason},
	call::{Call, MediaInput, OperationCall, Setting, TimestampGranularity, TranscriptionRequest},
	catalog::OperationKind,
	error::Error,
	operation::{
		MediaOperationError, OperationRequest, OperationResponse, media_protocol_error,
		media_validation_error, wrong_operation,
	},
};

/// Transcription feature and media bounds supplied by capability negotiation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptionLimits {
	/// Accepted input media types.
	pub media_types:      Box<[Str]>,
	/// Maximum inline immutable input size.
	pub max_inline_bytes: u64,
	/// Whether translation to English is supported.
	pub translation:      bool,
	/// Whether caller language hints are supported.
	pub language_hints:   bool,
	/// Whether speaker diarization is supported.
	pub diarization:      bool,
	/// Finest supported timestamp granularity.
	pub timestamps:       TimestampGranularity,
}

/// Typed transcription validation or stream failure.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TranscriptionError {
	/// Input media type is not accepted.
	#[error("transcription media type {media_type} is unsupported")]
	MediaType {
		/// Unsupported media type.
		media_type: Str,
	},
	/// Inline immutable input exceeds its bound.
	#[error("transcription input contains {observed} bytes, but the maximum is {limit}")]
	InputTooLarge {
		/// Configured maximum inline byte count.
		limit:    u64,
		/// Actual inline byte count supplied by the request.
		observed: u64,
	},
	/// Translation was required but is unsupported.
	#[error("transcription translation is unsupported")]
	TranslationUnsupported,
	/// A language hint was supplied but is unsupported.
	#[error("transcription language hints are unsupported")]
	LanguageHintUnsupported,
	/// Speaker diarization was required but is unsupported.
	#[error("transcription speaker diarization is unsupported")]
	DiarizationUnsupported,
	/// Required timestamp granularity is unsupported.
	#[error("transcription timestamp granularity is unsupported")]
	TimestampsUnsupported,
	/// Transcript did not begin with a Started event.
	#[error("transcript did not begin with a start event")]
	MissingStart,
	/// An event arrived after completion.
	#[error("transcript event arrived after completion")]
	AfterCompletion,
	/// Segment or word timestamps are inverted or moved backwards.
	#[error("transcript timestamp interval is invalid")]
	InvalidTimestamp,
	/// Segment index did not increase monotonically.
	#[error("transcript segment index is not monotonic")]
	SegmentOrder,
	/// Completed text disagrees with finalized segment text.
	#[error("transcript completion disagrees with finalized segments")]
	CompletionMismatch,
}

/// Validates immutable transcription input and explicit feature requirements.
pub fn validate_request(
	request: &TranscriptionRequest,
	limits: &TranscriptionLimits,
) -> Result<(), TranscriptionError> {
	match &request.audio {
		MediaInput::Bytes { media_type, data } => {
			validate_media_type(media_type, limits)?;
			if data.len() as u64 > limits.max_inline_bytes {
				return Err(TranscriptionError::InputTooLarge {
					limit:    limits.max_inline_bytes,
					observed: data.len() as u64,
				});
			}
		},
		MediaInput::Body { media_type, .. } => validate_media_type(media_type, limits)?,
		MediaInput::Remote { media_type: Some(media_type), .. } => {
			validate_media_type(media_type, limits)?;
		},
		MediaInput::Stored(_) | MediaInput::Remote { media_type: None, .. } => {},
	}
	if request.translate_to_english && !limits.translation {
		return Err(TranscriptionError::TranslationUnsupported);
	}
	if request.language.is_some() && !limits.language_hints {
		return Err(TranscriptionError::LanguageHintUnsupported);
	}
	if matches!(&request.diarization, Setting::Require(true)) && !limits.diarization {
		return Err(TranscriptionError::DiarizationUnsupported);
	}
	if let Setting::Require(requested) = &request.timestamps
		&& timestamp_rank(*requested) > timestamp_rank(limits.timestamps)
	{
		return Err(TranscriptionError::TimestampsUnsupported);
	}
	Ok(())
}

const fn timestamp_rank(value: TimestampGranularity) -> u8 {
	match value {
		TimestampGranularity::None => 0,
		TimestampGranularity::Segment => 1,
		TimestampGranularity::Word => 2,
	}
}

const HASH_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const HASH_PRIME: u64 = 0x0000_0100_0000_01b3;

fn hash_bytes(state: &mut u64, bytes: &[u8]) {
	for byte in bytes {
		*state = (*state ^ u64::from(*byte)).wrapping_mul(HASH_PRIME);
	}
}

fn hash_value(bytes: &[u8]) -> u64 {
	let mut state = HASH_OFFSET;
	hash_bytes(&mut state, bytes);
	state
}

fn validate_media_type(
	media_type: &Str,
	limits: &TranscriptionLimits,
) -> Result<(), TranscriptionError> {
	if !limits.media_types.is_empty() && !limits.media_types.contains(media_type) {
		return Err(TranscriptionError::MediaType { media_type: media_type.clone() });
	}
	Ok(())
}

/// Returns replay evidence for streamed audio, or `None` for immutable media
/// references.
pub fn request_replay_evidence(request: &TranscriptionRequest) -> Option<ReplayEvidence> {
	match &request.audio {
		MediaInput::Body { body, .. } => Some(body.replay_evidence()),
		MediaInput::Bytes { .. } | MediaInput::Stored(_) | MediaInput::Remote { .. } => None,
	}
}

/// Returns exact shared-body retry evidence; consumed one-shot audio is always
/// suppressed.
pub const fn retry_evidence(evidence: AttemptBodyEvidence) -> TranscriptionRetryEvidence {
	TranscriptionRetryEvidence {
		allowed:  matches!(evidence.retry_decision, RetryDecision::Allow),
		opened:   evidence.opened,
		consumed: evidence.consumed,
		reason:   evidence.reason,
	}
}

/// Typed operation receipt for retry or fallback eligibility.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TranscriptionRetryEvidence {
	/// Whether another automatic attempt may acquire audio.
	pub allowed:  bool,
	/// Whether the failed attempt opened its input.
	pub opened:   bool,
	/// Whether the failed attempt polled an input frame.
	pub consumed: bool,
	/// Shared typed reason for allowing or suppressing retry.
	pub reason:   RetryDecisionReason,
}

/// Incremental transcript verifier retaining only bounded counters and a
/// rolling text hash.
#[derive(Debug)]
pub struct TranscriptState {
	started:             bool,
	completed:           bool,
	last_segment:        Option<u32>,
	last_segment_end_ms: u64,
	last_word_end_ms:    u64,
	final_hash:          u64,
	final_len:           u64,
	words:               u64,
}

impl Default for TranscriptState {
	fn default() -> Self {
		Self {
			started:             false,
			completed:           false,
			last_segment:        None,
			last_segment_end_ms: 0,
			last_word_end_ms:    0,
			final_hash:          HASH_OFFSET,
			final_len:           0,
			words:               0,
		}
	}
}

impl TranscriptState {
	/// Observes one transcript event before it is published.
	pub fn observe(&mut self, event: &TranscriptEvent) -> Result<(), TranscriptionError> {
		if self.completed {
			return Err(TranscriptionError::AfterCompletion);
		}
		if !self.started && !matches!(event, TranscriptEvent::Started { .. }) {
			return Err(TranscriptionError::MissingStart);
		}
		match event {
			TranscriptEvent::Started { .. } => {
				if self.started {
					return Err(TranscriptionError::MissingStart);
				}
				self.started = true;
			},
			TranscriptEvent::TextDelta { .. } => {},
			TranscriptEvent::Segment { index, text, start_ms, end_ms, .. } => {
				validate_time(&mut self.last_segment_end_ms, *start_ms, *end_ms)?;
				if self.last_segment.is_some_and(|previous| *index <= previous) {
					return Err(TranscriptionError::SegmentOrder);
				}
				if self.final_len != 0 {
					hash_bytes(&mut self.final_hash, b" ");
					self.final_len = self.final_len.saturating_add(1);
				}
				hash_bytes(&mut self.final_hash, text.as_bytes());
				self.final_len = self.final_len.saturating_add(text.len() as u64);
				self.last_segment = Some(*index);
			},
			TranscriptEvent::Word { start_ms, end_ms, .. } => {
				validate_time(&mut self.last_word_end_ms, *start_ms, *end_ms)?;
				self.words = self.words.saturating_add(1);
			},
			TranscriptEvent::Completed { text, .. } => {
				if self.final_len != 0
					&& (text.len() as u64 != self.final_len
						|| hash_value(text.as_bytes()) != self.final_hash)
				{
					return Err(TranscriptionError::CompletionMismatch);
				}
				self.completed = true;
			},
		}
		Ok(())
	}

	/// Returns a clean completion receipt.
	pub fn finish(&self) -> Result<TranscriptReceipt, TranscriptionError> {
		if !self.started {
			return Err(TranscriptionError::MissingStart);
		}
		if !self.completed {
			return Err(TranscriptionError::CompletionMismatch);
		}
		Ok(TranscriptReceipt {
			segments: self.last_segment.map_or(0, |index| index.saturating_add(1)),
			words:    self.words,
			end_ms:   self.last_segment_end_ms.max(self.last_word_end_ms),
		})
	}
}

const fn validate_time(
	previous_end: &mut u64,
	start: u64,
	end: u64,
) -> Result<(), TranscriptionError> {
	if start > end || start < *previous_end {
		return Err(TranscriptionError::InvalidTimestamp);
	}
	*previous_end = end;
	Ok(())
}

/// Typed transcript completion accounting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TranscriptReceipt {
	/// Final segment count.
	pub segments: u32,
	/// Final timestamped word count.
	pub words:    u64,
	/// Last finalized timestamp.
	pub end_ms:   u64,
}

/// Concrete transcription operation service over a constructed streaming
/// backend.
#[derive(Clone, Debug)]
pub struct TranscriptionService<S> {
	inner:  S,
	limits: TranscriptionLimits,
}

impl<S> TranscriptionService<S> {
	/// Wraps a route backend with media and transcript-event validation.
	pub const fn new(inner: S, limits: TranscriptionLimits) -> Self {
		Self { inner, limits }
	}
}

impl<S> Service<Call> for TranscriptionService<S>
where
	S: Service<
			OperationRequest<TranscriptionRequest>,
			Response = OperationResponse<TranscriptStream>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::Transcribe(request) => Some(Arc::clone(request)),
			_ => None,
		};
		let validation = request
			.as_ref()
			.map(|request| validate_request(request, &self.limits));
		let pending = request
			.as_ref()
			.filter(|_| validation.as_ref().is_some_and(Result::is_ok))
			.map(|request| {
				self
					.inner
					.call(OperationRequest::from_call(&call, Arc::clone(request)))
			});
		async move {
			if request.is_none() {
				return Err(wrong_operation(&call, OperationKind::Transcribe));
			}
			if let Some(Err(error)) = validation {
				return Err(media_validation_error(OperationKind::Transcribe, error));
			}
			let response = pending
				.ok_or_else(|| {
					media_validation_error(
						OperationKind::Transcribe,
						MediaOperationError::TranscriptionRequestNotDispatched,
					)
				})?
				.await?;
			let mut state = TranscriptState::default();
			Ok(response
				.map(move |mut output| {
					let stream = async_stream::stream! {
						while let Some(event) = output.next().await {
							match event.and_then(|event| {
								state.observe(&event).map_err(|error| {
									media_protocol_error(OperationKind::Transcribe, error)
								})?;
								Ok(event)
							}) {
								Ok(event) => yield Ok(event),
								Err(error) => { yield Err(error); return; }
							}
						}
						if let Err(error) = state.finish() {
							yield Err(media_protocol_error(OperationKind::Transcribe, error));
						}
					};
					Box::pin(stream) as TranscriptStream
				})
				.into_answer(AnswerBody::Transcript))
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::body::{Replayability, RetryDecisionReason};

	#[test]
	fn consumed_one_shot_is_suppressed() {
		let evidence = AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		};
		assert_eq!(retry_evidence(evidence), TranscriptionRetryEvidence {
			allowed:  false,
			opened:   true,
			consumed: true,
			reason:   RetryDecisionReason::ConsumedOneShot,
		});
	}

	#[test]
	fn transcript_without_terminal_event_is_rejected() {
		let mut state = TranscriptState::default();
		state
			.observe(&TranscriptEvent::Started { language: None })
			.unwrap();
		assert_eq!(state.finish(), Err(TranscriptionError::CompletionMismatch));
	}
}
