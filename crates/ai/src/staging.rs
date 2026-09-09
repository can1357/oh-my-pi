//! Explicit, bounded, cancellable request-body staging.

use std::{
	collections::VecDeque,
	fmt,
	fs::{File as StdFile, OpenOptions as StdOpenOptions},
	future::Future,
	io::{Read as _, Seek as _, SeekFrom, Write as _},
	mem,
	path::PathBuf,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::{StreamExt as _, stream};
use omp_core::{Str, sf};
use parking_lot::Mutex;
use ring::{
	aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
	hkdf,
	rand::{SecureRandom as _, SystemRandom},
};
use tempfile::TempPath;
use tokio::{
	fs::{File as TokioFile, OpenOptions as TokioOpenOptions},
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	sync::Notify,
};
use zeroize::{Zeroize as _, Zeroizing};

use crate::{
	answer::{Artifact, ArtifactBody, ArtifactRef, Digest, DigestAlgorithm, ResponseMeta},
	body::{BodyFactory, BodyFactoryHandle, BodyOpenError, BodySource, ByteStream, Replayability},
	call::OpaqueJson,
	catalog::{ModelKey, ProviderId, RouteId},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, Completion, FinishReason, ToolCall, UsageUpdate},
	gate::{GateSpoolError, SecureGateSpool},
	id::{RequestId, ToolCallId},
	receipt::{
		ExecutionBudget, ExecutionReceipt, ReasonId, StagingEncryption, StagingEncryptionAlgorithm,
		StagingKeySource, StagingReceipt, StagingStorage, Usage, UsageSource,
	},
};

const FILE_MAGIC: [u8; 8] = *b"OMPSTG01";
const FILE_HEADER_LEN: usize = FILE_MAGIC.len();
const TAG_LEN: usize = 16;
const DEFAULT_CHUNK_BYTES: usize = 64 * 1024;
const MAX_CHUNK_BYTES: usize = 16 * 1024 * 1024;

/// A zeroizing 256-bit key used only for authenticated temporary staging.
pub struct StagingKey(Zeroizing<[u8; 32]>);

impl StagingKey {
	/// Wraps key material, transferring it into zeroizing storage.
	pub fn new(bytes: [u8; 32]) -> Self {
		Self(Zeroizing::new(bytes))
	}

	fn copy_bytes(&self) -> Zeroizing<[u8; 32]> {
		Zeroizing::new(*self.0)
	}
}

impl Clone for StagingKey {
	fn clone(&self) -> Self {
		Self(self.copy_bytes())
	}
}

impl fmt::Debug for StagingKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("StagingKey([REDACTED])")
	}
}

/// Adapter implemented by an operating-system credential facility.
pub trait OperatingSystemStagingKey: Send + Sync + 'static {
	/// Derives or loads the staging key without exposing it outside zeroizing
	/// storage.
	fn load_staging_key(&self) -> Result<StagingKey, StagingKeyUnavailable>;
}

/// Typed evidence that an operating-system staging key could not be obtained.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("secure staging key is unavailable")]
pub struct StagingKeyUnavailable;

/// Explicit source of temporary-file encryption key material.
#[derive(Clone)]
pub enum StagingKeyProvider {
	/// Key material was supplied directly by the caller.
	CallerProvided(StagingKey),
	/// Key material is derived by an operating-system credential adapter.
	OperatingSystem(Arc<dyn OperatingSystemStagingKey>),
}

impl StagingKeyProvider {
	fn load(&self) -> Result<(StagingKey, StagingKeySource), StagingKeyUnavailable> {
		match self {
			Self::CallerProvided(key) => Ok((key.clone(), StagingKeySource::CallerProvided)),
			Self::OperatingSystem(provider) => provider
				.load_staging_key()
				.map(|key| (key, StagingKeySource::OperatingSystem)),
		}
	}
}

impl fmt::Debug for StagingKeyProvider {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::CallerProvided(_) => formatter.write_str("CallerProvided([REDACTED])"),
			Self::OperatingSystem(_) => formatter.write_str("OperatingSystem([REDACTED])"),
		}
	}
}

/// Explicit bounds and storage choices for one staging operation.
#[derive(Clone, Debug)]
pub struct StagingPolicy {
	max_bytes:        u64,
	memory_threshold: u64,
	chunk_bytes:      usize,
	temp_directory:   Option<PathBuf>,
	key_provider:     Option<StagingKeyProvider>,
}

impl StagingPolicy {
	/// Creates a memory-only policy; crossing `memory_threshold` fails rather
	/// than spilling plaintext.
	pub const fn memory_only(max_bytes: u64, memory_threshold: u64) -> Self {
		Self {
			max_bytes,
			memory_threshold,
			chunk_bytes: DEFAULT_CHUNK_BYTES,
			temp_directory: None,
			key_provider: None,
		}
	}

	/// Creates a policy that migrates the complete body to
	/// authenticated-encrypted temporary storage.
	pub const fn encrypted_spill(
		max_bytes: u64,
		memory_threshold: u64,
		key_provider: StagingKeyProvider,
	) -> Self {
		Self {
			max_bytes,
			memory_threshold,
			chunk_bytes: DEFAULT_CHUNK_BYTES,
			temp_directory: None,
			key_provider: Some(key_provider),
		}
	}

	/// Selects the temporary directory used after the memory threshold is
	/// crossed.
	pub fn with_temp_directory(mut self, directory: impl Into<PathBuf>) -> Self {
		self.temp_directory = Some(directory.into());
		self
	}

	/// Selects the independently authenticated plaintext chunk size.
	pub fn with_chunk_bytes(mut self, chunk_bytes: usize) -> Result<Self, StagingPolicyError> {
		if !(1..=MAX_CHUNK_BYTES).contains(&chunk_bytes) {
			return Err(StagingPolicyError::InvalidChunkBytes {
				provided: chunk_bytes,
				maximum:  MAX_CHUNK_BYTES,
			});
		}
		self.chunk_bytes = chunk_bytes;
		Ok(self)
	}

	/// Returns the policy's absolute byte bound.
	pub const fn max_bytes(&self) -> u64 {
		self.max_bytes
	}

	/// Returns the in-memory threshold before encrypted spill is required.
	pub const fn memory_threshold(&self) -> u64 {
		self.memory_threshold
	}
}

/// Typed staging policy validation failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum StagingPolicyError {
	/// The authenticated plaintext chunk size was zero or exceeded the
	/// implementation bound.
	#[error("staging chunk size {provided} is outside 1..={maximum}")]
	InvalidChunkBytes {
		/// Rejected caller value.
		provided: usize,
		/// Largest accepted chunk size.
		maximum:  usize,
	},
}

/// Cloneable cancellation signal shared by staging and every staged reader.
#[derive(Clone, Debug, Default)]
pub struct StagingCancellation(Arc<CancellationInner>);

#[derive(Debug, Default)]
struct CancellationInner {
	cancelled:   AtomicBool,
	notify:      Notify,
	staged:      Mutex<Vec<Weak<StagedState>>>,
	gate_spools: Mutex<Vec<Weak<GateSpoolState>>>,
}

impl StagingCancellation {
	/// Creates a live cancellation signal.
	pub fn new() -> Self {
		Self::default()
	}

	/// Cancels staging, invalidates completed factories, zeroizes retained
	/// state, and deletes spill files.
	pub fn cancel(&self) {
		if self.0.cancelled.swap(true, Ordering::AcqRel) {
			return;
		}
		self.0.notify.notify_waiters();
		let staged = mem::take(&mut *self.0.staged.lock());
		for state in staged {
			if let Some(state) = state.upgrade() {
				state.invalidate();
			}
		}
		let gate_spools = mem::take(&mut *self.0.gate_spools.lock());
		for state in gate_spools {
			if let Some(state) = state.upgrade() {
				state.invalidate();
			}
		}
	}

	/// Reports whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.0.cancelled.load(Ordering::Acquire)
	}

	async fn cancelled(&self) {
		let notified = self.0.notify.notified();
		tokio::pin!(notified);
		if self.is_cancelled() {
			return;
		}
		notified.await;
	}

	fn register(&self, state: &Arc<StagedState>) {
		if self.is_cancelled() {
			state.invalidate();
			return;
		}
		self.0.staged.lock().push(Arc::downgrade(state));
		if self.is_cancelled() {
			state.invalidate();
		}
	}

	fn register_gate_spool(&self, state: &Arc<GateSpoolState>) {
		if self.is_cancelled() {
			state.invalidate();
			return;
		}
		self.0.gate_spools.lock().push(Arc::downgrade(state));
		if self.is_cancelled() {
			state.invalidate();
		}
	}
}

/// Request class considered by semantic-retry staging planning.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StagingInputKind {
	/// A finite attachment consumed by a semantic attempt.
	Attachment,
	/// Image, video, or other potentially large media input.
	Media,
	/// Live microphone or realtime audio input.
	LiveAudio,
}

/// Side-effect-free staging decision for a semantic-retry plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StagingDecision {
	/// The original source is already replayable and staging is unnecessary.
	NotNeeded,
	/// The caller explicitly supplied a policy and the planner must stage before
	/// the first attempt.
	ExplicitlyStage,
	/// The one-shot input cannot participate in semantic retry without explicit
	/// caller consent.
	RejectOneShot,
}

