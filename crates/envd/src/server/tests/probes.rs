/// The daemon has no in-process route: a sandbox amendment prompts only the
/// connection that issued the command, on that command's request, and only
/// that connection's answer decides it.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_relays_an_amendment_only_to_the_issuing_connection() {
	let Some((server, root, _state)) = relay_daemon().await else {
		return;
	};
	let owner = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	let other = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	let session = owner.open_session(1, root.path()).await;

	owner
		.exec(2, &session, "echo forged > .git/forged.txt")
		.await;
	let forged = owner.query(2).await;
	assert_eq!(forged.invocation_id, None, "a sandbox amendment blocks no invocation");
	let reason = forged.reasons.first().expect("amendment requirement");
	assert_eq!(reason.kind, "sandbox_amendment");
	assert_eq!(reason.timeout_ms, 120_000);
	assert_eq!(reason.pattern.as_deref(), Some("echo forged > .git/forged.txt"));
	assert!(Path::new(&reason.subject).ends_with(".git"), "{}", reason.subject);
	// Another connection that names the owner's request and query cannot
	// approve it, and its answer draws no reply.
	other.answer(2, forged.query_id, true).await;
	other.barrier(9).await;
	owner.answer(2, forged.query_id, false).await;
	let (status, _, withdrawn) = owner.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Denied as i32);
	assert!(withdrawn.is_empty(), "an answered query was withdrawn");
	assert!(!root.path().join(".git/forged.txt").exists());

	owner
		.exec(3, &session, "echo approved > .git/approved.txt")
		.await;
	let approved = owner.query(3).await;
	assert_ne!(approved.query_id, forged.query_id);
	owner.answer(3, approved.query_id, true).await;
	let (status, output, _) = owner.exit(3).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32, "{status:?}");
	assert_eq!(status.exit_code, Some(0));
	assert_eq!(
		fs::read(root.path().join(".git/approved.txt")).expect("approved write"),
		b"approved\n"
	);
	assert!(!String::from_utf8_lossy(&output).contains("rerun with approved scope"));
	assert!(
		status.diags.iter().any(|diag| diag
			.text
			.contains("sandbox: rerun with approved scope: write")),
		"{:?}",
		status.diags
	);

	// A connection that relays no approvals keeps the fail-closed denial.
	let silent = RelayPeer::connect(&server, &[]).await;
	let silent_session = silent.open_session(1, root.path()).await;
	silent
		.exec(2, &silent_session, "echo silent > .git/silent.txt")
		.await;
	let (status, ..) = silent.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Denied as i32);
	assert!(!root.path().join(".git/silent.txt").exists());

	assert!(other.responses.is_empty(), "another connection saw the owner's prompt");
}

/// A network endpoint approved for the session belongs to the connection
/// that approved it. Its later commands, in any of its shell sessions,
/// reach the endpoint unprompted; another connection to the same daemon is
/// asked as if nothing had been approved; and once the approving
/// connection revokes its grants (its conversation was rewound or switched
/// to another session), it is asked again. `exit` fails the test on any
/// query, so an unprompted command is proven by reading it to its exit.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_session_grants_belong_to_the_approving_connection() {
	let Some((server, root, _state)) = relay_daemon_with(SandboxSettings {
		mode: ExecSandboxMode::WorkspaceWrite,
		allow_localhost: true,
		..SandboxSettings::default()
	})
	.await
	else {
		return;
	};
	let upstream = LoopbackUpstream::serve();
	let fetch = upstream.fetch();
	let owner = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	let other = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	let session = owner.open_session(1, root.path()).await;

	owner.exec(2, &session, &fetch).await;
	let query = owner.query(2).await;
	let reason = query.reasons.first().expect("amendment requirement");
	assert_eq!(reason.subject, format!("network localhost:{}", upstream.port()));
	assert_eq!(reason.scopes, ["once", "session"]);
	owner.answer_in(2, query.query_id, true, "session").await;
	let (status, output, _) = owner.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32, "{status:?}");
	assert_eq!(output, BODY.as_bytes());

	let second = owner.open_session(3, root.path()).await;
	owner.exec(4, &second, &fetch).await;
	let (status, output, _) = owner.exit(4).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32, "{status:?}");
	assert_eq!(output, BODY.as_bytes());

	let elsewhere = other.open_session(1, root.path()).await;
	other.exec(2, &elsewhere, &fetch).await;
	let query = other.query(2).await;
	other.answer(2, query.query_id, false).await;
	let (status, ..) = other.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Denied as i32, "{status:?}");

	owner
		.send(0, client_frame::Body::RevokeApprovalGrants(pb::RevokeApprovalGrants {}))
		.await;
	owner.exec(5, &session, &fetch).await;
	let query = owner.query(5).await;
	owner.answer(5, query.query_id, false).await;
	let (status, ..) = owner.exit(5).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Denied as i32, "{status:?}");

	// A revocation on any other request id is refused, and a connection that
	// relays no approvals ignores one without a reply.
	owner
		.send(6, client_frame::Body::RevokeApprovalGrants(pb::RevokeApprovalGrants {}))
		.await;
	let refused = owner.next().await;
	assert_eq!(refused.request_id, 6);
	assert!(matches!(refused.body, Some(server_frame::Body::Error(_))), "{refused:?}");
	let silent = RelayPeer::connect(&server, &[]).await;
	silent
		.send(0, client_frame::Body::RevokeApprovalGrants(pb::RevokeApprovalGrants {}))
		.await;
	silent.barrier(9).await;
}

/// Cancelling a command withdraws its open prompt before the command exits;
/// closing the issuing connection fails its prompt closed and leaves the
/// daemon serving other connections.
///
/// The exit reaches the wire from its own forwarding task, so the ordering
/// holds only because the command drops its prompt before it reports the
/// exit. A multi-thread runtime, as the daemon runs, lets the two race.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_withdraws_cancelled_prompts_and_fails_closed_on_disconnect() {
	let Some((server, root, _state)) = relay_daemon().await else {
		return;
	};
	let owner = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	let session = owner.open_session(1, root.path()).await;
	owner
		.exec(2, &session, "echo cancelled > .git/cancelled.txt")
		.await;
	let cancelled = owner.query(2).await;
	owner
		.send(
			0,
			client_frame::Body::Cancel(pb::CancelRequest {
				target: Some(pb::cancel_request::Target::TargetRequestId(2)),
				..pb::CancelRequest::default()
			}),
		)
		.await;
	let (status, _, withdrawn) = owner.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Cancelled as i32, "{status:?}");
	assert_eq!(withdrawn, [cancelled.query_id], "the prompt was not withdrawn before exit");
	assert!(!root.path().join(".git/cancelled.txt").exists());
	// An answer to the withdrawn query is ignored without a reply.
	owner.answer(2, cancelled.query_id, true).await;
	owner.barrier(9).await;

	owner
		.exec(3, &session, "echo dropped > .git/dropped.txt")
		.await;
	let dropped = owner.query(3).await;
	let RelayPeer { requests, responses, serving } = owner;
	drop(requests);
	time::timeout(RELAY_WAIT, serving)
		.await
		.expect("the closed connection kept serving")
		.expect("serving task");
	drop(responses);

	let next = RelayPeer::connect(&server, &[omp_env::APPROVAL_RELAY_CAPABILITY]).await;
	// Approval state is per connection: naming the closed connection's
	// query from another connection decides nothing.
	next.answer(3, dropped.query_id, true).await;
	next.barrier(9).await;
	let next_session = next.open_session(1, root.path()).await;
	next.exec(2, &next_session, "printf served").await;
	let (status, output, _) = next.exit(2).await;
	assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32, "{status:?}");
	assert_eq!(output, b"served");
	assert!(!root.path().join(".git/dropped.txt").exists());
}

struct AllowAdmission;

impl omp_env::Admitter for AllowAdmission {
	type Future<'client> = std::future::Ready<pb::Admission>;

	fn admit(&self, query: pb::AdmitInvocation) -> Self::Future<'_> {
		std::future::ready(pb::Admission {
			invocation_id: query.invocation_id,
			allow: true,
			..pb::Admission::default()
		})
	}
}

/// A native tool declaring network effects, run on the host (`Host`).
#[cfg(target_os = "macos")]
struct NetworkProbe {
	spec: omp_tool::ToolSpec,
	ran:  Arc<AtomicUsize>,
}

#[cfg(target_os = "macos")]
impl omp_tool::Tool for NetworkProbe {
	type Fault = serde_json::Value;
	type Params = serde_json::Value;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<
		Item = omp_tool::Ev<serde_json::Value, serde_json::Value, serde_json::Value>,
	> + Send
	+ 'c {
		async_stream::stream! {
			params.whole::<serde_json::Value>().await.expect("probe arguments");
			params.committed().await.expect("probe commitment");
			self.ran.fetch_add(1, Ordering::AcqRel);
			yield omp_tool::Ev::Done(ToolTerminal::Done {
				result: Ok(serde_json::json!({"text": "ran"})),
				useless: false,
			});
		}
	}

	fn prompt(
		&self,
		_view: Result<&serde_json::Value, &serde_json::Value>,
		_caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		vec![omp_tool::Part::Text { text: sf!("ran") }]
	}
}

/// Records every admission query and refuses it.
#[cfg(target_os = "macos")]
#[derive(Clone, Default)]
struct RecordingRefusal(Arc<Mutex<Vec<String>>>);

#[cfg(target_os = "macos")]
impl omp_env::Admitter for RecordingRefusal {
	type Future<'client> = std::future::Ready<pb::Admission>;

	fn admit(&self, query: pb::AdmitInvocation) -> Self::Future<'_> {
		self.0.lock().push(query.invocation_id.clone());
		std::future::ready(pb::Admission {
			invocation_id: query.invocation_id,
			allow: false,
			..pb::Admission::default()
		})
	}
}

