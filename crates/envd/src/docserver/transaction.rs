//! Revisioned, idempotent document transactions over actor-owned snapshots.
//!
//! Planning is memory-only, all persistence is capability-prepared before the
//! first durable operation, and final authorization remains inside actor
//! mailboxes.

use std::{
	collections::HashMap, future, future::Future, mem, path::PathBuf, result, str, sync::Arc,
};

use bytes::Bytes;
use omp_core::{Str, sf};
use parking_lot::Mutex;
use tokio::{
	sync::oneshot,
	task,
	time::{self, Duration},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	ByteEdit, ByteRange, DocumentHead, DocumentId, DocumentKind, DocumentLocator, DocumentPresence,
	DocumentSnapshot, DocumentStore, Error, LanguageId, LeaseId, ReadBody, ReadSelection, Result,
	Revision, TransactionId,
	actor::{
		ActorHandle, CommittedSnapshotMetadata, DestinationExpectation, DocumentReservation,
		PathReservation, ReservedDocument,
	},
	apply_edits, canonical_edits,
	fs::{DiskExpectation, PreparedDelete, PreparedMove, PreparedWrite},
	rebase_content,
};

/// A transaction target matching the document protocol's id, lease, or URI
/// forms.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum DocumentTarget {
	/// An active document identity.
	Document(DocumentId),
	/// An active document lease.
	Lease(LeaseId),
	/// A confined local file URI.
	Uri(Url),
}

/// The supplied form of a text proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextProposal {
	/// Exact proposed bytes for the whole document.
	Content(Bytes),
	/// Sorted, non-overlapping edits in base-revision byte coordinates.
	Edits(Vec<ByteEdit>),
}

/// Behavior when a text proposal's base is not the transaction-local head.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StalePolicy {
	/// Reject rather than applying a last-writer-wins update.
	Fail,
	/// Rebase only edits whose unchanged context maps uniquely.
	RebaseNonOverlapping,
	/// Destructively replace with explicitly supplied whole content.
	ForceReplace,
}

/// Formatting requirement for a provisional text candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FormatPolicy {
	/// Do not invoke a formatter.
	Disabled,
	/// Use formatted bytes when formatting succeeds, otherwise use the
	/// candidate.
	BestEffort,
	/// Reject unless formatting succeeds for the exact candidate.
	Required,
}

/// A revisioned text transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextMutation {
	base_revision: Revision,
	proposal:      TextProposal,
	stale_policy:  StalePolicy,
	format_policy: FormatPolicy,
}

impl TextMutation {
	/// Creates a text mutation.
	pub const fn new(
		base_revision: Revision,
		proposal: TextProposal,
		stale_policy: StalePolicy,
		format_policy: FormatPolicy,
	) -> Self {
		Self { base_revision, proposal, stale_policy, format_policy }
	}

	/// Returns the expected committed base.
	pub const fn base_revision(&self) -> Revision {
		self.base_revision
	}

	/// Returns the proposed transition.
	pub const fn proposal(&self) -> &TextProposal {
		&self.proposal
	}

	/// Returns stale-base behavior.
	pub const fn stale_policy(&self) -> StalePolicy {
		self.stale_policy
	}

	/// Returns formatting behavior.
	pub const fn format_policy(&self) -> FormatPolicy {
		self.format_policy
	}
}

/// Existing-target behavior for a create mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistingDocumentPolicy {
	/// Reject if a regular file is already present.
	FailIfExists,
	/// Replace an existing regular file through revisioned persistence.
	ReplaceExisting,
}

/// A content creation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateMutation {
	content:           Bytes,
	existing_document: ExistingDocumentPolicy,
	format_policy:     FormatPolicy,
}

impl CreateMutation {
	/// Creates a create-or-replace mutation.
	pub const fn new(
		content: Bytes,
		existing_document: ExistingDocumentPolicy,
		format_policy: FormatPolicy,
	) -> Self {
		Self { content, existing_document, format_policy }
	}

	/// Returns proposed bytes.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Returns existing-target behavior.
	pub const fn existing_document(&self) -> ExistingDocumentPolicy {
		self.existing_document
	}

	/// Returns formatting behavior.
	pub const fn format_policy(&self) -> FormatPolicy {
		self.format_policy
	}
}

/// A revisioned deletion request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeleteMutation {
	base_revision: Revision,
}

impl DeleteMutation {
	/// Creates a deletion against an exact committed revision.
	pub const fn new(base_revision: Revision) -> Self {
		Self { base_revision }
	}

	/// Returns the exact source revision.
	pub const fn base_revision(&self) -> Revision {
		self.base_revision
	}
}

/// Destination state required by a move.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveDestinationPrecondition {
	/// The destination entry must not exist.
	MustNotExist,
	/// An inactive destination must have this exact retained revision.
	Revision(Revision),
}

/// A revisioned move preserving the source document identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveMutation {
	base_revision:            Revision,
	destination:              Url,
	destination_precondition: MoveDestinationPrecondition,
}

impl MoveMutation {
	/// Creates a move request.
	pub const fn new(
		base_revision: Revision,
		destination: Url,
		destination_precondition: MoveDestinationPrecondition,
	) -> Self {
		Self { base_revision, destination, destination_precondition }
	}

	/// Returns the exact source revision.
	pub const fn base_revision(&self) -> Revision {
		self.base_revision
	}

	/// Returns the destination URI.
	pub const fn destination(&self) -> &Url {
		&self.destination
	}

	/// Returns the destination precondition.
	pub const fn destination_precondition(&self) -> MoveDestinationPrecondition {
		self.destination_precondition
	}
}
/// An atomic revisioned move that installs exact final content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveWithContentMutation {
	base_revision:            Revision,
	destination:              Url,
	destination_precondition: MoveDestinationPrecondition,
	content:                  Bytes,
	format_policy:            FormatPolicy,
}

impl MoveWithContentMutation {
	/// Creates an atomic move-with-content request.
	pub const fn new(
		base_revision: Revision,
		destination: Url,
		destination_precondition: MoveDestinationPrecondition,
		content: Bytes,
		format_policy: FormatPolicy,
	) -> Self {
		Self { base_revision, destination, destination_precondition, content, format_policy }
	}

	/// Returns the exact source revision.
	pub const fn base_revision(&self) -> Revision {
		self.base_revision
	}

	/// Returns the destination URI.
	pub const fn destination(&self) -> &Url {
		&self.destination
	}

	/// Returns the destination precondition.
	pub const fn destination_precondition(&self) -> MoveDestinationPrecondition {
		self.destination_precondition
	}

	/// Returns the final destination bytes.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Returns formatting behavior.
	pub const fn format_policy(&self) -> FormatPolicy {
		self.format_policy
	}
}

/// One declared mutation operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOperation {
	/// A revisioned text proposal.
	Text(TextMutation),
	/// A create-or-replace proposal.
	Create(CreateMutation),
	/// A revisioned delete.
	Delete(DeleteMutation),
	/// A revisioned move.
	Move(MoveMutation),
	/// An atomic revisioned move with final content.
	MoveWithContent(MoveWithContentMutation),
}

/// One targeted transaction operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentMutation {
	target:    DocumentTarget,
	operation: MutationOperation,
}

impl DocumentMutation {
	/// Creates a targeted operation.
	pub const fn new(target: DocumentTarget, operation: MutationOperation) -> Self {
		Self { target, operation }
	}

	/// Returns the target.
	pub const fn target(&self) -> &DocumentTarget {
		&self.target
	}

	/// Returns the requested operation.
	pub const fn operation(&self) -> &MutationOperation {
		&self.operation
	}
}

/// An idempotent, declared-order document transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionRequest {
	transaction_id: TransactionId,
	operations:     Vec<DocumentMutation>,
}

impl TransactionRequest {
	/// Creates a transaction request.
	pub const fn new(transaction_id: TransactionId, operations: Vec<DocumentMutation>) -> Self {
		Self { transaction_id, operations }
	}

	/// Returns the server-epoch-scoped idempotency key.
	pub const fn transaction_id(&self) -> TransactionId {
		self.transaction_id
	}

	/// Returns operations in declared overlay order.
	pub fn operations(&self) -> &[DocumentMutation] {
		&self.operations
	}
}

/// Owned formatter input for an exact provisional candidate.
#[derive(Clone, Debug)]
pub struct FormatRequest {
	transaction_id:  TransactionId,
	operation_index: u32,
	base:            Arc<DocumentSnapshot>,
	uri:             Url,
	language_id:     Option<LanguageId>,
	candidate:       Bytes,
}

impl FormatRequest {
	/// Creates formatter input.
	pub const fn new(
		transaction_id: TransactionId,
		operation_index: u32,
		base: Arc<DocumentSnapshot>,
		uri: Url,
		language_id: Option<LanguageId>,
		candidate: Bytes,
	) -> Self {
		Self { transaction_id, operation_index, base, uri, language_id, candidate }
	}

	/// Returns the transaction id.
	pub const fn transaction_id(&self) -> TransactionId {
		self.transaction_id
	}

	/// Returns the declared operation index.
	pub const fn operation_index(&self) -> u32 {
		self.operation_index
	}

	/// Returns the committed snapshot used to synchronize the formatter.
	pub const fn base(&self) -> &Arc<DocumentSnapshot> {
		&self.base
	}

	/// Returns the candidate document URI.
	pub const fn uri(&self) -> &Url {
		&self.uri
	}

	/// Returns the optional language classification.
	pub const fn language_id(&self) -> Option<&LanguageId> {
		self.language_id.as_ref()
	}

	/// Returns exact provisional bytes.
	pub const fn candidate(&self) -> &Bytes {
		&self.candidate
	}
}

/// Exact bytes returned by a formatter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatResult {
	content: Bytes,
}

impl FormatResult {
	/// Creates a formatter result.
	pub const fn new(content: Bytes) -> Self {
		Self { content }
	}

	/// Returns formatted bytes.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Consumes the result into formatted bytes.
	pub fn into_content(self) -> Bytes {
		self.content
	}
}

/// A durable document publication delivered after actor installation.
#[derive(Clone, Debug)]
pub struct PublishedDocument {
	transaction_id:  TransactionId,
	operation_index: u32,
	head:            DocumentHead,
	content:         Bytes,
	uri:             Url,
	previous_uri:    Option<Url>,
}

impl PublishedDocument {
	/// Creates a committed publication.
	pub const fn new(
		transaction_id: TransactionId,
		operation_index: u32,
		head: DocumentHead,
		content: Bytes,
		uri: Url,
		previous_uri: Option<Url>,
	) -> Self {
		Self { transaction_id, operation_index, head, content, uri, previous_uri }
	}

