use std::{
	collections::HashMap,
	fmt::{self, Display},
	io,
	path::Path,
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	thread,
};

use bytes::Bytes;
#[cfg(unix)]
use bytes::BytesMut;
use flume::{Receiver, Sender};
use omp_core::{EnvPath, Hash32, Str, hash32::Hasher, sf};
#[cfg(unix)]
use omp_proto::prost::Message as _;
use omp_proto::{
	blob::v1::{
		Chunk, DeleteRequest, DeleteResponse, GetRequest, PutResponse, StatRequest, StatResponse,
	},
	document::v1::{
		self as document, CommitTransactionRequest, DocumentEvent, DocumentHead, DocumentMutation,
		GetLspBindingsRequest, GetLspBindingsResponse, LspBindingEvent, LspEvent,
		OpenDocumentRequest, ReadDocumentRequest, ReadDocumentResponse, ReadSelection, Revision,
		TextMutation, TransactionCommitted, TransactionPartiallyCommitted, TransactionRejected,
		commit_transaction_response, document_mutation, document_target, read_document_response,
	},
	env::{
		v1,
		v1::{
			self as env_wire, AcpBind, AcpDocumentAnswer, AcpExecCancel, AcpExecEvent, AcpExecQuery,
			AcpReadQuery, AcpWriteQuery, Admission, AdmitInvocation, ArgText, ArgsCommitted,
			AttachOutput, BlobGetComplete, CancelRequest, ClientFrame, ClientHello,
			CloseSessionRequest, CloseSessionResponse, CommitBlobPut, CreateWorktree, CurrentWorktree,
			CurrentWorktreeResult, DataEvent, DataRequest, DataResponse, DestroyWorktree, DetachExec,
			EditRepairAnswer, EditRepairQuery, EvalResetRequest, EventStreamError, EventStreamKind,
			ExecRequest, ExecStarted, ExitEvent, GetProcess, HttpRequest, HttpResponse, Interrupt,
			InvocationScope, InvokeAccepted, InvokeTool, ListProcesses, MaterializeSite,
			MergeWorktree, OpenSessionRequest, OpenSessionResponse, OutputAttached, OutputFrame,
			PresenceRegistered, PresenceReleased, ProcessCommandAccepted, ProcessInfo, ProcessList,
			ProcessOutput, ProcessStarted, ProcessStateEvent, ProtocolError, ProtocolErrorCode,
			RegisterPresence, ReleasePresence, ResourceCompletion, RestartProcess, Retire,
			SearchComplete, SearchMatchMsg, SearchRequest, SendInput, ServerFrame, ServerHello,
			SignalProcess, SignalRequest, SiteMaterialized, StartProcess, StdinFrame, StopProcess,
			Update, Verdict, WalkComplete, WalkEntry, WalkRequest, WorktreeResult, cancel_request,
			client_frame, data_event, data_request, data_response, document_op, document_result,
			exec_session_op, exec_session_result, mcp_op, mcp_result, resource_op, server_frame,
			stdin_frame, workspace_op, workspace_result, worktree_op,
		},
	},
};
use parking_lot::Mutex;
use thiserror::Error;
use tokio::runtime;
#[cfg(unix)]
use tokio::{
	io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
	net::UnixStream,
	task::AbortHandle,
};
use url::Url;

use crate::{admit::Admitter, guard::RunGuard};

/// A client-side environment protocol failure.
#[derive(Debug, Error)]
pub enum ClientError {
	/// The frame transport closed before the operation completed.
	#[error("environment frame transport closed")]
	TransportClosed,
	/// A nonblocking transport send could not proceed without waiting.
	#[error("environment frame transport is busy")]
	TransportBusy,
	/// All nonzero request identifiers have been consumed.
	#[error("environment request identifier space exhausted")]
	RequestIdExhausted,
	/// The server refused a DATA operation before effects were authorized.
	#[error("environment effects are not authorized: {0:?}")]
	EffectsNotAuthorized(ProtocolError),
	/// A correlated event stream permanently lost continuity.
	#[error("{0}")]
	StreamLost(StreamLost),
	/// The server rejected the request.
	#[error("environment protocol error: {0:?}")]
	Protocol(ProtocolError),
	/// The worker-scoped surface excludes this operation family.
	#[error("operation is unavailable on an invocation-scoped environment client")]
	ScopedOperationDenied,
	/// A UDS connection or framed transport could not be established.
	#[error("environment transport error: {0}")]
	Transport(#[from] io::Error),
	/// A typed environment path could not be resolved to a valid file URI.
	#[error("invalid environment path URI: {0}")]
	InvalidEnvPath(Str),
	/// A durable invocation principal omitted its session or agent identity.
	#[error("invalid invocation principal: session_id and agent_id must both be nonempty")]
	InvalidInvocationPrincipal,
	/// A response did not have the body required by the typed operation.
	#[error("unexpected environment response while waiting for {expected}")]
	UnexpectedResponse {
		/// The response body expected by the operation.
		expected: &'static str,
	},
	/// A blob digest did not contain exactly 32 raw SHA-256 bytes.
	#[error("environment blob digest has {actual} bytes; expected 32")]
	InvalidBlobDigest {
		/// Observed digest width.
		actual: usize,
	},
	/// A declared blob is larger than the caller's total transfer bound.
	#[error("environment blob is {size} bytes; transfer limit is {limit} bytes")]
	BlobTooLarge {
		/// Complete size declared by the content reference.
		size:  u64,
		/// Maximum accepted total size.
		limit: u64,
	},
	/// A resumed range did not begin at the next verified byte.
	#[error("environment blob resume offset mismatch: expected {expected}, requested {actual}")]
	BlobResumeOffsetMismatch {
		/// Next byte required by the retained transfer state.
		expected: u64,
		/// Byte offset requested from the environment.
		actual:   u64,
	},
	/// The blob stream omitted or repeated first-chunk provenance metadata.
	#[error("environment blob stream metadata is invalid")]
	InvalidBlobMetadata,
	/// Blob stream provenance disagreed with the requested content reference.
	#[error("environment blob stream digest does not match the requested reference")]
	BlobDigestMismatch,
	/// Blob stream size metadata disagreed with the requested content reference.
	#[error("environment blob stream size mismatch: expected {expected} bytes, got {actual}")]
	BlobSizeMismatch {
		/// Size declared by the requested content reference.
		expected: u64,
		/// Size observed in metadata or transferred bytes.
		actual:   u64,
	},
	/// The blob stream ended without its successful completion marker.
	#[error("environment blob stream ended before completion")]
	IncompleteBlob,
	/// The destination rejected bytes from a verified blob transfer.
	#[error("failed to persist environment blob")]
	BlobWrite {
		/// Destination write failure.
		#[source]
		source: io::Error,
	},
}

/// A terminal loss of event-stream continuity.
#[derive(Clone, Debug)]
pub struct StreamLost {
	/// The stream family whose ordered history is no longer contiguous.
	pub stream:          EventStreamKind,
	/// Number of events known to have been skipped.
	pub skipped:         u64,
	/// Server-supplied reason for the loss.
	pub reason:          Str,
	/// Resource-specific action required before work can safely continue.
	pub reopen_guidance: &'static str,
}

impl Display for StreamLost {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			formatter,
			"environment {:?} stream lost continuity after {} skipped events: {}; {}",
			self.stream, self.skipped, self.reason, self.reopen_guidance
		)
	}
}

/// Invocation-bound authority stamped on every scoped environment request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataScope {
	/// Stable invocation identifier shared across CONTROL, DATA, and the
	/// journal.
	pub invocation_id:      Str,
	/// Core-minted authorization token for this invocation.
	pub effect_token:       Bytes,
	/// Generation of the extension host issuing the request.
	pub host_generation:    u64,
	/// Generation of the owning session.
	pub session_generation: u64,
	/// Whether this invocation is forbidden from allocating pseudo-terminals.
	pub pty_denied:         bool,
	/// Stable durable session principal authenticated by the composing client.
	pub session_id:         Str,
	/// Stable durable agent principal within `session_id`.
	pub agent_id:           Str,
}

impl DataScope {
	/// Creates invocation-bound DATA authority.
	pub fn new(
		invocation_id: impl Into<Str>,
		effect_token: Bytes,
		host_generation: u64,
		session_generation: u64,
	) -> Self {
		Self {
			invocation_id: invocation_id.into(),
			effect_token,
			host_generation,
			session_generation,
			pty_denied: false,
			session_id: Str::default(),
			agent_id: Str::default(),
		}
	}

	/// Binds the stable durable session and agent principals for this scope.
	#[must_use]
	pub fn with_principal(mut self, session_id: impl Into<Str>, agent_id: impl Into<Str>) -> Self {
		self.session_id = session_id.into();
		self.agent_id = agent_id.into();
		self
	}

	/// Narrows this invocation so no environment operation can allocate a PTY.
	#[must_use]
	pub const fn deny_pty(mut self) -> Self {
		self.pty_denied = true;
		self
	}

	fn wire(&self) -> InvocationScope {
		InvocationScope {
			invocation_id: self.invocation_id.to_string(),
			effect_token: self.effect_token.clone(),
			host_generation: self.host_generation,
			session_generation: self.session_generation,
			pty_denied: self.pty_denied,
			session_id: self.session_id.to_string(),
			agent_id: self.agent_id.to_string(),
			..InvocationScope::default()
		}
	}
}

/// Stable authenticated owner of top-level tool invocations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvocationPrincipal {
	/// Durable chat/session identity.
	pub session_id: Str,
	/// Durable agent identity within the session.
	pub agent_id:   Str,
}

impl InvocationPrincipal {
	/// Validates and constructs a durable invocation principal.
	pub fn new(session_id: impl Into<Str>, agent_id: impl Into<Str>) -> Result<Self, ClientError> {
		let session_id = session_id.into();
		let agent_id = agent_id.into();
		if session_id.is_empty() || agent_id.is_empty() {
			return Err(ClientError::InvalidInvocationPrincipal);
		}
		Ok(Self { session_id, agent_id })
	}
}

/// Session-minted restrictions stamped on each top-level tool invocation.
///
/// Restrictions only narrow authority. Cloning an [`EnvClient`] with a
/// different grant does not mutate the shared transport or another session.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InvocationGrant {
	pty_denied: bool,
}

impl InvocationGrant {
	/// Creates an unrestricted invocation grant.
	pub const fn unrestricted() -> Self {
		Self { pty_denied: false }
	}

	/// Denies pseudo-terminal allocation for invocations carrying this grant.
	#[must_use]
	pub const fn deny_pty(mut self) -> Self {
		self.pty_denied = true;
		self
	}

	/// Returns whether pseudo-terminal allocation is denied.
	pub const fn pty_denied(self) -> bool {
		self.pty_denied
	}

	fn wire(self, invocation_id: &str, principal: Option<&InvocationPrincipal>) -> InvocationScope {
		InvocationScope {
			invocation_id: invocation_id.to_owned(),
			pty_denied: self.pty_denied,
			session_id: principal.map_or_else(String::new, |owner| owner.session_id.to_string()),
			agent_id: principal.map_or_else(String::new, |owner| owner.agent_id.to_string()),
			..InvocationScope::default()
		}
	}
}

/// The client half of a transport-neutral bidirectional `env/v1` frame channel.
///
/// A UDS, mTLS, or other remote transport can decode frames into `incoming`
/// and encode frames received from `outgoing`. [`Self::in_process`] creates the
/// same boundary from flume channels for a colocated environment host.
#[derive(Clone, Debug)]
pub struct EnvClient {
	inner:     Arc<ClientInner>,
	grant:     InvocationGrant,
	principal: Option<InvocationPrincipal>,
}
/// Cloneable out-of-band control for one active environment execution.
///
/// Unlike [`ExecRun`], this handle does not own the execution stream or its
/// cancellation guard. It is safe to hand to a UI overlay: every operation is
/// resolved by the Environment from the opaque execution id and remains
/// generation-fenced by the invocation scope.
#[derive(Clone, Debug)]
pub struct ActiveExecControl {
	client: EnvClient,
	exec:   Bytes,
}

impl ActiveExecControl {
	/// Returns the opaque execution identity.
	pub const fn exec_id(&self) -> &Bytes {
		&self.exec
	}

	/// Writes bytes to the active execution's stdin.
	pub async fn stdin(&self, data: Bytes) -> Result<bool, ClientError> {
		self
			.client
			.exec_live_control(exec_session_op::Op::Stdin(StdinFrame {
				exec:  self.exec.clone(),
				input: Some(stdin_frame::Input::Data(data)),
				props: None,
			}))
			.await
	}

	/// Closes the active execution's stdin.
	pub async fn eof(&self) -> Result<bool, ClientError> {
		self
			.client
			.exec_live_control(exec_session_op::Op::Stdin(StdinFrame {
				exec:  self.exec.clone(),
				input: Some(stdin_frame::Input::Eof(true)),
				props: None,
			}))
			.await
	}

	/// Resizes the active execution's pseudo-terminal.
	pub async fn resize(&self, rows: u32, columns: u32) -> Result<bool, ClientError> {
		self
			.client
			.exec_live_control(exec_session_op::Op::Resize(env_wire::ResizeRequest {
				exec: self.exec.clone(),
				rows,
				columns,
				props: None,
			}))
			.await
	}

	/// Sends one named process-group signal.
	pub async fn signal(&self, signal: impl Into<String>) -> Result<bool, ClientError> {
		self
			.client
			.exec_live_control(exec_session_op::Op::Signal(SignalRequest {
				exec:   self.exec.clone(),
				signal: signal.into(),
				props:  None,
			}))
			.await
	}

	/// Applies resource-owned graceful or forced cancellation.
	pub async fn cancel(
		&self,
		control: env_wire::ExecControlKind,
		grace_ms: u64,
	) -> Result<bool, ClientError> {
		Ok(self
			.client
			.exec_control(env_wire::ExecControlRequest {
				exec: self.exec.clone(),
				control: control as i32,
				grace_ms,
				wire_revision: omp_proto::SCHEMA_REV,
			})
			.await?
			.accepted)
	}
}
struct ClientInner {
	outgoing:               Sender<ClientFrame>,
	pending:                Mutex<HashMap<u64, Sender<ServerFrame>>>,
	request_scopes:         Mutex<HashMap<u64, InvocationScope>>,
	edit_repair_scopes:     Mutex<HashMap<u64, InvocationScope>>,
	acp_request_scopes:     Mutex<HashMap<u64, InvocationScope>>,
	hello_waiter:           Mutex<Option<Sender<ServerFrame>>>,
	info:                   Mutex<Option<ServerHello>>,
	owner_last_transaction: Mutex<Option<TransactionId>>,
	events:                 Receiver<ServerFrame>,
	edit_repair_requests:   Receiver<EditRepairRequest>,
	acp_requests:           Receiver<AcpRequest>,
	next_id:                AtomicU64,
	cancel:                 Sender<u64>,
	lease_close:            Sender<LeaseClose>,
	admitter:               Mutex<Option<Arc<dyn AdmissionDispatcher>>>,
}

trait AdmissionDispatcher: Send + Sync {
	fn dispatch(&self, client: Arc<ClientInner>, request_id: u64, query: AdmitInvocation);
}

struct AdmitterDispatcher<A> {
	admitter: Arc<A>,
	runtime:  runtime::Handle,
}
impl<A: Admitter> AdmissionDispatcher for AdmitterDispatcher<A> {
	fn dispatch(&self, client: Arc<ClientInner>, request_id: u64, query: AdmitInvocation) {
		let admitter = Arc::clone(&self.admitter);
		let invocation_id = query.invocation_id.clone();
		let task_client = Arc::clone(&client);
		drop(self.runtime.spawn(async move {
			let mut admission = admitter.admit(query).await;
			admission.invocation_id = invocation_id;
			let _ = task_client
				.outgoing
				.send_async(ClientFrame {
					request_id,
					body: Some(client_frame::Body::Admission(admission)),
					..ClientFrame::default()
				})
				.await;
		}));
	}
}

impl fmt::Debug for ClientInner {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ClientInner")
			.field("next_id", &self.next_id.load(Ordering::Relaxed))
			.finish_non_exhaustive()
	}
}

#[derive(Debug)]
struct LeaseClose {
	lease_id: Bytes,
	scope:    Option<DataScope>,
}

/// One daemon-generated syntax-repair request.
#[derive(Clone, Debug)]
pub struct EditRepairRequest {
	/// Correlation identifier to echo when answering this query.
	pub request_id: u64,
	/// Typed prompt and invoking tool identity supplied by the daemon.
	pub query:      EditRepairQuery,
}
/// One typed ACP request initiated by the environment daemon.
#[derive(Clone, Debug)]
pub enum AcpRequest {
	/// Reads one document through the bound ACP editor.
	Read {
		/// Frame request identifier used to retain invocation authority.
		request_id: u64,
		/// Typed document read query.
		query:      AcpReadQuery,
	},
	/// Writes one document through the bound ACP editor.
	Write {
		/// Frame request identifier used to retain invocation authority.
		request_id: u64,
		/// Typed document write query.
		query:      AcpWriteQuery,
	},
	/// Starts one command through the bound ACP terminal.
	Exec {
		/// Frame request identifier used to retain invocation authority.
		request_id: u64,
		/// Typed command query.
		query:      AcpExecQuery,
	},
	/// Cancels one command running through the bound ACP terminal.
	ExecCancel {
		/// Frame request identifier carrying the original invocation authority.
		request_id: u64,
		/// Typed command cancellation.
		cancel:     AcpExecCancel,
	},
}

/// The server half of an in-process `env/v1` frame transport.
///
/// This type contains transport endpoints only. It does not implement or own
/// any environment resources.
#[derive(Debug)]
pub struct InProcessEnvTransport {
	requests:  Receiver<ClientFrame>,
	responses: Sender<ServerFrame>,
}

/// A correlated stream of raw server frames for one request.
#[derive(Debug)]
pub struct RequestStream {
	request_id: u64,
	receiver:   Receiver<ServerFrame>,
	client:     Weak<ClientInner>,
	finished:   bool,
}

