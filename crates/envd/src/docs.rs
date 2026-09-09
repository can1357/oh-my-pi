//! Document-server connection and revision-pinned document operations.

use std::{
	collections::HashMap,
	fmt::{self, Write as _},
	future::Future,
	mem,
	path::{Path, PathBuf},
	pin::Pin,
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use omp_core::{FastHashMap, FastHashSet, Str, StrMut, sf};
use omp_edit::store::EditStore;
use omp_proto::{
	document::v1::{
		self as pb, client_frame, commit_transaction_response, document_target, server_frame,
	},
	lsp::{Diagnostic, Severity},
};
use parking_lot::{Mutex, RwLock};
use thiserror::Error;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
	io,
	io::{AsyncRead, AsyncWrite},
	time::{self, Instant},
};
use tokio_util::sync::CancellationToken;

use super::{ssh::SshService, vault::VaultService};
use crate::docserver::{
	client::{TerminalEventReceiver, terminal_event_channel},
	connection::{PROTOCOL_MAJOR, PROTOCOL_MINOR},
	diagnostics::parse_push,
	wire::{self, FrameConfig},
};
/// Editor-client document authority installed for an ACP session.
///
/// The boxed futures are confined to this cold dynamic RPC boundary; ordinary
/// document and tool calls remain statically dispatched.
pub trait AcpDocumentBackend: Send + Sync {
	/// Reads the editor's exact current UTF-8 buffer for an absolute path.
	fn read_text(
		&self,
		absolute_path: Str,
	) -> Pin<Box<dyn Future<Output = miette::Result<Str>> + Send + '_>>;

	/// Writes the editor buffer and returns its authoritative read-back after
	/// any client format-on-save hook.
	fn write_text(
		&self,
		absolute_path: Str,
		content: Str,
	) -> Pin<Box<dyn Future<Output = miette::Result<Str>> + Send + '_>>;
}

/// Late-bound ACP document capability shared by every tool adapter using one
/// document connection.
#[derive(Clone, Default)]
pub(crate) struct AcpDocumentSlot(Arc<RwLock<Option<Arc<dyn AcpDocumentBackend>>>>);

impl fmt::Debug for AcpDocumentSlot {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AcpDocumentSlot")
			.field("bound", &self.0.read().is_some())
			.finish()
	}
}

impl AcpDocumentSlot {
	/// Replaces the active editor-client authority.
	pub(crate) fn bind(&self, backend: Option<Arc<dyn AcpDocumentBackend>>) {
		*self.0.write() = backend;
	}

	fn backend(&self) -> Option<Arc<dyn AcpDocumentBackend>> {
		super::tools::invocation_acp_documents().or_else(|| self.0.read().clone())
	}
}

/// Metadata established by the document protocol hello exchange.
#[derive(Clone, Debug)]
pub struct DocumentHello {
	/// Negotiated protocol major version.
	pub protocol_major: u32,
	/// Negotiated protocol minor version.
	pub protocol_minor: u32,
	/// Stable identity of the connected document workspace.
	pub workspace_id:   Bytes,
	/// Canonical file URI of the connected workspace root.
	pub root_uri:       Str,
	/// Epoch scoping transaction idempotency keys.
	pub server_epoch:   Bytes,
	/// Executable-generation identity of the serving document authority.
	pub server_build:   Str,
}
/// A terminal loss of continuity in a document-server event stream.
#[derive(Clone, Debug, Error)]
#[error("document event stream ended ({failure:?}); skipped {skipped_events} events: {message}")]
pub struct EventStreamError {
	/// Stream family whose continuity was lost.
	pub stream:         pb::EventStreamKind,
	/// Terminal failure classification.
	pub failure:        pb::EventStreamFailure,
	/// Number of events overwritten before a lag failure.
	pub skipped_events: u64,
	/// Server-provided diagnostic.
	pub message:        Str,
}

/// One ordered DAP output or lifecycle event.
#[derive(Clone, Debug)]
pub enum DapRegistryEvent {
	/// Bounded adapter or debuggee output.
	Output(pb::DapOutput),
	/// Bounded adapter lifecycle or debugger event.
	Event(pb::DapEvent),
}

/// One connection-wide LSP registry event.
#[derive(Clone, Debug)]
pub enum LspRegistryEvent {
	/// Notification emitted by a bound language server.
	Event(pb::LspEvent),
	/// Binding lifecycle or synchronization-policy change.
	Binding(pb::LspBindingEvent),
}

/// The terminally contiguous event stream attached to an open document lease.
#[derive(Debug)]
pub struct DocumentEvents {
	receiver: TerminalEventReceiver<pb::DocumentEvent, EventStreamError>,
}

impl DocumentEvents {
	/// Waits for the next event, returning the terminal continuity error once.
	pub async fn next_event(&self) -> Result<pb::DocumentEvent, EventStreamError> {
		self
			.receiver
			.next_event()
			.await
			.unwrap_or_else(|| Err(closed_stream_error(pb::EventStreamKind::Document)))
	}
}

/// The terminally contiguous connection-wide LSP event stream.
#[derive(Debug)]
pub struct LspEvents {
	receiver: TerminalEventReceiver<LspRegistryEvent, EventStreamError>,
}

impl LspEvents {
	/// Waits for the next LSP or binding event.
	pub async fn next_event(&self) -> Result<LspRegistryEvent, EventStreamError> {
		self
			.receiver
			.next_event()
			.await
			.unwrap_or_else(|| Err(closed_stream_error(pb::EventStreamKind::LspRegistry)))
	}
}

type DocumentEventResult = Result<pb::DocumentEvent, EventStreamError>;
type DocumentEventSender = flume::Sender<DocumentEventResult>;
type DocumentEventSubscribers = HashMap<Bytes, (Bytes, DocumentEventSender)>;
type PendingDocumentEvents = HashMap<Bytes, Vec<DocumentEventResult>>;
type PendingDapEvents = HashMap<Bytes, Vec<DapRegistryEvent>>;
type PendingRequests = HashMap<u64, flume::Sender<Result<pb::ServerFrame, ()>>>;

pub(crate) type RehostFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub(crate) type RehostCallback = Arc<dyn Fn() -> RehostFuture + Send + Sync>;
/// A document-server lease pinned to the revision returned by `OpenDocument`.
///
/// Dropping the lease sends a best-effort close request, keeping lease release
/// resource-owned even when an executor future is cancelled.
#[derive(Debug)]
#[must_use]
pub struct DocumentLease {
	lease_id: Bytes,
	head:     pb::DocumentHead,
	host:     Arc<Inner>,
	events:   Option<DocumentEvents>,
	released: bool,
}

impl DocumentLease {
	/// Returns the opaque connection-owned lease identity.
	pub const fn id(&self) -> &Bytes {
		&self.lease_id
	}

	/// Returns the immutable head to which reads and edits are pinned.
	pub const fn head(&self) -> &pb::DocumentHead {
		&self.head
	}

	/// Takes the terminally contiguous event stream for this lease.
	///
	/// A lease has exactly one event consumer. Subsequent calls return `None`.
	pub const fn take_events(&mut self) -> Option<DocumentEvents> {
		self.events.take()
	}

	/// Advances this lease to a committed head returned for the same document.
	pub(crate) fn advance(&mut self, head: pb::DocumentHead) -> Result<(), DocumentError> {
		if head.revision.is_none() || head.document != self.head.document {
			return Err(unexpected("committed head for the leased document"));
		}
		self.head = head;
		Ok(())
	}

	fn revision(&self) -> Result<pb::Revision, DocumentError> {
		self
			.head
			.revision
			.clone()
			.ok_or(DocumentError::MalformedResponse(sf!("document head omitted its revision",)))
	}
}

/// Connection-owned exclusive workspace reservation.
#[derive(Debug)]
#[must_use]
pub struct WorkspaceLease {
	lease_id: Bytes,
	host:     Arc<Inner>,
	released: bool,
}

impl WorkspaceLease {
	/// Returns the opaque reservation identity.
	pub const fn id(&self) -> &Bytes {
		&self.lease_id
	}
}

impl Drop for WorkspaceLease {
	fn drop(&mut self) {
		if self.released {
			return;
		}
		let Some(connection) = self.host.current_connection() else {
			return;
		};
		let request_id = self.host.next_request.fetch_add(1, Ordering::Relaxed);
		if request_id == 0 {
			return;
		}
		let _ = connection.writer.try_send(pb::ClientFrame {
			request_id,
			body: Some(client_frame::Body::ReleaseWorkspaceLease(pb::ReleaseWorkspaceLeaseRequest {
				workspace_lease_id: self.lease_id.clone(),
			})),
		});
	}
}

impl Drop for DocumentLease {
	fn drop(&mut self) {
		let Some(connection) = self.host.current_connection() else {
			return;
		};
		connection.document_events.lock().remove(&self.lease_id);
		if self.released {
			return;
		}
		let request_id = self.host.next_request.fetch_add(1, Ordering::Relaxed);
		if request_id == 0 {
			return;
		}
		let _ = connection.writer.try_send(pb::ClientFrame {
			request_id,
			body: Some(client_frame::Body::CloseDocument(pb::CloseDocumentRequest {
				lease_id: self.lease_id.clone(),
			})),
		});
	}
}

