//! End-to-end contracts for correlated environment client streams.

use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::Duration,
};

use bytes::Bytes;
use flume::Receiver;
use frame::{
	client_frame, data_event, data_request, data_response, document_op, document_result,
	server_frame,
};
use omp_core::{EnvPath, sf};
use omp_env::{
	ClientError, DataScope, EnvClient, InvocationEvent, InvocationGrant, LspStreamEvent,
	SearchEvent, TransactionOutcome, WalkEvent, frame,
};
use omp_proto::document::v1::{self as document, commit_transaction_response};

const RECEIVE_TIMEOUT: Duration = Duration::from_secs(2);
const QUIET_PERIOD: Duration = Duration::from_millis(100);

struct ThreadWaker(thread::Thread);

impl Wake for ThreadWaker {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.unpark();
	}
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
	let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
	let mut context = Context::from_waker(&waker);
	let mut future = Box::pin(future);
	loop {
		match future.as_mut().poll(&mut context) {
			Poll::Ready(output) => return output,
			Poll::Pending => thread::park(),
		}
	}
}

fn receive(requests: &Receiver<frame::ClientFrame>) -> frame::ClientFrame {
	requests
		.recv_timeout(RECEIVE_TIMEOUT)
		.expect("client frame")
}

fn respond(
	responses: &flume::Sender<frame::ServerFrame>,
	request_id: u64,
	body: server_frame::Body,
) {
	responses
		.send(frame::ServerFrame { request_id, body: Some(body), ..frame::ServerFrame::default() })
		.expect("open client response channel");
}

fn invoke_request(invocation_id: &str) -> frame::InvokeTool {
	frame::InvokeTool {
		invocation_id: invocation_id.into(),
		name: "contract-test".into(),
		..frame::InvokeTool::default()
	}
}

fn expect_invoke(frame: frame::ClientFrame, invocation_id: &str) -> u64 {
	assert_ne!(frame.request_id, 0);
	match frame.body {
		Some(client_frame::Body::InvokeTool(request)) => {
			assert_eq!(request.invocation_id, invocation_id);
		},
		body => panic!("expected InvokeTool, got {body:?}"),
	}
	frame.request_id
}

fn expect_scoped_cancel(frame: frame::ClientFrame, target_request_id: u64) {
	assert_eq!(frame.request_id, 0, "cancellation is a control frame");
	match frame.body {
		Some(client_frame::Body::Cancel(cancel)) => assert!(matches!(
			cancel.target,
			Some(frame::cancel_request::Target::TargetRequestId(id)) if id == target_request_id
		)),
		body => panic!("expected scoped CancelRequest, got {body:?}"),
	}
}

fn data_scope() -> DataScope {
	DataScope::new("invocation-data", Bytes::from_static(b"effect-token"), 7, 11)
}

fn data_response(result: document_result::Result) -> server_frame::Body {
	server_frame::Body::Data(frame::DataResponse {
		body: Some(data_response::Body::Document(frame::DocumentResult {
			result: Some(result),
			..frame::DocumentResult::default()
		})),
		..frame::DataResponse::default()
	})
}

fn document_head(sequence: u64, uri: &str) -> document::DocumentHead {
	document::DocumentHead {
		document: Some(document::DocumentRef {
			id:  Bytes::from_static(b"document-owner"),
			uri: uri.into(),
		}),
		revision: Some(document::Revision {
			sequence,
			content_hash: Bytes::from_static(b"0123456789abcdef0123456789abcdef"),
		}),
		..document::DocumentHead::default()
	}
}

#[test]
fn invocation_grants_are_clone_local_and_stamped_on_each_request() {
	let (client, transport) = EnvClient::in_process(0);
	let denied = client.with_invocation_grant(InvocationGrant::unrestricted().deny_pty());
	let allowed = client.with_invocation_grant(InvocationGrant::unrestricted());
	let (requests, responses) = transport.into_parts();
	let server = thread::spawn(move || {
		for expected in [("denied", true), ("allowed", false)] {
			let frame = receive(&requests);
			let request_id = frame.request_id;
			assert!(matches!(
				frame.scope,
				Some(scope)
					if scope.invocation_id == expected.0 && scope.pty_denied == expected.1
			));
			respond(
				&responses,
				request_id,
				server_frame::Body::InvocationAccepted(frame::InvokeAccepted {
					invocation_id: expected.0.into(),
					..frame::InvokeAccepted::default()
				}),
			);
			let committed = receive(&requests);
			assert_eq!(committed.request_id, request_id);
			assert!(matches!(
				committed.scope,
				Some(scope)
					if scope.invocation_id == expected.0
						&& scope.effect_token == Bytes::from_static(b"scope-token")
						&& scope.pty_denied == expected.1
			));
		}
	});

	let denied_call = block_on(denied.invoke(invoke_request("denied"))).expect("denied invocation");
	block_on(denied_call.commit_args(
		Bytes::from_static(b"{}"),
		Bytes::from_static(b"scope-token"),
		1,
		None,
	))
	.expect("commit denied scope");
	let allowed_call =
		block_on(allowed.invoke(invoke_request("allowed"))).expect("allowed invocation");
	block_on(allowed_call.commit_args(
		Bytes::from_static(b"{}"),
		Bytes::from_static(b"scope-token"),
		1,
		None,
	))
	.expect("commit allowed scope");
	server.join().expect("server");
}
#[test]
fn invocation_principals_are_stable_and_stamped_on_open_and_commit() {
	let (client, transport) = EnvClient::in_process(0);
	let client = client
		.with_principal("session-7", "agent-child-2")
		.expect("valid durable principal");
	let (requests, responses) = transport.into_parts();
	let server = thread::spawn(move || {
		let opened = receive(&requests);
		let request_id = opened.request_id;
		assert!(matches!(
			opened.scope,
			Some(scope)
				if scope.session_id == "session-7"
					&& scope.agent_id == "agent-child-2"
					&& scope.invocation_id == "principal"
		));
		respond(
			&responses,
			request_id,
			server_frame::Body::InvocationAccepted(frame::InvokeAccepted {
				invocation_id: "principal".into(),
				..frame::InvokeAccepted::default()
			}),
		);
		let committed = receive(&requests);
		assert!(matches!(
			committed.scope,
			Some(scope)
				if scope.session_id == "session-7"
					&& scope.agent_id == "agent-child-2"
					&& scope.effect_token == Bytes::from_static(b"authorized")
		));
	});
	let invocation =
		block_on(client.invoke(invoke_request("principal"))).expect("principal invocation");
	block_on(invocation.commit_args(
		Bytes::from_static(b"{}"),
		Bytes::from_static(b"authorized"),
		1,
		None,
	))
	.expect("principal commit");
	server.join().expect("server");
}