	/// Returns the transaction id.
	pub const fn transaction_id(&self) -> TransactionId {
		self.transaction_id
	}

	/// Returns the declared operation index.
	pub const fn operation_index(&self) -> u32 {
		self.operation_index
	}

	/// Returns the installed actor head.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns exact bytes belonging to the installed head.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Returns the committed URI.
	pub const fn uri(&self) -> &Url {
		&self.uri
	}

	/// Returns the former URI for a move.
	pub const fn previous_uri(&self) -> Option<&Url> {
		self.previous_uri.as_ref()
	}
}

/// A formatter-visible candidate being discarded in favor of its public base.
#[derive(Clone, Debug)]
pub struct RevertedDocument {
	transaction_id:  TransactionId,
	operation_index: u32,
	snapshot:        Arc<DocumentSnapshot>,
	uri:             Url,
	language_id:     Option<LanguageId>,
}

impl RevertedDocument {
	/// Creates an uncommitted-candidate rollback.
	pub const fn new(
		transaction_id: TransactionId,
		operation_index: u32,
		snapshot: Arc<DocumentSnapshot>,
		uri: Url,
		language_id: Option<LanguageId>,
	) -> Self {
		Self { transaction_id, operation_index, snapshot, uri, language_id }
	}

	/// Returns the transaction which created the discarded candidate.
	pub const fn transaction_id(&self) -> TransactionId {
		self.transaction_id
	}

	/// Returns one declared operation which formatted this document.
	pub const fn operation_index(&self) -> u32 {
		self.operation_index
	}

	/// Returns the original public committed snapshot.
	pub const fn snapshot(&self) -> &Arc<DocumentSnapshot> {
		&self.snapshot
	}

	/// Returns the public snapshot URI.
	pub const fn uri(&self) -> &Url {
		&self.uri
	}

	/// Returns the public snapshot language classification.
	pub const fn language_id(&self) -> Option<&LanguageId> {
		self.language_id.as_ref()
	}
}

/// Formatting and committed-publication seam used by the transaction
/// coordinator.
pub trait FormatCoordinator: Send + Sync {
	/// Formats an exact provisional candidate.
	///
	/// `Ok` may leave the candidate formatter-visible until publication or
	/// [`Self::revert_uncommitted`]. `Err` must leave or restore `request.base`
	/// as the public formatter-visible state before returning.
	fn format_candidate(
		&self,
		request: FormatRequest,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<FormatResult>> + Send + '_;
	/// Publishes an actor-installed committed snapshot.
	fn publish_committed(
		&self,
		document: PublishedDocument,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<()>> + Send + '_;
	/// Restores a formatter-visible uncommitted candidate to its public
	/// snapshot.
	fn revert_uncommitted(
		&self,
		document: RevertedDocument,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<()>> + Send + '_;
}

/// Formatter implementation which preserves candidates and ignores publication.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFormatCoordinator;

impl FormatCoordinator for NoFormatCoordinator {
	fn format_candidate(
		&self,
		request: FormatRequest,
		_: CancellationToken,
	) -> impl Future<Output = Result<FormatResult>> + Send + '_ {
		future::ready(Ok(FormatResult::new(request.candidate)))
	}

	fn publish_committed(
		&self,
		_: PublishedDocument,
		_: CancellationToken,
	) -> impl Future<Output = Result<()>> + Send + '_ {
		future::ready(Ok(()))
	}

	fn revert_uncommitted(
		&self,
		_: RevertedDocument,
		_: CancellationToken,
	) -> impl Future<Output = Result<()>> + Send + '_ {
		future::ready(Ok(()))
	}
}

/// Why a transaction did not fully commit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionRejectReason {
	/// A base revision was stale.
	StaleBase,
	/// Rebase ranges overlapped or mapped ambiguously.
	OverlappingChange,
	/// Actor or persisted state changed after reservation.
	ExternalModification,
	/// A retained base revision expired.
	RevisionExpired,
	/// Proposed bytes violated text or edit invariants.
	InvalidContent,
	/// Required formatting failed.
	FormatFailed,
	/// Durable persistence failed.
	PersistFailed,
	/// A create, delete, or move precondition failed.
	PreconditionFailed,
	/// Cancellation won before durability began.
	Cancelled,
}

/// Conflict details in the operation's expected-revision coordinate space.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentConflict {
	operation_index:    u32,
	expected:           Revision,
	current:            DocumentHead,
	uri:                Url,
	conflicting_ranges: Vec<ByteRange>,
}

impl DocumentConflict {
	/// Returns the declared operation index.
	pub const fn operation_index(&self) -> u32 {
		self.operation_index
	}

	/// Returns the expected base revision.
	pub const fn expected(&self) -> Revision {
		self.expected
	}

	/// Returns the current committed head.
	pub const fn current(&self) -> &DocumentHead {
		&self.current
	}

	/// Returns the URI captured with the conflicting head.
	pub const fn uri(&self) -> &Url {
		&self.uri
	}

	/// Returns conflicting base-coordinate ranges.
	pub fn conflicting_ranges(&self) -> &[ByteRange] {
		&self.conflicting_ranges
	}
}

/// Result for one successfully finalized declared operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationResult {
	operation_index:    u32,
	head:               DocumentHead,
	uri:                Url,
	rebased:            bool,
	formatted:          bool,
	submitted_revision: Revision,
	changed_ranges:     Vec<ByteRange>,
	previous_uri:       Option<Url>,
}

impl OperationResult {
	/// Returns the declared operation index.
	pub const fn operation_index(&self) -> u32 {
		self.operation_index
	}

	/// Returns the installed head.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns the URI installed with the operation result.
	pub const fn uri(&self) -> &Url {
		&self.uri
	}

	/// Reports whether non-overlapping rebase was used.
	pub const fn rebased(&self) -> bool {
		self.rebased
	}

	/// Reports whether formatter output was committed.
	pub const fn formatted(&self) -> bool {
		self.formatted
	}

	/// Returns the revision submitted before server-side formatting.
	pub const fn submitted_revision(&self) -> Revision {
		self.submitted_revision
	}

	/// Returns ranges in finalized-head coordinates.
	pub fn changed_ranges(&self) -> &[ByteRange] {
		&self.changed_ranges
	}

	/// Returns the former URI for a successful move.
	pub const fn previous_uri(&self) -> Option<&Url> {
		self.previous_uri.as_ref()
	}
}

/// Exact terminal transaction outcome retained for the server epoch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransactionOutcome {
	/// Every operation committed.
	Committed {
		/// The idempotency key.
		transaction_id: TransactionId,
		/// Results in declared operation order.
		operations:     Vec<OperationResult>,
	},
	/// No operation became durable.
	Rejected {
		/// The idempotency key.
		transaction_id: TransactionId,
		/// Stable rejection classification.
		reason:         TransactionRejectReason,
		/// Human-readable failure detail.
		message:        Str,
		/// Structured stale or overlap conflicts.
		conflicts:      Vec<DocumentConflict>,
	},
	/// At least one earlier operation committed before a later failure.
	PartiallyCommitted {
		/// The idempotency key.
		transaction_id:         TransactionId,
		/// Operations known to have committed.
		committed_operations:   Vec<OperationResult>,
		/// First declared operation which could not commit.
		failed_operation_index: u32,
		/// Stable failure classification.
		reason:                 TransactionRejectReason,
		/// Human-readable failure detail.
		message:                Str,
	},
}

impl TransactionOutcome {
	/// Returns the shared idempotency key.
	pub const fn transaction_id(&self) -> TransactionId {
		match self {
			Self::Committed { transaction_id, .. }
			| Self::Rejected { transaction_id, .. }
			| Self::PartiallyCommitted { transaction_id, .. } => *transaction_id,
		}
	}
}

/// A deterministic proposal-lowering failure retained in the transaction
/// ledger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionBuildError {
	reason:  TransactionRejectReason,
	message: Str,
}

impl TransactionBuildError {
	/// Creates a lowering failure with its wire-level rejection classification.
	pub fn new(reason: TransactionRejectReason, message: impl AsRef<str>) -> Self {
		Self { reason, message: Str::new(message.as_ref()) }
	}

	/// Returns the stable rejection classification.
	pub const fn reason(&self) -> TransactionRejectReason {
		self.reason
	}

	/// Returns the human-readable lowering failure.
	pub fn message(&self) -> &str {
		self.message.as_str()
	}
}

/// Revisioned transaction authority above a [`DocumentStore`].
#[derive(Clone)]
pub struct TransactionCoordinator<F: FormatCoordinator = NoFormatCoordinator> {
	inner: Arc<CoordinatorInner<F>>,
}

struct CoordinatorInner<F: FormatCoordinator> {
	store:        DocumentStore,
	formatter:    F,
	server_epoch: [u8; 16],
	ledger:       Mutex<HashMap<TransactionId, LedgerEntry>>,
}

enum LedgerEntry {
	Running(Vec<oneshot::Sender<Arc<TransactionOutcome>>>),
	Complete(Arc<TransactionOutcome>),
}

impl TransactionCoordinator<NoFormatCoordinator> {
	/// Creates a coordinator with formatting disabled.
	pub fn new(store: DocumentStore, server_epoch: [u8; 16]) -> Self {
		Self::with_formatter(store, server_epoch, NoFormatCoordinator)
	}
}