/// A document host connection, protocol, or server operation failed.
#[derive(Debug, Error)]
pub enum DocumentError {
	/// Transport framing or serialization error.
	#[error(transparent)]
	Wire(#[from] wire::WireError),
	/// Server connection was closed unexpectedly.
	#[error("document-server connection closed")]
	Disconnected,
	/// Document operation was cancelled before completion.
	#[error("document operation was cancelled")]
	Cancelled,
	/// Document server rejected the operation.
	#[error("document server rejected the operation ({code}): {message}")]
	Protocol {
		/// Server status code.
		code:    i32,
		/// Server error message.
		message: Str,
	},
	/// Server response frame was invalid or unexpected.
	#[error("malformed document-server response: {0}")]
	MalformedResponse(Str),
}
#[derive(Clone, Debug)]
enum DocumentEndpoint {
	#[cfg(unix)]
	Unix(PathBuf),
	#[cfg(windows)]
	WindowsPipe(PathBuf),
}

#[derive(Debug)]
struct ReconnectAttempt {
	complete: CancellationToken,
}

#[derive(Debug)]
struct ConnectionState {
	current:         Option<Arc<ConnState>>,
	reconnect:       Option<Arc<ReconnectAttempt>>,
	terminal:        bool,
	next_generation: u64,
}

#[derive(Debug)]
struct ConnState {
	generation:               u64,
	writer:                   flume::Sender<pb::ClientFrame>,
	pending:                  Mutex<PendingRequests>,
	document_events:          Mutex<DocumentEventSubscribers>,
	pending_document_events:  Mutex<PendingDocumentEvents>,
	pending_dap_events:       Mutex<PendingDapEvents>,
	document_event_sequences: Mutex<HashMap<Bytes, u64>>,
	lsp_event_sender:         flume::Sender<Result<LspRegistryEvent, EventStreamError>>,
	lsp_events:               Mutex<Option<LspEvents>>,
	shutdown:                 CancellationToken,
}

type LateDiagnosticsSink =
	Arc<dyn Fn(omp_session::late_diagnostics::LateDiagnostics) + Send + Sync + 'static>;

#[derive(Clone, Debug)]
struct PendingLateDiagnostics {
	revision:  pb::Revision,
	path:      Str,
	delivered: FastHashSet<Str>,
}

struct Inner {
	hello:              DocumentHello,
	resource_mutations: RwLock<Option<ResourceMutationServices>>,
	acp_documents:      AcpDocumentSlot,
	connection:         RwLock<ConnectionState>,
	endpoint:           Option<DocumentEndpoint>,
	rehost:             RwLock<Option<RehostCallback>>,
	next_request:       AtomicU64,
	shutdown:           CancellationToken,
	edit_store:         EditStore,
	late_diagnostics:   Mutex<FastHashMap<Bytes, PendingLateDiagnostics>>,
	recent_diagnostics: Mutex<FastHashMap<Bytes, pb::LspEvent>>,
	late_inflight:      Mutex<FastHashSet<Bytes>>,
	late_inflight_uris: Mutex<FastHashSet<Str>>,
	late_sink:          RwLock<Option<(u64, LateDiagnosticsSink)>>,
}

impl fmt::Debug for Inner {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("Inner")
			.field("hello", &self.hello)
			.field("endpoint", &self.endpoint)
			.field("connection", &self.connection)
			.field("rehost", &self.rehost.read().is_some())
			.finish_non_exhaustive()
	}
}

/// App-owned SSH and vault authorities used by document resource writes.
#[derive(Clone, Debug)]
pub(super) struct ResourceMutationServices {
	pub(super) ssh:   SshService,
	pub(super) vault: VaultService,
}

/// Client connection to the project document server.
#[derive(Clone, Debug)]
pub struct DocumentHost {
	inner: Arc<Inner>,
}

/// Commit-lifetime diagnostic fence closing the response/event race.
pub(crate) struct LateDiagnosticsAttempt {
	host:      DocumentHost,
	documents: Vec<Bytes>,
	uris:      Vec<Str>,
}

impl Drop for LateDiagnosticsAttempt {
	fn drop(&mut self) {
		let mut inflight = self.host.inner.late_inflight.lock();
		let mut inflight_uris = self.host.inner.late_inflight_uris.lock();
		let mut recent = self.host.inner.recent_diagnostics.lock();
		for document in &self.documents {
			inflight.remove(document);
			recent.remove(document);
		}
		for uri in &self.uris {
			inflight_uris.remove(uri);
		}
	}
}

impl DocumentHost {
	/// Binds the current Agent mailbox projection for deferred diagnostics.
	pub(crate) fn bind_late_diagnostics(&self, id: u64, sink: LateDiagnosticsSink) {
		*self.inner.late_sink.write() = Some((id, sink));
	}

	/// Clears pending delivery while retaining the currently bound sink.
	pub(crate) fn reset_late_diagnostics(&self, id: u64) {
		if self
			.inner
			.late_sink
			.read()
			.as_ref()
			.is_some_and(|(owner, _)| *owner == id)
		{
			self.inner.late_diagnostics.lock().clear();
			self.inner.recent_diagnostics.lock().clear();
			self.inner.late_inflight.lock().clear();
			self.inner.late_inflight_uris.lock().clear();
		}
	}

	/// Removes the deferred-diagnostics projection only when `id` still owns it.
	pub(crate) fn unbind_late_diagnostics(&self, id: u64) {
		let mut sink = self.inner.late_sink.write();
		if sink.as_ref().is_some_and(|(owner, _)| *owner == id) {
			*sink = None;
			self.inner.late_diagnostics.lock().clear();
			self.inner.recent_diagnostics.lock().clear();
			self.inner.late_inflight.lock().clear();
			self.inner.late_inflight_uris.lock().clear();
		}
	}

	/// Invalidates late findings superseded by any non-document-host mutation.
	pub(crate) fn invalidate_late_diagnostics_path(&self, path: &str) {
		self
			.inner
			.late_diagnostics
			.lock()
			.retain(|_, pending| pending.path != path);
	}

