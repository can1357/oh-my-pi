//! Executable P3 proof for detached-process settlement and artifact delivery.

#![cfg(unix)]

use std::{
	fs,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use futures::StreamExt as _;
use nix::{sys::stat::Mode, unistd::mkfifo};
use omp_agent::{
	Agent, AgentEvent, AgentSnapshot, AgentState, EventSubscription, Journal, PromptFacts,
	TurnClient, TurnId, TurnInput, TurnOptions, TurnSession,
	testing::{Gate, ScriptedStep, ScriptedTurn, ScriptedTurnClient},
};
use omp_core::{Str, sf};
use omp_e2e::support::{
	AllowAdmission, Scratch, ScriptedGateway, accepted_event, install_omp_binary_env, omp_binary,
	outcome_event, tool_call_item, turn_event as scripted_turn_event, user_item,
};
use omp_env::{BlobDownloadEvent, EnvClient, ProcessAttachmentEvent};
use omp_envd::{EnvServer, RegistryBridges, worker::ExtHostConfig};
use omp_inference::{
	event::{BlockKind, ChatEvent, Completion, FinishReason},
	provider::fake::FakeScript,
	receipt::{ExecutionReceipt, Usage},
};
use omp_proto::{
	SCHEMA_REV,
	blob::v1::GetRequest,
	env::v1::{
		AttachOutput, ClientHello, ProcessSpec, ProcessState, RestartPolicy, RestartSpec, Script,
		StartProcess,
	},
	inference::v1::{self as inference, StopReason, part_start, turn_event, value},
	thread::v1::{self as thread, Revision, item, part},
};
use omp_storage::transcript::{Entry, Header, Kind, SessionId};
use omp_tool::{
	ArtifactLifetime, CapsBase, ExpectedArtifact, JobOwner, JobRef, JobStatus, ModelClass, Registry,
	ToolIdentity, ToolTerminal,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use tempfile::TempDir;
use tokio::{
	task::{self, JoinHandle},
	time,
};

const LIMIT: Duration = Duration::from_secs(15);
const SETTLEMENT_MIME: &str = "application/vnd.omp.process-settlement+json";
const CAPS_BASE: CapsBase = CapsBase {
	maximum_parts:      8,
	maximum_text_bytes: 4096,
	media:              false,
	model_class:        ModelClass::Standard,
};

struct RealEnv {
	client: EnvClient,
	server: Arc<EnvServer>,
	root:   TempDir,
	_state: TempDir,
	tasks:  Vec<JoinHandle<()>>,
}

impl RealEnv {
	async fn spawn() -> Self {
		install_omp_binary_env().expect("expose worker-capable host");
		let root = tempfile::tempdir().expect("workspace scratch directory");
		let state = tempfile::tempdir().expect("environment state directory");
		let server = Arc::new(
			EnvServer::open_local(
				root.path(),
				state.path(),
				Registry::new(),
				ExtHostConfig::new(
					omp_binary().expect("Cargo-built e2e host"),
					omp_core::Principal::new(omp_core::sf!("e2e-tester"), omp_core::sf!("E2E Tester")),
					omp_core::sf!("p3-session"),
					1,
				),
				RegistryBridges::default(),
			)
			.await
			.expect("real local environment"),
		);
		let (client, task) = connect_env(&server, "p3-primary").await;
		Self { client, server, root, _state: state, tasks: vec![task] }
	}

	async fn reconnect(&mut self, name: &str) -> EnvClient {
		let (client, task) = connect_env(&self.server, name).await;
		self.tasks.push(task);
		client
	}

	fn registry(&self) -> Arc<Registry> {
		self.server.registry()
	}

	fn cwd_uri(&self) -> String {
		let mut uri = String::from("file://");
		uri.push_str(self.root.path().to_str().expect("scratch path is UTF-8"));
		if !uri.ends_with('/') {
			uri.push('/');
		}
		uri
	}

	async fn read_blob(&self, hash: Bytes) -> Vec<u8> {
		let mut download = self
			.client
			.blob_get(GetRequest { hash, ..Default::default() })
			.await
			.expect("settlement artifact is addressable");
		let mut bytes = Vec::new();
		loop {
			match time::timeout(LIMIT, download.next_event())
				.await
				.expect("blob download timeout")
				.expect("blob download event")
				.expect("blob download did not close early")
			{
				BlobDownloadEvent::Chunk(chunk) => bytes.extend_from_slice(&chunk.data),
				BlobDownloadEvent::Complete(_) => return bytes,
			}
		}
	}
}

impl Drop for RealEnv {
	fn drop(&mut self) {
		for task in &self.tasks {
			task.abort();
		}
	}
}

async fn connect_env(server: &Arc<EnvServer>, name: &str) -> (EnvClient, JoinHandle<()>) {
	let (client, transport) = EnvClient::in_process(64);
	client.set_admitter(AllowAdmission);
	let host = Arc::clone(server);
	let task = tokio::spawn(async move { host.serve_in_process(transport).await });
	client
		.hello(ClientHello { client: name.to_owned(), schema_rev: SCHEMA_REV, ..Default::default() })
		.await
		.expect("environment hello");
	(client, task)
}

fn journal(path: &Path, root: &Path) -> Journal {
	Journal::create(path, &Header {
		v:       4,
		id:      SessionId(sf!("p3-detached-jobs")),
		created: 1,
		cwd:     root.to_owned(),
	})
	.expect("create agent journal")
}

fn state(root: &Path, registry: Arc<Registry>) -> AgentState {
	let turn = TurnOptions { context_id: Some(sf!("p3-context")), ..Default::default() };
	let snapshot = AgentSnapshot {
		enabled_tools: Arc::from([sf!("bash")]),
		..AgentSnapshot::new(
			turn,
			PromptFacts::new(root, Arc::from([]))
				.props()
				.expect("detached-job prompt facts"),
			registry,
		)
	};
	AgentState::new(snapshot)
}

fn revision(head: u64) -> Revision {
	Revision { head, token: Bytes::from(head.to_le_bytes().to_vec()) }
}

fn end_outcome(head: u64) -> inference::Outcome {
	inference::Outcome {
		stop: StopReason::StopEndTurn as i32,
		revision: Some(revision(head)),
		provider: "p3-script".to_owned(),
		model: "deterministic".to_owned(),
		..Default::default()
	}
}

fn shell_turn(command: String) -> ScriptedTurn {
	let identity =
		ToolIdentity { name: sf!("bash"), rev: omp_tool::Rev { family: Str::default(), n: 1 } };
	let args = Bytes::from(
		serde_json::to_vec(&serde_json::json!({
			"command": command,
			"async": true,
		}))
		.expect("shell args serialize"),
	);
	let call = tool_call_item(2, "shell-detached", &identity, args.clone());
	ScriptedTurn::events([
		accepted_event(false),
		scripted_turn_event(turn_event::Event::PartStart(inference::PartStart {
			index:        0,
			kind:         part_start::Kind::ToolCall as i32,
			tool_call_id: "shell-detached".to_owned(),
			tool_name:    "bash".to_owned(),
		})),
		scripted_turn_event(turn_event::Event::PartDelta(inference::PartDelta {
			index: 0,
			chunk: args,
		})),
		scripted_turn_event(turn_event::Event::PartEnd(inference::PartEnd {
			index:     0,
			signature: Bytes::new(),
		})),
		outcome_event(tool_use_outcome(call, 4)),
	])
}

fn tool_use_outcome(mut call: thread::Item, head: u64) -> inference::Outcome {
	call.seq = head;
	inference::Outcome {
		output: vec![call],
		stop: StopReason::StopToolUse as i32,
		revision: Some(revision(head)),
		provider: "p3-script".to_owned(),
		model: "deterministic".to_owned(),
		..Default::default()
	}
}

async fn wait_board_empty(board: &omp_agent::JobBoard) {
	time::timeout(LIMIT, async {
		while !board.is_empty() {
			task::yield_now().await;
		}
	})
	.await
	.expect("detached settlement watcher timeout");
}
async fn wait_job_completed(board: &omp_agent::JobBoard, job_id: &str) {
	time::timeout(LIMIT, async {
		loop {
			if board
				.pending()
				.iter()
				.any(|job| job.id == job_id && job.metadata.status == JobStatus::Completed)
			{
				return;
			}
			task::yield_now().await;
		}
	})
	.await
	.expect("detached process completed without updating its JobBoard entry");
}

async fn release_fifo(path: PathBuf) {
	time::timeout(LIMIT, task::spawn_blocking(move || fs::write(path, b"go\n")))
		.await
		.expect("FIFO writer timeout")
		.expect("FIFO writer task")
		.expect("release detached process");
}

async fn one_job_event(
	events: &EventSubscription,
	job_id: &str,
	registered: bool,
) -> Arc<AgentEvent> {
	loop {
		let event = time::timeout(LIMIT, events.recv())
			.await
			.expect("agent job event timeout")
			.expect("agent event bus closed");
		let matches = match event.as_ref() {
			AgentEvent::JobRegistered { job_id: actual } if registered => actual == job_id,
			AgentEvent::JobSettled { job_id: actual } if !registered => actual == job_id,
			_ => false,
		};
		if matches {
			return event;
		}
	}
}

fn delta(input: &TurnInput) -> &inference::ThreadDelta {
	match input {
		TurnInput::Delta(_, delta) => delta,
		TurnInput::Full(_) => panic!("expected incremental ThreadDelta"),
	}
}
fn input_items(input: &TurnInput) -> &[thread::Item] {
	match input {
		TurnInput::Full(thread) => &thread.items,
		TurnInput::Delta(_, delta) => &delta.append,
	}
}

fn tool_result<'a>(items: &'a [thread::Item], call_id: &str) -> &'a thread::ToolResult {
	let mut matching = items.iter().filter_map(|item| match item.kind.as_ref() {
		Some(item::Kind::ToolResult(result)) if result.call_id == call_id => Some(result),
		_ => None,
	});
	let result = matching.next().expect("canonical detached ToolResult");
	assert!(matching.next().is_none(), "detached ToolResult duplicated");
	result
}

