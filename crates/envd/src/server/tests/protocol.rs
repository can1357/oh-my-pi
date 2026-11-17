#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicUsize;
use std::{fs, os::unix::fs::PermissionsExt as _, sync::Arc};

use flume::Receiver;
use omp_contract::{ApprovalBook, ApprovalDecision, ApprovalRoute, ApprovalScope, ApprovalSource};
use omp_core::{EnvPath, Principal};
use omp_env::{EnvClient, ExecEvent as ClientExecEvent};
use omp_proto::{
	document::v1::{document_target, read_selection},
	env::v1::{self as env_pb, document_op, document_result},
};
use tokio::{
	io::{AsyncBufReadExt as _, BufReader, DuplexStream, duplex, split},
	net::{UnixListener, UnixStream},
	sync::watch,
	time,
};

use super::*;
#[cfg(target_os = "macos")]
use crate::loopback_upstream::{BODY, LoopbackUpstream};
use crate::{
	docserver::{
		Environment, NativeLspOptions, ServerConfig,
		connection::{ConnectionConfig, PROTOCOL_MAJOR, PROTOCOL_MINOR, serve_connection},
	},
	exec_settings::ExecSandboxMode,
	exthost::ConvarControlFactory,
};

const TEST_DAP_SESSION_ID: [u8; 16] = [0x2a; 16];

#[tokio::test]
async fn late_diagnostics_batch_by_path_in_arrival_order() {
	use omp_contract::{EnvEvent, EnvEventSink};
	use omp_session::late_diagnostics::{LateDiagnostics, LateDiagnosticsFile};

	let (sender, receiver) = flume::unbounded();
	let batcher = Arc::new(LateDiagnosticsBatcher {
		pending:   parking_lot::Mutex::new(Vec::new()),
		scheduled: AtomicBool::new(false),
		active:    AtomicBool::new(true),
		sender:    Arc::new(sender),
	});
	batcher.push(LateDiagnostics {
		files: vec![LateDiagnosticsFile {
			path:     sf!("src/lib.rs"),
			summary:  sf!("1 warning(s)"),
			errored:  false,
			messages: vec![sf!("src/lib.rs:9:1 [warning] [rustc] unused")],
		}],
	});
	batcher.push(LateDiagnostics {
		files: vec![LateDiagnosticsFile {
			path:     sf!("src/lib.rs"),
			summary:  sf!("1 error(s)"),
			errored:  true,
			messages: vec![sf!("src/lib.rs:2:1 [error] [rustc] broken (E1)")],
		}],
	});
	let event = time::timeout(Duration::from_secs(1), receiver.recv_async())
		.await
		.expect("batch deadline")
		.expect("batch event");
	let EnvEvent::LateDiagnostics(diagnostics) = event else {
		panic!("expected late diagnostics");
	};
	assert_eq!(diagnostics.files.len(), 1);
	assert_eq!(diagnostics.files[0].summary, "1 error(s), 1 warning(s)");
	assert_eq!(
		diagnostics.files[0]
			.messages
			.iter()
			.map(Str::as_str)
			.collect::<Vec<_>>(),
		["src/lib.rs:9:1 [warning] [rustc] unused", "src/lib.rs:2:1 [error] [rustc] broken (E1)",]
	);
}

fn accepted_hello(grants: Grants, approval_mode: Option<ApprovalMode>) -> AcceptedHello {
	AcceptedHello { grants, capabilities: BTreeSet::new(), props: None, approval_mode }
}

#[test]
fn wire_approval_modes_are_typed_and_unknown_values_are_rejected() {
	assert_eq!(approval_mode_from_wire(pb::ApprovalMode::Unspecified as i32), Ok(None));
	assert_eq!(approval_mode_from_wire(pb::ApprovalMode::Yolo as i32), Ok(Some(ApprovalMode::Yolo)));
	assert!(approval_mode_from_wire(i32::MAX).is_err());
}

/// Every hello reports the sandbox state the host's own probe found, the
/// one each admission on the connection resolves against, so a client
/// reports that state and not its own probe for the calls this host admits.
/// A host whose sandbox is off reports `off`; one configured for the
/// workspace reports what its probe constructed (`active` where Seatbelt
/// runs).
#[tokio::test]
async fn the_hello_reports_the_sandbox_state_the_host_probed() {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root.path(),
			state.path(),
			Registry::new(),
			ExtHostConfig::new(
				PathBuf::from("unused"),
				Principal::new(sf!("test-principal"), sf!("Test Principal")),
				sf!("test-session"),
				1,
			),
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.expect("host"),
	);
	for mode in [ExecSandboxMode::Off, ExecSandboxMode::WorkspaceWrite] {
		server
			.exec
			.configure_sandbox(&SandboxSettings { mode, ..SandboxSettings::default() }, root.path());
		let (client, transport) = EnvClient::in_process(8);
		let host = Arc::clone(&server);
		let serving = tokio::spawn(async move { host.serve_in_process(transport).await });
		let hello = client
			.hello(pb::ClientHello {
				client: "sandbox-state".to_owned(),
				schema_rev: omp_proto::SCHEMA_REV,
				..pb::ClientHello::default()
			})
			.await
			.expect("hello");
		let probed = server.exec.sandbox_state();
		assert_eq!(hello.sandbox_state(), probed.to_wire(), "{mode:?}: {probed:?}");
		if mode == ExecSandboxMode::Off {
			assert_eq!(probed, crate::admission::SandboxState::Off);
		}
		#[cfg(target_os = "macos")]
		if mode == ExecSandboxMode::WorkspaceWrite
			&& omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available()
		{
			assert_eq!(probed, crate::admission::SandboxState::Active);
		}
		drop(client);
		serving.abort();
	}
}

#[test]
fn unknown_tool_errors_explain_daemon_settings_and_eval_restart() {
	assert_eq!(
		unknown_tool_message("read"),
		"tool name and revision are not registered; project daemon settings differ; restart omp \
		 envd after changing tool settings"
	);
	assert_eq!(
		unknown_tool_message("eval"),
		"eval is disabled; restart the project daemon with --py-eval (omp envd)"
	);
}
#[test]
fn eval_reset_is_environment_only() {
	assert!(requires_environment_host(&client_frame::Body::EvalReset(pb::EvalResetRequest {}),));
}

#[test]
fn blob_io_is_available_on_session_hosts() {
	assert!(!requires_environment_host(&client_frame::Body::BlobStat(
		blob_pb::StatRequest::default(),
	)));
	assert!(!requires_environment_host(&client_frame::Body::BlobGet(
		blob_pb::GetRequest::default(),
	)));
	assert!(!requires_environment_host(&client_frame::Body::BlobPutChunk(
		blob_pb::Chunk::default(),
	)));
	assert!(!requires_environment_host(&client_frame::Body::BlobPutCommit(
		pb::CommitBlobPut::default(),
	)));
	assert!(!requires_environment_host(&client_frame::Body::BlobDelete(
		blob_pb::DeleteRequest::default(),
	)));
}

/// Aborts and policy denials are terminal verdicts too: `env.proto` keeps
/// every whole `CallOutcome` in the environment CAS, and the client
/// rejects a verdict without its blob and projection as "an invalid
/// outcome artifact" instead of reporting the abort.
#[tokio::test]
async fn abort_and_policy_verdicts_carry_their_cas_blob_and_projection() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blob host");
	let invocation_id = Str::new_static("call-1");
	for output_request in [omp_tool::OutputRequest::Bounded, omp_tool::OutputRequest::Complete] {
		let delivery = VerdictDelivery {
			blobs: blobs.clone(),
			retention_session: Some(Str::new_static("session-1")),
			output_request,
		};
		let (responses, frames) = flume::unbounded();
		send_abort_verdict(&responses, 7, &invocation_id, &delivery, omp_tool::Abort::Interrupted {
			reason: Str::new_static("bash command was cancelled"),
		})
		.await;
		send_policy_denied_verdict(
			&responses,
			8,
			&invocation_id,
			&delivery,
			policy_pb::PolicyDenied { reason: "denied by policy".to_owned(), ..Default::default() },
		)
		.await;
		for request_id in [7, 8] {
			let frame = frames.recv_async().await.expect("verdict frame");
			assert_eq!(frame.request_id, request_id);
			let Some(server_frame::Body::Verdict(verdict)) = frame.body else {
				panic!("expected a verdict frame");
			};
			assert!(verdict.is_error);
			let details = verdict.details_blob.expect("verdict names its CAS blob");
			let projection = verdict
				.projection
				.expect("verdict carries projection facts");
			let size = u64::try_from(verdict.json.len()).expect("size");
			assert_eq!(details.mime, "application/json");
			assert!(details.inline.is_empty());
			assert_eq!(details.size, size);
			assert_eq!(details.hash.as_ref(), Hash32::sum(&verdict.json).as_bytes());
			let stored = blobs
				.worker_verdict_store()
				.get(&omp_journal::blob::BlobRef::from(BlobId {
					hash: details.hash.as_ref().try_into().expect("digest"),
					size: details.size,
				}))
				.expect("verdict bytes live in the CAS");
			assert_eq!(stored.as_ref(), verdict.json.as_ref());
			assert_eq!(projection.request, match output_request {
				omp_tool::OutputRequest::Bounded => pb::OutputRequest::Bounded as i32,
				omp_tool::OutputRequest::Complete => pb::OutputRequest::Complete as i32,
			});
			assert_eq!((projection.source_bytes, projection.inline_bytes), (size, size));
			assert!(!projection.omitted);
			assert_eq!(projection.artifact.as_ref(), Some(&details));
			let outcome: CallOutcome<serde_json::Value, serde_json::Value> =
				serde_json::from_slice(&verdict.json).expect("inline CallOutcome");
			assert!(!matches!(outcome, CallOutcome::Ok(_)));
		}
	}
}

const OK_VERDICT: &[u8] = br#"{"kind":"ok","value":null}"#;
const FAULTED_VERDICT: &[u8] = br#"{"kind":"faulted","value":null}"#;

/// A native tool whose projection is one text part of `bytes` bytes.
struct SizedProjection {
	spec:  omp_tool::ToolSpec,
	bytes: usize,
}

impl omp_tool::Tool for SizedProjection {
	type Fault = serde_json::Value;
	type Params = serde_json::Value;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		_params: IncomingParams<'c>,
	) -> impl futures::Stream<
		Item = omp_tool::Ev<serde_json::Value, serde_json::Value, serde_json::Value>,
	> + Send
	+ 'c {
		futures::stream::empty()
	}

	fn prompt(
		&self,
		_view: Result<&serde_json::Value, &serde_json::Value>,
		_caps: &PromptCaps,
	) -> Vec<omp_tool::Part> {
		vec![omp_tool::Part::Text { text: Str::new("x".repeat(self.bytes)) }]
	}

	fn projection(
		&self,
		view: Result<&serde_json::Value, &serde_json::Value>,
		caps: &PromptCaps,
	) -> omp_tool::PromptProjection {
		let parts = self.prompt(view, caps);
		let visibility = if self.bytes == 0 {
			Vec::new()
		} else {
			vec![
				omp_tool::ProjectionSpan {
					part:       0,
					start_byte: 0,
					end_byte:   1,
					source_key: sf!("source"),
					line:       1,
				},
				omp_tool::ProjectionSpan {
					part:       0,
					start_byte: self.bytes - 1,
					end_byte:   self.bytes,
					source_key: sf!("source"),
					line:       2,
				},
			]
		};
		omp_tool::PromptProjection { parts, visibility }
	}

	fn authorize_visibility(
		&self,
		view: Result<&serde_json::Value, &serde_json::Value>,
		_receipt: &omp_tool::VisibilityReceipt,
	) -> Result<(), omp_tool::ProjectionAuthorizationError> {
		if view.is_ok_and(|value| value == &serde_json::Value::Bool(true)) {
			return Err(omp_tool::ProjectionAuthorizationError::new(std::io::Error::from(
				std::io::ErrorKind::PermissionDenied,
			)));
		}
		Ok(())
	}
}