/// Plans semantic-retry staging without reading or buffering the source.
pub const fn plan_semantic_retry_staging(
	replayability: Replayability,
	kind: StagingInputKind,
	explicit_policy: Option<&StagingPolicy>,
) -> StagingDecision {
	match (replayability, kind, explicit_policy.is_some()) {
		(Replayability::Replayable | Replayability::Staged, ..) => StagingDecision::NotNeeded,
		(
			Replayability::OneShot,
			StagingInputKind::Attachment | StagingInputKind::Media | StagingInputKind::LiveAudio,
			true,
		) => StagingDecision::ExplicitlyStage,
		(Replayability::OneShot, _, false) => StagingDecision::RejectOneShot,
	}
}

/// Replayable body factory produced only by an explicit staging call.
#[derive(Clone)]
pub struct StagedBody {
	state: Arc<StagedState>,
}

impl fmt::Debug for StagedBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("StagedBody")
			.field("bytes", &self.state.evidence.bytes)
			.field("storage", &self.state.evidence.storage)
			.finish_non_exhaustive()
	}
}

impl StagedBody {
	/// Returns secret-free receipt evidence for this completed staging
	/// operation.
	pub fn evidence(&self) -> &StagingReceipt {
		&self.state.evidence
	}

	/// Converts this staged factory into the canonical replayable body source.
	pub fn into_body_source(self) -> BodySource {
		BodySource::Factory(BodyFactoryHandle::staged(self))
	}
}

impl BodyFactory for StagedBody {
	type OpenFuture<'a> = impl Future<Output = Result<ByteStream, Error>> + Send + 'a;

	fn open(&self) -> Self::OpenFuture<'_> {
		async move { self.state.open().await }
	}
}

/// Explicitly stages a body under the caller's policy and execution budget.
pub async fn stage_body(
	source: &BodySource,
	policy: &StagingPolicy,
	budget: &ExecutionBudget,
	cancellation: &StagingCancellation,
	receipt: &mut ExecutionReceipt,
) -> Result<StagedBody, Error> {
	let started = Instant::now();
	if cancellation.is_cancelled() {
		return Err(finish_failure(
			receipt,
			staging_evidence(0, started, StagingStorage::Memory, None, false, true),
			staging_error(ErrorKind::Cancelled, "staging_cancelled", None),
		));
	}

	let mut attempt = source.begin_attempt();
	let mut input = match cancellable(cancellation, attempt.open()).await {
		Ok(result) => match result {
			Ok(stream) => stream,
			Err(BodyOpenError::Factory(mut error)) => {
				let evidence = staging_evidence(0, started, StagingStorage::Memory, None, false, false);
				receipt.staging.push(evidence);
				error.replace_receipt(receipt.clone());
				return Err(error);
			},
			Err(error) => {
				return Err(finish_failure(
					receipt,
					staging_evidence(0, started, StagingStorage::Memory, None, false, false),
					body_open_error(error),
				));
			},
		},
		Err(()) => {
			return Err(finish_failure(
				receipt,
				staging_evidence(0, started, StagingStorage::Memory, None, false, true),
				staging_error(ErrorKind::Cancelled, "staging_cancelled", None),
			));
		},
	};

	let already_charged = receipt
		.staging
		.iter()
		.fold(0_u64, |total, evidence| total.saturating_add(evidence.budget_charge));
	let budget_remaining = budget.max_staging_bytes.saturating_sub(already_charged);
	let effective_limit = policy.max_bytes.min(budget_remaining);
	let mut total = 0_u64;
	let mut memory = Zeroizing::new(Vec::new());
	let mut disk: Option<DiskBuilder> = None;

	loop {
		let next = cancellable(cancellation, input.next())
			.await
			.map_err(|()| {
				finish_failure(
					receipt,
					failed_evidence(total, started, disk.as_ref(), true),
					staging_error(ErrorKind::Cancelled, "staging_cancelled", None),
				)
			})?;
		let Some(next) = next else { break };
		let bytes = match next {
			Ok(bytes) => bytes,
			Err(mut error) => {
				let evidence = failed_evidence(total, started, disk.as_ref(), false);
				receipt.staging.push(evidence);
				error.replace_receipt(receipt.clone());
				return Err(error);
			},
		};
		let observed = total.saturating_add(bytes.len() as u64);
		if observed > effective_limit {
			let detail =
				ErrorDetail::budget(sf!("staging_bytes"), effective_limit as u128, observed as u128);
			return Err(finish_failure(
				receipt,
				failed_evidence(total, started, disk.as_ref(), false),
				staging_error(ErrorKind::BudgetExhausted, "staging_budget_exhausted", Some(detail)),
			));
		}

		if disk.is_none() && observed > policy.memory_threshold {
			let Some(provider) = &policy.key_provider else {
				return Err(finish_failure(
					receipt,
					failed_evidence(total, started, None, false),
					staging_error(ErrorKind::ResourceExhausted, "secure_staging_key_unavailable", None),
				));
			};
			let (key, key_source) = provider.load().map_err(|_| {
				finish_failure(
					receipt,
					failed_evidence(total, started, None, false),
					staging_error(ErrorKind::ResourceExhausted, "secure_staging_key_unavailable", None),
				)
			})?;
			let mut builder = match DiskBuilder::create(policy, key, key_source, cancellation).await {
				Ok(builder) => builder,
				Err(error) => {
					return Err(finish_failure(
						receipt,
						failed_evidence(total, started, None, cancellation.is_cancelled()),
						error,
					));
				},
			};
			if let Err(error) = builder.write_plaintext(&memory, cancellation).await {
				return Err(finish_failure(
					receipt,
					failed_evidence(total, started, Some(&builder), cancellation.is_cancelled()),
					error,
				));
			}
			memory.as_mut_slice().zeroize();
			memory.clear();
			disk = Some(builder);
		}

		if let Some(builder) = &mut disk {
			if let Err(error) = builder.write_plaintext(&bytes, cancellation).await {
				return Err(finish_failure(
					receipt,
					failed_evidence(total, started, Some(builder), cancellation.is_cancelled()),
					error,
				));
			}
		} else {
			memory.extend_from_slice(&bytes);
		}
		total = observed;
	}

	if cancellation.is_cancelled() {
		return Err(finish_failure(
			receipt,
			failed_evidence(total, started, disk.as_ref(), true),
			staging_error(ErrorKind::Cancelled, "staging_cancelled", None),
		));
	}

	let (storage, encryption, staged_storage) = if let Some(mut builder) = disk {
		if let Err(error) = builder.finish(cancellation).await {
			return Err(finish_failure(
				receipt,
				failed_evidence(total, started, Some(&builder), cancellation.is_cancelled()),
				error,
			));
		}
		let encryption = builder.encryption_evidence();
		(
			StagingStorage::EncryptedTemporaryFile,
			Some(encryption),
			StoredStage::Disk(builder.into_storage()),
		)
	} else {
		(StagingStorage::Memory, None, StoredStage::Memory(memory))
	};
	let evidence = staging_evidence(total, started, storage, encryption, true, false);
	let state = Arc::new(StagedState {
		storage:   Mutex::new(Some(staged_storage)),
		cancelled: AtomicBool::new(false),
		evidence:  evidence.clone(),
	});
	cancellation.register(&state);
	if state.cancelled.load(Ordering::Acquire) {
		return Err(finish_failure(
			receipt,
			StagingReceipt { completed: false, cancelled: true, ..evidence },
			staging_error(ErrorKind::Cancelled, "staging_cancelled", None),
		));
	}
	receipt.staging.push(evidence);
	Ok(StagedBody { state })
}

async fn cancellable<F: Future>(
	cancellation: &StagingCancellation,
	future: F,
) -> Result<F::Output, ()> {
	tokio::select! {
		biased;
		() = cancellation.cancelled() => Err(()),
		output = future => Ok(output),
	}
}

fn staging_evidence(
	bytes: u64,
	started: Instant,
	storage: StagingStorage,
	encryption: Option<StagingEncryption>,
	completed: bool,
	cancelled: bool,
) -> StagingReceipt {
	StagingReceipt {
		bytes,
		elapsed: started.elapsed(),
		storage,
		encryption,
		completed,
		cancelled,
		budget_charge: bytes,
	}
}

fn failed_evidence(
	bytes: u64,
	started: Instant,
	disk: Option<&DiskBuilder>,
	cancelled: bool,
) -> StagingReceipt {
	match disk {
		Some(disk) => staging_evidence(
			bytes,
			started,
			StagingStorage::EncryptedTemporaryFile,
			Some(disk.encryption_evidence()),
			false,
			cancelled,
		),
		None => staging_evidence(bytes, started, StagingStorage::Memory, None, false, cancelled),
	}
}

fn finish_failure(
	receipt: &mut ExecutionReceipt,
	evidence: StagingReceipt,
	mut error: Error,
) -> Error {
	receipt.staging.push(evidence);
	error.replace_receipt(receipt.clone());
	error
}

fn staging_error(kind: ErrorKind, code: &'static str, detail: Option<ErrorDetail>) -> Error {
	let error =
		Error::new(kind, ErrorPhase::Artifact, RetryAction::Never, ExecutionReceipt::default())
			.code(Str::new(code));
	match detail {
		Some(detail) => error.detail(detail),
		None => error,
	}
}

