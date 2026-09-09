//! Retry-safe request body acquisition and exact consumption evidence.

use std::{
	collections::VecDeque,
	fmt, future,
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
};

use bytes::Bytes;
use futures::{Stream, stream};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{answer::ArtifactRef, error::Error};

/// Owned asynchronous stream of immutable byte chunks.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, Error>> + Send + 'static>>;

/// Whether every component of a request body can be opened again.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Replayability {
	/// Every component has immutable repeatable input.
	Replayable,
	/// At least one component cannot be replayed after its first poll.
	OneShot,
	/// Explicit secure staging made every component repeatable.
	Staged,
}

impl Replayability {
	/// Conservatively aggregates multipart replayability.
	pub fn aggregate(parts: impl IntoIterator<Item = Self>) -> Self {
		let mut aggregate = Self::Replayable;
		for part in parts {
			match part {
				Self::OneShot => return Self::OneShot,
				Self::Staged => aggregate = Self::Staged,
				Self::Replayable => {},
			}
		}
		aggregate
	}
}

/// Typed outcome of evaluating whether another body attempt is safe.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RetryDecision {
	/// Another acquisition is safe.
	Allow,
	/// Another acquisition is unsafe and must not occur automatically.
	Suppress,
}

/// Typed evidence behind a body retry decision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RetryDecisionReason {
	/// The source promises fresh immutable input for every attempt.
	ReplayableSource,
	/// Explicit secure staging produced fresh input for every attempt.
	StagedSource,
	/// The initial one-shot stream has not been acquired yet.
	OneShotUnopened,
	/// An unread reader was dropped and an explicit factory can reacquire it.
	SafeReacquisition,
	/// A reader is still active, so another reader cannot be granted.
	ActiveReader,
	/// The one-shot reader polled its underlying stream.
	ConsumedOneShot,
	/// An unread reader was dropped without an explicit reacquisition factory.
	ReacquisitionUnavailable,
}

/// Exact body state consumed by every retry, rotation, fallback, reseed, and
/// semantic policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AttemptBodyEvidence {
	/// Whether this attempt successfully acquired a reader.
	pub opened:         bool,
	/// Whether this attempt polled the underlying stream at least once.
	pub consumed:       bool,
	/// Aggregate body replayability before the attempt.
	pub replayability:  Replayability,
	/// Whether another automatic attempt is safe.
	pub retry_decision: RetryDecision,
	/// Typed reason for the decision.
	pub reason:         RetryDecisionReason,
}

/// Classifies one component in aggregate replay evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BodyPartKind {
	/// Inline immutable bytes.
	Bytes,
	/// Immutable repeatable artifact storage.
	Stored(ArtifactLeaseEvidence),
	/// A deterministic stream factory.
	Factory,
	/// A single-reader stream, with explicit pre-poll reacquisition evidence.
	OneShot {
		/// Whether an unopened reader can be reacquired from a fresh factory.
		safe_reacquisition: bool,
	},
	/// A native stream whose replayability was explicitly declared.
	Native(NativeStreamDeclaration),
}

/// Replay evidence for one body component.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodyPartEvidence {
	/// Physical source category and its guarantees.
	pub kind:          BodyPartKind,
	/// Replayability contributed by this component.
	pub replayability: Replayability,
}

/// Flattened evidence and conservative replayability for a multipart body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayEvidence {
	/// Conservative aggregate across every component.
	pub replayability: Replayability,
	/// Ordered component evidence without hiding a mixed multipart member.
	pub parts:         Arc<[BodyPartEvidence]>,
}

impl ReplayEvidence {
	/// Aggregates complete evidence for an ordered multipart body.
	pub fn aggregate(parts: impl IntoIterator<Item = Self>) -> Self {
		let mut evidence = Vec::new();
		for part in parts {
			evidence.extend(part.parts.iter().cloned());
		}
		let replayability = Replayability::aggregate(evidence.iter().map(|part| part.replayability));
		Self { replayability, parts: evidence.into() }
	}
}

/// Nameable, allocation-free interface for opening a fresh stream.
pub trait BodyFactory: Send + Sync + 'static {
	/// Concrete future returned by [`BodyFactory::open`].
	type OpenFuture<'a>: Future<Output = Result<ByteStream, Error>> + Send + 'a
	where
		Self: 'a;

	/// Opens a fresh stream that shares no cursor state with an earlier open.
	fn open(&self) -> Self::OpenFuture<'_>;
}

impl<F, Fut> BodyFactory for F
where
	F: Fn() -> Fut + Send + Sync + 'static,
	Fut: Future<Output = Result<ByteStream, Error>> + Send + 'static,
{
	type OpenFuture<'a>
		= Fut
	where
		Self: 'a;

	fn open(&self) -> Self::OpenFuture<'_> {
		self()
	}
}

type ErasedOpenFuture<'a> = Pin<Box<dyn Future<Output = Result<ByteStream, Error>> + Send + 'a>>;

trait ErasedBodyFactory: Send + Sync {
	fn open_erased(&self) -> ErasedOpenFuture<'_>;
}

impl<F: BodyFactory> ErasedBodyFactory for F {
	fn open_erased(&self) -> ErasedOpenFuture<'_> {
		Box::pin(self.open())
	}
}

