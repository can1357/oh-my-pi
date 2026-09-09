//! Asynchronous video submission, polling, resume, cancellation, and download
//! contracts.

use std::{
	future::Future,
	mem,
	sync::Arc,
	task::{Context, Poll},
	time::SystemTime,
};

use futures::StreamExt;
use omp_core::{Str, sf};
use tower::Service;

use super::{
	artifact::{ArtifactLimits, ArtifactViolation, validate_artifact},
	job::{JobAction, JobCheckpoint, JobController, JobError, JobPolicy, JobRef, JobUpdate},
};
use crate::{
	answer::{
		Answer, AnswerBody, GenerationEvent, GenerationSession, GenerationStream, VideoArtifact,
	},
	body::ReplayEvidence,
	call::{Call, MediaInput, OperationCall, Setting, VideoRequest},
	catalog::OperationKind,
	error::Error,
	operation::{
		MediaOperationError, OperationRequest, OperationResponse, media_protocol_error,
		media_validation_error, wrong_operation,
	},
};

/// Bounded video-operation limits supplied by capability negotiation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VideoLimits {
	/// Maximum requested duration.
	pub max_duration_ms:       u64,
	/// Maximum requested pixels per frame.
	pub max_pixels:            u64,
	/// Maximum requested frame rate.
	pub max_frames_per_second: u32,
	/// Maximum inline reference-image bytes.
	pub max_reference_bytes:   u64,
}

/// Typed video request or output failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum VideoError {
	/// Prompt contains no non-whitespace content.
	#[error("video prompt is empty")]
	EmptyPrompt,
	/// Duration is zero or exceeds the capability bound.
	#[error("video duration {requested_ms} ms exceeds the {maximum_ms} ms limit")]
	Duration {
		/// Requested duration.
		requested_ms: u64,
		/// Capability duration limit.
		maximum_ms:   u64,
	},
	/// Dimensions are zero or exceed the capability bound.
	#[error("video dimensions {width}x{height} exceed the {maximum_pixels}-pixel limit")]
	Dimensions {
		/// Requested frame width.
		width:          u32,
		/// Requested frame height.
		height:         u32,
		/// Capability pixel limit.
		maximum_pixels: u64,
	},
	/// Frame rate is zero or exceeds the capability bound.
	#[error("video frame rate {requested} exceeds the {maximum} fps limit")]
	FrameRate {
		/// Requested frames per second.
		requested: u32,
		/// Capability frame-rate limit.
		maximum:   u32,
	},
	/// Reference image media type is unsupported.
	#[error("video reference media type {media_type} is unsupported")]
	ReferenceType {
		/// Unsupported media type.
		media_type: Str,
	},
	/// Inline reference image exceeds the request bound.
	#[error("video reference contains {observed} bytes, but the maximum is {limit}")]
	ReferenceTooLarge {
		/// Inline reference size limit.
		limit:    u64,
		/// Observed inline reference size.
		observed: u64,
	},
	/// Artifact metadata or streaming representation is invalid.
	#[error("video artifact violates the output contract")]
	Artifact(ArtifactViolation),
	/// Returned duration is zero.
	#[error("generated video duration is zero")]
	InvalidArtifactDuration,
	/// Generation event stream ended before explicit completion.
	#[error("video stream ended before completion")]
	MissingCompletion,
	/// Shared polling state rejected a transition.
	#[error("video polling state rejected a transition")]
	Job(JobError),
}

impl From<JobError> for VideoError {
	fn from(value: JobError) -> Self {
		Self::Job(value)
	}
}

impl From<ArtifactViolation> for VideoError {
	fn from(value: ArtifactViolation) -> Self {
		Self::Artifact(value)
	}
}

/// Validates video input before submission.
pub fn validate_request(request: &VideoRequest, limits: VideoLimits) -> Result<(), VideoError> {
	if request.prompt.trim().is_empty() {
		return Err(VideoError::EmptyPrompt);
	}
	if let Setting::Prefer(duration) | Setting::Require(duration) = &request.duration_ms
		&& (*duration == 0 || *duration > limits.max_duration_ms)
	{
		return Err(VideoError::Duration {
			requested_ms: *duration,
			maximum_ms:   limits.max_duration_ms,
		});
	}
	if let Setting::Prefer(dimensions) | Setting::Require(dimensions) = &request.dimensions {
		let pixels = u64::from(dimensions.width).saturating_mul(u64::from(dimensions.height));
		if dimensions.width == 0 || dimensions.height == 0 || pixels > limits.max_pixels {
			return Err(VideoError::Dimensions {
				width:          dimensions.width,
				height:         dimensions.height,
				maximum_pixels: limits.max_pixels,
			});
		}
	}
	if let Setting::Prefer(rate) | Setting::Require(rate) = &request.frames_per_second
		&& (*rate == 0 || *rate > limits.max_frames_per_second)
	{
		return Err(VideoError::FrameRate {
			requested: *rate,
			maximum:   limits.max_frames_per_second,
		});
	}
	if let Some(reference) = &request.reference {
		let (media_type, bytes) = match reference {
			MediaInput::Bytes { media_type, data } => (Some(media_type), data.len() as u64),
			MediaInput::Body { media_type, .. } => (Some(media_type), 0),
			MediaInput::Remote { media_type, .. } => (media_type.as_ref(), 0),
			MediaInput::Stored(_) => (None, 0),
		};
		if let Some(media_type) = media_type
			&& !matches!(media_type.as_str(), "image/png" | "image/jpeg" | "image/webp")
		{
			return Err(VideoError::ReferenceType { media_type: media_type.clone() });
		}
		if bytes > limits.max_reference_bytes {
			return Err(VideoError::ReferenceTooLarge {
				limit:    limits.max_reference_bytes,
				observed: bytes,
			});
		}
	}
	Ok(())
}

