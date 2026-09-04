//! Verified, root-confined acquisition for local-model artifacts.

use std::{
	collections::{HashMap, HashSet},
	ffi::OsString,
	fmt,
	fs::{self, File, OpenOptions},
	future::Future,
	io::{self, Read, Seek as _, SeekFrom, Write as _},
	path::{Component, Path, PathBuf},
	pin::Pin,
	sync::{Arc, LazyLock, Weak},
	task::{Context, Poll, ready},
};

use bytes::Bytes;
use futures::{Stream, StreamExt as _};
use http::{
	Request, StatusCode,
	header::{CONTENT_LENGTH, CONTENT_RANGE, LOCATION, RANGE},
};
use http_body_util::Empty;
use hyper::body::{Body as _, Incoming};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
	client::{
		legacy,
		legacy::{Client, connect::HttpConnector},
	},
	rt::TokioExecutor,
};
use omp_core::{Str, sf};
use parking_lot::Mutex as ParkingMutex;
use rustls::crypto::ring;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use strum::{Display, EnumString, IntoStaticStr};
use tokio::sync::Mutex;
use url::Url;

use super::runtime::{LocalCancellation, LocalError, LocalErrorKind, LocalResult};

/// Decodes a compile-time lowercase or uppercase SHA-256 identity.
///
/// Catalogs use this instead of storing a second textual digest beside the
/// fixed-size identity consumed by verification.
pub const fn sha256_digest(hex: &[u8; 64]) -> [u8; 32] {
	let mut digest = [0_u8; 32];
	let mut index = 0;
	while index < digest.len() {
		digest[index] = match omp_core::hex::parse_byte([hex[index * 2], hex[index * 2 + 1]]) {
			Ok(byte) => byte,
			Err(_) => panic!("invalid catalog SHA-256"),
		};
		index += 1;
	}
	digest
}

/// Immutable expected identity of one local-model artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactSpec {
	/// Root-relative artifact path.
	pub path:   PathBuf,
	/// Exact expected file length.
	pub bytes:  u64,
	/// Exact SHA-256 digest.
	pub sha256: [u8; 32],
}

/// One independently downloadable shard in an artifact manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactShard {
	/// Immutable artifact identity.
	pub spec:   ArtifactSpec,
	/// Public HTTP(S) source. Redirects are resolved by the fetcher.
	pub source: Str,
}

/// Complete immutable artifact set needed to load one model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactManifest {
	/// Stable model/artifact-set identifier.
	pub id:     Str,
	/// Ordered shards. Every path must be unique.
	pub shards: Vec<ArtifactShard>,
}

impl ArtifactManifest {
	/// Validates and constructs an immutable artifact manifest.
	pub fn new(id: impl Into<Str>, shards: Vec<ArtifactShard>) -> ArtifactResult<Self> {
		let manifest = Self { id: id.into(), shards };
		manifest.validate()?;
		Ok(manifest)
	}

	/// Validates paths, sources, uniqueness, and aggregate size.
	pub fn validate(&self) -> ArtifactResult<()> {
		if self.id.trim().is_empty() || self.shards.is_empty() {
			return Err(ArtifactError::InvalidManifest);
		}
		let mut paths = HashSet::with_capacity(self.shards.len());
		let mut total = 0_u64;
		for shard in &self.shards {
			validate_relative(&shard.spec.path)?;
			if !paths.insert(shard.spec.path.clone()) {
				return Err(ArtifactError::DuplicatePath { path: shard.spec.path.clone() });
			}
			let source = Url::parse(shard.source.as_str())
				.map_err(|source| ArtifactError::InvalidUrl { source })?;
			if !matches!(source.scheme(), "http" | "https")
				|| !source.username().is_empty()
				|| source.password().is_some()
				|| source.fragment().is_some()
			{
				return Err(ArtifactError::InvalidSource);
			}
			total = total
				.checked_add(shard.spec.bytes)
				.ok_or(ArtifactError::ManifestSizeOverflow)?;
		}
		Ok(())
	}

	/// Returns the exact aggregate size of every shard.
	pub fn total_bytes(&self) -> ArtifactResult<u64> {
		self.validate()?;
		self.shards.iter().try_fold(0_u64, |total, shard| {
			total
				.checked_add(shard.spec.bytes)
				.ok_or(ArtifactError::ManifestSizeOverflow)
		})
	}
}

/// Evidence produced after reading and hashing an artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactReceipt {
	/// Canonical verified path.
	pub path:   PathBuf,
	/// Observed file length.
	pub bytes:  u64,
	/// Observed SHA-256 digest.
	pub sha256: [u8; 32],
}

/// Evidence that every shard in one manifest was verified.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactManifestReceipt {
	/// Stable manifest identifier.
	pub id:        Str,
	/// Verification receipts in manifest order.
	pub artifacts: Vec<ArtifactReceipt>,
}

/// Stable cache classification derived from files and checksums on disk.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum ArtifactCacheStatus {
	/// No verified artifact or resumable partial bytes exist.
	#[default]
	Missing,
	/// At least one resumable sidecar exists, but the set is incomplete.
	Partial,
	/// A final-path object exists but does not match its manifest identity.
	Corrupt,
	/// Every shard matches its declared length and SHA-256 digest.
	Ready,
}

/// Cache evidence for one manifest.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCacheState {
	/// Stable cache classification.
	pub status:             ArtifactCacheStatus,
	/// Verified final bytes plus bounded resumable sidecar bytes.
	pub cached_bytes:       u64,
	/// Exact aggregate manifest size.
	pub total_bytes:        u64,
	/// Number of checksum-verified final shards.
	pub verified_artifacts: usize,
	/// Total number of manifest shards.
	pub total_artifacts:    usize,
}