/// Clone-cheap construction-time erasure for heterogeneous body factories.
#[derive(Clone)]
pub struct BodyFactoryHandle {
	inner:         Arc<dyn ErasedBodyFactory>,
	replayability: Replayability,
}

impl BodyFactoryHandle {
	/// Erases a deterministic replayable factory once at construction.
	pub fn new<F: BodyFactory>(factory: F) -> Self {
		Self { inner: Arc::new(factory), replayability: Replayability::Replayable }
	}

	/// Erases a factory produced by explicit secure staging.
	pub fn staged<F: BodyFactory>(factory: F) -> Self {
		Self { inner: Arc::new(factory), replayability: Replayability::Staged }
	}

	/// Opens a fresh independent stream.
	pub fn open(&self) -> impl Future<Output = Result<ByteStream, Error>> + Send + '_ {
		self.inner.open_erased()
	}

	/// Returns the factory's declared replayability provenance.
	pub const fn replayability(&self) -> Replayability {
		self.replayability
	}
}

impl fmt::Debug for BodyFactoryHandle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BodyFactoryHandle")
			.field("replayability", &self.replayability)
			.finish_non_exhaustive()
	}
}

/// Guarantee represented by a live artifact lease.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactReadGuarantee {
	/// Every open observes identical immutable bytes for the execution-plan
	/// lifetime.
	ImmutableRepeatableForPlan,
}

/// Secret-free evidence retained from a live artifact lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactLeaseEvidence {
	/// Immutable artifact identity and revision.
	pub artifact:  ArtifactRef,
	/// Repeatable-read guarantee held by the lease.
	pub guarantee: ArtifactReadGuarantee,
}

/// Store lease that owns its repeatable-read guarantee until dropped.
pub trait ArtifactLease: BodyFactory {
	/// Returns the immutable artifact identity guarded by this lease.
	fn artifact(&self) -> &ArtifactRef;
}

/// A stored body that retains its live lease while it can be opened.
#[derive(Clone)]
pub struct StoredBody {
	evidence: ArtifactLeaseEvidence,
	factory:  BodyFactoryHandle,
}

impl StoredBody {
	/// Retains a live immutable repeatable-read lease.
	pub fn new<L: ArtifactLease>(lease: L) -> Self {
		Self::with_replayability(lease, Replayability::Replayable)
	}

	/// Retains a live artifact lease produced by explicit secure staging.
	pub fn staged<L: ArtifactLease>(lease: L) -> Self {
		Self::with_replayability(lease, Replayability::Staged)
	}

	fn with_replayability<L: ArtifactLease>(lease: L, replayability: Replayability) -> Self {
		let evidence = ArtifactLeaseEvidence {
			artifact:  lease.artifact().clone(),
			guarantee: ArtifactReadGuarantee::ImmutableRepeatableForPlan,
		};
		let mut factory = BodyFactoryHandle::new(lease);
		factory.replayability = replayability;
		Self { evidence, factory }
	}

	/// Returns the immutable artifact identity.
	pub const fn artifact(&self) -> &ArtifactRef {
		&self.evidence.artifact
	}

	/// Returns secret-free evidence for the held lease.
	pub const fn lease_evidence(&self) -> &ArtifactLeaseEvidence {
		&self.evidence
	}
}

impl fmt::Debug for StoredBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("StoredBody")
			.field("evidence", &self.evidence)
			.field("replayability", &self.factory.replayability)
			.finish()
	}
}

/// Explicit replay declaration required for a native streaming request body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeStreamDeclaration {
	/// The supplied source itself proves fresh repeatable opens.
	Replayable,
	/// The supplied source is a one-shot stream.
	OneShot,
}

/// Error returned when a native declaration contradicts its physical source.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("native stream declaration {declared:?} contradicts {actual:?} body source")]
pub struct NativeDeclarationError {
	/// Replayability explicitly declared by the caller.
	pub declared: NativeStreamDeclaration,
	/// Replayability proved by the physical source.
	pub actual:   Replayability,
}

/// A native body coupled to its mandatory explicit replay declaration.
#[derive(Clone, Debug)]
pub struct NativeBodySource {
	source:      BodySource,
	declaration: NativeStreamDeclaration,
}

impl NativeBodySource {
	/// Validates and retains an explicit declaration; no HTTP-method inference
	/// is used.
	pub fn new(
		source: BodySource,
		declaration: NativeStreamDeclaration,
	) -> Result<Self, NativeDeclarationError> {
		let actual = source.replayability();
		let valid = matches!(
			(declaration, actual),
			(NativeStreamDeclaration::Replayable, Replayability::Replayable | Replayability::Staged)
				| (NativeStreamDeclaration::OneShot, Replayability::OneShot)
		);
		if valid {
			Ok(Self { source, declaration })
		} else {
			Err(NativeDeclarationError { declared: declaration, actual })
		}
	}

	/// Starts one independently tracked native body attempt.
	pub fn begin_attempt(&self) -> BodyAttempt {
		self.source.begin_attempt()
	}

	/// Returns the validated declaration.
	pub const fn declaration(&self) -> NativeStreamDeclaration {
		self.declaration
	}

