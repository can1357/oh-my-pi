//! Behavioral contracts for the persistent native `bash@1` executor.

use std::{
	collections::{BTreeMap, VecDeque},
	convert, future,
	io::Cursor,
	sync::Arc,
	thread,
	time::Duration,
};

use bytes::Bytes;
use futures::{FutureExt, StreamExt, executor::block_on, pin_mut};
use omp_core::{CowBytes, Str, sf};
use omp_proto::inference::v1::invoke_input::{self, chunk};
use omp_shell_builtins::encode_image_passthrough;
use omp_tool::{
	Abort, ArtifactLifetime, CallOutcome, CallOutcomeDetails, CallOutcomeSpill, CapsBase, Claims,
	DiagEnvelope, DiagKind, ErasedEv, ErasedOutcome, Ev, IncomingParams, Interrupt, JobOwner,
	ModelClass, Part, Precedence, Presentation, PromptCaps, Registry, Severity, Tool, ToolIdentity,
	ToolTerminal,
};
use omp_tools::{
	auto_background::DetachedJob,
	shell::{
		self, AdjustmentReceipt, DetachRequest, ExecOutcome, ExecStatus, Fault, OutputChannel,
		Payload, RunEvent, RunRequest, Session, SessionOptions, ShellExec, ShellRun, Update,
	},
};
use parking_lot::Mutex;
use tokio::{task, time};

#[derive(Default)]
struct State {
	opens:           usize,
	closes:          usize,
	session_options: Vec<SessionOptions>,
	runs:            Vec<(Bytes, RunRequest)>,
	detaches:        Vec<DetachRequest>,
	cancels:         usize,
	cwd:             String,
	env_value:       String,
}

#[derive(Default)]
struct RecordingSpill {
	bytes: Mutex<Vec<u8>>,
}

impl CallOutcomeSpill for RecordingSpill {
	type Error = convert::Infallible;
	type Stage<'a> = Cursor<Vec<u8>>;

	fn open(&self) -> Result<Self::Stage<'_>, Self::Error> {
		Ok(Cursor::new(Vec::new()))
	}

	async fn finish<'a>(&'a self, stage: Self::Stage<'a>) -> Result<omp_tool::BlobRef, Self::Error> {
		let bytes = stage.into_inner();
		*self.bytes.lock() = bytes.clone();
		Ok(omp_tool::BlobRef {
			hash:       sf!("sha256:captured"),
			media_type: sf!("application/json"),
			byte_len:   bytes.len() as u64,
		})
	}
}

#[derive(Clone, Default)]
struct FakeExec {
	state: Arc<Mutex<State>>,
}

struct FakeRun {
	events:    VecDeque<RunEvent>,
	cancelled: Arc<Mutex<Option<RunEvent>>>,
	state:     Arc<Mutex<State>>,
}

impl ShellRun for FakeRun {
	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		if let Some(event) = self.events.pop_front() {
			return Ok(Some(event));
		}
		let cancelled = { self.cancelled.lock().take() };
		if let Some(event) = cancelled {
			return Ok(Some(event));
		}
		futures::future::pending().await
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		self.state.lock().cancels += 1;
		*self.cancelled.lock() = Some(RunEvent::Exit(status(ExecOutcome::Cancelled)));
		future::ready(Ok(()))
	}

	fn detach(&self, name: Str) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_ {
		future::ready(Ok(DetachedJob {
			id:    sf!("process:{name}:1"),
			owner: JobOwner::NamedProcess { name, generation: 1 },
		}))
	}
}

impl ShellExec for FakeExec {
	type Run = FakeRun;