/// One monotonic aggregate download-progress update.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactProgress {
	/// Manifest currently being acquired.
	pub manifest_id:      Str,
	/// Current root-relative shard path.
	pub artifact_path:    PathBuf,
	/// Aggregate bytes downloaded or already verified.
	pub downloaded_bytes: u64,
	/// Exact aggregate manifest size.
	pub total_bytes:      u64,
	/// Zero-based current shard index.
	pub artifact_index:   usize,
	/// Number of shards in the manifest.
	pub artifact_count:   usize,
}

/// Range request made by an artifact store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactFetchRequest {
	/// Public HTTP(S) source.
	pub source:         Str,
	/// Existing sidecar length requested as a resume offset.
	pub offset:         u64,
	/// Exact expected complete length.
	pub expected_bytes: u64,
}

/// Streaming fetch response, including the offset accepted by the server.
pub struct ArtifactFetchResponse<B> {
	/// Offset of the first returned byte. Zero means replace the sidecar.
	pub accepted_offset: u64,
	/// Complete remote object length.
	pub total_bytes:     u64,
	/// Streaming response body.
	pub body:            B,
}

/// Cold network boundary for resumable artifact acquisition.
pub trait ArtifactFetcher: Send + Sync {
	/// Streaming response body.
	type Body: Stream<Item = ArtifactResult<Bytes>> + Send;
	/// Future returned by [`ArtifactFetcher::fetch`].
	type FetchFuture<'a>: Future<Output = ArtifactResult<ArtifactFetchResponse<Self::Body>>>
		+ Send
		+ 'a
	where
		Self: 'a;

	/// Fetches an object from the requested byte offset.
	fn fetch(&self, request: ArtifactFetchRequest) -> Self::FetchFuture<'_>;
}

/// File operation reported by a typed artifact I/O error.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum ArtifactIoOperation {
	/// Inspect file metadata.
	Metadata,
	/// Canonicalize a path.
	Canonicalize,
	/// Create an artifact directory.
	CreateDirectory,
	/// Open a file.
	Open,
	/// Read a file.
	Read,
	/// Write a partial file.
	Write,
	/// Flush file contents to stable storage.
	Sync,
	/// Resize a partial file.
	Truncate,
	/// Atomically publish a verified file.
	Promote,
	/// Remove an obsolete sidecar.
	Remove,
	/// Seek an opened verified artifact.
	Seek,
}

/// Typed artifact verification and acquisition failure.
#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
	/// Artifact root is unavailable or a file operation failed.
	#[error("artifact {operation} operation failed")]
	Io {
		/// Failed operation.
		operation: ArtifactIoOperation,
		/// Underlying filesystem error.
		#[source]
		source:    io::Error,
	},
	/// A root-relative artifact path was invalid.
	#[error("artifact path must be a non-empty normalized relative path")]
	InvalidPath,
	/// A manifest omitted its id or all shards.
	#[error("artifact manifest must have a non-empty id and at least one shard")]
	InvalidManifest,
	/// A manifest contained the same path more than once.
	#[error("artifact manifest contains duplicate path {path:?}")]
	DuplicatePath {
		/// Duplicate root-relative path.
		path: PathBuf,
	},
	/// Aggregate manifest length overflowed `u64`.
	#[error("artifact manifest aggregate size overflowed")]
	ManifestSizeOverflow,
	/// A source URL was malformed.
	#[error("artifact source URL is invalid")]
	InvalidUrl {
		/// URL parser failure.
		#[source]
		source: url::ParseError,
	},
	/// A source URL was not credential-free HTTP(S).
	#[error("artifact source must be credential-free HTTP(S) without a fragment")]
	InvalidSource,
	/// A candidate was not a regular file.
	#[error("artifact must be a regular file, not a symlink")]
	NotRegularFile,
	/// A candidate escaped its canonical storage root.
	#[error("artifact escapes its storage root")]
	EscapesRoot,
	/// A file changed between inspection and opening.
	#[error("artifact changed while it was being opened")]
	ChangedWhileOpening,
	/// File length did not match the manifest.
	#[error("artifact length mismatch: expected {expected}, observed {observed}")]
	LengthMismatch {
		/// Declared length.
		expected: u64,
		/// Observed length.
		observed: u64,
	},
	/// File checksum did not match the manifest.
	#[error("artifact SHA-256 mismatch")]
	ChecksumMismatch,
	/// Caller cancelled verification or acquisition.
	#[error("artifact operation was cancelled")]
	Cancelled,
	/// HTTP request URI could not be represented.
	#[error("artifact HTTP request URI is invalid")]
	InvalidHttpUri {
		/// URI parser failure.
		#[source]
		source: http::uri::InvalidUri,
	},
	/// HTTP transport failed before response streaming began.
	#[error("artifact HTTP request failed")]
	HttpRequest {
		/// Hyper client failure.
		#[source]
		source: legacy::Error,
	},
	/// HTTP response body failed while streaming.
	#[error("artifact HTTP response stream failed")]
	HttpBody {
		/// Hyper body failure.
		#[source]
		source: hyper::Error,
	},
	/// HTTP server returned a status that cannot carry an artifact.
	#[error("artifact server returned HTTP status {status}")]
	HttpStatus {
		/// Numeric HTTP status.
		status: u16,
	},
	/// Redirect metadata was missing or malformed.
	#[error("artifact server returned an invalid redirect")]
	InvalidRedirect,
	/// Redirect limit was exceeded.
	#[error("artifact server exceeded the redirect limit")]
	TooManyRedirects,
	/// A partial response carried malformed range metadata.
	#[error("artifact server returned invalid content-range metadata")]
	InvalidContentRange,
	/// Remote object length differs from the immutable manifest.
	#[error("artifact remote length mismatch: expected {expected}, observed {observed}")]
	RemoteLengthMismatch {
		/// Manifest length.
		expected: u64,
		/// Remote length.
		observed: u64,
	},
	/// Server resumed from neither the requested offset nor zero.
	#[error("artifact server resumed at {observed}, expected {expected} or zero")]
	InvalidResumeOffset {
		/// Requested resume offset.
		expected: u64,
		/// Response start offset.
		observed: u64,
	},
	/// Stream ended before the declared object length.
	#[error("artifact stream ended early: expected {expected}, observed {observed}")]
	IncompleteDownload {
		/// Manifest length.
		expected: u64,
		/// Sidecar length after streaming.
		observed: u64,
	},
	/// Stream exceeded the declared object length.
	#[error("artifact stream exceeded its declared length {expected}")]
	OversizedDownload {
		/// Manifest length.
		expected: u64,
	},
}