fn body_open_error(error: BodyOpenError) -> Error {
	let code = match error {
		BodyOpenError::AttemptAlreadyOpened => "staging_body_attempt_already_opened",
		BodyOpenError::ConcurrentReader => "staging_body_concurrent_reader",
		BodyOpenError::Consumed => "staging_body_consumed",
		BodyOpenError::ReacquisitionUnavailable => "staging_body_reacquisition_unavailable",
		BodyOpenError::Factory(error) => return error,
	};
	staging_error(ErrorKind::InvalidRequest, code, None)
}

fn io_error(code: &'static str) -> Error {
	staging_error(ErrorKind::ResourceExhausted, code, None)
}

struct DiskBuilder {
	path:            TempPath,
	file:            TokioFile,
	key:             StagingKey,
	key_source:      StagingKeySource,
	chunk_count:     u64,
	plaintext_bytes: u64,
	chunk_bytes:     usize,
}

impl DiskBuilder {
	async fn create(
		policy: &StagingPolicy,
		key: StagingKey,
		key_source: StagingKeySource,
		cancellation: &StagingCancellation,
	) -> Result<Self, Error> {
		let named = match &policy.temp_directory {
			Some(directory) => tempfile::Builder::new()
				.prefix("omp-llm-stage-")
				.tempfile_in(directory),
			None => tempfile::Builder::new().prefix("omp-llm-stage-").tempfile(),
		}
		.map_err(|_| io_error("secure_staging_create_failed"))?;
		let path = named.into_temp_path();
		let file = cancellable(
			cancellation,
			TokioOpenOptions::new()
				.write(true)
				.truncate(true)
				.open(&path),
		)
		.await
		.map_err(|()| staging_error(ErrorKind::Cancelled, "staging_cancelled", None))?
		.map_err(|_| io_error("secure_staging_open_failed"))?;
		let mut salt_bytes = Zeroizing::new([0_u8; 32]);
		SystemRandom::new()
			.fill(&mut *salt_bytes)
			.map_err(|_| io_error("secure_random_unavailable"))?;
		let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt_bytes[..]);
		let prk = salt.extract(&key.0[..]);
		let context = [b"omp-llm-secure-staging-v1".as_slice()];
		let output = prk
			.expand(&context, hkdf::HKDF_SHA256)
			.map_err(|_| io_error("secure_staging_key_derivation_failed"))?;
		let mut derived = [0_u8; 32];
		output
			.fill(&mut derived)
			.map_err(|_| io_error("secure_staging_key_derivation_failed"))?;
		drop(key);
		let mut builder = Self {
			path,
			file,
			key: StagingKey(Zeroizing::new(derived)),
			key_source,
			chunk_count: 0,
			plaintext_bytes: 0,
			chunk_bytes: policy.chunk_bytes,
		};
		builder.write_all(&FILE_MAGIC, cancellation).await?;
		Ok(builder)
	}

	async fn write_plaintext(
		&mut self,
		plaintext: &[u8],
		cancellation: &StagingCancellation,
	) -> Result<(), Error> {
		for chunk in plaintext.chunks(self.chunk_bytes) {
			let index = self.chunk_count;
			let mut sealed = Zeroizing::new(chunk.to_vec());
			let key = LessSafeKey::new(
				UnboundKey::new(&aead::CHACHA20_POLY1305, &self.key.0[..])
					.map_err(|_| io_error("secure_staging_cipher_unavailable"))?,
			);
			key.seal_in_place_append_tag(
				nonce(index),
				Aad::from(aad(index, chunk.len() as u32)),
				&mut *sealed,
			)
			.map_err(|_| io_error("secure_staging_encrypt_failed"))?;
			let sealed_len =
				u32::try_from(sealed.len()).map_err(|_| io_error("secure_staging_chunk_too_large"))?;
			self
				.write_all(&sealed_len.to_be_bytes(), cancellation)
				.await?;
			self.write_all(&sealed, cancellation).await?;
			self.chunk_count = self.chunk_count.saturating_add(1);
			self.plaintext_bytes = self.plaintext_bytes.saturating_add(chunk.len() as u64);
		}
		Ok(())
	}

	async fn write_all(
		&mut self,
		bytes: &[u8],
		cancellation: &StagingCancellation,
	) -> Result<(), Error> {
		cancellable(cancellation, self.file.write_all(bytes))
			.await
			.map_err(|()| staging_error(ErrorKind::Cancelled, "staging_cancelled", None))?
			.map_err(|_| io_error("secure_staging_write_failed"))
	}

	async fn finish(&mut self, cancellation: &StagingCancellation) -> Result<(), Error> {
		cancellable(cancellation, self.file.flush())
			.await
			.map_err(|()| staging_error(ErrorKind::Cancelled, "staging_cancelled", None))?
			.map_err(|_| io_error("secure_staging_flush_failed"))?;
		cancellable(cancellation, self.file.sync_all())
			.await
			.map_err(|()| staging_error(ErrorKind::Cancelled, "staging_cancelled", None))?
			.map_err(|_| io_error("secure_staging_sync_failed"))
	}

	const fn encryption_evidence(&self) -> StagingEncryption {
		StagingEncryption {
			algorithm:     StagingEncryptionAlgorithm::ChaCha20Poly1305,
			key_source:    self.key_source,
			authenticated: true,
			chunk_count:   self.chunk_count,
		}
	}

	fn into_storage(self) -> DiskStage {
		DiskStage {
			path:            self.path,
			key:             self.key,
			chunk_bytes:     self.chunk_bytes,
			chunk_count:     self.chunk_count,
			plaintext_bytes: self.plaintext_bytes,
		}
	}
}

enum StoredStage {
	Memory(Zeroizing<Vec<u8>>),
	Disk(DiskStage),
}

struct DiskStage {
	path:            TempPath,
	key:             StagingKey,
	chunk_bytes:     usize,
	chunk_count:     u64,
	plaintext_bytes: u64,
}

struct StagedState {
	storage:   Mutex<Option<StoredStage>>,
	cancelled: AtomicBool,
	evidence:  StagingReceipt,
}

impl StagedState {
	fn invalidate(&self) {
		self.cancelled.store(true, Ordering::Release);
		self.storage.lock().take();
	}

	fn attach_evidence(&self, mut error: Error) -> Error {
		let mut evidence = self.evidence.clone();
		if error.kind == ErrorKind::Cancelled {
			evidence.cancelled = true;
		}
		error.receipt_mut().staging.push(evidence);
		error
	}

	async fn open(self: &Arc<Self>) -> Result<ByteStream, Error> {
		if self.cancelled.load(Ordering::Acquire) {
			return Err(self.attach_evidence(staging_error(
				ErrorKind::Cancelled,
				"staged_body_cancelled",
				None,
			)));
		}
		let snapshot = {
			let storage = self.storage.lock();
			match storage.as_ref() {
				Some(StoredStage::Memory(_)) => StorageSnapshot::Memory,
				Some(StoredStage::Disk(disk)) => StorageSnapshot::Disk {
					path:            disk.path.to_path_buf(),
					key:             disk.key.clone(),
					chunk_bytes:     disk.chunk_bytes,
					chunk_count:     disk.chunk_count,
					plaintext_bytes: disk.plaintext_bytes,
				},
				None => {
					return Err(self.attach_evidence(staging_error(
						ErrorKind::Cancelled,
						"staged_body_cancelled",
						None,
					)));
				},
			}
		};
		match snapshot {
			StorageSnapshot::Memory => {
				let owner = Arc::clone(self);
				Ok(Box::pin(stream::try_unfold(Some(owner), |state| async move {
					let Some(owner) = state else { return Ok(None) };
					if owner.cancelled.load(Ordering::Acquire) {
						return Err(owner.attach_evidence(staging_error(
							ErrorKind::Cancelled,
							"staged_body_cancelled",
							None,
						)));
					}
					let bytes = {
						let storage = owner.storage.lock();
						match storage.as_ref() {
							Some(StoredStage::Memory(bytes)) => Bytes::copy_from_slice(bytes),
							_ => {
								return Err(owner.attach_evidence(staging_error(
									ErrorKind::Cancelled,
									"staged_body_cancelled",
									None,
								)));
							},
						}
					};
					if bytes.is_empty() {
						Ok(None)
					} else {
						Ok(Some((bytes, None)))
					}
				})))
			},
			StorageSnapshot::Disk { path, key, chunk_bytes, chunk_count, plaintext_bytes } => {
				let reader = match DiskReader::open(
					path,
					key,
					chunk_bytes,
					chunk_count,
					plaintext_bytes,
					Arc::clone(self),
				)
				.await
				{
					Ok(reader) => reader,
					Err(error) => {
						let error = self.attach_evidence(error);
						self.invalidate();
						return Err(error);
					},
				};
				Ok(Box::pin(stream::try_unfold(reader, |mut reader| async move {
					match reader.next_chunk().await {
						Ok(Some(bytes)) => Ok(Some((bytes, reader))),
						Ok(None) => Ok(None),
						Err(error) => {
							let owner = Arc::clone(&reader.owner);
							let error = owner.attach_evidence(error);
							drop(reader);
							owner.invalidate();
							Err(error)
						},
					}
				})))
			},
		}
	}
}