	/// Opens a commit-lifetime fence so diagnostics racing its response can be
	/// retained.
	pub(crate) fn begin_late_diagnostics<'a>(
		&self,
		heads: impl IntoIterator<Item = &'a pb::DocumentHead>,
	) -> LateDiagnosticsAttempt {
		let documents = heads
			.into_iter()
			.filter_map(|head| head.document.as_ref())
			.map(|document| document.id.clone())
			.collect::<Vec<_>>();
		self
			.inner
			.late_diagnostics
			.lock()
			.retain(|document, _| !documents.contains(document));
		self
			.inner
			.late_inflight
			.lock()
			.extend(documents.iter().cloned());
		LateDiagnosticsAttempt { host: self.clone(), documents, uris: Vec::new() }
	}

	/// Opens a commit fence for a create whose document identity is not minted
	/// yet.
	pub(crate) fn begin_late_diagnostics_uri(&self, uri: Str) -> LateDiagnosticsAttempt {
		let path = absolute_document_path(&uri);
		self
			.inner
			.late_diagnostics
			.lock()
			.retain(|_, pending| pending.path != path);
		self.inner.late_inflight_uris.lock().insert(uri.clone());
		LateDiagnosticsAttempt {
			host:      self.clone(),
			documents: Vec::new(),
			uris:      vec![uri],
		}
	}

	/// Fences the next published diagnostics snapshot to an incomplete commit.
	pub(crate) fn expect_late_diagnostics(&self, head: &pb::DocumentHead, complete: bool) {
		let (Some(document), Some(revision)) = (&head.document, &head.revision) else {
			return;
		};
		self.inner.late_inflight.lock().remove(&document.id);
		if complete {
			self.inner.late_diagnostics.lock().remove(&document.id);
			self.inner.recent_diagnostics.lock().remove(&document.id);
			return;
		}
		self
			.inner
			.late_diagnostics
			.lock()
			.insert(document.id.clone(), PendingLateDiagnostics {
				revision:  revision.clone(),
				path:      absolute_document_path(&document.uri),
				delivered: FastHashSet::default(),
			});
		let ready = self
			.inner
			.recent_diagnostics
			.lock()
			.remove(&document.id)
			.filter(|event| event.revision.as_ref() == Some(revision));
		if let Some(event) = ready {
			self.inner.publish_late_diagnostics(event);
		}
	}

	/// Binds or clears the editor-owned document authority.
	pub(crate) fn bind_acp_documents(&self, backend: Option<Arc<dyn AcpDocumentBackend>>) {
		self.inner.acp_documents.bind(backend);
	}

	/// Reads the current editor buffer when an ACP document authority is live.
	pub(crate) async fn read_acp_text(&self, absolute_path: Str) -> Option<miette::Result<Str>> {
		let backend = self.inner.acp_documents.backend()?;
		Some(backend.read_text(absolute_path).await)
	}

	/// Writes through the current editor and returns its formatted read-back.
	pub(crate) async fn write_acp_text(
		&self,
		absolute_path: Str,
		content: Str,
	) -> Option<miette::Result<Str>> {
		let backend = self.inner.acp_documents.backend()?;
		Some(backend.write_text(absolute_path, content).await)
	}

	/// Installs the app-owned capability-checked internal resource writers.
	pub(super) fn set_resource_mutations(&self, services: ResourceMutationServices) {
		*self.inner.resource_mutations.write() = Some(services);
	}

	pub(super) fn resource_mutations(&self) -> Option<ResourceMutationServices> {
		self.inner.resource_mutations.read().clone()
	}

	/// Connects to an already-running document server and completes its hello.
	pub async fn connect<S>(stream: S) -> Result<Self, DocumentError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		Self::connect_stream(stream, None).await
	}

	/// Connects to an already-running document server over a Unix-domain socket.
	#[cfg(unix)]
	pub async fn connect_uds(path: impl AsRef<Path>) -> Result<Self, DocumentError> {
		let path = path.as_ref().to_path_buf();
		let stream = UnixStream::connect(&path)
			.await
			.map_err(wire::WireError::from)?;
		Self::connect_uds_stream(path, stream).await
	}

	#[cfg(unix)]
	pub(crate) async fn connect_uds_stream(
		path: impl AsRef<Path>,
		stream: UnixStream,
	) -> Result<Self, DocumentError> {
		Self::connect_stream(stream, Some(DocumentEndpoint::Unix(path.as_ref().to_path_buf()))).await
	}

	/// Connects to an already-running document server over an owner named pipe.
	#[cfg(windows)]
	pub async fn connect_pipe(path: impl AsRef<Path>) -> Result<Self, DocumentError> {
		let path = path.as_ref().to_path_buf();
		let stream =
			crate::docserver::windows::connect_owner_pipe(&path).map_err(wire::WireError::from)?;
		Self::connect_pipe_stream(path, stream).await
	}

	#[cfg(windows)]
	pub(crate) async fn connect_pipe_stream(
		path: impl AsRef<Path>,
		stream: tokio::net::windows::named_pipe::NamedPipeClient,
	) -> Result<Self, DocumentError> {
		Self::connect_stream(stream, Some(DocumentEndpoint::WindowsPipe(path.as_ref().to_path_buf())))
			.await
	}

	async fn connect_stream<S>(
		stream: S,
		endpoint: Option<DocumentEndpoint>,
	) -> Result<Self, DocumentError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		let negotiated = negotiate(stream).await?;
		let inner = Arc::new(Inner {
			hello: negotiated.0,
			resource_mutations: RwLock::new(None),
			acp_documents: AcpDocumentSlot::default(),
			connection: RwLock::new(ConnectionState {
				current:         None,
				reconnect:       None,
				terminal:        false,
				next_generation: 1,
			}),
			endpoint,
			rehost: RwLock::new(None),
			next_request: AtomicU64::new(1),
			shutdown: CancellationToken::new(),
			edit_store: EditStore::default(),
			late_diagnostics: Mutex::new(FastHashMap::default()),
			recent_diagnostics: Mutex::new(FastHashMap::default()),
			late_inflight: Mutex::new(FastHashSet::default()),
			late_inflight_uris: Mutex::new(FastHashSet::default()),
			late_sink: RwLock::new(None),
		});
		install_connection(&inner, negotiated.1, negotiated.2, negotiated.3, negotiated.4, None);
		Ok(Self { inner })
	}

	/// Installs the cold authority-rehost path used only by project connections.
	pub(crate) fn install_rehost(&self, callback: RehostCallback) {
		*self.inner.rehost.write() = Some(callback);
	}

	/// Returns the negotiated server and workspace identity.
	pub fn hello(&self) -> &DocumentHello {
		&self.inner.hello
	}

	/// Returns the session-shared edit store.
	pub(crate) fn snapshot_store(&self) -> &EditStore {
		&self.inner.edit_store
	}

	/// Takes the connection-wide LSP registry event stream.
	///
	/// A protocol connection has exactly one ordered LSP event consumer.
	pub fn take_lsp_events(&self) -> Option<LspEvents> {
		let connection = self.inner.current_connection()?;
		connection.lsp_events.lock().take()
	}

	/// Acquires a document lease and pins it to the returned immutable revision.
	pub async fn open(
		&self,
		uri: Str,
		language_id: Option<Str>,
		cancel: &CancellationToken,
	) -> Result<DocumentLease, DocumentError> {
		let (lease, _) = self
			.open_request(
				pb::OpenDocumentRequest {
					uri:         uri.into(),
					language_id: language_id.unwrap_or_default().into(),
				},
				cancel,
			)
			.await?;
		Ok(lease)
	}

	/// Forwards one canonical open request and returns both its owned lease and
	/// unmodified protocol response.
	pub(crate) async fn open_request(
		&self,
		request: pb::OpenDocumentRequest,
		cancel: &CancellationToken,
	) -> Result<(DocumentLease, pb::OpenDocumentResponse), DocumentError> {
		let (body, connection) = self
			.request_with_connection(client_frame::Body::OpenDocument(request), cancel)
			.await?;
		let server_frame::Body::DocumentOpened(opened) = body else {
			return Err(unexpected("OpenDocumentResponse"));
		};
		let head = opened
			.head
			.clone()
			.ok_or_else(|| unexpected("OpenDocumentResponse.head"))?;
		let document_id = head
			.document
			.as_ref()
			.map(|document| document.id.clone())
			.filter(|id| !id.is_empty())
			.ok_or_else(|| unexpected("OpenDocumentResponse.head.document.id"))?;
		if opened.lease_id.len() != 16 || head.revision.is_none() {
			return Err(unexpected("valid lease id and pinned revision"));
		}
		let connection_state = self.inner.connection.read();
		if !connection_state
			.current
			.as_ref()
			.is_some_and(|current| Arc::ptr_eq(current, &connection))
		{
			return Err(DocumentError::Disconnected);
		}
		let (event_sender, event_receiver) = terminal_event_channel();
		connection
			.document_events
			.lock()
			.insert(opened.lease_id.clone(), (document_id.clone(), event_sender.clone()));
		let pending_events = connection
			.pending_document_events
			.lock()
			.remove(&document_id);
		if let Some(events) = pending_events {
			for event in events {
				let _ = event_sender.send(event);
			}
		}
		let pending_events = connection
			.pending_document_events
			.lock()
			.remove(&opened.lease_id);
		if let Some(events) = pending_events {
			for event in events {
				let _ = event_sender.send(event);
			}
		}
		drop(connection_state);
		let lease = DocumentLease {
			lease_id: opened.lease_id.clone(),
			head,
			host: Arc::clone(&self.inner),
			events: Some(DocumentEvents { receiver: event_receiver }),
			released: false,
		};
		Ok((lease, opened))
	}

	/// Reads ranges from the exact revision pinned by `lease`.
	pub async fn read(
		&self,
		lease: &DocumentLease,
		selection: pb::ReadSelection,
		cancel: &CancellationToken,
	) -> Result<pb::ReadDocumentResponse, DocumentError> {
		self
			.read_request(
				lease,
				pb::ReadDocumentRequest {
					document:  Some(lease_target(lease)),
					revision:  Some(lease.revision()?),
					selection: Some(selection),
				},
				cancel,
			)
			.await
	}

	/// Forwards one canonical read request after validating its connection-owned
	/// lease. The protocol permits omitting the revision to read the current
	/// head and permits an explicit retained revision.
	pub(crate) async fn read_request(
		&self,
		lease: &DocumentLease,
		request: pb::ReadDocumentRequest,
		cancel: &CancellationToken,
	) -> Result<pb::ReadDocumentResponse, DocumentError> {
		self.ensure_request_lease(lease, request.document.as_ref())?;
		if request.selection.is_none() {
			return Err(unexpected("ReadDocumentRequest.selection"));
		}
		let requested_revision = request.revision.clone();
		let body = self
			.request(client_frame::Body::ReadDocument(request), cancel)
			.await?;
		let server_frame::Body::DocumentRead(response) = body else {
			return Err(unexpected("ReadDocumentResponse"));
		};
		ensure_requested_head(response.head.as_ref(), requested_revision.as_ref())?;
		Ok(response)
	}

	/// Produces a structural summary from the exact revision pinned by `lease`.
	pub async fn summarize(
		&self,
		lease: &DocumentLease,
		options: pb::CodeSummaryOptions,
		cancel: &CancellationToken,
	) -> Result<pb::SummarizeDocumentResponse, DocumentError> {
		self
			.summarize_request(
				lease,
				pb::SummarizeDocumentRequest {
					document: Some(lease_target(lease)),
					revision: Some(lease.revision()?),
					options:  Some(options),
				},
				cancel,
			)
			.await
	}

	/// Forwards one canonical summary request after validating its
	/// connection-owned lease and optional requested revision.
	pub(crate) async fn summarize_request(
		&self,
		lease: &DocumentLease,
		request: pb::SummarizeDocumentRequest,
		cancel: &CancellationToken,
	) -> Result<pb::SummarizeDocumentResponse, DocumentError> {
		self.ensure_request_lease(lease, request.document.as_ref())?;
		if request.options.is_none() {
			return Err(unexpected("SummarizeDocumentRequest.options"));
		}
		let requested_revision = request.revision.clone();
		let body = self
			.request(client_frame::Body::SummarizeDocument(request), cancel)
			.await?;
		let server_frame::Body::DocumentSummarized(response) = body else {
			return Err(unexpected("SummarizeDocumentResponse"));
		};
		ensure_requested_head(response.head.as_ref(), requested_revision.as_ref())?;
		Ok(response)
	}

	/// Commits one text mutation against the lease's pinned base revision.
	///
	/// The lease advances only after a committed operation; rejected and partial
	/// outcomes retain the old pin so callers cannot accidentally write from an
	/// unobserved head.
	pub async fn commit(
		&self,
		lease: &mut DocumentLease,
		transaction_id: Bytes,
		mut mutation: pb::TextMutation,
		cancel: &CancellationToken,
	) -> Result<pb::CommitTransactionResponse, DocumentError> {
		self.ensure_owned(lease)?;
		mutation.base_revision = Some(lease.revision()?);
		let body = self
			.request(
				client_frame::Body::CommitTransaction(pb::CommitTransactionRequest {
					transaction_id,
					operations: vec![pb::DocumentMutation {
						document:  Some(lease_target(lease)),
						operation: Some(pb::document_mutation::Operation::Text(mutation)),
					}],
				}),
				cancel,
			)
			.await?;
		let server_frame::Body::TransactionResult(response) = body else {
			return Err(unexpected("CommitTransactionResponse"));
		};
		record_transaction_conflict(&response);
		if let Some(commit_transaction_response::Outcome::Committed(committed)) = &response.outcome {
			let Some(head) = (committed.operations.len() == 1)
				.then(|| committed.operations[0].head.clone())
				.flatten()
			else {
				return Err(unexpected("one committed operation head"));
			};
			if head.revision.is_none() {
				return Err(unexpected("committed operation revision"));
			}
			lease.head = head;
		}
		Ok(response)
	}

	/// Commits several already revision-bound mutations as one document-server
	/// transaction. Operations are sent in declared order against the server's
	/// transaction-local overlay.
	pub async fn commit_transaction(
		&self,
		transaction_id: Bytes,
		operations: Vec<pb::DocumentMutation>,
		cancel: &CancellationToken,
	) -> Result<pb::CommitTransactionResponse, DocumentError> {
		self
			.commit_transaction_request(
				pb::CommitTransactionRequest { transaction_id, operations },
				cancel,
			)
			.await
	}

	/// Forwards one canonical document transaction request.
	pub(crate) async fn commit_transaction_request(
		&self,
		request: pb::CommitTransactionRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CommitTransactionResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CommitTransaction(request), cancel)
			.await?;
		let server_frame::Body::TransactionResult(response) = body else {
			return Err(unexpected("CommitTransactionResponse"));
		};
		record_transaction_conflict(&response);
		Ok(response)
	}

	/// Resolves an existing path to its host-canonical file URI.
	pub async fn canonicalize(
		&self,
		request: pb::CanonicalizePathRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CanonicalizePathResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CanonicalizePath(request), cancel)
			.await?;
		let server_frame::Body::PathCanonicalized(response) = body else {
			return Err(unexpected("CanonicalizePathResponse"));
		};
		Ok(response)
	}

	/// Reads stat or lstat metadata through the document authority.
	pub async fn stat(
		&self,
		request: pb::StatPathRequest,
		cancel: &CancellationToken,
	) -> Result<pb::StatPathResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::StatPath(request), cancel)
			.await?;
		let server_frame::Body::PathStat(response) = body else {
			return Err(unexpected("StatPathResponse"));
		};
		Ok(response)
	}

	/// Enumerates one directory through the document authority.
	pub async fn list_directory(
		&self,
		request: pb::ListDirectoryRequest,
		cancel: &CancellationToken,
	) -> Result<pb::ListDirectoryResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::ListDirectory(request), cancel)
			.await?;
		let server_frame::Body::DirectoryListed(response) = body else {
			return Err(unexpected("ListDirectoryResponse"));
		};
		Ok(response)
	}

	/// Creates a directory through the document authority.
	pub async fn create_directory(
		&self,
		request: pb::CreateDirectoryRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CreateDirectoryResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CreateDirectory(request), cancel)
			.await?;
		let server_frame::Body::DirectoryCreated(response) = body else {
			return Err(unexpected("CreateDirectoryResponse"));
		};
		Ok(response)
	}

	/// Removes a path under the authority's active-document revision checks.
	pub async fn remove(
		&self,
		request: pb::RemovePathRequest,
		cancel: &CancellationToken,
	) -> Result<pb::RemovePathResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::RemovePath(request), cancel)
			.await?;
		let server_frame::Body::PathRemoved(response) = body else {
			return Err(unexpected("RemovePathResponse"));
		};
		Ok(response)
	}

	/// Renames a path under exact source and destination revision checks.
	pub async fn rename(
		&self,
		request: pb::RenamePathRequest,
		cancel: &CancellationToken,
	) -> Result<pb::RenamePathResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::RenamePath(request), cancel)
			.await?;
		let server_frame::Body::PathRenamed(response) = body else {
			return Err(unexpected("RenamePathResponse"));
		};
		Ok(response)
	}

	/// Copies a regular file or symbolic link without bypassing the authority.
	pub async fn copy(
		&self,
		request: pb::CopyPathRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CopyPathResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CopyPath(request), cancel)
			.await?;
		let server_frame::Body::PathCopied(response) = body else {
			return Err(unexpected("CopyPathResponse"));
		};
		Ok(response)
	}

	/// Reads a symbolic-link target without dereferencing the final entry.
	pub async fn read_link(
		&self,
		request: pb::ReadLinkRequest,
		cancel: &CancellationToken,
	) -> Result<pb::ReadLinkResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::ReadLink(request), cancel)
			.await?;
		let server_frame::Body::LinkRead(response) = body else {
			return Err(unexpected("ReadLinkResponse"));
		};
		Ok(response)
	}

	/// Creates a symbolic link through the document authority.
	pub async fn create_symlink(
		&self,
		request: pb::CreateSymlinkRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CreateSymlinkResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CreateSymlink(request), cancel)
			.await?;
		let server_frame::Body::SymlinkCreated(response) = body else {
			return Err(unexpected("CreateSymlinkResponse"));
		};
		Ok(response)
	}

	/// Creates a hard link through the document authority.
	pub async fn create_hard_link(
		&self,
		request: pb::CreateHardLinkRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CreateHardLinkResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::CreateHardLink(request), cancel)
			.await?;
		let server_frame::Body::HardLinkCreated(response) = body else {
			return Err(unexpected("CreateHardLinkResponse"));
		};
		Ok(response)
	}

	/// Applies a portable permission transition under revision checks.
	pub async fn set_permissions(
		&self,
		request: pb::SetPermissionsRequest,
		cancel: &CancellationToken,
	) -> Result<pb::SetPermissionsResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::SetPermissions(request), cancel)
			.await?;
		let server_frame::Body::PermissionsSet(response) = body else {
			return Err(unexpected("SetPermissionsResponse"));
		};
		Ok(response)
	}

	/// Launches a DAP session and returns lifecycle/output events emitted before
	/// the launch response.
	pub async fn dap_launch(
		&self,
		request: pb::DapLaunchRequest,
		cancel: &CancellationToken,
	) -> Result<(pb::DapSessionResponse, Vec<DapRegistryEvent>), DocumentError> {
		let (body, connection) = self
			.request_with_connection(client_frame::Body::DapLaunch(request), cancel)
			.await?;
		let server_frame::Body::DapSession(response) = body else {
			return Err(unexpected("DAP session response"));
		};
		let events = self.take_dap_events(&connection, response.session.as_ref())?;
		Ok((response, events))
	}

	/// Attaches a DAP session and returns lifecycle/output events emitted before
	/// the attach response.
	pub async fn dap_attach(
		&self,
		request: pb::DapAttachRequest,
		cancel: &CancellationToken,
	) -> Result<(pb::DapSessionResponse, Vec<DapRegistryEvent>), DocumentError> {
		let (body, connection) = self
			.request_with_connection(client_frame::Body::DapAttach(request), cancel)
			.await?;
		let server_frame::Body::DapSession(response) = body else {
			return Err(unexpected("DAP session response"));
		};
		let events = self.take_dap_events(&connection, response.session.as_ref())?;
		Ok((response, events))
	}

	/// Executes one revision-fenced DAP action and returns the ordered events
	/// emitted before its terminal response.
	pub async fn dap_action(
		&self,
		request: pb::DapActionRequest,
		cancel: &CancellationToken,
	) -> Result<(pb::DapActionResponse, Vec<DapRegistryEvent>), DocumentError> {
		let (body, connection) = self
			.request_with_connection(client_frame::Body::DapAction(request), cancel)
			.await?;
		let server_frame::Body::DapAction(response) = body else {
			return Err(unexpected("DAP action response"));
		};
		let events = self.take_dap_events(&connection, response.session.as_ref())?;
		Ok((response, events))
	}

	fn take_dap_events(
		&self,
		connection: &ConnState,
		session: Option<&pb::DapSessionRef>,
	) -> Result<Vec<DapRegistryEvent>, DocumentError> {
		let session = session.ok_or_else(|| unexpected("DAP response session identity"))?;
		if session.session_id.is_empty() {
			return Err(unexpected("non-empty DAP response session identity"));
		}
		let connection_state = self.inner.connection.read();
		if !connection_state
			.current
			.as_deref()
			.is_some_and(|current| std::ptr::eq(current, connection))
		{
			return Err(DocumentError::Disconnected);
		}
		Ok(connection
			.pending_dap_events
			.lock()
			.remove(&session.session_id)
			.unwrap_or_default())
	}

	/// Returns the authority-resolved LSP bindings for a document.
	pub async fn get_lsp_bindings(
		&self,
		request: pb::GetLspBindingsRequest,
		cancel: &CancellationToken,
	) -> Result<pb::GetLspBindingsResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::GetLspBindings(request), cancel)
			.await?;
		let server_frame::Body::LspBindings(response) = body else {
			return Err(unexpected("GetLspBindingsResponse"));
		};
		Ok(response)
	}

	/// Returns the native language-server roster and lifecycle stages.
	pub async fn lsp_status(
		&self,
		request: pb::LspStatusRequest,
		cancel: &CancellationToken,
	) -> Result<pb::LspStatusResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::LspStatus(request), cancel)
			.await?;
		let server_frame::Body::LspStatus(response) = body else {
			return Err(unexpected("LspStatusResponse"));
		};
		Ok(response)
	}

	/// Forwards an arbitrary non-lifecycle LSP request through the authority.
	pub async fn lsp_request(
		&self,
		request: pb::LspRequest,
		cancel: &CancellationToken,
	) -> Result<pb::LspResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::LspRequest(request), cancel)
			.await?;
		let server_frame::Body::LspResponse(response) = body else {
			return Err(unexpected("LspResponse"));
		};
		Ok(response)
	}

	/// Enqueues a non-lifecycle LSP notification on the selected server lane.
	pub async fn lsp_notification(
		&self,
		request: pb::LspNotificationRequest,
		cancel: &CancellationToken,
	) -> Result<pb::LspNotificationResponse, DocumentError> {
		let body = self
			.request(client_frame::Body::LspNotification(request), cancel)
			.await?;
		let server_frame::Body::LspNotificationAccepted(response) = body else {
			return Err(unexpected("LspNotificationResponse"));
		};
		Ok(response)
	}

	/// Atomically acquires or dry-runs an exclusive workspace path reservation.
	pub async fn acquire_workspace_lease(
		&self,
		request: pb::AcquireWorkspaceLeaseRequest,
		cancel: &CancellationToken,
	) -> Result<(Option<WorkspaceLease>, pb::AcquireWorkspaceLeaseResponse), DocumentError> {
		let body = self
			.request(client_frame::Body::AcquireWorkspaceLease(request), cancel)
			.await?;
		let server_frame::Body::WorkspaceLeaseAcquired(response) = body else {
			return Err(unexpected("AcquireWorkspaceLeaseResponse"));
		};
		if response
			.workspace_lease_id
			.as_ref()
			.is_some_and(|lease_id| lease_id.len() != 16)
		{
			return Err(unexpected("16-byte workspace lease id"));
		}
		let lease = response
			.workspace_lease_id
			.as_ref()
			.map(|lease_id| WorkspaceLease {
				lease_id: lease_id.clone(),
				host:     Arc::clone(&self.inner),
				released: false,
			});
		Ok((lease, response))
	}

	/// Explicitly releases an exclusive workspace reservation.
	pub async fn release_workspace_lease(
		&self,
		mut lease: WorkspaceLease,
		cancel: &CancellationToken,
	) -> Result<pb::ReleaseWorkspaceLeaseResponse, DocumentError> {
		if !Arc::ptr_eq(&self.inner, &lease.host) {
			return Err(unexpected("connection-owned workspace lease"));
		}
		let body = self
			.request(
				client_frame::Body::ReleaseWorkspaceLease(pb::ReleaseWorkspaceLeaseRequest {
					workspace_lease_id: lease.lease_id.clone(),
				}),
				cancel,
			)
			.await?;
		let server_frame::Body::WorkspaceLeaseReleased(response) = body else {
			return Err(unexpected("ReleaseWorkspaceLeaseResponse"));
		};
		lease.released = true;
		Ok(response)
	}

	/// Releases a connection-owned document lease.
	pub async fn close(
		&self,
		mut lease: DocumentLease,
		cancel: &CancellationToken,
	) -> Result<(), DocumentError> {
		let request = pb::CloseDocumentRequest { lease_id: lease.lease_id.clone() };
		self.close_request(&mut lease, request, cancel).await?;
		Ok(())
	}

	/// Forwards one canonical close request for a connection-owned lease.
	pub(crate) async fn close_request(
		&self,
		lease: &mut DocumentLease,
		request: pb::CloseDocumentRequest,
		cancel: &CancellationToken,
	) -> Result<pb::CloseDocumentResponse, DocumentError> {
		self.ensure_owned(lease)?;
		if request.lease_id != lease.lease_id {
			return Err(unexpected("connection-owned CloseDocumentRequest.lease_id"));
		}
		let body = self
			.request(client_frame::Body::CloseDocument(request), cancel)
			.await?;
		match body {
			server_frame::Body::DocumentClosed(response) => {
				lease.released = true;
				Ok(response)
			},
			_ => Err(unexpected("CloseDocumentResponse")),
		}
	}

	fn ensure_request_lease(
		&self,
		lease: &DocumentLease,
		target: Option<&pb::DocumentTarget>,
	) -> Result<(), DocumentError> {
		self.ensure_owned(lease)?;
		let lease_target = matches!(
			target.and_then(|target| target.target.as_ref()),
			Some(omp_proto::document::v1::document_target::Target::LeaseId(id)) if id == lease.id()
		);
		if !lease_target {
			return Err(unexpected("connection-owned document lease"));
		}
		Ok(())
	}

	fn ensure_owned(&self, lease: &DocumentLease) -> Result<(), DocumentError> {
		if Arc::ptr_eq(&self.inner, &lease.host) {
			Ok(())
		} else {
			Err(DocumentError::MalformedResponse(sf!(
				"document lease belongs to another document connection",
			)))
		}
	}

	async fn request(
		&self,
		body: client_frame::Body,
		cancel: &CancellationToken,
	) -> Result<server_frame::Body, DocumentError> {
		self
			.request_with_connection(body, cancel)
			.await
			.map(|(body, _)| body)
	}

	async fn request_with_connection(
		&self,
		body: client_frame::Body,
		cancel: &CancellationToken,
	) -> Result<(server_frame::Body, Arc<ConnState>), DocumentError> {
		let mut body = Some(body);
		let (connection, request_id, response_rx) = loop {
			let connection = self.connection_for_request(cancel).await?;
			let state = self.inner.connection.read();
			if !state
				.current
				.as_ref()
				.is_some_and(|current| Arc::ptr_eq(current, &connection))
			{
				continue;
			}
			let request_id = self.inner.next_request.fetch_add(1, Ordering::Relaxed);
			if request_id == 0 {
				return Err(DocumentError::Disconnected);
			}
			let (response_tx, response_rx) = flume::bounded(1);
			connection.pending.lock().insert(request_id, response_tx);
			if connection
				.writer
				.try_send(pb::ClientFrame { request_id, body: body.take() })
				.is_err()
			{
				connection.pending.lock().remove(&request_id);
				drop(state);
				Inner::disconnect_generation(&self.inner, connection.generation);
				return Err(DocumentError::Disconnected);
			}
			drop(state);
			break (connection, request_id, response_rx);
		};
		let mut pending = PendingRequest {
			inner: Arc::clone(&self.inner),
			connection: Arc::clone(&connection),
			request_id,
			armed: true,
		};
		let frame = tokio::select! {
			biased;
			() = cancel.cancelled() => return Err(DocumentError::Cancelled),
			result = response_rx.recv_async() => {
				result.map_err(|_| DocumentError::Disconnected)?
					.map_err(|()| DocumentError::Disconnected)?
			},
		};
		pending.armed = false;
		let body = match frame.body {
			Some(server_frame::Body::Error(error)) => {
				return Err(DocumentError::Protocol {
					code:    error.code,
					message: Str::from(error.message),
				});
			},
			Some(body) => body,
			None => return Err(unexpected("non-empty server frame")),
		};
		Ok((body, connection))
	}

	async fn connection_for_request(
		&self,
		cancel: &CancellationToken,
	) -> Result<Arc<ConnState>, DocumentError> {
		loop {
			let reconnect = {
				let state = self.inner.connection.read();
				if let Some(connection) = &state.current {
					return Ok(Arc::clone(connection));
				}
				if state.terminal {
					return Err(DocumentError::Disconnected);
				}
				state.reconnect.clone()
			};
			let Some(reconnect) = reconnect else {
				return Err(DocumentError::Disconnected);
			};
			tokio::select! {
				biased;
				() = cancel.cancelled() => return Err(DocumentError::Cancelled),
				() = reconnect.complete.cancelled() => {},
			}
		}
	}
}

