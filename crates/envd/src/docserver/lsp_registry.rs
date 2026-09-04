//! Project-scoped LSP binding selection, document lifecycle, revision
//! admission, inbound revision tagging, and transaction formatting
//! coordination.

use std::{
	cmp,
	collections::{HashMap, HashSet, VecDeque},
	fmt, fs, iter,
	path::{Path, PathBuf},
	str,
	sync::Arc,
	time::{Duration, Instant},
};

use bytes::Bytes;
use flume::Receiver;
use omp_core::{Hash32, Str};
use omp_proto::lsp::{Diagnostic, PositionEncoding};
use omp_walker::glob::{CompiledPattern, PatternBuilder};
use parking_lot::Mutex;
use serde_json::Value;
use strum::IntoStaticStr;
use thiserror::Error;
use tokio::{
	sync::{Mutex as AsyncMutex, broadcast},
	task,
	task::JoinSet,
	time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	DocumentEvent, DocumentHead, DocumentId, DocumentKind, DocumentLocator, DocumentPresence,
	DocumentSnapshot, DocumentStore, Error as DocumentError, LanguageId, LeaseId, ReadBody,
	ReadSelection, Result as DocumentResult, Revision, TransactionId,
	diagnostics_ledger::{DiagnosticDelta, DiagnosticsLedger},
	format_options,
	lsp::{
		LspActivity, LspDocument, LspError, LspResponse, LspResponseOutcome, LspServer,
		LspTransportError, LspWatchedFileChange, LspWatchedFileKind, SyncPolicy,
	},
	transaction::{
		FormatCoordinator, FormatRequest, FormatResult, PublishedDocument, RevertedDocument,
	},
};
const PUBLIC_VERSION_LIMIT: usize = 32;
const LSP_EVENT_BUS_CAPACITY: usize = 256;
const DOCUMENT_EVENT_FORWARD_CAPACITY: usize = 64;
mod event_receiver {
	use tokio::sync::broadcast::Receiver;

	use super::{LspRegistry, LspRegistryEvent};

	impl LspRegistry {
		/// Subscribes to the bounded registry event stream.
		///
		/// Receivers observe lag errors when they fall behind instead of
		/// silently losing notifications.
		pub fn subscribe_events(&self) -> Receiver<LspRegistryEvent> {
			self.inner.events.subscribe()
		}
	}
}

/// Stable process-local identity assigned to an LSP binding.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LspBindingId(u64);

impl LspBindingId {
	/// Reconstructs a binding identity from its registry-local integer
	/// representation.
	pub const fn from_u64(value: u64) -> Self {
		Self(value)
	}

	/// Returns the registry-local integer representation.
	pub const fn get(self) -> u64 {
		self.0
	}
}

/// Generation-bound identity for callbacks originating from one concrete LSP
/// server lane.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct LspBindingHandle {
	binding_id: LspBindingId,
	generation: u64,
}

impl LspBindingHandle {
	/// Returns the stable binding identity.
	pub const fn binding_id(self) -> LspBindingId {
		self.binding_id
	}
}

/// A compiled language, URI-scheme, and URI-path binding selector.
#[derive(Clone)]
pub struct LspSelector {
	languages:     Vec<LanguageId>,
	schemes:       Vec<Str>,
	path_patterns: Vec<Str>,
	path_matchers: Vec<CompiledPattern>,
}

impl fmt::Debug for LspSelector {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LspSelector")
			.field("languages", &self.languages)
			.field("schemes", &self.schemes)
			.field("path_patterns", &self.path_patterns)
			.finish()
	}
}

impl LspSelector {
	/// Compiles a selector. An empty dimension matches every value in that
	/// dimension.
	pub fn new(
		languages: Vec<LanguageId>,
		schemes: Vec<Str>,
		path_patterns: Vec<Str>,
	) -> Result<Self, LspRegistryError> {
		let mut path_matchers = Vec::with_capacity(path_patterns.len());
		for pattern in &path_patterns {
			let matcher = PatternBuilder::new(pattern.as_str())
				.literal_separator(false)
				.build()
				.map_err(|error| LspRegistryError::InvalidSelector {
					reason: Str::new(error.to_string()),
				})?;
			path_matchers.push(matcher);
		}
		Ok(Self { languages, schemes, path_patterns, path_matchers })
	}

	/// Creates a selector matching every document.
	pub const fn all() -> Self {
		Self {
			languages:     Vec::new(),
			schemes:       Vec::new(),
			path_patterns: Vec::new(),
			path_matchers: Vec::new(),
		}
	}

	/// Compiles extension and exact-filename routes.
	pub fn for_file_types(file_types: &[Str]) -> Result<Self, LspRegistryError> {
		let patterns = file_types
			.iter()
			.map(|file_type| {
				let value = file_type.as_str();
				if value.starts_with('.') {
					Str::new(format!("**/*{value}"))
				} else if value.contains('.') {
					Str::new(format!("**/*.{value}"))
				} else {
					Str::new(format!("**/{value}"))
				}
			})
			.collect();
		Self::new(Vec::new(), vec![Str::new_static("file")], patterns)
	}

	/// Returns the language restrictions in declaration order.
	pub fn languages(&self) -> &[LanguageId] {
		&self.languages
	}

	/// Returns the URI-scheme restrictions in declaration order.
	pub fn schemes(&self) -> &[Str] {
		&self.schemes
	}

	/// Returns the path glob restrictions in declaration order.
	pub fn path_patterns(&self) -> &[Str] {
		&self.path_patterns
	}

	/// Reports whether this selector accepts a URI and language classification.
	pub fn matches(&self, uri: &Url, language: Option<&LanguageId>) -> bool {
		let language_matches = self.languages.is_empty()
			|| language.is_some_and(|language| self.languages.iter().any(|item| item == language));
		let scheme_matches = self.schemes.is_empty()
			|| self
				.schemes
				.iter()
				.any(|scheme| scheme.as_str() == uri.scheme());
		let path_matches = self.path_matchers.is_empty()
			|| self
				.path_matchers
				.iter()
				.any(|matcher| matcher.matches(uri.path()));
		language_matches && scheme_matches && path_matches
	}
}

/// Declaration used when installing a named server binding.
#[derive(Clone, Debug)]
pub struct LspBindingSpec {
	name:              Str,
	priority:          i32,
	selector:          LspSelector,
	is_linter:         bool,
	root_markers:      Vec<Str>,
	idle_timeout:      Option<Duration>,
	readiness_timeout: Duration,
	settings_json:     Bytes,
}

impl LspBindingSpec {
	/// Creates a binding declaration.
	pub fn new(
		name: impl AsRef<str>,
		priority: i32,
		selector: LspSelector,
	) -> Result<Self, LspRegistryError> {
		let name = name.as_ref();
		if name.is_empty() {
			return Err(LspRegistryError::InvalidBindingName);
		}
		Ok(Self {
			name: Str::new(name),
			priority,
			selector,
			is_linter: false,
			root_markers: Vec::new(),
			idle_timeout: None,
			readiness_timeout: Duration::from_secs(5),
			settings_json: Bytes::from_static(br#"{"settings":{}}"#),
		})
	}

	/// Returns the unique binding name.
	pub fn name(&self) -> &str {
		self.name.as_str()
	}

	/// Returns the deterministic selection priority. Higher values run first.
	pub const fn priority(&self) -> i32 {
		self.priority
	}

	/// Returns the binding selector.
	pub const fn selector(&self) -> &LspSelector {
		&self.selector
	}

	/// Marks whether this binding is a linter/checker.
	pub const fn with_linter(mut self, is_linter: bool) -> Self {
		self.is_linter = is_linter;
		self
	}

	/// Installs ancestor root markers used to exclude unrelated files.
	pub fn with_root_markers(mut self, root_markers: Vec<Str>) -> Self {
		self.root_markers = root_markers;
		self
	}

	/// Applies lifecycle timing policy from the resolved declaration.
	pub const fn with_lifecycle(
		mut self,
		idle_timeout: Option<Duration>,
		readiness_timeout: Duration,
	) -> Self {
		self.idle_timeout = idle_timeout;
		self.readiness_timeout = readiness_timeout;
		self
	}

	/// Retains the exact configuration notification used by this binding.
	pub fn with_settings_json(mut self, settings_json: Bytes) -> Self {
		self.settings_json = settings_json;
		self
	}

	/// Returns whether this is a linter/checker binding.
	pub const fn is_linter(&self) -> bool {
		self.is_linter
	}

	/// Returns configured ancestor root markers.
	pub fn root_markers(&self) -> &[Str] {
		&self.root_markers
	}

	/// Returns the exact active `workspace/didChangeConfiguration` parameters.
	pub const fn settings_json(&self) -> &Bytes {
		&self.settings_json
	}

	fn matches(&self, uri: &Url, language: Option<&LanguageId>) -> bool {
		if !self.selector.matches(uri, language) {
			return false;
		}
		if self.root_markers.is_empty() || uri.scheme() != "file" {
			return true;
		}
		uri.to_file_path()
			.ok()
			.is_some_and(|path| root_marker_ancestor(&path, &self.root_markers).is_some())
	}
}

/// Immutable public description of an installed binding.
#[derive(Clone, Debug)]
pub struct LspBindingInfo {
	id:   LspBindingId,
	spec: LspBindingSpec,
}

impl LspBindingInfo {
	/// Returns the binding identity.
	pub const fn id(&self) -> LspBindingId {
		self.id
	}

	/// Returns the binding declaration.
	pub const fn spec(&self) -> &LspBindingSpec {
		&self.spec
	}
}

/// Current synchronization policy and capabilities for a selected lease
/// binding.
#[derive(Clone, Debug)]
pub struct LspLeaseBinding {
	info:              LspBindingInfo,
	sync_policy:       SyncPolicy,
	capabilities_json: Bytes,
}

impl LspLeaseBinding {
	/// Returns the installed binding description.
	pub const fn info(&self) -> &LspBindingInfo {
		&self.info
	}

	/// Returns the selector-resolved synchronization policy.
	pub const fn sync_policy(&self) -> &SyncPolicy {
		&self.sync_policy
	}

	/// Returns exact `InitializeResult` capability JSON.
	pub const fn capabilities_json(&self) -> &Bytes {
		&self.capabilities_json
	}
}

/// Requested stale-response policy for semantic operations.
///
/// Semantic parameters are opaque raw JSON, so both policies reject a stale
/// admission or completion rather than replaying position-bearing parameters
/// against different text.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum StaleResponsePolicy {
	/// Reject admission or a response whenever the requested head is no longer
	/// current.
	#[default]
	ContentModified,
	/// Retained for protocol compatibility; opaque parameters are not retried.
	RetryOnce,
}

/// An inbound server event tagged with a provable daemon revision when
/// available.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaggedLspEvent {
	binding_id:        LspBindingId,
	binding_name:      Str,
	method:            Str,
	params_json:       Bytes,
	revision:          Option<Revision>,
	document_identity: Option<(DocumentId, Url)>,
}

impl TaggedLspEvent {
	/// Returns the server binding that emitted the event.
	pub const fn binding_id(&self) -> LspBindingId {
		self.binding_id
	}

	/// Returns the server binding name captured with the event.
	pub fn binding_name(&self) -> &str {
		self.binding_name.as_str()
	}

	/// Returns the inbound LSP method.
	pub fn method(&self) -> &str {
		self.method.as_str()
	}

	/// Returns the exact inbound JSON parameters.
	pub const fn params_json(&self) -> &Bytes {
		&self.params_json
	}

	/// Returns the daemon revision proven by a URI/version pair, if any.
	pub const fn revision(&self) -> Option<Revision> {
		self.revision
	}

	/// Returns the document identity proven by the binding's public version
	/// history, if the notification names one unambiguously.
	pub const fn document_identity(&self) -> Option<&(DocumentId, Url)> {
		self.document_identity.as_ref()
	}

	/// Returns the document identity proven for this notification, if any.
	pub fn document_id(&self) -> Option<DocumentId> {
		self
			.document_identity
			.as_ref()
			.map(|(document_id, _)| *document_id)
	}

	/// Returns the document URI proven for this notification, if any.
	pub fn document_uri(&self) -> Option<&Url> {
		self.document_identity.as_ref().map(|(_, uri)| uri)
	}
}

/// A registry event that connection-local subscribers can forward without
/// translating native LSP or document identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LspRegistryEvent {
	/// An inbound server notification with the exact parameters received.
	Inbound(Box<TaggedLspEvent>),
	/// A binding lifecycle or synchronization-policy change.
	Binding(LspBindingEvent),
	/// Bounded discovery/startup progress.
	Startup(LspStartupEvent),
}

/// Startup progress stage for one selected declaration.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "snake_case")]
pub enum LspStartupStage {
	/// A declaration matched project markers and file routing.
	Discovered,
	/// Initialization has begun.
	Starting,
	/// rust-analyzer is still indexing.
	Indexing,
	/// Initialization or readiness completed.
	Ready,
	/// Initialization failed.
	Failed,
}

/// One bounded startup progress event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LspStartupEvent {
	/// Server declaration name.
	pub name:  Str,
	/// Current startup stage.
	pub stage: LspStartupStage,
}

/// The kind of an installed binding change.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspBindingEventKind {
	/// The binding has been installed and is ready for requests.
	Ready,
	/// Dynamic registration changed the binding's policy for an open document.
	PolicyChanged,
	/// The binding's server lane has been replaced successfully.
	Restarted,
	/// The binding has been removed after its documents were released.
	Stopped,
}

/// A binding lifecycle or policy event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LspBindingEvent {
	binding_id:  LspBindingId,
	document_id: Option<DocumentId>,
	kind:        LspBindingEventKind,
}

impl LspBindingEvent {
	/// Returns the binding affected by this change.
	pub const fn binding_id(&self) -> LspBindingId {
		self.binding_id
	}

	/// Returns the affected open document for document-scoped policy changes.
	pub const fn document_id(&self) -> Option<DocumentId> {
		self.document_id
	}

	/// Returns the lifecycle or policy transition.
	pub const fn kind(&self) -> LspBindingEventKind {
		self.kind
	}
}

