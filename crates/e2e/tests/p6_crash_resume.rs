//! Executable P6 proof for durable replay and interrupted-batch recovery after
//! crashes.

#![cfg(unix)]

use std::{
	collections::VecDeque,
	env,
	fs::{self, OpenOptions},
	future::{Future, ready},
	io::{self, BufRead as _, BufReader, Read as _, Write as _},
	iter,
	os::{
		fd,
		unix::{fs::PermissionsExt as _, net::UnixStream, process::CommandExt as _},
	},
	path::{Path, PathBuf},
	pin::Pin,
	process::{Child, Command, ExitStatus, Stdio},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll},
	thread as std_thread,
	time::{Duration, Instant},
};

use async_stream::stream;
use bytes::Bytes;
use flume::Receiver;
use futures::{Stream, StreamExt as _};
use nix::{
	errno::Errno,
	fcntl::{FcntlArg, OFlag, fcntl},
	pty::{Winsize, openpty},
	sys::signal,
	unistd::{Pid, ttyname},
};
use omp_agent::{
	Agent, AgentError, AgentEvent, AgentSnapshot, AgentState, Error as TurnError, InvokeFrame,
	Journal, PromptHash, RpcTurnClient, RpcTurnSession, TurnClient, TurnId, TurnInput,
	TurnInputRecord, TurnOptions, TurnOptionsRecord, TurnSession, TurnStart, project_journal,
};
use omp_app::{
	daemon::{DaemonConfig, DaemonHandle},
	endpoint::LocalEndpoint,
};
use omp_catalog::{
	ManagementCapabilities, OperationBits, OperationKind,
	snapshot::{Catalog, SnapshotProvenance},
};
use omp_core::{Str, sf};
use omp_e2e::support::{
	AllowAdmission, Scratch, ScriptedGateway, install_omp_binary_env, omp_binary,
};
use omp_env::EnvClient;
use omp_envd::{EnvServer, RegistryBridges, worker::ExtHostConfig};
use omp_inference::{
	Answer, Error as InferenceError, Registry as InferenceRegistry,
	call::Call,
	event::{BlockKind, ChatEvent, Completion, FinishReason, WorkflowResponse},
	id::TurnId as ProviderTurnId,
	layer::{LayerCall, stack::RouteProviderService},
	provider::fake::{FakeProvider, FakeScript},
	receipt::{ExecutionReceipt, ReasonId, Usage},
	registry::RouteUnavailable,
	session::ConversationSessionPlanner,
};
use omp_proto::{
	SCHEMA_REV,
	env::v1::ClientHello,
	inference::v1::{self as pb, part_start, turn_event, value},
	prost::Message as _,
	thread::v1::{self as thread, item},
};
use omp_storage::{
	index::{NewSession, SessionIndex, SessionKind},
	transcript::{self, AmendPatch, Entry, Header, Kind, SessionId},
};
use omp_tool::{
	Abort, CallOutcome, CapsBase, Claims, Constraint, DocEffects, Effects, Ev, IncomingParams,
	ModelClass, Part as ToolPart, Precedence, Presentation, PromptCaps, Registry, Rev,
	TOOL_REV_PROP, Tool, ToolSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time;
use tower::Service;

const TEST_NAME: &str = "crash_resume_replays_exact_durable_truth";
const CHILD_ENV: &str = "OMP_P6_CHILD";
const ROOT_ENV: &str = "OMP_P6_ROOT";

fn file_write_effects() -> Effects {
	Effects {
		documents: Some(DocEffects {
			read:        false,
			write_globs: iter::once(sf!("**")).collect(),
		}),
		exec:      None,
		inference: None,
		desktop:   None,
		subagents: 0,
	}
}
const ROOT_TURN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BATCH_TURN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const FALLBACK_TURN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TOOLSET_TURN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const RECEIPT_TURN: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const BINARY_SESSION: &str = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const TOOL_NAME: &str = "p6_hang";

fn assert_fixed_turn_ids() {
	let ids = [ROOT_TURN, BATCH_TURN, FALLBACK_TURN, TOOLSET_TURN, RECEIPT_TURN, BINARY_SESSION];
	for (index, id) in ids.iter().enumerate() {
		assert!(id.parse::<omp_core::Ulid>().is_ok(), "invalid fixed test TurnId {id}");
		assert!(!ids[..index].contains(id), "duplicate fixed test TurnId {id}");
	}
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct OpenRecord {
	turn_id: Str,
	input:   TurnInputRecord,
	options: TurnOptionsRecord,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct GatewayTurn {
	open:    OpenRecord,
	outcome: pb::Outcome,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct GatewayState {
	turns:    Vec<GatewayTurn>,
	accepted: Vec<bool>,
}

#[derive(Clone)]
struct NeverTurnClient {
	opens: Arc<AtomicUsize>,
}

impl TurnClient for NeverTurnClient {
	type Session<'client> = DiskTurnSession;

	fn turn<'client>(
		&'client self,
		_turn_id: TurnId,
		_input: TurnInput,
		_options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, TurnError>> + Send + 'client {
		self.opens.fetch_add(1, Ordering::SeqCst);
		ready(Err(TurnError::Protocol("toolset mismatch must fail before opening the turn client")))
	}
}

#[derive(Clone)]
struct DiskTurnClient {
	path: PathBuf,
}

impl DiskTurnClient {
	const fn new(path: PathBuf) -> Self {
		Self { path }
	}

	fn open(&self, turn_id: TurnId, input: TurnInput, options: &TurnOptions) -> DiskTurnSession {
		let open = OpenRecord {
			turn_id: turn_id.as_str().into(),
			input:   input_record(&input),
			options: options_record(options),
		};
		let mut state = load_gateway(&self.path);
		assert!(
			state
				.turns
				.iter()
				.all(|record| record.open.turn_id != open.turn_id),
			"receipt recovery reopened an already terminal scripted provider turn"
		);
		let (outcome, events) = if state.turns.is_empty() {
			assert_eq!(turn_id.as_str(), BATCH_TURN, "initial batch turn id was reminted");
			let outcome = batch_outcome(&input);
			(outcome.clone(), batch_events(outcome))
		} else {
			assert_ne!(turn_id.as_str(), BATCH_TURN, "receipt recovery reopened the gateway turn");
			assert_interrupted_follow_up(&input);
			let outcome = end_outcome(&input, "after interrupted batch");
			(outcome.clone(), vec![accepted(false), outcome_event(outcome)])
		};
		state.turns.push(GatewayTurn { open, outcome });
		state.accepted.push(false);
		store_gateway(&self.path, &state);
		DiskTurnSession { events: events.into() }
	}
}

impl TurnClient for DiskTurnClient {
	type Session<'client> = DiskTurnSession;

	fn turn<'client>(
		&'client self,
		turn_id: TurnId,
		input: TurnInput,
		options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, TurnError>> + Send + 'client {
		ready(Ok(self.open(turn_id, input, options)))
	}
}

struct DiskTurnSession {
	events: VecDeque<pb::TurnEvent>,
}

struct DiskEvents<'a> {
	session: &'a mut DiskTurnSession,
}

impl Stream for DiskEvents<'_> {
	type Item = Result<pb::TurnEvent, TurnError>;

	fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		Poll::Ready(self.session.events.pop_front().map(Ok))
	}
}

