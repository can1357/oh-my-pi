//! Durable append-only journal operations for canonical agent turns.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
	io, iter,
	ops::Deref,
	path::{Path, PathBuf},
	slice,
	sync::Arc,
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{ArtifactDigest, Hash32, InvocationPhase, Principal, Provenance, Str, phase, sf};
use omp_proto::{
	inference::v1::Outcome,
	thread::v1::{Item, Role, item, part},
};
pub use omp_storage::transcript::{TurnInputRecord, TurnOptionsRecord, TurnReceipt, TurnStart};
use omp_storage::{
	blob::BlobRef,
	index::{
		self, ContextPosition, EventProjection, IndexedEvent, IndexedWriteError, JournalPosition,
		SessionIndex,
	},
	state::{self, StateRevision},
	transcript::{
		self, AmendPatch, ApprovalDecided, ApprovalTicketFiled, ChildLifecycleEntry,
		ChildSessionInit, Event, Header, HookOutcome, ItemRecord, JobRegistered, JobSettled, Kind,
		Log, ModelChange, Patch, Pin, PolicyDecision, PromptRewriteCommit, PromptRewriteIntent,
		PromptRewriteStage, Reader, RefreshState, RequestAudit, ToolBatchAuthorized, TurnAbort,
		TurnInputItem, Writer,
		event::Custom,
		msg::Content,
		writer::{AppendManyError, IndexRun, JournalError as WriterError},
	},
};
use omp_tool::{Abort, JobRef};
use parking_lot::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use thiserror::Error;

use crate::{
	ProjectionError,
	arbiter::RegimeFact,
	events::EventBus,
	journal_kinds::{
		CHECKPOINT_KIND, CORE_EXTENSION, CORE_REVISION, EntryKindDecl, EntryKindError,
		EntryKindRegistry, REGIME_FACT_KIND, REGIME_RECORD_KIND, REWIND_REPORT_KIND,
		TTSR_INJECTION_KIND, core_checkpoint_declarations, core_regime_declarations,
		core_ttsr_declaration,
	},
	project,
	prompt::PromptHash,
	regime::RegimeRecord,
	ttsr::StreamSource,
};
type ActivePrompt = (Hash32, Vec<u64>);
type PendingItem = (u64, Item, Option<Hash32>);
type ReplayKey = (Str, Str, Str);
struct IndexedAppend {
	index:       u64,
	index_error: Option<index::Error>,
}
type PendingItems = Vec<PendingItem>;
struct CachedReader {
	transcript:   Reader,
	writer_stale: bool,
}

impl CachedReader {
	fn open(path: &Path) -> Result<Self, transcript::Error> {
		Ok(Self { transcript: Reader::open(path)?, writer_stale: false })
	}

	fn pending(path: &Path, header: Header) -> Self {
		Self { transcript: Reader::pending(path, header), writer_stale: false }
	}

	fn refresh_projection(&mut self) -> Result<(), transcript::Error> {
		let report = self.transcript.refresh()?;
		self.writer_stale |= !matches!(report.state, RefreshState::Unchanged);
		Ok(())
	}
}

struct JournalLog<'a>(MutexGuard<'a, CachedReader>);

impl Deref for JournalLog<'_> {
	type Target = transcript::LiveLog;

	fn deref(&self) -> &Self::Target {
		self.0.transcript.live_log()
	}
}

/// Durable child-session semantics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildKind {
	/// A lineage child whose context is resolved from the parent checkpoint.
	Branch {
		/// Physical parent checkpoint inherited by the child.
		checkpoint: u64,
	},
	/// A self-contained child seeded from the parent's current live projection.
	Fork,
}

/// Append-only projection of workspace roots recorded by a session journal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRoots {
	primary:   PathBuf,
	secondary: Arc<[PathBuf]>,
}

impl WorkspaceRoots {
	/// Returns the current primary root after future-only moves are folded.
	pub fn primary(&self) -> &Path {
		&self.primary
	}

	/// Returns ordered secondary roots after all durable mutations are folded.
	pub fn secondary(&self) -> &[PathBuf] {
		&self.secondary
	}

	/// Iterates the primary root followed by ordered secondary roots.
	pub fn iter(&self) -> impl Iterator<Item = &Path> + Clone {
		iter::once(self.primary.as_path()).chain(self.secondary.iter().map(PathBuf::as_path))
	}
}

fn fold_workspace_roots<'a>(
	primary: &Path,
	events: impl IntoIterator<Item = &'a Kind>,
) -> WorkspaceRoots {
	let mut current_primary = primary.to_owned();
	let mut secondary = Vec::new();
	for kind in events {
		match kind {
			Kind::MoveRoot { root } => {
				if root != &current_primary {
					if !secondary.contains(&current_primary) {
						secondary.push(current_primary);
					}
					secondary.retain(|dir| dir != root);
					current_primary = root.clone();
				}
			},
			Kind::AddDirs { dirs } => {
				for dir in dirs {
					if dir != &current_primary && !secondary.contains(dir) {
						secondary.push(dir.clone());
					}
				}
			},
			Kind::RemoveDirs { dirs } => {
				secondary.retain(|dir| !dirs.contains(dir));
			},
			_ => {},
		}
	}
	WorkspaceRoots { primary: current_primary, secondary: secondary.into() }
}

/// Durable textual summary that replaces a live context prefix.
///
/// `summary` is deliberately text rather than provider-native bytes so a
/// compacted transcript remains usable after a provider or model change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Compact {
	/// Full summary supplied to subsequent model context.
	pub summary:       Str,
	/// Optional concise summary for display.
	pub short:         Option<Str>,
	/// First live event retained after the summary event.
	pub first_kept:    u64,
	/// Context tokens observed before this compaction.
	pub tokens_before: u64,
	/// Estimated context tokens after the rewrite, when available.
	pub tokens_after:  Option<u64>,
	/// Ladder method that produced the summary; absent for extension and legacy
	/// entries.
	pub method:        Option<Str>,
	/// Optional user-visible compaction warning.
	pub warning:       Option<Str>,
	/// Durable bitmap archive, when this boundary used Snapcompact.
	pub snapcompact:   Option<transcript::SnapcompactArchive>,
	/// Ordered extension-summary losers recorded without their summary bytes.
	pub superseded:    Vec<transcript::SupersededCompaction>,
}
/// Durable disposition of a started turn that failed without an outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AbortDisposition {
	/// Continue the submission through bounded crash-recoverable retry.
	Continue,
	/// Fence the exhausted retry epoch; later caller input starts a new epoch.
	Exhausted,
}

impl AbortDisposition {
	const fn recoverable(self) -> bool {
		matches!(self, Self::Continue)
	}
}
/// Generation fence currently accepted by a session journal owner.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct JournalGenerations {
	/// Active extension-host incarnation.
	pub host:    u64,
	/// Active session incarnation.
	pub session: u64,
}

/// Request identity stamped on every durable journal operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalRequestStamp {
	/// Unique correlation identifier for this attempt.
	pub request_id:         Str,
	/// Stable key shared by retries of one logical operation.
	pub idempotency_key:    Str,
	/// Extension-host generation observed by the requester.
	pub host_generation:    u64,
	/// Session generation observed by the requester.
	pub session_generation: u64,
}

/// Core-authenticated authorship for an extension journal request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalAuthor {
	/// Authenticated person acting through the daemon.
	pub principal:  Principal,
	/// Authenticated exact extension incarnation.
	pub provenance: Provenance,
}

/// Unattributed custom payload accepted from an extension worker.
///
/// Source, principal, provenance, and the display default are deliberately
/// absent: the core derives them from the live registry and authenticated
/// request channel. `rev` is only an assertion checked against that registry.
#[derive(Debug)]
pub struct PendingCustomEntry {
	/// Declared reverse-DNS entry-kind name.
	pub kind:    Str,
	/// Revision asserted by the worker's declared entry instance.
	pub rev:     Str,
	/// Canonical JSON payload bytes.
	pub data:    Option<Box<RawValue>>,
	/// Optional already-materialized model-context projection.
	pub context: Option<Content>,
	/// Per-entry display override, or the declaration default.
	pub display: Option<bool>,
}

/// One journal operation carried as one single-owner mailbox message.
#[derive(Debug)]
pub enum JournalOperation {
	/// Append one declared custom entry.
	Append(PendingCustomEntry),
	/// Append a non-transactional ordered group.
	AppendMany(Vec<PendingCustomEntry>),
	/// Append an all-or-nothing ordered group.
	AppendAtomic(Vec<PendingCustomEntry>),
	/// Append a label mutation against an earlier physical event.
	Label {
		/// Addressed physical event.
		target: u64,
		/// New label, or `None` to clear it.
		label:  Option<Str>,
	},
}

/// Authenticated journal request consumed by the session's sole owner.
#[derive(Debug)]
pub struct JournalRequest {
	/// Epoch-millisecond timestamp stamped on all operation events.
	pub ts:        u64,
	/// Durable request quartet.
	pub stamp:     JournalRequestStamp,
	/// Core-authenticated author.
	pub author:    JournalAuthor,
	/// Requested durable operation.
	pub operation: JournalOperation,
}

/// Successful result from one journal mailbox request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalReply {
	/// Physical indexes assigned to the requested entries, excluding the audit
	/// event that carries the request quartet.
	pub indexes: Vec<u64>,
}
/// Rust-enforced custom-journal query from an authenticated extension.
#[derive(Clone, Debug)]
pub struct JournalQuery {
	/// Calling extension identity.
	pub caller_extension:   Str,
	/// Manifest-granted foreign extension namespaces.
	pub granted_extensions: Vec<Str>,
	/// Optional exact kind filter.
	pub kind:               Option<Str>,
	/// Optional exact recorded revision filter.
	pub rev:                Option<Str>,
	/// Exclusive physical event watermark.
	pub since:              Option<u64>,
	/// Maximum number of most-recent matches returned in ascending order.
	pub limit:              Option<usize>,
	/// Whether abandoned physical branches are excluded.
	pub live:               bool,
}

/// One raw custom-journal query result.
#[derive(Clone, Debug)]
pub struct JournalCustomEntry {
	/// Physical journal event index.
	pub index: u64,
	/// Core-stamped epoch-millisecond timestamp.
	pub ts:    u64,
	/// Strictly decoded custom record with verbatim canonical raw bytes.
	pub entry: Custom,
}
/// Visibility assigned to one physical transcript-v4 record for collaboration.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum ReplicationVisibility {
	/// Exact canonical journal bytes may be replicated to authenticated guests.
	PublicTranscript,
	/// The physical revision is retained as an omission marker, without payload
	/// bytes.
	HostLocalOmitted,
}

/// One ordered physical transcript-v4 record offered to a collaboration host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplicationRecord {
	/// One-based physical host-journal revision.
	pub revision:   u64,
	/// Visibility decision made by the journal owner.
	pub visibility: ReplicationVisibility,
	/// Exact public record or a non-semantic host-local omission marker.
	pub json:       Bytes,
}

/// Terminal status for a bounded journal replication subscription.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplicationTerminal {
	/// The host bridge failed to consume records within the bounded lag window.
	Lagged {
		/// Last revision successfully offered to the bridge.
		after: u64,
	},
	/// The authoritative journal owner closed.
	Closed,
}

/// Catch-up plus ordered live transcript-v4 replication delivery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplicationEvent {
	/// A committed physical record, including visibility-preserving omissions.
	Record(ReplicationRecord),
	/// The live subscription ended and must not be reused.
	Terminal(ReplicationTerminal),
}

/// Catch-up snapshot and bounded live stream captured under the sole journal
/// owner.
pub struct ReplicationSubscription {
	catch_up:      VecDeque<ReplicationRecord>,
	live:          Receiver<ReplicationEvent>,
	host_revision: u64,
}

impl ReplicationSubscription {
	/// Returns the host revision fenced by the catch-up snapshot.
	pub const fn host_revision(&self) -> u64 {
		self.host_revision
	}

	/// Removes the next catch-up record in physical revision order.
	pub fn next_catch_up(&mut self) -> Option<ReplicationRecord> {
		self.catch_up.pop_front()
	}

	/// Returns the number of catch-up records not yet consumed.
	pub fn catch_up_len(&self) -> usize {
		self.catch_up.len()
	}

	/// Receives the next committed live record or terminal status.
	pub async fn recv(&self) -> Result<ReplicationEvent, flume::RecvError> {
		self.live.recv_async().await
	}

	/// Attempts to receive a live record without waiting.
	pub fn try_recv(&self) -> Result<ReplicationEvent, flume::TryRecvError> {
		self.live.try_recv()
	}
}

const REPLICATION_LAG_CAPACITY: usize = 256;

struct ReplicationSubscriber {
	last:   u64,
	sender: flume::Sender<ReplicationEvent>,
}
/// Session-scoped compare-and-swap value backed by a physical journal event.
#[derive(Clone, Debug)]
pub struct SessionStateValue {
	/// Physical journal event index, also the session state revision.
	pub revision: StateRevision,
	/// Namespaced state key.
	pub key:      Str,
	/// Verbatim canonical JSON value.
	pub value:    Box<RawValue>,
}
/// Ordered SESSION-state watch delivery.
#[derive(Clone, Debug)]
pub enum SessionStateWatchEvent {
	/// A newer compare-and-swap value committed durably.
	Value(SessionStateValue),
	/// The subscription ended with an explicit typed status.
	Terminal(SessionStateWatchTerminal),
}

/// Terminal SESSION-state subscription status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionStateWatchTerminal {
	/// The bounded consumer fell behind; resubscribe after this revision.
	Lagged {
		/// Last revision offered before termination.
		after: Option<StateRevision>,
	},
	/// The owning journal actor closed.
	Closed,
}

struct SessionStateSubscriber {
	namespace: Str,
	key:       Str,
	last:      Option<StateRevision>,
	sender:    flume::Sender<SessionStateWatchEvent>,
}

#[derive(Deserialize, Serialize)]
struct SessionCasRecord {
	namespace: Str,
	key:       Str,
	value:     Box<RawValue>,
}