impl Drop for Inner {
	fn drop(&mut self) {
		self.shutdown.cancel();
		let connection = self.connection.write().current.take();
		if let Some(connection) = connection {
			connection.shutdown.cancel();
		}
	}
}

#[must_use]
struct PendingRequest {
	inner:      Arc<Inner>,
	connection: Arc<ConnState>,
	request_id: u64,
	armed:      bool,
}

impl Drop for PendingRequest {
	fn drop(&mut self) {
		if !self.armed
			|| self
				.connection
				.pending
				.lock()
				.remove(&self.request_id)
				.is_none()
		{
			return;
		}
		let Some(connection) = self.inner.current_connection() else {
			return;
		};
		let _ = connection.writer.try_send(pb::ClientFrame {
			request_id: 0,
			body:       Some(client_frame::Body::Cancel(pb::CancelRequest {
				target_request_id: self.request_id,
			})),
		});
	}
}
impl Inner {
	fn observe_lsp_event(&self, event: &pb::LspEvent) {
		if event.method != "textDocument/publishDiagnostics" {
			return;
		}
		let Some(document) = event
			.document
			.as_ref()
			.filter(|document| !document.id.is_empty())
		else {
			return;
		};
		let Some(revision) = event.revision.as_ref() else {
			return;
		};
		let ready = self
			.late_diagnostics
			.lock()
			.get(&document.id)
			.is_some_and(|pending| &pending.revision == revision);
		if ready {
			self.publish_late_diagnostics(event.clone());
		} else if self.late_inflight.lock().contains(&document.id)
			|| self
				.late_inflight_uris
				.lock()
				.contains(document.uri.as_str())
		{
			self
				.recent_diagnostics
				.lock()
				.insert(document.id.clone(), event.clone());
		}
	}