/// A registry holding one [`SizedProjection`], and its identity.
fn sized_projection(bytes: usize) -> (Registry, ToolIdentity) {
	let spec = omp_tool::ToolSpec {
		name:            sf!("sized"),
		rev:             omp_tool::Rev { family: Str::default(), n: 1 },
		description:     sf!("projects one sized text part"),
		schema:          Bytes::from_static(br#"{"type":"object"}"#),
		constraint:      omp_tool::Constraint::None,
		effects:         Effects::empty(),
		confinement:     Confinement::Host,
		projection_code: [0; 32],
	};
	let identity = spec.identity();
	let mut registry = Registry::new();
	registry
		.register(SizedProjection { spec, bytes }, omp_tool::Presentation::Slot, omp_tool::Claims {
			precedence: omp_tool::Precedence::DEFAULT,
			claimant:   sf!("omp/test"),
			replaces:   None,
		})
		.expect("register the sized projection");
	(registry, identity)
}

/// Publishes `json` as the native outcome of `identity` and returns the
/// verdict frame.
async fn publish_native_outcome(
	blobs: &BlobHost,
	registry: &Registry,
	identity: &ToolIdentity,
	output_request: omp_tool::OutputRequest,
	json: &'static [u8],
) -> pb::Verdict {
	let delivery = VerdictDelivery {
		blobs: blobs.clone(),
		retention_session: Some(Str::new_static("session-1")),
		output_request,
	};
	let (responses, frames) = flume::unbounded();
	send_native_outcome(
		&responses,
		7,
		&Str::new_static("call-1"),
		identity,
		registry,
		&delivery,
		ErasedOutcome::Done { verdict: Bytes::from_static(json), useless: false },
	)
	.await;
	let frame = frames.recv_async().await.expect("verdict frame");
	let Some(server_frame::Body::Verdict(verdict)) = frame.body else {
		panic!("expected a verdict frame");
	};
	verdict
}

#[tokio::test]
async fn native_verdict_transports_only_host_retained_visibility() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blobs");
	let (registry, identity) = sized_projection(DEFAULT_RESULT_PROJECTION_BYTES + 10);
	let verdict = publish_native_outcome(
		&blobs,
		&registry,
		&identity,
		omp_tool::OutputRequest::Bounded,
		OK_VERDICT,
	)
	.await;
	assert_eq!(verdict.visibility, [pb::ProjectionSpan {
		part:       0,
		start_byte: 0,
		end_byte:   1,
		source_key: "source".to_owned(),
		line:       1,
	}]);
	let round_trip = pb::Verdict::decode(verdict.encode_to_vec().as_slice()).expect("wire verdict");
	assert_eq!(round_trip.visibility, verdict.visibility);
}

#[tokio::test]
async fn native_verdict_without_candidates_transports_empty_visibility() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blobs");
	let (registry, identity) = sized_projection(0);
	let verdict = publish_native_outcome(
		&blobs,
		&registry,
		&identity,
		omp_tool::OutputRequest::Bounded,
		OK_VERDICT,
	)
	.await;
	assert!(verdict.visibility.is_empty());
}

#[test]
fn host_visibility_remaps_candidates_after_a_dropped_part() {
	let mut parts = vec![
		thread_pb::Part {
			kind: Some(thread_pb::part::Kind::Blob(thread_pb::Blob {
				mime: "x".repeat(DEFAULT_RESULT_PROJECTION_BYTES + 1),
				..Default::default()
			})),
		},
		wire_text("alpha".to_owned()),
	];
	let mut spans = vec![pb::ProjectionSpan {
		part:       1,
		start_byte: 0,
		end_byte:   5,
		source_key: "source".to_owned(),
		line:       1,
	}];
	project_wire_parts_with_visibility(&mut parts, &mut spans, omp_tool::OutputRequest::Bounded);
	assert_eq!(spans[0].part, 0);
	assert_eq!(parts.len(), 1);
}

fn visibility_request(
	identity: &ToolIdentity,
	verdict: &'static [u8],
	lines: Vec<pb::VisibleSourceLine>,
) -> pb::VisibilityAuthorization {
	pb::VisibilityAuthorization {
		name: identity.name.as_str().to_owned(),
		rev: identity.rev.to_string(),
		verdict: Bytes::from_static(verdict),
		lines,
	}
}

#[test]
fn host_authorizes_populated_visibility_receipt() {
	let (registry, identity) = sized_projection(5);
	let request = visibility_request(&identity, OK_VERDICT, vec![pb::VisibleSourceLine {
		source_key: "source".to_owned(),
		line:       1,
	}]);
	assert!(authorize_visibility_receipt(&registry, request).is_ok());
}

#[test]
fn host_authorizes_empty_visibility_receipt() {
	let (registry, identity) = sized_projection(5);
	assert!(
		authorize_visibility_receipt(
			&registry,
			visibility_request(&identity, OK_VERDICT, Vec::new())
		)
		.is_ok()
	);
}

#[test]
fn host_rejects_malformed_and_legacy_visibility_verdicts() {
	let (registry, identity) = sized_projection(5);
	for verdict in [b"not json".as_slice(), br#"{"text":"legacy"}"#.as_slice()] {
		assert!(matches!(
			authorize_visibility_receipt(
				&registry,
				visibility_request(&identity, verdict, Vec::new())
			),
			Err((pb::ProtocolErrorCode::InvalidArgument, _))
		));
	}
}

#[test]
fn host_propagates_visibility_authority_rejection() {
	let (registry, identity) = sized_projection(5);
	let request = visibility_request(&identity, br#"{"kind":"ok","value":true}"#, Vec::new());
	assert!(matches!(
		authorize_visibility_receipt(&registry, request),
		Err((pb::ProtocolErrorCode::PermissionDenied, _))
	));
}

#[test]
fn host_rejects_visibility_for_an_unprojected_source_line() {
	let (registry, identity) = sized_projection(5);
	let request = visibility_request(&identity, OK_VERDICT, vec![pb::VisibleSourceLine {
		source_key: "other".to_owned(),
		line:       1,
	}]);
	assert!(matches!(
		authorize_visibility_receipt(&registry, request),
		Err((pb::ProtocolErrorCode::PermissionDenied, _))
	));
}

#[test]
fn host_rejects_visibility_for_a_different_tool_revision() {
	let (registry, identity) = sized_projection(5);
	let mut request = visibility_request(&identity, OK_VERDICT, Vec::new());
	request.rev = "other@9".to_owned();
	assert!(matches!(
		authorize_visibility_receipt(&registry, request),
		Err((pb::ProtocolErrorCode::PreconditionFailed, _))
	));
}

#[test]
fn host_rejects_visibility_with_invalid_line_identity() {
	let (registry, identity) = sized_projection(5);
	for (source_key, line) in [("source", 0), ("", 1)] {
		let request = visibility_request(&identity, OK_VERDICT, vec![pb::VisibleSourceLine {
			source_key: source_key.to_owned(),
			line,
		}]);
		assert!(matches!(
			authorize_visibility_receipt(&registry, request),
			Err((pb::ProtocolErrorCode::InvalidArgument, _))
		));
	}
}

/// The registry's shared projection cache keeps at most 4 MiB and declines
/// a larger projection. A native result that large still reaches the model:
/// whole under a complete output request, bounded under a bounded one. Its
/// completed call is never republished as an effects-unknown abort.
#[tokio::test]
async fn native_projections_the_cache_declines_still_reach_the_model() {
	const PROJECTION_CACHE_BYTES: usize = 4 * 1024 * 1024;
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blob host");
	let (registry, identity) = sized_projection(PROJECTION_CACHE_BYTES + 1);
	for output_request in [omp_tool::OutputRequest::Complete, omp_tool::OutputRequest::Bounded] {
		let verdict =
			publish_native_outcome(&blobs, &registry, &identity, output_request, OK_VERDICT).await;
		assert_eq!(verdict.json.as_ref(), OK_VERDICT, "the tool's own outcome is published");
		assert!(!verdict.is_error, "{output_request:?}: the verdict agrees with its outcome");
		let text = verdict_text(&verdict);
		assert!(text.bytes().all(|byte| byte == b'x'), "{output_request:?}: the tool's text");
		match output_request {
			omp_tool::OutputRequest::Complete => assert_eq!(
				text.len(),
				PROJECTION_CACHE_BYTES + 1,
				"the whole projection reaches the model"
			),
			omp_tool::OutputRequest::Bounded => assert!(
				!text.is_empty() && text.len() <= DEFAULT_RESULT_PROJECTION_BYTES,
				"a bounded projection reaches the model: {} bytes",
				text.len()
			),
		}
	}
}

/// A native verdict its tool cannot project (here, one published under a
/// revision the registry does not hold) is still the tool's own completed
/// outcome: it is published unchanged, with its own error flag and a
/// harness note for the model, never as an effects-unknown abort.
#[tokio::test]
async fn unprojectable_native_verdicts_keep_their_own_outcome() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blob host");
	let (registry, identity) = sized_projection(1);
	let unregistered =
		ToolIdentity { name: identity.name, rev: omp_tool::Rev { family: Str::default(), n: 2 } };
	for (json, is_error) in [(OK_VERDICT, false), (FAULTED_VERDICT, true)] {
		let verdict = publish_native_outcome(
			&blobs,
			&registry,
			&unregistered,
			omp_tool::OutputRequest::Bounded,
			json,
		)
		.await;
		assert_eq!(verdict.json.as_ref(), json, "the tool's own outcome is published");
		assert_eq!(verdict.is_error, is_error, "the error flag follows the outcome");
		assert_eq!(verdict_text(&verdict), UNPROJECTED_NATIVE_RESULT);
	}
}

