//! Streamed speech validation and timestamp accounting.

use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll},
};

use futures::StreamExt;
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, AudioChunk, AudioStream},
	call::{AudioFormat, Call, OperationCall, Setting, SpeechRequest, TimestampGranularity},
	catalog::OperationKind,
	error::Error,
	operation::{
		MediaOperationError, OperationRequest, OperationResponse, media_protocol_error,
		media_validation_error, wrong_operation,
	},
};
/// Speech capability bounds used during request validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpeechLimits {
	/// Accepted output encodings.
	pub formats:              Box<[AudioFormat]>,
	/// Accepted sample rates.
	pub sample_rates_hz:      Box<[u32]>,
	/// Minimum playback-speed multiplier in millionths.
	pub min_speed_millionths: u32,
	/// Maximum playback-speed multiplier in millionths.
	pub max_speed_millionths: u32,
	/// Whether audio timestamps are supported.
	pub timestamps:           bool,
	/// Maximum transport chunk size.
	pub max_chunk_bytes:      usize,
}

/// Typed request or streamed-audio violation.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum SpeechError {
	/// Input text is empty.
	#[error("speech input text is empty")]
	EmptyText,
	/// Voice identity is empty.
	#[error("speech voice identity is empty")]
	EmptyVoice,
	/// Explicit format is unsupported.
	#[error("speech audio format {format:?} is unsupported")]
	Format {
		/// Unsupported audio format.
		format: AudioFormat,
	},
	/// Explicit sample rate is unsupported.
	#[error("speech sample rate {sample_rate} Hz is unsupported")]
	SampleRate {
		/// Unsupported sample rate.
		sample_rate: u32,
	},
	/// Playback speed is not finite, positive, or inside negotiated bounds.
	#[error("speech playback speed {speed} is unsupported")]
	Speed {
		/// Unsupported playback-speed multiplier.
		speed: f32,
	},
	/// Timestamps were explicitly requested but unavailable.
	#[error("speech timestamps are unsupported")]
	TimestampsUnsupported,
	/// A chunk exceeded the negotiated maximum size.
	#[error("speech chunk contains {observed} bytes, but the maximum is {limit}")]
	ChunkTooLarge {
		/// Negotiated maximum chunk size in bytes.
		limit:    usize,
		/// Received chunk size in bytes.
		observed: usize,
	},
	/// Timestamp interval is inverted or moved backwards.
	#[error("speech timestamp interval is invalid")]
	InvalidTimestamp,
	/// A non-final chunk arrived after the final chunk.
	#[error("speech chunk arrived after the final chunk")]
	AfterFinal,
	/// Stream ended without an explicit final chunk.
	#[error("speech stream ended without a final chunk")]
	MissingFinalChunk,
}

/// Validates speech settings without changing caller intent.
pub fn validate_request(request: &SpeechRequest, limits: &SpeechLimits) -> Result<(), SpeechError> {
	if request.text.trim().is_empty() {
		return Err(SpeechError::EmptyText);
	}
	if request.voice.trim().is_empty() {
		return Err(SpeechError::EmptyVoice);
	}
	if let Setting::Prefer(format) | Setting::Require(format) = &request.format
		&& !limits.formats.contains(format)
	{
		return Err(SpeechError::Format { format: *format });
	}
	if let Setting::Prefer(rate) | Setting::Require(rate) = &request.sample_rate_hz
		&& !limits.sample_rates_hz.contains(rate)
	{
		return Err(SpeechError::SampleRate { sample_rate: *rate });
	}
	if let Setting::Prefer(speed) | Setting::Require(speed) = &request.speed {
		let scaled = *speed * 1_000_000.0;
		if !speed.is_finite()
			|| *speed <= 0.0
			|| scaled < limits.min_speed_millionths as f32
			|| scaled > limits.max_speed_millionths as f32
		{
			return Err(SpeechError::Speed { speed: *speed });
		}
	}
	if let Setting::Require(granularity) = &request.timestamps
		&& *granularity != TimestampGranularity::None
		&& !limits.timestamps
	{
		return Err(SpeechError::TimestampsUnsupported);
	}
	Ok(())
}

/// Incremental audio verifier that forwards chunks without buffering them.
#[derive(Clone, Debug)]
pub struct SpeechStreamState {
	max_chunk_bytes: usize,
	last_end_ms:     Option<u64>,
	final_seen:      bool,
	chunks:          u64,
	bytes:           u64,
}

impl SpeechStreamState {
	/// Creates bounded stream accounting.
	pub const fn new(max_chunk_bytes: usize) -> Self {
		Self { max_chunk_bytes, last_end_ms: None, final_seen: false, chunks: 0, bytes: 0 }
	}