/// Artifact operation result.
pub type ArtifactResult<T> = Result<T, ArtifactError>;

impl ArtifactError {
	fn into_local(self) -> LocalError {
		if matches!(self, Self::Cancelled) {
			LocalError::cancelled()
		} else {
			LocalError::new(LocalErrorKind::Artifact, "local artifact verification failed")
		}
	}
}

/// Root-confined storage boundary for model files.
#[derive(Clone, Debug)]
pub struct ArtifactStore {
	root:          PathBuf,
	download_lock: Arc<Mutex<()>>,
}

impl ArtifactStore {
	/// Opens an existing artifact root and resolves it against symlinks.
	pub fn open(root: impl AsRef<Path>) -> ArtifactResult<Self> {
		let root = fs::canonicalize(root.as_ref())
			.map_err(|source| io_error(ArtifactIoOperation::Canonicalize, source))?;
		if !root.is_dir() {
			return Err(ArtifactError::NotRegularFile);
		}
		let download_lock = shared_download_lock(&root);
		Ok(Self { root, download_lock })
	}

	/// Returns the canonical storage root.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Verifies an artifact with typed failure details.
	pub fn verify_typed(
		&self,
		spec: &ArtifactSpec,
		cancel: &LocalCancellation,
	) -> ArtifactResult<VerifiedArtifact> {
		validate_relative(&spec.path)?;
		let candidate = self.root.join(&spec.path);
		self.verify_candidate(&candidate, spec, cancel)
	}

	/// Verifies path confinement, size, and digest before returning a usable
	/// file. This compatibility entry point maps typed artifact errors into the
	/// shared local-inference category.
	pub fn verify(
		&self,
		spec: &ArtifactSpec,
		cancel: &LocalCancellation,
	) -> LocalResult<VerifiedArtifact> {
		self
			.verify_typed(spec, cancel)
			.map_err(ArtifactError::into_local)
	}

	/// Derives cache state by checking every final artifact and `.part` sidecar.
	pub fn inspect_manifest(
		&self,
		manifest: &ArtifactManifest,
		cancel: &LocalCancellation,
	) -> ArtifactResult<ArtifactCacheState> {
		manifest.validate()?;
		let total_bytes = manifest.total_bytes()?;
		let mut cached_bytes = 0_u64;
		let mut verified_artifacts = 0_usize;
		let mut corrupt = false;
		for shard in &manifest.shards {
			if cancelled(cancel) {
				return Err(ArtifactError::Cancelled);
			}
			let verified = match self.try_verify(&shard.spec, cancel) {
				Ok(Some(receipt)) => {
					cached_bytes = cached_bytes.saturating_add(receipt.bytes);
					verified_artifacts += 1;
					true
				},
				Ok(None) => false,
				Err(ArtifactError::Cancelled) => return Err(ArtifactError::Cancelled),
				Err(_) => {
					corrupt = true;
					false
				},
			};
			if !verified {
				cached_bytes = cached_bytes.saturating_add(self.partial_len(&shard.spec)?);
			}
		}
		let status = if verified_artifacts == manifest.shards.len() {
			ArtifactCacheStatus::Ready
		} else if corrupt {
			ArtifactCacheStatus::Corrupt
		} else if cached_bytes > 0 {
			ArtifactCacheStatus::Partial
		} else {
			ArtifactCacheStatus::Missing
		};
		Ok(ArtifactCacheState {
			status,
			cached_bytes: cached_bytes.min(total_bytes),
			total_bytes,
			verified_artifacts,
			total_artifacts: manifest.shards.len(),
		})
	}