	/// Returns native-tagged replay evidence.
	pub fn replay_evidence(&self) -> ReplayEvidence {
		ReplayEvidence {
			replayability: self.source.replayability(),
			parts:         Arc::from([BodyPartEvidence {
				kind:          BodyPartKind::Native(self.declaration),
				replayability: self.source.replayability(),
			}]),
		}
	}

	/// Returns the validated physical source.
	pub const fn source(&self) -> &BodySource {
		&self.source
	}
}

/// Typed failure to acquire a body reader.
#[derive(Clone, Debug, thiserror::Error)]
pub enum BodyOpenError {
	/// This attempt already tried to acquire its reader.
	#[error("body attempt already tried to acquire a reader")]
	AttemptAlreadyOpened,
	/// Another one-shot reader is still active.
	#[error("one-shot body already has an active reader")]
	ConcurrentReader,
	/// The one-shot source was already polled.
	#[error("one-shot body has been consumed")]
	Consumed,
	/// An unread reader was dropped without an explicit reacquisition factory.
	#[error("one-shot body cannot be safely reacquired")]
	ReacquisitionUnavailable,
	/// A deterministic factory failed before a reader was acquired.
	#[error("body factory failed: {0}")]
	Factory(#[source] Error),
}

struct OneShotState {
	initial:   Option<ByteStream>,
	reacquire: Option<BodyFactoryHandle>,
	active:    bool,
	opened:    bool,
	consumed:  bool,
}

/// Single-reader body state shared by clone-cheap request envelopes.
pub struct OneShotBody {
	state: Mutex<OneShotState>,
}

impl fmt::Debug for OneShotBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let state = self.state.lock();
		formatter
			.debug_struct("OneShotBody")
			.field("has_initial", &state.initial.is_some())
			.field("has_reacquisition", &state.reacquire.is_some())
			.field("active", &state.active)
			.field("opened", &state.opened)
			.field("consumed", &state.consumed)
			.finish()
	}
}

impl OneShotBody {
	/// Creates a one-shot source that cannot be reacquired after an unread
	/// reader is dropped.
	pub fn new(stream: ByteStream) -> Self {
		Self {
			state: Mutex::new(OneShotState {
				initial:   Some(stream),
				reacquire: None,
				active:    false,
				opened:    false,
				consumed:  false,
			}),
		}
	}

	/// Creates a one-shot source with an explicit factory usable only after a
	/// pre-poll drop.
	pub fn with_reacquisition(stream: ByteStream, factory: BodyFactoryHandle) -> Self {
		Self {
			state: Mutex::new(OneShotState {
				initial:   Some(stream),
				reacquire: Some(factory),
				active:    false,
				opened:    false,
				consumed:  false,
			}),
		}
	}

	fn decision(&self) -> (RetryDecision, RetryDecisionReason) {
		let state = self.state.lock();
		if state.consumed {
			(RetryDecision::Suppress, RetryDecisionReason::ConsumedOneShot)
		} else if state.active {
			(RetryDecision::Suppress, RetryDecisionReason::ActiveReader)
		} else if !state.opened && state.initial.is_some() {
			(RetryDecision::Allow, RetryDecisionReason::OneShotUnopened)
		} else if state.reacquire.is_some() {
			(RetryDecision::Allow, RetryDecisionReason::SafeReacquisition)
		} else {
			(RetryDecision::Suppress, RetryDecisionReason::ReacquisitionUnavailable)
		}
	}

	fn safe_reacquisition(&self) -> bool {
		self.state.lock().reacquire.is_some()
	}

	async fn acquire(self: &Arc<Self>) -> Result<(ByteStream, Arc<Self>), BodyOpenError> {
		let acquisition = {
			let mut state = self.state.lock();
			if state.consumed {
				return Err(BodyOpenError::Consumed);
			}
			if state.active {
				return Err(BodyOpenError::ConcurrentReader);
			}
			let acquisition = if let Some(stream) = state.initial.take() {
				OneShotAcquisition::Initial(stream)
			} else if let Some(factory) = state.reacquire.clone() {
				OneShotAcquisition::Factory(factory)
			} else {
				return Err(BodyOpenError::ReacquisitionUnavailable);
			};
			state.active = true;
			acquisition
		};

		let mut reservation = OneShotReservation { body: Arc::clone(self), armed: true };
		let stream = match acquisition {
			OneShotAcquisition::Initial(stream) => stream,
			OneShotAcquisition::Factory(factory) => {
				factory.open().await.map_err(BodyOpenError::Factory)?
			},
		};
		self.state.lock().opened = true;
		reservation.armed = false;
		Ok((stream, Arc::clone(self)))
	}
}

enum OneShotAcquisition {
	Initial(ByteStream),
	Factory(BodyFactoryHandle),
}

struct OneShotReservation {
	body:  Arc<OneShotBody>,
	armed: bool,
}

impl Drop for OneShotReservation {
	fn drop(&mut self) {
		if self.armed {
			self.body.state.lock().active = false;
		}
	}
}

/// Clone-cheap request body source with explicit replay semantics.
#[derive(Clone, Debug)]
pub enum BodySource {
	/// Inline immutable bytes.
	Bytes(Bytes),
	/// Immutable stored content held by a live repeatable-read lease.
	Stored(StoredBody),
	/// Deterministic factory opened afresh for every attempt.
	Factory(BodyFactoryHandle),
	/// Single-reader caller or live stream.
	OneShot(Arc<OneShotBody>),
	/// Ordered multipart chunks and streams opened independently without byte
	/// aggregation.
	Multipart(Arc<[Self]>),
}