	fn publish_late_diagnostics(&self, event: pb::LspEvent) {
		let Some(document) = event.document.as_ref() else {
			return;
		};
		let path = {
			let pending = self.late_diagnostics.lock();
			let Some(pending) = pending.get(&document.id) else {
				return;
			};
			if event.revision.as_ref() != Some(&pending.revision) {
				return;
			}
			pending.path.clone()
		};
		let Ok((_, _, diagnostics)) = parse_push(&event.params_json, "lsp") else {
			return;
		};
		let display_path = display_document_path(&document.uri, self.hello.root_uri.as_str());
		let mut file = late_diagnostics_file(path, display_path, diagnostics);
		{
			let mut pending = self.late_diagnostics.lock();
			let Some(pending) = pending.get_mut(&document.id) else {
				return;
			};
			if event.revision.as_ref() != Some(&pending.revision) {
				return;
			}
			file
				.messages
				.retain(|message| pending.delivered.insert(message.clone()));
		}
		file.recount();
		if file.messages.is_empty() {
			return;
		}
		let sink = self
			.late_sink
			.read()
			.as_ref()
			.map(|(_, sink)| Arc::clone(sink));
		if let Some(sink) = sink {
			sink(omp_session::late_diagnostics::LateDiagnostics { files: vec![file] });
		}
	}