#[derive(Deserialize, Serialize)]
struct SessionContentRecord {
	namespace: Str,
	reference: BlobRef,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
enum JournalOperationName {
	Append,
	AppendMany,
	AppendAtomic,
	Label,
	StateCompareExchange,
	StateContent,
}

/// Journal append or validation failure.
#[derive(Debug, Error)]
pub enum JournalError {
	/// Transcript storage failed.
	#[error(transparent)]
	Storage(#[from] transcript::Error),
	/// A non-atomic group left a proven durable prefix.
	#[error("journal append_many failed after {count} entries: {source}", count = .appended.len())]
	Partial {
		/// Durable custom-entry index run that landed before failure.
		appended: IndexRun,
		/// Proven writer failure.
		#[source]
		source:   WriterError,
	},
	/// Durability could not be proven and this session has halted.
	#[error("journal durability is indeterminate; the session is halted: {0}")]
	JournalIndeterminate(#[source] transcript::writer::JournalIndeterminate),
	/// An atomic request exceeded the durable writer's hard group bound.
	#[error("atomic journal append has {entries} events; maximum is {maximum}")]
	AtomicTooLarge {
		/// Requested event count, including its request audit.
		entries: usize,
		/// Durable writer ceiling.
		maximum: usize,
	},
	/// This owner previously observed indeterminate durability.
	#[error("journal session is halted after an indeterminate write")]
	Halted,
	/// Child initialization was attempted after another durable event.
	#[error("child initialization must be the first journal event")]
	ChildInitNotFirst,
	/// A durable request was sent by a stale host or session generation.
	#[error(
		"stale journal generation: expected host {expected_host}/session {expected_session}, got \
		 host {actual_host}/session {actual_session}"
	)]
	StaleGeneration {
		/// Active host generation.
		expected_host:    u64,
		/// Active session generation.
		expected_session: u64,
		/// Request host generation.
		actual_host:      u64,
		/// Request session generation.
		actual_session:   u64,
	},
	/// The request's authenticated provenance disagreed with its host fence.
	#[error("journal author provenance generation does not match the request generation")]
	AuthorGenerationMismatch,
	/// A custom append or label was requested while a turn was pending.
	#[error("cannot append extension journal state while a turn is pending")]
	WriteWhilePending,
	/// A label targeted an absent physical journal event.
	#[error("journal target {0} is outside the physical event range")]
	InvalidTarget(u64),
	/// A core SESSION-state record failed strict decoding.
	#[error("session state record at journal event {0} is corrupt")]
	CorruptSessionState(u64),
	/// An idempotency key was replayed with a different operation or payload.
	#[error("journal idempotency replay for `{0}` differs from durable truth")]
	IdempotencyConflict(Str),
	/// Entry-kind declaration or access validation failed.
	#[error(transparent)]
	EntryKind(#[from] EntryKindError),
	/// A worker supplied context for a kind without a declared projection.
	#[error("entry kind `{0}` does not declare a model-context projection")]
	ProjectionNotDeclared(Str),
	/// A worker asserted a revision other than the live declared revision.
	#[error("entry kind `{kind}` asserted revision `{actual}`, live revision is `{expected}`")]
	RevisionMismatch {
		/// Declared kind.
		kind:     Str,
		/// Live registry revision.
		expected: Str,
		/// Rejected worker revision.
		actual:   Str,
	},
	/// A repeated invocation phase carried different facts.
	#[error("invocation {0} replay differs from its durable transition")]
	InvocationReplayMismatch(Str),
	/// An invocation skipped, reversed, or restarted its durable phase machine.
	#[error("invocation {invocation_id} cannot transition from {previous:?} to {next:?}")]
	InvalidInvocationTransition {
		/// Stable invocation identity.
		invocation_id: Str,
		/// Last durable phase, or `None` before `OPEN`.
		previous:      Option<InvocationPhase>,
		/// Rejected next phase.
		next:          InvocationPhase,
	},
	/// The sessions index rejected an event before its journal append.
	#[error("sessions index rejected journal write: {0}")]
	SessionIndex(#[source] index::Error),
	/// The journal committed but its rebuildable sessions-index update failed.
	#[error("journal event {event_index} committed but sessions index failed: {source}")]
	SessionIndexAfterJournal {
		/// Durable event index that must not be appended again.
		event_index: u64,
		/// Rebuildable index failure.
		#[source]
		source:      index::Error,
	},
	/// The journal committed but its collaboration projection could not be
	/// encoded.
	#[error("journal event {event_index} committed but replication projection failed: {source}")]
	ReplicationAfterJournal {
		/// Durable event index that must not be appended again.
		event_index: u64,
		/// Transcript-v4 projection failure.
		#[source]
		source:      transcript::Error,
	},
	/// A sequence amendment targeted a non-item event.
	#[error("sequence amendment target {0} is not a canonical item")]
	InvalidItemTarget(u64),
	/// Arbiter-assigned item sequences begin at one.
	#[error("arbiter sequence must be nonzero")]
	ZeroSequence,
	/// A resumed turn replay did not match its already journaled prefix.
	#[error("replayed outcome for turn {0} differs from its durable prefix")]
	TurnReplayMismatch(Str),
	/// A logical turn was started again with a different prompt identity.
	#[error("turn start for {0} changed its durable prompt identity")]
	TurnStartMismatch(Str),
	/// Session-scoped state routing or CAS validation failed.
	#[error(transparent)]
	State(#[from] state::Error),
	/// A settled failed turn was opened again under the same identity.
	#[error("turn {0} was already aborted")]
	TurnAlreadyAborted(Str),
	/// A repeated turn abort changed whether crash replay may continue it.
	#[error("turn abort for {0} changed recovery disposition")]
	TurnAbortMismatch(Str),
	/// One optimistic item was claimed by two live logical turns.
	#[error("journal item {target} is already claimed by live turn {turn_id}")]
	ItemAlreadyClaimed {
		/// Physical item event index.
		target:  u64,
		/// Existing logical turn.
		turn_id: Str,
	},
	/// A turn start referenced an absent or non-item event.
	#[error("turn start references non-item event {0}")]
	InvalidTurnInput(u64),
	/// A terminal arbiter outcome arrived without a durable turn start.
	#[error("arbiter outcome for turn {0} has no durable turn start")]
	MissingTurnStart(Str),
	/// A durable receipt revision cannot assign its recorded input sequences.
	#[error("turn receipt for {0} has an invalid sequence range")]
	InvalidSequenceRange(Str),
	/// A recorded sequence amendment disagrees with its authoritative receipt.
	#[error("sequence amendment for event {target} is {actual}, expected {expected}")]
	SequenceReplayMismatch {
		/// Patched item event.
		target:   u64,
		/// Durable amendment value.
		actual:   u64,
		/// Receipt-derived value.
		expected: u64,
	},
	/// A prompt rewrite contained missing, duplicate, or mismatched stages.
	#[error("prompt rewrite intent {0} is corrupt")]
	CorruptPromptRewrite(u64),
	/// A repeated detached-job event disagreed with its durable record.
	#[error("detached job {0} replay differs from durable truth")]
	JobReplayMismatch(Str),
	/// A repeated tool-batch authorization disagreed with durable truth.
	#[error("tool batch authorization for turn {0} changed")]
	ToolBatchReplayMismatch(Str),
	/// A tool batch references a turn without its durable terminal receipt.
	#[error("tool batch authorization for turn {0} has no receipt")]
	ToolBatchWithoutReceipt(Str),
	/// An authorization named a call absent from its turn receipt.
	#[error("tool call {call_id} is absent from receipt {turn_id}")]
	UnknownReceiptCall {
		/// Arbiter turn identifier.
		turn_id: Str,
		/// Missing call identifier.
		call_id: Str,
	},
	/// Canonical recovery-result construction failed.
	#[error(transparent)]
	Projection(#[from] ProjectionError),
	/// A requested checkpoint does not exist in the parent journal.
	#[error("journal event index {index} does not exist")]
	InvalidEventIndex {
		/// Missing physical event index.
		index: u64,
	},
	/// A context or provider transition was requested while a durable turn was
	/// still pending.
	#[error("cannot transition session state while a turn is pending")]
	TransitionWhilePending,
	/// Rewind was requested while a durable turn was still pending.
	#[error("cannot rewind while a turn is pending")]
	RewindWhilePending,
	/// Compaction was requested while a durable turn was still pending.
	#[error("cannot compact while a turn is pending")]
	CompactWhilePending,
}

const _: () = assert!(std::mem::size_of::<JournalError>() <= 128, "JournalError must stay compact");

/// Append-only transcript owner with an in-memory terminal-turn index.
pub struct Journal {
	path: PathBuf,
	writer: Writer,
	reader: Mutex<CachedReader>,
	receipts: BTreeMap<Str, TurnReceipt>,
	starts: BTreeMap<Str, (u64, TurnStart)>,
	aborted: BTreeMap<Str, (u64, AbortDisposition)>,
	claims: BTreeMap<u64, Str>,
	last_start: Option<TurnStart>,
	session_id: transcript::SessionId,
	last_receipt: Option<TurnReceipt>,
	last_receipt_event: Option<u64>,
	active_prompt: Option<ActivePrompt>,
	pending: BTreeMap<Str, PendingItems>,
	pending_jobs: BTreeMap<Str, (u64, JobRef)>,
	settled_jobs: BTreeMap<Str, (u64, Item)>,
	authorized_batches: BTreeMap<Str, (u64, Vec<Str>)>,
	recoverable_settlements: Vec<u64>,
	released_inputs: Vec<u64>,
	released_turn_id: Option<Str>,
	pending_inputs: VecDeque<(Str, Vec<u64>)>,
	item_count: u64,
	context_revision: u64,
	compaction_epoch: u64,
	prompt_anchor: Option<u64>,
	entry_kinds: EntryKindRegistry,
	invocations: HashMap<Str, (u64, transcript::InvocationTransition)>,
	generations: JournalGenerations,
	request_replays: HashMap<ReplayKey, Vec<u64>>,
	halted: bool,
	session_index: Option<(Arc<SessionIndex>, transcript::SessionId)>,
	state_subscribers: HashMap<u64, SessionStateSubscriber>,
	next_state_subscriber: u64,
	replication_subscribers: HashMap<u64, ReplicationSubscriber>,
	next_replication_subscriber: u64,
}

impl Journal {
	/// Creates an empty transcript-v4 journal.
	pub fn create(path: &Path, header: &Header) -> Result<Self, JournalError> {
		let writer = Writer::create_lazy(path, header)?;
		let reader = Mutex::new(CachedReader::pending(path, header.clone()));
		Ok(Self {
			path: path.to_owned(),
			writer,
			reader,
			receipts: BTreeMap::new(),
			starts: BTreeMap::new(),
			aborted: BTreeMap::new(),
			claims: BTreeMap::new(),
			last_start: None,
			last_receipt: None,
			session_id: header.id.clone(),
			last_receipt_event: None,
			active_prompt: None,
			pending: BTreeMap::new(),
			pending_jobs: BTreeMap::new(),
			authorized_batches: BTreeMap::new(),
			recoverable_settlements: Vec::new(),
			released_inputs: Vec::new(),
			released_turn_id: None,
			pending_inputs: VecDeque::new(),
			settled_jobs: BTreeMap::new(),
			item_count: 0,
			context_revision: 0,
			compaction_epoch: 0,
			prompt_anchor: None,
			entry_kinds: EntryKindRegistry::new(),
			invocations: HashMap::new(),
			generations: JournalGenerations::default(),
			request_replays: HashMap::new(),
			halted: false,
			session_index: None,
			state_subscribers: HashMap::new(),
			next_state_subscriber: 0,
			replication_subscribers: HashMap::new(),
			next_replication_subscriber: 0,
		})
	}

	/// Opens an existing transcript and restores terminal turn receipts.
	pub fn open(path: &Path) -> Result<Self, JournalError> {
		let log = transcript::load(path)?;
		let mut receipts = BTreeMap::new();
		let mut starts: BTreeMap<Str, (u64, TurnStart)> = BTreeMap::new();
		let mut aborted = BTreeMap::new();
		let mut last_start = None;
		let mut pending: BTreeMap<Str, PendingItems> = BTreeMap::new();
		let mut pending_jobs = BTreeMap::new();
		let mut settled_jobs = BTreeMap::new();
		let mut item_count = 0_u64;
		let mut context_revision = 0_u64;
		let mut compaction_epoch = 0_u64;
		let mut prompt_anchor = None;
		let mut last_receipt = None;
		let mut last_receipt_event = None;
		let mut authorized_batches = BTreeMap::new();
		let mut turn_inputs = BTreeMap::<Str, Vec<u64>>::new();
		let mut invocations = HashMap::<Str, (u64, transcript::InvocationTransition)>::new();
		let mut turn_input_order = Vec::new();
		let mut claimed_ever = BTreeSet::new();
		let mut request_replays = HashMap::<ReplayKey, Vec<u64>>::new();
		let mut settled_input_events = Vec::new();
		for index in 0..u64::try_from(log.len()).expect("transcript length fits in u64") {
			let Some(transcript::Entry::Ok(event)) = log.get(index) else {
				continue;
			};
			match &event.kind {
				Kind::Item(record) => {
					item_count = item_count.saturating_add(1);
					advance_message_position(
						&record.item,
						index,
						&mut context_revision,
						&mut prompt_anchor,
					);
					if let Some(turn_id) = &record.turn_id {
						pending.entry(turn_id.clone()).or_default().push((
							index,
							record.item.clone(),
							record.prompt_hash,
						));
					}
				},
				Kind::TurnInput(input) => {
					item_count = item_count.saturating_add(1);
					advance_message_position(
						&input.item,
						index,
						&mut context_revision,
						&mut prompt_anchor,
					);
					if !turn_inputs.contains_key(input.turn_id.as_str()) {
						turn_input_order.push(input.turn_id.clone());
					}
					turn_inputs
						.entry(input.turn_id.clone())
						.or_default()
						.push(index);
				},
				Kind::PromptRewriteStage(_) => {
					item_count = item_count.saturating_add(1);
				},
				Kind::TurnStart(start) => {
					starts.insert(start.turn_id.clone(), (index, start.clone()));
					last_start = Some(start.clone());
					claimed_ever.extend(start.item_events.iter().copied());
				},
				Kind::TurnAbort(abort) => {
					let disposition = if abort.recoverable {
						AbortDisposition::Continue
					} else {
						AbortDisposition::Exhausted
					};
					aborted.insert(abort.turn_id.clone(), (index, disposition));
				},
				Kind::TurnReceipt(receipt) => {
					receipts.insert(receipt.turn_id.clone(), receipt.clone());
					last_receipt = Some(receipt.clone());
					last_receipt_event = Some(index);
				},
				Kind::JobRegistered(registered) => {
					if !settled_jobs.contains_key(registered.job.id.as_str()) {
						pending_jobs.insert(registered.job.id.clone(), (index, registered.job.clone()));
					}
				},
				Kind::JobSettled(settled) => {
					pending_jobs.remove(settled.job_id.as_str());
					item_count = item_count.saturating_add(1);
					settled_jobs.insert(settled.job_id.clone(), (index, settled.settlement.clone()));
					settled_input_events.push(index);
				},
				Kind::ToolBatchAuthorized(batch) => {
					authorized_batches.insert(batch.turn_id.clone(), (index, batch.call_ids.clone()));
				},
				Kind::RequestAudit(audit) => {
					let key = (
						audit.extension_id.clone(),
						audit.idempotency_key.clone(),
						audit.operation.clone(),
					);
					let indexes = audit.indexes.iter().copied().collect::<Vec<_>>();
					if let Some(previous) = request_replays.insert(key, indexes.clone())
						&& previous != indexes
					{
						return Err(JournalError::IdempotencyConflict(audit.idempotency_key.clone()));
					}
				},
				Kind::InvocationTransition(transition) => {
					if let Some((_, previous)) = invocations.get(transition.invocation_id.as_str()) {
						if transition.phase == previous.phase && transition != previous {
							return Err(JournalError::InvocationReplayMismatch(
								transition.invocation_id.clone(),
							));
						}
						if transition.phase != previous.phase
							&& (transition.call_id != previous.call_id
								|| !previous.phase.can_transition_to(transition.phase))
						{
							return Err(JournalError::InvalidInvocationTransition {
								invocation_id: transition.invocation_id.clone(),
								previous:      Some(previous.phase),
								next:          transition.phase,
							});
						}
					} else if transition.phase != InvocationPhase::Open {
						return Err(JournalError::InvalidInvocationTransition {
							invocation_id: transition.invocation_id.clone(),
							previous:      None,
							next:          transition.phase,
						});
					}
					invocations.insert(transition.invocation_id.clone(), (index, transition.clone()));
				},
				Kind::Reset | Kind::Compact { .. } => {
					context_revision = context_revision.saturating_add(1);
					compaction_epoch = compaction_epoch.saturating_add(1);
				},
				_ => {},
			}
		}
		starts.retain(|turn_id, _| !receipts.contains_key(turn_id) && !aborted.contains_key(turn_id));
		let mut claims = BTreeMap::new();
		for (turn_id, (_, start)) in &starts {
			for target in &start.item_events {
				if !matches!(log.get(*target), Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some())
				{
					return Err(JournalError::InvalidTurnInput(*target));
				}
				if let Some(existing) = claims.insert(*target, turn_id.clone())
					&& existing != *turn_id
				{
					return Err(JournalError::ItemAlreadyClaimed {
						target:  *target,
						turn_id: existing,
					});
				}
			}
			for target in start
				.prompt_head_events
				.iter()
				.chain(&start.sequence_targets)
			{
				if !matches!(log.get(*target), Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some())
				{
					return Err(JournalError::InvalidTurnInput(*target));
				}
			}
		}
		pending
			.retain(|turn_id, _| !receipts.contains_key(turn_id) && !aborted.contains_key(turn_id));
		let recovery_epoch = aborted
			.values()
			.filter_map(|(index, disposition)| {
				(*disposition == AbortDisposition::Exhausted).then_some(*index)
			})
			.chain(last_receipt_event)
			.max();
		let mut released_inputs = Vec::new();
		for turn_id in &turn_input_order {
			if aborted
				.get(turn_id.as_str())
				.is_some_and(|(abort, disposition)| {
					*disposition == AbortDisposition::Continue
						&& recovery_epoch.is_none_or(|boundary| *abort > boundary)
				}) && let Some(events) = turn_inputs.get(turn_id.as_str())
			{
				released_inputs.extend_from_slice(events);
			}
		}
		let released_turn_id =
			(!released_inputs.is_empty()).then(|| Str::new(omp_core::Ulid::generate().to_string()));
		for turn_id in starts.keys().chain(receipts.keys()).chain(aborted.keys()) {
			turn_inputs.remove(turn_id.as_str());
		}
		let mut writer = Writer::open_append(path)?;
		let (recovered_items, active_prompt) = recover_prompt_rewrites(&log, &mut writer)?;
		item_count = item_count.saturating_add(recovered_items);
		recover_sequence_amendments(&log, &mut writer)?;
		let recovered_batches = recover_tool_batches(&log, &mut writer)?;
		item_count = item_count.saturating_add(
			u64::try_from(recovered_batches.len()).expect("recovered batch length fits in u64"),
		);
		for (turn_id, index) in recovered_batches {
			if !turn_inputs.contains_key(turn_id.as_str()) {
				turn_input_order.push(turn_id.clone());
			}
			turn_inputs.entry(turn_id).or_default().push(index);
		}
		let pending_inputs = turn_input_order
			.into_iter()
			.filter_map(|turn_id| {
				turn_inputs
					.remove(turn_id.as_str())
					.map(|events| (turn_id, events))
			})
			.collect();
		let recoverable_settlements = settled_input_events
			.into_iter()
			.filter(|index| !claimed_ever.contains(index))
			.collect();
		let cached_reader = CachedReader::open(path)?;
		let session_id = cached_reader.transcript.log().header().id.clone();
		let reader = Mutex::new(cached_reader);
		Ok(Self {
			path: path.to_owned(),
			writer,
			reader,
			receipts,
			starts,
			aborted,
			claims,
			last_start,
			last_receipt,
			last_receipt_event,
			active_prompt,
			pending,
			pending_jobs,
			session_id,
			settled_jobs,
			authorized_batches,
			recoverable_settlements,
			pending_inputs,
			released_inputs,
			released_turn_id,
			item_count,
			context_revision,
			compaction_epoch,
			prompt_anchor,
			entry_kinds: EntryKindRegistry::new(),
			invocations,
			generations: JournalGenerations::default(),
			request_replays,
			halted: false,
			session_index: None,
			state_subscribers: HashMap::new(),
			next_state_subscriber: 0,
			replication_subscribers: HashMap::new(),
			next_replication_subscriber: 0,
		})
	}

	/// Borrows the incrementally refreshed durable journal for pure projection.
	///
	/// The returned value holds the journal's reader lock. Callers must drop it
	/// before mutating or otherwise reading this journal again.
	pub fn load(&self) -> Result<impl Deref<Target = transcript::LiveLog> + '_, JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		let mut reader = self.reader.lock();
		reader.refresh_projection()?;
		Ok(JournalLog(reader))
	}

	/// Returns the durable session identity owned by this journal.
	pub const fn session_id(&self) -> &transcript::SessionId {
		&self.session_id
	}

	fn prepare_append(&mut self) -> Result<u64, JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		let cached = self.reader.get_mut();
		let before = cached.transcript.refresh()?;
		if cached.writer_stale || !matches!(before.state, RefreshState::Unchanged) {
			self.writer = Writer::open_append(&self.path)?;
			let repaired = cached.transcript.refresh()?;
			if !matches!(repaired.state, RefreshState::Unchanged) {
				return Err(refresh_invariant("reader changed while resynchronizing writer"));
			}
			cached.writer_stale = false;
		}
		Ok(cached.transcript.next_index())
	}

	fn refresh_after_append(&mut self, expected: u64, count: usize) -> Result<(), JournalError> {
		let cached = self.reader.get_mut();
		let report = cached.transcript.refresh()?;
		let count = u64::try_from(count).expect("journal request event count fits in u64");
		if report.next_index != expected.saturating_add(count)
			|| !matches!(report.state, RefreshState::Advanced { records } if records == count)
		{
			self.writer = Writer::open_append(&self.path)?;
			cached.transcript.refresh()?;
			cached.writer_stale = false;
			return Err(refresh_invariant("writer and incremental reader diverged after append"));
		}
		Ok(())
	}

	fn append_events(&mut self, events: &[Event]) -> Result<Vec<u64>, JournalError> {
		let expected = self.prepare_append()?;
		match self.writer.append_atomic(events) {
			Ok(indexes) => {
				self.refresh_after_append(expected, events.len())?;
				let indexes = indexes.into_vec();
				self.publish_replication(&indexes, events)?;
				Ok(indexes)
			},
			Err(WriterError::RolledBack { source }) => {
				self.reader.get_mut().transcript.refresh()?;
				Err(JournalError::Storage(source))
			},
			Err(WriterError::Indeterminate(indeterminate)) => {
				self.halt_session();
				Err(JournalError::JournalIndeterminate(indeterminate))
			},
			Err(WriterError::TooManyEntries { entries, maximum }) => {
				Err(JournalError::AtomicTooLarge { entries, maximum })
			},
		}
	}

	fn append(&mut self, event: &Event) -> Result<u64, JournalError> {
		let expected = self.prepare_append()?;
		match self.writer.append_atomic(slice::from_ref(event)) {
			Ok(indexes) => {
				self.refresh_after_append(expected, 1)?;
				let index = indexes[0];
				self.publish_replication(slice::from_ref(&index), slice::from_ref(event))?;
				Ok(index)
			},
			Err(WriterError::RolledBack { source }) => {
				self.reader.get_mut().transcript.refresh()?;
				Err(JournalError::Storage(source))
			},
			Err(WriterError::Indeterminate(indeterminate)) => {
				self.halt_session();
				Err(JournalError::JournalIndeterminate(indeterminate))
			},
			Err(WriterError::TooManyEntries { entries, maximum }) => {
				Err(JournalError::AtomicTooLarge { entries, maximum })
			},
		}
	}

	/// Appends the first production child initialization record.
	///
	/// Every content-addressed snapshot must be placed before this call. The
	/// resulting event is the durable cross-process revival anchor.
	pub fn append_child_init(
		&mut self,
		ts: u64,
		system_prompt: BlobRef,
		tools: Vec<Str>,
		output_schema: Option<Box<RawValue>>,
		revival: ChildSessionInit,
	) -> Result<u64, JournalError> {
		if !self.load()?.log().is_empty() {
			return Err(JournalError::ChildInitNotFirst);
		}
		let agent = Some(revival.parent_id.clone());
		self.append(&Event {
			ts,
			kind: Kind::Init { system_prompt, tools, agent, output_schema, revival: Some(revival) },
		})
	}

	/// Appends one durable child lifecycle transition linked to its Init event.
	pub fn append_child_lifecycle(
		&mut self,
		ts: u64,
		entry: ChildLifecycleEntry,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::ChildLifecycle(entry) })
	}

	/// Atomically creates a branch or fork child with ruled lineage semantics.
	pub fn create_child(
		&self,
		path: &Path,
		header: &transcript::Header,
		ts: u64,
		kind: ChildKind,
	) -> Result<Self, JournalError> {
		let (at, seed) = {
			let log = self.load()?;
			match kind {
				ChildKind::Branch { checkpoint } => {
					let mut live = transcript::LiveSet::new();
					if !log.log().live_through_into(checkpoint, &mut live) {
						return Err(JournalError::InvalidEventIndex { index: checkpoint });
					}
					(Some(checkpoint), project::project_journal_items(log.log(), &live)?)
				},
				ChildKind::Fork => (None, project::project_journal_items(log.log(), log.live())?),
			}
		};
		let mut child = Self::create(path, header)?;
		if let Some((index, _)) = &self.session_index {
			child.attach_session_index(Arc::clone(index), header.id.clone());
		}
		child.append_forked_from(ts, &self.session_id, at)?;
		for item in seed {
			child.append_optimistic(ts, item, None)?;
		}
		Ok(child)
	}

	/// Appends a branch summary only while its source checkpoint still exists.
	pub fn branch_summary(&mut self, ts: u64, from: u64, summary: Str) -> Result<u64, JournalError> {
		let log = self.load()?;
		if log.log().get(from).is_none() {
			return Err(JournalError::InvalidEventIndex { index: from });
		}
		drop(log);
		self.append(&Event { ts, kind: Kind::Branch { from, summary } })
	}

	/// Atomically creates a handoff child containing parent lineage and a
	/// structured summary instead of copying the parent's live projection.
	///
	/// `checkpoint` and `compaction_epoch` are validated by the coordinator
	/// before this journal-owner operation. The checkpoint is checked again
	/// here so a stale parent event can never be recorded as current lineage.
	pub fn create_handoff_child(
		&self,
		path: &Path,
		header: &transcript::Header,
		ts: u64,
		checkpoint: u64,
		mut compact: Compact,
	) -> Result<Self, JournalError> {
		let log = self.load()?;
		if log.log().get(checkpoint).is_none() {
			return Err(JournalError::InvalidEventIndex { index: checkpoint });
		}
		drop(log);
		compact.first_kept = 0;
		compact.method = Some(sf!("handoff"));
		let mut child = Self::create(path, header)?;
		if let Some((index, _)) = &self.session_index {
			child.attach_session_index(Arc::clone(index), header.id.clone());
		}
		child.append_forked_from(ts, &self.session_id, Some(checkpoint))?;
		child.compact(ts, compact)?;
		Ok(child)
	}