/// Terminal failure for a lease's bounded committed-document event stream.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum DocumentEventStreamError {
	/// The actor produced more events than the registry could synchronize.
	#[error("document event stream lagged by {skipped} events")]
	Lagged {
		/// Number of overwritten events.
		skipped: u64,
	},
	/// An event could not be synchronized to every selected LSP binding.
	#[error("document event synchronization failed: {message}")]
	Synchronization {
		/// Registry or LSP failure.
		message: Str,
	},
	/// The document actor stopped while the lease remained open.
	#[error("document event stream closed unexpectedly")]
	Closed,
}

/// An active document lease owned by the registry and its initial committed
/// head.
#[derive(Debug)]
pub struct LspDocumentLease {
	lease_id:    LeaseId,
	head:        DocumentHead,
	binding_ids: Vec<LspBindingId>,
	events:      Receiver<Result<DocumentEvent, DocumentEventStreamError>>,
}

impl LspDocumentLease {
	/// Returns the underlying document-store lease identity.
	pub const fn lease_id(&self) -> LeaseId {
		self.lease_id
	}

	/// Returns the committed head admitted by the open operation.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns selected bindings in deterministic priority order.
	pub fn binding_ids(&self) -> &[LspBindingId] {
		&self.binding_ids
	}

	/// Returns this lease's ordered committed-document event stream.
	pub const fn events(&self) -> &Receiver<Result<DocumentEvent, DocumentEventStreamError>> {
		&self.events
	}

	/// Splits the lease into its identity, initial head, selected bindings, and
	/// event stream.
	pub fn into_parts(
		self,
	) -> (
		LeaseId,
		DocumentHead,
		Vec<LspBindingId>,
		Receiver<Result<DocumentEvent, DocumentEventStreamError>>,
	) {
		(self.lease_id, self.head, self.binding_ids, self.events)
	}
}

#[derive(Clone)]
struct Binding {
	id:         LspBindingId,
	spec:       LspBindingSpec,
	server:     LspServer,
	generation: u64,
}

struct FormatBindingLease {
	binding: Binding,
}

struct FormatLeaseSet {
	bindings:         Vec<FormatBindingLease>,
	shadow_document:  DocumentId,
	shadow_uri:       Url,
	policy_uri:       Url,
	base_language_id: Option<LanguageId>,
}

struct RefreshProgress {
	binding:          Binding,
	original_count:   usize,
	opened:           bool,
	retained:         usize,
	released:         usize,
	current_language: Option<LanguageId>,
}

#[derive(Clone)]
struct LeaseRecord {
	document_id:   DocumentId,
	language_id:   Option<LanguageId>,
	binding_ids:   Vec<LspBindingId>,
	cancel_events: CancellationToken,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ProvisionalLeaseKey {
	binding_id:      LspBindingId,
	document_id:     DocumentId,
	transaction:     TransactionId,
	shadow_document: DocumentId,
}

#[derive(Default)]
struct RegistryState {
	next_binding_id:    u64,
	bindings:           HashMap<LspBindingId, Binding>,
	binding_names:      HashMap<Str, LspBindingId>,
	leases:             HashMap<LeaseId, LeaseRecord>,
	public_versions:    HashMap<(LspBindingId, DocumentId), VecDeque<(Str, i32)>>,
	provisional_leases: HashSet<ProvisionalLeaseKey>,
	publication_gates:  HashMap<TransactionId, CancellationToken>,
	diagnostic_events:  HashMap<(LspBindingId, DocumentId), DiagnosticRecord>,
	diagnostics_ledger: DiagnosticsLedger,
}

#[derive(Clone)]
struct DiagnosticRecord {
	version:     Option<i64>,
	payload:     Hash32,
	event:       TaggedLspEvent,
	observed_at: Instant,
}

struct RegistryInner {
	store:    DocumentStore,
	events:   broadcast::Sender<LspRegistryEvent>,
	mutation: AsyncMutex<()>,
	state:    Mutex<RegistryState>,
}

/// Project-scoped owner of selected, ordered LSP server bindings.
#[derive(Clone)]
pub struct LspRegistry {
	inner: Arc<RegistryInner>,
}

/// Releases actor-event publication for one committed inbound LSP transaction.
#[must_use]
pub(crate) struct LspPublicationBarrier {
	registry:       LspRegistry,
	transaction_id: TransactionId,
}

impl LspPublicationBarrier {
	/// Releases every document event blocked on this transaction.
	pub(crate) fn release(self) {
		drop(self);
	}
}

impl Drop for LspPublicationBarrier {
	fn drop(&mut self) {
		let gate = {
			self
				.registry
				.inner
				.state
				.lock()
				.publication_gates
				.remove(&self.transaction_id)
		};
		if let Some(gate) = gate {
			gate.cancel();
		}
	}
}

impl fmt::Debug for LspRegistry {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LspRegistry")
			.finish_non_exhaustive()
	}
}

impl LspRegistry {
	/// Creates an empty registry above a document store.
	pub fn new(store: DocumentStore) -> Self {
		Self {
			inner: Arc::new(RegistryInner {
				store,
				events: broadcast::channel(LSP_EVENT_BUS_CAPACITY).0,
				mutation: AsyncMutex::new(()),
				state: Mutex::new(RegistryState { next_binding_id: 1, ..RegistryState::default() }),
			}),
		}
	}

	/// Returns the project document store used for revision admission.
	pub fn document_store(&self) -> &DocumentStore {
		&self.inner.store
	}

	/// Concurrently installs selected bindings and publishes bounded startup
	/// progress. Result order matches candidate order.
	pub async fn warm_bindings(
		&self,
		candidates: Vec<(LspBindingSpec, LspServer)>,
		cancel: CancellationToken,
	) -> Vec<Result<LspBindingId, LspRegistryError>> {
		let count = candidates.len();
		let mut tasks = JoinSet::new();
		for (index, (spec, server)) in candidates.into_iter().enumerate() {
			self.publish_startup(spec.name.clone(), LspStartupStage::Discovered);
			let registry = self.clone();
			let task_cancel = cancel.child_token();
			tasks.spawn(async move {
				registry.publish_startup(spec.name.clone(), LspStartupStage::Starting);
				let result = registry
					.add_binding(spec.clone(), server, task_cancel.child_token())
					.await;
				if let Ok(binding_id) = result {
					let readiness = registry
						.wait_for_binding_ready(binding_id, task_cancel)
						.await;
					match readiness {
						Ok(()) => {
							registry.publish_startup(spec.name, LspStartupStage::Ready);
							(index, Ok(binding_id))
						},
						Err(error) => {
							let _ = registry
								.remove_binding(binding_id, CancellationToken::new())
								.await;
							registry.publish_startup(spec.name, LspStartupStage::Failed);
							(index, Err(error))
						},
					}
				} else {
					registry.publish_startup(spec.name, LspStartupStage::Failed);
					(index, result)
				}
			});
		}
		let mut results = iter::repeat_with(|| None).take(count).collect::<Vec<_>>();
		while let Some(joined) = tasks.join_next().await {
			match joined {
				Ok((index, result)) => results[index] = Some(result),
				Err(source) => {
					if let Some(slot) = results.iter_mut().find(|slot| slot.is_none()) {
						*slot = Some(Err(LspRegistryError::WarmupTask { source }));
					}
				},
			}
		}
		results
			.into_iter()
			.map(|result| result.unwrap_or(Err(LspRegistryError::WarmupResultMissing)))
			.collect()
	}

	/// Polls rust-analyzer status until a workspace is observed or the
	/// configured readiness bound expires. Other servers are immediately ready.
	pub async fn wait_for_binding_ready(
		&self,
		binding_id: LspBindingId,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let binding = self.binding(binding_id)?;
		if binding.spec.name != "rust-analyzer" {
			return Ok(());
		}
		let started = Instant::now();
		let deadline = started + binding.spec.readiness_timeout;
		loop {
			if cancel.is_cancelled() {
				return Err(LspError::Transport(LspTransportError::Cancelled).into());
			}
			let request = binding.server.request(
				"rust-analyzer/analyzerStatus",
				Bytes::from_static(b"{}"),
				None,
				cancel.child_token(),
			);
			if let Ok(Ok(response)) = timeout(Duration::from_secs(1), request).await
				&& let LspResponseOutcome::Result(result) = response.outcome
				&& let Ok(status) = serde_json::from_slice::<Str>(&result)
				&& !status.starts_with("No workspaces")
				&& started.elapsed() >= Duration::from_secs(2).min(binding.spec.readiness_timeout)
			{
				return Ok(());
			}
			if Instant::now() >= deadline {
				return Ok(());
			}
			self.publish_startup(binding.spec.name.clone(), LspStartupStage::Indexing);
			tokio::select! {
				() = sleep(Duration::from_millis(100)) => {},
				() = cancel.cancelled() => return Err(LspError::Transport(LspTransportError::Cancelled).into()),
			}
		}
	}

	/// Returns exact initialize capabilities for one installed binding.
	pub fn binding_capabilities(&self, binding_id: LspBindingId) -> Result<Bytes, LspRegistryError> {
		Ok(self.binding(binding_id)?.server.capabilities_json())
	}

	/// Returns current activity for one binding.
	pub fn binding_activity(
		&self,
		binding_id: LspBindingId,
	) -> Result<LspActivity, LspRegistryError> {
		Ok(self.binding(binding_id)?.server.activity())
	}

	/// Runs periodic inactivity reaping until cancelled.
	pub fn spawn_idle_reaper(
		&self,
		interval: Duration,
		cancel: CancellationToken,
	) -> task::JoinHandle<()> {
		let registry = self.clone();
		tokio::spawn(async move {
			loop {
				tokio::select! {
					() = sleep(interval) => {
						let _ = registry.reap_inactive(cancel.child_token()).await;
					},
					() = cancel.cancelled() => return,
				}
			}
		})
	}

	/// Evicts bindings that exceeded their configured idle timeout and have no
	/// pending requests.
	pub async fn reap_inactive(
		&self,
		cancel: CancellationToken,
	) -> Result<Vec<LspBindingId>, LspRegistryError> {
		let inactive = self
			.sorted_bindings()
			.into_iter()
			.filter_map(|binding| {
				let timeout = binding.spec.idle_timeout?;
				let activity = binding.server.activity();
				(activity.pending_requests == 0 && activity.idle_for >= timeout).then_some(binding.id)
			})
			.collect::<Vec<_>>();
		for binding_id in &inactive {
			self
				.remove_binding(*binding_id, cancel.child_token())
				.await?;
		}
		Ok(inactive)
	}

	/// Re-emits the active binding configuration before optionally replacing
	/// the native binding lane. Callers evict config and pool caches before
	/// calling.
	pub async fn reload_binding(
		&self,
		binding_id: LspBindingId,
		replacement: Option<LspServer>,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let binding = self.binding(binding_id)?;
		if binding.spec.name == "rust-analyzer" {
			let _ = binding
				.server
				.request(
					"rust-analyzer/reloadWorkspace",
					Bytes::from_static(b"{}"),
					None,
					cancel.child_token(),
				)
				.await;
		}
		binding
			.server
			.notification(
				"workspace/didChangeConfiguration",
				binding.spec.settings_json().clone(),
				cancel.child_token(),
			)
			.await?;
		if let Some(replacement) = replacement {
			self
				.restart_binding(binding_id, replacement, cancel)
				.await?;
		}
		Ok(())
	}

	pub(crate) fn publish_startup(&self, name: Str, stage: LspStartupStage) {
		let _ = self
			.inner
			.events
			.send(LspRegistryEvent::Startup(LspStartupEvent { name, stage }));
	}

	/// Defers actor-event publication until an inbound LSP response is written.
	pub(crate) fn defer_transaction_publication(
		&self,
		transaction_id: TransactionId,
	) -> LspPublicationBarrier {
		let displaced = self
			.inner
			.state
			.lock()
			.publication_gates
			.insert(transaction_id, CancellationToken::new());
		assert!(displaced.is_none(), "transaction publication barrier is unique");
		LspPublicationBarrier { registry: self.clone(), transaction_id }
	}

	async fn await_transaction_publication(&self, transaction_id: Option<TransactionId>) {
		let gate = transaction_id.and_then(|transaction_id| {
			self
				.inner
				.state
				.lock()
				.publication_gates
				.get(&transaction_id)
				.cloned()
		});
		if let Some(gate) = gate {
			gate.cancelled().await;
		}
	}

