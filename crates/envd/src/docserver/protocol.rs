//! Protobuf request conversion and dispatch for one document-server session.

use std::{
	collections::HashSet,
	future::Future,
	io,
	path::PathBuf,
	str,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_core::Str;
use omp_proto::{
	document::v1::{
		self as proto, client_frame, commit_transaction_response, document_mutation,
		document_summary_segment, document_target, lsp_response, read_document_response,
		read_selection, server_frame, summarize_document_response, text_mutation,
	},
	lsp::{PositionEncoding, Range, Severity, normalize},
	prost::Message,
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	ByteEdit, ByteRange, DapAction, DapApprovalTier, DapInbound, DapProtocol,
	DapReverseRequestHandler, DapSession, DapSessionError, DapSessionRegistry,
	DestinationOverwritePolicy, DocumentEvent, DocumentEventKind, DocumentHead, DocumentId,
	DocumentKind, DocumentLocator, DocumentPresence, DocumentSnapshot,
	Environment as DocserverEnvironment, EnvironmentSession, Error, ExistingDirectoryPolicy,
	FileKind, FollowSymlinks, LanguageId, LaunchAdapterSelection, LeaseId, LineRange, PathMetadata,
	PortablePermissions, ReadBody, ReadSelection, Result as CoreResult, Revision, SymlinkTarget,
	SymlinkTargetForm, SymlinkTargetKind, TransactionId,
	diagnostics::parse_push,
	environment::{WorkspaceLeaseId, WorkspaceMutationGuard},
	lsp::{LspError, LspResponseOutcome, LspTransportError, TextDocumentSyncKind},
	lsp_registry::{
		DocumentEventStreamError, LspBindingEventKind, LspBindingId, LspLeaseBinding,
		LspRegistryError, LspRegistryEvent, StaleResponsePolicy,
	},
	lsp_supervisor::LspServerState,
	path_ops::PathMutationResult,
	position::position_to_offset,
	summary::{
		DocumentSummary, SummaryFallback, SummaryOptions, SummaryOutcome, SummaryRenderMode,
		SummarySegment, SummaryUnavailableReason,
	},
	transaction::{
		CreateMutation, DeleteMutation, DocumentMutation, DocumentTarget, ExistingDocumentPolicy,
		FormatPolicy, MoveDestinationPrecondition, MoveMutation, MoveWithContentMutation,
		MutationOperation, OperationResult, StalePolicy, TextMutation, TextProposal,
		TransactionBuildError, TransactionOutcome, TransactionRejectReason,
	},
};

#[derive(Clone)]
struct EnvironmentDapReverseHandler {
	environment: DocserverEnvironment,
	workspace:   PathBuf,
	read:        bool,
	execute:     bool,
	event_limit: u32,
}

#[async_trait]
impl DapReverseRequestHandler for EnvironmentDapReverseHandler {
	async fn handle(
		&self,
		parent: Arc<DapSession>,
		command: &str,
		arguments: serde_json::Value,
	) -> Result<serde_json::Value, Str> {
		match command {
			"runInTerminal" => parent
				.run_in_terminal(&self.workspace, &arguments)
				.await
				.map_err(|_| Str::new_static("runInTerminal was rejected")),
			"startDebugging" => self.start_child(parent, arguments).await,
			_ => Err(Str::new_static("unsupported DAP reverse request")),
		}
	}
}

impl EnvironmentDapReverseHandler {
	async fn start_child(
		&self,
		parent: Arc<DapSession>,
		arguments: serde_json::Value,
	) -> Result<serde_json::Value, Str> {
		let configuration = arguments
			.get("configuration")
			.and_then(serde_json::Value::as_object)
			.cloned()
			.ok_or_else(|| Str::new_static("startDebugging requires configuration"))?;
		let attach = arguments.get("request").and_then(serde_json::Value::as_str) == Some("attach")
			|| configuration
				.get("request")
				.and_then(serde_json::Value::as_str)
				== Some("attach");
		let adapter_name = configuration
			.get("type")
			.and_then(serde_json::Value::as_str)
			.unwrap_or_else(|| parent.adapter());
		let adapter = self
			.environment
			.dap_adapters()
			.select_attach(Some(adapter_name), None)
			.or_else(|| {
				self
					.environment
					.dap_adapters()
					.select_attach(Some(parent.adapter()), None)
			})
			.ok_or_else(|| Str::new_static("child DAP adapter was not found"))?;
		let protocol = if attach {
			if let Some(port) = configuration
				.get("port")
				.and_then(serde_json::Value::as_u64)
			{
				let port = u16::try_from(port)
					.map_err(|_| Str::new_static("child DAP port is out of range"))?;
				let host = configuration
					.get("host")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("127.0.0.1");
				Some(
					DapProtocol::connect_tcp_host(host, port)
						.await
						.map_err(|_| Str::new_static("child DAP connection failed"))?,
				)
			} else {
				None
			}
		} else {
			None
		};
		let child_id: [u8; 16] = rand::random();
		let child_id = omp_core::hex::encode_n(&child_id);
		let handler = Arc::new(self.clone());
		let child = if let Some(protocol) = protocol {
			DapSession::start(
				child_id.as_str(),
				adapter.spec.name.as_str(),
				protocol,
				attach,
				adapter.spec.merged_arguments(attach, &configuration),
				Some(handler),
			)
			.await
		} else {
			let spawned = DapProtocol::spawn_adapter(
				adapter.spec.command.as_str(),
				&adapter.spec.args,
				&adapter.spec.transport,
				&self.workspace,
			)
			.await
			.map_err(|_| Str::new_static("child DAP adapter launch failed"))?;
			DapSession::start_spawned(
				child_id.as_str(),
				adapter.spec.name.as_str(),
				spawned,
				attach,
				adapter.spec.merged_arguments(attach, &configuration),
				Some(handler),
			)
			.await
		}
		.map_err(|_| Str::new_static("child DAP session failed"))?;
		child.set_wire_grants(self.read, self.execute, self.event_limit);
		parent
			.add_child(&child)
			.await
			.map_err(|_| Str::new_static("child DAP linkage failed"))?;
		self.environment.dap_sessions().insert(child);
		Ok(serde_json::json!({}))
	}
}

/// Dispatches one post-handshake request body. Framing, hello, and cancellation
/// routing remain connection-owned.
#[tracing::instrument(
	level = "debug",
	skip_all,
	fields(request_id = request_id, method = %request_kind(&body))
)]
pub async fn dispatch_request(
	session: EnvironmentSession,
	request_id: u64,
	body: client_frame::Body,
	protocol_minor: u32,
	events: flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	cancellation: CancellationToken,
) -> proto::ServerFrame {
	let result =
		dispatch(&session, body, protocol_minor, events, event_frame_limit, cancellation).await;
	proto::ServerFrame {
		request_id,
		body: Some(match result {
			Ok(body) => body,
			Err(error) => {
				if error.code == proto::ProtocolErrorCode::Cancelled {
					tracing::debug!("protocol request cancelled");
				} else {
					tracing::warn!(code = ?error.code, "protocol request rejected");
				}
				server_frame::Body::Error(error.into_proto())
			},
		}),
	}
}
fn request_kind(body: &client_frame::Body) -> &'static str {
	use client_frame::Body as Request;
	match body {
		Request::Hello(_) => "hello",
		Request::Cancel(_) => "cancel",
		Request::OpenDocument(_) => "open_document",
		Request::CloseDocument(_) => "close_document",
		Request::ReadDocument(_) => "read_document",
		Request::SummarizeDocument(_) => "summarize_document",
		Request::CommitTransaction(_) => "commit_transaction",
		Request::GetLspBindings(_) => "get_lsp_bindings",
		Request::LspStatus(_) => "lsp_status",
		Request::LspRequest(_) => "lsp_request",
		Request::LspNotification(_) => "lsp_notification",
		Request::AcquireWorkspaceLease(_) => "acquire_workspace_lease",
		Request::ReleaseWorkspaceLease(_) => "release_workspace_lease",
		Request::CanonicalizePath(_) => "canonicalize_path",
		Request::StatPath(_) => "stat_path",
		Request::ListDirectory(_) => "list_directory",
		Request::CreateDirectory(_) => "create_directory",
		Request::RemovePath(_) => "remove_path",
		Request::RenamePath(_) => "rename_path",
		Request::CopyPath(_) => "copy_path",
		Request::ReadLink(_) => "read_link",
		Request::CreateSymlink(_) => "create_symlink",
		Request::CreateHardLink(_) => "create_hard_link",
		Request::SetPermissions(_) => "set_permissions",
		Request::DapLaunch(_) => "dap_launch",
		Request::DapAttach(_) => "dap_attach",
		Request::DapAction(_) => "dap_action",
	}
}

const CLOSE_SESSION_LEASE_DEADLINE: Duration = Duration::from_secs(1);

/// Cancels every session event forwarder and releases every registry-owned
/// lease, balancing LSP and document-store ownership.
pub async fn close_session(session: &EnvironmentSession) {
	session.release_workspace_leases();
	let leases = session.take_leases();
	for lease_id in leases {
		let cancellation = CancellationToken::new();
		let close = session
			.environment()
			.lsp()
			.close_document(lease_id, cancellation.child_token());
		let _ = await_cooperative_cleanup(&cancellation, CLOSE_SESSION_LEASE_DEADLINE, close).await;
	}
}

async fn await_cooperative_cleanup<T>(
	cancellation: &CancellationToken,
	deadline: Duration,
	cleanup: impl Future<Output = T>,
) -> T {
	tokio::pin!(cleanup);
	tokio::select! {
		biased;
		output = &mut cleanup => output,
		() = tokio::time::sleep(deadline) => {
			cancellation.cancel();
			cleanup.await
		},
	}
}
/// Converts one registry-wide LSP event into a session-visible unsolicited
/// frame, filtering document-scoped events without a connection-owned lease.
pub async fn registry_event_frame(
	session: &EnvironmentSession,
	event: LspRegistryEvent,
) -> Option<proto::ServerFrame> {
	let body = match event {
		LspRegistryEvent::Inbound(event) => {
			if !inbound_event_is_resolved(
				event.method(),
				event.params_json(),
				event.document_identity().is_some(),
				event.revision().is_some(),
			) {
				return None;
			}
			if let Some(document_id) = event.document_id()
				&& session.lease_for_document(document_id).is_none()
			{
				return None;
			}
			let document = event
				.document_identity()
				.map(|(document_id, uri)| proto::DocumentRef {
					id:  Bytes::copy_from_slice(document_id.as_bytes()),
					uri: uri.to_string(),
				});
			server_frame::Body::LspEvent(proto::LspEvent {
				server_id: binding_id_bytes(event.binding_id()),
				method: event.method().to_owned(),
				params_json: event.params_json().clone(),
				document,
				revision: event.revision().map(revision_to_proto),
			})
		},
		LspRegistryEvent::Binding(event) => {
			let document_id = event.document_id();
			let lease_id = if let Some(document_id) = document_id {
				match session.lease_for_document(document_id) {
					Some(lease_id) => Some(lease_id),
					None => return None,
				}
			} else {
				None
			};
			let binding = if let Some(lease_id) = lease_id {
				session
					.environment()
					.lsp()
					.lease_bindings(lease_id)
					.await
					.ok()
					.and_then(|bindings| {
						bindings
							.into_iter()
							.find(|binding| binding.info().id() == event.binding_id())
					})
					.as_ref()
					.map(binding_to_proto)
			} else {
				session
					.environment()
					.lsp()
					.bindings()
					.into_iter()
					.find(|binding| binding.id() == event.binding_id())
					.map(|binding| proto::LspServerBinding {
						server_id:         binding_id_bytes(binding.id()),
						name:              binding.spec().name().to_owned(),
						sync_policy:       None,
						capabilities_json: Bytes::new(),
						settings_json:     binding.spec().settings_json().clone(),
					})
			}
			.or_else(|| {
				Some(proto::LspServerBinding {
					server_id:         binding_id_bytes(event.binding_id()),
					name:              String::new(),
					sync_policy:       None,
					capabilities_json: Bytes::new(),
					settings_json:     Bytes::new(),
				})
			});
			let document = match document_id {
				Some(document_id) => document_ref_to_proto(session, document_id).await,
				None => None,
			};
			server_frame::Body::LspBindingEvent(proto::LspBindingEvent {
				kind: match event.kind() {
					LspBindingEventKind::Ready => proto::LspBindingEventKind::Ready,
					LspBindingEventKind::PolicyChanged => proto::LspBindingEventKind::PolicyChanged,
					LspBindingEventKind::Restarted => proto::LspBindingEventKind::Restarted,
					LspBindingEventKind::Stopped => proto::LspBindingEventKind::Stopped,
				} as i32,
				binding,
				document,
			})
		},
		LspRegistryEvent::Startup(event) => {
			let stage: &'static str = event.stage.into();
			let params_json = serde_json::to_vec(&serde_json::json!({
				"name": event.name.as_str(),
				"stage": stage,
			}))
			.ok()
			.map(Bytes::from)?;
			server_frame::Body::LspEvent(proto::LspEvent {
				server_id: Bytes::new(),
				method: "omp/lspStartup".to_owned(),
				params_json,
				document: None,
				revision: None,
			})
		},
	};
	Some(proto::ServerFrame { request_id: 0, body: Some(body) })
}

const EVENT_STREAM_ERROR_PROTOCOL_MINOR: u32 = 1;

fn document_event_stream_error_frame(
	protocol_minor: u32,
	lease_id: LeaseId,
	error: DocumentEventStreamError,
) -> proto::ServerFrame {
	let (failure, skipped_events, message, legacy_code) = match error {
		DocumentEventStreamError::Lagged { skipped } => (
			proto::EventStreamFailure::Lagged,
			skipped,
			format!("document event stream lagged by {skipped} events; reopen the document"),
			proto::ProtocolErrorCode::ContentModified,
		),
		DocumentEventStreamError::Synchronization { message } => (
			proto::EventStreamFailure::Synchronization,
			0,
			format!("document event synchronization failed: {message}; reopen the document"),
			proto::ProtocolErrorCode::Internal,
		),
		DocumentEventStreamError::Closed => (
			proto::EventStreamFailure::Closed,
			0,
			"document event stream closed unexpectedly; reopen the document".to_owned(),
			proto::ProtocolErrorCode::Internal,
		),
	};
	event_stream_error_frame(
		protocol_minor,
		proto::EventStreamKind::Document,
		failure,
		Bytes::copy_from_slice(lease_id.as_bytes()),
		skipped_events,
		message,
		legacy_code,
	)
}

/// Builds the terminal connection-wide LSP event continuity failure.
pub fn lsp_event_stream_error_frame(
	protocol_minor: u32,
	failure: proto::EventStreamFailure,
	skipped_events: u64,
) -> proto::ServerFrame {
	let (message, legacy_code) = match failure {
		proto::EventStreamFailure::Lagged => (
			format!(
				"LSP registry event stream lagged by {skipped_events} events; reconnect and reopen \
				 documents"
			),
			proto::ProtocolErrorCode::ContentModified,
		),
		_ => (
			"LSP registry event stream closed unexpectedly; reconnect and reopen documents".to_owned(),
			proto::ProtocolErrorCode::Internal,
		),
	};
	event_stream_error_frame(
		protocol_minor,
		proto::EventStreamKind::LspRegistry,
		failure,
		Bytes::new(),
		skipped_events,
		message,
		legacy_code,
	)
}