/// One open tool invocation and its correlated event stream.
#[derive(Debug)]
pub struct Invocation {
	client:    EnvClient,
	id:        Str,
	grant:     InvocationGrant,
	principal: Option<InvocationPrincipal>,
	guard:     Option<RunGuard>,
	stream:    RequestStream,
}

/// A typed event on a tool invocation stream.
#[derive(Debug)]
pub enum InvocationEvent {
	/// The environment accepted the invocation channel.
	Accepted(InvokeAccepted),
	/// Core must answer the environment's admission query before authorization.
	Admission(AdmitInvocation),
	/// Serialized typed progress from the executor.
	Update(Update),
	/// The terminal structured tool outcome and canonical model-facing parts.
	Verdict(Verdict),
}

/// One command running inside a server-owned exec session.
#[derive(Debug)]
pub struct ExecRun {
	client: EnvClient,
	scope:  Option<DataScope>,
	guard:  Option<RunGuard>,
	stream: RequestStream,
}

/// A typed event on an exec request stream.
#[derive(Debug)]
pub enum ExecEvent {
	/// The command was created and has an exec identifier.
	Started(ExecStarted),
	/// Ordered stdout, stderr, or PTY bytes.
	Output(OutputFrame),
	/// The terminal command status.
	Exit(ExitEvent),
}

/// A correlated named-process output attachment.
#[derive(Debug)]
pub struct ProcessAttachment {
	stream: RequestStream,
}

/// One event from a named-process output attachment.
#[derive(Debug)]
pub enum ProcessAttachmentEvent {
	/// The server established the attachment and identified its generation.
	Attached(OutputAttached),
	/// Ordered output from the attached process generation.
	Output(ProcessOutput),
	/// A lifecycle transition for the named process.
	State(ProcessStateEvent),
}

/// A streaming blob download.
///
/// Unlike a detached raw request stream, dropping an incomplete blob download
/// cancels its server-side transfer.
#[derive(Debug)]
pub struct BlobDownload {
	request: GetRequest,
	stream:  RequestStream,
}

/// One event from a blob download.
#[derive(Debug)]
pub enum BlobDownloadEvent {
	/// The next ordered bytes in the download.
	Chunk(Chunk),
	/// The successful terminal download marker.
	Complete(BlobGetComplete),
}

/// Provenance verified after a complete bounded blob download.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerifiedBlobTransfer {
	/// SHA-256 digest declared by the caller and recomputed over transferred
	/// bytes.
	pub hash: Hash32,
	/// Exact complete blob size.
	pub size: u64,
}

/// Stateful verifier for a bounded download that may cross connections.
///
/// The state advances only after the destination accepts a complete chunk. If
/// a stream is cancelled or disconnected, [`Self::request`] produces the exact
/// next range request for any replacement environment client. Digest
/// verification spans all resumed segments rather than trusting
/// per-connection metadata alone.
pub struct ResumableBlobTransfer {
	hash:        Hash32,
	size:        u64,
	max_bytes:   u64,
	next_offset: u64,
	hasher:      Hasher,
}

impl ResumableBlobTransfer {
	/// Starts a whole-blob transfer under a caller-owned total byte bound.
	///
	/// # Errors
	///
	/// Returns [`ClientError::BlobTooLarge`] before any request when the
	/// declared complete size exceeds `max_bytes`.
	pub fn new(hash: Hash32, size: u64, max_bytes: u64) -> Result<Self, ClientError> {
		if size > max_bytes {
			return Err(ClientError::BlobTooLarge { size, limit: max_bytes });
		}
		Ok(Self { hash, size, max_bytes, next_offset: 0, hasher: Hasher::new() })
	}

	/// Builds a request for the complete remainder, suitable for a newly
	/// connected client.
	pub fn request(&self) -> GetRequest {
		self.request_range(0)
	}

	/// Builds the next contiguous bounded range request.
	///
	/// `length` follows the wire convention: zero selects the complete
	/// remainder, while a nonzero value caps this request without changing the
	/// complete transfer's digest or size provenance.
	pub fn request_range(&self, length: u64) -> GetRequest {
		GetRequest {
			hash: Bytes::copy_from_slice(self.hash.as_bytes()),
			offset: self.next_offset,
			length,
		}
	}

	/// Returns the first byte not yet persisted and verified.
	pub const fn next_offset(&self) -> u64 {
		self.next_offset
	}

	/// Returns whether all declared bytes have been persisted.
	pub const fn is_complete(&self) -> bool {
		self.next_offset == self.size
	}
}

/// A streaming, correlated blob upload.
#[derive(Debug)]
pub struct BlobUpload {
	client:     EnvClient,
	scope:      Option<DataScope>,
	request_id: u64,
	stream:     RequestStream,
}

/// An invocation-scoped client whose public surface cannot invoke tools,
/// manage named processes, renegotiate the connection, or retire the server.
#[derive(Clone, Debug)]
pub struct WorkerEnvClient {
	client:           EnvClient,
	scope:            DataScope,
	last_transaction: Arc<Mutex<Option<TransactionId>>>,
}
/// An extension-host connection permanently bound to one invocation scope.
///
/// Construction performs the sole connection handshake before hiding the
/// underlying [`EnvClient`]. Every subsequently exposed operation carries the
/// immutable scope; tool invocation, handshake, admission, shutdown, and
/// server-retirement frames are not representable through this surface.
#[derive(Clone, Debug)]
pub struct ExtensionEnvClient {
	worker:     WorkerEnvClient,
	#[cfg(unix)]
	_transport: Arc<ExtensionTransport>,
}

#[cfg(unix)]
#[derive(Debug)]
struct ExtensionTransport {
	bridge: AbortHandle,
}

#[cfg(unix)]
impl Drop for ExtensionTransport {
	fn drop(&mut self) {
		self.bridge.abort();
	}
}

/// The epoch-qualified identity of a document transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactionId {
	/// Server epoch in which the transaction outcome is retained.
	pub server_epoch: Bytes,
	/// Caller-generated transaction identifier.
	pub txn_id:       Bytes,
}

/// An open, connection-owned document lease.
#[derive(Debug)]
#[must_use]
pub struct DocumentLease {
	client:   EnvClient,
	scope:    Option<DataScope>,
	lease_id: Bytes,
	head:     DocumentHead,
	events:   DocumentEvents,
	released: bool,
}

/// A typed document read response.
#[derive(Debug)]
pub struct DocumentRead {
	response: ReadDocumentResponse,
}

/// A terminal document transaction outcome.
#[derive(Debug)]
pub enum TransactionOutcome {
	/// Every operation committed durably.
	Committed(TransactionCommitted),
	/// No operation committed; the supplied precondition or revision was
	/// rejected.
	Rejected(TransactionRejected),
	/// A durable prefix committed before a later operation failed.
	///
	/// Callers must not infer rollback.
	Partial(TransactionPartiallyCommitted),
}

/// Correlated events for one open document lease.
#[derive(Debug)]
pub struct DocumentEvents {
	stream: RequestStream,
}

/// One connection-wide LSP registry event.
#[derive(Debug)]
pub enum LspStreamEvent {
	/// Initial bindings returned by the subscription request.
	Bindings(GetLspBindingsResponse),
	/// A language-server notification.
	Event(LspEvent),
	/// A binding lifecycle change.
	Binding(LspBindingEvent),
}

/// Correlated connection-wide LSP events.
#[derive(Debug)]
pub struct LspEvents {
	stream: RequestStream,
}

/// One streaming workspace walk item.
#[derive(Debug)]
pub enum WalkEvent {
	/// One matching workspace entry.
	Entry(WalkEntry),
	/// Terminal walk accounting.
	Complete(WalkComplete),
}

/// A correlated streaming workspace walk.
#[derive(Debug)]
pub struct WalkStream {
	stream: RequestStream,
}

/// One streaming workspace search item.
#[derive(Debug)]
pub enum SearchEvent {
	/// One matching line.
	Match(SearchMatchMsg),
	/// Terminal search accounting.
	Complete(SearchComplete),
}

/// A correlated streaming workspace search.
#[derive(Debug)]
pub struct SearchStream {
	stream: RequestStream,
}

/// One item returned by a generic scoped DATA stream.
#[derive(Debug)]
pub enum DataStreamItem {
	/// A nonterminal event.
	Event(DataEvent),
	/// A terminal response.
	Response(DataResponse),
}

/// A generic scoped DATA request stream.
#[derive(Debug)]
pub struct DataStream {
	stream: RequestStream,
}

/// One typed DAP stream item.
#[derive(Debug)]
pub enum DapStreamEvent {
	/// The session was launched or attached.
	Session(document::DapSessionResponse),
	/// The action's terminal response.
	Action(document::DapActionResponse),
	/// Ordered adapter output.
	Output(document::DapOutput),
	/// Ordered adapter lifecycle or debugger event.
	Event(document::DapEvent),
}

/// A cancellable DAP launch, attach, or action stream.
#[derive(Debug)]
pub struct DapStream {
	stream: RequestStream,
}

/// One internal-resource completion item.
#[derive(Debug)]
pub enum ResourceCompletionEvent {
	/// One scored completion.
	Completion(ResourceCompletion),
	/// Terminal completion accounting.
	Complete(env_wire::ResourceCompletionComplete),
}

/// A cancellable internal-resource completion stream.
#[derive(Debug)]
pub struct ResourceCompletionStream {
	stream: RequestStream,
}

/// One MCP subscription item.
#[derive(Debug)]
pub enum McpSubscriptionEvent {
	/// Server notification.
	Notification(env_wire::McpNotification),
	/// Lifecycle/status transition.
	Status(env_wire::McpServerStatus),
}

/// A cancellable MCP notification and status subscription.
#[derive(Debug)]
pub struct McpSubscription {
	stream: RequestStream,
}
impl EnvClient {
	/// Builds a client over decoded bidirectional frame channels.
	///
	/// `outgoing` carries client frames to the transport and `incoming` carries
	/// decoded server frames back. A dispatcher thread performs correlation;
	/// this client owns no async runtime or world resource.
	pub fn from_channels(outgoing: Sender<ClientFrame>, incoming: Receiver<ServerFrame>) -> Self {
		let (events_tx, events) = flume::unbounded();
		let (edit_repair_tx, edit_repair_requests) = flume::unbounded();
		let (acp_tx, acp_requests) = flume::unbounded();
		let (cancel, cancellations) = flume::unbounded();
		let (lease_close, lease_closes) = flume::unbounded();
		let inner = Arc::new(ClientInner {
			outgoing,
			pending: Mutex::new(HashMap::new()),
			request_scopes: Mutex::new(HashMap::new()),
			edit_repair_scopes: Mutex::new(HashMap::new()),
			acp_request_scopes: Mutex::new(HashMap::new()),
			hello_waiter: Mutex::new(None),
			info: Mutex::new(None),
			owner_last_transaction: Mutex::new(None),
			events,
			edit_repair_requests,
			acp_requests,
			next_id: AtomicU64::new(1),
			cancel,
			lease_close,
			admitter: Mutex::new(None),
		});
		let router = Arc::downgrade(&inner);
		let _ = thread::spawn(move || {
			route_responses(router, incoming, events_tx, edit_repair_tx, acp_tx);
		});
		let canceller = Arc::downgrade(&inner);
		let _ = thread::spawn(move || route_cancellations(canceller, cancellations));
		let closer = Arc::downgrade(&inner);
		let _ = thread::spawn(move || route_lease_closes(closer, lease_closes));
		Self { inner, grant: InvocationGrant::unrestricted(), principal: None }
	}

	/// Returns a transport-sharing client whose tool invocations carry `grant`.
	///
	/// The grant is immutable and local to the returned clone.
	#[must_use]
	pub fn with_invocation_grant(&self, grant: InvocationGrant) -> Self {
		Self { inner: Arc::clone(&self.inner), grant, principal: self.principal.clone() }
	}

	/// Returns a transport-sharing client bound to one durable invocation owner.
	///
	/// The principal is stamped on every top-level tool invocation and remains
	/// stable across reconnects because it never derives from the transport.
	pub fn with_principal(
		&self,
		session_id: impl Into<Str>,
		agent_id: impl Into<Str>,
	) -> Result<Self, ClientError> {
		Ok(Self {
			inner:     Arc::clone(&self.inner),
			grant:     self.grant,
			principal: Some(InvocationPrincipal::new(session_id, agent_id)?),
		})
	}

	/// Creates an in-process client/server frame channel.
	///
	/// Capacity zero selects unbounded channels. A nonzero capacity applies
	/// backpressure to ordinary asynchronous frame sends; guard cancellation is
	/// first queued on a separate unbounded control channel so drop never
	/// blocks.
	pub fn in_process(capacity: usize) -> (Self, InProcessEnvTransport) {
		let (frames, transport) = crate::partition::in_process_frames(capacity);
		let (outgoing, incoming) = frames.into_parts();
		(Self::from_channels(outgoing, incoming), transport)
	}

	/// Performs the request-id-zero protocol handshake.
	#[tracing::instrument(name = "environment_handshake", level = "debug", skip_all)]
	pub async fn hello(&self, hello: ClientHello) -> Result<ServerHello, ClientError> {
		let (sender, receiver) = flume::bounded(1);
		{
			let mut slot = self.inner.hello_waiter.lock();
			if slot.is_some() {
				return Err(ClientError::UnexpectedResponse { expected: "a single in-flight hello" });
			}
			*slot = Some(sender);
		}
		let send = self
			.inner
			.outgoing
			.send_async(ClientFrame {
				request_id: 0,
				body: Some(client_frame::Body::Hello(hello)),
				..ClientFrame::default()
			})
			.await;
		if send.is_err() {
			self.inner.hello_waiter.lock().take();
			return Err(ClientError::TransportClosed);
		}
		let frame = receiver
			.recv_async()
			.await
			.map_err(|_| ClientError::TransportClosed)?;
		match frame.body {
			Some(server_frame::Body::Hello(response)) => {
				*self.inner.info.lock() = Some(response.clone());
				Ok(response)
			},
			Some(server_frame::Body::Error(error)) => Err(protocol_error(error)),
			_ => Err(ClientError::UnexpectedResponse { expected: "ServerHello" }),
		}
	}

	/// Returns the cached server handshake, if this client has completed one.
	pub fn info(&self) -> Option<ServerHello> {
		self.inner.info.lock().clone()
	}

	/// Subscribes to daemon-generated syntax-repair queries.
	///
	/// Every clone receives work from the same single-consumer queue. The queue
	/// closes when the environment response transport disconnects.
	pub fn edit_repair_requests(&self) -> Receiver<EditRepairRequest> {
		self.inner.edit_repair_requests.clone()
	}

	/// Answers one syntax-repair query without opening a correlated response
	/// route.
	///
	/// The answer retains the invoking tool's original authority scope.
	pub async fn answer_edit_repair(
		&self,
		request_id: u64,
		answer: EditRepairAnswer,
	) -> Result<(), ClientError> {
		let scope = self
			.inner
			.edit_repair_scopes
			.lock()
			.remove(&request_id)
			.ok_or(ClientError::ScopedOperationDenied)?;
		self
			.inner
			.outgoing
			.send_async(ClientFrame {
				request_id,
				body: Some(client_frame::Body::EditRepairAnswer(answer)),
				scope: Some(scope),
				..ClientFrame::default()
			})
			.await
			.map_err(|_| ClientError::TransportClosed)
	}

	/// Subscribes to typed ACP document and terminal requests.
	///
	/// Every clone receives work from the same single-consumer queue. ACP
	/// requests bypass ordinary correlated response streams, and this queue
	/// closes when the environment response transport disconnects.
	pub fn acp_requests(&self) -> Receiver<AcpRequest> {
		self.inner.acp_requests.clone()
	}

	/// Binds or unbinds this connection as an ACP document and terminal host.
	///
	/// Binding is an unsolicited request-id-zero control frame and is only
	/// valid after the protocol handshake. The send never waits for transport
	/// capacity.
	pub fn bind_acp(&self, documents: bool, exec: bool) -> Result<(), ClientError> {
		if self.inner.info.lock().is_none() {
			return Err(ClientError::UnexpectedResponse {
				expected: "a completed environment handshake before ACP binding",
			});
		}
		self
			.inner
			.outgoing
			.try_send(ClientFrame {
				request_id: 0,
				body: Some(client_frame::Body::AcpBind(AcpBind { documents, exec })),
				..ClientFrame::default()
			})
			.map_err(|error| match error {
				flume::TrySendError::Full(_) => ClientError::TransportBusy,
				flume::TrySendError::Disconnected(_) => ClientError::TransportClosed,
			})
	}

	/// Answers one ACP document query without opening a correlated response
	/// route.
	///
	/// The answer retains the invocation authority captured from the query's
	/// original request scope.
	pub async fn answer_acp_document(
		&self,
		request_id: u64,
		answer: AcpDocumentAnswer,
	) -> Result<(), ClientError> {
		let scope = self
			.inner
			.acp_request_scopes
			.lock()
			.remove(&request_id)
			.ok_or(ClientError::ScopedOperationDenied)?;
		self
			.inner
			.outgoing
			.send_async(ClientFrame {
				request_id,
				body: Some(client_frame::Body::AcpDocumentAnswer(answer)),
				scope: Some(scope),
				..ClientFrame::default()
			})
			.await
			.map_err(|_| ClientError::TransportClosed)
	}

	/// Sends one typed ACP execution event without opening a correlated
	/// response route.
	///
	/// Started and output events retain the query scope for later events. Exit
	/// and protocol-error events terminate that retained correlation.
	pub async fn send_acp_exec_event(
		&self,
		request_id: u64,
		event: AcpExecEvent,
	) -> Result<(), ClientError> {
		let terminal = matches!(
			event.body.as_ref(),
			Some(env_wire::acp_exec_event::Body::Exit(_) | env_wire::acp_exec_event::Body::Error(_))
		);
		let scope = if terminal {
			self.inner.acp_request_scopes.lock().remove(&request_id)
		} else {
			self
				.inner
				.acp_request_scopes
				.lock()
				.get(&request_id)
				.cloned()
		}
		.ok_or(ClientError::ScopedOperationDenied)?;
		self
			.inner
			.outgoing
			.send_async(ClientFrame {
				request_id,
				body: Some(client_frame::Body::AcpExecEvent(event)),
				scope: Some(scope),
				..ClientFrame::default()
			})
			.await
			.map_err(|_| ClientError::TransportClosed)
	}