	fn append_forked_from(
		&mut self,
		ts: u64,
		parent: &transcript::SessionId,
		at: Option<u64>,
	) -> Result<u64, JournalError> {
		let event = Event { ts, kind: Kind::ForkedFrom { session: parent.clone(), at } };
		let appended = self.append_indexed_event(
			ts,
			"forked_from",
			EventProjection::Fork { parent, at },
			&event,
		)?;
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal {
				event_index: appended.index,
				source,
			});
		}
		Ok(appended.index)
	}

	/// Attaches the authoritative write-time sessions index for this journal.
	pub fn attach_session_index(
		&mut self,
		index: Arc<SessionIndex>,
		session: transcript::SessionId,
	) {
		self.session_index = Some((index, session));
	}

	/// Returns the latest durable context position reconstructed from journal
	/// boundaries.
	pub const fn context_position(&self) -> ContextPosition {
		ContextPosition {
			anchor:   self.prompt_anchor,
			revision: self.context_revision,
			epoch:    self.compaction_epoch,
		}
	}

	fn next_message_position(
		&mut self,
		item: &Item,
	) -> Result<Option<ContextPosition>, JournalError> {
		let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
			return Ok(None);
		};
		let anchor = if message.role == Role::User as i32 {
			Some(self.prepare_append()?)
		} else {
			self.prompt_anchor
		};
		Ok(Some(ContextPosition {
			anchor,
			revision: self.context_revision.saturating_add(1),
			epoch: self.compaction_epoch,
		}))
	}

	fn commit_message_position(&mut self, item: &Item, event_index: u64) {
		advance_message_position(
			item,
			event_index,
			&mut self.context_revision,
			&mut self.prompt_anchor,
		);
	}

	/// Returns the complete committed journal byte watermark.
	pub fn byte_watermark(&self) -> Result<u64, JournalError> {
		Ok(self.writer.byte_watermark()?)
	}

	/// Subscribes to a complete ordered catch-up and bounded live committed
	/// records.
	///
	/// Catch-up is captured and the subscriber is registered while this sole
	/// owner is mutably borrowed, so no journal commit can fall between them.
	/// Host-local records become omission markers at the same physical revision;
	/// their payload bytes never enter the collaboration channel.
	pub fn subscribe_replication(&mut self) -> Result<ReplicationSubscription, JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		let (catch_up, host_revision) = {
			let log = self.load()?;
			let host_revision =
				u64::try_from(log.log().len()).expect("transcript event count fits in u64");
			let mut catch_up = VecDeque::with_capacity(log.log().len());
			for index in 0..host_revision {
				let record = match log.log().get(index) {
					Some(transcript::Entry::Ok(event)) => {
						replication_record(index, Some(event)).map_err(|source| {
							JournalError::ReplicationAfterJournal { event_index: index, source }
						})?
					},
					_ => replication_record(index, None).map_err(|source| {
						JournalError::ReplicationAfterJournal { event_index: index, source }
					})?,
				};
				catch_up.push_back(record);
			}
			(catch_up, host_revision)
		};
		let (sender, live) = flume::bounded(REPLICATION_LAG_CAPACITY + 1);
		let subscriber = self.next_replication_subscriber;
		self.next_replication_subscriber = self.next_replication_subscriber.wrapping_add(1);
		self
			.replication_subscribers
			.insert(subscriber, ReplicationSubscriber { last: host_revision, sender });
		Ok(ReplicationSubscription { catch_up, live, host_revision })
	}

	fn publish_replication(
		&mut self,
		indexes: &[u64],
		events: &[Event],
	) -> Result<(), JournalError> {
		if self.replication_subscribers.is_empty() {
			return Ok(());
		}
		debug_assert_eq!(indexes.len(), events.len());
		for (&index, event) in indexes.iter().zip(events) {
			let record = replication_record(index, Some(event)).map_err(|source| {
				JournalError::ReplicationAfterJournal { event_index: index, source }
			})?;
			self.replication_subscribers.retain(|_, subscriber| {
				if subscriber.sender.is_disconnected() {
					return false;
				}
				if subscriber.sender.len() >= REPLICATION_LAG_CAPACITY {
					let _ = subscriber.sender.try_send(ReplicationEvent::Terminal(
						ReplicationTerminal::Lagged { after: subscriber.last },
					));
					return false;
				}
				match subscriber
					.sender
					.try_send(ReplicationEvent::Record(record.clone()))
				{
					Ok(()) => {
						subscriber.last = record.revision;
						true
					},
					Err(flume::TrySendError::Disconnected(_)) => false,
					Err(flume::TrySendError::Full(_)) => {
						let _ = subscriber.sender.try_send(ReplicationEvent::Terminal(
							ReplicationTerminal::Lagged { after: subscriber.last },
						));
						false
					},
				}
			});
		}
		Ok(())
	}

	fn append_indexed_event(
		&mut self,
		ts: u64,
		kind: &'static str,
		projection: EventProjection<'_>,
		event: &Event,
	) -> Result<IndexedAppend, JournalError> {
		let Some((index, session)) = self.session_index.clone() else {
			return Ok(IndexedAppend { index: self.append(event)?, index_error: None });
		};
		let indexed = IndexedEvent { session: &session, ts_ms: ts, kind, projection };
		match index.append(&indexed, || {
			let event_index = self.append(event)?;
			let byte_watermark = self.writer.byte_watermark()?;
			Ok((event_index, JournalPosition { event_index, byte_watermark }))
		}) {
			Ok(event_index) => Ok(IndexedAppend { index: event_index, index_error: None }),
			Err(IndexedWriteError::Journal(error)) => Err(error),
			Err(IndexedWriteError::IndexBeforeJournal(error)) => {
				Err(JournalError::SessionIndex(error))
			},
			Err(IndexedWriteError::IndexAfterJournal { written, source, .. }) => {
				Ok(IndexedAppend { index: written, index_error: Some(source) })
			},
		}
	}

	/// Appends a title event and updates the attached sessions index in the same
	/// sole-writer critical section.
	pub fn append_title(
		&mut self,
		ts: u64,
		title: Str,
		source: transcript::TitleSource,
	) -> Result<u64, JournalError> {
		let event = Event { ts, kind: Kind::Title { title: title.clone(), source } };
		let appended = self.append_indexed_event(
			ts,
			"title",
			EventProjection::Title { title: title.as_str(), source },
			&event,
		)?;
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal {
				event_index: appended.index,
				source,
			});
		}
		Ok(appended.index)
	}

	/// Appends and write-time-indexes a title, then publishes the accepted
	/// title through the host event bus. A failed journal/index write emits no
	/// observable title transition.
	pub fn append_title_and_publish(
		&mut self,
		ts: u64,
		title: Str,
		source: transcript::TitleSource,
		events: &EventBus,
	) -> Result<u64, JournalError> {
		let index = self.append_title(ts, title.clone(), source)?;
		events.title_changed(title, source);
		Ok(index)
	}

	/// Changes the primary workspace root for future entries only.
	///
	/// The immutable header remains the historical creation root.
	pub fn move_workspace_root(&mut self, ts: u64, root: PathBuf) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::MoveRoot { root } })
	}

	/// Appends ordered secondary workspace roots to the session.
	///
	/// Canonicalization and Environment-grant validation belong to the app
	/// boundary. Replay preserves the exact accepted ordering.
	pub fn append_workspace_dirs(
		&mut self,
		ts: u64,
		dirs: impl Into<Vec<PathBuf>>,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::AddDirs { dirs: dirs.into() } })
	}

	/// Appends a durable removal of secondary workspace roots.
	///
	/// Projection always preserves the primary root, even if an old or corrupt
	/// caller records it in this event.
	pub fn remove_workspace_dirs(
		&mut self,
		ts: u64,
		dirs: impl Into<Vec<PathBuf>>,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::RemoveDirs { dirs: dirs.into() } })
	}

	/// Atomically replaces secondary workspace roots in one journal commit.
	pub fn replace_workspace_dirs(
		&mut self,
		ts: u64,
		remove: impl Into<Vec<PathBuf>>,
		add: impl Into<Vec<PathBuf>>,
	) -> Result<Vec<u64>, JournalError> {
		let remove = remove.into();
		let add = add.into();
		let mut events =
			Vec::with_capacity(usize::from(!remove.is_empty()) + usize::from(!add.is_empty()));
		if !remove.is_empty() {
			events.push(Event { ts, kind: Kind::RemoveDirs { dirs: remove } });
		}
		if !add.is_empty() {
			events.push(Event { ts, kind: Kind::AddDirs { dirs: add } });
		}
		if events.is_empty() {
			return Ok(Vec::new());
		}
		self.append_events(&events)
	}

	/// Folds every physical root mutation in append order.
	///
	/// Rewinds and context resets do not erase workspace authority history.
	pub fn workspace_roots(&self, primary: &Path) -> Result<WorkspaceRoots, JournalError> {
		let log = self.load()?;
		Ok(fold_workspace_roots(
			primary,
			(0..u64::try_from(log.log().len()).expect("journal length fits u64")).filter_map(
				|index| match log.log().get(index) {
					Some(transcript::Entry::Ok(event)) => Some(&event.kind),
					Some(transcript::Entry::Tombstone(_)) | None => None,
				},
			),
		))
	}

	/// Replaces the host/session generation fence accepted by this owner.
	pub const fn set_generations(&mut self, generations: JournalGenerations) {
		self.generations = generations;
	}

	/// Atomically declares one authenticated extension's complete entry-kind
	/// set.
	pub fn declare_entry_kinds(
		&mut self,
		extension: &str,
		declarations: impl IntoIterator<Item = EntryKindDecl>,
	) -> Result<(), JournalError> {
		self
			.entry_kinds
			.declare_extension(extension, declarations)?;
		Ok(())
	}

	/// Borrows the live entry-kind registry for scoped query validation.
	pub const fn entry_kinds(&self) -> &EntryKindRegistry {
		&self.entry_kinds
	}

	/// Returns the journaled phase of one invocation, when any transition has
	/// been recorded for it.
	///
	/// Live-fact writers advance phases during the turn, so post-outcome
	/// replay ladders consult this to skip steps the journal already passed.
	pub fn invocation_phase(&self, invocation_id: &str) -> Option<InvocationPhase> {
		self
			.invocations
			.get(invocation_id)
			.map(|(_, transition)| transition.phase)
	}

	/// Persists one adjacent invocation-machine transition through the journal
	/// owner.
	///
	/// An exact repeat of the current phase is idempotent and returns its
	/// existing event index. Changed facts, skipped phases, reversed phases, and
	/// call-id changes are rejected before staging bytes.
	pub fn record_invocation_transition(
		&mut self,
		ts: u64,
		transition: transcript::InvocationTransition,
	) -> Result<u64, JournalError> {
		transition.validate().map_err(transcript::Error::from)?;
		if let Some((index, previous)) = self.invocations.get(transition.invocation_id.as_str()) {
			if transition.phase == previous.phase {
				return if transition == *previous {
					Ok(*index)
				} else {
					Err(JournalError::InvocationReplayMismatch(transition.invocation_id.clone()))
				};
			}
			if transition.call_id != previous.call_id
				|| !previous.phase.can_transition_to(transition.phase)
			{
				return Err(JournalError::InvalidInvocationTransition {
					invocation_id: transition.invocation_id.clone(),
					previous:      Some(previous.phase),
					next:          transition.phase,
				});
			}
		} else if transition.phase != InvocationPhase::Open {
			return Err(JournalError::InvalidInvocationTransition {
				invocation_id: transition.invocation_id.clone(),
				previous:      None,
				next:          transition.phase,
			});
		}
		let invocation_id = transition.invocation_id.clone();
		let durable = transition.clone();
		let index = self.append(&Event { ts, kind: Kind::InvocationTransition(transition) })?;
		self.invocations.insert(invocation_id, (index, durable));
		Ok(index)
	}

	/// Records one Core-attributed hook outcome in the durable transcript.
	pub fn record_hook_outcome(
		&mut self,
		ts: u64,
		outcome: HookOutcome,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::HookOutcome(outcome) })
	}

	/// Records the requested/effective policy audit sextet for an invocation.
	pub fn record_policy_decision(
		&mut self,
		ts: u64,
		decision: PolicyDecision,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::PolicyDecision(decision) })
	}

	/// Persists a newly filed or merged Core-owned approval ticket.
	pub fn record_approval_ticket(
		&mut self,
		ts: u64,
		ticket: ApprovalTicketFiled,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::ApprovalTicketFiled(ticket) })
	}

	/// Persists an idempotent approval decision or guard-drop withdrawal.
	pub fn record_approval_decision(
		&mut self,
		ts: u64,
		decision: ApprovalDecided,
	) -> Result<u64, JournalError> {
		self.append(&Event { ts, kind: Kind::ApprovalDecided(decision) })
	}

	/// Handles exactly one authenticated single-owner mailbox request.
	pub fn handle_request(&mut self, request: JournalRequest) -> Result<JournalReply, JournalError> {
		let JournalRequest { ts, stamp, author, operation } = request;
		let indexes = match operation {
			JournalOperation::Append(entry) => {
				vec![self.append_custom(ts, entry, &stamp, &author)?]
			},
			JournalOperation::AppendMany(entries) => {
				self.append_custom_many(ts, entries, &stamp, &author)?
			},
			JournalOperation::AppendAtomic(entries) => {
				self.append_custom_atomic(ts, entries, &stamp, &author)?
			},
			JournalOperation::Label { target, label } => {
				vec![self.label(ts, target, label, &stamp, &author)?]
			},
		};
		Ok(JournalReply { indexes })
	}

	/// Appends one declared extension entry and returns its physical event
	/// index.
	pub fn append_custom(
		&mut self,
		ts: u64,
		entry: PendingCustomEntry,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
	) -> Result<u64, JournalError> {
		let mut indexes = self.append_request_atomic(
			ts,
			vec![self.custom_event(ts, entry, author)?],
			JournalOperationName::Append,
			stamp,
			author,
		)?;
		Ok(indexes.remove(0))
	}

	/// Appends a declared-entry group non-transactionally as one writer request.
	///
	/// On a clean partial failure, [`JournalError::Partial`] contains only the
	/// custom entry indexes proven durable; the request-audit index is excluded.
	pub fn append_custom_many(
		&mut self,
		ts: u64,
		entries: Vec<PendingCustomEntry>,
		stamp: &JournalRequestStamp,

		author: &JournalAuthor,
	) -> Result<Vec<u64>, JournalError> {
		self.validate_request(stamp, author)?;
		self.ensure_extension_write_allowed()?;
		let events = entries
			.into_iter()
			.map(|entry| self.custom_event(ts, entry, author))
			.collect::<Result<Vec<_>, _>>()?;
		if let Some(indexes) =
			self.replay(stamp, author, JournalOperationName::AppendMany, &events)?
		{
			return Ok(indexes);
		}
		let expected = self.prepare_append()?;
		let indexes = payload_indexes(expected, events.len());
		let audit = Self::audit_event(ts, stamp, author, JournalOperationName::AppendMany, &indexes);
		let mut staged = Vec::with_capacity(events.len().saturating_add(1));
		staged.push(audit);
		staged.extend(events);
		match self.writer.append_many(&staged) {
			Ok(written) => {
				self.refresh_after_append(expected, staged.len())?;
				debug_assert_eq!(written.len(), staged.len());
				self.remember_replay(stamp, author, JournalOperationName::AppendMany, &indexes);
				Ok(indexes)
			},
			Err(error) => {
				self.finish_many_error(expected, staged.len(), indexes, stamp, author, error)
			},
		}
	}

	/// Queries extension entries with namespace access enforced in Rust.
	pub fn query_custom(
		&self,
		query: &JournalQuery,
	) -> Result<Vec<JournalCustomEntry>, JournalError> {
		if let Some(kind) = &query.kind
			&& !EntryKindRegistry::can_read_core(kind.as_str())
		{
			self.entry_kinds.authorize_read(
				query.caller_extension.as_str(),
				query.granted_extensions.iter().map(Str::as_str),
				kind.as_str(),
			)?;
		}
		let log = self.load()?;
		let mut entries = Vec::new();
		for index in 0..u64::try_from(log.log().len()).expect("journal length fits in u64") {
			if query.live && !log.live().contains(index) {
				continue;
			}
			if query.since.is_some_and(|since| index <= since) {
				continue;
			}
			let Some(transcript::Entry::Ok(event)) = log.log().get(index) else {
				continue;
			};
			let Kind::Custom(custom) = &event.kind else {
				continue;
			};
			if custom.kind().starts_with("omp.state.session.") {
				continue;
			}
			if query
				.kind
				.as_ref()
				.is_some_and(|kind| kind.as_str() != custom.kind())
			{
				continue;
			}
			if query
				.rev
				.as_ref()
				.is_some_and(|rev| Some(rev.as_str()) != custom.rev())
			{
				continue;
			}
			let readable = EntryKindRegistry::can_read_core(custom.kind())
				|| custom.source().is_some_and(|source| {
					source == query.caller_extension.as_str()
						|| query
							.granted_extensions
							.iter()
							.any(|granted| granted == source)
				});
			if !readable {
				continue;
			}
			entries.push(JournalCustomEntry { index, ts: event.ts, entry: custom.clone() });
		}
		if let Some(limit) = query.limit
			&& entries.len() > limit
		{
			entries.drain(..entries.len() - limit);
		}
		Ok(entries)
	}

	/// Appends a declared-entry group atomically.
	///
	/// A replay under the same authenticated extension and idempotency key
	/// returns the first request's recorded indexes without appending.
	pub fn append_custom_atomic(
		&mut self,
		ts: u64,
		entries: Vec<PendingCustomEntry>,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
	) -> Result<Vec<u64>, JournalError> {
		let events = entries
			.into_iter()
			.map(|entry| self.custom_event(ts, entry, author))
			.collect::<Result<Vec<_>, _>>()?;
		self.append_request_atomic(ts, events, JournalOperationName::AppendAtomic, stamp, author)
	}

	/// Appends a label assignment against an addressable earlier event.
	pub fn label(
		&mut self,
		ts: u64,
		target: u64,
		label: Option<Str>,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
	) -> Result<u64, JournalError> {
		self.validate_request(stamp, author)?;
		self.ensure_extension_write_allowed()?;
		{
			let log = self.load()?;
			if target >= u64::try_from(log.log().len()).expect("journal length fits in u64") {
				return Err(JournalError::InvalidTarget(target));
			}
		}

		let mut indexes = self.append_request_atomic(
			ts,
			vec![Event { ts, kind: Kind::Label { target, label } }],
			JournalOperationName::Label,
			stamp,
			author,
		)?;
		Ok(indexes.remove(0))
	}

	/// Appends a SESSION-scoped typed state entry into this canonical journal.
	pub fn append_session_state(
		&mut self,
		ts: u64,
		authority: &omp_storage::state::StateAuthority,
		kind: Str,
		schema_rev: Str,
		data: Box<RawValue>,
		request: &omp_storage::state::DurableRequest,
	) -> Result<u64, JournalError> {
		let (stamp, author) = self.session_state_request(authority, request)?;
		self.append_custom(
			ts,
			PendingCustomEntry {
				kind,
				rev: schema_rev,
				data: Some(data),
				context: None,
				display: None,
			},
			&stamp,
			&author,
		)
	}

	/// Reads SESSION-scoped typed entries through the journal's physical ids,
	/// liveness, revisions, and Rust namespace gate.
	pub fn query_session_state(
		&self,
		authority: &omp_storage::state::StateAuthority,
		kind: Str,
		since: Option<u64>,
		limit: Option<usize>,
		live: bool,
	) -> Result<Vec<JournalCustomEntry>, JournalError> {
		if authority.session_id() != self.session_id.0.as_str() {
			return Err(state::Error::InvalidAuthority.into());
		}
		let owner = self
			.entry_kinds
			.require_declared(kind.as_str())?
			.extension
			.clone();
		if !authority.may_read_namespace(owner.as_str()) {
			return Err(state::Error::NamespaceDenied.into());
		}
		let granted_extensions: Vec<Str> = (owner != authority.namespace())
			.then_some(owner)
			.into_iter()
			.collect();
		self.query_custom(&JournalQuery {
			caller_extension: Str::new(authority.namespace()),
			granted_extensions,
			kind: Some(kind),
			rev: None,
			since,
			limit,
			live,
		})
	}

	/// Atomically installs a SESSION-scoped JSON value when the journal-backed
	/// key's current physical revision equals `expected`.
	pub fn compare_exchange_session_state(
		&mut self,
		ts: u64,
		authority: &omp_storage::state::StateAuthority,
		key: Str,
		expected: Option<StateRevision>,
		value: Box<RawValue>,
		request: &omp_storage::state::DurableRequest,
	) -> Result<SessionStateValue, JournalError> {
		if request.idempotency_key().is_none() {
			return Err(state::Error::MissingIdempotencyKey.into());
		}
		let (stamp, author) = self.session_state_request(authority, request)?;
		let record = SessionCasRecord {
			namespace: Str::new(authority.namespace()),
			key:       key.clone(),
			value:     value.clone(),
		};
		let data = serde_json::value::to_raw_value(&record).map_err(transcript::Error::from)?;
		let custom = Custom::new(
			sf!("omp.state.session.cas"),
			Some(sf!("state.1")),
			Some(Str::new(authority.namespace())),
			author.principal.clone(),
			author.provenance.clone(),
			Some(data),
			None,
			false,
		)
		.map_err(transcript::Error::from)?;
		let events = vec![Event { ts, kind: Kind::Custom(custom) }];
		self.validate_request(&stamp, &author)?;
		self.ensure_extension_write_allowed()?;
		if let Some(indexes) =
			self.replay(&stamp, &author, JournalOperationName::StateCompareExchange, &events)?
		{
			let revision = indexes
				.first()
				.copied()
				.ok_or_else(|| JournalError::IdempotencyConflict(stamp.idempotency_key.clone()))?;
			return Ok(SessionStateValue { revision: StateRevision::new(revision), key, value });
		}
		let actual = self.latest_session_state_value(authority.namespace(), key.as_str())?;
		let actual_revision = actual.as_ref().map(|state| state.revision);
		if actual_revision != expected {
			return Err(state::Error::CasConflict { expected, actual: actual_revision }.into());
		}
		let indexes = self.append_request_atomic(
			ts,
			events,
			JournalOperationName::StateCompareExchange,
			&stamp,
			&author,
		)?;
		let revision = indexes[0];
		let state = SessionStateValue { revision: StateRevision::new(revision), key, value };
		self.publish_session_state(authority.namespace(), &state);
		Ok(state)
	}

	/// Subscribes to newer SESSION-state values for the authenticated
	/// extension's key.
	///
	/// Catch-up is delivered before the subscriber is registered while the sole
	/// journal owner is borrowed, so no commit can race between the two. The
	/// bounded channel reserves one slot for a typed terminal status.
	pub fn subscribe_session_state(
		&mut self,
		authority: &omp_storage::state::StateAuthority,
		key: Str,
		since: Option<StateRevision>,
	) -> Result<Receiver<SessionStateWatchEvent>, JournalError> {
		if authority.session_id() != self.session_id.0.as_str() {
			return Err(state::Error::InvalidAuthority.into());
		}
		if !authority.may_read_namespace(authority.namespace()) {
			return Err(state::Error::NamespaceDenied.into());
		}
		let latest = self.latest_session_state_value(authority.namespace(), key.as_str())?;
		let (sender, receiver) = flume::bounded(2);
		let mut last = since;
		if let Some(value) = latest
			&& since.is_none_or(|revision| value.revision > revision)
		{
			last = Some(value.revision);
			sender
				.try_send(SessionStateWatchEvent::Value(value))
				.expect("new state subscription has capacity");
		}
		let subscriber = self.next_state_subscriber;
		self.next_state_subscriber = self.next_state_subscriber.wrapping_add(1);
		self
			.state_subscribers
			.insert(subscriber, SessionStateSubscriber {
				namespace: Str::new(authority.namespace()),
				key,
				last,
				sender,
			});
		Ok(receiver)
	}

	fn publish_session_state(&mut self, namespace: &str, value: &SessionStateValue) {
		self.state_subscribers.retain(|_, subscriber| {
			if subscriber.sender.is_disconnected() {
				return false;
			}
			if subscriber.namespace != namespace
				|| subscriber.key != value.key
				|| subscriber
					.last
					.is_some_and(|revision| revision >= value.revision)
			{
				return true;
			}
			if !subscriber.sender.is_empty() {
				let _ = subscriber.sender.try_send(SessionStateWatchEvent::Terminal(
					SessionStateWatchTerminal::Lagged { after: subscriber.last },
				));
				return false;
			}
			match subscriber
				.sender
				.try_send(SessionStateWatchEvent::Value(value.clone()))
			{
				Ok(()) => {
					subscriber.last = Some(value.revision);
					true
				},
				Err(flume::TrySendError::Disconnected(_)) => false,
				Err(flume::TrySendError::Full(_)) => {
					let _ = subscriber.sender.try_send(SessionStateWatchEvent::Terminal(
						SessionStateWatchTerminal::Lagged { after: subscriber.last },
					));
					false
				},
			}
		});
	}

	fn halt_session(&mut self) {
		self.halted = true;
		for subscriber in self.state_subscribers.values() {
			let _ = subscriber
				.sender
				.try_send(SessionStateWatchEvent::Terminal(SessionStateWatchTerminal::Closed));
		}
		self.state_subscribers.clear();
		for subscriber in self.replication_subscribers.values() {
			let _ = subscriber
				.sender
				.try_send(ReplicationEvent::Terminal(ReplicationTerminal::Closed));
		}
		self.replication_subscribers.clear();
	}

	/// Returns the authenticated extension's latest live SESSION-scoped value.
	///
	/// Session identity and namespace authority are checked before any journal
	/// read, so CONTROL dispatch never accepts a worker-supplied namespace.
	pub fn latest_session_state(
		&self,
		authority: &omp_storage::state::StateAuthority,
		key: &str,
	) -> Result<Option<SessionStateValue>, JournalError> {
		if authority.session_id() != self.session_id.0.as_str() {
			return Err(state::Error::InvalidAuthority.into());
		}
		if !authority.may_read_namespace(authority.namespace()) {
			return Err(state::Error::NamespaceDenied.into());
		}
		self.latest_session_state_value(authority.namespace(), key)
	}

	/// Returns the latest live SESSION-scoped value for one trusted namespace.
	fn latest_session_state_value(
		&self,
		namespace: &str,
		key: &str,
	) -> Result<Option<SessionStateValue>, JournalError> {
		let log = self.load()?;
		for (index, event) in log.log().custom(log.live(), "omp.state.session.cas").rev() {
			let Kind::Custom(custom) = &event.kind else {
				continue;
			};
			if custom.source() != Some(namespace) {
				continue;
			}
			let Some(data) = custom.data() else {
				return Err(JournalError::CorruptSessionState(index));
			};
			let record = serde_json::from_str::<SessionCasRecord>(data.get())
				.map_err(|_| JournalError::CorruptSessionState(index))?;
			if record.namespace == namespace && record.key == key {
				return Ok(Some(SessionStateValue {
					revision: StateRevision::new(index),
					key:      record.key,
					value:    record.value,
				}));
			}
		}
		Ok(None)
	}

	/// Roots an already-adopted blob from the SESSION journal so reachability is
	/// governed by the same physical history and liveness rules.
	pub fn root_session_state_content(
		&mut self,
		ts: u64,
		authority: &omp_storage::state::StateAuthority,
		reference: BlobRef,
		request: &omp_storage::state::DurableRequest,
	) -> Result<omp_storage::state::ContentRoot, JournalError> {
		if request.idempotency_key().is_none() {
			return Err(state::Error::MissingIdempotencyKey.into());
		}
		let (stamp, author) = self.session_state_request(authority, request)?;
		let record = SessionContentRecord { namespace: Str::new(authority.namespace()), reference };
		let data = serde_json::value::to_raw_value(&record).map_err(transcript::Error::from)?;
		let custom = Custom::new(
			sf!("omp.state.session.content"),
			Some(sf!("state.1")),
			Some(Str::new(authority.namespace())),
			author.principal.clone(),
			author.provenance.clone(),
			Some(data),
			None,
			false,
		)
		.map_err(transcript::Error::from)?;
		let events = vec![Event { ts, kind: Kind::Custom(custom) }];
		self.validate_request(&stamp, &author)?;
		self.ensure_extension_write_allowed()?;
		if let Some(indexes) =
			self.replay(&stamp, &author, JournalOperationName::StateContent, &events)?
		{
			let revision = indexes
				.first()
				.copied()
				.ok_or_else(|| JournalError::IdempotencyConflict(stamp.idempotency_key.clone()))?;
			return Ok(omp_storage::state::ContentRoot {
				revision: StateRevision::new(revision),
				reference,
			});
		}
		let indexes = self.append_request_atomic(
			ts,
			events,
			JournalOperationName::StateContent,
			&stamp,
			&author,
		)?;
		Ok(omp_storage::state::ContentRoot { revision: StateRevision::new(indexes[0]), reference })
	}

	/// Reports whether a blob reference is rooted by a live SESSION journal
	/// entry in a namespace readable by the authenticated authority.
	pub fn session_state_content_is_rooted(
		&self,
		authority: &omp_storage::state::StateAuthority,
		namespace: &str,
		reference: &omp_storage::blob::BlobRef,
	) -> Result<bool, JournalError> {
		if authority.session_id() != self.session_id.0.as_str() {
			return Err(state::Error::InvalidAuthority.into());
		}
		if !authority.may_read_namespace(namespace) {
			return Err(state::Error::NamespaceDenied.into());
		}
		let log = self.load()?;
		for (index, event) in log
			.log()
			.custom(log.live(), "omp.state.session.content")
			.rev()
		{
			let Kind::Custom(custom) = &event.kind else {
				continue;
			};
			if custom.source() != Some(namespace) {
				continue;
			}
			let Some(data) = custom.data() else {
				return Err(JournalError::CorruptSessionState(index));
			};
			let record = serde_json::from_str::<SessionContentRecord>(data.get())
				.map_err(|_| JournalError::CorruptSessionState(index))?;
			if record.namespace == namespace && record.reference == *reference {
				return Ok(true);
			}
		}
		Ok(false)
	}

	fn session_state_request(
		&self,
		authority: &omp_storage::state::StateAuthority,
		request: &omp_storage::state::DurableRequest,
	) -> Result<(JournalRequestStamp, JournalAuthor), JournalError> {
		if authority.session_id() != self.session_id.0.as_str() {
			return Err(state::Error::InvalidAuthority.into());
		}
		let generation = request.generation();
		let stamp = JournalRequestStamp {
			request_id:         Str::new(request.request_id()),
			idempotency_key:    Str::new(
				request
					.idempotency_key()
					.unwrap_or_else(|| request.request_id()),
			),
			host_generation:    generation.host,
			session_generation: generation.session,
		};
		let author = JournalAuthor {
			principal:  authority.principal().clone(),
			provenance: authority.provenance().clone(),
		};
		Ok((stamp, author))
	}

	fn validate_request(
		&self,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
	) -> Result<(), JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		if stamp.host_generation != self.generations.host
			|| stamp.session_generation != self.generations.session
		{
			return Err(JournalError::StaleGeneration {
				expected_host:    self.generations.host,
				expected_session: self.generations.session,
				actual_host:      stamp.host_generation,
				actual_session:   stamp.session_generation,
			});
		}
		if author.provenance.generation() != stamp.host_generation {
			return Err(JournalError::AuthorGenerationMismatch);
		}
		Ok(())
	}

	fn ensure_extension_write_allowed(&self) -> Result<(), JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::WriteWhilePending);
		}
		Ok(())
	}

	fn custom_event(
		&self,
		ts: u64,
		entry: PendingCustomEntry,
		author: &JournalAuthor,
	) -> Result<Event, JournalError> {
		let record = self.entry_kinds.require_declared(entry.kind.as_str())?;
		let live_rev = Str::new(record.rev.to_string());
		if entry.rev != live_rev {
			return Err(JournalError::RevisionMismatch {
				kind:     entry.kind,
				expected: live_rev,
				actual:   entry.rev,
			});
		}
		if record.extension != author.provenance.extension_id() {
			return Err(
				EntryKindError::AccessDenied {
					extension: Str::new(author.provenance.extension_id()),
					kind:      entry.kind,
				}
				.into(),
			);
		}
		if entry.context.is_some() && !record.projects {
			return Err(JournalError::ProjectionNotDeclared(entry.kind));
		}
		let custom = Custom::new(
			entry.kind,
			Some(live_rev),
			Some(record.extension.clone()),
			author.principal.clone(),
			author.provenance.clone(),
			entry.data,
			entry.context,
			entry.display.unwrap_or(record.display),
		)
		.map_err(transcript::Error::from)?;
		Ok(Event { ts, kind: Kind::Custom(custom) })
	}

	fn append_request_atomic(
		&mut self,
		ts: u64,
		events: Vec<Event>,
		operation: JournalOperationName,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
	) -> Result<Vec<u64>, JournalError> {
		self.validate_request(stamp, author)?;
		self.ensure_extension_write_allowed()?;
		if let Some(indexes) = self.replay(stamp, author, operation, &events)? {
			return Ok(indexes);
		}
		let expected = self.prepare_append()?;
		let indexes = payload_indexes(expected, events.len());
		let audit = Self::audit_event(ts, stamp, author, operation, &indexes);
		let mut staged = Vec::with_capacity(events.len().saturating_add(1));
		staged.push(audit);
		staged.extend(events);
		match self.writer.append_atomic(&staged) {
			Ok(written) => {
				self.refresh_after_append(expected, staged.len())?;
				debug_assert_eq!(written.len(), staged.len());
				self.remember_replay(stamp, author, operation, &indexes);
				Ok(indexes)
			},
			Err(WriterError::RolledBack { source }) => {
				self.reader.get_mut().transcript.refresh()?;
				Err(JournalError::Storage(source))
			},
			Err(WriterError::Indeterminate(indeterminate)) => {
				self.halt_session();
				Err(JournalError::JournalIndeterminate(indeterminate))
			},
			Err(WriterError::TooManyEntries { entries, maximum }) => {
				Err(JournalError::AtomicTooLarge { entries, maximum })
			},
		}
	}

	fn audit_event(
		ts: u64,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
		operation: JournalOperationName,
		indexes: &[u64],
	) -> Event {
		Event {
			ts,
			kind: Kind::RequestAudit(RequestAudit {
				request_id:         stamp.request_id.clone(),
				idempotency_key:    stamp.idempotency_key.clone(),
				extension_id:       Str::new(author.provenance.extension_id()),
				host_generation:    stamp.host_generation,
				session_generation: stamp.session_generation,
				operation:          Str::new(operation.to_string()),
				indexes:            indexes.iter().copied().collect(),
			}),
		}
	}

	fn replay(
		&self,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
		operation: JournalOperationName,
		events: &[Event],
	) -> Result<Option<Vec<u64>>, JournalError> {
		let extension = author.provenance.extension_id();
		let operation = operation.to_string();
		if self
			.request_replays
			.keys()
			.any(|(recorded_extension, key, recorded_operation)| {
				recorded_extension == extension
					&& key == stamp.idempotency_key.as_str()
					&& recorded_operation != operation.as_str()
			}) {
			return Err(JournalError::IdempotencyConflict(stamp.idempotency_key.clone()));
		}
		let key = (extension, stamp.idempotency_key.as_str(), operation.as_str());
		let Some(indexes) = self.request_replays.iter().find_map(
			|((recorded_extension, recorded_key, recorded_operation), indexes)| {
				(recorded_extension == key.0 && recorded_key == key.1 && recorded_operation == key.2)
					.then_some(indexes)
			},
		) else {
			return Ok(None);
		};
		if indexes.len() != events.len() {
			return Err(JournalError::IdempotencyConflict(stamp.idempotency_key.clone()));
		}
		let log = self.load()?;
		let mut recorded = Vec::with_capacity(indexes.len());
		for (index, expected) in indexes.iter().zip(events) {
			let Some(transcript::Entry::Ok(actual)) = log.log().get(*index) else {
				return Err(JournalError::IdempotencyConflict(stamp.idempotency_key.clone()));
			};
			if actual.kind != expected.kind {
				return Err(JournalError::IdempotencyConflict(stamp.idempotency_key.clone()));
			}
			recorded.push(*index);
		}
		Ok(Some(recorded))
	}

	fn remember_replay(
		&mut self,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
		operation: JournalOperationName,
		indexes: &[u64],
	) {
		self.request_replays.insert(
			(
				Str::new(author.provenance.extension_id()),
				stamp.idempotency_key.clone(),
				Str::new(operation.to_string()),
			),
			indexes.to_vec(),
		);
	}

	fn finish_many_error(
		&mut self,
		expected: u64,
		staged_count: usize,
		indexes: Vec<u64>,
		stamp: &JournalRequestStamp,
		author: &JournalAuthor,
		error: AppendManyError,
	) -> Result<Vec<u64>, JournalError> {
		match error.source {
			WriterError::Indeterminate(indeterminate) => {
				self.halt_session();
				Err(JournalError::JournalIndeterminate(indeterminate))
			},
			source @ (WriterError::RolledBack { .. } | WriterError::TooManyEntries { .. }) => {
				let written = error.appended.len();
				if written != 0 {
					self.refresh_after_append(expected, written)?;
				} else {
					self.reader.get_mut().transcript.refresh()?;
				}
				let appended = if error.appended.first() == Some(expected) {
					let count = error.appended.len().saturating_sub(1);
					self.remember_replay(stamp, author, JournalOperationName::AppendMany, &indexes);
					IndexRun::from_contiguous(&indexes[..count.min(indexes.len())])
				} else {
					IndexRun::from_contiguous(&[])
				};
				debug_assert!(written <= staged_count);
				Err(JournalError::Partial { appended, source })
			},
		}
	}

	/// Appends one local item optimistically with sequence zero.
	pub fn append_optimistic(
		&mut self,
		ts: u64,
		item: Item,
		prompt_hash: Option<PromptHash>,
	) -> Result<u64, JournalError> {
		self.append_item_record(ts, item, None, prompt_hash)
	}

	/// Persists the structurally marked assistant record of an internally
	/// aborted turn.
	pub(crate) fn append_aborted_assistant(
		&mut self,
		ts: u64,
		turn_id: &str,
		item: Item,
		prompt_hash: Option<PromptHash>,
	) -> Result<u64, JournalError> {
		if !self.starts.contains_key(turn_id) {
			return Err(JournalError::MissingTurnStart(Str::new(turn_id)));
		}
		self.append_item_record(ts, item, Some(Str::new(turn_id)), prompt_hash)
	}

	fn append_item_record(
		&mut self,
		ts: u64,
		mut item: Item,
		turn_id: Option<Str>,
		prompt_hash: Option<PromptHash>,
	) -> Result<u64, JournalError> {
		item.seq = 0;
		project::truncate_item_for_persistence(&mut item);
		let event = Event {
			ts,
			kind: Kind::Item(ItemRecord {
				item,
				turn_id,
				prompt_hash: prompt_hash.map(PromptHash::digest),
			}),
		};
		let Kind::Item(record) = &event.kind else {
			unreachable!("constructed item event");
		};
		let prompt = self
			.session_index
			.is_some()
			.then(|| user_prompt_text(&record.item))
			.flatten();
		let context = self.next_message_position(&record.item)?;
		let appended = self.append_indexed_event(
			ts,
			"item",
			EventProjection::ThreadItem { item: &record.item, prompt: prompt.as_deref(), context },
			&event,
		)?;
		self.item_count = self.item_count.saturating_add(1);
		self.commit_message_position(&record.item, appended.index);
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal {
				event_index: appended.index,
				source,
			});
		}
		Ok(appended.index)
	}

	/// Stages one canonical input under the logical turn that must submit it.
	pub fn append_turn_input(
		&mut self,
		ts: u64,
		turn_id: &str,
		mut item: Item,
		prompt_hash: Option<PromptHash>,
	) -> Result<u64, JournalError> {
		item.seq = 0;
		project::truncate_item_for_persistence(&mut item);
		let turn_id = Str::new(turn_id);
		let event = Event {
			ts,
			kind: Kind::TurnInput(TurnInputItem {
				turn_id: turn_id.clone(),
				item,
				prompt_hash: prompt_hash.map(PromptHash::digest),
			}),
		};
		let Kind::TurnInput(input) = &event.kind else {
			unreachable!("constructed turn-input event");
		};
		let prompt = self
			.session_index
			.is_some()
			.then(|| user_prompt_text(&input.item))
			.flatten();
		let context = self.next_message_position(&input.item)?;
		let appended = self.append_indexed_event(
			ts,
			"turn_input",
			EventProjection::ThreadItem { item: &input.item, prompt: prompt.as_deref(), context },
			&event,
		)?;
		let index = appended.index;
		self.item_count = self.item_count.saturating_add(1);
		self.commit_message_position(&input.item, index);
		if let Some((_, events)) = self
			.pending_inputs
			.iter_mut()
			.find(|(durable_turn_id, _)| durable_turn_id == &turn_id)
		{
			events.push(index);
		} else {
			self.pending_inputs.push_back((turn_id, vec![index]));
		}
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal { event_index: index, source });
		}
		Ok(index)
	}

	/// Atomically replaces the system-prompt head while retaining an ordered
	/// tail.
	///
	/// The intent and hidden stages do not change the live chain. Only the final
	/// commit publishes `[new head, preserved tail]`; reopening the journal
	/// idempotently completes an interrupted materialization.
	pub fn rewrite_prompt_head(
		&mut self,
		ts: u64,
		prompt_hash: PromptHash,
		head: &[Item],
		preserved_tail: &[u64],
	) -> Result<Vec<u64>, JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		{
			let mut reader = self.reader.lock();
			reader.refresh_projection()?;
			for target in preserved_tail {
				if !reader.transcript.live().contains(*target) {
					return Err(JournalError::InvalidTurnInput(*target));
				}
			}
		}
		let intent = PromptRewriteIntent {
			prompt_hash:    prompt_hash.digest(),
			head:           head.to_vec(),
			preserved_tail: preserved_tail.to_vec(),
		};
		let intent_event = self.append(&Event { ts, kind: Kind::PromptRewriteIntent(intent) })?;
		let mut head_events = Vec::with_capacity(head.len());
		for (ordinal, item) in head.iter().enumerate() {
			let stage = PromptRewriteStage {
				intent:  intent_event,
				ordinal: u64::try_from(ordinal).expect("prompt head length fits in u64"),
				item:    item.clone(),
			};
			head_events.push(self.append(&Event { ts, kind: Kind::PromptRewriteStage(stage) })?);
			self.item_count = self.item_count.saturating_add(1);
		}
		self.append(&Event {
			ts,
			kind: Kind::PromptRewriteCommit(PromptRewriteCommit {
				intent:      intent_event,
				head_events: head_events.clone(),
			}),
		})?;
		self.active_prompt = Some((prompt_hash.digest(), head_events.clone()));
		Ok(head_events)
	}

	/// Durably fixes a logical turn before its transport is opened.
	///
	/// Re-recording identical metadata is idempotent. Conflict and `NeedFull`
	/// recovery may supersede only the input envelope and claimed item set; the
	/// logical turn identity and prompt identity remain fixed.
	pub fn start_turn(&mut self, ts: u64, start: TurnStart) -> Result<u64, JournalError> {
		if let Some(receipt) = self.receipts.get(start.turn_id.as_str()) {
			return Ok(receipt.item_events.last().copied().unwrap_or_default());
		}
		if self.aborted.contains_key(start.turn_id.as_str()) {
			return Err(JournalError::TurnAlreadyAborted(start.turn_id));
		}
		if let Some((index, durable)) = self.starts.get(start.turn_id.as_str()) {
			if durable == &start {
				return Ok(*index);
			}
			if durable.prompt_hash != start.prompt_hash
				|| durable.prompt_head_events != start.prompt_head_events
				|| durable.toolset_hash != start.toolset_hash
				|| durable.enabled_tools != start.enabled_tools
			{
				return Err(JournalError::TurnStartMismatch(start.turn_id));
			}
		}

		{
			let log = self.load()?;
			for target in start
				.item_events
				.iter()
				.chain(&start.prompt_head_events)
				.chain(&start.sequence_targets)
			{
				if !matches!(log.log().get(*target), Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some())
				{
					return Err(JournalError::InvalidTurnInput(*target));
				}
			}
		}
		for target in &start.item_events {
			if let Some(turn_id) = self.claims.get(target)
				&& turn_id != &start.turn_id
			{
				return Err(JournalError::ItemAlreadyClaimed {
					target:  *target,
					turn_id: turn_id.clone(),
				});
			}
		}
		if let Some((_, durable)) = self.starts.get(start.turn_id.as_str()) {
			for target in &durable.item_events {
				self.claims.remove(target);
			}
		}
		let index = self.append(&Event { ts, kind: Kind::TurnStart(start.clone()) })?;
		for target in &start.item_events {
			self.claims.insert(*target, start.turn_id.clone());
		}
		self
			.recoverable_settlements
			.retain(|target| !start.item_events.contains(target));
		self
			.released_inputs
			.retain(|target| !start.item_events.contains(target));
		if self.released_inputs.is_empty() {
			self.released_turn_id = None;
		}
		if let Some(position) = self
			.pending_inputs
			.iter()
			.position(|(turn_id, _)| turn_id == &start.turn_id)
		{
			self.pending_inputs.remove(position);
		}
		self.last_start = Some(start.clone());
		self.starts.insert(start.turn_id.clone(), (index, start));
		Ok(index)
	}

	/// Durably settles a started turn that failed without an authoritative
	/// outcome.
	///
	/// The turn's claimed inputs remain transcript content, but crash replay
	/// will never reopen the failed request. Repeated settlement is idempotent.
	pub fn abort_turn(
		&mut self,
		ts: u64,
		turn_id: &str,
		disposition: AbortDisposition,
	) -> Result<u64, JournalError> {
		if let Some((index, durable)) = self.aborted.get(turn_id) {
			if *durable != disposition {
				return Err(JournalError::TurnAbortMismatch(Str::new(turn_id)));
			}
			return Ok(*index);
		}
		let turn_id = Str::new(turn_id);
		if !self.starts.contains_key(turn_id.as_str()) {
			return Err(JournalError::MissingTurnStart(turn_id));
		}
		let index = self.append(&Event {
			ts,
			kind: Kind::TurnAbort(TurnAbort {
				turn_id:     turn_id.clone(),
				recoverable: disposition.recoverable(),
			}),
		})?;
		self.starts.remove(turn_id.as_str());
		self.pending.remove(turn_id.as_str());
		self.claims.retain(|_, claimed| claimed != &turn_id);
		self.aborted.insert(turn_id, (index, disposition));
		Ok(index)
	}

	/// Appends one invisible Core-authored exploration checkpoint marker.
	pub fn checkpoint(
		&mut self,
		ts: u64,
		token: &str,
		goal: &str,
		started_at: u64,
	) -> Result<u64, JournalError> {
		#[derive(Serialize)]
		struct Checkpoint<'a> {
			token:      &'a str,
			goal:       &'a str,
			started_at: u64,
		}

		self.append_core_checkpoint_entry(
			ts,
			token,
			CHECKPOINT_KIND,
			serde_json::value::to_raw_value(&Checkpoint { token, goal, started_at })
				.map_err(transcript::Error::from)?,
		)
	}

	/// Appends the durable replacement summary after an exploration rewind.
	pub fn rewind_report(
		&mut self,
		token: &str,
		goal: &str,
		report: &str,
		started_at: u64,
		rewound_at: u64,
	) -> Result<u64, JournalError> {
		#[derive(Serialize)]
		struct RewindReport<'a> {
			token:      &'a str,
			goal:       &'a str,
			report:     &'a str,
			started_at: u64,
			rewound_at: u64,
		}

		self.append_core_checkpoint_entry(
			rewound_at,
			token,
			REWIND_REPORT_KIND,
			serde_json::value::to_raw_value(&RewindReport {
				token,
				goal,
				report,
				started_at,
				rewound_at,
			})
			.map_err(transcript::Error::from)?,
		)
	}

	fn append_core_checkpoint_entry(
		&mut self,
		ts: u64,
		token: &str,
		kind: &'static str,
		data: Box<RawValue>,
	) -> Result<u64, JournalError> {
		self.declare_entry_kinds(CORE_EXTENSION, core_checkpoint_declarations())?;
		let request_id = sf!("{kind}-{token}");
		let reply = self.handle_request(JournalRequest {
			ts,
			stamp: JournalRequestStamp {
				idempotency_key: request_id.clone(),
				request_id,
				host_generation: self.generations.host,
				session_generation: self.generations.session,
			},
			author: JournalAuthor {
				principal:  Principal::new(sf!("omp.core"), sf!("OMP Core")),
				provenance: Provenance::new(
					sf!("omp"),
					sf!(CORE_EXTENSION),
					sf!(env!("CARGO_PKG_VERSION")),
					ArtifactDigest::new([0; 32]),
					sf!("core"),
					sf!("builtin"),
					0,
				),
			},
			operation: JournalOperation::Append(PendingCustomEntry {
				kind:    sf!(kind),
				rev:     sf!(CORE_REVISION),
				data:    Some(data),
				context: None,
				display: Some(false),
			}),
		})?;
		Ok(*reply
			.indexes
			.first()
			.expect("single core checkpoint append returns one payload index"))
	}

	/// Appends an in-place context reset boundary without changing session
	/// identity or audit history.
	pub fn reset(&mut self, ts: u64) -> Result<u64, JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::TransitionWhilePending);
		}
		let event = Event { ts, kind: Kind::Reset };
		let context = ContextPosition {
			anchor:   None,
			revision: self.context_revision.saturating_add(1),
			epoch:    self.compaction_epoch.saturating_add(1),
		};
		let appended = self.append_indexed_event(
			ts,
			"reset",
			EventProjection::Context {
				anchor:   context.anchor,
				revision: context.revision,
				epoch:    context.epoch,
			},
			&event,
		)?;
		self.context_revision = context.revision;
		self.compaction_epoch = context.epoch;
		self.prompt_anchor = None;
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal {
				event_index: appended.index,
				source,
			});
		}
		Ok(appended.index)
	}

	/// Requests a fresh provider-native session while preserving the canonical
	/// context and session identity.
	pub fn provider_reset(&mut self, ts: u64) -> Result<u64, JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::TransitionWhilePending);
		}
		self.append(&Event { ts, kind: Kind::ProviderReset })
	}

	/// Appends a session-only effective model override.
	///
	/// Durable `/model` preferences stay in settings and must never call this
	/// method. Ctrl-P, role cycling, and `/switch` use it so revival can restore
	/// the effective model without rewriting preferences.
	pub fn model_override(&mut self, ts: u64, model: ModelChange) -> Result<u64, JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::TransitionWhilePending);
		}
		self.append(&Event {
			ts,
			kind: Kind::Infer {
				thinking: Patch::Unchanged,
				model:    Patch::Set(model),
				tier:     Patch::Unchanged,
				cred_pin: Patch::Unchanged,
			},
		})
	}

	/// Appends opaque credential-affinity evidence without account identity.
	pub fn credential_affinity(
		&mut self,
		ts: u64,
		provider: transcript::ProviderId,
		affinity: &omp_inference::session::CredentialAffinityDigest,
	) -> Result<u64, JournalError> {
		self.append(&Event {
			ts,
			kind: Kind::Infer {
				thinking: Patch::Unchanged,
				model:    Patch::Unchanged,
				tier:     Patch::Unchanged,
				cred_pin: Patch::Set(Pin { provider, affinity: Str::new(affinity.as_str()) }),
			},
		})
	}

	/// Restores the latest live session-only model override.
	pub fn effective_model_override(&self) -> Result<Option<ModelChange>, JournalError> {
		let mut reader = self.reader.lock();
		reader.refresh_projection()?;
		Ok(reader
			.transcript
			.live()
			.iter()
			.fold(None, |current, index| match reader.transcript.log().get(index) {
				Some(transcript::Entry::Ok(event)) => match &event.kind {
					Kind::Infer { model: Patch::Set(model), .. } => Some(model.clone()),
					Kind::Infer { model: Patch::Clear, .. } => None,
					_ => current,
				},
				_ => current,
			}))
	}

	/// Restores the latest live opaque credential affinity.
	pub fn effective_credential_affinity(&self) -> Result<Option<Pin>, JournalError> {
		let mut reader = self.reader.lock();
		reader.refresh_projection()?;
		Ok(reader
			.transcript
			.live()
			.iter()
			.fold(None, |current, index| match reader.transcript.log().get(index) {
				Some(transcript::Entry::Ok(event)) => match &event.kind {
					Kind::Infer { cred_pin: Patch::Set(pin), .. } => Some(pin.clone()),
					Kind::Infer { cred_pin: Patch::Clear, .. } => None,
					_ => current,
				},
				_ => current,
			}))
	}

	/// Appends an explicit live-chain truncation to `to`, or to the transcript
	/// root.
	///
	/// Truncation is rejected while a started turn lacks a terminal receipt.
	pub fn truncate_to(&mut self, ts: u64, to: Option<u64>) -> Result<u64, JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::RewindWhilePending);
		}
		self.append(&Event { ts, kind: Kind::Rewind { to } })
	}

	/// Replaces the live context prefix with a durable textual summary.
	///
	/// Like [`Self::truncate_to`], compaction is rejected while a started turn
	/// lacks a terminal receipt, preventing an authorized batch from being
	/// stranded outside the resulting live chain.
	pub fn compact(&mut self, ts: u64, compact: Compact) -> Result<u64, JournalError> {
		if self.pending_turn().is_some() {
			return Err(JournalError::CompactWhilePending);
		}
		let event = Event {
			ts,
			kind: Kind::Compact {
				summary:       compact.summary,
				short:         compact.short,
				first_kept:    compact.first_kept,
				tokens_before: compact.tokens_before,
				tokens_after:  compact.tokens_after,
				method:        compact.method,
				warning:       compact.warning,
				superseded:    compact.superseded,
				snapcompact:   compact.snapcompact,
			},
		};
		let context = ContextPosition {
			anchor:   self.prompt_anchor,
			revision: self.context_revision.saturating_add(1),
			epoch:    self.compaction_epoch.saturating_add(1),
		};
		let appended = self.append_indexed_event(
			ts,
			"compact",
			EventProjection::Context {
				anchor:   context.anchor,
				revision: context.revision,
				epoch:    context.epoch,
			},
			&event,
		)?;
		self.context_revision = context.revision;
		self.compaction_epoch = context.epoch;
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal {
				event_index: appended.index,
				source,
			});
		}
		Ok(appended.index)
	}

	/// Returns the earliest live turn start that lacks a terminal receipt.
	pub fn pending_turn(&self) -> Option<&TurnStart> {
		self
			.starts
			.values()
			.min_by_key(|(index, _)| *index)
			.map(|(_, start)| start)
	}

	/// Returns durable start metadata for one unmatched logical turn.
	pub fn turn_start(&self, turn_id: &str) -> Option<&TurnStart> {
		self.starts.get(turn_id).map(|(_, start)| start)
	}

	/// Clones the canonical items at ordered physical item-event indexes.
	pub fn items_at(&self, targets: &[u64]) -> Result<Vec<Item>, JournalError> {
		let log = self.load()?;
		targets
			.iter()
			.map(|target| match log.log().get(*target) {
				Some(transcript::Entry::Ok(event)) => event_item(&event.kind)
					.cloned()
					.ok_or(JournalError::InvalidTurnInput(*target)),
				_ => Err(JournalError::InvalidTurnInput(*target)),
			})
			.collect()
	}

	/// Renders bounded user text directly from committed physical item ids.
	///
	/// This validates every id through the journal owner and avoids cloning
	/// canonical item/message arrays solely to prepare a proactive recall query.
	pub fn bounded_user_text_at(
		&self,
		targets: &[u64],
		max_chars: usize,
	) -> Result<Str, JournalError> {
		let log = self.load()?;
		let mut text = String::with_capacity(max_chars.min(4096));
		let mut chars = 0_usize;
		for target in targets {
			let item = match log.log().get(*target) {
				Some(transcript::Entry::Ok(event)) => {
					event_item(&event.kind).ok_or(JournalError::InvalidTurnInput(*target))?
				},
				_ => return Err(JournalError::InvalidTurnInput(*target)),
			};
			if chars == max_chars {
				continue;
			}
			let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
				continue;
			};
			if message.role != Role::User as i32 {
				continue;
			}
			for part in &message.parts {
				let Some(part::Kind::Text(value)) = part.kind.as_ref() else {
					continue;
				};
				if !text.is_empty() && chars < max_chars {
					text.push('\n');
					chars = chars.saturating_add(1);
				}
				for character in value.chars().take(max_chars.saturating_sub(chars)) {
					text.push(character);
					chars = chars.saturating_add(1);
				}
				if chars == max_chars {
					break;
				}
			}
		}
		Ok(Str::new(text))
	}

	/// Returns metadata from the most recently opened logical turn.
	pub const fn latest_turn_start(&self) -> Option<&TurnStart> {
		self.last_start.as_ref()
	}

	/// Returns every live canonical item event in projection order.
	pub fn live_item_events(&self) -> Result<Vec<u64>, JournalError> {
		if self.halted {
			return Err(JournalError::Halted);
		}
		let mut reader = self.reader.lock();
		reader.refresh_projection()?;
		Ok(reader
			.transcript
			.live()
			.iter()
			.filter(|index| {
				matches!(reader.transcript.log().get(*index), Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some())
			})
			.collect())
	}

	/// Appends an authoritative arbiter outcome and its terminal receipt.
	///
	/// Prompt identity and head boundaries come from the durable [`TurnStart`],
	/// never from mutable caller state. Replaying an existing receipt succeeds
	/// only when the complete canonical outcome is field-exact; it appends no
	/// duplicate items or receipt.
	pub fn append_arbiter_outcome(
		&mut self,
		ts: u64,
		turn_id: &str,
		mut outcome: Outcome,
	) -> Result<(TurnReceipt, bool), JournalError> {
		for item in &mut outcome.output {
			project::truncate_item_for_persistence(item);
		}
		if let Some(receipt) = self.receipts.get(turn_id) {
			stamp_outcome_context(&mut outcome, self.context_position());
			if receipt.outcome != outcome {
				return Err(JournalError::TurnReplayMismatch(Str::new(turn_id)));
			}
			return Ok((receipt.clone(), true));
		}

		let turn_id = Str::new(turn_id);
		let Some((_, start)) = self.starts.get(turn_id.as_str()).cloned() else {
			return Err(JournalError::MissingTurnStart(turn_id));
		};
		let existing = self
			.pending
			.get(turn_id.as_str())
			.cloned()
			.unwrap_or_default();
		let prompt_hash = Some(start.prompt_hash);
		let mut item_events = Vec::with_capacity(outcome.output.len());
		item_events.extend(existing.iter().map(|(index, ..)| *index));
		let mut replayed = 0_usize;
		let mut mismatch = false;
		for (position, item) in outcome.output.iter().enumerate() {
			replayed = position.saturating_add(1);
			if let Some((_, durable, durable_hash)) = existing.get(position) {
				if durable != item || durable_hash != &prompt_hash {
					mismatch = true;
					break;
				}
				continue;
			}
			let event = Event {
				ts,
				kind: Kind::Item(ItemRecord {
					item: item.clone(),
					turn_id: Some(turn_id.clone()),
					prompt_hash,
				}),
			};
			let Kind::Item(record) = &event.kind else {
				unreachable!("constructed arbiter item event");
			};
			let prompt = self
				.session_index
				.is_some()
				.then(|| user_prompt_text(&record.item))
				.flatten();
			let context = self.next_message_position(&record.item)?;
			let appended = self.append_indexed_event(
				ts,
				"item",
				EventProjection::ThreadItem { item: &record.item, prompt: prompt.as_deref(), context },
				&event,
			)?;
			let index = appended.index;
			item_events.push(index);
			self.item_count = self.item_count.saturating_add(1);
			self.commit_message_position(&record.item, index);
			self
				.pending
				.entry(turn_id.clone())
				.or_default()
				.push((index, item.clone(), prompt_hash));
			if let Some(source) = appended.index_error {
				return Err(JournalError::SessionIndexAfterJournal { event_index: index, source });
			}
		}
		if mismatch || replayed < existing.len() {
			return Err(JournalError::TurnReplayMismatch(turn_id));
		}
		stamp_outcome_context(&mut outcome, self.context_position());
		let receipt = TurnReceipt {
			turn_id: turn_id.clone(),
			prompt_hash: start.prompt_hash,
			prompt_head_events: start.prompt_head_events,
			item_events,
			outcome,
		};

		let receipt_record = Event { ts, kind: Kind::TurnReceipt(receipt.clone()) };
		let appended = self.append_indexed_event(
			ts,
			"turn_receipt",
			EventProjection::TurnReceipt { outcome: &receipt.outcome, failed: false },
			&receipt_record,
		)?;
		let receipt_event = appended.index;
		self.pending.remove(turn_id.as_str());
		self.starts.remove(turn_id.as_str());
		self.claims.retain(|_, claimed| claimed != &turn_id);
		self.last_receipt = Some(receipt.clone());
		self.last_receipt_event = Some(receipt_event);
		self.released_inputs.clear();
		self.released_turn_id = None;
		self.receipts.insert(turn_id, receipt.clone());
		if let Some(source) = appended.index_error {
			return Err(JournalError::SessionIndexAfterJournal { event_index: receipt_event, source });
		}
		Ok((receipt, false))
	}

	/// Appends one invisible regime-resolution fact with no model projection.
	pub fn append_regime_fact(&mut self, ts: u64, fact: &RegimeFact) -> Result<u64, JournalError> {
		self.append_regime_data(
			ts,
			REGIME_FACT_KIND,
			sf!("regime-fact-{}", omp_core::Ulid::generate()),
			serde_json::value::to_raw_value(fact).map_err(transcript::Error::from)?,
		)
	}

	/// Appends one first-class durable regime lifecycle record.
	pub fn append_regime_record(
		&mut self,
		ts: u64,
		record: &RegimeRecord,
	) -> Result<u64, JournalError> {
		self.append_regime_data(
			ts,
			REGIME_RECORD_KIND,
			sf!(
				"regime-record-{}-{}-{}-{}",
				record.activation.as_str(),
				record.committed_steps,
				record.status,
				Hash32::sum(record.state.as_bytes()),
			),
			serde_json::value::to_raw_value(record).map_err(transcript::Error::from)?,
		)
	}

	/// Recovers the latest lifecycle record for every activation.
	pub fn recover_regime_records(&self) -> Result<Vec<RegimeRecord>, JournalError> {
		let log = self.load()?;
		let mut latest = BTreeMap::<Str, RegimeRecord>::new();
		for index in log.live().iter() {
			let Some(transcript::Entry::Ok(event)) = log.log().get(index) else {
				continue;
			};
			let Kind::Custom(custom) = &event.kind else {
				continue;
			};
			if custom.kind() != REGIME_RECORD_KIND {
				continue;
			}
			let Some(data) = custom.data() else {
				continue;
			};
			let Ok(record) = serde_json::from_str::<RegimeRecord>(data.get()) else {
				continue;
			};
			latest.insert(record.activation.clone(), record);
		}
		Ok(latest.into_values().collect())
	}

	/// Returns SETTLE regime facts that prevented stop for `turn_id`.
	pub fn settle_rejections(&self, turn_id: &str) -> Result<Vec<RegimeFact>, JournalError> {
		let log = self.load()?;
		let mut facts = Vec::new();
		for index in log.live().iter() {
			let Some(transcript::Entry::Ok(event)) = log.log().get(index) else {
				continue;
			};
			let Kind::Custom(custom) = &event.kind else {
				continue;
			};
			if custom.kind() != REGIME_FACT_KIND {
				continue;
			}
			let Some(data) = custom.data() else {
				continue;
			};
			let Ok(fact) = serde_json::from_str::<RegimeFact>(data.get()) else {
				continue;
			};
			if fact.point == phase::Point::Settle
				&& fact
					.turn_id
					.as_ref()
					.is_some_and(|candidate| candidate == turn_id)
				&& fact.control != "none"
			{
				facts.push(fact);
			}
		}
		Ok(facts)
	}

	fn append_regime_data(
		&mut self,
		ts: u64,
		kind: &'static str,
		request_id: Str,
		data: Box<RawValue>,
	) -> Result<u64, JournalError> {
		self.declare_entry_kinds(CORE_EXTENSION, core_regime_declarations())?;
		let reply = self.handle_request(JournalRequest {
			ts,
			stamp: JournalRequestStamp {
				idempotency_key: request_id.clone(),
				request_id,
				host_generation: self.generations.host,
				session_generation: self.generations.session,
			},
			author: JournalAuthor {
				principal:  Principal::new(sf!("omp.core"), sf!("OMP Core")),
				provenance: Provenance::new(
					sf!("omp"),
					sf!(CORE_EXTENSION),
					sf!(env!("CARGO_PKG_VERSION")),
					ArtifactDigest::new([0; 32]),
					sf!("core"),
					sf!("builtin"),
					0,
				),
			},
			operation: JournalOperation::Append(PendingCustomEntry {
				kind:    sf!(kind),
				rev:     sf!(CORE_REVISION),
				data:    Some(data),
				context: None,
				display: Some(false),
			}),
		})?;
		Ok(*reply
			.indexes
			.first()
			.expect("single regime fact append returns one payload index"))
	}

	/// Appends one invisible core TTSR injection with its model-context
	/// projection.
	pub fn append_ttsr_injection(
		&mut self,
		ts: u64,
		turn_id: &str,
		source: StreamSource,
		rules: &[Str],
		content: &str,
	) -> Result<u64, JournalError> {
		#[derive(Serialize)]
		struct TtsrInjection<'a> {
			turn_id: &'a str,
			source:  &'static str,
			rules:   &'a [Str],
			content: &'a str,
		}

		self.declare_entry_kinds(CORE_EXTENSION, [core_ttsr_declaration()])?;
		let digest = Hash32::sum(content.as_bytes());
		let request_id = sf!("ttsr-{}-{}", turn_id, digest);
		let reply = self.handle_request(JournalRequest {
			ts,
			stamp: JournalRequestStamp {
				idempotency_key: request_id.clone(),
				request_id,
				host_generation: self.generations.host,
				session_generation: self.generations.session,
			},
			author: JournalAuthor {
				principal:  Principal::new(sf!("omp.core"), sf!("OMP Core")),
				provenance: Provenance::new(
					sf!("omp"),
					sf!(CORE_EXTENSION),
					sf!(env!("CARGO_PKG_VERSION")),
					ArtifactDigest::new([0; 32]),
					sf!("core"),
					sf!("builtin"),
					0,
				),
			},
			operation: JournalOperation::Append(PendingCustomEntry {
				kind:    sf!(TTSR_INJECTION_KIND),
				rev:     sf!(CORE_REVISION),
				data:    Some(
					serde_json::value::to_raw_value(&TtsrInjection {
						turn_id,
						source: <&'static str>::from(source),
						rules,
						content,
					})
					.map_err(transcript::Error::from)?,
				),
				context: None,
				display: Some(false),
			}),
		})?;
		Ok(*reply
			.indexes
			.first()
			.expect("single TTSR injection append returns one payload index"))
	}

	/// Durably authorizes one committed tool batch before any effect may start.
	pub fn authorize_tool_batch(
		&mut self,
		ts: u64,
		turn_id: &str,
		call_ids: &[Str],
	) -> Result<u64, JournalError> {
		if let Some((index, durable)) = self.authorized_batches.get(turn_id) {
			if durable == call_ids {
				return Ok(*index);
			}
			return Err(JournalError::ToolBatchReplayMismatch(Str::new(turn_id)));
		}
		let Some(receipt) = self.receipts.get(turn_id) else {
			return Err(JournalError::ToolBatchWithoutReceipt(Str::new(turn_id)));
		};
		for call_id in call_ids {
			let present = receipt.outcome.output.iter().any(|item| {
				matches!(
					item.kind.as_ref(),
					Some(omp_proto::thread::v1::item::Kind::ToolCall(call))
						if call.id == call_id.as_str()
				)
			});
			if !present {
				return Err(JournalError::UnknownReceiptCall {
					turn_id: Str::new(turn_id),
					call_id: call_id.clone(),
				});
			}
		}
		let batch = ToolBatchAuthorized { turn_id: Str::new(turn_id), call_ids: call_ids.to_vec() };
		let index = self.append(&Event { ts, kind: Kind::ToolBatchAuthorized(batch.clone()) })?;
		self
			.authorized_batches
			.insert(batch.turn_id, (index, batch.call_ids));
		Ok(index)
	}

	/// Durably registers detached work for restart-safe settlement watching.
	///
	/// Re-registering the exact same job is idempotent. A job already settled
	/// remains terminal and is not made pending again.
	pub fn register_job(&mut self, ts: u64, job: JobRef) -> Result<u64, JournalError> {
		if let Some((index, _)) = self.settled_jobs.get(job.id.as_str()) {
			return Ok(*index);
		}
		if let Some((index, durable)) = self.pending_jobs.get(job.id.as_str()) {
			if durable != &job {
				return Err(JournalError::JobReplayMismatch(job.id));
			}
			return Ok(*index);
		}
		let index = self
			.append(&Event { ts, kind: Kind::JobRegistered(JobRegistered { job: job.clone() }) })?;
		self.pending_jobs.insert(job.id.clone(), (index, job));
		Ok(index)
	}

	/// Durably records one canonical detached-job settlement.
	///
	/// Duplicate identical settlements are idempotent; differing duplicates are
	/// rejected without appending another line.
	pub fn settle_job(
		&mut self,
		ts: u64,
		job_id: &str,
		settlement: Item,
	) -> Result<u64, JournalError> {
		if let Some((index, durable)) = self.settled_jobs.get(job_id) {
			if durable != &settlement {
				return Err(JournalError::JobReplayMismatch(Str::new(job_id)));
			}
			return Ok(*index);
		}
		let job_id = Str::new(job_id);
		let index = self.append(&Event {
			ts,
			kind: Kind::JobSettled(JobSettled {
				job_id:     job_id.clone(),
				settlement: settlement.clone(),
			}),
		})?;
		self.item_count = self.item_count.saturating_add(1);
		self.pending_jobs.remove(job_id.as_str());
		self.settled_jobs.insert(job_id, (index, settlement));
		self.recoverable_settlements.push(index);
		Ok(index)
	}

	/// Returns unclaimed durable input events, including inputs released by an
	/// aborted turn during crash replay.
	pub fn recoverable_input_events(&self) -> &[u64] {
		if self.released_inputs.is_empty() {
			self
				.pending_inputs
				.front()
				.map_or(&[], |(_, events)| events.as_slice())
		} else {
			&self.released_inputs
		}
	}

	/// Returns input events released from trailing aborted turns.
	pub(crate) fn released_input_events(&self) -> &[u64] {
		&self.released_inputs
	}

	/// Returns unclaimed durable detached-job settlement event IDs.
	pub fn recoverable_settlement_events(&self) -> &[u64] {
		&self.recoverable_settlements
	}

	/// Returns the earliest staged input whose turn transport never opened.
	///
	/// Inputs released by an aborted turn remain startup-visible under a fresh
	/// logical turn identity when no later staged submission exists.
	pub fn pending_input_submission(&self) -> Option<(&Str, &[u64])> {
		self
			.pending_inputs
			.front()
			.map(|(turn_id, events)| (turn_id, events.as_slice()))
			.or_else(|| {
				self
					.released_turn_id
					.as_ref()
					.map(|turn_id| (turn_id, self.released_inputs.as_slice()))
			})
	}

	/// Returns whether a startup-visible submission is reclaimed from an aborted
	/// turn.
	pub(crate) fn is_released_submission(&self, turn_id: &str) -> bool {
		self
			.released_turn_id
			.as_ref()
			.is_some_and(|released| released.as_str() == turn_id)
	}

	/// Iterates detached jobs still awaiting settlement without allocating.
	pub fn pending_jobs(&self) -> impl Iterator<Item = &JobRef> {
		self.pending_jobs.values().map(|(_, job)| job)
	}

	/// Appends a later event assigning a arbiter sequence to an item event.
	pub fn amend_seq(&mut self, ts: u64, target: u64, seq: u64) -> Result<u64, JournalError> {
		if seq == 0 {
			return Err(JournalError::ZeroSequence);
		}
		{
			let log = self.load()?;
			if !matches!(log.log().get(target), Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some())
			{
				return Err(JournalError::InvalidItemTarget(target));
			}
		}
		self.append(&Event { ts, kind: Kind::Amend { target, patch: AmendPatch::Seq { seq } } })
	}

	/// Returns whether a turn has a terminal durable receipt.
	pub fn contains_turn(&self, turn_id: &str) -> bool {
		self.receipts.contains_key(turn_id)
	}

	/// Returns the authoritative committed prompt identity and head event IDs.
	pub fn active_prompt(&self) -> Option<(Hash32, &[u64])> {
		self
			.active_prompt
			.as_ref()
			.map(|(hash, events)| (*hash, events.as_slice()))
	}

	/// Returns the most recently appended terminal receipt in physical order.
	pub const fn latest_receipt(&self) -> Option<&TurnReceipt> {
		self.last_receipt.as_ref()
	}

	/// Returns the durable terminal receipt for one logical turn.
	pub fn receipt(&self, turn_id: &str) -> Option<&TurnReceipt> {
		self.receipts.get(turn_id)
	}

	/// Returns whether a failed turn identity has a durable abort settlement.
	pub fn is_turn_aborted(&self, turn_id: &str) -> bool {
		self.aborted.contains_key(turn_id)
	}

	/// Returns the number of recoverable failed-turn settlements in the current
	/// recovery epoch.
	///
	/// A successful receipt or a non-recoverable abort fences older failures so
	/// a later caller-authored submission starts with a fresh retry cap.
	pub fn trailing_aborts(&self) -> u32 {
		let boundary = self
			.aborted
			.values()
			.filter_map(|(index, disposition)| {
				(*disposition == AbortDisposition::Exhausted).then_some(*index)
			})
			.chain(self.last_receipt_event)
			.max();
		u32::try_from(
			self
				.aborted
				.values()
				.filter(|(index, disposition)| {
					*disposition == AbortDisposition::Continue
						&& boundary.is_none_or(|fence| *index > fence)
				})
				.count(),
		)
		.unwrap_or(u32::MAX)
	}

	/// Returns the number of canonical item events observed by this writer.
	pub const fn item_count(&self) -> u64 {
		self.item_count
	}
}