#[test]
fn hello_and_concurrent_requests_are_correlated_while_events_remain_observable() {
	let (client, transport) = EnvClient::in_process(0);
	let events = client.server_events();
	let (requests, responses) = transport.into_parts();

	let server = thread::spawn(move || {
		let hello = receive(&requests);
		assert_eq!(hello.request_id, 0);
		assert!(matches!(hello.body, Some(frame::client_frame::Body::Hello(_))));
		respond(
			&responses,
			0,
			server_frame::Body::Update(frame::Update {
				invocation_id: "unsolicited".into(),
				json: Bytes::from_static(b"{\"live\":true}"),
				..frame::Update::default()
			}),
		);
		respond(
			&responses,
			0,
			server_frame::Body::Hello(frame::ServerHello {
				schema_rev: 7,
				server_version: "test-server".into(),
				..frame::ServerHello::default()
			}),
		);
		(requests, responses)
	});

	let hello =
		block_on(client.hello(frame::ClientHello {
			client: "test-client".into(),
			..frame::ClientHello::default()
		}))
		.expect("hello response");
	assert_eq!(hello.schema_rev, 7);
	assert_eq!(hello.server_version, "test-server");
	let event = events
		.recv_timeout(RECEIVE_TIMEOUT)
		.expect("unsolicited event");
	assert_eq!(event.request_id, 0);
	assert!(
		matches!(event.body, Some(server_frame::Body::Update(update)) if update.invocation_id == "unsolicited")
	);

	let (requests, responses) = server.join().expect("server thread");
	let mut first = block_on(client.invoke(invoke_request("first"))).expect("first invocation");
	let mut second = block_on(client.invoke(invoke_request("second"))).expect("second invocation");
	let first_id = expect_invoke(receive(&requests), "first");
	let second_id = expect_invoke(receive(&requests), "second");
	assert_ne!(first_id, second_id);

	respond(
		&responses,
		second_id,
		server_frame::Body::Update(frame::Update {
			invocation_id: "second".into(),
			json: Bytes::from_static(b"2"),
			..frame::Update::default()
		}),
	);
	respond(
		&responses,
		first_id,
		server_frame::Body::Update(frame::Update {
			invocation_id: "first".into(),
			json: Bytes::from_static(b"1"),
			..frame::Update::default()
		}),
	);
	assert!(matches!(
		block_on(first.next_event()).expect("first event"),
		Some(InvocationEvent::Update(update)) if update.invocation_id == "first" && update.json == Bytes::from_static(b"1")
	));
	assert!(matches!(
		block_on(second.next_event()).expect("second event"),
		Some(InvocationEvent::Update(update)) if update.invocation_id == "second" && update.json == Bytes::from_static(b"2")
	));

	for (request_id, invocation_id) in [(first_id, "first"), (second_id, "second")] {
		respond(
			&responses,
			request_id,
			server_frame::Body::Verdict(frame::Verdict {
				invocation_id: invocation_id.into(),
				..frame::Verdict::default()
			}),
		);
	}
	assert!(matches!(block_on(first.next_event()), Ok(Some(InvocationEvent::Verdict(_)))));
	assert!(matches!(block_on(second.next_event()), Ok(Some(InvocationEvent::Verdict(_)))));
}