#[tokio::test]
async fn environment_host_acknowledges_eval_reset() {
	let (requests, responses, _root, _state) = test_connection(&[], false).await;
	requests
		.send_async(pb::ClientFrame {
			request_id: 1,
			body: Some(client_frame::Body::EvalReset(pb::EvalResetRequest {})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send eval reset");
	assert!(matches!(
		responses
			.recv_async()
			.await
			.expect("eval reset response")
			.body,
		Some(server_frame::Body::EvalReset(pb::EvalResetResponse {}))
	));
}

/// An approval or reflection answer is a continuation of its query's
/// request and is valid on every host kind, so a session-only host never
/// refuses it with an error that would end the issuing request's stream.
#[test]
fn relayed_answers_reach_every_host_kind() {
	assert!(!requires_environment_host(&client_frame::Body::ApprovalAnswer(
		pb::ApprovalAnswer::default(),
	)));
	assert!(!requires_environment_host(&client_frame::Body::ReflectionAnswer(
		pb::ReflectionAnswer::default(),
	)));
}

#[tokio::test]
async fn stray_approval_answer_is_dropped_without_a_reply() {
	let (requests, responses, _root, _state) = test_connection(&[], false).await;
	let answer = pb::ApprovalAnswer {
		query_id: 1,
		decision: Some(pb::ApprovalDecision {
			approved: true,
			scope: "once".into(),
			source: "user".into(),
			..pb::ApprovalDecision::default()
		}),
	};
	for frame in [
		pb::ClientFrame {
			request_id: 5,
			body: Some(client_frame::Body::ApprovalAnswer(answer)),
			..pb::ClientFrame::default()
		},
		pb::ClientFrame {
			request_id: 4,
			body: Some(client_frame::Body::ReflectionAnswer(pb::ReflectionAnswer {
				query_id: 1,
				body:     Some(pb::reflection_answer::Body::Answer("stray".into())),
			})),
			..pb::ClientFrame::default()
		},
		pb::ClientFrame {
			request_id: 6,
			body: Some(client_frame::Body::EvalReset(pb::EvalResetRequest {})),
			..pb::ClientFrame::default()
		},
	] {
		requests.send_async(frame).await.expect("send frame");
	}
	let frame = responses.recv_async().await.expect("eval reset response");
	assert_eq!(frame.request_id, 6, "the stray approval answer drew a reply: {:?}", frame.body);
	assert!(matches!(frame.body, Some(server_frame::Body::EvalReset(pb::EvalResetResponse {}))));
}

/// An approval answer rides the live request of the command that raised the
/// query, so it is a continuation of that request: it must not be refused
/// as a duplicate open, whose error would end the command's stream.
#[tokio::test]
async fn approval_answer_on_an_open_request_draws_no_reply() {
	const WAIT: std::time::Duration = std::time::Duration::from_secs(5);
	let (requests, responses, root, _state) = test_external_connection(&[], false).await;
	let next = async || {
		tokio::time::timeout(WAIT, responses.recv_async())
			.await
			.expect("server frame timed out")
			.expect("server frame")
	};
	requests
		.send_async(pb::ClientFrame {
			request_id: 1,
			body: Some(client_frame::Body::OpenSession(pb::OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
				..pb::OpenSessionRequest::default()
			})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send open session");
	let opened = next().await;
	let Some(server_frame::Body::SessionOpened(opened)) = opened.body else {
		panic!("session did not open: {:?}", opened.body);
	};
	requests
		.send_async(pb::ClientFrame {
			request_id: 2,
			body: Some(client_frame::Body::Exec(pb::ExecRequest {
				session: opened.session,
				source: Some(pb::Script { text: "sleep 30".to_owned(), ..pb::Script::default() }),
				..pb::ExecRequest::default()
			})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send exec");
	let started = next().await;
	assert_eq!(started.request_id, 2);
	assert!(
		matches!(started.body, Some(server_frame::Body::ExecStarted(_))),
		"exec did not start: {:?}",
		started.body
	);

	for frame in [
		pb::ClientFrame {
			request_id: 2,
			body: Some(client_frame::Body::ApprovalAnswer(pb::ApprovalAnswer {
				query_id: 1,
				decision: Some(pb::ApprovalDecision {
					approved: true,
					scope: "once".into(),
					source: "user".into(),
					..pb::ApprovalDecision::default()
				}),
			})),
			..pb::ClientFrame::default()
		},
		pb::ClientFrame {
			request_id: 3,
			body: Some(client_frame::Body::EvalReset(pb::EvalResetRequest {})),
			..pb::ClientFrame::default()
		},
	] {
		requests.send_async(frame).await.expect("send frame");
	}
	loop {
		let frame = next().await;
		assert!(
			!matches!(frame.body, Some(server_frame::Body::Error(_))),
			"the approval answer on the open exec drew an error: {frame:?}"
		);
		if frame.request_id == 3 {
			assert!(matches!(
				frame.body,
				Some(server_frame::Body::EvalReset(pb::EvalResetResponse {}))
			));
			break;
		}
	}

	requests
		.send_async(pb::ClientFrame {
			request_id: 0,
			body: Some(client_frame::Body::Cancel(pb::CancelRequest {
				target: Some(pb::cancel_request::Target::TargetRequestId(2)),
				..pb::CancelRequest::default()
			})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send exec cancel");
	loop {
		let frame = next().await;
		if frame.request_id == 2 && matches!(frame.body, Some(server_frame::Body::Exit(_))) {
			break;
		}
		assert!(
			!matches!(frame.body, Some(server_frame::Body::Error(_))),
			"cancelling the exec drew an error: {frame:?}"
		);
	}
}

/// The approval-relay capability is a client feature: an application
/// connection that advertises only it keeps its default grants and can
/// still dispatch invocations.
#[tokio::test]
async fn approval_relay_capability_keeps_application_grants() {
	let (requests, responses, _root, _state) =
		test_external_connection(&[omp_env::APPROVAL_RELAY_CAPABILITY], false).await;
	requests
		.send_async(pb::ClientFrame {
			request_id: 7,
			body: Some(client_frame::Body::InvokeTool(pb::InvokeTool {
				invocation_id: "relay-client-invoke".into(),
				name: "no-such-tool".into(),
				rev: "1".into(),
				..pb::InvokeTool::default()
			})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send invoke");
	let frame = responses.recv_async().await.expect("invoke response");
	let Some(server_frame::Body::Error(error)) = frame.body else {
		panic!("an unknown tool was not refused: {:?}", frame.body);
	};
	// The invocation grant gate passed; tool lookup refused the name.
	assert_eq!(error.code, pb::ProtocolErrorCode::NotFound as i32, "{}", error.message);
}

/// Owner-local connections may run eval on this host; extension-host
/// connections are the one class the eval guard still rejects.
#[tokio::test]
async fn host_keyed_connections_cannot_invoke_eval() {
	let (requests, responses, _root, _state) = test_connection(&["invocation"], false).await;
	requests
		.send_async(pb::ClientFrame {
			request_id: 7,
			body: Some(client_frame::Body::InvokeTool(pb::InvokeTool {
				invocation_id: "host-eval-denied".into(),
				name: "eval".into(),
				rev: "1".into(),
				..pb::InvokeTool::default()
			})),
			..pb::ClientFrame::default()
		})
		.await
		.expect("send eval invoke");
	let frame = responses.recv_async().await.expect("eval denial response");
	let Some(server_frame::Body::Error(error)) = frame.body else {
		panic!("host-keyed eval invoke was not denied: {:?}", frame.body);
	};
	assert_eq!(error.code, pb::ProtocolErrorCode::PermissionDenied as i32);
	assert_eq!(error.message, "eval is denied to extension-host connections");
}

#[tokio::test]
async fn edit_repair_route_sends_typed_query_and_accepts_matching_answer() {
	use omp_tools::edit::observer::EditRepairPrompt;

	let (responses, queries) = flume::unbounded();
	let route = ConnectionEditRepairRoute {
		request_id: 41,
		invocation_id: sf!("inv-41"),
		responses,
		next_query: Arc::new(AtomicU64::new(1)),
		pending: Arc::new(Mutex::new(None)),
	};
	let completion = tokio::spawn({
		let route = route.clone();
		async move {
			route
				.complete(EditRepairPrompt {
					language:         sf!("rust"),
					before:           Str::new_static("fn ok() {}"),
					after:            Str::new_static("fn bad( {}"),
					previous_attempt: None,
				})
				.await
		}
	});
	let query = queries.recv_async().await.expect("repair query");
	assert_eq!(query.request_id, 41);
	let Some(server_frame::Body::EditRepairQuery(query)) = query.body else {
		panic!("expected typed edit repair query");
	};
	assert_eq!(query.invocation_id, "inv-41");
	assert_eq!(query.prompt.expect("prompt").language, "rust");
	route
		.answer(pb::EditRepairAnswer {
			invocation_id: "inv-41".to_owned(),
			body:          Some(pb::edit_repair_answer::Body::Content("fn fixed() {}".to_owned())),
		})
		.expect("matching answer");
	assert_eq!(completion.await.expect("completion task"), Ok(Str::new_static("fn fixed() {}")));
	assert!(matches!(
		route.answer(pb::EditRepairAnswer {
			invocation_id: "inv-41".to_owned(),
			body:          Some(pb::edit_repair_answer::Body::Content("duplicate".to_owned())),
		}),
		Err((pb::ProtocolErrorCode::PreconditionFailed, _))
	));
}

#[tokio::test]
async fn edit_repair_route_rejects_cross_invocation_and_disconnects_pending() {
	use omp_tools::edit::observer::{EditRepairError, EditRepairPrompt};

	let (responses, queries) = flume::unbounded();
	let route = ConnectionEditRepairRoute {
		request_id: 9,
		invocation_id: sf!("inv-9"),
		responses,
		next_query: Arc::new(AtomicU64::new(1)),
		pending: Arc::new(Mutex::new(None)),
	};
	let completion = tokio::spawn({
		let route = route.clone();
		async move {
			route
				.complete(EditRepairPrompt {
					language:         sf!("typescript"),
					before:           sf!("const a = 1;"),
					after:            sf!("const a = ;"),
					previous_attempt: None,
				})
				.await
		}
	});
	queries.recv_async().await.expect("repair query");
	assert!(matches!(
		route.answer(pb::EditRepairAnswer {
			invocation_id: "other-invocation".to_owned(),
			body:          Some(pb::edit_repair_answer::Body::Content("crossed".to_owned())),
		}),
		Err((pb::ProtocolErrorCode::InvalidArgument, _))
	));
	route.disconnect();
	assert_eq!(completion.await.expect("completion task"), Err(EditRepairError::Unavailable));
}

async fn test_connection(
	capabilities: &[&str],
	with_dap: bool,
) -> (flume::Sender<pb::ClientFrame>, Receiver<pb::ServerFrame>, tempfile::TempDir, tempfile::TempDir)
{
	let host = HostKey::new("workspace", "sandboxed", "envd-test");
	test_connection_scoped(capabilities, with_dap, host.clone(), host, true).await
}

async fn test_external_connection(
	capabilities: &[&str],
	with_dap: bool,
) -> (flume::Sender<pb::ClientFrame>, Receiver<pb::ServerFrame>, tempfile::TempDir, tempfile::TempDir)
{
	let host = HostKey::new("workspace", "sandboxed", "envd-test");
	test_connection_scoped(capabilities, with_dap, host.clone(), host, false).await
}

async fn test_connection_scoped(
	capabilities: &[&str],
	with_dap: bool,
	policy_host: HostKey,
	authority_host: HostKey,
	extension_policy: bool,
) -> (flume::Sender<pb::ClientFrame>, Receiver<pb::ServerFrame>, tempfile::TempDir, tempfile::TempDir)
{
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let workspace = WorkspaceHost::open(root.path()).expect("workspace host");
	let document_config = ServerConfig::new(root.path())
		.expect("document config")
		.with_server_build("envd-test");
	let document_environment = Environment::new(document_config).expect("document environment");
	if with_dap {
		install_test_dap(&document_environment).await;
	}
	let (document_client, document_server) = duplex(64 * 1024);
	tokio::spawn(async move {
		let _ =
			serve_connection(document_environment, document_server, ConnectionConfig::default()).await;
	});
	let documents = DocumentHost::connect(document_client)
		.await
		.expect("document host");
	let hello = documents.hello().clone();
	let exec = ExecHost::new();
	let blobs = BlobHost::open(state.path().join("blobs")).expect("blob host");
	let schedules = DurableScheduleActor::spawn(state.path()).expect("durable schedule actor");
	let workspace_ops = WorkspaceOperations::open(
		workspace.clone(),
		documents.clone(),
		blobs.clone(),
		state.path().join("workspace-ops"),
	)
	.expect("workspace operations");
	let ext_hosts = ExtHostSupervisor::spawn(ExtHostConfig::new(
		PathBuf::from("unused"),
		Principal::new(sf!("test-principal"), sf!("Test Principal")),
		sf!("test-session"),
		1,
	))
	.await
	.expect("empty extension supervisor");
	let memory_runtime = start_memory_runtime(
		&HostSettings::default(),
		state.path(),
		workspace.root(),
		&sf!("test-session"),
	)
	.await
	.expect("memory runtime");
	let mcp = McpService::open(state.path().join("mcp-cache.sqlite3")).expect("MCP service");
	let mcp_manager = McpManager::new(
		Arc::clone(&mcp),
		Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
		Arc::from([hello.root_uri.clone()]),
		state.path().join("mcp-local"),
	);
	mcp.bind_manager(&mcp_manager);
	let server = Arc::new(EnvServer::new(
		ServerIdentity {
			workspace_id:    hello.workspace_id,
			root_uri:        hello.root_uri,
			server_epoch:    hello.server_epoch,
			server_version:  sf!("test"),
			server_build:    sf!("envd-test"),
			policy:          crate::daemon_policy::from_con(&Ctx::new(), WorkspaceTrust::Untrusted),
			workspace_trust: WorkspaceTrust::Untrusted,
		},
		Some(EnvironmentAuthorities {
			documents,
			_document_authority: None,
			workspace_ops,
			lsp_settings: LspSettings::default(),
			process_store: ProcessStore::new(state.path().join("processes/meta.json")),
		}),
		ToolSettings::default(),
		exec,
		workspace.clone(),
		mcp,
		mcp_manager,
		Arc::new(ResolverTable::default()),
		memory_runtime,
		blobs.clone(),
		SiteMaterializer::open(state.path().join("ext"), blobs.store().clone())
			.expect("site materializer"),
		ResourceMaterializer::open(
			workspace.root(),
			state.path(),
			&state.path().join("sessions/test/local"),
			blobs.store().clone(),
		)
		.expect("resource materializer"),
		Arc::new(Registry::new()),
		PresenterSlot::new(Arc::new(omp_tools::ask::HeadlessPresenter)),
		Arc::new(ext_hosts),
		Arc::new(SessionBridgeHost::new()),
		Arc::new(ReflectionBridgeHost::new()),
		EvalSessionControl::default(),
		Arc::new(SearchBridgeHost::new(None)),
		Arc::new(ForgeCredentialBridge::new()),
		omp_ai::operation::usage::UsageFetcherRegistry::default(),
		omp_ai::ProviderResponseHooks::default(),
		Arc::new(HookGate::channel().0),
		AgentCheckpointControl::default(),
		StagedProposalRegistry::new(),
		schedules,
		Arc::new(AuthorityTable::default()),
		state.path(),
		#[cfg(feature = "cap-forge")]
		crate::forge_adapter::LiveForgeDeviceClient::default(),
		#[cfg(feature = "cap-ci")]
		crate::forge_adapter::LiveCiDeviceClient::default(),
	));
	let grants = Grants::supported(capabilities.iter().copied());
	server
		.authority
		.register_host(authority_host.clone(), grants.clone());
	server
		.authority
		.open(authority_host.clone(), sf!("test-invocation"));
	server
		.authority
		.authorize(
			&authority_host,
			"test-invocation",
			Bytes::from_static(b"test-effect-token"),
			grants.clone(),
			100,
			1,
			1,
		)
		.expect("authorize test invocation");
	let policy = if extension_policy {
		ConnectionPolicy::extension(policy_host, grants.iter())
	} else {
		ConnectionPolicy::external(None)
	};
	let (requests, request_rx) = flume::bounded(16);
	let (responses, response_rx) = flume::bounded(16);
	tokio::spawn(async move {
		server.serve_frames(request_rx, responses, policy).await;
	});
	requests
		.send_async(pb::ClientFrame {
			request_id: 0,
			body:       Some(client_frame::Body::Hello(pb::ClientHello {
				client:        "envd-test".to_owned(),
				schema_rev:    omp_proto::SCHEMA_REV,
				capabilities:  capabilities
					.iter()
					.map(|capability| (*capability).to_owned())
					.collect(),
				client_id:     Bytes::new(),
				approval_mode: pb::ApprovalMode::Unspecified as i32,
				props:         Default::default(),
			})),
			props:      Default::default(),
			scope:      None,
		})
		.await
		.expect("send hello");
	assert!(matches!(
		response_rx.recv_async().await.expect("server hello").body,
		Some(server_frame::Body::Hello(_))
	));
	(requests, response_rx, root, state)
}

async fn install_test_dap(environment: &Environment) {
	let (client, adapter) = duplex(64 * 1024);
	tokio::spawn(fake_dap_adapter(adapter));
	let (reader, writer) = split(client);
	let session = crate::docserver::DapSession::start(
		omp_core::hex::encode_n(&TEST_DAP_SESSION_ID).as_str(),
		"test",
		crate::docserver::DapProtocol::from_streams(reader, writer),
		false,
		serde_json::Map::new(),
		None,
	)
	.await
	.expect("start fake DAP session");
	session.set_wire_grants(true, true, 4096);
	environment.dap_sessions().insert(session);
}

async fn fake_dap_adapter(stream: DuplexStream) {
	let (reader, mut writer) = split(stream);
	let mut reader = BufReader::new(reader);
	let mut next_seq = 1_i64;
	loop {
		let mut content_length = None;
		loop {
			let mut line = String::new();
			if reader
				.read_line(&mut line)
				.await
				.ok()
				.filter(|read| *read > 0)
				.is_none()
			{
				return;
			}
			if line == "\r\n" {
				break;
			}
			if let Some(length) = line.strip_prefix("Content-Length: ") {
				content_length = length.trim().parse::<usize>().ok();
			}
		}
		let Some(content_length) = content_length else {
			return;
		};
		let mut body = vec![0; content_length];
		if reader.read_exact(&mut body).await.is_err() {
			return;
		}
		let Ok(request) = serde_json::from_slice::<serde_json::Value>(&body) else {
			return;
		};
		let Some(request_seq) = request.get("seq").and_then(serde_json::Value::as_i64) else {
			continue;
		};
		let Some(command) = request.get("command").and_then(serde_json::Value::as_str) else {
			continue;
		};
		if command == "launch" {
			if write_fake_dap_message(
				&mut writer,
				&serde_json::json!({
					"seq": next_seq,
					"type": "event",
					"event": "initialized",
					"body": {},
				}),
			)
			.await
			.is_err()
			{
				return;
			}
			next_seq += 1;
		}
		if command == "variables" {
			if write_fake_dap_message(
				&mut writer,
				&serde_json::json!({
					"seq": next_seq,
					"type": "event",
					"event": "output",
					"body": {"category": "console", "output": "ready\n"},
				}),
			)
			.await
			.is_err()
			{
				return;
			}
			next_seq += 1;
		}
		let response_body = if command == "variables" {
			serde_json::json!({"variables": [{"name": "answer", "value": "42", "variablesReference": 0}]})
		} else {
			serde_json::json!({})
		};
		if write_fake_dap_message(
			&mut writer,
			&serde_json::json!({
				"seq": next_seq,
				"type": "response",
				"request_seq": request_seq,
				"command": command,
				"success": true,
				"body": response_body,
			}),
		)
		.await
		.is_err()
		{
			return;
		}
		next_seq += 1;
	}
}

async fn write_fake_dap_message<W>(writer: &mut W, message: &serde_json::Value) -> io::Result<()>
where
	W: AsyncWrite + Unpin,
{
	let body = serde_json::to_vec(message).map_err(io::Error::other)?;
	let header = format!("Content-Length: {}\r\n\r\n", body.len());
	writer.write_all(header.as_bytes()).await?;
	writer.write_all(&body).await?;
	writer.flush().await
}

fn data_frame(request_id: u64, body: data_request::Body) -> pb::ClientFrame {
	pb::ClientFrame {
		request_id,
		body: Some(client_frame::Body::Data(pb::DataRequest {
			body:  Some(body),
			props: Default::default(),
		})),
		scope: Some(pb::InvocationScope {
			invocation_id: "test-invocation".to_owned(),
			effect_token: Bytes::from_static(b"test-effect-token"),
			host_generation: 1,
			session_generation: 1,
			..Default::default()
		}),
		props: Default::default(),
	}
}

fn stat_data_frame(request_id: u64, root: &Path) -> pb::ClientFrame {
	data_frame(
		request_id,
		data_request::Body::Document(pb::DocumentOp {
			op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
				uri:             Url::from_file_path(root)
					.expect("workspace URI")
					.to_string(),
				follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
			})),
			props: Default::default(),
		}),
	)
}

async fn socket_mode_extension_server(
	root: &Path,
	state: &Path,
) -> (Arc<EnvServer>, ExtensionDataBinding) {
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root,
			state,
			Registry::new(),
			ExtHostConfig::new(
				PathBuf::from("unused"),
				Principal::new(sf!("test-principal"), sf!("Test Principal")),
				sf!("test-session"),
				1,
			),
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.expect("local environment"),
	);
	let binding = ExtensionDataBinding::scoped(
		state,
		HostKey::new("workspace", "trusted", "socket-mode"),
		"test-session",
		1,
		Grants::supported(["env.fs.read"]),
	);
	(server, binding)
}

#[tokio::test]
async fn extension_socket_is_owner_only_and_removed_on_shutdown() {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let (server, binding) = socket_mode_extension_server(root.path(), state.path()).await;
	let socket = binding.path().to_path_buf();
	let shutdown = CancellationToken::new();
	let task = tokio::spawn(Arc::clone(&server).serve_extension_uds(binding, shutdown.clone()));
	if time::timeout(Duration::from_secs(30), async {
		while !socket.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.is_err()
	{
		let serve = time::timeout(Duration::from_secs(1), task).await;
		panic!("extension socket was not published; serve result: {serve:?}");
	}
	let mode = fs::metadata(&socket)
		.expect("extension socket metadata")
		.permissions()
		.mode();
	assert_eq!(mode & 0o777, 0o600);
	let _accepted = UnixStream::connect(&socket)
		.await
		.expect("connect extension socket before teardown");
	task.abort();
	assert!(
		task
			.await
			.expect_err("aborted extension socket task unexpectedly completed")
			.is_cancelled()
	);
	assert!(!socket.exists(), "extension socket survived task teardown");
}

/// A prepared endpoint publishes its socket before any server runs, so the
/// serve future can be dropped before its first poll. The prepared endpoint
/// owns the published path from creation; nothing may leak it.
#[tokio::test]
async fn extension_socket_prepared_endpoint_is_removed_when_serve_is_dropped_unpolled() {
	use std::os::unix::fs::FileTypeExt as _;

	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let (server, mut binding) = socket_mode_extension_server(root.path(), state.path()).await;
	binding
		.prepare_endpoint()
		.expect("prepare extension endpoint");
	let socket = binding.path().to_path_buf();
	assert!(
		fs::symlink_metadata(&socket).is_ok_and(|metadata| metadata.file_type().is_socket()),
		"prepared endpoint did not publish its socket"
	);
	let serve = server.serve_extension_uds(binding, CancellationToken::new());
	drop(serve);
	assert!(
		fs::symlink_metadata(&socket).is_err(),
		"prepared extension socket survived a serve future dropped before its first poll"
	);
}

/// Drops the serve future at the first poll boundary after its socket
/// becomes reachable: publication and cleanup ownership must be one step,
/// so no cancellation point leaves a published socket nothing will remove.
#[tokio::test]
async fn extension_socket_publication_is_cancellation_safe() {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let (server, binding) = socket_mode_extension_server(root.path(), state.path()).await;
	let socket = binding.path().to_path_buf();
	{
		let serve = server.serve_extension_uds(binding, CancellationToken::new());
		tokio::pin!(serve);
		// Hang guard only; each round polls the future once and never polls
		// it again after the socket appears.
		time::timeout(Duration::from_secs(30), async {
			while !socket.exists() {
				let pending =
					future::poll_fn(|cx| std::task::Poll::Ready(serve.as_mut().poll(cx).is_pending()))
						.await;
				assert!(pending, "extension socket server returned before publishing");
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("extension socket was not published");
	}
	assert!(!socket.exists(), "extension socket survived a drop right after publication");
}

#[tokio::test]
async fn extension_policy_rejects_other_host_authority() {
	let policy_host = HostKey::new("workspace", "trusted", "extension-a");
	let authority_host = HostKey::new("workspace", "trusted", "extension-b");
	let (requests, responses, root, _state) =
		test_connection_scoped(&["env.fs.read"], false, policy_host, authority_host, true).await;
	requests
		.send_async(stat_data_frame(1, root.path()))
		.await
		.expect("send cross-host stat");
	assert!(matches!(
		responses.recv_async().await.expect("cross-host denial").body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::Uncommitted as i32
	));
}

#[tokio::test]
async fn extension_policy_denies_ungranted_operation_before_dispatch() {
	let (requests, responses, root, _state) = test_connection(&[], false).await;
	requests
		.send_async(stat_data_frame(1, root.path()))
		.await
		.expect("send ungranted stat");
	assert!(matches!(
		responses.recv_async().await.expect("grant denial").body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::PermissionDenied as i32
	));
}

#[tokio::test]
async fn extension_policy_rejects_unscoped_data() {
	let (requests, responses, root, _state) = test_connection(&["env.fs.read"], false).await;
	let body = data_request::Body::Document(pb::DocumentOp {
		op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
			uri:             Url::from_file_path(root.path())
				.expect("workspace URI")
				.to_string(),
			follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
		})),
		props: Default::default(),
	});
	requests
		.send_async(unscoped_data_frame(1, body))
		.await
		.expect("send unscoped extension stat");
	assert!(matches!(
		responses.recv_async().await.expect("unscoped denial").body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::Uncommitted as i32
	));
}

#[tokio::test]
async fn extension_policy_rejects_stale_host_generation() {
	let (requests, responses, root, _state) = test_connection(&["env.fs.read"], false).await;
	let mut frame = stat_data_frame(1, root.path());
	frame.scope.as_mut().expect("DATA scope").host_generation = 2;
	requests
		.send_async(frame)
		.await
		.expect("send stale-generation stat");
	assert!(matches!(
		responses.recv_async().await.expect("stale-generation denial").body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::PreconditionFailed as i32
	));
}

#[tokio::test]
async fn concurrent_extensions_cannot_reuse_each_others_endpoint() {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root.path(),
			state.path(),
			Registry::new(),
			ExtHostConfig::new(
				PathBuf::from("unused"),
				Principal::new(sf!("test-principal"), sf!("Test Principal")),
				sf!("test-session"),
				1,
			),
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.expect("local environment"),
	);
	let host_a = HostKey::new("workspace", "trusted", "extension-a");
	let host_b = HostKey::new("workspace", "trusted", "extension-b");
	let grants = Grants::supported(["env.fs.read"]);
	let binding_a =
		ExtensionDataBinding::scoped(state.path(), host_a.clone(), "test-session", 1, grants.clone());
	let binding_b =
		ExtensionDataBinding::scoped(state.path(), host_b.clone(), "test-session", 1, grants.clone());
	let socket_a = binding_a.path().to_path_buf();
	let socket_b = binding_b.path().to_path_buf();
	assert_ne!(socket_a, socket_b);
	let shutdown = CancellationToken::new();
	let task_a = tokio::spawn(Arc::clone(&server).serve_extension_uds(binding_a, shutdown.clone()));
	let task_b = tokio::spawn(Arc::clone(&server).serve_extension_uds(binding_b, shutdown.clone()));
	time::timeout(Duration::from_secs(2), async {
		while !socket_a.exists() || !socket_b.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("extension sockets were not published");
	for (host, invocation, token) in [
		(&host_a, "invocation-a", Bytes::from_static(b"effect-a")),
		(&host_b, "invocation-b", Bytes::from_static(b"effect-b")),
	] {
		server.authority.open(host.clone(), Str::new(invocation));
		server
			.authority
			.authorize(host, invocation, token, grants.clone(), 100, 1, 1)
			.expect("authorize extension invocation");
	}
	let hello = pb::ClientHello {
		client: "envd-extension-test".to_owned(),
		schema_rev: omp_proto::SCHEMA_REV,
		capabilities: vec!["env.fs.read".to_owned()],
		..Default::default()
	};
	let crossed = omp_env::ExtensionEnvClient::connect_uds(
		&socket_a,
		&hello,
		omp_env::DataScope::new(sf!("invocation-b"), Bytes::from_static(b"effect-b"), 1, 1),
	)
	.await
	.expect("connect B authority to A endpoint");
	let probe = root.path().join("endpoint-probe.txt");
	fs::write(&probe, b"endpoint isolation").expect("write endpoint probe");
	let request = pb::DataRequest {
		body:  Some(data_request::Body::Document(pb::DocumentOp {
			op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
				uri:             Url::from_file_path(&probe)
					.expect("workspace probe URI")
					.to_string(),
				follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
			})),
			props: Default::default(),
		})),
		props: Default::default(),
	};
	crossed
		.request(request.clone())
		.await
		.expect_err("extension B reused extension A endpoint");
	let own = omp_env::ExtensionEnvClient::connect_uds(
		&socket_b,
		&hello,
		omp_env::DataScope::new(sf!("invocation-b"), Bytes::from_static(b"effect-b"), 1, 1),
	)
	.await
	.expect("connect B authority to B endpoint");
	own.request(request)
		.await
		.expect("extension B uses its own endpoint");
	shutdown.cancel();
	task_a
		.await
		.expect("extension A socket task")
		.expect("extension A socket shutdown");
	task_b
		.await
		.expect("extension B socket task")
		.expect("extension B socket shutdown");
}

/// App-authority DATA frame: no invocation scope, so admission rides the
/// connection grants rather than the worker effect envelope.
fn unscoped_data_frame(request_id: u64, body: data_request::Body) -> pb::ClientFrame {
	pb::ClientFrame {
		request_id,
		body: Some(client_frame::Body::Data(pb::DataRequest {
			body:  Some(body),
			props: Default::default(),
		})),
		scope: None,
		props: Default::default(),
	}
}

#[tokio::test]
async fn dap_read_action_streams_output_before_revision_fenced_response() {
	let (requests, responses, _root, _state) =
		test_external_connection(&["env.dap.read", "env.dap.execute"], true).await;
	requests
		.send_async(unscoped_data_frame(
			1,
			data_request::Body::DapAction(document_pb::DapActionRequest {
				session:             Some(document_pb::DapSessionRef {
					session_id: Bytes::copy_from_slice(&TEST_DAP_SESSION_ID),
					generation: 1,
					revision:   1,
				}),
				expected_revision:   1,
				required_capability: document_pb::DapCapability::Read as i32,
				command:             "variables".to_owned(),
				arguments_json:      Bytes::from_static(b"{\"variablesReference\":0}"),
				max_response_bytes:  4096,
				timeout_ms:          0,
			}),
		))
		.await
		.expect("send DAP read action");
	let output = responses.recv_async().await.expect("DAP output event");
	assert!(matches!(
		output.body,
		Some(server_frame::Body::DataEvent(pb::DataEvent {
			body: Some(data_event::Body::DapOutput(document_pb::DapOutput {
				sequence: 1,
				ref output,
				..
			})),
			..
		})) if output.as_ref() == b"ready\n"
	));
	let response = responses.recv_async().await.expect("DAP action response");
	let Some(server_frame::Body::Data(pb::DataResponse {
		body: Some(data_response::Body::DapAction(response)),
		..
	})) = response.body
	else {
		panic!("expected DAP action response");
	};
	assert!(response.success);
	assert_eq!(response.session.expect("response session").revision, 2);
	assert!(
		response
			.body_json
			.windows(b"answer".len())
			.any(|window| window == b"answer")
	);
}

#[tokio::test]
async fn dap_mutation_is_denied_by_read_only_grants_before_session_effects() {
	let (requests, responses, _root, _state) = test_connection(&["env.dap.read"], true).await;
	requests
		.send_async(data_frame(
			1,
			data_request::Body::DapAction(document_pb::DapActionRequest {
				session:             Some(document_pb::DapSessionRef {
					session_id: Bytes::copy_from_slice(&TEST_DAP_SESSION_ID),
					generation: 1,
					revision:   1,
				}),
				expected_revision:   1,
				required_capability: document_pb::DapCapability::Execute as i32,
				command:             "continue".to_owned(),
				arguments_json:      Bytes::from_static(b"{}"),
				max_response_bytes:  4096,
				timeout_ms:          0,
			}),
		))
		.await
		.expect("send denied DAP mutation");
	assert!(matches!(
		responses.recv_async().await.expect("DAP denial").body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::PermissionDenied as i32
	));
}

#[tokio::test]
async fn repository_snapshot_returns_only_granted_canonical_root_uris() {
	let (requests, responses, root, _state) = test_connection(&["env.search"], false).await;
	omp_vcs::testing::run(root.path(), &["init", "-b", "main"]);
	requests
		.send_async(data_frame(
			1,
			data_request::Body::RepositorySnapshot(pb::RepositorySnapshotRequest {
				root_uri:          Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
				max_changed_paths: 16,
				wire_revision:     omp_proto::SCHEMA_REV,
			}),
		))
		.await
		.expect("send repository snapshot");
	let response = responses.recv_async().await.expect("snapshot response");
	let Some(server_frame::Body::Data(pb::DataResponse {
		body: Some(data_response::Body::RepositorySnapshot(snapshot)),
		..
	})) = response.body
	else {
		panic!("expected repository snapshot response");
	};
	assert_eq!(snapshot.availability, pb::RepositoryAvailability::Available as i32);
	assert_eq!(
		Url::parse(&snapshot.worktree_root_uri)
			.expect("worktree URI")
			.to_file_path()
			.expect("worktree file URI"),
		fs::canonicalize(root.path()).expect("canonical workspace")
	);
	assert_eq!(snapshot.worktree_root_uri, snapshot.primary_root_uri);
	assert!(snapshot.revision > 0);

	let outside = tempfile::tempdir().expect("outside root");
	requests
		.send_async(data_frame(
			2,
			data_request::Body::RepositorySnapshot(pb::RepositorySnapshotRequest {
				root_uri:          Url::from_directory_path(outside.path())
					.expect("outside URI")
					.to_string(),
				max_changed_paths: 0,
				wire_revision:     omp_proto::SCHEMA_REV,
			}),
		))
		.await
		.expect("send outside snapshot");
	assert!(matches!(
		responses.recv_async().await.expect("outside response").body,
		Some(server_frame::Body::Error(pb::ProtocolError {
			code,
			..
		})) if code == pb::ProtocolErrorCode::PermissionDenied as i32
	));
}

#[tokio::test]
async fn extension_unpinned_read_works_and_site_write_is_refused_even_with_grant() {
	let (requests, responses, root, _state) =
		test_connection(&["env.doc.read", "env.site"], false).await;
	let path = root.path().join("sample.txt");
	fs::write(&path, b"hello document").expect("write document");
	let uri = Url::from_file_path(&path)
		.expect("document URI")
		.to_string();
	requests
		.send_async(data_frame(
			1,
			data_request::Body::Document(pb::DocumentOp {
				op:    Some(document_op::Op::Open(document_pb::OpenDocumentRequest {
					uri,
					language_id: "text".to_owned(),
				})),
				props: Default::default(),
			}),
		))
		.await
		.expect("send open");
	let opened = responses.recv_async().await.expect("open response");
	let Some(server_frame::Body::Data(pb::DataResponse {
		body:
			Some(data_response::Body::Document(pb::DocumentResult {
				result: Some(document_result::Result::Opened(opened)),
				..
			})),
		..
	})) = opened.body
	else {
		panic!("expected document open response");
	};
	let opened_revision = opened.head.as_ref().and_then(|head| head.revision.clone());
	requests
		.send_async(data_frame(
			2,
			data_request::Body::Document(pb::DocumentOp {
				op:    Some(document_op::Op::Read(document_pb::ReadDocumentRequest {
					document:  Some(document_pb::DocumentTarget {
						target: Some(document_target::Target::LeaseId(opened.lease_id)),
					}),
					revision:  None,
					selection: Some(document_pb::ReadSelection {
						selection: Some(read_selection::Selection::Whole(
							document_pb::WholeDocument::default(),
						)),
					}),
				})),
				props: Default::default(),
			}),
		))
		.await
		.expect("send read");
	let read = responses.recv_async().await.expect("read response");
	let Some(server_frame::Body::Data(pb::DataResponse {
		body:
			Some(data_response::Body::Document(pb::DocumentResult {
				result: Some(document_result::Result::Read(read)),
				..
			})),
		..
	})) = read.body
	else {
		panic!("expected document read response");
	};
	assert_eq!(read.head.as_ref().and_then(|head| head.revision.clone()), opened_revision);
	requests
		.send_async(data_frame(3, data_request::Body::Site(env_pb::MaterializeSite::default())))
		.await
		.expect("send extension site write");
	let denied = responses.recv_async().await.expect("site refusal response");
	assert!(matches!(
		denied.body,
		Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
			if code == pb::ProtocolErrorCode::PermissionDenied as i32
	));
}

#[tokio::test]
async fn data_walk_and_search_stream_incrementally_to_completion() {
	let (requests, responses, root, _state) =
		test_connection(&["env.walk", "env.search"], false).await;
	fs::write(root.path().join("a.txt"), b"needle\n").expect("write first");
	fs::write(root.path().join("b.txt"), b"other needle\n").expect("write second");
	requests
		.send_async(data_frame(
			10,
			data_request::Body::Walk(pb::WalkRequest {
				root_uri: String::new(),
				options:  None,
				include:  Vec::new(),
				exclude:  Vec::new(),
				limit:    None,
				props:    Default::default(),
			}),
		))
		.await
		.expect("send walk");
	let mut walk_entries = 0;
	loop {
		match responses.recv_async().await.expect("walk event").body {
			Some(server_frame::Body::DataEvent(pb::DataEvent {
				body: Some(data_event::Body::WalkEntry(_)),
				..
			})) => walk_entries += 1,
			Some(server_frame::Body::DataEvent(pb::DataEvent {
				body: Some(data_event::Body::WalkComplete(_)),
				..
			})) => break,
			other => panic!("unexpected walk frame: {other:?}"),
		}
	}
	assert!(walk_entries >= 2);
	requests
		.send_async(data_frame(
			11,
			data_request::Body::Search(pb::SearchRequest {
				walk:           Some(pb::WalkRequest {
					root_uri: String::new(),
					options:  None,
					include:  Vec::new(),
					exclude:  Vec::new(),
					limit:    None,
					props:    Default::default(),
				}),
				pattern:        Bytes::from_static(b"needle"),
				case_sensitive: true,
				limit:          None,
				props:          Default::default(),
			}),
		))
		.await
		.expect("send search");
	let mut matches = 0;
	loop {
		match responses.recv_async().await.expect("search event").body {
			Some(server_frame::Body::DataEvent(pb::DataEvent {
				body: Some(data_event::Body::SearchMatch(_)),
				..
			})) => matches += 1,
			Some(server_frame::Body::DataEvent(pb::DataEvent {
				body: Some(data_event::Body::SearchComplete(_)),
				..
			})) => break,
			other => panic!("unexpected search frame: {other:?}"),
		}
	}
	assert_eq!(matches, 2);
}

#[test]
fn connection_stream_state_and_cleanup_are_isolated() {
	let grants = Grants::supported(["env.search"]);
	let authority = Arc::new(AuthorityTable::default());
	let policy = ConnectionPolicy::in_process();
	let mut first = ConnectionState::new(
		ExecHost::new(),
		accepted_hello(grants.clone(), None),
		&ToolSettings::default(),
		Arc::clone(&authority),
		&policy,
	);
	let second = ConnectionState::new(
		ExecHost::new(),
		accepted_hello(grants, None),
		&ToolSettings::default(),
		authority,
		&policy,
	);
	let cancel = CancellationToken::new();
	first
		.requests
		.insert(41, RequestState::DataStream { cancel: cancel.clone() });
	assert!(!second.requests.contains_key(&41));
	let exec = first.exec_host.clone();
	first.cancel_all(&exec);
	let state = tempfile::tempdir().expect("binding state");
	let first_binding = ExtensionDataBinding::built_in(
		state.path(),
		HostKey::new("workspace", "trusted", "first"),
		"session",
		7,
	);
	let second_binding = ExtensionDataBinding::built_in(
		state.path(),
		HostKey::new("workspace", "trusted", "second"),
		"session",
		7,
	);
	assert_ne!(first_binding.path(), second_binding.path());
	assert!(first_binding.grants().contains("env.doc.read"));
	assert!(first_binding.grants().contains("env.search"));
	assert!(!first_binding.grants().contains("*"));
	assert!(cancel.is_cancelled());
	assert!(first.requests.is_empty());
}

#[test]
fn approval_overrides_are_connection_local() {
	let grants = Grants::all();
	let authority = Arc::new(AuthorityTable::default());
	let policy = ConnectionPolicy::in_process();
	// Explicit `yolo` is respected only in a trusted workspace.
	let base = ToolSettings {
		approval_mode: ApprovalMode::AlwaysAsk,
		workspace_trust: WorkspaceTrust::Trusted,
		..ToolSettings::default()
	};
	let yolo = ConnectionState::new(
		ExecHost::new(),
		accepted_hello(grants.clone(), Some(ApprovalMode::Yolo)),
		&base,
		Arc::clone(&authority),
		&policy,
	);
	let inherited = ConnectionState::new(
		ExecHost::new(),
		accepted_hello(grants, None),
		&base,
		authority,
		&policy,
	);
	let effects = Effects {
		exec: Some(omp_tool::ExecEffects { commands: Arc::from([sf!("*")]), network: true }),
		..Effects::empty()
	};

	let sandbox = crate::admission::SandboxState::Active;

	assert_eq!(
		yolo
			.tool_settings
			.approval_for("yolo", "bash", &effects, Confinement::ExecSandbox, sandbox)
			.policy,
		crate::admission::ApprovalPolicy::Allow
	);
	assert_eq!(
		inherited
			.tool_settings
			.approval_for("inherited", "bash", &effects, Confinement::ExecSandbox, sandbox)
			.policy,
		crate::admission::ApprovalPolicy::Prompt
	);
	assert_eq!(
		base
			.approval_for("base", "bash", &effects, Confinement::ExecSandbox, sandbox)
			.policy,
		crate::admission::ApprovalPolicy::Prompt
	);
}

#[tokio::test]
async fn standalone_daemon_refuses_a_served_document_socket() {
	let root = tempfile::tempdir().expect("document workspace");
	let scratch = tempfile::tempdir().expect("scratch socket directory");
	let socket = scratch.path().join("doc.sock");

	assert!(
		ensure_document_socket_free(root.path(), &socket)
			.await
			.is_ok(),
		"absent socket must be free"
	);

	let listener = UnixListener::bind(&socket).expect("bind document socket");
	assert!(
		matches!(
			ensure_document_socket_free(root.path(), &socket).await,
			Err(EnvdError::DocumentAuthorityHeldBy { path })
				if path == root.path()
		),
		"live authority must refuse a second daemon"
	);

	// A stale socket file without a listener no longer refuses startup.
	drop(listener);
	time::timeout(Duration::from_secs(1), async {
		loop {
			if ensure_document_socket_free(root.path(), &socket)
				.await
				.is_ok()
			{
				break;
			}
			time::sleep(Duration::from_millis(1)).await;
		}
	})
	.await
	.expect("stale socket file did not become free");
}

fn hello_for(root_uri: &str, workspace_trust: ServedWorkspaceTrust) -> DocumentHello {
	DocumentHello {
		protocol_major: PROTOCOL_MAJOR,
		protocol_minor: PROTOCOL_MINOR,
		workspace_id: Bytes::new(),
		root_uri: Str::from(root_uri),
		server_epoch: Bytes::new(),
		server_build: Str::default(),
		workspace_trust,
	}
}

#[test]
fn document_authority_must_match_the_canonical_environment_root() {
	let environment = tempfile::tempdir().expect("environment root");
	let foreign = tempfile::tempdir().expect("foreign root");
	let matching = Url::from_directory_path(environment.path())
		.expect("environment file URI")
		.to_string();
	let mismatched = Url::from_directory_path(foreign.path())
		.expect("foreign file URI")
		.to_string();
	let validate = |uri: &str| {
		validate_document_authority(
			environment.path(),
			&hello_for(uri, ServedWorkspaceTrust::Untrusted),
			WorkspaceTrust::Untrusted,
		)
	};

	assert!(validate(&matching).is_ok());
	assert!(validate(&mismatched).is_err());
	assert!(validate("memory://foreign").is_err());
}

#[test]
fn document_authority_must_report_the_sessions_own_workspace_trust() {
	let environment = tempfile::tempdir().expect("environment root");
	let uri = Url::from_directory_path(environment.path())
		.expect("environment file URI")
		.to_string();
	let validate = |served, trust| {
		validate_document_authority(environment.path(), &hello_for(&uri, served), trust)
	};

	assert!(validate(ServedWorkspaceTrust::Trusted, WorkspaceTrust::Trusted).is_ok());
	assert!(validate(ServedWorkspaceTrust::Untrusted, WorkspaceTrust::Untrusted).is_ok());
	for (served, trust) in [
		(ServedWorkspaceTrust::Trusted, WorkspaceTrust::Untrusted),
		(ServedWorkspaceTrust::Untrusted, WorkspaceTrust::Trusted),
		(ServedWorkspaceTrust::Unreported, WorkspaceTrust::Untrusted),
		(ServedWorkspaceTrust::Unreported, WorkspaceTrust::Trusted),
	] {
		assert!(
			matches!(
				validate(served, trust),
				Err(EnvdError::DocumentAuthorityTrustMismatch { expected, served: reported, .. })
					if expected == trust && reported == served
			),
			"{served} authority admitted a {trust:?} session"
		);
	}
}

/// A running authority refuses a session whose workspace trust differs, in
/// both directions, and admits one whose trust matches.
#[tokio::test]
async fn a_running_document_authority_admits_only_sessions_of_its_own_trust() {
	for (owner, other) in [
		(WorkspaceTrust::Trusted, WorkspaceTrust::Untrusted),
		(WorkspaceTrust::Untrusted, WorkspaceTrust::Trusted),
	] {
		let project = tempfile::tempdir().expect("document workspace");
		let state = tempfile::tempdir().expect("document socket directory");
		let socket = state.path().join("document.sock");
		let start = |trust| {
			connect_or_start_docserver(
				project.path(),
				&socket,
				None,
				false,
				NativeLspOptions { enabled: false, ..Default::default() },
				DocumentConfigInputs {
					user_config_root: None,
					claude_plugins:   Arc::default(),
					workspace_trust:  trust,
				},
				sf!("test-build"),
			)
		};
		let (documents, authority) = start(owner).await.expect("owner session");
		assert!(authority.is_some(), "the first session must own the authority");
		let served = match owner {
			WorkspaceTrust::Trusted => ServedWorkspaceTrust::Trusted,
			WorkspaceTrust::Untrusted => ServedWorkspaceTrust::Untrusted,
		};
		assert_eq!(documents.hello().workspace_trust, served);

		let refused = start(other)
			.await
			.err()
			.expect("a session of the other trust joined");
		assert!(
			matches!(
				&refused,
				EnvdError::DocumentAuthorityTrustMismatch { expected, served: reported, .. }
					if *expected == other && *reported == served
			),
			"unexpected refusal: {refused}"
		);

		let (joined, joined_authority) = start(owner).await.expect("same-trust session");
		assert!(joined_authority.is_none(), "a matching session must join, not own");
		drop(joined);
		drop(documents);
		drop(authority);
	}
}

/// Runs on tokio's paused clock: `wait_idle` reads only tokio time, so every
/// sleep below advances virtual time deterministically and scheduler jitter
/// on a loaded host cannot move a deadline across an assertion.
#[tokio::test(start_paused = true)]
async fn idle_wait_requires_one_continuous_quiet_window() {
	let state = tempfile::tempdir().expect("daemon state");
	let window = Duration::from_millis(30);
	let (env_tx, env_rx) = watch::channel(1);
	let (docs_tx, docs_rx) = watch::channel(2);
	let busy = tokio::spawn(wait_idle(
		env_rx,
		docs_rx,
		1,
		window,
		state.path().to_path_buf(),
		sf!("same-build"),
		ExecHost::new(),
	));
	time::sleep(Duration::from_millis(5)).await;
	assert!(!busy.is_finished(), "busy environment was considered idle");
	env_tx.send_replace(0);
	time::sleep(Duration::from_millis(5)).await;
	assert!(!busy.is_finished(), "external document client was considered idle");
	docs_tx.send_replace(1);
	time::sleep(Duration::from_millis(15)).await;
	assert!(!busy.is_finished(), "idle wait resolved before its full window");
	time::sleep(Duration::from_millis(20)).await;
	busy.await.expect("idle wait task");

	let (env_tx, env_rx) = watch::channel(0);
	let (_docs_tx, docs_rx) = watch::channel(1);
	let reset = tokio::spawn(wait_idle(
		env_rx,
		docs_rx,
		1,
		window,
		state.path().to_path_buf(),
		sf!("same-build"),
		ExecHost::new(),
	));
	time::sleep(Duration::from_millis(15)).await;
	env_tx.send_replace(1);
	task::yield_now().await;
	env_tx.send_replace(0);
	time::sleep(Duration::from_millis(20)).await;
	assert!(!reset.is_finished(), "activity did not reset the idle window");
	time::sleep(Duration::from_millis(15)).await;
	reset.await.expect("reset idle wait task");
}

/// A live persistent process holds the daemon open. This phase drives a real
/// child process, which a paused clock would race past, so it keeps real
/// time and gates on a release file rather than on wall-clock durations:
/// the process stays alive until the test says otherwise, however slow the
/// host.
#[cfg(unix)]
#[tokio::test]
async fn idle_wait_stays_open_while_a_persistent_process_lives() {
	let state = tempfile::tempdir().expect("daemon state");
	let release = state.path().join("release");
	let window = Duration::from_millis(30);
	let processes = ExecHost::new();
	processes
		.start_process(env_pb::StartProcess {
			name: String::from("persistent-idle"),
			spec: Some(env_pb::ProcessSpec {
				source: Some(env_pb::Script {
					text: format!("while [ ! -e '{}' ]; do sleep 0.02; done", release.display()),
					..Default::default()
				}),
				cwd_uri: Url::from_directory_path(state.path())
					.expect("state directory URI")
					.to_string(),
				persist: true,
				..Default::default()
			}),
			..Default::default()
		})
		.await
		.expect("start persistent process");
	let (_env_tx, env_rx) = watch::channel(0);
	let (_docs_tx, docs_rx) = watch::channel(1);
	let persistent = tokio::spawn(wait_idle(
		env_rx,
		docs_rx,
		1,
		window,
		state.path().to_path_buf(),
		sf!("same-build"),
		processes,
	));
	// Several idle windows elapse while the process is held alive.
	time::sleep(window * 5).await;
	assert!(!persistent.is_finished(), "live persistent process did not hold the daemon open");
	std::fs::write(&release, b"").expect("release persistent process");
	time::timeout(Duration::from_secs(30), persistent)
		.await
		.expect("idle window did not begin after the persistent process exited")
		.expect("persistent idle task");
}

#[cfg(unix)]
#[tokio::test]
async fn spawned_document_authority_reports_discovered_lsp_roster() {
	use std::os::unix::fs::PermissionsExt as _;
	let root = tempfile::tempdir().expect("document workspace");
	let project = root.path().canonicalize().expect("canonical root");
	let server = project.join("fake-lsp.sh");
	std::fs::write(&server, "#!/bin/sh\nexit 0\n").expect("fake server");
	std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o700))
		.expect("chmod fake server");
	std::fs::write(project.join("foo.marker"), b"").expect("marker");
	std::fs::write(
		project.join(".lsp.json"),
		serde_json::to_vec(&serde_json::json!({
			"servers": {
				"fake": {
					"command": server,
					"args": [],
					"fileTypes": [".foo"],
					"rootMarkers": ["foo.marker"],
				}
			}
		}))
		.expect("encode config"),
	)
	.expect("write config");
	let state = tempfile::tempdir().expect("document socket directory");
	let socket = state.path().join("document.sock");
	let (documents, authority) = connect_or_start_docserver(
		&project,
		&socket,
		None,
		true,
		crate::docserver::NativeLspOptions { enabled: true, lazy: true, ..Default::default() },
		// A trusted workspace loads the project `.lsp.json`.
		DocumentConfigInputs {
			workspace_trust: WorkspaceTrust::Trusted,
			..DocumentConfigInputs::default()
		},
		sf!("test-build"),
	)
	.await
	.expect("spawn document authority");
	let response = documents
		.lsp_status(
			document_pb::LspStatusRequest { reload: false, start: false },
			&CancellationToken::new(),
		)
		.await
		.expect("lsp status");
	let fake = response
		.servers
		.iter()
		.find(|server| server.name == "fake")
		.expect("discovered declaration in roster");
	assert_eq!(fake.stage, document_pb::LspServerStage::Available as i32);
	assert_eq!(fake.file_types, vec![".foo".to_owned()]);
	drop(documents);
	drop(authority);
}

#[cfg(unix)]
#[tokio::test]
async fn spawned_document_authority_reports_installed_plugin_lsp_servers() {
	use std::os::unix::fs::PermissionsExt as _;

	use crate::docserver::lsp_config::tests::{installed_plugins, write};

	let scratch = tempfile::tempdir().expect("scratch");
	let scratch = scratch.path().canonicalize().expect("canonical scratch");
	let project = scratch.join("project");
	std::fs::create_dir_all(&project).expect("project");
	let mut installs = Vec::new();
	for (id, name) in [("enabled@m", "plugin-fake"), ("disabled@m", "ghost")] {
		let plugin = scratch.join(name);
		write(&plugin.join("bin/fake-lsp.sh"), "#!/bin/sh\nexit 0\n");
		std::fs::set_permissions(
			plugin.join("bin/fake-lsp.sh"),
			std::fs::Permissions::from_mode(0o700),
		)
		.expect("chmod fake server");
		write(
			&plugin.join(".lsp.json"),
			&serde_json::json!({
				name: {
					"command": "${CLAUDE_PLUGIN_ROOT}/bin/fake-lsp.sh",
					"extensionToLanguage": {".foo": "foo"},
				}
			})
			.to_string(),
		);
		installs.push((id, plugin, id.starts_with("enabled")));
	}
	let installs = installs
		.iter()
		.map(|(id, plugin, enabled)| (*id, plugin.as_path(), *enabled))
		.collect::<Vec<_>>();
	let plugins = installed_plugins(&scratch.join("data"), &installs);
	let state = tempfile::tempdir().expect("document socket directory");
	let socket = state.path().join("document.sock");
	let (documents, authority) = connect_or_start_docserver(
		&project,
		&socket,
		None,
		true,
		crate::docserver::NativeLspOptions { enabled: true, lazy: true, ..Default::default() },
		DocumentConfigInputs {
			user_config_root: None,
			claude_plugins:   plugins.plugins.into(),
			workspace_trust:  WorkspaceTrust::Untrusted,
		},
		sf!("test-build"),
	)
	.await
	.expect("spawn document authority");
	let response = documents
		.lsp_status(
			document_pb::LspStatusRequest { reload: false, start: false },
			&CancellationToken::new(),
		)
		.await
		.expect("lsp status");
	let fake = response
		.servers
		.iter()
		.find(|server| server.name == "plugin-fake")
		.expect("installed plugin declaration in roster");
	assert_eq!(fake.stage, document_pb::LspServerStage::Available as i32);
	assert_eq!(fake.source, "plugin");
	assert_eq!(fake.file_types, vec![".foo".to_owned()]);
	assert!(
		response.servers.iter().all(|server| server.name != "ghost"),
		"a disabled plugin contributed a server"
	);
	drop(documents);
	drop(authority);
}

#[tokio::test]
async fn new_build_attach_waits_for_stale_docserver_authority_to_drain() {
	let root = tempfile::tempdir().expect("document workspace");
	let state = tempfile::tempdir().expect("document socket directory");
	let socket = state.path().join("document.sock");
	let old_config = ServerConfig::new(root.path())
		.expect("old document config")
		.with_server_build("old-build");
	assert_eq!(old_config.server_build().as_str(), "old-build");

	let shutdown = CancellationToken::new();
	let serve_shutdown = shutdown.clone();
	let serve_root = root.path().to_path_buf();
	let serve_socket = socket.clone();
	let old_task = tokio::spawn(async move {
		crate::docserver::daemon::serve(
			serve_root,
			daemon::Transport::Socket(serve_socket),
			crate::docserver::daemon::ServeOptions {
				lsp_config_paths: Vec::new(),
				lsp:              crate::docserver::NativeLspOptions {
					enabled: false,
					lazy: true,
					..Default::default()
				},
				user_config_root: None,
				claude_plugins:   Arc::default(),
				workspace_trust:  WorkspaceTrust::Untrusted,
				shutdown:         Some(serve_shutdown),
				server_build:     old_config.server_build().clone(),
				connections:      None,
			},
		)
		.await
	});
	time::timeout(Duration::from_secs(2), async {
		loop {
			if let Ok(stream) = UnixStream::connect(&socket).await
				&& DocumentHost::connect_uds_stream(&socket, stream)
					.await
					.is_ok()
			{
				break;
			}
			task::yield_now().await;
		}
	})
	.await
	.expect("stale document authority did not become ready");

	let drain = shutdown.clone();
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(100)).await;
		drain.cancel();
	});
	let started = Instant::now();
	let (documents, authority) = connect_or_start_docserver(
		root.path(),
		&socket,
		None,
		false,
		crate::docserver::NativeLspOptions { enabled: false, lazy: true, ..Default::default() },
		DocumentConfigInputs::default(),
		sf!("new-build"),
	)
	.await
	.expect("new build takes document authority after stale drain");
	assert!(started.elapsed() < Duration::from_secs(5));
	assert_eq!(documents.hello().server_build.as_str(), "new-build");
	assert!(authority.is_some(), "new build did not claim document authority");

	old_task
		.await
		.expect("stale authority task")
		.expect("stale authority shutdown");
	drop(documents);
	drop(authority);
}

#[tokio::test]
async fn document_authority_collision_retries_until_holder_releases() {
	let root = tempfile::tempdir().expect("document workspace");
	let state = tempfile::tempdir().expect("document socket directory");
	let socket = state.path().join("document.sock");
	let old_config = ServerConfig::new(root.path())
		.expect("old document config")
		.with_server_build("old-build");
	let old_authority = old_config.try_lock_authority().expect("old authority");
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(100)).await;
		drop(old_authority);
	});

	let (documents, authority) = connect_or_start_docserver(
		root.path(),
		&socket,
		None,
		false,
		crate::docserver::NativeLspOptions { enabled: false, lazy: true, ..Default::default() },
		DocumentConfigInputs::default(),
		sf!("new-build"),
	)
	.await
	.expect("new document authority starts after old lock releases");
	assert_eq!(documents.hello().server_build.as_str(), "new-build");
	assert!(authority.is_some());
	drop(documents);
	drop(authority);
}

#[tokio::test]
async fn stale_daemon_does_not_rehost_after_drain() {
	let root = tempfile::tempdir().expect("document workspace");
	let state = tempfile::tempdir().expect("daemon state");
	crate::atomic_replace(&crate::launcher_build_path(state.path()), "new-build")
		.expect("publish replacement build");

	let old_config = ServerConfig::new(root.path())
		.expect("old document config")
		.with_server_build("old-build");
	let old_authority = old_config.try_lock_authority().expect("old authority");
	let socket = state.path().join("document.sock");
	let rehosted = rehost_document_authority(
		root.path(),
		state.path(),
		&socket,
		None,
		crate::docserver::NativeLspOptions { enabled: false, lazy: true, ..Default::default() },
		DocumentConfigInputs::default(),
		old_config.server_build().clone(),
	)
	.await
	.expect("stale rehost check");
	assert!(rehosted.is_none(), "stale daemon rehosted document authority");
	assert!(UnixStream::connect(&socket).await.is_err(), "stale daemon published a document socket");

	let (env_tx, env_rx) = watch::channel(1);
	let (_docs_tx, docs_rx) = watch::channel(1);
	let idle = tokio::spawn(wait_idle(
		env_rx,
		docs_rx,
		1,
		Duration::from_secs(60),
		state.path().to_path_buf(),
		old_config.server_build().clone(),
		ExecHost::new(),
	));
	time::sleep(Duration::from_millis(75)).await;
	assert!(!idle.is_finished(), "stale daemon shut down before its client drained");
	env_tx.send_replace(0);
	time::timeout(Duration::from_secs(1), idle)
		.await
		.expect("stale daemon did not shut down after its last client drained")
		.expect("idle task");

	drop(old_authority);
	let new_config = ServerConfig::new(root.path())
		.expect("new document config")
		.with_server_build("new-build");
	let _new_authority = new_config
		.try_lock_authority()
		.expect("stale daemon rehosted document authority after drain");
}
#[cfg(target_os = "macos")]
#[tokio::test]
async fn remote_exec_approval_amends_only_the_owner_command() {
	if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
		return;
	}
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	fs::create_dir(root.path().join(".git")).expect("protected carve-out");
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root.path(),
			state.path(),
			Registry::new(),
			ExtHostConfig::new(
				PathBuf::from("unused"),
				Principal::new(sf!("test-principal"), sf!("Test Principal")),
				sf!("test-session"),
				1,
			),
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.expect("owner server"),
	);
	server.exec.configure_sandbox(
		&SandboxSettings {
			mode: crate::exec_settings::ExecSandboxMode::WorkspaceWrite,
			..SandboxSettings::default()
		},
		root.path(),
	);
	let book = Arc::new(ApprovalBook::new());
	let (route, inbox) = ApprovalRoute::new(Arc::clone(&book), None);
	server.bind_approval_authority(Some(book), Some(route));
	let (client, transport) = EnvClient::in_process(64);
	let owner = Arc::clone(&server);
	let serving = tokio::spawn(async move { owner.serve_in_process(transport).await });
	client
		.hello(pb::ClientHello {
			client: "remote-scoped-amendment".to_owned(),
			schema_rev: omp_proto::SCHEMA_REV,
			..pb::ClientHello::default()
		})
		.await
		.expect("remote hello");
	let approval = tokio::spawn(async move {
		let request = inbox.recv().await.expect("owner approval");
		let reason = request.ticket.reasons.first().expect("scoped reason");
		assert_eq!(reason.kind, "sandbox_amendment");
		assert!(
			reason
				.pattern
				.as_deref()
				.is_some_and(|command| { command == "echo approved > .git/approved.txt" })
		);
		assert!(reason.subject.ends_with(".git"));
		request
			.respond(ApprovalDecision {
				approved:   true,
				scope:      ApprovalScope::Once,
				source:     ApprovalSource::User,
				decided_by: Some(sf!("test approver")),
				reason:     None,
				audited:    false,
			})
			.expect("approve exact scope");
	});
	let opened = client
		.open_session(
			&EnvPath::new(
				Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
			)
			.expect("typed workspace URI"),
			pb::OpenSessionRequest::default(),
		)
		.await
		.expect("remote session");
	let mut approved = client
		.exec(pb::ExecRequest {
			session: opened.session.clone(),
			source: Some(pb::Script {
				text: "echo approved > .git/approved.txt".to_owned(),
				..pb::Script::default()
			}),
			..pb::ExecRequest::default()
		})
		.await
		.expect("normal remote request");
	let mut starts = 0;
	let mut output = Vec::new();
	let status = loop {
		match approved
			.next_event()
			.await
			.expect("remote exec event")
			.expect("remote exec stream")
		{
			ClientExecEvent::Started(_) => starts += 1,
			ClientExecEvent::Output(frame) => output.extend_from_slice(&frame.data),
			ClientExecEvent::Exit(exit) => break exit.status.expect("terminal status"),
		}
	};
	approval.await.expect("owner approver");
	assert_eq!(starts, 1);
	assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32);
	assert_eq!(
		fs::read(root.path().join(".git/approved.txt")).expect("approved write"),
		b"approved\n"
	);
	assert!(!String::from_utf8_lossy(&output).contains("rerun with approved scope"));
	assert!(status.diags.iter().any(|diag| {
		diag
			.text
			.contains("sandbox: rerun with approved scope: write")
	}));

	let mut restored = client
		.exec(pb::ExecRequest {
			session: opened.session,
			source: Some(pb::Script {
				text: "echo blocked > .git/blocked.txt".to_owned(),
				..pb::Script::default()
			}),
			..pb::ExecRequest::default()
		})
		.await
		.expect("second normal remote request");
	let restored = loop {
		match restored
			.next_event()
			.await
			.expect("restored event")
			.expect("restored stream")
		{
			ClientExecEvent::Exit(exit) => break exit.status.expect("restored status"),
			ClientExecEvent::Started(_) | ClientExecEvent::Output(_) => {},
		}
	};
	assert_eq!(restored.outcome, pb::ExecOutcome::Denied as i32);
	assert!(!root.path().join(".git/blocked.txt").exists());
	serving.abort();
}