fn detached_ref(result: &thread::ToolResult) -> JobRef {
	let details = result
		.details
		.as_ref()
		.expect("detached result retains exact structured truth");
	let json = proto_json(details);
	match serde_json::from_value::<ToolTerminal<JsonValue, JsonValue>>(json)
		.expect("detached result details decode")
	{
		ToolTerminal::Detached(job) => job,
		ToolTerminal::Done { .. } => panic!("detached result lowered as synchronous outcome"),
	}
}

fn proto_json(value: &inference::Value) -> JsonValue {
	match value.kind.as_ref().expect("proto JSON value kind") {
		value::Kind::Null(_) => JsonValue::Null,
		value::Kind::Bool(value) => JsonValue::Bool(*value),
		value::Kind::Int(value) => JsonValue::from(*value),
		value::Kind::Uint(value) => JsonValue::from(*value),
		value::Kind::Double(value) => serde_json::Number::from_f64(*value)
			.map(JsonValue::Number)
			.expect("finite JSON number"),
		value::Kind::String(value) => JsonValue::String(value.clone()),
		value::Kind::List(values) => JsonValue::Array(values.values.iter().map(proto_json).collect()),
		value::Kind::Map(values) => JsonValue::Object(
			values
				.fields
				.iter()
				.map(|(key, value)| (key.clone(), proto_json(value)))
				.collect(),
		),
	}
}