/// Invokes `name` with `args` and returns its terminal verdict.
async fn invoke_to_verdict(
	client: &EnvClient,
	server: &EnvServer,
	invocation_id: &str,
	name: &str,
	args: serde_json::Value,
) -> pb::Verdict {
	let rev = server
		.registry()
		.live_identity(name)
		.map(|(_, rev)| rev.to_string())
		.expect("tool is registered");
	let mut invocation = client
		.invoke(pb::InvokeTool {
			invocation_id: invocation_id.to_owned(),
			name: name.to_owned(),
			rev,
			..pb::InvokeTool::default()
		})
		.await
		.expect("invoke");
	assert!(matches!(
		invocation.next_event().await.expect("accepted"),
		Some(omp_env::InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from(serde_json::to_vec(&args).expect("arguments")),
			Bytes::from_static(b"confinement-test-token"),
			1_000,
			None,
		)
		.await
		.expect("commit arguments");
	time::timeout(RELAY_WAIT, async {
		loop {
			match invocation.next_event().await.expect("invocation event") {
				Some(omp_env::InvocationEvent::Verdict(verdict)) => break verdict,
				Some(omp_env::InvocationEvent::Update(_)) => {},
				other => panic!("unexpected {name} event: {other:?}"),
			}
		}
	})
	.await
	.expect("the invocation did not settle")
}

/// The text parts a verdict carries for the model, in order.
fn verdict_text(verdict: &pb::Verdict) -> String {
	verdict
		.parts
		.iter()
		.filter_map(|part| match part.kind.as_ref() {
			Some(thread_pb::part::Kind::Text(text)) => Some(text.as_str()),
			_ => None,
		})
		.collect()
}

/// The production tools on an unsandboxed host, served to one application
/// connection whose explicit `yolo` admits every call.
async fn unconfined_tools() -> (EnvClient, Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir) {
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
		.expect("tool host"),
	);
	server.exec.configure_sandbox(
		&SandboxSettings { mode: ExecSandboxMode::Off, ..SandboxSettings::default() },
		root.path(),
	);
	let (client, transport) = EnvClient::in_process(64);
	client.set_admitter(AllowAdmission);
	let host = Arc::clone(&server);
	tokio::spawn(async move { host.serve_in_process(transport).await });
	client
		.hello(pb::ClientHello {
			client: "native-parts".to_owned(),
			schema_rev: omp_proto::SCHEMA_REV,
			approval_mode: pb::ApprovalMode::Yolo as i32,
			..pb::ClientHello::default()
		})
		.await
		.expect("hello");
	(client, server, root, state)
}

/// A native tool's verdict carries the model-facing parts its own
/// projection renders, on the ok and the faulted branch alike, and they
/// agree with the verdict's error flag. Without them the client journals
/// an empty tool message and the model never sees the command's output.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_verdicts_carry_the_tools_own_projection() {
	let (client, server, root, _state) = unconfined_tools().await;

	let ok = invoke_to_verdict(
		&client,
		&server,
		"bash-ok",
		"bash",
		serde_json::json!({"command": "printf native-parts-marker"}),
	)
	.await;
	let text = verdict_text(&ok);
	assert!(!ok.is_error, "{}", String::from_utf8_lossy(&ok.json));
	assert!(text.contains("[status="), "bash status line reaches the model: {text:?}");
	assert!(text.contains("native-parts-marker"), "bash stdout reaches the model: {text:?}");

	let faulted = invoke_to_verdict(
		&client,
		&server,
		"bash-faulted",
		"bash",
		serde_json::json!({"command": "printf native-parts-stderr >&2; exit 3"}),
	)
	.await;
	let text = verdict_text(&faulted);
	assert!(faulted.is_error, "a failed command is a fault");
	assert!(text.contains("bash command failed"), "the fault reaches the model: {text:?}");
	assert!(text.contains("native-parts-stderr"), "stderr reaches the model: {text:?}");

	fs::write(root.path().join("present.txt"), "native-parts-file\n").expect("fixture");
	let read = invoke_to_verdict(
		&client,
		&server,
		"read-ok",
		"read",
		serde_json::json!({"path": "present.txt"}),
	)
	.await;
	let text = verdict_text(&read);
	assert!(!read.is_error, "{}", String::from_utf8_lossy(&read.json));
	assert!(text.contains("native-parts-file"), "the file reaches the model: {text:?}");

	let missing = invoke_to_verdict(
		&client,
		&server,
		"read-missing",
		"read",
		serde_json::json!({"path": "absent.txt"}),
	)
	.await;
	assert!(missing.is_error, "a missing file is a fault");
	assert!(!verdict_text(&missing).is_empty(), "the read fault reaches the model");
}

/// A native tool's media part travels as its alternative text and a blob
/// reference, and the blob is retained in the verdict store for the
/// invocation's delivery, so the client can replicate it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_media_parts_are_retained_for_delivery() {
	let (client, server, root, _state) = unconfined_tools().await;
	fs::write(
		root.path().join("pixel.png"),
		include_bytes!(concat!(
			env!("CARGO_MANIFEST_DIR"),
			"/../tools/tests/fixtures/special-sources/images/pixel.png"
		)),
	)
	.expect("image fixture");
	let read = invoke_to_verdict(
		&client,
		&server,
		"read-image",
		"read",
		serde_json::json!({"path": "pixel.png"}),
	)
	.await;
	assert!(!read.is_error, "{}", String::from_utf8_lossy(&read.json));
	let media = read
		.parts
		.iter()
		.position(|part| matches!(part.kind, Some(thread_pb::part::Kind::Blob(_))))
		.expect("the image reaches the model as a blob part");
	let alt = media
		.checked_sub(1)
		.and_then(|before| match read.parts[before].kind.as_ref() {
			Some(thread_pb::part::Kind::Text(alt)) => Some(alt.as_str()),
			_ => None,
		});
	assert!(
		alt.is_some_and(|alt| !alt.is_empty()),
		"its alternative text precedes it: {:?}",
		read.parts
	);
	let Some(thread_pb::part::Kind::Blob(image)) = &read.parts[media].kind else {
		unreachable!("located above");
	};
	assert!(image.mime.starts_with("image/"), "{image:?}");
	assert!(image.inline.is_empty(), "media travels by reference: {image:?}");
	let hash = <[u8; 32]>::try_from(image.hash.as_ref()).expect("a SHA-256 blob reference");
	assert!(
		server
			.blobs
			.worker_verdict_store()
			.has(&blob::BlobRef { hash: Hash32::new(hash), size: image.size }),
		"the image is retained for delivery"
	);
}

/// Decision 4 over the wire, with Seatbelt really confining the
/// environment. Under the shipped (defaulted) `yolo`, kept alive only by
/// the active sandbox, `bash` runs unprompted because the sandbox confines
/// it, while a `Host` tool declaring network asks the client and, refused,
/// never runs. Under an explicit `yolo`, neither asks.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sandbox_kept_default_yolo_covers_only_sandboxed_tools() {
	let ran = Arc::new(AtomicUsize::new(0));
	let mut registry = Registry::new();
	registry
		.register(
			NetworkProbe {
				spec: omp_tool::ToolSpec {
					name:            sf!("net_probe"),
					rev:             omp_tool::Rev { family: Str::default(), n: 1 },
					description:     sf!("host-side network probe"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      omp_tool::Constraint::None,
					effects:         Effects {
						exec: Some(omp_tool::ExecEffects { commands: Arc::default(), network: true }),
						..Effects::empty()
					},
					confinement:     Confinement::Host,
					projection_code: [0; 32],
				},
				ran:  Arc::clone(&ran),
			},
			omp_tool::Presentation::Slot,
			omp_tool::Claims {
				precedence: omp_tool::Precedence::DEFAULT,
				claimant:   sf!("omp/test"),
				replaces:   None,
			},
		)
		.expect("register the network probe");
	let Some((server, _root, _state)) = relay_daemon_in(
		SandboxSettings { mode: ExecSandboxMode::WorkspaceWrite, ..SandboxSettings::default() },
		registry,
		// An explicit `yolo` is respected only in a trusted workspace.
		WorkspaceTrust::Trusted,
	)
	.await
	else {
		return;
	};
	assert_eq!(server.exec.sandbox_state(), crate::admission::SandboxState::Active);
	assert_eq!(
		server
			.registry()
			.live_spec("bash")
			.expect("bash is registered")
			.confinement,
		Confinement::ExecSandbox
	);

	for (approval_mode, host_prompts) in
		[(pb::ApprovalMode::Unspecified, true), (pb::ApprovalMode::Yolo, false)]
	{
		let (client, transport) = EnvClient::in_process(64);
		let admissions = RecordingRefusal::default();
		client.set_admitter(admissions.clone());
		let host = Arc::clone(&server);
		let serving = tokio::spawn(async move { host.serve_in_process(transport).await });
		client
			.hello(pb::ClientHello {
				client: "confinement".to_owned(),
				schema_rev: omp_proto::SCHEMA_REV,
				approval_mode: approval_mode as i32,
				..pb::ClientHello::default()
			})
			.await
			.expect("hello");
		let posture = approval_mode.as_str_name();

		let bash = invoke_to_verdict(
			&client,
			&server,
			"confined-bash",
			"bash",
			serde_json::json!({"command": "printf confined"}),
		)
		.await;
		assert!(!bash.is_error, "{posture}: {}", String::from_utf8_lossy(&bash.json));
		assert!(admissions.0.lock().is_empty(), "{posture}: bash must not prompt");

		let before = ran.load(Ordering::Acquire);
		let probe =
			invoke_to_verdict(&client, &server, "host-network", "net_probe", serde_json::json!({}))
				.await;
		if host_prompts {
			assert_eq!(*admissions.0.lock(), ["host-network"], "{posture}");
			assert!(probe.is_error, "{posture}: the refused prompt denies the call");
			assert_eq!(ran.load(Ordering::Acquire), before, "{posture}: never ran");
		} else {
			assert!(admissions.0.lock().is_empty(), "{posture}: an explicit yolo never asks");
			assert!(!probe.is_error, "{posture}: {}", String::from_utf8_lossy(&probe.json));
			assert_eq!(ran.load(Ordering::Acquire), before + 1, "{posture}");
		}
		drop(client);
		serving.abort();
	}
}