fn event_stream_error_frame(
	protocol_minor: u32,
	stream: proto::EventStreamKind,
	failure: proto::EventStreamFailure,
	lease_id: Bytes,
	skipped_events: u64,
	message: String,
	legacy_code: proto::ProtocolErrorCode,
) -> proto::ServerFrame {
	let body = if protocol_minor >= EVENT_STREAM_ERROR_PROTOCOL_MINOR {
		server_frame::Body::EventStreamError(proto::EventStreamError {
			stream: stream as i32,
			failure: failure as i32,
			lease_id,
			skipped_events,
			message,
		})
	} else {
		server_frame::Body::Error(proto::ProtocolError { code: legacy_code as i32, message })
	};
	proto::ServerFrame { request_id: 0, body: Some(body) }
}

async fn dispatch(
	session: &EnvironmentSession,
	body: client_frame::Body,
	protocol_minor: u32,
	events: flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	cancellation: CancellationToken,
) -> DispatchResult<server_frame::Body> {
	use proto::{client_frame::Body as Request, server_frame::Body as Response};
	match body {
		Request::Hello(_) => Err(Failure::invalid("ClientHello is connection-owned")),
		Request::Cancel(_) => Err(Failure::invalid("CancelRequest is connection-owned")),
		Request::OpenDocument(request) => {
			open_document(session, request, protocol_minor, events, event_frame_limit, cancellation)
				.await
				.map(Response::DocumentOpened)
		},
		Request::CloseDocument(request) => close_document(session, request, cancellation)
			.await
			.map(Response::DocumentClosed),
		Request::ReadDocument(request) => read_document(session, request, cancellation)
			.await
			.map(Response::DocumentRead),
		Request::SummarizeDocument(request) => summarize_document(session, request, cancellation)
			.await
			.map(Response::DocumentSummarized),
		Request::CommitTransaction(request) => commit_transaction(session, request, cancellation)
			.await
			.map(Response::TransactionResult),
		Request::GetLspBindings(request) => get_lsp_bindings(session, request, cancellation)
			.await
			.map(Response::LspBindings),
		Request::LspStatus(request) => Ok(Response::LspStatus(
			lsp_status(session, request.reload, request.start, &cancellation).await,
		)),
		Request::LspRequest(request) => lsp_request(session, request, cancellation)
			.await
			.map(Response::LspResponse),
		Request::LspNotification(request) => lsp_notification(session, request, cancellation)
			.await
			.map(Response::LspNotificationAccepted),
		Request::AcquireWorkspaceLease(request) => acquire_workspace_lease(session, request)
			.await
			.map(Response::WorkspaceLeaseAcquired),
		Request::ReleaseWorkspaceLease(request) => {
			release_workspace_lease(session, request).map(Response::WorkspaceLeaseReleased)
		},
		Request::CanonicalizePath(request) => {
			canonicalize_path(session, request).map(Response::PathCanonicalized)
		},
		Request::StatPath(request) => stat_path(session, request).map(Response::PathStat),
		Request::ListDirectory(request) => {
			list_directory(session, request).map(Response::DirectoryListed)
		},
		Request::CreateDirectory(request) => create_directory(session, request, cancellation)
			.await
			.map(Response::DirectoryCreated),
		Request::RemovePath(request) => remove_path(session, request, cancellation)
			.await
			.map(Response::PathRemoved),
		Request::RenamePath(request) => rename_path(session, request, cancellation)
			.await
			.map(Response::PathRenamed),
		Request::CopyPath(request) => copy_path(session, request, cancellation)
			.await
			.map(Response::PathCopied),
		Request::ReadLink(request) => read_link(session, request).map(Response::LinkRead),
		Request::CreateSymlink(request) => create_symlink(session, request, cancellation)
			.await
			.map(Response::SymlinkCreated),
		Request::CreateHardLink(request) => create_hard_link(session, request, cancellation)
			.await
			.map(Response::HardLinkCreated),
		Request::SetPermissions(request) => set_permissions(session, request, cancellation)
			.await
			.map(Response::PermissionsSet),
		Request::DapLaunch(request) => dap_start(
			session,
			request.adapter,
			request.workspace_uri,
			request.configuration_json,
			request.capabilities,
			request.max_event_bytes,
			false,
			&events,
			event_frame_limit,
			cancellation,
		)
		.await
		.map(Response::DapSession),
		Request::DapAttach(request) => dap_start(
			session,
			request.adapter,
			request.workspace_uri,
			request.configuration_json,
			request.capabilities,
			request.max_event_bytes,
			true,
			&events,
			event_frame_limit,
			cancellation,
		)
		.await
		.map(Response::DapSession),
		Request::DapAction(request) => {
			dap_action(session, request, &events, event_frame_limit, cancellation)
				.await
				.map(Response::DapAction)
		},
	}
}

const MAX_DAP_CONFIGURATION_BYTES: usize = 1024 * 1024;
const MAX_DAP_EVENT_BYTES: u32 = 1024 * 1024;
const MAX_DAP_RESPONSE_BYTES: u32 = 4 * 1024 * 1024;
const DAP_SESSION_GENERATION: u64 = 1;

async fn dap_start(
	connection: &EnvironmentSession,
	adapter_name: String,
	workspace_uri: String,
	configuration_json: Bytes,
	capabilities: Vec<i32>,
	max_event_bytes: u32,
	attach: bool,
	events: &flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	cancellation: CancellationToken,
) -> DispatchResult<proto::DapSessionResponse> {
	if configuration_json.len() > MAX_DAP_CONFIGURATION_BYTES {
		return Err(Failure::resource("DAP configuration exceeds its byte ceiling"));
	}
	if max_event_bytes == 0 || max_event_bytes > MAX_DAP_EVENT_BYTES {
		return Err(Failure::invalid("DAP event byte ceiling is out of range"));
	}
	let workspace = parse_file_uri(&workspace_uri)?;
	if workspace != *connection.environment().root_uri() {
		return Err(Failure::precondition(
			"DAP workspace must equal this Environment's project root",
		));
	}
	let mut read = false;
	let mut execute = false;
	for capability in capabilities {
		match proto::DapCapability::try_from(capability)
			.map_err(|_| Failure::invalid("unknown DAP capability"))?
		{
			proto::DapCapability::Read => read = true,
			proto::DapCapability::Execute => execute = true,
			proto::DapCapability::Unspecified => {
				return Err(Failure::invalid("unspecified DAP capability is not grantable"));
			},
		}
	}
	if !execute {
		return Err(Failure::precondition("launch and attach require the DAP execute capability"));
	}
	let supplied: serde_json::Value = serde_json::from_slice(&configuration_json)
		.map_err(|_| Failure::invalid("DAP configuration must be valid JSON"))?;
	let mut supplied = supplied
		.as_object()
		.cloned()
		.ok_or_else(|| Failure::invalid("DAP configuration must be a JSON object"))?;
	let root = workspace
		.to_file_path()
		.map_err(|()| Failure::invalid("DAP workspace is not a local file URI"))?;
	let port = supplied
		.get("port")
		.and_then(serde_json::Value::as_u64)
		.and_then(|port| u16::try_from(port).ok());
	let command_cwd = supplied
		.get("cwd")
		.and_then(serde_json::Value::as_str)
		.map(PathBuf::from)
		.map_or_else(
			|| root.clone(),
			|cwd| {
				if cwd.is_absolute() {
					cwd
				} else {
					root.join(cwd)
				}
			},
		);
	let launch_program = (!attach)
		.then(|| supplied.get("program").and_then(serde_json::Value::as_str))
		.flatten()
		.map(PathBuf::from)
		.map(|program| {
			if program.is_absolute() {
				program
			} else {
				command_cwd.join(program)
			}
		});
	if let Some(program) = &launch_program {
		supplied.insert(
			"program".to_owned(),
			serde_json::Value::String(program.to_string_lossy().into_owned()),
		);
		supplied.insert(
			"cwd".to_owned(),
			serde_json::Value::String(command_cwd.to_string_lossy().into_owned()),
		);
	}
	if !attach && launch_program.is_none() {
		return Err(Failure::invalid("DAP launch requires program"));
	}
	if attach
		&& adapter_name.is_empty()
		&& port.is_none()
		&& supplied
			.get("pid")
			.and_then(serde_json::Value::as_u64)
			.is_none()
	{
		return Err(Failure::invalid("DAP attach requires pid or port when adapter is omitted"));
	}
	let adapter = if !adapter_name.is_empty() {
		connection
			.environment()
			.dap_adapters()
			.select_attach(Some(&adapter_name), port)
			.ok_or_else(|| Failure::not_found("configured DAP adapter was not found"))?
	} else if attach {
		connection
			.environment()
			.dap_adapters()
			.select_attach(None, port)
			.ok_or_else(|| Failure::not_found("no available DAP adapter accepts this attachment"))?
	} else {
		let program = launch_program
			.as_ref()
			.expect("launch program presence was validated");
		match connection
			.environment()
			.dap_adapters()
			.select_launch(program, &root)
		{
			LaunchAdapterSelection::Available(adapter) => adapter,
			LaunchAdapterSelection::Unavailable { .. } => {
				return Err(Failure::not_found("selected DAP adapter executable is unavailable"));
			},
			LaunchAdapterSelection::NoMatch => {
				return Err(Failure::not_found("no available DAP adapter accepts this program"));
			},
		}
	};
	if launch_program
		.as_ref()
		.is_some_and(|program| !program.exists())
	{
		return Err(Failure::not_found("DAP launch program was not found"));
	}
	if launch_program
		.as_ref()
		.is_some_and(|program| program.is_dir())
		&& !adapter.spec.accepts_directory_program
	{
		return Err(Failure::invalid("selected DAP adapter does not accept a directory program"));
	}
	let arguments = if attach {
		adapter.spec.merged_arguments(true, &supplied)
	} else {
		adapter.spec.launch_arguments(
			launch_program
				.as_deref()
				.expect("launch program presence was validated"),
			&supplied,
		)
	};
	let reverse_handler: Arc<dyn DapReverseRequestHandler> =
		Arc::new(EnvironmentDapReverseHandler {
			environment: connection.environment().clone(),
			workspace: root.clone(),
			read,
			execute,
			event_limit: max_event_bytes,
		});
	let session_id: [u8; 16] = rand::random();
	let registry_id = omp_core::hex::encode_n(&session_id);
	let debug_session = tokio::select! {
		biased;
		() = cancellation.cancelled() => return Err(Failure::cancelled("DAP launch cancelled")),
		result = async {
			let spawned = DapProtocol::spawn_adapter(
				adapter.spec.command.as_str(),
				&adapter.spec.args,
				&adapter.spec.transport,
				&root,
			)
			.await
			.map_err(|_| Failure::internal("DAP adapter launch failed"))?;
			DapSession::start_spawned(
				registry_id.as_str(),
				adapter.spec.name.as_str(),
				spawned,
				attach,
				arguments,
				Some(reverse_handler),
			)
			.await
			.map_err(Failure::from_dap)
		} => result?,
	};
	debug_session.set_wire_grants(read, execute, max_event_bytes);
	let adapter_capabilities_json = serde_json::to_vec(&debug_session.capabilities())
		.map(Bytes::from)
		.map_err(|_| Failure::internal("DAP capabilities could not be encoded"))?;
	if adapter_capabilities_json.len() > usize::try_from(max_event_bytes).unwrap_or(usize::MAX) {
		let _ = debug_session.terminate().await;
		return Err(Failure::resource("DAP adapter capabilities exceed the requested byte ceiling"));
	}
	connection
		.environment()
		.dap_sessions()
		.insert(Arc::clone(&debug_session));
	let session_ref = dap_session_ref(&session_id, &debug_session);
	let mut started_body = serde_json::to_vec(&serde_json::json!({
		"state": Into::<&'static str>::into(debug_session.state()),
	}))
	.map_err(|_| Failure::internal("DAP lifecycle event could not be encoded"))?;
	if started_body.len() > usize::try_from(max_event_bytes).unwrap_or(usize::MAX) {
		started_body.clear();
	}
	let started_body = Bytes::from(started_body);
	send_dap_frame(
		events,
		event_frame_limit,
		server_frame::Body::DapEvent(proto::DapEvent {
			session:   Some(session_ref.clone()),
			sequence:  debug_session.next_event_sequence(),
			event:     "started".to_owned(),
			body_json: started_body,
		}),
	)
	.await?;
	Ok(proto::DapSessionResponse {
		session: Some(session_ref),
		granted_capabilities: [
			read.then_some(proto::DapCapability::Read as i32),
			execute.then_some(proto::DapCapability::Execute as i32),
		]
		.into_iter()
		.flatten()
		.collect(),
		adapter_capabilities_json,
		adapter: adapter.spec.name.as_str().to_owned(),
	})
}