impl<F: FormatCoordinator + 'static> TransactionCoordinator<F> {
	/// Creates a coordinator using the supplied formatting and publication seam.
	pub fn with_formatter(store: DocumentStore, server_epoch: [u8; 16], formatter: F) -> Self {
		Self {
			inner: Arc::new(CoordinatorInner {
				store,
				formatter,
				server_epoch,
				ledger: Mutex::new(HashMap::new()),
			}),
		}
	}

	/// Returns the epoch which scopes the in-memory terminal outcome ledger.
	pub fn server_epoch(&self) -> &[u8; 16] {
		&self.inner.server_epoch
	}

	/// Executes a fully lowered request once per transaction id.
	pub async fn commit(
		&self,
		request: TransactionRequest,
		cancellation: CancellationToken,
	) -> Arc<TransactionOutcome> {
		let transaction_id = request.transaction_id;
		self
			.commit_lazy(transaction_id, cancellation, move || async move {
				Ok::<_, TransactionBuildError>(request.operations)
			})
			.await
	}

	/// Commits without synchronously publishing through the formatter.
	///
	/// Inbound LSP `workspace/applyEdit` uses this path so its JSON-RPC response
	/// can release the server lane before document event forwarders
	/// resynchronize the committed heads.
	pub async fn commit_deferred_publication(
		&self,
		request: TransactionRequest,
		cancellation: CancellationToken,
	) -> Arc<TransactionOutcome> {
		let transaction_id = request.transaction_id;
		self
			.commit_lazy_with_publication(
				transaction_id,
				cancellation,
				move || async move { Ok::<_, TransactionBuildError>(request.operations) },
				false,
				None,
			)
			.await
	}

	/// Claims the idempotency ledger before lazily lowering opaque proposals.
	///
	/// Only the owner of a previously unseen `transaction_id` invokes `build`.
	/// Duplicates wait for or return the exact terminal outcome without lowering
	/// their proposals a second time.
	pub async fn commit_lazy<B, Fut>(
		&self,
		transaction_id: TransactionId,
		cancellation: CancellationToken,
		build: B,
	) -> Arc<TransactionOutcome>
	where
		B: FnOnce() -> Fut + Send + 'static,
		Fut: Future<Output = result::Result<Vec<DocumentMutation>, TransactionBuildError>>
			+ Send
			+ 'static,
	{
		self
			.commit_lazy_with_publication(transaction_id, cancellation, build, true, None)
			.await
	}

	/// Claims the idempotency ledger for a connection holding workspace leases.
	pub async fn commit_lazy_for<B, Fut>(
		&self,
		owner: [u8; 16],
		transaction_id: TransactionId,
		cancellation: CancellationToken,
		build: B,
	) -> Arc<TransactionOutcome>
	where
		B: FnOnce() -> Fut + Send + 'static,
		Fut: Future<Output = result::Result<Vec<DocumentMutation>, TransactionBuildError>>
			+ Send
			+ 'static,
	{
		self
			.commit_lazy_with_publication(transaction_id, cancellation, build, true, Some(owner))
			.await
	}

	async fn commit_lazy_with_publication<B, Fut>(
		&self,
		transaction_id: TransactionId,
		cancellation: CancellationToken,
		build: B,
		publish: bool,
		workspace_owner: Option<[u8; 16]>,
	) -> Arc<TransactionOutcome>
	where
		B: FnOnce() -> Fut + Send + 'static,
		Fut: Future<Output = result::Result<Vec<DocumentMutation>, TransactionBuildError>>
			+ Send
			+ 'static,
	{
		let receiver = {
			let mut ledger = self.inner.ledger.lock();
			match ledger.get_mut(&transaction_id) {
				Some(LedgerEntry::Complete(outcome)) => return Arc::clone(outcome),
				Some(LedgerEntry::Running(waiters)) => {
					let (send, receive) = oneshot::channel();
					waiters.push(send);
					receive
				},
				None => {
					let (send, receive) = oneshot::channel();
					ledger.insert(transaction_id, LedgerEntry::Running(vec![send]));
					let coordinator = Self { inner: Arc::clone(&self.inner) };
					tokio::spawn(async move {
						let operations = if cancellation.is_cancelled() {
							Err(TransactionBuildError::new(
								TransactionRejectReason::Cancelled,
								"transaction cancelled before proposal lowering",
							))
						} else {
							let building = build();
							tokio::select! {
								biased;
								() = cancellation.cancelled() => Err(TransactionBuildError::new(
									TransactionRejectReason::Cancelled,
									"transaction cancelled during proposal lowering",
								)),
								result = building => result,
							}
						};
						let terminal = match operations {
							Ok(operations) => {
								coordinator
									.execute(
										TransactionRequest::new(transaction_id, operations),
										cancellation,
										publish,
										workspace_owner,
									)
									.await
							},
							Err(error) => rejected(transaction_id, error.reason(), error.message()),
						};
						let outcome = Arc::new(terminal);
						coordinator.record_terminal(transaction_id, Arc::clone(&outcome));
					});
					receive
				},
			}
		};
		if let Ok(outcome) = receiver.await {
			outcome
		} else {
			let complete = {
				let ledger = self.inner.ledger.lock();
				match ledger.get(&transaction_id) {
					Some(LedgerEntry::Complete(outcome)) => Some(Arc::clone(outcome)),
					_ => None,
				}
			};
			if let Some(outcome) = complete {
				outcome
			} else {
				let outcome = Arc::new(rejected(
					transaction_id,
					TransactionRejectReason::ExternalModification,
					"transaction worker stopped before recording an outcome",
				));
				self.record_terminal(transaction_id, Arc::clone(&outcome));
				outcome
			}
		}
	}

	fn record_terminal(&self, transaction_id: TransactionId, outcome: Arc<TransactionOutcome>) {
		let waiters = {
			let mut ledger = self.inner.ledger.lock();
			match ledger.get_mut(&transaction_id) {
				Some(entry @ LedgerEntry::Running(_)) => {
					let LedgerEntry::Running(waiters) =
						mem::replace(entry, LedgerEntry::Complete(Arc::clone(&outcome)))
					else {
						unreachable!("matched running ledger entry")
					};
					waiters
				},
				Some(LedgerEntry::Complete(_)) => Vec::new(),
				None => {
					ledger.insert(transaction_id, LedgerEntry::Complete(Arc::clone(&outcome)));
					Vec::new()
				},
			}
		};
		for waiter in waiters {
			let _ = waiter.send(Arc::clone(&outcome));
		}
	}

	async fn execute(
		&self,
		request: TransactionRequest,
		cancellation: CancellationToken,
		publish: bool,
		workspace_owner: Option<[u8; 16]>,
	) -> TransactionOutcome {
		let transaction_id = request.transaction_id;
		let gate = self.inner.store.mutation_gate();
		let _authority = tokio::select! {
			guard = gate.lock() => guard,
			() = cancellation.cancelled() => return rejected(transaction_id, TransactionRejectReason::Cancelled, "transaction cancelled before mutation authority was acquired"),
		};
		if cancellation.is_cancelled() {
			return rejected(
				transaction_id,
				TransactionRejectReason::Cancelled,
				"transaction cancelled before planning",
			);
		}
		match self
			.plan_and_commit(request, cancellation, publish, workspace_owner)
			.await
		{
			Ok(outcome) | Err(outcome) => outcome,
		}
	}

	async fn plan_and_commit(
		&self,
		request: TransactionRequest,
		cancellation: CancellationToken,
		publish: bool,
		workspace_owner: Option<[u8; 16]>,
	) -> result::Result<TransactionOutcome, TransactionOutcome> {
		let transaction_id = request.transaction_id;
		if request.operations.is_empty() {
			return Ok(TransactionOutcome::Committed { transaction_id, operations: Vec::new() });
		}
		let resolved = match self
			.resolve_operations(&request.operations, &cancellation)
			.await
		{
			Ok(resolved) => resolved,
			Err(failure) => return Err(failure.outcome(transaction_id, Vec::new())),
		};
		let ResolvedOperations { operations: resolved, owned_leases } = resolved;
		let mut workspace_paths = Vec::with_capacity(resolved.len() * 2);
		for operation in &resolved {
			workspace_paths.push(operation.path.clone());
			if let Some(destination) = &operation.destination_path {
				workspace_paths.push(destination.clone());
			}
		}
		if let Err(error) = self
			.inner
			.store
			.check_workspace_paths(workspace_owner, workspace_paths)
		{
			self.close_owned(owned_leases).await;
			return Err(PlanningFailure::from_error(0, error).outcome(transaction_id, Vec::new()));
		}
		let mut plans = match self.reserve_plans(transaction_id, &resolved).await {
			Ok(plans) => plans,
			Err(failure) => {
				self.close_owned(owned_leases).await;
				return Err(failure.outcome(transaction_id, Vec::new()));
			},
		};
		let planned = self
			.apply_overlay(transaction_id, &resolved, &mut plans, cancellation.clone())
			.await;
		if let Err(failure) = planned {
			self.revert_uncommitted(transaction_id, &plans).await;
			self.release_all(&mut plans).await;
			self.close_owned(owned_leases).await;
			return Err(failure.outcome(transaction_id, Vec::new()));
		}
		if cancellation.is_cancelled() {
			self.revert_uncommitted(transaction_id, &plans).await;
			self.release_all(&mut plans).await;
			self.close_owned(owned_leases).await;
			return Err(rejected(
				transaction_id,
				TransactionRejectReason::Cancelled,
				"transaction cancelled before persistence preparation",
			));
		}
		let mut prepared = match self.prepare_all(transaction_id, &mut plans).await {
			Ok(prepared) => prepared,
			Err(failure) => {
				self.revert_uncommitted(transaction_id, &plans).await;
				self.release_all(&mut plans).await;
				self.close_owned(owned_leases).await;
				return Err(failure.outcome(transaction_id, Vec::new()));
			},
		};
		if cancellation.is_cancelled() {
			drop(prepared);
			self.revert_uncommitted(transaction_id, &plans).await;
			self.release_all(&mut plans).await;
			self.close_owned(owned_leases).await;
			return Err(rejected(
				transaction_id,
				TransactionRejectReason::Cancelled,
				"transaction cancelled before durability began",
			));
		}

		prepared.sort_by_key(|plan| plan.operation_index);
		let mut results = Vec::new();
		for prepared_plan in prepared {
			let plan = &mut plans[prepared_plan.plan_index];
			let failed_index = plan.operation_indices.iter().copied().min().unwrap_or(0);
			let commit = match prepared_plan.action {
				PreparedAction::Write(prepared) => {
					plan
						.handle
						.commit_prepared(
							plan
								.reservation
								.take()
								.expect("prepared plan owns reservation"),
							prepared,
							CommittedSnapshotMetadata { kind: plan.kind.clone() },
						)
						.await
				},
				PreparedAction::Delete(prepared) => {
					plan
						.handle
						.commit_prepared_delete(
							plan
								.reservation
								.take()
								.expect("prepared plan owns reservation"),
							prepared,
						)
						.await
				},
				PreparedAction::Move(prepared, path) => {
					plan
						.handle
						.commit_prepared_move(
							plan
								.reservation
								.take()
								.expect("prepared plan owns reservation"),
							*prepared,
							path,
						)
						.await
				},
				PreparedAction::Noop => plan
					.handle
					.release(
						plan
							.reservation
							.take()
							.expect("prepared plan owns reservation"),
					)
					.await
					.map(|()| plan.reserved.snapshot.head().clone()),
			};
			let head = match commit {
				Ok(head) => head,
				Err(error) => {
					self.revert_uncommitted(transaction_id, &plans).await;
					self.release_all(&mut plans).await;
					self.close_owned(owned_leases).await;
					results.sort_by_key(OperationResult::operation_index);
					let (reason, message) = classify_error(&error);
					if results.is_empty() {
						return Err(rejected(transaction_id, reason, message));
					}
					return Err(TransactionOutcome::PartiallyCommitted {
						transaction_id,
						committed_operations: results,
						failed_operation_index: failed_index,
						reason,
						message,
					});
				},
			};
			plan.committed = true;
			let changed =
				finalized_ranges(plan.reserved.snapshot.content(), &plan.content).unwrap_or_default();
			for operation_index in &plan.operation_indices {
				results.push(OperationResult {
					operation_index:    *operation_index,
					head:               head.clone(),
					uri:                plan.uri.clone(),
					rebased:            plan.rebased.contains(operation_index),
					formatted:          plan.formatted.contains(operation_index),
					submitted_revision: plan.reserved.snapshot.head().revision(),
					changed_ranges:     changed.clone(),
					previous_uri:       plan.previous_uri.clone(),
				});
			}
			if publish {
				let publication = PublishedDocument::new(
					transaction_id,
					failed_index,
					head,
					plan.content.clone(),
					plan.uri.clone(),
					plan.previous_uri.clone(),
				);
				let _ = self
					.inner
					.formatter
					.publish_committed(publication, CancellationToken::new())
					.await;
			}
		}
		results.sort_by_key(OperationResult::operation_index);
		self.close_owned(owned_leases).await;
		Ok(TransactionOutcome::Committed { transaction_id, operations: results })
	}

	async fn resolve_operations(
		&self,
		operations: &[DocumentMutation],
		cancellation: &CancellationToken,
	) -> result::Result<ResolvedOperations, PlanningFailure> {
		let mut owned_leases = Vec::new();
		match self
			.resolve_operations_inner(operations, &mut owned_leases, cancellation)
			.await
		{
			Ok(operations) => Ok(ResolvedOperations { operations, owned_leases }),
			Err(failure) => {
				self.close_owned(owned_leases).await;
				Err(failure)
			},
		}
	}

	async fn resolve_operations_inner(
		&self,
		operations: &[DocumentMutation],
		owned_leases: &mut Vec<LeaseId>,
		cancellation: &CancellationToken,
	) -> result::Result<Vec<ResolvedOperation>, PlanningFailure> {
		let mut resolved = Vec::with_capacity(operations.len());
		let mut overlay_paths: HashMap<PathBuf, ActorHandle> = HashMap::new();
		for (index, mutation) in operations.iter().enumerate() {
			let operation_index = u32::try_from(index)
				.map_err(|_| PlanningFailure::invalid(0, "operation index exceeds u32"))?;
			if cancellation.is_cancelled() {
				return Err(PlanningFailure::cancelled(
					operation_index,
					"transaction cancelled during target resolution",
				));
			}
			let (handle, path) = match &mutation.target {
				DocumentTarget::Document(id) => {
					let handle = self
						.inner
						.store
						.actor_handle(DocumentLocator::Document(*id))
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
					let state = handle
						.state()
						.await
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
					(handle, state.path)
				},
				DocumentTarget::Lease(id) => {
					let handle = self
						.inner
						.store
						.actor_handle(DocumentLocator::Lease(*id))
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
					let state = handle
						.state()
						.await
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
					(handle, state.path)
				},
				DocumentTarget::Uri(uri) => {
					let path = self
						.inner
						.store
						.resolve_entry_path(uri)
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
					if let Some(handle) = overlay_paths.get(&path) {
						(handle.clone(), path)
					} else {
						let opened = self
							.inner
							.store
							.open_with_mutation_authority(DocumentLocator::Path(path.clone()))
							.await
							.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
						owned_leases.push(opened.lease_id());
						let handle = self
							.inner
							.store
							.actor_handle(DocumentLocator::Lease(opened.lease_id()))
							.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
						(handle, path)
					}
				},
			};
			overlay_paths.insert(path.clone(), handle.clone());
			let destination = match &mutation.operation {
				MutationOperation::Move(movement) => Some(&movement.destination),
				MutationOperation::MoveWithContent(movement) => Some(&movement.destination),
				MutationOperation::Text(_)
				| MutationOperation::Create(_)
				| MutationOperation::Delete(_) => None,
			};
			let destination_path = if let Some(destination) = destination {
				let destination = self
					.inner
					.store
					.resolve_entry_path(destination)
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				overlay_paths.remove(&path);
				overlay_paths.insert(destination.clone(), handle.clone());
				Some(destination)
			} else {
				None
			};
			resolved.push(ResolvedOperation {
				operation_index,
				mutation: mutation.clone(),
				handle,
				path,
				destination_path,
			});
			if cancellation.is_cancelled() {
				return Err(PlanningFailure::cancelled(
					operation_index,
					"transaction cancelled during target resolution",
				));
			}
		}
		Ok(resolved)
	}

	async fn reserve_plans(
		&self,
		transaction_id: TransactionId,
		operations: &[ResolvedOperation],
	) -> result::Result<Vec<DocumentPlan>, PlanningFailure> {
		let mut unique: HashMap<DocumentId, ActorHandle> = HashMap::new();
		for operation in operations {
			unique
				.entry(operation.handle.document_id())
				.or_insert_with(|| operation.handle.clone());
		}
		let mut states = Vec::with_capacity(unique.len());
		for handle in unique.into_values() {
			let state = handle
				.ready_state()
				.await
				.map_err(|error| PlanningFailure::from_error(0, error))?;
			let head = state
				.head
				.ok_or_else(|| PlanningFailure::invalid(0, "document actor has no committed head"))?;
			states.push((state.path, handle, head.head().revision()));
		}
		states.sort_by(|left, right| left.0.cmp(&right.0));
		let mut plans = Vec::with_capacity(states.len());
		for (path, handle, expected) in states {
			let uri = self
				.inner
				.store
				.file_uri(&path)
				.map_err(|error| PlanningFailure::from_error(0, error))?;
			match handle.reserve(transaction_id, expected).await {
				Ok(reserved) => plans.push(DocumentPlan::new(handle, reserved, uri)),
				Err(error) => {
					for plan in &mut plans {
						if let Some(reservation) = plan.reservation.take() {
							let _ = plan.handle.release(reservation).await;
						}
					}
					return Err(PlanningFailure::from_error(0, error));
				},
			}
			debug_assert_eq!(plans.last().map(|plan| &plan.path), Some(&path));
		}
		Ok(plans)
	}

	async fn apply_overlay(
		&self,
		transaction_id: TransactionId,
		operations: &[ResolvedOperation],
		plans: &mut [DocumentPlan],
		cancellation: CancellationToken,
	) -> result::Result<(), PlanningFailure> {
		for operation in operations {
			let plan = plans
				.iter_mut()
				.find(|plan| plan.handle.document_id() == operation.handle.document_id())
				.expect("resolved actor has a plan");
			let combines_move = plan.move_precondition.is_some()
				|| (matches!(
					&operation.mutation.operation,
					MutationOperation::Move(_) | MutationOperation::MoveWithContent(_)
				) && !plan.operation_indices.is_empty());
			if combines_move {
				return Err(PlanningFailure::precondition(
					operation.operation_index,
					"a move cannot be combined with another mutation of the same document",
				));
			}
			plan.operation_indices.push(operation.operation_index);
			match &operation.mutation.operation {
				MutationOperation::Text(text) => {
					if !matches!(plan.kind, DocumentKind::Text(_))
						|| plan.presence != DocumentPresence::Present
					{
						return Err(PlanningFailure::invalid(
							operation.operation_index,
							"text mutation requires a present text document",
						));
					}
					let force_replace = text.stale_policy == StalePolicy::ForceReplace;
					if force_replace && matches!(&text.proposal, TextProposal::Edits(_)) {
						return Err(PlanningFailure::invalid(
							operation.operation_index,
							"force-replace requires whole proposed content",
						));
					}
					let base_content = if force_replace {
						plan.content.clone()
					} else {
						self
							.snapshot_at(plan.handle.document_id(), text.base_revision)
							.await
							.map_err(|error| {
								PlanningFailure::from_error(operation.operation_index, error)
							})?
							.content()
							.clone()
					};
					let proposed = proposal_content(&base_content, &text.proposal)
						.map_err(|error| PlanningFailure::from_error(operation.operation_index, error))?;
					let stale = text.base_revision != plan.reserved.snapshot.head().revision()
						|| plan.overlay_changed;
					let candidate = if stale {
						match text.stale_policy {
							StalePolicy::Fail => {
								return Err(PlanningFailure::conflict(
									operation.operation_index,
									text.base_revision,
									plan.reserved.snapshot.head().clone(),
									plan.uri.clone(),
									Vec::new(),
									TransactionRejectReason::StaleBase,
									"text base is not the transaction-local head",
								));
							},
							StalePolicy::ForceReplace => proposed,
							StalePolicy::RebaseNonOverlapping => {
								match rebase_content(&base_content, &plan.content, &proposed).map_err(
									|error| PlanningFailure::from_error(operation.operation_index, error),
								)? {
									Ok(applied) => {
										plan.rebased.push(operation.operation_index);
										applied.into_parts().0
									},
									Err(conflict) => {
										return Err(PlanningFailure::conflict(
											operation.operation_index,
											text.base_revision,
											plan.reserved.snapshot.head().clone(),
											plan.uri.clone(),
											conflict.into_ranges(),
											TransactionRejectReason::OverlappingChange,
											"text proposal overlaps the transaction-local head",
										));
									},
								}
							},
						}
					} else {
						proposed
					};
					let (candidate, formatted) = self
						.maybe_format(
							transaction_id,
							operation.operation_index,
							plan,
							candidate,
							text.format_policy,
							cancellation.clone(),
						)
						.await?;
					validate_text(&candidate)
						.map_err(|error| PlanningFailure::from_error(operation.operation_index, error))?;
					if formatted {
						plan.formatted.push(operation.operation_index);
					}
					plan.content = candidate;
					plan.presence = DocumentPresence::Present;
					plan.overlay_changed = true;
				},
				MutationOperation::Create(create) => {
					if plan.presence == DocumentPresence::Present
						&& create.existing_document == ExistingDocumentPolicy::FailIfExists
					{
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"create target already exists",
						));
					}
					let kind = if plan.presence == DocumentPresence::Present {
						plan.kind.clone()
					} else if str::from_utf8(&create.content).is_ok() {
						DocumentKind::Text(None)
					} else {
						DocumentKind::Binary
					};
					let mut candidate = create.content.clone();
					plan.kind = kind;
					if matches!(plan.kind, DocumentKind::Text(_)) {
						validate_text(&candidate).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
						let formatted;
						(candidate, formatted) = self
							.maybe_format(
								transaction_id,
								operation.operation_index,
								plan,
								candidate,
								create.format_policy,
								cancellation.clone(),
							)
							.await?;
						validate_text(&candidate).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
						if formatted {
							plan.formatted.push(operation.operation_index);
						}
					} else if create.format_policy == FormatPolicy::Required {
						return Err(PlanningFailure::format(
							operation.operation_index,
							"required formatting is unavailable for binary content",
						));
					}
					plan.content = candidate;
					plan.presence = DocumentPresence::Present;
					plan.overlay_changed = true;
				},
				MutationOperation::Delete(delete) => {
					if delete.base_revision != plan.reserved.snapshot.head().revision()
						|| plan.presence != DocumentPresence::Present
					{
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"delete base is stale or the document is missing",
						));
					}
					plan.content = Bytes::new();
					plan.presence = DocumentPresence::Missing;
					plan.overlay_changed = true;
				},
				MutationOperation::Move(movement) => {
					if movement.base_revision != plan.reserved.snapshot.head().revision()
						|| plan.presence != DocumentPresence::Present
					{
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"move base is stale or the source is missing",
						));
					}
					if plan.content != plan.reserved.snapshot.content()
						|| plan.path != plan.reserved.path
					{
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"a move cannot be combined with another mutation of the same document",
						));
					}
					let destination = self
						.inner
						.store
						.resolve_entry_path(&movement.destination)
						.map_err(|error| PlanningFailure::from_error(operation.operation_index, error))?;
					if destination == plan.path {
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"move source and destination are the same path",
						));
					}
					plan.previous_uri =
						Some(self.inner.store.file_uri(&plan.path).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?);
					plan.uri =
						self.inner.store.file_uri(&destination).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
					plan.path = destination;
					plan.move_precondition = Some(movement.destination_precondition);
				},
				MutationOperation::MoveWithContent(movement) => {
					if movement.base_revision != plan.reserved.snapshot.head().revision()
						|| plan.presence != DocumentPresence::Present
					{
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"move base is stale or the source is missing",
						));
					}
					let destination = self
						.inner
						.store
						.resolve_entry_path(&movement.destination)
						.map_err(|error| PlanningFailure::from_error(operation.operation_index, error))?;
					if destination == plan.path {
						return Err(PlanningFailure::precondition(
							operation.operation_index,
							"move source and destination are the same path",
						));
					}
					plan.previous_uri =
						Some(self.inner.store.file_uri(&plan.path).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?);
					plan.uri =
						self.inner.store.file_uri(&destination).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
					plan.path = destination;
					let mut candidate = movement.content.clone();
					if matches!(plan.kind, DocumentKind::Text(_)) {
						validate_text(&candidate).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
						let formatted;
						(candidate, formatted) = self
							.maybe_format(
								transaction_id,
								operation.operation_index,
								plan,
								candidate,
								movement.format_policy,
								cancellation.clone(),
							)
							.await?;
						validate_text(&candidate).map_err(|error| {
							PlanningFailure::from_error(operation.operation_index, error)
						})?;
						if formatted {
							plan.formatted.push(operation.operation_index);
						}
					} else if movement.format_policy == FormatPolicy::Required {
						return Err(PlanningFailure::format(
							operation.operation_index,
							"required formatting is unavailable for binary content",
						));
					}
					plan.content = candidate;
					plan.overlay_changed = true;
					plan.move_precondition = Some(movement.destination_precondition);
				},
			}
		}
		Ok(())
	}

	async fn maybe_format(
		&self,
		transaction_id: TransactionId,
		operation_index: u32,
		plan: &mut DocumentPlan,
		candidate: Bytes,
		policy: FormatPolicy,
		cancellation: CancellationToken,
	) -> result::Result<(Bytes, bool), PlanningFailure> {
		if policy == FormatPolicy::Disabled {
			return Ok((candidate, false));
		}
		let uri = self
			.inner
			.store
			.file_uri(&plan.path)
			.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
		let language_id = match &plan.kind {
			DocumentKind::Text(language) => language.clone(),
			DocumentKind::Binary => None,
		};
		let request = FormatRequest::new(
			transaction_id,
			operation_index,
			Arc::clone(&plan.reserved.snapshot),
			uri,
			language_id,
			candidate.clone(),
		);
		let format_cancel = cancellation.child_token();
		let formatted = time::timeout(
			Duration::from_secs(5),
			self
				.inner
				.formatter
				.format_candidate(request, format_cancel.clone()),
		)
		.await;
		match formatted {
			Err(_) => {
				format_cancel.cancel();
				if policy == FormatPolicy::BestEffort {
					Ok((candidate, false))
				} else {
					Err(PlanningFailure::format(operation_index, "formatter timed out after 5 seconds"))
				}
			},
			Ok(Ok(result)) => {
				plan.format_attempted = true;
				if format_cancel.is_cancelled() {
					return Err(PlanningFailure::cancelled(
						operation_index,
						"transaction cancelled during formatting",
					));
				}
				if str::from_utf8(result.content()).is_ok() {
					Ok((result.into_content(), true))
				} else if policy == FormatPolicy::BestEffort {
					Ok((candidate, false))
				} else {
					Err(PlanningFailure::format(operation_index, "formatter returned invalid UTF-8"))
				}
			},
			Ok(Err(_)) if policy == FormatPolicy::BestEffort => Ok((candidate, false)),
			Ok(Err(error)) => Err(PlanningFailure::format(operation_index, error.to_string())),
		}
	}

	async fn snapshot_at(
		&self,
		document_id: DocumentId,
		revision: Revision,
	) -> Result<Arc<DocumentSnapshot>> {
		let read = self
			.inner
			.store
			.read(DocumentLocator::Document(document_id), Some(revision), ReadSelection::Whole)
			.await?;
		let content = match read.body() {
			ReadBody::Whole(content) => content.clone(),
			ReadBody::Slices(_) => unreachable!("whole read returns whole bytes"),
		};
		Ok(Arc::new(DocumentSnapshot::new(read.head().clone(), content)?))
	}

	async fn prepare_all(
		&self,
		transaction_id: TransactionId,
		plans: &mut [DocumentPlan],
	) -> result::Result<Vec<PreparedPlan>, PlanningFailure> {
		let filesystem = self.inner.store.local_fs();
		let mut prepared = Vec::with_capacity(plans.len());
		for (plan_index, plan) in plans.iter_mut().enumerate() {
			let operation_index = plan.operation_indices.iter().copied().min().unwrap_or(0);
			let action = if let Some(precondition) = plan.move_precondition {
				let (destination_expected, path_claim) = self
					.prepare_move_destination(transaction_id, plan, precondition, operation_index)
					.await?;
				let source = plan.reserved.path.clone();
				let destination = plan.path.clone();
				let source_expected = plan.reserved.disk_expectation.clone();
				let content =
					(plan.content != plan.reserved.snapshot.content()).then(|| plan.content.clone());
				let fs = filesystem.clone();
				let move_capability = task::spawn_blocking(move || {
					if let Some(content) = content {
						fs.prepare_move_with_content(
							source,
							destination,
							content,
							source_expected,
							destination_expected,
						)
					} else {
						fs.prepare_move(source, destination, source_expected, destination_expected)
					}
				})
				.await
				.map_err(join_failure)?
				.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				PreparedAction::Move(Box::new(move_capability), path_claim)
			} else if plan.presence == DocumentPresence::Missing {
				if plan.reserved.snapshot.head().presence() == DocumentPresence::Missing {
					PreparedAction::Noop
				} else {
					let path = plan.path.clone();
					let expected = plan.reserved.disk_expectation.clone();
					let fs = filesystem.clone();
					PreparedAction::Delete(
						task::spawn_blocking(move || fs.prepare_delete(path, expected))
							.await
							.map_err(join_failure)?
							.map_err(|error| PlanningFailure::from_error(operation_index, error))?,
					)
				}
			} else if plan.content == plan.reserved.snapshot.content()
				&& plan.reserved.snapshot.head().presence() == DocumentPresence::Present
			{
				PreparedAction::Noop
			} else {
				let path = plan.path.clone();
				let expected = plan.reserved.disk_expectation.clone();
				let content = plan.content.clone();
				let fs = filesystem.clone();
				PreparedAction::Write(
					task::spawn_blocking(move || fs.prepare_write(path, content, expected))
						.await
						.map_err(join_failure)?
						.map_err(|error| PlanningFailure::from_error(operation_index, error))?,
				)
			};
			prepared.push(PreparedPlan { plan_index, operation_index, action });
		}
		Ok(prepared)
	}

	async fn prepare_move_destination(
		&self,
		transaction_id: TransactionId,
		plan: &DocumentPlan,
		precondition: MoveDestinationPrecondition,
		operation_index: u32,
	) -> result::Result<(DiskExpectation, PathReservation), PlanningFailure> {
		let expectation = match precondition {
			MoveDestinationPrecondition::MustNotExist => DestinationExpectation::Missing,
			MoveDestinationPrecondition::Revision(revision) => {
				DestinationExpectation::Revision(revision)
			},
		};
		let disk_expectation = match precondition {
			MoveDestinationPrecondition::MustNotExist => DiskExpectation::Missing,
			MoveDestinationPrecondition::Revision(revision) => {
				let opened = self
					.inner
					.store
					.open_with_mutation_authority(DocumentLocator::Path(plan.path.clone()))
					.await
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				let lease = opened.lease_id();
				let actor = self
					.inner
					.store
					.actor_handle(DocumentLocator::Lease(lease))
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				self
					.inner
					.store
					.close(lease)
					.await
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				let reserved = actor
					.reserve(transaction_id, revision)
					.await
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				let expected = reserved.disk_expectation.clone();
				actor
					.release(reserved.reservation)
					.await
					.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
				expected
			},
		};
		let claim = self
			.inner
			.store
			.reserve_move_destination(plan.handle.document_id(), plan.path.clone(), expectation)
			.await
			.map_err(|error| PlanningFailure::from_error(operation_index, error))?;
		Ok((disk_expectation, claim))
	}

	async fn revert_uncommitted(&self, transaction_id: TransactionId, plans: &[DocumentPlan]) {
		for plan in plans {
			if plan.committed || !plan.format_attempted {
				continue;
			}
			let Ok(uri) = self.inner.store.file_uri(&plan.reserved.path) else {
				continue;
			};
			let language_id = match plan.reserved.snapshot.head().kind() {
				DocumentKind::Text(language_id) => language_id.clone(),
				DocumentKind::Binary => None,
			};
			let reverted = RevertedDocument::new(
				transaction_id,
				plan.operation_indices.iter().copied().min().unwrap_or(0),
				Arc::clone(&plan.reserved.snapshot),
				uri,
				language_id,
			);
			let _ = self
				.inner
				.formatter
				.revert_uncommitted(reverted, CancellationToken::new())
				.await;
		}
	}

	async fn release_all(&self, plans: &mut [DocumentPlan]) {
		for plan in plans {
			if let Some(reservation) = plan.reservation.take() {
				let _ = plan.handle.release(reservation).await;
			}
		}
	}

	async fn close_owned(&self, leases: Vec<LeaseId>) {
		for lease in leases {
			let _ = self.inner.store.close(lease).await;
		}
	}
}