impl BodySource {
	/// Creates replayable inline body bytes.
	pub const fn bytes(bytes: Bytes) -> Self {
		Self::Bytes(bytes)
	}

	/// Wraps a caller-owned or live stream as a one-shot body.
	pub fn from_stream(stream: ByteStream) -> Self {
		Self::OneShot(Arc::new(OneShotBody::new(stream)))
	}

	/// Composes ordered multipart preambles, payloads, and boundaries without
	/// aggregating bytes.
	pub fn multipart(parts: impl Into<Arc<[Self]>>) -> Self {
		Self::Multipart(parts.into())
	}

	/// Returns the source's physical replayability.
	pub fn replayability(&self) -> Replayability {
		match self {
			Self::Bytes(_) => Replayability::Replayable,
			Self::Stored(stored) => stored.factory.replayability(),
			Self::Factory(factory) => factory.replayability(),
			Self::OneShot(_) => Replayability::OneShot,
			Self::Multipart(parts) => Replayability::aggregate(parts.iter().map(Self::replayability)),
		}
	}

	/// Returns complete evidence for this source.
	pub fn replay_evidence(&self) -> ReplayEvidence {
		if let Self::Multipart(parts) = self {
			return ReplayEvidence::aggregate(parts.iter().map(Self::replay_evidence));
		}
		let (kind, replayability) = match self {
			Self::Bytes(_) => (BodyPartKind::Bytes, Replayability::Replayable),
			Self::Stored(stored) => {
				(BodyPartKind::Stored(stored.evidence.clone()), stored.factory.replayability())
			},
			Self::Factory(factory) => (BodyPartKind::Factory, factory.replayability()),
			Self::OneShot(body) => (
				BodyPartKind::OneShot { safe_reacquisition: body.safe_reacquisition() },
				Replayability::OneShot,
			),
			Self::Multipart(_) => unreachable!("multipart evidence is flattened before matching"),
		};
		ReplayEvidence { replayability, parts: Arc::from([BodyPartEvidence { kind, replayability }]) }
	}

	/// Begins one independently tracked acquisition attempt.
	pub fn begin_attempt(&self) -> BodyAttempt {
		let policy = match self {
			Self::OneShot(body) => EvidencePolicy::OneShot(Arc::clone(body)),
			Self::Multipart(_) if self.replayability() == Replayability::OneShot => {
				let mut bodies = Vec::new();
				self.collect_one_shots(&mut bodies);
				EvidencePolicy::MultipartOneShot(bodies.into())
			},
			_ => EvidencePolicy::Repeatable(self.replayability()),
		};
		BodyAttempt {
			source:    self.clone(),
			evidence:  AttemptEvidenceHandle {
				state: Arc::new(AttemptState {
					opened: AtomicBool::new(false),
					consumed: AtomicBool::new(false),
					policy,
				}),
			},
			attempted: false,
		}
	}

	fn collect_one_shots(&self, output: &mut Vec<Arc<OneShotBody>>) {
		match self {
			Self::OneShot(body) => output.push(Arc::clone(body)),
			Self::Multipart(parts) => {
				for part in parts.iter() {
					part.collect_one_shots(output);
				}
			},
			Self::Bytes(_) | Self::Stored(_) | Self::Factory(_) => {},
		}
	}
}

enum EvidencePolicy {
	Repeatable(Replayability),
	OneShot(Arc<OneShotBody>),
	MultipartOneShot(Arc<[Arc<OneShotBody>]>),
}

struct AttemptState {
	opened:   AtomicBool,
	consumed: AtomicBool,
	policy:   EvidencePolicy,
}

/// Cloneable observation handle that remains valid after the reader is moved or
/// dropped.
#[derive(Clone)]
pub struct AttemptEvidenceHandle {
	state: Arc<AttemptState>,
}

impl AttemptEvidenceHandle {
	/// Snapshots exact opened, consumed, replayability, and retry evidence.
	pub fn evidence(&self) -> AttemptBodyEvidence {
		let opened = self.state.opened.load(Ordering::Acquire);
		let consumed = self.state.consumed.load(Ordering::Acquire);
		let (replayability, retry_decision, reason) = match &self.state.policy {
			EvidencePolicy::Repeatable(Replayability::Replayable) => {
				(Replayability::Replayable, RetryDecision::Allow, RetryDecisionReason::ReplayableSource)
			},
			EvidencePolicy::Repeatable(Replayability::Staged) => {
				(Replayability::Staged, RetryDecision::Allow, RetryDecisionReason::StagedSource)
			},
			EvidencePolicy::Repeatable(Replayability::OneShot) => {
				unreachable!("one-shot evidence has shared state")
			},
			EvidencePolicy::OneShot(body) => {
				let (decision, reason) = body.decision();
				(Replayability::OneShot, decision, reason)
			},
			EvidencePolicy::MultipartOneShot(bodies) => {
				let (decision, reason) = multipart_one_shot_decision(bodies);
				(Replayability::OneShot, decision, reason)
			},
		};
		AttemptBodyEvidence { opened, consumed, replayability, retry_decision, reason }
	}
}