	/// Installs a named server and synchronizes every already-open matching
	/// document.
	pub async fn add_binding(
		&self,
		spec: LspBindingSpec,
		server: LspServer,
		cancel: CancellationToken,
	) -> Result<LspBindingId, LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		{
			let state = self.inner.state.lock();
			if state.binding_names.contains_key(spec.name.as_str()) {
				return Err(LspRegistryError::DuplicateBinding { name: spec.name.clone() });
			}
		}
		let lease_records = self.lease_records();
		let mut documents =
			HashMap::<DocumentId, (Arc<DocumentSnapshot>, Url, Option<LanguageId>, usize)>::new();
		for (_, record) in &lease_records {
			let (snapshot, uri) = self.current_snapshot(record.document_id).await?;
			if !spec.matches(&uri, record.language_id.as_ref()) {
				continue;
			}
			documents
				.entry(record.document_id)
				.and_modify(|entry| entry.3 += 1)
				.or_insert_with(|| (snapshot, uri, record.language_id.clone(), 1));
		}
		let mut installed = Vec::new();
		for (document_id, (snapshot, uri, language_id, count)) in &documents {
			if let Err(error) = server
				.synchronize(lsp_document(snapshot, uri, language_id.as_ref()), cancel.child_token())
				.await
			{
				for installed_id in installed {
					let _ = server
						.release_document(installed_id, CancellationToken::new())
						.await;
				}
				return Err(error.into());
			}
			installed.push(*document_id);
			for _ in 1..*count {
				if let Err(error) = server.retain_document(*document_id).await {
					for installed_id in installed {
						let _ = server
							.release_document(installed_id, CancellationToken::new())
							.await;
					}
					return Err(error.into());
				}
				installed.push(*document_id);
			}
		}
		let id = {
			let mut state = self.inner.state.lock();
			let id = LspBindingId(state.next_binding_id);
			state.next_binding_id = state
				.next_binding_id
				.checked_add(1)
				.ok_or(LspRegistryError::BindingIdOverflow)?;
			state.binding_names.insert(spec.name.clone(), id);
			state
				.bindings
				.insert(id, Binding { id, spec, server: server.clone(), generation: 0 });
			for (lease_id, record) in &lease_records {
				if documents.contains_key(&record.document_id) {
					state
						.leases
						.get_mut(lease_id)
						.expect("lease captured under mutation gate")
						.binding_ids
						.push(id);
				}
			}
			id
		};
		for (document_id, (_, uri, ..)) in &documents {
			if let Some((version, _)) = server.tracked_version_revision(*document_id) {
				self.mark_public_version(id, *document_id, uri, version);
			}
		}
		self.publish_binding_event(id, None, LspBindingEventKind::Ready);
		Ok(id)
	}

	/// Removes a binding after balancing all document leases and advertised
	/// closes.
	pub async fn remove_binding(
		&self,
		binding_id: LspBindingId,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		if self
			.inner
			.state
			.lock()
			.provisional_leases
			.iter()
			.any(|lease| lease.binding_id == binding_id)
		{
			return Err(LspRegistryError::BindingBusy { binding_id });
		}
		let binding = self.binding(binding_id)?;
		loop {
			let selected = self
				.inner
				.state
				.lock()
				.leases
				.iter()
				.find_map(|(lease_id, record)| {
					record
						.binding_ids
						.contains(&binding_id)
						.then_some((*lease_id, record.document_id))
				});
			let Some((lease_id, document_id)) = selected else {
				break;
			};
			binding
				.server
				.release_document(document_id, cancel.child_token())
				.await?;
			self
				.inner
				.state
				.lock()
				.leases
				.get_mut(&lease_id)
				.expect("lease retained under mutation gate")
				.binding_ids
				.retain(|id| *id != binding_id);
		}
		{
			let mut state = self.inner.state.lock();
			state.bindings.remove(&binding_id);
			state.binding_names.remove(binding.spec.name.as_str());
			state.public_versions.retain(|(id, _), _| *id != binding_id);
			state
				.diagnostic_events
				.retain(|(id, _), _| *id != binding_id);
			state.diagnostics_ledger.clear();
		}
		self.publish_binding_event(binding_id, None, LspBindingEventKind::Stopped);
		Ok(())
	}

	/// Returns installed bindings in deterministic selection order.
	pub fn bindings(&self) -> Vec<LspBindingInfo> {
		let mut bindings = self
			.inner
			.state
			.lock()
			.bindings
			.values()
			.map(|binding| LspBindingInfo { id: binding.id, spec: binding.spec.clone() })
			.collect::<Vec<_>>();
		bindings.sort_by(binding_info_order);
		bindings
	}

	/// Resolves a binding identity by its unique name.
	pub fn binding_id(&self, name: &str) -> Option<LspBindingId> {
		self.inner.state.lock().binding_names.get(name).copied()
	}

	/// Captures a generation-bound handle for callbacks installed on the
	/// binding's current server lane.
	pub fn binding_handle(
		&self,
		binding_id: LspBindingId,
	) -> Result<LspBindingHandle, LspRegistryError> {
		let binding = self.binding(binding_id)?;
		Ok(LspBindingHandle { binding_id, generation: binding.generation })
	}

	/// Resolves synchronization policy for the concrete server generation that
	/// originated an inbound request.
	pub fn sync_policy_for_handle(
		&self,
		handle: LspBindingHandle,
		uri: &Url,
		language_id: Option<&LanguageId>,
	) -> Result<SyncPolicy, LspRegistryError> {
		let binding = self.binding_for_handle(handle)?;
		Ok(binding.server.sync_policy(uri, language_id))
	}

	/// Resolves one server-visible text document version to its daemon revision.
	pub fn revision_for_version(
		&self,
		handle: LspBindingHandle,
		uri: &Url,
		version: i32,
	) -> Result<Option<Revision>, LspRegistryError> {
		let binding = self.binding_for_handle(handle)?;
		Ok(binding.server.revision_for_version(uri, version))
	}

	/// Returns current policy and capabilities for bindings selected by one
	/// lease.
	pub async fn lease_bindings(
		&self,
		lease_id: LeaseId,
	) -> Result<Vec<LspLeaseBinding>, LspRegistryError> {
		let (document_id, language_id, bindings) = {
			let state = self.inner.state.lock();
			let record = state
				.leases
				.get(&lease_id)
				.ok_or(LspRegistryError::UnknownLease { lease_id })?;
			let bindings = record
				.binding_ids
				.iter()
				.filter_map(|id| state.bindings.get(id).cloned())
				.collect::<Vec<_>>();
			(record.document_id, record.language_id.clone(), bindings)
		};
		let uri = self.document_uri(document_id).await?;
		let mut selected = Vec::with_capacity(bindings.len());
		for binding in bindings {
			selected.push(LspLeaseBinding {
				info:              LspBindingInfo { id: binding.id, spec: binding.spec },
				sync_policy:       binding.server.sync_policy(&uri, language_id.as_ref()),
				capabilities_json: binding.server.capabilities_json(),
			});
		}
		selected.sort_by(|left, right| binding_info_order(&left.info, &right.info));
		Ok(selected)
	}

	/// Opens a store lease, selects matching bindings, and begins automatic head
	/// publication.
	pub async fn open_document(
		&self,
		locator: impl Into<DocumentLocator>,
		language_id: Option<LanguageId>,
		cancel: CancellationToken,
	) -> Result<LspDocumentLease, LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		let opened = self.inner.store.open(locator).await?;
		let (lease_id, head, mut events) = opened.into_parts();
		let snapshot = match self.snapshot_from_store(lease_id, None).await {
			Ok(snapshot) => snapshot,
			Err(error) => {
				let _ = self.inner.store.close(lease_id).await;
				return Err(error);
			},
		};
		let uri = match self.document_uri(head.document_id()).await {
			Ok(uri) => uri,
			Err(error) => {
				let _ = self.inner.store.close(lease_id).await;
				return Err(error);
			},
		};
		let bindings = self.matching_bindings(&uri, language_id.as_ref());
		let mut installed: Vec<Binding> = Vec::new();
		for binding in &bindings {
			let existing = self.binding_document_count(binding.id, head.document_id());
			let mut acquired = false;
			let result = if existing == 0 {
				let result = binding
					.server
					.synchronize(
						lsp_document(&snapshot, &uri, language_id.as_ref()),
						cancel.child_token(),
					)
					.await;
				acquired = result.is_ok();
				result
			} else {
				match binding.server.retain_document(head.document_id()).await {
					Ok(()) => {
						acquired = true;
						binding
							.server
							.synchronize(
								lsp_document(&snapshot, &uri, language_id.as_ref()),
								cancel.child_token(),
							)
							.await
					},
					Err(error) => Err(error),
				}
			};
			let version = match result {
				Ok(version) => version,
				Err(error) => {
					if acquired {
						let _ = binding
							.server
							.release_document(head.document_id(), CancellationToken::new())
							.await;
					}
					for installed_binding in installed {
						let _ = installed_binding
							.server
							.release_document(head.document_id(), CancellationToken::new())
							.await;
					}
					let _ = self.inner.store.close(lease_id).await;
					return Err(error.into());
				},
			};
			self.mark_public_version(binding.id, head.document_id(), &uri, version);
			installed.push(binding.clone());
		}
		let binding_ids = bindings
			.iter()
			.map(|binding| binding.id)
			.collect::<Vec<_>>();
		let cancel_events = CancellationToken::new();
		self
			.inner
			.state
			.lock()
			.leases
			.insert(lease_id, LeaseRecord {
				document_id: head.document_id(),
				language_id,
				binding_ids: binding_ids.clone(),
				cancel_events: cancel_events.clone(),
			});
		let registry = self.clone();
		let (client_events_sender, client_events) = flume::bounded(DOCUMENT_EVENT_FORWARD_CAPACITY);
		tokio::spawn(async move {
			loop {
				tokio::select! {
					() = cancel_events.cancelled() => break,
					event = events.recv() => match event {
						Ok(event) => {
							tokio::select! {
								() = cancel_events.cancelled() => break,
								() = registry.await_transaction_publication(event.transaction_id()) => {},
							}
							let document_id = event.head().document_id();
							if let Err(error) =
								registry.publish_head(document_id, CancellationToken::new()).await
							{
								let _ = client_events_sender
									.send_async(Err(DocumentEventStreamError::Synchronization {
										message: Str::new(error.to_string()),
									}))
									.await;
								break;
							}
							if client_events_sender.send_async(Ok(event)).await.is_err() {
								break;
							}
						},
						Err(broadcast::error::RecvError::Lagged(skipped)) => {
							let _ = client_events_sender
								.send_async(Err(DocumentEventStreamError::Lagged { skipped }))
								.await;
							break;
						},
						Err(broadcast::error::RecvError::Closed) => {
							let _ = client_events_sender
								.send_async(Err(DocumentEventStreamError::Closed))
								.await;
							break;
						},
					},
				}
			}
		});
		Ok(LspDocumentLease { lease_id, head, binding_ids, events: client_events })
	}

	/// Releases a registry lease and balances every selected server lease.
	pub async fn close_document(
		&self,
		lease_id: LeaseId,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		let record = self
			.inner
			.state
			.lock()
			.leases
			.get(&lease_id)
			.cloned()
			.ok_or(LspRegistryError::UnknownLease { lease_id })?;
		record.cancel_events.cancel();

		let mut first_error = None;
		for binding_id in &record.binding_ids {
			match self.binding(*binding_id) {
				Ok(binding) => {
					let result = {
						let release = binding
							.server
							.release_document(record.document_id, cancel.child_token());
						tokio::pin!(release);
						tokio::select! {
							biased;
							result = &mut release => result,
							() = cancel.cancelled() => Err(LspError::Transport(LspTransportError::Cancelled).into()),
						}
					};
					if let Err(error) = result {
						binding
							.server
							.abandon_document_lease(record.document_id)
							.await;
						if first_error.is_none() {
							first_error = Some(LspRegistryError::from(error));
						}
					}
				},
				Err(error) if first_error.is_none() => first_error = Some(error),
				Err(_) => {},
			}
		}
		if let Err(error) = self.inner.store.close(lease_id).await
			&& first_error.is_none()
		{
			first_error = Some(LspRegistryError::from(error));
		}
		let mut state = self.inner.state.lock();
		state.leases.remove(&lease_id);
		if !state
			.leases
			.values()
			.any(|lease| lease.document_id == record.document_id)
		{
			state
				.public_versions
				.retain(|(_, document_id), _| *document_id != record.document_id);
		}
		drop(state);
		match first_error {
			Some(error) => Err(error),
			None => Ok(()),
		}
	}

	/// Synchronizes a current committed or external head to every selected
	/// binding.
	pub async fn publish_head(
		&self,
		document_id: DocumentId,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		self.refresh_document(document_id, cancel).await
	}

	/// Applies dynamic registrations and schedules document reconciliation after
	/// the registration request can be acknowledged on the server lane.
	pub async fn register_capabilities(
		&self,
		handle: LspBindingHandle,
		params_json: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let mutation = self.inner.mutation.lock().await;
		let binding = self.binding_for_handle(handle)?;
		let affected = self.binding_document_ids(binding.id);
		binding.server.register_capabilities(params_json)?;
		drop(mutation);
		self.schedule_policy_reconciliation(binding, affected, cancel);
		Ok(())
	}

	/// Applies dynamic unregistrations and schedules document reconciliation
	/// after the unregister request can be acknowledged on the server lane.
	pub async fn unregister_capabilities(
		&self,
		handle: LspBindingHandle,
		params_json: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let mutation = self.inner.mutation.lock().await;
		let binding = self.binding_for_handle(handle)?;
		let affected = self.binding_document_ids(binding.id);
		binding.server.unregister_capabilities(params_json)?;
		drop(mutation);
		self.schedule_policy_reconciliation(binding, affected, cancel);
		Ok(())
	}

	/// Replaces a restarted server lane only after its complete document state
	/// has been staged successfully.
	pub async fn restart_binding(
		&self,
		binding_id: LspBindingId,
		server: LspServer,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		if self
			.inner
			.state
			.lock()
			.provisional_leases
			.iter()
			.any(|lease| lease.binding_id == binding_id)
		{
			return Err(LspRegistryError::BindingBusy { binding_id });
		}
		let binding = self.binding(binding_id)?;
		let generation = binding
			.generation
			.checked_add(1)
			.ok_or(LspRegistryError::BindingGenerationOverflow { binding_id })?;
		let records = self.lease_records();
		let mut documents =
			HashMap::<DocumentId, (Arc<DocumentSnapshot>, Url, Option<LanguageId>, usize)>::new();
		for (_, record) in records
			.iter()
			.filter(|(_, record)| record.binding_ids.contains(&binding_id))
		{
			let (snapshot, uri) = self.current_snapshot(record.document_id).await?;
			documents
				.entry(record.document_id)
				.and_modify(|entry| entry.3 += 1)
				.or_insert_with(|| (snapshot, uri, record.language_id.clone(), 1));
		}

		let mut acquired = Vec::<(DocumentId, usize)>::new();
		let mut public_versions = Vec::with_capacity(documents.len());
		for (document_id, (snapshot, uri, language_id, count)) in documents {
			let version = match server
				.synchronize(lsp_document(&snapshot, &uri, language_id.as_ref()), cancel.child_token())
				.await
			{
				Ok(version) => version,
				Err(error) => {
					self.cleanup_replacement_leases(&server, &acquired).await;
					return Err(error.into());
				},
			};
			acquired.push((document_id, 1));
			public_versions.push((document_id, Str::new(uri.as_str()), version));
			for _ in 1..count {
				if let Err(error) = server.retain_document(document_id).await {
					self.cleanup_replacement_leases(&server, &acquired).await;
					return Err(error.into());
				}
				acquired
					.last_mut()
					.expect("replacement document was staged")
					.1 += 1;
			}
		}

		{
			let mut state = self.inner.state.lock();
			state.public_versions.retain(|(id, _), _| *id != binding_id);
			state
				.diagnostic_events
				.retain(|(id, _), _| *id != binding_id);
			state.diagnostics_ledger.clear();
			for (document_id, uri, version) in public_versions {
				state
					.public_versions
					.entry((binding_id, document_id))
					.or_default()
					.push_back((uri, version));
			}
			state
				.bindings
				.insert(binding_id, Binding { server, generation, ..binding });
		}
		self.publish_binding_event(binding_id, None, LspBindingEventKind::Restarted);
		Ok(())
	}

	/// Sends an exact raw workspace request without document revision tagging.
	pub async fn workspace_request(
		&self,
		binding_id: LspBindingId,
		method: &str,
		params_json: Bytes,
		cancel: CancellationToken,
	) -> Result<LspResponse, LspRegistryError> {
		let binding = self.binding(binding_id)?;
		let response = binding
			.server
			.request(method, params_json, None, cancel)
			.await?;
		self.ensure_binding_generation(binding.id, binding.generation)?;
		Ok(response)
	}

	/// Sends an exact raw non-lifecycle notification through the binding's
	/// ordered lane.
	pub async fn notification(
		&self,
		binding_id: LspBindingId,
		method: &str,
		params_json: Bytes,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let binding = self.binding(binding_id)?;
		binding
			.server
			.notification(method, params_json, cancel)
			.await?;
		self.ensure_binding_generation(binding.id, binding.generation)
	}

	/// Admits opaque semantic parameters only against their exact requested
	/// revision. Stale raw position parameters are never replayed at a newer
	/// revision.
	pub async fn semantic_request(
		&self,
		binding_id: LspBindingId,
		method: &str,
		params_json: Bytes,
		lease_id: LeaseId,
		requested_revision: Revision,
		_stale_policy: StaleResponsePolicy,
		cancel: CancellationToken,
	) -> Result<LspResponse, LspRegistryError> {
		let binding = self.binding(binding_id)?;
		let record = self.lease_record(lease_id)?;
		if !record.binding_ids.contains(&binding_id) {
			return Err(LspRegistryError::BindingNotSelected {
				binding_id,
				document_id: record.document_id,
			});
		}
		let snapshot = self.snapshot_from_store(lease_id, None).await?;
		let current = snapshot.head().revision();
		if current != requested_revision {
			return Err(LspRegistryError::ContentModified { requested: requested_revision, current });
		}
		let uri = self.document_uri(record.document_id).await?;
		let version = binding
			.server
			.synchronize(
				lsp_document(&snapshot, &uri, record.language_id.as_ref()),
				cancel.child_token(),
			)
			.await?;
		if !self.mark_public_version_if_current(&binding, record.document_id, &uri, version) {
			return Err(LspRegistryError::BindingRestarted { binding_id });
		}
		let response = binding
			.server
			.request(
				method,
				params_json,
				Some(lsp_document(&snapshot, &uri, record.language_id.as_ref())),
				cancel.child_token(),
			)
			.await?;
		self.ensure_binding_generation(binding.id, binding.generation)?;
		let newest = self
			.snapshot_from_store(lease_id, None)
			.await?
			.head()
			.revision();
		if newest == requested_revision && response.revision == Some(requested_revision) {
			return Ok(response);
		}
		Err(LspRegistryError::ContentModified { requested: requested_revision, current: newest })
	}

	/// Tags an inbound event, resolving versioned diagnostics when the mapping
	/// is provable.
	pub fn tag_inbound_event(
		&self,
		handle: LspBindingHandle,
		method: impl AsRef<str>,
		params_json: Bytes,
	) -> Result<TaggedLspEvent, LspRegistryError> {
		let binding = self.binding_for_handle(handle)?;
		let binding_id = binding.id;
		let method = method.as_ref();
		let value: Value = serde_json::from_slice(&params_json).map_err(|error| {
			LspRegistryError::InvalidInboundJson { reason: Str::new(error.to_string()) }
		})?;
		let uri = value
			.get("uri")
			.or_else(|| value.pointer("/textDocument/uri"))
			.and_then(Value::as_str)
			.and_then(|uri| Url::parse(uri).ok());
		let version = (method == "textDocument/publishDiagnostics")
			.then(|| value.get("version"))
			.flatten()
			.and_then(Value::as_i64)
			.and_then(|version| i32::try_from(version).ok());
		let document_identity = if let Some(uri) = uri {
			let state = self.inner.state.lock();
			let mut document_id = None;
			let mut ambiguous = false;
			for ((entry_binding_id, entry_document_id), entries) in &state.public_versions {
				if *entry_binding_id != binding_id
					|| !entries
						.iter()
						.any(|(entry_uri, _)| entry_uri.as_str() == uri.as_str())
				{
					continue;
				}
				if document_id.is_some_and(|known| known != *entry_document_id) {
					ambiguous = true;
					break;
				}
				document_id = Some(*entry_document_id);
			}
			(!ambiguous)
				.then_some(document_id)
				.flatten()
				.map(|document_id| (document_id, uri))
		} else {
			None
		};
		let revision = match (&document_identity, version) {
			(Some((document_id, uri)), Some(version)) => {
				let is_public = self
					.inner
					.state
					.lock()
					.public_versions
					.get(&(binding_id, *document_id))
					.is_some_and(|entries| {
						entries.iter().any(|(entry_uri, entry_version)| {
							entry_uri.as_str() == uri.as_str() && *entry_version == version
						})
					});
				if is_public {
					binding.server.revision_for_version(uri, version)
				} else {
					None
				}
			},
			_ => None,
		};
		self.ensure_binding_generation(binding.id, binding.generation)?;
		Ok(TaggedLspEvent {
			binding_id,
			binding_name: binding.spec.name,
			method: Str::new(method),
			params_json,
			revision,
			document_identity,
		})
	}

	/// Tags and publishes an inbound server notification.
	///
	/// The exact parameter bytes are retained in both the returned event and
	/// the clone delivered to every current subscriber.
	pub fn publish_inbound_event(
		&self,
		handle: LspBindingHandle,
		method: impl AsRef<str>,
		params_json: Bytes,
	) -> Result<TaggedLspEvent, LspRegistryError> {
		let event = self.tag_inbound_event(handle, method, params_json)?;
		let publish = if event.method() == "textDocument/publishDiagnostics" {
			self.should_publish_diagnostics(&event)
		} else {
			true
		};
		if publish {
			let _ = self
				.inner
				.events
				.send(LspRegistryEvent::Inbound(Box::new(event.clone())));
		}
		Ok(event)
	}

	/// Waits at most `budget` for a fresh push/pull batch fenced to an exact
	/// committed revision. Unversioned streams receive their quiescence window
	/// inside this same wall-clock budget.
	pub async fn await_diagnostics_for_revision(
		&self,
		document_id: DocumentId,
		revision: Revision,
		deduplicate: bool,
		budget: Duration,
	) -> Vec<TaggedLspEvent> {
		let has_bindings = self
			.inner
			.state
			.lock()
			.leases
			.values()
			.any(|lease| lease.document_id == document_id && !lease.binding_ids.is_empty());
		if !has_bindings {
			return Vec::new();
		}
		let deadline = Instant::now() + budget;
		loop {
			let events = self.drain_diagnostics_for_revision(document_id, revision, deduplicate);
			if !events.is_empty() || Instant::now() >= deadline {
				return events;
			}
			sleep(Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())))
				.await;
		}
	}

	/// Applies the persistent new-and-changed-only delivery ledger.
	pub fn diagnostic_delta(
		&self,
		uri: Str,
		diagnostics: Vec<Diagnostic>,
		deduplicate: bool,
	) -> DiagnosticDelta {
		self
			.inner
			.state
			.lock()
			.diagnostics_ledger
			.update(uri, diagnostics, deduplicate)
	}

	/// Returns the negotiated position encoding for a diagnostic event.
	pub fn diagnostic_position_encoding(&self, event: &TaggedLspEvent) -> PositionEncoding {
		let state = self.inner.state.lock();
		let language = state
			.leases
			.values()
			.find(|lease| {
				event
					.document_id()
					.is_some_and(|document_id| lease.document_id == document_id)
			})
			.and_then(|lease| lease.language_id.as_ref());
		state
			.bindings
			.get(&event.binding_id())
			.and_then(|binding| {
				event
					.document_uri()
					.map(|uri| binding.server.sync_policy(uri, language).position_encoding)
			})
			.unwrap_or_default()
	}

	/// Drains diagnostics observed for one exact committed revision. Records
	/// from formatter/save intermediates and stale revisions are discarded.
	/// Unversioned streams are accepted only after a 250 ms quiescence window
	/// and are fenced to the newest public version for that binding/document.
	/// When `deduplicate` is enabled, byte-identical final batches collapse
	/// across bindings.
	pub fn drain_diagnostics_for_revision(
		&self,
		document_id: DocumentId,
		revision: Revision,
		deduplicate: bool,
	) -> Vec<TaggedLspEvent> {
		let mut state = self.inner.state.lock();
		let keys = state
			.diagnostic_events
			.keys()
			.filter(|(_, candidate)| *candidate == document_id)
			.copied()
			.collect::<Vec<_>>();
		let mut seen = HashSet::new();
		let mut events = Vec::new();
		for key in keys {
			let Some(record) = state.diagnostic_events.get(&key) else {
				continue;
			};
			let event_revision = record.event.revision().or_else(|| {
				(record.observed_at.elapsed() >= Duration::from_millis(250))
					.then(|| {
						let version = state.public_versions.get(&key)?.back()?.1;
						state
							.bindings
							.get(&key.0)?
							.server
							.revision_for_version(record.event.document_uri()?, version)
					})
					.flatten()
			});
			if event_revision != Some(revision) {
				if event_revision.is_some() {
					state.diagnostic_events.remove(&key);
				}
				continue;
			}
			let Some(mut record) = state.diagnostic_events.remove(&key) else {
				continue;
			};
			record.event.revision = Some(revision);
			if !deduplicate || seen.insert(record.payload) {
				events.push(record.event);
			}
		}
		events.sort_by_key(|event| event.binding_id());
		events
	}

	fn should_publish_diagnostics(&self, event: &TaggedLspEvent) -> bool {
		let Some(document_id) = event.document_id() else {
			return true;
		};
		let version = serde_json::from_slice::<Value>(event.params_json())
			.ok()
			.and_then(|value| value.get("version").and_then(Value::as_i64));
		let next = DiagnosticRecord {
			version,
			payload: Hash32::sum(event.params_json()),
			event: event.clone(),
			observed_at: Instant::now(),
		};
		let mut state = self.inner.state.lock();
		let key = (event.binding_id(), document_id);
		if let Some(current) = state.diagnostic_events.get(&key) {
			if current.payload == next.payload {
				return false;
			}
			if matches!((current.version, next.version), (Some(current), Some(next)) if next < current)
			{
				return false;
			}
		}
		state.diagnostic_events.insert(key, next);
		true
	}

	fn binding_document_ids(&self, binding_id: LspBindingId) -> HashSet<DocumentId> {
		self
			.inner
			.state
			.lock()
			.leases
			.values()
			.filter(|record| record.binding_ids.contains(&binding_id))
			.map(|record| record.document_id)
			.collect()
	}

	fn schedule_policy_reconciliation(
		&self,
		binding: Binding,
		affected: HashSet<DocumentId>,
		cancel: CancellationToken,
	) {
		let registry = self.clone();
		tokio::spawn(async move {
			let _mutation = registry.inner.mutation.lock().await;
			let is_current = registry
				.inner
				.state
				.lock()
				.bindings
				.get(&binding.id)
				.is_some_and(|current| current.generation == binding.generation);
			if !is_current || registry.refresh_all_documents(cancel).await.is_err() {
				return;
			}
			for document_id in affected {
				registry.publish_binding_event(
					binding.id,
					Some(document_id),
					LspBindingEventKind::PolicyChanged,
				);
			}
		});
	}

	fn publish_binding_event(
		&self,
		binding_id: LspBindingId,
		document_id: Option<DocumentId>,
		kind: LspBindingEventKind,
	) {
		let _ = self
			.inner
			.events
			.send(LspRegistryEvent::Binding(LspBindingEvent { binding_id, document_id, kind }));
	}

	async fn refresh_all_documents(
		&self,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let ids = self
			.inner
			.state
			.lock()
			.leases
			.values()
			.map(|record| record.document_id)
			.collect::<HashSet<_>>();
		for document_id in ids {
			self
				.refresh_document(document_id, cancel.child_token())
				.await?;
		}
		Ok(())
	}

	async fn refresh_document(
		&self,
		document_id: DocumentId,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let records = self
			.lease_records()
			.into_iter()
			.filter(|(_, record)| record.document_id == document_id)
			.collect::<Vec<_>>();
		if records.is_empty() {
			return Ok(());
		}
		let (snapshot, uri) = self.current_snapshot(document_id).await?;
		let bindings = self.sorted_bindings();
		let mut desired_by_lease = HashMap::new();
		let mut desired_counts = HashMap::<LspBindingId, usize>::new();
		let mut desired_languages = HashMap::<LspBindingId, Option<LanguageId>>::new();
		let mut current_counts = HashMap::<LspBindingId, usize>::new();
		let mut current_languages = HashMap::<LspBindingId, Option<LanguageId>>::new();
		for (lease_id, record) in &records {
			for id in &record.binding_ids {
				*current_counts.entry(*id).or_default() += 1;
				current_languages
					.entry(*id)
					.or_insert_with(|| record.language_id.clone());
			}
			let desired = bindings
				.iter()
				.filter(|binding| binding.spec.matches(&uri, record.language_id.as_ref()))
				.map(|binding| binding.id)
				.collect::<Vec<_>>();
			for id in &desired {
				*desired_counts.entry(*id).or_default() += 1;
				desired_languages
					.entry(*id)
					.or_insert_with(|| record.language_id.clone());
			}
			desired_by_lease.insert(*lease_id, desired);
		}

		let mut progress = Vec::new();
		for binding in bindings {
			let binding_id = binding.id;
			let server = binding.server.clone();
			let current = current_counts.get(&binding_id).copied().unwrap_or(0);
			let desired = desired_counts.get(&binding_id).copied().unwrap_or(0);
			let current_language = current_languages.get(&binding_id).cloned().flatten();
			let index = progress.len();
			progress.push(RefreshProgress {
				binding,
				original_count: current,
				opened: false,
				retained: 0,
				released: 0,
				current_language,
			});
			if desired > 0 {
				let version = match server
					.synchronize(
						lsp_document(
							&snapshot,
							&uri,
							desired_languages.get(&binding_id).and_then(Option::as_ref),
						),
						cancel.child_token(),
					)
					.await
				{
					Ok(version) => version,
					Err(error) => {
						self
							.compensate_refresh(document_id, &snapshot, &uri, &progress)
							.await;
						return Err(error.into());
					},
				};
				progress[index].opened = current == 0;
				self.mark_public_version(binding_id, document_id, &uri, version);
				for _ in current.max(1)..desired {
					if let Err(error) = server.retain_document(document_id).await {
						self
							.compensate_refresh(document_id, &snapshot, &uri, &progress)
							.await;
						return Err(error.into());
					}
					progress[index].retained += 1;
				}
			}
			if current > desired {
				for _ in desired..current {
					if let Err(error) = server
						.release_document(document_id, cancel.child_token())
						.await
					{
						self
							.compensate_refresh(document_id, &snapshot, &uri, &progress)
							.await;
						return Err(error.into());
					}
					progress[index].released += 1;
				}
			}
		}

		let mut state = self.inner.state.lock();
		for (lease_id, binding_ids) in desired_by_lease {
			state
				.leases
				.get_mut(&lease_id)
				.expect("lease retained under mutation gate")
				.binding_ids = binding_ids;
		}
		for binding_id in current_counts.keys().chain(desired_counts.keys()) {
			let desired = desired_counts.get(binding_id).copied().unwrap_or(0);
			if desired == 0 {
				state.public_versions.remove(&(*binding_id, document_id));
			}
		}
		Ok(())
	}

	async fn compensate_refresh(
		&self,
		document_id: DocumentId,
		snapshot: &DocumentSnapshot,
		uri: &Url,
		progress: &[RefreshProgress],
	) {
		for item in progress.iter().rev() {
			if item.released > 0 {
				let remaining = item.original_count.saturating_sub(item.released);
				if remaining == 0 {
					if let Ok(version) = item
						.binding
						.server
						.synchronize(
							lsp_document(snapshot, uri, item.current_language.as_ref()),
							CancellationToken::new(),
						)
						.await
					{
						self.mark_public_version(item.binding.id, document_id, uri, version);
						for _ in 1..item.released {
							let _ = item.binding.server.retain_document(document_id).await;
						}
					}
				} else {
					for _ in 0..item.released {
						let _ = item.binding.server.retain_document(document_id).await;
					}
				}
			}
			for _ in 0..item.retained {
				if item
					.binding
					.server
					.release_document(document_id, CancellationToken::new())
					.await
					.is_err()
				{
					item
						.binding
						.server
						.abandon_document_lease(document_id)
						.await;
				}
			}
			if item.opened {
				if item
					.binding
					.server
					.release_document(document_id, CancellationToken::new())
					.await
					.is_err()
				{
					item
						.binding
						.server
						.abandon_document_lease(document_id)
						.await;
				}
				self
					.inner
					.state
					.lock()
					.public_versions
					.remove(&(item.binding.id, document_id));
			}
		}
	}

	fn sorted_bindings(&self) -> Vec<Binding> {
		let mut bindings = self
			.inner
			.state
			.lock()
			.bindings
			.values()
			.cloned()
			.collect::<Vec<_>>();
		bindings.sort_by(binding_order);
		bindings
	}

	fn matching_bindings(&self, uri: &Url, language_id: Option<&LanguageId>) -> Vec<Binding> {
		self
			.sorted_bindings()
			.into_iter()
			.filter(|binding| binding.spec.matches(uri, language_id))
			.collect()
	}

	fn binding(&self, binding_id: LspBindingId) -> Result<Binding, LspRegistryError> {
		self
			.inner
			.state
			.lock()
			.bindings
			.get(&binding_id)
			.cloned()
			.ok_or(LspRegistryError::UnknownBinding { binding_id })
	}

	fn binding_for_handle(&self, handle: LspBindingHandle) -> Result<Binding, LspRegistryError> {
		let binding = self.binding(handle.binding_id)?;
		if binding.generation != handle.generation {
			return Err(LspRegistryError::BindingRestarted { binding_id: handle.binding_id });
		}
		Ok(binding)
	}

	async fn cleanup_replacement_leases(
		&self,
		server: &LspServer,
		acquired: &[(DocumentId, usize)],
	) {
		for (document_id, count) in acquired.iter().rev() {
			for _ in 0..*count {
				if server
					.release_document(*document_id, CancellationToken::new())
					.await
					.is_err()
				{
					server.abandon_document_lease(*document_id).await;
				}
			}
		}
	}

	fn lease_record(&self, lease_id: LeaseId) -> Result<LeaseRecord, LspRegistryError> {
		self
			.inner
			.state
			.lock()
			.leases
			.get(&lease_id)
			.cloned()
			.ok_or(LspRegistryError::UnknownLease { lease_id })
	}

	fn lease_records(&self) -> Vec<(LeaseId, LeaseRecord)> {
		self
			.inner
			.state
			.lock()
			.leases
			.iter()
			.map(|(id, record)| (*id, record.clone()))
			.collect()
	}

	fn binding_document_count(&self, binding_id: LspBindingId, document_id: DocumentId) -> usize {
		self
			.inner
			.state
			.lock()
			.leases
			.values()
			.filter(|record| {
				record.document_id == document_id && record.binding_ids.contains(&binding_id)
			})
			.count()
	}

	async fn current_snapshot(
		&self,
		document_id: DocumentId,
	) -> Result<(Arc<DocumentSnapshot>, Url), LspRegistryError> {
		let state = self
			.inner
			.store
			.actor_handle(document_id)?
			.ready_state()
			.await?;
		let snapshot = state
			.head
			.ok_or(LspRegistryError::DocumentNotActivated { document_id })?;
		let uri = Url::from_file_path(&state.path)
			.map_err(|()| LspRegistryError::PathCannotBeUri { path: state.path })?;
		Ok((snapshot, uri))
	}

	async fn document_uri(&self, document_id: DocumentId) -> Result<Url, LspRegistryError> {
		Ok(self.current_snapshot(document_id).await?.1)
	}

	async fn snapshot_from_store(
		&self,
		lease_id: LeaseId,
		revision: Option<Revision>,
	) -> Result<Arc<DocumentSnapshot>, LspRegistryError> {
		let read = self
			.inner
			.store
			.read(lease_id, revision, ReadSelection::Whole)
			.await?;
		let content = match read.body() {
			ReadBody::Whole(content) => content.clone(),
			ReadBody::Slices(_) => unreachable!("whole selection returns whole bytes"),
		};
		Ok(Arc::new(DocumentSnapshot::new(read.head().clone(), content)?))
	}

	fn ensure_binding_generation(
		&self,
		binding_id: LspBindingId,
		generation: u64,
	) -> Result<(), LspRegistryError> {
		if self
			.inner
			.state
			.lock()
			.bindings
			.get(&binding_id)
			.is_some_and(|binding| binding.generation == generation)
		{
			Ok(())
		} else {
			Err(LspRegistryError::BindingRestarted { binding_id })
		}
	}

	fn mark_public_version_if_current(
		&self,
		binding: &Binding,
		document_id: DocumentId,
		uri: &Url,
		version: i32,
	) -> bool {
		let mut state = self.inner.state.lock();
		if state
			.bindings
			.get(&binding.id)
			.is_none_or(|current| current.generation != binding.generation)
		{
			return false;
		}
		record_public_version(&mut state, binding.id, document_id, uri, version);
		true
	}

	fn mark_public_version(
		&self,
		binding_id: LspBindingId,
		document_id: DocumentId,
		uri: &Url,
		version: i32,
	) {
		let mut state = self.inner.state.lock();
		record_public_version(&mut state, binding_id, document_id, uri, version);
	}

	async fn acquire_format_leases(
		&self,
		request: &FormatRequest,
		cancel: CancellationToken,
	) -> Result<FormatLeaseSet, LspRegistryError> {
		let _mutation = self.inner.mutation.lock().await;
		let document_id = request.base().head().document_id();
		let base_language_id = language_for_head(request.base().head()).cloned();
		let all_bindings = self.sorted_bindings();
		let base_uri = match self.current_snapshot(document_id).await {
			Ok((_, uri)) => uri,
			Err(_error)
				if all_bindings
					.iter()
					.all(|binding| self.binding_document_count(binding.id, document_id) == 0) =>
			{
				request.uri().clone()
			},
			Err(error) => return Err(error),
		};
		let bindings = all_bindings
			.into_iter()
			.filter(|binding| binding.spec.matches(&base_uri, base_language_id.as_ref()))
			.collect::<Vec<_>>();
		let shadow_document = format_shadow_document(request);
		let shadow_uri = format_shadow_uri(request);
		let snapshot =
			provisional_snapshot_for(shadow_document, request.base(), request.candidate().clone())?;
		let mut acquired = Vec::new();
		for binding in &bindings {
			let key = ProvisionalLeaseKey {
				binding_id: binding.id,
				document_id,
				transaction: request.transaction_id(),
				shadow_document,
			};
			if self.inner.state.lock().provisional_leases.contains(&key) {
				acquired.push(FormatBindingLease { binding: binding.clone() });
				continue;
			}
			if let Err(error) = binding
				.server
				.synchronize(
					lsp_document(&snapshot, &shadow_uri, base_language_id.as_ref()),
					cancel.child_token(),
				)
				.await
			{
				self.release_shadow(binding, shadow_document).await;
				self
					.rollback_format_acquisition(
						document_id,
						request.transaction_id(),
						shadow_document,
						&mut acquired,
					)
					.await;
				return Err(error.into());
			}
			self.inner.state.lock().provisional_leases.insert(key);
			acquired.push(FormatBindingLease { binding: binding.clone() });
		}
		Ok(FormatLeaseSet {
			bindings: acquired,
			shadow_document,
			shadow_uri,
			policy_uri: base_uri,
			base_language_id,
		})
	}

	async fn rollback_format_acquisition(
		&self,
		document_id: DocumentId,
		transaction_id: TransactionId,
		shadow_document: DocumentId,
		acquired: &mut Vec<FormatBindingLease>,
	) {
		for lease in acquired.drain(..).rev() {
			let key = ProvisionalLeaseKey {
				binding_id: lease.binding.id,
				document_id,
				transaction: transaction_id,
				shadow_document,
			};
			if self.inner.state.lock().provisional_leases.remove(&key) {
				self.release_shadow(&lease.binding, shadow_document).await;
			}
		}
	}

	async fn release_shadow(&self, binding: &Binding, shadow_document: DocumentId) {
		if binding
			.server
			.tracked_version_revision(shadow_document)
			.is_none()
		{
			return;
		}
		if binding
			.server
			.release_document(shadow_document, CancellationToken::new())
			.await
			.is_err()
		{
			binding.server.abandon_document_lease(shadow_document).await;
		}
	}

	async fn release_provisional_in_gate(
		&self,
		bindings: &[Binding],
		document_id: DocumentId,
		transaction_id: TransactionId,
		close_public_when_unleased: bool,
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let mut first_error = None;
		for binding in bindings {
			let keys = self
				.inner
				.state
				.lock()
				.provisional_leases
				.iter()
				.copied()
				.filter(|key| {
					key.binding_id == binding.id
						&& key.document_id == document_id
						&& key.transaction == transaction_id
				})
				.collect::<Vec<_>>();
			for key in keys {
				if let Err(error) = binding
					.server
					.release_document(key.shadow_document, cancel.child_token())
					.await
				{
					binding
						.server
						.abandon_document_lease(key.shadow_document)
						.await;
					if first_error.is_none() {
						first_error = Some(LspRegistryError::from(error));
					}
				}
				self.inner.state.lock().provisional_leases.remove(&key);
			}
			if close_public_when_unleased
				&& self.binding_document_count(binding.id, document_id) == 0
				&& binding
					.server
					.tracked_version_revision(document_id)
					.is_some()
				&& let Err(error) = binding
					.server
					.release_document(document_id, cancel.child_token())
					.await
			{
				binding.server.abandon_document_lease(document_id).await;
				if first_error.is_none() {
					first_error = Some(LspRegistryError::from(error));
				}
			}
			if self.binding_document_count(binding.id, document_id) == 0 {
				self
					.inner
					.state
					.lock()
					.public_versions
					.remove(&(binding.id, document_id));
			}
		}
		match first_error {
			Some(error) => Err(error),
			None => Ok(()),
		}
	}

	async fn format_candidate_inner(
		&self,
		request: &FormatRequest,
		leases: &FormatLeaseSet,
		cancel: CancellationToken,
	) -> Result<Bytes, LspRegistryError> {
		if leases.bindings.is_empty() {
			return Err(LspRegistryError::FormattingUnavailable);
		}
		let bindings = &leases.bindings;
		let uri = &leases.shadow_uri;
		let policy_uri = &leases.policy_uri;
		let language_id = leases.base_language_id.as_ref();
		let mut content = request.candidate().clone();
		let mut performed = false;
		for binding in bindings {
			let binding = &binding.binding;
			let mut snapshot =
				provisional_snapshot_for(leases.shadow_document, request.base(), content.clone())?;
			binding
				.server
				.synchronize(lsp_document(&snapshot, uri, language_id), cancel.child_token())
				.await?;
			let policy = binding.server.sync_policy(policy_uri, language_id);
			if policy.will_save {
				binding
					.server
					.will_save(lsp_document(&snapshot, uri, language_id), 1, cancel.child_token())
					.await?;
			}
			if policy.will_save_wait_until {
				content = binding
					.server
					.will_save_wait_until(
						lsp_document(&snapshot, uri, language_id),
						1,
						cancel.child_token(),
					)
					.await?;
				performed = true;
				snapshot =
					provisional_snapshot_for(leases.shadow_document, request.base(), content.clone())?;
				binding
					.server
					.synchronize(lsp_document(&snapshot, uri, language_id), cancel.child_token())
					.await?;
			}
			if binding.server.supports_formatting(policy_uri, language_id) {
				content = binding
					.server
					.format_document(
						lsp_document(&snapshot, uri, language_id),
						Bytes::from(
							serde_json::to_vec(&format_options::resolve(
								str::from_utf8(&content).unwrap_or_default(),
								None,
							))
							.map_err(|error| LspRegistryError::InvalidInboundJson {
								reason: Str::new(error.to_string()),
							})?,
						),
						cancel.child_token(),
					)
					.await?;
				performed = true;
				snapshot =
					provisional_snapshot_for(leases.shadow_document, request.base(), content.clone())?;
				binding
					.server
					.synchronize(lsp_document(&snapshot, uri, language_id), cancel.child_token())
					.await?;
			}
		}
		if !performed {
			return Err(LspRegistryError::FormattingUnavailable);
		}
		let snapshot =
			provisional_snapshot_for(leases.shadow_document, request.base(), content.clone())?;
		for binding in bindings {
			binding
				.binding
				.server
				.synchronize(lsp_document(&snapshot, uri, language_id), cancel.child_token())
				.await?;
		}
		let text = str::from_utf8(&content).map_err(|_| LspRegistryError::FormattingUnavailable)?;
		let options = format_options::resolve(text, None);
		Ok(Bytes::copy_from_slice(format_options::enforce(text, options).as_bytes()))
	}

	async fn publish_committed_inner(
		&self,
		document: &PublishedDocument,
		bindings: &[Binding],
		cancel: CancellationToken,
	) -> Result<(), LspRegistryError> {
		let snapshot = DocumentSnapshot::new(document.head().clone(), document.content().clone())?;
		let language_id = language_for_head(document.head());
		for binding in bindings {
			let version = binding
				.server
				.synchronize(lsp_document(&snapshot, document.uri(), language_id), cancel.child_token())
				.await?;
			self.mark_public_version(
				binding.id,
				document.head().document_id(),
				document.uri(),
				version,
			);
			if binding.server.sync_policy(document.uri(), language_id).save {
				binding
					.server
					.did_save(lsp_document(&snapshot, document.uri(), language_id), cancel.child_token())
					.await?;
			}
		}
		let mut changes = Vec::with_capacity(2);
		if let Some(previous) = document.previous_uri().filter(|uri| *uri != document.uri()) {
			changes.push(LspWatchedFileChange {
				uri:  previous.clone(),
				kind: LspWatchedFileKind::Deleted,
			});
			changes.push(LspWatchedFileChange {
				uri:  document.uri().clone(),
				kind: LspWatchedFileKind::Created,
			});
		} else {
			let kind = if document.head().presence() == DocumentPresence::Missing {
				LspWatchedFileKind::Deleted
			} else if document.head().revision().sequence() <= 1 {
				LspWatchedFileKind::Created
			} else {
				LspWatchedFileKind::Changed
			};
			changes.push(LspWatchedFileChange { uri: document.uri().clone(), kind });
		}
		for binding in bindings.iter().cloned() {
			binding
				.server
				.did_change_watched_files(&changes, cancel.child_token())
				.await?;
		}
		Ok(())
	}
}