fn settlement_item<'a>(items: &'a [thread::Item], job_id: &str) -> &'a thread::Item {
	let mut matching = items
		.iter()
		.filter(|item| settlement_parts(item, job_id).is_some());
	let item = matching
		.next()
		.expect("ThreadDelta carries detached settlement");
	assert!(matching.next().is_none(), "ThreadDelta duplicated detached settlement");
	item
}

fn settlement_parts<'a>(
	item: &'a thread::Item,
	job_id: &str,
) -> Option<(&'a str, &'a thread::Blob)> {
	let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
		return None;
	};
	if message.role != thread::Role::System as i32 {
		return None;
	}
	let text = message
		.parts
		.iter()
		.find_map(|part| match part.kind.as_ref() {
			Some(part::Kind::Text(text)) if text.contains(job_id) => Some(text.as_str()),
			_ => None,
		})?;
	let blob = message
		.parts
		.iter()
		.find_map(|part| match part.kind.as_ref() {
			Some(part::Kind::Blob(blob)) => Some(blob),
			_ => None,
		})?;
	Some((text, blob))
}

#[derive(Debug, Deserialize)]
struct SettlementArtifact {
	job_id:            String,
	owner:             ArtifactOwner,
	expected_artifact: ArtifactExpectation,
	output:            Vec<ArtifactOutput>,
	state:             ArtifactState,
}