fn multipart_one_shot_decision(
	bodies: &[Arc<OneShotBody>],
) -> (RetryDecision, RetryDecisionReason) {
	let mut allowed_reason = RetryDecisionReason::SafeReacquisition;
	let mut suppressed = None;
	for body in bodies {
		let (decision, reason) = body.decision();
		if decision == RetryDecision::Allow {
			if reason == RetryDecisionReason::OneShotUnopened {
				allowed_reason = reason;
			}
			continue;
		}
		let priority = match reason {
			RetryDecisionReason::ConsumedOneShot => 3,
			RetryDecisionReason::ActiveReader => 2,
			RetryDecisionReason::ReacquisitionUnavailable => 1,
			_ => 0,
		};
		if suppressed.is_none_or(|(current, _)| priority > current) {
			suppressed = Some((priority, reason));
		}
	}
	suppressed.map_or((RetryDecision::Allow, allowed_reason), |(_, reason)| {
		(RetryDecision::Suppress, reason)
	})
}

impl fmt::Debug for AttemptEvidenceHandle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		self.evidence().fmt(formatter)
	}
}

/// One request attempt with evidence retained independently from its reader.
pub struct BodyAttempt {
	source:    BodySource,
	evidence:  AttemptEvidenceHandle,
	attempted: bool,
}

impl BodyAttempt {
	/// Returns a handle suitable for a receipt or retry layer to retain.
	pub fn evidence_handle(&self) -> AttemptEvidenceHandle {
		self.evidence.clone()
	}

	/// Snapshots exact evidence for this attempt.
	pub fn evidence(&self) -> AttemptBodyEvidence {
		self.evidence.evidence()
	}

	/// Acquires this attempt's reader, opening factories afresh and never
	/// reusing a cursor.
	pub async fn open(&mut self) -> Result<BodyReader, BodyOpenError> {
		if self.attempted {
			return Err(BodyOpenError::AttemptAlreadyOpened);
		}
		self.attempted = true;
		if matches!(&self.source, BodySource::Multipart(_)) {
			self.open_multipart().await
		} else {
			self.open_leaf().await
		}
	}

	async fn open_leaf(&self) -> Result<BodyReader, BodyOpenError> {
		let (stream, one_shot) = match &self.source {
			BodySource::Bytes(bytes) => {
				let stream: ByteStream = Box::pin(stream::once(future::ready(Ok(bytes.clone()))));
				(stream, None)
			},
			BodySource::Stored(stored) => (
				stored
					.factory
					.open()
					.await
					.map_err(BodyOpenError::Factory)?,
				None,
			),
			BodySource::Factory(factory) => {
				(factory.open().await.map_err(BodyOpenError::Factory)?, None)
			},
			BodySource::OneShot(body) => {
				let (stream, owner) = body.acquire().await?;
				(stream, Some(owner))
			},
			BodySource::Multipart(_) => {
				return Err(BodyOpenError::AttemptAlreadyOpened);
			},
		};
		self.evidence.state.opened.store(true, Ordering::Release);
		Ok(BodyReader { stream, evidence: self.evidence.clone(), one_shot })
	}

	async fn open_multipart(&self) -> Result<BodyReader, BodyOpenError> {
		let BodySource::Multipart(parts) = &self.source else {
			return Err(BodyOpenError::AttemptAlreadyOpened);
		};
		let mut pending = VecDeque::from_iter(parts.iter().cloned());
		let mut readers = VecDeque::with_capacity(parts.len());
		while let Some(part) = pending.pop_front() {
			if let BodySource::Multipart(nested) = part {
				for child in nested.iter().rev() {
					pending.push_front(child.clone());
				}
				continue;
			}
			let mut attempt = part.begin_attempt();
			attempt.attempted = true;
			readers.push_back(attempt.open_leaf().await?);
		}
		let stream: ByteStream = Box::pin(MultipartReader { readers });
		self.evidence.state.opened.store(true, Ordering::Release);
		Ok(BodyReader { stream, evidence: self.evidence.clone(), one_shot: None })
	}
}

impl fmt::Debug for BodyAttempt {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BodyAttempt")
			.field("attempted", &self.attempted)
			.field("evidence", &self.evidence)
			.finish_non_exhaustive()
	}
}

struct MultipartReader {
	readers: VecDeque<BodyReader>,
}

impl Stream for MultipartReader {
	type Item = Result<Bytes, Error>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		loop {
			let Some(reader) = self.readers.front_mut() else {
				return Poll::Ready(None);
			};
			match Pin::new(reader).poll_next(context) {
				Poll::Ready(None) => {
					self.readers.pop_front();
				},
				result => return result,
			}
		}
	}
}

/// Attempt-scoped body reader that marks consumption before its first
/// underlying poll.
pub struct BodyReader {
	stream:   ByteStream,
	evidence: AttemptEvidenceHandle,
	one_shot: Option<Arc<OneShotBody>>,
}

impl BodyReader {
	/// Returns an evidence handle that outlives this reader.
	pub fn evidence_handle(&self) -> AttemptEvidenceHandle {
		self.evidence.clone()
	}
}

impl fmt::Debug for BodyReader {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BodyReader")
			.field("evidence", &self.evidence)
			.finish_non_exhaustive()
	}
}