/// Only an application connection that advertised a capability gets its
/// relay; an extension connection never does, even when it asks, so
/// extension code cannot approve its own commands' amendments or answer its
/// own reflections.
#[test]
fn only_advertising_application_connections_get_relays() {
	let authority = Arc::new(AuthorityTable::default());
	let (responses, _frames) = flume::bounded(1);
	let connection = |hello, policy: &ConnectionPolicy| {
		let mut connection = ConnectionState::new(
			ExecHost::new(),
			hello,
			&ToolSettings::default(),
			Arc::clone(&authority),
			policy,
		);
		connection.bind_relays(&responses);
		connection
	};
	let relays = |connection: &ConnectionState| {
		(connection.owned_approvals(1).is_some(), connection.owned_reflection(1).is_some())
	};
	let application = connection(relay_hello(), &ConnectionPolicy::external(None));
	assert_eq!(relays(&application), (true, false));
	let reflecting = connection(
		AcceptedHello {
			capabilities: BTreeSet::from([
				Str::from(omp_env::APPROVAL_RELAY_CAPABILITY),
				Str::from(omp_env::REFLECTION_RELAY_CAPABILITY),
			]),
			..relay_hello()
		},
		&ConnectionPolicy::external(None),
	);
	assert_eq!(relays(&reflecting), (true, true));
	let silent = connection(accepted_hello(Grants::all(), None), &ConnectionPolicy::external(None));
	assert_eq!(relays(&silent), (false, false));
	let extension = connection(
		AcceptedHello {
			capabilities: BTreeSet::from([
				Str::from(omp_env::APPROVAL_RELAY_CAPABILITY),
				Str::from(omp_env::REFLECTION_RELAY_CAPABILITY),
			]),
			..relay_hello()
		},
		&ConnectionPolicy::extension(HostKey::new("workspace", "sandboxed", "relay"), ["env.exec"]),
	);
	assert_eq!(relays(&extension), (false, false));
}