	/// Downloads, verifies, and atomically promotes every manifest shard.
	///
	/// Existing `.part` sidecars are resumed when the server accepts their exact
	/// offset and replaced when it responds from byte zero. A store clone shares
	/// one cancellable acquisition lock, so concurrent callers cannot write the
	/// same sidecar simultaneously.
	pub async fn acquire<F, P>(
		&self,
		manifest: &ArtifactManifest,
		fetcher: &F,
		cancel: &LocalCancellation,
		mut progress: P,
	) -> ArtifactResult<ArtifactManifestReceipt>
	where
		F: ArtifactFetcher,
		P: FnMut(ArtifactProgress),
	{
		manifest.validate()?;
		let total_bytes = manifest.total_bytes()?;
		let _guard = tokio::select! {
			guard = self.download_lock.lock() => guard,
			() = cancel.cancelled() => return Err(ArtifactError::Cancelled),
		};

		let mut verified = Vec::with_capacity(manifest.shards.len());
		let mut partials = Vec::with_capacity(manifest.shards.len());
		for shard in &manifest.shards {
			match self.try_verify(&shard.spec, cancel) {
				Ok(receipt) => verified.push(receipt),
				Err(ArtifactError::Cancelled) => return Err(ArtifactError::Cancelled),
				Err(_) => verified.push(None),
			}
			partials.push(self.partial_len(&shard.spec)?);
		}

		let mut last_reported = verified
			.iter()
			.enumerate()
			.map(|(index, receipt)| receipt.as_ref().map_or(partials[index], |item| item.bytes))
			.fold(0_u64, u64::saturating_add)
			.min(total_bytes);
		let initial_path = manifest.shards[0].spec.path.clone();
		progress(ArtifactProgress {
			manifest_id: manifest.id.clone(),
			artifact_path: initial_path,
			downloaded_bytes: last_reported,
			total_bytes,
			artifact_index: 0,
			artifact_count: manifest.shards.len(),
		});

		let mut receipts = Vec::with_capacity(manifest.shards.len());
		let mut prefix = 0_u64;
		for (index, shard) in manifest.shards.iter().enumerate() {
			let suffix = partials[index + 1..]
				.iter()
				.copied()
				.fold(0_u64, u64::saturating_add);
			let receipt = if let Some(receipt) = verified[index].take() {
				receipt
			} else {
				self.ensure_parent(&shard.spec.path)?;
				self
					.acquire_shard(shard, fetcher, cancel, |shard_bytes| {
						let aggregate = prefix
							.saturating_add(shard_bytes)
							.saturating_add(suffix)
							.min(total_bytes);
						last_reported = last_reported.max(aggregate);
						progress(ArtifactProgress {
							manifest_id: manifest.id.clone(),
							artifact_path: shard.spec.path.clone(),
							downloaded_bytes: last_reported,
							total_bytes,
							artifact_index: index,
							artifact_count: manifest.shards.len(),
						});
					})
					.await?
			};
			prefix = prefix.saturating_add(shard.spec.bytes);
			last_reported = last_reported.max(prefix.saturating_add(suffix).min(total_bytes));
			receipts.push(receipt);
		}
		last_reported = total_bytes;
		let final_index = manifest.shards.len() - 1;
		progress(ArtifactProgress {
			manifest_id: manifest.id.clone(),
			artifact_path: manifest.shards[final_index].spec.path.clone(),
			downloaded_bytes: last_reported,
			total_bytes,
			artifact_index: final_index,
			artifact_count: manifest.shards.len(),
		});
		Ok(ArtifactManifestReceipt { id: manifest.id.clone(), artifacts: receipts })
	}

	async fn acquire_shard<F, P>(
		&self,
		shard: &ArtifactShard,
		fetcher: &F,
		cancel: &LocalCancellation,
		mut progress: P,
	) -> ArtifactResult<ArtifactReceipt>
	where
		F: ArtifactFetcher,
		P: FnMut(u64),
	{
		let part = sidecar_path(&self.root.join(&shard.spec.path));
		let mut offset = self.partial_len(&shard.spec)?;
		if offset == shard.spec.bytes {
			match self.promote(&part, &shard.spec, cancel) {
				Ok(receipt) => return Ok(receipt),
				Err(ArtifactError::Cancelled) => return Err(ArtifactError::Cancelled),
				Err(_) => {
					resize_partial(&part, 0)?;
					offset = 0;
				},
			}
		}
		progress(offset);
		let response = tokio::select! {
			response = fetcher.fetch(ArtifactFetchRequest {
				source: shard.source.clone(),
				offset,
				expected_bytes: shard.spec.bytes,
			}) => response?,
			() = cancel.cancelled() => return Err(ArtifactError::Cancelled),
		};
		if response.total_bytes != shard.spec.bytes {
			return Err(ArtifactError::RemoteLengthMismatch {
				expected: shard.spec.bytes,
				observed: response.total_bytes,
			});
		}
		if response.accepted_offset != offset && response.accepted_offset != 0 {
			return Err(ArtifactError::InvalidResumeOffset {
				expected: offset,
				observed: response.accepted_offset,
			});
		}
		if response.accepted_offset == 0 && offset != 0 {
			resize_partial(&part, 0)?;
			offset = 0;
			progress(0);
		}

		let mut file = open_partial(&part, response.accepted_offset != 0)?;
		let mut observed = offset;
		let body = response.body;
		tokio::pin!(body);
		loop {
			if cancelled(cancel) {
				return Err(ArtifactError::Cancelled);
			}
			let chunk = tokio::select! {
				chunk = body.next() => chunk,
				() = cancel.cancelled() => return Err(ArtifactError::Cancelled),
			};
			let Some(chunk) = chunk else { break };
			let chunk = chunk?;
			if observed.saturating_add(chunk.len() as u64) > shard.spec.bytes {
				return Err(ArtifactError::OversizedDownload { expected: shard.spec.bytes });
			}
			file
				.write_all(&chunk)
				.map_err(|source| io_error(ArtifactIoOperation::Write, source))?;
			observed += chunk.len() as u64;
			progress(observed);
		}
		if observed != shard.spec.bytes {
			return Err(ArtifactError::IncompleteDownload { expected: shard.spec.bytes, observed });
		}
		file
			.sync_all()
			.map_err(|source| io_error(ArtifactIoOperation::Sync, source))?;
		drop(file);
		self.promote(&part, &shard.spec, cancel)
	}

	fn try_verify(
		&self,
		spec: &ArtifactSpec,
		cancel: &LocalCancellation,
	) -> ArtifactResult<Option<ArtifactReceipt>> {
		validate_relative(&spec.path)?;
		let candidate = self.root.join(&spec.path);
		match fs::symlink_metadata(&candidate) {
			Ok(_) => self
				.verify_candidate(&candidate, spec, cancel)
				.map(|artifact| Some(artifact.receipt)),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
			Err(source) => Err(io_error(ArtifactIoOperation::Metadata, source)),
		}
	}