impl TurnSession for DiskTurnSession {
	fn events(
		&mut self,
	) -> impl Stream<Item = Result<pb::TurnEvent, TurnError>> + Send + Unpin + '_ {
		DiskEvents { session: self }
	}

	fn submit(
		&mut self,
		_frame: InvokeFrame,
	) -> impl Future<Output = Result<(), TurnError>> + Send + '_ {
		ready(Ok(()))
	}
}

struct HangingTool {
	spec:    ToolSpec,
	effects: PathBuf,
}

impl HangingTool {
	fn new(effects: PathBuf) -> Self {
		Self {
			spec: ToolSpec {
				name:            TOOL_NAME.into(),
				rev:             Rev { family: "p6".into(), n: 1 },
				description:     "waits forever after its durable effect gate".into(),
				schema:          Bytes::from_static(
					br#"{"type":"object","properties":{"call":{"type":"string"}},"required":["call"]}"#,
				),
				constraint:      Constraint::None,
				effects:         file_write_effects(),
				projection_code: [0; 32],
			},
			effects,
		}
	}
}

impl Tool for HangingTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			match params.committed().await {
				Ok(raw) => {
					let value: Value = serde_json::from_str(raw.as_str()).expect("committed test args");
					let call = value["call"].as_str().expect("call name");
					let mut file = OpenOptions::new()
						.create(true)
						.append(true)
						.open(&self.effects)
						.expect("open effects marker");
					let record = format!("{call}\n");
					file.write_all(record.as_bytes()).expect("record committed effect");
					file.sync_data().expect("sync committed effect");
					futures::future::pending::<()>().await;
				},
				Err(_) => yield Ev::Aborted(Abort::InputDropped),
			}
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<ToolPart> {
		Vec::new()
	}
}

#[derive(Clone)]
struct FakeRoute(FakeProvider);

impl Service<LayerCall<Call>> for FakeRoute {
	type Error = InferenceError;
	type Future = <FakeProvider as Service<Call>>::Future;
	type Response = Answer;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		<FakeProvider as Service<Call>>::poll_ready(&mut self.0, context)
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		<FakeProvider as Service<Call>>::call(&mut self.0, request.payload)
	}
}

async fn rpc_host(
	root: &Path,
	first: bool,
) -> (DaemonHandle, RpcTurnClient, String, Receiver<WorkflowResponse>) {
	let mut compiled = Catalog::embedded().compiled().clone();
	for provider in &mut compiled.providers {
		provider.management = ManagementCapabilities {
			operations:        OperationBits::empty(),
			multiple_accounts: false,
			refresh:           false,
			principal_quota:   false,
		};
	}
	let artifacts = Catalog::encode(compiled, SnapshotProvenance { source_digest: [0; 32] })
		.expect("P6 catalog snapshot");
	let catalog = Arc::new(Catalog::decode(&artifacts.postcard).expect("P6 catalog"));
	let model = catalog
		.models()
		.iter()
		.find(|candidate| {
			candidate
				.capabilities
				.operations
				.contains_kind(OperationKind::Chat)
		})
		.expect("chat model");
	let route_id = model.routes.first().expect("chat route").clone();
	let route = catalog.route(&route_id).expect("catalog route");
	let fake = FakeProvider::new(route.provider.clone(), route_id.clone());
	if first {
		fake.extend([FakeScript::chat(vec![
			Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
			Ok(ChatEvent::TextDelta { index: 0, text: sf!("the durable RPC outcome") }),
			Ok(ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Usage::default(),
				receipt: ExecutionReceipt::default().into(),
			})),
		])]);
	}
	let route_service = RouteProviderService::new(FakeRoute(fake));
	let mut builder = InferenceRegistry::builder(Arc::clone(&catalog));
	for candidate in catalog.routes() {
		builder = if candidate.id == route_id {
			builder
				.register_route(candidate.id.clone(), route_service.clone())
				.expect("register P6 fake route")
		} else {
			builder
				.register_unavailable(RouteUnavailable {
					route:     candidate.id.clone(),
					reason:    ReasonId(sf!("p6-route-unavailable")),
					operation: None,
				})
				.expect("register unavailable route")
		};
	}
	let registry = builder.build().expect("P6 inference registry");
	let sessions = ConversationSessionPlanner::open(root.join("sessions.db"), Arc::clone(&catalog))
		.expect("open durable conversation store");
	let socket = root.join(if first {
		"gateway-first.sock"
	} else {
		"gateway-resume.sock"
	});
	let (responses_tx, responses_rx) = flume::bounded(8);
	let daemon = DaemonHandle::start_for_test(
		DaemonConfig::local(LocalEndpoint::from(socket.clone()))
			.with_data_dir(root.join("gateway-data")),
		registry,
		sessions,
		Arc::new(Registry::new()),
		responses_tx,
	)
	.await
	.expect("start real RPC gateway");
	let channel = omp_rpc::uds::connect(&socket)
		.await
		.expect("connect real RPC gateway");
	(daemon, RpcTurnClient::new(channel), model.key.as_str().to_owned(), responses_rx)
}

async fn next_rpc(session: &mut RpcTurnSession) -> pb::TurnEvent {
	time::timeout(Duration::from_secs(3), async {
		session
			.events()
			.next()
			.await
			.expect("RPC turn stream ended")
			.expect("RPC turn event failed")
	})
	.await
	.expect("RPC turn event timed out")
}