impl Stream for BodyReader {
	type Item = Result<Bytes, Error>;

	fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		if !self.evidence.state.consumed.swap(true, Ordering::AcqRel)
			&& let Some(body) = &self.one_shot
		{
			body.state.lock().consumed = true;
		}
		self.stream.as_mut().poll_next(context)
	}
}

impl Drop for BodyReader {
	fn drop(&mut self) {
		if let Some(body) = &self.one_shot {
			body.state.lock().active = false;
		}
	}
}

/// Aggregates replay evidence for multipart media, transcription, realtime, or
/// native input.
pub fn aggregate_replay_evidence<'a>(
	sources: impl IntoIterator<Item = &'a BodySource>,
) -> ReplayEvidence {
	ReplayEvidence::aggregate(sources.into_iter().map(BodySource::replay_evidence))
}

/// Creates a convenient single-chunk stream for factories and one-shot callers.
pub fn byte_stream(bytes: Bytes) -> ByteStream {
	Box::pin(stream::once(future::ready(Ok(bytes))))
}

/// Creates a stream that never produces a frame until cancelled or dropped.
pub fn pending_byte_stream() -> ByteStream {
	Box::pin(stream::pending())
}

#[cfg(test)]
mod tests {
	use std::{
		future::{Ready, ready},
		pin::Pin,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		task::Poll,
	};

	use bytes::Bytes;
	use futures::{Stream, StreamExt, poll};
	use omp_core::sf;

	use super::{
		ArtifactLease, ArtifactReadGuarantee, AttemptBodyEvidence, BodyFactory, BodyFactoryHandle,
		BodyOpenError, BodyPartKind, BodySource, ByteStream, NativeBodySource,
		NativeStreamDeclaration, OneShotBody, ReplayEvidence, Replayability, RetryDecision,
		RetryDecisionReason, StoredBody, aggregate_replay_evidence, byte_stream, pending_byte_stream,
	};
	use crate::{
		answer::ArtifactRef,
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		receipt::ExecutionReceipt,
	};

	fn chunk(value: &'static [u8]) -> Bytes {
		Bytes::from_static(value)
	}