	fn partial_len(&self, spec: &ArtifactSpec) -> ArtifactResult<u64> {
		validate_relative(&spec.path)?;
		let part = sidecar_path(&self.root.join(&spec.path));
		match fs::symlink_metadata(&part) {
			Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
				Err(ArtifactError::NotRegularFile)
			},
			Ok(metadata) if metadata.len() > spec.bytes => Ok(0),
			Ok(metadata) => Ok(metadata.len()),
			Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(0),
			Err(source) => Err(io_error(ArtifactIoOperation::Metadata, source)),
		}
	}

	fn verify_candidate(
		&self,
		candidate: &Path,
		spec: &ArtifactSpec,
		cancel: &LocalCancellation,
	) -> ArtifactResult<VerifiedArtifact> {
		if cancelled(cancel) {
			return Err(ArtifactError::Cancelled);
		}
		let metadata = fs::symlink_metadata(candidate)
			.map_err(|source| io_error(ArtifactIoOperation::Metadata, source))?;
		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err(ArtifactError::NotRegularFile);
		}
		let canonical = fs::canonicalize(candidate)
			.map_err(|source| io_error(ArtifactIoOperation::Canonicalize, source))?;
		if !canonical.starts_with(&self.root) {
			return Err(ArtifactError::EscapesRoot);
		}
		if metadata.len() != spec.bytes {
			return Err(ArtifactError::LengthMismatch {
				expected: spec.bytes,
				observed: metadata.len(),
			});
		}
		let mut file =
			File::open(&canonical).map_err(|source| io_error(ArtifactIoOperation::Open, source))?;
		let opened = file
			.metadata()
			.map_err(|source| io_error(ArtifactIoOperation::Metadata, source))?;
		if !same_file(&metadata, &opened) {
			return Err(ArtifactError::ChangedWhileOpening);
		}
		let mut context = Sha256::new();
		let mut buffer = vec![0_u8; 64 * 1024];
		loop {
			if cancelled(cancel) {
				return Err(ArtifactError::Cancelled);
			}
			let read = file
				.read(&mut buffer)
				.map_err(|source| io_error(ArtifactIoOperation::Read, source))?;
			if read == 0 {
				break;
			}
			context.update(&buffer[..read]);
		}
		let observed: [u8; 32] = context.finalize().into();
		if observed != spec.sha256 {
			return Err(ArtifactError::ChecksumMismatch);
		}
		file
			.seek(SeekFrom::Start(0))
			.map_err(|source| io_error(ArtifactIoOperation::Seek, source))?;
		Ok(VerifiedArtifact {
			file,
			receipt: ArtifactReceipt { path: canonical, bytes: opened.len(), sha256: observed },
		})
	}

	fn ensure_parent(&self, relative: &Path) -> ArtifactResult<()> {
		validate_relative(relative)?;
		let mut parent = self.root.clone();
		let Some(components) = relative.parent() else {
			return Ok(());
		};
		for component in components.components() {
			let Component::Normal(component) = component else {
				return Err(ArtifactError::InvalidPath);
			};
			parent.push(component);
			match fs::symlink_metadata(&parent) {
				Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
					return Err(ArtifactError::NotRegularFile);
				},
				Ok(_) => {},
				Err(source) if source.kind() == io::ErrorKind::NotFound => fs::create_dir(&parent)
					.map_err(|source| io_error(ArtifactIoOperation::CreateDirectory, source))?,
				Err(source) => return Err(io_error(ArtifactIoOperation::Metadata, source)),
			}
			let canonical = fs::canonicalize(&parent)
				.map_err(|source| io_error(ArtifactIoOperation::Canonicalize, source))?;
			if !canonical.starts_with(&self.root) {
				return Err(ArtifactError::EscapesRoot);
			}
		}
		Ok(())
	}

	fn promote(
		&self,
		part: &Path,
		spec: &ArtifactSpec,
		cancel: &LocalCancellation,
	) -> ArtifactResult<ArtifactReceipt> {
		if cancelled(cancel) {
			return Err(ArtifactError::Cancelled);
		}
		let verified = self.verify_candidate(part, spec, cancel)?;
		if cancelled(cancel) {
			return Err(ArtifactError::Cancelled);
		}
		let final_path = self.root.join(&spec.path);
		atomic_replace(part, &final_path)?;
		if let Some(parent) = final_path.parent() {
			sync_directory(parent)?;
		}
		let mut receipt = verified.receipt;
		receipt.path = fs::canonicalize(&final_path)
			.map_err(|source| io_error(ArtifactIoOperation::Canonicalize, source))?;
		Ok(receipt)
	}
}

static DOWNLOAD_LOCKS: LazyLock<ParkingMutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
	LazyLock::new(|| ParkingMutex::new(HashMap::new()));

fn shared_download_lock(root: &Path) -> Arc<Mutex<()>> {
	let mut locks = DOWNLOAD_LOCKS.lock();
	locks.retain(|_, lock| lock.strong_count() != 0);
	if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
		return lock;
	}
	let lock = Arc::new(Mutex::new(()));
	locks.insert(root.to_owned(), Arc::downgrade(&lock));
	lock
}