struct ResolvedOperations {
	operations:   Vec<ResolvedOperation>,
	owned_leases: Vec<LeaseId>,
}

struct ResolvedOperation {
	operation_index:  u32,
	mutation:         DocumentMutation,
	handle:           ActorHandle,
	path:             PathBuf,
	destination_path: Option<PathBuf>,
}

struct DocumentPlan {
	handle:            ActorHandle,
	reserved:          ReservedDocument,
	reservation:       Option<DocumentReservation>,
	path:              PathBuf,
	uri:               Url,
	content:           Bytes,
	presence:          DocumentPresence,
	kind:              DocumentKind,
	operation_indices: Vec<u32>,
	rebased:           Vec<u32>,
	formatted:         Vec<u32>,
	previous_uri:      Option<Url>,
	move_precondition: Option<MoveDestinationPrecondition>,
	overlay_changed:   bool,
	format_attempted:  bool,
	committed:         bool,
}

impl DocumentPlan {
	fn new(handle: ActorHandle, reserved: ReservedDocument, uri: Url) -> Self {
		Self {
			reservation: Some(reserved.reservation),
			path: reserved.path.clone(),
			uri,
			content: reserved.snapshot.content().clone(),
			presence: reserved.snapshot.head().presence(),
			kind: reserved.snapshot.head().kind().clone(),
			handle,
			reserved,
			operation_indices: Vec::new(),
			rebased: Vec::new(),
			formatted: Vec::new(),
			previous_uri: None,
			move_precondition: None,
			overlay_changed: false,
			format_attempted: false,
			committed: false,
		}
	}
}