impl FormatCoordinator for LspRegistry {
	async fn format_candidate(
		&self,
		request: FormatRequest,
		cancel: CancellationToken,
	) -> DocumentResult<FormatResult> {
		let leases = self
			.acquire_format_leases(&request, cancel.child_token())
			.await
			.map_err(registry_protocol_error)?;
		match self.format_candidate_inner(&request, &leases, cancel).await {
			Ok(content) => Ok(FormatResult::new(content)),
			Err(error) => {
				let _mutation = self.inner.mutation.lock().await;
				let bindings = leases
					.bindings
					.iter()
					.map(|lease| lease.binding.clone())
					.collect::<Vec<_>>();
				let _ = self
					.release_provisional_in_gate(
						&bindings,
						request.base().head().document_id(),
						request.transaction_id(),
						false,
						CancellationToken::new(),
					)
					.await;
				Err(registry_protocol_error(error))
			},
		}
	}

	async fn publish_committed(
		&self,
		document: PublishedDocument,
		cancel: CancellationToken,
	) -> DocumentResult<()> {
		let _mutation = self.inner.mutation.lock().await;
		let refresh_result = if self
			.inner
			.state
			.lock()
			.leases
			.values()
			.any(|record| record.document_id == document.head().document_id())
		{
			self
				.refresh_document(document.head().document_id(), cancel.child_token())
				.await
		} else {
			Ok(())
		};
		let mut bindings = Vec::new();
		let mut included = HashSet::new();
		for binding in self.matching_bindings(document.uri(), language_for_head(document.head())) {
			if self.binding_document_count(binding.id, document.head().document_id()) > 0 {
				included.insert(binding.id);
				bindings.push(binding);
			}
		}
		let provisional_ids = self
			.inner
			.state
			.lock()
			.provisional_leases
			.iter()
			.filter(|key| {
				key.document_id == document.head().document_id()
					&& key.transaction == document.transaction_id()
			})
			.map(|key| key.binding_id)
			.collect::<Vec<_>>();
		for binding_id in provisional_ids {
			if included.insert(binding_id) {
				bindings.push(self.binding(binding_id).map_err(registry_protocol_error)?);
			}
		}
		let publish_result = match refresh_result {
			Ok(()) => {
				self
					.publish_committed_inner(&document, &bindings, cancel.child_token())
					.await
			},
			Err(error) => Err(error),
		};
		let release_result = self
			.release_provisional_in_gate(
				&bindings,
				document.head().document_id(),
				document.transaction_id(),
				true,
				cancel,
			)
			.await;
		publish_result
			.and(release_result)
			.map_err(registry_protocol_error)
	}