	fn open_session(
		&self,
		options: SessionOptions,
	) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		let mut state = self.state.lock();
		state.opens += 1;
		state.session_options.push(options);
		if state.cwd.is_empty() {
			state.cwd = "/workspace".into();
		}
		future::ready(Ok(Session { id: Bytes::from(format!("session-{}", state.opens)) }))
	}

	fn close_session<'a>(
		&'a self,
		_: &'a Session,
	) -> impl Future<Output = Result<(), Fault>> + Send + 'a {
		self.state.lock().closes += 1;
		future::ready(Ok(()))
	}

	fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		let mut events = VecDeque::new();
		let command = request.command.clone();
		self.state.lock().runs.push((session.id.clone(), request));
		events.push_back(RunEvent::Started { exec_id: Bytes::from(format!("exec-{command}")) });
		match command.as_str() {
			"set-state" => {
				let mut state = self.state.lock();
				state.cwd = "/workspace/subdir".into();
				state.env_value = "preserved".into();
				events.push_back(RunEvent::Exit(status(ExecOutcome::Exited)));
			},
			"show-state" => {
				let state = self.state.lock();
				let text = format!("{}\n{}\n", state.cwd, state.env_value).into_bytes();
				drop(state);
				events.push_back(RunEvent::Output(Update {
					channel:  OutputChannel::Stdout,
					data:     text.into(),
					sequence: 1,
					exec_id:  Bytes::new(),
					started:  false,
					terminal: false,
				}));
				events.push_back(RunEvent::Exit(status(ExecOutcome::Exited)));
			},
			"ordered" => {
				for (channel, data, sequence) in [
					(OutputChannel::Stdout, CowBytes::from_static(b"one"), 4),
					(OutputChannel::Stderr, CowBytes::from_static(b"two"), 5),
					(OutputChannel::Stdout, CowBytes::from_static(b"three"), 6),
				] {
					events.push_back(RunEvent::Output(Update {
						channel,
						data,
						sequence,
						exec_id: Bytes::new(),
						started: false,
						terminal: false,
					}));
				}
				events.push_back(RunEvent::Exit(status(ExecOutcome::Exited)));
			},
			"graphics" => {
				let mut encoded = b"before\n".to_vec();
				encode_image_passthrough("image/png", b"\x89PNG\r\n\x1a\npixels", &mut encoded);
				encoded.extend_from_slice(b"\nafter\n");
				let split = encoded.len() / 2;
				for (sequence, data) in [(1, encoded[..split].to_vec()), (2, encoded[split..].to_vec())]
				{
					events.push_back(RunEvent::Output(Update {
						channel: OutputChannel::Stdout,
						data: CowBytes::owned(Bytes::from(data)),
						sequence,
						exec_id: Bytes::new(),
						started: false,
						terminal: false,
					}));
				}
				events.push_back(RunEvent::Exit(status(ExecOutcome::Exited)));
			},
			"timeout" => events.push_back(RunEvent::Exit(status(ExecOutcome::Timeout))),
			"sandboxed" => {
				let mut terminal = status(ExecOutcome::Exited);
				terminal.diags.push(omp_tool::Diag::info(
					DiagKind::Sandbox,
					sf!(
						"sandbox: backend=seatbelt; mode=workspace-write; writes outside workspace are \
						 denied"
					),
				));
				events.push_back(RunEvent::Exit(terminal));
			},
			"nonzero" => {
				let mut terminal = status(ExecOutcome::Exited);
				terminal.exit_code = Some(17);
				events.push_back(RunEvent::Exit(terminal));
			},
			"overflow" => {
				events.push_back(RunEvent::Output(Update {
					channel:  OutputChannel::Stdout,
					data:     CowBytes::owned(Bytes::from(vec![b'x'; 16])),
					sequence: 1,
					exec_id:  Bytes::new(),
					started:  false,
					terminal: false,
				}));
				let mut terminal = status(ExecOutcome::Exited);
				terminal.spilled_output = Some(omp_tool::BlobRef {
					hash:       sf!("overflow"),
					media_type: sf!("application/octet-stream"),
					byte_len:   4096,
				});
				events.push_back(RunEvent::Exit(terminal));
			},
			"wait" => {},
			"effects-unknown" => {
				let mut terminal = status(ExecOutcome::Cancelled);
				terminal.effects_unknown = true;
				events.push_back(RunEvent::Exit(terminal));
			},
			_ => events.push_back(RunEvent::Exit(status(ExecOutcome::Exited))),
		}
		future::ready(Ok(FakeRun {
			events,
			cancelled: Arc::new(Mutex::new(None)),
			state: Arc::clone(&self.state),
		}))
	}

	fn store_attachment(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl future::Future<Output = Result<omp_tool::BlobRef, Fault>> + Send + '_ {
		future::ready(Ok(omp_tool::BlobRef {
			hash: Str::from(omp_core::Hash32::sum(&bytes).to_hex().as_str()),
			media_type,
			byte_len: bytes.len() as u64,
		}))
	}

	async fn detach(&self, request: DetachRequest) -> Result<DetachedJob, Fault> {
		let pending = request.command == "pending-detach";
		let id = sf!("process:{}:1", request.name);
		let owner_name = request.name.clone();
		self.state.lock().detaches.push(request);
		if pending {
			futures::future::pending::<()>().await;
		}
		Ok(DetachedJob { id, owner: JobOwner::NamedProcess { name: owner_name, generation: 1 } })
	}
}