async fn rpc_outcome(session: &mut RpcTurnSession) -> pb::Outcome {
	loop {
		let event = next_rpc(session).await;
		if let Some(turn_event::Event::Outcome(outcome)) = event.event {
			return outcome;
		}
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_resume_replays_exact_durable_truth() {
	assert_fixed_turn_ids();
	if let (Ok(stage), Ok(root)) = (env::var(CHILD_ENV), env::var(ROOT_ENV)) {
		Box::pin(run_child(&stage, Path::new(&root))).await;
		return;
	}

	let scratch = tempfile::tempdir().expect("P6 scratch directory");

	let replay_root = scratch.path().join("replay");
	fs::create_dir(&replay_root).expect("replay scenario directory");
	let accepted_marker = replay_root.join("accepted");
	let mut first = spawn_child("replay-crash", &replay_root);
	wait_for_file(&accepted_marker).await;
	kill_at_boundary(&mut first);
	let resumed = run_child_process("replay-resume", &replay_root).await;
	assert!(resumed.success(), "resume child failed: {resumed}");
	assert_single_receipt(&replay_root.join("journal.jsonl"), ROOT_TURN);

	let patch_root = scratch.path().join("receipt-patch");
	fs::create_dir(&patch_root).expect("receipt-patch scenario directory");
	let receipt_marker = patch_root.join("receipt");
	let mut receipt = spawn_child("receipt-crash", &patch_root);
	wait_for_file(&receipt_marker).await;
	kill_at_boundary(&mut receipt);
	let patched = run_child_process("receipt-resume", &patch_root).await;
	assert!(patched.success(), "receipt recovery child failed: {patched}");
	let patch_state = load_gateway(&patch_root.join("gateway.json"));
	assert_eq!(patch_state.turns.len(), 1, "sequence recovery opened another gateway turn");
	assert_eq!(patch_state.accepted, vec![false]);
	assert_recovered_sequences(&patch_root.join("journal.jsonl"));

	let batch_root = scratch.path().join("batch");
	fs::create_dir(&batch_root).expect("batch scenario directory");
	let effects = batch_root.join("effects");
	let mut batch = spawn_child("batch-crash", &batch_root);
	wait_for_lines(&effects, 2).await;
	kill_at_boundary(&mut batch);
	assert_effects(&effects);
	let completed = run_child_process("batch-resume", &batch_root).await;
	assert!(completed.success(), "batch recovery child failed: {completed}");
	assert_effects(&effects);
	assert_batch_recovery(&batch_root.join("journal.jsonl"), &batch_root.join("gateway.json"));
}

#[tokio::test]
async fn resume_rejects_changed_toolset_before_opening_any_authority() {
	assert_fixed_turn_ids();
	let scratch = tempfile::tempdir().expect("toolset mismatch scratch directory");
	let journal_path = scratch.path().join("journal.jsonl");
	let mut journal = Journal::create(&journal_path, &header(scratch.path(), "toolset-mismatch"))
		.expect("create toolset mismatch journal");
	let hash = PromptHash::from([19; 32]);
	let user = message(thread::Role::User, "resume only with the frozen toolset");
	let input_event = journal
		.append_optimistic(1, user.clone(), Some(hash))
		.expect("append pending turn input");
	let durable_registry = Registry::new();
	let input = TurnInput::Full(thread::Thread { items: vec![user] });
	let options = TurnOptions::default();
	journal
		.start_turn(2, TurnStart {
			turn_id:            TOOLSET_TURN.into(),
			item_events:        vec![input_event],
			prompt_hash:        hash.digest(),
			prompt_head_events: Vec::new(),
			toolset_hash:       durable_registry.slot_hash(),
			enabled_tools:      Vec::new(),
			sequence_targets:   vec![input_event],
			input:              input_record(&input),
			options:            options_record(&options),
		})
		.expect("record pending turn under original toolset");

	let mut changed_registry = Registry::new();
	changed_registry
		.register(
			HangingTool::new(scratch.path().join("must-not-run")),
			Presentation::Slot,
			core_claims(),
		)
		.expect("register changed live tool");
	let mut snapshot =
		AgentSnapshot::new(TurnOptions::default(), Default::default(), Arc::new(changed_registry));
	snapshot.enabled_tools = Arc::from([Str::from(TOOL_NAME)]);
	let opens = Arc::new(AtomicUsize::new(0));
	let client = NeverTurnClient { opens: Arc::clone(&opens) };
	let (env, transport) = EnvClient::in_process(8);
	let (environment_requests, _environment_responses) = transport.into_parts();
	let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, caps());

	let error = agent
		.submit(Vec::<thread::Item>::new(), TurnId::new(FALLBACK_TURN))
		.await
		.expect_err("changed toolset must reject resume");
	assert!(matches!(error, AgentError::ToolsetMismatch { .. }));
	assert_eq!(opens.load(Ordering::SeqCst), 0, "turn client opened before mismatch rejection");
	assert!(environment_requests.is_empty(), "environment opened before mismatch rejection");
	assert!(!scratch.path().join("must-not-run").exists(), "changed tool effect was launched");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_chat_resume_replays_pending_turn_through_cli_startup() {
	assert_fixed_turn_ids();
	install_omp_binary_env().expect("expose worker-capable host");
	let scratch = Scratch::new().expect("binary resume scratch");
	let project = fs::canonicalize(scratch.project()).expect("canonical scratch project");
	let omp_dir = project.join(".omp");
	fs::create_dir(&omp_dir).expect("create project metadata directory");
	fs::set_permissions(&omp_dir, fs::Permissions::from_mode(0o755))
		.expect("use standard .omp permissions");
	let data_dir = project
		.parent()
		.expect("project parent")
		.join("binary-home/data");
	let state_dir =
		omp_env::project_state::directory(&data_dir, &project).expect("project state directory");
	let sessions = state_dir.join("sessions");
	fs::create_dir_all(&sessions).expect("create chat session directory");
	fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o755))
		.expect("use standard state permissions");
	fs::set_permissions(&sessions, fs::Permissions::from_mode(0o755))
		.expect("use standard sessions permissions");
	fs::set_permissions(scratch.state(), fs::Permissions::from_mode(0o700))
		.expect("secure binary-resume daemon state");
	let journal_path = sessions.join(format!("{BINARY_SESSION}.jsonl"));
	let session_id = SessionId(Str::from(BINARY_SESSION));
	let session_index =
		Arc::new(SessionIndex::open(sessions.join("sessions.sqlite3")).expect("session index"));
	let project_text = project.to_string_lossy();
	let request = NewSession {
		id:         &session_id,
		cwd:        project_text.as_ref(),
		project:    project_text.as_ref(),
		created_ms: 1,
		kind:       SessionKind::Interactive,
		parent:     None,
		remote:     false,
	};
	session_index
		.create_session(&request, || {
			let header = Header {
				v:       4,
				id:      session_id.clone(),
				created: 1,
				cwd:     project.clone(),
			};
			let mut bytes = serde_json::to_vec(&header).map_err(io::Error::other)?;
			bytes.push(b'\n');
			fs::write(&journal_path, &bytes)?;
			Ok::<_, io::Error>(((), 0))
		})
		.expect("create indexed resumable binary journal");
	drop(session_index);
	fs::set_permissions(&journal_path, fs::Permissions::from_mode(0o644))
		.expect("use standard binary journal permissions");

	let script = FakeScript::chat(vec![
		Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
		Ok(ChatEvent::TextDelta { index: 0, text: sf!("binary resume outcome") }),
		Ok(ChatEvent::Completed(Completion {
			reason:  FinishReason::Stop,
			blocks:  1,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		})),
	]);
	let gateway = ScriptedGateway::spawn_gated(&scratch, [script], binary_gateway_tools())
		.await
		.expect("start gated real gateway");
	let binary = omp_binary().expect("locate worker-capable omp binary");
	let args = chat_resume_args(&gateway, &project);
	let first_debug = scratch.socket("binary-first-debug.sock");
	let mut first = ChatPty::spawn(&binary, &args, &project, &first_debug);
	let mut first_ui =
		ChatDebug::connect(&first_debug, Instant::now() + Duration::from_secs(30), &mut first);
	first_ui.wait_text("idle", Duration::from_secs(10));
	first_ui.keys("'exercise binary resume' enter");
	first_ui.wait_text("exercise binary resume", Duration::from_secs(10));
	let pending_turn = match wait_pending_turn(&journal_path, Duration::from_secs(10)).await {
		Some(turn) => turn,
		None => {
			let screen = first_ui.request(json!({ "op": "text" }));
			let envd_log = fs::read_to_string(state_dir.join("envd.log")).unwrap_or_default();
			let journal = fs::read_to_string(&journal_path).unwrap_or_default();
			let indexed = SessionIndex::open(sessions.join("sessions.sqlite3"))
				.and_then(|index| index.get(&SessionId(Str::from(BINARY_SESSION))));
			let journal_len = fs::metadata(&journal_path).map(|metadata| metadata.len());
			panic!(
				"binary chat did not durably start a turn\nscreen: \
				 {screen}\nenvd:\n{envd_log}\nindex: {indexed:?}\njournal_len: \
				 {journal_len:?}\njournal:\n{journal}"
			);
		},
	};
	if let Err(error) = gateway.wait_response_gated(Duration::from_secs(30)).await {
		let screen = first_ui.request(json!({ "op": "text" }));
		let envd_log = fs::read_to_string(state_dir.join("envd.log")).unwrap_or_default();
		let journal = fs::read_to_string(&journal_path).unwrap_or_default();
		panic!(
			"provider response never reached gate: {error:#}\nscreen: \
			 {screen}\nenvd:\n{envd_log}\njournal:\n{journal}"
		);
	}
	assert!(pending_turn.parse::<omp_core::Ulid>().is_ok(), "chat minted non-ULID TurnId");
	first.stop();
	gateway
		.release_response()
		.expect("release gated provider response");
	let replay = gateway
		.wait_turn_replay(ProviderTurnId::from_ref(pending_turn.as_str()), Duration::from_secs(10))
		.await
		.expect("gateway committed exact turn replay while chat was frozen");
	assert!(!replay.outcome.is_empty(), "gateway replay omitted terminal outcome");
	drop(first_ui);
	first.kill();
	let crashed = Journal::open(&journal_path).expect("open abandoned binary journal");
	assert_eq!(
		crashed.pending_turn().map(|start| start.turn_id.as_str()),
		Some(pending_turn.as_str()),
		"frozen chat did not leave its durable TurnStart pending",
	);
	assert!(crashed.receipt(pending_turn.as_str()).is_none());
	drop(crashed);

	let second_debug = scratch.socket("binary-resume-debug.sock");
	let mut second = ChatPty::spawn(&binary, &args, &project, &second_debug);
	let mut second_ui =
		ChatDebug::connect(&second_debug, Instant::now() + Duration::from_secs(30), &mut second);
	second_ui.wait_text("binary resume outcome", Duration::from_secs(30));
	second_ui.request(json!({ "op": "quit" }));
	second_ui.request(json!({ "op": "quit" }));
	drop(second_ui);
	let status = second.wait(Duration::from_secs(15));

	assert!(status.success(), "resumed omp chat did not quit cleanly: {status}");
	assert_eq!(gateway.calls().len(), 1, "CLI resume invoked the provider instead of RPC replay");
	assert_binary_resume_journal(&journal_path, &pending_turn);
	gateway.shutdown().await.expect("stop scripted gateway");
}
fn binary_gateway_tools() -> Arc<Registry> {
	let mut registry = Registry::new();
	for name in [
		"checkpoint",
		"rewind",
		"ask",
		"ast_edit",
		"ast_grep",
		"bash",
		"debug",
		"edit",
		"eval",
		"fetch",
		"glob",
		"grep",
		"hub",
		"lsp",
		"think",
		"todo",
		"web_search",
		"write",
		"read",
	] {
		registry
			.register_worker(
				ToolSpec {
					name:            sf!(name),
					rev:             Rev { family: sf!("fixture"), n: 1 },
					description:     sf!("binary crash-resume fixture"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      Constraint::None,
					effects:         Effects::empty(),
					projection_code: [0; 32],
				},
				Presentation::Device,
				worker_claims(),
			)
			.expect("register binary gateway tool identity");
	}
	Arc::new(registry)
}

fn chat_resume_args(gateway: &ScriptedGateway, project: &Path) -> Vec<String> {
	vec![
		"chat".to_owned(),
		"--model".to_owned(),
		gateway.model().to_owned(),
		"--project".to_owned(),
		project.display().to_string(),
		"--gateway".to_owned(),
		gateway.endpoint().display().to_string(),
		"--resume".to_owned(),
		BINARY_SESSION.to_owned(),
	]
}

async fn wait_pending_turn(path: &Path, limit: Duration) -> Option<String> {
	let deadline = Instant::now() + limit;
	loop {
		if let Ok(log) = transcript::load(path) {
			for index in 0..u64::try_from(log.len()).expect("binary journal length") {
				if let Some(Entry::Ok(event)) = log.get(index)
					&& let Kind::TurnStart(start) = &event.kind
				{
					return Some(start.turn_id.to_string());
				}
			}
		}
		if Instant::now() >= deadline {
			return None;
		}
		time::sleep(Duration::from_millis(10)).await;
	}
}

fn assert_binary_resume_journal(path: &Path, turn_id: &str) {
	let journal = Journal::open(path).expect("open CLI-resumed journal");
	assert!(journal.pending_turn().is_none(), "CLI resume left its TurnStart pending");
	let receipt = journal
		.receipt(turn_id)
		.expect("CLI resume terminal receipt");
	assert_eq!(receipt.turn_id.as_str(), turn_id);
	let log = journal.load().expect("load CLI-resumed journal");
	assert_eq!(
		event_count(log.log(), |kind| matches!(
			kind,
			Kind::TurnReceipt(receipt) if receipt.turn_id.as_str() == turn_id
		)),
		1,
		"CLI resume duplicated its terminal receipt",
	);
	let projected =
		project_journal(&log, &Registry::new(), &caps()).expect("project CLI-resumed journal");
	let outputs = projected
		.items
		.iter()
		.filter(|item| {
			matches!(
				item.kind.as_ref(),
				Some(item::Kind::Message(message))
					if message.role == thread::Role::Assistant as i32
						&& message.parts.iter().any(|part| matches!(
							part.kind.as_ref(),
							Some(thread::part::Kind::Text(text)) if text == "binary resume outcome"
						))
			)
		})
		.count();
	assert_eq!(outputs, 1, "CLI resume duplicated or lost the terminal assistant item");
}

struct ChatDebug {
	reader: BufReader<UnixStream>,
	writer: UnixStream,
}

impl ChatDebug {
	fn connect(path: &Path, deadline: Instant, process: &mut ChatPty) -> Self {
		loop {
			match UnixStream::connect(path) {
				Ok(stream) => {
					stream
						.set_read_timeout(Some(Duration::from_secs(2)))
						.expect("debug read timeout");
					stream
						.set_write_timeout(Some(Duration::from_secs(2)))
						.expect("debug write timeout");
					let writer = stream.try_clone().expect("clone debug socket");
					return Self { reader: BufReader::new(stream), writer };
				},
				Err(error) => {
					if let Some(status) = process.child.try_wait().expect("poll binary chat") {
						let mut stdout = String::new();
						let mut stderr = String::new();
						if let Some(mut pipe) = process.child.stdout.take() {
							pipe
								.read_to_string(&mut stdout)
								.expect("read early binary stdout");
						}
						if let Some(mut pipe) = process.child.stderr.take() {
							pipe
								.read_to_string(&mut stderr)
								.expect("read early binary stderr");
						}
						let envd = fs::read_to_string(&process.envd_log).unwrap_or_default();
						panic!(
							"binary chat exited before debug socket: {status}; connect: \
							 {error}\nstdout:\n{stdout}\nstderr:\n{stderr}\nenvd:\n{envd}"
						);
					}
					if Instant::now() >= deadline {
						let envd = fs::read_to_string(&process.envd_log).unwrap_or_default();
						panic!("binary chat debug socket timed out: {error}\nenvd:\n{envd}");
					}
					std_thread::sleep(Duration::from_millis(20));
				},
			}
		}
	}

	fn request(&mut self, request: Value) -> Value {
		serde_json::to_writer(&mut self.writer, &request).expect("write debug request");
		self
			.writer
			.write_all(b"\n")
			.expect("terminate debug request");
		self.writer.flush().expect("flush debug request");
		let mut line = String::new();
		self
			.reader
			.read_line(&mut line)
			.expect("read debug response");
		let response: Value = serde_json::from_str(&line).expect("decode debug response");
		assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true), "{response}");
		response
	}

	fn keys(&mut self, keys: &str) {
		self.request(json!({ "op": "keys", "keys": keys }));
	}

	fn wait_text(&mut self, needle: &str, limit: Duration) {
		let deadline = Instant::now() + limit;
		loop {
			let response = self.request(json!({ "op": "text" }));
			let found = response
				.get("lines")
				.and_then(Value::as_array)
				.is_some_and(|lines| {
					lines
						.iter()
						.any(|line| line.as_str().is_some_and(|line| line.contains(needle)))
				});
			if found {
				return;
			}
			assert!(
				Instant::now() < deadline,
				"binary chat never displayed {needle:?}; last screen: {response}"
			);
			std_thread::sleep(Duration::from_millis(20));
		}
	}
}
struct ChatPty {
	child:       Child,
	_master:     fd::OwnedFd,
	_slave:      fd::OwnedFd,
	stop_reader: Arc<AtomicUsize>,
	reader:      Option<std_thread::JoinHandle<()>>,
	envd_log:    PathBuf,
}

