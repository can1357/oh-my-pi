//! Raw frame transports and deterministic client-side environment partitioning.

use std::sync::Arc;

use flume::{Receiver, Sender};
use omp_core::{FastHashMap, FastHashSet, Str};
use omp_proto::env::v1::{ClientFrame, ServerFrame, client_frame, data_request, server_frame};
use thiserror::Error;
use tokio::task::JoinHandle;

use crate::{ClientError, EnvClient, InProcessEnvTransport};

/// Client-side endpoints of a raw environment frame transport.
#[derive(Debug)]
pub struct FramePipe {
	outgoing: Sender<ClientFrame>,
	incoming: Receiver<ServerFrame>,
}

impl FramePipe {
	/// Creates a raw client frame pipe from transport-owned endpoints.
	#[must_use]
	pub const fn new(outgoing: Sender<ClientFrame>, incoming: Receiver<ServerFrame>) -> Self {
		Self { outgoing, incoming }
	}

	/// Returns the endpoint used to send client frames.
	#[must_use]
	pub const fn outgoing(&self) -> &Sender<ClientFrame> {
		&self.outgoing
	}

	/// Returns the endpoint used to receive server frames.
	#[must_use]
	pub const fn incoming(&self) -> &Receiver<ServerFrame> {
		&self.incoming
	}

	/// Splits the pipe into its client-frame sender and server-frame receiver.
	#[must_use]
	pub fn into_parts(self) -> (Sender<ClientFrame>, Receiver<ServerFrame>) {
		(self.outgoing, self.incoming)
	}
}

/// Creates paired raw client endpoints and an in-process server transport.
///
/// A capacity of zero selects unbounded channels. A nonzero capacity creates
/// bounded channels with backpressure in both directions.
#[must_use]
pub fn in_process_frames(capacity: usize) -> (FramePipe, InProcessEnvTransport) {
	let (outgoing, requests) = channel(capacity);
	let (responses, incoming) = channel(capacity);
	(FramePipe::new(outgoing, incoming), InProcessEnvTransport::from_parts(requests, responses))
}

/// A failure that terminates a partition router task.
#[derive(Debug, Error)]
pub enum PartitionError {
	/// The final client transport closed.
	#[error("partitioned environment client transport closed")]
	ClientClosed,
	/// A backend transport closed.
	#[error("{backend} environment backend transport closed")]
	BackendClosed {
		/// Stable backend name used for diagnostics.
		backend: &'static str,
	},
	/// A backend rejected the hello exchange.
	#[error("{backend} environment backend rejected the hello")]
	Handshake {
		/// Stable backend name used for diagnostics.
		backend: &'static str,
		/// Typed protocol rejection.
		#[source]
		source:  ClientError,
	},
	/// A peer sent a non-hello frame during negotiation.
	#[error("{backend} environment peer sent an invalid hello")]
	InvalidHandshake {
		/// Stable peer name used for diagnostics.
		backend: &'static str,
	},
}

/// Deterministically partitions one environment client across two frame
/// backends.
pub struct PartitionedEnvTransport;