enum StorageSnapshot {
	Memory,
	Disk {
		path:            PathBuf,
		key:             StagingKey,
		chunk_bytes:     usize,
		chunk_count:     u64,
		plaintext_bytes: u64,
	},
}

struct DiskReader {
	file: TokioFile,
	key: StagingKey,
	index: u64,
	chunk_bytes: usize,
	expected_chunks: u64,
	expected_plaintext_bytes: u64,
	read_plaintext_bytes: u64,
	owner: Arc<StagedState>,
}

impl DiskReader {
	async fn open(
		path: PathBuf,
		key: StagingKey,
		chunk_bytes: usize,
		expected_chunks: u64,
		expected_plaintext_bytes: u64,
		owner: Arc<StagedState>,
	) -> Result<Self, Error> {
		let mut file = TokioOpenOptions::new()
			.read(true)
			.open(&path)
			.await
			.map_err(|_| io_error("secure_staging_reopen_failed"))?;
		let mut header = [0_u8; FILE_HEADER_LEN];
		file
			.read_exact(&mut header)
			.await
			.map_err(|_| tamper_error())?;
		if header[..FILE_MAGIC.len()] != FILE_MAGIC {
			return Err(tamper_error());
		}
		Ok(Self {
			file,
			key,
			index: 0,
			chunk_bytes,
			expected_chunks,
			expected_plaintext_bytes,
			read_plaintext_bytes: 0,
			owner,
		})
	}

	async fn next_chunk(&mut self) -> Result<Option<Bytes>, Error> {
		if self.owner.cancelled.load(Ordering::Acquire) {
			return Err(staging_error(ErrorKind::Cancelled, "staged_body_cancelled", None));
		}
		if self.index > self.expected_chunks {
			return Err(tamper_error());
		}
		let mut encoded_len = [0_u8; 4];
		let read = self
			.file
			.read(&mut encoded_len)
			.await
			.map_err(|_| tamper_error())?;
		if read == 0 {
			if self.index != self.expected_chunks
				|| self.read_plaintext_bytes != self.expected_plaintext_bytes
			{
				return Err(tamper_error());
			}
			return Ok(None);
		}
		if self.index == self.expected_chunks {
			return Err(tamper_error());
		}
		if read < encoded_len.len() {
			self
				.file
				.read_exact(&mut encoded_len[read..])
				.await
				.map_err(|_| tamper_error())?;
		}
		let sealed_len = u32::from_be_bytes(encoded_len) as usize;
		if sealed_len < TAG_LEN || sealed_len > self.chunk_bytes.saturating_add(TAG_LEN) {
			return Err(tamper_error());
		}
		let plain_len = sealed_len - TAG_LEN;
		let mut sealed = Zeroizing::new(vec![0_u8; sealed_len]);
		self
			.file
			.read_exact(&mut sealed)
			.await
			.map_err(|_| tamper_error())?;
		let key = LessSafeKey::new(
			UnboundKey::new(&aead::CHACHA20_POLY1305, &self.key.0[..]).map_err(|_| tamper_error())?,
		);
		let plaintext = key
			.open_in_place(
				nonce(self.index),
				Aad::from(aad(self.index, plain_len as u32)),
				&mut sealed,
			)
			.map_err(|_| tamper_error())?;
		let bytes = Bytes::copy_from_slice(plaintext);
		self.index = self.index.saturating_add(1);
		self.read_plaintext_bytes = self.read_plaintext_bytes.saturating_add(plain_len as u64);
		Ok(Some(bytes))
	}
}

fn nonce(index: u64) -> Nonce {
	let mut bytes = [0_u8; 12];
	bytes[4..].copy_from_slice(&index.to_be_bytes());
	Nonce::assume_unique_for_key(bytes)
}

fn aad(index: u64, plain_len: u32) -> [u8; 20] {
	let mut aad = [0_u8; 20];
	aad[..FILE_MAGIC.len()].copy_from_slice(&FILE_MAGIC);
	aad[FILE_MAGIC.len()..16].copy_from_slice(&index.to_be_bytes());
	aad[16..].copy_from_slice(&plain_len.to_be_bytes());
	aad
}

fn tamper_error() -> Error {
	let detail = ErrorDetail::protocol(ReasonId(sf!("staged_chunk_authentication_failed")));
	staging_error(ErrorKind::StreamCorruption, "staged_chunk_authentication_failed", Some(detail))
}

#[cfg(test)]
mod tests {
	use std::{
		fs::{self, OpenOptions},
		io::{self, Read, Seek, Write},
		sync::atomic::{AtomicUsize, Ordering},
		task,
	};

	use futures::stream;

	use super::*;
	use crate::body::OneShotBody as BodyOneShotBody;

	fn budget(bytes: u64) -> ExecutionBudget {
		ExecutionBudget { max_staging_bytes: bytes, ..ExecutionBudget::default() }
	}

	fn body(chunks: &[&'static [u8]]) -> BodySource {
		let chunks = chunks
			.iter()
			.map(|chunk| Ok::<_, Error>(Bytes::from_static(chunk)))
			.collect::<Vec<_>>();
		BodySource::OneShot(Arc::new(BodyOneShotBody::new(Box::pin(stream::iter(chunks)))))
	}

	async fn read_all(source: &BodySource) -> Result<Vec<u8>, Error> {
		let mut attempt = source.begin_attempt();
		let mut reader = attempt.open().await.map_err(body_open_error)?;
		let mut output = Vec::new();
		while let Some(chunk) = reader.next().await {
			output.extend_from_slice(&chunk?);
		}
		Ok(output)
	}
	#[test]
	fn semantic_retry_attachment_requires_explicit_staging() {
		let policy = StagingPolicy::memory_only(64, 64);
		assert_eq!(
			plan_semantic_retry_staging(Replayability::OneShot, StagingInputKind::Attachment, None),
			StagingDecision::RejectOneShot,
		);
		assert_eq!(
			plan_semantic_retry_staging(
				Replayability::OneShot,
				StagingInputKind::Attachment,
				Some(&policy),
			),
			StagingDecision::ExplicitlyStage,
		);
		assert_eq!(
			StagingPolicy::memory_only(64, 64)
				.with_chunk_bytes(0)
				.unwrap_err(),
			StagingPolicyError::InvalidChunkBytes { provided: 0, maximum: MAX_CHUNK_BYTES },
		);
	}

	#[tokio::test]
	async fn rejects_policy_and_execution_bound_overflow() {
		for (policy, execution, expected) in [(4, 32, 4_u128), (32, 4, 4_u128)] {
			let mut receipt = ExecutionReceipt::default();
			let error = stage_body(
				&body(&[b"abc", b"def"]),
				&StagingPolicy::memory_only(policy, policy),
				&budget(execution),
				&StagingCancellation::new(),
				&mut receipt,
			)
			.await
			.expect_err("overflow must fail");
			assert_eq!(error.kind, ErrorKind::BudgetExhausted);
			assert!(matches!(
				error.detail_ref(),
				Some(ErrorDetail::Budget { limit, observed, .. })
					if *limit == expected && *observed == 6
			));
			assert!(!receipt.staging[0].completed);
		}
	}

	#[tokio::test]
	async fn staging_budget_charge_is_aggregate_across_explicit_stages() {
		let mut receipt = ExecutionReceipt::default();
		let first = stage_body(
			&body(&[b"abc"]),
			&StagingPolicy::memory_only(8, 8),
			&budget(5),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.unwrap();
		assert_eq!(first.evidence().budget_charge, 3);

		let error = stage_body(
			&body(&[b"def"]),
			&StagingPolicy::memory_only(8, 8),
			&budget(5),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.expect_err("remaining staging budget is only two bytes");
		assert_eq!(error.kind, ErrorKind::BudgetExhausted);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Budget { limit: 2, observed: 3, .. })
		));
	}

	#[tokio::test]
	async fn cancellation_before_open_and_while_reading_cleans_up() {
		let cancelled = StagingCancellation::new();
		cancelled.cancel();
		let mut receipt = ExecutionReceipt::default();
		let error = stage_body(
			&body(&[b"unused"]),
			&StagingPolicy::memory_only(32, 32),
			&budget(32),
			&cancelled,
			&mut receipt,
		)
		.await
		.expect_err("pre-cancel must fail");
		assert_eq!(error.kind, ErrorKind::Cancelled);
		assert!(receipt.staging[0].cancelled);

		let signal = StagingCancellation::new();
		let cancel_after_first = signal.clone();
		let polled = Arc::new(AtomicUsize::new(0));
		let count = Arc::clone(&polled);
		let stream = stream::poll_fn(move |_| {
			let current = count.fetch_add(1, Ordering::SeqCst);
			if current == 0 {
				task::Poll::Ready(Some(Ok(Bytes::from_static(b"first"))))
			} else {
				cancel_after_first.cancel();
				task::Poll::Pending
			}
		});
		let mut receipt = ExecutionReceipt::default();
		let error = stage_body(
			&BodySource::OneShot(Arc::new(BodyOneShotBody::new(Box::pin(stream)))),
			&StagingPolicy::memory_only(32, 32),
			&budget(32),
			&signal,
			&mut receipt,
		)
		.await
		.expect_err("mid-stream cancellation must fail");
		assert_eq!(error.kind, ErrorKind::Cancelled);
		assert_eq!(receipt.staging[0].bytes, 5);
	}