struct PreparedPlan {
	plan_index:      usize,
	operation_index: u32,
	action:          PreparedAction,
}
enum PreparedAction {
	Write(PreparedWrite),
	Delete(PreparedDelete),
	Move(Box<PreparedMove>, PathReservation),
	Noop,
}

struct PlanningFailure {
	operation_index: u32,
	reason:          TransactionRejectReason,
	message:         Str,
	conflicts:       Vec<DocumentConflict>,
}

impl PlanningFailure {
	fn invalid(operation_index: u32, message: impl AsRef<str>) -> Self {
		Self {
			operation_index,
			reason: TransactionRejectReason::InvalidContent,
			message: Str::new(message.as_ref()),
			conflicts: Vec::new(),
		}
	}

	fn cancelled(operation_index: u32, message: impl AsRef<str>) -> Self {
		Self {
			operation_index,
			reason: TransactionRejectReason::Cancelled,
			message: Str::new(message.as_ref()),
			conflicts: Vec::new(),
		}
	}

	fn precondition(operation_index: u32, message: impl AsRef<str>) -> Self {
		Self {
			operation_index,
			reason: TransactionRejectReason::PreconditionFailed,
			message: Str::new(message.as_ref()),
			conflicts: Vec::new(),
		}
	}

	fn format(operation_index: u32, message: impl AsRef<str>) -> Self {
		Self {
			operation_index,
			reason: TransactionRejectReason::FormatFailed,
			message: Str::new(message.as_ref()),
			conflicts: Vec::new(),
		}
	}