impl PartitionedEnvTransport {
	/// Spawns one router and returns the sole ID-minting client plus its task.
	///
	/// The returned join handle resolves to `Result<(), PartitionError>`. The
	/// router performs both backend handshakes when the client sends its hello,
	/// exposes only the remote backend's hello, and then merges backend frames.
	#[must_use]
	pub fn spawn(
		local: FramePipe,
		remote: FramePipe,
		remote_tools: Arc<FastHashSet<Str>>,
	) -> (EnvClient, JoinHandle<Result<(), PartitionError>>) {
		let (client, final_transport) = EnvClient::in_process(0);
		let task = tokio::spawn(route(final_transport, local, remote, remote_tools));
		(client, task)
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Backend {
	Local,
	Remote,
}

impl Backend {
	const fn name(self) -> &'static str {
		match self {
			Self::Local => "local",
			Self::Remote => "remote",
		}
	}
}

async fn route(
	final_transport: InProcessEnvTransport,
	local: FramePipe,
	remote: FramePipe,
	remote_tools: Arc<FastHashSet<Str>>,
) -> Result<(), PartitionError> {
	let (client_rx, client_tx) = final_transport.into_parts();
	let (local_tx, local_rx) = local.into_parts();
	let (remote_tx, remote_rx) = remote.into_parts();

	let forwarded = client_rx
		.recv_async()
		.await
		.map_err(|_| PartitionError::ClientClosed)?;
	if forwarded.request_id != 0
		|| !matches!(forwarded.body.as_ref(), Some(client_frame::Body::Hello(_)))
	{
		return Err(PartitionError::InvalidHandshake { backend: "client" });
	}
	local_tx
		.send_async(forwarded.clone())
		.await
		.map_err(|_| PartitionError::BackendClosed { backend: Backend::Local.name() })?;
	remote_tx
		.send_async(forwarded)
		.await
		.map_err(|_| PartitionError::BackendClosed { backend: Backend::Remote.name() })?;

	let (local_hello, remote_hello) = tokio::join!(
		receive_hello(&local_rx, Backend::Local),
		receive_hello(&remote_rx, Backend::Remote),
	);
	let _local_hello = local_hello?;
	let remote_hello = remote_hello?;
	client_tx
		.send_async(remote_hello)
		.await
		.map_err(|_| PartitionError::ClientClosed)?;

	let mut invocation_routes = FastHashMap::<Str, Backend>::default();
	let mut request_routes = FastHashMap::<u64, Backend>::default();
	let mut request_invocations = FastHashMap::<u64, Str>::default();
	let mut local_open = true;
	let mut remote_open = true;

	loop {
		tokio::select! {
			frame = client_rx.recv_async() => {
				let frame = frame.map_err(|_| PartitionError::ClientClosed)?;
				let (backend, invocation) = route_client_frame(&frame, &remote_tools, &invocation_routes, &request_routes);
				if let Some(client_frame::Body::InvokeTool(invoke)) = frame.body.as_ref() {
					invocation_routes.insert(Str::from(invoke.invocation_id.clone()), backend);
				}
				if frame.request_id != 0 && opens_response_route(&frame) {
					request_routes.insert(frame.request_id, backend);
					if let Some(invocation) = invocation {
						request_invocations.insert(frame.request_id, invocation);
					}
				}
				let target = match backend { Backend::Local => &local_tx, Backend::Remote => &remote_tx };
				target.send_async(frame).await.map_err(|_| PartitionError::BackendClosed { backend: backend.name() })?;
			}
			frame = local_rx.recv_async(), if local_open => match frame {
				Ok(frame) => forward_server_frame(frame, &client_tx, &mut invocation_routes, &mut request_routes, &mut request_invocations).await?,
				Err(_) => local_open = false,
			},
			frame = remote_rx.recv_async(), if remote_open => match frame {
				Ok(frame) => forward_server_frame(frame, &client_tx, &mut invocation_routes, &mut request_routes, &mut request_invocations).await?,
				Err(_) => remote_open = false,
			},
		}
		if !local_open && !remote_open {
			return Err(PartitionError::BackendClosed { backend: "local and remote" });
		}
	}
}

async fn receive_hello(
	receiver: &Receiver<ServerFrame>,
	backend: Backend,
) -> Result<ServerFrame, PartitionError> {
	let frame = receiver
		.recv_async()
		.await
		.map_err(|_| PartitionError::BackendClosed { backend: backend.name() })?;
	if frame.request_id != 0 {
		return Err(PartitionError::InvalidHandshake { backend: backend.name() });
	}
	match frame.body.as_ref() {
		Some(server_frame::Body::Hello(_)) => Ok(frame),
		Some(server_frame::Body::Error(error)) => Err(PartitionError::Handshake {
			backend: backend.name(),
			source:  ClientError::Protocol(error.clone()),
		}),
		_ => Err(PartitionError::InvalidHandshake { backend: backend.name() }),
	}
}

fn route_client_frame(
	frame: &ClientFrame,
	remote_tools: &FastHashSet<Str>,
	invocations: &FastHashMap<Str, Backend>,
	requests: &FastHashMap<u64, Backend>,
) -> (Backend, Option<Str>) {
	let remote = Backend::Remote;
	let local = Backend::Local;
	match frame.body.as_ref() {
		Some(client_frame::Body::Hello(_)) => (remote, None),
		Some(client_frame::Body::InvokeTool(invoke)) => {
			let id = Str::from(invoke.invocation_id.clone());
			let backend = if remote_tools.contains(invoke.name.as_str()) {
				remote
			} else {
				local
			};
			// The router owns this map; this insertion is performed by the caller below.
			(backend, Some(id))
		},
		Some(client_frame::Body::ArgText(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::ArgsCommitted(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::Interrupt(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::Admission(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::EditRepairAnswer(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::AcpDocumentAnswer(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::AcpExecEvent(value)) => {
			invocation_route(&value.invocation_id, invocations)
		},
		Some(client_frame::Body::Cancel(cancel)) => match cancel.target.as_ref() {
			Some(omp_proto::env::v1::cancel_request::Target::TargetRequestId(id)) => {
				(requests.get(id).copied().unwrap_or(remote), None)
			},
			Some(omp_proto::env::v1::cancel_request::Target::InvocationId(id)) => {
				invocation_route(id, invocations)
			},
			Some(omp_proto::env::v1::cancel_request::Target::Exec(_)) | None => (remote, None),
		},
		Some(client_frame::Body::Data(data)) => (route_data(data.body.as_ref()), None),
		Some(client_frame::Body::WorkspaceUpdateCheck(_)) => (local, None),
		Some(
			client_frame::Body::EvalReset(_)
			| client_frame::Body::AcpBind(_)
			| client_frame::Body::OpenSession(_)
			| client_frame::Body::CloseSession(_)
			| client_frame::Body::Exec(_)
			| client_frame::Body::Stdin(_)
			| client_frame::Body::Signal(_)
			| client_frame::Body::Resize(_)
			| client_frame::Body::StartProcess(_)
			| client_frame::Body::ListProcesses(_)
			| client_frame::Body::AttachOutput(_)
			| client_frame::Body::SendInput(_)
			| client_frame::Body::SignalProcess(_)
			| client_frame::Body::StopProcess(_)
			| client_frame::Body::BlobStat(_)
			| client_frame::Body::BlobGet(_)
			| client_frame::Body::BlobPutChunk(_)
			| client_frame::Body::BlobPutCommit(_)
			| client_frame::Body::BlobDelete(_)
			| client_frame::Body::Retire(_)
			| client_frame::Body::HttpRequest(_)
			| client_frame::Body::Shutdown(_)
			| client_frame::Body::RegisterPresence(_)
			| client_frame::Body::ReleasePresence(_)
			| client_frame::Body::GetProcess(_)
			| client_frame::Body::RestartProcess(_),
		)
		| None => (remote, None),
	}
}

const fn opens_response_route(frame: &ClientFrame) -> bool {
	!matches!(
		frame.body.as_ref(),
		Some(client_frame::Body::AcpDocumentAnswer(_) | client_frame::Body::AcpExecEvent(_))
	)
}

fn invocation_route(id: &str, routes: &FastHashMap<Str, Backend>) -> (Backend, Option<Str>) {
	let id = Str::from(id);
	(routes.get(&id).copied().unwrap_or(Backend::Remote), Some(id))
}

const fn route_data(body: Option<&data_request::Body>) -> Backend {
	match body {
		Some(
			data_request::Body::Worker(_)
			| data_request::Body::Site(_)
			| data_request::Body::Resource(_)
			| data_request::Body::Mcp(_),
		) => Backend::Local,
		Some(
			data_request::Body::Document(_)
			| data_request::Body::Walk(_)
			| data_request::Body::Search(_)
			| data_request::Body::Workspace(_)
			| data_request::Body::Worktree(_)
			| data_request::Body::DetachExec(_)
			| data_request::Body::RepositorySnapshot(_)
			| data_request::Body::PrivilegedMutation(_)
			| data_request::Body::ExecSession(_)
			| data_request::Body::DapLaunch(_)
			| data_request::Body::DapAttach(_)
			| data_request::Body::DapAction(_)
			| data_request::Body::HostInfo(_)
			| data_request::Body::WorkspaceRoots(_),
		)
		| None => Backend::Remote,
	}
}

async fn forward_server_frame(
	frame: ServerFrame,
	client: &Sender<ServerFrame>,
	invocations: &mut FastHashMap<Str, Backend>,
	requests: &mut FastHashMap<u64, Backend>,
	request_invocations: &mut FastHashMap<u64, Str>,
) -> Result<(), PartitionError> {
	match frame.body.as_ref() {
		Some(server_frame::Body::Verdict(verdict)) => {
			let id = Str::from(verdict.invocation_id.clone());
			invocations.remove(&id);
			request_invocations.retain(|request, invocation| {
				let keep = invocation != &id;
				if !keep {
					requests.remove(request);
				}
				keep
			});
		},
		Some(server_frame::Body::Error(_)) => {
			requests.remove(&frame.request_id);
			if let Some(invocation) = request_invocations.remove(&frame.request_id) {
				invocations.remove(&invocation);
			}
		},
		_ => {},
	}
	client
		.send_async(frame)
		.await
		.map_err(|_| PartitionError::ClientClosed)
}

fn channel<T>(capacity: usize) -> (Sender<T>, Receiver<T>) {
	if capacity == 0 {
		flume::unbounded()
	} else {
		flume::bounded(capacity)
	}
}
#[cfg(test)]
mod tests {
	use std::time::Duration;

	use omp_proto::env::v1::{
		AcpBind, AcpDocumentAnswer, AcpExecCancel, AcpExecEvent, AcpExecQuery, AcpReadQuery,
		AcpWriteQuery, ArgText, ClientHello, DataRequest, DocumentOp, EditRepairAnswer,
		EditRepairQuery, EvalResetRequest, InvokeTool, RegisterPresence, ServerHello, Update,
	};

	use super::*;

	async fn receive(transport: &InProcessEnvTransport) -> ClientFrame {
		tokio::time::timeout(Duration::from_secs(2), transport.recv())
			.await
			.expect("backend receive timed out")
			.expect("router closed backend")
	}

	async fn send(pipe: &FramePipe, frame: ClientFrame) {
		tokio::time::timeout(Duration::from_secs(2), pipe.outgoing().send_async(frame))
			.await
			.expect("client send timed out")
			.expect("router closed client input");
	}

	fn frame(request_id: u64, body: client_frame::Body) -> ClientFrame {
		ClientFrame { request_id, body: Some(body), ..ClientFrame::default() }
	}

	#[test]
	fn edit_repair_answers_follow_the_invoking_backend() {
		let remote_tools = FastHashSet::default();
		let mut invocations = FastHashMap::default();
		invocations.insert(Str::from("local-edit"), Backend::Local);
		invocations.insert(Str::from("remote-edit"), Backend::Remote);
		let requests = FastHashMap::default();

		for (invocation_id, expected) in [
			("local-edit", Backend::Local),
			("remote-edit", Backend::Remote),
			("missing-edit", Backend::Remote),
		] {
			let answer = frame(
				91,
				client_frame::Body::EditRepairAnswer(EditRepairAnswer {
					invocation_id: invocation_id.into(),
					..EditRepairAnswer::default()
				}),
			);
			let (actual, pinned_invocation) =
				route_client_frame(&answer, &remote_tools, &invocations, &requests);
			assert_eq!(actual, expected);
			assert_eq!(pinned_invocation.as_deref(), Some(invocation_id));
		}
	}

	#[test]
	fn acp_bind_always_routes_to_the_environment_backend() {
		let bind = frame(0, client_frame::Body::AcpBind(AcpBind { documents: true, exec: true }));
		let (backend, invocation) = route_client_frame(
			&bind,
			&FastHashSet::default(),
			&FastHashMap::default(),
			&FastHashMap::default(),
		);
		assert_eq!(backend, Backend::Remote);
		assert!(invocation.is_none());
	}

	#[test]
	fn acp_answers_and_events_follow_the_invoking_backend_without_correlation() {
		let remote_tools = FastHashSet::default();
		let mut invocations = FastHashMap::default();
		invocations.insert(Str::from("local-acp"), Backend::Local);
		invocations.insert(Str::from("remote-acp"), Backend::Remote);
		let requests = FastHashMap::default();

		for (invocation_id, expected) in [
			("local-acp", Backend::Local),
			("remote-acp", Backend::Remote),
			("missing-acp", Backend::Remote),
		] {
			let document_answer = frame(
				91,
				client_frame::Body::AcpDocumentAnswer(AcpDocumentAnswer {
					invocation_id: invocation_id.into(),
					..AcpDocumentAnswer::default()
				}),
			);
			let exec_event = frame(
				91,
				client_frame::Body::AcpExecEvent(AcpExecEvent {
					invocation_id: invocation_id.into(),
					..AcpExecEvent::default()
				}),
			);
			for answer in [document_answer, exec_event] {
				let (actual, pinned_invocation) =
					route_client_frame(&answer, &remote_tools, &invocations, &requests);
				assert_eq!(actual, expected);
				assert_eq!(pinned_invocation.as_deref(), Some(invocation_id));
				assert!(!opens_response_route(&answer));
			}
		}
	}

	#[test]
	fn eval_reset_always_routes_to_the_environment_backend() {
		let reset = frame(91, client_frame::Body::EvalReset(EvalResetRequest {}));
		let (backend, invocation) = route_client_frame(
			&reset,
			&FastHashSet::default(),
			&FastHashMap::default(),
			&FastHashMap::default(),
		);
		assert_eq!(backend, Backend::Remote);
		assert!(invocation.is_none());
	}

	#[tokio::test]
	async fn acp_queries_and_cancellation_merge_without_rewriting() {
		let (client, merged) = flume::unbounded();
		let mut invocations = FastHashMap::default();
		let mut requests = FastHashMap::default();
		let mut request_invocations = FastHashMap::default();
		let frames = [
			ServerFrame {
				request_id: 81,
				body: Some(server_frame::Body::AcpReadQuery(AcpReadQuery {
					query_id:      1,
					invocation_id: "remote-acp".into(),
					path:          "one.rs".into(),
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 82,
				body: Some(server_frame::Body::AcpWriteQuery(AcpWriteQuery {
					query_id:      2,
					invocation_id: "remote-acp".into(),
					path:          "two.rs".into(),
					content:       "updated".into(),
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 83,
				body: Some(server_frame::Body::AcpExecQuery(AcpExecQuery {
					query_id: 3,
					invocation_id: "remote-acp".into(),
					..AcpExecQuery::default()
				})),
				..ServerFrame::default()
			},
			ServerFrame {
				request_id: 84,
				body: Some(server_frame::Body::AcpExecCancel(AcpExecCancel {
					query_id:      3,
					invocation_id: "remote-acp".into(),
				})),
				..ServerFrame::default()
			},
		];

		for frame in frames {
			forward_server_frame(
				frame.clone(),
				&client,
				&mut invocations,
				&mut requests,
				&mut request_invocations,
			)
			.await
			.expect("merge ACP request");
			assert_eq!(
				merged
					.recv_async()
					.await
					.expect("receive merged ACP request"),
				frame
			);
		}
	}

	#[tokio::test]
	async fn edit_repair_queries_merge_without_rewriting() {
		let (client, merged) = flume::unbounded();
		let mut invocations = FastHashMap::default();
		let mut requests = FastHashMap::default();
		let mut request_invocations = FastHashMap::default();
		let query = ServerFrame {
			request_id: 91,
			body: Some(server_frame::Body::EditRepairQuery(EditRepairQuery {
				invocation_id: "remote-edit".into(),
				prompt:        None,
			})),
			..ServerFrame::default()
		};

		forward_server_frame(
			query.clone(),
			&client,
			&mut invocations,
			&mut requests,
			&mut request_invocations,
		)
		.await
		.expect("merge repair query");
		assert_eq!(merged.recv_async().await.expect("receive merged query"), query);
	}

	#[tokio::test]
	async fn partitions_raw_frames_and_merges_responses() {
		let (final_pipe, final_transport) = in_process_frames(8);
		let (local_pipe, local_transport) = in_process_frames(8);
		let (remote_pipe, remote_transport) = in_process_frames(8);
		let mut tools = FastHashSet::default();
		tools.insert(Str::from("read"));
		let router = tokio::spawn(route(final_transport, local_pipe, remote_pipe, Arc::new(tools)));

		let local = tokio::spawn(async move {
			assert!(matches!(
				receive(&local_transport).await.body,
				Some(client_frame::Body::Hello(_))
			));
			local_transport
				.send(ServerFrame {
					body: Some(server_frame::Body::Hello(ServerHello {
						server_build: "local".into(),
						..ServerHello::default()
					})),
					..ServerFrame::default()
				})
				.await
				.expect("send local hello");

			let ask = receive(&local_transport).await;
			assert!(matches!(
				ask.body,
				Some(client_frame::Body::InvokeTool(InvokeTool { ref name, .. })) if name == "ask"
			));
			assert!(matches!(
				receive(&local_transport).await.body,
				Some(client_frame::Body::ArgText(_))
			));
			let worker = receive(&local_transport).await;
			assert!(matches!(
				worker.body,
				Some(client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Worker(_)),
					..
				}))
			));
			local_transport
				.send(ServerFrame {
					request_id: 4,
					body: Some(server_frame::Body::Update(Update {
						invocation_id: "local-response".into(),
						..Update::default()
					})),
					..ServerFrame::default()
				})
				.await
				.expect("send local response");
		});

		let remote = tokio::spawn(async move {
			assert!(matches!(
				receive(&remote_transport).await.body,
				Some(client_frame::Body::Hello(_))
			));
			remote_transport
				.send(ServerFrame {
					body: Some(server_frame::Body::Hello(ServerHello {
						server_build: "daemon".into(),
						..ServerHello::default()
					})),
					..ServerFrame::default()
				})
				.await
				.expect("send daemon hello");

			let document = receive(&remote_transport).await;
			assert!(matches!(
				document.body,
				Some(client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Document(_)),
					..
				}))
			));
			let read = receive(&remote_transport).await;
			assert!(matches!(
				read.body,
				Some(client_frame::Body::InvokeTool(InvokeTool { ref name, .. })) if name == "read"
			));
			assert!(matches!(
				receive(&remote_transport).await.body,
				Some(client_frame::Body::ArgText(_))
			));
			assert!(matches!(
				receive(&remote_transport).await.body,
				Some(client_frame::Body::RegisterPresence(_))
			));
			remote_transport
				.send(ServerFrame {
					request_id: 1,
					body: Some(server_frame::Body::Update(Update {
						invocation_id: "remote-response".into(),
						..Update::default()
					})),
					..ServerFrame::default()
				})
				.await
				.expect("send remote response");
		});

		send(&final_pipe, frame(0, client_frame::Body::Hello(ClientHello::default()))).await;
		let hello = tokio::time::timeout(Duration::from_secs(2), final_pipe.incoming().recv_async())
			.await
			.expect("hello timed out")
			.expect("router closed final responses");
		assert!(matches!(
			hello.body,
			Some(server_frame::Body::Hello(ServerHello { ref server_build, .. }))
				if server_build == "daemon"
		));

		send(
			&final_pipe,
			frame(
				1,
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Document(DocumentOp::default())),
					..DataRequest::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(
				2,
				client_frame::Body::InvokeTool(InvokeTool {
					invocation_id: "ask-1".into(),
					name: "ask".into(),
					..InvokeTool::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(
				2,
				client_frame::Body::ArgText(ArgText {
					invocation_id: "ask-1".into(),
					..ArgText::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(
				3,
				client_frame::Body::InvokeTool(InvokeTool {
					invocation_id: "read-1".into(),
					name: "read".into(),
					..InvokeTool::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(
				3,
				client_frame::Body::ArgText(ArgText {
					invocation_id: "read-1".into(),
					..ArgText::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(
				4,
				client_frame::Body::Data(DataRequest {
					body: Some(data_request::Body::Worker(Default::default())),
					..DataRequest::default()
				}),
			),
		)
		.await;
		send(
			&final_pipe,
			frame(5, client_frame::Body::RegisterPresence(RegisterPresence::default())),
		)
		.await;

		let first = tokio::time::timeout(Duration::from_secs(2), final_pipe.incoming().recv_async())
			.await
			.expect("first merged response timed out")
			.expect("router closed final responses");
		let second = tokio::time::timeout(Duration::from_secs(2), final_pipe.incoming().recv_async())
			.await
			.expect("second merged response timed out")
			.expect("router closed final responses");
		let ids = [first, second].map(|frame| match frame.body {
			Some(server_frame::Body::Update(update)) => update.invocation_id,
			other => panic!("unexpected merged frame: {other:?}"),
		});
		assert!(ids.contains(&"local-response".to_owned()));
		assert!(ids.contains(&"remote-response".to_owned()));

		local.await.expect("local backend task");
		remote.await.expect("remote backend task");
		drop(final_pipe);
		let result = tokio::time::timeout(Duration::from_secs(2), router)
			.await
			.expect("router shutdown timed out")
			.expect("router task panicked");
		assert!(result.is_err());
	}
}