	/// Validates and accounts for one chunk before it is published.
	pub fn observe(&mut self, chunk: &AudioChunk) -> Result<(), SpeechError> {
		if self.final_seen {
			return Err(SpeechError::AfterFinal);
		}
		if chunk.bytes.len() > self.max_chunk_bytes {
			return Err(SpeechError::ChunkTooLarge {
				limit:    self.max_chunk_bytes,
				observed: chunk.bytes.len(),
			});
		}
		if let (Some(start), Some(end)) = (chunk.start_ms, chunk.end_ms)
			&& (start > end || self.last_end_ms.is_some_and(|previous| start < previous))
		{
			return Err(SpeechError::InvalidTimestamp);
		}
		if chunk.start_ms.is_some() != chunk.end_ms.is_some() {
			return Err(SpeechError::InvalidTimestamp);
		}
		self.last_end_ms = chunk.end_ms.or(self.last_end_ms);
		self.chunks = self.chunks.saturating_add(1);
		self.bytes = self.bytes.saturating_add(chunk.bytes.len() as u64);
		self.final_seen = chunk.final_chunk;
		Ok(())
	}

	/// Confirms the stream ended with an explicit final chunk.
	pub const fn finish(&self) -> Result<SpeechStreamReceipt, SpeechError> {
		if !self.final_seen {
			return Err(SpeechError::MissingFinalChunk);
		}
		Ok(SpeechStreamReceipt {
			chunks:      self.chunks,
			bytes:       self.bytes,
			duration_ms: self.last_end_ms,
		})
	}
}

/// Typed accounting produced at clean audio stream completion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpeechStreamReceipt {
	/// Number of chunks published.
	pub chunks:      u64,
	/// Number of encoded bytes published.
	pub bytes:       u64,
	/// Last timestamp when timestamps were available.
	pub duration_ms: Option<u64>,
}

/// Concrete speech operation service over a constructed streaming backend.
#[derive(Clone, Debug)]
pub struct SpeechService<S> {
	inner:  S,
	limits: SpeechLimits,
}

impl<S> SpeechService<S> {
	/// Wraps a route backend with speech request and chunk validation.
	pub const fn new(inner: S, limits: SpeechLimits) -> Self {
		Self { inner, limits }
	}
}

impl<S> Service<Call> for SpeechService<S>
where
	S: Service<
			OperationRequest<SpeechRequest>,
			Response = OperationResponse<AudioStream>,
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
			OperationCall::Speak(request) => Some(Arc::clone(request)),
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
		let max_chunk_bytes = self.limits.max_chunk_bytes;
		async move {
			if request.is_none() {
				return Err(wrong_operation(&call, OperationKind::Speak));
			}
			if let Some(Err(error)) = validation {
				return Err(media_validation_error(OperationKind::Speak, error));
			}
			let response = pending
				.ok_or_else(|| {
					media_validation_error(
						OperationKind::Speak,
						MediaOperationError::SpeechRequestNotDispatched,
					)
				})?
				.await?;
			let mut state = SpeechStreamState::new(max_chunk_bytes);
			Ok(response
				.map(move |mut output| {
					let stream = async_stream::stream! {
						while let Some(chunk) = output.next().await {
							match chunk.and_then(|chunk| {
								state.observe(&chunk).map_err(|error| {
									media_protocol_error(OperationKind::Speak, error)
								})?;
								Ok(chunk)
							}) {
								Ok(chunk) => yield Ok(chunk),
								Err(error) => { yield Err(error); return; }
							}
						}
						if let Err(error) = state.finish() {
							yield Err(media_protocol_error(OperationKind::Speak, error));
						}
					};
					Box::pin(stream) as AudioStream
				})
				.into_answer(AnswerBody::Speech))
		}
	}
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;

	use super::*;

	#[test]
	fn validates_timestamped_stream_without_aggregation() {
		let mut state = SpeechStreamState::new(4);
		state
			.observe(&AudioChunk {
				bytes:       Bytes::from_static(b"12"),
				start_ms:    Some(0),
				end_ms:      Some(10),
				final_chunk: false,
			})
			.unwrap();
		state
			.observe(&AudioChunk {
				bytes:       Bytes::from_static(b"34"),
				start_ms:    Some(10),
				end_ms:      Some(20),
				final_chunk: true,
			})
			.unwrap();
		assert_eq!(state.finish().unwrap(), SpeechStreamReceipt {
			chunks:      2,
			bytes:       4,
			duration_ms: Some(20),
		});
	}

	#[test]
	fn stream_without_final_chunk_is_rejected() {
		let mut state = SpeechStreamState::new(4);
		state
			.observe(&AudioChunk {
				bytes:       Bytes::from_static(b"12"),
				start_ms:    None,
				end_ms:      None,
				final_chunk: false,
			})
			.unwrap();
		assert_eq!(state.finish(), Err(SpeechError::MissingFinalChunk));
	}
}