	fn conflict(
		operation_index: u32,
		expected: Revision,
		current: DocumentHead,
		uri: Url,
		conflicting_ranges: Vec<ByteRange>,
		reason: TransactionRejectReason,
		message: impl AsRef<str>,
	) -> Self {
		Self {
			operation_index,
			reason,
			message: Str::new(message.as_ref()),
			conflicts: vec![DocumentConflict {
				operation_index,
				expected,
				current,
				uri,
				conflicting_ranges,
			}],
		}
	}

	fn from_error(operation_index: u32, error: Error) -> Self {
		let (reason, message) = classify_error(&error);
		Self { operation_index, reason, message, conflicts: Vec::new() }
	}

	fn outcome(
		self,
		transaction_id: TransactionId,
		committed: Vec<OperationResult>,
	) -> TransactionOutcome {
		if committed.is_empty() {
			TransactionOutcome::Rejected {
				transaction_id,
				reason: self.reason,
				message: self.message,
				conflicts: self.conflicts,
			}
		} else {
			TransactionOutcome::PartiallyCommitted {
				transaction_id,
				committed_operations: committed,
				failed_operation_index: self.operation_index,
				reason: self.reason,
				message: self.message,
			}
		}
	}
}

fn proposal_content(base: &Bytes, proposal: &TextProposal) -> Result<Bytes> {
	match proposal {
		TextProposal::Content(content) => Ok(content.clone()),
		TextProposal::Edits(edits) => Ok(apply_edits(base, edits)?.into_parts().0),
	}
}

fn finalized_ranges(base: &Bytes, finalized: &Bytes) -> Result<Vec<ByteRange>> {
	let edits = canonical_edits(base, finalized)?;
	Ok(apply_edits(base, &edits)?.into_parts().1)
}

fn validate_text(content: &Bytes) -> Result<()> {
	str::from_utf8(content)
		.map(|_| ())
		.map_err(|_| Error::InvalidContent { reason: sf!("text content is not valid UTF-8") })
}

fn classify_error(error: &Error) -> (TransactionRejectReason, Str) {
	let reason = match error {
		Error::StaleTransaction { .. } => TransactionRejectReason::ExternalModification,
		Error::ContentModified { .. } => TransactionRejectReason::StaleBase,
		Error::ConflictingTransaction { .. } => TransactionRejectReason::OverlappingChange,
		Error::RevisionExpired { .. } | Error::RevisionMissing { .. } => {
			TransactionRejectReason::RevisionExpired
		},
		Error::InvalidContent { .. } | Error::InvalidRange { .. } => {
			TransactionRejectReason::InvalidContent
		},
		Error::ExternalInvalidation { .. } | Error::StaleDiskState { .. } => {
			TransactionRejectReason::ExternalModification
		},
		Error::Persistence { .. } | Error::Io { .. } | Error::Watch { .. } => {
			TransactionRejectReason::PersistFailed
		},
		Error::PreconditionFailed { .. }
		| Error::InvalidTarget { .. }
		| Error::DocumentNotFound { .. }
		| Error::LeaseExpired { .. }
		| Error::Protocol { .. }
		| Error::Worker { .. }
		| Error::HashlineSnapshot
		| Error::HashlinePayloadUtf8 { .. }
		| Error::ReplacePayloadJson { .. }
		| Error::ReplaceOptionsJson { .. }
		| Error::HashlineOptionsJson { .. }
		| Error::Replace { .. }
		| Error::HashlineParse { .. }
		| Error::HashlineLookup { .. }
		| Error::HashlineApply { .. }
		| Error::HashlineRecovery { .. } => TransactionRejectReason::PreconditionFailed,
	};
	(reason, Str::new(error.to_string()))
}

fn rejected(
	transaction_id: TransactionId,
	reason: TransactionRejectReason,
	message: impl AsRef<str>,
) -> TransactionOutcome {
	TransactionOutcome::Rejected {
		transaction_id,
		reason,
		message: Str::new(message.as_ref()),
		conflicts: Vec::new(),
	}
}

fn join_failure(error: task::JoinError) -> PlanningFailure {
	PlanningFailure::precondition(0, format!("filesystem preparation worker failed: {error}"))
}

#[cfg(test)]
mod tests {
	use std::{
		fs, future,
		num::NonZeroUsize,
		path::Path,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::Duration,
	};

	use tempfile::TempDir;
	use tokio::sync::Notify;

	use super::*;
	use crate::docserver::{ReadBody, ReadSelection, ServerConfig};

	fn id(value: u8) -> TransactionId {
		TransactionId::from_bytes([value; 16])
	}

	fn setup(root: &TempDir) -> DocumentStore {
		let config = ServerConfig::new(root.path())
			.expect("temporary root")
			.with_revision_capacity(NonZeroUsize::new(16).expect("nonzero"));
		DocumentStore::new(config).expect("document store")
	}

	fn file_uri(path: &Path) -> Url {
		Url::from_file_path(path).expect("fixture path has a file URI")
	}

	fn text_request(
		transaction_id: TransactionId,
		document_id: DocumentId,
		base: Revision,
		content: &'static [u8],
		stale: StalePolicy,
		format: FormatPolicy,
	) -> TransactionRequest {
		TransactionRequest::new(transaction_id, vec![DocumentMutation::new(
			DocumentTarget::Document(document_id),
			MutationOperation::Text(TextMutation::new(
				base,
				TextProposal::Content(Bytes::from_static(content)),
				stale,
				format,
			)),
		)])
	}

	async fn current_bytes(store: &DocumentStore, document_id: DocumentId) -> Bytes {
		let read = store
			.read(document_id, None, ReadSelection::Whole)
			.await
			.expect("current read");
		match read.body() {
			ReadBody::Whole(content) => content.clone(),
			ReadBody::Slices(_) => panic!("whole read"),
		}
	}

	fn committed_head(outcome: &TransactionOutcome) -> DocumentHead {
		match outcome {
			TransactionOutcome::Committed { operations, .. } => {
				operations.last().expect("operation result").head().clone()
			},
			other => panic!("expected committed outcome, got {other:?}"),
		}
	}

	#[tokio::test]
	async fn stale_fail_rejects_and_disjoint_rebase_commits() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("stale.txt");
		fs::write(&path, b"alpha beta").expect("fixture");
		let store = setup(&root);
		let opened = store.open(path).await.expect("open");
		let document_id = opened.head().document_id();
		let base = opened.head().revision();
		let coordinator = TransactionCoordinator::new(store.clone(), [1; 16]);