async fn dap_action(
	connection: &EnvironmentSession,
	request: proto::DapActionRequest,
	events: &flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	cancellation: CancellationToken,
) -> DispatchResult<proto::DapActionResponse> {
	let session_ref = required(request.session, "DAP session")?;
	if session_ref.session_id.len() != 16 {
		return Err(Failure::invalid("DAP session identity must be exactly 16 bytes"));
	}
	let session_id: [u8; 16] = session_ref
		.session_id
		.as_ref()
		.try_into()
		.expect("DAP session identity length was validated");
	let registry_id = omp_core::hex::encode_n(&session_id);
	let debug_session = connection
		.environment()
		.dap_sessions()
		.get(registry_id.as_str())
		.map_err(Failure::from_dap)?;
	if session_ref.generation != DAP_SESSION_GENERATION {
		return Err(Failure::precondition("DAP session generation is stale"));
	}
	let current_revision = debug_session.revision();
	if request.expected_revision != current_revision || session_ref.revision != current_revision {
		return Err(Failure::precondition("DAP session revision is stale"));
	}
	if request.max_response_bytes == 0 || request.max_response_bytes > MAX_DAP_RESPONSE_BYTES {
		return Err(Failure::invalid("DAP response byte ceiling is out of range"));
	}
	let timeout = if request.timeout_ms == 0 {
		Duration::from_secs(30)
	} else if request.timeout_ms > 300_000 {
		return Err(Failure::invalid("DAP action timeout is out of range"));
	} else {
		Duration::from_millis(u64::from(request.timeout_ms.max(5_000)))
	};
	let action = request
		.command
		.parse::<DapAction>()
		.map_err(|_| Failure::invalid("unknown DAP action command"))?;
	let action_session = if matches!(
		action,
		DapAction::SetBreakpoint
			| DapAction::RemoveBreakpoint
			| DapAction::SetFunctionBreakpoint
			| DapAction::RemoveFunctionBreakpoint
			| DapAction::SetInstructionBreakpoint
			| DapAction::RemoveInstructionBreakpoint
			| DapAction::SetDataBreakpoint
			| DapAction::RemoveDataBreakpoint
			| DapAction::Terminate
			| DapAction::Sessions
	) {
		Arc::clone(&debug_session)
	} else {
		debug_session.active_target()
	};
	action_session
		.ensure_action_supported(action)
		.map_err(Failure::from_dap)?;
	let tier = action.approval_tier();
	if !debug_session.grants(tier) {
		return Err(Failure::precondition(
			"DAP session was not granted the capability required by this action",
		));
	}
	let required_capability = proto::DapCapability::try_from(request.required_capability)
		.map_err(|_| Failure::invalid("unknown required DAP capability"))?;
	let expected_capability = match tier {
		DapApprovalTier::ReadOnly => proto::DapCapability::Read,
		DapApprovalTier::Execution => proto::DapCapability::Execute,
	};
	if required_capability != expected_capability {
		return Err(Failure::precondition(
			"DAP action capability does not match the authoritative action tier",
		));
	}
	let arguments = if request.arguments_json.is_empty() {
		serde_json::json!({})
	} else {
		serde_json::from_slice(&request.arguments_json)
			.map_err(|_| Failure::invalid("DAP action arguments must be valid JSON"))?
	};
	let mut inbound = action_session.subscribe();
	let operation = execute_dap_action(
		connection.environment().dap_sessions(),
		&action_session,
		action,
		arguments,
		timeout,
	);
	let result = if action == DapAction::Terminate {
		operation.await?
	} else {
		tokio::select! {
			biased;
			() = cancellation.cancelled() => return Err(Failure::cancelled("DAP action cancelled")),
			result = operation => result?,
		}
	};
	let revision = debug_session.advance_revision();
	let response_ref = proto::DapSessionRef {
		session_id: Bytes::copy_from_slice(&session_id),
		generation: DAP_SESSION_GENERATION,
		revision,
	};
	while let Ok(event) = inbound.try_recv() {
		forward_dap_inbound(events, event_frame_limit, &action_session, &response_ref, event).await?;
	}
	if action == DapAction::Output {
		send_dap_output(
			events,
			event_frame_limit,
			&action_session,
			&response_ref,
			"console",
			action_session.output_snapshot(),
		)
		.await?;
	}
	let body_json = serde_json::to_vec(&result)
		.map(Bytes::from)
		.map_err(|_| Failure::internal("DAP action response could not be encoded"))?;
	if body_json.len() > usize::try_from(request.max_response_bytes).unwrap_or(usize::MAX) {
		return Err(Failure::resource("DAP action response exceeds the requested byte ceiling"));
	}
	Ok(proto::DapActionResponse {
		session: Some(response_ref),
		success: true,
		body_json,
		message: String::new(),
	})
}

async fn execute_dap_action(
	registry: &DapSessionRegistry,
	session: &Arc<DapSession>,
	action: DapAction,
	arguments: serde_json::Value,
	timeout: Duration,
) -> DispatchResult<serde_json::Value> {
	match action {
		DapAction::Output => Ok(serde_json::json!({})),
		DapAction::SetBreakpoint | DapAction::RemoveBreakpoint => {
			let source = arguments
				.get("source")
				.and_then(|source| source.get("path"))
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| Failure::invalid("source breakpoint requires source.path"))?;
			let breakpoint = arguments
				.get("breakpoint")
				.cloned()
				.ok_or_else(|| Failure::invalid("source breakpoint requires breakpoint"))?;
			session
				.mutate_source_breakpoint(source, breakpoint, action == DapAction::RemoveBreakpoint)
				.await
				.map_err(Failure::from_dap)
		},
		DapAction::SetFunctionBreakpoint | DapAction::RemoveFunctionBreakpoint => {
			let breakpoint = arguments
				.get("breakpoint")
				.cloned()
				.ok_or_else(|| Failure::invalid("function breakpoint requires breakpoint"))?;
			session
				.mutate_function_breakpoint(breakpoint, action == DapAction::RemoveFunctionBreakpoint)
				.await
				.map_err(Failure::from_dap)
		},
		DapAction::SetInstructionBreakpoint | DapAction::RemoveInstructionBreakpoint => {
			let breakpoint = arguments
				.get("breakpoint")
				.cloned()
				.ok_or_else(|| Failure::invalid("instruction breakpoint requires breakpoint"))?;
			session
				.mutate_instruction_breakpoint(
					breakpoint,
					action == DapAction::RemoveInstructionBreakpoint,
				)
				.await
				.map_err(Failure::from_dap)
		},
		DapAction::SetDataBreakpoint | DapAction::RemoveDataBreakpoint => {
			let breakpoint = arguments
				.get("breakpoint")
				.cloned()
				.ok_or_else(|| Failure::invalid("data breakpoint requires breakpoint"))?;
			session
				.mutate_data_breakpoint(breakpoint, action == DapAction::RemoveDataBreakpoint)
				.await
				.map_err(Failure::from_dap)
		},
		DapAction::Continue
		| DapAction::Pause
		| DapAction::StepOver
		| DapAction::StepIn
		| DapAction::StepOut => session
			.control(action, arguments, timeout.saturating_sub(Duration::from_millis(50)))
			.await
			.map_err(Failure::from_dap)
			.and_then(|snapshot| {
				serde_json::to_value(snapshot)
					.map_err(|_| Failure::internal("DAP stop snapshot could not be encoded"))
			}),
		DapAction::CustomRequest => {
			let command = arguments
				.get("command")
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| Failure::invalid("custom request requires command"))?;
			let body = arguments
				.get("arguments")
				.cloned()
				.unwrap_or_else(|| serde_json::json!({}));
			session
				.custom_request(command, body)
				.await
				.map_err(Failure::from_dap)
		},
		DapAction::Terminate => {
			session.terminate().await.map_err(Failure::from_dap)?;
			Ok(serde_json::json!({}))
		},
		DapAction::Sessions => {
			registry.cleanup();
			Ok(serde_json::Value::Array(
				registry
					.list()
					.into_iter()
					.map(|session| session.snapshot())
					.collect(),
			))
		},
		_ => session
			.execute(action, arguments)
			.await
			.map_err(Failure::from_dap),
	}
}

async fn forward_dap_inbound(
	events: &flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	session: &DapSession,
	session_ref: &proto::DapSessionRef,
	inbound: DapInbound,
) -> DispatchResult<()> {
	match inbound {
		DapInbound::Event { event, body } if event == "output" => {
			let category = body
				.get("category")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("console");
			let output = body
				.get("output")
				.and_then(serde_json::Value::as_str)
				.unwrap_or_default()
				.as_bytes()
				.to_vec();
			send_dap_output(events, event_frame_limit, session, session_ref, category, output).await
		},
		DapInbound::Event { event, body } => {
			let mut body_json = serde_json::to_vec(&body)
				.map_err(|_| Failure::internal("DAP event body could not be encoded"))?;
			if body_json.len() > session.event_byte_limit() {
				body_json.clear();
			}
			send_dap_frame(
				events,
				event_frame_limit,
				server_frame::Body::DapEvent(proto::DapEvent {
					session:   Some(session_ref.clone()),
					sequence:  session.next_event_sequence(),
					event:     event.into(),
					body_json: Bytes::from(body_json),
				}),
			)
			.await
		},
		DapInbound::ReverseRequest { .. } => Ok(()),
	}
}

async fn send_dap_output(
	events: &flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	session: &DapSession,
	session_ref: &proto::DapSessionRef,
	category: &str,
	mut output: Vec<u8>,
) -> DispatchResult<()> {
	let truncated = output.len() > session.event_byte_limit();
	output.truncate(session.event_byte_limit());
	send_dap_frame(
		events,
		event_frame_limit,
		server_frame::Body::DapOutput(proto::DapOutput {
			session: Some(session_ref.clone()),
			sequence: session.next_event_sequence(),
			category: category.to_owned(),
			output: Bytes::from(output),
			truncated,
		}),
	)
	.await
}

async fn send_dap_frame(
	events: &flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	body: server_frame::Body,
) -> DispatchResult<()> {
	let frame = proto::ServerFrame { request_id: 0, body: Some(body) };
	if frame.encoded_len() > event_frame_limit {
		return Err(Failure::resource("DAP event exceeds the document frame ceiling"));
	}
	events
		.send_async(frame)
		.await
		.map_err(|_| Failure::cancelled("DAP event consumer disconnected"))
}

fn dap_session_ref(session_id: &[u8; 16], session: &DapSession) -> proto::DapSessionRef {
	proto::DapSessionRef {
		session_id: Bytes::copy_from_slice(session_id),
		generation: DAP_SESSION_GENERATION,
		revision:   session.revision(),
	}
}

async fn acquire_workspace_lease(
	session: &EnvironmentSession,
	request: proto::AcquireWorkspaceLeaseRequest,
) -> DispatchResult<proto::AcquireWorkspaceLeaseResponse> {
	if request.uris.is_empty() {
		return Err(Failure::invalid("workspace lease requires at least one URI"));
	}
	let transaction_id = exact_array(&request.transaction_id, "workspace lease transaction id")?;
	let uris = request
		.uris
		.iter()
		.map(|uri| parse_file_uri(uri))
		.collect::<DispatchResult<Vec<_>>>()?;
	let outcome = session
		.acquire_workspace_lease(&uris, transaction_id, request.dry_run)
		.await
		.map_err(Failure::from_core)?;
	Ok(proto::AcquireWorkspaceLeaseResponse {
		workspace_lease_id: outcome
			.lease_id
			.map(|id| Bytes::copy_from_slice(id.as_bytes())),
		conflicts:          outcome
			.conflicts
			.into_iter()
			.map(|conflict| {
				let uri = session
					.environment()
					.store()
					.file_uri(&conflict.path)
					.map_err(Failure::from_core)?;
				Ok(proto::WorkspaceLeaseConflict {
					uri:             uri.to_string(),
					active_lease_id: Bytes::copy_from_slice(&conflict.active_lease_id),
				})
			})
			.collect::<DispatchResult<Vec<_>>>()?,
	})
}

fn release_workspace_lease(
	session: &EnvironmentSession,
	request: proto::ReleaseWorkspaceLeaseRequest,
) -> DispatchResult<proto::ReleaseWorkspaceLeaseResponse> {
	let id =
		WorkspaceLeaseId::from_bytes(exact_array(&request.workspace_lease_id, "workspace lease id")?);
	if !session.release_workspace_lease(id) {
		return Err(Failure::invalid("workspace lease is missing or owned by another connection"));
	}
	Ok(proto::ReleaseWorkspaceLeaseResponse {})
}

async fn open_document(
	session: &EnvironmentSession,
	request: proto::OpenDocumentRequest,
	protocol_minor: u32,
	events_sender: flume::Sender<proto::ServerFrame>,
	event_frame_limit: usize,
	cancellation: CancellationToken,
) -> DispatchResult<proto::OpenDocumentResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let path = session
		.environment()
		.store()
		.resolve_entry_path(&uri)
		.map_err(Failure::from_core)?;
	if let Some(supervisor) = session.environment().lsp_supervisor() {
		supervisor.notify_open(&path);
	}
	let language = if request.language_id.is_empty() {
		None
	} else {
		Some(LanguageId::new(&request.language_id).map_err(Failure::from_core)?)
	};
	let lease = session
		.environment()
		.lsp()
		.open_document(path, language, cancellation.child_token())
		.await
		.map_err(Failure::from_registry)?;
	let (lease_id, head, _, receiver) = lease.into_parts();
	let forwarder_cancel = CancellationToken::new();
	let events_ready = CancellationToken::new();
	session.own_lease(lease_id, head.document_id(), forwarder_cancel.clone(), events_ready.clone());
	let response_head = head_to_proto(session, &head, &cancellation).await;
	let response_head = match response_head {
		Ok(head) => head,
		Err(error) => {
			close_owned_lease(session, lease_id).await;
			return Err(error);
		},
	};
	let event_session = session.clone();
	tokio::spawn(async move {
		tokio::select! {
			() = forwarder_cancel.cancelled() => return,
			() = events_ready.cancelled() => {},
		}
		loop {
			let received = tokio::select! {
				() = forwarder_cancel.cancelled() => break,
				event = receiver.recv_async() => event,
			};
			let event = match received {
				Ok(Ok(event)) => event,
				Ok(Err(error)) => {
					let frame = document_event_stream_error_frame(protocol_minor, lease_id, error);
					close_owned_lease(&event_session, lease_id).await;
					let _ = events_sender.send_async(frame).await;
					break;
				},
				Err(_) => {
					let frame = document_event_stream_error_frame(
						protocol_minor,
						lease_id,
						DocumentEventStreamError::Closed,
					);
					close_owned_lease(&event_session, lease_id).await;
					let _ = events_sender.send_async(frame).await;
					break;
				},
			};
			let body = match document_event_to_proto(&event_session, &event) {
				Ok(event) => server_frame::Body::DocumentEvent(event),
				Err(error) => {
					let frame = document_event_stream_error_frame(
						protocol_minor,
						lease_id,
						DocumentEventStreamError::Synchronization { message: Str::new(error.message) },
					);
					close_owned_lease(&event_session, lease_id).await;
					let _ = events_sender.send_async(frame).await;
					break;
				},
			};
			let frame = proto::ServerFrame { request_id: 0, body: Some(body) };
			if frame.encoded_len() > event_frame_limit {
				let terminal = document_event_stream_error_frame(
					protocol_minor,
					lease_id,
					DocumentEventStreamError::Closed,
				);
				close_owned_lease(&event_session, lease_id).await;
				let _ = events_sender.send_async(terminal).await;
				break;
			}
			if events_sender.send_async(frame).await.is_err() {
				break;
			}
		}
	});
	Ok(proto::OpenDocumentResponse {
		lease_id: Bytes::copy_from_slice(lease_id.as_bytes()),
		head:     Some(response_head),
	})
}

async fn close_owned_lease(session: &EnvironmentSession, lease_id: LeaseId) {
	session.release_lease(lease_id);
	let cancellation = CancellationToken::new();
	let close = session
		.environment()
		.lsp()
		.close_document(lease_id, cancellation.child_token());
	let _ = await_cooperative_cleanup(&cancellation, CLOSE_SESSION_LEASE_DEADLINE, close).await;
}