fn status(outcome: ExecOutcome) -> ExecStatus {
	ExecStatus {
		outcome,
		exit_code: (outcome == ExecOutcome::Exited).then_some(0),
		signal: None,
		wall_clock_ms: 7,
		spilled_output: None,
		aborted: matches!(outcome, ExecOutcome::Timeout | ExecOutcome::Cancelled),
		effects_unknown: false,
		diags: Vec::new(),
		final_cwd_uri: None,
		final_cwd_revision: 0,
	}
}

fn registry(exec: FakeExec, _: usize) -> Registry {
	let mut registry = Registry::new();
	registry
		.register(shell::shell(exec), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   sf!("omp/core"),
			replaces:   None,
		})
		.expect("shell schema and revision register");
	registry
}

fn call(registry: &Registry, raw: &str) -> Vec<ErasedEv> {
	let (feed, params) = IncomingParams::channel();
	feed.args_committed(Str::new(raw)).unwrap();
	let stream = registry.invoke("bash", params).unwrap();
	block_on(stream.map(|event| event.unwrap()).collect())
}

fn payload(events: &[ErasedEv]) -> Payload {
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("foreground call must end in a verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	let CallOutcome::Ok(payload) = outcome else {
		panic!("expected successful payload")
	};
	payload
}

fn failed_payload(events: &[ErasedEv]) -> Payload {
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("failed foreground call must end in a verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	let CallOutcome::Faulted(Fault::CommandFailed { payload }) = outcome else {
		panic!("expected command failure payload")
	};
	*payload
}

fn committed(raw: &str) -> IncomingParams<'static> {
	let (feed, params) = IncomingParams::channel();
	feed.args_committed(Str::new(raw)).unwrap();
	params
}

#[test]
fn constructed_tool_spec_preserves_the_bash_schema_contract() {
	let tool = shell::shell(FakeExec::default());
	let actual: serde_json::Value = serde_json::from_slice(&tool.spec().schema).unwrap();
	assert_eq!(tool.spec().schema.as_ref(), omp_tool::schema::<shell::Params>().as_ref());
	let properties = actual["properties"].as_object().unwrap();
	for key in ["command", "timeout", "env", "cwd", "pty", "async"] {
		assert!(properties.contains_key(key), "bash schema must expose {key}");
	}
	assert!(!properties.contains_key("name"));
	assert_eq!(actual["properties"]["timeout"]["minimum"], 0.0);
	assert_eq!(
		actual["properties"]["timeout"]["description"],
		"Host-enforced execution timeout in seconds; zero disables the deadline; nonzero values do \
		 not extend the foreground auto-background threshold."
	);
	assert!(
		tool
			.spec()
			.description
			.contains("`timeout` is measured in seconds")
	);
	assert!(
		serde_json::from_value::<shell::Params>(serde_json::json!({
			"command": "echo ok",
			"extra": true
		}))
		.is_err()
	);
	let params = serde_json::from_value::<shell::Params>(serde_json::json!({
		"command": "echo env",
		"env": {"ADD": "value", "REMOVE": null}
	}))
	.expect("environment delta accepts set and unset values");
	assert_eq!(params.env.get("ADD"), Some(&Some(sf!("value"))));
	assert_eq!(params.env.get("REMOVE"), Some(&None));
}