/// Bash invoked over the wire runs its command inside the invocation, so
/// the amendment reaches the invoking connection on the invocation's own
/// request, and the approved rerun completes the call.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_bash_relays_its_amendment_on_the_invocation_request() {
	let Some((server, root, _state)) = relay_daemon().await else {
		return;
	};
	let (client, transport) = EnvClient::in_process(64);
	client.set_admitter(AllowAdmission);
	let host = Arc::clone(&server);
	let serving = tokio::spawn(async move { host.serve_in_process(transport).await });
	client
		.hello(pb::ClientHello {
			client: "native-relay".to_owned(),
			schema_rev: omp_proto::SCHEMA_REV,
			capabilities: vec![omp_env::APPROVAL_RELAY_CAPABILITY.to_owned()],
			..pb::ClientHello::default()
		})
		.await
		.expect("relay hello");
	let queries = client.approval_queries();
	let rev = server
		.registry()
		.live_identity("bash")
		.map(|(_, rev)| rev.to_string())
		.expect("bash is registered");
	let mut invocation = client
		.invoke(pb::InvokeTool {
			invocation_id: "native-relay".into(),
			name: "bash".into(),
			rev,
			..pb::InvokeTool::default()
		})
		.await
		.expect("invoke bash");
	assert!(matches!(
		invocation.next_event().await.expect("bash accepted"),
		Some(omp_env::InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&serde_json::json!({
					"command": "echo native > .git/native.txt"
				}))
				.expect("bash arguments"),
			),
			Bytes::from_static(b"relay-test-token"),
			1_000,
			None,
		)
		.await
		.expect("commit bash arguments");
	let (request_id, query) = time::timeout(RELAY_WAIT, async {
		loop {
			tokio::select! {
				event = queries.recv_async() => match event.expect("approval queue") {
					omp_env::ApprovalQueryEvent::Requested { request_id, query } => {
						break (request_id, query);
					},
					withdrawn => panic!("unexpected withdrawal: {withdrawn:?}"),
				},
				event = invocation.next_event() => match event.expect("bash event") {
					Some(omp_env::InvocationEvent::Update(_)) => {},
					other => panic!("bash settled before its amendment was answered: {other:?}"),
				},
			}
		}
	})
	.await
	.expect("the amendment was not relayed");
	// The invocation is this client's first request after the hello.
	assert_eq!(request_id, 1);
	let reason = query.reasons.first().expect("amendment requirement");
	assert_eq!(reason.kind, "sandbox_amendment");
	assert!(
		reason
			.pattern
			.as_deref()
			.is_some_and(|command| command.contains("echo native > .git/native.txt")),
		"{:?}",
		reason.pattern
	);
	client
		.answer_approval(request_id, query.query_id, pb::ApprovalDecision {
			approved: true,
			scope: "once".to_owned(),
			source: "user".to_owned(),
			..pb::ApprovalDecision::default()
		})
		.await
		.expect("answer the amendment");
	let verdict = time::timeout(RELAY_WAIT, async {
		loop {
			match invocation.next_event().await.expect("bash event") {
				Some(omp_env::InvocationEvent::Verdict(verdict)) => break verdict,
				Some(omp_env::InvocationEvent::Update(_)) => {},
				other => panic!("unexpected bash event: {other:?}"),
			}
		}
	})
	.await
	.expect("bash did not settle");
	assert!(!verdict.is_error, "{}", String::from_utf8_lossy(&verdict.json));
	assert_eq!(
		fs::read(root.path().join(".git/native.txt")).expect("approved native write"),
		b"native\n"
	);
	serving.abort();
}

fn scoped_policy(tool: &'static str, scope: WriteScope) -> InvocationExecutionPolicy {
	InvocationExecutionPolicy {
		tool:           sf!(tool),
		write_scope:    Some(Arc::new(scope)),
		core_admission: false,
	}
}

/// A Python worker tool that declares no envelope gets its host's ceiling,
/// which writes around the scoped writers under either trust tier, so plan
/// mode and read-only subagents refuse it before it runs. A worker that
/// declares a read-only envelope still passes.
#[test]
fn write_scopes_refuse_undeclared_worker_tools() {
	let declaration =
		|effects: Option<omp_proto::policy::v1::EffectEnvelope>| omp_proto::toolhost::v1::ToolDecl {
			definition: Some(omp_proto::inference::v1::ToolDef {
				name:        "ext_tool".to_owned(),
				description: "extension tool".to_owned(),
				input:       Some(omp_proto::inference::v1::tool_def::Input::JsonSchema(
					omp_proto::inference::v1::tool_def::JsonSchema {
						schema_json: bytes::Bytes::from_static(br#"{"type":"object","properties":{}}"#),
						strict:      Some(true),
					},
				)),
			}),
			rev: "1".to_owned(),
			extension_id: "test.extension".to_owned(),
			effects,
			..Default::default()
		};
	let plan = || WriteScope::PlanFile { plan_file: sf!("local://PLAN.md"), target: None };
	for tier in ["trusted", "sandboxed"] {
		let owner = crate::worker::HostKey::new("project", tier, "test.extension");
		let spec = crate::tools::worker_spec(&declaration(None), &owner).expect("undeclared");
		for scope in [plan(), WriteScope::ReadOnly] {
			assert!(
				scoped_policy("ext_tool", scope)
					.denial(&spec.effects, spec.confinement)
					.is_some(),
				"{tier}"
			);
		}
		let read_only = omp_proto::policy::v1::EffectEnvelope {
			documents: Some(omp_proto::policy::v1::DocEffects { read: true, ..Default::default() }),
			..Default::default()
		};
		let spec = crate::tools::worker_spec(&declaration(Some(read_only)), &owner).expect("read");
		assert_eq!(
			scoped_policy("ext_tool", plan()).denial(&spec.effects, spec.confinement),
			None,
			"{tier}"
		);
	}
}

#[test]
fn write_scopes_refuse_tools_that_write_around_the_scoped_writers() {
	let documents = Effects {
		documents: Some(omp_tool::DocEffects {
			read:        true,
			write_globs: Arc::from([sf!("**")]),
		}),
		..Effects::empty()
	};
	let commands = Effects {
		exec: Some(omp_tool::ExecEffects { commands: Arc::from([sf!("*")]), network: true }),
		..Effects::empty()
	};
	let network = Effects {
		exec: Some(omp_tool::ExecEffects { commands: Arc::default(), network: true }),
		..Effects::empty()
	};
	let host = Confinement::Host;
	let doc_authority = Confinement::DocumentAuthority;
	let plan = || WriteScope::PlanFile { plan_file: sf!("local://PLAN.md"), target: None };
	// The scoped writers proceed: the scope confines each of their writes.
	for tool in ["write", "edit", "lsp"] {
		assert_eq!(scoped_policy(tool, plan()).denial(&documents, doc_authority), None, "{tool}");
	}
	assert_eq!(scoped_policy("web_search", plan()).denial(&network, host), None);
	assert_eq!(scoped_policy("read", WriteScope::ReadOnly).denial(&Effects::empty(), host), None);
	let denial = scoped_policy("ast_edit", plan())
		.denial(&documents, host)
		.expect("direct writer");
	assert_eq!(
		denial.to_string(),
		"plan mode is active: the environment refused `ast_edit`, which can change files outside \
		 the plan file; no action was taken"
	);
	let denial = scoped_policy("debug", plan())
		.denial(&commands, host)
		.expect("declared commands");
	assert!(matches!(denial, WriteBoundaryDenied::Plan { .. }), "{denial}");
	// The production shell declares no effects: its confinement marker, not
	// an envelope, says its processes write around the scoped writers.
	let bash = omp_tools::shell::spec(&omp_tools::shell::ShellPromptSnapshot {
		sibling_tools:       Arc::default(),
		platform:            sf!("macos"),
		command_prefix:      false,
		embedded_builtins:   true,
		devices:             true,
		interceptor_enabled: false,
		interceptor_rules:   Arc::default(),
	});
	assert_eq!(
		(bash.effects.clone(), bash.confinement),
		(Effects::empty(), Confinement::ExecSandbox)
	);
	let denial = scoped_policy("bash", WriteScope::ReadOnly)
		.denial(&bash.effects, bash.confinement)
		.expect("the shell's processes");
	assert_eq!(
		denial.to_string(),
		"this agent is a read-only subagent of a plan-mode session: the environment refused `bash`, \
		 which can change files; no action was taken"
	);
	assert!(
		scoped_policy("bash", plan())
			.denial(&bash.effects, bash.confinement)
			.is_some()
	);
	let unscoped = InvocationExecutionPolicy { tool: sf!("bash"), ..Default::default() };
	assert_eq!(
		unscoped.denial(&bash.effects, bash.confinement),
		None,
		"no scope, no boundary refusal"
	);
}

/// Arguments of [`ScopedProbe`]: the effects one call asks for.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopedProbeParams {
	level: Str,
}

/// A native tool scoping each call's effects to its `level`: `read` reads
/// documents and `write` also writes them; any other level keeps the
/// declared maximum, which runs commands as well. `widen` lies, judging
/// the call beyond that maximum.
struct ScopedProbe {
	spec: omp_tool::ToolSpec,
	ran:  Arc<Mutex<Vec<serde_json::Value>>>,
}

impl omp_tool::Tool for ScopedProbe {
	type Fault = serde_json::Value;
	type Params = ScopedProbeParams;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	const ARGUMENT_SCOPED_EFFECTS: bool = true;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn invocation_effects(&self, params: &ScopedProbeParams) -> Option<Effects> {
		let documents = |write_globs| Effects {
			documents: Some(omp_tool::DocEffects { read: true, write_globs }),
			..Effects::empty()
		};
		match params.level.as_str() {
			"read" => Some(documents(Arc::from([]))),
			"write" => Some(documents(Arc::from([sf!("**")]))),
			"widen" => Some(Effects { subagents: 1, ..Effects::empty() }),
			_ => None,
		}
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<
		Item = omp_tool::Ev<serde_json::Value, serde_json::Value, serde_json::Value>,
	> + Send
	+ 'c {
		async_stream::stream! {
			let committed = params.committed().await.expect("probe commitment");
			self.ran.lock().push(serde_json::from_str(&committed).expect("committed JSON"));
			yield omp_tool::Ev::Done(ToolTerminal::Done {
				result: Ok(serde_json::json!({"text": "ran"})),
				useless: false,
			});
		}
	}