	/// Installs the handler for server-initiated admission queries.
	///
	/// The handler must be installed from the async runtime that owns this
	/// client; the frame router schedules answers on that ambient runtime.
	pub fn set_admitter<A: Admitter>(&self, admitter: A) {
		*self.inner.admitter.lock() = Some(Arc::new(AdmitterDispatcher {
			admitter: Arc::new(admitter),
			runtime:  runtime::Handle::current(),
		}));
	}

	/// Restricts this connection to one invocation-bound worker authority.
	///
	/// The returned surface deliberately exposes no tool invocation, named
	/// process, blob deletion, hello, or retire operation.
	pub fn worker_scope(&self, scope: DataScope) -> WorkerEnvClient {
		WorkerEnvClient { client: self.clone(), scope, last_transaction: Arc::new(Mutex::new(None)) }
	}

	/// Asks the serving daemon to retire its listening socket.
	///
	/// The server stops accepting new connections and releases the endpoint.
	/// Existing connections, including this one, continue until closed or
	/// drained. This resolves once the server acknowledges with
	/// `RetireStarted`. Pre-change servers reject the request with a protocol
	/// error, which surfaces as [`ClientError::Protocol`].
	pub async fn retire(&self) -> Result<(), ClientError> {
		match self
			.one_shot(client_frame::Body::Retire(Retire::default()), None)
			.await?
		{
			server_frame::Body::RetireStarted(_) => Ok(()),
			_ => Err(ClientError::UnexpectedResponse { expected: "RetireStarted" }),
		}
	}

	/// Begins graceful Environment shutdown and waits for admission closure.
	pub async fn shutdown(
		&self,
		request: env_wire::ShutdownRequest,
	) -> Result<env_wire::ShutdownAcknowledged, ClientError> {
		match self
			.one_shot(client_frame::Body::Shutdown(request), None)
			.await?
		{
			server_frame::Body::ShutdownAcknowledged(acknowledged) => Ok(acknowledged),
			_ => Err(ClientError::UnexpectedResponse { expected: "ShutdownAcknowledged" }),
		}
	}

	/// Disposes every persistent evaluation session owned by the Environment.
	pub async fn reset_eval(&self) -> Result<(), ClientError> {
		match self
			.one_shot(client_frame::Body::EvalReset(EvalResetRequest {}), None)
			.await?
		{
			server_frame::Body::EvalReset(_) => Ok(()),
			_ => Err(ClientError::UnexpectedResponse { expected: "EvalResetResponse" }),
		}
	}

	/// Runs one due-checked workspace extension update inspection.
	///
	/// The environment never rewrites the committed workspace lock; `auto`
	/// therefore has notify semantics on this authority.
	pub async fn check_workspace_updates(
		&self,
		request: env_wire::WorkspaceUpdateCheck,
	) -> Result<env_wire::WorkspaceUpdateReport, ClientError> {
		match self
			.one_shot(client_frame::Body::WorkspaceUpdateCheck(request), None)
			.await?
		{
			server_frame::Body::WorkspaceUpdateReport(report) => Ok(report),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceUpdateReport" }),
		}
	}

	/// Registers this connection as one live project client.
	///
	/// The daemon durably publishes the lease and removes it if this connection
	/// closes before [`Self::release_presence`] is called.
	pub async fn register_presence(
		&self,
		request: RegisterPresence,
	) -> Result<PresenceRegistered, ClientError> {
		match self
			.one_shot(client_frame::Body::RegisterPresence(request), None)
			.await?
		{
			server_frame::Body::PresenceRegistered(registered) => Ok(registered),
			_ => Err(ClientError::UnexpectedResponse { expected: "PresenceRegistered" }),
		}
	}

	/// Explicitly releases this connection's daemon presence lease.
	pub async fn release_presence(
		&self,
		request: ReleasePresence,
	) -> Result<PresenceReleased, ClientError> {
		match self
			.one_shot(client_frame::Body::ReleasePresence(request), None)
			.await?
		{
			server_frame::Body::PresenceReleased(released) => Ok(released),
			_ => Err(ClientError::UnexpectedResponse { expected: "PresenceReleased" }),
		}
	}