	fn current_connection(&self) -> Option<Arc<ConnState>> {
		self.connection.read().current.clone()
	}

	fn disconnect_generation(inner: &Arc<Self>, generation: u64) {
		let (connection, reconnect) = {
			let mut state = inner.connection.write();
			let Some(current) = state.current.as_ref() else {
				return;
			};
			if current.generation != generation {
				return;
			}
			let connection = state
				.current
				.take()
				.expect("matched current document connection");
			if inner.endpoint.is_some() {
				let reconnect = Arc::new(ReconnectAttempt { complete: CancellationToken::new() });
				state.reconnect = Some(Arc::clone(&reconnect));
				(connection, Some(reconnect))
			} else {
				state.terminal = true;
				(connection, None)
			}
		};
		drain_connection(&connection);
		if let Some(reconnect) = reconnect {
			spawn_reconnect(Arc::downgrade(inner), reconnect);
		}
	}
}

async fn negotiate<S>(
	stream: S,
) -> Result<(DocumentHello, io::ReadHalf<S>, io::WriteHalf<S>, BytesMut, BytesMut), DocumentError>
where
	S: AsyncRead + AsyncWrite + Unpin,
{
	let config = FrameConfig::default();
	let (mut reader, mut writer) = io::split(stream);
	let mut write_scratch = BytesMut::new();
	wire::write_client_frame(
		&mut writer,
		&pb::ClientFrame {
			request_id: 0,
			body:       Some(client_frame::Body::Hello(pb::ClientHello {
				protocol_major: PROTOCOL_MAJOR,
				protocol_minor: PROTOCOL_MINOR,
				client_id:      Bytes::new(),
			})),
		},
		config,
		&mut write_scratch,
	)
	.await?;

	let mut read_scratch = BytesMut::new();
	let hello_frame = wire::read_server_frame(&mut reader, config, &mut read_scratch)
		.await?
		.ok_or(DocumentError::Disconnected)?;
	let hello = match hello_frame.body {
		Some(server_frame::Body::Hello(hello)) if hello_frame.request_id == 0 => hello,
		Some(server_frame::Body::Error(error)) => {
			return Err(DocumentError::Protocol {
				code:    error.code,
				message: Str::from(error.message),
			});
		},
		_ => {
			return Err(DocumentError::MalformedResponse(sf!(
				"expected ServerHello as the first server frame",
			)));
		},
	};
	if hello.protocol_major != PROTOCOL_MAJOR || hello.protocol_minor > PROTOCOL_MINOR {
		return Err(DocumentError::MalformedResponse(sf!(
			"document server negotiated an unsupported protocol version",
		)));
	}
	Ok((
		DocumentHello {
			protocol_major: hello.protocol_major,
			protocol_minor: hello.protocol_minor,
			workspace_id:   hello.workspace_id,
			root_uri:       Str::from(hello.root_uri),
			server_epoch:   hello.server_epoch,
			server_build:   Str::from(hello.server_build),
		},
		reader,
		writer,
		read_scratch,
		write_scratch,
	))
}

fn install_connection<S>(
	inner: &Arc<Inner>,
	mut reader: io::ReadHalf<S>,
	mut writer: io::WriteHalf<S>,
	mut read_scratch: BytesMut,
	write_scratch: BytesMut,
	expected_reconnect: Option<&Arc<ReconnectAttempt>>,
) -> bool
where
	S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
	let (write_tx, write_rx) = flume::unbounded();
	let (lsp_event_sender, lsp_event_receiver) = terminal_event_channel();
	let (connection, completed_reconnect) = {
		let mut state = inner.connection.write();
		match expected_reconnect {
			Some(expected)
				if !state
					.reconnect
					.as_ref()
					.is_some_and(|current| Arc::ptr_eq(current, expected)) =>
			{
				return false;
			},
			None if state.current.is_some() => return false,
			_ => {},
		}
		let generation = state.next_generation;
		state.next_generation = state.next_generation.wrapping_add(1);
		let connection = Arc::new(ConnState {
			generation,
			writer: write_tx,
			pending: Mutex::new(HashMap::new()),
			document_events: Mutex::new(HashMap::new()),
			pending_document_events: Mutex::new(HashMap::new()),
			pending_dap_events: Mutex::new(HashMap::new()),
			document_event_sequences: Mutex::new(HashMap::new()),
			lsp_event_sender,
			lsp_events: Mutex::new(Some(LspEvents { receiver: lsp_event_receiver })),
			shutdown: CancellationToken::new(),
		});
		state.current = Some(Arc::clone(&connection));
		state.terminal = false;
		let completed_reconnect = state.reconnect.take();
		(connection, completed_reconnect)
	};

	let writer_connection = Arc::clone(&connection);
	let writer_inner = Arc::downgrade(inner);
	tokio::spawn(async move {
		let mut scratch = write_scratch;
		loop {
			let frame = tokio::select! {
				() = writer_connection.shutdown.cancelled() => break,
				result = write_rx.recv_async() => match result {
					Ok(frame) => frame,
					Err(_) => break,
				},
			};
			if wire::write_client_frame(&mut writer, &frame, FrameConfig::default(), &mut scratch)
				.await
				.is_err()
			{
				break;
			}
		}
		if let Some(inner) = writer_inner.upgrade() {
			Inner::disconnect_generation(&inner, writer_connection.generation);
		}
	});

	let reader_connection = Arc::clone(&connection);
	let reader_inner = Arc::downgrade(inner);
	tokio::spawn(async move {
		loop {
			let frame = tokio::select! {
				() = reader_connection.shutdown.cancelled() => break,
				result = wire::read_server_frame(
					&mut reader,
					FrameConfig::default(),
					&mut read_scratch,
				) => {
					match result {
						Ok(Some(frame)) => frame,
						Ok(None) | Err(_) => break,
					}
				},
			};
			if frame.request_id == 0 {
				if let Some(body) = frame.body {
					let Some(inner) = reader_inner.upgrade() else {
						break;
					};
					dispatch_event_frame(
						body,
						&reader_connection.document_events,
						&reader_connection.pending_document_events,
						&reader_connection.document_event_sequences,
						&reader_connection.pending_dap_events,
						&reader_connection.lsp_event_sender,
						&inner,
					);
				}
				continue;
			}
			let waiter = reader_connection.pending.lock().remove(&frame.request_id);
			if let Some(waiter) = waiter {
				let _ = waiter.send(Ok(frame));
			}
		}
		if let Some(inner) = reader_inner.upgrade() {
			Inner::disconnect_generation(&inner, reader_connection.generation);
		}
	});

	if let Some(reconnect) = completed_reconnect {
		reconnect.complete.cancel();
	}
	true
}

fn drain_connection(connection: &ConnState) {
	connection.shutdown.cancel();
	drop(mem::take(&mut *connection.pending.lock()));
	let closed = closed_stream_error(pb::EventStreamKind::Document);
	let document_events = mem::take(&mut *connection.document_events.lock());
	for (_, sender) in document_events.into_values() {
		let _ = sender.send(Err(closed.clone()));
	}
	connection.pending_document_events.lock().clear();
	connection.pending_dap_events.lock().clear();
	connection.document_event_sequences.lock().clear();
	let _ = connection
		.lsp_event_sender
		.send(Err(closed_stream_error(pb::EventStreamKind::LspRegistry)));
}

#[derive(Clone, Copy)]
enum RedialFailure {
	Rehostable,
	Other,
}

