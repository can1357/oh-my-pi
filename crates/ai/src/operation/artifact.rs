//! Bounded validation and storage contracts for large media artifacts.

use std::{future::Future, num::NonZeroU64};

use bytes::Bytes;
use omp_core::Str;

use crate::{
	answer::{Artifact, ArtifactBody, ArtifactRef, Digest},
	body::ByteStream,
};

/// Limits applied while accepting or downloading an artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactLimits {
	/// Maximum accepted content length.
	pub max_bytes:        NonZeroU64,
	/// Largest single streamed chunk.
	pub max_chunk_bytes:  NonZeroU64,
	/// Maximum body eligible for inline storage.
	pub max_inline_bytes: u64,
	/// Exact accepted media types; empty accepts every non-empty type.
	pub media_types:      Box<[Str]>,
}

/// Metadata known before an artifact body is opened.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactDescriptor {
	/// MIME media type.
	pub media_type: Str,
	/// Declared byte length.
	pub size:       Option<u64>,
	/// Optional integrity digest.
	pub digest:     Option<Digest>,
}

impl ArtifactDescriptor {
	/// Builds a descriptor without opening the artifact body.
	pub fn from_artifact(artifact: &Artifact) -> Self {
		Self {
			media_type: artifact.media_type.clone(),
			size:       artifact.size,
			digest:     artifact.digest.clone(),
		}
	}
}

/// Why an artifact was rejected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArtifactViolation {
	/// Media type is empty or outside the allowlist.
	MediaType {
		/// Received media type.
		actual: Str,
	},
	/// Declared or observed content exceeds the operation bound.
	TooLarge {
		/// Maximum accepted bytes.
		limit:    u64,
		/// Declared or observed bytes.
		observed: u64,
	},
	/// A transport chunk exceeds the per-chunk bound.
	ChunkTooLarge {
		/// Maximum chunk bytes.
		limit:    u64,
		/// Received chunk bytes.
		observed: u64,
	},
	/// Observed content length differs from its declaration.
	SizeMismatch {
		/// Declared body bytes.
		declared: u64,
		/// Received body bytes.
		observed: u64,
	},
	/// A byte body was selected even though inline storage is forbidden at its
	/// size.
	InlineBodyTooLarge {
		/// Maximum inline bytes.
		limit:    u64,
		/// Body bytes selected for inline storage.
		observed: u64,
	},
	/// More content arrived after the body was finalized.
	AlreadyFinished,
}

/// Validates metadata and representation without consuming a stream.
pub fn validate_artifact(
	artifact: &Artifact,
	limits: &ArtifactLimits,
) -> Result<(), ArtifactViolation> {
	validate_descriptor(&ArtifactDescriptor::from_artifact(artifact), limits)?;
	if let ArtifactBody::Bytes(bytes) = &artifact.body {
		let observed = bytes.len() as u64;
		if observed > limits.max_bytes.get() {
			return Err(ArtifactViolation::TooLarge { limit: limits.max_bytes.get(), observed });
		}
		if observed > limits.max_inline_bytes {
			return Err(ArtifactViolation::InlineBodyTooLarge {
				limit: limits.max_inline_bytes,
				observed,
			});
		}
		if let Some(declared) = artifact.size
			&& declared != observed
		{
			return Err(ArtifactViolation::SizeMismatch { declared, observed });
		}
	}
	Ok(())
}

/// Validates artifact metadata before a body is downloaded.
pub fn validate_descriptor(
	descriptor: &ArtifactDescriptor,
	limits: &ArtifactLimits,
) -> Result<(), ArtifactViolation> {
	if descriptor.media_type.is_empty()
		|| (!limits.media_types.is_empty()
			&& !limits
				.media_types
				.iter()
				.any(|value| value == &descriptor.media_type))
	{
		return Err(ArtifactViolation::MediaType { actual: descriptor.media_type.clone() });
	}
	if let Some(observed) = descriptor.size
		&& observed > limits.max_bytes.get()
	{
		return Err(ArtifactViolation::TooLarge { limit: limits.max_bytes.get(), observed });
	}
	Ok(())
}

/// Incremental byte accounting that never buffers artifact payloads.
#[derive(Clone, Debug)]
pub struct ArtifactMeter {
	limits:   ArtifactLimits,
	declared: Option<u64>,
	observed: u64,
	finished: bool,
}

impl ArtifactMeter {
	/// Starts accounting after validating preflight metadata.
	pub fn new(
		descriptor: &ArtifactDescriptor,
		limits: ArtifactLimits,
	) -> Result<Self, ArtifactViolation> {
		validate_descriptor(descriptor, &limits)?;
		Ok(Self { declared: descriptor.size, limits, observed: 0, finished: false })
	}

	/// Accounts for one chunk before it is forwarded to storage or a caller.
	pub fn observe(&mut self, chunk: &Bytes) -> Result<(), ArtifactViolation> {
		if self.finished {
			return Err(ArtifactViolation::AlreadyFinished);
		}
		let chunk_len = chunk.len() as u64;
		if chunk_len > self.limits.max_chunk_bytes.get() {
			return Err(ArtifactViolation::ChunkTooLarge {
				limit:    self.limits.max_chunk_bytes.get(),
				observed: chunk_len,
			});
		}
		let observed = self
			.observed
			.checked_add(chunk_len)
			.ok_or(ArtifactViolation::TooLarge {
				limit:    self.limits.max_bytes.get(),
				observed: u64::MAX,
			})?;
		if observed > self.limits.max_bytes.get() {
			return Err(ArtifactViolation::TooLarge { limit: self.limits.max_bytes.get(), observed });
		}
		self.observed = observed;
		Ok(())
	}