fn relay_hello() -> AcceptedHello {
	AcceptedHello {
		grants:        Grants::all(),
		capabilities:  BTreeSet::from([Str::from(omp_env::APPROVAL_RELAY_CAPABILITY)]),
		props:         None,
		approval_mode: None,
	}
}

/// Closing a connection disconnects its relay, whether its serve loop
/// ends (`cancel_all`) or its state is dropped: a command that outlives
/// the connection, such as auto-backgrounded bash past its verdict (no
/// request left for `cancel_all` to cancel), fails its prompt closed at
/// once, and the relay stops holding the connection's response channel.
#[test]
fn closing_a_connection_disconnects_its_relay() {
	let connection = |responses: &flume::Sender<pb::ServerFrame>| {
		let mut connection = ConnectionState::new(
			ExecHost::new(),
			relay_hello(),
			&ToolSettings::default(),
			Arc::new(AuthorityTable::default()),
			&ConnectionPolicy::external(None),
		);
		connection.bind_relays(responses);
		connection
	};
	let assert_closed = |outliving: &OwnedApprovals, frames: &Receiver<pb::ServerFrame>| {
		assert!(!outliving.is_live(), "a closed connection's relay can still prompt");
		assert!(frames.is_disconnected(), "the relay kept the connection's writer alive");
		let prompt = outliving.request(
			None,
			vec![ApprovalSpec {
				title:         sf!("Approve scoped sandbox amendment"),
				body:          sf!("The sandbox denied a write."),
				subject:       sf!("/workspace/.git"),
				kind:          sf!("sandbox_amendment"),
				scopes:        vec![sf!("once")],
				default:       Some(false),
				route:         sf!("local"),
				approver:      None,
				timeout_ms:    120_000,
				unreachable:   sf!("fail_closed"),
				require_human: true,
				pattern:       Some(sf!("echo x > .git/a")),
				evidence:      Vec::new(),
			}],
			1_000,
		);
		let ticket = futures::FutureExt::now_or_never(prompt)
			.expect("a closed connection's prompt waited for an answer");
		assert_eq!(ticket.state, TicketState::Decided);
		let decision = ticket.decision.expect("decided ticket");
		assert!(!decision.approved);
		assert_eq!(decision.source, ApprovalSource::Unavailable);
		assert!(frames.is_empty(), "a closed connection's relay sent a query");
	};

	// The serve loop's close path, while the state itself is still alive.
	let (responses, frames) = flume::bounded(1);
	let mut closed = connection(&responses);
	drop(responses);
	let outliving = closed.owned_approvals(1).expect("application relay");
	assert!(outliving.is_live());
	let exec = closed.exec_host.clone();
	closed.cancel_all(&exec);
	assert_closed(&outliving, &frames);
	drop(closed);

	// A state dropped without that close path.
	let (responses, frames) = flume::bounded(1);
	let dropped = connection(&responses);
	drop(responses);
	let outliving = dropped.owned_approvals(1).expect("application relay");
	assert!(outliving.is_live());
	drop(dropped);
	assert_closed(&outliving, &frames);
}