fn spawn_reconnect(inner: Weak<Inner>, reconnect: Arc<ReconnectAttempt>) {
	tokio::spawn(async move {
		let deadline = Instant::now() + Duration::from_secs(10);
		loop {
			let Some(host) = inner.upgrade() else {
				return;
			};
			let Some(endpoint) = host.endpoint.clone() else {
				return;
			};
			let shutdown = host.shutdown.clone();
			drop(host);
			let result = tokio::select! {
				biased;
				() = shutdown.cancelled() => return,
				result = time::timeout_at(
					deadline,
					reconnect_endpoint(&inner, &endpoint, &reconnect),
				) => result,
			};
			match result {
				Ok(Ok(true)) => return,
				Ok(Ok(false)) => return,
				Ok(Err(RedialFailure::Rehostable)) => {
					let callback = inner.upgrade().and_then(|host| host.rehost.read().clone());
					if let Some(callback) = callback {
						let completed = tokio::select! {
							biased;
							() = shutdown.cancelled() => return,
							result = time::timeout_at(deadline, callback()) => result.is_ok(),
						};
						if !completed {
							break;
						}
					}
				},
				Ok(Err(RedialFailure::Other)) => {},
				Err(_) => break,
			}
			if Instant::now() >= deadline {
				break;
			}
			tokio::select! {
				biased;
				() = shutdown.cancelled() => return,
				() = time::sleep(Duration::from_millis(100)) => {},
			}
		}

		if let Some(host) = inner.upgrade() {
			let completed = {
				let mut state = host.connection.write();
				if !state
					.reconnect
					.as_ref()
					.is_some_and(|current| Arc::ptr_eq(current, &reconnect))
				{
					return;
				}
				state.terminal = true;
				state.reconnect.take()
			};
			if let Some(completed) = completed {
				completed.complete.cancel();
			}
		}
	});
}

#[cfg(unix)]
async fn reconnect_endpoint(
	inner: &Weak<Inner>,
	endpoint: &DocumentEndpoint,
	reconnect: &Arc<ReconnectAttempt>,
) -> Result<bool, RedialFailure> {
	let DocumentEndpoint::Unix(path) = endpoint;
	let stream = UnixStream::connect(path)
		.await
		.map_err(|error| match error.kind() {
			std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
				RedialFailure::Rehostable
			},
			_ => RedialFailure::Other,
		})?;
	let negotiated = negotiate(stream).await.map_err(|_| RedialFailure::Other)?;
	let Some(inner) = inner.upgrade() else {
		return Ok(false);
	};
	Ok(install_connection(
		&inner,
		negotiated.1,
		negotiated.2,
		negotiated.3,
		negotiated.4,
		Some(reconnect),
	))
}

#[cfg(windows)]
async fn reconnect_endpoint(
	inner: &Weak<Inner>,
	endpoint: &DocumentEndpoint,
	reconnect: &Arc<ReconnectAttempt>,
) -> Result<bool, RedialFailure> {
	let DocumentEndpoint::WindowsPipe(path) = endpoint;
	let stream =
		crate::docserver::windows::connect_owner_pipe(path).map_err(|error| match error.kind() {
			std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
				RedialFailure::Rehostable
			},
			_ => RedialFailure::Other,
		})?;
	let negotiated = negotiate(stream).await.map_err(|_| RedialFailure::Other)?;
	let Some(inner) = inner.upgrade() else {
		return Ok(false);
	};
	Ok(install_connection(
		&inner,
		negotiated.1,
		negotiated.2,
		negotiated.3,
		negotiated.4,
		Some(reconnect),
	))
}
fn record_transaction_conflict(response: &pb::CommitTransactionResponse) {
	match &response.outcome {
		Some(commit_transaction_response::Outcome::Rejected(rejected)) => {
			tracing::warn!(
				reason = rejected.reason,
				conflicts = rejected.conflicts.len(),
				"document transaction rejected",
			);
		},
		Some(commit_transaction_response::Outcome::PartiallyCommitted(partial)) => {
			tracing::warn!(
				reason = partial.reason,
				committed_operations = partial.committed_operations.len(),
				failed_operation_index = partial.failed_operation_index,
				"document transaction partially committed",
			);
		},
		Some(commit_transaction_response::Outcome::Committed(_)) | None => {},
	}
}

fn ensure_requested_head(
	head: Option<&pb::DocumentHead>,
	requested_revision: Option<&pb::Revision>,
) -> Result<(), DocumentError> {
	let revision = head
		.and_then(|head| head.revision.as_ref())
		.ok_or_else(|| unexpected("revision-pinned response head"))?;
	if requested_revision.is_some_and(|requested| requested != revision) {
		return Err(DocumentError::MalformedResponse(sf!(
			"document server returned a revision other than the requested revision",
		)));
	}
	Ok(())
}

pub(crate) fn lease_target(lease: &DocumentLease) -> pb::DocumentTarget {
	pb::DocumentTarget { target: Some(document_target::Target::LeaseId(lease.lease_id.clone())) }
}
fn absolute_document_path(uri: &str) -> Str {
	url::Url::parse(uri)
		.ok()
		.and_then(|url| url.to_file_path().ok())
		.and_then(|path| path.to_str().map(Str::new))
		.unwrap_or_else(|| Str::new(uri))
}

fn display_document_path(uri: &str, root_uri: &str) -> Str {
	let Some(path) = url::Url::parse(uri)
		.ok()
		.and_then(|url| url.to_file_path().ok())
	else {
		return Str::new(uri);
	};
	let root = url::Url::parse(root_uri)
		.ok()
		.and_then(|url| url.to_file_path().ok());
	let display = root
		.as_deref()
		.and_then(|root| path.strip_prefix(root).ok())
		.unwrap_or(path.as_path());
	display
		.to_str()
		.map(Str::new)
		.unwrap_or_else(|| Str::new(uri))
}

fn late_diagnostics_file(
	path: Str,
	display_path: Str,
	diagnostics: Vec<Diagnostic>,
) -> omp_session::late_diagnostics::LateDiagnosticsFile {
	let mut counts = [0usize; 4];
	let mut messages = Vec::with_capacity(diagnostics.len());
	for diagnostic in diagnostics {
		let rank = match diagnostic.severity {
			Severity::Error => 0,
			Severity::Warning => 1,
			Severity::Information => 2,
			Severity::Hint => 3,
		};
		counts[rank] += 1;
		let severity: &'static str = diagnostic.severity.into();
		let mut message = StrMut::with_capacity(display_path.len() + diagnostic.message.len() + 48);
		let _ = write!(
			message,
			"{}:{}:{} [{severity}]",
			display_path,
			diagnostic.range.start.line + 1,
			diagnostic.range.start.character + 1
		);
		if !diagnostic.source.is_empty() {
			let _ = write!(message, " [{}]", diagnostic.source);
		}
		let _ = write!(message, " {}", diagnostic.message);
		if let Some(code) = diagnostic.code {
			let _ = write!(message, " ({code})");
		}
		messages.push(message.freeze());
	}
	let labels = ["error(s)", "warning(s)", "info(s)", "hint(s)"];
	let mut summary = StrMut::new("");
	for (count, label) in counts.into_iter().zip(labels) {
		if count == 0 {
			continue;
		}
		if !summary.is_empty() {
			summary.push_str(", ");
		}
		let _ = write!(summary, "{count} {label}");
	}
	if summary.is_empty() {
		summary.push_str("no issues");
	}
	omp_session::late_diagnostics::LateDiagnosticsFile {
		path,
		summary: summary.freeze(),
		errored: counts[0] > 0,
		messages,
	}
}

fn dispatch_event_frame(
	body: server_frame::Body,
	document_events: &Mutex<DocumentEventSubscribers>,
	pending_document_events: &Mutex<PendingDocumentEvents>,
	document_event_sequences: &Mutex<HashMap<Bytes, u64>>,
	dap_events: &Mutex<PendingDapEvents>,
	lsp_events: &flume::Sender<Result<LspRegistryEvent, EventStreamError>>,
	inner: &Inner,
) {
	match body {
		server_frame::Body::DocumentEvent(event) => {
			let Some(document_id) = event
				.head
				.as_ref()
				.and_then(|head| head.document.as_ref())
				.map(|document| document.id.clone())
				.filter(|id| !id.is_empty())
			else {
				return;
			};
			let mut sequences = document_event_sequences.lock();
			if sequences
				.get(&document_id)
				.is_some_and(|sequence| *sequence >= event.event_sequence)
			{
				return;
			}
			sequences.insert(document_id.clone(), event.event_sequence);
			drop(sequences);
			let mut delivered = false;
			document_events.lock().retain(|_, (subscribed_id, sender)| {
				if subscribed_id != &document_id {
					return true;
				}
				let alive = sender.send(Ok(event.clone())).is_ok();
				delivered |= alive;
				alive
			});
			if !delivered {
				pending_document_events
					.lock()
					.entry(document_id)
					.or_default()
					.push(Ok(event));
			}
		},
		server_frame::Body::DapOutput(output) => {
			if let Some(session) = output
				.session
				.as_ref()
				.filter(|session| !session.session_id.is_empty())
			{
				dap_events
					.lock()
					.entry(session.session_id.clone())
					.or_default()
					.push(DapRegistryEvent::Output(output));
			}
		},
		server_frame::Body::DapEvent(event) => {
			if let Some(session) = event
				.session
				.as_ref()
				.filter(|session| !session.session_id.is_empty())
			{
				dap_events
					.lock()
					.entry(session.session_id.clone())
					.or_default()
					.push(DapRegistryEvent::Event(event));
			}
		},
		server_frame::Body::LspEvent(event) => {
			inner.observe_lsp_event(&event);
			let _ = lsp_events.send(Ok(LspRegistryEvent::Event(event)));
		},
		server_frame::Body::LspBindingEvent(event) => {
			let _ = lsp_events.send(Ok(LspRegistryEvent::Binding(event)));
		},
		server_frame::Body::EventStreamError(error) => {
			let terminal = EventStreamError {
				stream:         pb::EventStreamKind::try_from(error.stream)
					.unwrap_or(pb::EventStreamKind::Unspecified),
				failure:        pb::EventStreamFailure::try_from(error.failure)
					.unwrap_or(pb::EventStreamFailure::Unspecified),
				skipped_events: error.skipped_events,
				message:        Str::from(error.message),
			};
			match terminal.stream {
				pb::EventStreamKind::Document => {
					let subscriber = document_events.lock().remove(&error.lease_id);
					if let Some((_, sender)) = subscriber {
						let _ = sender.send(Err(terminal));
					} else {
						pending_document_events
							.lock()
							.entry(error.lease_id)
							.or_default()
							.push(Err(terminal));
					}
				},
				pb::EventStreamKind::LspRegistry | pb::EventStreamKind::Unspecified => {
					let _ = lsp_events.send(Err(terminal));
				},
			}
		},
		_ => {},
	}
}

