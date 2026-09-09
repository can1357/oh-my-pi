//! Executable P7 proof for the real chat TUI, interruption, and terminal
//! restoration.

#![feature(impl_trait_in_assoc_type)]
#![cfg(unix)]

use std::{
	collections::VecDeque,
	fmt::Write as _,
	fs,
	io::{self, BufRead as _, BufReader, Read as _, Write as _},
	os::{
		fd::{self, AsFd as _, AsRawFd as _},
		unix::net::UnixStream,
	},
	path::Path,
	process::{self, Child, Command, Stdio},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	thread,
	time::{Duration, Instant},
};

use bytes::Bytes;
use flume::{Receiver, Sender};
use futures::StreamExt as _;
use nix::{
	errno::Errno,
	fcntl::{FcntlArg, OFlag, fcntl},
	pty::{Winsize, openpty},
	sys::termios::{Termios, cfgetispeed, cfgetospeed, tcgetattr},
	unistd::ttyname,
};
use omp_ai::{
	Answer, Error as InferenceError, Registry,
	answer::{AnswerBody, ChatStream},
	call::{Call, OpaqueJson},
	event::{BlockKind, ChatEvent, Completion, FinishReason, ToolCall, WorkflowResponse},
	id::ToolCallId,
	layer::{LayerCall, stack::RouteProviderService},
	provider::fake::{FakeProvider, FakeScript},
	receipt::{Cost, ExecutionReceipt, ReasonId, Usage, UsageSource},
	registry::RouteUnavailable,
	session::ConversationSessionPlanner,
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
use omp_session::{ComponentRegistry, Session};
use omp_tool::{Claims, Constraint, Effects, Precedence, Presentation, Rev, ToolSpec};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::time;
use tower::Service;

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// The pi-parity composer prompt gutter painted on the input row.
const COMPOSER_PROMPT: &str = "╰─ ";

#[derive(Clone)]
struct GatedRoute {
	fake:            FakeProvider,
	gates:           Arc<Mutex<VecDeque<Receiver<()>>>>,
	captures:        Arc<Mutex<Vec<Call>>>,
	preview_reached: Sender<()>,
	preview_release: Receiver<()>,
}

impl Service<LayerCall<Call>> for GatedRoute {
	type Error = InferenceError;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, InferenceError>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		<FakeProvider as Service<Call>>::poll_ready(&mut self.fake, context)
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		let gate = self
			.gates
			.lock()
			.pop_front()
			.expect("every scripted provider call has a gate");
		let call_index = {
			let mut captures = self.captures.lock();
			let index = captures.len();
			captures.push(request.payload.clone());
			index
		};
		let response = <FakeProvider as Service<Call>>::call(&mut self.fake, request.payload);
		let preview_reached = self.preview_reached.clone();
		let preview_release = self.preview_release.clone();
		async move {
			gate
				.recv_async()
				.await
				.expect("scripted provider gate remains open");
			let Answer { meta, receipt, body } = response.await?;
			let body = if call_index == 1 {
				match body {
					AnswerBody::Chat(mut chat) => {
						let events = async_stream::stream! {
							let mut pause_pending = true;
							while let Some(event) = chat.next().await {
								let pause = pause_pending
									&& matches!(&event, Ok(ChatEvent::ToolArgumentsDelta { .. }));
								pause_pending &= !pause;
								yield event;
								if pause {
									preview_reached
										.send_async(())
										.await
										.expect("preview observer remains open");
									preview_release
										.recv_async()
										.await
										.expect("preview release remains open");
								}
							}
						};
						AnswerBody::Chat(ChatStream::ordinary(Box::pin(events)))
					},
					body => body,
				}
			} else {
				body
			};
			Ok(Answer { meta, receipt, body })
		}
	}
}

struct ScriptedGateway {
	_handle:         DaemonHandle,
	model:           String,
	permits:         Vec<Sender<()>>,
	captures:        Arc<Mutex<Vec<Call>>>,
	preview_reached: Receiver<()>,
	preview_release: Sender<()>,
	_responses:      Receiver<WorkflowResponse>,
}

impl ScriptedGateway {
	async fn start(scratch: &Path, socket: &Path, shell_release: &Path) -> Self {
		let scripts = scripts(shell_release);
		Self::start_with_scripts(scratch, socket, scripts).await
	}