/// Returns replay evidence when the starting image is a streamed body.
pub fn request_replay_evidence(request: &VideoRequest) -> Option<ReplayEvidence> {
	match &request.reference {
		Some(MediaInput::Body { body, .. }) => Some(body.replay_evidence()),
		Some(MediaInput::Bytes { .. } | MediaInput::Stored(_) | MediaInput::Remote { .. }) | None => {
			None
		},
	}
}

/// Provider-neutral lifecycle for one submitted or resumed video job.
#[derive(Debug)]
pub struct VideoJob {
	controller: JobController,
}

impl VideoJob {
	/// Starts lifecycle tracking after submit returns a typed handle.
	pub fn submitted(
		job: JobRef,
		policy: JobPolicy,
		now: SystemTime,
		expires_at: Option<SystemTime>,
	) -> Self {
		Self { controller: JobController::submitted(job, policy, now, expires_at) }
	}

	/// Resumes from an explicit checkpoint; no submission is repeated.
	pub fn resume(
		checkpoint: JobCheckpoint,
		policy: JobPolicy,
		now: SystemTime,
	) -> Result<Self, VideoError> {
		Ok(Self { controller: JobController::resume(checkpoint, policy, now)? })
	}

	/// Requests a single provider cancellation dispatch.
	pub fn request_cancel(&mut self) -> Result<(), VideoError> {
		self.controller.request_cancel().map_err(Into::into)
	}

	/// Applies a typed poll update and chooses poll, download, cancellation, or
	/// completion.
	pub fn update<A>(
		&mut self,
		update: JobUpdate<A>,
		now: SystemTime,
	) -> Result<JobAction<A>, VideoError> {
		self.controller.update(update, now).map_err(Into::into)
	}

	/// Exports resumable state without performing I/O.
	pub fn checkpoint(&self) -> JobCheckpoint {
		self.controller.checkpoint()
	}

	/// Validates a downloaded final video before publishing it.
	pub fn validate_download(
		artifact: &VideoArtifact,
		limits: &ArtifactLimits,
	) -> Result<(), VideoError> {
		if artifact.duration_ms == 0 {
			return Err(VideoError::InvalidArtifactDuration);
		}
		validate_artifact(&artifact.artifact, limits).map_err(Into::into)
	}
}

/// Verifies ordered video generation events without retaining media payloads.
#[derive(Debug, Default)]
pub struct VideoProgress {
	completed: u64,
	total:     Option<u64>,
	artifacts: u32,
	finished:  bool,
}

impl VideoProgress {
	/// Validates one video event and its final artifact.
	pub fn observe(
		&mut self,
		event: &GenerationEvent<VideoArtifact>,
		limits: &ArtifactLimits,
	) -> Result<(), VideoError> {
		if self.finished {
			return Err(VideoError::Job(JobError::AlreadyTerminal));
		}
		match event {
			GenerationEvent::Progress { completed, total } => {
				if *completed < self.completed
					|| self.total.is_some_and(|known| *total != Some(known))
					|| total.is_some_and(|total| *completed > total)
				{
					return Err(VideoError::Job(JobError::NonMonotonicProgress));
				}
				self.completed = *completed;
				self.total = total.or(self.total);
			},
			GenerationEvent::Artifact(artifact) => {
				VideoJob::validate_download(artifact, limits)?;
				self.artifacts = self.artifacts.saturating_add(1);
			},
			GenerationEvent::Completed(summary) => {
				if summary.artifacts != self.artifacts {
					return Err(VideoError::Job(JobError::Provider {
						code:    sf!("artifact_count_mismatch"),
						message: sf!("completion artifact count differs from streamed artifacts",),
					}));
				}
				self.finished = true;
			},
			GenerationEvent::Queued { .. } | GenerationEvent::Preview(_) => {},
		}
		Ok(())
	}