const RELAY_WAIT: Duration = Duration::from_secs(30);

/// A project-daemon-shaped host for relay proofs: a workspace-write
/// sandbox and no in-process approval route, so a sandbox amendment can
/// reach a human only through the issuing connection's relay. `None`
/// without Seatbelt.
#[cfg(target_os = "macos")]
async fn relay_daemon() -> Option<(Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir)> {
	relay_daemon_with(SandboxSettings {
		mode: ExecSandboxMode::WorkspaceWrite,
		..SandboxSettings::default()
	})
	.await
}

/// [`relay_daemon`] under `sandbox`.
#[cfg(target_os = "macos")]
async fn relay_daemon_with(
	sandbox: SandboxSettings,
) -> Option<(Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir)> {
	relay_daemon_in(sandbox, Registry::new(), WorkspaceTrust::Untrusted).await
}

/// [`relay_daemon_with`], composing the production tools over `registry`.
#[cfg(target_os = "macos")]
async fn relay_daemon_in(
	sandbox: SandboxSettings,
	registry: Registry,
	workspace_trust: WorkspaceTrust,
) -> Option<(Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir)> {
	if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
		return None;
	}
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	fs::create_dir(root.path().join(".git")).expect("protected carve-out");
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root.path(),
			state.path(),
			registry,
			ExtHostConfig::new(
				PathBuf::from("unused"),
				Principal::new(sf!("test-principal"), sf!("Test Principal")),
				sf!("test-session"),
				1,
			),
			&con,
			convars,
			{
				let mut bridges = RegistryBridges::default();
				bridges.content.workspace_trust = workspace_trust;
				bridges
			},
		)
		.await
		.expect("daemon-shaped server"),
	);
	server.exec.configure_sandbox(&sandbox, root.path());
	Some((server, root, state))
}