	/// Materializes one immutable Python site tree through the installer-only
	/// environment connection.
	///
	/// The Environment makes the requested store references available, builds
	/// the complete symlink farm, and atomically replaces `sites/<site_key>`.
	/// Repeating a request with the same manifest returns the existing tree.
	///
	/// This method is intentionally absent from [`WorkerEnvClient`]: extension
	/// connections can read their site tree but cannot mutate any site or store.
	pub async fn materialize_site(
		&self,
		request: MaterializeSite,
	) -> Result<SiteMaterialized, ClientError> {
		let request =
			DataRequest { body: Some(data_request::Body::Site(request)), ..DataRequest::default() };
		match self
			.one_shot(client_frame::Body::Data(request), None)
			.await?
		{
			server_frame::Body::Data(DataResponse {
				body: Some(data_response::Body::Site(response)),
				..
			}) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "SiteMaterialized" }),
		}
	}

	/// Retrieves bounded, versioned host facts from the Environment authority.
	pub async fn host_info(
		&self,
		request: env_wire::HostInfoRequest,
	) -> Result<env_wire::HostInfo, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::HostInfo(request)),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::HostInfo(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "HostInfo" }),
		}
	}

	/// Retrieves the ordered canonical set of primary and granted roots.
	pub async fn workspace_roots(
		&self,
		request: env_wire::WorkspaceRootSetRequest,
	) -> Result<env_wire::WorkspaceRootSet, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::WorkspaceRoots(request)),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::WorkspaceRoots(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceRootSet" }),
		}
	}

	/// Reads the Environment-owned repository snapshot for a granted root.
	pub async fn repository_snapshot(
		&self,
		request: env_wire::RepositorySnapshotRequest,
	) -> Result<env_wire::RepositorySnapshot, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::RepositorySnapshot(request)),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::RepositorySnapshot(snapshot)) => Ok(snapshot),
			_ => Err(ClientError::UnexpectedResponse { expected: "RepositorySnapshot" }),
		}
	}

	/// Captures a generation-fenced workspace snapshot.
	pub async fn snapshot_workspace(
		&self,
		request: env_wire::SnapshotWorkspace,
	) -> Result<env_wire::WorkspaceSnapshot, ClientError> {
		let result = self
			.workspace_request(workspace_op::Op::Snapshot(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::Snapshot(snapshot)) => Ok(snapshot),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceSnapshot" }),
		}
	}

	/// Lists retained workspace snapshots.
	pub async fn list_workspace_snapshots(
		&self,
		request: env_wire::ListWorkspaceSnapshots,
	) -> Result<env_wire::WorkspaceSnapshotList, ClientError> {
		let result = self
			.workspace_request(workspace_op::Op::List(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::List(list)) => Ok(list),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceSnapshotList" }),
		}
	}

	/// Restores or dry-runs one generation-fenced workspace snapshot.
	pub async fn restore_workspace(
		&self,
		request: env_wire::RestoreWorkspace,
	) -> Result<env_wire::WorkspaceRestored, ClientError> {
		let result = self
			.workspace_request(workspace_op::Op::Restore(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::Restored(restored)) => Ok(restored),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceRestored" }),
		}
	}

	/// Returns Environment-owned MCP lifecycle status and definition epoch.
	pub async fn mcp_status(
		&self,
		request: env_wire::McpStatusRequest,
	) -> Result<env_wire::McpStatusResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Status(request)).await?;
		match result.result {
			Some(mcp_result::Result::Status(status)) => Ok(status),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpStatusResult" }),
		}
	}

	/// Executes one finite native MCP configuration operation.
	pub async fn mcp_config(
		&self,
		request: env_wire::McpConfigRequest,
	) -> Result<env_wire::McpConfigResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Config(request)).await?;
		match result.result {
			Some(mcp_result::Result::Config(config)) => Ok(config),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpConfigResult" }),
		}
	}

	/// Resets one MCP server at its exact definition epoch.
	pub async fn mcp_reset(
		&self,
		request: env_wire::McpResetRequest,
	) -> Result<env_wire::McpResetResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Reset(request)).await?;
		match result.result {
			Some(mcp_result::Result::Reset(reset)) => Ok(reset),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpResetResult" }),
		}
	}

	/// Resolves live transport headers without exposing credential ownership.
	pub async fn mcp_live_header(
		&self,
		request: env_wire::McpLiveHeaderRequest,
	) -> Result<env_wire::McpLiveHeader, ClientError> {
		let result = self.mcp_request(mcp_op::Op::LiveHeader(request)).await?;
		match result.result {
			Some(mcp_result::Result::LiveHeader(header)) => Ok(header),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpLiveHeader" }),
		}
	}

	/// Reads one bounded MCP resource.
	pub async fn mcp_resource(
		&self,
		request: env_wire::McpResourceRequest,
	) -> Result<env_wire::McpResourceResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Resource(request)).await?;
		match result.result {
			Some(mcp_result::Result::Resource(resource)) => Ok(resource),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpResourceResult" }),
		}
	}

	/// Renders one bounded MCP prompt.
	pub async fn mcp_prompt(
		&self,
		request: env_wire::McpPromptRequest,
	) -> Result<env_wire::McpPromptResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Prompt(request)).await?;
		match result.result {
			Some(mcp_result::Result::Prompt(prompt)) => Ok(prompt),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpPromptResult" }),
		}
	}

	/// Invokes one MCP tool under Environment lifecycle and timeout authority.
	pub async fn mcp_invoke(
		&self,
		request: env_wire::McpInvokeRequest,
	) -> Result<env_wire::McpInvokeResult, ClientError> {
		let result = self.mcp_request(mcp_op::Op::Invoke(request)).await?;
		match result.result {
			Some(mcp_result::Result::Invoke(invoke)) => Ok(invoke),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpInvokeResult" }),
		}
	}

	/// Opens a cancellable MCP notification/status subscription.
	pub async fn mcp_subscribe(
		&self,
		request: env_wire::McpSubscribeRequest,
	) -> Result<McpSubscription, ClientError> {
		let stream = self
			.open(
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Mcp(env_wire::McpOp {
						op: Some(mcp_op::Op::Subscribe(request)),
					})),
					..DataRequest::default()
				}),
				None,
			)
			.await?;
		Ok(McpSubscription { stream })
	}

	/// Creates an Environment-owned isolated worktree.
	pub async fn create_worktree(
		&self,
		request: CreateWorktree,
	) -> Result<WorktreeResult, ClientError> {
		self
			.worktree_request(worktree_op::Op::Create(request))
			.await
	}

	/// Destroys an Environment-owned isolated worktree.
	pub async fn destroy_worktree(
		&self,
		request: DestroyWorktree,
	) -> Result<WorktreeResult, ClientError> {
		self
			.worktree_request(worktree_op::Op::Destroy(request))
			.await
	}

	/// Produces the selected Environment-owned worktree disposition.
	pub async fn merge_worktree(
		&self,
		request: MergeWorktree,
	) -> Result<WorktreeResult, ClientError> {
		self.worktree_request(worktree_op::Op::Merge(request)).await
	}

	/// Opens a connection-owned document lease without an invocation scope.
	///
	/// Owner document operations are routed to the Environment's DATA authority
	/// with an omitted frame scope.
	pub async fn open_document(
		&self,
		path: &EnvPath,
		language_id: Option<&str>,
	) -> Result<DocumentLease, ClientError> {
		self.open_document_scoped(path, language_id, None).await
	}

	/// Reads a revision or selection from an owner document lease.
	pub async fn read_document(
		&self,
		lease: &DocumentLease,
		revision: Option<Revision>,
		selection: Option<ReadSelection>,
	) -> Result<DocumentRead, ClientError> {
		self
			.read_document_scoped(lease, revision, selection, None)
			.await
	}

	/// Reads policy-authorized metadata for an exact environment path.
	pub async fn stat_path(&self, path: &EnvPath) -> Result<document::PathMetadata, ClientError> {
		let response = self
			.data_request_owned(document_request(document_op::Op::Stat(document::StatPathRequest {
				uri:             self.path_uri(path)?,
				follow_symlinks: document::FollowSymlinks::Yes as i32,
			})))
			.await?;
		document_result(response, "StatPathResponse", |result| {
			let document_result::Result::Stat(stat) = result else {
				return None;
			};
			stat.metadata
		})
	}

	/// Lists policy-authorized immediate children of an exact environment path.
	pub async fn list_directory(
		&self,
		path: &EnvPath,
	) -> Result<Vec<document::DirectoryEntry>, ClientError> {
		let response = self
			.data_request_owned(document_request(document_op::Op::ListDirectory(
				document::ListDirectoryRequest {
					uri:             self.path_uri(path)?,
					follow_symlinks: document::FollowSymlinks::Yes as i32,
				},
			)))
			.await?;
		document_result(response, "ListDirectoryResponse", |result| {
			let document_result::Result::Directory(directory) = result else {
				return None;
			};
			Some(directory.entries)
		})
	}

	/// Commits an idempotent owner document transaction.
	///
	/// The epoch-qualified transaction id is retained before transmission so a
	/// caller can reuse it after an ambiguous disconnect.
	pub async fn commit_transaction(
		&self,
		request: CommitTransactionRequest,
	) -> Result<TransactionOutcome, ClientError> {
		self
			.commit_transaction_scoped(request, None, &self.inner.owner_last_transaction)
			.await
	}

	/// Commits one text mutation against an owner lease's pinned revision.
	///
	/// A committed response must contain exactly one complete operation head;
	/// only then is the lease advanced. Rejected and partial outcomes retain the
	/// previous head.
	pub async fn commit_document(
		&self,
		lease: &mut DocumentLease,
		transaction_id: Bytes,
		mutation: TextMutation,
	) -> Result<TransactionOutcome, ClientError> {
		self
			.commit_document_scoped(
				lease,
				transaction_id,
				mutation,
				None,
				&self.inner.owner_last_transaction,
			)
			.await
	}

	/// Returns the epoch-qualified id of the most recently attempted owner
	/// document transaction.
	pub fn last_transaction(&self) -> Option<TransactionId> {
		self.inner.owner_last_transaction.lock().clone()
	}

	/// Returns the native language-server roster, optionally rediscovering its
	/// configuration.
	pub async fn lsp_status(
		&self,
		reload: bool,
	) -> Result<omp_proto::document::v1::LspStatusResponse, ClientError> {
		let response = self
			.data_request_owned(document_request(document_op::Op::LspStatus(
				document::LspStatusRequest { reload, start: false },
			)))
			.await?;
		document_result(response, "LspStatusResponse", |result| {
			let document_result::Result::LspStatus(status) = result else {
				return None;
			};
			Some(status)
		})
	}

	async fn open_document_scoped(
		&self,
		path: &EnvPath,
		language_id: Option<&str>,
		scope: Option<&DataScope>,
	) -> Result<DocumentLease, ClientError> {
		let request = DataRequest {
			body: Some(data_request::Body::Document(v1::DocumentOp {
				op: Some(document_op::Op::Open(OpenDocumentRequest {
					uri:         self.path_uri(path)?,
					language_id: language_id.unwrap_or_default().to_owned(),
				})),
				..v1::DocumentOp::default()
			})),
			..DataRequest::default()
		};
		let mut stream = self.open(client_frame::Body::Data(request), scope).await?;
		let frame = stream.next().await?.ok_or(ClientError::TransportClosed)?;
		let opened = document_result(response_data(frame)?, "OpenDocumentResponse", |result| {
			let document_result::Result::Opened(opened) = result else {
				return None;
			};
			Some(opened)
		})?;
		let head = opened
			.head
			.ok_or(ClientError::UnexpectedResponse { expected: "DocumentHead" })?;
		if opened.lease_id.is_empty() || !is_revision_pinned(&head) {
			return Err(ClientError::UnexpectedResponse {
				expected: "connection-owned lease id and revision-pinned DocumentHead",
			});
		}
		Ok(DocumentLease {
			client: self.clone(),
			scope: scope.cloned(),
			lease_id: opened.lease_id,
			head,
			events: DocumentEvents { stream },
			released: false,
		})
	}

	async fn read_document_scoped(
		&self,
		lease: &DocumentLease,
		revision: Option<Revision>,
		selection: Option<ReadSelection>,
		scope: Option<&DataScope>,
	) -> Result<DocumentRead, ClientError> {
		self.ensure_lease_scope(lease, scope)?;
		let request = document_request(document_op::Op::Read(ReadDocumentRequest {
			document: Some(lease_target(lease)),
			revision,
			selection,
		}));
		let response = self.data_request_scoped(request, scope).await?;
		let read = document_result(response, "ReadDocumentResponse", |result| {
			let document_result::Result::Read(read) = result else {
				return None;
			};
			Some(read)
		})?;
		let complete_head = read.head.as_ref().is_some_and(is_revision_pinned);
		if !complete_head || read.body.is_none() {
			return Err(ClientError::UnexpectedResponse {
				expected: "complete revision-pinned ReadDocumentResponse",
			});
		}
		Ok(DocumentRead { response: read })
	}

	async fn commit_transaction_scoped(
		&self,
		request: CommitTransactionRequest,
		scope: Option<&DataScope>,
		last_transaction: &Mutex<Option<TransactionId>>,
	) -> Result<TransactionOutcome, ClientError> {
		let server_epoch = self
			.inner
			.info
			.lock()
			.as_ref()
			.map(|info| info.server_epoch.clone())
			.filter(|epoch| !epoch.is_empty())
			.ok_or(ClientError::UnexpectedResponse {
				expected: "nonempty ServerHello.server_epoch before transaction",
			})?;
		let expected_transaction_id = request.transaction_id.clone();
		*last_transaction.lock() =
			Some(TransactionId { server_epoch, txn_id: expected_transaction_id.clone() });
		let response = self
			.data_request_scoped(document_request(document_op::Op::CommitTransaction(request)), scope)
			.await?;
		let transaction = document_result(response, "CommitTransactionResponse", |result| {
			let document_result::Result::Transaction(transaction) = result else {
				return None;
			};
			Some(transaction)
		})?;
		match transaction.outcome {
			Some(commit_transaction_response::Outcome::Committed(committed))
				if committed.transaction_id == expected_transaction_id =>
			{
				Ok(TransactionOutcome::Committed(committed))
			},
			Some(commit_transaction_response::Outcome::Rejected(rejected))
				if rejected.transaction_id == expected_transaction_id =>
			{
				Ok(TransactionOutcome::Rejected(rejected))
			},
			Some(commit_transaction_response::Outcome::PartiallyCommitted(partial))
				if partial.transaction_id == expected_transaction_id =>
			{
				Ok(TransactionOutcome::Partial(partial))
			},
			Some(_) => Err(ClientError::UnexpectedResponse { expected: "matching transaction id" }),
			None => Err(ClientError::UnexpectedResponse { expected: "transaction outcome" }),
		}
	}

	async fn commit_document_scoped(
		&self,
		lease: &mut DocumentLease,
		transaction_id: Bytes,
		mut mutation: TextMutation,
		scope: Option<&DataScope>,
		last_transaction: &Mutex<Option<TransactionId>>,
	) -> Result<TransactionOutcome, ClientError> {
		self.ensure_lease_scope(lease, scope)?;
		mutation.base_revision = Some(
			lease
				.head
				.revision
				.clone()
				.ok_or(ClientError::UnexpectedResponse { expected: "revision-pinned DocumentHead" })?,
		);
		let outcome = self
			.commit_transaction_scoped(
				CommitTransactionRequest {
					transaction_id,
					operations: vec![DocumentMutation {
						document:  Some(lease_target(lease)),
						operation: Some(document_mutation::Operation::Text(mutation)),
					}],
				},
				scope,
				last_transaction,
			)
			.await?;
		if let TransactionOutcome::Committed(committed) = &outcome {
			let head = (committed.operations.len() == 1)
				.then(|| committed.operations[0].head.clone())
				.flatten()
				.filter(is_revision_pinned)
				.ok_or(ClientError::UnexpectedResponse {
					expected: "one committed operation with revision-pinned DocumentHead",
				})?;
			lease.head = head;
		}
		Ok(outcome)
	}

	fn ensure_lease_scope(
		&self,
		lease: &DocumentLease,
		scope: Option<&DataScope>,
	) -> Result<(), ClientError> {
		if Arc::ptr_eq(&self.inner, &lease.client.inner) && lease.scope.as_ref() == scope {
			Ok(())
		} else {
			Err(ClientError::ScopedOperationDenied)
		}
	}

	async fn data_request_scoped(
		&self,
		request: DataRequest,
		scope: Option<&DataScope>,
	) -> Result<DataResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::Data(request), scope)
			.await?
		{
			server_frame::Body::Data(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DataResponse" }),
		}
	}

	async fn data_request_owned(&self, request: DataRequest) -> Result<DataResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::Data(request), None)
			.await?
		{
			server_frame::Body::Data(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DataResponse" }),
		}
	}

	/// Creates a cloneable out-of-band control handle for one active execution.
	pub fn active_exec_control(&self, exec: Bytes) -> ActiveExecControl {
		ActiveExecControl { client: self.clone(), exec }
	}

	/// Applies typed control to one exec generation.
	pub async fn exec_control(
		&self,
		request: env_wire::ExecControlRequest,
	) -> Result<env_wire::ExecControlResult, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::Control(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::Controlled(controlled)) => Ok(controlled),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecControlResult" }),
		}
	}

	async fn exec_live_control(&self, op: exec_session_op::Op) -> Result<bool, ClientError> {
		let result = self.exec_session_request(op).await?;
		match result.result {
			Some(exec_session_result::Result::Controlled(controlled)) => Ok(controlled.accepted),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecControlResult" }),
		}
	}

	async fn exec_session_request(
		&self,
		op: exec_session_op::Op,
	) -> Result<env_wire::ExecSessionResult, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::ExecSession(env_wire::ExecSessionOp { op: Some(op) })),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::ExecSession(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecSessionResult" }),
		}
	}

	async fn mcp_request(&self, op: mcp_op::Op) -> Result<env_wire::McpResult, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::Mcp(env_wire::McpOp { op: Some(op) })),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::Mcp(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "McpResult" }),
		}
	}

	async fn workspace_request(
		&self,
		op: workspace_op::Op,
	) -> Result<env_wire::WorkspaceResult, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::Workspace(env_wire::WorkspaceOp {
					op:    Some(op),
					props: None,
				})),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::Workspace(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceResult" }),
		}
	}

	async fn worktree_request(
		&self,
		operation: worktree_op::Op,
	) -> Result<WorktreeResult, ClientError> {
		let request = DataRequest {
			body: Some(data_request::Body::Worktree(v1::WorktreeOp {
				op: Some(operation),
				..Default::default()
			})),
			..Default::default()
		};
		match self
			.one_shot(client_frame::Body::Data(request), None)
			.await?
		{
			server_frame::Body::Data(DataResponse {
				body: Some(data_response::Body::Worktree(response)),
				..
			}) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorktreeResult" }),
		}
	}

	/// Returns the receiver for unsolicited request-id-zero server events.
	///
	/// Clones share one queue; callers should normally keep a single receiver
	/// and distribute events according to application policy.
	pub fn server_events(&self) -> Receiver<ServerFrame> {
		self.inner.events.clone()
	}

	/// Opens a tool invocation before its arguments have committed.
	#[tracing::instrument(
		name = "invocation_open",
		level = "debug",
		skip_all,
		fields(
			invocation_id = %request.invocation_id,
			tool = %request.name,
			revision = %request.rev,
		)
	)]
	pub async fn invoke(&self, request: InvokeTool) -> Result<Invocation, ClientError> {
		let id = Str::new(request.invocation_id.as_str());
		let (stream, guard) = self
			.open_guarded_wire(
				client_frame::Body::InvokeTool(request),
				Some(self.grant.wire(id.as_str(), self.principal.as_ref())),
			)
			.await?;
		Ok(Invocation {
			client: self.clone(),
			id,
			grant: self.grant,
			principal: self.principal.clone(),
			stream,
			guard: Some(guard),
		})
	}

	/// Opens a persistent, server-owned exec session rooted at `cwd`.
	pub async fn open_session(
		&self,
		cwd: &EnvPath,
		mut request: OpenSessionRequest,
	) -> Result<OpenSessionResponse, ClientError> {
		request.cwd_uri = self.path_uri(cwd)?;
		self.open_session_scoped(request, None).await
	}

	/// Explicitly closes a persistent exec session.
	pub async fn close_session(
		&self,
		request: CloseSessionRequest,
	) -> Result<CloseSessionResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::CloseSession(request), None)
			.await?
		{
			server_frame::Body::SessionClosed(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "CloseSessionResponse" }),
		}
	}

	/// Starts one guarded command inside a persistent session.
	pub async fn exec(&self, request: ExecRequest) -> Result<ExecRun, ClientError> {
		self.exec_scoped(request, None).await
	}

	/// Transfers one live exec generation to a named Environment process.
	///
	/// The correlated exec guard is relinquished only after the daemon
	/// acknowledges ownership, so disconnects cannot silently orphan it.
	pub async fn detach_exec(
		&self,
		run: ExecRun,
		exec: Bytes,
		name: String,
	) -> Result<ProcessStarted, ClientError> {
		let response = self
			.data_request_owned(DataRequest {
				body: Some(data_request::Body::DetachExec(DetachExec {
					exec,
					name,
					props: Default::default(),
				})),
				..DataRequest::default()
			})
			.await?;
		let Some(data_response::Body::DetachedExec(started)) = response.body else {
			return Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" });
		};
		let mut stream = run.relinquish();
		stream.finish();
		Ok(started)
	}

	/// Starts or replaces a server-owned named process rooted at `cwd`.
	pub async fn start_process(
		&self,
		cwd: &EnvPath,
		mut request: StartProcess,
	) -> Result<ProcessStarted, ClientError> {
		request.spec.get_or_insert_default().cwd_uri = self.path_uri(cwd)?;
		match self
			.one_shot(client_frame::Body::StartProcess(request), None)
			.await?
		{
			server_frame::Body::ProcessStarted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" }),
		}
	}

	/// Lists the server-owned named processes visible to this environment.
	pub async fn list_processes(&self, request: ListProcesses) -> Result<ProcessList, ClientError> {
		match self
			.one_shot(client_frame::Body::ListProcesses(request), None)
			.await?
		{
			server_frame::Body::ProcessList(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessList" }),
		}
	}

	/// Restarts one exact server-owned named-process generation.
	pub async fn restart_process(
		&self,
		request: RestartProcess,
	) -> Result<ProcessStarted, ClientError> {
		match self
			.one_shot(client_frame::Body::RestartProcess(request), None)
			.await?
		{
			server_frame::Body::ProcessRestarted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" }),
		}
	}

	/// Attaches to ordered output and state events for one named-process
	/// generation.
	pub async fn attach_output(
		&self,
		request: AttachOutput,
	) -> Result<ProcessAttachment, ClientError> {
		let stream = self
			.open(client_frame::Body::AttachOutput(request), None)
			.await?;
		Ok(ProcessAttachment { stream })
	}

	/// Sends bytes or EOF to one generation of a server-owned named process.
	pub async fn send_process_input(
		&self,
		request: SendInput,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::SendInput(request))
			.await
	}

	/// Sends a signal to one generation of a server-owned named process.
	pub async fn signal_process(
		&self,
		request: SignalProcess,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::SignalProcess(request))
			.await
	}

	/// Stops one generation of a server-owned named process.
	pub async fn stop_process(
		&self,
		request: StopProcess,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::StopProcess(request))
			.await
	}

	/// Checks whether a content-addressed blob is present.
	pub async fn blob_stat(&self, request: StatRequest) -> Result<StatResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::BlobStat(request), None)
			.await?
		{
			server_frame::Body::BlobStat(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "StatResponse" }),
		}
	}

	/// Starts a streaming blob download.
	pub async fn blob_get(&self, request: GetRequest) -> Result<BlobDownload, ClientError> {
		let stream = self
			.open(client_frame::Body::BlobGet(request.clone()), None)
			.await?;
		Ok(BlobDownload { request, stream })
	}

	/// Starts a streaming blob download attributed to one tool invocation.
	///
	/// The durable session principal bound by [`Self::with_principal`] and the
	/// invocation id travel in the outer frame scope. A remote blob authority
	/// uses that provenance to release exactly the matching delivery lease
	/// after a complete or resumed transfer; generic hash reads never release a
	/// detached-job lease.
	pub async fn blob_get_for_invocation(
		&self,
		invocation_id: &str,
		request: GetRequest,
	) -> Result<BlobDownload, ClientError> {
		let scope = self.grant.wire(invocation_id, self.principal.as_ref());
		let (stream, guard) = self
			.open_guarded_wire(client_frame::Body::BlobGet(request.clone()), Some(scope))
			.await?;
		guard.relinquish();
		Ok(BlobDownload { request, stream })
	}

	/// Starts a streaming blob upload.
	///
	/// Call [`BlobUpload::send_chunk`] in order and finish with
	/// [`BlobUpload::commit`]. Dropping an uncommitted upload only abandons its
	/// client-side response route; blob visibility remains gated by the commit
	/// frame.
	pub fn blob_put(&self) -> Result<BlobUpload, ClientError> {
		let request_id = self.allocate_request_id()?;
		let stream = self.register(request_id);
		Ok(BlobUpload { client: self.clone(), scope: None, request_id, stream })
	}

	/// Deletes one content-addressed blob.
	pub async fn blob_delete(&self, request: DeleteRequest) -> Result<DeleteResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::BlobDelete(request), None)
			.await?
		{
			server_frame::Body::BlobDeleted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DeleteResponse" }),
		}
	}

	async fn process_command(
		&self,
		body: client_frame::Body,
	) -> Result<ProcessCommandAccepted, ClientError> {
		match self.one_shot(body, None).await? {
			server_frame::Body::ProcessCommandAccepted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessCommandAccepted" }),
		}
	}

	async fn one_shot(
		&self,
		body: client_frame::Body,
		scope: Option<&DataScope>,
	) -> Result<server_frame::Body, ClientError> {
		let mut stream = self.open(body, scope).await?;
		let frame = stream.next().await?.ok_or(ClientError::TransportClosed)?;
		stream.finish();
		response_body(frame)
	}

	async fn open(
		&self,
		body: client_frame::Body,
		scope: Option<&DataScope>,
	) -> Result<RequestStream, ClientError> {
		let request_id = self.allocate_request_id()?;
		let stream = self.register(request_id);
		if self.send(request_id, body, scope).await.is_err() {
			stream.unregister();
			return Err(ClientError::TransportClosed);
		}
		Ok(stream)
	}

	async fn open_guarded(
		&self,
		body: client_frame::Body,
		scope: Option<&DataScope>,
	) -> Result<(RequestStream, RunGuard), ClientError> {
		self
			.open_guarded_wire(body, scope.map(DataScope::wire))
			.await
	}

	async fn open_guarded_wire(
		&self,
		body: client_frame::Body,
		scope: Option<InvocationScope>,
	) -> Result<(RequestStream, RunGuard), ClientError> {
		let request_id = self.allocate_request_id()?;
		let stream = self.register(request_id);
		let cancel = scope.clone().map_or_else(
			|| self.inner.cancel.clone(),
			|scope| scoped_cancel_sender(Arc::downgrade(&self.inner), scope),
		);
		let guard = RunGuard::new(request_id, cancel);
		if self.send_wire(request_id, body, scope).await.is_err() {
			stream.unregister();
			guard.relinquish();
			return Err(ClientError::TransportClosed);
		}
		Ok((stream, guard))
	}

	fn register(&self, request_id: u64) -> RequestStream {
		let (sender, receiver) = flume::unbounded();
		self.inner.pending.lock().insert(request_id, sender);
		RequestStream { request_id, receiver, client: Arc::downgrade(&self.inner), finished: false }
	}

	async fn send(
		&self,
		request_id: u64,
		body: client_frame::Body,
		scope: Option<&DataScope>,
	) -> Result<(), ClientError> {
		self
			.send_wire(request_id, body, scope.map(DataScope::wire))
			.await
	}

	async fn send_wire(
		&self,
		request_id: u64,
		body: client_frame::Body,
		scope: Option<InvocationScope>,
	) -> Result<(), ClientError> {
		if let Some(scope) = scope.as_ref() {
			self
				.inner
				.request_scopes
				.lock()
				.insert(request_id, scope.clone());
		}
		let result = self
			.inner
			.outgoing
			.send_async(ClientFrame { request_id, body: Some(body), scope, ..ClientFrame::default() })
			.await
			.map_err(|_| ClientError::TransportClosed);
		if result.is_err() {
			self.inner.request_scopes.lock().remove(&request_id);
		}
		result
	}

	async fn open_session_scoped(
		&self,
		request: OpenSessionRequest,
		scope: Option<&DataScope>,
	) -> Result<OpenSessionResponse, ClientError> {
		match self
			.one_shot(client_frame::Body::OpenSession(request), scope)
			.await?
		{
			server_frame::Body::SessionOpened(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "OpenSessionResponse" }),
		}
	}

	async fn exec_scoped(
		&self,
		request: ExecRequest,
		scope: Option<&DataScope>,
	) -> Result<ExecRun, ClientError> {
		let (stream, guard) = self
			.open_guarded(client_frame::Body::Exec(request), scope)
			.await?;
		Ok(ExecRun { client: self.clone(), scope: scope.cloned(), stream, guard: Some(guard) })
	}

	fn path_uri(&self, path: &EnvPath) -> Result<String, ClientError> {
		let path = path.as_str();
		if path.starts_with("file://") {
			let url = Url::parse(path)
				.map_err(|error| ClientError::InvalidEnvPath(Str::from(error.to_string())))?;
			if url.scheme() != "file" {
				return Err(ClientError::InvalidEnvPath(sf!(
					"environment paths must use the file scheme",
				)));
			}
			return Ok(url.to_string());
		}
		let mut url = if path.starts_with('/') {
			Url::parse("file:///")
				.map_err(|error| ClientError::InvalidEnvPath(Str::from(error.to_string())))?
		} else {
			let info = self.inner.info.lock();
			let root = info
				.as_ref()
				.map(|info| info.root_uri.as_str())
				.filter(|root| !root.is_empty())
				.ok_or(ClientError::UnexpectedResponse {
					expected: "ServerHello root_uri before resolving a relative EnvPath",
				})?;
			Url::parse(root)
				.map_err(|error| ClientError::InvalidEnvPath(Str::from(error.to_string())))?
		};
		if path.starts_with('/') {
			url.set_path(path);
		} else {
			let mut segments = url
				.path_segments_mut()
				.map_err(|()| ClientError::InvalidEnvPath(sf!("workspace root is not hierarchical")))?;
			segments.pop_if_empty();
			for component in path.split('/') {
				match component {
					"" | "." => {},
					".." => {
						return Err(ClientError::InvalidEnvPath(sf!(
							"relative environment paths cannot escape the workspace root",
						)));
					},
					component => {
						segments.push(component);
					},
				}
			}
		}
		url.set_query(None);
		url.set_fragment(None);
		Ok(url.to_string())
	}

	fn allocate_request_id(&self) -> Result<u64, ClientError> {
		self
			.inner
			.next_id
			.try_update(Ordering::Relaxed, Ordering::Relaxed, |request_id| request_id.checked_add(1))
			.map_err(|_| ClientError::RequestIdExhausted)
	}
}