	#[tokio::test]
	async fn encrypted_spill_reopens_fresh_readers_and_deletes_on_drop() {
		let directory = tempfile::tempdir().unwrap();
		let policy = StagingPolicy::encrypted_spill(
			64,
			2,
			StagingKeyProvider::CallerProvided(StagingKey::new([7; 32])),
		)
		.with_temp_directory(directory.path())
		.with_chunk_bytes(3)
		.unwrap();
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_body(
			&body(&[b"abcdef"]),
			&policy,
			&budget(64),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.unwrap();
		assert_eq!(staged.evidence().storage, StagingStorage::EncryptedTemporaryFile);
		assert_eq!(staged.evidence().encryption.as_ref().unwrap().chunk_count, 2);
		assert_eq!(staged.evidence().bytes, 6);
		assert_eq!(staged.evidence().budget_charge, 6);
		assert!(staged.evidence().completed);
		let encryption = staged.evidence().encryption.as_ref().unwrap();
		assert!(encryption.authenticated);
		assert_eq!(encryption.key_source, StagingKeySource::CallerProvided);
		assert_eq!(receipt.staging.len(), 1);
		assert_eq!(&receipt.staging[0], staged.evidence());
		let path = match staged.state.storage.lock().as_ref().unwrap() {
			StoredStage::Disk(disk) => disk.path.to_path_buf(),
			StoredStage::Memory(_) => panic!("expected disk spill"),
		};
		let source = staged.clone().into_body_source();
		assert_eq!(read_all(&source).await.unwrap(), b"abcdef");
		assert_eq!(read_all(&source).await.unwrap(), b"abcdef");
		drop(source);
		drop(staged);
		assert!(!path.exists());
	}

	#[tokio::test]
	async fn cancellation_after_spill_deletes_file_and_invalidates_readers() {
		let directory = tempfile::tempdir().unwrap();
		let cancellation = StagingCancellation::new();
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_body(
			&body(&[b"spill-me"]),
			&StagingPolicy::encrypted_spill(
				64,
				1,
				StagingKeyProvider::CallerProvided(StagingKey::new([9; 32])),
			)
			.with_temp_directory(directory.path()),
			&budget(64),
			&cancellation,
			&mut receipt,
		)
		.await
		.unwrap();
		let path = match staged.state.storage.lock().as_ref().unwrap() {
			StoredStage::Disk(disk) => disk.path.to_path_buf(),
			StoredStage::Memory(_) => panic!("expected disk spill"),
		};
		cancellation.cancel();
		assert!(!path.exists());
		let Err(error) = staged.open().await else {
			panic!("cancelled staged body must not open");
		};
		assert_eq!(error.kind, ErrorKind::Cancelled);
	}

	#[tokio::test]
	async fn cancellation_after_memory_reader_open_prevents_delivery() {
		let cancellation = StagingCancellation::new();
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_body(
			&body(&[b"memory"]),
			&StagingPolicy::memory_only(32, 32),
			&budget(32),
			&cancellation,
			&mut receipt,
		)
		.await
		.unwrap();
		let mut reader = staged.open().await.unwrap();
		cancellation.cancel();
		let error = reader
			.next()
			.await
			.unwrap()
			.expect_err("cancel must stop an opened reader");
		assert_eq!(error.kind, ErrorKind::Cancelled);
	}

	struct CancellingOsKey {
		cancellation: StagingCancellation,
	}

	impl OperatingSystemStagingKey for CancellingOsKey {
		fn load_staging_key(&self) -> Result<StagingKey, StagingKeyUnavailable> {
			self.cancellation.cancel();
			Ok(StagingKey::new([11; 32]))
		}
	}

	#[tokio::test]
	async fn cancellation_during_spill_setup_leaves_no_file() {
		let directory = tempfile::tempdir().unwrap();
		let cancellation = StagingCancellation::new();
		let provider = StagingKeyProvider::OperatingSystem(Arc::new(CancellingOsKey {
			cancellation: cancellation.clone(),
		}));
		let mut receipt = ExecutionReceipt::default();
		let error = stage_body(
			&body(&[b"spill"]),
			&StagingPolicy::encrypted_spill(32, 1, provider).with_temp_directory(directory.path()),
			&budget(32),
			&cancellation,
			&mut receipt,
		)
		.await
		.expect_err("cancellation during spill setup must fail");
		assert_eq!(error.kind, ErrorKind::Cancelled);
		assert!(receipt.staging[0].cancelled);
		assert!(directory.path().read_dir().unwrap().next().is_none());
	}

	#[tokio::test]
	async fn tamper_is_detected_per_chunk_and_deletes_spill() {
		let directory = tempfile::tempdir().unwrap();
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_body(
			&body(&[b"authenticated"]),
			&StagingPolicy::encrypted_spill(
				64,
				1,
				StagingKeyProvider::CallerProvided(StagingKey::new([3; 32])),
			)
			.with_temp_directory(directory.path())
			.with_chunk_bytes(4)
			.unwrap(),
			&budget(64),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.unwrap();
		let path = match staged.state.storage.lock().as_ref().unwrap() {
			StoredStage::Disk(disk) => disk.path.to_path_buf(),
			StoredStage::Memory(_) => panic!("expected disk spill"),
		};
		let mut file = OpenOptions::new()
			.read(true)
			.write(true)
			.open(&path)
			.unwrap();
		file
			.seek(io::SeekFrom::Start((FILE_HEADER_LEN + 4 + 1) as u64))
			.unwrap();
		let mut byte = [0_u8; 1];
		file.read_exact(&mut byte).unwrap();
		file.seek(io::SeekFrom::Current(-1)).unwrap();
		byte[0] ^= 0x80;
		file.write_all(&byte).unwrap();
		drop(file);
		let source = staged.clone().into_body_source();
		let error = read_all(&source)
			.await
			.expect_err("tamper must fail authentication");
		assert_eq!(error.kind, ErrorKind::StreamCorruption);
		assert!(!path.exists());
	}

	#[tokio::test]
	async fn unavailable_disk_key_never_falls_back_to_plaintext() {
		let directory = tempfile::tempdir().unwrap();
		let mut receipt = ExecutionReceipt::default();
		let error = stage_body(
			&body(&[b"too-large-for-memory"]),
			&StagingPolicy::memory_only(64, 1).with_temp_directory(directory.path()),
			&budget(64),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.expect_err("disk spill without a key must fail");
		assert_eq!(error.code.as_deref(), Some("secure_staging_key_unavailable"));
		assert!(directory.path().read_dir().unwrap().next().is_none());
	}
	struct FixedOsKey;

	impl OperatingSystemStagingKey for FixedOsKey {
		fn load_staging_key(&self) -> Result<StagingKey, StagingKeyUnavailable> {
			Ok(StagingKey::new([19; 32]))
		}
	}

	#[tokio::test]
	async fn operating_system_key_origin_is_recorded_without_secret_material() {
		let mut receipt = ExecutionReceipt::default();
		let staged = stage_body(
			&body(&[b"secret"]),
			&StagingPolicy::encrypted_spill(
				32,
				1,
				StagingKeyProvider::OperatingSystem(Arc::new(FixedOsKey)),
			),
			&budget(32),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.unwrap();
		assert_eq!(
			staged.evidence().encryption.as_ref().unwrap().key_source,
			StagingKeySource::OperatingSystem,
		);
	}

	struct UnavailableOsKey;

	impl OperatingSystemStagingKey for UnavailableOsKey {
		fn load_staging_key(&self) -> Result<StagingKey, StagingKeyUnavailable> {
			Err(StagingKeyUnavailable)
		}
	}

	#[tokio::test]
	async fn unavailable_operating_system_key_is_typed_and_never_spills() {
		let directory = tempfile::tempdir().unwrap();
		let mut receipt = ExecutionReceipt::default();
		let error = stage_body(
			&body(&[b"secret"]),
			&StagingPolicy::encrypted_spill(
				32,
				1,
				StagingKeyProvider::OperatingSystem(Arc::new(UnavailableOsKey)),
			)
			.with_temp_directory(directory.path()),
			&budget(32),
			&StagingCancellation::new(),
			&mut receipt,
		)
		.await
		.expect_err("unavailable OS key must not fall back");
		assert_eq!(error.code.as_deref(), Some("secure_staging_key_unavailable"));
		assert!(directory.path().read_dir().unwrap().next().is_none());
	}

	#[test]
	fn media_and_live_audio_are_never_implicitly_buffered() {
		for kind in [StagingInputKind::Media, StagingInputKind::LiveAudio] {
			assert_eq!(
				plan_semantic_retry_staging(Replayability::OneShot, kind, None),
				StagingDecision::RejectOneShot,
			);
		}
	}

	#[test]
	fn secure_gate_spool_round_trips_order_and_deletes_on_drop() {
		let directory = tempfile::tempdir().unwrap();
		let cancellation = StagingCancellation::new();
		let mut spool = SecureTemporaryGateSpool::new(
			256,
			StagingKeyProvider::CallerProvided(StagingKey::new([23; 32])),
			Some(directory.path().to_path_buf()),
			&cancellation,
		)
		.unwrap();
		let path = spool.temporary_path().unwrap();
		spool
			.push(ChatEvent::TextDelta { index: 1, text: sf!("first") }, 10)
			.unwrap();
		spool
			.push(ChatEvent::ThinkingDelta { index: 2, text: sf!("second") }, 11)
			.unwrap();
		let encrypted = fs::read(&path).unwrap();
		assert!(
			!encrypted
				.windows(b"first".len())
				.any(|window| window == b"first")
		);
		assert!(
			!encrypted
				.windows(b"second".len())
				.any(|window| window == b"second")
		);
		match spool.pop_front().unwrap().unwrap() {
			(ChatEvent::TextDelta { index, text }, bytes) => {
				assert_eq!(index, 1);
				assert_eq!(text.as_str(), "first");
				assert_eq!(bytes, 10);
			},
			_ => panic!("unexpected first spooled event"),
		}
		match spool.pop_front().unwrap().unwrap() {
			(ChatEvent::ThinkingDelta { index, text }, bytes) => {
				assert_eq!(index, 2);
				assert_eq!(text.as_str(), "second");
				assert_eq!(bytes, 11);
			},
			_ => panic!("unexpected second spooled event"),
		}
		drop(spool);
		assert!(!path.exists());
	}

	#[test]
	fn secure_gate_spool_capacity_cancellation_and_unspoolable_stream_are_explicit() {
		let cancellation = StagingCancellation::new();
		let mut spool = SecureTemporaryGateSpool::new(
			4,
			StagingKeyProvider::CallerProvided(StagingKey::new([29; 32])),
			None,
			&cancellation,
		)
		.unwrap();
		assert_eq!(
			spool
				.push(ChatEvent::TextDelta { index: 0, text: sf!("large") }, 5)
				.unwrap_err(),
			GateSpoolError::Capacity { limit: 4, observed: 5 },
		);

		let mut spool = SecureTemporaryGateSpool::new(
			64,
			StagingKeyProvider::CallerProvided(StagingKey::new([31; 32])),
			None,
			&cancellation,
		)
		.unwrap();
		let event = ChatEvent::Artifact {
			index:    0,
			artifact: Artifact {
				media_type: sf!("audio/raw"),
				size:       None,
				digest:     None,
				body:       ArtifactBody::Stream(Box::pin(stream::pending())),
			},
		};
		assert!(matches!(spool.push(event, 1), Err(GateSpoolError::Unavailable { .. })));
		cancellation.cancel();
		assert!(spool.is_cancelled());
		assert!(matches!(spool.pop_front(), Err(GateSpoolError::Unavailable { .. })));
	}
}

/// Caller-explicit authenticated-encrypted temporary spool for provisional chat
/// events.
pub struct SecureTemporaryGateSpool {
	state:       Arc<GateSpoolState>,
	capacity:    u64,
	charged:     u64,
	write_index: u64,
	read_index:  u64,
	records:     VecDeque<GateRecord>,
}

#[derive(Debug)]
struct GateSpoolState {
	storage:   Mutex<Option<GateSpoolStorage>>,
	cancelled: AtomicBool,
}

struct GateSpoolStorage {
	file: StdFile,
	#[cfg_attr(
		not(test),
		expect(
			dead_code,
			reason = "owning the TempPath keeps the encrypted spool alive until its file is dropped"
		)
	)]
	path: TempPath,
	key:  StagingKey,
}

impl fmt::Debug for GateSpoolStorage {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("GateSpoolStorage")
			.field("path", &"[REDACTED]")
			.finish()
	}
}

#[derive(Clone, Copy, Debug)]
struct GateRecord {
	offset:      u64,
	sealed_len:  u32,
	event_bytes: u64,
	index:       u64,
}

impl SecureTemporaryGateSpool {
	/// Creates an explicit secure provisional spool. No gate creates one
	/// automatically.
	pub fn new(
		capacity: u64,
		key_provider: StagingKeyProvider,
		temp_directory: Option<PathBuf>,
		cancellation: &StagingCancellation,
	) -> Result<Self, GateSpoolError> {
		if cancellation.is_cancelled() {
			return Err(gate_unavailable("secure_gate_spool_cancelled"));
		}
		let (key, _) = key_provider
			.load()
			.map_err(|_| gate_unavailable("secure_gate_spool_key_unavailable"))?;
		let named = match temp_directory {
			Some(directory) => tempfile::Builder::new()
				.prefix("omp-llm-gate-")
				.tempfile_in(directory),
			None => tempfile::Builder::new().prefix("omp-llm-gate-").tempfile(),
		}
		.map_err(|_| gate_unavailable("secure_gate_spool_create_failed"))?;
		let path = named.into_temp_path();
		let file = StdOpenOptions::new()
			.read(true)
			.write(true)
			.truncate(true)
			.open(&path)
			.map_err(|_| gate_unavailable("secure_gate_spool_open_failed"))?;
		let key = derive_ephemeral_key(key)?;
		let state = Arc::new(GateSpoolState {
			storage:   Mutex::new(Some(GateSpoolStorage { file, path, key })),
			cancelled: AtomicBool::new(false),
		});
		cancellation.register_gate_spool(&state);
		if state.cancelled.load(Ordering::Acquire) {
			return Err(gate_unavailable("secure_gate_spool_cancelled"));
		}
		Ok(Self {
			state,
			capacity,
			charged: 0,
			write_index: 0,
			read_index: 0,
			records: VecDeque::new(),
		})
	}