		let first = coordinator
			.commit(
				text_request(
					id(1),
					document_id,
					base,
					b"ALPHA beta",
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		let _first_head = committed_head(&first);
		let stale = coordinator
			.commit(
				text_request(
					id(2),
					document_id,
					base,
					b"alpha BETA",
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		assert!(
			matches!(&*stale, TransactionOutcome::Rejected {
				reason: TransactionRejectReason::StaleBase,
				..
			}),
			"unexpected stale outcome: {stale:?}"
		);

		let rebased = coordinator
			.commit(
				text_request(
					id(3),
					document_id,
					base,
					b"alpha BETA",
					StalePolicy::RebaseNonOverlapping,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		assert!(
			matches!(&*rebased, TransactionOutcome::Committed { operations, .. } if operations[0].rebased())
		);
		assert_eq!(current_bytes(&store, document_id).await, b"ALPHA BETA".as_slice());
	}

	#[tokio::test]
	async fn overlapping_rebase_and_force_replace_edits_are_rejected() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("overlap.txt");
		fs::write(&path, b"abcdef").expect("fixture");
		let store = setup(&root);
		let opened = store.open(path).await.expect("open");
		let document_id = opened.head().document_id();
		let base = opened.head().revision();
		let coordinator = TransactionCoordinator::new(store.clone(), [2; 16]);
		let _ = coordinator
			.commit(
				text_request(
					id(4),
					document_id,
					base,
					b"abXXef",
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		let overlap = coordinator
			.commit(
				text_request(
					id(5),
					document_id,
					base,
					b"abYYef",
					StalePolicy::RebaseNonOverlapping,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		assert!(
			matches!(&*overlap, TransactionOutcome::Rejected { reason: TransactionRejectReason::OverlappingChange, conflicts, .. } if !conflicts.is_empty())
		);

		let edit = ByteEdit::new(ByteRange::new(0, 1).expect("range"), Bytes::from_static(b"z"));
		let force = TransactionRequest::new(id(6), vec![DocumentMutation::new(
			DocumentTarget::Document(document_id),
			MutationOperation::Text(TextMutation::new(
				base,
				TextProposal::Edits(vec![edit]),
				StalePolicy::ForceReplace,
				FormatPolicy::Disabled,
			)),
		)]);
		let outcome = coordinator.commit(force, CancellationToken::new()).await;
		assert!(matches!(&*outcome, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::InvalidContent,
			..
		}));
	}

	#[tokio::test]
	async fn duplicate_transaction_ids_share_one_terminal_commit() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("duplicate.txt");
		fs::write(&path, b"before").expect("fixture");
		let store = setup(&root);
		let opened = store.open(path).await.expect("open");
		let base = opened.head().revision();
		let request = text_request(
			id(7),
			opened.head().document_id(),
			base,
			b"after",
			StalePolicy::Fail,
			FormatPolicy::Disabled,
		);
		let coordinator = TransactionCoordinator::new(store, [3; 16]);
		let (left, right) = tokio::join!(
			coordinator.commit(request.clone(), CancellationToken::new()),
			coordinator.commit(request, CancellationToken::new())
		);
		assert!(Arc::ptr_eq(&left, &right));
		let head = committed_head(&left);
		assert_eq!(head.revision().sequence(), base.sequence() + 1);
	}

	#[tokio::test]
	async fn duplicate_lazy_transactions_invoke_the_builder_once() {
		let root = TempDir::new().expect("tempdir");
		let coordinator = TransactionCoordinator::new(setup(&root), [8; 16]);
		let calls = Arc::new(AtomicUsize::new(0));
		let left_calls = Arc::clone(&calls);
		let right_calls = Arc::clone(&calls);
		let (left, right) = tokio::join!(
			coordinator.commit_lazy(id(15), CancellationToken::new(), move || {
				left_calls.fetch_add(1, Ordering::SeqCst);
				async {
					task::yield_now().await;
					Ok::<Vec<DocumentMutation>, TransactionBuildError>(Vec::new())
				}
			}),
			coordinator.commit_lazy(id(15), CancellationToken::new(), move || {
				right_calls.fetch_add(1, Ordering::SeqCst);
				async {
					task::yield_now().await;
					Ok::<Vec<DocumentMutation>, TransactionBuildError>(Vec::new())
				}
			}),
		);
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert!(Arc::ptr_eq(&left, &right));
		assert!(
			matches!(&*left, TransactionOutcome::Committed { operations, .. } if operations.is_empty())
		);
	}

	#[derive(Clone)]
	struct TestFormatter {
		fail:                     bool,
		cancel_after_format:      bool,
		calls:                    Arc<AtomicUsize>,
		reverts:                  Arc<AtomicUsize>,
		invalidate_after_publish: Option<PathBuf>,
	}

	impl FormatCoordinator for TestFormatter {
		fn format_candidate(
			&self,
			request: FormatRequest,
			cancel: CancellationToken,
		) -> impl Future<Output = Result<FormatResult>> + Send + '_ {
			self.calls.fetch_add(1, Ordering::SeqCst);
			let result = if self.fail {
				Err(Error::Protocol { reason: sf!("formatter failed") })
			} else {
				if self.cancel_after_format {
					cancel.cancel();
				}
				Ok(FormatResult::new(Bytes::from(
					request
						.candidate()
						.iter()
						.map(u8::to_ascii_uppercase)
						.collect::<Vec<_>>(),
				)))
			};
			future::ready(result)
		}

		fn publish_committed(
			&self,
			_: PublishedDocument,
			_: CancellationToken,
		) -> impl Future<Output = Result<()>> + Send + '_ {
			if let Some(path) = &self.invalidate_after_publish {
				fs::write(path, b"external").expect("invalidate second prepared file");
			}
			future::ready(Ok(()))
		}

		fn revert_uncommitted(
			&self,
			document: RevertedDocument,
			_: CancellationToken,
		) -> impl Future<Output = Result<()>> + Send + '_ {
			assert_eq!(document.uri().scheme(), "file");
			self.reverts.fetch_add(1, Ordering::SeqCst);
			future::ready(Ok(()))
		}
	}

	#[tokio::test]
	async fn formatting_policy_and_declared_order_partial_commit_are_explicit() {
		let root = TempDir::new().expect("tempdir");
		let first_path = root.path().join("z-declared-first.txt");
		let second_path = root.path().join("a-declared-second.txt");
		fs::write(&first_path, b"one").expect("first");
		fs::write(&second_path, b"two").expect("second");
		let store = setup(&root);
		let first = store.open(first_path).await.expect("open first");
		let second = store.open(second_path.clone()).await.expect("open second");
		let failed_calls = Arc::new(AtomicUsize::new(0));
		let failing = TransactionCoordinator::with_formatter(store.clone(), [6; 16], TestFormatter {
			fail:                     true,
			cancel_after_format:      false,
			calls:                    Arc::clone(&failed_calls),
			reverts:                  Arc::new(AtomicUsize::new(0)),
			invalidate_after_publish: None,
		});
		let required_failure = failing
			.commit(
				text_request(
					id(13),
					first.head().document_id(),
					first.head().revision(),
					b"never",
					StalePolicy::Fail,
					FormatPolicy::Required,
				),
				CancellationToken::new(),
			)
			.await;
		assert_eq!(failed_calls.load(Ordering::SeqCst), 1);
		assert!(matches!(&*required_failure, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::FormatFailed,
			..
		}));
		let calls = Arc::new(AtomicUsize::new(0));
		let reverts = Arc::new(AtomicUsize::new(0));
		let formatter = TestFormatter {
			fail:                     false,
			cancel_after_format:      false,
			calls:                    Arc::clone(&calls),
			reverts:                  Arc::clone(&reverts),
			invalidate_after_publish: Some(second_path),
		};
		let coordinator = TransactionCoordinator::with_formatter(store, [4; 16], formatter);
		let request = TransactionRequest::new(id(8), vec![
			DocumentMutation::new(
				DocumentTarget::Document(first.head().document_id()),
				MutationOperation::Text(TextMutation::new(
					first.head().revision(),
					TextProposal::Content(Bytes::from_static(b"first")),
					StalePolicy::Fail,
					FormatPolicy::Required,
				)),
			),
			DocumentMutation::new(
				DocumentTarget::Document(second.head().document_id()),
				MutationOperation::Text(TextMutation::new(
					second.head().revision(),
					TextProposal::Content(Bytes::from_static(b"second")),
					StalePolicy::Fail,
					FormatPolicy::Required,
				)),
			),
		]);
		let outcome = coordinator.commit(request, CancellationToken::new()).await;

		assert_eq!(calls.load(Ordering::SeqCst), 2);
		assert!(
			matches!(&*outcome, TransactionOutcome::PartiallyCommitted { committed_operations, failed_operation_index: 1, .. } if committed_operations.len() == 1)
		);
		if let TransactionOutcome::PartiallyCommitted { committed_operations, .. } = &*outcome {
			assert_eq!(committed_operations[0].operation_index(), 0);
		}
		assert_eq!(reverts.load(Ordering::SeqCst), 1);
	}

	#[derive(Clone)]
	struct BlockingNoopFormatter {
		entered: Arc<Notify>,
		resume:  Arc<Notify>,
	}

	impl FormatCoordinator for BlockingNoopFormatter {
		async fn format_candidate(
			&self,
			request: FormatRequest,
			_: CancellationToken,
		) -> Result<FormatResult> {
			self.entered.notify_one();
			self.resume.notified().await;
			Ok(FormatResult::new(request.candidate().clone()))
		}

		fn publish_committed(
			&self,
			_: PublishedDocument,
			_: CancellationToken,
		) -> impl Future<Output = Result<()>> + Send + '_ {
			future::ready(Ok(()))
		}

		fn revert_uncommitted(
			&self,
			_: RevertedDocument,
			_: CancellationToken,
		) -> impl Future<Output = Result<()>> + Send + '_ {
			future::ready(Ok(()))
		}
	}

