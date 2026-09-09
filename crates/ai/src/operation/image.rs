//! Image generation and editing validation plus progress accounting.

use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll},
};

use futures::StreamExt;
use omp_core::Str;
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, GenerationEvent, GenerationStream, ImageArtifact},
	body::ReplayEvidence,
	call::{Call, ImageRequest, MediaInput, OperationCall, Setting},
	catalog::OperationKind,
	error::Error,
	operation::{
		MediaOperationError, OperationRequest, OperationResponse, media_protocol_error,
		media_validation_error, wrong_operation,
	},
};

/// Bounded image-operation limits supplied by capability negotiation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageLimits {
	/// Maximum requested final image count.
	pub max_count:       u32,
	/// Maximum input reference count.
	pub max_references:  u32,
	/// Maximum pixels in one requested or returned image.
	pub max_pixels:      u64,
	/// Maximum inline bytes across references and a mask.
	pub max_input_bytes: u64,
}

/// Typed image request validation failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ImageError {
	/// Prompt contains no non-whitespace content.
	#[error("image prompt is empty")]
	EmptyPrompt,
	/// Explicit style contains no non-whitespace content.
	#[error("image style is empty")]
	EmptyStyle,
	/// Requested artifact count is zero or exceeds the bound.
	#[error("requested {requested} images, but the maximum is {maximum}")]
	Count {
		/// Requested final artifact count.
		requested: u32,
		/// Negotiated maximum final artifact count.
		maximum:   u32,
	},
	/// Reference count exceeds the bound.
	#[error("supplied {requested} image references, but the maximum is {maximum}")]
	References {
		/// Number of supplied edit references.
		requested: u32,
		/// Negotiated maximum edit reference count.
		maximum:   u32,
	},
	/// Mask was supplied without an image to edit.
	#[error("image mask requires an edit reference")]
	MaskWithoutReference,
	/// A mask is not a supported raster type.
	#[error("image mask media type {media_type} is unsupported")]
	InvalidMaskType {
		/// Unsupported media type.
		media_type: Str,
	},
	/// A reference is not a supported raster type.
	#[error("image reference media type {media_type} is unsupported")]
	InvalidReferenceType {
		/// Unsupported media type.
		media_type: Str,
	},
	/// Inline edit inputs exceed their aggregate bound.
	#[error("inline image inputs contain {observed} bytes, but the maximum is {limit}")]
	InputsTooLarge {
		/// Maximum permitted aggregate inline input bytes.
		limit:    u64,
		/// Aggregate inline input bytes observed.
		observed: u64,
	},
	/// Dimensions are zero or exceed the pixel bound.
	#[error("image dimensions {width}x{height} exceed the {maximum_pixels}-pixel limit")]
	Dimensions {
		/// Requested image width.
		width:          u32,
		/// Requested image height.
		height:         u32,
		/// Negotiated maximum requested pixel count.
		maximum_pixels: u64,
	},
	/// Generation progress moved backwards or changed a known total.
	#[error("image generation progress is not monotonic")]
	NonMonotonicProgress,
	/// More final artifacts arrived than requested.
	#[error("image generation returned more than the requested {requested} artifacts")]
	TooManyArtifacts {
		/// Final artifact count requested by the caller.
		requested: u32,
	},
	/// A final image has invalid dimensions.
	#[error("generated image has invalid dimensions {width}x{height}")]
	InvalidArtifactDimensions {
		/// Returned image width.
		width:  u32,
		/// Returned image height.
		height: u32,
	},
	/// Completion summary disagrees with observed final artifacts.
	#[error(
		"image completion reported {reported} artifacts after {observed} artifacts were observed"
	)]
	CompletionMismatch {
		/// Final artifact count observed before completion.
		observed: u32,
		/// Final artifact count reported by the completion summary.
		reported: u32,
	},
	/// Stream ended before a completion event.
	#[error("image stream ended before completion")]
	MissingCompletion,
	/// Event arrived after completion.
	#[error("image event arrived after completion")]
	AlreadyCompleted,
}