#[derive(Serialize)]
struct ReplicationOmission {
	ts:  u64,
	k:   &'static str,
	rev: &'static str,
}

fn replication_visibility(kind: &Kind) -> ReplicationVisibility {
	match kind {
		Kind::Msg(_)
		| Kind::Item(_)
		| Kind::Rewind { .. }
		| Kind::Compact { .. }
		| Kind::Branch { .. }
		| Kind::Reset
		| Kind::ProviderReset
		| Kind::Title { .. }
		| Kind::ForkedFrom { .. }
		| Kind::Aborted { .. }
		| Kind::Amend { .. }
		| Kind::TurnInput(_)
		| Kind::JobSettled(_)
		| Kind::TurnReceipt(_)
		| Kind::Label { .. } => ReplicationVisibility::PublicTranscript,
		Kind::Infer { cred_pin, .. } if cred_pin.is_unchanged() => {
			ReplicationVisibility::PublicTranscript
		},
		Kind::Custom(custom) if custom.kind() == "collab-prompt" && custom.display() => {
			ReplicationVisibility::PublicTranscript
		},
		_ => ReplicationVisibility::HostLocalOmitted,
	}
}

fn replication_record(
	index: u64,
	event: Option<&Event>,
) -> Result<ReplicationRecord, transcript::Error> {
	let revision = index.saturating_add(1);
	let visibility = event
		.map_or(ReplicationVisibility::HostLocalOmitted, |event| replication_visibility(&event.kind));
	let json = match (visibility, event) {
		(ReplicationVisibility::PublicTranscript, Some(event)) => {
			let mut json = Vec::new();
			transcript::write_line(event, &mut json)?;
			Bytes::from(json)
		},
		_ => Bytes::from(serde_json::to_vec(&ReplicationOmission {
			ts:  event.map_or(0, |event| event.ts),
			k:   "collab_omitted",
			rev: "host_local.v1",
		})?),
	};
	Ok(ReplicationRecord { revision, visibility, json })
}