#[test]
fn invocation_frames_preserve_commit_and_event_order() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let mut invocation = block_on(client.invoke(invoke_request("ordered"))).expect("invocation");
	let request_id = expect_invoke(receive(&requests), "ordered");

	block_on(invocation.arg_text(sf!("{{\"path\":"))).expect("first argument fragment");
	block_on(invocation.arg_text(sf!("\"a\"}}"))).expect("second argument fragment");
	block_on(invocation.commit_args(
		Bytes::from_static(b"{\"path\":\"a\"}"),
		Bytes::from_static(b"effect-token"),
		123,
		None,
	))
	.expect("argument commitment");
	block_on(invocation.interrupt(sf!("please stop"))).expect("interrupt");

	let frames = [receive(&requests), receive(&requests), receive(&requests), receive(&requests)];
	for frame in &frames {
		assert_eq!(frame.request_id, request_id);
	}
	assert!(matches!(
		frames[0].body.as_ref(),
		Some(frame::client_frame::Body::ArgText(fragment)) if fragment.invocation_id == "ordered" && fragment.fragment == "{\"path\":"
	));
	assert!(matches!(
		frames[1].body.as_ref(),
		Some(frame::client_frame::Body::ArgText(fragment)) if fragment.invocation_id == "ordered" && fragment.fragment == "\"a\"}"
	));
	assert!(matches!(
		frames[2].body.as_ref(),
		Some(frame::client_frame::Body::ArgsCommitted(commit)) if commit.invocation_id == "ordered" && commit.raw == Bytes::from_static(b"{\"path\":\"a\"}")
	));
	assert!(matches!(
		frames[3].body.as_ref(),
		Some(frame::client_frame::Body::Interrupt(interrupt)) if interrupt.invocation_id == "ordered" && interrupt.reason == "please stop"
	));

	respond(
		&responses,
		request_id,
		server_frame::Body::Update(frame::Update {
			invocation_id: "ordered".into(),
			json: Bytes::from_static(b"{\"step\":1}"),
			..frame::Update::default()
		}),
	);
	respond(
		&responses,
		request_id,
		server_frame::Body::Verdict(frame::Verdict {
			invocation_id: "ordered".into(),
			json: Bytes::from_static(b"{\"status\":\"ok\"}"),
			is_error: true,
			useless: true,
			..frame::Verdict::default()
		}),
	);
	assert!(
		matches!(block_on(invocation.next_event()), Ok(Some(InvocationEvent::Update(update))) if update.json == Bytes::from_static(b"{\"step\":1}"))
	);
	assert!(
		matches!(block_on(invocation.next_event()), Ok(Some(InvocationEvent::Verdict(verdict))) if verdict.json == Bytes::from_static(b"{\"status\":\"ok\"}") && verdict.is_error && verdict.useless)
	);
	drop(invocation);
	assert!(matches!(requests.recv_timeout(QUIET_PERIOD), Err(flume::RecvTimeoutError::Timeout)));
}

#[test]
fn invocation_guard_cancels_once_but_relinquish_and_terminal_events_disarm_it() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();

	let dropped = block_on(client.invoke(invoke_request("dropped"))).expect("dropped invocation");
	let dropped_id = expect_invoke(receive(&requests), "dropped");
	drop(dropped);
	expect_scoped_cancel(receive(&requests), dropped_id);
	assert!(matches!(requests.recv_timeout(QUIET_PERIOD), Err(flume::RecvTimeoutError::Timeout)));

	let explicitly_cancelled =
		block_on(client.invoke(invoke_request("explicit"))).expect("explicitly cancelled invocation");
	let explicitly_cancelled_id = expect_invoke(receive(&requests), "explicit");
	assert_eq!(explicitly_cancelled.guard().request_id(), explicitly_cancelled_id);
	explicitly_cancelled.guard().cancel();
	explicitly_cancelled.guard().cancel();
	assert!(!explicitly_cancelled.guard().is_armed());
	drop(explicitly_cancelled);
	expect_scoped_cancel(receive(&requests), explicitly_cancelled_id);
	assert!(matches!(requests.recv_timeout(QUIET_PERIOD), Err(flume::RecvTimeoutError::Timeout)));

	let relinquished =
		block_on(client.invoke(invoke_request("relinquished"))).expect("relinquished invocation");
	let _relinquished_id = expect_invoke(receive(&requests), "relinquished");
	drop(relinquished.relinquish());
	assert!(matches!(requests.recv_timeout(QUIET_PERIOD), Err(flume::RecvTimeoutError::Timeout)));

	let mut completed =
		block_on(client.invoke(invoke_request("completed"))).expect("completed invocation");
	let completed_id = expect_invoke(receive(&requests), "completed");
	respond(
		&responses,
		completed_id,
		server_frame::Body::Verdict(frame::Verdict {
			invocation_id: "completed".into(),
			..frame::Verdict::default()
		}),
	);
	assert!(matches!(block_on(completed.next_event()), Ok(Some(InvocationEvent::Verdict(_)))));
	drop(completed);
	assert!(matches!(requests.recv_timeout(QUIET_PERIOD), Err(flume::RecvTimeoutError::Timeout)));
}