/// Validates references, mask, dimensions, and input bounds before planning.
pub fn validate_request(request: &ImageRequest, limits: ImageLimits) -> Result<(), ImageError> {
	if request.prompt.trim().is_empty() {
		return Err(ImageError::EmptyPrompt);
	}
	if let Setting::Prefer(style) | Setting::Require(style) = &request.style
		&& style.trim().is_empty()
	{
		return Err(ImageError::EmptyStyle);
	}
	if request.count == 0 || request.count > limits.max_count {
		return Err(ImageError::Count { requested: request.count, maximum: limits.max_count });
	}
	if request.references.len() as u32 > limits.max_references {
		return Err(ImageError::References {
			requested: request.references.len() as u32,
			maximum:   limits.max_references,
		});
	}
	if request.mask.is_some() && request.references.is_empty() {
		return Err(ImageError::MaskWithoutReference);
	}
	let mut bytes = 0_u64;
	for reference in request.references.iter() {
		bytes = bytes.checked_add(validate_media(reference, false)?).ok_or(
			ImageError::InputsTooLarge { limit: limits.max_input_bytes, observed: u64::MAX },
		)?;
	}
	if let Some(mask) = request.mask.as_ref() {
		bytes = bytes
			.checked_add(validate_media(mask, true)?)
			.ok_or(ImageError::InputsTooLarge {
				limit:    limits.max_input_bytes,
				observed: u64::MAX,
			})?;
	}
	if bytes > limits.max_input_bytes {
		return Err(ImageError::InputsTooLarge { limit: limits.max_input_bytes, observed: bytes });
	}
	if let Setting::Prefer(dimensions) | Setting::Require(dimensions) = &request.dimensions {
		let pixels = u64::from(dimensions.width).saturating_mul(u64::from(dimensions.height));
		if dimensions.width == 0 || dimensions.height == 0 || pixels > limits.max_pixels {
			return Err(ImageError::Dimensions {
				width:          dimensions.width,
				height:         dimensions.height,
				maximum_pixels: limits.max_pixels,
			});
		}
	}
	Ok(())
}

fn validate_media(input: &MediaInput, mask: bool) -> Result<u64, ImageError> {
	let media_type = match input {
		MediaInput::Bytes { media_type, .. } | MediaInput::Body { media_type, .. } => media_type,
		MediaInput::Remote { media_type: Some(media_type), .. } => media_type,
		MediaInput::Stored(_) | MediaInput::Remote { media_type: None, .. } => return Ok(0),
	};
	if !matches!(media_type.as_str(), "image/png" | "image/jpeg" | "image/webp") {
		return Err(if mask {
			ImageError::InvalidMaskType { media_type: media_type.clone() }
		} else {
			ImageError::InvalidReferenceType { media_type: media_type.clone() }
		});
	}
	Ok(match input {
		MediaInput::Bytes { data, .. } => data.len() as u64,
		MediaInput::Stored(_) | MediaInput::Remote { .. } | MediaInput::Body { .. } => 0,
	})
}

/// Aggregates replay evidence for every streamed reference and mask body.
pub fn request_replay_evidence(request: &ImageRequest) -> Option<ReplayEvidence> {
	let parts = request
		.references
		.iter()
		.chain(request.mask.iter())
		.filter_map(|input| match input {
			MediaInput::Body { body, .. } => Some(body.replay_evidence()),
			MediaInput::Bytes { .. } | MediaInput::Stored(_) | MediaInput::Remote { .. } => None,
		});
	let evidence: Vec<_> = parts.collect();
	(!evidence.is_empty()).then(|| ReplayEvidence::aggregate(evidence))
}

/// Verifies ordered generation events without retaining artifact payloads.
#[derive(Clone, Debug)]
pub struct ImageProgress {
	requested: u32,
	completed: u64,
	total:     Option<u64>,
	artifacts: u32,
	finished:  bool,
}

impl ImageProgress {
	/// Starts accounting for one validated image request.
	pub const fn new(requested: u32) -> Self {
		Self { requested, completed: 0, total: None, artifacts: 0, finished: false }
	}

	/// Observes one event and rejects inconsistent progress or artifact counts.
	pub fn observe(&mut self, event: &GenerationEvent<ImageArtifact>) -> Result<(), ImageError> {
		if self.finished {
			return Err(ImageError::AlreadyCompleted);
		}
		match event {
			GenerationEvent::Progress { completed, total } => {
				if *completed < self.completed || self.total.is_some_and(|known| *total != Some(known))
				{
					return Err(ImageError::NonMonotonicProgress);
				}
				if total.is_some_and(|total| *completed > total) {
					return Err(ImageError::NonMonotonicProgress);
				}
				self.completed = *completed;
				self.total = total.or(self.total);
			},
			GenerationEvent::Artifact(artifact) => {
				if artifact.width == 0 || artifact.height == 0 {
					return Err(ImageError::InvalidArtifactDimensions {
						width:  artifact.width,
						height: artifact.height,
					});
				}
				self.artifacts = self.artifacts.saturating_add(1);
				if self.artifacts > self.requested {
					return Err(ImageError::TooManyArtifacts { requested: self.requested });
				}
			},
			GenerationEvent::Completed(summary) => {
				if summary.artifacts != self.artifacts {
					return Err(ImageError::CompletionMismatch {
						observed: self.artifacts,
						reported: summary.artifacts,
					});
				}
				self.finished = true;
			},
			GenerationEvent::Queued { .. } | GenerationEvent::Preview(_) => {},
		}
		Ok(())
	}