	async fn revert_uncommitted(
		&self,
		document: RevertedDocument,
		cancel: CancellationToken,
	) -> DocumentResult<()> {
		let _mutation = self.inner.mutation.lock().await;
		let snapshot = document.snapshot();
		let keys = self
			.inner
			.state
			.lock()
			.provisional_leases
			.iter()
			.copied()
			.filter(|key| {
				key.document_id == snapshot.head().document_id()
					&& key.transaction == document.transaction_id()
			})
			.collect::<Vec<_>>();
		let mut bindings = Vec::new();
		let mut included = HashSet::new();
		let mut first_error = None;
		for key in keys {
			match self.binding(key.binding_id) {
				Ok(binding) => {
					if included.insert(binding.id) {
						bindings.push(binding);
					}
				},
				Err(error) => {
					self.inner.state.lock().provisional_leases.remove(&key);
					if first_error.is_none() {
						first_error = Some(error);
					}
				},
			}
		}
		let release_result = self
			.release_provisional_in_gate(
				&bindings,
				snapshot.head().document_id(),
				document.transaction_id(),
				false,
				cancel,
			)
			.await;
		match first_error {
			Some(error) => Err(registry_protocol_error(error)),
			None => release_result.map_err(registry_protocol_error),
		}
	}
}

fn record_public_version(
	state: &mut RegistryState,
	binding_id: LspBindingId,
	document_id: DocumentId,
	uri: &Url,
	version: i32,
) {
	let entries = state
		.public_versions
		.entry((binding_id, document_id))
		.or_default();
	entries.retain(|(entry_uri, entry_version)| {
		entry_uri.as_str() != uri.as_str() || *entry_version != version
	});
	if entries.len() == PUBLIC_VERSION_LIMIT {
		entries.pop_front();
	}
	entries.push_back((Str::new(uri.as_str()), version));
}