	#[tokio::test]
	async fn consumed_one_shot_suppresses_every_automatic_reacquisition() {
		let source = BodySource::OneShot(Arc::new(OneShotBody::new(byte_stream(chunk(b"a")))));
		let mut attempt = source.begin_attempt();
		assert_eq!(attempt.evidence(), AttemptBodyEvidence {
			opened:         false,
			consumed:       false,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::OneShotUnopened,
		});

		let mut reader = attempt.open().await.expect("initial reader");
		assert_eq!(reader.next().await.expect("frame").expect("bytes"), chunk(b"a"));
		drop(reader);

		assert_eq!(attempt.evidence(), AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		});
		let mut retry = source.begin_attempt();
		assert!(matches!(retry.open().await, Err(BodyOpenError::Consumed)));
	}

	#[tokio::test]
	async fn unread_drop_uses_only_the_explicit_reacquisition_factory() {
		let opens = Arc::new(AtomicUsize::new(0));
		let factory_opens = Arc::clone(&opens);
		let factory = BodyFactoryHandle::new(move || {
			let ordinal = factory_opens.fetch_add(1, Ordering::SeqCst) + 1;
			async move { Ok(byte_stream(Bytes::from(ordinal.to_string()))) }
		});
		let source = BodySource::OneShot(Arc::new(OneShotBody::with_reacquisition(
			byte_stream(chunk(b"initial")),
			factory,
		)));

		let mut first = source.begin_attempt();
		let reader = first.open().await.expect("initial reader");
		drop(reader);
		assert_eq!(first.evidence(), AttemptBodyEvidence {
			opened:         true,
			consumed:       false,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::SafeReacquisition,
		});

		let mut second = source.begin_attempt();
		let mut reader = second.open().await.expect("reacquired reader");
		assert_eq!(reader.next().await.expect("frame").expect("bytes"), chunk(b"1"));
		assert_eq!(opens.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn unread_drop_without_factory_is_not_reacquirable() {
		let source = BodySource::OneShot(Arc::new(OneShotBody::new(byte_stream(chunk(b"single")))));
		let mut first = source.begin_attempt();
		drop(first.open().await.expect("initial reader"));
		assert_eq!(first.evidence(), AttemptBodyEvidence {
			opened:         true,
			consumed:       false,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ReacquisitionUnavailable,
		});
		let mut retry = source.begin_attempt();
		assert!(matches!(retry.open().await, Err(BodyOpenError::ReacquisitionUnavailable)));
	}

	#[tokio::test]
	async fn concurrent_one_shot_reader_is_rejected_before_poll() {
		let source = BodySource::OneShot(Arc::new(OneShotBody::with_reacquisition(
			byte_stream(chunk(b"initial")),
			BodyFactoryHandle::new(|| async { Ok(byte_stream(chunk(b"fresh"))) }),
		)));
		let mut first = source.begin_attempt();
		let reader = first.open().await.expect("first reader");
		let mut concurrent = source.begin_attempt();
		assert!(matches!(concurrent.open().await, Err(BodyOpenError::ConcurrentReader)));
		assert_eq!(first.evidence().reason, RetryDecisionReason::ActiveReader);
		drop(reader);
		assert_eq!(first.evidence().reason, RetryDecisionReason::SafeReacquisition);
	}

	#[tokio::test]
	async fn factories_open_fresh_streams_and_never_reuse_partial_cursors() {
		let opens = Arc::new(AtomicUsize::new(0));
		let factory_opens = Arc::clone(&opens);
		let source = BodySource::Factory(BodyFactoryHandle::new(move || {
			let ordinal = factory_opens.fetch_add(1, Ordering::SeqCst) + 1;
			async move {
				let first = Bytes::from(format!("{ordinal}:first"));
				let second = Bytes::from(format!("{ordinal}:second"));
				let stream: ByteStream = Box::pin(futures::stream::iter([Ok(first), Ok(second)]));
				Ok(stream)
			}
		}));

		let mut first = source.begin_attempt();
		let mut first_reader = first.open().await.expect("first factory open");
		assert_eq!(first_reader.next().await.expect("frame").expect("bytes"), chunk(b"1:first"));
		drop(first_reader);

		let mut second = source.begin_attempt();
		let mut second_reader = second.open().await.expect("second factory open");
		assert_eq!(second_reader.next().await.expect("frame").expect("bytes"), chunk(b"2:first"));
		assert_eq!(opens.load(Ordering::SeqCst), 2);
		assert_eq!(first.evidence().retry_decision, RetryDecision::Allow);
	}

	#[test]
	fn mixed_multipart_evidence_is_conservatively_one_shot() {
		let bytes = BodySource::Bytes(chunk(b"text"));
		let staged = BodySource::Factory(BodyFactoryHandle::staged(|| async {
			Ok(byte_stream(chunk(b"staged")))
		}));
		let live = BodySource::OneShot(Arc::new(OneShotBody::new(byte_stream(chunk(b"live")))));
		let evidence = aggregate_replay_evidence([&bytes, &staged, &live]);

		assert_eq!(evidence.replayability, Replayability::OneShot);
		assert_eq!(evidence.parts.len(), 3);
		assert_eq!(evidence.parts[0].replayability, Replayability::Replayable);
		assert_eq!(evidence.parts[1].replayability, Replayability::Staged);
		assert!(matches!(evidence.parts[2].kind, BodyPartKind::OneShot {
			safe_reacquisition: false,
		}));
	}

	#[tokio::test]
	async fn multipart_source_streams_ordered_chunks_without_aggregating() {
		let opens = Arc::new(AtomicUsize::new(0));
		let factory_opens = Arc::clone(&opens);
		let source = BodySource::multipart(vec![
			BodySource::multipart(vec![BodySource::bytes(chunk(b"--boundary\r\n"))]),
			BodySource::Factory(BodyFactoryHandle::new(move || {
				factory_opens.fetch_add(1, Ordering::SeqCst);
				async {
					let stream: ByteStream = Box::pin(futures::stream::iter([
						Ok(chunk(b"payload-a")),
						Ok(chunk(b"payload-b")),
					]));
					Ok(stream)
				}
			})),
			BodySource::bytes(chunk(b"\r\n--boundary--\r\n")),
		]);
		assert_eq!(source.replayability(), Replayability::Replayable);

		let mut first = source.begin_attempt();
		let chunks = first
			.open()
			.await
			.expect("multipart reader")
			.collect::<Vec<_>>()
			.await
			.into_iter()
			.collect::<Result<Vec<_>, _>>()
			.expect("multipart chunks");
		assert_eq!(chunks, vec![
			chunk(b"--boundary\r\n"),
			chunk(b"payload-a"),
			chunk(b"payload-b"),
			chunk(b"\r\n--boundary--\r\n"),
		]);

		let mut second = source.begin_attempt();
		drop(second.open().await.expect("fresh multipart reader"));
		assert_eq!(opens.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn mixed_multipart_source_tracks_child_one_shot_consumption() {
		let source = BodySource::multipart(vec![
			BodySource::bytes(chunk(b"--boundary\r\n")),
			BodySource::from_stream(byte_stream(chunk(b"live-media"))),
			BodySource::bytes(chunk(b"\r\n--boundary--\r\n")),
		]);
		assert_eq!(source.replayability(), Replayability::OneShot);
		let mut attempt = source.begin_attempt();
		assert_eq!(attempt.evidence().reason, RetryDecisionReason::OneShotUnopened);
		let mut reader = attempt.open().await.expect("multipart reader");
		assert_eq!(attempt.evidence().reason, RetryDecisionReason::ActiveReader);
		while reader.next().await.is_some() {}
		drop(reader);
		assert_eq!(attempt.evidence(), AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		});
	}

	#[test]
	fn transcription_media_realtime_and_native_streams_keep_body_evidence() {
		let transcript_audio =
			BodySource::OneShot(Arc::new(OneShotBody::new(byte_stream(chunk(b"microphone")))));
		let media = BodySource::Bytes(chunk(b"image"));
		let realtime = BodySource::OneShot(Arc::new(OneShotBody::new(pending_byte_stream())));
		let request = ReplayEvidence::aggregate([
			transcript_audio.replay_evidence(),
			media.replay_evidence(),
			realtime.replay_evidence(),
		]);
		assert_eq!(request.replayability, Replayability::OneShot);
		assert_eq!(request.parts.len(), 3);

		let native = NativeBodySource::new(
			BodySource::OneShot(Arc::new(OneShotBody::new(byte_stream(chunk(b"native"))))),
			NativeStreamDeclaration::OneShot,
		)
		.expect("matching declaration");
		assert_eq!(native.replay_evidence().replayability, Replayability::OneShot);
		assert!(
			NativeBodySource::new(
				BodySource::Bytes(chunk(b"native")),
				NativeStreamDeclaration::OneShot,
			)
			.is_err()
		);
	}

	#[tokio::test]
	async fn pending_poll_marks_consumed_before_cancellation_drop() {
		let source = BodySource::OneShot(Arc::new(OneShotBody::new(pending_byte_stream())));
		let mut attempt = source.begin_attempt();
		let mut reader = attempt.open().await.expect("reader");
		let polled = futures::future::poll_fn(|context| {
			assert!(matches!(Pin::new(&mut reader).poll_next(context), Poll::Pending));
			Poll::Ready(())
		})
		.await;
		assert_eq!(polled, ());
		drop(reader);
		assert_eq!(attempt.evidence(), AttemptBodyEvidence {
			opened:         true,
			consumed:       true,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Suppress,
			reason:         RetryDecisionReason::ConsumedOneShot,
		});
	}

	#[tokio::test]
	async fn cancelled_factory_open_releases_the_single_reader_reservation() {
		let calls = Arc::new(AtomicUsize::new(0));
		let factory_calls = Arc::clone(&calls);
		let factory = BodyFactoryHandle::new(move || {
			let call = factory_calls.fetch_add(1, Ordering::SeqCst);
			async move {
				if call == 0 {
					futures::future::pending::<()>().await;
				}
				Ok(byte_stream(chunk(b"reacquired")))
			}
		});
		let source = BodySource::OneShot(Arc::new(OneShotBody::with_reacquisition(
			byte_stream(chunk(b"initial")),
			factory,
		)));
		let mut initial = source.begin_attempt();
		drop(initial.open().await.expect("initial reader"));

		let mut cancelled = source.begin_attempt();
		{
			let opening = cancelled.open();
			futures::pin_mut!(opening);
			assert!(matches!(poll!(opening.as_mut()), Poll::Pending));
		}

		let mut retry = source.begin_attempt();
		let mut reader = retry
			.open()
			.await
			.expect("reservation released on cancellation");
		assert_eq!(reader.next().await.expect("frame").expect("bytes"), chunk(b"reacquired"));
	}

	#[tokio::test]
	async fn failed_factory_open_leaves_exact_unopened_evidence_and_releases_reservation() {
		let factory = BodyFactoryHandle::new(|| async {
			Err(Error::new(
				ErrorKind::Connectivity,
				ErrorPhase::Connecting,
				RetryAction::Never,
				ExecutionReceipt::default(),
			))
		});
		let source = BodySource::OneShot(Arc::new(OneShotBody::with_reacquisition(
			byte_stream(chunk(b"initial")),
			factory,
		)));
		let mut initial = source.begin_attempt();
		drop(initial.open().await.expect("initial reader"));

		let mut failed = source.begin_attempt();
		assert!(matches!(failed.open().await, Err(BodyOpenError::Factory(_))));
		assert_eq!(failed.evidence(), AttemptBodyEvidence {
			opened:         false,
			consumed:       false,
			replayability:  Replayability::OneShot,
			retry_decision: RetryDecision::Allow,
			reason:         RetryDecisionReason::SafeReacquisition,
		});
		let mut next = source.begin_attempt();
		assert!(matches!(next.open().await, Err(BodyOpenError::Factory(_))));
	}

	struct MockLease {
		artifact: ArtifactRef,
		drops:    Arc<AtomicUsize>,
	}

	impl BodyFactory for MockLease {
		type OpenFuture<'a> = Ready<Result<ByteStream, Error>>;

		fn open(&self) -> Self::OpenFuture<'_> {
			ready(Ok(byte_stream(chunk(b"leased"))))
		}
	}

	impl ArtifactLease for MockLease {
		fn artifact(&self) -> &ArtifactRef {
			&self.artifact
		}
	}

	impl Drop for MockLease {
		fn drop(&mut self) {
			self.drops.fetch_add(1, Ordering::SeqCst);
		}
	}

	#[test]
	fn stored_source_retains_immutable_repeatable_lease_for_all_clones() {
		let drops = Arc::new(AtomicUsize::new(0));
		let stored = StoredBody::new(MockLease {
			artifact: ArtifactRef {
				store:    sf!("media"),
				id:       sf!("object"),
				revision: sf!("sha256:abc"),
			},
			drops:    Arc::clone(&drops),
		});
		let source = BodySource::Stored(stored);
		let clone = source.clone();
		let evidence = source.replay_evidence();
		assert!(matches!(
			&evidence.parts[0].kind,
			BodyPartKind::Stored(lease)
				if lease.guarantee == ArtifactReadGuarantee::ImmutableRepeatableForPlan
		));
		drop(source);
		assert_eq!(drops.load(Ordering::SeqCst), 0);
		drop(clone);
		assert_eq!(drops.load(Ordering::SeqCst), 1);
	}
}