fn validate_relative(path: &Path) -> ArtifactResult<()> {
	if path.as_os_str().is_empty()
		|| path.is_absolute()
		|| path
			.components()
			.any(|component| !matches!(component, Component::Normal(_)))
	{
		return Err(ArtifactError::InvalidPath);
	}
	Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> ArtifactResult<()> {
	File::open(path)
		.and_then(|directory| directory.sync_all())
		.map_err(|source| io_error(ArtifactIoOperation::Sync, source))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> ArtifactResult<()> {
	Ok(())
}

fn cancelled(cancel: &LocalCancellation) -> bool {
	cancel.is_cancelled()
}

fn sidecar_path(path: &Path) -> PathBuf {
	let mut name: OsString = path.as_os_str().to_owned();
	name.push(".part");
	PathBuf::from(name)
}

fn resize_partial(path: &Path, bytes: u64) -> ArtifactResult<()> {
	let file = OpenOptions::new()
		.create(true)
		.write(true)
		.truncate(false)
		.open(path)
		.map_err(|source| io_error(ArtifactIoOperation::Open, source))?;
	file
		.set_len(bytes)
		.map_err(|source| io_error(ArtifactIoOperation::Truncate, source))?;
	Ok(())
}

fn open_partial(path: &Path, append: bool) -> ArtifactResult<File> {
	let mut options = OpenOptions::new();
	options
		.create(true)
		.write(true)
		.append(append)
		.truncate(!append);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		options.custom_flags(libc::O_NOFOLLOW);
	}
	options
		.open(path)
		.map_err(|source| io_error(ArtifactIoOperation::Open, source))
}

#[cfg(unix)]
fn same_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt as _;
	opened.is_file()
		&& opened.len() == before.len()
		&& opened.dev() == before.dev()
		&& opened.ino() == before.ino()
}

#[cfg(not(unix))]
fn same_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
	opened.is_file()
		&& opened.len() == before.len()
		&& opened.modified().ok() == before.modified().ok()
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> ArtifactResult<()> {
	fs::rename(source, destination).map_err(|source| io_error(ArtifactIoOperation::Promote, source))
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> ArtifactResult<()> {
	use std::os::windows::ffi::OsStrExt as _;

	#[link(name = "Kernel32")]
	unsafe extern "system" {
		fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
	}
	const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
	const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
	let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
	let destination: Vec<u16> = destination
		.as_os_str()
		.encode_wide()
		.chain(Some(0))
		.collect();
	// SAFETY: both buffers are NUL-terminated and remain alive through the call.
	let result = unsafe {
		MoveFileExW(
			source.as_ptr(),
			destination.as_ptr(),
			MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
		)
	};
	if result == 0 {
		Err(io_error(ArtifactIoOperation::Promote, io::Error::last_os_error()))
	} else {
		Ok(())
	}
}

const fn io_error(operation: ArtifactIoOperation, source: io::Error) -> ArtifactError {
	ArtifactError::Io { operation, source }
}

/// Open file proven to match its declared immutable identity.
pub struct VerifiedArtifact {
	file:    File,
	receipt: ArtifactReceipt,
}

impl VerifiedArtifact {
	/// Borrows the verified open file, positioned at byte zero.
	pub const fn file(&self) -> &File {
		&self.file
	}

	/// Returns verification evidence.
	pub const fn receipt(&self) -> &ArtifactReceipt {
		&self.receipt
	}

	/// Returns the canonical verified file path for engines requiring a path.
	pub fn path(&self) -> &Path {
		&self.receipt.path
	}
}

impl fmt::Debug for VerifiedArtifact {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("VerifiedArtifact")
			.field("receipt", &self.receipt)
			.finish()
	}
}

type ArtifactHttpClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;

/// Pooled rustls HTTP(S) fetcher for public model artifacts.
#[derive(Clone)]
pub struct SystemArtifactFetcher {
	inner: ArtifactHttpClient,
}

impl SystemArtifactFetcher {
	/// Constructs a pooled HTTP/1.1 and HTTP/2 artifact fetcher.
	pub fn new() -> Self {
		let _ = ring::default_provider().install_default();
		let connector = HttpsConnectorBuilder::new()
			.with_webpki_roots()
			.https_or_http()
			.enable_http1()
			.enable_http2()
			.build();
		Self { inner: Client::builder(TokioExecutor::new()).build(connector) }
	}
}

impl Default for SystemArtifactFetcher {
	fn default() -> Self {
		Self::new()
	}
}

impl fmt::Debug for SystemArtifactFetcher {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("SystemArtifactFetcher(..)")
	}
}

impl ArtifactFetcher for SystemArtifactFetcher {
	type Body = SystemArtifactBody;

	type FetchFuture<'a> =
		impl Future<Output = ArtifactResult<ArtifactFetchResponse<Self::Body>>> + Send + 'a;

	fn fetch(&self, request: ArtifactFetchRequest) -> Self::FetchFuture<'_> {
		async move {
			let mut url = Url::parse(request.source.as_str())
				.map_err(|source| ArtifactError::InvalidUrl { source })?;
			for redirect in 0..=5 {
				let uri: http::Uri = url
					.as_str()
					.parse()
					.map_err(|source| ArtifactError::InvalidHttpUri { source })?;
				let mut outbound = Request::get(uri)
					.body(Empty::<Bytes>::new())
					.expect("GET request with a parsed URI is valid");
				if request.offset != 0 {
					let range = sf!("bytes={}-", request.offset);
					outbound.headers_mut().insert(
						RANGE,
						range
							.as_str()
							.parse()
							.map_err(|_| ArtifactError::InvalidContentRange)?,
					);
				}
				let response = self
					.inner
					.request(outbound)
					.await
					.map_err(|source| ArtifactError::HttpRequest { source })?;
				if response.status().is_redirection() {
					if redirect == 5 {
						return Err(ArtifactError::TooManyRedirects);
					}
					let location = response
						.headers()
						.get(LOCATION)
						.and_then(|value| value.to_str().ok())
						.ok_or(ArtifactError::InvalidRedirect)?;
					url = url
						.join(location)
						.map_err(|source| ArtifactError::InvalidUrl { source })?;
					continue;
				}
				let status = response.status();
				if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
					return Err(ArtifactError::HttpStatus { status: status.as_u16() });
				}
				let (accepted_offset, total_bytes) =
					response_range(status, response.headers(), request.expected_bytes)?;
				return Ok(ArtifactFetchResponse {
					accepted_offset,
					total_bytes,
					body: SystemArtifactBody { inner: response.into_body() },
				});
			}
			Err(ArtifactError::TooManyRedirects)
		}
	}
}