impl ChatPty {
	fn spawn(binary: &Path, args: &[String], project: &Path, debug: &Path) -> Self {
		let window = Winsize { ws_row: 32, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0 };
		let pty = openpty(Some(&window), None).expect("open binary chat PTY");
		let device = ttyname(&pty.slave).expect("binary chat PTY slave path");
		fcntl(&pty.master, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))
			.expect("nonblocking binary chat PTY");
		let reader_fd = pty.master.try_clone().expect("clone binary chat PTY");
		let stop_reader = Arc::new(AtomicUsize::new(0));
		let reader_stop = Arc::clone(&stop_reader);
		let reader = std_thread::spawn(move || {
			let mut buffer = [0_u8; 8192];
			loop {
				match nix::unistd::read(&reader_fd, &mut buffer) {
					Ok(0) if reader_stop.load(Ordering::Acquire) != 0 => break,
					Ok(_) => {},
					Err(Errno::EAGAIN) if reader_stop.load(Ordering::Acquire) != 0 => {
						break;
					},
					Err(Errno::EAGAIN) => {
						std_thread::sleep(Duration::from_millis(5));
					},
					Err(Errno::EIO) => break,
					Err(error) => panic!("binary chat PTY read failed: {error}"),
				}
			}
		});
		let home = project
			.parent()
			.expect("project parent")
			.join("binary-home");
		let envd_log = omp_env::project_state::directory(&home.join("data"), project)
			.expect("binary chat project state")
			.join("envd.log");
		fs::create_dir_all(&home).expect("create binary chat home");
		let mut command = Command::new(binary);
		command
			.args(args)
			.current_dir(project)
			.env("TERM", "xterm-256color")
			.env("HOME", &home)
			.env("OMP_DATA_DIR", home.join("data"))
			.env("OMP_TTY", &device)
			.env("OMP_TUI_DEBUG", debug)
			.env("NO_COLOR", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.process_group(0);
		let child = command.spawn().expect("spawn real omp chat");
		Self {
			child,
			_master: pty.master,
			_slave: pty.slave,
			stop_reader,
			reader: Some(reader),
			envd_log,
		}
	}