#[test]
fn execution_waits_for_the_explicit_commit_gate() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	let (feed, params) = IncomingParams::channel();
	feed.arg_text(sf!(r#"{{"command":"ordered"}}"#)).unwrap();
	let stream = registry.invoke("bash", params).unwrap();
	pin_mut!(stream);
	assert!(stream.next().now_or_never().is_none());
	assert_eq!(exec.state.lock().opens, 0);
	assert!(exec.state.lock().runs.is_empty());

	feed
		.args_committed(sf!(r#"{{"command":"ordered"}}"#))
		.unwrap();
	let events = block_on(stream.map(|event| event.unwrap()).collect::<Vec<_>>());
	assert_eq!(payload(&events).status.outcome, ExecOutcome::Exited);
	assert_eq!(exec.state.lock().runs.len(), 1);
}

#[test]
fn one_session_is_reused_with_its_cwd_and_environment_state() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	assert_eq!(
		payload(&call(&registry, r#"{"command":"set-state"}"#)).session_id,
		Bytes::from_static(b"session-1"),
	);
	let shown = payload(&call(&registry, r#"{"command":"show-state"}"#));
	assert_eq!(shown.session_id, Bytes::from_static(b"session-1"));
	assert_eq!(shown.transcript[0].data, b"/workspace/subdir\npreserved\n");
	let state = exec.state.lock();
	assert_eq!(state.opens, 1);
	assert!(
		state
			.runs
			.iter()
			.all(|run| run.0 == Bytes::from_static(b"session-1"))
	);
}

#[test]
fn command_environment_is_routed_to_the_run_not_the_session() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	let _ = call(&registry, r#"{"command":"show-env","env":{"ADD":"value","REMOVE":null}}"#);
	let state = exec.state.lock();
	assert!(state.session_options[0].env.is_empty());
	assert_eq!(
		state.runs[0].1.environment,
		BTreeMap::from([(sf!("ADD"), Some(sf!("value"))), (sf!("REMOVE"), None),]),
	);
}

#[test]
fn explicit_cwd_and_shell_expansions_preserve_leading_cd_commands() {
	let explicit = FakeExec::default();
	let _ = call(&registry(explicit.clone(), 1024), r#"{"command":"cd /var && pwd","cwd":"/tmp"}"#);
	let explicit_state = explicit.state.lock();
	assert_eq!(explicit_state.session_options[0].cwd.as_deref(), Some("/tmp"));
	assert_eq!(explicit_state.runs[0].1.command, "cd /var && pwd");
	drop(explicit_state);

	let expansion = FakeExec::default();
	let _ = call(&registry(expansion.clone(), 1024), r#"{"command":"cd \"$HOME\" && pwd"}"#);
	let expansion_state = expansion.state.lock();
	assert_eq!(expansion_state.session_options[0].cwd, None);
	assert_eq!(expansion_state.runs[0].1.command, r#"cd "$HOME" && pwd"#);
}

#[test]
fn live_updates_and_durable_transcript_preserve_host_order() {
	let exec = FakeExec::default();
	let events = call(&registry(exec, 1024), r#"{"command":"ordered"}"#);
	let updates = events
		.iter()
		.filter_map(|event| match event {
			ErasedEv::Update(json) => Some(serde_json::from_slice::<Update>(json).unwrap()),
			ErasedEv::Done(_) => None,
		})
		.collect::<Vec<_>>();
	assert_eq!(
		updates
			.iter()
			.map(|update| update.sequence)
			.collect::<Vec<_>>(),
		[0, 4, 5, 6]
	);
	let started = &updates[0];
	assert!(started.started);
	assert_eq!(started.exec_id, Bytes::from_static(b"exec-ordered"));
	assert!(started.data.is_empty());
	assert_eq!(started.channel, OutputChannel::Stdout);
	assert!(!started.terminal);
	assert!(updates[1..].iter().all(|update| !update.started));
	assert_eq!(
		payload(&events)
			.transcript
			.iter()
			.map(|frame| frame.sequence)
			.collect::<Vec<_>>(),
		[4, 5, 6]
	);
}

#[test]
fn timeout_clamp_journals_a_receipt_and_returns_a_failed_outcome() {
	let exec = FakeExec::default();
	let events = call(&registry(exec.clone(), 1024), r#"{"command":"timeout","timeout":0.023}"#);
	let result = failed_payload(&events);
	assert_eq!(result.status.outcome, ExecOutcome::Timeout);
	assert!(result.status.aborted);
	assert_eq!(exec.state.lock().runs[0].1.timeout_ms, Some(1_000));
	assert_eq!(result.adjustments, [AdjustmentReceipt::TimeoutClamped {
		requested_ms: 23,
		effective_ms: 1_000,
	}],);
}

#[test]
fn timeout_zero_disables_and_values_above_3600_seconds_clamp() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);

	let zero = payload(&call(&registry, r#"{"command":"zero","timeout":0}"#));
	assert!(zero.adjustments.is_empty());
	assert_eq!(exec.state.lock().runs[0].1.timeout_ms, None);

	let clamped = payload(&call(&registry, r#"{"command":"large","timeout":4000}"#));
	assert_eq!(exec.state.lock().runs[1].1.timeout_ms, Some(3_600_000));
	assert_eq!(clamped.adjustments, [AdjustmentReceipt::TimeoutClamped {
		requested_ms: 4_000_000,
		effective_ms: 3_600_000,
	}]);
}

#[test]
fn aborted_foreground_run_quarantines_its_pooled_session() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	let timed_out = failed_payload(&call(&registry, r#"{"command":"timeout"}"#));
	assert_eq!(timed_out.status.outcome, ExecOutcome::Timeout);
	let later = payload(&call(&registry, r#"{"command":"show-state"}"#));
	assert_eq!(later.session_id, Bytes::from_static(b"session-2"));
	let state = exec.state.lock();
	assert_eq!(state.opens, 2);
	assert_eq!(state.closes, 1);
}

#[test]
fn shell_wrapper_preserves_the_host_projection_without_a_second_bound() {
	let exec = FakeExec::default();
	let events = call(&registry(exec, 4), r#"{"command":"overflow"}"#);
	let result = payload(&events);
	assert_eq!(result.transcript[0].data, b"xxxxxxxxxxxxxxxx");
	assert_eq!(result.status.spilled_output.as_ref().unwrap().hash, "overflow");
	assert!(
		matches!(events.first(), Some(ErasedEv::Update(_))),
		"the shell wrapper forwards the already-bounded host projection"
	);
}

#[test]
fn shell_extracts_split_graphics_as_full_typed_attachments() {
	let registry = registry(FakeExec::default(), 1024);
	let events = call(&registry, r#"{"command":"graphics"}"#);
	let result = payload(&events);
	assert_eq!(result.attachments.len(), 1);
	assert_eq!(result.attachments[0].media_type, "image/png");
	assert_eq!(result.attachments[0].byte_len, 14);
	let text = result
		.transcript
		.iter()
		.flat_map(|frame| frame.data.as_ref())
		.copied()
		.collect::<Vec<_>>();
	assert_eq!(text, b"before\n\nafter\n");

	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("graphics command must produce a verdict")
	};
	let (name, rev) = registry.live_identity("bash").unwrap();
	let caps = PromptCaps::for_tool(
		CapsBase {
			maximum_parts:      2,
			maximum_text_bytes: 1024,
			media:              true,
			model_class:        ModelClass::Standard,
		},
		rev,
	);
	let parts = registry
		.prompt(&ToolIdentity { name: name.clone(), rev: rev.clone() }, verdict, &caps)
		.unwrap()
		.unwrap();
	assert!(
		matches!(parts.last(), Some(Part::Blob { blob, .. }) if blob.media_type == "image/png" && blob.byte_len == 14)
	);
}

#[tokio::test]
async fn shell_spills_whole_verdict_through_the_central_blob_gate_at_threshold() {
	let result = payload(&call(&registry(FakeExec::default(), 1024), r#"{"command":"overflow"}"#));
	let spill = RecordingSpill::default();
	let outcome = CallOutcome::<Payload, Fault>::Ok(result);
	let details = omp_tool::call_outcome_details(&outcome, 8, &spill)
		.await
		.unwrap();
	assert!(matches!(
		details,
		CallOutcomeDetails::Spilled { blob, .. } if blob.hash == "sha256:captured"
	));
	let spilled: CallOutcome<Payload, Fault> =
		serde_json::from_slice(&spill.bytes.lock()).expect("spilled verdict remains valid JSON");
	let CallOutcome::Ok(spilled) = spilled else {
		panic!("spilled verdict remains successful");
	};
	assert_eq!(
		spilled.transcript[0].data, b"xxxxxxxxxxxxxxxx",
		"spill stage receives complete output rather than a truncated replacement"
	);
}

#[test]
fn async_allocates_a_managed_session_lifetime_job_reference() {
	let exec = FakeExec::default();
	let events =
		call(&registry(exec.clone(), 1024), r#"{"command":"serve","async":true,"timeout":0.05}"#);
	let ErasedEv::Done(ErasedOutcome::Detached(job)) = events.last().unwrap() else {
		panic!("async must return a detached outcome")
	};
	assert_eq!(job.id, "process:bash-bg-1:1");
	assert_eq!(job.owner, JobOwner::NamedProcess { name: sf!("bash-bg-1"), generation: 1 });
	assert_eq!(job.artifact.lifetime, ArtifactLifetime::Session);
	assert_eq!(
		job.artifact.media_type.as_deref(),
		Some("application/vnd.omp.process-settlement+json")
	);
	let state = exec.state.lock();
	assert_eq!(state.opens, 0, "async does not open the foreground session");
	assert_eq!(state.detaches[0].timeout_ms, Some(1_000));
}

#[tokio::test]
async fn foreground_wait_threshold_detaches_the_exact_running_command() {
	let tool = shell::shell(FakeExec::default()).with_auto_background(true, Duration::ZERO);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"command":"wait"}}"#))
		.expect("shell invocation remains live");
	let mut events = Box::pin(tool.call(params));
	let event = events.next().await.expect("detached terminal");
	let Ev::Done(ToolTerminal::Detached(job)) = event else {
		panic!("zero-threshold shell did not detach");
	};
	assert_eq!(job.id, "process:bash-bg-1:1");
	assert_eq!(job.owner, JobOwner::NamedProcess { name: sf!("bash-bg-1"), generation: 1 },);
}

#[test]
fn interrupt_during_async_setup_reports_effect_uncertainty() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"command":"pending-detach","async":true}}"#,))
		.unwrap();
	let wait_state = Arc::clone(&exec.state);
	let interrupter = thread::spawn(move || {
		while wait_state.lock().detaches.is_empty() {
			thread::yield_now();
		}
		feed
			.interrupt(Interrupt { class: sf!("immediate"), reason: sf!("stop detach") })
			.unwrap();
	});
	let stream = registry.invoke("bash", params).unwrap();
	let events = block_on(stream.map(|event| event.unwrap()).collect::<Vec<_>>());
	interrupter.join().unwrap();
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("interrupted async setup must produce a verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	assert!(matches!(outcome, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));
	assert_eq!(exec.state.lock().detaches.len(), 1);
}

#[test]
fn output_update_clones_share_owned_bytes() {
	let update = Update {
		channel:  OutputChannel::Stdout,
		data:     CowBytes::owned(Bytes::from(vec![1, 2, 3, 4])),
		sequence: 1,
		exec_id:  Bytes::new(),
		started:  false,
		terminal: false,
	};
	let cloned = update.clone();
	assert_eq!(update.data.as_ptr(), cloned.data.as_ptr());
}

#[test]
fn shell_updates_map_exactly_to_live_invoke_input_chunks() {
	let tool = shell::shell(FakeExec::default());
	for (source, expected) in [
		(OutputChannel::Stdout, chunk::Channel::Stdout),
		(OutputChannel::Stderr, chunk::Channel::Stderr),
		(OutputChannel::Pty, chunk::Channel::Stdout),
	] {
		let update = Update {
			channel:  source,
			data:     CowBytes::owned(Bytes::from(vec![7, 8, 9])),
			sequence: 42,
			exec_id:  Bytes::new(),
			started:  false,
			terminal: false,
		};
		let source_ptr = update.data.as_ptr();
		let input = tool.invoke_input(&update, "invocation-17").unwrap();
		assert_eq!(input.invocation_id, "invocation-17");
		let Some(invoke_input::Payload::Chunk(chunk)) = input.payload else {
			panic!("shell update must map to an invocation chunk")
		};
		assert_eq!(chunk.channel, expected as i32);
		assert_eq!(chunk.data, Bytes::from_static(&[7, 8, 9]));
		assert_eq!(chunk.data.as_ptr(), source_ptr, "owned output must remain zero-copy");
	}
}
#[test]
fn interrupt_before_execution_is_skipped_without_poisoning_later_calls() {
	let exec = FakeExec::default();
	let registry = registry(exec.clone(), 1024);
	let (feed, params) = IncomingParams::channel();
	feed.args_committed(sf!(r#"{{"command":"wait"}}"#)).unwrap();
	feed
		.interrupt(Interrupt { class: sf!("immediate"), reason: sf!("stop now") })
		.unwrap();
	let stream = registry.invoke("bash", params).unwrap();
	let events = block_on(stream.map(|event| event.unwrap()).collect::<Vec<_>>());
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("interrupted call must produce a verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	assert!(
		matches!(
			outcome,
			CallOutcome::Aborted { abort: Abort::Skipped { ref reason }, .. } if reason == "stop now"
		),
		"{outcome:?}"
	);
	{
		let state = exec.state.lock();
		assert_eq!(state.opens, 0);
		assert_eq!(state.runs.len(), 0);
		assert_eq!(state.cancels, 0);
	}

	let later = call(&registry, r#"{"command":"show-state"}"#);
	assert_eq!(payload(&later).status.outcome, ExecOutcome::Exited);
	let state = exec.state.lock();
	assert_eq!(state.opens, 1);
	assert_eq!(state.runs.len(), 1);
	assert_eq!(state.runs[0].0, Bytes::from_static(b"session-1"));
}

#[tokio::test]
async fn overlapping_foreground_runs_use_isolated_sessions() {
	let exec = FakeExec::default();
	let registry = Arc::new(registry(exec.clone(), 1024));
	let (active_feed, active_params) = IncomingParams::channel();
	active_feed
		.args_committed(sf!(r#"{{"command":"wait"}}"#))
		.unwrap();
	let active_registry = Arc::clone(&registry);
	let active = tokio::spawn(async move {
		active_registry
			.invoke("bash", active_params)
			.unwrap()
			.map(|event| event.unwrap())
			.collect::<Vec<_>>()
			.await
	});
	while exec.state.lock().runs.is_empty() {
		task::yield_now().await;
	}

	let isolated_registry = Arc::clone(&registry);
	let isolated = tokio::spawn(async move {
		isolated_registry
			.invoke("bash", committed(r#"{"command":"show-state"}"#))
			.unwrap()
			.map(|event| event.unwrap())
			.collect::<Vec<_>>()
			.await
	});
	let isolated_events = time::timeout(Duration::from_secs(1), isolated)
		.await
		.expect("isolated execution timeout")
		.expect("isolated invocation");
	assert_eq!(payload(&isolated_events).session_id, Bytes::from_static(b"session-2"));
	{
		let state = exec.state.lock();
		assert_eq!(state.runs.len(), 2);
		assert_eq!(state.closes, 1);
	}

	active_feed
		.interrupt(Interrupt { class: sf!("immediate"), reason: sf!("stop active") })
		.unwrap();
	let active_events = time::timeout(Duration::from_secs(1), active)
		.await
		.expect("active interrupt timeout")
		.expect("active invocation");
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = active_events.last().unwrap() else {
		panic!("interrupted active command must settle with a verdict");
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	assert!(matches!(outcome, CallOutcome::Aborted { abort: Abort::Interrupted { .. }, .. }));
	assert_eq!(exec.state.lock().cancels, 1);
}

#[test]
fn malformed_whole_arguments_are_a_structured_args_verdict() {
	let exec = FakeExec::default();
	let events = call(&registry(exec.clone(), 1024), r#"{"command":17}"#);
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("malformed args must produce a verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	assert!(matches!(outcome, CallOutcome::ArgsRejected(_)));
	let state = exec.state.lock();
	assert_eq!(state.opens, 0);
	assert!(state.runs.is_empty());
}

#[test]
fn sandbox_notice_is_a_structured_diag_not_process_output() {
	let events = call(&registry(FakeExec::default(), 1024), r#"{"command":"sandboxed"}"#);
	let diags = events
		.iter()
		.filter_map(|event| match event {
			ErasedEv::Update(json) => serde_json::from_slice::<DiagEnvelope>(json).ok(),
			ErasedEv::Done(_) => None,
		})
		.collect::<Vec<_>>();
	assert_eq!(diags.len(), 1);
	assert_eq!(diags[0].diag.native_kind(), Some(DiagKind::Sandbox));
	assert_eq!(diags[0].diag.severity, Severity::Info);
	assert!(payload(&events).transcript.is_empty());
}

#[test]
fn nonzero_exit_is_a_failed_outcome_with_transcript_and_status() {
	let events = call(&registry(FakeExec::default(), 1024), r#"{"command":"nonzero"}"#);
	let result = failed_payload(&events);
	assert_eq!(result.status.outcome, ExecOutcome::Exited);
	assert_eq!(result.status.exit_code, Some(17));
}

#[test]
fn leading_cd_and_extracts_an_isolated_structured_cwd() {
	let exec = FakeExec::default();
	let events = call(&registry(exec.clone(), 1024), r#"{"command":"cd 'work dir' && printf ok"}"#);
	assert_eq!(payload(&events).command, "printf ok");
	let state = exec.state.lock();
	assert_eq!(state.runs[0].1.command, "printf ok");
	assert_eq!(state.session_options[0].cwd.as_deref(), Some("work dir"));
	assert_eq!(state.closes, 1, "cwd-scoped sessions are isolated and closed");
}

#[test]
fn effects_unknown_cancelled_status_aborts_the_tool_outcome() {
	let events = call(&registry(FakeExec::default(), 1024), r#"{"command":"effects-unknown"}"#);
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("cancelled command must end in an aborted verdict")
	};
	let outcome: CallOutcome<Payload, Fault> = serde_json::from_slice(verdict).unwrap();
	assert!(matches!(outcome, CallOutcome::Aborted {
		abort: omp_tool::Abort::EffectsUnknown { .. },
		..
	}));
}

#[test]
fn prompt_projection_retains_status_and_the_host_bounded_stream_without_reprojection() {
	let registry = registry(FakeExec::default(), 1024);
	let events = call(&registry, r#"{"command":"ordered"}"#);
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = events.last().unwrap() else {
		panic!("foreground call must produce a verdict")
	};
	let (name, rev) = registry.live_identity("bash").unwrap();
	let caps = PromptCaps::for_tool(
		CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: 1024,
			media:              false,
			model_class:        ModelClass::Standard,
		},
		rev,
	);
	let parts = registry
		.prompt(&ToolIdentity { name: name.clone(), rev: rev.clone() }, verdict, &caps)
		.unwrap()
		.unwrap();
	let [Part::Text { text }] = parts.as_ref() else {
		panic!("shell prompt must be one capped text part")
	};
	assert!(text.len() <= 1024);
	assert!(text.contains("status=Exited"));
	assert!(text.contains("onetwothree"));
	assert!(!text.contains("output middle omitted"));

	let overflow = call(&registry, r#"{"command":"overflow"}"#);
	let ErasedEv::Done(ErasedOutcome::Done { verdict, .. }) = overflow.last().unwrap() else {
		panic!("overflow call must produce a verdict")
	};
	let parts = registry
		.prompt(&ToolIdentity { name: name.clone(), rev: rev.clone() }, verdict, &caps)
		.unwrap()
		.unwrap();
	let [Part::Text { text }] = parts.as_ref() else {
		panic!("overflow prompt must be text")
	};
	assert!(text.contains("artifact://sha256/overflow"));
}