	/// Reports whether cancellation/drop cleanup has removed the temporary file.
	pub fn is_cancelled(&self) -> bool {
		self.state.cancelled.load(Ordering::Acquire)
	}

	#[cfg(test)]
	fn temporary_path(&self) -> Option<PathBuf> {
		self
			.state
			.storage
			.lock()
			.as_ref()
			.map(|storage| storage.path.to_path_buf())
	}
}

impl SecureGateSpool for SecureTemporaryGateSpool {
	fn capacity_bytes(&self) -> u64 {
		self.capacity
	}

	fn push(&mut self, event: ChatEvent, event_bytes: u64) -> Result<(), GateSpoolError> {
		if self.state.cancelled.load(Ordering::Acquire) {
			return Err(gate_unavailable("secure_gate_spool_cancelled"));
		}
		let observed = self.charged.saturating_add(event_bytes);
		if observed > self.capacity {
			return Err(GateSpoolError::Capacity { limit: self.capacity, observed });
		}
		let mut plaintext = Zeroizing::new(Vec::new());
		encode_chat_event(&event, &mut plaintext)?;
		let plain_len = u32::try_from(plaintext.len())
			.map_err(|_| gate_unavailable("secure_gate_event_too_large"))?;
		let result = (|| {
			let mut storage = self.state.storage.lock();
			let storage = storage
				.as_mut()
				.ok_or_else(|| gate_unavailable("secure_gate_spool_cancelled"))?;
			let key = LessSafeKey::new(
				UnboundKey::new(&aead::CHACHA20_POLY1305, &storage.key.0[..])
					.map_err(|_| gate_unavailable("secure_gate_cipher_unavailable"))?,
			);
			key.seal_in_place_append_tag(
				nonce(self.write_index),
				Aad::from(gate_aad(self.write_index, event_bytes, plain_len)),
				&mut *plaintext,
			)
			.map_err(|_| gate_unavailable("secure_gate_encrypt_failed"))?;
			let sealed_len = u32::try_from(plaintext.len())
				.map_err(|_| gate_unavailable("secure_gate_event_too_large"))?;
			let offset = storage
				.file
				.seek(SeekFrom::End(0))
				.map_err(|_| gate_unavailable("secure_gate_spool_seek_failed"))?;
			storage
				.file
				.write_all(&plaintext)
				.map_err(|_| gate_unavailable("secure_gate_spool_write_failed"))?;
			storage
				.file
				.flush()
				.map_err(|_| gate_unavailable("secure_gate_spool_flush_failed"))?;
			Ok(GateRecord { offset, sealed_len, event_bytes, index: self.write_index })
		})();
		let record = match result {
			Ok(record) => record,
			Err(error) => {
				self.state.invalidate();
				return Err(error);
			},
		};
		self.records.push_back(record);
		self.write_index = self.write_index.saturating_add(1);
		self.charged = observed;
		drop(event);
		Ok(())
	}