	fn stop(&self) {
		signal::killpg(
			Pid::from_raw(i32::try_from(self.child.id()).expect("chat pid")),
			Some(signal::Signal::SIGSTOP),
		)
		.expect("freeze binary chat process group");
	}

	fn kill(&mut self) {
		let _ = signal::killpg(
			Pid::from_raw(i32::try_from(self.child.id()).expect("chat pid")),
			Some(signal::Signal::SIGKILL),
		);
		let _ = self.child.wait();
		self.finish_reader();
	}

	fn wait(mut self, limit: Duration) -> ExitStatus {
		let deadline = Instant::now() + limit;
		let status = loop {
			if let Some(status) = self.child.try_wait().expect("poll binary chat exit") {
				break status;
			}
			assert!(Instant::now() < deadline, "binary chat did not exit within {limit:?}");
			std_thread::sleep(Duration::from_millis(20));
		};
		self.finish_reader();
		status
	}

	fn finish_reader(&mut self) {
		self.stop_reader.store(1, Ordering::Release);
		if let Some(reader) = self.reader.take() {
			reader.join().expect("binary chat PTY reader joins");
		}
	}
}

impl Drop for ChatPty {
	fn drop(&mut self) {
		if self.child.try_wait().ok().flatten().is_none() {
			let _ = signal::killpg(
				Pid::from_raw(i32::try_from(self.child.id()).unwrap_or(i32::MAX)),
				Some(signal::Signal::SIGKILL),
			);
			let _ = self.child.wait();
		}
		self.finish_reader();
	}
}
async fn run_child(stage: &str, root: &Path) {
	match stage {
		"replay-crash" => Box::pin(replay_child(root, true, false)).await,
		"replay-resume" => Box::pin(replay_child(root, false, true)).await,
		"receipt-crash" => receipt_child(root, true),
		"receipt-resume" => receipt_child(root, false),
		"batch-crash" => Box::pin(batch_child(root, true)).await,
		"batch-resume" => Box::pin(batch_child(root, false)).await,
		other => panic!("unknown P6 child stage {other}"),
	}
}

async fn replay_child(root: &Path, create: bool, _mutated: bool) {
	let journal_path = root.join("journal.jsonl");
	let (_daemon, client, model, _responses) = rpc_host(root, create).await;
	if create {
		let mut journal =
			Journal::create(&journal_path, &header(root, "replay")).expect("create replay journal");
		let hash = PromptHash::from([11; 32]);
		let prompt = message(thread::Role::System, "durable RPC prompt");
		let user = message(thread::Role::User, "survive this RPC host crash");
		let prompt_event = journal
			.append_optimistic(1, prompt.clone(), Some(hash))
			.expect("append durable prompt");
		let input_event = journal
			.append_optimistic(2, user.clone(), Some(hash))
			.expect("append durable input");
		let input = TurnInput::Full(thread::Thread { items: vec![prompt, user] });
		let options = TurnOptions {
			context_id: Some("durable-rpc-context".into()),
			params: pb::ChatParams { model, ..pb::ChatParams::default() },
			..TurnOptions::default()
		};
		journal
			.start_turn(3, TurnStart {
				turn_id:            ROOT_TURN.into(),
				item_events:        vec![input_event],
				prompt_hash:        hash.digest(),
				prompt_head_events: vec![prompt_event],
				toolset_hash:       Registry::new().slot_hash(),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![prompt_event, input_event],
				input:              input_record(&input),
				options:            options_record(&options),
			})
			.expect("durable TurnStart before RPC");
		let mut session = client
			.turn(TurnId::new(ROOT_TURN), input, &options)
			.await
			.expect("open real RPC turn");
		assert!(matches!(
			next_rpc(&mut session).await.event,
			Some(turn_event::Event::Accepted(pb::Accepted { replay: false }))
		));
		let outcome = rpc_outcome(&mut session).await;
		fs::write(root.join("rpc-outcome.bin"), outcome.encode_to_vec())
			.expect("persist expected RPC outcome");
		write_marker(&root.join("accepted"));
		loop {
			std_thread::park();
		}
	}
	let journal = Journal::open(&journal_path).expect("reopen pending RPC journal");
	let start = journal
		.pending_turn()
		.cloned()
		.expect("pending durable TurnStart");
	let poison = TurnOptions {
		context_id: Some("poison-context".into()),
		params: pb::ChatParams { model: "poison/model".to_owned(), ..pb::ChatParams::default() },
		..TurnOptions::default()
	};
	assert_ne!(start.options, options_record(&poison), "fixture must distinguish mutable state");
	let (env, _transport) = EnvClient::in_process(0);
	let snapshot = AgentSnapshot::new(poison, Default::default(), Arc::new(Registry::new()));
	let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, caps());
	let events = agent.events().subscribe_lossless();
	let summary = agent
		.submit(Vec::<thread::Item>::new(), TurnId::new(FALLBACK_TURN))
		.await
		.expect("Agent::submit resumes exact durable RPC turn");
	let expected = pb::Outcome::decode(
		fs::read(root.join("rpc-outcome.bin"))
			.expect("read first host outcome")
			.as_slice(),
	)
	.expect("decode first host outcome");
	assert_eq!(
		summary.outcome.expect("committed outcome"),
		expected,
		"RPC replay outcome changed bytes"
	);
	let mut replay_accepted = false;
	while let Ok(event) = events.try_recv() {
		if let AgentEvent::Turn { turn_id, event } = event.as_ref()
			&& matches!(event.as_ref(), pb::TurnEvent {
				event: Some(turn_event::Event::Accepted(pb::Accepted { replay: true })),
			}) && turn_id.as_str() == ROOT_TURN
		{
			replay_accepted = true;
		}
	}
	assert!(replay_accepted, "Agent::submit did not observe Accepted replay=true");
}