	fn prompt(
		&self,
		_view: Result<&serde_json::Value, &serde_json::Value>,
		_caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		vec![omp_tool::Part::Text { text: sf!("ran") }]
	}
}

/// Records every admission query and answers each one as scripted.
#[derive(Clone, Default)]
struct ScriptedAdmission {
	queries: Arc<Mutex<Vec<String>>>,
	/// Every query as it arrived.
	seen:    Arc<Mutex<Vec<pb::AdmitInvocation>>>,
	allow:   bool,
	patch:   Bytes,
}

impl omp_env::Admitter for ScriptedAdmission {
	type Future<'client> = future::Ready<pb::Admission>;

	fn admit(&self, query: pb::AdmitInvocation) -> Self::Future<'_> {
		self.queries.lock().push(query.invocation_id.clone());
		self.seen.lock().push(query.clone());
		future::ready(pb::Admission {
			invocation_id: query.invocation_id,
			allow: self.allow,
			args_patch: self.patch.clone(),
			..pb::Admission::default()
		})
	}
}

/// A local daemon whose registry holds [`ScopedProbe`], whose runs land
/// in `ran`.
async fn scoped_probe_daemon(
	ran: &Arc<Mutex<Vec<serde_json::Value>>>,
) -> (Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir) {
	let mut registry = Registry::new();
	registry
		.register(
			ScopedProbe {
				spec: omp_tool::ToolSpec {
					name:            sf!("scoped_probe"),
					rev:             omp_tool::Rev { family: Str::default(), n: 1 },
					description:     sf!("argument-scoped probe"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      omp_tool::Constraint::None,
					effects:         Effects {
						documents: Some(omp_tool::DocEffects {
							read:        true,
							write_globs: Arc::from([sf!("**")]),
						}),
						exec: Some(omp_tool::ExecEffects {
							commands: Arc::from([sf!("*")]),
							network:  false,
						}),
						..Effects::empty()
					},
					confinement:     Confinement::Host,
					projection_code: [0; 32],
				},
				ran:  Arc::clone(ran),
			},
			omp_tool::Presentation::Slot,
			omp_tool::Claims {
				precedence: omp_tool::Precedence::DEFAULT,
				claimant:   sf!("omp/test"),
				replaces:   None,
			},
		)
		.expect("register the scoped probe");
	probe_daemon(registry).await
}

/// A local daemon serving `registry` on a fresh workspace and state
/// directory.
async fn probe_daemon(
	registry: Registry,
) -> (Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir) {
	configured_probe_daemon(registry, &[]).await
}

/// A local daemon serving `registry` on a fresh workspace and state
/// directory, configured by the cfg `commands` first.
async fn configured_probe_daemon(
	registry: Registry,
	commands: &[&str],
) -> (Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir) {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let con = Arc::new(Ctx::new());
	for command in commands {
		con.run(command).expect(command);
	}
	let convars = Arc::new(ConvarControlFactory::new(Arc::clone(&con)));
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
			RegistryBridges::default(),
		)
		.await
		.expect("local environment"),
	);
	(server, root, state)
}

/// Connects a client to `server` under `approval_mode`, answering
/// admission queries with `admission`.
async fn scoped_probe_client(
	server: &Arc<EnvServer>,
	approval_mode: pb::ApprovalMode,
	admission: impl omp_env::Admitter,
) -> (EnvClient, JoinHandle<()>) {
	let (client, transport) = EnvClient::in_process(64);
	client.set_admitter(admission);
	let host = Arc::clone(server);
	let serving = tokio::spawn(async move { host.serve_in_process(transport).await });
	client
		.hello(pb::ClientHello {
			client: "scoped-effects".to_owned(),
			schema_rev: omp_proto::SCHEMA_REV,
			approval_mode: approval_mode as i32,
			..pb::ClientHello::default()
		})
		.await
		.expect("hello");
	(client, serving)
}

/// Invokes the probe tool `name` with `args` under `restrictions` and
/// returns its verdict, or the environment's refusal of the committed
/// call.
async fn invoke_probe(
	client: &EnvClient,
	server: &EnvServer,
	name: &str,
	invocation_id: &str,
	args: serde_json::Value,
	restrictions: Option<pb::ToolRestrictions>,
) -> Result<pb::Verdict, omp_env::ClientError> {
	let rev = server
		.registry()
		.live_identity(name)
		.map(|(_, rev)| rev.to_string())
		.expect("the probe is registered");
	let mut invocation = client
		.invoke(pb::InvokeTool {
			invocation_id: invocation_id.to_owned(),
			name: name.to_owned(),
			rev,
			restrictions,
			..pb::InvokeTool::default()
		})
		.await
		.expect("invoke");
	assert!(matches!(
		invocation.next_event().await.expect("accepted"),
		Some(omp_env::InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from(serde_json::to_vec(&args).expect("arguments")),
			Bytes::from_static(b"scoped-effects-token"),
			1_000,
			None,
		)
		.await
		.expect("commit arguments");
	time::timeout(Duration::from_secs(30), async {
		loop {
			match invocation.next_event().await? {
				Some(omp_env::InvocationEvent::Verdict(verdict)) => break Ok(verdict),
				Some(omp_env::InvocationEvent::Update(_)) => {},
				other => panic!("unexpected scoped probe event: {other:?}"),
			}
		}
	})
	.await
	.expect("the scoped probe did not settle")
}

/// Approval follows what each call does, judged at commit: under
/// `always-ask` a reading call runs unasked while a writing or executing
/// one asks; under `write` only the executing call asks. A refused
/// prompt never runs the call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn argument_scoped_calls_are_approved_by_their_committed_effects() {
	let ran = Arc::new(Mutex::new(Vec::new()));
	let (server, _root, _state) = scoped_probe_daemon(&ran).await;
	for (mode, level, prompts) in [
		(pb::ApprovalMode::AlwaysAsk, "read", false),
		(pb::ApprovalMode::AlwaysAsk, "write", true),
		(pb::ApprovalMode::AlwaysAsk, "exec", true),
		(pb::ApprovalMode::Write, "read", false),
		(pb::ApprovalMode::Write, "write", false),
		(pb::ApprovalMode::Write, "exec", true),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) = scoped_probe_client(&server, mode, refusing.clone()).await;
		let context = format!("{} {level}", mode.as_str_name());
		let before = ran.lock().len();
		let verdict = invoke_probe(
			&client,
			&server,
			"scoped_probe",
			"scoped",
			serde_json::json!({"i": "probe", "level": level}),
			None,
		)
		.await
		.expect("a verdict");
		if prompts {
			assert_eq!(*refusing.queries.lock(), ["scoped"], "{context}");
			assert!(verdict.is_error, "{context}: the refused prompt denies the call");
			assert_eq!(ran.lock().len(), before, "{context}: never ran");
		} else {
			assert!(refusing.queries.lock().is_empty(), "{context}: never asks");
			assert!(!verdict.is_error, "{context}: {}", String::from_utf8_lossy(&verdict.json));
			assert_eq!(ran.lock().len(), before + 1, "{context}");
		}
		drop(client);
		serving.abort();
	}
}

/// Plan mode refuses a call by what it does: a reading call of a tool
/// that can run commands proceeds, while its writing and executing calls
/// are refused before they run. A call judged beyond its tool's declared
/// maximum is refused too, never admitted on that maximum, and an answer
/// that rewrites a call to do more than was admitted is denied while one
/// that narrows it runs the narrowed call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn argument_scoped_calls_meet_the_write_boundary_by_their_effects() {
	let ran = Arc::new(Mutex::new(Vec::new()));
	let (server, _root, _state) = scoped_probe_daemon(&ran).await;
	let plan = || pb::ToolRestrictions {
		plan_file: Some("local://PLAN.md".to_owned()),
		..pb::ToolRestrictions::default()
	};
	let (client, serving) =
		scoped_probe_client(&server, pb::ApprovalMode::Yolo, ScriptedAdmission::default()).await;
	let read = invoke_probe(
		&client,
		&server,
		"scoped_probe",
		"plan-read",
		serde_json::json!({"level": "read"}),
		Some(plan()),
	)
	.await
	.expect("a reading call passes plan mode");
	assert!(!read.is_error, "{}", String::from_utf8_lossy(&read.json));
	assert_eq!(ran.lock().len(), 1);
	for (invocation_id, level, restrictions) in [
		("plan-write", "write", Some(plan())),
		("plan-exec", "exec", Some(plan())),
		("widened", "widen", None),
	] {
		let refused = invoke_probe(
			&client,
			&server,
			"scoped_probe",
			invocation_id,
			serde_json::json!({"level": level}),
			restrictions,
		)
		.await
		.expect_err("the environment refuses the committed call");
		let omp_env::ClientError::Protocol(error) = refused else {
			panic!("{invocation_id}: unexpected refusal {refused:?}");
		};
		assert_eq!(
			error.code,
			pb::ProtocolErrorCode::PermissionDenied as i32,
			"{invocation_id}: {}",
			error.message
		);
	}
	assert_eq!(ran.lock().len(), 1, "no refused call ran");
	drop(client);
	serving.abort();

	for (patch, admitted) in
		[(br#"{"level":"exec"}"#.as_slice(), None), (br#"{"level":"read"}"#, Some("read"))]
	{
		let rewriting = ScriptedAdmission {
			allow: true,
			patch: Bytes::copy_from_slice(patch),
			..ScriptedAdmission::default()
		};
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, rewriting.clone()).await;
		let before = ran.lock().len();
		let verdict = invoke_probe(
			&client,
			&server,
			"scoped_probe",
			"rewritten",
			serde_json::json!({"level": "write"}),
			None,
		)
		.await
		.expect("a verdict");
		assert_eq!(*rewriting.queries.lock(), ["rewritten"], "the writing call asks");
		if let Some(level) = admitted {
			assert!(!verdict.is_error, "{}", String::from_utf8_lossy(&verdict.json));
			assert_eq!(ran.lock().last().map(|args| args["level"].clone()), Some(level.into()));
		} else {
			assert!(verdict.is_error);
			assert!(
				String::from_utf8_lossy(&verdict.json).contains("admission_effects_widened"),
				"{}",
				String::from_utf8_lossy(&verdict.json)
			);
			assert_eq!(ran.lock().len(), before, "the widened call never ran");
		}
		drop(client);
		serving.abort();
	}
}