	fn pop_front(&mut self) -> Result<Option<(ChatEvent, u64)>, GateSpoolError> {
		if self.state.cancelled.load(Ordering::Acquire) {
			return Err(gate_unavailable("secure_gate_spool_cancelled"));
		}
		let Some(record) = self.records.front().copied() else {
			return Ok(None);
		};
		if record.index != self.read_index {
			self.state.invalidate();
			return Err(gate_corrupt("secure_gate_spool_order_corrupt"));
		}
		let result = (|| {
			let mut storage = self.state.storage.lock();
			let storage = storage
				.as_mut()
				.ok_or_else(|| gate_unavailable("secure_gate_spool_cancelled"))?;
			storage
				.file
				.seek(SeekFrom::Start(record.offset))
				.map_err(|_| gate_corrupt("secure_gate_spool_seek_corrupt"))?;
			let mut sealed = Zeroizing::new(vec![0_u8; record.sealed_len as usize]);
			storage
				.file
				.read_exact(&mut sealed)
				.map_err(|_| gate_corrupt("secure_gate_spool_truncated"))?;
			let plain_len = record
				.sealed_len
				.checked_sub(TAG_LEN as u32)
				.ok_or_else(|| gate_corrupt("secure_gate_spool_record_corrupt"))?;
			let key = LessSafeKey::new(
				UnboundKey::new(&aead::CHACHA20_POLY1305, &storage.key.0[..])
					.map_err(|_| gate_corrupt("secure_gate_cipher_unavailable"))?,
			);
			let plaintext = key
				.open_in_place(
					nonce(record.index),
					Aad::from(gate_aad(record.index, record.event_bytes, plain_len)),
					&mut sealed,
				)
				.map_err(|_| gate_corrupt("secure_gate_spool_authentication_failed"))?;
			decode_chat_event(plaintext)
		})();
		let event = match result {
			Ok(event) => event,
			Err(error) => {
				self.state.invalidate();
				return Err(error);
			},
		};
		self.records.pop_front();
		self.read_index = self.read_index.saturating_add(1);
		self.charged = self.charged.saturating_sub(record.event_bytes);
		Ok(Some((event, record.event_bytes)))
	}

	fn discard(&mut self) -> Result<(), GateSpoolError> {
		self.records.clear();
		self.charged = 0;
		self.state.invalidate();
		Ok(())
	}
}

impl Drop for SecureTemporaryGateSpool {
	fn drop(&mut self) {
		self.state.invalidate();
	}
}

impl GateSpoolState {
	fn invalidate(&self) {
		self.cancelled.store(true, Ordering::Release);
		self.storage.lock().take();
	}
}

fn derive_ephemeral_key(key: StagingKey) -> Result<StagingKey, GateSpoolError> {
	let mut salt_bytes = Zeroizing::new([0_u8; 32]);
	SystemRandom::new()
		.fill(&mut *salt_bytes)
		.map_err(|_| gate_unavailable("secure_gate_random_unavailable"))?;
	let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt_bytes[..]);
	let prk = salt.extract(&key.0[..]);
	let context = [b"omp-llm-secure-gate-v1".as_slice()];
	let output = prk
		.expand(&context, hkdf::HKDF_SHA256)
		.map_err(|_| gate_unavailable("secure_gate_key_derivation_failed"))?;
	let mut derived = [0_u8; 32];
	output
		.fill(&mut derived)
		.map_err(|_| gate_unavailable("secure_gate_key_derivation_failed"))?;
	Ok(StagingKey(Zeroizing::new(derived)))
}

fn gate_aad(index: u64, event_bytes: u64, plain_len: u32) -> [u8; 28] {
	let mut aad = [0_u8; 28];
	aad[..8].copy_from_slice(b"OMPGATE1");
	aad[8..16].copy_from_slice(&index.to_be_bytes());
	aad[16..24].copy_from_slice(&event_bytes.to_be_bytes());
	aad[24..].copy_from_slice(&plain_len.to_be_bytes());
	aad
}

fn gate_unavailable(reason: &'static str) -> GateSpoolError {
	GateSpoolError::Unavailable { reason: ReasonId(Str::new(reason)) }
}

fn gate_corrupt(reason: &'static str) -> GateSpoolError {
	GateSpoolError::Corrupt { reason: ReasonId(Str::new(reason)) }
}

fn encode_chat_event(event: &ChatEvent, out: &mut Vec<u8>) -> Result<(), GateSpoolError> {
	match event {
		ChatEvent::Started(meta) => {
			put_u8(out, 0);
			put_str(out, meta.request_id.as_str())?;
			put_str(out, meta.provider.as_str())?;
			put_str(out, meta.route.as_str())?;
			put_option_str(out, meta.model.as_ref().map(|model| model.as_str()))?;
			put_option_str(out, meta.provider_request_id.as_ref().map(Str::as_str))?;
			put_system_time(out, meta.created_at)?;
		},
		ChatEvent::BlockStarted { index, kind } => {
			put_u8(out, 1);
			put_u32(out, *index);
			put_u8(out, match kind {
				BlockKind::Text => 0,
				BlockKind::Thinking => 1,
				BlockKind::ToolCall => 2,
				BlockKind::Artifact => 3,
			});
		},
		ChatEvent::TextDelta { index, text } => {
			put_u8(out, 2);
			put_u32(out, *index);
			put_str(out, text.as_str())?;
		},
		ChatEvent::ThinkingDelta { index, text } => {
			put_u8(out, 3);
			put_u32(out, *index);
			put_str(out, text.as_str())?;
		},
		ChatEvent::ToolCallStarted { index, id, name } => {
			put_u8(out, 4);
			put_u32(out, *index);
			put_str(out, id.as_str())?;
			put_str(out, name.as_str())?;
		},
		ChatEvent::ToolArgumentsDelta { index, bytes } => {
			put_u8(out, 5);
			put_u32(out, *index);
			put_bytes(out, bytes)?;
		},
		ChatEvent::ToolCallReady { index, call } => {
			put_u8(out, 6);
			put_u32(out, *index);
			put_str(out, call.id.as_str())?;
			put_str(out, call.name.as_str())?;
			let json = serde_json::to_vec(call.arguments.as_value())
				.map_err(|_| gate_unavailable("secure_gate_json_encode_failed"))?;
			put_bytes(out, &json)?;
		},
		ChatEvent::Artifact { index, artifact } => {
			put_u8(out, 7);
			put_u32(out, *index);
			encode_artifact(artifact, out)?;
		},
		ChatEvent::Usage(update) => {
			put_u8(out, 8);
			encode_usage(update.usage, out);
			put_bool(out, update.final_update);
		},
		ChatEvent::WorkflowAction(_)
		| ChatEvent::WorkflowResume(_)
		| ChatEvent::WorkflowCancelled { .. } => {
			return Err(gate_unavailable("secure_gate_control_event"));
		},
		ChatEvent::Completed(completion) => {
			put_u8(out, 9);
			encode_finish_reason(&completion.reason, out)?;
			put_u32(out, completion.blocks);
			encode_usage(completion.usage, out);
			let receipt = postcard::to_allocvec(&completion.receipt)
				.map_err(|_| gate_unavailable("secure_gate_receipt_encode_failed"))?;
			put_bytes(out, &receipt)?;
		},
	}
	Ok(())
}

fn decode_chat_event(input: &[u8]) -> Result<ChatEvent, GateSpoolError> {
	let mut cursor = GateCursor::new(input);
	let event = match cursor.u8()? {
		0 => ChatEvent::Started(ResponseMeta {
			request_id:          RequestId::from(cursor.string()?),
			provider:            ProviderId::from(cursor.string()?),
			route:               RouteId::from(cursor.string()?),
			model:               cursor.option_string()?.map(ModelKey::from),
			provider_request_id: cursor.option_string()?.map(Str::new),
			created_at:          cursor.system_time()?,
		}),
		1 => ChatEvent::BlockStarted {
			index: cursor.u32()?,
			kind:  match cursor.u8()? {
				0 => BlockKind::Text,
				1 => BlockKind::Thinking,
				2 => BlockKind::ToolCall,
				3 => BlockKind::Artifact,
				_ => return Err(gate_corrupt("secure_gate_event_tag_corrupt")),
			},
		},
		2 => ChatEvent::TextDelta { index: cursor.u32()?, text: Str::new(cursor.string()?) },
		3 => ChatEvent::ThinkingDelta { index: cursor.u32()?, text: Str::new(cursor.string()?) },
		4 => ChatEvent::ToolCallStarted {
			index: cursor.u32()?,
			id:    ToolCallId::from(cursor.string()?),
			name:  Str::new(cursor.string()?),
		},
		5 => ChatEvent::ToolArgumentsDelta {
			index: cursor.u32()?,
			bytes: Bytes::copy_from_slice(cursor.bytes()?),
		},
		6 => {
			let index = cursor.u32()?;
			let id = ToolCallId::from(cursor.string()?);
			let name = Str::new(cursor.string()?);
			let arguments = serde_json::from_slice(cursor.bytes()?)
				.map_err(|_| gate_corrupt("secure_gate_json_corrupt"))?;
			ChatEvent::ToolCallReady {
				index,
				call: ToolCall { id, name, arguments: OpaqueJson::new(arguments) },
			}
		},
		7 => {
			let index = cursor.u32()?;
			ChatEvent::Artifact { index, artifact: decode_artifact(&mut cursor)? }
		},
		8 => ChatEvent::Usage(UsageUpdate {
			usage:        cursor.usage()?,
			final_update: cursor.bool()?,
		}),
		9 => {
			let reason = cursor.finish_reason()?;
			let blocks = cursor.u32()?;
			let usage = cursor.usage()?;
			let receipt: ExecutionReceipt = postcard::from_bytes(cursor.bytes()?)
				.map_err(|_| gate_corrupt("secure_gate_receipt_corrupt"))?;
			ChatEvent::Completed(Completion { reason, blocks, usage, receipt: receipt.into() })
		},
		_ => return Err(gate_corrupt("secure_gate_event_tag_corrupt")),
	};
	if !cursor.done() {
		return Err(gate_corrupt("secure_gate_event_trailing_bytes"));
	}
	Ok(event)
}