#[test]
fn command_guard_cancels_only_its_request_and_does_not_own_the_session() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let session = Bytes::from_static(b"session-token");

	let server_session = session.clone();
	let server = thread::spawn(move || {
		let open = receive(&requests);
		assert!(matches!(open.body, Some(frame::client_frame::Body::OpenSession(_))));
		respond(
			&responses,
			open.request_id,
			server_frame::Body::SessionOpened(frame::OpenSessionResponse {
				session: server_session,
				..frame::OpenSessionResponse::default()
			}),
		);
		(requests, responses)
	});
	let cwd = EnvPath::new("file:///workspace").expect("typed env path");
	let opened =
		block_on(client.open_session(&cwd, frame::OpenSessionRequest::default())).expect("session");
	assert_eq!(opened.session, session);
	let (requests, responses) = server.join().expect("server thread");

	let command = block_on(
		client.exec(frame::ExecRequest { session: session.clone(), ..frame::ExecRequest::default() }),
	)
	.expect("exec request");
	let exec = receive(&requests);
	let exec_id = exec.request_id;
	assert!(
		matches!(exec.body, Some(frame::client_frame::Body::Exec(request)) if request.session == session)
	);

	let mut other = block_on(client.invoke(invoke_request("other"))).expect("other request");
	let other_id = expect_invoke(receive(&requests), "other");
	drop(command);
	expect_scoped_cancel(receive(&requests), exec_id);
	assert_ne!(exec_id, other_id);

	respond(
		&responses,
		other_id,
		server_frame::Body::Verdict(frame::Verdict {
			invocation_id: "other".into(),
			..frame::Verdict::default()
		}),
	);
	assert!(matches!(block_on(other.next_event()), Ok(Some(InvocationEvent::Verdict(_)))));

	let server_session = session.clone();
	let server = thread::spawn(move || {
		let close = receive(&requests);
		assert_ne!(close.request_id, exec_id);
		assert!(matches!(
			close.body,
			Some(frame::client_frame::Body::CloseSession(request)) if request.session == server_session
		));
		respond(
			&responses,
			close.request_id,
			server_frame::Body::SessionClosed(frame::CloseSessionResponse {
				session: server_session,
				..frame::CloseSessionResponse::default()
			}),
		);
	});
	let closed = block_on(client.close_session(frame::CloseSessionRequest {
		session: session.clone(),
		..frame::CloseSessionRequest::default()
	}))
	.expect("close session after command cancellation");
	assert_eq!(closed.session, session);
	server.join().expect("server thread");
}

#[test]
fn admission_and_authorization_frames_carry_typed_phase_data() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let mut invocation = block_on(client.invoke(invoke_request("phase"))).expect("invocation");
	let request_id = expect_invoke(receive(&requests), "phase");

	respond(
		&responses,
		request_id,
		server_frame::Body::AdmitInvocation(frame::AdmitInvocation {
			invocation_id: "phase".into(),
			..frame::AdmitInvocation::default()
		}),
	);
	assert!(matches!(
		block_on(invocation.next_event()).expect("admission event"),
		Some(InvocationEvent::Admission(admission)) if admission.invocation_id == "phase"
	));
	block_on(invocation.admit(frame::Admission {
		invocation_id: "forged".into(),
		allow: true,
		..frame::Admission::default()
	}))
	.expect("admission reply");
	let admission = receive(&requests);
	assert_eq!(admission.request_id, request_id);
	assert!(matches!(
		admission.body,
		Some(frame::client_frame::Body::Admission(reply)) if reply.invocation_id == "phase" && reply.allow
	));

	block_on(invocation.commit_args(
		Bytes::from_static(b"{}"),
		Bytes::from_static(b"phase-token"),
		456,
		None,
	))
	.expect("authorization frame");
	let authorized = receive(&requests);
	assert_eq!(authorized.request_id, request_id);
	assert!(matches!(
		authorized.body,
		Some(frame::client_frame::Body::ArgsCommitted(commit))
			if commit.effect_token == Bytes::from_static(b"phase-token")
				&& commit.authorized_at_ms == 456
	));
}

#[test]
fn scoped_walk_and_search_interleave_and_fuse_after_completion() {
	let (client, transport) = EnvClient::in_process(0);
	let worker = client.worker_scope(data_scope());
	let (requests, responses) = transport.into_parts();
	let root = EnvPath::new("file:///workspace").expect("typed root");

	let mut walk = block_on(worker.walk(&root, frame::WalkRequest::default())).expect("walk stream");
	let walk_request = receive(&requests);
	let walk_id = walk_request.request_id;
	assert!(matches!(
		walk_request.scope,
		Some(scope)
			if scope.invocation_id == "invocation-data"
				&& scope.effect_token == Bytes::from_static(b"effect-token")
				&& scope.host_generation == 7
				&& scope.session_generation == 11
	));
	assert!(matches!(
		walk_request.body,
		Some(frame::client_frame::Body::Data(frame::DataRequest {
			body: Some(frame::data_request::Body::Walk(frame::WalkRequest { root_uri, .. })),
			..
		})) if root_uri == "file:///workspace"
	));

	let mut search =
		block_on(worker.search(&root, frame::SearchRequest::default())).expect("search stream");
	let search_request = receive(&requests);
	let search_id = search_request.request_id;
	assert_ne!(walk_id, search_id);

	respond(
		&responses,
		search_id,
		server_frame::Body::DataEvent(frame::DataEvent {
			body: Some(data_event::Body::SearchMatch(frame::SearchMatchMsg {
				path: "src/lib.rs".into(),
				line: 9,
				..frame::SearchMatchMsg::default()
			})),
			..frame::DataEvent::default()
		}),
	);
	respond(
		&responses,
		walk_id,
		server_frame::Body::DataEvent(frame::DataEvent {
			body: Some(data_event::Body::WalkEntry(frame::WalkEntry {
				path: "src".into(),
				..frame::WalkEntry::default()
			})),
			..frame::DataEvent::default()
		}),
	);
	assert!(matches!(
		block_on(walk.next_event()).expect("walk entry"),
		Some(WalkEvent::Entry(entry)) if entry.path == "src"
	));
	assert!(matches!(
		block_on(search.next_event()).expect("search match"),
		Some(SearchEvent::Match(found)) if found.path == "src/lib.rs" && found.line == 9
	));

	respond(
		&responses,
		walk_id,
		server_frame::Body::DataEvent(frame::DataEvent {
			body: Some(data_event::Body::WalkComplete(frame::WalkComplete::default())),
			..frame::DataEvent::default()
		}),
	);
	respond(
		&responses,
		search_id,
		server_frame::Body::DataEvent(frame::DataEvent {
			body: Some(data_event::Body::SearchComplete(frame::SearchComplete::default())),
			..frame::DataEvent::default()
		}),
	);
	assert!(matches!(block_on(walk.next_event()), Ok(Some(WalkEvent::Complete(_)))));
	assert!(matches!(block_on(search.next_event()), Ok(Some(SearchEvent::Complete(_)))));
	assert!(matches!(block_on(walk.next_event()), Ok(None)));
	assert!(matches!(block_on(search.next_event()), Ok(None)));
}