/// A commit the gate refuses judges nothing, so the call is admitted on
/// the policy its next, accepted commit resolves to. Under `always-ask`, a
/// reading call in serde's sequence form, refused, then an executing call
/// asks and never runs; an executing call so refused, then a reading call,
/// runs unasked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_commit_leaves_the_call_unjudged() {
	let ran = Arc::new(Mutex::new(Vec::new()));
	let (server, _root, _state) = scoped_probe_daemon(&ran).await;
	let rev = server
		.registry()
		.live_identity("scoped_probe")
		.map(|(_, rev)| rev.to_string())
		.expect("the scoped probe is registered");
	for (invocation_id, refused, accepted, asks) in [
		("exec-after-refusal", r#"["read"]"#, r#"{"level":"exec"}"#, true),
		("read-after-refusal", r#"["exec"]"#, r#"{"level":"read"}"#, false),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, refusing.clone()).await;
		let before = ran.lock().len();
		let mut invocation = client
			.invoke(pb::InvokeTool {
				invocation_id: invocation_id.to_owned(),
				name: "scoped_probe".to_owned(),
				rev: rev.clone(),
				..pb::InvokeTool::default()
			})
			.await
			.expect("invoke");
		assert!(matches!(
			invocation.next_event().await.expect("accepted"),
			Some(omp_env::InvocationEvent::Accepted(_))
		));
		for raw in [refused, accepted] {
			invocation
				.commit_args(
					Bytes::copy_from_slice(raw.as_bytes()),
					Bytes::from_static(b"scoped-effects-token"),
					1_000,
					None,
				)
				.await
				.expect("commit arguments");
		}
		// The refused commit's error ends this client's view of the
		// invocation, so the outcome shows in what was asked and what ran.
		time::timeout(Duration::from_secs(30), async {
			while refusing.queries.lock().is_empty() && ran.lock().len() == before {
				time::sleep(Duration::from_millis(5)).await;
			}
		})
		.await
		.expect("the accepted commit was neither asked nor run");
		if asks {
			assert_eq!(*refusing.queries.lock(), [invocation_id], "the executing call asks");
			assert_eq!(ran.lock().len(), before, "the refused prompt never ran it");
		} else {
			assert!(refusing.queries.lock().is_empty(), "the reading call never asks");
			assert_eq!(ran.lock().len(), before + 1);
			assert_eq!(ran.lock().last().map(|args| args["level"].clone()), Some("read".into()));
		}
		drop(invocation);
		drop(client);
		serving.abort();
	}
}

/// Arguments of [`FetchProbe`]: the targets one call reads.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FetchProbeParams {
	targets: Vec<Str>,
}

/// A native tool reading local paths and fetching every URL target, the
/// way an argument-scoped `read` classifies its targets: a call fetches
/// only when a target is a URL, and names those URLs as its locators.
struct FetchProbe {
	spec: omp_tool::ToolSpec,
}

impl omp_tool::Tool for FetchProbe {
	type Fault = serde_json::Value;
	type Params = FetchProbeParams;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	const ARGUMENT_SCOPED_EFFECTS: bool = true;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn invocation_effects(&self, params: &FetchProbeParams) -> Option<Effects> {
		let fetches = params.targets.iter().any(|target| target.contains("://"));
		Some(Effects {
			documents: Some(omp_tool::DocEffects { read: true, write_globs: Arc::from([]) }),
			fetch: fetches.then_some(omp_tool::FetchEffects { credentials: true }),
			..Effects::empty()
		})
	}

	fn fetch_locators(&self, params: &FetchProbeParams) -> Vec<Str> {
		params
			.targets
			.iter()
			.filter(|target| target.contains("://"))
			.cloned()
			.collect()
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<
		Item = omp_tool::Ev<serde_json::Value, serde_json::Value, serde_json::Value>,
	> + Send
	+ 'c {
		async_stream::stream! {
			params.committed().await.expect("probe commitment");
			yield omp_tool::Ev::Done(ToolTerminal::Done {
				result: Ok(serde_json::json!({"text": "fetched"})),
				useless: false,
			});
		}
	}

	fn prompt(
		&self,
		_view: Result<&serde_json::Value, &serde_json::Value>,
		_caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		vec![omp_tool::Part::Text { text: sf!("fetched") }]
	}
}

/// A local daemon whose registry holds [`FetchProbe`].
async fn fetch_probe_daemon() -> (Arc<EnvServer>, tempfile::TempDir, tempfile::TempDir) {
	let mut registry = Registry::new();
	registry
		.register(
			FetchProbe {
				spec: omp_tool::ToolSpec {
					name:            sf!("fetch_probe"),
					rev:             omp_tool::Rev { family: Str::default(), n: 1 },
					description:     sf!("argument-scoped fetch probe"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      omp_tool::Constraint::None,
					effects:         Effects {
						documents: Some(omp_tool::DocEffects {
							read:        true,
							write_globs: Arc::from([]),
						}),
						fetch: Some(omp_tool::FetchEffects { credentials: true }),
						..Effects::empty()
					},
					confinement:     Confinement::Host,
					projection_code: [0; 32],
				},
			},
			omp_tool::Presentation::Slot,
			omp_tool::Claims {
				precedence: omp_tool::Precedence::DEFAULT,
				claimant:   sf!("omp/test"),
				replaces:   None,
			},
		)
		.expect("register the fetch probe");
	probe_daemon(registry).await
}

/// Under `always-ask` a fetching call's query reports the envelope it was
/// judged by and every distinct host its fetches reach, named by the
/// resolver that performs each: an http(s) URL by its authored host and
/// port, `ssh://` by its alias, `issue://` and `pr://` by the GitHub host
/// the URL or the workspace's git remote names. A locator the environment
/// cannot name marks the call partly unnamed and never drops the hosts the
/// others name. A local read never asks, and `write` asks for no fetch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_queries_name_every_host_the_resolvers_reach() {
	use crate::fetch_host::FetchHost;

	let (server, root, _state) = fetch_probe_daemon().await;
	std::fs::create_dir(root.path().join(".git")).expect("git directory");
	std::fs::write(
		root.path().join(".git/config"),
		"[remote \"origin\"]\n\turl = git@GHE.example.com:Owner/Repo.git\n",
	)
	.expect("git config");
	let hosts = |query: &pb::AdmitInvocation| {
		query
			.fetch
			.iter()
			.map(|target| FetchHost::try_from(target).expect("a named host"))
			.collect::<Vec<_>>()
	};
	for (invocation_id, targets, named, unnamed) in [
		(
			"web",
			vec!["https://docs.rs/serde", "https://docs.rs/tokio:10-20", "http://localhost:8080/x"],
			vec![FetchHost::http("docs.rs", 443), FetchHost::http("localhost", 8080)],
			false,
		),
		#[cfg(feature = "cap-ssh")]
		("ssh", vec!["ssh://prod/etc/hosts"], vec![FetchHost::ssh("prod")], false),
		("remote-issue", vec!["issue://5"], vec![FetchHost::github("ghe.example.com")], false),
		(
			"named-pr",
			vec!["pr://Owner/Repo/7/diff", "notes.txt"],
			vec![FetchHost::github("github.com")],
			false,
		),
		("unadvertised-mcp", vec!["mcp://unadvertised/resource"], Vec::new(), true),
		(
			"one-unnamed",
			vec!["https://docs.rs/serde", "issue://owner"],
			vec![FetchHost::http("docs.rs", 443)],
			true,
		),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, refusing.clone()).await;
		let verdict = invoke_probe(
			&client,
			&server,
			"fetch_probe",
			invocation_id,
			serde_json::json!({"targets": targets}),
			None,
		)
		.await
		.expect("a verdict");
		assert!(verdict.is_error, "{invocation_id}: the refused prompt denies the call");
		let seen = refusing.seen.lock().clone();
		assert_eq!(seen.len(), 1, "{invocation_id}: one query");
		let effects = seen[0]
			.effects
			.as_ref()
			.map(|envelope| Effects::try_from(envelope).expect("a typed envelope"))
			.expect("the query reports the envelope");
		assert_eq!(
			effects.fetch,
			Some(omp_tool::FetchEffects { credentials: true }),
			"{invocation_id}"
		);
		assert_eq!(hosts(&seen[0]), named, "{invocation_id}");
		assert_eq!(seen[0].fetch_unnamed, unnamed, "{invocation_id}");
		drop(client);
		serving.abort();
	}

	for (mode, invocation_id, targets) in [
		(pb::ApprovalMode::AlwaysAsk, "local", vec!["notes.txt"]),
		(pb::ApprovalMode::Write, "write-fetch", vec!["https://docs.rs/serde"]),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) = scoped_probe_client(&server, mode, refusing.clone()).await;
		let verdict = invoke_probe(
			&client,
			&server,
			"fetch_probe",
			invocation_id,
			serde_json::json!({"targets": targets}),
			None,
		)
		.await
		.expect("a verdict");
		assert!(refusing.seen.lock().is_empty(), "{invocation_id}: never asks");
		assert!(!verdict.is_error, "{invocation_id}: {}", String::from_utf8_lossy(&verdict.json));
		drop(client);
		serving.abort();
	}
}

/// Document reads plus `fetch`, the envelope of one `read@3` call.
fn read_effects(fetch: Option<omp_tool::FetchEffects>) -> Effects {
	Effects {
		documents: Some(omp_tool::DocEffects { read: true, write_globs: Arc::from([]) }),
		fetch,
		..Effects::empty()
	}
}