fn receipt_child(root: &Path, crash: bool) {
	let journal_path = root.join("journal.jsonl");
	if crash {
		let mut journal =
			Journal::create(&journal_path, &header(root, "receipt")).expect("create receipt journal");
		let hash = PromptHash::from([7; 32]);
		let prompt = journal
			.append_optimistic(1, message(thread::Role::System, "fixed prompt"), Some(hash))
			.expect("append prompt");
		let input = journal
			.append_optimistic(2, message(thread::Role::User, "fixed input"), Some(hash))
			.expect("append input");
		let full = thread::Thread {
			items: vec![
				message(thread::Role::System, "fixed prompt"),
				message(thread::Role::User, "fixed input"),
			],
		};
		let options =
			TurnOptions { context_id: Some("receipt-context".into()), ..Default::default() };
		let open = OpenRecord {
			turn_id: RECEIPT_TURN.into(),
			input:   TurnInputRecord::Full { thread: full.clone() },
			options: options_record(&options),
		};
		let outcome = end_outcome(&TurnInput::Full(full), "receipt answer");
		journal
			.start_turn(3, TurnStart {
				turn_id:            RECEIPT_TURN.into(),
				item_events:        vec![input],
				prompt_hash:        hash.digest(),
				prompt_head_events: vec![prompt],
				toolset_hash:       Registry::new().slot_hash(),
				enabled_tools:      Vec::new(),
				sequence_targets:   vec![prompt, input],
				input:              open.input.clone(),
				options:            open.options.clone(),
			})
			.expect("durable turn start");
		store_gateway(&root.join("gateway.json"), &GatewayState {
			turns:    vec![GatewayTurn { open, outcome: outcome.clone() }],
			accepted: vec![false],
		});
		journal
			.append_arbiter_outcome(4, RECEIPT_TURN, outcome)
			.expect("durable terminal receipt");
		write_marker(&root.join("receipt"));
		loop {
			std_thread::park();
		}
	}
	let journal = Journal::open(&journal_path).expect("recover missing sequence amendments");
	let first = fs::read(&journal_path).expect("read recovered journal");
	drop(journal);
	let reopened = Journal::open(&journal_path).expect("reopen recovered journal");
	drop(reopened);
	assert_eq!(fs::read(&journal_path).expect("read stable journal"), first);
}

async fn batch_child(root: &Path, create: bool) {
	install_omp_binary_env().expect("expose worker-capable host");
	let journal_path = root.join("journal.jsonl");
	let journal = if create {
		Journal::create(&journal_path, &header(root, "batch")).expect("create batch journal")
	} else {
		Journal::open(&journal_path).expect("open batch journal")
	};
	let mut agent_registry = Registry::new();
	agent_registry
		.register(HangingTool::new(root.join("effects")), Presentation::Slot, core_claims())
		.expect("register agent hanging tool");
	let agent_registry = Arc::new(agent_registry);
	let mut environment_registry = Registry::new();
	environment_registry
		.register(HangingTool::new(root.join("effects")), Presentation::Slot, core_claims())
		.expect("register environment hanging tool");
	let state_dir = root.join("env-state");
	let workspace = root.join("workspace");
	fs::create_dir_all(&state_dir).expect("environment state directory");
	fs::create_dir_all(&workspace).expect("environment workspace directory");
	let server = Arc::new(
		EnvServer::open_local(
			&workspace,
			&state_dir,
			environment_registry,
			ExtHostConfig::new(
				omp_binary().expect("worker-capable host binary"),
				omp_core::Principal::new(omp_core::sf!("e2e-tester"), omp_core::sf!("E2E Tester")),
				omp_core::sf!("p6-session"),
				1,
			),
			RegistryBridges::default(),
		)
		.await
		.expect("real local environment host"),
	);
	let (env, transport) = EnvClient::in_process(64);
	env.set_admitter(AllowAdmission);
	let host = Arc::clone(&server);
	let server_task = tokio::spawn(async move { host.serve_in_process(transport).await });
	env.hello(ClientHello {
		client: "p6-crash-resume".to_owned(),
		schema_rev: SCHEMA_REV,
		..ClientHello::default()
	})
	.await
	.expect("environment handshake");
	let options = TurnOptions { context_id: Some("batch-context".into()), ..Default::default() };
	let mut snapshot = AgentSnapshot::new(options, Default::default(), agent_registry);
	snapshot.enabled_tools = Arc::from([Str::from(TOOL_NAME)]);
	let client = DiskTurnClient::new(root.join("gateway.json"));
	let mut agent = Agent::new(client, env, AgentState::new(snapshot), journal, caps());
	let items = if create {
		vec![message(thread::Role::User, "run the durable batch")]
	} else {
		Vec::new()
	};
	let result = agent
		.submit(items, TurnId::new(if create { BATCH_TURN } else { FALLBACK_TURN }))
		.await;
	if create {
		let _ = result.expect("batch remains live until parent kills this host");
		panic!("hanging tool batch unexpectedly completed");
	}
	let summary = result.expect("recover interrupted batch and proceed");
	let outcome = summary.outcome.expect("committed outcome");
	assert_eq!(outcome.provider, "p6-gateway");
	assert_eq!(outcome.stop(), pb::StopReason::StopEndTurn);
	server_task.abort();
}

fn spawn_child(stage: &str, root: &Path) -> Child {
	let mut command = Command::new(env::current_exe().expect("current P6 test executable"));
	command.process_group(0);
	command
		.arg(TEST_NAME)
		.arg("--exact")
		.arg("--nocapture")
		.arg("--test-threads=1")
		.env(CHILD_ENV, stage)
		.env(ROOT_ENV, root)
		.stdin(Stdio::null())
		.stdout(Stdio::inherit())
		.stderr(Stdio::inherit());
	command.spawn().expect("spawn child host process")
}