#[test]
fn owner_document_operations_omit_scope_and_advance_committed_lease_head() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let uri = "file:///workspace/src/owner.rs";
	let path = EnvPath::new(uri).expect("typed owner document path");
	let server = thread::spawn(move || {
		let hello = receive(&requests);
		assert!(hello.scope.is_none(), "owner hello unexpectedly carried scope");
		respond(
			&responses,
			hello.request_id,
			server_frame::Body::Hello(frame::ServerHello {
				server_epoch: Bytes::from_static(b"epoch-owner"),
				..frame::ServerHello::default()
			}),
		);

		let open = receive(&requests);
		assert!(open.scope.is_none(), "owner open unexpectedly carried scope");
		assert!(matches!(
			open.body,
			Some(client_frame::Body::Data(frame::DataRequest {
				body: Some(data_request::Body::Document(frame::DocumentOp {
					op: Some(document_op::Op::Open(_)),
					..
				})),
				..
			}))
		));
		respond(
			&responses,
			open.request_id,
			data_response(document_result::Result::Opened(document::OpenDocumentResponse {
				lease_id: Bytes::from_static(b"lease-owner"),
				head:     Some(document_head(1, uri)),
			})),
		);

		let read = receive(&requests);
		assert!(read.scope.is_none(), "owner read unexpectedly carried scope");
		assert!(matches!(
			read.body,
			Some(client_frame::Body::Data(frame::DataRequest {
				body: Some(data_request::Body::Document(frame::DocumentOp {
					op: Some(document_op::Op::Read(_)),
					..
				})),
				..
			}))
		));
		respond(
			&responses,
			read.request_id,
			data_response(document_result::Result::Read(document::ReadDocumentResponse {
				head: Some(document_head(1, uri)),
				body: Some(document::read_document_response::Body::Content(Bytes::from_static(
					b"before",
				))),
			})),
		);

		let commit = receive(&requests);
		assert!(commit.scope.is_none(), "owner commit unexpectedly carried scope");
		let Some(client_frame::Body::Data(frame::DataRequest {
			body:
				Some(data_request::Body::Document(frame::DocumentOp {
					op: Some(document_op::Op::CommitTransaction(transaction)),
					..
				})),
			..
		})) = commit.body
		else {
			panic!("expected owner transaction");
		};
		assert_eq!(transaction.transaction_id, Bytes::from_static(b"txn-owner"));
		assert_eq!(
			transaction.operations[0]
				.operation
				.as_ref()
				.and_then(|operation| match operation {
					document::document_mutation::Operation::Text(text) => text.base_revision.as_ref(),
					_ => None,
				})
				.map(|revision| revision.sequence),
			Some(1),
		);
		respond(
			&responses,
			commit.request_id,
			data_response(document_result::Result::Transaction(document::CommitTransactionResponse {
				outcome: Some(commit_transaction_response::Outcome::Committed(
					document::TransactionCommitted {
						transaction_id: Bytes::from_static(b"txn-owner"),
						operations:     vec![document::OperationResult {
							operation_index: 0,
							head: Some(document_head(2, uri)),
							..document::OperationResult::default()
						}],
					},
				)),
			})),
		);

		let close = receive(&requests);
		assert!(close.scope.is_none(), "owner close unexpectedly carried scope");
		assert!(matches!(
			close.body,
			Some(client_frame::Body::Data(frame::DataRequest {
				body: Some(data_request::Body::Document(frame::DocumentOp {
					op: Some(frame::document_op::Op::Close(document::CloseDocumentRequest {
						lease_id,
					})),
					..
				})),
				..
			})) if lease_id == Bytes::from_static(b"lease-owner")
		));
		respond(
			&responses,
			close.request_id,
			data_response(document_result::Result::Closed(document::CloseDocumentResponse::default())),
		);
		assert!(
			requests.recv_timeout(QUIET_PERIOD).is_err(),
			"explicit lease close emitted a duplicate drop close"
		);
	});

	block_on(client.hello(frame::ClientHello::default())).expect("owner hello");
	let mut lease = block_on(client.open_document(&path, Some("rust"))).expect("owner lease");
	let read = block_on(client.read_document(
		&lease,
		None,
		Some(document::ReadSelection {
			selection: Some(document::read_selection::Selection::Whole(document::WholeDocument {})),
		}),
	))
	.expect("owner read");
	assert_eq!(read.content(), Some(&Bytes::from_static(b"before")));
	let outcome = block_on(client.commit_document(
		&mut lease,
		Bytes::from_static(b"txn-owner"),
		document::TextMutation {
			change: Some(document::text_mutation::Change::ProposedContent(Bytes::from_static(
				b"after",
			))),
			..document::TextMutation::default()
		},
	))
	.expect("owner commit");
	assert!(matches!(outcome, TransactionOutcome::Committed(_)));
	assert_eq!(
		lease
			.head()
			.revision
			.as_ref()
			.map(|revision| revision.sequence),
		Some(2)
	);
	let retained = client
		.last_transaction()
		.expect("retained owner transaction");
	assert_eq!(retained.server_epoch, Bytes::from_static(b"epoch-owner"));
	assert_eq!(retained.txn_id, Bytes::from_static(b"txn-owner"));
	block_on(lease.close()).expect("owner close");
	server.join().expect("owner document server");
}