fn format_shadow_document(request: &FormatRequest) -> DocumentId {
	let mut hasher = Hash32::hasher();
	hasher.update(b"omp-lsp-format-shadow-v1\0");
	hasher.update(request.base().head().document_id().as_bytes());
	hasher.update(request.transaction_id().as_bytes());
	hasher.update(request.operation_index().to_be_bytes());
	let mut bytes = [0; 16];
	bytes.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
	DocumentId::from_bytes(bytes)
}

fn format_shadow_uri(request: &FormatRequest) -> Url {
	let mut uri = request.uri().clone();
	uri.query_pairs_mut()
		.append_pair("omp-format-transaction", &request.transaction_id().to_string())
		.append_pair("omp-format-operation", &request.operation_index().to_string());
	uri
}
#[cfg(test)]
fn provisional_snapshot(
	base: &DocumentSnapshot,
	content: Bytes,
) -> DocumentResult<DocumentSnapshot> {
	provisional_snapshot_for(base.head().document_id(), base, content)
}

fn provisional_snapshot_for(
	document_id: DocumentId,
	base: &DocumentSnapshot,
	content: Bytes,
) -> DocumentResult<DocumentSnapshot> {
	let sequence = base
		.head()
		.revision()
		.sequence()
		.checked_add(1)
		.unwrap_or_else(|| base.head().revision().sequence());
	let revision = Revision::for_content(sequence, &content);
	let presence = DocumentPresence::Present;
	let head = DocumentHead::new(
		document_id,
		revision,
		presence,
		base.head().kind().clone(),
		content.len() as u64,
	)?;
	DocumentSnapshot::new(head, content)
}

const fn language_for_head(head: &DocumentHead) -> Option<&LanguageId> {
	match head.kind() {
		DocumentKind::Text(language_id) => language_id.as_ref(),
		DocumentKind::Binary => None,
	}
}

fn registry_protocol_error(error: LspRegistryError) -> DocumentError {
	DocumentError::Protocol { reason: Str::new(error.to_string()) }
}

const fn lsp_document<'a>(
	snapshot: &'a DocumentSnapshot,
	uri: &'a Url,
	language_id: Option<&'a LanguageId>,
) -> LspDocument<'a> {
	LspDocument { snapshot, uri, language_id }
}

/// Finds the nearest ancestor containing any configured root marker. Glob
/// markers are matched only against direct children of each ancestor.
pub fn root_marker_ancestor(file: &Path, markers: &[Str]) -> Option<PathBuf> {
	let mut directory = if file.is_dir() {
		file.to_owned()
	} else {
		file.parent()?.to_owned()
	};
	loop {
		if root_has_marker(&directory, markers) {
			return Some(directory);
		}
		if !directory.pop() {
			return None;
		}
	}
}

fn root_has_marker(directory: &Path, markers: &[Str]) -> bool {
	markers.iter().any(|marker| {
		let marker = marker.as_str();
		if marker == "." {
			return true;
		}
		if !marker.contains('*') {
			return directory.join(marker).exists();
		}
		let Ok(pattern) = PatternBuilder::new(marker).literal_separator(true).build() else {
			return false;
		};
		let Ok(entries) = fs::read_dir(directory) else {
			return false;
		};
		entries.filter_map(Result::ok).any(|entry| {
			entry
				.file_name()
				.to_str()
				.is_some_and(|name| pattern.matches(name))
		})
	})
}

fn binding_order(left: &Binding, right: &Binding) -> cmp::Ordering {
	right
		.spec
		.priority
		.cmp(&left.spec.priority)
		.then_with(|| left.spec.is_linter.cmp(&right.spec.is_linter))
		.then_with(|| left.spec.name.cmp(&right.spec.name))
		.then_with(|| left.id.cmp(&right.id))
}

fn binding_info_order(left: &LspBindingInfo, right: &LspBindingInfo) -> cmp::Ordering {
	right
		.spec
		.priority
		.cmp(&left.spec.priority)
		.then_with(|| left.spec.is_linter.cmp(&right.spec.is_linter))
		.then_with(|| left.spec.name.cmp(&right.spec.name))
		.then_with(|| left.id.cmp(&right.id))
}

/// A binding, selection, revision-admission, or delegated LSP failure.
#[derive(Debug, Error)]
pub enum LspRegistryError {
	/// A binding name was empty.
	#[error("LSP binding name must not be empty")]
	InvalidBindingName,
	/// A binding name is already installed.
	#[error("LSP binding {name} already exists")]
	DuplicateBinding {
		/// Duplicate binding name.
		name: Str,
	},
	/// A selector glob could not be compiled.
	#[error("invalid LSP selector: {reason}")]
	InvalidSelector {
		/// Selector diagnostic.
		reason: Str,
	},
	/// No installed binding has this identity.
	#[error("unknown LSP binding {}", binding_id.get())]
	UnknownBinding {
		/// Missing binding identity.
		binding_id: LspBindingId,
	},
	/// A topology operation cannot replace a binding while it owns provisional
	/// text.
	#[error("LSP binding {} has an active provisional document lease", binding_id.get())]
	BindingBusy {
		/// Busy binding identity.
		binding_id: LspBindingId,
	},
	/// An in-flight operation completed on a server generation that has been
	/// replaced.
	#[error("LSP binding {} restarted while the operation was in flight", binding_id.get())]
	BindingRestarted {
		/// Replaced binding identity.
		binding_id: LspBindingId,
	},
	/// No open registry lease has this identity.
	#[error("unknown LSP registry lease {lease_id}")]
	UnknownLease {
		/// Missing lease identity.
		lease_id: LeaseId,
	},
	/// The selected server is not bound to this document lease.
	#[error("LSP binding {} is not selected for document {document_id}", binding_id.get())]
	BindingNotSelected {
		/// Unselected binding identity.
		binding_id:  LspBindingId,
		/// Requested document identity.
		document_id: DocumentId,
	},
	/// A semantic request or response raced a different current head.
	#[error("document content modified: requested {requested}, current {current}")]
	ContentModified {
		/// Revision against which the operation was admitted.
		requested: Revision,
		/// Newest revision observed at rejection.
		current:   Revision,
	},
	/// A document actor had no activated immutable head.
	#[error("document {document_id} is not activated")]
	DocumentNotActivated {
		/// Document identity.
		document_id: DocumentId,
	},
	/// A canonical document path could not be represented as a file URI.
	#[error("document path cannot be represented as a file URI: {path:?}")]
	PathCannotBeUri {
		/// Canonical path.
		path: PathBuf,
	},
	/// Binding identities exhausted their integer representation.
	#[error("LSP binding identity overflow")]
	BindingIdOverflow,
	/// A binding's restart generation exhausted its integer representation.
	#[error("LSP binding {} restart generation overflow", binding_id.get())]
	BindingGenerationOverflow {
		/// Binding whose generation could not advance.
		binding_id: LspBindingId,
	},
	/// Inbound parameters were not exact valid JSON.
	#[error("invalid inbound LSP JSON: {reason}")]
	InvalidInboundJson {
		/// JSON diagnostic.
		reason: Str,
	},
	/// No selected server advertised an operation capable of formatting bytes.
	#[error("no selected LSP binding provides formatting")]
	FormattingUnavailable,
	/// A warmup task terminated before reporting its binding result.
	#[error("LSP warmup task failed: {source}")]
	WarmupTask {
		/// Join failure.
		#[source]
		source: task::JoinError,
	},
	/// A warmup task completed without filling its ordered result slot.
	#[error("LSP warmup result is missing")]
	WarmupResultMissing,
	/// The document store rejected the operation.
	#[error(transparent)]
	Store(#[from] DocumentError),
	/// The selected LSP lane rejected the operation.
	#[error(transparent)]
	Lsp(#[from] LspError),
}

#[cfg(test)]
mod tests {
	use std::{
		env, fs, future,
		sync::atomic::{AtomicBool, AtomicU64, Ordering},
	};

	use async_trait::async_trait;
	use omp_core::sf;
	use tokio::sync::Notify;

	use super::*;
	use crate::docserver::{
		DocumentPresence, ServerConfig, TransactionId,
		lsp::{LspTransport, LspTransportError},
	};
	struct NullTransport;

	#[async_trait]
	impl LspTransport for NullTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Ok(())
		}
	}