/// Operations available to an extension host after its one-time handshake.
impl ExtensionEnvClient {
	/// Connects to an environment UDS, starts its framing task, completes the
	/// handshake, and permanently installs `scope` on the returned client.
	#[cfg(unix)]
	#[tracing::instrument(
		name = "environment_connect",
		level = "debug",
		skip_all,
		fields(endpoint = %path.as_ref().display())
	)]
	pub async fn connect_uds(
		path: impl AsRef<Path>,
		hello: &ClientHello,
		scope: DataScope,
	) -> Result<Self, ClientError> {
		let stream = UnixStream::connect(path).await?;
		let (outgoing, requests) = flume::bounded(64);
		let (responses, incoming) = flume::bounded(64);
		let client = EnvClient::from_channels(outgoing, incoming);
		let bridge = tokio::spawn(bridge_extension_frames(stream, requests, responses));
		let transport = Arc::new(ExtensionTransport { bridge: bridge.abort_handle() });
		client.hello(hello.clone()).await?;
		Ok(Self { worker: client.worker_scope(scope), _transport: transport })
	}

	/// Returns the immutable invocation authority stamped on every operation.
	pub const fn scope(&self) -> &DataScope {
		self.worker.scope()
	}

	/// Returns the server handshake completed during construction.
	pub fn info(&self) -> Option<ServerHello> {
		self.worker.info()
	}

	/// Performs one extension-authorized DATA request.
	///
	/// Authorization remains server-owned. This broader host surface permits
	/// DATA arms unavailable to a worker while still making non-DATA protocol
	/// and lifecycle frames impossible to construct.
	pub async fn request(&self, request: DataRequest) -> Result<DataResponse, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::Data(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::Data(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DataResponse" }),
		}
	}

	/// Opens one cancellable extension-authorized DATA stream.
	pub async fn stream(&self, request: DataRequest) -> Result<DataStream, ClientError> {
		let stream = self
			.worker
			.client
			.open(client_frame::Body::Data(request), Some(self.scope()))
			.await?;
		Ok(DataStream { stream })
	}

	/// Opens a connection-owned document lease.
	pub async fn open_document(
		&self,
		path: &EnvPath,
		language_id: Option<&str>,
	) -> Result<DocumentLease, ClientError> {
		self.worker.open_document(path, language_id).await
	}

	/// Reads a revision or selection from an owned document lease.
	pub async fn read_document(
		&self,
		lease: &DocumentLease,
		revision: Option<Revision>,
		selection: Option<ReadSelection>,
	) -> Result<DocumentRead, ClientError> {
		self.worker.read_document(lease, revision, selection).await
	}

	/// Commits an idempotent document transaction.
	pub async fn commit_transaction(
		&self,
		request: CommitTransactionRequest,
	) -> Result<TransactionOutcome, ClientError> {
		self.worker.commit_transaction(request).await
	}

	/// Subscribes to LSP bindings and registry events for a document lease.
	pub async fn lsp_events(&self, lease: &DocumentLease) -> Result<LspEvents, ClientError> {
		self.worker.lsp_events(lease).await
	}

	/// Starts a streaming workspace walk.
	pub async fn walk(
		&self,
		root: &EnvPath,
		request: WalkRequest,
	) -> Result<WalkStream, ClientError> {
		self.worker.walk(root, request).await
	}

	/// Starts a streaming workspace search.
	pub async fn search(
		&self,
		root: &EnvPath,
		request: SearchRequest,
	) -> Result<SearchStream, ClientError> {
		self.worker.search(root, request).await
	}

	/// Resolves the primary worktree for this scoped extension invocation.
	pub async fn current_worktree(
		&self,
		request: CurrentWorktree,
	) -> Result<CurrentWorktreeResult, ClientError> {
		let response = self
			.request(DataRequest {
				body: Some(data_request::Body::Worktree(env_wire::WorktreeOp {
					op: Some(worktree_op::Op::Current(request)),
					..Default::default()
				})),
				..Default::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::Worktree(result)) => result
				.current
				.ok_or(ClientError::UnexpectedResponse { expected: "CurrentWorktreeResult" }),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorktreeResult" }),
		}
	}

	/// Captures a generation-fenced workspace snapshot.
	pub async fn snapshot_workspace(
		&self,
		request: env_wire::SnapshotWorkspace,
	) -> Result<env_wire::WorkspaceSnapshot, ClientError> {
		let result = self
			.extension_workspace_request(workspace_op::Op::Snapshot(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::Snapshot(snapshot)) => Ok(snapshot),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceSnapshot" }),
		}
	}

	/// Lists retained workspace snapshots.
	pub async fn list_workspace_snapshots(
		&self,
		request: env_wire::ListWorkspaceSnapshots,
	) -> Result<env_wire::WorkspaceSnapshotList, ClientError> {
		let result = self
			.extension_workspace_request(workspace_op::Op::List(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::List(list)) => Ok(list),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceSnapshotList" }),
		}
	}

	/// Restores or dry-runs one generation-fenced workspace snapshot.
	pub async fn restore_workspace(
		&self,
		request: env_wire::RestoreWorkspace,
	) -> Result<env_wire::WorkspaceRestored, ClientError> {
		let result = self
			.extension_workspace_request(workspace_op::Op::Restore(request))
			.await?;
		match result.result {
			Some(workspace_result::Result::Restored(restored)) => Ok(restored),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceRestored" }),
		}
	}

	/// Opens a scoped exec session.
	pub async fn open_session(
		&self,
		cwd: &EnvPath,
		request: OpenSessionRequest,
	) -> Result<OpenSessionResponse, ClientError> {
		self.worker.open_session(cwd, request).await
	}

	/// Closes a scoped exec session.
	pub async fn close_session(
		&self,
		request: CloseSessionRequest,
	) -> Result<CloseSessionResponse, ClientError> {
		self.worker.close_session(request).await
	}

	/// Starts one guarded command in a scoped exec session.
	pub async fn exec(&self, request: ExecRequest) -> Result<ExecRun, ClientError> {
		self.worker.exec(request).await
	}

	/// Transfers one live scoped exec generation to a named Environment process.
	///
	/// The guard remains armed until the server acknowledges ownership. After
	/// acknowledgement the correlated exec stream is finished locally without
	/// emitting a cancellation frame.
	pub async fn detach_exec(
		&self,
		run: ExecRun,
		exec: Bytes,
		name: String,
	) -> Result<ProcessStarted, ClientError> {
		let response = self
			.request(DataRequest {
				body:  Some(data_request::Body::DetachExec(DetachExec {
					exec,
					name,
					props: Default::default(),
				})),
				props: Default::default(),
			})
			.await?;
		let Some(data_response::Body::DetachedExec(started)) = response.body else {
			return Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" });
		};
		let mut stream = run.relinquish();
		stream.finish();
		Ok(started)
	}

	/// Starts a scoped server-owned named process.
	pub async fn start_process(
		&self,
		cwd: &EnvPath,
		mut request: StartProcess,
	) -> Result<ProcessStarted, ClientError> {
		request.spec.get_or_insert_default().cwd_uri = self.worker.client.path_uri(cwd)?;
		match self
			.worker
			.client
			.one_shot(client_frame::Body::StartProcess(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::ProcessStarted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" }),
		}
	}

	/// Lists named processes visible to this invocation.
	pub async fn list_processes(&self, request: ListProcesses) -> Result<ProcessList, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::ListProcesses(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::ProcessList(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessList" }),
		}
	}

	/// Reads one exact named-process generation.
	pub async fn process_info(&self, request: GetProcess) -> Result<ProcessInfo, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::GetProcess(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::ProcessInfo(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessInfo" }),
		}
	}

	/// Restarts one exact named-process generation.
	pub async fn restart_process(
		&self,
		request: RestartProcess,
	) -> Result<ProcessStarted, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::RestartProcess(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::ProcessRestarted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessStarted" }),
		}
	}

	/// Attaches to ordered output and state events for a named process.
	pub async fn attach_output(
		&self,
		request: AttachOutput,
	) -> Result<ProcessAttachment, ClientError> {
		let stream = self
			.worker
			.client
			.open(client_frame::Body::AttachOutput(request), Some(self.scope()))
			.await?;
		Ok(ProcessAttachment { stream })
	}

	/// Sends bytes or EOF to a named-process generation.
	pub async fn send_process_input(
		&self,
		request: SendInput,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::SendInput(request))
			.await
	}

	/// Sends a signal to a named-process generation.
	pub async fn signal_process(
		&self,
		request: SignalProcess,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::SignalProcess(request))
			.await
	}

	/// Stops a named-process generation.
	pub async fn stop_process(
		&self,
		request: StopProcess,
	) -> Result<ProcessCommandAccepted, ClientError> {
		self
			.process_command(client_frame::Body::StopProcess(request))
			.await
	}

	/// Checks whether a scoped content-addressed blob is present.
	pub async fn blob_stat(&self, request: StatRequest) -> Result<StatResponse, ClientError> {
		self.worker.blob_stat(request).await
	}

	/// Starts a scoped streaming blob download.
	pub async fn blob_get(&self, request: GetRequest) -> Result<BlobDownload, ClientError> {
		self.worker.blob_get(request).await
	}

	/// Starts a scoped streaming blob upload.
	pub fn blob_put(&self) -> Result<BlobUpload, ClientError> {
		self.worker.blob_put()
	}

	/// Deletes one scoped content-addressed blob.
	pub async fn blob_delete(&self, request: DeleteRequest) -> Result<DeleteResponse, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::BlobDelete(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::BlobDeleted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DeleteResponse" }),
		}
	}

	/// Performs one scoped HTTP request through the environment authority.
	pub async fn http(&self, request: HttpRequest) -> Result<HttpResponse, ClientError> {
		match self
			.worker
			.client
			.one_shot(client_frame::Body::HttpRequest(request), Some(self.scope()))
			.await?
		{
			server_frame::Body::HttpResponse(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "HttpResponse" }),
		}
	}

	async fn process_command(
		&self,
		body: client_frame::Body,
	) -> Result<ProcessCommandAccepted, ClientError> {
		match self
			.worker
			.client
			.one_shot(body, Some(self.scope()))
			.await?
		{
			server_frame::Body::ProcessCommandAccepted(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "ProcessCommandAccepted" }),
		}
	}

	async fn extension_workspace_request(
		&self,
		op: workspace_op::Op,
	) -> Result<env_wire::WorkspaceResult, ClientError> {
		let response = self
			.request(DataRequest {
				body: Some(data_request::Body::Workspace(env_wire::WorkspaceOp {
					op:    Some(op),
					props: None,
				})),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::Workspace(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "WorkspaceResult" }),
		}
	}
}

impl WorkerEnvClient {
	/// Returns this worker client's immutable invocation authority.
	pub const fn scope(&self) -> &DataScope {
		&self.scope
	}

	/// Returns the cached server handshake, if negotiation completed.
	pub fn info(&self) -> Option<ServerHello> {
		self.client.info()
	}

	/// Performs one arbitrary scoped DATA request.
	pub async fn request(&self, request: DataRequest) -> Result<DataResponse, ClientError> {
		ensure_worker_data(&request)?;
		match self
			.client
			.one_shot(client_frame::Body::Data(request), Some(&self.scope))
			.await?
		{
			server_frame::Body::Data(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "DataResponse" }),
		}
	}

	/// Opens an arbitrary scoped DATA stream.
	pub async fn stream(&self, request: DataRequest) -> Result<DataStream, ClientError> {
		ensure_worker_data(&request)?;
		let stream = self
			.client
			.open(client_frame::Body::Data(request), Some(&self.scope))
			.await?;
		Ok(DataStream { stream })
	}

	/// Opens a connection-owned document lease and its correlated event stream.
	pub async fn open_document(
		&self,
		path: &EnvPath,
		language_id: Option<&str>,
	) -> Result<DocumentLease, ClientError> {
		self
			.client
			.open_document_scoped(path, language_id, Some(&self.scope))
			.await
	}

	/// Reads a revision or selection from an owned document lease.
	pub async fn read_document(
		&self,
		lease: &DocumentLease,
		revision: Option<Revision>,
		selection: Option<ReadSelection>,
	) -> Result<DocumentRead, ClientError> {
		self
			.client
			.read_document_scoped(lease, revision, selection, Some(&self.scope))
			.await
	}

	/// Commits an idempotent document transaction.
	///
	/// The epoch-qualified transaction id is retained before transmission so a
	/// caller can reuse it after an ambiguous disconnect.
	pub async fn commit_transaction(
		&self,
		request: CommitTransactionRequest,
	) -> Result<TransactionOutcome, ClientError> {
		self
			.client
			.commit_transaction_scoped(request, Some(&self.scope), &self.last_transaction)
			.await
	}

	/// Commits one text mutation against this worker's lease.
	///
	/// The mutation is pinned to the lease head and advances that head only
	/// after a validated committed response.
	pub async fn commit_document(
		&self,
		lease: &mut DocumentLease,
		transaction_id: Bytes,
		mutation: TextMutation,
	) -> Result<TransactionOutcome, ClientError> {
		self
			.client
			.commit_document_scoped(
				lease,
				transaction_id,
				mutation,
				Some(&self.scope),
				&self.last_transaction,
			)
			.await
	}

	/// Returns the epoch-qualified id of the most recently attempted
	/// transaction.
	pub fn last_transaction(&self) -> Option<TransactionId> {
		self.last_transaction.lock().clone()
	}

	/// Subscribes to LSP registry events after querying this lease's bindings.
	pub async fn lsp_events(&self, lease: &DocumentLease) -> Result<LspEvents, ClientError> {
		let request = document_request(document_op::Op::GetLspBindings(GetLspBindingsRequest {
			document: Some(lease_target(lease)),
		}));
		let stream = self
			.client
			.open(client_frame::Body::Data(request), Some(&self.scope))
			.await?;
		Ok(LspEvents { stream })
	}

	/// Executes an attributed, approval-ticketed privileged write or unlink.
	pub async fn privileged_mutation(
		&self,
		request: env_wire::PrivilegedMutationIntent,
	) -> Result<env_wire::PrivilegedMutationResult, ClientError> {
		let response = self
			.request(DataRequest {
				body: Some(data_request::Body::PrivilegedMutation(request)),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::PrivilegedMutation(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "PrivilegedMutationResult" }),
		}
	}

	/// Materializes one internal resource as a leased Environment path.
	pub async fn materialize(
		&self,
		request: env_wire::MaterializeRequest,
	) -> Result<env_wire::MaterializationLease, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::Materialize(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::Materialized(lease)) => Ok(lease),
			_ => Err(ClientError::UnexpectedResponse { expected: "MaterializationLease" }),
		}
	}

	/// Releases a materialized Environment path lease.
	pub async fn release_materialization(
		&self,
		request: env_wire::ReleaseMaterialization,
	) -> Result<env_wire::MaterializationReleased, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::ReleaseMaterialization(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::MaterializationReleased(released)) => Ok(released),
			_ => Err(ClientError::UnexpectedResponse { expected: "MaterializationReleased" }),
		}
	}

	/// Applies typed control to one exec generation.
	pub async fn exec_control(
		&self,
		request: env_wire::ExecControlRequest,
	) -> Result<env_wire::ExecControlResult, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::Control(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::Controlled(controlled)) => Ok(controlled),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecControlResult" }),
		}
	}

	/// Negotiates backend capabilities for an exec session.
	pub async fn exec_capabilities(
		&self,
		request: env_wire::ExecCapabilitiesRequest,
	) -> Result<env_wire::ExecBackendCapabilities, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::Capabilities(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::Capabilities(capabilities)) => Ok(capabilities),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecBackendCapabilities" }),
		}
	}

	/// Reads revision-fenced final working-directory metadata.
	pub async fn exec_final_cwd(
		&self,
		request: env_wire::ExecFinalCwdRequest,
	) -> Result<env_wire::ExecFinalCwd, ClientError> {
		let result = self
			.exec_session_request(exec_session_op::Op::FinalCwd(request))
			.await?;
		match result.result {
			Some(exec_session_result::Result::FinalCwd(final_cwd)) => Ok(final_cwd),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecFinalCwd" }),
		}
	}

	/// Launches a revision-fenced DAP session and streams its typed events.
	pub async fn dap_launch(
		&self,
		request: document::DapLaunchRequest,
	) -> Result<DapStream, ClientError> {
		self
			.dap_stream(data_request::Body::DapLaunch(request))
			.await
	}

	/// Attaches a revision-fenced DAP session and streams its typed events.
	pub async fn dap_attach(
		&self,
		request: document::DapAttachRequest,
	) -> Result<DapStream, ClientError> {
		self
			.dap_stream(data_request::Body::DapAttach(request))
			.await
	}

	/// Applies one capability-tagged, revision-fenced DAP action.
	pub async fn dap_action(
		&self,
		request: document::DapActionRequest,
	) -> Result<DapStream, ClientError> {
		self
			.dap_stream(data_request::Body::DapAction(request))
			.await
	}

	/// Reads one bounded internal resource.
	pub async fn resource_read(
		&self,
		request: env_wire::ResourceReadRequest,
	) -> Result<env_wire::ResourceResult, ClientError> {
		self.resource_request(resource_op::Op::Read(request)).await
	}

	/// Lists one bounded internal resource.
	pub async fn resource_list(
		&self,
		request: env_wire::ResourceListRequest,
	) -> Result<env_wire::ResourceResult, ClientError> {
		self.resource_request(resource_op::Op::List(request)).await
	}

	/// Resolves one internal resource to canonical path metadata without bytes.
	pub async fn resource_path(
		&self,
		request: env_wire::ResourcePathRequest,
	) -> Result<env_wire::ResourceResult, ClientError> {
		self.resource_request(resource_op::Op::Path(request)).await
	}

	/// Opens a cancellable, bounded internal-resource completion stream.
	pub async fn resource_complete(
		&self,
		request: env_wire::ResourceCompleteRequest,
	) -> Result<ResourceCompletionStream, ClientError> {
		let stream = self
			.client
			.open(
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Resource(env_wire::ResourceOp {
						op: Some(resource_op::Op::Complete(request)),
					})),
					..DataRequest::default()
				}),
				Some(&self.scope),
			)
			.await?;
		Ok(ResourceCompletionStream { stream })
	}

	async fn exec_session_request(
		&self,
		op: exec_session_op::Op,
	) -> Result<env_wire::ExecSessionResult, ClientError> {
		let response = self
			.request(DataRequest {
				body: Some(data_request::Body::ExecSession(env_wire::ExecSessionOp { op: Some(op) })),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::ExecSession(result)) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "ExecSessionResult" }),
		}
	}

	async fn resource_request(
		&self,
		op: resource_op::Op,
	) -> Result<env_wire::ResourceResult, ClientError> {
		let response = self
			.request(DataRequest {
				body: Some(data_request::Body::Resource(env_wire::ResourceOp { op: Some(op) })),
				..DataRequest::default()
			})
			.await?;
		match response.body {
			Some(data_response::Body::Resource(env_wire::ResourceOpResult {
				result: Some(result),
			})) => Ok(result),
			_ => Err(ClientError::UnexpectedResponse { expected: "ResourceResult" }),
		}
	}

	async fn dap_stream(&self, body: data_request::Body) -> Result<DapStream, ClientError> {
		let stream = self
			.client
			.open(
				client_frame::Body::Data(DataRequest { body: Some(body), ..DataRequest::default() }),
				Some(&self.scope),
			)
			.await?;
		Ok(DapStream { stream })
	}

	/// Starts a streaming workspace walk rooted at a typed environment path.
	pub async fn walk(
		&self,
		root: &EnvPath,
		mut request: WalkRequest,
	) -> Result<WalkStream, ClientError> {
		request.root_uri = self.client.path_uri(root)?;
		let stream = self
			.client
			.open(
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Walk(request)),
					..DataRequest::default()
				}),
				Some(&self.scope),
			)
			.await?;
		Ok(WalkStream { stream })
	}

	/// Starts a streaming workspace search rooted at a typed environment path.
	pub async fn search(
		&self,
		root: &EnvPath,
		mut request: SearchRequest,
	) -> Result<SearchStream, ClientError> {
		request.walk.get_or_insert_default().root_uri = self.client.path_uri(root)?;
		let stream = self
			.client
			.open(
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Search(request)),
					..DataRequest::default()
				}),
				Some(&self.scope),
			)
			.await?;
		Ok(SearchStream { stream })
	}

	/// Opens a scoped exec session rooted at `cwd`.
	pub async fn open_session(
		&self,
		cwd: &EnvPath,
		mut request: OpenSessionRequest,
	) -> Result<OpenSessionResponse, ClientError> {
		request.cwd_uri = self.client.path_uri(cwd)?;
		self
			.client
			.open_session_scoped(request, Some(&self.scope))
			.await
	}

	/// Closes a scoped exec session.
	pub async fn close_session(
		&self,
		request: CloseSessionRequest,
	) -> Result<CloseSessionResponse, ClientError> {
		match self
			.client
			.one_shot(client_frame::Body::CloseSession(request), Some(&self.scope))
			.await?
		{
			server_frame::Body::SessionClosed(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "CloseSessionResponse" }),
		}
	}

	/// Starts one guarded command inside a scoped exec session.
	pub async fn exec(&self, request: ExecRequest) -> Result<ExecRun, ClientError> {
		self.client.exec_scoped(request, Some(&self.scope)).await
	}

	/// Checks whether a scoped content-addressed blob is present.
	pub async fn blob_stat(&self, request: StatRequest) -> Result<StatResponse, ClientError> {
		match self
			.client
			.one_shot(client_frame::Body::BlobStat(request), Some(&self.scope))
			.await?
		{
			server_frame::Body::BlobStat(response) => Ok(response),
			_ => Err(ClientError::UnexpectedResponse { expected: "StatResponse" }),
		}
	}

	/// Starts a scoped streaming blob download.
	pub async fn blob_get(&self, request: GetRequest) -> Result<BlobDownload, ClientError> {
		let stream = self
			.client
			.open(client_frame::Body::BlobGet(request.clone()), Some(&self.scope))
			.await?;
		Ok(BlobDownload { request, stream })
	}

	/// Starts a scoped streaming blob upload.
	pub fn blob_put(&self) -> Result<BlobUpload, ClientError> {
		let request_id = self.client.allocate_request_id()?;
		let stream = self.client.register(request_id);
		Ok(BlobUpload {
			client: self.client.clone(),
			scope: Some(self.scope.clone()),
			request_id,
			stream,
		})
	}
}