async fn run_child_process(stage: &str, root: &Path) -> ExitStatus {
	let mut child = spawn_child(stage, root);
	let deadline = Instant::now() + Duration::from_secs(15);
	loop {
		if let Some(status) = child.try_wait().expect("query child host") {
			return status;
		}
		if Instant::now() >= deadline {
			kill_process_group(&mut child);
			let _ = child.wait();
			panic!("child stage {stage} exceeded its bounded deadline");
		}
		time::sleep(Duration::from_millis(20)).await;
	}
}

fn kill_at_boundary(child: &mut Child) {
	kill_process_group(child);
	let status = child.wait().expect("reap killed child");
	assert!(!status.success(), "crash boundary child exited cleanly before kill");
}

fn kill_process_group(child: &mut Child) {
	if let Ok(group) = i32::try_from(child.id()) {
		let _ = signal::killpg(Pid::from_raw(group), Some(signal::Signal::SIGKILL));
		return;
	}
	let _ = child.kill();
}

async fn wait_for_file(path: &Path) {
	let deadline = Instant::now() + Duration::from_secs(10);
	while !path.exists() {
		assert!(Instant::now() < deadline, "timed out waiting for {}", path.display());
		time::sleep(Duration::from_millis(10)).await;
	}
}

async fn wait_for_lines(path: &Path, count: usize) {
	let deadline = Instant::now() + Duration::from_secs(10);
	loop {
		let observed = fs::read_to_string(path)
			.map(|text| text.lines().count())
			.unwrap_or_default();
		if observed >= count {
			return;
		}
		assert!(Instant::now() < deadline, "timed out waiting for {count} durable effects");
		time::sleep(Duration::from_millis(10)).await;
	}
}

fn assert_single_receipt(path: &Path, turn_id: &str) {
	let journal = Journal::open(path).expect("open completed replay journal");
	let log = journal.load().expect("load completed replay journal");
	let receipts = event_count(
		log.log(),
		|kind| matches!(kind, Kind::TurnReceipt(receipt) if receipt.turn_id == turn_id),
	);
	assert_eq!(receipts, 1, "terminal receipt duplicated");
	let receipt = journal.receipt(turn_id).expect("root turn receipt");
	assert_eq!(receipt.outcome.output.len(), 1);
	let projected =
		project_journal(&log, &Registry::new(), &caps()).expect("project replay journal");
	assert_eq!(projected.items.len(), 3, "replay duplicated or omitted canonical items");
	assert_eq!(
		projected
			.items
			.iter()
			.map(|item| item.seq)
			.collect::<Vec<_>>(),
		vec![1, 2, 3],
		"replay input/output sequences drifted"
	);
	for (item, role, text) in [
		(&projected.items[0], thread::Role::System, "durable RPC prompt"),
		(&projected.items[1], thread::Role::User, "survive this RPC host crash"),
		(&projected.items[2], thread::Role::Assistant, "the durable RPC outcome"),
	] {
		let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
			panic!("replay projected a non-message canonical item");
		};
		assert_eq!(message.role, role as i32);
		assert_eq!(message.parts.len(), 1);
		assert!(matches!(
			message.parts[0].kind.as_ref(),
			Some(thread::part::Kind::Text(actual)) if actual == text
		));
	}
}

fn assert_recovered_sequences(path: &Path) {
	let journal = Journal::open(path).expect("open sequence-recovered journal");
	let log = journal.load().expect("load sequence-recovered journal");
	let amendments = event_count(log.log(), |kind| {
		matches!(kind, Kind::Amend { patch: AmendPatch::Seq { .. }, .. })
	});
	assert_eq!(amendments, 2, "sequence recovery duplicated or omitted amendments");
	let projected =
		project_journal(&log, &Registry::new(), &caps()).expect("project recovered journal");
	let seqs: Vec<_> = projected.items.iter().map(|item| item.seq).collect();
	assert_eq!(seqs, vec![1, 2, 3], "recovered sequence assignment drifted");
}

fn assert_effects(path: &Path) {
	let mut effects: Vec<_> = fs::read_to_string(path)
		.expect("read durable effects")
		.lines()
		.map(str::to_owned)
		.collect();
	effects.sort();
	assert_eq!(effects, vec!["durable-a", "durable-b"]);
}

fn assert_batch_recovery(journal_path: &Path, gateway_path: &Path) {
	let state = load_gateway(gateway_path);
	assert_eq!(state.turns.len(), 2, "recovery performed an extra gateway turn");
	assert_eq!(
		state.accepted,
		vec![false, false],
		"receipt recovery replayed the terminal gateway turn"
	);
	assert_ne!(state.turns[0].open.turn_id, state.turns[1].open.turn_id);
	let journal = Journal::open(journal_path).expect("open recovered batch journal");
	let log = journal.load().expect("load recovered batch journal");
	let mut registry = Registry::new();
	registry
		.register(
			HangingTool::new(journal_path.with_extension("unused-effects")),
			Presentation::Slot,
			core_claims(),
		)
		.expect("register projection tool");
	let projected = project_journal(&log, &registry, &caps()).expect("project interrupted batch");
	let mut result_ids = Vec::new();
	for item in &projected.items {
		if let Some(item::Kind::ToolResult(result)) = &item.kind {
			result_ids.push(result.call_id.as_str());
			assert!(result.is_error, "synthesized interrupted result must be an error");
			assert_crash_abort(result);
		}
	}
	result_ids.sort_unstable();
	assert_eq!(result_ids, vec!["durable-a", "durable-b"]);
	let mut nonzero: Vec<_> = projected
		.items
		.iter()
		.map(|item| item.seq)
		.filter(|seq| *seq != 0)
		.collect();
	let expected: Vec<_> = (1..=u64::try_from(nonzero.len()).expect("item count")).collect();
	assert_eq!(nonzero, expected, "recovery introduced duplicate or drifting sequences");
	nonzero.clear();
}

fn assert_interrupted_follow_up(input: &TurnInput) {
	let mut ids = Vec::new();
	for item in input_items(input) {
		if let Some(item::Kind::ToolResult(result)) = &item.kind {
			assert!(result.is_error, "unfinished call did not synthesize an interrupted error");
			assert_crash_abort(result);
			ids.push(result.call_id.as_str());
		}
	}
	ids.sort_unstable();
	assert_eq!(
		ids,
		vec!["durable-a", "durable-b"],
		"recovery duplicated, omitted, or invented tool results"
	);
}

fn assert_crash_abort(result: &thread::ToolResult) {
	let details = result
		.details
		.as_ref()
		.expect("recovery result has structured outcome");
	let outcome: CallOutcome<Value, Value> =
		serde_json::from_value(proto_json(details).expect("recovery outcome is canonical JSON"))
			.expect("decode recovery outcome");
	assert!(matches!(
		outcome,
		CallOutcome::Aborted {
			abort: Abort::EffectsUnknown { reason },
			..
		} if reason.as_str() == "agent restarted after invocation authorization"
	));
}