const fn closed_stream_error(stream: pb::EventStreamKind) -> EventStreamError {
	EventStreamError {
		stream,
		failure: pb::EventStreamFailure::Closed,
		skipped_events: 0,
		message: sf!("document-server connection closed"),
	}
}

fn unexpected(expected: &'static str) -> DocumentError {
	DocumentError::MalformedResponse(Str::new(expected))
}
#[cfg(all(test, unix))]
mod tests {
	use std::{path::Path, time::Duration};

	use omp_proto::document::v1::{read_document_response, read_selection};
	use tokio::{task::JoinHandle, time};

	use super::*;
	use crate::docserver::daemon::{self, ServeOptions, Transport};

	const TEST_TIMEOUT: Duration = Duration::from_secs(10);
	const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);
	const GAP_SETTLE: Duration = Duration::from_millis(100);

	#[test]
	fn late_diagnostics_payload_keeps_path_summary_and_message_order() {
		let file = late_diagnostics_file(
			Str::new_static("/workspace/src/lib.rs"),
			Str::new_static("src/lib.rs"),
			vec![
				Diagnostic {
					uri:      Str::new_static("file:///workspace/src/lib.rs"),
					range:    omp_proto::lsp::Range {
						start: omp_proto::lsp::Position { line: 9, character: 3 },
						end:   omp_proto::lsp::Position { line: 9, character: 4 },
					},
					severity: Severity::Warning,
					message:  Str::new_static("unused binding"),
					code:     Some(Str::new_static("unused")),
					source:   Str::new_static("rustc"),
				},
				Diagnostic {
					uri:      Str::new_static("file:///workspace/src/lib.rs"),
					range:    omp_proto::lsp::Range {
						start: omp_proto::lsp::Position { line: 1, character: 0 },
						end:   omp_proto::lsp::Position { line: 1, character: 1 },
					},
					severity: Severity::Error,
					message:  Str::new_static("mismatched types"),
					code:     Some(Str::new_static("E0308")),
					source:   Str::new_static("rustc"),
				},
			],
		);
		assert_eq!(file.path, "/workspace/src/lib.rs");
		assert_eq!(file.summary, "1 error(s), 1 warning(s)");
		assert!(file.errored);
		assert_eq!(file.messages.iter().map(Str::as_str).collect::<Vec<_>>(), [
			"src/lib.rs:10:4 [warning] [rustc] unused binding (unused)",
			"src/lib.rs:2:1 [error] [rustc] mismatched types (E0308)",
		]);
	}

	struct TestDocServer {
		shutdown: CancellationToken,
		task:     JoinHandle<daemon::Result>,
	}

	impl TestDocServer {
		async fn start(project: &Path, socket: &Path) -> (Self, DocumentHost) {
			let shutdown = CancellationToken::new();
			let serve_shutdown = shutdown.clone();
			let serve_project = project.to_path_buf();
			let serve_socket = socket.to_path_buf();
			let task = tokio::spawn(async move {
				daemon::serve(serve_project, Transport::Socket(serve_socket), ServeOptions {
					lsp_config_paths: Vec::new(),
					lsp:              crate::docserver::NativeLspOptions {
						enabled: false,
						lazy:    true,
					},
					user_config_root: None,
					shutdown:         Some(serve_shutdown),
					server_build:     Str::from(omp_env::build_id::current()),
					connections:      None,
				})
				.await
			});
			let mut server = Self { shutdown, task };
			let socket = socket.to_path_buf();
			let ready = time::timeout(TEST_TIMEOUT, async {
				loop {
					if server.task.is_finished() {
						return Err("document server exited before accepting a connection");
					}
					match DocumentHost::connect_uds(&socket).await {
						Ok(host) => return Ok(host),
						Err(_) => time::sleep(Duration::from_millis(10)).await,
					}
				}
			})
			.await;
			match ready {
				Ok(Ok(host)) => (server, host),
				Ok(Err(message)) => {
					server.abort().await;
					panic!("{message}");
				},
				Err(_) => {
					server.abort().await;
					panic!("document server did not become ready within the deadline");
				},
			}
		}

		async fn stop(self) {
			let Self { shutdown, mut task } = self;
			shutdown.cancel();
			match time::timeout(TEST_TIMEOUT, &mut task).await {
				Ok(joined) => joined
					.expect("join document server")
					.expect("stop document server cleanly"),
				Err(_) => {
					task.abort();
					let _ = task.await;
					panic!("document server did not stop within the deadline");
				},
			}
		}

		async fn abort(&mut self) {
			self.shutdown.cancel();
			self.task.abort();
			let _ = (&mut self.task).await;
		}
	}

	async fn read_whole(host: &DocumentHost, uri: Str) -> Result<Bytes, DocumentError> {
		let cancel = CancellationToken::new();
		let lease = host.open(uri, None, &cancel).await?;
		let response = host
			.read(
				&lease,
				pb::ReadSelection {
					selection: Some(read_selection::Selection::Whole(pb::WholeDocument {})),
				},
				&cancel,
			)
			.await?;
		host.close(lease, &cancel).await?;
		match response.body {
			Some(read_document_response::Body::Content(content)) => Ok(content),
			_ => Err(unexpected("whole-document content")),
		}
	}

	#[tokio::test]
	async fn document_host_recovers_across_real_docserver_kill_gap_and_restart() {
		let project = tempfile::tempdir().expect("document workspace");
		let project_root =
			std::fs::canonicalize(project.path()).expect("canonical document workspace");
		let socket_dir = tempfile::tempdir().expect("document socket directory");
		let socket = socket_dir.path().join("document.sock");
		let file = project_root.join("restart.txt");
		let expected = "before restart: λ\n";
		std::fs::write(&file, expected).expect("write UTF-8 fixture");
		let config = crate::docserver::ServerConfig::new(&project_root).expect("document config");
		let uri = Str::from(
			config
				.file_uri(&file)
				.expect("fixture file URI")
				.to_string(),
		);

		let (first_server, host) = TestDocServer::start(&project_root, &socket).await;
		let initial = time::timeout(TEST_TIMEOUT, read_whole(&host, uri.clone()))
			.await
			.expect("initial document read timed out")
			.expect("initial document read");
		assert_eq!(initial.as_ref(), expected.as_bytes());

		let connection = host
			.inner
			.current_connection()
			.expect("live document connection");
		let request_id = host.inner.next_request.fetch_add(1, Ordering::Relaxed);
		let (response_tx, response_rx) = flume::bounded(1);
		connection.pending.lock().insert(request_id, response_tx);
		let mut pending_waiter = tokio::spawn(async move {
			match response_rx.recv_async().await {
				Ok(Ok(_)) => Ok(()),
				Ok(Err(())) | Err(_) => Err(DocumentError::Disconnected),
			}
		});

		first_server.stop().await;
		let disconnected = match time::timeout(DISCONNECT_TIMEOUT, &mut pending_waiter).await {
			Ok(joined) => joined.expect("join pending response waiter"),
			Err(_) => {
				pending_waiter.abort();
				let _ = pending_waiter.await;
				panic!("pending response waiter was not drained after disconnect");
			},
		};
		assert!(matches!(disconnected, Err(DocumentError::Disconnected)));

		let request_host = host.clone();
		let request_uri = uri.clone();
		let mut gap_request =
			tokio::spawn(async move { read_whole(&request_host, request_uri).await });
		assert!(
			time::timeout(GAP_SETTLE, &mut gap_request).await.is_err(),
			"document request completed while the endpoint was absent"
		);

		let (second_server, readiness_host) = TestDocServer::start(&project_root, &socket).await;
		drop(readiness_host);
		let recovered = match time::timeout(TEST_TIMEOUT, &mut gap_request).await {
			Ok(joined) => joined.expect("join request spanning document-server restart"),
			Err(_) => {
				gap_request.abort();
				let _ = gap_request.await;
				second_server.stop().await;
				panic!("document request did not recover after server restart");
			},
		};
		second_server.stop().await;
		let recovered = recovered.expect("read after document-server restart");
		assert_eq!(recovered.as_ref(), expected.as_bytes());
	}
}