impl DocumentLease {
	/// Returns the opaque lease id, valid only on this connection.
	pub const fn id(&self) -> &Bytes {
		&self.lease_id
	}

	/// Returns the head pinned when this lease opened.
	pub const fn head(&self) -> &DocumentHead {
		&self.head
	}

	/// Returns the correlated event stream while retaining lease ownership.
	pub const fn events(&mut self) -> &mut DocumentEvents {
		&mut self.events
	}

	/// Explicitly closes this lease.
	pub async fn close(mut self) -> Result<(), ClientError> {
		let request = document_request(document_op::Op::Close(document::CloseDocumentRequest {
			lease_id: self.lease_id.clone(),
		}));
		self.events.stream.finish();
		let response = self
			.client
			.one_shot(client_frame::Body::Data(request), self.scope.as_ref())
			.await?;
		let _ = document_result(response_data_body(response)?, "CloseDocumentResponse", |result| {
			let document_result::Result::Closed(closed) = result else {
				return None;
			};
			Some(closed)
		})?;
		self.released = true;
		Ok(())
	}
}

impl Drop for DocumentLease {
	fn drop(&mut self) {
		if self.released {
			return;
		}
		self.events.stream.finish();
		let _ = self
			.client
			.inner
			.lease_close
			.try_send(LeaseClose { lease_id: self.lease_id.clone(), scope: self.scope.clone() });
		self.released = true;
	}
}

impl DocumentRead {
	/// Returns the head from which this response was read.
	pub const fn head(&self) -> &DocumentHead {
		self
			.response
			.head
			.as_ref()
			.expect("DocumentRead is constructed only from a response containing a head")
	}

	/// Returns the complete content bytes, or `None` when the response contains
	/// requested slices.
	pub const fn content(&self) -> Option<&Bytes> {
		let Some(read_document_response::Body::Content(content)) = self.response.body.as_ref() else {
			return None;
		};
		Some(content)
	}

	/// Returns disjoint content slices when ranges were requested.
	pub const fn slices(&self) -> Option<&document::ContentSlices> {
		let Some(read_document_response::Body::Slices(slices)) = self.response.body.as_ref() else {
			return None;
		};
		Some(slices)
	}

	/// Consumes this wrapper and returns the canonical wire response.
	pub fn into_response(self) -> ReadDocumentResponse {
		self.response
	}
}

impl InProcessEnvTransport {
	pub(crate) const fn from_parts(
		requests: Receiver<ClientFrame>,
		responses: Sender<ServerFrame>,
	) -> Self {
		Self { requests, responses }
	}

	/// Receives the next client frame asynchronously.
	pub async fn recv(&self) -> Result<ClientFrame, flume::RecvError> {
		self.requests.recv_async().await
	}

	/// Sends one server frame asynchronously.
	pub async fn send(&self, frame: ServerFrame) -> Result<(), Box<flume::SendError<ServerFrame>>> {
		self.responses.send_async(frame).await.map_err(Box::new)
	}

	/// Splits this transport into the server's receive and send endpoints.
	pub fn into_parts(self) -> (Receiver<ClientFrame>, Sender<ServerFrame>) {
		(self.requests, self.responses)
	}
}

impl RequestStream {
	/// Returns the correlation identifier carried by every frame in this stream.
	pub const fn request_id(&self) -> u64 {
		self.request_id
	}

	/// Waits for the next correlated server frame.
	pub async fn next(&mut self) -> Result<Option<ServerFrame>, ClientError> {
		if self.finished {
			return Ok(None);
		}
		if let Ok(frame) = self.receiver.recv_async().await {
			Ok(Some(frame))
		} else {
			self.finish();
			Err(ClientError::TransportClosed)
		}
	}

	/// Explicitly cancels this request and closes its local response route.
	///
	/// Unlike [`RunGuard`], a raw request stream is not cancelled on drop. This
	/// keeps the stream returned by detached work safe to discard; callers that
	/// own an ordinary long-lived request can cancel it explicitly here.
	pub fn cancel(mut self) {
		self.request_cancel();
		self.finish();
	}

	fn request_cancel(&mut self) {
		if self.finished {
			return;
		}
		if let Some(client) = self.client.upgrade() {
			let scope = client.request_scopes.lock().get(&self.request_id).cloned();
			let _ = client.outgoing.try_send(ClientFrame {
				request_id: 0,
				body: Some(client_frame::Body::Cancel(CancelRequest {
					target: Some(cancel_request::Target::TargetRequestId(self.request_id)),
					..CancelRequest::default()
				})),
				scope,
				..ClientFrame::default()
			});
		}
	}

	fn finish(&mut self) {
		self.unregister();
		self.finished = true;
	}

	fn unregister(&self) {
		if let Some(client) = self.client.upgrade() {
			client.pending.lock().remove(&self.request_id);
			client.request_scopes.lock().remove(&self.request_id);
		}
	}
}

impl Drop for RequestStream {
	fn drop(&mut self) {
		self.unregister();
	}
}

mod policy_effects {
	use bytes::Bytes;
	use omp_proto::policy::v1;

	use super::{ArgsCommitted, ClientError, Invocation, client_frame};

	impl Invocation {
		/// Sends the exact committed argument bytes, authorizing effects
		/// env-side.
		#[tracing::instrument(
			name = "invocation_commit",
			level = "debug",
			skip_all,
			fields(invocation_id = %self.id)
		)]
		pub async fn commit_args(
			&self,
			raw: Bytes,
			effect_token: Bytes,
			authorized_at_ms: u64,
			effects: Option<v1::EffectEnvelope>,
		) -> Result<(), ClientError> {
			let mut scope = self.grant.wire(self.id.as_str(), self.principal.as_ref());
			scope.effect_token = effect_token.clone();
			self
				.client
				.send_wire(
					self.stream.request_id,
					client_frame::Body::ArgsCommitted(ArgsCommitted {
						invocation_id: self.id.to_string(),
						raw,
						effect_token,
						authorized_at_ms,
						effects,
						..ArgsCommitted::default()
					}),
					Some(scope),
				)
				.await
		}
	}
}

impl Invocation {
	/// Returns the invocation's logical identifier.
	pub fn invocation_id(&self) -> &str {
		&self.id
	}

	/// Returns the request-scoped cancellation guard.
	pub const fn guard(&self) -> &RunGuard {
		self
			.guard
			.as_ref()
			.expect("invocation guard exists until relinquished")
	}

	/// Relays one raw provider argument fragment without validation.
	pub async fn arg_text(&self, fragment: Str) -> Result<(), ClientError> {
		self
			.client
			.send(
				self.stream.request_id,
				client_frame::Body::ArgText(ArgText {
					invocation_id: self.id.to_string(),
					fragment: fragment.to_string(),
					..ArgText::default()
				}),
				None,
			)
			.await
	}

	/// Answers the environment's admission query for this invocation.
	#[tracing::instrument(
		name = "invocation_admit",
		level = "debug",
		skip_all,
		fields(invocation_id = %self.id)
	)]
	pub async fn admit(&self, mut admission: Admission) -> Result<(), ClientError> {
		admission.invocation_id = self.id.to_string();
		self
			.client
			.send(self.stream.request_id, client_frame::Body::Admission(admission), None)
			.await
	}

	/// Sends cooperative interrupt steering to this invocation only.
	#[tracing::instrument(
		name = "invocation_interrupt",
		level = "debug",
		skip_all,
		fields(invocation_id = %self.id)
	)]
	pub async fn interrupt(&self, reason: Str) -> Result<(), ClientError> {
		self
			.client
			.send(
				self.stream.request_id,
				client_frame::Body::Interrupt(Interrupt {
					invocation_id: self.id.to_string(),
					reason: reason.to_string(),
					..Interrupt::default()
				}),
				None,
			)
			.await
	}

	/// Waits for the next typed invocation event.
	pub async fn next_event(&mut self) -> Result<Option<InvocationEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		let body = match response_body(frame) {
			Ok(body) => body,
			Err(error) => {
				tracing::warn!(
					invocation_id = %self.id,
					error = %error,
					"invocation protocol error"
				);
				self.complete();
				return Err(error);
			},
		};
		match body {
			server_frame::Body::InvocationAccepted(event) => {
				Ok(Some(InvocationEvent::Accepted(event)))
			},
			server_frame::Body::AdmitInvocation(event) => Ok(Some(InvocationEvent::Admission(event))),
			server_frame::Body::Update(event) => Ok(Some(InvocationEvent::Update(event))),
			server_frame::Body::Verdict(event) => {
				self.complete();
				Ok(Some(InvocationEvent::Verdict(event)))
			},
			server_frame::Body::EventStreamError(event) => {
				let error = stream_lost(event);
				tracing::warn!(
					invocation_id = %self.id,
					error = %error,
					"invocation event stream lost continuity"
				);
				self.complete();
				Err(error)
			},
			_ => {
				let error = ClientError::UnexpectedResponse { expected: "invocation event" };
				tracing::warn!(
					invocation_id = %self.id,
					error = %error,
					"unexpected invocation protocol response"
				);
				self.complete();
				Err(error)
			},
		}
	}

	/// Explicitly leaves detached work owned by the environment service.
	///
	/// The returned stream can continue observing its terminal event, but its
	/// drop no longer requests cancellation.
	pub fn relinquish(mut self) -> RequestStream {
		if let Some(guard) = self.guard.take() {
			guard.relinquish();
		}
		self.stream
	}

	fn complete(&mut self) {
		if let Some(guard) = self.guard.take() {
			guard.relinquish();
		}
		self.stream.finish();
	}
}

impl ExecRun {
	/// Returns the request-scoped command cancellation guard.
	pub const fn guard(&self) -> &RunGuard {
		self
			.guard
			.as_ref()
			.expect("exec guard exists until relinquished")
	}

	/// Writes stdin bytes or EOF to this command.
	pub async fn stdin(&self, frame: StdinFrame) -> Result<(), ClientError> {
		self
			.client
			.send(self.stream.request_id, client_frame::Body::Stdin(frame), self.scope.as_ref())
			.await
	}

	/// Sends a signal to this command.
	pub async fn signal(&self, request: SignalRequest) -> Result<(), ClientError> {
		self
			.client
			.send(self.stream.request_id, client_frame::Body::Signal(request), self.scope.as_ref())
			.await
	}

	/// Resizes this command's PTY.
	pub async fn resize(&self, request: v1::ResizeRequest) -> Result<(), ClientError> {
		self
			.client
			.send(self.stream.request_id, client_frame::Body::Resize(request), self.scope.as_ref())
			.await
	}

	/// Waits for the next typed command event.
	pub async fn next_event(&mut self) -> Result<Option<ExecEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		let body = match response_body(frame) {
			Ok(body) => body,
			Err(error) => {
				self.complete();
				return Err(error);
			},
		};
		match body {
			server_frame::Body::ExecStarted(event) => Ok(Some(ExecEvent::Started(event))),
			server_frame::Body::Output(event) => Ok(Some(ExecEvent::Output(event))),
			server_frame::Body::Exit(event) => {
				self.complete();
				Ok(Some(ExecEvent::Exit(event)))
			},
			server_frame::Body::EventStreamError(event) => {
				let error = stream_lost(event);
				self.complete();
				Err(error)
			},
			_ => {
				self.complete();
				Err(ClientError::UnexpectedResponse { expected: "exec event" })
			},
		}
	}

	/// Explicitly leaves a detached command owned by the environment service.
	pub fn relinquish(mut self) -> RequestStream {
		if let Some(guard) = self.guard.take() {
			guard.relinquish();
		}
		self.stream
	}

	fn complete(&mut self) {
		if let Some(guard) = self.guard.take() {
			guard.relinquish();
		}
		self.stream.finish();
	}
}

impl ProcessAttachment {
	/// Waits for the next ordered attachment event.
	pub async fn next_event(&mut self) -> Result<Option<ProcessAttachmentEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		let body = match response_body(frame) {
			Ok(body) => body,
			Err(error) => {
				self.stream.finish();
				return Err(error);
			},
		};
		match body {
			server_frame::Body::OutputAttached(event) => {
				Ok(Some(ProcessAttachmentEvent::Attached(event)))
			},
			server_frame::Body::ProcessOutput(event) => {
				Ok(Some(ProcessAttachmentEvent::Output(event)))
			},
			server_frame::Body::ProcessState(event) => Ok(Some(ProcessAttachmentEvent::State(event))),
			server_frame::Body::EventStreamError(event) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			_ => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "process attachment event" })
			},
		}
	}

	/// Stops the server-side output attachment.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl DocumentEvents {
	/// Waits for the next contiguous document event.
	pub async fn next_event(&mut self) -> Result<Option<DocumentEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(event)) => {
				if let Some(data_event::Body::Document(event)) = event.body {
					Ok(Some(event))
				} else {
					self.stream.finish();
					Err(ClientError::UnexpectedResponse { expected: "DocumentEvent" })
				}
			},
			Ok(server_frame::Body::EventStreamError(event)) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			Ok(_) => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "DocumentEvent" })
			},
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}
}

impl LspEvents {
	/// Waits for the initial bindings or next contiguous LSP event.
	pub async fn next_event(&mut self) -> Result<Option<LspStreamEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::Data(response)) => {
				match document_result(response, "GetLspBindingsResponse", |result| {
					let document_result::Result::LspBindings(bindings) = result else {
						return None;
					};
					Some(bindings)
				}) {
					Ok(bindings) => Ok(Some(LspStreamEvent::Bindings(bindings))),
					Err(error) => {
						self.stream.finish();
						Err(error)
					},
				}
			},
			Ok(server_frame::Body::DataEvent(event)) => match event.body {
				Some(data_event::Body::Lsp(event)) => Ok(Some(LspStreamEvent::Event(event))),
				Some(data_event::Body::LspBinding(event)) => Ok(Some(LspStreamEvent::Binding(event))),
				_ => {
					self.stream.finish();
					Err(ClientError::UnexpectedResponse { expected: "LSP registry event" })
				},
			},
			Ok(server_frame::Body::EventStreamError(event)) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			Ok(_) => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "LSP registry event" })
			},
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}
}