/// A loopback port nothing listens on: a fetch from it is refused at once.
fn closed_loopback_port() -> u16 {
	std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
		.and_then(|listener| listener.local_addr())
		.expect("a free loopback port")
		.port()
}

/// The production `read@3` declares the most its resolvers can fetch, a
/// credentialed fetch, and judges each call by the resolver that reads
/// each target: a local path, an internal URI that reads local state, and a
/// vault read that asks the Obsidian CLI are document reads; an http(s) URL
/// is an anonymous fetch; an undeclared foreign scheme is a local document
/// read (ADR 0050 S3 / D5: Host no longer blankets every host URI as
/// anonymous Fetch); an `ssh://` host, `issue://`, `pr://` and an `mcp://`
/// resource no mounted server advertises yet are credentialed fetches. A
/// local read is `read` tier and runs unasked in every mode and sandbox
/// state; a fetch asks only under `always-ask`. With URL reads disabled the
/// maximum keeps the credentialed fetch and a URL read fetches nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_read_declares_its_fetches_and_local_reads_stay_read() {
	use crate::{
		admission::{ApprovalMode, ApprovalPolicy, ApprovalTier, SandboxState, SandboxUnavailable},
		tool_settings::ToolSettings,
	};

	let anonymous = Some(omp_tool::FetchEffects { credentials: false });
	let credentialed = Some(omp_tool::FetchEffects { credentials: true });
	let (server, _root, _state) = probe_daemon(Registry::new()).await;
	let registry = server.registry();
	assert_eq!(registry.effects_owned("read").expect("read is live"), read_effects(credentialed));
	let sandboxes = [SandboxState::Active, SandboxState::Off, SandboxState::Unavailable {
		cause: SandboxUnavailable::BackendUnavailable,
	}];
	for (path, fetch) in [
		("notes.txt", None),
		("src/lib.rs:1-5", None),
		("file:///tmp/notes.txt", None),
		("artifact://1", None),
		("local://scratch.md", None),
		("vault://notes/a.md", None),
		("vault://_/a.md?op=read", None),
		("vault://notes?op=search&q=todo", None),
		("custom://thing", None),
		("ssh://", None),
		("https://docs.rs/serde", anonymous),
		("docs.rs:443/", anonymous),
		("ssh://prod/etc/hosts", credentialed),
		("issue://5", credentialed),
		("pr://owner/repo/7", credentialed),
		("mcp://unadvertised/resource", credentialed),
		("notes.txt;https://docs.rs/x", anonymous),
	] {
		let effects = registry
			.invocation_effects("read", &serde_json::json!({ "path": path }).to_string())
			.expect(path);
		assert_eq!(effects, read_effects(fetch), "{path}");
		let tier = if fetch.is_some() {
			ApprovalTier::Fetch
		} else {
			ApprovalTier::Read
		};
		for mode in
			[None, Some(ApprovalMode::AlwaysAsk), Some(ApprovalMode::Write), Some(ApprovalMode::Yolo)]
		{
			for sandbox in sandboxes {
				let decision = ToolSettings::default()
					.with_approval_mode_override(mode)
					.approval_for("c", "read", &effects, Confinement::Host, sandbox);
				let asks = fetch.is_some() && mode == Some(ApprovalMode::AlwaysAsk);
				assert_eq!(
					(decision.tier, decision.policy),
					(
						tier,
						if asks {
							ApprovalPolicy::Prompt
						} else {
							ApprovalPolicy::Allow
						}
					),
					"{path} under {mode:?} with sandbox {sandbox:?}"
				);
			}
		}
	}
	drop(server);

	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let con = Arc::new(Ctx::new());
	con.run("sv_fetch_enabled false")
		.expect("disable URL reads");
	let disabled = EnvServer::open_local(
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
		Arc::new(ConvarControlFactory::new(Arc::clone(&con))),
		RegistryBridges::default(),
	)
	.await
	.expect("local environment");
	let registry = disabled.registry();
	assert_eq!(registry.effects_owned("read").expect("read is live"), read_effects(credentialed));
	for (path, fetch) in
		[("notes.txt", None), ("https://docs.rs/serde", None), ("ssh://prod/etc/hosts", credentialed)]
	{
		assert_eq!(
			registry
				.invocation_effects("read", &serde_json::json!({ "path": path }).to_string())
				.expect(path),
			read_effects(fetch),
			"{path} with URL reads disabled"
		);
	}
}

/// The production `read@3` over a connection. Under `always-ask` a URL,
/// `ssh://` or `issue://` read asks once, its query reporting the fetch the
/// call was judged by and every host its targets reach, named by the
/// resolver that reads each, and a refused prompt reads nothing. A local
/// read never asks in any mode. Under `write` a URL read runs unasked, and
/// plan mode lets it through: a fetch writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_queries_name_the_hosts_its_targets_fetch() {
	use crate::fetch_host::FetchHost;

	let anonymous = Some(omp_tool::FetchEffects { credentials: false });
	let credentialed = Some(omp_tool::FetchEffects { credentials: true });
	let (server, root, _state) = probe_daemon(Registry::new()).await;
	std::fs::write(root.path().join("notes.txt"), "alpha\n").expect("local file");
	std::fs::create_dir(root.path().join(".git")).expect("git directory");
	std::fs::write(
		root.path().join(".git/config"),
		"[remote \"origin\"]\n\turl = git@GHE.example.com:Owner/Repo.git\n",
	)
	.expect("git config");
	for (invocation_id, path, fetch, named) in [
		("url", "https://docs.rs/serde", anonymous, vec![FetchHost::http("docs.rs", 443)]),
		#[cfg(feature = "cap-ssh")]
		("ssh", "ssh://prod/etc/hosts", credentialed, vec![FetchHost::ssh("prod")]),
		("issue", "issue://5", credentialed, vec![FetchHost::github("ghe.example.com")]),
		("listed", r#"["https://docs.rs/a","notes.txt","https://crates.io/b"]"#, anonymous, vec![
			FetchHost::http("crates.io", 443),
			FetchHost::http("docs.rs", 443),
		]),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, refusing.clone()).await;
		let verdict = invoke_probe(
			&client,
			&server,
			"read",
			invocation_id,
			serde_json::json!({ "path": path }),
			None,
		)
		.await
		.expect("a verdict");
		assert!(verdict.is_error, "{invocation_id}: the refused prompt denies the read");
		let seen = refusing.seen.lock().clone();
		assert_eq!(seen.len(), 1, "{invocation_id}: one query");
		let effects = seen[0]
			.effects
			.as_ref()
			.map(|envelope| Effects::try_from(envelope).expect("a typed envelope"))
			.expect("the query reports the envelope");
		assert_eq!(effects, read_effects(fetch), "{invocation_id}");
		let hosts = seen[0]
			.fetch
			.iter()
			.map(|target| FetchHost::try_from(target).expect("a named host"))
			.collect::<Vec<_>>();
		assert_eq!(hosts, named, "{invocation_id}");
		assert!(!seen[0].fetch_unnamed, "{invocation_id}: every host is named");
		drop(client);
		serving.abort();
	}

	for mode in [pb::ApprovalMode::AlwaysAsk, pb::ApprovalMode::Write, pb::ApprovalMode::Yolo] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) = scoped_probe_client(&server, mode, refusing.clone()).await;
		let verdict = invoke_probe(
			&client,
			&server,
			"read",
			"local",
			serde_json::json!({ "path": "notes.txt" }),
			None,
		)
		.await
		.expect("a verdict");
		assert!(refusing.seen.lock().is_empty(), "{mode:?}: a local read never asks");
		assert!(!verdict.is_error, "{mode:?}: {}", String::from_utf8_lossy(&verdict.json));
		assert!(String::from_utf8_lossy(&verdict.json).contains("alpha"), "{mode:?}");
		drop(client);
		serving.abort();
	}

	let unreachable = format!("http://127.0.0.1:{}/x", closed_loopback_port());
	let plan = pb::ToolRestrictions {
		plan_file: Some("local://PLAN.md".to_owned()),
		..pb::ToolRestrictions::default()
	};
	for (mode, restrictions) in
		[(pb::ApprovalMode::Write, None), (pb::ApprovalMode::Yolo, Some(plan))]
	{
		let refusing = ScriptedAdmission::default();
		let (client, serving) = scoped_probe_client(&server, mode, refusing.clone()).await;
		invoke_probe(
			&client,
			&server,
			"read",
			"unasked-fetch",
			serde_json::json!({ "path": unreachable }),
			restrictions,
		)
		.await
		.expect("the fetch is admitted and runs");
		assert!(refusing.seen.lock().is_empty(), "{mode:?}: a fetch is not asked");
		drop(client);
		serving.abort();
	}
}