impl Drop for Journal {
	fn drop(&mut self) {
		for subscriber in self.state_subscribers.values() {
			let _ = subscriber
				.sender
				.try_send(SessionStateWatchEvent::Terminal(SessionStateWatchTerminal::Closed));
		}
		for subscriber in self.replication_subscribers.values() {
			let _ = subscriber
				.sender
				.try_send(ReplicationEvent::Terminal(ReplicationTerminal::Closed));
		}
	}
}

fn payload_indexes(audit_index: u64, count: usize) -> Vec<u64> {
	(0..count)
		.map(|offset| {
			audit_index
				.saturating_add(1)
				.saturating_add(u64::try_from(offset).expect("journal request count fits in u64"))
		})
		.collect()
}

fn recover_tool_batches(log: &Log, writer: &mut Writer) -> Result<Vec<(Str, u64)>, JournalError> {
	struct ReceiptRecovery<'a> {
		ts:            u64,
		receipt:       &'a TurnReceipt,
		settled:       BTreeSet<usize>,
		recovery_turn: Option<Str>,
	}

	let mut authorized = BTreeMap::<Str, BTreeSet<Str>>::new();
	let mut receipts = Vec::<ReceiptRecovery<'_>>::new();
	for index in 0..u64::try_from(log.len()).expect("transcript length fits in u64") {
		let Some(transcript::Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::ToolBatchAuthorized(batch) => {
				authorized.insert(batch.turn_id.clone(), batch.call_ids.iter().cloned().collect());
			},
			Kind::TurnReceipt(receipt)
				if receipt
					.outcome
					.output
					.iter()
					.any(|item| matches!(item.kind, Some(item::Kind::ToolCall(_)))) =>
			{
				receipts.push(ReceiptRecovery {
					ts: event.ts,
					receipt,
					settled: BTreeSet::new(),
					recovery_turn: None,
				});
			},
			kind => {
				let Some(item) = event_item(kind) else {
					continue;
				};
				let Some(item::Kind::ToolResult(result)) = item.kind.as_ref() else {
					continue;
				};
				let recovery_turn = match kind {
					Kind::TurnInput(input) => Some(input.turn_id.clone()),
					_ => None,
				};
				for state in receipts.iter_mut().rev() {
					let occurrence = state
						.receipt
						.outcome
						.output
						.iter()
						.enumerate()
						.find(|(position, item)| {
							!state.settled.contains(position)
								&& matches!(
									item.kind.as_ref(),
									Some(item::Kind::ToolCall(call))
										if call.id == result.call_id
								)
						})
						.map(|(position, _)| position);
					if let Some(position) = occurrence {
						state.settled.insert(position);
						if state.recovery_turn.is_none() {
							state.recovery_turn = recovery_turn;
						}
						break;
					}
				}
			},
		}
	}

	let mut recovered = Vec::new();
	for mut state in receipts {
		let authorized_calls = authorized.get(state.receipt.turn_id.as_str());
		for (position, item) in state.receipt.outcome.output.iter().enumerate() {
			let Some(item::Kind::ToolCall(call)) = item.kind.as_ref() else {
				continue;
			};
			if state.settled.contains(&position) {
				continue;
			}
			let call_id = Str::new(call.id.as_str());
			let abort = if authorized_calls.is_some_and(|calls| calls.contains(&call_id)) {
				Abort::EffectsUnknown { reason: sf!("agent restarted after invocation authorization") }
			} else {
				Abort::Skipped { reason: sf!("agent restarted before invocation authorization") }
			};
			let result = project::recovery_tool_result_item(state.ts, item, abort)?;
			let recovery_turn = state
				.recovery_turn
				.get_or_insert_with(|| Str::new(omp_core::Ulid::generate().to_string()));
			let index = writer.append(&Event {
				ts:   state.ts,
				kind: Kind::TurnInput(TurnInputItem {
					turn_id:     recovery_turn.clone(),
					item:        result,
					prompt_hash: Some(state.receipt.prompt_hash),
				}),
			})?;
			recovered.push((recovery_turn.clone(), index));
		}
	}
	Ok(recovered)
}
struct SequenceRecovery {
	ts:         u64,
	receipt:    TurnReceipt,
	start:      TurnStart,
	amendments: BTreeMap<u64, u64>,
}