	/// Finalizes accounting and checks a declared content length.
	pub const fn finish(&mut self) -> Result<u64, ArtifactViolation> {
		if self.finished {
			return Err(ArtifactViolation::AlreadyFinished);
		}
		self.finished = true;
		if let Some(declared) = self.declared
			&& declared != self.observed
		{
			return Err(ArtifactViolation::SizeMismatch { declared, observed: self.observed });
		}
		Ok(self.observed)
	}

	/// Returns bytes forwarded so far.
	pub const fn observed(&self) -> u64 {
		self.observed
	}
}

/// Cancellation-aware streaming verifier that never owns payload bytes.
#[derive(Debug)]
pub struct ArtifactTransfer {
	meter:     ArtifactMeter,
	cancelled: bool,
}

/// Failure while forwarding a bounded artifact stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArtifactTransferError {
	/// Transfer was explicitly cancelled.
	Cancelled,
	/// Content violated an artifact bound.
	Violation(ArtifactViolation),
}

/// Typed evidence produced when an artifact transfer is cancelled.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ArtifactCancellationReceipt {
	/// Bytes forwarded before cancellation.
	pub bytes_forwarded: u64,
}

impl ArtifactTransfer {
	/// Starts a cancellation-aware bounded transfer.
	pub fn new(
		descriptor: &ArtifactDescriptor,
		limits: ArtifactLimits,
	) -> Result<Self, ArtifactViolation> {
		Ok(Self { meter: ArtifactMeter::new(descriptor, limits)?, cancelled: false })
	}

	/// Validates one chunk before forwarding it to a caller or store.
	pub fn observe(&mut self, chunk: &Bytes) -> Result<(), ArtifactTransferError> {
		if self.cancelled {
			return Err(ArtifactTransferError::Cancelled);
		}
		self
			.meter
			.observe(chunk)
			.map_err(ArtifactTransferError::Violation)
	}

	/// Cancels forwarding without polling or buffering another body chunk.
	pub const fn cancel(&mut self) -> ArtifactCancellationReceipt {
		self.cancelled = true;
		ArtifactCancellationReceipt { bytes_forwarded: self.meter.observed() }
	}

	/// Finalizes a non-cancelled transfer.
	pub fn finish(&mut self) -> Result<u64, ArtifactTransferError> {
		if self.cancelled {
			return Err(ArtifactTransferError::Cancelled);
		}
		self
			.meter
			.finish()
			.map_err(ArtifactTransferError::Violation)
	}
}

/// Immutable metadata returned after streaming storage commits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredArtifact {
	/// Repeatable immutable object reference.
	pub reference: ArtifactRef,
	/// Stored byte length.
	pub size:      u64,
	/// Store-computed digest, when available.
	pub digest:    Option<Digest>,
}

/// Failure from an artifact store, sanitized for operation-level reporting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArtifactStoreError {
	/// The object does not exist or its immutable revision expired.
	NotFound,
	/// Storage rejected the descriptor or byte stream.
	Rejected(Str),
	/// Storage was cancelled before commit.
	Cancelled,
	/// Storage failed without exposing secret-bearing backend details.
	Unavailable(Str),
}

/// Streaming immutable artifact storage; implementations must not aggregate the
/// body.
pub trait ArtifactStore: Send + Sync {
	/// Future returned by [`ArtifactStore::put`].
	type PutFuture<'a>: Future<Output = Result<StoredArtifact, ArtifactStoreError>> + Send + 'a
	where
		Self: 'a;
	/// Future returned by [`ArtifactStore::open`].
	type OpenFuture<'a>: Future<Output = Result<(ArtifactDescriptor, ByteStream), ArtifactStoreError>>
		+ Send
		+ 'a
	where
		Self: 'a;

	/// Streams an object into storage and atomically publishes it on success.
	fn put(
		&self,
		descriptor: ArtifactDescriptor,
		body: ByteStream,
		limits: ArtifactLimits,
	) -> Self::PutFuture<'_>;
	/// Opens a new repeatable stream for an immutable stored object.
	fn open<'a>(
		&'a self,
		reference: &'a ArtifactRef,
		limits: ArtifactLimits,
	) -> Self::OpenFuture<'a>;
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	fn limits() -> ArtifactLimits {
		ArtifactLimits {
			max_bytes:        NonZeroU64::new(8).unwrap(),
			max_chunk_bytes:  NonZeroU64::new(4).unwrap(),
			max_inline_bytes: 4,
			media_types:      [sf!("image/png")].into(),
		}
	}

	#[test]
	fn meter_rejects_oversize_without_buffering() {
		let descriptor =
			ArtifactDescriptor { media_type: sf!("image/png"), size: None, digest: None };
		let mut meter = ArtifactMeter::new(&descriptor, limits()).unwrap();
		meter.observe(&Bytes::from_static(b"1234")).unwrap();
		let failure = meter.observe(&Bytes::from_static(b"56789")).unwrap_err();
		assert_eq!(failure, ArtifactViolation::ChunkTooLarge { limit: 4, observed: 5 });
		assert_eq!(meter.observed(), 4);
	}

	#[test]
	fn declared_size_is_checked_at_completion() {
		let descriptor =
			ArtifactDescriptor { media_type: sf!("image/png"), size: Some(3), digest: None };
		let mut meter = ArtifactMeter::new(&descriptor, limits()).unwrap();
		meter.observe(&Bytes::from_static(b"12")).unwrap();
		assert_eq!(meter.finish(), Err(ArtifactViolation::SizeMismatch { declared: 3, observed: 2 }));
	}
}