#[test]
fn document_stream_loss_is_terminal_and_drop_closes_connection_owned_lease() {
	let (client, transport) = EnvClient::in_process(0);
	let worker = client.worker_scope(data_scope());
	let (requests, responses) = transport.into_parts();
	let path = EnvPath::new("file:///workspace/src/lib.rs").expect("typed document path");

	let server = thread::spawn(move || {
		let open = receive(&requests);
		assert!(open.scope.is_some(), "worker open omitted invocation authority");
		assert!(matches!(
			open.body,
			Some(frame::client_frame::Body::Data(frame::DataRequest {
				body: Some(frame::data_request::Body::Document(frame::DocumentOp {
					op: Some(frame::document_op::Op::Open(_)),
					..
				})),
				..
			}))
		));
		respond(
			&responses,
			open.request_id,
			data_response(document_result::Result::Opened(document::OpenDocumentResponse {
				lease_id: Bytes::from_static(b"lease-a"),
				head:     Some(document::DocumentHead {
					document: Some(document::DocumentRef {
						id:  Bytes::from_static(b"document-a"),
						uri: "file:///workspace/src/lib.rs".into(),
					}),
					revision: Some(document::Revision {
						sequence:     1,
						content_hash: Bytes::from_static(b"0123456789abcdef0123456789abcdef"),
					}),
					..document::DocumentHead::default()
				}),
			})),
		);
		(requests, responses, open.request_id)
	});
	let mut lease = block_on(worker.open_document(&path, Some("rust"))).expect("document lease");
	let (requests, responses, open_id) = server.join().expect("open server");
	respond(
		&responses,
		open_id,
		server_frame::Body::EventStreamError(frame::EventStreamError {
			stream: frame::EventStreamKind::Document as i32,
			skipped_events: 3,
			message: "receiver lagged".into(),
			..frame::EventStreamError::default()
		}),
	);
	let error = block_on(lease.events().next_event()).expect_err("continuity loss");
	let ClientError::StreamLost(lost) = error else {
		panic!("expected StreamLost");
	};
	assert_eq!(lost.skipped, 3);
	assert!(lost.reopen_guidance.contains("reopen"));
	assert!(matches!(block_on(lease.events().next_event()), Ok(None)));

	drop(lease);
	let close = receive(&requests);
	assert!(matches!(
		close.body,
		Some(frame::client_frame::Body::Data(frame::DataRequest {
			body: Some(frame::data_request::Body::Document(frame::DocumentOp {
				op: Some(frame::document_op::Op::Close(document::CloseDocumentRequest { lease_id })),
				..
			})),
			..
		})) if lease_id == Bytes::from_static(b"lease-a")
	));
	assert!(close.scope.is_some(), "lease close retains invocation authority");
}