impl WalkStream {
	/// Waits for the next walk entry or terminal accounting event.
	pub async fn next_event(&mut self) -> Result<Option<WalkEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(event)) => match event.body {
				Some(data_event::Body::WalkEntry(event)) => Ok(Some(WalkEvent::Entry(event))),
				Some(data_event::Body::WalkComplete(event)) => {
					self.stream.finish();
					Ok(Some(WalkEvent::Complete(event)))
				},
				_ => {
					self.stream.finish();
					Err(ClientError::UnexpectedResponse { expected: "walk event" })
				},
			},
			Ok(server_frame::Body::EventStreamError(event)) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			Ok(_) => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "walk event" })
			},
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the server-side walk.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl SearchStream {
	/// Waits for the next search match or terminal accounting event.
	pub async fn next_event(&mut self) -> Result<Option<SearchEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(event)) => match event.body {
				Some(data_event::Body::SearchMatch(event)) => Ok(Some(SearchEvent::Match(event))),
				Some(data_event::Body::SearchComplete(event)) => {
					self.stream.finish();
					Ok(Some(SearchEvent::Complete(event)))
				},
				_ => {
					self.stream.finish();
					Err(ClientError::UnexpectedResponse { expected: "search event" })
				},
			},
			Ok(server_frame::Body::EventStreamError(event)) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			Ok(_) => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "search event" })
			},
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the server-side search.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl DataStream {
	/// Waits for the next event or terminal response.
	pub async fn next(&mut self) -> Result<Option<DataStreamItem>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(event)) => Ok(Some(DataStreamItem::Event(event))),
			Ok(server_frame::Body::Data(response)) => {
				self.stream.finish();
				Ok(Some(DataStreamItem::Response(response)))
			},
			Ok(server_frame::Body::EventStreamError(event)) => {
				let error = stream_lost(event);
				self.stream.finish();
				Err(error)
			},
			Ok(_) => {
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "DATA event or response" })
			},
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the server-side DATA stream.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl DapStream {
	/// Waits for the next typed DAP session, action, output, or event frame.
	pub async fn next_event(&mut self) -> Result<Option<DapStreamEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::Data(DataResponse {
				body: Some(data_response::Body::DapSession(session)),
				..
			})) => {
				self.stream.finish();
				Ok(Some(DapStreamEvent::Session(session)))
			},
			Ok(server_frame::Body::Data(DataResponse {
				body: Some(data_response::Body::DapAction(action)),
				..
			})) => {
				self.stream.finish();
				Ok(Some(DapStreamEvent::Action(action)))
			},
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::DapOutput(output)),
				..
			})) => Ok(Some(DapStreamEvent::Output(output))),
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::DapEvent(event)),
				..
			})) => Ok(Some(DapStreamEvent::Event(event))),
			Ok(_) => Err(ClientError::UnexpectedResponse { expected: "typed DAP frame" }),
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the server-side DAP request or subscription.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl ResourceCompletionStream {
	/// Waits for the next completion or terminal accounting frame.
	pub async fn next_event(&mut self) -> Result<Option<ResourceCompletionEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::ResourceCompletion(completion)),
				..
			})) => Ok(Some(ResourceCompletionEvent::Completion(completion))),
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::ResourceCompletionComplete(complete)),
				..
			})) => {
				self.stream.finish();
				Ok(Some(ResourceCompletionEvent::Complete(complete)))
			},
			Ok(_) => Err(ClientError::UnexpectedResponse { expected: "resource completion frame" }),
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the server-side completion request.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl McpSubscription {
	/// Waits for the next MCP notification or lifecycle transition.
	pub async fn next_event(&mut self) -> Result<Option<McpSubscriptionEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		match response_body(frame) {
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::McpNotification(notification)),
				..
			})) => Ok(Some(McpSubscriptionEvent::Notification(notification))),
			Ok(server_frame::Body::DataEvent(DataEvent {
				body: Some(data_event::Body::McpStatus(status)),
				..
			})) => Ok(Some(McpSubscriptionEvent::Status(status))),
			Ok(_) => Err(ClientError::UnexpectedResponse { expected: "MCP subscription frame" }),
			Err(error) => {
				self.stream.finish();
				Err(error)
			},
		}
	}

	/// Cancels the MCP subscription.
	pub fn cancel(self) {
		self.stream.cancel();
	}
}

impl BlobDownload {
	/// Waits for the next ordered chunk or terminal completion marker.
	pub async fn next_event(&mut self) -> Result<Option<BlobDownloadEvent>, ClientError> {
		let Some(frame) = self.stream.next().await? else {
			return Ok(None);
		};
		let body = match response_body(frame) {
			Ok(body) => body,
			Err(error) => {
				self.stream.request_cancel();
				self.stream.finish();
				return Err(error);
			},
		};
		match body {
			server_frame::Body::BlobChunk(chunk) => Ok(Some(BlobDownloadEvent::Chunk(chunk))),
			server_frame::Body::BlobGetComplete(complete) => {
				self.stream.finish();
				Ok(Some(BlobDownloadEvent::Complete(complete)))
			},
			server_frame::Body::EventStreamError(event) => {
				let error = stream_lost(event);
				self.stream.request_cancel();
				self.stream.finish();
				Err(error)
			},
			_ => {
				self.stream.request_cancel();
				self.stream.finish();
				Err(ClientError::UnexpectedResponse { expected: "blob chunk or completion" })
			},
		}
	}

	/// Streams a complete blob into `destination` under a caller-owned total
	/// bound while verifying first-chunk metadata, the completion marker,
	/// transferred length, and the SHA-256 digest.
	///
	/// This single-request convenience delegates to
	/// [`ResumableBlobTransfer::receive`], keeping verdict consumers and generic
	/// blob consumers on one verifier. Use [`ResumableBlobTransfer`] directly
	/// when a replacement connection must continue after interruption.
	pub async fn write_verified(
		self,
		expected_hash: Hash32,
		expected_size: u64,
		max_bytes: u64,
		destination: &mut (impl io::Write + Send),
	) -> Result<VerifiedBlobTransfer, ClientError> {
		let mut transfer = ResumableBlobTransfer::new(expected_hash, expected_size, max_bytes)?;
		transfer
			.receive(self, destination)
			.await?
			.ok_or(ClientError::IncompleteBlob)
	}

	/// Stops this download before its completion marker.
	pub fn cancel(mut self) {
		self.stream.request_cancel();
		self.stream.finish();
	}
}

impl Drop for BlobDownload {
	fn drop(&mut self) {
		if !self.stream.finished {
			self.stream.request_cancel();
			self.stream.finish();
		}
	}
}

impl ResumableBlobTransfer {
	/// Consumes one requested range and advances durable transfer progress.
	///
	/// Each chunk is written before the next frame is requested, preserving
	/// destination backpressure. On transport loss or cancellation, fully
	/// written chunks remain represented by [`Self::next_offset`]; the caller
	/// may open a replacement client with [`Self::request`] and call `receive`
	/// again.
	/// A destination write error is terminal because `std::io::Write` cannot
	/// report how much of a failed `write_all` reached the destination.
	///
	/// # Errors
	///
	/// Returns a typed [`ClientError`] for mismatched range position,
	/// provenance, size, digest, destination failure, or transport loss.
	pub async fn receive(
		&mut self,
		mut download: BlobDownload,
		destination: &mut (impl io::Write + Send),
	) -> Result<Option<VerifiedBlobTransfer>, ClientError> {
		let requested_hash = parse_blob_hash(&download.request.hash)?;
		if requested_hash != self.hash {
			return Err(ClientError::BlobDigestMismatch);
		}
		if download.request.offset != self.next_offset {
			return Err(ClientError::BlobResumeOffsetMismatch {
				expected: self.next_offset,
				actual:   download.request.offset,
			});
		}

		let available = self.size - self.next_offset;
		let expected_segment = if download.request.length == 0 {
			available
		} else {
			download.request.length.min(available)
		};
		let segment_start = self.next_offset;
		let mut first = true;

		loop {
			match download.next_event().await? {
				Some(BlobDownloadEvent::Chunk(chunk)) => {
					if first {
						let hash = parse_blob_hash(&chunk.hash)?;
						if hash != self.hash {
							return Err(ClientError::BlobDigestMismatch);
						}
						let size = chunk.size.ok_or(ClientError::InvalidBlobMetadata)?;
						if size != self.size {
							return Err(ClientError::BlobSizeMismatch {
								expected: self.size,
								actual:   size,
							});
						}
						first = false;
					} else if !chunk.hash.is_empty() || chunk.size.is_some() {
						return Err(ClientError::InvalidBlobMetadata);
					}

					let chunk_len = u64::try_from(chunk.data.len()).unwrap_or(u64::MAX);
					let segment_received = self.next_offset - segment_start;
					if chunk_len == 0 && segment_received < expected_segment {
						return Err(ClientError::InvalidBlobMetadata);
					}
					let next_segment = segment_received
						.checked_add(chunk_len)
						.ok_or(ClientError::BlobTooLarge { size: u64::MAX, limit: self.max_bytes })?;
					let next_offset = self
						.next_offset
						.checked_add(chunk_len)
						.ok_or(ClientError::BlobTooLarge { size: u64::MAX, limit: self.max_bytes })?;
					if next_segment > expected_segment
						|| next_offset > self.size
						|| next_offset > self.max_bytes
					{
						return Err(ClientError::BlobSizeMismatch {
							expected: expected_segment,
							actual:   next_segment,
						});
					}

					io::Write::write_all(destination, &chunk.data)
						.map_err(|source| ClientError::BlobWrite { source })?;
					self.hasher.update(&chunk.data);
					self.next_offset = next_offset;
				},
				Some(BlobDownloadEvent::Complete(complete)) => {
					if first {
						return Err(ClientError::InvalidBlobMetadata);
					}
					let hash = parse_blob_hash(&complete.hash)?;
					if hash != self.hash {
						return Err(ClientError::BlobDigestMismatch);
					}
					let segment_received = self.next_offset - segment_start;
					if complete.bytes_sent != segment_received || segment_received != expected_segment {
						return Err(ClientError::BlobSizeMismatch {
							expected: expected_segment,
							actual:   segment_received,
						});
					}
					if self.is_complete() {
						if self.hasher.finalize() != self.hash {
							return Err(ClientError::BlobDigestMismatch);
						}
						return Ok(Some(VerifiedBlobTransfer { hash: self.hash, size: self.size }));
					}
					return Ok(None);
				},
				None => return Err(ClientError::IncompleteBlob),
			}
		}
	}
}

fn parse_blob_hash(bytes: &[u8]) -> Result<Hash32, ClientError> {
	let hash: [u8; 32] = bytes
		.try_into()
		.map_err(|_| ClientError::InvalidBlobDigest { actual: bytes.len() })?;
	Ok(Hash32::new(hash))
}

impl BlobUpload {
	/// Returns the correlation identifier shared by every upload frame.
	pub const fn request_id(&self) -> u64 {
		self.request_id
	}

	/// Sends the next ordered blob chunk.
	pub async fn send_chunk(&self, chunk: Chunk) -> Result<(), ClientError> {
		self
			.client
			.send(self.request_id, client_frame::Body::BlobPutChunk(chunk), self.scope.as_ref())
			.await
	}

	/// Cancels this upload without making its staged bytes visible.
	pub fn abort(self) {
		self.stream.cancel();
	}

	/// Commits the upload and waits for its content identity.
	pub async fn commit(mut self) -> Result<PutResponse, ClientError> {
		self
			.client
			.send(
				self.request_id,
				client_frame::Body::BlobPutCommit(CommitBlobPut::default()),
				self.scope.as_ref(),
			)
			.await?;
		let frame = self
			.stream
			.next()
			.await?
			.ok_or(ClientError::TransportClosed)?;
		self.stream.finish();
		match response_body(frame)? {
			server_frame::Body::BlobPut(response) => Ok(response),
			server_frame::Body::EventStreamError(event) => Err(stream_lost(event)),
			_ => Err(ClientError::UnexpectedResponse { expected: "PutResponse" }),
		}
	}
}

fn response_body(frame: ServerFrame) -> Result<server_frame::Body, ClientError> {
	match frame.body {
		Some(server_frame::Body::Error(error)) => Err(protocol_error(error)),
		Some(body) => Ok(body),
		None => Err(ClientError::UnexpectedResponse { expected: "nonempty server frame" }),
	}
}

const fn protocol_error(error: ProtocolError) -> ClientError {
	if error.code == ProtocolErrorCode::Uncommitted as i32 {
		ClientError::EffectsNotAuthorized(error)
	} else {
		ClientError::Protocol(error)
	}
}

fn response_data(frame: ServerFrame) -> Result<DataResponse, ClientError> {
	response_data_body(response_body(frame)?)
}

fn response_data_body(body: server_frame::Body) -> Result<DataResponse, ClientError> {
	match body {
		server_frame::Body::Data(response) => Ok(response),
		server_frame::Body::EventStreamError(event) => Err(stream_lost(event)),
		_ => Err(ClientError::UnexpectedResponse { expected: "DataResponse" }),
	}
}

fn document_request(operation: document_op::Op) -> DataRequest {
	DataRequest {
		body: Some(data_request::Body::Document(v1::DocumentOp {
			op: Some(operation),
			..v1::DocumentOp::default()
		})),
		..DataRequest::default()
	}
}

fn document_result<T>(
	response: DataResponse,
	expected: &'static str,
	select: impl FnOnce(document_result::Result) -> Option<T>,
) -> Result<T, ClientError> {
	let Some(data_response::Body::Document(document)) = response.body else {
		return Err(ClientError::UnexpectedResponse { expected });
	};
	document
		.result
		.and_then(select)
		.ok_or(ClientError::UnexpectedResponse { expected })
}

fn lease_target(lease: &DocumentLease) -> document::DocumentTarget {
	document::DocumentTarget {
		target: Some(document_target::Target::LeaseId(lease.lease_id.clone())),
	}
}

fn is_revision_pinned(head: &DocumentHead) -> bool {
	head
		.document
		.as_ref()
		.is_some_and(|document| !document.id.is_empty() && !document.uri.is_empty())
		&& head
			.revision
			.as_ref()
			.is_some_and(|revision| revision.content_hash.len() == 32)
}

fn stream_lost(event: EventStreamError) -> ClientError {
	let stream = EventStreamKind::try_from(event.stream).unwrap_or(EventStreamKind::Unspecified);
	let reopen_guidance = match stream {
		EventStreamKind::Document => "discard the closed lease and reopen the document",
		EventStreamKind::LspRegistry => {
			"reconnect, reopen documents, and re-query LSP bindings before revision-sensitive work"
		},
		EventStreamKind::Walk => "restart the walk from a new request",
		EventStreamKind::Search => "restart the search from a new request",
		EventStreamKind::Invocation => "restart the invocation from its durable boundary",
		EventStreamKind::Exec => "open a new command and do not infer missing output",
		EventStreamKind::ProcessOutput | EventStreamKind::ProcessState => {
			"reattach and resume after the last observed sequence"
		},
		EventStreamKind::Dap => "reopen the DAP session before issuing another action",
		EventStreamKind::ResourceCompletion => "restart completion from a fresh catalog revision",
		EventStreamKind::McpNotification => "resubscribe from the last observed sequence",
		EventStreamKind::Unspecified => "reopen the resource before continuing",
	};
	ClientError::StreamLost(StreamLost {
		stream,
		skipped: event.skipped_events,
		reason: Str::from(event.message),
		reopen_guidance,
	})
}

const fn ensure_worker_data(request: &DataRequest) -> Result<(), ClientError> {
	match request.body.as_ref() {
		Some(
			data_request::Body::Document(_)
			| data_request::Body::Walk(_)
			| data_request::Body::Search(_)
			| data_request::Body::RepositorySnapshot(_)
			| data_request::Body::PrivilegedMutation(_)
			| data_request::Body::ExecSession(_)
			| data_request::Body::DapLaunch(_)
			| data_request::Body::DapAttach(_)
			| data_request::Body::DapAction(_)
			| data_request::Body::Resource(_),
		) => Ok(()),
		_ => Err(ClientError::ScopedOperationDenied),
	}
}

fn route_responses(
	client: Weak<ClientInner>,
	incoming: Receiver<ServerFrame>,
	events: Sender<ServerFrame>,
	edit_repair_requests: Sender<EditRepairRequest>,
	acp_requests: Sender<AcpRequest>,
) {
	while let Ok(frame) = incoming.recv() {
		let Some(client) = client.upgrade() else {
			break;
		};
		if frame.request_id == 0 {
			let is_hello_response = matches!(
				frame.body.as_ref(),
				Some(
					omp_proto::env::v1::server_frame::Body::Hello(_)
						| omp_proto::env::v1::server_frame::Body::Error(_)
				)
			);
			if is_hello_response && let Some(waiter) = client.hello_waiter.lock().take() {
				let _ = waiter.send(frame);
			} else {
				let _ = events.send(frame);
			}
			continue;
		}
		if let Some(server_frame::Body::EditRepairQuery(query)) = frame.body.as_ref() {
			let scope = {
				let scopes = client.request_scopes.lock();
				scopes.get(&frame.request_id).cloned().or_else(|| {
					scopes
						.values()
						.find(|scope| scope.invocation_id == query.invocation_id)
						.cloned()
				})
			};
			if let Some(scope) = scope {
				client
					.edit_repair_scopes
					.lock()
					.insert(frame.request_id, scope);
				let _ = edit_repair_requests
					.send(EditRepairRequest { request_id: frame.request_id, query: query.clone() });
			}
			continue;
		}
		let acp_request = match frame.body.as_ref() {
			Some(server_frame::Body::AcpReadQuery(query)) => Some((
				query.invocation_id.as_str(),
				AcpRequest::Read { request_id: frame.request_id, query: query.clone() },
				true,
			)),
			Some(server_frame::Body::AcpWriteQuery(query)) => Some((
				query.invocation_id.as_str(),
				AcpRequest::Write { request_id: frame.request_id, query: query.clone() },
				true,
			)),
			Some(server_frame::Body::AcpExecQuery(query)) => Some((
				query.invocation_id.as_str(),
				AcpRequest::Exec { request_id: frame.request_id, query: query.clone() },
				true,
			)),
			Some(server_frame::Body::AcpExecCancel(cancel)) => Some((
				cancel.invocation_id.as_str(),
				AcpRequest::ExecCancel { request_id: frame.request_id, cancel: cancel.clone() },
				false,
			)),
			_ => None,
		};
		if let Some((invocation_id, request, retains_scope)) = acp_request {
			let scope = {
				let scopes = client.request_scopes.lock();
				scopes.get(&frame.request_id).cloned().or_else(|| {
					scopes
						.values()
						.find(|scope| scope.invocation_id == invocation_id)
						.cloned()
				})
			};
			if retains_scope && let Some(scope) = scope {
				client
					.acp_request_scopes
					.lock()
					.insert(frame.request_id, scope);
			}
			let _ = acp_requests.send(request);
			continue;
		}
		if let Some(server_frame::Body::AdmitInvocation(query)) = frame.body.as_ref()
			&& let Some(admitter) = client.admitter.lock().clone()
		{
			admitter.dispatch(Arc::clone(&client), frame.request_id, query.clone());
			continue;
		}
		let target = client.pending.lock().get(&frame.request_id).cloned();
		if let Some(target) = target {
			let _ = target.send(frame);
		}
	}
	if let Some(client) = client.upgrade() {
		client.pending.lock().clear();
		client.edit_repair_scopes.lock().clear();
		client.acp_request_scopes.lock().clear();
		client.hello_waiter.lock().take();
	}
}