	async fn start_with_scripts(scratch: &Path, socket: &Path, scripts: Vec<FakeScript>) -> Self {
		let mut senders = Vec::with_capacity(scripts.len());
		let mut receivers = VecDeque::with_capacity(scripts.len());
		for _ in 0..scripts.len() {
			let (sender, receiver) = flume::bounded(1);
			senders.push(sender);
			receivers.push_back(receiver);
		}
		let captures = Arc::new(Mutex::new(Vec::with_capacity(scripts.len())));
		let (preview_reached_tx, preview_reached) = flume::bounded(1);
		let (preview_release, preview_release_rx) = flume::bounded(1);
		let (registry, sessions, fake, model) = scripted_registry(
			scratch,
			receivers,
			Arc::clone(&captures),
			preview_reached_tx,
			preview_release_rx,
		);
		fake.extend(scripts);

		let mut tools = omp_tool::Registry::new();
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
			"glob",
			"grep",
			"hub",
			"lsp",
			"task",
			"think",
			"todo",
			"web_search",
			"write",
			"read",
		] {
			tools
				.register_worker(
					ToolSpec {
						name:            sf!(name),
						rev:             Rev {
							family: if name == "edit" {
								sf!("hl")
							} else {
								Str::default()
							},
							n:      1,
						},
						description:     sf!("P7 gateway executor declaration"),
						schema:          Bytes::from_static(br#"{"type":"object"}"#),
						constraint:      Constraint::None,
						effects:         Effects::empty(),
						projection_code: [0; 32],
					},
					Presentation::Device,
					Claims {
						precedence: Precedence::DEFAULT,
						claimant:   sf!("test/worker"),
						replaces:   None,
					},
				)
				.expect("proof tool registers");
		}
		let (responses, incoming) = flume::bounded(32);
		let handle = time::timeout(
			READY_TIMEOUT,
			DaemonHandle::start_for_test(
				DaemonConfig::local(LocalEndpoint::from(socket.to_path_buf()))
					.with_data_dir(scratch.join("gateway-state")),
				registry,
				sessions,
				Arc::new(tools),
				responses,
			),
		)
		.await
		.expect("gateway startup timed out")
		.expect("scripted gateway starts");
		Self {
			_handle: handle,
			model,
			permits: senders,
			captures,
			preview_reached,
			preview_release,
			_responses: incoming,
		}
	}

	fn release(&self, call: usize) {
		self.permits[call]
			.send(())
			.expect("scripted call gate remains open");
	}

	async fn await_preview(&self) {
		match time::timeout(CHECKPOINT_TIMEOUT, self.preview_reached.recv_async()).await {
			Ok(Ok(())) => {},
			Ok(Err(error)) => panic!("edit preview stream observer closed: {error}"),
			Err(_) => panic!(
				"edit preview stream pause timed out after {} captured provider calls",
				self.captures.lock().len()
			),
		}
	}

	fn release_preview(&self) {
		self
			.preview_release
			.send(())
			.expect("edit preview stream remains paused");
	}
}

fn scripted_registry(
	scratch: &Path,
	gates: VecDeque<Receiver<()>>,
	captures: Arc<Mutex<Vec<Call>>>,
	preview_reached: Sender<()>,
	preview_release: Receiver<()>,
) -> (Registry, ConversationSessionPlanner, FakeProvider, String) {
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
		.expect("catalog snapshot");
	let catalog = Arc::new(Catalog::decode(&artifacts.postcard).expect("catalog decode"));
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
	let model_key = model.key.as_str().to_owned();
	let route_id = model.routes.first().expect("chat route").clone();
	let route = catalog.route(&route_id).expect("selected route");
	let fake = FakeProvider::new(route.provider.clone(), route_id.clone());
	let route_service = RouteProviderService::new(GatedRoute {
		fake: fake.clone(),
		gates: Arc::new(Mutex::new(gates)),
		captures,
		preview_reached,
		preview_release,
	});
	let mut builder = Registry::builder(catalog.clone());
	for candidate in catalog.routes() {
		builder = if candidate.id == route_id {
			builder
				.register_route(candidate.id.clone(), route_service.clone())
				.expect("scripted route registers")
		} else {
			builder
				.register_unavailable(RouteUnavailable::new(
					candidate.id.clone(),
					ReasonId(sf!("p7-scripted-route-only")),
					None,
				))
				.expect("unavailable route registers")
		};
	}
	let sessions = ConversationSessionPlanner::open(scratch.join("sessions.db"), catalog)
		.expect("conversation store opens");
	(builder.build().expect("base registry"), sessions, fake, model_key)
}

fn tool_script(calls: &[(&str, &str, Value)]) -> FakeScript {
	let mut events = Vec::with_capacity(calls.len() * 3 + 1);
	for (index, (id, name, arguments)) in calls.iter().enumerate() {
		let index = u32::try_from(index).expect("small scripted batch");
		let id = ToolCallId::from(*id);
		events.push(Ok(ChatEvent::ToolCallStarted { index, id: id.clone(), name: Str::from(*name) }));
		events.push(Ok(ChatEvent::ToolArgumentsDelta {
			index,
			bytes: Bytes::from(serde_json::to_vec(arguments).expect("tool args encode")),
		}));
		events.push(Ok(ChatEvent::ToolCallReady {
			index,
			call: ToolCall {
				id,
				name: Str::from(*name),
				arguments: OpaqueJson::new(arguments.clone()),
			},
		}));
	}
	events.push(Ok(completed(FinishReason::ToolCalls, calls.len())));
	FakeScript::chat(events)
}