#[test]
fn lsp_stream_loss_requires_reconnect_and_requery() {
	let (client, transport) = EnvClient::in_process(0);
	let worker = client.worker_scope(data_scope());
	let (requests, responses) = transport.into_parts();
	let path = EnvPath::new("file:///workspace/src/main.rs").expect("typed document path");
	let server = thread::spawn(move || {
		let open = receive(&requests);
		respond(
			&responses,
			open.request_id,
			data_response(document_result::Result::Opened(document::OpenDocumentResponse {
				lease_id: Bytes::from_static(b"lease-lsp"),
				head:     Some(document::DocumentHead {
					document: Some(document::DocumentRef {
						id:  Bytes::from_static(b"document-lsp"),
						uri: "file:///workspace/src/main.rs".into(),
					}),
					revision: Some(document::Revision {
						sequence:     4,
						content_hash: Bytes::from_static(b"abcdef0123456789abcdef0123456789"),
					}),
					..document::DocumentHead::default()
				}),
			})),
		);
		(requests, responses)
	});
	let lease = block_on(worker.open_document(&path, Some("rust"))).expect("document lease");
	let (requests, responses) = server.join().expect("open server");
	let mut events = block_on(worker.lsp_events(&lease)).expect("LSP event stream");
	let subscription = receive(&requests);
	assert!(matches!(
		subscription.body,
		Some(frame::client_frame::Body::Data(frame::DataRequest {
			body: Some(frame::data_request::Body::Document(frame::DocumentOp {
				op: Some(frame::document_op::Op::GetLspBindings(_)),
				..
			})),
			..
		}))
	));
	respond(
		&responses,
		subscription.request_id,
		data_response(document_result::Result::LspBindings(
			document::GetLspBindingsResponse::default(),
		)),
	);
	assert!(matches!(block_on(events.next_event()), Ok(Some(LspStreamEvent::Bindings(_)))));
	respond(
		&responses,
		subscription.request_id,
		server_frame::Body::EventStreamError(frame::EventStreamError {
			stream: frame::EventStreamKind::LspRegistry as i32,
			skipped_events: 2,
			message: "registry lagged".into(),
			..frame::EventStreamError::default()
		}),
	);
	let error = block_on(events.next_event()).expect_err("LSP continuity loss");
	let ClientError::StreamLost(lost) = error else {
		panic!("expected StreamLost");
	};
	assert_eq!(lost.skipped, 2);
	assert!(lost.reopen_guidance.contains("reconnect"));
	assert!(lost.reopen_guidance.contains("re-query"));
	assert!(matches!(block_on(events.next_event()), Ok(None)));
	drop(lease);
	let _close = receive(&requests);
}

#[test]
fn transaction_ids_are_epoch_scoped_duplicates_reuse_outcome_and_partial_stays_distinct() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let hello_server = thread::spawn(move || {
		let hello = receive(&requests);
		respond(
			&responses,
			hello.request_id,
			server_frame::Body::Hello(frame::ServerHello {
				server_epoch: Bytes::from_static(b"epoch-a"),
				..frame::ServerHello::default()
			}),
		);
		(requests, responses)
	});
	block_on(client.hello(frame::ClientHello::default())).expect("hello");
	let (requests, responses) = hello_server.join().expect("hello server");
	let worker = client.worker_scope(data_scope());

	let server = thread::spawn(move || {
		for duplicate in 0..2 {
			let request = receive(&requests);
			assert!(request.scope.is_some(), "worker commit omitted invocation authority");
			let Some(client_frame::Body::Data(frame::DataRequest {
				body:
					Some(data_request::Body::Document(frame::DocumentOp {
						op: Some(document_op::Op::CommitTransaction(transaction)),
						..
					})),
				..
			})) = request.body
			else {
				panic!("expected transaction");
			};
			assert_eq!(transaction.transaction_id, Bytes::from_static(b"txn-same"));
			respond(
				&responses,
				request.request_id,
				data_response(document_result::Result::Transaction(
					document::CommitTransactionResponse {
						outcome: Some(commit_transaction_response::Outcome::Committed(
							document::TransactionCommitted {
								transaction_id: Bytes::from_static(b"txn-same"),
								..document::TransactionCommitted::default()
							},
						)),
					},
				)),
			);
			assert!(duplicate < 2);
		}
		let request = receive(&requests);
		assert!(request.scope.is_some(), "worker commit omitted invocation authority");
		respond(
			&responses,
			request.request_id,
			data_response(document_result::Result::Transaction(document::CommitTransactionResponse {
				outcome: Some(commit_transaction_response::Outcome::PartiallyCommitted(
					document::TransactionPartiallyCommitted {
						transaction_id: Bytes::from_static(b"txn-partial"),
						failed_operation_index: 1,
						..document::TransactionPartiallyCommitted::default()
					},
				)),
			})),
		);
		let request = receive(&requests);
		assert!(request.scope.is_some(), "worker commit omitted invocation authority");
		respond(
			&responses,
			request.request_id,
			data_response(document_result::Result::Transaction(document::CommitTransactionResponse {
				outcome: Some(commit_transaction_response::Outcome::Rejected(
					document::TransactionRejected {
						transaction_id: Bytes::from_static(b"txn-other"),
						..document::TransactionRejected::default()
					},
				)),
			})),
		);
	});
	for _ in 0..2 {
		let outcome = block_on(worker.commit_transaction(document::CommitTransactionRequest {
			transaction_id: Bytes::from_static(b"txn-same"),
			..document::CommitTransactionRequest::default()
		}))
		.expect("duplicate transaction outcome");
		assert!(matches!(outcome, TransactionOutcome::Committed(_)));
	}
	let retained = worker.last_transaction().expect("retained transaction id");
	assert_eq!(retained.server_epoch, Bytes::from_static(b"epoch-a"));
	assert_eq!(retained.txn_id, Bytes::from_static(b"txn-same"));

	let partial = block_on(worker.commit_transaction(document::CommitTransactionRequest {
		transaction_id: Bytes::from_static(b"txn-partial"),
		..document::CommitTransactionRequest::default()
	}))
	.expect("partial transaction outcome");
	assert!(matches!(
		partial,
		TransactionOutcome::Partial(document::TransactionPartiallyCommitted {
			failed_operation_index: 1,
			..
		})
	));
	let mismatch = block_on(worker.commit_transaction(document::CommitTransactionRequest {
		transaction_id: Bytes::from_static(b"txn-expected"),
		..document::CommitTransactionRequest::default()
	}));
	assert!(matches!(
		mismatch,
		Err(ClientError::UnexpectedResponse { expected: "matching transaction id" })
	));
	server.join().expect("transaction server");
}