fn proto_json(value: &pb::Value) -> Option<Value> {
	Some(match value.kind.as_ref()? {
		value::Kind::Null(_) => Value::Null,
		value::Kind::Bool(value) => (*value).into(),
		value::Kind::Int(value) => (*value).into(),
		value::Kind::Uint(value) => (*value).into(),
		value::Kind::Double(value) => serde_json::Number::from_f64(*value)?.into(),
		value::Kind::String(value) => value.clone().into(),
		value::Kind::List(values) => Value::Array(
			values
				.values
				.iter()
				.map(proto_json)
				.collect::<Option<Vec<_>>>()?,
		),
		value::Kind::Map(values) => Value::Object(
			values
				.fields
				.iter()
				.map(|(key, value)| Some((key.clone(), proto_json(value)?)))
				.collect::<Option<serde_json::Map<_, _>>>()?,
		),
	})
}

fn event_count(log: &transcript::Log, predicate: impl Fn(&Kind) -> bool) -> usize {
	(0..u64::try_from(log.len()).expect("log length"))
		.filter(|index| matches!(log.get(*index), Some(Entry::Ok(event)) if predicate(&event.kind)))
		.count()
}

fn input_record(input: &TurnInput) -> TurnInputRecord {
	match input {
		TurnInput::Full(thread) => TurnInputRecord::Full { thread: thread.clone() },
		TurnInput::Delta(context, delta) => {
			TurnInputRecord::Delta { context: context.clone(), delta: delta.clone() }
		},
	}
}

fn options_record(options: &TurnOptions) -> TurnOptionsRecord {
	TurnOptionsRecord {
		context_id: options.context_id.clone(),
		params:     options.params.clone(),
		executor:   options.executor.clone(),
		props:      options.props.clone(),
	}
}

fn input_items(input: &TurnInput) -> &[thread::Item] {
	match input {
		TurnInput::Full(thread) => &thread.items,
		TurnInput::Delta(_, delta) => &delta.append,
	}
}

fn input_head(input: &TurnInput) -> u64 {
	match input {
		TurnInput::Full(thread) => u64::try_from(thread.items.len()).expect("thread length"),
		TurnInput::Delta(context, delta) => {
			let expected = context.expected.as_ref().expect("delta revision");
			delta.truncate_to.unwrap_or(expected.head)
				+ u64::try_from(delta.append.len()).expect("delta length")
		},
	}
}

fn end_outcome(input: &TurnInput, text: &str) -> pb::Outcome {
	let head = input_head(input);
	pb::Outcome {
		output: vec![thread::Item {
			seq:           head + 1,
			created_at_ms: 9,
			kind:          Some(item::Kind::Message(thread::Message {
				role:  thread::Role::Assistant as i32,
				parts: vec![thread::Part { kind: Some(thread::part::Kind::Text(text.to_owned())) }],
			})),
			props:         None,
		}],
		stop: pb::StopReason::StopEndTurn as i32,
		revision: Some(revision(head + 1)),
		provider: "p6-gateway".to_owned(),
		model: "p6-model".to_owned(),
		..pb::Outcome::default()
	}
}

fn batch_outcome(input: &TurnInput) -> pb::Outcome {
	let head = input_head(input);
	pb::Outcome {
		output: vec![tool_call(head + 1, "durable-a"), tool_call(head + 2, "durable-b")],
		stop: pb::StopReason::StopToolUse as i32,
		revision: Some(revision(head + 2)),
		provider: "p6-gateway".to_owned(),
		model: "p6-model".to_owned(),
		..pb::Outcome::default()
	}
}

fn batch_events(outcome: pb::Outcome) -> Vec<pb::TurnEvent> {
	let mut events = vec![accepted(false)];
	for (index, id) in [(0, "durable-a"), (1, "durable-b"), (2, "ghost-absent")] {
		events.push(event(turn_event::Event::PartStart(pb::PartStart {
			index,
			kind: part_start::Kind::ToolCall as i32,
			tool_call_id: id.to_owned(),
			tool_name: TOOL_NAME.to_owned(),
		})));
		events.push(event(turn_event::Event::PartDelta(pb::PartDelta {
			index,
			chunk: Bytes::from(format!(r#"{{"call":"{id}"}}"#)),
		})));
	}
	events.push(outcome_event(outcome));
	events
}

fn tool_call(seq: u64, id: &str) -> thread::Item {
	thread::Item {
		seq,
		created_at_ms: 8,
		kind: Some(item::Kind::ToolCall(thread::ToolCall {
			id: id.to_owned(),
			name: TOOL_NAME.to_owned(),
			args_json: Bytes::from(format!(r#"{{"call":"{id}"}}"#)),
			..thread::ToolCall::default()
		})),
		props: Some(pb::ValueMap {
			fields: iter::once((TOOL_REV_PROP.to_owned(), pb::Value {
				kind: Some(value::Kind::String("p6.1".to_owned())),
			}))
			.collect(),
		}),
	}
}

fn message(role: thread::Role, text: &str) -> thread::Item {
	thread::Item {
		kind: Some(item::Kind::Message(thread::Message {
			role:  role as i32,
			parts: vec![thread::Part { kind: Some(thread::part::Kind::Text(text.to_owned())) }],
		})),
		..thread::Item::default()
	}
}

const fn accepted(replay: bool) -> pb::TurnEvent {
	event(turn_event::Event::Accepted(pb::Accepted { replay }))
}

const fn outcome_event(outcome: pb::Outcome) -> pb::TurnEvent {
	event(turn_event::Event::Outcome(outcome))
}

const fn event(event: turn_event::Event) -> pb::TurnEvent {
	pb::TurnEvent { event: Some(event) }
}

fn revision(head: u64) -> thread::Revision {
	thread::Revision {
		head,
		token: Bytes::from(vec![u8::try_from(head % 251).expect("token byte"); 32]),
	}
}

const fn caps() -> CapsBase {
	CapsBase {
		maximum_parts:      8,
		maximum_text_bytes: 4096,
		media:              false,
		model_class:        ModelClass::Standard,
	}
}

const fn core_claims() -> Claims {
	Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
}

const fn worker_claims() -> Claims {
	Claims { precedence: Precedence::DEFAULT, claimant: sf!("test/worker"), replaces: None }
}

fn header(root: &Path, id: &str) -> Header {
	Header { v: 4, id: SessionId(Str::from(id)), created: 1, cwd: root.to_owned() }
}

fn load_gateway(path: &Path) -> GatewayState {
	match fs::read(path) {
		Ok(bytes) => serde_json::from_slice(&bytes).expect("decode durable gateway state"),
		Err(error) if error.kind() == io::ErrorKind::NotFound => GatewayState::default(),
		Err(error) => panic!("read durable gateway state: {error}"),
	}
}

fn store_gateway(path: &Path, state: &GatewayState) {
	let bytes = serde_json::to_vec(state).expect("encode durable gateway state");
	let temporary = path.with_extension("tmp");
	fs::write(&temporary, bytes).expect("write temporary gateway state");
	OpenOptions::new()
		.read(true)
		.open(&temporary)
		.expect("open temporary gateway state")
		.sync_all()
		.expect("sync temporary gateway state");
	fs::rename(&temporary, path).expect("publish durable gateway state");
}

fn write_marker(path: &Path) {
	fs::write(path, b"ready").expect("write crash-boundary marker");
	OpenOptions::new()
		.read(true)
		.open(path)
		.expect("open crash-boundary marker")
		.sync_all()
		.expect("sync crash-boundary marker");
}