/// The production `grep@1`, `glob@1` and `ast_grep` declare the most their
/// roots can fetch and judge each call by the route its executor takes for
/// each root. grep: a local path, an archive member, `file://` and every
/// resolver-backed root that reads local state (`local://`, `omp://`, a
/// vault search, an unknown scheme) are document reads; an http(s) root is
/// an anonymous fetch; `ssh://` naming a host alias, `issue://` and an
/// `mcp://` resource no mounted server advertises are credentialed ones.
/// glob: a local glob and a vault walk are document reads, any walk over
/// `ssh://` a credentialed fetch (from the alias list it reaches every
/// configured host), and it never fetches a URL. `ast_grep`: only an
/// http(s) root fetches. Each fetch names the hosts the resolvers reach, and
/// the remainder they cannot name. A local search is `read` tier and runs
/// unasked in every mode and sandbox state; a fetch asks only under
/// `always-ask`. With `sv_fetch_enabled false` no URL root fetches and
/// the credentialed maxima stay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_search_tools_declare_their_remote_roots_and_local_roots_stay_read() {
	use crate::{
		admission::{ApprovalMode, ApprovalPolicy, ApprovalTier, SandboxState, SandboxUnavailable},
		fetch_host::FetchHost,
		tool_settings::ToolSettings,
	};

	let anonymous = Some(omp_tool::FetchEffects { credentials: false });
	let credentialed = Some(omp_tool::FetchEffects { credentials: true });
	let (server, root, _state) =
		configured_probe_daemon(Registry::new(), &["sv_ast_grep_enabled true"]).await;
	std::fs::create_dir(root.path().join(".git")).expect("git directory");
	std::fs::write(
		root.path().join(".git/config"),
		"[remote \"origin\"]\n\turl = git@GHE.example.com:Owner/Repo.git\n",
	)
	.expect("git config");
	let registry = server.registry();
	for (tool, maximum) in [("grep", credentialed), ("glob", credentialed), ("ast_grep", anonymous)]
	{
		assert_eq!(registry.effects_owned(tool).expect(tool), read_effects(maximum), "{tool}");
	}
	let names = server.fetch_hosts();
	let sandboxes = [SandboxState::Active, SandboxState::Off, SandboxState::Unavailable {
		cause: SandboxUnavailable::BackendUnavailable,
	}];
	let docs = || FetchHost::http("docs.rs", 443);
	let prod = || FetchHost::ssh("prod");
	for (tool, arguments, fetch, hosts, unnamed) in [
		("grep", serde_json::json!({ "pattern": "x" }), None, vec![], false),
		("grep", serde_json::json!({ "pattern": "x", "path": "src" }), None, vec![], false),
		("grep", serde_json::json!({ "pattern": "x", "path": "a.zip:docs" }), None, vec![], false),
		("grep", serde_json::json!({ "pattern": "x", "path": "file:///tmp/a" }), None, vec![], false),
		("grep", serde_json::json!({ "pattern": "x", "path": "local://a.md" }), None, vec![], false),
		("grep", serde_json::json!({ "pattern": "x", "path": "omp://" }), None, vec![], false),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "vault://notes?op=search&q=todo" }),
			None,
			vec![],
			false,
		),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "custom://thing" }),
			None,
			vec![],
			false,
		),
		("grep", serde_json::json!({ "pattern": "x", "path": "ssh://" }), None, vec![], false),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "https://docs.rs/serde:1-5" }),
			anonymous,
			vec![docs()],
			false,
		),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "ssh://prod/etc/hosts" }),
			credentialed,
			vec![prod()],
			false,
		),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "issue://5" }),
			credentialed,
			vec![FetchHost::github("ghe.example.com")],
			false,
		),
		(
			"grep",
			serde_json::json!({ "pattern": "x", "path": "mcp://unadvertised/resource" }),
			credentialed,
			vec![],
			true,
		),
		(
			"grep",
			serde_json::json!({
				"pattern": "x",
				"path": "src; https://docs.rs/x; ssh://prod/etc",
			}),
			credentialed,
			vec![docs(), prod()],
			false,
		),
		("glob", serde_json::json!({}), None, vec![], false),
		("glob", serde_json::json!({ "path": "src/**/*.rs" }), None, vec![], false),
		("glob", serde_json::json!({ "path": "vault://notes/**" }), None, vec![], false),
		("glob", serde_json::json!({ "path": "https://docs.rs/**" }), None, vec![], false),
		(
			"glob",
			serde_json::json!({ "path": "ssh://prod/src/**/*.rs" }),
			credentialed,
			vec![prod()],
			false,
		),
		("glob", serde_json::json!({ "path": "ssh:///**" }), credentialed, vec![], true),
		("glob", serde_json::json!({ "path": "ssh:///pr*/**" }), credentialed, vec![], true),
		(
			"glob",
			serde_json::json!({ "path": "ssh://pr*/**" }),
			credentialed,
			vec![FetchHost::ssh("pr*")],
			false,
		),
		(
			"glob",
			serde_json::json!({ "path": "src/**; ssh://prod/**" }),
			credentialed,
			vec![prod()],
			false,
		),
		("ast_grep", serde_json::json!({ "pat": "x", "path": "src" }), None, vec![], false),
		("ast_grep", serde_json::json!({ "pat": "x", "path": "local://a.rs" }), None, vec![], false),
		(
			"ast_grep",
			serde_json::json!({ "pat": "x", "path": "ssh://prod/a.rs" }),
			None,
			vec![],
			false,
		),
		(
			"ast_grep",
			serde_json::json!({ "pat": "x", "path": "src; https://docs.rs/a.rs" }),
			anonymous,
			vec![docs()],
			false,
		),
	] {
		let raw = arguments.to_string();
		let effects = registry.invocation_effects(tool, &raw).expect(&raw);
		assert_eq!(effects, read_effects(fetch), "{tool} {raw}");
		if fetch.is_some() {
			let named = names.name(&registry.fetch_locators(tool, &raw));
			assert_eq!(named.hosts(), hosts, "{tool} {raw}");
			assert_eq!(named.is_partly_unnamed(), unnamed, "{tool} {raw}");
		} else {
			assert!(registry.fetch_locators(tool, &raw).is_empty(), "{tool} {raw}");
		}
		let tier = if fetch.is_some() {
			ApprovalTier::Fetch
		} else {
			ApprovalTier::Read
		};
		for mode in
			[None, Some(ApprovalMode::AlwaysAsk), Some(ApprovalMode::Write), Some(ApprovalMode::Yolo)]
		{
			for sandbox in sandboxes {
				let decision = ToolSettings::default()
					.with_approval_mode_override(mode)
					.approval_for("c", tool, &effects, Confinement::Host, sandbox);
				let asks = fetch.is_some() && mode == Some(ApprovalMode::AlwaysAsk);
				assert_eq!(
					(decision.tier, decision.policy),
					(
						tier,
						if asks {
							ApprovalPolicy::Prompt
						} else {
							ApprovalPolicy::Allow
						}
					),
					"{tool} {raw} under {mode:?} with sandbox {sandbox:?}"
				);
			}
		}
	}
	drop(server);

	let (disabled, _root, _state) = configured_probe_daemon(Registry::new(), &[
		"sv_fetch_enabled false",
		"sv_ast_grep_enabled true",
	])
	.await;
	let registry = disabled.registry();
	for (tool, maximum) in [("grep", credentialed), ("glob", credentialed), ("ast_grep", None)] {
		assert_eq!(registry.effects_owned(tool).expect(tool), read_effects(maximum), "{tool}");
	}
	for (tool, arguments, fetch) in [
		("grep", serde_json::json!({ "pattern": "x", "path": "src" }), None),
		("grep", serde_json::json!({ "pattern": "x", "path": "https://docs.rs/serde" }), None),
		("grep", serde_json::json!({ "pattern": "x", "path": "ssh://prod/etc" }), credentialed),
		("glob", serde_json::json!({ "path": "ssh://prod/**" }), credentialed),
		("ast_grep", serde_json::json!({ "pat": "x", "path": "https://docs.rs/a.rs" }), None),
	] {
		let raw = arguments.to_string();
		assert_eq!(
			registry.invocation_effects(tool, &raw).expect(&raw),
			read_effects(fetch),
			"{tool} {raw} with URL fetches disabled"
		);
	}
}

/// The production search tools over a connection. Under `always-ask` a
/// grep of a URL or an `ssh://` host, a glob walking an `ssh://` host (one
/// it names, or every one from the alias list) and an `ast_grep` of a URL
/// each ask once, the query reporting the fetch the call was judged by and
/// every host its roots reach, and a refused prompt runs nothing. A search
/// of local roots never asks in any mode, and runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn search_queries_name_the_hosts_their_roots_reach() {
	use crate::fetch_host::FetchHost;

	let anonymous = Some(omp_tool::FetchEffects { credentials: false });
	let credentialed = Some(omp_tool::FetchEffects { credentials: true });
	let (server, root, _state) =
		configured_probe_daemon(Registry::new(), &["sv_ast_grep_enabled true"]).await;
	std::fs::write(root.path().join("notes.txt"), "alpha\n").expect("local file");
	std::fs::write(root.path().join("lib.rs"), "fn main() { call(1); }\n").expect("source");
	for (tool, invocation_id, arguments, fetch, named, unnamed) in [
		(
			"grep",
			"grep-url",
			serde_json::json!({ "pattern": "alpha", "path": "notes.txt; https://docs.rs/serde" }),
			anonymous,
			vec![FetchHost::http("docs.rs", 443)],
			false,
		),
		(
			"grep",
			"grep-ssh",
			serde_json::json!({ "pattern": "alpha", "path": "ssh://prod/etc/hosts" }),
			credentialed,
			vec![FetchHost::ssh("prod")],
			false,
		),
		(
			"glob",
			"glob-ssh",
			serde_json::json!({ "path": "ssh://prod/**/*.rs" }),
			credentialed,
			vec![FetchHost::ssh("prod")],
			false,
		),
		(
			"glob",
			"glob-aliases",
			serde_json::json!({ "path": "ssh:///**" }),
			credentialed,
			vec![],
			true,
		),
		(
			"ast_grep",
			"ast-url",
			serde_json::json!({ "pat": "call($A)", "path": "https://docs.rs/a.rs" }),
			anonymous,
			vec![FetchHost::http("docs.rs", 443)],
			false,
		),
	] {
		let refusing = ScriptedAdmission::default();
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, refusing.clone()).await;
		let verdict = invoke_probe(&client, &server, tool, invocation_id, arguments, None)
			.await
			.expect("a verdict");
		assert!(verdict.is_error, "{invocation_id}: the refused prompt denies the search");
		let seen = refusing.seen.lock().clone();
		assert_eq!(seen.len(), 1, "{invocation_id}: one query");
		let effects = seen[0]
			.effects
			.as_ref()
			.map(|envelope| Effects::try_from(envelope).expect("a typed envelope"))
			.expect("the query reports the envelope");
		assert_eq!(effects, read_effects(fetch), "{invocation_id}");
		let hosts = seen[0]
			.fetch
			.iter()
			.map(|target| FetchHost::try_from(target).expect("a named host"))
			.collect::<Vec<_>>();
		assert_eq!(hosts, named, "{invocation_id}");
		assert_eq!(seen[0].fetch_unnamed, unnamed, "{invocation_id}");
		drop(client);
		serving.abort();
	}

	for mode in [pb::ApprovalMode::AlwaysAsk, pb::ApprovalMode::Write, pb::ApprovalMode::Yolo] {
		for (tool, arguments, expected) in [
			("grep", serde_json::json!({ "pattern": "alpha", "path": "notes.txt" }), "alpha"),
			("glob", serde_json::json!({ "path": "*.txt" }), "notes.txt"),
			("ast_grep", serde_json::json!({ "pat": "call($A)", "path": "lib.rs" }), "call(1)"),
		] {
			let refusing = ScriptedAdmission::default();
			let (client, serving) = scoped_probe_client(&server, mode, refusing.clone()).await;
			let verdict = invoke_probe(&client, &server, tool, "local", arguments, None)
				.await
				.expect("a verdict");
			assert!(refusing.seen.lock().is_empty(), "{tool} under {mode:?}: never asks");
			let json = String::from_utf8_lossy(&verdict.json);
			assert!(!verdict.is_error, "{tool} under {mode:?}: {json}");
			assert!(json.contains(expected), "{tool} under {mode:?}: {json}");
			drop(client);
			serving.abort();
		}
	}
}