async fn close_document(
	session: &EnvironmentSession,
	request: proto::CloseDocumentRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CloseDocumentResponse> {
	let lease_id = parse_lease_id(&request.lease_id)?;
	if !session.release_lease(lease_id) {
		return Err(Failure::not_found("document lease is not owned by this connection"));
	}
	let result = session
		.environment()
		.lsp()
		.close_document(lease_id, cancellation)
		.await
		.map_err(Failure::from_registry);
	result?;
	Ok(proto::CloseDocumentResponse {})
}

async fn read_document(
	session: &EnvironmentSession,
	request: proto::ReadDocumentRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::ReadDocumentResponse> {
	let target = parse_target(required(request.document, "read document target")?)?;
	let revision = request.revision.map(parse_revision).transpose()?;
	let selection = parse_read_selection(required(request.selection, "read selection")?)?;
	let locator = locator_for_target(session, &target)?;
	let selected = tokio::select! {
		biased;
		() = cancellation.cancelled() => return Err(Failure::cancelled("read request cancelled")),
		result = session.environment().store().read(locator.clone(), revision, selection.clone()) => {
			result.map_err(Failure::from_core)?
		},
	};
	let retained = tokio::select! {
		biased;
		() = cancellation.cancelled() => return Err(Failure::cancelled("read request cancelled")),
		result = session.environment().store().read(
			locator.clone(),
			Some(selected.head().revision()),
			ReadSelection::Whole,
		) => result.map_err(Failure::from_core)?,
	};
	let ReadBody::Whole(content) = retained.body() else {
		return Err(Failure::internal("whole snapshot read returned slices"));
	};
	let snapshot = Arc::new(
		DocumentSnapshot::new(retained.head().clone(), content.clone())
			.map_err(Failure::from_core)?,
	);
	let path = canonical_path_for_locator(session, locator, &cancellation).await?;
	if cancellation.is_cancelled() {
		return Err(Failure::cancelled("read request cancelled"));
	}
	session
		.edit_adapters()
		.record_snapshot(&path, snapshot, &selection)
		.map_err(Failure::from_core)?;
	let body = match selected.body() {
		ReadBody::Whole(content) => read_document_response::Body::Content(content.clone()),
		ReadBody::Slices(slices) => read_document_response::Body::Slices(proto::ContentSlices {
			slices: slices
				.iter()
				.map(|slice| proto::ContentSlice {
					start:   slice.start(),
					end:     slice.end(),
					content: slice.content().clone(),
				})
				.collect(),
		}),
	};
	Ok(proto::ReadDocumentResponse {
		head: Some(head_to_proto(session, selected.head(), &cancellation).await?),
		body: Some(body),
	})
}

async fn summarize_document(
	session: &EnvironmentSession,
	request: proto::SummarizeDocumentRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::SummarizeDocumentResponse> {
	let target = parse_target(required(request.document, "summary document target")?)?;
	let revision = request.revision.map(parse_revision).transpose()?;
	let options = parse_summary_options(required(request.options, "summary options")?)?;
	let locator = locator_for_target(session, &target)?;
	let read = tokio::select! {
		biased;
		() = cancellation.cancelled() => {
			return Err(Failure::cancelled("summary request cancelled"));
		},
		result = session.environment().store().read(
			locator.clone(),
			revision,
			ReadSelection::Whole,
		) => result.map_err(Failure::from_core)?,
	};
	let ReadBody::Whole(content) = read.body() else {
		return Err(Failure::internal("whole snapshot read returned slices"));
	};
	let snapshot = Arc::new(
		DocumentSnapshot::new(read.head().clone(), content.clone()).map_err(Failure::from_core)?,
	);
	let path = canonical_path_for_locator(session, locator, &cancellation).await?;
	let outcome = session
		.environment()
		.summaries()
		.summarize(snapshot, &path, options, &cancellation)
		.await;
	let outcome = match outcome {
		SummaryOutcome::Available(summary) => {
			summarize_document_response::Outcome::Summary(summary_to_proto(&summary))
		},
		SummaryOutcome::Fallback(fallback) => {
			summarize_document_response::Outcome::Unavailable(fallback_to_proto(&fallback))
		},
		SummaryOutcome::Cancelled => return Err(Failure::cancelled("summary request cancelled")),
	};
	Ok(proto::SummarizeDocumentResponse {
		head:    Some(head_to_proto(session, read.head(), &cancellation).await?),
		outcome: Some(outcome),
	})
}

async fn commit_transaction(
	session: &EnvironmentSession,
	request: proto::CommitTransactionRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CommitTransactionResponse> {
	let transaction_id = parse_transaction_id(&request.transaction_id)?;
	let build_session = session.clone();
	let operations = request.operations;
	let build_cancellation = cancellation.child_token();
	let outcome = session
		.environment()
		.transactions()
		.commit_lazy_for(session.owner(), transaction_id, cancellation, move || async move {
			build_operations(build_session, operations, build_cancellation).await
		})
		.await;
	let mut response = transaction_outcome_to_proto(outcome.as_ref());
	enrich_transaction_diagnostics(session, outcome.as_ref(), &mut response).await;
	Ok(response)
}

async fn build_operations(
	session: EnvironmentSession,
	operations: Vec<proto::DocumentMutation>,
	cancellation: CancellationToken,
) -> Result<Vec<DocumentMutation>, TransactionBuildError> {
	let mut built = Vec::with_capacity(operations.len());
	for operation in operations {
		if cancellation.is_cancelled() {
			return Err(build_cancelled("transaction cancelled during operation building"));
		}
		let target = operation
			.document
			.ok_or_else(|| build_invalid("document mutation target is required"))
			.and_then(|target| parse_target(target).map_err(build_from_failure))?;
		let locator = locator_for_target(&session, &target)
			.map_err(|error| build_precondition(error.message))?;
		let target_path = match &target {
			DocumentTarget::Uri(uri) => session
				.environment()
				.store()
				.resolve_entry_path(uri)
				.map_err(build_snapshot_error)?,
			_ => canonical_path_for_locator(&session, locator, &cancellation)
				.await
				.map_err(|error| build_precondition(error.message))?,
		};
		session
			.check_workspace_paths([target_path])
			.map_err(build_snapshot_error)?;
		let native = match operation
			.operation
			.ok_or_else(|| build_invalid("document mutation operation is required"))?
		{
			document_mutation::Operation::Text(text) => MutationOperation::Text(
				build_text_mutation(&session, &target, text, &cancellation).await?,
			),
			document_mutation::Operation::Create(create) => {
				MutationOperation::Create(build_create_mutation(create)?)
			},
			document_mutation::Operation::Delete(delete) => {
				let revision = delete
					.base_revision
					.ok_or_else(|| build_invalid("delete base revision is required"))
					.and_then(|revision| parse_revision(revision).map_err(build_from_failure))?;
				MutationOperation::Delete(DeleteMutation::new(revision))
			},
			document_mutation::Operation::Move(moved) => {
				let moved = build_move_mutation(moved)?;
				check_workspace_uris(&session, [moved.destination()]).map_err(build_from_failure)?;
				MutationOperation::Move(moved)
			},
			document_mutation::Operation::MoveWithContent(moved) => {
				let moved = build_move_with_content_mutation(moved)?;
				check_workspace_uris(&session, [moved.destination()]).map_err(build_from_failure)?;
				MutationOperation::MoveWithContent(moved)
			},
		};
		built.push(DocumentMutation::new(target, native));
	}
	Ok(built)
}

async fn build_text_mutation(
	session: &EnvironmentSession,
	target: &DocumentTarget,
	text: proto::TextMutation,
	cancellation: &CancellationToken,
) -> Result<TextMutation, TransactionBuildError> {
	let base_revision = text
		.base_revision
		.ok_or_else(|| build_invalid("text base revision is required"))
		.and_then(|revision| parse_revision(revision).map_err(build_from_failure))?;
	let stale_policy = parse_stale_policy(text.stale_policy).map_err(build_from_failure)?;
	let format_policy = parse_format_policy(text.format_policy).map_err(build_from_failure)?;
	let change = text
		.change
		.ok_or_else(|| build_invalid("text mutation change is required"))?;
	let proposal = match change {
		text_mutation::Change::ProposedContent(content) => TextProposal::Content(content),
		text_mutation::Change::Edits(edits) => {
			let edits = edits
				.edits
				.into_iter()
				.map(|edit| {
					ByteRange::new(edit.start, edit.end)
						.map(|range| ByteEdit::new(range, edit.replacement))
				})
				.collect::<CoreResult<Vec<_>>>()
				.map_err(|error| build_invalid(error.to_string()))?;
			TextProposal::Edits(edits)
		},
		text_mutation::Change::Proposal(proposal) => {
			if proposal.format.is_empty() {
				return Err(build_invalid("edit proposal format must not be empty"));
			}
			let locator = locator_for_target(session, target)
				.map_err(|error| build_precondition(error.message))?;
			let read = tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					return Err(build_cancelled("transaction cancelled during proposal lowering"));
				},
				result = session.environment().store().read(
					locator.clone(),
					Some(base_revision),
					ReadSelection::Whole,
				) => result.map_err(build_snapshot_error)?,
			};
			let ReadBody::Whole(content) = read.body() else {
				return Err(build_precondition("whole base snapshot read returned slices"));
			};
			let snapshot = Arc::new(
				DocumentSnapshot::new(read.head().clone(), content.clone())
					.map_err(|error| build_invalid(error.to_string()))?,
			);
			let path = canonical_path_for_locator(session, locator, cancellation)
				.await
				.map_err(|error| build_precondition(error.message))?;
			if cancellation.is_cancelled() {
				return Err(build_cancelled("transaction cancelled during proposal lowering"));
			}
			let edits = session
				.edit_adapters()
				.lower(&proposal.format, &path, snapshot, proposal.payload, proposal.options_json)
				.map_err(|error| build_invalid(error.to_string()))?;
			TextProposal::Edits(edits)
		},
	};
	Ok(TextMutation::new(base_revision, proposal, stale_policy, format_policy))
}

fn build_create_mutation(
	create: proto::CreateMutation,
) -> Result<CreateMutation, TransactionBuildError> {
	let existing = match proto::ExistingDocumentPolicy::try_from(create.existing_document)
		.map_err(|_| build_invalid("unknown existing document policy"))?
	{
		proto::ExistingDocumentPolicy::FailIfExists => ExistingDocumentPolicy::FailIfExists,
		proto::ExistingDocumentPolicy::ReplaceExisting => ExistingDocumentPolicy::ReplaceExisting,
	};
	let format = parse_format_policy(create.format_policy).map_err(build_from_failure)?;
	Ok(CreateMutation::new(create.content, existing, format))
}

fn build_move_mutation(moved: proto::MoveMutation) -> Result<MoveMutation, TransactionBuildError> {
	use omp_proto::document::v1::move_mutation::DestinationPrecondition;
	let base = moved
		.base_revision
		.ok_or_else(|| build_invalid("move base revision is required"))
		.and_then(|revision| parse_revision(revision).map_err(build_from_failure))?;
	let destination = parse_file_uri(&moved.destination_uri).map_err(build_from_failure)?;
	let precondition = match moved
		.destination_precondition
		.ok_or_else(|| build_invalid("move destination precondition is required"))?
	{
		DestinationPrecondition::DestinationRevision(revision) => {
			MoveDestinationPrecondition::Revision(
				parse_revision(revision).map_err(build_from_failure)?,
			)
		},
		DestinationPrecondition::DestinationMustNotExist(true) => {
			MoveDestinationPrecondition::MustNotExist
		},
		DestinationPrecondition::DestinationMustNotExist(false) => {
			return Err(build_invalid("destination_must_not_exist must be true"));
		},
	};
	Ok(MoveMutation::new(base, destination, precondition))
}

fn build_move_with_content_mutation(
	moved: proto::MoveWithContentMutation,
) -> Result<MoveWithContentMutation, TransactionBuildError> {
	use omp_proto::document::v1::move_with_content_mutation::DestinationPrecondition;
	let base = moved
		.base_revision
		.ok_or_else(|| build_invalid("move base revision is required"))
		.and_then(|revision| parse_revision(revision).map_err(build_from_failure))?;
	let destination = parse_file_uri(&moved.destination_uri).map_err(build_from_failure)?;
	let precondition = match moved
		.destination_precondition
		.ok_or_else(|| build_invalid("move destination precondition is required"))?
	{
		DestinationPrecondition::DestinationRevision(revision) => {
			MoveDestinationPrecondition::Revision(
				parse_revision(revision).map_err(build_from_failure)?,
			)
		},
		DestinationPrecondition::DestinationMustNotExist(true) => {
			MoveDestinationPrecondition::MustNotExist
		},
		DestinationPrecondition::DestinationMustNotExist(false) => {
			return Err(build_invalid("destination_must_not_exist must be true"));
		},
	};
	let format = parse_format_policy(moved.format_policy).map_err(build_from_failure)?;
	Ok(MoveWithContentMutation::new(base, destination, precondition, moved.content, format))
}

async fn get_lsp_bindings(
	session: &EnvironmentSession,
	request: proto::GetLspBindingsRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::GetLspBindingsResponse> {
	let target = parse_target(required(request.document, "LSP binding document target")?)?;
	let lease_id = connection_lease_for_target(session, &target, &cancellation).await?;
	if let Some(supervisor) = session.environment().lsp_supervisor() {
		supervisor.wait_idle(&cancellation).await;
	}
	let bindings = tokio::select! {
		biased;
		() = cancellation.cancelled() => {
			return Err(Failure::cancelled("LSP binding request cancelled"));
		},
		result = session.environment().lsp().lease_bindings(lease_id) => {
			result.map_err(Failure::from_registry)?
		},
	};
	Ok(proto::GetLspBindingsResponse { bindings: bindings.iter().map(binding_to_proto).collect() })
}
async fn lsp_status(
	session: &EnvironmentSession,
	reload: bool,
	start: bool,
	cancellation: &CancellationToken,
) -> proto::LspStatusResponse {
	let Some(supervisor) = session.environment().lsp_supervisor() else {
		return proto::LspStatusResponse { servers: Vec::new() };
	};
	if reload && let Err(error) = supervisor.reload() {
		tracing::warn!(%error, "LSP roster reload failed; answering with prior roster");
	}
	if start {
		supervisor.warm_all();
		supervisor.wait_idle(cancellation).await;
	}
	let registry = session.environment().lsp();
	let servers = supervisor
		.status()
		.into_iter()
		.map(|server| {
			let binding_id = registry.binding_id(server.name.as_str());
			proto::LspServerStatus {
				server_id:         binding_id.map(binding_id_bytes).unwrap_or_default(),
				capabilities_json: binding_id
					.and_then(|binding_id| registry.binding_capabilities(binding_id).ok())
					.unwrap_or_default(),
				name:              server.name.to_string(),
				stage:             match server.state {
					LspServerState::Available => proto::LspServerStage::Available,
					LspServerState::Starting => proto::LspServerStage::Starting,
					LspServerState::Indexing => proto::LspServerStage::Indexing,
					LspServerState::Ready => proto::LspServerStage::Ready,
					LspServerState::Failed => proto::LspServerStage::Failed,
				} as i32,
				file_types:        server.file_types.iter().map(ToString::to_string).collect(),
				detail:            server
					.detail
					.map(|detail| detail.to_string())
					.unwrap_or_default(),
				source:            server.source.to_owned(),
			}
		})
		.collect();
	proto::LspStatusResponse { servers }
}

async fn lsp_request(
	session: &EnvironmentSession,
	request: proto::LspRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::LspResponse> {
	let binding_id = parse_binding_id(&request.server_id)?;
	if request.method.is_empty() {
		return Err(Failure::invalid("LSP request method must not be empty"));
	}
	let stale = match proto::LspStalePolicy::try_from(request.stale_policy)
		.map_err(|_| Failure::invalid("unknown LSP stale policy"))?
	{
		proto::LspStalePolicy::Fail => StaleResponsePolicy::ContentModified,
		proto::LspStalePolicy::RetryCurrentHead => StaleResponsePolicy::RetryOnce,
	};
	let is_document_method = request.method.starts_with("textDocument/");
	let result = match (request.document, request.revision) {
		(None, None) if !is_document_method => {
			session
				.environment()
				.lsp()
				.workspace_request(binding_id, &request.method, request.params_json, cancellation)
				.await
		},
		(Some(target), Some(revision)) => {
			let target = parse_target(target)?;
			let lease_id = connection_lease_for_target(session, &target, &cancellation).await?;
			let revision = parse_revision(revision)?;
			if is_document_method {
				validate_text_document_uri(session, lease_id, &request.params_json, &cancellation)
					.await?;
			}
			session
				.environment()
				.lsp()
				.semantic_request(
					binding_id,
					&request.method,
					request.params_json,
					lease_id,
					revision,
					stale,
					cancellation,
				)
				.await
		},
		(None, None) => {
			return Err(Failure::invalid(
				"textDocument requests require document and revision context",
			));
		},
		_ => return Err(Failure::invalid("LSP document and revision must be supplied together")),
	};
	match result {
		Ok(response) => {
			let outcome = match response.outcome {
				LspResponseOutcome::Result(result) => lsp_response::Outcome::ResultJson(result),
				LspResponseOutcome::Error { code, message, data } => {
					lsp_response::Outcome::Error(proto::LspError {
						code,
						message: message.to_string(),
						data_json: data.unwrap_or_default(),
					})
				},
			};
			Ok(proto::LspResponse {
				server_id: binding_id_bytes(binding_id),
				revision:  response.revision.map(revision_to_proto),
				outcome:   Some(outcome),
			})
		},
		Err(error) => Err(Failure::from_registry(error)),
	}
}

async fn lsp_notification(
	session: &EnvironmentSession,
	request: proto::LspNotificationRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::LspNotificationResponse> {
	let binding_id = parse_binding_id(&request.server_id)?;
	if request.method.is_empty() {
		return Err(Failure::invalid("LSP notification method must not be empty"));
	}
	session
		.environment()
		.lsp()
		.notification(binding_id, &request.method, request.params_json, cancellation)
		.await
		.map_err(Failure::from_registry)?;
	Ok(proto::LspNotificationResponse {})
}

fn canonicalize_path(
	session: &EnvironmentSession,
	request: proto::CanonicalizePathRequest,
) -> DispatchResult<proto::CanonicalizePathResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let canonical = session
		.environment()
		.paths()
		.canonicalize(&uri)
		.map_err(Failure::from_core)?;
	Ok(proto::CanonicalizePathResponse { canonical_uri: canonical.to_string() })
}

fn stat_path(
	session: &EnvironmentSession,
	request: proto::StatPathRequest,
) -> DispatchResult<proto::StatPathResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let follow = parse_follow(request.follow_symlinks)?;
	let metadata = session
		.environment()
		.paths()
		.stat(&uri, follow)
		.map_err(Failure::from_core)?;
	Ok(proto::StatPathResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

fn list_directory(
	session: &EnvironmentSession,
	request: proto::ListDirectoryRequest,
) -> DispatchResult<proto::ListDirectoryResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let follow = parse_follow(request.follow_symlinks)?;
	let entries = session
		.environment()
		.paths()
		.list_directory(&uri, follow)
		.map_err(Failure::from_core)?;
	Ok(proto::ListDirectoryResponse {
		entries: entries
			.iter()
			.map(|entry| {
				Ok(proto::DirectoryEntry {
					name:     entry.name.to_string(),
					metadata: Some(metadata_to_proto(session, &entry.metadata)?),
				})
			})
			.collect::<DispatchResult<_>>()?,
	})
}

async fn create_directory(
	session: &EnvironmentSession,
	request: proto::CreateDirectoryRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CreateDirectoryResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&uri])?;
	let existing = match proto::ExistingDirectoryPolicy::try_from(request.existing_leaf)
		.map_err(|_| Failure::invalid("unknown existing directory policy"))?
	{
		proto::ExistingDirectoryPolicy::FailIfExists => ExistingDirectoryPolicy::FailIfExists,
		proto::ExistingDirectoryPolicy::AllowExistingDirectory => {
			ExistingDirectoryPolicy::AllowExistingDirectory
		},
	};
	let metadata = completed_path_result(
		session
			.environment()
			.paths()
			.create_directory(&uri, request.recursive, existing, &cancellation)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::CreateDirectoryResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

async fn remove_path(
	session: &EnvironmentSession,
	request: proto::RemovePathRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::RemovePathResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&uri])?;
	let revision = request.revision.map(parse_revision).transpose()?;
	completed_path_result(
		session
			.environment()
			.paths()
			.remove(&uri, request.recursive, revision, &cancellation)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::RemovePathResponse {})
}

async fn rename_path(
	session: &EnvironmentSession,
	request: proto::RenamePathRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::RenamePathResponse> {
	let source = parse_file_uri(&request.source_uri)?;
	let destination = parse_file_uri(&request.destination_uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&source, &destination])?;
	let overwrite = parse_overwrite(request.overwrite, true)?;
	let source_revision = request.source_revision.map(parse_revision).transpose()?;
	let destination_revision = request
		.destination_revision
		.map(parse_revision)
		.transpose()?;
	let metadata = completed_path_result(
		session
			.environment()
			.paths()
			.rename(
				&source,
				&destination,
				overwrite,
				source_revision,
				destination_revision,
				&cancellation,
			)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::RenamePathResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

async fn copy_path(
	session: &EnvironmentSession,
	request: proto::CopyPathRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CopyPathResponse> {
	let source = parse_file_uri(&request.source_uri)?;
	let destination = parse_file_uri(&request.destination_uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&destination])?;
	let follow = parse_follow(request.follow_source_symlinks)?;
	let overwrite = parse_overwrite(request.overwrite, false)?;
	let revision = request
		.destination_revision
		.map(parse_revision)
		.transpose()?;
	let copied = completed_path_result(
		session
			.environment()
			.paths()
			.copy(&source, &destination, follow, overwrite, revision, &cancellation)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::CopyPathResponse {
		metadata:     Some(metadata_to_proto(session, &copied.metadata)?),
		bytes_copied: copied.bytes_copied,
	})
}

fn read_link(
	session: &EnvironmentSession,
	request: proto::ReadLinkRequest,
) -> DispatchResult<proto::ReadLinkResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let target = session
		.environment()
		.paths()
		.read_link(&uri)
		.map_err(Failure::from_core)?;
	Ok(proto::ReadLinkResponse { target: Some(symlink_target_to_proto(session, &target)?) })
}

async fn create_symlink(
	session: &EnvironmentSession,
	request: proto::CreateSymlinkRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CreateSymlinkResponse> {
	let target = parse_symlink_target(session, required(request.target, "symlink target")?)?;
	let link = parse_file_uri(&request.link_uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&link])?;
	let kind = match proto::SymlinkTargetKind::try_from(request.target_kind)
		.map_err(|_| Failure::invalid("unknown symlink target kind"))?
	{
		proto::SymlinkTargetKind::Unspecified => {
			return Err(Failure::invalid("symlink target kind is required"));
		},
		proto::SymlinkTargetKind::File => SymlinkTargetKind::File,
		proto::SymlinkTargetKind::Directory => SymlinkTargetKind::Directory,
	};
	let overwrite = parse_overwrite(request.overwrite, false)?;
	let metadata = completed_path_result(
		session
			.environment()
			.paths()
			.create_symlink(&target, &link, kind, overwrite, &cancellation)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::CreateSymlinkResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

async fn create_hard_link(
	session: &EnvironmentSession,
	request: proto::CreateHardLinkRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::CreateHardLinkResponse> {
	let source = parse_file_uri(&request.source_uri)?;
	let link = parse_file_uri(&request.link_uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&source, &link])?;
	let follow = parse_follow(request.follow_source_symlinks)?;
	let overwrite = parse_overwrite(request.overwrite, false)?;
	let metadata = completed_path_result(
		session
			.environment()
			.paths()
			.create_hard_link(&source, &link, follow, overwrite, &cancellation)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::CreateHardLinkResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

async fn set_permissions(
	session: &EnvironmentSession,
	request: proto::SetPermissionsRequest,
	cancellation: CancellationToken,
) -> DispatchResult<proto::SetPermissionsResponse> {
	let uri = parse_file_uri(&request.uri)?;
	let _workspace_mutation = begin_workspace_mutation(session, [&uri])?;
	let permissions = required(request.permissions, "portable permissions")?;
	if permissions.read_only.is_none() && permissions.executable.is_none() {
		return Err(Failure::invalid("at least one portable permission is required"));
	}
	let follow = parse_follow(request.follow_symlinks)?;
	let revision = request.revision.map(parse_revision).transpose()?;
	let metadata = completed_path_result(
		session
			.environment()
			.paths()
			.set_permissions(
				&uri,
				PortablePermissions {
					read_only:  permissions.read_only,
					executable: permissions.executable,
				},
				follow,
				revision,
				&cancellation,
			)
			.await
			.map_err(Failure::from_core)?,
	)?;
	Ok(proto::SetPermissionsResponse { metadata: Some(metadata_to_proto(session, &metadata)?) })
}

fn begin_workspace_mutation<'a>(
	session: &EnvironmentSession,
	uris: impl IntoIterator<Item = &'a Url>,
) -> DispatchResult<WorkspaceMutationGuard> {
	let paths = uris
		.into_iter()
		.map(|uri| session.environment().store().resolve_entry_path(uri))
		.collect::<Result<Vec<_>, _>>()
		.map_err(Failure::from_core)?;
	session
		.environment()
		.paths()
		.begin_workspace_mutation(session.owner(), paths)
		.map_err(Failure::from_core)
}

fn check_workspace_uris<'a>(
	session: &EnvironmentSession,
	uris: impl IntoIterator<Item = &'a Url>,
) -> DispatchResult<()> {
	let paths = uris
		.into_iter()
		.map(|uri| session.environment().store().resolve_entry_path(uri))
		.collect::<Result<Vec<_>, _>>()
		.map_err(Failure::from_core)?;
	session
		.check_workspace_paths(paths)
		.map_err(Failure::from_core)
}

fn completed_path_result<T>(result: PathMutationResult<T>) -> DispatchResult<T> {
	match result {
		PathMutationResult::Completed(value) => Ok(value),
		PathMutationResult::TransactionRejected(outcome) => Err(path_rejection(outcome.as_ref())),
	}
}

fn path_rejection(outcome: &TransactionOutcome) -> Failure {
	match outcome {
		TransactionOutcome::Rejected { reason, message, .. } => Failure::new(
			transaction_reject_code(*reason),
			format!("path transaction rejected ({reason:?}): {message}"),
		),
		TransactionOutcome::PartiallyCommitted {
			failed_operation_index, reason, message, ..
		} => Failure::internal(format!(
			"path transaction partially committed before operation {failed_operation_index} \
			 ({reason:?}): {message}"
		)),
		TransactionOutcome::Committed { .. } => {
			Failure::internal("path transaction did not return its expected operation result")
		},
	}
}

const fn transaction_reject_code(reason: TransactionRejectReason) -> proto::ProtocolErrorCode {
	match reason {
		TransactionRejectReason::StaleBase
		| TransactionRejectReason::OverlappingChange
		| TransactionRejectReason::ExternalModification => proto::ProtocolErrorCode::ContentModified,
		TransactionRejectReason::RevisionExpired => proto::ProtocolErrorCode::RevisionExpired,
		TransactionRejectReason::InvalidContent => proto::ProtocolErrorCode::InvalidArgument,
		TransactionRejectReason::FormatFailed => proto::ProtocolErrorCode::Internal,
		TransactionRejectReason::PersistFailed => proto::ProtocolErrorCode::Io,
		TransactionRejectReason::PreconditionFailed => proto::ProtocolErrorCode::PreconditionFailed,
		TransactionRejectReason::Cancelled => proto::ProtocolErrorCode::Cancelled,
	}
}

fn parse_target(target: proto::DocumentTarget) -> DispatchResult<DocumentTarget> {
	match required(target.target, "document target")? {
		document_target::Target::DocumentId(bytes) => {
			Ok(DocumentTarget::Document(parse_document_id(&bytes)?))
		},
		document_target::Target::LeaseId(bytes) => Ok(DocumentTarget::Lease(parse_lease_id(&bytes)?)),
		document_target::Target::Uri(uri) => Ok(DocumentTarget::Uri(parse_file_uri(&uri)?)),
	}
}

fn locator_for_target(
	session: &EnvironmentSession,
	target: &DocumentTarget,
) -> DispatchResult<DocumentLocator> {
	match target {
		DocumentTarget::Document(id) => Ok(DocumentLocator::Document(*id)),
		DocumentTarget::Lease(id) if session.owns_lease(*id) => Ok(DocumentLocator::Lease(*id)),
		DocumentTarget::Lease(_) => {
			Err(Failure::not_found("document lease is not owned by this connection"))
		},
		DocumentTarget::Uri(uri) => session
			.environment()
			.store()
			.resolve_entry_path(uri)
			.map(DocumentLocator::Path)
			.map_err(Failure::from_core),
	}
}

async fn canonical_path_for_locator(
	session: &EnvironmentSession,
	locator: DocumentLocator,
	cancellation: &CancellationToken,
) -> DispatchResult<PathBuf> {
	let handle = session
		.environment()
		.store()
		.actor_handle(locator)
		.map_err(Failure::from_core)?;
	tokio::select! {
		biased;
		() = cancellation.cancelled() => Err(Failure::cancelled("request cancelled")),
		state = handle.state() => Ok(state.map_err(Failure::from_core)?.path),
	}
}

async fn validate_text_document_uri(
	session: &EnvironmentSession,
	lease_id: LeaseId,
	params_json: &Bytes,
	cancellation: &CancellationToken,
) -> DispatchResult<()> {
	let value: serde_json::Value = serde_json::from_slice(params_json)
		.map_err(|error| Failure::invalid(format!("invalid LSP params JSON: {error}")))?;
	let supplied = value
		.pointer("/textDocument/uri")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| Failure::invalid("textDocument.uri is required for textDocument requests"))?;
	let path =
		canonical_path_for_locator(session, DocumentLocator::Lease(lease_id), cancellation).await?;
	let canonical = session
		.environment()
		.store()
		.file_uri(&path)
		.map_err(Failure::from_core)?;
	if supplied != canonical.as_str() {
		return Err(Failure::precondition(
			"textDocument.uri does not match the synchronized document lease URI",
		));
	}
	Ok(())
}

fn inbound_event_is_document_scoped(method: &str, params_json: &Bytes) -> bool {
	if method.starts_with("textDocument/") {
		return true;
	}
	serde_json::from_slice::<serde_json::Value>(params_json).is_ok_and(|value| {
		value
			.pointer("/textDocument/uri")
			.and_then(serde_json::Value::as_str)
			.is_some()
			|| value
				.get("uri")
				.and_then(serde_json::Value::as_str)
				.is_some()
	})
}
fn inbound_event_is_resolved(
	method: &str,
	params_json: &Bytes,
	has_document: bool,
	has_revision: bool,
) -> bool {
	!inbound_event_is_document_scoped(method, params_json) || (has_document && has_revision)
}

async fn connection_lease_for_target(
	session: &EnvironmentSession,
	target: &DocumentTarget,
	cancellation: &CancellationToken,
) -> DispatchResult<LeaseId> {
	let locator = locator_for_target(session, target)?;
	let handle = session
		.environment()
		.store()
		.actor_handle(locator)
		.map_err(Failure::from_core)?;
	let state = tokio::select! {
		biased;
		() = cancellation.cancelled() => {
			return Err(Failure::cancelled("document lease lookup cancelled"));
		},
		state = handle.state() => state.map_err(Failure::from_core)?,
	};
	session
		.lease_for_document(state.document_id)
		.ok_or_else(|| Failure::precondition("document has no lease owned by this connection"))
}

fn parse_read_selection(selection: proto::ReadSelection) -> DispatchResult<ReadSelection> {
	match required(selection.selection, "read selection kind")? {
		read_selection::Selection::Whole(_) => Ok(ReadSelection::Whole),
		read_selection::Selection::Bytes(bytes) => Ok(ReadSelection::Bytes(
			bytes
				.ranges
				.into_iter()
				.map(|range| ByteRange::new(range.start, range.end).map_err(Failure::from_core))
				.collect::<DispatchResult<_>>()?,
		)),
		read_selection::Selection::Lines(lines) => Ok(ReadSelection::Lines(
			lines
				.ranges
				.into_iter()
				.map(|range| LineRange::new(range.start, range.end).map_err(Failure::from_core))
				.collect::<DispatchResult<_>>()?,
		)),
	}
}

fn parse_summary_options(options: proto::CodeSummaryOptions) -> DispatchResult<SummaryOptions> {
	let render_mode = match proto::SummaryRenderMode::try_from(options.render_mode)
		.map_err(|_| Failure::invalid("unknown summary render mode"))?
	{
		proto::SummaryRenderMode::Unspecified => {
			return Err(Failure::invalid("summary render mode is required"));
		},
		proto::SummaryRenderMode::Hashline => SummaryRenderMode::Hashline,
		proto::SummaryRenderMode::Numbered => SummaryRenderMode::Numbered,
		proto::SummaryRenderMode::Plain => SummaryRenderMode::Plain,
	};
	Ok(SummaryOptions {
		min_total_lines: options.min_total_lines,
		min_body_lines: options.min_body_lines,
		min_comment_lines: options.min_comment_lines,
		unfold_until_lines: options.unfold_until_lines,
		unfold_limit_lines: options.unfold_limit_lines,
		enable_prose: options.enable_prose,
		language: (!options.language.is_empty()).then(|| Str::new(options.language)),
		render_mode,
	})
}

fn summary_to_proto(summary: &DocumentSummary) -> proto::DocumentSummaryResult {
	proto::DocumentSummaryResult {
		language:    summary.language.to_string(),
		parsed:      true,
		elided:      true,
		total_lines: summary.total_lines,
		segments:    summary
			.segments
			.iter()
			.map(|segment| match segment {
				SummarySegment::Kept { start_line, end_line, text } => proto::DocumentSummarySegment {
					kind:       document_summary_segment::Kind::Kept as i32,
					start_line: *start_line,
					end_line:   *end_line,
					text:       Some(text.clone()),
				},
				SummarySegment::Elided { start_line, end_line } => proto::DocumentSummarySegment {
					kind:       document_summary_segment::Kind::Elided as i32,
					start_line: *start_line,
					end_line:   *end_line,
					text:       None,
				},
			})
			.collect(),
		rendered:    Some(proto::RenderedDocumentSummary {
			text:          summary.rendered.text.clone(),
			display_text:  summary.rendered.display_text.clone(),
			elided_ranges: summary
				.rendered
				.elided_ranges
				.iter()
				.map(|range| proto::SummaryLineRange {
					start_line: range.start_line,
					end_line:   range.end_line,
				})
				.collect(),
			elided_lines:  summary.rendered.elided_lines,
		}),
	}
}

fn fallback_to_proto(fallback: &SummaryFallback) -> proto::DocumentSummaryUnavailable {
	proto::DocumentSummaryUnavailable {
		reason:      match fallback.reason {
			SummaryUnavailableReason::Binary => proto::SummaryUnavailableReason::Binary,
			SummaryUnavailableReason::MissingDocument => {
				proto::SummaryUnavailableReason::MissingDocument
			},
			SummaryUnavailableReason::TooLarge => proto::SummaryUnavailableReason::TooLarge,
			SummaryUnavailableReason::TooManyLines => proto::SummaryUnavailableReason::TooManyLines,
			SummaryUnavailableReason::BelowMinimumLines => {
				proto::SummaryUnavailableReason::BelowMinimumLines
			},
			SummaryUnavailableReason::ProseDisabled => proto::SummaryUnavailableReason::ProseDisabled,
			SummaryUnavailableReason::UnsupportedLanguage => {
				proto::SummaryUnavailableReason::UnsupportedLanguage
			},
			SummaryUnavailableReason::Empty => proto::SummaryUnavailableReason::Empty,
			SummaryUnavailableReason::SyntaxError => proto::SummaryUnavailableReason::SyntaxError,
			SummaryUnavailableReason::NoElisions => proto::SummaryUnavailableReason::NoElisions,
			SummaryUnavailableReason::ParserFailure => proto::SummaryUnavailableReason::ParserFailure,
		} as i32,
		total_lines: fallback.total_lines,
		language:    fallback
			.language
			.as_ref()
			.map_or_else(String::new, ToString::to_string),
		parsed:      fallback.parsed,
	}
}

async fn enrich_transaction_diagnostics(
	session: &EnvironmentSession,
	outcome: &TransactionOutcome,
	response: &mut proto::CommitTransactionResponse,
) {
	let operations = match outcome {
		TransactionOutcome::Committed { operations, .. } => operations.as_slice(),
		TransactionOutcome::PartiallyCommitted { committed_operations, .. } => {
			committed_operations.as_slice()
		},
		TransactionOutcome::Rejected { .. } => return,
	};
	let response_operations = match response.outcome.as_mut() {
		Some(commit_transaction_response::Outcome::Committed(committed)) => &mut committed.operations,
		Some(commit_transaction_response::Outcome::PartiallyCommitted(partial)) => {
			&mut partial.committed_operations
		},
		_ => return,
	};
	let deadline = Instant::now() + Duration::from_millis(500);
	let mut pending = operations
		.iter()
		.map(|operation| operation.operation_index())
		.collect::<HashSet<_>>();
	while !pending.is_empty() {
		for operation in operations {
			if !pending.contains(&operation.operation_index()) {
				continue;
			}
			let events = session.environment().lsp().drain_diagnostics_for_revision(
				operation.head().document_id(),
				operation.head().revision(),
				true,
			);
			if events.is_empty() {
				continue;
			}
			let mut diagnostics = Vec::new();
			let mut encodings = Vec::new();
			for event in events {
				let encoding = session
					.environment()
					.lsp()
					.diagnostic_position_encoding(&event);
				if let Ok((_, _, batch)) = parse_push(event.params_json(), event.binding_name()) {
					encodings.extend(
						batch
							.iter()
							.map(|diagnostic| (diagnostic.source.clone(), diagnostic.range, encoding)),
					);
					diagnostics.extend(batch);
				}
			}
			let diagnostics = normalize(diagnostics);
			let diagnostics = session
				.environment()
				.lsp()
				.diagnostic_delta(Str::from(operation.uri().as_str()), diagnostics, true)
				.changed;
			let content = session
				.environment()
				.store()
				.read(
					DocumentLocator::Document(operation.head().document_id()),
					Some(operation.head().revision()),
					ReadSelection::Whole,
				)
				.await
				.ok()
				.and_then(|read| match read.body() {
					ReadBody::Whole(content) => Some(content.clone()),
					ReadBody::Slices(_) => None,
				});
			if let Some(result) = response_operations
				.iter_mut()
				.find(|result| result.operation_index == operation.operation_index())
				&& let Some(batch) = result.diagnostics.as_mut()
			{
				batch.diagnostics = diagnostics
					.into_iter()
					.take(50)
					.map(|diagnostic| {
						let encoding = encodings
							.iter()
							.find(|(source, range, _)| {
								diagnostic.source.contains(source.as_str()) && *range == diagnostic.range
							})
							.map(|(_, _, encoding)| *encoding)
							.unwrap_or_default();
						proto::CommittedDiagnostic {
							range:    content.as_ref().and_then(|content| {
								diagnostic_byte_range(content, diagnostic.range, encoding)
							}),
							severity: match diagnostic.severity {
								Severity::Error => proto::DiagnosticSeverity::Error,
								Severity::Warning => proto::DiagnosticSeverity::Warning,
								Severity::Information => proto::DiagnosticSeverity::Information,
								Severity::Hint => proto::DiagnosticSeverity::Hint,
							} as i32,
							code:     diagnostic.code.unwrap_or_default().into(),
							source:   diagnostic.source.into(),
							message:  diagnostic.message.into(),
						}
					})
					.collect();
				batch.omitted = 0;
				batch.complete = true;
			}
			pending.remove(&operation.operation_index());
		}
		if pending.is_empty() || Instant::now() >= deadline {
			break;
		}
		time::sleep(Duration::from_millis(25)).await;
	}
	for result in response_operations {
		if pending.contains(&result.operation_index)
			&& let Some(batch) = result.diagnostics.as_mut()
		{
			batch.complete = false;
		}
	}
}

fn diagnostic_byte_range(
	content: &[u8],
	range: Range,
	encoding: PositionEncoding,
) -> Option<proto::ByteRange> {
	let text = str::from_utf8(content).ok()?;
	let start = position_to_offset(encoding, text, range.start)
		.ok()
		.and_then(|offset| u64::try_from(offset).ok())?;
	let end = position_to_offset(encoding, text, range.end)
		.ok()
		.and_then(|offset| u64::try_from(offset).ok())?;
	(start <= end).then_some(proto::ByteRange { start, end })
}

fn transaction_outcome_to_proto(outcome: &TransactionOutcome) -> proto::CommitTransactionResponse {
	let outcome = match outcome {
		TransactionOutcome::Committed { transaction_id, operations } => {
			commit_transaction_response::Outcome::Committed(proto::TransactionCommitted {
				transaction_id: Bytes::copy_from_slice(transaction_id.as_bytes()),
				operations:     operation_results_to_proto(operations),
			})
		},
		TransactionOutcome::Rejected { transaction_id, reason, message, conflicts } => {
			let converted = conflicts
				.iter()
				.map(|conflict| proto::DocumentConflict {
					operation_index:    conflict.operation_index(),
					expected:           Some(revision_to_proto(conflict.expected())),
					current:            Some(head_at_uri_to_proto(conflict.current(), conflict.uri())),
					conflicting_ranges: conflict
						.conflicting_ranges()
						.iter()
						.copied()
						.map(range_to_proto)
						.collect(),
				})
				.collect();
			commit_transaction_response::Outcome::Rejected(proto::TransactionRejected {
				transaction_id: Bytes::copy_from_slice(transaction_id.as_bytes()),
				reason:         reject_reason_to_proto(*reason) as i32,
				message:        message.to_string(),
				conflicts:      converted,
			})
		},
		TransactionOutcome::PartiallyCommitted {
			transaction_id,
			committed_operations,
			failed_operation_index,
			reason,
			message,
		} => commit_transaction_response::Outcome::PartiallyCommitted(
			proto::TransactionPartiallyCommitted {
				transaction_id:         Bytes::copy_from_slice(transaction_id.as_bytes()),
				committed_operations:   operation_results_to_proto(committed_operations),
				failed_operation_index: *failed_operation_index,
				reason:                 reject_reason_to_proto(*reason) as i32,
				message:                message.to_string(),
			},
		),
	};
	proto::CommitTransactionResponse { outcome: Some(outcome) }
}

fn operation_results_to_proto(operations: &[OperationResult]) -> Vec<proto::OperationResult> {
	operations
		.iter()
		.map(|operation| proto::OperationResult {
			operation_index: operation.operation_index(),
			head:            Some(head_at_uri_to_proto(operation.head(), operation.uri())),
			rebased:         operation.rebased(),
			formatted:       operation.formatted(),
			changed_ranges:  operation
				.changed_ranges()
				.iter()
				.copied()
				.map(range_to_proto)
				.collect(),
			previous_uri:    operation
				.previous_uri()
				.map_or_else(String::new, Url::to_string),
			diagnostics:     Some(proto::CommittedDiagnosticBatch {
				document:           Some(proto::DocumentRef {
					id:  Bytes::copy_from_slice(operation.head().document_id().as_bytes()),
					uri: operation.uri().to_string(),
				}),
				committed_revision: Some(revision_to_proto(operation.head().revision())),
				diagnostics:        Vec::new(),
				complete:           true,
				omitted:            0,
			}),
			format_drift:    Some(proto::ClientFormatDrift {
				submitted_revision:                Some(revision_to_proto(
					operation.submitted_revision(),
				)),
				committed_revision:                Some(revision_to_proto(operation.head().revision())),
				client_formatted:                  false,
				server_formatted:                  operation.formatted(),
				bytes_changed_after_client_format: false,
				committed_content_hash:            Bytes::copy_from_slice(
					operation.head().revision().content_hash(),
				),
			}),
		})
		.collect()
}

const fn reject_reason_to_proto(reason: TransactionRejectReason) -> proto::TransactionRejectReason {
	match reason {
		TransactionRejectReason::StaleBase => proto::TransactionRejectReason::StaleBase,
		TransactionRejectReason::OverlappingChange => {
			proto::TransactionRejectReason::OverlappingChange
		},
		TransactionRejectReason::ExternalModification => {
			proto::TransactionRejectReason::ExternalModification
		},
		TransactionRejectReason::RevisionExpired => proto::TransactionRejectReason::RevisionExpired,
		TransactionRejectReason::InvalidContent => proto::TransactionRejectReason::InvalidContent,
		TransactionRejectReason::FormatFailed => proto::TransactionRejectReason::FormatFailed,
		TransactionRejectReason::PersistFailed => proto::TransactionRejectReason::PersistFailed,
		TransactionRejectReason::PreconditionFailed => {
			proto::TransactionRejectReason::PreconditionFailed
		},
		TransactionRejectReason::Cancelled => proto::TransactionRejectReason::Cancelled,
	}
}

async fn document_ref_to_proto(
	session: &EnvironmentSession,
	document_id: DocumentId,
) -> Option<proto::DocumentRef> {
	let state = session
		.environment()
		.store()
		.actor_handle(document_id)
		.ok()?
		.state()
		.await
		.ok()?;
	let uri = session.environment().store().file_uri(&state.path).ok()?;
	Some(proto::DocumentRef {
		id:  Bytes::copy_from_slice(document_id.as_bytes()),
		uri: uri.to_string(),
	})
}

async fn head_to_proto(
	session: &EnvironmentSession,
	head: &DocumentHead,
	cancellation: &CancellationToken,
) -> DispatchResult<proto::DocumentHead> {
	let handle = session
		.environment()
		.store()
		.actor_handle(head.document_id())
		.map_err(Failure::from_core)?;
	let state = tokio::select! {
		biased;
		() = cancellation.cancelled() => return Err(Failure::cancelled("request cancelled")),
		state = handle.state() => state.map_err(Failure::from_core)?,
	};
	let uri = session
		.environment()
		.store()
		.file_uri(&state.path)
		.map_err(Failure::from_core)?;
	Ok(head_at_uri_to_proto(head, &uri))
}

fn head_at_uri_to_proto(head: &DocumentHead, uri: &Url) -> proto::DocumentHead {
	let (kind, language_id) = match head.kind() {
		DocumentKind::Text(language) => (
			proto::DocumentKind::Text,
			language
				.as_ref()
				.map_or_else(String::new, |language| language.as_str().to_owned()),
		),
		DocumentKind::Binary => (proto::DocumentKind::Binary, String::new()),
	};
	proto::DocumentHead {
		document: Some(proto::DocumentRef {
			id:  Bytes::copy_from_slice(head.document_id().as_bytes()),
			uri: uri.to_string(),
		}),
		revision: Some(revision_to_proto(head.revision())),
		presence: match head.presence() {
			DocumentPresence::Present => proto::DocumentPresence::Present,
			DocumentPresence::Missing => proto::DocumentPresence::Missing,
		} as i32,
		kind: kind as i32,
		byte_length: head.byte_length(),
		language_id,
	}
}

fn document_event_to_proto(
	session: &EnvironmentSession,
	event: &DocumentEvent,
) -> DispatchResult<proto::DocumentEvent> {
	let previous_uri = match event.previous_path() {
		Some(path) => session
			.environment()
			.store()
			.file_uri(path)
			.map_err(Failure::from_core)?
			.to_string(),
		None => String::new(),
	};
	let uri = session
		.environment()
		.store()
		.file_uri(event.path())
		.map_err(Failure::from_core)?;
	Ok(proto::DocumentEvent {
		event_sequence: event.event_sequence(),
		kind: match event.kind() {
			DocumentEventKind::Committed => proto::DocumentEventKind::Committed,
			DocumentEventKind::ExternalCreated => proto::DocumentEventKind::ExternalCreated,
			DocumentEventKind::ExternalModified => proto::DocumentEventKind::ExternalModified,
			DocumentEventKind::ExternalDeleted => proto::DocumentEventKind::ExternalDeleted,
			DocumentEventKind::ExternalRenamed => proto::DocumentEventKind::ExternalRenamed,
			DocumentEventKind::WatchRescanned => proto::DocumentEventKind::WatchRescanned,
		} as i32,
		head: Some(head_at_uri_to_proto(event.head(), &uri)),
		previous_revision: Some(revision_to_proto(event.previous_revision())),
		transaction_id: event
			.transaction_id()
			.map_or_else(Bytes::new, |id| Bytes::copy_from_slice(id.as_bytes())),
		invalidated_transaction_ids: event
			.invalidated_transaction_ids()
			.iter()
			.map(|id| Bytes::copy_from_slice(id.as_bytes()))
			.collect(),
		previous_uri,
	})
}

fn binding_to_proto(binding: &LspLeaseBinding) -> proto::LspServerBinding {
	let policy = binding.sync_policy();
	proto::LspServerBinding {
		server_id:         binding_id_bytes(binding.info().id()),
		name:              binding.info().spec().name().to_owned(),
		sync_policy:       Some(proto::SyncPolicy {
			change:               match policy.change {
				TextDocumentSyncKind::None => proto::TextDocumentSyncKind::TextDocumentSyncNone,
				TextDocumentSyncKind::Full => proto::TextDocumentSyncKind::TextDocumentSyncFull,
				TextDocumentSyncKind::Incremental => {
					proto::TextDocumentSyncKind::TextDocumentSyncIncremental
				},
			} as i32,
			open_close:           policy.open_close,
			will_save:            policy.will_save,
			will_save_wait_until: policy.will_save_wait_until,
			save:                 policy.save,
			save_include_text:    policy.save_include_text,
			position_encoding:    policy.position_encoding.as_lsp_name().to_owned(),
		}),
		capabilities_json: binding.capabilities_json().clone(),
		settings_json:     binding.info().spec().settings_json().clone(),
	}
}

fn metadata_to_proto(
	session: &EnvironmentSession,
	metadata: &PathMetadata,
) -> DispatchResult<proto::PathMetadata> {
	let uri = session
		.environment()
		.store()
		.file_uri(&metadata.path)
		.map_err(Failure::from_core)?;
	Ok(proto::PathMetadata {
		uri: uri.to_string(),
		kind: match metadata.kind {
			FileKind::RegularFile => proto::FileKind::RegularFile,
			FileKind::Directory => proto::FileKind::Directory,
			FileKind::SymbolicLink => proto::FileKind::SymbolicLink,
			FileKind::Other => proto::FileKind::Other,
		} as i32,
		byte_length: metadata.byte_length,
		permissions: Some(proto::PortablePermissions {
			read_only:  metadata.permissions.read_only,
			executable: metadata.permissions.executable,
		}),
		modified_time_unix_nanos: metadata.modified.map(system_time_to_nanos).transpose()?,
		accessed_time_unix_nanos: metadata.accessed.map(system_time_to_nanos).transpose()?,
		created_time_unix_nanos: metadata.created.map(system_time_to_nanos).transpose()?,
	})
}

fn parse_symlink_target(
	session: &EnvironmentSession,
	target: proto::SymlinkTarget,
) -> DispatchResult<SymlinkTarget> {
	let uri = parse_file_uri(&target.uri)?;
	let path = session
		.environment()
		.store()
		.resolve_entry_path(&uri)
		.map_err(Failure::from_core)?;
	let form = match proto::SymlinkTargetForm::try_from(target.form)
		.map_err(|_| Failure::invalid("unknown symlink target form"))?
	{
		proto::SymlinkTargetForm::Absolute => SymlinkTargetForm::Absolute,
		proto::SymlinkTargetForm::Relative => SymlinkTargetForm::Relative,
	};
	Ok(SymlinkTarget { path, form })
}

fn symlink_target_to_proto(
	session: &EnvironmentSession,
	target: &SymlinkTarget,
) -> DispatchResult<proto::SymlinkTarget> {
	let uri = session
		.environment()
		.store()
		.file_uri(&target.path)
		.map_err(Failure::from_core)?;
	Ok(proto::SymlinkTarget {
		uri:  uri.to_string(),
		form: match target.form {
			SymlinkTargetForm::Absolute => proto::SymlinkTargetForm::Absolute,
			SymlinkTargetForm::Relative => proto::SymlinkTargetForm::Relative,
		} as i32,
	})
}

fn parse_follow(value: i32) -> DispatchResult<FollowSymlinks> {
	match proto::FollowSymlinks::try_from(value)
		.map_err(|_| Failure::invalid("unknown follow-symlinks policy"))?
	{
		proto::FollowSymlinks::No => Ok(FollowSymlinks::No),
		proto::FollowSymlinks::Yes => Ok(FollowSymlinks::Yes),
	}
}

fn parse_overwrite(
	value: i32,
	allow_empty_directory: bool,
) -> DispatchResult<DestinationOverwritePolicy> {
	match proto::DestinationOverwritePolicy::try_from(value)
		.map_err(|_| Failure::invalid("unknown destination overwrite policy"))?
	{
		proto::DestinationOverwritePolicy::FailIfExists => {
			Ok(DestinationOverwritePolicy::FailIfExists)
		},
		proto::DestinationOverwritePolicy::ReplaceNonDirectory => {
			Ok(DestinationOverwritePolicy::ReplaceNonDirectory)
		},
		proto::DestinationOverwritePolicy::ReplaceEmptyDirectory if allow_empty_directory => {
			Ok(DestinationOverwritePolicy::ReplaceEmptyDirectory)
		},
		proto::DestinationOverwritePolicy::ReplaceEmptyDirectory => {
			Err(Failure::invalid("replace-empty-directory is valid only for rename"))
		},
	}
}

fn parse_stale_policy(value: i32) -> DispatchResult<StalePolicy> {
	match proto::StalePolicy::try_from(value)
		.map_err(|_| Failure::invalid("unknown stale policy"))?
	{
		proto::StalePolicy::Fail => Ok(StalePolicy::Fail),
		proto::StalePolicy::RebaseNonOverlapping => Ok(StalePolicy::RebaseNonOverlapping),
		proto::StalePolicy::ForceReplace => Ok(StalePolicy::ForceReplace),
	}
}

fn parse_format_policy(value: i32) -> DispatchResult<FormatPolicy> {
	match proto::FormatPolicy::try_from(value)
		.map_err(|_| Failure::invalid("unknown format policy"))?
	{
		proto::FormatPolicy::Disabled => Ok(FormatPolicy::Disabled),
		proto::FormatPolicy::BestEffort => Ok(FormatPolicy::BestEffort),
		proto::FormatPolicy::Required => Ok(FormatPolicy::Required),
	}
}

fn parse_revision(revision: proto::Revision) -> DispatchResult<Revision> {
	let hash = exact_array::<32>(&revision.content_hash, "revision content hash")?;
	Ok(Revision::from_hash(revision.sequence, hash))
}

fn revision_to_proto(revision: Revision) -> proto::Revision {
	proto::Revision {
		sequence:     revision.sequence(),
		content_hash: Bytes::copy_from_slice(revision.content_hash()),
	}
}

const fn range_to_proto(range: ByteRange) -> proto::ByteRange {
	proto::ByteRange { start: range.start(), end: range.end() }
}

fn parse_document_id(bytes: &[u8]) -> DispatchResult<DocumentId> {
	Ok(DocumentId::from_bytes(exact_array(bytes, "document id")?))
}

fn parse_lease_id(bytes: &[u8]) -> DispatchResult<LeaseId> {
	Ok(LeaseId::from_bytes(exact_array(bytes, "lease id")?))
}

fn parse_transaction_id(bytes: &[u8]) -> DispatchResult<TransactionId> {
	Ok(TransactionId::from_bytes(exact_array(bytes, "transaction id")?))
}

fn parse_binding_id(bytes: &[u8]) -> DispatchResult<LspBindingId> {
	Ok(LspBindingId::from_u64(u64::from_be_bytes(exact_array(bytes, "LSP server id")?)))
}

fn binding_id_bytes(binding_id: LspBindingId) -> Bytes {
	Bytes::copy_from_slice(&binding_id.get().to_be_bytes())
}

fn exact_array<const N: usize>(bytes: &[u8], name: &str) -> DispatchResult<[u8; N]> {
	bytes
		.try_into()
		.map_err(|_| Failure::invalid(format!("{name} must be exactly {N} bytes")))
}

fn parse_file_uri(value: &str) -> DispatchResult<Url> {
	if value.is_empty() {
		return Err(Failure::invalid("file URI must not be empty"));
	}
	let uri =
		Url::parse(value).map_err(|error| Failure::invalid(format!("invalid URI: {error}")))?;
	if uri.scheme() != "file" {
		return Err(Failure::invalid("URI scheme must be file"));
	}
	if uri.cannot_be_a_base() {
		return Err(Failure::invalid("file URI must be hierarchical"));
	}
	Ok(uri)
}

fn system_time_to_nanos(time: SystemTime) -> DispatchResult<i64> {
	let nanos = match time.duration_since(UNIX_EPOCH) {
		Ok(duration) => {
			i128::from(duration.as_secs()) * 1_000_000_000 + i128::from(duration.subsec_nanos())
		},
		Err(error) => {
			let duration = error.duration();
			-(i128::from(duration.as_secs()) * 1_000_000_000 + i128::from(duration.subsec_nanos()))
		},
	};
	i64::try_from(nanos)
		.map_err(|_| Failure::internal("filesystem timestamp exceeds protocol range"))
}

fn required<T>(value: Option<T>, name: &str) -> DispatchResult<T> {
	value.ok_or_else(|| Failure::invalid(format!("{name} is required")))
}

fn build_invalid(message: impl AsRef<str>) -> TransactionBuildError {
	TransactionBuildError::new(TransactionRejectReason::InvalidContent, message)
}

fn build_precondition(message: impl AsRef<str>) -> TransactionBuildError {
	TransactionBuildError::new(TransactionRejectReason::PreconditionFailed, message)
}

fn build_from_failure(error: Failure) -> TransactionBuildError {
	build_invalid(error.message)
}

fn build_cancelled(message: impl AsRef<str>) -> TransactionBuildError {
	TransactionBuildError::new(TransactionRejectReason::Cancelled, message)
}
fn build_snapshot_error(error: Error) -> TransactionBuildError {
	let reason = match &error {
		Error::RevisionExpired { .. } | Error::RevisionMissing { .. } => {
			TransactionRejectReason::RevisionExpired
		},
		Error::InvalidContent { .. } | Error::InvalidRange { .. } => {
			TransactionRejectReason::InvalidContent
		},
		Error::ContentModified { .. }
		| Error::StaleTransaction { .. }
		| Error::ConflictingTransaction { .. }
		| Error::ExternalInvalidation { .. }
		| Error::StaleDiskState { .. } => TransactionRejectReason::ExternalModification,
		_ => TransactionRejectReason::PreconditionFailed,
	};
	TransactionBuildError::new(reason, error.to_string())
}

type DispatchResult<T> = Result<T, Failure>;

#[derive(Debug)]
struct Failure {
	code:    proto::ProtocolErrorCode,
	message: String,
}

impl Failure {
	fn new(code: proto::ProtocolErrorCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	fn invalid(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::InvalidArgument, message)
	}

	fn not_found(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::NotFound, message)
	}

	fn precondition(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::PreconditionFailed, message)
	}

	fn cancelled(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::Cancelled, message)
	}

	fn internal(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::Internal, message)
	}

	fn resource(message: impl Into<String>) -> Self {
		Self::new(proto::ProtocolErrorCode::InvalidArgument, message)
	}

	fn from_dap(error: DapSessionError) -> Self {
		match error {
			DapSessionError::NotFound(_) => Self::not_found(error.to_string()),
			DapSessionError::UnsupportedAction(_) | DapSessionError::InvalidReverseRequest => {
				Self::invalid(error.to_string())
			},
			DapSessionError::InvalidTransition { .. }
			| DapSessionError::SessionTreeCycle
			| DapSessionError::MissingCapability { .. } => Self::precondition(error.to_string()),
			DapSessionError::Protocol(_) | DapSessionError::Process(_) => {
				Self::internal(error.to_string())
			},
		}
	}

	fn into_proto(self) -> proto::ProtocolError {
		proto::ProtocolError { code: self.code as i32, message: self.message }
	}

	fn from_core(error: Error) -> Self {
		let code = match &error {
			Error::PreconditionFailed { .. } => proto::ProtocolErrorCode::PreconditionFailed,
			Error::ContentModified { .. } => proto::ProtocolErrorCode::ContentModified,
			Error::InvalidTarget { .. }
			| Error::InvalidRange { .. }
			| Error::InvalidContent { .. } => proto::ProtocolErrorCode::InvalidArgument,
			Error::DocumentNotFound { .. } | Error::LeaseExpired { .. } => {
				proto::ProtocolErrorCode::NotFound
			},
			Error::RevisionMissing { .. } | Error::RevisionExpired { .. } => {
				proto::ProtocolErrorCode::RevisionExpired
			},
			Error::StaleTransaction { .. }
			| Error::ConflictingTransaction { .. }
			| Error::ExternalInvalidation { .. }
			| Error::StaleDiskState { .. } => proto::ProtocolErrorCode::ContentModified,
			Error::Watch { .. } => proto::ProtocolErrorCode::Io,
			Error::Persistence { source, .. } | Error::Io { source, .. }
				if source.kind() == io::ErrorKind::Interrupted =>
			{
				proto::ProtocolErrorCode::Cancelled
			},
			Error::Persistence { source, .. } | Error::Io { source, .. } => io_code(source.kind()),
			Error::Protocol { .. }
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
			| Error::HashlineRecovery { .. } => proto::ProtocolErrorCode::Internal,
		};
		Self::new(code, error.to_string())
	}

	fn from_registry(error: LspRegistryError) -> Self {
		match error {
			LspRegistryError::Store(error) => Self::from_core(error),
			LspRegistryError::Lsp(error) => Self::from_lsp(&error),
			error => {
				let code = match &error {
					LspRegistryError::InvalidBindingName
					| LspRegistryError::DuplicateBinding { .. }
					| LspRegistryError::InvalidSelector { .. }
					| LspRegistryError::InvalidInboundJson { .. } => proto::ProtocolErrorCode::InvalidArgument,
					LspRegistryError::UnknownBinding { .. } | LspRegistryError::UnknownLease { .. } => {
						proto::ProtocolErrorCode::NotFound
					},
					LspRegistryError::BindingBusy { .. }
					| LspRegistryError::BindingNotSelected { .. }
					| LspRegistryError::DocumentNotActivated { .. }
					| LspRegistryError::FormattingUnavailable => proto::ProtocolErrorCode::PreconditionFailed,
					LspRegistryError::ContentModified { .. }
					| LspRegistryError::BindingRestarted { .. } => proto::ProtocolErrorCode::ContentModified,
					LspRegistryError::PathCannotBeUri { .. }
					| LspRegistryError::BindingIdOverflow
					| LspRegistryError::BindingGenerationOverflow { .. }
					| LspRegistryError::WarmupTask { .. }
					| LspRegistryError::WarmupResultMissing
					| LspRegistryError::Store(_)
					| LspRegistryError::Lsp(_) => proto::ProtocolErrorCode::Internal,
				};
				Self::new(code, error.to_string())
			},
		}
	}

	fn from_lsp(error: &LspError) -> Self {
		let code = match error {
			LspError::Transport(LspTransportError::Cancelled) => proto::ProtocolErrorCode::Cancelled,
			LspError::Transport(
				LspTransportError::Closed { .. }
				| LspTransportError::Io { .. }
				| LspTransportError::Frame { .. },
			) => proto::ProtocolErrorCode::Io,
			LspError::Transport(LspTransportError::JsonRpc { .. }) => {
				proto::ProtocolErrorCode::Internal
			},
			LspError::Transport(
				LspTransportError::InvalidResponse { .. } | LspTransportError::InvalidJson { .. },
			)
			| LspError::InvalidCapabilities { .. }
			| LspError::InvalidRegistration { .. } => proto::ProtocolErrorCode::Internal,
			LspError::InvalidJson { .. } | LspError::Position(_) | LspError::InvalidUtf8 => {
				proto::ProtocolErrorCode::InvalidArgument
			},
			LspError::LifecyclePassthrough { .. } => proto::ProtocolErrorCode::InvalidArgument,
			LspError::CapabilityNotAdvertised { .. }
			| LspError::SynchronizationUnavailable { .. }
			| LspError::DocumentNotTracked { .. }
			| LspError::NonTextDocument { .. } => proto::ProtocolErrorCode::Unsupported,
			LspError::StateChanged { .. } | LspError::LanguageChanged { .. } => {
				proto::ProtocolErrorCode::ContentModified
			},
			LspError::LeaseOverflow { .. }
			| LspError::StateGenerationOverflow { .. }
			| LspError::VersionOverflow { .. } => proto::ProtocolErrorCode::Internal,
		};
		Self::new(code, error.to_string())
	}
}