fn encode_artifact(artifact: &Artifact, out: &mut Vec<u8>) -> Result<(), GateSpoolError> {
	put_str(out, artifact.media_type.as_str())?;
	put_option_u64(out, artifact.size);
	match &artifact.digest {
		Some(digest) => {
			put_bool(out, true);
			put_u8(out, match digest.algorithm {
				DigestAlgorithm::Sha256 => 0,
				DigestAlgorithm::Blake3 => 1,
			});
			put_bytes(out, &digest.value)?;
		},
		None => put_bool(out, false),
	}
	match &artifact.body {
		ArtifactBody::Bytes(bytes) => {
			put_u8(out, 0);
			put_bytes(out, bytes)?;
		},
		ArtifactBody::Stored(reference) => {
			put_u8(out, 1);
			put_str(out, reference.store.as_str())?;
			put_str(out, reference.id.as_str())?;
			put_str(out, reference.revision.as_str())?;
		},
		ArtifactBody::Stream(_) => {
			return Err(gate_unavailable("secure_gate_stream_artifact_requires_storage"));
		},
	}
	Ok(())
}

fn decode_artifact(cursor: &mut GateCursor<'_>) -> Result<Artifact, GateSpoolError> {
	let media_type = Str::new(cursor.string()?);
	let size = cursor.option_u64()?;
	let digest = if cursor.bool()? {
		Some(Digest {
			algorithm: match cursor.u8()? {
				0 => DigestAlgorithm::Sha256,
				1 => DigestAlgorithm::Blake3,
				_ => return Err(gate_corrupt("secure_gate_digest_tag_corrupt")),
			},
			value:     Bytes::copy_from_slice(cursor.bytes()?),
		})
	} else {
		None
	};
	let body = match cursor.u8()? {
		0 => ArtifactBody::Bytes(Bytes::copy_from_slice(cursor.bytes()?)),
		1 => ArtifactBody::Stored(ArtifactRef {
			store:    Str::new(cursor.string()?),
			id:       Str::new(cursor.string()?),
			revision: Str::new(cursor.string()?),
		}),
		_ => return Err(gate_corrupt("secure_gate_artifact_tag_corrupt")),
	};
	Ok(Artifact { media_type, size, digest, body })
}

fn encode_finish_reason(reason: &FinishReason, out: &mut Vec<u8>) -> Result<(), GateSpoolError> {
	match reason {
		FinishReason::Stop => put_u8(out, 0),
		FinishReason::Length => put_u8(out, 1),
		FinishReason::ToolCalls => put_u8(out, 2),
		FinishReason::ContentFilter => put_u8(out, 3),
		FinishReason::Cancelled => put_u8(out, 4),
		FinishReason::Other(reason) => {
			put_u8(out, 5);
			put_str(out, reason.as_str())?;
		},
	}
	Ok(())
}

fn encode_usage(usage: Usage, out: &mut Vec<u8>) {
	for value in [
		usage.input_tokens,
		usage.output_tokens,
		usage.reasoning_tokens,
		usage.cache_read_tokens,
		usage.cache_write_tokens,
		usage.cache_write_1h_tokens,
		usage.audio_input_ms,
		usage.audio_output_ms,
		usage.video_ms,
		usage.premium_requests_millionths,
	] {
		put_u64(out, value);
	}
	put_u32(out, usage.images);
	put_u32(out, usage.search_calls);
	put_u8(out, match usage.source {
		UsageSource::Unknown => 0,
		UsageSource::Provider => 1,
		UsageSource::Measured => 2,
		UsageSource::Estimated => 3,
		UsageSource::Mixed => 4,
	});
}

fn put_u8(out: &mut Vec<u8>, value: u8) {
	out.push(value);
}
fn put_bool(out: &mut Vec<u8>, value: bool) {
	put_u8(out, u8::from(value));
}
fn put_u32(out: &mut Vec<u8>, value: u32) {
	out.extend_from_slice(&value.to_be_bytes());
}
fn put_u64(out: &mut Vec<u8>, value: u64) {
	out.extend_from_slice(&value.to_be_bytes());
}
fn put_bytes(out: &mut Vec<u8>, value: &[u8]) -> Result<(), GateSpoolError> {
	let len =
		u32::try_from(value.len()).map_err(|_| gate_unavailable("secure_gate_event_too_large"))?;
	put_u32(out, len);
	out.extend_from_slice(value);
	Ok(())
}
fn put_str(out: &mut Vec<u8>, value: &str) -> Result<(), GateSpoolError> {
	put_bytes(out, value.as_bytes())
}
fn put_option_str(out: &mut Vec<u8>, value: Option<&str>) -> Result<(), GateSpoolError> {
	put_bool(out, value.is_some());
	if let Some(value) = value {
		put_str(out, value)?;
	}
	Ok(())
}
fn put_option_u64(out: &mut Vec<u8>, value: Option<u64>) {
	put_bool(out, value.is_some());
	if let Some(value) = value {
		put_u64(out, value);
	}
}
fn put_system_time(out: &mut Vec<u8>, value: SystemTime) -> Result<(), GateSpoolError> {
	let duration = value
		.duration_since(UNIX_EPOCH)
		.map_err(|_| gate_unavailable("secure_gate_time_before_epoch"))?;
	put_u64(out, duration.as_secs());
	put_u32(out, duration.subsec_nanos());
	Ok(())
}

struct GateCursor<'a> {
	input:  &'a [u8],
	offset: usize,
}
impl<'a> GateCursor<'a> {
	const fn new(input: &'a [u8]) -> Self {
		Self { input, offset: 0 }
	}

	const fn done(&self) -> bool {
		self.offset == self.input.len()
	}

	fn take(&mut self, count: usize) -> Result<&'a [u8], GateSpoolError> {
		let end = self
			.offset
			.checked_add(count)
			.ok_or_else(|| gate_corrupt("secure_gate_length_corrupt"))?;
		let bytes = self
			.input
			.get(self.offset..end)
			.ok_or_else(|| gate_corrupt("secure_gate_event_truncated"))?;
		self.offset = end;
		Ok(bytes)
	}

	fn u8(&mut self) -> Result<u8, GateSpoolError> {
		Ok(self.take(1)?[0])
	}

	fn bool(&mut self) -> Result<bool, GateSpoolError> {
		match self.u8()? {
			0 => Ok(false),
			1 => Ok(true),
			_ => Err(gate_corrupt("secure_gate_bool_corrupt")),
		}
	}

	fn u32(&mut self) -> Result<u32, GateSpoolError> {
		Ok(u32::from_be_bytes(self.take(4)?.try_into().expect("exact slice")))
	}

	fn u64(&mut self) -> Result<u64, GateSpoolError> {
		Ok(u64::from_be_bytes(self.take(8)?.try_into().expect("exact slice")))
	}

	fn bytes(&mut self) -> Result<&'a [u8], GateSpoolError> {
		let len = self.u32()? as usize;
		self.take(len)
	}

	fn string(&mut self) -> Result<&'a str, GateSpoolError> {
		str::from_utf8(self.bytes()?).map_err(|_| gate_corrupt("secure_gate_utf8_corrupt"))
	}

	fn option_string(&mut self) -> Result<Option<&'a str>, GateSpoolError> {
		if self.bool()? {
			self.string().map(Some)
		} else {
			Ok(None)
		}
	}

	fn option_u64(&mut self) -> Result<Option<u64>, GateSpoolError> {
		if self.bool()? {
			self.u64().map(Some)
		} else {
			Ok(None)
		}
	}

	fn system_time(&mut self) -> Result<SystemTime, GateSpoolError> {
		let seconds = self.u64()?;
		let nanos = self.u32()?;
		if nanos >= 1_000_000_000 {
			return Err(gate_corrupt("secure_gate_time_corrupt"));
		}
		UNIX_EPOCH
			.checked_add(Duration::new(seconds, nanos))
			.ok_or_else(|| gate_corrupt("secure_gate_time_corrupt"))
	}

	fn usage(&mut self) -> Result<Usage, GateSpoolError> {
		Ok(Usage {
			input_tokens: self.u64()?,
			output_tokens: self.u64()?,
			reasoning_tokens: self.u64()?,
			cache_read_tokens: self.u64()?,
			cache_write_tokens: self.u64()?,
			cache_write_1h_tokens: self.u64()?,
			audio_input_ms: self.u64()?,
			audio_output_ms: self.u64()?,
			video_ms: self.u64()?,
			premium_requests_millionths: self.u64()?,
			images: self.u32()?,
			search_calls: self.u32()?,
			source: match self.u8()? {
				0 => UsageSource::Unknown,
				1 => UsageSource::Provider,
				2 => UsageSource::Measured,
				3 => UsageSource::Estimated,
				4 => UsageSource::Mixed,
				_ => return Err(gate_corrupt("secure_gate_usage_source_corrupt")),
			},
		})
	}

	fn finish_reason(&mut self) -> Result<FinishReason, GateSpoolError> {
		Ok(match self.u8()? {
			0 => FinishReason::Stop,
			1 => FinishReason::Length,
			2 => FinishReason::ToolCalls,
			3 => FinishReason::ContentFilter,
			4 => FinishReason::Cancelled,
			5 => FinishReason::Other(Str::new(self.string()?)),
			_ => return Err(gate_corrupt("secure_gate_finish_reason_corrupt")),
		})
	}
}