	/// Confirms the provider emitted an explicit completion event.
	pub const fn finish(&self) -> Result<(), VideoError> {
		if self.finished {
			Ok(())
		} else {
			Err(VideoError::MissingCompletion)
		}
	}
}

/// Concrete video operation service over a constructed asynchronous-job
/// backend.
#[derive(Clone, Debug)]
pub struct VideoService<S> {
	inner:           S,
	limits:          VideoLimits,
	artifact_limits: ArtifactLimits,
}

impl<S> VideoService<S> {
	/// Wraps a route backend with request, polling-event, and download
	/// validation.
	pub const fn new(inner: S, limits: VideoLimits, artifact_limits: ArtifactLimits) -> Self {
		Self { inner, limits, artifact_limits }
	}
}

impl<S> Service<Call> for VideoService<S>
where
	S: Service<
			OperationRequest<VideoRequest>,
			Response = OperationResponse<GenerationSession<VideoArtifact>>,
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
			OperationCall::GenerateVideo(request) => Some(Arc::clone(request)),
			_ => None,
		};
		let validation = request
			.as_ref()
			.map(|request| validate_request(request, self.limits));
		let pending = request
			.as_ref()
			.filter(|_| validation.as_ref().is_some_and(Result::is_ok))
			.map(|request| {
				self
					.inner
					.call(OperationRequest::from_call(&call, Arc::clone(request)))
			});
		let artifact_limits = self.artifact_limits.clone();
		async move {
			if request.is_none() {
				return Err(wrong_operation(&call, OperationKind::GenerateVideo));
			}
			if let Some(Err(error)) = validation {
				return Err(media_validation_error(OperationKind::GenerateVideo, error));
			}
			let response = pending
				.ok_or_else(|| {
					media_validation_error(
						OperationKind::GenerateVideo,
						MediaOperationError::VideoRequestNotDispatched,
					)
				})?
				.await?;
			let mut progress = VideoProgress::default();
			Ok(response
				.map(move |mut session| {
					let mut output =
						mem::replace(session.events_mut(), Box::pin(futures::stream::empty()));
					let stream = async_stream::stream! {
						while let Some(event) = output.next().await {
							match event.and_then(|event| {
								progress.observe(&event, &artifact_limits).map_err(|error| {
									media_protocol_error(OperationKind::GenerateVideo, error)
								})?;
								Ok(event)
							}) {
								Ok(event) => yield Ok(event),
								Err(error) => { yield Err(error); return; }
							}
						}
						if let Err(error) = progress.finish() {
							yield Err(media_protocol_error(OperationKind::GenerateVideo, error));
						}
					};
					*session.events_mut() = Box::pin(stream) as GenerationStream<VideoArtifact>;
					session
				})
				.into_answer(AnswerBody::Video))
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use super::*;
	use crate::{
		call::{Dimensions, NegotiationPolicy},
		catalog::{OperationKind, ProviderId, RouteId},
		id::GenerationHandle,
	};

	#[test]
	fn resume_never_resubmits_and_can_cancel() {
		let checkpoint = JobCheckpoint {
			job:        JobRef {
				provider:  ProviderId::from("p"),
				route:     RouteId::from("r"),
				operation: OperationKind::GenerateVideo,
				handle:    GenerationHandle::from("h"),
			},
			completed:  2,
			total:      Some(10),
			polls:      1,
			expires_at: None,
			created_at: SystemTime::UNIX_EPOCH,
		};
		let policy = JobPolicy {
			initial_delay: Duration::from_secs(1),
			max_delay:     Duration::from_secs(3),
			max_polls:     5,
			max_elapsed:   Duration::from_secs(30),
		};
		let mut video = VideoJob::resume(checkpoint, policy, SystemTime::UNIX_EPOCH).unwrap();
		video.request_cancel().unwrap();
		assert!(matches!(
			video.update::<()>(
				JobUpdate::Running { completed: 3, total: Some(10), retry_after: None },
				SystemTime::UNIX_EPOCH
			),
			Ok(JobAction::Cancel)
		));
	}

	#[test]
	fn validates_media_controls() {
		let request = VideoRequest {
			prompt:            sf!("clip"),
			reference:         None,
			duration_ms:       Setting::Require(2_000),
			dimensions:        Setting::Require(Dimensions { width: 64, height: 64 }),
			frames_per_second: Setting::Prefer(24),
			audio:             Setting::Unset,
			safety:            Arc::from([]),
			seed:              None,
			negotiation:       NegotiationPolicy::default(),
		};
		assert!(
			validate_request(&request, VideoLimits {
				max_duration_ms:       2_000,
				max_pixels:            4096,
				max_frames_per_second: 24,
				max_reference_bytes:   10,
			})
			.is_ok()
		);
	}

	#[test]
	fn stream_without_completion_is_rejected() {
		assert_eq!(VideoProgress::default().finish(), Err(VideoError::MissingCompletion));
	}
}