	struct HangingCloseTransport;

	#[async_trait]
	impl LspTransport for HangingCloseTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		async fn notify(
			&self,
			method: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			if method == "textDocument/didClose" {
				future::pending().await
			} else {
				Ok(())
			}
		}
	}

	struct PendingFormatTransport {
		started: Notify,
		release: Notify,
	}

	#[async_trait]
	impl LspTransport for PendingFormatTransport {
		async fn request(
			&self,
			method: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			if method == "textDocument/formatting" {
				self.started.notify_one();
				self.release.notified().await;
				Ok(Bytes::from_static(b"[]"))
			} else {
				Ok(Bytes::from_static(b"null"))
			}
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Ok(())
		}
	}
	struct CountingTransport {
		messages: AtomicU64,
	}

	#[async_trait]
	impl LspTransport for CountingTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			self.messages.fetch_add(1, Ordering::Relaxed);
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			self.messages.fetch_add(1, Ordering::Relaxed);
			Ok(())
		}
	}

	struct PendingRequestTransport {
		started: Notify,
		release: Notify,
	}

	#[async_trait]
	impl LspTransport for PendingRequestTransport {
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			self.started.notify_one();
			self.release.notified().await;
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Ok(())
		}
	}

	struct RequestCountingTransport {
		requests: AtomicU64,
	}

	#[async_trait]
	impl LspTransport for RequestCountingTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			self.requests.fetch_add(1, Ordering::Relaxed);
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Ok(())
		}
	}

	struct FailingNotifyTransport;

	#[async_trait]
	impl LspTransport for FailingNotifyTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			Err(LspTransportError::Closed { message: sf!("injected failure") })
		}
	}

	struct ToggleNotifyTransport {
		fail:   AtomicBool,
		params: Mutex<Vec<Bytes>>,
	}

	#[async_trait]
	impl LspTransport for ToggleNotifyTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			params: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			self.params.lock().push(params);
			if self.fail.load(Ordering::Relaxed) {
				Err(LspTransportError::Closed { message: sf!("injected failure") })
			} else {
				Ok(())
			}
		}
	}

	struct FailSecondNotifyTransport {
		notifications: AtomicU64,
	}

	#[async_trait]
	impl LspTransport for FailSecondNotifyTransport {
		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async request implementation"
		)]
		async fn request(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<Bytes, LspTransportError> {
			Ok(Bytes::from_static(b"null"))
		}

		#[allow(
			unknown_lints,
			reason = "unused_async_trait_impl is not available on every supported nightly"
		)]
		#[allow(
			clippy::unused_async_trait_impl,
			reason = "LspTransport requires an async notification implementation"
		)]
		async fn notify(
			&self,
			_: &str,
			_: Bytes,
			_: CancellationToken,
		) -> Result<(), LspTransportError> {
			if self.notifications.fetch_add(1, Ordering::Relaxed) == 1 {
				Err(LspTransportError::Closed { message: sf!("injected second notification failure") })
			} else {
				Ok(())
			}
		}
	}

	fn server() -> LspServer {
		LspServer::new(
			Arc::new(NullTransport),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap()
	}

	fn binding(id: u64, name: &str, priority: i32) -> Binding {
		Binding {
			id:         LspBindingId(id),
			spec:       LspBindingSpec::new(name, priority, LspSelector::all()).unwrap(),
			server:     server(),
			generation: 0,
		}
	}
	#[tokio::test]
	async fn reload_emits_exact_active_settings_without_restarting() {
		let root = tempfile::tempdir().unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(root.path()).unwrap()).unwrap());
		let configured =
			Bytes::from_static(br#"{"settings":{"rust-analyzer":{"cargo":{"features":["all"]}}}}"#);
		let empty = Bytes::from_static(br#"{"settings":{}}"#);

		for (name, settings_json) in [("configured", configured), ("empty", empty)] {
			let transport = Arc::new(ToggleNotifyTransport {
				fail:   AtomicBool::new(false),
				params: Mutex::new(Vec::new()),
			});
			let server = LspServer::new(
				transport.clone(),
				Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
			)
			.unwrap();
			let binding_id = registry
				.add_binding(
					LspBindingSpec::new(name, 0, LspSelector::all())
						.unwrap()
						.with_settings_json(settings_json.clone()),
					server,
					CancellationToken::new(),
				)
				.await
				.unwrap();

			registry
				.reload_binding(binding_id, None, CancellationToken::new())
				.await
				.unwrap();

			assert_eq!(transport.params.lock().as_slice(), &[settings_json]);
			assert_eq!(registry.binding(binding_id).unwrap().generation, 0);
		}
	}

	#[tokio::test]
	async fn inbound_publication_preserves_bytes_and_proven_revision_identity() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(20_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-events-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let binding_id = registry
			.add_binding(
				LspBindingSpec::new("events", 0, LspSelector::all()).unwrap(),
				server(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let handle = registry.binding_handle(binding_id).unwrap();
		let document_id = DocumentId::from_bytes([7; 16]);
		let content = Bytes::from_static(b"published");
		let revision = Revision::for_content(1, &content);
		let head = DocumentHead::new(
			document_id,
			revision,
			DocumentPresence::Present,
			DocumentKind::Text(None),
			content.len() as u64,
		)
		.unwrap();
		let snapshot = DocumentSnapshot::new(head, content).unwrap();
		let uri = Url::from_file_path(root.join("published.txt")).unwrap();
		let bound = registry.binding(binding_id).unwrap();
		let version = bound
			.server
			.synchronize(lsp_document(&snapshot, &uri, None), CancellationToken::new())
			.await
			.unwrap();
		registry.mark_public_version(binding_id, document_id, &uri, version);
		let params_json =
			Bytes::from(format!(r#"{{"uri":"{uri}","version":{version},"diagnostics":[]}}"#));
		let mut events = registry.subscribe_events();

		let tagged = registry
			.publish_inbound_event(handle, "textDocument/publishDiagnostics", params_json.clone())
			.unwrap();

		assert_eq!(tagged.params_json(), &params_json);
		assert_eq!(tagged.revision(), Some(revision));
		assert_eq!(tagged.document_id(), Some(document_id));
		assert_eq!(tagged.document_uri(), Some(&uri));
		assert_eq!(events.recv().await.unwrap(), LspRegistryEvent::Inbound(Box::new(tagged)));
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn selector_requires_every_declared_dimension() {
		let selector =
			LspSelector::new(vec![LanguageId::new("rust").unwrap()], vec![sf!("file")], vec![sf!(
				"**/*.rs"
			)])
			.unwrap();
		let rust = LanguageId::new("rust").unwrap();
		let python = LanguageId::new("python").unwrap();
		assert!(selector.matches(&Url::parse("file:///project/src/lib.rs").unwrap(), Some(&rust)));
		assert!(!selector.matches(&Url::parse("file:///project/src/lib.py").unwrap(), Some(&rust)));
		assert!(!selector.matches(&Url::parse("file:///project/src/lib.rs").unwrap(), Some(&python)));
		assert!(
			!selector.matches(&Url::parse("untitled:///project/src/lib.rs").unwrap(), Some(&rust))
		);
	}

	#[test]
	fn file_types_route_extensions_and_exact_filenames() {
		let selector =
			LspSelector::for_file_types(&[Str::new_static(".rs"), Str::new_static("Dockerfile")])
				.unwrap();
		assert!(selector.matches(&Url::parse("file:///project/src/lib.rs").unwrap(), None));
		assert!(selector.matches(&Url::parse("file:///project/Dockerfile").unwrap(), None));
		assert!(!selector.matches(&Url::parse("file:///project/Dockerfile.dev").unwrap(), None));
	}

	#[test]
	fn root_markers_walk_ancestors_and_match_one_level_globs() {
		let root = tempfile::tempdir().unwrap();
		fs::write(root.path().join("workspace.cabal"), b"").unwrap();
		let nested = root.path().join("src/nested");
		fs::create_dir_all(&nested).unwrap();
		let found =
			root_marker_ancestor(&nested.join("Main.hs"), &[Str::new_static("*.cabal")]).unwrap();
		assert_eq!(found, root.path());
		assert!(
			root_marker_ancestor(&nested.join("Main.hs"), &[Str::new_static("go.mod")]).is_none()
		);
	}

	#[test]
	fn bindings_order_by_priority_name_then_identity() {
		let mut bindings = [binding(3, "zeta", 10), binding(2, "alpha", 10), binding(1, "low", 1)];
		bindings.sort_by(binding_order);
		assert_eq!(
			bindings
				.iter()
				.map(|binding| binding.id.get())
				.collect::<Vec<_>>(),
			vec![2, 3, 1],
		);

		let mut primary = binding(4, "z-primary", 10);
		let mut linter = binding(5, "a-linter", 10);
		linter.spec = linter.spec.with_linter(true);
		let mut same_priority = [linter, primary.clone()];
		same_priority.sort_by(binding_order);
		assert_eq!(same_priority[0].id, primary.id);
		primary.spec = primary.spec.with_linter(false);
	}

	#[test]
	fn provisional_snapshot_never_mutates_the_committed_base() {
		let content = Bytes::from_static(b"base");
		let revision = Revision::for_content(4, &content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([9; 16]),
			revision,
			DocumentPresence::Present,
			DocumentKind::Text(None),
			content.len() as u64,
		)
		.unwrap();
		let base = DocumentSnapshot::new(head, content).unwrap();
		let provisional = provisional_snapshot(&base, Bytes::from_static(b"candidate")).unwrap();
		assert_eq!(base.content(), &Bytes::from_static(b"base"));
		assert_eq!(provisional.content(), &Bytes::from_static(b"candidate"));
		assert_ne!(base.head().revision(), provisional.head().revision());
	}
	#[test]
	fn empty_provisional_text_remains_present() {
		let content = Bytes::new();
		let revision = Revision::for_content(1, &content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([4; 16]),
			revision,
			DocumentPresence::Missing,
			DocumentKind::Text(None),
			0,
		)
		.unwrap();
		let base = DocumentSnapshot::new(head, content).unwrap();
		let provisional = provisional_snapshot(&base, Bytes::new()).unwrap();
		assert_eq!(provisional.head().presence(), DocumentPresence::Present);
	}

	#[tokio::test]
	async fn dynamic_registration_completes_while_formatting_is_pending() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let path = root.join("file.txt");
		fs::write(&path, b"base").unwrap();
		let store = DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap();
		let registry = LspRegistry::new(store);
		let transport =
			Arc::new(PendingFormatTransport { started: Notify::new(), release: Notify::new() });
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(
				br#"{"documentFormattingProvider":true,"textDocumentSync":{"openClose":true,"change":1}}"#,
			),
		).unwrap();
		let binding_id = registry
			.add_binding(
				LspBindingSpec::new(
					"formatter",
					0,
					LspSelector::new(Vec::new(), vec![sf!("file")], vec![sf!("**/file.txt",)]).unwrap(),
				)
				.unwrap(),
				server,
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let binding_handle = registry.binding_handle(binding_id).unwrap();
		let opened = registry.inner.store.open(path.clone()).await.unwrap();
		let (base_lease, head, _) = opened.into_parts();
		let base = registry
			.snapshot_from_store(base_lease, None)
			.await
			.unwrap();
		let uri = Url::from_file_path(&path).unwrap();
		let document_id = head.document_id();
		let transaction_id = TransactionId::from_bytes([6; 16]);
		let rollback_base = base.clone();
		let rollback_uri = uri.clone();
		let request = FormatRequest::new(
			transaction_id,
			0,
			base,
			uri.clone(),
			None,
			Bytes::from_static(b"candidate"),
		);
		let first_shadow_document = format_shadow_document(&request);
		let formatting_registry = registry.clone();
		let formatting = tokio::spawn(async move {
			formatting_registry
				.format_candidate(request, CancellationToken::new())
				.await
		});
		transport.started.notified().await;
		let opening_registry = registry.clone();
		let opening_path = path.clone();
		let public_open = tokio::spawn(async move {
			opening_registry
				.open_document(opening_path, None, CancellationToken::new())
				.await
		});
		timeout(
			Duration::from_secs(1),
			registry.register_capabilities(
				binding_handle,
				Bytes::from_static(
					br#"{"registrations":[{"id":"save","method":"textDocument/didSave"}]}"#,
				),
				CancellationToken::new(),
			),
		)
		.await
		.unwrap()
		.unwrap();
		transport.release.notify_one();
		assert_eq!(formatting.await.unwrap().unwrap().content(), &Bytes::from_static(b"candidate\n"),);
		let public_lease = timeout(Duration::from_secs(1), public_open)
			.await
			.unwrap()
			.unwrap()
			.unwrap();
		let second_request = FormatRequest::new(
			transaction_id,
			1,
			rollback_base.clone(),
			uri.clone(),
			None,
			Bytes::from_static(b"candidate-two"),
		);
		let second_shadow_document = format_shadow_document(&second_request);
		let second_shadow_uri = format_shadow_uri(&second_request);
		let second_registry = registry.clone();
		let second_format = tokio::spawn(async move {
			second_registry
				.format_candidate(second_request, CancellationToken::new())
				.await
		});
		transport.started.notified().await;
		transport.release.notify_one();
		assert_eq!(
			second_format.await.unwrap().unwrap().content(),
			&Bytes::from_static(b"candidate-two\n"),
		);
		let bound_server = registry.binding(binding_id).unwrap().server;
		let (version, _) = bound_server
			.tracked_version_revision(second_shadow_document)
			.unwrap();
		let diagnostics = Bytes::from(format!(
			r#"{{"uri":"{second_shadow_uri}","version":{version},"diagnostics":[]}}"#
		));
		assert_eq!(
			registry
				.tag_inbound_event(
					binding_handle,
					"textDocument/publishDiagnostics",
					diagnostics.clone(),
				)
				.unwrap()
				.revision(),
			None,
		);
		registry
			.revert_uncommitted(
				RevertedDocument::new(transaction_id, 0, rollback_base, rollback_uri, None),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		assert_eq!(bound_server.tracked_version_revision(first_shadow_document), None);
		assert_eq!(bound_server.tracked_version_revision(second_shadow_document), None);
		let (_, public_revision) = bound_server.tracked_version_revision(document_id).unwrap();
		assert_eq!(public_revision, head.revision());
		assert_eq!(
			registry
				.tag_inbound_event(binding_handle, "textDocument/publishDiagnostics", diagnostics,)
				.unwrap()
				.revision(),
			None,
		);
		registry
			.close_document(public_lease.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		registry.inner.store.close(base_lease).await.unwrap();
		fs::remove_dir_all(root).unwrap();
	}
	#[tokio::test]
	async fn unopened_unformatted_publication_emits_no_lifecycle() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(10_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-publish-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let transport = Arc::new(CountingTransport { messages: AtomicU64::new(0) });
		let server = LspServer::new(
			transport.clone(),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1,"save":true}}"#),
		)
		.unwrap();
		registry
			.add_binding(
				LspBindingSpec::new("unopened", 0, LspSelector::all()).unwrap(),
				server,
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let content = Bytes::from_static(b"committed");
		let revision = Revision::for_content(1, &content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([8; 16]),
			revision,
			DocumentPresence::Present,
			DocumentKind::Text(None),
			content.len() as u64,
		)
		.unwrap();
		registry
			.publish_committed(
				PublishedDocument::new(
					TransactionId::from_bytes([7; 16]),
					0,
					head,
					content,
					Url::from_file_path(root.join("unopened.txt")).unwrap(),
					None,
				),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		assert_eq!(transport.messages.load(Ordering::Relaxed), 0);
		fs::remove_dir_all(root).unwrap();
	}
	#[tokio::test]
	async fn restarted_binding_rejects_old_request_completion() {
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(env::temp_dir()).unwrap()).unwrap());
		let transport =
			Arc::new(PendingRequestTransport { started: Notify::new(), release: Notify::new() });
		let binding_id = registry
			.add_binding(
				LspBindingSpec::new("pending", 0, LspSelector::all()).unwrap(),
				LspServer::new(transport.clone(), Bytes::from_static(b"{}")).unwrap(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let old_handle = registry.binding_handle(binding_id).unwrap();
		let requesting_registry = registry.clone();
		let request = tokio::spawn(async move {
			requesting_registry
				.workspace_request(
					binding_id,
					"workspace/symbol",
					Bytes::from_static(br#"{"query":"x"}"#),
					CancellationToken::new(),
				)
				.await
		});
		transport.started.notified().await;
		registry
			.restart_binding(binding_id, server(), CancellationToken::new())
			.await
			.unwrap();
		transport.release.notify_one();
		assert!(matches!(
			request.await.unwrap(),
			Err(LspRegistryError::BindingRestarted { binding_id: rejected })
				if rejected == binding_id
		));
		assert!(matches!(
			registry.publish_inbound_event(
				old_handle,
				"window/logMessage",
				Bytes::from_static(br#"{"type":3,"message":"late"}"#),
			),
			Err(LspRegistryError::BindingRestarted { binding_id: rejected })
				if rejected == binding_id
		));
	}

	#[tokio::test]
	async fn opaque_stale_semantic_params_are_not_retried() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(30_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-stale-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let path = root.join("file.txt");
		fs::write(&path, b"current").unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let transport = Arc::new(RequestCountingTransport { requests: AtomicU64::new(0) });
		let binding_id = registry
			.add_binding(
				LspBindingSpec::new("semantic", 0, LspSelector::all()).unwrap(),
				LspServer::new(
					transport.clone(),
					Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
				)
				.unwrap(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let lease = registry
			.open_document(path, None, CancellationToken::new())
			.await
			.unwrap();
		let stale =
			Revision::for_content(lease.head().revision().sequence(), &Bytes::from_static(b"stale"));
		assert!(matches!(
			registry
				.semantic_request(
					binding_id,
					"textDocument/hover",
					Bytes::from_static(
						br#"{"textDocument":{"uri":"file:///file.txt"},"position":{"line":0,"character":0}}"#,
					),
					lease.lease_id(),
					stale,
					StaleResponsePolicy::RetryOnce,
					CancellationToken::new(),
				)
				.await,
			Err(LspRegistryError::ContentModified { .. })
		));
		assert_eq!(transport.requests.load(Ordering::Relaxed), 0);
		registry
			.close_document(lease.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		fs::remove_dir_all(root).unwrap();
	}

	#[tokio::test]
	async fn refresh_failure_compensates_a_prior_open() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(40_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-refresh-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let path = root.join("file.txt");
		fs::write(&path, b"current").unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let lease = registry
			.open_document(path, None, CancellationToken::new())
			.await
			.unwrap();
		let successful = server();
		let failing = LspServer::new(
			Arc::new(FailingNotifyTransport),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		{
			let mut state = registry.inner.state.lock();
			state.bindings.insert(LspBindingId(2), Binding {
				id:         LspBindingId(2),
				spec:       LspBindingSpec::new("successful", 10, LspSelector::all()).unwrap(),
				server:     successful.clone(),
				generation: 0,
			});
			state.bindings.insert(LspBindingId(3), Binding {
				id:         LspBindingId(3),
				spec:       LspBindingSpec::new("failing", 5, LspSelector::all()).unwrap(),
				server:     failing,
				generation: 0,
			});
		}
		assert!(
			registry
				.publish_head(lease.head().document_id(), CancellationToken::new())
				.await
				.is_err()
		);
		assert_eq!(
			registry
				.inner
				.state
				.lock()
				.leases
				.get(&lease.lease_id())
				.unwrap()
				.binding_ids
				.len(),
			0
		);
		registry
			.close_document(lease.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		fs::remove_dir_all(root).unwrap();
	}

	#[tokio::test]
	async fn failed_restart_keeps_old_binding_and_cleans_staged_leases() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(45_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-restart-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let first_path = root.join("first.txt");
		let second_path = root.join("second.txt");
		fs::write(&first_path, b"first").unwrap();
		fs::write(&second_path, b"second").unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let binding_id = registry
			.add_binding(
				LspBindingSpec::new("restart", 0, LspSelector::all()).unwrap(),
				server(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let first = registry
			.open_document(first_path, None, CancellationToken::new())
			.await
			.unwrap();
		let second = registry
			.open_document(second_path, None, CancellationToken::new())
			.await
			.unwrap();
		let old_versions = registry.inner.state.lock().public_versions.clone();
		let replacement = LspServer::new(
			Arc::new(FailSecondNotifyTransport { notifications: AtomicU64::new(0) }),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.unwrap();
		assert!(
			registry
				.restart_binding(binding_id, replacement.clone(), CancellationToken::new(),)
				.await
				.is_err()
		);
		assert_eq!(registry.binding(binding_id).unwrap().generation, 0);
		assert_eq!(registry.inner.state.lock().public_versions, old_versions);
		assert_eq!(replacement.tracked_version_revision(first.head().document_id()), None);
		assert_eq!(replacement.tracked_version_revision(second.head().document_id()), None);
		registry
			.close_document(first.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		registry
			.close_document(second.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		fs::remove_dir_all(root).unwrap();
	}

	#[tokio::test]
	async fn formatting_acquisition_failure_closes_shadow_and_preserves_public_mapping() {
		static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(50_000);
		let root = env::temp_dir().join(format!(
			"omp-lsp-registry-format-rollback-{}-{}",
			std::process::id(),
			ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).unwrap();
		let path = root.join("base.txt");
		fs::write(&path, b"base").unwrap();
		let registry =
			LspRegistry::new(DocumentStore::new(ServerConfig::new(&root).unwrap()).unwrap());
		let first_transport = Arc::new(ToggleNotifyTransport {
			fail:   AtomicBool::new(false),
			params: Mutex::new(Vec::new()),
		});
		let second_transport = Arc::new(ToggleNotifyTransport {
			fail:   AtomicBool::new(false),
			params: Mutex::new(Vec::new()),
		});
		let capabilities = Bytes::from_static(
			br#"{"documentFormattingProvider":true,"textDocumentSync":{"openClose":true,"change":1}}"#,
		);
		let first_id = registry
			.add_binding(
				LspBindingSpec::new("first", 10, LspSelector::all()).unwrap(),
				LspServer::new(first_transport.clone(), capabilities.clone()).unwrap(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		registry
			.add_binding(
				LspBindingSpec::new("second", 5, LspSelector::all()).unwrap(),
				LspServer::new(second_transport.clone(), capabilities).unwrap(),
				CancellationToken::new(),
			)
			.await
			.unwrap();
		let lease = registry
			.open_document(path.clone(), None, CancellationToken::new())
			.await
			.unwrap();
		let base = registry
			.snapshot_from_store(lease.lease_id(), None)
			.await
			.unwrap();
		let base_uri = registry
			.document_uri(lease.head().document_id())
			.await
			.unwrap();
		let candidate_uri = Url::from_file_path(root.join("candidate.rs")).unwrap();
		first_transport.params.lock().clear();
		second_transport.params.lock().clear();
		second_transport.fail.store(true, Ordering::Relaxed);
		let request = FormatRequest::new(
			TransactionId::from_bytes([51; 16]),
			0,
			base.clone(),
			candidate_uri,
			Some(LanguageId::new("rust").unwrap()),
			Bytes::from_static(b"candidate"),
		);
		let shadow_document = format_shadow_document(&request);
		let shadow_uri = format_shadow_uri(&request);
		let result = registry
			.format_candidate(request, CancellationToken::new())
			.await;
		assert!(result.is_err());
		let first = registry.binding(first_id).unwrap();
		assert_eq!(
			first
				.server
				.tracked_version_revision(lease.head().document_id())
				.unwrap()
				.1,
			base.head().revision()
		);
		{
			let state = registry.inner.state.lock();
			assert!(
				state
					.public_versions
					.get(&(first_id, lease.head().document_id()))
					.unwrap()
					.iter()
					.all(|(uri, _)| uri.as_str() == base_uri.as_str())
			);
		}
		assert_eq!(first.server.tracked_version_revision(shadow_document), None);
		let shadow = shadow_uri.as_str().as_bytes();
		let shadow_was_used = {
			let params = first_transport.params.lock();
			params
				.iter()
				.any(|params| params.windows(shadow.len()).any(|window| window == shadow))
		};
		assert!(shadow_was_used);
		second_transport.fail.store(false, Ordering::Relaxed);
		registry
			.close_document(lease.lease_id(), CancellationToken::new())
			.await
			.unwrap();
		fs::remove_dir_all(root).unwrap();
	}
	#[tokio::test]
	async fn cancelled_close_abandons_a_transport_that_ignores_cancellation() {
		let root = tempfile::tempdir().expect("temporary directory");
		let path = root.path().join("close.txt");
		fs::write(&path, b"content").expect("write fixture");
		let store =
			DocumentStore::new(ServerConfig::new(root.path()).expect("server config")).expect("store");
		let registry = LspRegistry::new(store);
		let server = LspServer::new(
			Arc::new(HangingCloseTransport),
			Bytes::from_static(br#"{"textDocumentSync":{"openClose":true,"change":1}}"#),
		)
		.expect("LSP server");
		registry
			.add_binding(
				LspBindingSpec::new("hanging-close", 0, LspSelector::all()).expect("binding"),
				server,
				CancellationToken::new(),
			)
			.await
			.expect("install binding");
		let lease = registry
			.open_document(path, None, CancellationToken::new())
			.await
			.expect("open document");
		let lease_id = lease.lease_id();
		let cancellation = CancellationToken::new();
		let close_registry = registry.clone();
		let close_cancellation = cancellation.clone();
		let close = tokio::spawn(async move {
			close_registry
				.close_document(lease_id, close_cancellation)
				.await
		});
		task::yield_now().await;
		cancellation.cancel();
		let result = timeout(Duration::from_secs(1), close)
			.await
			.expect("bounded close")
			.expect("close task");
		assert!(matches!(
			result,
			Err(LspRegistryError::Lsp(LspError::Transport(LspTransportError::Cancelled)))
		));
		assert!(matches!(
			registry
				.close_document(lease_id, CancellationToken::new())
				.await,
			Err(LspRegistryError::UnknownLease { .. })
		));
	}
}