/// Arguments of [`PinningProbe`]: none.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PinningProbeParams {}

/// What one [`PinningProbe`] call's executor found pinned, beside what the
/// live state named by the time it ran.
type PinnedRun = (Option<omp_tool::ResolutionPin>, Str);

/// A native tool whose judgment reads live state, as `read` reads which
/// MCP server advertises a resource: judging a call pins the target `live`
/// names then. Its calls write documents, so `always-ask` asks. Its
/// executor records what it finds pinned beside what `live` names by the
/// time it runs.
struct PinningProbe {
	spec: omp_tool::ToolSpec,
	live: Arc<Mutex<Str>>,
	ran:  Arc<Mutex<Vec<PinnedRun>>>,
}

impl omp_tool::Tool for PinningProbe {
	type Fault = serde_json::Value;
	type Params = PinningProbeParams;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	const ARGUMENT_SCOPED_EFFECTS: bool = true;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn invocation_effects(&self, _params: &PinningProbeParams) -> Option<Effects> {
		InvocationPins::pin("probe", "target", || omp_tool::ResolutionPin {
			target: Some(self.live.lock().clone()),
			fetch:  None,
		});
		Some(self.spec.effects.clone())
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<
		Item = omp_tool::Ev<serde_json::Value, serde_json::Value, serde_json::Value>,
	> + Send
	+ 'c {
		async_stream::stream! {
			params.committed().await.expect("probe commitment");
			let pinned = InvocationPins::pinned("probe", "target");
			self.ran.lock().push((pinned, self.live.lock().clone()));
			yield omp_tool::Ev::Done(ToolTerminal::Done {
				result: Ok(serde_json::json!({"text": "ran"})),
				useless: false,
			});
		}
	}

	fn prompt(
		&self,
		_view: Result<&serde_json::Value, &serde_json::Value>,
		_caps: &omp_tool::PromptCaps,
	) -> Vec<omp_tool::Part> {
		vec![omp_tool::Part::Text { text: sf!("ran") }]
	}
}

/// Allows every admission query once the live state has moved on, as it
/// may while the user is asked.
struct MovingAdmission {
	live: Arc<Mutex<Str>>,
}

impl omp_env::Admitter for MovingAdmission {
	type Future<'client> = future::Ready<pb::Admission>;

	fn admit(&self, query: pb::AdmitInvocation) -> Self::Future<'_> {
		*self.live.lock() = sf!("moved");
		future::ready(pb::Admission {
			invocation_id: query.invocation_id,
			allow: true,
			..pb::Admission::default()
		})
	}
}

/// A native call is judged and run inside one set of pins: what its
/// judgment at commit resolved from live state is what its executor
/// reaches, though that state moved while the user was asked. Each call
/// judges afresh.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_native_call_runs_inside_the_pins_its_judgment_fixed() {
	let live = Arc::new(Mutex::new(sf!("judged")));
	let ran = Arc::new(Mutex::new(Vec::new()));
	let mut registry = Registry::new();
	registry
		.register(
			PinningProbe {
				spec: omp_tool::ToolSpec {
					name:            sf!("pinning_probe"),
					rev:             omp_tool::Rev { family: Str::default(), n: 1 },
					description:     sf!("judges each call by live state"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      omp_tool::Constraint::None,
					effects:         Effects {
						documents: Some(omp_tool::DocEffects {
							read:        true,
							write_globs: Arc::from([sf!("**")]),
						}),
						..Effects::empty()
					},
					confinement:     Confinement::Host,
					projection_code: [0; 32],
				},
				live: Arc::clone(&live),
				ran:  Arc::clone(&ran),
			},
			omp_tool::Presentation::Slot,
			omp_tool::Claims {
				precedence: omp_tool::Precedence::DEFAULT,
				claimant:   sf!("omp/test"),
				replaces:   None,
			},
		)
		.expect("register the pinning probe");
	let (server, _root, _state) = probe_daemon(registry).await;
	let judged = |target: &'static str| omp_tool::ResolutionPin {
		target: Some(Str::new_static(target)),
		fetch:  None,
	};
	for (invocation_id, expected) in [
		("first", (Some(judged("judged")), sf!("moved"))),
		("second", (Some(judged("moved")), sf!("moved"))),
	] {
		let admission = MovingAdmission { live: Arc::clone(&live) };
		let (client, serving) =
			scoped_probe_client(&server, pb::ApprovalMode::AlwaysAsk, admission).await;
		let verdict = invoke_probe(
			&client,
			&server,
			"pinning_probe",
			invocation_id,
			serde_json::json!({}),
			None,
		)
		.await
		.expect("a verdict");
		assert!(!verdict.is_error, "{invocation_id}: {}", String::from_utf8_lossy(&verdict.json));
		assert_eq!(ran.lock().pop(), Some(expected), "{invocation_id}");
		drop(client);
		serving.abort();
	}
}

#[test]
fn worker_projection_retains_canonical_spilled_outcome_and_parts() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blob host");
	let outcome = serde_json::json!({"kind": "faulted", "value": {
		"reason": "x".repeat(DEFAULT_RESULT_PROJECTION_BYTES + 1),
		"artifact": "artifact://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}});
	let bytes = serde_json::to_vec(&outcome).expect("outcome JSON");
	let blob = blobs
		.put_verdict_bytes(Some("session"), "call", &bytes)
		.expect("store canonical outcome");
	let text = "é".repeat(DEFAULT_RESULT_PROJECTION_BYTES);
	let completion = ExtHostCompletion {
		call_id:      sf!("call"),
		kind:         ExtHostOutcomeKind::Faulted,
		parts:        vec![thread_pb::Part { kind: Some(thread_pb::part::Kind::Text(text.clone())) }],
		details_json: None,
		details_blob: Some(blob.clone()),
		args_issue:   None,
		useless:      false,
		terminate:    true,
	};
	let (json, artifact, is_error) = projected_worker_completion_json(
		&blobs,
		&completion,
		omp_tool::OutputRequest::Bounded,
		Some("session"),
		"call",
	)
	.expect("bounded projection");
	assert!(json.is_empty());
	assert_eq!(artifact, Some(blob.clone()));
	assert!(is_error);
	assert_eq!(blob.hash.as_ref(), Hash32::sum(&bytes).as_bytes());
	assert_eq!(blob.size, bytes.len() as u64);
	assert_eq!(
		materialize_worker_outcome(&blobs, &completion)
			.expect("read full outcome")
			.as_ref(),
		bytes.as_slice()
	);
	let mut parts = completion.parts.clone();
	let (source_bytes, inline_bytes, omitted) =
		project_wire_parts(&mut parts, omp_tool::OutputRequest::Bounded);
	assert!(omitted);
	assert!(source_bytes > inline_bytes);
	assert!(inline_bytes <= DEFAULT_RESULT_PROJECTION_BYTES as u64);
	let Some(thread_pb::part::Kind::Text(projected)) =
		parts.first().and_then(|part| part.kind.as_ref())
	else {
		panic!("bounded text projection must survive the spill");
	};
	assert!(!projected.is_empty());
	assert!(text.starts_with(projected));
	let (json, artifact, _) = projected_worker_completion_json(
		&blobs,
		&completion,
		omp_tool::OutputRequest::Complete,
		Some("session"),
		"call",
	)
	.expect("complete projection");
	assert_eq!(json.as_ref(), bytes.as_slice());
	assert_eq!(artifact, Some(blob));
}

#[test]
fn worker_projection_bounds_the_canonical_envelope_not_just_details() {
	let root = tempfile::tempdir().expect("blob root");
	let blobs = BlobHost::open(root.path()).expect("blob host");
	let details = Bytes::from(
		serde_json::to_vec(&"x".repeat(DEFAULT_RESULT_PROJECTION_BYTES - 2)).expect("details JSON"),
	);
	assert_eq!(details.len(), DEFAULT_RESULT_PROJECTION_BYTES);
	let expected = worker_verdict_json(details.clone(), false).expect("outcome envelope");
	let completion = ExtHostCompletion {
		call_id:      sf!("boundary"),
		kind:         ExtHostOutcomeKind::Ok,
		parts:        Vec::new(),
		details_json: Some(details),
		details_blob: None,
		args_issue:   None,
		useless:      false,
		terminate:    false,
	};
	let (json, artifact, is_error) = projected_worker_completion_json(
		&blobs,
		&completion,
		omp_tool::OutputRequest::Bounded,
		Some("session"),
		"boundary",
	)
	.expect("bounded envelope");
	assert!(json.is_empty());
	assert!(!is_error);
	let artifact = artifact.expect("complete canonical artifact");
	assert_eq!(artifact.hash.as_ref(), Hash32::sum(&expected).as_bytes());
	assert_eq!(
		blobs
			.get(BlobId {
				hash: artifact.hash.as_ref().try_into().expect("digest"),
				size: artifact.size,
			})
			.expect("read canonical artifact"),
		expected
	);
}