fn recover_sequence_amendments(log: &Log, writer: &mut Writer) -> Result<(), JournalError> {
	let mut starts = BTreeMap::new();
	let mut recoveries = Vec::<SequenceRecovery>::new();
	let mut active = None;
	for index in 0..u64::try_from(log.len()).expect("transcript length fits in u64") {
		let Some(transcript::Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::TurnStart(start) => {
				starts.insert(start.turn_id.clone(), start.clone());
				active = None;
			},
			Kind::TurnReceipt(receipt) => {
				let Some(start) = starts.get(receipt.turn_id.as_str()).cloned() else {
					return Err(JournalError::MissingTurnStart(receipt.turn_id.clone()));
				};
				recoveries.push(SequenceRecovery {
					ts: event.ts,
					receipt: receipt.clone(),
					start,
					amendments: BTreeMap::new(),
				});
				active = Some(recoveries.len() - 1);
			},
			Kind::Amend { target, patch: AmendPatch::Seq { seq } } => {
				if let Some(recovery) = active.and_then(|position| recoveries.get_mut(position))
					&& recovery.start.sequence_targets.contains(target)
				{
					recovery.amendments.insert(*target, *seq);
				}
			},
			_ => {},
		}
	}
	for recovery in recoveries {
		let Some(revision) = recovery.receipt.outcome.revision.as_ref() else {
			continue;
		};
		let input_len = u64::try_from(recovery.start.sequence_targets.len())
			.map_err(|_| JournalError::InvalidSequenceRange(recovery.receipt.turn_id.clone()))?;
		let output_len = u64::try_from(recovery.receipt.outcome.output.len())
			.map_err(|_| JournalError::InvalidSequenceRange(recovery.receipt.turn_id.clone()))?;
		let first_input = revision
			.head
			.checked_sub(output_len)
			.and_then(|head| head.checked_add(1))
			.and_then(|first_output| first_output.checked_sub(input_len))
			.ok_or_else(|| JournalError::InvalidSequenceRange(recovery.receipt.turn_id.clone()))?;
		for (offset, target) in recovery.start.sequence_targets.iter().enumerate() {
			if !matches!(
				log.get(*target),
				Some(omp_storage::transcript::Entry::Ok(event)) if event_item(&event.kind).is_some()
			) {
				return Err(JournalError::InvalidTurnInput(*target));
			}
			let expected = first_input
				.checked_add(u64::try_from(offset).expect("sequence target length fits in u64"))
				.ok_or_else(|| JournalError::InvalidSequenceRange(recovery.receipt.turn_id.clone()))?;
			if let Some(actual) = recovery.amendments.get(target) {
				if *actual != expected {
					return Err(JournalError::SequenceReplayMismatch {
						target: *target,
						actual: *actual,
						expected,
					});
				}
				continue;
			}
			writer.append(&Event {
				ts:   recovery.ts,
				kind: Kind::Amend { target: *target, patch: AmendPatch::Seq { seq: expected } },
			})?;
		}
	}
	Ok(())
}
struct RewriteRecovery {
	ts:        u64,
	intent:    PromptRewriteIntent,
	stages:    Vec<Option<u64>>,
	committed: bool,
}