/// One application connection speaking raw frames, so a test can send what
/// a well-behaved client never would (a forged answer). Dropping it closes
/// the connection.
#[cfg(target_os = "macos")]
struct RelayPeer {
	requests:  flume::Sender<pb::ClientFrame>,
	responses: Receiver<pb::ServerFrame>,
	serving:   tokio::task::JoinHandle<()>,
}

#[cfg(target_os = "macos")]
impl RelayPeer {
	async fn connect(server: &Arc<EnvServer>, capabilities: &[&str]) -> Self {
		let (requests, request_rx) = flume::bounded(16);
		let (response_tx, responses) = flume::bounded(64);
		let host = Arc::clone(server);
		let serving = tokio::spawn(async move {
			host
				.serve_frames(request_rx, response_tx, ConnectionPolicy::external(None))
				.await;
		});
		let peer = Self { requests, responses, serving };
		peer
			.send(
				0,
				client_frame::Body::Hello(pb::ClientHello {
					client: "relay-peer".to_owned(),
					schema_rev: omp_proto::SCHEMA_REV,
					capabilities: capabilities
						.iter()
						.map(|capability| (*capability).to_owned())
						.collect(),
					..pb::ClientHello::default()
				}),
			)
			.await;
		let hello = peer.next().await;
		assert!(matches!(hello.body, Some(server_frame::Body::Hello(_))), "{hello:?}");
		peer
	}