	#[tokio::test]
	async fn stale_noop_release_rejects_the_transaction() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("stale-noop.txt");
		fs::write(&path, b"original").expect("fixture");
		let store = setup(&root);
		let opened = store.open(path.clone()).await.expect("open");
		let entered = Arc::new(Notify::new());
		let resume = Arc::new(Notify::new());
		let coordinator =
			TransactionCoordinator::with_formatter(store.clone(), [9; 16], BlockingNoopFormatter {
				entered: Arc::clone(&entered),
				resume:  Arc::clone(&resume),
			});
		let request = text_request(
			id(16),
			opened.head().document_id(),
			opened.head().revision(),
			b"original",
			StalePolicy::Fail,
			FormatPolicy::Required,
		);
		let committing =
			tokio::spawn(async move { coordinator.commit(request, CancellationToken::new()).await });
		entered.notified().await;
		fs::write(&path, b"external").expect("external invalidation");
		let observed = time::timeout(Duration::from_secs(5), async {
			loop {
				let bytes = current_bytes(&store, opened.head().document_id()).await;
				if bytes == b"external".as_slice() {
					return bytes;
				}
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("watcher invalidation");
		assert_eq!(observed, b"external".as_slice());
		resume.notify_one();
		let outcome = committing.await.expect("transaction task");
		assert!(matches!(&*outcome, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::ExternalModification,
			..
		}));
	}

	#[tokio::test]
	async fn uri_resolution_failure_closes_previously_opened_leases() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("lease-cleanup.txt");
		fs::write(&path, b"original").expect("fixture");
		let store = setup(&root);
		let baseline = store.open(path.clone()).await.expect("baseline lease");
		let handle = store
			.actor_handle(DocumentLocator::Document(baseline.head().document_id()))
			.expect("actor");
		assert_eq!(handle.state().await.expect("state").lease_count, 1);
		let invalid_uri = Url::parse("https://example.invalid/not-local").expect("URI");
		let request = TransactionRequest::new(id(17), vec![
			DocumentMutation::new(
				DocumentTarget::Uri(file_uri(&path)),
				MutationOperation::Text(TextMutation::new(
					baseline.head().revision(),
					TextProposal::Content(Bytes::from_static(b"updated")),
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				)),
			),
			DocumentMutation::new(
				DocumentTarget::Uri(invalid_uri),
				MutationOperation::Create(CreateMutation::new(
					Bytes::from_static(b"invalid"),
					ExistingDocumentPolicy::FailIfExists,
					FormatPolicy::Disabled,
				)),
			),
		]);
		let outcome = TransactionCoordinator::new(store.clone(), [10; 16])
			.commit(request, CancellationToken::new())
			.await;
		assert!(matches!(&*outcome, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::PreconditionFailed,
			..
		}));
		assert_eq!(handle.state().await.expect("state").lease_count, 1);
		store
			.close(baseline.lease_id())
			.await
			.expect("close baseline");
	}

	#[tokio::test]
	async fn move_cannot_share_a_plan_with_text_in_either_order() {
		let root = TempDir::new().expect("tempdir");
		let source_path = root.path().join("move-source.txt");
		let destination_path = root.path().join("move-destination.txt");
		fs::write(&source_path, b"unchanged").expect("fixture");
		let store = setup(&root);
		let opened = store.open(source_path.clone()).await.expect("open");
		let document_id = opened.head().document_id();
		let revision = opened.head().revision();
		let movement = || {
			DocumentMutation::new(
				DocumentTarget::Document(document_id),
				MutationOperation::Move(MoveMutation::new(
					revision,
					file_uri(&destination_path),
					MoveDestinationPrecondition::MustNotExist,
				)),
			)
		};
		let text = || {
			DocumentMutation::new(
				DocumentTarget::Document(document_id),
				MutationOperation::Text(TextMutation::new(
					revision,
					TextProposal::Content(Bytes::from_static(b"unchanged")),
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				)),
			)
		};
		let coordinator = TransactionCoordinator::new(store, [11; 16]);
		for request in [
			TransactionRequest::new(id(18), vec![movement(), text()]),
			TransactionRequest::new(id(19), vec![text(), movement()]),
		] {
			let outcome = coordinator.commit(request, CancellationToken::new()).await;
			assert!(matches!(&*outcome, TransactionOutcome::Rejected {
				reason: TransactionRejectReason::PreconditionFailed,
				..
			}));
			assert_eq!(fs::read(&source_path).expect("source remains"), b"unchanged");
			assert!(!destination_path.exists());
		}
	}

	#[tokio::test]
	async fn move_with_content_is_one_atomic_transition() {
		let root = TempDir::new().expect("tempdir");
		let source_path = root.path().join("move-edit-source.txt");
		let destination_path = root.path().join("move-edit-destination.txt");
		fs::write(&source_path, b"before").expect("fixture");
		let store = setup(&root);
		let opened = store.open(source_path.clone()).await.expect("open");
		let request = TransactionRequest::new(id(20), vec![DocumentMutation::new(
			DocumentTarget::Document(opened.head().document_id()),
			MutationOperation::MoveWithContent(MoveWithContentMutation::new(
				opened.head().revision(),
				file_uri(&destination_path),
				MoveDestinationPrecondition::MustNotExist,
				Bytes::from_static(b"after"),
				FormatPolicy::Disabled,
			)),
		)]);
		let outcome = TransactionCoordinator::new(store, [12; 16])
			.commit(request, CancellationToken::new())
			.await;
		let moved = committed_head(&outcome);
		assert_eq!(moved.document_id(), opened.head().document_id());
		assert!(!source_path.exists());
		assert_eq!(fs::read(&destination_path).expect("destination bytes"), b"after");
	}

	#[tokio::test]
	async fn stale_move_with_content_leaves_both_paths_untouched() {
		let root = TempDir::new().expect("tempdir");
		let source_path = root.path().join("stale-move-edit-source.txt");
		let destination_path = root.path().join("stale-move-edit-destination.txt");
		fs::write(&source_path, b"before").expect("fixture");
		let store = setup(&root);
		let opened = store.open(source_path.clone()).await.expect("open");
		let document_id = opened.head().document_id();
		let stale_revision = opened.head().revision();
		let coordinator = TransactionCoordinator::new(store, [13; 16]);
		let updated = coordinator
			.commit(
				text_request(
					id(21),
					document_id,
					stale_revision,
					b"concurrent",
					StalePolicy::Fail,
					FormatPolicy::Disabled,
				),
				CancellationToken::new(),
			)
			.await;
		assert!(matches!(&*updated, TransactionOutcome::Committed { .. }));
		let stale_move = TransactionRequest::new(id(22), vec![DocumentMutation::new(
			DocumentTarget::Document(document_id),
			MutationOperation::MoveWithContent(MoveWithContentMutation::new(
				stale_revision,
				file_uri(&destination_path),
				MoveDestinationPrecondition::MustNotExist,
				Bytes::from_static(b"after"),
				FormatPolicy::Disabled,
			)),
		)]);
		let outcome = coordinator
			.commit(stale_move, CancellationToken::new())
			.await;
		assert!(matches!(&*outcome, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::PreconditionFailed,
			..
		}));
		assert_eq!(fs::read(&source_path).expect("source bytes"), b"concurrent");
		assert!(!destination_path.exists());
	}

	#[tokio::test]
	async fn cancellation_after_format_rolls_back_the_private_candidate() {
		let root = TempDir::new().expect("tempdir");
		let path = root.path().join("cancel.txt");
		fs::write(&path, b"public").expect("fixture");
		let store = setup(&root);
		let opened = store.open(path.clone()).await.expect("open");
		let reverts = Arc::new(AtomicUsize::new(0));
		let coordinator = TransactionCoordinator::with_formatter(store, [7; 16], TestFormatter {
			fail:                     false,
			cancel_after_format:      true,
			calls:                    Arc::new(AtomicUsize::new(0)),
			reverts:                  Arc::clone(&reverts),
			invalidate_after_publish: None,
		});
		let outcome = coordinator
			.commit(
				text_request(
					id(14),
					opened.head().document_id(),
					opened.head().revision(),
					b"private",
					StalePolicy::Fail,
					FormatPolicy::Required,
				),
				CancellationToken::new(),
			)
			.await;
		assert!(matches!(&*outcome, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::Cancelled,
			..
		}));
		assert_eq!(reverts.load(Ordering::SeqCst), 1);
		assert_eq!(fs::read(path).expect("public bytes remain"), b"public");
	}

	#[tokio::test]
	async fn create_delete_move_and_active_destination_preconditions() {
		let root = TempDir::new().expect("tempdir");
		let source_path = root.path().join("created.txt");
		let moved_path = root.path().join("moved.txt");
		let active_path = root.path().join("active.txt");
		fs::write(&active_path, b"occupied").expect("active fixture");
		let store = setup(&root);
		let active = store
			.open(active_path.clone())
			.await
			.expect("active destination");
		let coordinator = TransactionCoordinator::new(store.clone(), [5; 16]);
		let create = TransactionRequest::new(id(9), vec![DocumentMutation::new(
			DocumentTarget::Uri(file_uri(&source_path)),
			MutationOperation::Create(CreateMutation::new(
				Bytes::from_static(b"created"),
				ExistingDocumentPolicy::FailIfExists,
				FormatPolicy::Disabled,
			)),
		)]);
		let created = coordinator.commit(create, CancellationToken::new()).await;
		let created_head = committed_head(&created);
		assert_eq!(fs::read(&source_path).expect("created bytes"), b"created");

		let blocked_move = TransactionRequest::new(id(10), vec![DocumentMutation::new(
			DocumentTarget::Document(created_head.document_id()),
			MutationOperation::Move(MoveMutation::new(
				created_head.revision(),
				file_uri(&active_path),
				MoveDestinationPrecondition::MustNotExist,
			)),
		)]);
		let blocked = coordinator
			.commit(blocked_move, CancellationToken::new())
			.await;
		assert!(matches!(&*blocked, TransactionOutcome::Rejected {
			reason: TransactionRejectReason::PreconditionFailed,
			..
		}));
		assert_eq!(active.head().presence(), DocumentPresence::Present);

		let movement = TransactionRequest::new(id(11), vec![DocumentMutation::new(
			DocumentTarget::Document(created_head.document_id()),
			MutationOperation::Move(MoveMutation::new(
				created_head.revision(),
				file_uri(&moved_path),
				MoveDestinationPrecondition::MustNotExist,
			)),
		)]);
		let moved = coordinator.commit(movement, CancellationToken::new()).await;
		let moved_head = committed_head(&moved);
		assert!(!source_path.exists());
		assert_eq!(fs::read(&moved_path).expect("moved bytes"), b"created");
		assert_eq!(moved_head.document_id(), created_head.document_id());

		let delete = TransactionRequest::new(id(12), vec![DocumentMutation::new(
			DocumentTarget::Document(moved_head.document_id()),
			MutationOperation::Delete(DeleteMutation::new(moved_head.revision())),
		)]);
		let deleted = coordinator.commit(delete, CancellationToken::new()).await;
		assert_eq!(committed_head(&deleted).presence(), DocumentPresence::Missing);
		assert!(!moved_path.exists());
	}
}