const fn io_code(kind: io::ErrorKind) -> proto::ProtocolErrorCode {
	match kind {
		io::ErrorKind::NotFound => proto::ProtocolErrorCode::NotFound,
		io::ErrorKind::PermissionDenied => proto::ProtocolErrorCode::PermissionDenied,
		io::ErrorKind::AlreadyExists => proto::ProtocolErrorCode::AlreadyExists,
		io::ErrorKind::NotADirectory => proto::ProtocolErrorCode::NotADirectory,
		io::ErrorKind::IsADirectory => proto::ProtocolErrorCode::IsADirectory,
		io::ErrorKind::DirectoryNotEmpty => proto::ProtocolErrorCode::DirectoryNotEmpty,
		io::ErrorKind::CrossesDevices => proto::ProtocolErrorCode::CrossDevice,
		io::ErrorKind::Unsupported => proto::ProtocolErrorCode::Unsupported,
		io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
			proto::ProtocolErrorCode::InvalidArgument
		},
		_ => proto::ProtocolErrorCode::Io,
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use bytes::Bytes;
	use tempfile::TempDir;

	use super::*;
	use crate::docserver::{Environment, ServerConfig, fs::DiskExpectation};

	fn environment(root: &TempDir) -> Environment {
		Environment::new(ServerConfig::new(root.path()).expect("server config")).expect("environment")
	}

	fn create_file(environment: &Environment, name: &str, content: &'static [u8]) -> PathBuf {
		let path = environment.store().local_fs().root_path().join(name);
		let prepared = environment
			.store()
			.local_fs()
			.prepare_write(&path, Bytes::from_static(content), DiskExpectation::Missing)
			.expect("prepare file");
		environment
			.store()
			.local_fs()
			.commit_prepared(prepared)
			.expect("commit file");
		path
	}

	#[test]
	fn fixed_size_ids_reject_short_and_long_inputs() {
		assert_eq!(
			parse_document_id(&[0; 15]).unwrap_err().code,
			proto::ProtocolErrorCode::InvalidArgument
		);
		assert_eq!(
			parse_lease_id(&[0; 17]).unwrap_err().code,
			proto::ProtocolErrorCode::InvalidArgument
		);
		assert_eq!(
			parse_binding_id(&[0; 7]).unwrap_err().code,
			proto::ProtocolErrorCode::InvalidArgument
		);
	}

	#[test]
	fn revisions_require_an_exact_sha256_hash() {
		let malformed =
			proto::Revision { sequence: 9, content_hash: Bytes::from_static(&[1; 31]) };
		assert_eq!(
			parse_revision(malformed).unwrap_err().code,
			proto::ProtocolErrorCode::InvalidArgument
		);
	}

	#[test]
	fn binding_ids_are_exact_big_endian_values() {
		let encoded = Bytes::from_static(&[0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
		let id = parse_binding_id(&encoded).unwrap();
		assert_eq!(id.get(), 0x0123_4567_89ab_cdef);
		assert_eq!(binding_id_bytes(id), encoded);
	}
	#[test]
	fn lsp_binding_protocol_round_trip_preserves_settings_json() {
		for settings_json in [
			Bytes::from_static(br#"{"settings":{"typescript":{"inlayHints":true}}}"#),
			Bytes::from_static(br#"{"settings":{}}"#),
		] {
			let binding = proto::LspServerBinding {
				server_id: Bytes::from_static(b"12345678"),
				name: "server".to_owned(),
				settings_json: settings_json.clone(),
				..Default::default()
			};
			let decoded = proto::LspServerBinding::decode(binding.encode_to_vec().as_slice()).unwrap();
			assert_eq!(decoded.settings_json, settings_json);
		}
	}

	#[test]
	fn event_stream_failures_are_explicit_after_minor_one() {
		let lease_id = LeaseId::from_bytes([7; 16]);
		let frame =
			document_event_stream_error_frame(1, lease_id, DocumentEventStreamError::Lagged {
				skipped: 3,
			});
		let Some(server_frame::Body::EventStreamError(error)) = frame.body else {
			panic!("minor one must use the dedicated event stream error");
		};
		assert_eq!(error.stream(), proto::EventStreamKind::Document);
		assert_eq!(error.failure(), proto::EventStreamFailure::Lagged);
		assert_eq!(error.lease_id.as_ref(), lease_id.as_bytes());
		assert_eq!(error.skipped_events, 3);
	}

	#[test]
	fn event_stream_failures_remain_decodable_by_minor_zero() {
		let frame = document_event_stream_error_frame(
			0,
			LeaseId::from_bytes([7; 16]),
			DocumentEventStreamError::Lagged { skipped: 3 },
		);
		assert!(matches!(
			frame.body,
			Some(proto::server_frame::Body::Error(proto::ProtocolError {
				code,
				..
			})) if code == proto::ProtocolErrorCode::ContentModified as i32
		));
	}

	#[test]
	fn timestamps_preserve_the_pre_epoch_nanosecond_boundary() {
		let instant = UNIX_EPOCH - Duration::from_nanos(1);
		assert_eq!(system_time_to_nanos(instant).unwrap(), -1);
	}

	#[tokio::test]
	async fn lease_targets_are_connection_owned_before_lookup_or_building() {
		let root = tempfile::tempdir().expect("temporary root");
		let environment = environment(&root);
		let owner = environment.session();
		let other = environment.session();
		let lease_id = LeaseId::from_bytes([9; 16]);
		let document_id = DocumentId::from_bytes([3; 16]);
		owner.own_lease(lease_id, document_id, CancellationToken::new(), CancellationToken::new());
		let target = DocumentTarget::Lease(lease_id);

		assert_eq!(
			locator_for_target(&other, &target).unwrap_err().code,
			proto::ProtocolErrorCode::NotFound
		);
		let operation = proto::DocumentMutation {
			document:  Some(proto::DocumentTarget {
				target: Some(document_target::Target::LeaseId(Bytes::copy_from_slice(
					lease_id.as_bytes(),
				))),
			}),
			operation: Some(document_mutation::Operation::Create(proto::CreateMutation::default())),
		};
		let error = build_operations(other, vec![operation], CancellationToken::new())
			.await
			.expect_err("foreign lease must reject during operation building");
		assert_eq!(error.reason(), TransactionRejectReason::PreconditionFailed);
	}

	#[tokio::test]
	async fn text_document_requests_require_context_and_exact_lease_uri() {
		let root = tempfile::tempdir().expect("temporary root");
		let environment = environment(&root);
		let session = environment.session();
		let path = create_file(&environment, "document.txt", b"text\n");
		let opened = environment
			.store()
			.open(path.clone())
			.await
			.expect("open document");
		let (lease_id, head, _) = opened.into_parts();
		session.own_lease(
			lease_id,
			head.document_id(),
			CancellationToken::new(),
			CancellationToken::new(),
		);

		let omitted = lsp_request(
			&session,
			proto::LspRequest {
				server_id: Bytes::copy_from_slice(&1_u64.to_be_bytes()),
				method: "textDocument/hover".to_owned(),
				params_json: Bytes::from_static(br#"{"textDocument":{"uri":"file:///ignored"}}"#),
				..proto::LspRequest::default()
			},
			CancellationToken::new(),
		)
		.await
		.expect_err("text document context is required");
		assert_eq!(omitted.code, proto::ProtocolErrorCode::InvalidArgument);

		let mismatch = validate_text_document_uri(
			&session,
			lease_id,
			&Bytes::from_static(br#"{"textDocument":{"uri":"file:///different.txt"}}"#),
			&CancellationToken::new(),
		)
		.await
		.expect_err("mismatched URI must reject");
		assert_eq!(mismatch.code, proto::ProtocolErrorCode::PreconditionFailed);

		let canonical = environment.store().file_uri(&path).expect("canonical URI");
		let params = Bytes::from(
			serde_json::to_vec(&serde_json::json!({
				"textDocument": { "uri": canonical.as_str() }
			}))
			.expect("params JSON"),
		);
		validate_text_document_uri(&session, lease_id, &params, &CancellationToken::new())
			.await
			.expect("canonical URI must match");
	}

	#[test]
	fn unresolved_uri_scoped_inbound_events_are_filtered() {
		let diagnostics = Bytes::from_static(br#"{"uri":"file:///document.txt","diagnostics":[]}"#);
		assert!(!inbound_event_is_resolved(
			"textDocument/publishDiagnostics",
			&diagnostics,
			false,
			false,
		));
		assert!(!inbound_event_is_resolved(
			"textDocument/publishDiagnostics",
			&diagnostics,
			true,
			false,
		));
		assert!(inbound_event_is_resolved(
			"textDocument/publishDiagnostics",
			&diagnostics,
			true,
			true,
		));
		assert!(inbound_event_is_resolved(
			"workspace/configuration",
			&Bytes::from_static(br"{}"),
			false,
			false,
		));
	}

	#[tokio::test]
	async fn failed_close_still_releases_session_ownership() {
		let root = tempfile::tempdir().expect("temporary root");
		let session = environment(&root).session();
		let lease_id = LeaseId::from_bytes([7; 16]);
		session.own_lease(
			lease_id,
			DocumentId::from_bytes([8; 16]),
			CancellationToken::new(),
			CancellationToken::new(),
		);

		close_document(
			&session,
			proto::CloseDocumentRequest { lease_id: Bytes::copy_from_slice(lease_id.as_bytes()) },
			CancellationToken::new(),
		)
		.await
		.expect_err("unknown registry lease must fail");

		assert!(!session.owns_lease(lease_id));
	}

	#[tokio::test]
	async fn cleanup_deadline_cancels_and_awaits_cooperative_completion() {
		let cancellation = CancellationToken::new();
		let observed = cancellation.clone();
		let output = await_cooperative_cleanup(&cancellation, Duration::ZERO, async move {
			observed.cancelled().await;
			"cleaned"
		})
		.await;

		assert!(cancellation.is_cancelled());
		assert_eq!(output, "cleaned");
	}
}