	/// Confirms the stream reached an explicit, count-consistent completion.
	pub const fn finish(&self) -> Result<(), ImageError> {
		if self.finished {
			Ok(())
		} else {
			Err(ImageError::MissingCompletion)
		}
	}

	/// Returns the number of final artifacts observed.
	pub const fn artifacts(&self) -> u32 {
		self.artifacts
	}
}

/// Concrete image operation service over a constructed route backend.
#[derive(Clone, Debug)]
pub struct ImageService<S> {
	inner:  S,
	limits: ImageLimits,
}

impl<S> ImageService<S> {
	/// Wraps a route backend with canonical image validation and stream
	/// accounting.
	pub const fn new(inner: S, limits: ImageLimits) -> Self {
		Self { inner, limits }
	}
}

impl<S> Service<Call> for ImageService<S>
where
	S: Service<
			OperationRequest<ImageRequest>,
			Response = OperationResponse<GenerationStream<ImageArtifact>>,
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
			OperationCall::GenerateImage(request) => Some(Arc::clone(request)),
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
		async move {
			let Some(request) = request else {
				return Err(wrong_operation(&call, OperationKind::GenerateImage));
			};
			if let Some(Err(error)) = validation {
				return Err(media_validation_error(OperationKind::GenerateImage, error));
			}
			let response = pending
				.ok_or_else(|| {
					media_validation_error(
						OperationKind::GenerateImage,
						MediaOperationError::ImageRequestNotDispatched,
					)
				})?
				.await?;
			let mut progress = ImageProgress::new(request.count);
			Ok(response
				.map(move |mut output| {
					let stream = async_stream::stream! {
						while let Some(event) = output.next().await {
							match event.and_then(|event| {
								progress.observe(&event).map_err(|error| {
									media_protocol_error(OperationKind::GenerateImage, error)
								})?;
								Ok(event)
							}) {
								Ok(event) => yield Ok(event),
								Err(error) => { yield Err(error); return; }
							}
						}
						if let Err(error) = progress.finish() {
							yield Err(media_protocol_error(OperationKind::GenerateImage, error));
						}
					};
					Box::pin(stream) as GenerationStream<ImageArtifact>
				})
				.into_answer(AnswerBody::Images))
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{error, sync::Arc};

	use bytes::Bytes;
	use omp_core::sf;

	use super::*;
	use crate::call::{Background, Dimensions, ImageFormat, ImageQuality, NegotiationPolicy};

	fn request() -> ImageRequest {
		ImageRequest {
			prompt:      sf!("edit"),
			references:  Arc::from([MediaInput::Bytes {
				media_type: sf!("image/png"),
				data:       Bytes::from_static(b"png"),
			}]),
			mask:        Some(MediaInput::Bytes {
				media_type: sf!("image/png"),
				data:       Bytes::from_static(b"mask"),
			}),
			count:       1,
			dimensions:  Setting::Prefer(Dimensions { width: 64, height: 64 }),
			quality:     Setting::<ImageQuality>::Unset,
			background:  Setting::<Background>::Unset,
			format:      Setting::<ImageFormat>::Unset,
			style:       Setting::Unset,
			safety:      Arc::from([]),
			seed:        None,
			negotiation: NegotiationPolicy::default(),
		}
	}

	#[test]
	fn validation_error_preserves_typed_source_chain() {
		let error = media_validation_error(OperationKind::GenerateImage, ImageError::EmptyPrompt);
		let media = error::Error::source(&error)
			.and_then(|source| source.downcast_ref::<MediaOperationError>())
			.expect("typed media operation source");
		let image = error::Error::source(media)
			.and_then(|source| source.downcast_ref::<ImageError>())
			.expect("typed image source");
		assert_eq!(image, &ImageError::EmptyPrompt);
	}

	#[test]
	fn validates_edit_inputs_and_aggregate_bound() {
		assert!(
			validate_request(&request(), ImageLimits {
				max_count:       1,
				max_references:  1,
				max_pixels:      4096,
				max_input_bytes: 7,
			})
			.is_ok()
		);
		assert_eq!(
			validate_request(&request(), ImageLimits {
				max_count:       1,
				max_references:  1,
				max_pixels:      4096,
				max_input_bytes: 6,
			}),
			Err(ImageError::InputsTooLarge { limit: 6, observed: 7 })
		);
	}

	#[test]
	fn stream_without_completion_is_rejected() {
		let progress = ImageProgress::new(1);
		assert_eq!(progress.finish(), Err(ImageError::MissingCompletion));
	}
}