fn recover_prompt_rewrites(
	log: &Log,
	writer: &mut Writer,
) -> Result<(u64, Option<ActivePrompt>), JournalError> {
	let mut rewrites = BTreeMap::<u64, RewriteRecovery>::new();
	for index in 0..u64::try_from(log.len()).expect("transcript length fits in u64") {
		let Some(transcript::Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::PromptRewriteIntent(intent) => {
				rewrites.insert(index, RewriteRecovery {
					ts:        event.ts,
					intent:    intent.clone(),
					stages:    vec![None; intent.head.len()],
					committed: false,
				});
			},
			Kind::PromptRewriteStage(stage) => {
				let Some(rewrite) = rewrites.get_mut(&stage.intent) else {
					return Err(JournalError::CorruptPromptRewrite(stage.intent));
				};
				let ordinal = usize::try_from(stage.ordinal)
					.map_err(|_| JournalError::CorruptPromptRewrite(stage.intent))?;
				let Some(expected) = rewrite.intent.head.get(ordinal) else {
					return Err(JournalError::CorruptPromptRewrite(stage.intent));
				};
				if expected != &stage.item || rewrite.stages[ordinal].replace(index).is_some() {
					return Err(JournalError::CorruptPromptRewrite(stage.intent));
				}
			},
			Kind::PromptRewriteCommit(commit) => {
				let Some(rewrite) = rewrites.get_mut(&commit.intent) else {
					return Err(JournalError::CorruptPromptRewrite(commit.intent));
				};
				let complete = rewrite
					.stages
					.iter()
					.copied()
					.collect::<Option<Vec<_>>>()
					.is_some_and(|stages| stages == commit.head_events);
				if !complete || rewrite.committed {
					return Err(JournalError::CorruptPromptRewrite(commit.intent));
				}
				rewrite.committed = true;
			},
			_ => {},
		}
	}

	let mut recovered_items = 0_u64;
	let mut active_prompt = None;
	for (intent_event, rewrite) in &mut rewrites {
		if !rewrite.committed {
			for (ordinal, stage_event) in rewrite.stages.iter_mut().enumerate() {
				if stage_event.is_some() {
					continue;
				}
				let index = writer.append(&Event {
					ts:   rewrite.ts,
					kind: Kind::PromptRewriteStage(PromptRewriteStage {
						intent:  *intent_event,
						ordinal: u64::try_from(ordinal).expect("prompt head length fits in u64"),
						item:    rewrite.intent.head[ordinal].clone(),
					}),
				})?;
				*stage_event = Some(index);
				recovered_items = recovered_items.saturating_add(1);
			}
		}
		let head_events = rewrite
			.stages
			.iter()
			.copied()
			.collect::<Option<Vec<_>>>()
			.expect("committed or recovered prompt stages are complete");
		if !rewrite.committed {
			writer.append(&Event {
				ts:   rewrite.ts,
				kind: Kind::PromptRewriteCommit(PromptRewriteCommit {
					intent:      *intent_event,
					head_events: head_events.clone(),
				}),
			})?;
		}
		active_prompt = Some((rewrite.intent.prompt_hash, head_events));
	}
	Ok((recovered_items, active_prompt))
}

fn refresh_invariant(message: &'static str) -> JournalError {
	JournalError::Storage(transcript::Error::Io(io::Error::new(io::ErrorKind::InvalidData, message)))
}

fn stamp_outcome_context(outcome: &mut Outcome, context: ContextPosition) {
	let Some(snapshot) = outcome.context_snapshot.as_mut() else {
		return;
	};
	snapshot.prompt_anchor = context.anchor;
	snapshot.context_revision = Some(context.revision);
	snapshot.compaction_epoch = Some(context.epoch);
}

fn advance_message_position(
	item: &Item,
	event_index: u64,
	revision: &mut u64,
	prompt_anchor: &mut Option<u64>,
) {
	let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
		return;
	};
	*revision = revision.saturating_add(1);
	if message.role == Role::User as i32 {
		*prompt_anchor = Some(event_index);
	}
}

fn user_prompt_text(item: &Item) -> Option<String> {
	let item::Kind::Message(message) = item.kind.as_ref()? else {
		return None;
	};
	if message.role != Role::User as i32 {
		return None;
	}
	let mut prompt = String::new();
	for value in message
		.parts
		.iter()
		.filter_map(|part| match part.kind.as_ref() {
			Some(part::Kind::Text(value)) => Some(value.as_str()),
			_ => None,
		}) {
		if !prompt.is_empty() {
			prompt.push('\n');
		}
		prompt.push_str(value);
	}
	(!prompt.is_empty()).then_some(prompt)
}