pin_project_lite::pin_project! {
	/// Streaming body returned by [`SystemArtifactFetcher`].
	pub struct SystemArtifactBody {
		#[pin]
		inner: Incoming,
	}
}

impl Stream for SystemArtifactBody {
	type Item = ArtifactResult<Bytes>;

	fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		let mut this = self.project();
		loop {
			let frame = ready!(this.inner.as_mut().poll_frame(context));
			match frame {
				Some(Ok(frame)) => match frame.into_data() {
					Ok(data) if data.is_empty() => continue,
					Ok(data) => return Poll::Ready(Some(Ok(data))),
					Err(_) => continue,
				},
				Some(Err(source)) => return Poll::Ready(Some(Err(ArtifactError::HttpBody { source }))),
				None => return Poll::Ready(None),
			}
		}
	}
}

fn response_range(
	status: StatusCode,
	headers: &http::HeaderMap,
	expected: u64,
) -> ArtifactResult<(u64, u64)> {
	if status == StatusCode::OK {
		let total = headers
			.get(CONTENT_LENGTH)
			.and_then(|value| value.to_str().ok())
			.and_then(|value| value.parse::<u64>().ok())
			.unwrap_or(expected);
		return Ok((0, total));
	}
	let content_range = headers
		.get(CONTENT_RANGE)
		.and_then(|value| value.to_str().ok())
		.ok_or(ArtifactError::InvalidContentRange)?;
	let range = content_range
		.strip_prefix("bytes ")
		.ok_or(ArtifactError::InvalidContentRange)?;
	let (bounds, total) = range
		.split_once('/')
		.ok_or(ArtifactError::InvalidContentRange)?;
	let (start, end) = bounds
		.split_once('-')
		.ok_or(ArtifactError::InvalidContentRange)?;
	let start = start
		.parse::<u64>()
		.map_err(|_| ArtifactError::InvalidContentRange)?;
	let end = end
		.parse::<u64>()
		.map_err(|_| ArtifactError::InvalidContentRange)?;
	let total = total
		.parse::<u64>()
		.map_err(|_| ArtifactError::InvalidContentRange)?;
	if end < start || end >= total {
		return Err(ArtifactError::InvalidContentRange);
	}
	Ok((start, total))
}

#[cfg(test)]
mod tests {
	use std::{
		future::{Ready, ready},
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		vec,
	};

	use futures::stream;
	use parking_lot::Mutex as ParkingMutex;
	use sha2::Sha256;
	use tempfile::tempdir;

	use super::*;

	#[derive(Clone)]
	struct FixtureFetcher {
		bytes:       Arc<Vec<u8>>,
		requests:    Arc<ParkingMutex<Vec<ArtifactFetchRequest>>>,
		fetch_count: Arc<AtomicUsize>,
		replace:     bool,
	}

	impl ArtifactFetcher for FixtureFetcher {
		type Body = stream::Iter<vec::IntoIter<ArtifactResult<Bytes>>>;
		type FetchFuture<'a> = Ready<ArtifactResult<ArtifactFetchResponse<Self::Body>>>;