	async fn send(&self, request_id: u64, body: client_frame::Body) {
		self
			.requests
			.send_async(pb::ClientFrame { request_id, body: Some(body), ..pb::ClientFrame::default() })
			.await
			.expect("send frame");
	}

	async fn next(&self) -> pb::ServerFrame {
		time::timeout(RELAY_WAIT, self.responses.recv_async())
			.await
			.expect("server frame timed out")
			.expect("server frame")
	}

	async fn open_session(&self, request_id: u64, root: &Path) -> Bytes {
		self
			.send(
				request_id,
				client_frame::Body::OpenSession(pb::OpenSessionRequest {
					cwd_uri: Url::from_directory_path(root)
						.expect("workspace URI")
						.to_string(),
					..pb::OpenSessionRequest::default()
				}),
			)
			.await;
		let frame = self.next().await;
		let Some(server_frame::Body::SessionOpened(opened)) = frame.body else {
			panic!("session did not open: {frame:?}");
		};
		opened.session
	}

	async fn exec(&self, request_id: u64, session: &Bytes, text: &str) {
		self
			.send(
				request_id,
				client_frame::Body::Exec(pb::ExecRequest {
					session: session.clone(),
					source: Some(pb::Script { text: text.to_owned(), ..pb::Script::default() }),
					..pb::ExecRequest::default()
				}),
			)
			.await;
	}

	/// Reads `request_id`'s frames up to its approval query.
	async fn query(&self, request_id: u64) -> pb::ApprovalQuery {
		loop {
			let frame = self.next().await;
			assert_eq!(frame.request_id, request_id, "unexpected frame: {frame:?}");
			match frame.body {
				Some(server_frame::Body::ApprovalQuery(query)) => return query,
				Some(server_frame::Body::ExecStarted(_) | server_frame::Body::Output(_)) => {},
				other => panic!("expected an approval query on {request_id}, got {other:?}"),
			}
		}
	}

	async fn answer(&self, request_id: u64, query_id: u64, approved: bool) {
		self.answer_in(request_id, query_id, approved, "once").await;
	}

	async fn answer_in(&self, request_id: u64, query_id: u64, approved: bool, scope: &str) {
		self
			.send(
				request_id,
				client_frame::Body::ApprovalAnswer(pb::ApprovalAnswer {
					query_id,
					decision: Some(pb::ApprovalDecision {
						approved,
						scope: scope.to_owned(),
						source: "user".to_owned(),
						..pb::ApprovalDecision::default()
					}),
				}),
			)
			.await;
	}

	/// Reads `request_id`'s frames to its exit and returns the terminal
	/// status, its output, and the query ids withdrawn on the way. Another
	/// query, or any frame on another request, fails the test.
	async fn exit(&self, request_id: u64) -> (pb::ExecStatusMsg, Vec<u8>, Vec<u64>) {
		let mut output = Vec::new();
		let mut withdrawn = Vec::new();
		loop {
			let frame = self.next().await;
			assert_eq!(frame.request_id, request_id, "unexpected frame: {frame:?}");
			match frame.body {
				Some(server_frame::Body::Exit(exit)) => {
					return (exit.status.expect("terminal status"), output, withdrawn);
				},
				Some(server_frame::Body::Output(chunk)) => output.extend_from_slice(&chunk.data),
				Some(server_frame::Body::ApprovalWithdrawn(query)) => withdrawn.push(query.query_id),
				Some(server_frame::Body::ExecStarted(_)) => {},
				other => panic!("unexpected frame before {request_id} exited: {other:?}"),
			}
		}
	}

	/// One request round trip: every frame sent before it was handled, and
	/// none drew a reply.
	async fn barrier(&self, request_id: u64) {
		self
			.send(request_id, client_frame::Body::EvalReset(pb::EvalResetRequest {}))
			.await;
		let frame = self.next().await;
		assert_eq!(frame.request_id, request_id, "an earlier frame drew a reply: {frame:?}");
		assert!(matches!(frame.body, Some(server_frame::Body::EvalReset(_))), "{frame:?}");
	}
}