/// A provider stream whose thinking block is closed implicitly by the
/// following text block, mirroring reasoning-capable providers.
fn thinking_text_script(thinking: &'static str, answer: &'static str) -> FakeScript {
	FakeScript::chat(vec![
		Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking }),
		Ok(ChatEvent::ThinkingDelta { index: 0, text: Str::from(thinking) }),
		Ok(ChatEvent::BlockStarted { index: 1, kind: BlockKind::Text }),
		Ok(ChatEvent::TextDelta { index: 1, text: Str::from(answer) }),
		Ok(completed(FinishReason::Stop, 2)),
	])
}

fn metered_text_script(text: &'static str) -> FakeScript {
	let usage = Usage {
		input_tokens: 4_096,
		output_tokens: 128,
		source: UsageSource::Provider,
		..Usage::default()
	};
	let receipt = ExecutionReceipt {
		usage,
		cost: Cost::from_micro_usd(1_500_000),
		..ExecutionReceipt::default()
	};
	FakeScript::chat(vec![
		Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
		Ok(ChatEvent::TextDelta { index: 0, text: Str::from(text) }),
		Ok(ChatEvent::Completed(Completion {
			reason: FinishReason::Stop,
			blocks: 1,
			usage,
			receipt: receipt.into(),
		})),
	])
}