const fn event_item(kind: &Kind) -> Option<&Item> {
	match kind {
		Kind::Item(record) => Some(&record.item),
		Kind::TurnInput(input) => Some(&input.item),
		Kind::PromptRewriteStage(stage) => Some(&stage.item),
		Kind::JobSettled(settled) => Some(&settled.settlement),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env, fs,
		fs::OpenOptions,
		io::{self, Write as _},
		sync::atomic::{AtomicU64, Ordering},
	};

	use omp_proto::{
		inference::v1 as pb,
		prost::Message as _,
		thread::v1::{self as thread_pb, item as thread_item, part as thread_part},
	};
	use omp_storage::transcript::{Entry, Header, SessionId};
	use omp_tool::{ArtifactLifetime, ExpectedArtifact, JobOwner};

	use super::*;
	use crate::{PromptHash, project::recovery_tool_result_item, project_journal};

	static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

	fn path(name: &str) -> PathBuf {
		env::temp_dir().join(format!(
			"omp-agent-journal-{name}-{}-{}.jsonl",
			std::process::id(),
			NEXT_PATH.fetch_add(1, Ordering::Relaxed)
		))
	}

	fn header() -> Header {
		Header {
			v:       4,
			id:      SessionId(sf!("journal-test")),
			created: 1,
			cwd:     env::temp_dir(),
		}
	}

	fn message(text: &str) -> Item {
		Item {
			kind: Some(thread_item::Kind::Message(thread_pb::Message {
				role:  Role::User as i32,
				parts: vec![thread_pb::Part { kind: Some(thread_part::Kind::Text(text.to_owned())) }],
			})),
			..Default::default()
		}
	}
	#[test]
	fn materialized_header_indexes_first_turn_input() {
		let journal_path = path("materialized-header");
		let index_path = journal_path.with_extension("sqlite3");
		let header = header();
		let session_id = header.id.clone();
		let index = Arc::new(SessionIndex::open(&index_path).expect("session index"));
		let cwd = header.cwd.to_string_lossy();
		let request = omp_storage::index::NewSession {
			id:         &session_id,
			cwd:        cwd.as_ref(),
			project:    cwd.as_ref(),
			created_ms: header.created,
			kind:       omp_storage::index::SessionKind::Interactive,
			parent:     None,
			remote:     false,
		};
		index
			.create_session(&request, || {
				let mut bytes = serde_json::to_vec(&header).map_err(io::Error::other)?;
				bytes.push(b'\n');
				fs::write(&journal_path, bytes)?;
				Ok::<_, io::Error>(((), 0))
			})
			.unwrap_or_else(|_| panic!("create indexed session"));
		let mut journal = Journal::open(&journal_path).expect("open materialized journal");
		journal.attach_session_index(index, session_id);
		let result = journal.append_turn_input(2, "turn", message("input"), None);
		assert!(result.is_ok(), "{result:?}");
	}

	#[test]
	fn reset_fresh_and_child_lineage_round_trip() {
		let parent_path = path("lifecycle-parent");
		let mut parent = Journal::create(&parent_path, &header()).expect("create parent");
		parent
			.append_optimistic(2, message("before"), None)
			.expect("append item");
		parent.provider_reset(3).expect("provider reset");
		parent.reset(4).expect("reset");
		parent
			.append_optimistic(5, message("after"), None)
			.expect("append live item");

		let branch_path = path("lifecycle-branch");
		let mut branch_header = header();
		branch_header.id = SessionId(sf!("branch-child"));
		let branch = parent
			.create_child(&branch_path, &branch_header, 6, ChildKind::Branch { checkpoint: 0 })
			.expect("create branch");
		assert_eq!(
			branch
				.items_at(&branch.live_item_events().expect("branch events"))
				.expect("branch items"),
			vec![message("before")]
		);

		let fork_path = path("lifecycle-fork");
		let mut fork_header = header();
		fork_header.id = SessionId(sf!("fork-child"));
		let fork = parent
			.create_child(&fork_path, &fork_header, 7, ChildKind::Fork)
			.expect("create fork");
		assert_eq!(
			fork
				.items_at(&fork.live_item_events().expect("fork events"))
				.expect("fork items"),
			vec![message("after")]
		);

		drop((parent, branch, fork));
		let log = transcript::load(&parent_path).expect("reload parent");
		assert!(matches!(log.get(1), Some(Entry::Ok(event)) if event.kind == Kind::ProviderReset));
		assert!(matches!(log.get(2), Some(Entry::Ok(event)) if event.kind == Kind::Reset));
		for path in [parent_path, branch_path, fork_path] {
			fs::remove_file(path).expect("remove journal");
		}
	}

	#[test]
	fn branch_materializes_checkpoint_context_after_rewind_reset_and_compact() {
		let parent_path = path("branch-checkpoint-parent");
		let mut parent = Journal::create(&parent_path, &header()).expect("create parent");
		let first = parent
			.append_optimistic(2, message("first"), None)
			.expect("append first");
		parent
			.append_optimistic(3, message("discarded by rewind"), None)
			.expect("append discarded item");
		parent.truncate_to(4, Some(first)).expect("rewind to first");
		let after_rewind = parent
			.append_optimistic(5, message("after rewind"), None)
			.expect("append after rewind");

		let rewind_branch_path = path("branch-checkpoint-rewind");
		let mut rewind_header = header();
		rewind_header.id = SessionId(sf!("branch-rewind"));
		let rewind_branch = parent
			.create_child(&rewind_branch_path, &rewind_header, 6, ChildKind::Branch {
				checkpoint: after_rewind,
			})
			.expect("branch after rewind");
		assert_eq!(
			rewind_branch
				.items_at(
					&rewind_branch
						.live_item_events()
						.expect("rewind branch events")
				)
				.expect("rewind branch items"),
			vec![message("first"), message("after rewind")]
		);

		parent.reset(7).expect("reset context");
		let kept = parent
			.append_optimistic(8, message("kept after reset"), None)
			.expect("append compact suffix");
		parent
			.compact(9, Compact {
				summary:       sf!("summary after reset"),
				short:         None,
				first_kept:    kept,
				tokens_before: 50,
				tokens_after:  Some(10),
				method:        Some(sf!("remote")),
				warning:       None,
				snapcompact:   None,
				superseded:    Vec::new(),
			})
			.expect("compact reset context");
		let checkpoint = parent
			.append_optimistic(10, message("after compact"), None)
			.expect("append after compact");

		let compact_branch_path = path("branch-checkpoint-compact");
		let mut compact_header = header();
		compact_header.id = SessionId(sf!("branch-compact"));
		let compact_branch = parent
			.create_child(&compact_branch_path, &compact_header, 11, ChildKind::Branch { checkpoint })
			.expect("branch after compact");
		let compact_items = compact_branch
			.items_at(
				&compact_branch
					.live_item_events()
					.expect("compact branch events"),
			)
			.expect("compact branch items");
		assert_eq!(compact_items.len(), 3);
		assert!(matches!(
			&compact_items[0].kind,
			Some(thread_item::Kind::Message(message))
				if matches!(
					message.parts.as_slice(),
					[thread_pb::Part { kind: Some(thread_part::Kind::Text(text)) }]
						if text.contains("summary after reset")
				)
		));
		assert_eq!(compact_items[1], message("kept after reset"));
		assert_eq!(compact_items[2], message("after compact"));

		drop((parent, rewind_branch, compact_branch));
		for path in [parent_path, rewind_branch_path, compact_branch_path] {
			fs::remove_file(path).expect("remove journal");
		}
	}

	#[test]
	fn workspace_root_mutations_fold_and_replay_without_removing_primary() {
		let path = path("workspace-roots");
		let primary = PathBuf::from("/workspace");
		let secondary_a = PathBuf::from("/workspace-a");
		let secondary_b = PathBuf::from("/workspace-b");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		journal
			.append_workspace_dirs(2, vec![
				secondary_a.clone(),
				primary.clone(),
				secondary_b.clone(),
				secondary_a.clone(),
			])
			.expect("append roots");
		journal
			.remove_workspace_dirs(3, vec![primary.clone(), secondary_a.clone()])
			.expect("remove roots");

		assert_eq!(journal.workspace_roots(&primary).expect("project roots"), WorkspaceRoots {
			primary:   primary.clone(),
			secondary: vec![secondary_b.clone()].into(),
		});

		drop(journal);
		let reopened = Journal::open(&path).expect("reopen root journal");
		assert_eq!(
			reopened
				.workspace_roots(&primary)
				.expect("replay roots")
				.secondary(),
			[secondary_b]
		);
		let _ = fs::remove_file(path);
	}

	fn outcome() -> Outcome {
		Outcome {
			output: vec![Item {
				seq:           3,
				created_at_ms: 9,
				kind:          Some(thread_item::Kind::Message(thread_pb::Message {
					role:  Role::Assistant as i32,
					parts: vec![thread_pb::Part {
						kind: Some(thread_part::Kind::Text("answer".to_owned())),
					}],
				})),
				props:         None,
			}],
			stop: pb::StopReason::StopEndTurn as i32,
			revision: Some(thread_pb::Revision { head: 3, token: vec![0xa5; 32].into() }),
			provider: "provider".to_owned(),
			model: "model".to_owned(),
			duration_ms: Some(42),
			..Default::default()
		}
	}

	fn caps() -> omp_tool::CapsBase {
		omp_tool::CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: 1024,
			media:              false,
			model_class:        omp_tool::ModelClass::Standard,
		}
	}

	fn tool_outcome() -> Outcome {
		Outcome {
			output: vec![Item {
				seq:           3,
				created_at_ms: 4,
				kind:          Some(thread_item::Kind::ToolCall(thread_pb::ToolCall {
					id: "call-1".to_owned(),
					name: "read".to_owned(),
					args_json: br#"{"path":"x"}"#.to_vec().into(),
					..Default::default()
				})),
				props:         Some(pb::ValueMap {
					fields: BTreeMap::from([(omp_tool::TOOL_REV_PROP.to_owned(), pb::Value {
						kind: Some(pb::value::Kind::String("1".to_owned())),
					})]),
				}),
			}],
			stop: pb::StopReason::StopToolUse as i32,
			revision: Some(thread_pb::Revision { head: 3, token: vec![4; 32].into() }),
			provider: "provider".to_owned(),
			model: "model".to_owned(),
			..Default::default()
		}
	}

	fn assert_tool_crash_recovery(authorized: bool, expected_text: &str) {
		let path = path(if authorized {
			"authorized-tool"
		} else {
			"unmarked-tool"
		});
		let hash = PromptHash::from([2; 32]);
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let input = journal
			.append_turn_input(2, "turn", message("input"), Some(hash))
			.expect("append turn input");
		journal
			.start_turn(3, TurnStart {
				turn_id:            sf!("turn"),
				item_events:        vec![input],
				prompt_hash:        hash.digest(),
				prompt_head_events: Vec::new(),
				toolset_hash:       Hash32::new([3; 32]),
				enabled_tools:      vec![sf!("read")],
				sequence_targets:   vec![input],
				input:              TurnInputRecord::Full {
					thread: thread_pb::Thread { items: vec![message("input")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start turn");
		journal
			.append_arbiter_outcome(4, "turn", tool_outcome())
			.expect("append tool outcome");
		if authorized {
			journal
				.authorize_tool_batch(5, "turn", &[sf!("call-1")])
				.expect("authorize tool batch");
		}
		drop(journal);
		let reopened = Journal::open(&path).expect("recover unresolved tool");
		let (recovery_turn, indexes) = reopened
			.pending_input_submission()
			.expect("recovery submission");
		omp_core::Ulid::from_string(recovery_turn.as_str()).expect("recovery turn id is a ULID");
		assert_eq!(indexes.len(), 1);
		let log = reopened.load().expect("load recovery");
		let Some(Entry::Ok(event)) = log.log().get(indexes[0]) else {
			panic!("recovered input missing");
		};
		let Kind::TurnInput(input) = &event.kind else {
			panic!("recovery must be typed turn input");
		};
		let Some(thread_item::Kind::ToolResult(result)) = input.item.kind.as_ref() else {
			panic!("recovery input must be tool result");
		};
		assert_eq!(result.call_id, "call-1");
		let Some(thread_part::Kind::Text(text)) =
			result.parts.first().and_then(|part| part.kind.as_ref())
		else {
			panic!("recovery result text missing");
		};
		assert!(text.contains(expected_text));
		drop(log);
		let bytes = fs::read(&path).expect("read once-recovered journal");
		drop(reopened);

		let reopened = Journal::open(&path).expect("reopen recovered tool");
		assert_eq!(fs::read(&path).expect("read twice-recovered journal"), bytes);
		assert_eq!(
			reopened
				.pending_input_submission()
				.expect("same recovery")
				.1
				.len(),
			1
		);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn staged_turn_input_reopens_with_exact_turn_id() {
		let path = path("staged-input");
		let turn_id = omp_core::Ulid::generate().to_string();
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let index = journal
			.append_turn_input(2, &turn_id, message("input"), Some(PromptHash::from([1; 32])))
			.expect("append staged input");
		drop(journal);
		let reopened = Journal::open(&path).expect("reopen staged input");
		let (durable_turn_id, indexes) = reopened
			.pending_input_submission()
			.expect("pending staged input");
		assert_eq!(durable_turn_id.as_str(), turn_id);
		assert_eq!(indexes, &[index]);
		assert_eq!(reopened.recoverable_input_events(), &[index]);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn partial_tool_batch_recovery_coalesces_missing_results_into_existing_follow_up() {
		let path = path("partial-tool-batch");
		let hash = PromptHash::from([3; 32]);
		let mut journal = Journal::create(&path, &header()).expect("create journal");

		let input = journal
			.append_turn_input(2, "turn", message("input"), Some(hash))
			.expect("append turn input");
		journal
			.start_turn(3, TurnStart {
				turn_id:            sf!("turn"),
				item_events:        vec![input],
				prompt_hash:        hash.digest(),
				prompt_head_events: Vec::new(),
				toolset_hash:       Hash32::new([3; 32]),
				enabled_tools:      vec![sf!("read")],
				sequence_targets:   vec![input],
				input:              TurnInputRecord::Full {
					thread: thread_pb::Thread { items: vec![message("input")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start turn");
		let mut outcome = tool_outcome();
		let mut second = outcome.output[0].clone();
		second.seq = 4;
		let Some(thread_item::Kind::ToolCall(call)) = second.kind.as_mut() else {
			panic!("fixture call missing");
		};
		call.id = "call-2".to_owned();
		outcome.output.push(second);
		outcome.revision.as_mut().expect("revision").head = 4;
		journal
			.append_arbiter_outcome(4, "turn", outcome.clone())
			.expect("append tool outcome");
		journal
			.authorize_tool_batch(5, "turn", &[sf!("call-1"), sf!("call-2")])
			.expect("authorize tool batch");
		let follow_up = omp_core::Ulid::generate().to_string();
		let first_result = recovery_tool_result_item(6, &outcome.output[0], Abort::Interrupted {
			reason: sf!("fixture terminal result"),
		})
		.expect("build first terminal result");
		journal
			.append_turn_input(6, &follow_up, first_result, Some(hash))
			.expect("append first result");
		drop(journal);

		let reopened = Journal::open(&path).expect("recover missing batch result");
		let (turn_id, indexes) = reopened
			.pending_input_submission()
			.expect("recovery submission");
		assert_eq!(turn_id.as_str(), follow_up);
		assert_eq!(indexes.len(), 2);
		let bytes = fs::read(&path).expect("read recovered batch");
		drop(reopened);
		let reopened = Journal::open(&path).expect("reopen recovered batch");
		assert_eq!(fs::read(&path).expect("read idempotent batch"), bytes);
		assert_eq!(
			reopened
				.pending_input_submission()
				.expect("same group")
				.1
				.len(),
			2
		);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn crash_recovery_scopes_reused_call_ids_to_their_receipt_occurrence() {
		let path = path("reused-call-id");
		let hash = PromptHash::from([7; 32]);
		let start = |turn_id: &'static str| TurnStart {
			turn_id:            Str::new_static(turn_id),
			item_events:        Vec::new(),
			prompt_hash:        hash.digest(),
			prompt_head_events: Vec::new(),
			toolset_hash:       Hash32::new([0; 32]),
			enabled_tools:      Vec::new(),
			sequence_targets:   Vec::new(),
			input:              TurnInputRecord::Full { thread: thread_pb::Thread::default() },
			options:            TurnOptionsRecord {
				context_id: None,
				params:     pb::ChatParams::default(),
				executor:   None,
				props:      None,
			},
		};
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		journal
			.append(&Event { ts: 2, kind: Kind::TurnStart(start("first")) })
			.expect("append first start");
		let first_receipt = TurnReceipt {
			turn_id:            sf!("first"),
			prompt_hash:        hash.digest(),
			prompt_head_events: Vec::new(),
			item_events:        Vec::new(),
			outcome:            tool_outcome(),
		};
		journal
			.append(&Event { ts: 3, kind: Kind::TurnReceipt(first_receipt.clone()) })
			.expect("append first receipt");
		let first_result =
			recovery_tool_result_item(4, &first_receipt.outcome.output[0], Abort::Interrupted {
				reason: sf!("first occurrence settled"),
			})
			.expect("build first result");
		journal
			.append(&Event {
				ts:   4,
				kind: Kind::TurnInput(TurnInputItem {
					turn_id:     sf!("first-follow-up"),
					item:        first_result,
					prompt_hash: Some(hash.digest()),
				}),
			})
			.expect("append first result");
		let mut second_receipt = first_receipt;
		second_receipt.turn_id = sf!("second");
		second_receipt.outcome.stop = pb::StopReason::StopMaxTokens as i32;
		journal
			.append(&Event { ts: 5, kind: Kind::TurnStart(start("second")) })
			.expect("append second start");
		journal
			.append(&Event { ts: 6, kind: Kind::TurnReceipt(second_receipt) })
			.expect("append second receipt");
		journal
			.append(&Event {
				ts:   7,
				kind: Kind::ToolBatchAuthorized(ToolBatchAuthorized {
					turn_id:  sf!("second"),
					call_ids: vec![sf!("call-1")],
				}),
			})
			.expect("authorize second occurrence");
		drop(journal);

		let reopened = Journal::open(&path).expect("recover second occurrence");
		let log = reopened.load().expect("load recovery");
		let results = (0..u64::try_from(log.log().len()).expect("journal length"))
			.filter_map(|index| {
				let Entry::Ok(event) = log.log().get(index)? else {
					return None;
				};
				let item = event_item(&event.kind)?;
				let item::Kind::ToolResult(result) = item.kind.as_ref()? else {
					return None;
				};
				Some(result)
			})
			.collect::<Vec<_>>();
		assert_eq!(results.len(), 2);
		let text = results[1]
			.parts
			.iter()
			.find_map(|part| match part.kind.as_ref() {
				Some(thread_part::Kind::Text(text)) => Some(text.as_str()),
				_ => None,
			})
			.expect("recovery result text");
		assert!(text.contains("effects unknown"));
		drop(log);
		drop(reopened);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn ordered_staged_turn_groups_and_settlement_survive_sequential_reopens() {
		let no_events: &[u64] = &[];
		let path = path("staged-queue");
		let first_turn = omp_core::Ulid::generate().to_string();
		let second_turn = omp_core::Ulid::generate().to_string();
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let first = journal
			.append_turn_input(2, &first_turn, message("first"), None)
			.expect("append first group");
		let second = journal
			.append_turn_input(3, &second_turn, message("second"), None)
			.expect("append second group");
		let settlement = journal
			.settle_job(4, "job", message("settled"))
			.expect("append settlement");
		drop(journal);

		let mut journal = Journal::open(&path).expect("first reopen");
		assert_eq!(
			journal.pending_input_submission(),
			Some((&Str::new(first_turn.as_str()), [first].as_slice()))
		);
		assert_eq!(journal.recoverable_settlement_events(), &[settlement]);
		journal
			.start_turn(5, TurnStart {
				turn_id:            Str::new(first_turn.as_str()),
				item_events:        vec![first, settlement],
				prompt_hash:        Hash32::new([0; 32]),
				prompt_head_events: Vec::new(),
				toolset_hash:       Hash32::new([0; 32]),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![first, settlement],
				input:              TurnInputRecord::Full {
					thread: thread_pb::Thread { items: vec![message("first"), message("settled")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start first group");
		journal
			.append_arbiter_outcome(6, &first_turn, outcome())
			.expect("complete first group");
		drop(journal);

		let mut journal = Journal::open(&path).expect("second reopen");
		let (turn_id, indexes) = journal.pending_input_submission().expect("second group");
		assert_eq!(turn_id.as_str(), second_turn);
		assert_eq!(indexes, &[second]);
		assert_eq!(journal.recoverable_settlement_events(), no_events);
		journal
			.start_turn(7, TurnStart {
				turn_id:            Str::new(second_turn.as_str()),
				item_events:        vec![second],
				prompt_hash:        Hash32::new([0; 32]),
				prompt_head_events: Vec::new(),
				toolset_hash:       Hash32::new([0; 32]),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![second],
				input:              TurnInputRecord::Full {
					thread: thread_pb::Thread { items: vec![message("second")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start second group");
		journal
			.append_arbiter_outcome(8, &second_turn, outcome())
			.expect("complete second group");
		drop(journal);

		let journal = Journal::open(&path).expect("final reopen");
		assert!(journal.pending_input_submission().is_none());
		assert_eq!(journal.recoverable_settlement_events(), no_events);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn tool_crash_recovery_distinguishes_authorized_effect_uncertainty() {
		assert_tool_crash_recovery(true, "effects unknown");
		assert_tool_crash_recovery(false, "skipped");
	}

	#[test]
	fn arbiter_outcome_receipt_round_trips_and_replays_exactly_once() {
		let path = path("receipt");
		let prompt_hash = PromptHash::from([7; 32]);
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let prompt_event = journal
			.append_optimistic(2, message("system"), Some(prompt_hash))
			.expect("append prompt");
		let input_event = journal
			.append_optimistic(3, message("input"), Some(prompt_hash))
			.expect("append input");
		journal
			.start_turn(4, TurnStart {
				turn_id:            sf!("turn"),
				item_events:        vec![input_event],
				prompt_hash:        prompt_hash.digest(),
				prompt_head_events: vec![prompt_event],
				toolset_hash:       Hash32::new([8; 32]),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![input_event],
				input:              TurnInputRecord::Delta {
					context: pb::ContextRef {
						context_id: "context".to_owned(),
						expected:   Some(thread_pb::Revision { head: 2, token: vec![3; 32].into() }),
					},
					delta:   pb::ThreadDelta { truncate_to: None, append: vec![message("input")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start turn");

		let expected = outcome();
		let (receipt, replay) = journal
			.append_arbiter_outcome(5, "turn", expected.clone())
			.expect("append outcome");
		assert!(!replay);
		assert_eq!(receipt.prompt_hash, prompt_hash.digest());
		assert_eq!(receipt.prompt_head_events, vec![prompt_event]);
		assert_eq!(receipt.outcome, expected);
		let bytes = fs::read(&path).expect("read committed journal");

		let (replayed, replay) = journal
			.append_arbiter_outcome(6, "turn", expected.clone())
			.expect("replay exact outcome");
		assert!(replay);
		assert_eq!(replayed, receipt);
		assert_eq!(fs::read(&path).expect("read replayed journal"), bytes);

		let mut different = expected;
		different.provider = "other".to_owned();
		assert!(matches!(
			journal.append_arbiter_outcome(7, "turn", different),
			Err(JournalError::TurnReplayMismatch(_))
		));
		assert_eq!(fs::read(&path).expect("read rejected replay journal"), bytes);
		drop(journal);

		let reopened = Journal::open(&path).expect("reopen journal");
		assert_eq!(reopened.receipt("turn"), Some(&receipt));
		assert!(reopened.pending_turn().is_none());
		let view = reopened.load().expect("load recovered");
		let projected =
			project_journal(&view, &omp_tool::Registry::new(), &caps()).expect("project recovered");
		assert_eq!(projected.items[1].seq, 2, "reopen must recover the missing sequence patch");
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn partial_turn_output_stays_hidden_and_exact_start_reopens() {
		let path = path("partial-output");
		let prompt_hash = PromptHash::from([9; 32]);
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let prompt_event = journal
			.append_optimistic(2, message("system"), Some(prompt_hash))
			.expect("append prompt");
		let input = message("input");
		let input_event = journal
			.append_optimistic(3, input.clone(), Some(prompt_hash))
			.expect("append input");
		let start = TurnStart {
			turn_id:            sf!("turn"),
			item_events:        vec![input_event],
			prompt_hash:        prompt_hash.digest(),
			prompt_head_events: vec![prompt_event],
			toolset_hash:       Hash32::new([6; 32]),
			enabled_tools:      Vec::new(),
			sequence_targets:   vec![input_event],
			input:              TurnInputRecord::Full {
				thread: thread_pb::Thread { items: vec![message("system"), input] },
			},
			options:            TurnOptionsRecord {
				context_id: Some(sf!("seed")),
				params:     pb::ChatParams { model: "provider/model".to_owned(), ..Default::default() },
				executor:   None,
				props:      None,
			},
		};
		journal.start_turn(4, start.clone()).expect("start turn");
		journal
			.writer
			.append(&Event {
				ts:   5,
				kind: Kind::Item(ItemRecord {
					item:        outcome().output[0].clone(),
					turn_id:     Some(start.turn_id.clone()),
					prompt_hash: Some(start.prompt_hash),
				}),
			})
			.expect("append interrupted output prefix");
		drop(journal);

		let reopened = Journal::open(&path).expect("reopen partial turn");
		assert_eq!(reopened.pending_turn(), Some(&start));
		let view = reopened.load().expect("load partial");
		let projected =
			project_journal(&view, &omp_tool::Registry::new(), &caps()).expect("project partial");
		assert_eq!(projected.items, vec![message("system"), message("input")]);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn aborted_turn_is_settled_and_counted_across_reopen() {
		let path = path("turn-abort");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let start = TurnStart {
			turn_id:            sf!("failed-turn-1"),
			item_events:        Vec::new(),
			prompt_hash:        Hash32::new([3; 32]),
			prompt_head_events: Vec::new(),
			toolset_hash:       Hash32::new([4; 32]),
			enabled_tools:      Vec::new(),
			sequence_targets:   Vec::new(),
			input:              TurnInputRecord::Full { thread: thread_pb::Thread::default() },
			options:            TurnOptionsRecord {
				context_id: None,
				params:     pb::ChatParams::default(),
				executor:   None,
				props:      None,
			},
		};
		journal
			.start_turn(2, start.clone())
			.expect("start first turn");
		journal
			.abort_turn(3, "failed-turn-1", AbortDisposition::Continue)
			.expect("abort first turn");
		let mut second = start.clone();
		second.turn_id = sf!("failed-turn-2");
		journal.start_turn(4, second).expect("start second turn");
		let abort = journal
			.abort_turn(5, "failed-turn-2", AbortDisposition::Continue)
			.expect("abort second turn");
		assert_eq!(
			journal
				.abort_turn(6, "failed-turn-2", AbortDisposition::Continue)
				.expect("repeat abort"),
			abort,
			"abort settlement must be idempotent"
		);
		assert!(journal.pending_turn().is_none());
		assert_eq!(journal.trailing_aborts(), 2);
		drop(journal);

		let mut reopened = Journal::open(&path).expect("reopen aborted turns");
		assert!(reopened.pending_turn().is_none());
		assert_eq!(reopened.trailing_aborts(), 2);
		let mut success = start;
		success.turn_id = sf!("successful-turn");
		reopened
			.start_turn(7, success)
			.expect("start successful turn");
		reopened
			.append_arbiter_outcome(8, "successful-turn", outcome())
			.expect("append successful receipt");
		assert_eq!(reopened.trailing_aborts(), 0);
		drop(reopened);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn sequence_amendment_projects_without_mutating_item_event() {
		let path = path("sequence");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let target = journal
			.append_optimistic(2, message("input"), None)
			.expect("append optimistic item");
		journal
			.amend_seq(3, target, 9)
			.expect("append sequence amendment");
		let log = journal.load().expect("load journal");
		let Some(Entry::Ok(event)) = log.log().get(target) else {
			panic!("item event missing")
		};
		let Kind::Item(record) = &event.kind else {
			panic!("target is not an item")
		};
		assert_eq!(record.item.seq, 0);
		let projected =
			project_journal(&log, &omp_tool::Registry::new(), &caps()).expect("project journal");
		assert_eq!(projected.items[0].seq, 9);
		drop(log);
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn prompt_rewrite_recovers_every_partial_materialization_once() {
		for staged in 0..=2 {
			let path = path("prompt-rewrite");
			let mut journal = Journal::create(&path, &header()).expect("create journal");
			let old_head = journal
				.append_optimistic(2, message("old-head"), Some(PromptHash::from([1; 32])))
				.expect("append old head");
			let tail = journal
				.append_optimistic(3, message("tail"), Some(PromptHash::from([1; 32])))
				.expect("append tail");
			drop(journal);

			let head = vec![message("new-head-a"), message("new-head-b")];
			let mut writer = Writer::open_append(&path).expect("open raw writer");
			let intent = writer
				.append(&Event {
					ts:   4,
					kind: Kind::PromptRewriteIntent(PromptRewriteIntent {
						prompt_hash:    Hash32::new([2; 32]),
						head:           head.clone(),
						preserved_tail: vec![tail],
					}),
				})
				.expect("append rewrite intent");
			for (ordinal, item) in head.iter().take(staged).enumerate() {
				writer
					.append(&Event {
						ts:   4,
						kind: Kind::PromptRewriteStage(PromptRewriteStage {
							intent,
							ordinal: ordinal as u64,
							item: item.clone(),
						}),
					})
					.expect("append partial stage");
			}
			drop(writer);

			let pending_view = transcript::load_live(&path).expect("load incomplete rewrite");
			assert!(pending_view.live().iter().eq([old_head, tail]));
			let pending_thread = project_journal(&pending_view, &omp_tool::Registry::new(), &caps())
				.expect("project old live chain");
			assert_eq!(pending_thread.items, vec![message("old-head"), message("tail")]);

			let recovered = Journal::open(&path).expect("recover rewrite");
			let live = recovered
				.live_item_events()
				.expect("read recovered live indexes");
			assert_eq!(live.len(), 3);
			assert_eq!(live[2], tail);
			let (active_hash, active_head) =
				recovered.active_prompt().expect("active recovered prompt");
			assert_eq!(active_hash, Hash32::new([2; 32]));
			assert_eq!(active_head, &live[..2]);
			assert!(!live.contains(&old_head));
			assert_eq!(recovered.items_at(&live).expect("read rewritten items"), vec![
				head[0].clone(),
				head[1].clone(),
				message("tail")
			]);
			let view = recovered.load().expect("load recovered journal");
			let projected = project_journal(&view, &omp_tool::Registry::new(), &caps())
				.expect("project recovered rewrite");
			drop(view);
			let projected_bytes = projected.encode_to_vec();
			drop(recovered);
			let recovered_bytes = fs::read(&path).expect("read recovered bytes");

			let reopened = Journal::open(&path).expect("reopen completed rewrite");
			assert_eq!(
				reopened
					.live_item_events()
					.expect("read stable live indexes"),
				live
			);
			let view = reopened.load().expect("reload journal");
			let reprojection = project_journal(&view, &omp_tool::Registry::new(), &caps())
				.expect("reproject completed rewrite");
			drop(view);
			assert_eq!(reprojection.encode_to_vec(), projected_bytes);
			drop(reopened);
			assert_eq!(
				fs::read(&path).expect("read idempotently reopened bytes"),
				recovered_bytes,
				"reopening must not duplicate stages or commit"
			);
			fs::remove_file(path).expect("remove journal");
		}
	}

	#[test]
	fn detached_jobs_reconstruct_pending_minus_settled_without_duplicates() {
		let path = path("jobs");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let job = |id: &'static str| JobRef {
			id:       sf!(id),
			owner:    JobOwner::NamedProcess { name: sf!(id), generation: 1 },
			metadata: Arc::default(),
			artifact: ExpectedArtifact {
				description: sf!("artifact"),
				media_type:  Some(sf!("text/plain")),
				lifetime:    ArtifactLifetime::Session,
			},
		};
		let first = job("job-a");
		let second = job("job-b");
		let first_index = journal
			.register_job(2, first.clone())
			.expect("register first job");
		assert_eq!(
			journal
				.register_job(3, first.clone())
				.expect("repeat first registration"),
			first_index
		);
		journal
			.register_job(4, second.clone())
			.expect("register second job");
		let settlement = message("job-a settled");
		let settlement_index = journal
			.settle_job(5, first.id.as_str(), settlement.clone())
			.expect("settle first job");
		assert_eq!(
			journal
				.settle_job(6, first.id.as_str(), settlement)
				.expect("repeat settlement"),
			settlement_index
		);
		assert_eq!(journal.pending_jobs().cloned().collect::<Vec<_>>(), vec![second.clone()]);
		drop(journal);

		let mut reopened = Journal::open(&path).expect("reopen jobs");
		assert_eq!(reopened.pending_jobs().cloned().collect::<Vec<_>>(), vec![second.clone()]);
		reopened
			.settle_job(7, second.id.as_str(), message("job-b settled"))
			.expect("settle resumed job");
		assert_eq!(reopened.pending_jobs().count(), 0);
		assert!(matches!(
			reopened.settle_job(8, first.id.as_str(), message("different")),
			Err(JournalError::JobReplayMismatch(_))
		));
		drop(reopened);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn repeated_append_projection_cycles_keep_the_complete_live_prefix() {
		let path = path("incremental-project");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let mut indexes = Vec::new();
		for ordinal in 0..128_u64 {
			indexes.push(
				journal
					.append_optimistic(ordinal.saturating_add(2), message("item"), None)
					.expect("append item"),
			);
			let live = journal.live_item_events().expect("project live items");
			assert_eq!(live.as_slice(), indexes.as_slice());
			assert_eq!(journal.items_at(&live).expect("project item values").len(), live.len());
		}
		assert_eq!(journal.load().expect("borrow final journal").log().len(), 128);
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn foreign_append_refresh_resynchronizes_the_local_writer_once() {
		let path = path("foreign-append");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let first = journal
			.append_optimistic(2, message("local"), None)
			.expect("append local item");
		let mut foreign = Writer::open_append(&path).expect("open foreign writer");
		let second = foreign
			.append(&Event {
				ts:   3,
				kind: Kind::Item(ItemRecord {
					item:        message("foreign"),
					turn_id:     None,
					prompt_hash: None,
				}),
			})
			.expect("append foreign item");
		drop(foreign);
		assert_eq!(journal.live_item_events().expect("refresh foreign append"), vec![first, second]);
		let third = journal
			.append_optimistic(4, message("local again"), None)
			.expect("append after foreign refresh");
		assert_eq!(third, second.saturating_add(1));
		assert_eq!(
			journal
				.live_item_events()
				.expect("project resynchronized journal"),
			vec![first, second, third]
		);
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn torn_foreign_tail_is_repaired_before_the_next_local_append() {
		let path = path("torn-tail");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let first = journal
			.append_optimistic(2, message("before tear"), None)
			.expect("append before tear");
		let mut file = OpenOptions::new()
			.append(true)
			.open(&path)
			.expect("open journal tail");
		file
			.write_all(br#"{"ts":3,"type":"item""#)
			.expect("write torn foreign tail");
		drop(file);
		assert_eq!(journal.live_item_events().expect("read complete prefix"), vec![first]);

		let second = journal
			.append_optimistic(4, message("after repair"), None)
			.expect("repair tail and append");
		assert_eq!(second, first.saturating_add(1));
		assert_eq!(
			journal
				.items_at(&[first, second])
				.expect("read repaired items"),
			vec![message("before tear"), message("after repair")]
		);
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}
	#[test]
	fn projection_fails_closed_after_foreign_truncation() {
		let path = path("foreign-truncate");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		journal
			.append_optimistic(2, message("durable"), None)
			.expect("append durable item");
		OpenOptions::new()
			.write(true)
			.truncate(true)
			.open(&path)
			.expect("truncate journal");
		assert!(matches!(journal.live_item_events(), Err(JournalError::Storage(_))));
		assert!(matches!(journal.items_at(&[0]), Err(JournalError::Storage(_))));
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}

	#[test]
	fn rewind_rejects_pending_turn() {
		let path = path("rewind-pending");
		let mut journal = Journal::create(&path, &header()).expect("create journal");
		let input = journal
			.append_turn_input(2, "pending", message("pending input"), None)
			.expect("stage pending input");
		journal
			.start_turn(3, TurnStart {
				turn_id:            sf!("pending"),
				item_events:        vec![input],
				prompt_hash:        Hash32::new([1; 32]),
				prompt_head_events: Vec::new(),
				toolset_hash:       Hash32::new([2; 32]),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![input],
				input:              TurnInputRecord::Full {
					thread: thread_pb::Thread { items: vec![message("pending input")] },
				},
				options:            TurnOptionsRecord {
					context_id: None,
					params:     pb::ChatParams::default(),
					executor:   None,
					props:      None,
				},
			})
			.expect("start pending turn");
		assert_eq!(journal.live_item_events().expect("project pending journal"), vec![input]);
		assert!(journal.pending_turn().is_some());
		assert!(matches!(journal.truncate_to(4, None), Err(JournalError::RewindWhilePending)));
		assert!(matches!(
			journal.compact(4, Compact {
				summary:       sf!("summary"),
				short:         None,
				first_kept:    input,
				tokens_before: 100,
				tokens_after:  Some(20),
				method:        Some(sf!("remote")),
				warning:       None,
				snapcompact:   None,
				superseded:    Vec::new(),
			}),
			Err(JournalError::CompactWhilePending)
		));
		drop(journal);
		fs::remove_file(path).expect("remove journal");
	}
}