#[test]
fn preauthorization_protocol_error_has_a_distinct_client_variant() {
	let (client, transport) = EnvClient::in_process(0);
	let worker = client.worker_scope(data_scope());
	let (requests, responses) = transport.into_parts();
	let server = thread::spawn(move || {
		let request = receive(&requests);
		respond(
			&responses,
			request.request_id,
			server_frame::Body::Error(frame::ProtocolError {
				code: frame::ProtocolErrorCode::Uncommitted as i32,
				message: "effects not authorized".into(),
				..frame::ProtocolError::default()
			}),
		);
	});
	let error = block_on(worker.request(frame::DataRequest {
		body: Some(data_request::Body::Walk(frame::WalkRequest::default())),
		..frame::DataRequest::default()
	}))
	.expect_err("preauthorization request must fail");
	assert!(matches!(error, ClientError::EffectsNotAuthorized(_)));
	server.join().expect("phase-error server");
}

#[test]
fn owner_worktree_api_preserves_typed_merge_disposition() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let server = thread::spawn(move || {
		let request = receive(&requests);
		let request_id = request.request_id;
		assert!(matches!(
			request.body,
			Some(frame::client_frame::Body::Data(frame::DataRequest {
				body: Some(frame::data_request::Body::Worktree(frame::WorktreeOp {
					op: Some(frame::worktree_op::Op::Merge(frame::MergeWorktree {
						mode,
						..
					})),
					..
				})),
				..
			})) if mode == frame::MergeMode::Patch as i32
		));
		respond(
			&responses,
			request_id,
			server_frame::Body::Data(frame::DataResponse {
				body: Some(data_response::Body::Worktree(frame::WorktreeResult {
					worktree: Some(frame::WorktreeInfo { id: "agent-1".into(), ..Default::default() }),
					artifact_hash: Bytes::from_static(b"hash"),
					artifact_size: 42,
					branch: Some("omp/agent/agent-1".into()),
					..Default::default()
				})),
				..Default::default()
			}),
		);
	});
	let result = block_on(client.merge_worktree(frame::MergeWorktree {
		id: "agent-1".into(),
		mode: frame::MergeMode::Patch as i32,
		..Default::default()
	}))
	.expect("typed worktree response");
	assert_eq!(result.artifact_hash, Bytes::from_static(b"hash"));
	assert_eq!(result.artifact_size, 42);
	assert_eq!(result.branch.as_deref(), Some("omp/agent/agent-1"));
	server.join().expect("worktree server");
}

#[test]
fn host_info_api_preserves_versioned_bounded_facts() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let server = thread::spawn(move || {
		let request = receive(&requests);
		let request_id = request.request_id;
		assert!(matches!(
			request.body,
			Some(frame::client_frame::Body::Data(frame::DataRequest {
				body: Some(frame::data_request::Body::HostInfo(frame::HostInfoRequest {
					wire_revision: 9,
					max_field_bytes: 256,
					..
				})),
				..
			}))
		));
		respond(
			&responses,
			request_id,
			server_frame::Body::Data(frame::DataResponse {
				body: Some(data_response::Body::HostInfo(frame::HostInfo {
					wire_revision: 9,
					os: "Darwin".into(),
					architecture: "arm64".into(),
					..Default::default()
				})),
				..Default::default()
			}),
		);
	});
	let info =
		block_on(client.host_info(frame::HostInfoRequest { wire_revision: 9, max_field_bytes: 256 }))
			.expect("typed host info");
	assert_eq!(info.os, "Darwin");
	assert_eq!(info.architecture, "arm64");
	server.join().expect("host-info server");
}

#[test]
fn resource_completion_is_scoped_streamed_and_cancellable() {
	let (client, transport) = EnvClient::in_process(0);
	let (requests, responses) = transport.into_parts();
	let worker = client.worker_scope(data_scope());
	let stream = block_on(worker.resource_complete(frame::ResourceCompleteRequest {
		input:            "skill://pro".into(),
		max_results:      5,
		catalog_revision: 7,
		wire_revision:    8,
	}))
	.expect("completion stream");
	let request = receive(&requests);
	let request_id = request.request_id;
	assert!(request.scope.is_some());
	assert!(matches!(
		request.body,
		Some(frame::client_frame::Body::Data(frame::DataRequest {
			body: Some(frame::data_request::Body::Resource(frame::ResourceOp {
				op: Some(frame::resource_op::Op::Complete(frame::ResourceCompleteRequest {
					max_results: 5,
					..
				})),
			})),
			..
		}))
	));
	stream.cancel();
	expect_scoped_cancel(receive(&requests), request_id);
	drop(responses);
}