fn streaming_edit_script() -> FakeScript {
	let arguments = json!({ "input": "[scratch.txt#5C9F]\nPUT 1.=1:\n+new" });
	let call = ToolCall {
		id:        ToolCallId::from("edit-1"),
		name:      sf!("edit"),
		arguments: OpaqueJson::new(arguments),
	};
	FakeScript::chat(vec![
		Ok(ChatEvent::ToolCallStarted { index: 0, id: call.id.clone(), name: call.name.clone() }),
		Ok(ChatEvent::ToolArgumentsDelta {
			index: 0,
			bytes: Bytes::from_static(br#"{"input":"[scratch.txt#5C9F]\nPUT 1.=1:\n+new""#),
		}),
		Ok(ChatEvent::ToolArgumentsDelta { index: 0, bytes: Bytes::from_static(br"}") }),
		Ok(ChatEvent::ToolCallReady { index: 0, call }),
		Ok(completed(FinishReason::ToolCalls, 1)),
	])
}

fn completed(reason: FinishReason, blocks: usize) -> ChatEvent {
	ChatEvent::Completed(Completion {
		reason,
		blocks: blocks.try_into().unwrap(),
		usage: Usage::default(),
		receipt: ExecutionReceipt::default().into(),
	})
}

fn scripts(_shell_release: &Path) -> Vec<FakeScript> {
	vec![
		tool_script(&[("read-1", "read", json!({ "path": "scratch.txt" }))]),
		streaming_edit_script(),
		tool_script(&[("shell-1", "bash", json!({ "command": "printf 'shell-ok\\n'" }))]),
		metered_text_script("The deterministic tool sequence is complete."),
		tool_script(&[(
			"slow-shell",
			"bash",
			json!({ "command": "printf 'interrupt-ready\\n'; sleep 30" }),
		)]),
	]
}

#[derive(Clone, Debug)]
struct Snapshot {
	text:  String,
	frame: String,
}

impl Snapshot {
	fn combined(&self) -> String {
		format!("{}\n{}", self.text, self.frame)
	}
}

struct DebugClient {
	reader: BufReader<UnixStream>,
	writer: UnixStream,
}

impl DebugClient {
	fn connect(path: &Path, deadline: Instant, process: &mut PtyChild) -> Self {
		loop {
			let problem = match UnixStream::connect(path) {
				Ok(stream) => {
					stream
						.set_read_timeout(Some(IO_TIMEOUT))
						.expect("debug read timeout");
					stream
						.set_write_timeout(Some(IO_TIMEOUT))
						.expect("debug write timeout");
					let writer = stream.try_clone().expect("clone debug socket");
					let mut client = Self { reader: BufReader::new(stream), writer };
					match client.op("info") {
						Ok(_) => return client,
						Err(error) => error,
					}
				},
				Err(error) => error.to_string(),
			};
			if let Some(status) = process
				.child
				.try_wait()
				.expect("poll chat during debug startup")
			{
				let mut stdout = String::new();
				let mut stderr = String::new();
				if let Some(mut pipe) = process.child.stdout.take() {
					pipe.read_to_string(&mut stdout).expect("read early stdout");
				}
				if let Some(mut pipe) = process.child.stderr.take() {
					pipe.read_to_string(&mut stderr).expect("read early stderr");
				}
				panic!(
					"chat exited before debug socket: {status}\nconnect: {problem}\nstdout: \
					 {stdout}\nstderr: {stderr}\nraw PTY:\n{}",
					visible(&process.raw()),
				);
			}
			assert!(
				Instant::now() < deadline,
				"debug socket did not become ready: {problem}\nraw PTY:\n{}",
				visible(&process.raw()),
			);
			thread::sleep(Duration::from_millis(20));
		}
	}

	fn request(&mut self, request: Value) -> Result<Value, String> {
		serde_json::to_writer(&mut self.writer, &request).map_err(|error| error.to_string())?;
		self
			.writer
			.write_all(b"\n")
			.map_err(|error| error.to_string())?;
		self.writer.flush().map_err(|error| error.to_string())?;
		let mut line = String::new();
		self
			.reader
			.read_line(&mut line)
			.map_err(|error| error.to_string())?;
		if line.is_empty() {
			return Err("debug socket closed".to_owned());
		}
		let response: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
		if response.get("ok").and_then(Value::as_bool) != Some(true) {
			return Err(format!("debug request {request} failed: {response}"));
		}
		Ok(response)
	}

	fn op(&mut self, op: &'static str) -> Result<Value, String> {
		self.request(json!({ "op": op }))
	}

	fn keys(&mut self, keys: &str) {
		self
			.request(json!({ "op": "keys", "keys": keys }))
			.unwrap_or_else(|error| panic!("key injection failed: {error}"));
	}

	fn snapshot(&mut self) -> Result<Snapshot, String> {
		let text = lines(&self.op("text")?);
		let frame = lines(&self.op("frame")?);
		Ok(Snapshot { text, frame })
	}
}

fn lines(response: &Value) -> String {
	response
		.get("lines")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
		.collect::<Vec<_>>()
		.join("\n")
}

struct PtyChild {
	child:      Child,
	master:     fd::OwnedFd,
	slave:      fd::OwnedFd,
	before:     Termios,
	raw:        Arc<Mutex<Vec<u8>>>,
	reader_end: Arc<AtomicBool>,
	reader:     Option<thread::JoinHandle<()>>,
}

impl PtyChild {
	fn spawn(binary: &Path, args: &[String], project: &Path, debug: &Path) -> Self {
		let window = Winsize { ws_row: 48, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
		let pty = openpty(Some(&window), None).expect("open PTY");
		let device = ttyname(&pty.slave).expect("PTY slave path");
		let before = tcgetattr(&pty.slave).expect("initial PTY termios");
		fcntl(&pty.master, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).expect("nonblocking PTY master");
		let reader_fd = pty.master.try_clone().expect("clone PTY master");
		let raw = Arc::new(Mutex::new(Vec::new()));
		let reader_raw = raw.clone();
		let reader_end = Arc::new(AtomicBool::new(false));
		let reader_stop = reader_end.clone();
		let reader = thread::spawn(move || {
			let mut buffer = [0_u8; 16 * 1024];
			loop {
				match nix::unistd::read(&reader_fd, &mut buffer) {
					Ok(0) if reader_stop.load(Ordering::Acquire) => break,
					Ok(0) => thread::sleep(Duration::from_millis(5)),
					Ok(count) => reader_raw.lock().extend_from_slice(&buffer[..count]),
					Err(Errno::EAGAIN) if reader_stop.load(Ordering::Acquire) => break,
					Err(Errno::EAGAIN) => thread::sleep(Duration::from_millis(5)),
					Err(Errno::EIO) => break,
					Err(error) => panic!("PTY read failed: {error}"),
				}
			}
		});

		let home = project.parent().expect("project has parent").join("home");
		fs::create_dir_all(&home).expect("create isolated home");
		let child = Command::new(binary)
			.args(args)
			.current_dir(project)
			.env("TERM", "xterm-256color")
			.env("HOME", &home)
			.env("OMP_DATA_DIR", home.join("data"))
			.env("OMP_TTY", &device)
			.env("OMP_TUI_DEBUG", debug)
			.env("NO_COLOR", "1")
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("spawn omp chat");
		Self {
			child,
			master: pty.master,
			slave: pty.slave,
			before,
			raw,
			reader_end,
			reader: Some(reader),
		}
	}

	fn resize(&self, rows: u16, cols: u16) {
		let window = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
		// SAFETY: master is a live PTY and window is a valid winsize value.
		let result =
			unsafe { libc::ioctl(self.master.as_fd().as_raw_fd(), libc::TIOCSWINSZ, &window) };
		assert_eq!(result, 0, "TIOCSWINSZ failed: {}", io::Error::last_os_error());
	}

	fn raw(&self) -> Vec<u8> {
		self.raw.lock().clone()
	}

	fn wait(mut self, timeout: Duration) -> (process::ExitStatus, Vec<u8>, String, String, Termios) {
		let deadline = Instant::now() + timeout;
		let status = loop {
			match self.child.try_wait().expect("poll omp chat") {
				Some(status) => break status,
				None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
				None => {
					let raw = visible(&self.raw());
					let _ = self.child.kill();
					panic!("omp chat did not exit in {timeout:?}; raw PTY:\n{raw}");
				},
			}
		};
		self.reader_end.store(true, Ordering::Release);
		if let Some(reader) = self.reader.take() {
			reader.join().expect("PTY reader joins");
		}
		let mut stdout = String::new();
		let mut stderr = String::new();
		if let Some(mut pipe) = self.child.stdout.take() {
			pipe.read_to_string(&mut stdout).expect("read child stdout");
		}
		if let Some(mut pipe) = self.child.stderr.take() {
			pipe.read_to_string(&mut stderr).expect("read child stderr");
		}
		let after = tcgetattr(&self.slave).expect("final PTY termios");
		(status, self.raw(), stdout, stderr, after)
	}
}

fn wait_snapshot(
	debug: &mut DebugClient,
	raw: &Arc<Mutex<Vec<u8>>>,
	label: &str,
	mut ready: impl FnMut(&Snapshot) -> bool,
) -> Snapshot {
	let deadline = Instant::now() + CHECKPOINT_TIMEOUT;
	let mut last = None;
	let mut error = None;
	loop {
		match debug.snapshot() {
			Ok(snapshot) if ready(&snapshot) => return snapshot,
			Ok(snapshot) => last = Some(snapshot),
			Err(problem) => error = Some(problem),
		}
		if Instant::now() >= deadline {
			let snapshot = last.map_or_else(|| "<none>".to_owned(), |value| format!("{value:#?}"));
			panic!(
				"checkpoint {label:?} timed out\nlast error: {error:?}\nlast \
				 snapshot:\n{snapshot}\nraw PTY:\n{}",
				visible(&raw.lock()),
			);
		}
		thread::sleep(Duration::from_millis(15));
	}
}

fn wait_info(debug: &mut DebugClient, label: &str, mut ready: impl FnMut(&Value) -> bool) -> Value {
	let deadline = Instant::now() + CHECKPOINT_TIMEOUT;
	loop {
		let info = debug
			.op("info")
			.unwrap_or_else(|error| panic!("{label}: {error}"));
		if ready(&info) {
			return info;
		}
		assert!(Instant::now() < deadline, "checkpoint {label:?} timed out: {info}");
		thread::sleep(Duration::from_millis(15));
	}
}

fn assert_surface(snapshot: &Snapshot, label: &str) {
	assert!(!snapshot.text.trim().is_empty(), "{label}: published terminal surface is empty");
}

fn visible(bytes: &[u8]) -> String {
	let mut out = String::new();
	for &byte in &bytes[bytes.len().saturating_sub(96 * 1024)..] {
		match byte {
			b'\n' => out.push('\n'),
			b'\r' => out.push_str("\\r"),
			b'\t' => out.push_str("\\t"),
			0x20..=0x7e => out.push(char::from(byte)),
			_ => write!(out, "\\x{byte:02x}").expect("writing to String cannot fail"),
		}
	}
	out
}

/// Creates one authoritative resumable `.oms` journal.
fn seed_session(path: &Path) {
	Session::create(path, ComponentRegistry::standard()).expect("create resumable TUI session");
}

fn journal(path: &Path) -> String {
	fs::read_to_string(path).expect("read session journal")
}

fn assert_journal_chain(text: &str) {
	let frames = text
		.split("\n\n")
		.filter(|frame| frame.contains("event:"))
		.collect::<Vec<_>>();
	assert!(!frames.is_empty(), "journal has no SSE frames");
	for frame in frames.iter().skip(1) {
		assert!(
			frame.lines().any(|line| line.starts_with("by: ")),
			"non-genesis frame has no by: {frame}"
		);
	}
}

fn assert_restored(raw: &[u8], before: &Termios, after: &Termios, diagnostics: &str) {
	let alt_enter = raw.windows(8).rposition(|window| window == b"\x1b[?1049h");
	let alt_exit = raw.windows(8).rposition(|window| window == b"\x1b[?1049l");
	assert!(
		alt_enter.is_none() || alt_exit.is_some_and(|exit| Some(exit) > alt_enter),
		"alternate buffer was not restored; enter={alt_enter:?} exit={alt_exit:?}\n{diagnostics}"
	);
	for sequence in ["\x1b[?1047h", "\x1b[?47h"] {
		assert!(
			!raw
				.windows(sequence.len())
				.any(|window| window == sequence.as_bytes()),
			"legacy alternate-buffer entry {sequence:?} observed\n{diagnostics}"
		);
	}
	for mode in [1000, 1002, 1003, 1006] {
		let enable = format!("\x1b[?{mode}h");
		let disable = format!("\x1b[?{mode}l");
		let enabled = raw
			.windows(enable.len())
			.rposition(|window| window == enable.as_bytes());
		let disabled = raw
			.windows(disable.len())
			.rposition(|window| window == disable.as_bytes());
		assert!(
			enabled.is_none() || disabled.is_some_and(|exit| Some(exit) > enabled),
			"mouse tracking mode {mode} was not restored; enable={enabled:?} \
			 disable={disabled:?}\n{diagnostics}"
		);
	}
	let hide = raw.windows(6).rposition(|window| window == b"\x1b[?25l");
	let show = raw.windows(6).rposition(|window| window == b"\x1b[?25h");
	assert!(
		show.is_some() && hide.is_none_or(|hidden| show > Some(hidden)),
		"cursor was not restored; hide={hide:?} show={show:?}\n{diagnostics}"
	);
	assert_eq!(after.input_flags, before.input_flags, "input flags not restored\n{diagnostics}");
	assert_eq!(after.output_flags, before.output_flags, "output flags not restored\n{diagnostics}");
	assert_eq!(
		after.control_flags, before.control_flags,
		"control flags not restored\n{diagnostics}"
	);
	assert_eq!(after.local_flags, before.local_flags, "local flags not restored\n{diagnostics}");
	assert_eq!(
		after.control_chars, before.control_chars,
		"control characters not restored\n{diagnostics}"
	);
	assert_eq!(
		cfgetispeed(after),
		cfgetispeed(before),
		"input baud rate not restored\n{diagnostics}"
	);
	assert_eq!(
		cfgetospeed(after),
		cfgetospeed(before),
		"output baud rate not restored\n{diagnostics}"
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_tui_drives_real_pty_tools_interrupt_resize_and_clean_quit() {
	use std::os::unix::fs::PermissionsExt;
	omp_e2e::support::install_omp_binary_env().expect("install Cargo-built omp binary");
	let scratch = tempfile::tempdir().expect("scratch root");
	fs::set_permissions(scratch.path(), <fs::Permissions>::from_mode(0o700))
		.expect("secure scratch root");
	let project = scratch.path().join("project");
	fs::create_dir(&project).expect("project directory");
	let project = fs::canonicalize(&project).expect("canonical project root");
	fs::write(project.join("scratch.txt"), "old\n").expect("write read/edit fixture");
	let metadata_dir = project.join(".omp");
	fs::create_dir(&metadata_dir).expect("project metadata directory");
	fs::set_permissions(&metadata_dir, <fs::Permissions>::from_mode(0o755))
		.expect("use standard project metadata permissions");

	let shell_release = scratch.path().join("unused-shell-release");
	let gateway_socket = scratch.path().join("gateway.sock");
	let debug_socket = scratch.path().join("tui-debug.sock");
	let gateway = ScriptedGateway::start(scratch.path(), &gateway_socket, &shell_release).await;
	let session_path = scratch.path().join("p7-tools.oms");
	seed_session(&session_path);
	gateway.release(0);

	let binary = omp_e2e::support::omp_binary().expect("locate omp binary");
	let args = vec![
		"chat".to_owned(),
		"--model".to_owned(),
		gateway.model.clone(),
		"--project".to_owned(),
		project.display().to_string(),
		"--gateway".to_owned(),
		gateway_socket.display().to_string(),
		"--session".to_owned(),
		session_path.display().to_string(),
		"--envd-idle-timeout".to_owned(),
		"2".to_owned(),
	];
	let mut process = PtyChild::spawn(&binary, &args, &project, &debug_socket);
	let raw_capture = process.raw.clone();
	let mut debug =
		DebugClient::connect(&debug_socket, Instant::now() + READY_TIMEOUT, &mut process);
	let ready = wait_snapshot(&mut debug, &raw_capture, "chat shell ready", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("Welcome back!")
			&& surface.contains("omp v")
			&& surface.contains(&gateway.model)
			&& surface.contains(project.to_string_lossy().as_ref())
			&& surface.contains("turn 0 · 0 in / 0 out")
			&& surface.contains(COMPOSER_PROMPT)
	});
	assert_surface(&ready, "ready");

	debug.keys("'exercise deterministic tools' enter");
	let read = wait_snapshot(&mut debug, &raw_capture, "read card settled", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("Read scratch.txt") && surface.contains("old")
	});
	assert_surface(&read, "read card");
	let first_journal = journal(&session_path);
	assert!(first_journal.contains("event: tool.call@1"), "read call absent from journal");
	assert!(first_journal.contains("event: tool.result@1"), "read result absent from journal");
	assert_journal_chain(&first_journal);

	gateway.release(1);
	gateway.await_preview().await;
	let preview = wait_snapshot(&mut debug, &raw_capture, "edit live preview", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("edit arguments")
			&& fs::read_to_string(project.join("scratch.txt")).is_ok_and(|text| text == "old\n")
	});
	assert_surface(&preview, "edit preview");
	gateway.release_preview();
	let final_edit = wait_snapshot(&mut debug, &raw_capture, "edit card settled", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("Edit:")
			&& surface.contains("scratch.txt")
			&& fs::read_to_string(project.join("scratch.txt")).is_ok_and(|text| text == "new\n")
			&& journal(&session_path)
				.matches("event: tool.result@1")
				.count() >= 2
	});
	assert_surface(&final_edit, "edit final");
	let edit_journal = journal(&session_path);
	assert!(edit_journal.matches("event: tool.call@1").count() >= 2);
	assert!(edit_journal.matches("event: tool.result@1").count() >= 2);
	assert_journal_chain(&edit_journal);

	gateway.release(2);
	let shell = wait_snapshot(&mut debug, &raw_capture, "bash card settled", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("$ printf 'shell-ok")
			&& surface.contains("shell-ok")
			&& journal(&session_path)
				.matches("event: tool.result@1")
				.count() >= 3
	});
	assert_surface(&shell, "bash final");
	let shell_journal = journal(&session_path);
	assert!(shell_journal.matches("event: tool.call@1").count() >= 3);
	assert!(shell_journal.matches("event: tool.result@1").count() >= 3);
	assert_journal_chain(&shell_journal);

	gateway.release(3);
	let summary = wait_snapshot(&mut debug, &raw_capture, "tool turn complete", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("The deterministic tool sequence is complete.")
			&& surface.contains("turn 1")
			&& surface.contains("4096 in / 128 out")
	});
	assert_surface(&summary, "tool summary");

	debug.keys("'interrupt the next tool' enter");
	gateway.release(4);
	let running = wait_snapshot(&mut debug, &raw_capture, "interruptible bash live", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("bash running") && surface.contains("\"terminal\":false")
	});
	assert_surface(&running, "interruptible bash");

	process.resize(32, 92);
	debug
		.op("resize")
		.unwrap_or_else(|error| panic!("resize injection failed: {error}"));
	// At 32 rows the settled cards retire into native scrollback; the live
	// card, band, and composer must survive the rebuild.
	let resized = wait_snapshot(&mut debug, &raw_capture, "streaming resize", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("sleep 30")
			&& surface.contains("interrupt the next tool")
			&& surface.contains(COMPOSER_PROMPT)
	});
	assert_surface(&resized, "resized");
	let info = wait_info(&mut debug, "settled streaming resize", |info| {
		info.get("rows").and_then(Value::as_u64) == Some(32)
			&& info.get("cols").and_then(Value::as_u64) == Some(92)
	});
	assert_eq!(info.get("rows").and_then(Value::as_u64), Some(32), "resize rows: {info}");
	assert_eq!(info.get("cols").and_then(Value::as_u64), Some(92), "resize cols: {info}");

	debug.keys("ctrl+c");
	let interrupted =
		wait_snapshot(&mut debug, &raw_capture, "turn interrupted and responsive", |snapshot| {
			let surface = snapshot.combined();
			surface.contains(COMPOSER_PROMPT)
				&& journal(&session_path)
					.matches("event: tool.result@1")
					.count() >= 4
		});
	assert_surface(&interrupted, "interrupt");
	let interrupted_journal = journal(&session_path);
	assert!(interrupted_journal.matches("event: tool.call@1").count() >= 4);
	assert!(interrupted_journal.matches("event: tool.result@1").count() >= 4);
	assert!(interrupted_journal.contains("event: msg.assistant.end@1"));
	assert_journal_chain(&interrupted_journal);

	debug.keys("ctrl+c");
	drop(debug);
	let before = process.before.clone();
	let (status, raw, stdout, stderr, after) = process.wait(READY_TIMEOUT);
	let diagnostics = format!(
		"status={status}\nstdout={stdout}\nstderr={stderr}\nlast frame={}\nraw={}",
		interrupted.frame,
		visible(&raw),
	);
	assert!(status.success(), "omp chat did not exit cleanly\n{diagnostics}");
	assert_restored(&raw, &before, &after, &diagnostics);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chat_tui_persists_thinking_blocks_across_turns_and_resume() {
	use std::os::unix::fs::PermissionsExt;
	omp_e2e::support::install_omp_binary_env().expect("install Cargo-built omp binary");
	let scratch = tempfile::tempdir().expect("scratch root");
	fs::set_permissions(scratch.path(), <fs::Permissions>::from_mode(0o700))
		.expect("secure scratch root");
	let project = scratch.path().join("project");
	fs::create_dir(&project).expect("project directory");
	let project = fs::canonicalize(&project).expect("canonical project root");
	let metadata_dir = project.join(".omp");
	fs::create_dir(&metadata_dir).expect("project metadata directory");
	fs::set_permissions(&metadata_dir, <fs::Permissions>::from_mode(0o755))
		.expect("use standard project metadata permissions");
	let gateway_socket = scratch.path().join("gateway.sock");
	let debug_socket = scratch.path().join("tui-debug.sock");
	let gateway = ScriptedGateway::start_with_scripts(scratch.path(), &gateway_socket, vec![
		thinking_text_script(
			"Weighing the first request.\nThe deterministic option is safest.",
			"First answer settled.",
		),
		thinking_text_script("Second deliberation paragraph.", "Second answer settled."),
	])
	.await;
	gateway.release(0);
	gateway.release(1);

	let sessions_dir = scratch.path().join("sessions");
	fs::create_dir(&sessions_dir).expect("session directory");
	let session_path = sessions_dir.join("thinking.oms");
	seed_session(&session_path);
	let binary = omp_e2e::support::omp_binary().expect("locate omp binary");
	let base_args = vec![
		"chat".to_owned(),
		"--model".to_owned(),
		gateway.model.clone(),
		"--project".to_owned(),
		project.display().to_string(),
		"--gateway".to_owned(),
		gateway_socket.display().to_string(),
		"--session-dir".to_owned(),
		sessions_dir.display().to_string(),
		"--envd-idle-timeout".to_owned(),
		"2".to_owned(),
	];
	let mut args = base_args.clone();
	args.extend(["--session".to_owned(), session_path.display().to_string()]);
	let mut process = PtyChild::spawn(&binary, &args, &project, &debug_socket);
	let raw_capture = process.raw.clone();
	let mut debug =
		DebugClient::connect(&debug_socket, Instant::now() + READY_TIMEOUT, &mut process);
	let ready = wait_snapshot(&mut debug, &raw_capture, "chat shell ready", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("Welcome back!")
			&& surface.contains("omp v")
			&& surface.contains(&gateway.model)
			&& surface.contains(project.to_string_lossy().as_ref())
			&& surface.contains("turn 0 · 0 in / 0 out")
			&& surface.contains(COMPOSER_PROMPT)
	});
	assert_surface(&ready, "ready");

	debug.keys("'first prompt' enter");
	let first = wait_snapshot(&mut debug, &raw_capture, "first turn keeps thinking", |snapshot| {
		snapshot.frame.contains("First answer settled.")
			&& snapshot.frame.contains("Weighing the first request")
	});
	assert_surface(&first, "first turn");
	let first_journal = journal(&session_path);
	assert!(first_journal.contains("event: msg.assistant.end@1"));
	assert_journal_chain(&first_journal);

	debug.keys("ctrl+t");
	let hidden = wait_snapshot(&mut debug, &raw_capture, "ctrl+t hides thinking", |snapshot| {
		snapshot.frame.contains("First answer settled.")
			&& !snapshot.frame.contains("Weighing the first request")
	});
	assert_surface(&hidden, "hidden thinking");
	assert_eq!(
		journal(&session_path),
		first_journal,
		"visibility toggle changed the session DOM journal"
	);
	debug.keys("ctrl+t");
	wait_snapshot(&mut debug, &raw_capture, "ctrl+t restores thinking", |snapshot| {
		snapshot.frame.contains("Weighing the first request")
	});
	assert_eq!(
		journal(&session_path),
		first_journal,
		"restoring visibility changed the session DOM journal"
	);

	debug.keys("'second prompt' enter");
	let second = wait_snapshot(&mut debug, &raw_capture, "second turn keeps history", |snapshot| {
		let surface = snapshot.combined();
		surface.contains("Second answer settled.")
			&& surface.contains("Second deliberation paragraph.")
			&& surface.contains("First answer settled.")
	});
	assert_surface(&second, "second turn");
	let second_journal = journal(&session_path);
	assert!(second_journal.matches("event: msg.assistant.end@1").count() >= 2);
	assert_journal_chain(&second_journal);

	// Ctrl+C on an idle composer arms exit; a second press within the window
	// quits.
	debug.keys("ctrl+c ctrl+c");
	drop(debug);
	let before = process.before.clone();
	let (status, raw, stdout, stderr, after) = process.wait(READY_TIMEOUT);
	let diagnostics =
		format!("status={status}\nstdout={stdout}\nstderr={stderr}\nraw={}", visible(&raw));
	assert!(status.success(), "omp chat did not exit cleanly\n{diagnostics}");
	assert_restored(&raw, &before, &after, &diagnostics);

	let resume_socket = scratch.path().join("resume-tui-debug.sock");
	let mut resume_args = base_args;
	resume_args.push("-c".to_owned());
	let mut resumed = PtyChild::spawn(&binary, &resume_args, &project, &resume_socket);
	let resumed_raw = resumed.raw.clone();
	let mut resume_debug =
		DebugClient::connect(&resume_socket, Instant::now() + READY_TIMEOUT, &mut resumed);
	let rehydrated = wait_snapshot(
		&mut resume_debug,
		&resumed_raw,
		"resumed transcript keeps thinking bodies",
		|snapshot| {
			let all = snapshot.combined();
			all.contains("First answer settled.")
				&& all.contains("Second answer settled.")
				&& all.contains("Weighing the first request")
				&& all.contains("Second deliberation paragraph.")
		},
	);
	assert_surface(&rehydrated, "resumed thinking transcript");
	let resumed_journal = journal(&session_path);
	assert!(
		resumed_journal.starts_with(&second_journal),
		"resume did not preserve the authoritative journal prefix"
	);
	assert_journal_chain(&resumed_journal);

	resume_debug.keys("ctrl+c ctrl+c");
	drop(resume_debug);
	let resumed_before = resumed.before.clone();
	let (resumed_status, resumed_bytes, resumed_stdout, resumed_stderr, resumed_after) =
		resumed.wait(READY_TIMEOUT);
	let resumed_diagnostics = format!(
		"status={resumed_status}\nstdout={resumed_stdout}\nstderr={resumed_stderr}\nraw={}",
		visible(&resumed_bytes)
	);
	assert!(
		resumed_status.success(),
		"resumed omp chat did not exit cleanly\n{resumed_diagnostics}"
	);
	assert_restored(&resumed_bytes, &resumed_before, &resumed_after, &resumed_diagnostics);
}