fn route_cancellations(client: Weak<ClientInner>, cancellations: Receiver<u64>) {
	while let Ok(request_id) = cancellations.recv() {
		let Some(client) = client.upgrade() else {
			break;
		};
		let frame = ClientFrame {
			request_id: 0,
			body: Some(client_frame::Body::Cancel(CancelRequest {
				target: Some(cancel_request::Target::TargetRequestId(request_id)),
				..CancelRequest::default()
			})),
			scope: client.request_scopes.lock().get(&request_id).cloned(),
			..ClientFrame::default()
		};
		if client.outgoing.send(frame).is_err() {
			break;
		}
	}
}
fn scoped_cancel_sender(client: Weak<ClientInner>, scope: InvocationScope) -> Sender<u64> {
	let (sender, cancellations) = flume::unbounded();
	let _ = thread::spawn(move || {
		while let Ok(request_id) = cancellations.recv() {
			let Some(client) = client.upgrade() else {
				break;
			};
			let frame = ClientFrame {
				request_id: 0,
				body: Some(client_frame::Body::Cancel(CancelRequest {
					target: Some(cancel_request::Target::TargetRequestId(request_id)),
					..CancelRequest::default()
				})),
				scope: Some(scope.clone()),
				..ClientFrame::default()
			};
			if client.outgoing.send(frame).is_err() {
				break;
			}
		}
	});
	sender
}

fn route_lease_closes(client: Weak<ClientInner>, closes: Receiver<LeaseClose>) {
	while let Ok(close) = closes.recv() {
		let Some(client) = client.upgrade() else {
			break;
		};
		let Ok(request_id) =
			client
				.next_id
				.try_update(Ordering::Relaxed, Ordering::Relaxed, |request_id| {
					request_id.checked_add(1)
				})
		else {
			continue;
		};
		let request = document_request(document_op::Op::Close(document::CloseDocumentRequest {
			lease_id: close.lease_id,
		}));
		let frame = ClientFrame {
			request_id,
			body: Some(client_frame::Body::Data(request)),
			scope: close.scope.as_ref().map(DataScope::wire),
			..ClientFrame::default()
		};
		if client.outgoing.send(frame).is_err() {
			break;
		}
	}
}
#[cfg(unix)]
const EXTENSION_FRAME_LIMIT: usize = 64 * 1024 * 1024;

#[cfg(unix)]
async fn bridge_extension_frames<S>(
	stream: S,
	requests: Receiver<ClientFrame>,
	responses: Sender<ServerFrame>,
) -> io::Result<()>
where
	S: AsyncRead + AsyncWrite + Unpin,
{
	let (mut reader, mut writer) = {
		use tokio::io;
		io::split(stream)
	};
	let write = async {
		let mut encoded = BytesMut::new();
		while let Ok(frame) = requests.recv_async().await {
			if frame.encoded_len() > EXTENSION_FRAME_LIMIT {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"environment client frame exceeds limit",
				));
			}
			encoded.clear();
			frame
				.encode_length_delimited(&mut encoded)
				.map_err(io::Error::other)?;
			writer.write_all(&encoded).await?;
			writer.flush().await?;
		}
		Ok(())
	};
	let read = async {
		let mut payload = BytesMut::new();
		while let Some(length) = read_extension_frame_length(&mut reader).await? {
			if length > EXTENSION_FRAME_LIMIT {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"environment server frame exceeds limit",
				));
			}
			payload.resize(length, 0);
			reader.read_exact(&mut payload).await?;
			let frame = ServerFrame::decode(&payload[..]).map_err(io::Error::other)?;
			if responses.send_async(frame).await.is_err() {
				return Ok(());
			}
		}
		Ok(())
	};
	tokio::select! {
		result = write => result,
		result = read => result,
	}
}

#[cfg(unix)]
async fn read_extension_frame_length<R: AsyncRead + Unpin>(
	reader: &mut R,
) -> io::Result<Option<usize>> {
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let byte = match reader.read_u8().await {
			Ok(byte) => byte,
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error),
		};
		if shift == 63 && byte > 1 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "frame length overflow"));
		}
		value |= u64::from(byte & 0x7f) << shift;
		if byte & 0x80 == 0 {
			return usize::try_from(value)
				.map(Some)
				.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame length overflow"));
		}
	}
	Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame length"))
}
#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn invocation_blob_get_carries_stable_delivery_provenance() {
		let (client, transport) = EnvClient::in_process(0);
		let client = client
			.with_principal("session-a", "agent-a")
			.expect("valid principal");
		let request = tokio::spawn({
			let client = client.clone();
			async move {
				client
					.blob_get_for_invocation("call-a", GetRequest {
						hash:   Bytes::from_static(&[7; 32]),
						offset: 12,
						length: 34,
					})
					.await
			}
		});
		let frame = transport.recv().await.expect("receive blob request");
		assert!(matches!(
			&frame.body,
			Some(client_frame::Body::BlobGet(GetRequest {
				hash,
				offset: 12,
				length: 34,
			})) if hash.as_ref() == [7; 32]
		));
		assert_eq!(
			frame.scope,
			Some(InvocationScope {
				invocation_id: "call-a".into(),
				session_id: "session-a".into(),
				agent_id: "agent-a".into(),
				..InvocationScope::default()
			})
		);
		request
			.await
			.expect("blob request task")
			.expect("open blob download")
			.cancel();
	}

	#[tokio::test]
	async fn reset_eval_uses_one_correlated_typed_request() {
		let (client, transport) = EnvClient::in_process(0);
		let (requests, responses) = transport.into_parts();
		let request = tokio::spawn({
			let client = client.clone();
			async move { client.reset_eval().await }
		});
		let frame = requests
			.recv_async()
			.await
			.expect("receive eval reset request");
		assert_ne!(frame.request_id, 0);
		assert!(matches!(frame.body, Some(client_frame::Body::EvalReset(EvalResetRequest {}))));
		responses
			.send_async(ServerFrame {
				request_id: frame.request_id,
				body: Some(server_frame::Body::EvalReset(env_wire::EvalResetResponse {})),
				..ServerFrame::default()
			})
			.await
			.expect("send eval reset response");
		request.await.expect("reset task").expect("reset response");
		assert!(requests.try_recv().is_err(), "reset sent more than one request");
	}

	#[tokio::test]
	async fn reset_eval_rejects_a_different_response_type() {
		let (client, transport) = EnvClient::in_process(0);
		let request = tokio::spawn({
			let client = client.clone();
			async move { client.reset_eval().await }
		});
		let frame = transport.recv().await.expect("receive eval reset request");
		transport
			.send(ServerFrame {
				request_id: frame.request_id,
				body: Some(server_frame::Body::RetireStarted(env_wire::RetireStarted::default())),
				..ServerFrame::default()
			})
			.await
			.expect("send mismatched response");
		assert!(matches!(
			request.await.expect("reset task"),
			Err(ClientError::UnexpectedResponse { expected: "EvalResetResponse" })
		));
	}
	#[tokio::test]
	async fn reset_eval_surfaces_typed_protocol_errors() {
		let (client, transport) = EnvClient::in_process(0);
		let request = tokio::spawn({
			let client = client.clone();
			async move { client.reset_eval().await }
		});
		let frame = transport.recv().await.expect("receive eval reset request");
		transport
			.send(ServerFrame {
				request_id: frame.request_id,
				body: Some(server_frame::Body::Error(ProtocolError {
					code: ProtocolErrorCode::Unsupported as i32,
					message: "eval reset unavailable".into(),
					..ProtocolError::default()
				})),
				..ServerFrame::default()
			})
			.await
			.expect("send protocol error");
		assert!(matches!(
			request.await.expect("reset task"),
			Err(ClientError::Protocol(ProtocolError { code, .. }))
				if code == ProtocolErrorCode::Unsupported as i32
		));
	}

	#[tokio::test]
	async fn edit_repair_queries_bypass_invocation_events_and_preserve_scope() {
		let (outgoing, requests) = flume::unbounded();
		let (responses, incoming) = flume::unbounded();
		let client = EnvClient::from_channels(outgoing, incoming);
		let scope = InvocationScope {
			invocation_id: "edit-1".into(),
			effect_token: Bytes::from_static(b"authority"),
			host_generation: 7,
			session_generation: 11,
			..InvocationScope::default()
		};
		client.inner.request_scopes.lock().insert(42, scope.clone());
		let pending = client.register(42);
		let repair_requests = client.edit_repair_requests();

		responses
			.send(ServerFrame {
				request_id: 700,
				body: Some(server_frame::Body::EditRepairQuery(EditRepairQuery {
					invocation_id: "edit-1".into(),
					prompt:        Some(env_wire::EditRepairPrompt {
						language:         "rust".into(),
						before:           "fn good() {}".into(),
						after:            "fn broken( {}".into(),
						previous_attempt: None,
					}),
				})),
				..ServerFrame::default()
			})
			.expect("send repair query");

		let request =
			tokio::time::timeout(std::time::Duration::from_secs(1), repair_requests.recv_async())
				.await
				.expect("repair request timed out")
				.expect("repair request channel closed");
		assert_eq!(request.request_id, 700);
		assert_eq!(request.query.invocation_id, "edit-1");
		assert!(pending.receiver.try_recv().is_err(), "repair query entered invocation events");

		client
			.answer_edit_repair(request.request_id, EditRepairAnswer {
				invocation_id: request.query.invocation_id,
				body:          Some(env_wire::edit_repair_answer::Body::Content(
					"fn fixed() {}".into(),
				)),
			})
			.await
			.expect("answer repair query");
		let answer = requests.recv_async().await.expect("receive repair answer");
		assert_eq!(answer.request_id, 700);
		assert_eq!(client.inner.pending.lock().len(), 1, "answer opened a correlation waiter");
		assert_eq!(answer.scope, Some(scope));
		assert!(matches!(
			&answer.body,
			Some(client_frame::Body::EditRepairAnswer(EditRepairAnswer {
				body: Some(env_wire::edit_repair_answer::Body::Content(content)),
				..
			})) if content == "fn fixed() {}"
		));

		drop(responses);
		tokio::time::timeout(std::time::Duration::from_secs(1), repair_requests.recv_async())
			.await
			.expect("repair request disconnect timed out")
			.expect_err("repair request channel remained open");
	}

	#[tokio::test]
	async fn bind_acp_is_request_zero_and_requires_hello() {
		let (outgoing, requests) = flume::unbounded();
		let (responses, incoming) = flume::unbounded();
		let client = EnvClient::from_channels(outgoing, incoming);
		assert!(matches!(client.bind_acp(true, true), Err(ClientError::UnexpectedResponse { .. })));

		let handshake = tokio::spawn({
			let client = client.clone();
			async move { client.hello(ClientHello::default()).await }
		});
		let hello = requests.recv_async().await.expect("receive client hello");
		assert_eq!(hello.request_id, 0);
		responses
			.send_async(ServerFrame {
				request_id: 0,
				body: Some(server_frame::Body::Hello(ServerHello::default())),
				..ServerFrame::default()
			})
			.await
			.expect("send server hello");
		handshake
			.await
			.expect("hello task")
			.expect("complete hello");

		client.bind_acp(true, false).expect("bind ACP documents");
		let bind = requests.recv_async().await.expect("receive ACP bind");
		assert_eq!(bind.request_id, 0);
		assert!(bind.scope.is_none());
		assert!(matches!(
			bind.body,
			Some(client_frame::Body::AcpBind(AcpBind { documents: true, exec: false }))
		));
		assert!(client.inner.pending.lock().is_empty(), "bind opened a response correlation");
	}

	#[tokio::test]
	async fn acp_requests_bypass_pending_and_answers_preserve_scope() {
		let (outgoing, requests) = flume::unbounded();
		let (responses, incoming) = flume::unbounded();
		let client = EnvClient::from_channels(outgoing, incoming);
		let scope = InvocationScope {
			invocation_id: "acp-1".into(),
			effect_token: Bytes::from_static(b"acp-authority"),
			host_generation: 5,
			session_generation: 8,
			..InvocationScope::default()
		};
		client.inner.request_scopes.lock().insert(42, scope.clone());
		let pending = client.register(42);
		let acp_requests = client.acp_requests();

		let server_requests = [
			ServerFrame {
				request_id: 700,
				body: Some(server_frame::Body::AcpReadQuery(AcpReadQuery {
					query_id:      1,
					invocation_id: "acp-1".into(),
					path:          "one.rs".into(),
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 701,
				body: Some(server_frame::Body::AcpWriteQuery(AcpWriteQuery {
					query_id:      2,
					invocation_id: "acp-1".into(),
					path:          "two.rs".into(),
					content:       "updated".into(),
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 702,
				body: Some(server_frame::Body::AcpExecQuery(AcpExecQuery {
					query_id:      3,
					invocation_id: "acp-1".into(),
					command:       "cargo metadata".into(),
					cwd:           "/workspace".into(),
					env:           std::collections::BTreeMap::new(),
					timeout_ms:    Some(2_000),
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 703,
				body: Some(server_frame::Body::AcpExecCancel(AcpExecCancel {
					query_id:      3,
					invocation_id: "acp-1".into(),
				})),
				..ServerFrame::default()
			},
		];
		for frame in server_requests {
			responses.send_async(frame).await.expect("send ACP request");
		}

		let read = acp_requests.recv_async().await.expect("receive ACP read");
		let write = acp_requests.recv_async().await.expect("receive ACP write");
		let exec = acp_requests.recv_async().await.expect("receive ACP exec");
		let cancel = acp_requests
			.recv_async()
			.await
			.expect("receive ACP cancellation");
		assert!(matches!(
			&read,
			AcpRequest::Read { request_id: 700, query } if query.query_id == 1
		));
		assert!(matches!(
			&write,
			AcpRequest::Write { request_id: 701, query } if query.query_id == 2
		));
		assert!(matches!(
			&exec,
			AcpRequest::Exec { request_id: 702, query } if query.query_id == 3
		));
		assert!(matches!(
			&cancel,
			AcpRequest::ExecCancel { request_id: 703, cancel } if cancel.query_id == 3
		));
		assert!(pending.receiver.try_recv().is_err(), "ACP request entered invocation events");

		client
			.answer_acp_document(700, AcpDocumentAnswer {
				query_id:      1,
				invocation_id: "acp-1".into(),
				body:          Some(env_wire::acp_document_answer::Body::Content("source".into())),
			})
			.await
			.expect("answer ACP read");
		client
			.answer_acp_document(701, AcpDocumentAnswer {
				query_id:      2,
				invocation_id: "acp-1".into(),
				body:          Some(env_wire::acp_document_answer::Body::Error(
					ProtocolError::default(),
				)),
			})
			.await
			.expect("answer ACP write");
		for body in [
			env_wire::acp_exec_event::Body::Started(ExecStarted::default()),
			env_wire::acp_exec_event::Body::Output(OutputFrame::default()),
			env_wire::acp_exec_event::Body::Exit(ExitEvent::default()),
		] {
			client
				.send_acp_exec_event(702, AcpExecEvent {
					query_id:      3,
					invocation_id: "acp-1".into(),
					body:          Some(body),
				})
				.await
				.expect("send ACP exec event");
		}

		for expected_request_id in [700, 701, 702, 702, 702] {
			let answer = requests
				.recv_async()
				.await
				.expect("receive ACP answer or event");
			assert_eq!(answer.request_id, expected_request_id);
			assert_eq!(answer.scope, Some(scope.clone()));
		}
		assert_eq!(client.inner.pending.lock().len(), 1, "ACP answer opened a response waiter");
		assert!(client.inner.acp_request_scopes.lock().is_empty());
		assert!(pending.receiver.try_recv().is_err(), "ACP answer entered invocation events");

		drop(responses);
		tokio::time::timeout(std::time::Duration::from_secs(1), acp_requests.recv_async())
			.await
			.expect("ACP request disconnect timed out")
			.expect_err("ACP request channel remained open");
	}

	#[test]
	fn terminal_request_streams_remove_all_correlation_state() {
		let (client, _transport) = EnvClient::in_process(0);
		for request_id in 1..=1_000 {
			client
				.inner
				.request_scopes
				.lock()
				.insert(request_id, InvocationScope {
					invocation_id: request_id.to_string(),
					..InvocationScope::default()
				});
			let mut stream = client.register(request_id);
			stream.finish();
		}
		assert!(client.inner.pending.lock().is_empty());
		assert!(client.inner.request_scopes.lock().is_empty());

		let request_id = 1_001;
		let stream = client.register(request_id);
		drop(stream);
		assert!(!client.inner.pending.lock().contains_key(&request_id));
	}
}