#[derive(Debug, Deserialize)]
struct ArtifactOwner {
	name:       String,
	generation: u64,
}

#[derive(Debug, Deserialize)]
struct ArtifactExpectation {
	description: String,
	media_type:  Option<String>,
	lifetime:    String,
}

#[derive(Debug, Deserialize)]
struct ArtifactOutput {
	sequence: u64,
	channel:  i32,
	data:     Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct ArtifactState {
	state:  i32,
	status: Option<ArtifactStatus>,
}

#[derive(Debug, Deserialize)]
struct ArtifactStatus {
	outcome:   i32,
	exit_code: Option<i32>,
	aborted:   bool,
}

async fn assert_artifact(env: &RealEnv, item: &thread::Item, job: &JobRef, expected_output: &[u8]) {
	let (text, blob) = settlement_parts(item, job.id.as_str()).expect("canonical settlement parts");
	assert!(text.contains("settled"));
	assert_eq!(blob.mime, SETTLEMENT_MIME);
	assert!(blob.inline.is_empty(), "settlement must remain blob-authoritative");
	let raw = env.read_blob(blob.hash.clone()).await;
	assert_eq!(blob.size, u64::try_from(raw.len()).expect("artifact length fits u64"));
	let artifact: SettlementArtifact =
		serde_json::from_slice(&raw).expect("structured process-settlement artifact");
	assert_eq!(artifact.job_id, job.id.as_str());
	let JobOwner::NamedProcess { name, generation } = &job.owner else {
		panic!("expected NamedProcess owner");
	};
	assert_eq!(artifact.owner.name, name.as_str());
	assert_eq!(artifact.owner.generation, *generation);
	assert_eq!(artifact.expected_artifact.description, job.artifact.description.as_str());
	assert_eq!(artifact.expected_artifact.media_type.as_deref(), job.artifact.media_type.as_deref(),);
	assert_eq!(artifact.expected_artifact.lifetime, "session");
	assert_eq!(artifact.state.state, ProcessState::Exited as i32);
	let status = artifact.state.status.expect("terminal process status");
	assert_eq!(status.exit_code, Some(0));
	assert!(!status.aborted);
	assert_ne!(status.outcome, 0);
	assert!(
		artifact
			.output
			.windows(2)
			.all(|pair| pair[0].sequence < pair[1].sequence),
		"process output sequences must be strictly ordered",
	);
	assert!(artifact.output.iter().all(|frame| frame.channel != 0));
	let ordered: Vec<u8> = artifact
		.output
		.into_iter()
		.flat_map(|frame| frame.data)
		.collect();
	assert_eq!(ordered, expected_output, "artifact bytes differ from ordered process output");
}

fn job_event_counts(journal: &Journal, job_id: &str) -> (usize, usize) {
	let log = journal.load().expect("load durable transcript");
	let mut registered = 0;
	let mut settled = 0;
	for index in 0..u64::try_from(log.len()).expect("log length fits u64") {
		let Some(Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::JobRegistered(event) if event.job.id == job_id => registered += 1,
			Kind::JobSettled(event) if event.job_id == job_id => settled += 1,
			_ => {},
		}
	}
	(registered, settled)
}

async fn wait_terminal(client: &EnvClient, name: &str, generation: u64) {
	let mut attachment = client
		.attach_output(AttachOutput {
			name: name.to_owned(),
			after_sequence: 0,
			generation,
			max_bytes: 16 * 1024 * 1024,
			terminal_text: false,
			terminal_columns: 0,
			terminal_rows: 0,
			props: None,
		})
		.await
		.expect("attach to named process");
	loop {
		let event = time::timeout(LIMIT, attachment.next_event())
			.await
			.expect("process terminal timeout")
			.expect("process attachment event")
			.expect("process attachment did not close early");
		match event {
			ProcessAttachmentEvent::Attached(attached) => {
				assert_eq!(attached.name, name);
				assert_eq!(attached.generation, generation);
			},
			ProcessAttachmentEvent::Output(output) => {
				assert_eq!(output.name, name);
				assert_eq!(output.generation, generation);
			},
			ProcessAttachmentEvent::State(state) => {
				let process = state.process.expect("process state info");
				assert_eq!(process.name, name);
				assert_eq!(process.generation, generation);
				if process.status.is_some() {
					return;
				}
			},
		}
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_shell_settles_once_after_reconnect_with_exact_artifact() {
	let mut env = RealEnv::spawn().await;
	let journal_path = env.root.path().join("agent.jsonl");
	let fifo = env.root.path().join("release.fifo");
	mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).expect("create deterministic process gate");
	let command = format!(
		"printf 'output-1\\noutput-2\\n'; read _ < '{}'; printf 'output-3\\n'",
		fifo.display(),
	);
	let detached_gate = Gate::default();
	let initial_client = ScriptedTurnClient::new([
		shell_turn(command),
		ScriptedTurn::steps([
			ScriptedStep::Wait(detached_gate.clone()),
			ScriptedStep::from(outcome_event(end_outcome(5))),
		]),
	]);
	let initial_capture = initial_client.clone();
	let mut agent = Agent::new(
		initial_client,
		env.client.clone(),
		state(env.root.path(), env.registry()),
		journal(&journal_path, env.root.path()),
		CAPS_BASE,
	);
	let events = agent.events().subscribe_lossless();
	let mut detached_start = tokio::spawn(async move {
		time::timeout(
			LIMIT,
			agent.submit(
				[user_item("start detached shell")],
				TurnId::new(omp_core::Ulid::generate().to_string()),
			),
		)
		.await
	});
	tokio::select! {
		arrival = detached_gate.wait_arrived(LIMIT) => {
			arrival.expect("detached result follow-up reached provider");
		},
		result = &mut detached_start => {
			panic!("detached-start submit ended before its follow-up gate: {result:?}");
		},
	}
	let captures = initial_capture.captures();
	assert_eq!(captures.len(), 2);
	let result = tool_result(&delta(&captures[1].input).append, "shell-detached");
	assert!(!result.is_error, "detached shell failed: {result:?}");
	let job = detached_ref(result);
	let JobOwner::NamedProcess { name: process_name, generation } = &job.owner else {
		panic!("detached shell did not register a named process")
	};
	assert_eq!(job.id, format!("{process_name}#{generation}").as_str());
	assert_eq!(*generation, 1);
	assert_eq!(
		job.artifact.description,
		"named process settlement; detached because explicit async request"
	);
	assert_eq!(job.artifact.media_type.as_deref(), Some(SETTLEMENT_MIME));
	assert_eq!(job.artifact.lifetime, ArtifactLifetime::Session);
	let text = result
		.parts
		.iter()
		.find_map(|part| match part.kind.as_ref() {
			Some(part::Kind::Text(text)) => Some(text.as_str()),
			_ => None,
		});
	assert_eq!(
		text,
		Some(
			format!(
				"job started; artifact will land at job://{} ({})",
				job.id, job.artifact.description
			)
			.as_str()
		),
	);
	let _registered = one_job_event(&events, job.id.as_str(), true).await;

	// Simulate losing the host while the detached-result follow-up is still in
	// flight. The bounded submit must be cancellable, while the real named
	// process remains owned by the environment.
	assert!(!detached_start.is_finished(), "detached-start submit returned before gate release");
	detached_start.abort();
	let _ = time::timeout(LIMIT, detached_start)
		.await
		.expect("detached-start cancellation timeout");

	let reconnected = env.reconnect("p3-reconnected").await;
	let settlement_gate = Gate::default();
	let next_client = ScriptedTurnClient::new([
		ScriptedTurn::steps([
			ScriptedStep::Wait(settlement_gate.clone()),
			ScriptedStep::from(outcome_event(end_outcome(5))),
		]),
		ScriptedTurn::events([outcome_event(end_outcome(6))]),
	]);
	let next_capture = next_client.clone();
	let reopened_journal = Journal::open(&journal_path).expect("reopen pending detached journal");
	assert_eq!(job_event_counts(&reopened_journal, job.id.as_str()), (1, 0));
	let mut reopened = Agent::new(
		next_client,
		reconnected,
		state(env.root.path(), env.registry()),
		reopened_journal,
		CAPS_BASE,
	);
	let settled_events = reopened.events().subscribe_lossless();
	let board = Arc::clone(reopened.jobs());
	let resumed = tokio::spawn(async move {
		let result = time::timeout(
			LIMIT,
			reopened.submit(
				Vec::<thread::Item>::new(),
				TurnId::new(omp_core::Ulid::generate().to_string()),
			),
		)
		.await;
		(reopened, result)
	});
	settlement_gate
		.wait_arrived(LIMIT)
		.await
		.expect("replayed detached follow-up reached provider");
	release_fifo(fifo).await;
	wait_terminal(&env.client, process_name, *generation).await;
	assert!(!resumed.is_finished(), "TurnBoundary settlement ended the active turn");
	wait_job_completed(&board, job.id.as_str()).await;
	assert!(!board.is_empty(), "settlement was removed before its durable claim");
	assert!(!resumed.is_finished(), "settlement bypassed the blocked turn boundary");
	settlement_gate.release();
	let (reopened, resumed_result) = time::timeout(LIMIT, resumed)
		.await
		.expect("resumed detached submit join timeout")
		.expect("resumed detached submit task");
	resumed_result
		.expect("resumed detached submit timeout")
		.expect("turn after detached settlement");
	wait_board_empty(&board).await;
	let _settled = one_job_event(&settled_events, job.id.as_str(), false).await;
	let next = next_capture.captures();
	assert_eq!(next.len(), 2);
	let settlement = settlement_item(&delta(&next[1].input).append, job.id.as_str());
	assert_eq!(
		delta(&next[1].input)
			.append
			.iter()
			.filter(|item| settlement_parts(item, job.id.as_str()).is_some())
			.count(),
		1,
	);
	assert_artifact(&env, settlement, &job, b"output-1\noutput-2\noutput-3\n").await;
	assert_eq!(job_event_counts(reopened.journal(), job.id.as_str()), (1, 1));
	assert!(reopened.jobs().is_empty());

	// Register a job only after the real named process has already exited.
	// Reopening must reconstruct its watcher from durable truth and consume
	// retained output.
	let early_name = "p3-already-exited";
	let started = env
		.client
		.start_process(&omp_core::EnvPath::new(env.cwd_uri()).expect("typed cwd"), StartProcess {
			name: early_name.to_owned(),
			spec: Some(ProcessSpec {
				source: Some(Script {
					text: "printf 'early-1\\nearly-2\\n'".to_owned(),
					..Default::default()
				}),
				restart: Some(RestartSpec {
					policy: RestartPolicy::Never as i32,
					..Default::default()
				}),
				..Default::default()
			}),
			..Default::default()
		})
		.await
		.expect("start early-exit named process");
	wait_terminal(&env.client, early_name, started.generation).await;
	let early_job = JobRef {
		id:       Str::from(format!("{early_name}#{}", started.generation)),
		owner:    JobOwner::NamedProcess {
			name:       Str::from(early_name),
			generation: started.generation,
		},
		metadata: Arc::default(),
		artifact: ExpectedArtifact {
			description: sf!("expected PNG render"),
			media_type:  Some(sf!("image/png")),
			lifetime:    ArtifactLifetime::Session,
		},
	};
	drop(reopened);
	let mut durable = Journal::open(&journal_path).expect("open journal for durable registration");
	durable
		.register_job(10, early_job.clone())
		.expect("register already-exited job");
	drop(durable);
	let early_gate = Gate::default();
	let final_client = ScriptedTurnClient::new([
		ScriptedTurn::steps([
			ScriptedStep::Wait(early_gate.clone()),
			ScriptedStep::from(outcome_event(end_outcome(7))),
		]),
		ScriptedTurn::events([outcome_event(end_outcome(8))]),
	]);
	let final_capture = final_client.clone();
	let mut final_agent = Agent::new(
		final_client,
		env.reconnect("p3-final-reopen").await,
		state(env.root.path(), env.registry()),
		Journal::open(&journal_path).expect("reopen already-exited job"),
		CAPS_BASE,
	);
	let final_events = final_agent.events().subscribe_lossless();
	let final_board = Arc::clone(final_agent.jobs());
	let early_release = tokio::spawn({
		let early_gate = early_gate.clone();
		let early_job = early_job.clone();
		let final_board = Arc::clone(&final_board);
		async move {
			wait_job_completed(&final_board, early_job.id.as_str()).await;
			assert!(!final_board.is_empty(), "early settlement disappeared before its durable claim");
			early_gate.release();
		}
	});
	time::timeout(
		LIMIT,
		final_agent.submit(
			[user_item("observe retained early exit")],
			TurnId::new(omp_core::Ulid::generate().to_string()),
		),
	)
	.await
	.expect("already-exited attachment submit timeout")
	.expect("turn after already-exited attachment");
	early_release.await.expect("early-exit release task");
	let _early_settled = one_job_event(&final_events, early_job.id.as_str(), false).await;
	let final_turns = final_capture.captures();
	assert!(
		(1..=2).contains(&final_turns.len()),
		"already-exited settlement used an unexpected number of provider turns"
	);
	let mut matching = final_turns
		.iter()
		.flat_map(|capture| input_items(&capture.input))
		.filter(|item| settlement_parts(item, early_job.id.as_str()).is_some());
	let early_settlement = matching
		.next()
		.expect("provider input carries early-exit settlement");
	assert!(matching.next().is_none(), "provider inputs duplicated early-exit settlement");
	assert_artifact(&env, early_settlement, &early_job, b"early-1\nearly-2\n").await;
	assert_eq!(job_event_counts(final_agent.journal(), early_job.id.as_str()), (1, 1));
	assert_eq!(job_event_counts(final_agent.journal(), job.id.as_str()), (1, 1));
	assert!(final_agent.jobs().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detached_replay_acceptance_comes_from_real_gateway_authority() {
	let scratch = Scratch::new().expect("gateway replay scratch");
	let script = FakeScript::chat(vec![
		Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
		Ok(ChatEvent::TextDelta { index: 0, text: sf!("durable replay") }),
		Ok(ChatEvent::Completed(Completion {
			reason:  FinishReason::Stop,
			blocks:  1,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		})),
	]);
	let mut gateway = ScriptedGateway::spawn(&scratch, [script], Arc::new(Registry::new()))
		.await
		.expect("real scripted gateway");
	let options = TurnOptions {
		context_id: Some(sf!("p3-replay-context")),
		params: inference::ChatParams { model: gateway.model().to_owned(), ..Default::default() },
		..Default::default()
	};
	let input = TurnInput::Full(thread::Thread {
		items: vec![user_item("persist this exact detached acceptance turn")],
	});
	let turn_id = TurnId::new(omp_core::Ulid::generate().to_string());
	let first_outcome = {
		let client = gateway.client().await.expect("first real gateway client");
		let mut session = time::timeout(LIMIT, client.turn(turn_id.clone(), input.clone(), &options))
			.await
			.expect("first gateway turn open timeout")
			.expect("first gateway turn open");
		let mut events = session.events();
		let accepted = time::timeout(LIMIT, events.next())
			.await
			.expect("first acceptance timeout")
			.expect("first acceptance event")
			.expect("first acceptance protocol");
		assert!(matches!(
			accepted.event,
			Some(turn_event::Event::Accepted(inference::Accepted { replay: false }))
		));
		loop {
			let event = time::timeout(LIMIT, events.next())
				.await
				.expect("first outcome timeout")
				.expect("first outcome event")
				.expect("first outcome protocol");
			if let Some(turn_event::Event::Outcome(outcome)) = event.event {
				break outcome;
			}
		}
	};

	gateway
		.restart()
		.await
		.expect("restart durable gateway authority");
	let replay_outcome = {
		let client = gateway.client().await.expect("replay real gateway client");
		let mut session = time::timeout(LIMIT, client.turn(turn_id, input, &options))
			.await
			.expect("replay gateway turn open timeout")
			.expect("replay gateway turn open");
		let mut events = session.events();
		let accepted = time::timeout(LIMIT, events.next())
			.await
			.expect("replay acceptance timeout")
			.expect("replay acceptance event")
			.expect("replay acceptance protocol");
		assert!(matches!(
			accepted.event,
			Some(turn_event::Event::Accepted(inference::Accepted { replay: true }))
		));
		loop {
			let event = time::timeout(LIMIT, events.next())
				.await
				.expect("replay outcome timeout")
				.expect("replay outcome event")
				.expect("replay outcome protocol");
			if let Some(turn_event::Event::Outcome(outcome)) = event.event {
				break outcome;
			}
		}
	};
	assert_eq!(replay_outcome, first_outcome, "gateway replay changed durable outcome");
	assert_eq!(gateway.calls().len(), 1, "replay reached provider instead of durable authority");
	gateway.shutdown().await.expect("gateway shutdown");
}