		fn fetch(&self, request: ArtifactFetchRequest) -> Self::FetchFuture<'_> {
			self.fetch_count.fetch_add(1, Ordering::SeqCst);
			self.requests.lock().push(request.clone());
			let accepted_offset = if self.replace { 0 } else { request.offset };
			let body = self.bytes[accepted_offset as usize..]
				.chunks(2)
				.map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
				.collect::<Vec<_>>();
			ready(Ok(ArtifactFetchResponse {
				accepted_offset,
				total_bytes: self.bytes.len() as u64,
				body: stream::iter(body),
			}))
		}
	}

	fn fixture_manifest(path: &str, contents: &[u8]) -> ArtifactManifest {
		ArtifactManifest::new("fixture", vec![ArtifactShard {
			spec:   ArtifactSpec {
				path:   path.into(),
				bytes:  contents.len() as u64,
				sha256: Sha256::digest(contents).into(),
			},
			source: Str::from("https://fixtures.invalid/model"),
		}])
		.expect("valid fixture manifest")
	}

	fn fixture_shard(path: &str, contents: &[u8]) -> ArtifactShard {
		let mut manifest = fixture_manifest(path, contents);
		manifest.shards.remove(0)
	}
	#[test]
	fn manifest_rejects_duplicate_paths_and_unsafe_sources() {
		let contents = b"model";
		let shard = fixture_shard("model.bin", contents);
		assert!(matches!(
			ArtifactManifest::new("duplicate", vec![shard.clone(), shard]),
			Err(ArtifactError::DuplicatePath { .. })
		));
		let invalid = ArtifactShard {
			source: Str::from("file:///tmp/model"),
			..fixture_shard("model.bin", contents)
		};
		assert!(matches!(
			ArtifactManifest::new("unsafe", vec![invalid]),
			Err(ArtifactError::InvalidSource)
		));
	}

	#[tokio::test]
	async fn cancellation_keeps_sidecar_and_retry_resumes_before_atomic_promotion() {
		let directory = tempdir().expect("temporary artifact root");
		let store = ArtifactStore::open(directory.path()).expect("artifact store");
		let bytes = Arc::new(b"abcdefgh".to_vec());
		let manifest = fixture_manifest("model.bin", &bytes);
		let requests = Arc::new(ParkingMutex::new(Vec::new()));
		let fetcher = FixtureFetcher {
			bytes:       bytes.clone(),
			requests:    requests.clone(),
			fetch_count: Arc::new(AtomicUsize::new(0)),
			replace:     false,
		};
		let cancel = LocalCancellation::new();
		let cancel_after_chunk = cancel.clone();
		let result = store
			.acquire(&manifest, &fetcher, &cancel, move |progress| {
				if progress.downloaded_bytes >= 2 {
					cancel_after_chunk.cancel();
				}
			})
			.await;
		assert!(matches!(result, Err(ArtifactError::Cancelled)));
		assert!(!directory.path().join("model.bin").exists());
		assert_eq!(fs::read(directory.path().join("model.bin.part")).unwrap(), b"ab");

		store
			.acquire(&manifest, &fetcher, &LocalCancellation::new(), |_| {})
			.await
			.expect("resumed acquisition");
		assert_eq!(fs::read(directory.path().join("model.bin")).unwrap(), bytes.as_slice());
		assert!(!directory.path().join("model.bin.part").exists());
		assert_eq!(requests.lock()[1].offset, 2);
	}

	#[tokio::test]
	async fn server_restart_replaces_partial_and_progress_never_decreases() {
		let directory = tempdir().expect("temporary artifact root");
		fs::write(directory.path().join("model.bin.part"), b"abc").unwrap();
		let store = ArtifactStore::open(directory.path()).expect("artifact store");
		let bytes = Arc::new(b"abcdefgh".to_vec());
		let manifest = fixture_manifest("model.bin", &bytes);
		let fetcher = FixtureFetcher {
			bytes,
			requests: Arc::new(ParkingMutex::new(Vec::new())),
			fetch_count: Arc::new(AtomicUsize::new(0)),
			replace: true,
		};
		let mut updates = Vec::new();
		store
			.acquire(&manifest, &fetcher, &LocalCancellation::new(), |progress| {
				updates.push(progress.downloaded_bytes);
			})
			.await
			.expect("replacement acquisition");
		assert!(updates.windows(2).all(|pair| pair[0] <= pair[1]));
		assert_eq!(updates.last().copied(), Some(8));
	}

	#[tokio::test]
	async fn concurrent_store_clones_share_one_download_and_only_publish_verified_bytes() {
		let directory = tempdir().expect("temporary artifact root");
		let store = ArtifactStore::open(directory.path()).expect("artifact store");
		let bytes = Arc::new(b"concurrent artifact".to_vec());
		let manifest = Arc::new(fixture_manifest("model.bin", &bytes));
		let fetch_count = Arc::new(AtomicUsize::new(0));
		let fetcher = Arc::new(FixtureFetcher {
			bytes:       bytes.clone(),
			requests:    Arc::new(ParkingMutex::new(Vec::new())),
			fetch_count: fetch_count.clone(),
			replace:     false,
		});
		let first = {
			let store = store.clone();
			let manifest = manifest.clone();
			let fetcher = fetcher.clone();
			tokio::spawn(async move {
				store
					.acquire(&manifest, fetcher.as_ref(), &LocalCancellation::new(), |_| {})
					.await
			})
		};
		let independently_opened_store =
			ArtifactStore::open(directory.path()).expect("second artifact store");
		let second = {
			let store = independently_opened_store;
			let manifest = manifest.clone();
			let fetcher = fetcher.clone();
			tokio::spawn(async move {
				store
					.acquire(&manifest, fetcher.as_ref(), &LocalCancellation::new(), |_| {})
					.await
			})
		};
		first.await.unwrap().expect("first acquisition");
		second.await.unwrap().expect("second acquisition");
		assert_eq!(fetch_count.load(Ordering::SeqCst), 1);
		assert_eq!(fs::read(directory.path().join("model.bin")).unwrap(), bytes.as_slice());
	}

	#[tokio::test]
	async fn multi_shard_progress_is_aggregate_and_monotonic() {
		let directory = tempdir().expect("temporary artifact root");
		let store = ArtifactStore::open(directory.path()).expect("artifact store");
		let first = b"abcd";
		let second = b"efgh";
		let manifest = ArtifactManifest::new("sharded", vec![
			ArtifactShard {
				spec:   ArtifactSpec {
					path:   "first.bin".into(),
					bytes:  first.len() as u64,
					sha256: Sha256::digest(first).into(),
				},
				source: Str::from("https://fixtures.invalid/model"),
			},
			ArtifactShard {
				spec:   ArtifactSpec {
					path:   "second.bin".into(),
					bytes:  second.len() as u64,
					sha256: Sha256::digest(second).into(),
				},
				source: Str::from("https://fixtures.invalid/model"),
			},
		])
		.unwrap();
		// Give the second shard a distinct source-selected fixture.
		let mut manifest = manifest;
		manifest.shards[1].source = Str::from("https://fixtures.invalid/model?second");
		struct TwoFetcher;
		impl ArtifactFetcher for TwoFetcher {
			type Body = stream::Iter<vec::IntoIter<ArtifactResult<Bytes>>>;
			type FetchFuture<'a> = Ready<ArtifactResult<ArtifactFetchResponse<Self::Body>>>;

			fn fetch(&self, request: ArtifactFetchRequest) -> Self::FetchFuture<'_> {
				let bytes = if request.source.as_str().contains("second") {
					b"efgh"
				} else {
					b"abcd"
				};
				ready(Ok(ArtifactFetchResponse {
					accepted_offset: request.offset,
					total_bytes:     4,
					body:            stream::iter(vec![Ok(Bytes::copy_from_slice(bytes))]),
				}))
			}
		}
		let mut updates = Vec::new();
		store
			.acquire(&manifest, &TwoFetcher, &LocalCancellation::new(), |progress| {
				updates.push(progress.downloaded_bytes);
			})
			.await
			.expect("sharded acquisition");
		assert!(updates.windows(2).all(|pair| pair[0] <= pair[1]));
		assert_eq!(updates.last().copied(), Some(8));
	}
}
