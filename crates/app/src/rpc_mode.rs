//! Stateful JSON-line RPC actor over the journal-first kernel and session DOM.

mod history;

use std::{
	collections::{BTreeMap, HashMap, HashSet},
	fs,
	future::Future,
	path::{Path, PathBuf},
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Instant, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_agent::{
	Inference, Kernel, KernelError, KernelEvent, LocalRun, LocalRunKind, RunControl, TurnInput,
	TurnOutcome, TurnStop, Up,
};
use omp_core::Str;
use omp_dom::{
	Dom, Handle, KnownTag, Node, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value as DomValue,
};
use omp_driver::{
	headless::kernel::SessionHome,
	workspace_trust::{WITHHELD_NOTICE, WorkspaceTrustSource},
};
use omp_ext::{trust::GrantDuration, workspace_trust::TrustDecision};
use omp_rpc::{
	framing::{
		JsonLineDecoder, MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES, RpcFrameDecoder, encode_json_v1,
		encode_json_v2,
	},
	protocol::{
		PROTOCOL_V1, PROTOCOL_V2, ReadyFrame, RequestId, RpcErrorCode, RpcRequest, RpcResponse,
		SESSION_STARTUP_COMMAND, SessionStartupParams,
	},
};
use omp_session::Session;
use omp_tool::{
	HostToolExecutor, HostToolInvocation, HostToolResult as RuntimeHostToolResult, HostToolSpec,
	HostToolUpdateSink,
};
use omp_tools::{
	ask::{AskPresenter, Fault as AskFault, Presentation, Question, Selection},
	shell,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{
	AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader,
	stdin, stdout,
};
use tokio_util::sync::CancellationToken;

use crate::{
	chat_cmd::{Launch, LaunchEnv},
	cli::{ChatArgs, RpcArgs},
};

/// Runs the RPC server using stdin exclusively for protocol input and stdout
/// exclusively for protocol output.
pub async fn run(args: RpcArgs, ui_enabled: bool) -> miette::Result<()> {
	let max_time = args.max_time.map(|duration| duration.0);
	let future = run_inner(args.launch, ui_enabled);
	match max_time {
		Some(limit) => tokio::time::timeout(limit, future)
			.await
			.map_err(|_| miette!("RPC mode exceeded --max-time"))?,
		None => future.await,
	}
}

async fn run_inner(args: ChatArgs, ui_enabled: bool) -> miette::Result<()> {
	let project = fs::canonicalize(&args.project).into_diagnostic()?;
	let ctx = Arc::new(crate::process_ctx(&project)?);
	let env = LaunchEnv::production(&project, args.gateway.is_some())?;
	let mut input = BufReader::new(stdin());
	let mut output = stdout();
	let (startup, pending) = receive_startup(&mut input, &mut output).await?;
	let mut launch = Launch::prepare(args, ctx, env).await?;
	if startup.trust_workspace == Some(true) {
		launch.options.workspace_trust =
			WorkspaceTrustSource::Fixed(TrustDecision::Trusted { duration: GrantDuration::Session });
	}
	let (kernel, session) = launch.compose().await?;
	let home = SessionHome::new(
		&launch.data_dir,
		&launch.project,
		&launch.options,
		launch.model.clone(),
		kernel.mailbox(),
		kernel.turn_activity(),
	)
	.into_diagnostic()?
	.with_workspace_trust(kernel.inference().workspace_trust().clone());
	let ui = ui_enabled.then(RpcUiBridge::new);
	if let Some(ui) = &ui {
		kernel
			.inference()
			.environment()
			.bind_ask_presenter(Arc::new(ui.clone()));
	}
	let runtime = RpcRuntime {
		con:                  Some(Arc::clone(&launch.ctx)),
		catalog:              Some(
			kernel
				.inference()
				.live_catalog()
				.map_or_else(|| Arc::clone(&launch.catalog), |live| live.load()),
		),
		model:                launch.model.clone(),
		model_cycle:          launch.cycle(),
		model_cycle_index:    0,
		project:              launch.project.clone(),
		session_name:         None,
		automatic_compaction: true,
		auto_retry:           true,
		steering_mode:        Str::new_static("one-at-a-time"),
		follow_up_mode:       Str::new_static("one-at-a-time"),
		interrupt_mode:       Str::new_static("immediate"),
		skills:               launch.options.discovered_skills.clone(),
	};
	let input = std::io::Cursor::new(pending).chain(input);
	serve_rpc_with_runtime(kernel, session, home, ui, runtime, input, output, false).await
}

/// Offers startup before composition. A legacy first request selects ordinary
/// grant evaluation and is replayed unchanged into the normal RPC decoder.
async fn receive_startup<R, W>(
	input: &mut R,
	output: &mut W,
) -> miette::Result<(SessionStartupParams, Vec<u8>)>
where
	R: tokio::io::AsyncBufRead + Unpin,
	W: AsyncWrite + Unpin,
{
	let ready = serde_json::to_vec(&ReadyFrame::v2_capable(MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES))
		.into_diagnostic()?;
	output.write_all(&ready).await.into_diagnostic()?;
	output.write_all(b"\n").await.into_diagnostic()?;
	output.flush().await.into_diagnostic()?;

	let mut line = Vec::new();
	input
		.take((MAX_FRAME_BYTES + 1) as u64)
		.read_until(b'\n', &mut line)
		.await
		.into_diagnostic()?;
	if line.len() > MAX_FRAME_BYTES {
		return Err(miette!("RPC startup frame exceeds the frame limit"));
	}
	let Ok(request) = serde_json::from_slice::<RpcRequest>(&line) else {
		return Ok((SessionStartupParams::default(), line));
	};
	if request.command != SESSION_STARTUP_COMMAND {
		return Ok((SessionStartupParams::default(), line));
	}
	let params = request.parse_params::<SessionStartupParams>();
	let response = match &params {
		Ok(_) => RpcResponse::success_empty(request.id, SESSION_STARTUP_COMMAND),
		Err(_) => RpcResponse::error(
			request.id,
			SESSION_STARTUP_COMMAND,
			"session_startup requires `trustWorkspace` to be a boolean when present",
			Some(RpcErrorCode::new("invalid_params")),
		),
	};
	let response = serde_json::to_vec(&response).into_diagnostic()?;
	output.write_all(&response).await.into_diagnostic()?;
	output.write_all(b"\n").await.into_diagnostic()?;
	output.flush().await.into_diagnostic()?;
	Ok((params.into_diagnostic()?, Vec::new()))
}

/// Remote retained-dialog bridge enabled by `rpc-ui`.
///
/// The environment's `ask@2` presenter emits ordinary
/// `extension_ui_request` frames and waits for correlated
/// `extension_ui_response` input. Plain `rpc` never installs this presenter.
#[doc(hidden)]
#[derive(Clone)]
pub struct RpcUiBridge {
	inner: Arc<RpcUiInner>,
}

struct RpcUiInner {
	requests_tx: flume::Sender<Value>,
	requests_rx: flume::Receiver<Value>,
	state:       Mutex<RpcUiState>,
}

#[derive(Default)]
struct RpcUiState {
	pending: BTreeMap<String, flume::Sender<Map<String, Value>>>,
	closed:  bool,
}

struct PendingUiReply {
	bridge: RpcUiBridge,
	id:     String,
}

impl Drop for PendingUiReply {
	fn drop(&mut self) {
		self.bridge.inner.state.lock().pending.remove(&self.id);
	}
}

impl RpcUiBridge {
	/// Creates an unattached retained-dialog bridge.
	#[doc(hidden)]
	#[must_use]
	pub fn new() -> Self {
		let (requests_tx, requests_rx) = flume::unbounded();
		Self {
			inner: Arc::new(RpcUiInner {
				requests_tx,
				requests_rx,
				state: Mutex::new(RpcUiState::default()),
			}),
		}
	}

	fn requests(&self) -> flume::Receiver<Value> {
		self.inner.requests_rx.clone()
	}

	fn respond(&self, id: &str, params: Map<String, Value>) -> bool {
		let Some(sender) = self.inner.state.lock().pending.remove(id) else {
			return false;
		};
		sender.try_send(params).is_ok()
	}

	fn close(&self) {
		let pending = {
			let mut state = self.inner.state.lock();
			state.closed = true;
			std::mem::take(&mut state.pending)
		};
		drop(pending);
	}
}

impl Default for RpcUiBridge {
	fn default() -> Self {
		Self::new()
	}
}

impl AskPresenter for RpcUiBridge {
	fn present<'p>(
		&'p self,
		questions: &'p [Question],
		invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, AskFault>> + Send + 'p>> {
		let bridge = self.clone();
		let questions = questions.to_vec();
		let invocation = invocation.map(str::to_owned);
		Box::pin(async move {
			let Some(invocation) = invocation else {
				return Err(AskFault::Presenter {
					message: Str::new_static("RPC UI ask requires a call identity"),
				});
			};
			let mut answers = Vec::with_capacity(questions.len());
			for (index, question) in questions.iter().enumerate() {
				let id = format!("{invocation}:{index}");
				let (reply_tx, reply_rx) = flume::bounded(1);
				{
					let mut state = bridge.inner.state.lock();
					if state.closed {
						return Err(AskFault::Presenter {
							message: Str::new_static("RPC UI host went away before showing ask"),
						});
					}
					state.pending.insert(id.clone(), reply_tx);
				}
				let pending = PendingUiReply { bridge: bridge.clone(), id: id.clone() };
				let options = question
					.options
					.iter()
					.map(|option| option.label.as_str())
					.collect::<Vec<_>>();
				let option_details = question
					.options
					.iter()
					.map(|option| {
						json!({
							"description": option.description,
							"preview": option.preview,
						})
					})
					.collect::<Vec<_>>();
				let request = json!({
					"type": "extension_ui_request",
					"id": id,
					"method": "select",
					"title": question.question,
					"header": question.header,
					"options": options,
					"optionDetails": option_details,
					"multi": question.multi,
					"recommended": question.recommended,
					"allowOther": true,
				});
				if bridge.inner.requests_tx.send_async(request).await.is_err() {
					return Err(AskFault::Presenter {
						message: Str::new_static("RPC UI host went away before showing ask"),
					});
				}
				let fields = reply_rx
					.recv_async()
					.await
					.map_err(|_| AskFault::Presenter {
						message: Str::new_static("RPC UI host went away before answering ask"),
					})?;
				drop(pending);
				if fields.get("cancelled").and_then(Value::as_bool) == Some(true) {
					return Err(AskFault::cancelled());
				}
				let selected = selected_values(&fields);
				if selected.iter().any(|selected| {
					!question
						.options
						.iter()
						.any(|option| option.label.as_str() == selected.as_str())
				}) {
					return Err(AskFault::Presenter {
						message: Str::new_static("RPC UI host returned an unknown ask option"),
					});
				}
				answers.push(Selection {
					id: question.id.clone(),
					selected,
					custom_input: fields
						.get("customInput")
						.and_then(Value::as_str)
						.map(Str::new),
					note: fields.get("note").and_then(Value::as_str).map(Str::new),
					timed_out: fields
						.get("timedOut")
						.and_then(Value::as_bool)
						.unwrap_or(false),
				});
			}
			Ok(Presentation { selections: answers })
		})
	}
}

fn selected_values(fields: &Map<String, Value>) -> Vec<Str> {
	if let Some(values) = fields.get("values").and_then(Value::as_array) {
		return values
			.iter()
			.filter_map(Value::as_str)
			.map(Str::new)
			.collect();
	}
	fields
		.get("value")
		.and_then(Value::as_str)
		.map_or_else(Vec::new, |value| vec![Str::new(value)])
}

enum Incoming {
	Request(RpcRequest),
	Error(Value),
	End { truncated: bool },
}

enum Outgoing {
	Frame(Value),
	Negotiated { frame: Value, protocol: u8 },
	Close,
}

#[derive(Clone)]
struct RpcRuntime {
	con:                  Option<Arc<omp_con::Ctx>>,
	catalog:              Option<Arc<omp_catalog::Catalog>>,
	model:                Str,
	model_cycle:          Vec<(Str, Str, Option<Str>)>,
	model_cycle_index:    usize,
	project:              PathBuf,
	session_name:         Option<Str>,
	automatic_compaction: bool,
	auto_retry:           bool,
	steering_mode:        Str,
	follow_up_mode:       Str,
	interrupt_mode:       Str,
	skills:               Option<Arc<omp_driver::discovery::skills::ActiveSkills>>,
}

impl RpcRuntime {
	fn detached<C: Inference>(_kernel: &Kernel<C>, session: &Session) -> Self {
		Self {
			con:                  None,
			catalog:              None,
			model:                Str::new_static(""),
			model_cycle:          Vec::new(),
			model_cycle_index:    0,
			project:              session
				.journal_path()
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.to_path_buf(),
			session_name:         None,
			automatic_compaction: true,
			auto_retry:           true,
			steering_mode:        Str::new_static("one-at-a-time"),
			follow_up_mode:       Str::new_static("one-at-a-time"),
			interrupt_mode:       Str::new_static("immediate"),
			skills:               None,
		}
	}
}

struct PendingHostCall {
	terminal: flume::Sender<Result<RuntimeHostToolResult, Str>>,
	updates:  HostToolUpdateSink,
}

#[derive(Clone)]
struct RpcHostToolBridge {
	outgoing: flume::Sender<Outgoing>,
	pending:  Arc<Mutex<HashMap<String, PendingHostCall>>>,
	closed:   Arc<Mutex<Option<Str>>>,
	next_id:  Arc<AtomicU64>,
}

impl RpcHostToolBridge {
	fn new(outgoing: flume::Sender<Outgoing>) -> Self {
		Self {
			outgoing,
			pending: Arc::new(Mutex::new(HashMap::new())),
			closed: Arc::new(Mutex::new(None)),
			next_id: Arc::new(AtomicU64::new(1)),
		}
	}

	fn handle_update(&self, params: &Map<String, Value>) -> bool {
		let Some(id) = params.get("id").and_then(Value::as_str) else {
			return false;
		};
		let Some(partial) = params.get("partialResult").cloned() else {
			return false;
		};
		self
			.pending
			.lock()
			.get(id)
			.is_some_and(|pending| pending.updates.send(partial).is_ok())
	}

	fn handle_result(&self, params: &Map<String, Value>) -> bool {
		let Some(id) = params.get("id").and_then(Value::as_str) else {
			return false;
		};
		let Some(result) = params.get("result").cloned() else {
			return false;
		};
		let Some(pending) = self.pending.lock().remove(id) else {
			return false;
		};
		pending
			.terminal
			.send(Ok(RuntimeHostToolResult {
				result,
				is_error: params
					.get("isError")
					.and_then(Value::as_bool)
					.unwrap_or(false),
			}))
			.is_ok()
	}

	fn close(&self, reason: &'static str) {
		let reason = Str::new_static(reason);
		*self.closed.lock() = Some(reason.clone());
		for (_, pending) in self.pending.lock().drain() {
			let _ = pending.terminal.send(Err(reason.clone()));
		}
	}
}

impl HostToolExecutor for RpcHostToolBridge {
	fn execute(
		&self,
		invocation: HostToolInvocation,
		updates: HostToolUpdateSink,
		cancellation: CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<RuntimeHostToolResult, Str>> + Send + 'static>> {
		let bridge = self.clone();
		Box::pin(async move {
			if let Some(reason) = bridge.closed.lock().clone() {
				return Err(reason);
			}
			let id = format!(
				"rpc-{}-{}",
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.unwrap_or_default()
					.as_millis(),
				bridge.next_id.fetch_add(1, Ordering::Relaxed)
			);
			let (terminal_tx, terminal_rx) = flume::bounded(1);
			bridge
				.pending
				.lock()
				.insert(id.clone(), PendingHostCall { terminal: terminal_tx, updates });
			if bridge
				.outgoing
				.send(Outgoing::Frame(json!({
					"type": "host_tool_call",
					"id": id,
					"toolCallId": invocation.tool_call_id,
					"toolName": invocation.name,
					"arguments": invocation.arguments,
				})))
				.is_err()
			{
				bridge.pending.lock().remove(&id);
				return Err(Str::new_static("RPC client disconnected before host tool execution"));
			}
			tokio::select! {
				result = terminal_rx.recv_async() => {
					result.unwrap_or_else(|_| Err(Str::new_static("RPC host tool response channel closed")))
				},
				() = cancellation.cancelled() => {
					bridge.pending.lock().remove(&id);
					let cancel_id = bridge.next_id.fetch_add(1, Ordering::Relaxed);
					let _ = bridge.outgoing.send(Outgoing::Frame(json!({
						"type": "host_tool_cancel",
						"id": format!("rpc-cancel-{cancel_id}"),
						"targetId": id,
					})));
					Err(Str::new_static("host tool execution was aborted"))
				},
			}
		})
	}
}

#[derive(Default)]
struct RpcAssistantState {
	text:     String,
	thinking: String,
	started:  bool,
	ended:    bool,
}

#[derive(Default)]
struct RpcToolState {
	update:  String,
	started: bool,
	ended:   bool,
}

#[derive(Default)]
struct RpcEventProjection {
	users:      HashSet<String>,
	assistants: HashMap<String, RpcAssistantState>,
	tools:      HashMap<String, RpcToolState>,
	/// Journaled operator notices already forwarded.
	notices:    HashSet<String>,
}

impl RpcEventProjection {
	fn reset(&mut self) {
		*self = Self::default();
	}

	fn observe(&mut self, dom: &Dom) -> Vec<Value> {
		let mut events = Vec::new();
		for turn in dom.children(dom.body()) {
			for handle in dom.children(*turn) {
				let Some(node) = dom.get(*handle) else {
					continue;
				};
				let key = handle.to_string();
				match &node.tag {
					Tag::Known(KnownTag::User) => {
						if self.users.insert(key) {
							let message = rpc_user_message(dom, *handle, node);
							events.push(json!({ "type": "message_start", "message": message }));
							events.push(json!({ "type": "message_end", "message": message }));
						}
					},
					Tag::Known(KnownTag::Assistant) => {
						let message = rpc_assistant_message(dom, *handle, node);
						let (text, thinking) = assistant_text(dom, *handle);
						let state = self.assistants.entry(key).or_default();
						if !state.started {
							state.started = true;
							events.push(json!({ "type": "message_start", "message": message }));
						}
						if let Some(delta) = text
							.strip_prefix(&state.text)
							.filter(|delta| !delta.is_empty())
						{
							events.push(json!({
								"type": "message_update",
								"message": message,
								"assistantMessageEvent": {
									"type": "text_delta",
									"contentIndex": usize::from(!thinking.is_empty()),
									"delta": delta,
									"partial": message,
								},
							}));
						}
						if let Some(delta) = thinking
							.strip_prefix(&state.thinking)
							.filter(|delta| !delta.is_empty())
						{
							events.push(json!({
								"type": "message_update",
								"message": message,
								"assistantMessageEvent": {
									"type": "thinking_delta",
									"contentIndex": 0,
									"delta": delta,
									"partial": message,
								},
							}));
						}
						state.text = text;
						state.thinking = thinking;
						let ended = prop(node, PropId::StopReason).is_some();
						if ended && !state.ended {
							state.ended = true;
							events.push(json!({ "type": "message_end", "message": message }));
						}
					},
					Tag::Known(KnownTag::Notice)
						if matches!(
							node
								.prop(&PropKey::Custom(Str::new_static("name")))
								.and_then(DomValue::as_str),
							Some(omp_agent::ACCOUNT_PIN_NOTICE | WITHHELD_NOTICE)
						) =>
					{
						if self.notices.insert(key) {
							events.push(json!({
								"type": "notice",
								"level": if prop(node, PropId::Kind) == Some("error") { "error" } else { "warning" },
								"message": node.content.as_deref().unwrap_or_default(),
								"source": node.prop(&PropKey::Custom(Str::new_static("name"))).and_then(DomValue::as_str),
								"data": node.prop(&PropKey::from(PropId::Data)).and_then(|value| {
									if let DomValue::Json(raw) = value {
										serde_json::from_str::<Value>(raw.get()).ok()
									} else {
										None
									}
								}),
							}));
						}
					},
					Tag::Custom(name) => {
						let id = prop(node, PropId::Id).unwrap_or_default();
						if id.is_empty() {
							continue;
						}
						let args = tool_args(dom, *handle);
						let status = prop(node, PropId::Status).unwrap_or("running");
						let result = tool_result(dom, *handle, status);
						let state = self.tools.entry(id.to_owned()).or_default();
						if !state.started {
							state.started = true;
							events.push(json!({
								"type": "tool_execution_start",
								"toolCallId": id,
								"toolName": name,
								"args": args,
								"intent": prop(node, PropId::I),
							}));
						}
						let update = serde_json::to_string(&result).unwrap_or_default();
						if !update.is_empty()
							&& update != "null"
							&& update != state.update
							&& !state.ended
						{
							events.push(json!({
								"type": "tool_execution_update",
								"toolCallId": id,
								"toolName": name,
								"args": args,
								"partialResult": result,
							}));
							state.update = update;
						}
						if matches!(status, "ok" | "error" | "aborted" | "cancelled") && !state.ended {
							state.ended = true;
							events.push(json!({
								"type": "tool_execution_end",
								"toolCallId": id,
								"toolName": name,
								"result": result,
								"isError": status != "ok",
							}));
						}
					},
					_ => {},
				}
			}
		}
		events
	}
}

fn prop(node: &Node, id: PropId) -> Option<&str> {
	node.prop(&PropKey::from(id)).and_then(DomValue::as_str)
}

fn node_text<'a>(dom: &'a Dom, handle: Handle, node: &'a Node) -> Option<&'a str> {
	node
		.content
		.as_deref()
		.or_else(|| dom.stream_text(handle, &PropId::Text.into()))
		.or_else(|| prop(node, PropId::Text))
}

fn assistant_text(dom: &Dom, assistant: Handle) -> (String, String) {
	let mut text = String::new();
	let mut thinking = String::new();
	for handle in dom.children(assistant) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		let Tag::Custom(tag) = &node.tag else {
			continue;
		};
		if tag.as_str() != omp_session::ASSISTANT_CONTENT_TAG {
			continue;
		}
		let Some(value) = node_text(dom, *handle, node) else {
			continue;
		};
		match prop(node, PropId::Kind) {
			Some("text") => text.push_str(value),
			Some("thinking") => thinking.push_str(value),
			_ => {},
		}
	}
	if text.is_empty() {
		text
			.push_str(prop(dom.get(assistant).expect("assistant exists"), PropId::Text).unwrap_or(""));
	}
	if thinking.is_empty() {
		thinking.push_str(
			prop(dom.get(assistant).expect("assistant exists"), PropId::Thinking).unwrap_or(""),
		);
	}
	(text, thinking)
}

fn rpc_user_message(dom: &Dom, handle: Handle, node: &Node) -> Value {
	let text = node_text(dom, handle, node).unwrap_or_default();
	json!({ "role": "user", "content": text })
}

fn rpc_assistant_message(dom: &Dom, handle: Handle, node: &Node) -> Value {
	let (text, thinking) = assistant_text(dom, handle);
	let mut content = Vec::new();
	if !thinking.is_empty() {
		content.push(json!({ "type": "thinking", "thinking": thinking }));
	}
	if !text.is_empty() {
		content.push(json!({ "type": "text", "text": text }));
	}
	if let Some(turn) = dom.parent(handle) {
		let mut after_assistant = false;
		for sibling in dom.children(turn) {
			if *sibling == handle {
				after_assistant = true;
				continue;
			}
			if !after_assistant {
				continue;
			}
			let Some(tool) = dom.get(*sibling) else {
				continue;
			};
			if tool.tag == Tag::Known(KnownTag::Assistant) {
				break;
			}
			let Tag::Custom(name) = &tool.tag else {
				continue;
			};
			let Some(id) = prop(tool, PropId::Id) else {
				continue;
			};
			content.push(json!({
				"type": "toolCall",
				"id": id,
				"name": name,
				"arguments": tool_args(dom, *sibling),
				"intent": prop(tool, PropId::I),
			}));
		}
	}
	json!({
		"role": "assistant",
		"content": content,
		"provider": prop(node, PropId::Provider),
		"model": prop(node, PropId::Model),
		"stopReason": prop(node, PropId::StopReason),
	})
}

fn child(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<(Handle, &Node)> {
	dom.children(parent).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(tag)).then_some((*handle, node))
	})
}

fn tool_args(dom: &Dom, tool: Handle) -> Value {
	let Some((handle, node)) = child(dom, tool, KnownTag::Input) else {
		return Value::Object(Map::new());
	};
	let Some(text) = node_text(dom, handle, node) else {
		return Value::Object(Map::new());
	};
	serde_json::from_str(text).unwrap_or_else(|_| json!({ "raw": text }))
}

fn tool_result(dom: &Dom, tool: Handle, status: &str) -> Value {
	let tag = if status == "error" {
		KnownTag::Diag
	} else {
		KnownTag::Result
	};
	let Some((handle, node)) = child(dom, tool, tag) else {
		return Value::Null;
	};
	if let Some(DomValue::Json(raw)) = node.prop(&PropKey::from(PropId::Outcome)) {
		return serde_json::from_str(raw.get()).unwrap_or(Value::Null);
	}
	node_text(dom, handle, node).map_or(Value::Null, |text| {
		serde_json::from_str(text).unwrap_or_else(|_| {
			json!({
				"content": [{ "type": "text", "text": text }],
			})
		})
	})
}

fn rpc_tool_results(dom: &Dom, turn: Handle) -> Vec<Value> {
	dom.children(turn)
		.iter()
		.filter_map(|handle| {
			let node = dom.get(*handle)?;
			let Tag::Custom(name) = &node.tag else {
				return None;
			};
			let id = prop(node, PropId::Id)?;
			let status = prop(node, PropId::Status).unwrap_or("running");
			matches!(status, "ok" | "error" | "aborted" | "cancelled").then(|| {
				json!({
					"role": "toolResult",
					"toolCallId": id,
					"toolName": name,
					"content": tool_result(dom, *handle, status)
						.get("content")
						.cloned()
						.unwrap_or_else(|| vec![json!({
							"type": "text",
							"text": tool_result(dom, *handle, status).to_string(),
						})].into()),
					"isError": status != "ok",
				})
			})
		})
		.collect()
}

fn append_rpc_turn_messages(dom: &Dom, turn: Handle, messages: &mut Vec<Value>) {
	for handle in dom.children(turn) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		match &node.tag {
			Tag::Known(KnownTag::User) => messages.push(rpc_user_message(dom, *handle, node)),
			Tag::Known(KnownTag::Assistant) => {
				messages.push(rpc_assistant_message(dom, *handle, node));
			},
			Tag::Custom(name) => {
				let Some(id) = prop(node, PropId::Id) else {
					continue;
				};
				let status = prop(node, PropId::Status).unwrap_or("running");
				if matches!(status, "ok" | "error" | "aborted" | "cancelled") {
					messages.push(json!({
						"role": "toolResult",
						"toolCallId": id,
						"toolName": name,
						"content": tool_result(dom, *handle, status)
							.get("content")
							.cloned()
							.unwrap_or_else(|| vec![json!({
								"type": "text",
								"text": tool_result(dom, *handle, status).to_string(),
							})].into()),
						"isError": status != "ok",
					}));
				}
			},
			_ => {},
		}
	}
}

fn rpc_turn_messages(dom: &Dom, turn: Handle) -> Vec<Value> {
	let mut messages = Vec::new();
	append_rpc_turn_messages(dom, turn, &mut messages);
	messages
}

fn rpc_messages(dom: &Dom) -> Vec<Value> {
	let mut messages = Vec::new();
	for turn in dom.children(dom.body()) {
		append_rpc_turn_messages(dom, *turn, &mut messages);
	}
	messages
}

fn con_value(runtime: &RpcRuntime, name: &str) -> Option<omp_con::Value> {
	runtime.con.as_ref().and_then(|con| con.get(name))
}

fn con_bool(runtime: &RpcRuntime, name: &str, fallback: bool) -> bool {
	match con_value(runtime, name) {
		Some(omp_con::Value::Bool(value)) => value,
		_ => fallback,
	}
}

fn con_text(runtime: &RpcRuntime, name: &str) -> Option<Str> {
	match con_value(runtime, name) {
		Some(omp_con::Value::Str(value)) => Some(value),
		_ => None,
	}
}

fn set_con(runtime: &RpcRuntime, name: &str, value: omp_con::Value) -> Result<(), String> {
	let Some(con) = &runtime.con else {
		return Err("RPC control plane is unavailable".into());
	};
	con.set(name, value, omp_con::Origin::Session)
		.map(|_| ())
		.map_err(|error| crate::fault(error).into())
}

fn known_thinking_level(level: &str) -> bool {
	matches!(omp_agent::AI_THINKING.spec().hint, omp_con::Hint::Suggest(levels) if levels.contains(&level))
}

fn todo_phases(dom: &Dom) -> Vec<Value> {
	let Some(todo) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
	}) else {
		return Vec::new();
	};
	let mut phases = Vec::<(String, Vec<Value>)>::new();
	for handle in dom.children(todo) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Item) {
			continue;
		}
		let phase = node
			.prop(&PropKey::Custom(Str::new_static("phase")))
			.and_then(DomValue::as_str)
			.unwrap_or("")
			.to_owned();
		let item = json!({
			"text": prop(node, PropId::Label).unwrap_or_default(),
			"status": prop(node, PropId::Status).unwrap_or("pending"),
			"reason": prop(node, PropId::Detail),
		});
		if let Some((_, items)) = phases.iter_mut().find(|(name, _)| *name == phase) {
			items.push(item);
		} else {
			phases.push((phase, vec![item]));
		}
	}
	phases
		.into_iter()
		.map(|(phase, items)| json!({ "phase": phase, "items": items }))
		.collect()
}

fn rename_session(session: &mut Session, title: Str) -> Result<(), String> {
	let cause = session
		.head()
		.ok_or_else(|| "session has no journal head".to_owned())?;
	session
		.patch(Txn {
			cause,
			label: Some(Str::new_static("session.rename")),
			ops: vec![Op::Set {
				h:     session.dom().meta(),
				prop:  PropId::Name.into(),
				value: DomValue::Str(title),
			}],
		})
		.map(|_| ())
		.map_err(|error| crate::fault(error).into())
}

fn replace_todos(session: &mut Session, phases: &[Value]) -> Result<(), String> {
	let Some(cause) = session.head() else {
		return Err("session has no journal head".into());
	};
	let dom = session.dom();
	let Some(todo) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
	}) else {
		return Err("session has no todo component".into());
	};
	let mut ops = dom
		.children(todo)
		.iter()
		.copied()
		.map(Op::Rm)
		.collect::<Vec<_>>();
	let mut after = None;
	let mut next_handle = dom.high_water().saturating_add(1);
	for phase in phases {
		let phase_name = phase.get("phase").and_then(Value::as_str).unwrap_or("");
		for item in phase
			.get("items")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let mut node = NodeSpec::new(KnownTag::Item)
				.with_prop(
					PropId::Label,
					DomValue::Str(Str::new(item.get("text").and_then(Value::as_str).unwrap_or(""))),
				)
				.with_prop(
					PropId::Status,
					DomValue::Str(Str::new(
						item
							.get("status")
							.and_then(Value::as_str)
							.unwrap_or("pending"),
					)),
				)
				.with_prop(
					PropKey::Custom(Str::new_static("phase")),
					DomValue::Str(Str::new(phase_name)),
				);
			if let Some(reason) = item.get("reason").and_then(Value::as_str) {
				node = node.with_prop(PropId::Detail, DomValue::Str(Str::new(reason)));
			}
			ops.push(Op::Ins { parent: todo, after, node });
			after = Handle::new(next_handle);
			next_handle = next_handle.saturating_add(1);
		}
	}
	session
		.patch(Txn { cause, label: Some(Str::new_static("rpc.set_todos")), ops })
		.map(|_| ())
		.map_err(|error| crate::fault(error).into())
}

fn rpc_models(runtime: &RpcRuntime) -> Vec<Value> {
	runtime
		.catalog
		.as_ref()
		.map(|catalog| {
			catalog
				.models()
				.iter()
				.map(|model| {
					let key = model.key.as_str();
					let (provider, id) = key.split_once('/').unwrap_or(("", key));
					json!({
						"id": id,
						"name": model.display_name,
						"provider": provider,
						"contextWindow": model.limits.context_window,
						"maxTokens": model.limits.maximum_output_tokens,
						"reasoning": model.thinking.is_some(),
					})
				})
				.collect()
		})
		.unwrap_or_default()
}

fn available_commands(runtime: &RpcRuntime) -> Vec<Value> {
	let mut commands = Vec::new();
	if let Some(con) = &runtime.con {
		for item in con.items() {
			if let omp_con::RegItem::Cmd(spec) = item {
				let name = spec
					.name
					.strip_prefix("cl_")
					.or_else(|| spec.name.strip_prefix("app."))
					.unwrap_or(spec.name)
					.replace('_', "-");
				commands.push(json!({
					"name": name,
					"description": spec.desc,
					"source": "builtin",
				}));
			}
		}
		for (name, description) in con.dynamic_cmds() {
			commands.push(json!({
				"name": name,
				"description": description,
				"source": "extension",
			}));
		}
	}
	commands.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
	commands
}

fn queued_prompt_count(dom: &Dom) -> usize {
	omp_session::components::prompts::prompts_handle(dom).map_or(0, |prompts| {
		dom.children(prompts)
			.iter()
			.filter(|handle| {
				dom.get(**handle)
					.and_then(|node| node.prop(&PropKey::from(PropId::Status)))
					.and_then(DomValue::as_str)
					== Some("queued")
			})
			.count()
	})
}

fn rpc_state(
	runtime: &RpcRuntime,
	dom: &Dom,
	registry: &omp_tool::Registry,
	streaming: bool,
	session_file: &Path,
) -> Value {
	let messages = rpc_messages(dom);
	let model_key = con_text(runtime, "ai_model").unwrap_or_else(|| runtime.model.clone());
	let (provider, model_id) = model_key
		.split_once('/')
		.unwrap_or(("", model_key.as_str()));
	let thinking = con_text(runtime, "ai_thinking");
	let fast = con_bool(runtime, "ai_fastmode", false);
	let session_id = session_file
		.file_stem()
		.and_then(|stem| stem.to_str())
		.unwrap_or("session");
	json!({
		"model": {
			"id": model_id,
			"name": model_id,
			"provider": provider,
		},
		"thinkingLevel": thinking,
		"isStreaming": streaming,
		"isCompacting": false,
		"steeringMode": runtime.steering_mode,
		"followUpMode": runtime.follow_up_mode,
		"interruptMode": runtime.interrupt_mode,
		"sessionFile": session_file,
		"sessionId": session_id,
		"sessionName": dom.get(dom.meta()).and_then(|meta| prop(meta, PropId::Name)).map(Str::new)
			.or_else(|| runtime.session_name.clone()),
		"autoCompactionEnabled": runtime.automatic_compaction,
		"autoRetryEnabled": runtime.auto_retry,
		"fastModeEnabled": fast,
		"fastModeActive": fast,
		"tokensPerSecond": Value::Null,
		"messageCount": messages.len(),
		"queuedMessageCount": queued_prompt_count(dom),
		"todoPhases": todo_phases(dom),
		"dumpTools": registry.host_tool_specs().into_iter().map(|tool| json!({
			"name": tool.name,
			"description": tool.description,
			"parameters": tool.parameters,
		})).collect::<Vec<_>>(),
	})
}

fn rpc_subagents(jobs: &omp_agent::JobBoard) -> Vec<Value> {
	let mut snapshots = jobs
		.list()
		.into_iter()
		.filter(|job| job.kind == omp_agent::JobKind::Subagent)
		.enumerate()
		.map(|(index, job)| {
			json!({
				"id": job.id,
				"index": index,
				"agent": job.job_type,
				"agentSource": "configured",
				"description": job.label,
				"status": job.status,
				"lastUpdate": 0,
			})
		})
		.collect::<Vec<_>>();
	snapshots.sort_by(|left, right| left["index"].as_u64().cmp(&right["index"].as_u64()));
	snapshots
}

fn observe_subagents(
	jobs: &omp_agent::JobBoard,
	level: omp_rpc::protocol::SubscriptionLevel,
	seen: &mut HashMap<String, Value>,
) -> Vec<Value> {
	let snapshots = rpc_subagents(jobs);
	let current = snapshots
		.iter()
		.filter_map(|snapshot| {
			snapshot
				.get("id")
				.and_then(Value::as_str)
				.map(|id| (id.to_owned(), snapshot.clone()))
		})
		.collect::<HashMap<_, _>>();
	let mut events = Vec::new();
	if level != omp_rpc::protocol::SubscriptionLevel::Off {
		for (id, snapshot) in &current {
			let status = snapshot
				.get("status")
				.and_then(Value::as_str)
				.unwrap_or("running");
			match seen.get(id) {
				None => events.push(json!({
					"type": "subagent_lifecycle",
					"payload": {
						"id": id,
						"index": snapshot["index"],
						"agent": snapshot["agent"],
						"agentSource": snapshot["agentSource"],
						"description": snapshot["description"],
						"status": if matches!(status, "running" | "starting") { "started" } else { status },
					},
				})),
				Some(previous) if previous != snapshot => {
					if !matches!(status, "running" | "starting") {
						events.push(json!({
							"type": "subagent_lifecycle",
							"payload": {
								"id": id,
								"index": snapshot["index"],
								"agent": snapshot["agent"],
								"agentSource": snapshot["agentSource"],
								"description": snapshot["description"],
								"status": status,
							},
						}));
					} else {
						events.push(json!({
							"type": "subagent_progress",
							"payload": {
								"id": id,
								"index": snapshot["index"],
								"agent": snapshot["agent"],
								"agentSource": snapshot["agentSource"],
								"description": snapshot["description"],
								"progress": snapshot,
							},
						}));
					}
				},
				_ => {},
			}
		}
	}
	*seen = current;
	events
}

fn safe_session_name(value: &str) -> String {
	value
		.chars()
		.map(|ch| {
			if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
				ch
			} else {
				'_'
			}
		})
		.collect()
}

fn model_value(runtime: &RpcRuntime, key: &str) -> Value {
	if let Some(model) = runtime.catalog.as_ref().and_then(|catalog| {
		catalog
			.models()
			.iter()
			.find(|model| model.key.as_str() == key)
	}) {
		let (provider, id) = key.split_once('/').unwrap_or(("", key));
		return json!({
			"id": id,
			"name": model.display_name,
			"provider": provider,
			"contextWindow": model.limits.context_window,
			"maxTokens": model.limits.maximum_output_tokens,
			"reasoning": model.thinking.is_some(),
		});
	}
	let (provider, id) = key.split_once('/').unwrap_or(("", key));
	json!({ "id": id, "name": id, "provider": provider })
}

fn branch_messages(dom: &Dom) -> Vec<Value> {
	let mut messages = Vec::new();
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::User) {
				continue;
			}
			messages.push(json!({
				"entryId": prop(node, PropId::Order).or_else(|| prop(node, PropId::Cause)).unwrap_or_default(),
				"text": node_text(dom, *handle, node).unwrap_or_default(),
			}));
		}
	}
	messages
}

fn last_assistant_text(dom: &Dom) -> Option<String> {
	for turn in dom.children(dom.body()).iter().rev() {
		for handle in dom.children(*turn).iter().rev() {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.tag == Tag::Known(KnownTag::Assistant) {
				return Some(assistant_text(dom, *handle).0);
			}
		}
	}
	None
}

enum RpcTurnInput {
	Plain(TurnInput),
	Skill(omp_journal::data::SkillPrompt),
}

/// Which request a spawned run answers once it hands the kernel back.
enum RunOrigin {
	/// A model turn (`prompt`, `follow_up`, `abort_and_prompt`, a popped
	/// follow-up): settles with `turn_end` and one terminal `agent_end`.
	Turn,
	/// One RPC `bash` request run through [`Kernel::run_local`]: settles with
	/// that request's response.
	Bash {
		/// Request the settled run answers.
		id:      Option<RequestId>,
		/// Fallback clock when the run settles without a host status.
		started: Instant,
	},
}

/// What a spawned run hands back: the kernel and session it borrowed, the
/// run's result, and the request it answers.
struct TurnCompletion<C> {
	kernel:  Kernel<C>,
	session: Session,
	result:  Result<TurnOutcome, KernelError>,
	origin:  RunOrigin,
}

/// Moves the idle kernel and session into a spawned turn (`prompt`, an idle
/// `follow_up`, `abort_and_prompt`, and the follow-up pop after a turn all
/// start turns through this one path) and announces `turn_start`.
fn start_turn<C>(
	current: &mut Option<(Kernel<C>, Session)>,
	turn_tx: &flume::Sender<TurnCompletion<C>>,
	outgoing_tx: &flume::Sender<Outgoing>,
	input: RpcTurnInput,
) -> miette::Result<()>
where
	C: Inference + Send + Sync + 'static,
{
	let (mut kernel, mut session) = current.take().expect("idle RPC owns kernel and session");
	let turn_tx = turn_tx.clone();
	drop(tokio::spawn(async move {
		let result = match input {
			RpcTurnInput::Plain(input) => {
				kernel
					.run_turn(&mut session, input, RunControl::default())
					.await
			},
			RpcTurnInput::Skill(prompt) => {
				kernel
					.run_skill_turn(&mut session, prompt, RunControl::default())
					.await
			},
		};
		let _ = turn_tx
			.send_async(TurnCompletion { kernel, session, result, origin: RunOrigin::Turn })
			.await;
	}));
	outgoing_tx
		.send(Outgoing::Frame(json!({ "type": "agent_start" })))
		.into_diagnostic()?;
	outgoing_tx
		.send(Outgoing::Frame(json!({ "type": "turn_start" })))
		.into_diagnostic()
}

/// Moves the idle kernel and session into one RPC `bash` run.
///
/// The command is the interactive `!` prefix's user-local run
/// ([`Kernel::run_local`]): it resolves the registry's `bash` tool, so the
/// project environment's admission policy and sandbox, the persistent session
/// shell (cwd, exports), the kernel's turn cancellation tree (`abort_bash`),
/// and the dispatcher's single central output bound apply exactly as they do
/// to a model-issued call. The run is journaled as a local-run element whose
/// output joins the model context, like pi's `bashExecution` message.
fn start_bash<C>(
	current: &mut Option<(Kernel<C>, Session)>,
	turn_tx: &flume::Sender<TurnCompletion<C>>,
	id: Option<RequestId>,
	command: Str,
) where
	C: Inference + Send + Sync + 'static,
{
	let (mut kernel, mut session) = current.take().expect("idle RPC owns kernel and session");
	let turn_tx = turn_tx.clone();
	let started = Instant::now();
	drop(tokio::spawn(async move {
		let run = LocalRun { kind: LocalRunKind::Bash, input: command, exclude: false };
		let result = kernel
			.run_local(&mut session, run, RunControl::default())
			.await;
		let _ = turn_tx
			.send_async(TurnCompletion {
				kernel,
				session,
				result,
				origin: RunOrigin::Bash { id, started },
			})
			.await;
	}));
}

/// The settled user-local `bash` element of the session's last turn.
fn local_bash_element(dom: &Dom) -> Option<(Handle, &Node)> {
	let turn = *dom.children(dom.body()).last()?;
	dom.children(turn).iter().rev().find_map(|handle| {
		let node = dom.get(*handle)?;
		let local = node
			.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_PRESENTATION_PROP)))
			.and_then(DomValue::as_str)
			== Some(omp_agent::LOCAL_PRESENTATION_VALUE);
		let bash = node
			.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_KIND_PROP)))
			.and_then(DomValue::as_str)
			== Some(<&'static str>::from(LocalRunKind::Bash));
		(local && bash).then_some((*handle, node))
	})
}

/// The `artifact://` address the dispatcher's single output bound recorded
/// for a call (`<diag kind=output_bounded>`, ADR 0009), if it bounded one.
fn bounded_artifact(dom: &Dom, call: Handle) -> Option<&str> {
	let bounded: &'static str = omp_tool::DiagKind::OutputBounded.into();
	dom.children(call).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(KnownTag::Diag) && prop(node, PropId::Kind) == Some(bounded))
			.then(|| prop(node, PropId::Recovery))
			.flatten()
	})
}

/// Durable call outcome of the `bash` tool.
/// Lowers a host tool's declared wire envelope into the registry's effect
/// envelope. The only invalid input is a spend that is not decimal USD.
fn host_tool_effects(
	effects: omp_rpc::protocol::HostToolEffects,
) -> Result<omp_tool::Effects, omp_tool::UsdParseError> {
	let inference = effects
		.inference
		.map(|inference| {
			Ok::<_, omp_tool::UsdParseError>(omp_tool::InferenceEffects {
				max_requests: inference.max_requests,
				max_usd:      inference
					.max_usd
					.as_deref()
					.map(str::parse)
					.transpose()?
					.unwrap_or_default(),
			})
		})
		.transpose()?;
	Ok(omp_tool::Effects {
		documents: effects.documents.map(|documents| omp_tool::DocEffects {
			read:        documents.read,
			write_globs: documents.write_globs.into_iter().map(Str::from).collect(),
		}),
		exec: effects.exec.map(|exec| omp_tool::ExecEffects {
			commands: exec.commands.into_iter().map(Str::from).collect(),
			network:  exec.network,
		}),
		inference,
		desktop: effects.desktop.map(|desktop| omp_tool::DesktopEffects {
			capture:       desktop.capture,
			accessibility: desktop.accessibility,
			clipboard:     desktop.clipboard,
			input:         desktop.input,
		}),
		fetch: effects
			.fetch
			.map(|fetch| omp_tool::FetchEffects { credentials: fetch.credentials }),
		subagents: effects.subagents,
	})
}

type BashOutcome = omp_tool::CallOutcome<shell::Payload, shell::Fault>;

/// Decodes the journaled `bash` call outcome. An outcome the dispatcher moved
/// into the session CAS (`CallOutcomeDetails::Spilled`) is read back: it is
/// the environment's already-bounded verdict, never the raw output stream.
fn bash_outcome(raw: &str, blobs: &omp_journal::blob::BlobStore) -> Option<BashOutcome> {
	match serde_json::from_str::<omp_tool::CallOutcomeDetails>(raw) {
		Ok(omp_tool::CallOutcomeDetails::Inline { json }) => serde_json::from_slice(&json).ok(),
		Ok(omp_tool::CallOutcomeDetails::Spilled { blob, byte_len }) => {
			if byte_len > omp_agent::DispatchPolicy::MAX_COMPLETE_OUTPUT_BYTES as u64 {
				return None;
			}
			let reference =
				omp_journal::blob::BlobRef::parse_hex(blob.hash.as_str(), byte_len).ok()?;
			serde_json::from_slice(&blobs.get(&reference).ok()?).ok()
		},
		Err(_) => serde_json::from_str(raw).ok(),
	}
}

/// Answers one settled RPC `bash` run from its journaled local-run element.
///
/// Response data (v1-compatible; clients ignore unknown keys): `stdout`,
/// `stderr` (per channel; a PTY run reports on `stdout`), `exitCode`,
/// `cancelled`, `truncated`, `durationMs`, plus `output` (both channels in
/// host order, pi's `BashResult.output`) and `artifactId` — the
/// `artifact://sha256/<hex>` address of the complete output, present exactly
/// when `truncated` is true. A command refused before it started (approval
/// policy, hooks, a denied prompt) or denied by the environment sandbox
/// answers with error code `policy_denied`.
fn bash_response(
	id: Option<RequestId>,
	session: &Session,
	result: Result<TurnOutcome, KernelError>,
	started: Instant,
) -> miette::Result<RpcResponse> {
	const COMMAND: &str = "bash";
	let error = |id, message: &str, code: &str| {
		Ok(RpcResponse::error(id, COMMAND, message, Some(RpcErrorCode::new(code))))
	};
	if let Err(source) = result {
		return error(id, &crate::fault(source), BASH_ERROR);
	}
	let dom = session.dom();
	let Some((handle, _)) = local_bash_element(dom) else {
		return error(id, "the bash run settled without a journaled result", BASH_ERROR);
	};
	// A settled call carries its outcome on `<result>`; a failed one on the
	// fault `<diag>` (ADR 0008).
	let raw = child(dom, handle, KnownTag::Result)
		.and_then(|(_, result)| result.prop(&PropKey::from(PropId::Outcome)))
		.or_else(|| {
			dom.children(handle)
				.iter()
				.rev()
				.find_map(|handle| dom.get(*handle)?.prop(&PropKey::from(PropId::Fault)))
		})
		.and_then(|value| match value {
			DomValue::Json(raw) => Some(raw.get()),
			_ => None,
		});
	let payload = match raw.and_then(|raw| bash_outcome(raw, session.blobs())) {
		Some(omp_tool::CallOutcome::Ok(payload)) => payload,
		Some(omp_tool::CallOutcome::Faulted(shell::Fault::CommandFailed { payload })) => *payload,
		Some(omp_tool::CallOutcome::Aborted { kind: omp_tool::AbortKind::Cancelled, .. }) => {
			return RpcResponse::success(
				id,
				COMMAND,
				json!({
					"stdout": "",
					"stderr": "",
					"output": "",
					"exitCode": Value::Null,
					"cancelled": true,
					"truncated": false,
					"durationMs": started.elapsed().as_millis(),
				}),
			)
			.into_diagnostic();
		},
		Some(omp_tool::CallOutcome::Aborted { abort, policy, .. }) => {
			let reason = policy.map_or_else(|| abort.render(), |policy| policy.reason);
			return error(id, &reason, POLICY_DENIED);
		},
		Some(omp_tool::CallOutcome::Faulted(fault)) => {
			return error(id, &fault.message(), BASH_ERROR);
		},
		Some(omp_tool::CallOutcome::ArgsRejected(_)) | None => {
			return error(id, "the bash run settled without a shell result", BASH_ERROR);
		},
	};
	let mut stdout = Vec::new();
	let mut stderr = Vec::new();
	let mut output = Vec::new();
	for frame in &payload.transcript {
		match frame.channel {
			shell::OutputChannel::Stdout | shell::OutputChannel::Pty => {
				stdout.extend_from_slice(&frame.data);
			},
			shell::OutputChannel::Stderr => stderr.extend_from_slice(&frame.data),
		}
		output.extend_from_slice(&frame.data);
	}
	if payload.status.outcome == shell::ExecOutcome::Denied {
		let reason = String::from_utf8_lossy(&stderr);
		let reason = reason.trim();
		return error(
			id,
			if reason.is_empty() {
				"bash command denied by environment policy"
			} else {
				reason
			},
			POLICY_DENIED,
		);
	}
	let artifact = bounded_artifact(dom, handle)
		.map(str::to_owned)
		.or_else(|| {
			payload
				.status
				.spilled_output
				.as_ref()
				.map(|blob| format!("artifact://sha256/{}", blob.hash))
		});
	let mut data = json!({
		"stdout": String::from_utf8_lossy(&stdout),
		"stderr": String::from_utf8_lossy(&stderr),
		"output": String::from_utf8_lossy(&output),
		"exitCode": payload.status.exit_code,
		"cancelled": payload.status.aborted || payload.status.outcome == shell::ExecOutcome::Cancelled,
		"truncated": artifact.is_some(),
		"durationMs": payload.status.wall_clock_ms,
	});
	if let Some(artifact) = artifact {
		data["artifactId"] = Value::String(artifact);
	}
	RpcResponse::success(id, COMMAND, data).into_diagnostic()
}

/// The document of the newest handoff compaction (`<compaction
/// method=handoff>`), without its legacy `<handoff-context>` wrapper.
fn handoff_document(dom: &Dom) -> Option<String> {
	dom.children(dom.meta()).iter().rev().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(KnownTag::Compaction)
			&& prop(node, PropId::Method) == Some("handoff"))
		.then(|| prop(node, PropId::Summary))
		.flatten()
		.map(|summary| omp_session::custom_message::extract_handoff_document(summary).to_owned())
	})
}

/// Error code for a `bash` run that failed outside the command itself.
const BASH_ERROR: &str = "bash_error";
/// Error code for a `bash` run the environment's policy refused.
const POLICY_DENIED: &str = "policy_denied";

/// Serves RPC over caller-provided transport halves.
///
/// Exposed for joined scripted-kernel transport proofs. Production passes
/// stdio and a [`SessionHome`]; tests pass an in-memory duplex stream through
/// this exact path.
#[doc(hidden)]
pub async fn serve_rpc<C, R, W>(
	kernel: Kernel<C>,
	session: Session,
	home: SessionHome,
	ui: Option<RpcUiBridge>,
	input: R,
	output: W,
) -> miette::Result<()>
where
	C: Inference + Send + Sync + 'static,
	R: AsyncRead + Unpin + Send + 'static,
	W: AsyncWrite + Unpin + Send + 'static,
{
	let runtime = RpcRuntime::detached(&kernel, &session);
	serve_rpc_with_runtime(kernel, session, home, ui, runtime, input, output, true).await
}

async fn serve_rpc_with_runtime<C, R, W>(
	mut kernel: Kernel<C>,
	mut session: Session,
	home: SessionHome,
	ui: Option<RpcUiBridge>,
	mut runtime: RpcRuntime,
	mut input: R,
	mut output: W,
	send_ready: bool,
) -> miette::Result<()>
where
	C: Inference + Send + Sync + 'static,
	R: AsyncRead + Unpin + Send + 'static,
	W: AsyncWrite + Unpin + Send + 'static,
{
	if let Some(lifecycle) = kernel.lifecycle_hooks() {
		lifecycle
			.session_start(&omp_agent::SessionStart::launch(&session, &home.project_root))
			.await
			.into_diagnostic()?;
	}
	let (outgoing_tx, outgoing_rx) = flume::unbounded::<Outgoing>();
	let writer = tokio::spawn(async move {
		let mut protocol = PROTOCOL_V1;
		let streamed = HashSet::<String>::new();
		let mut chunk_sequence = 0_u64;
		while let Ok(message) = outgoing_rx.recv_async().await {
			let (value, negotiated) = match message {
				Outgoing::Frame(value) => (value, None),
				Outgoing::Negotiated { frame, protocol } => (frame, Some(protocol)),
				Outgoing::Close => break,
			};
			let frames = if protocol == PROTOCOL_V2 {
				chunk_sequence = chunk_sequence.saturating_add(1);
				encode_json_v2(&value, &format!("rpc-{chunk_sequence}"))
					.map_err(|source| miette!(source))?
			} else {
				vec![encode_json_v1(&value, &streamed)]
			};
			for bytes in frames {
				output.write_all(&bytes).await.into_diagnostic()?;
			}
			output.flush().await.into_diagnostic()?;
			if let Some(next) = negotiated {
				protocol = next;
			}
		}
		Ok::<(), miette::Report>(())
	});
	if send_ready {
		outgoing_tx
			.send(Outgoing::Frame(
				serde_json::to_value(ReadyFrame::v2_capable(MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES))
					.into_diagnostic()?,
			))
			.into_diagnostic()?;
	}
	outgoing_tx
		.send(Outgoing::Frame(json!({
			"type": "available_commands_update",
			"commands": available_commands(&runtime),
		})))
		.into_diagnostic()?;
	let host_tools = RpcHostToolBridge::new(outgoing_tx.clone());
	let tool_registry = Arc::clone(kernel.tool_registry());
	let mut host_tool_revision = 0_u64;
	let mut subagent_subscription = omp_rpc::protocol::SubscriptionLevel::Off;
	let mut subagent_seen = HashMap::<String, Value>::new();

	let (snapshot, mut dom_events) = session.subscribe();
	// The actor's own projection of the session tree (ADR 0005): `get_state`
	// answers from it at any time, including while a turn owns the session.
	let mut replica = Dom::from_snapshot(&snapshot);
	let mut projection = RpcEventProjection::default();
	let _ = projection.observe(&replica);
	let mut event_filter = history::EventFilter::default();
	let kernel_events = kernel.subscribe();
	let mailbox = kernel.mailbox();

	let (incoming_tx, incoming_rx) = flume::unbounded();
	let input_task = tokio::spawn(async move {
		let mut lines = JsonLineDecoder::new();
		let mut logical = RpcFrameDecoder::new();
		let mut logical_pending = false;
		let mut buffer = [0_u8; 16 * 1024];
		loop {
			let count = match input.read(&mut buffer).await {
				Ok(count) => count,
				Err(source) => {
					let _ = incoming_tx
						.send_async(Incoming::Error(error_frame(
							None,
							"transport",
							"io_error",
							&crate::fault(source),
						)))
						.await;
					break;
				},
			};
			if count == 0 {
				let _ = incoming_tx
					.send_async(Incoming::End {
						truncated: !lines.remainder().is_empty() || logical_pending,
					})
					.await;
				break;
			}
			let batch = lines.push(&buffer[..count]);
			for diagnostic in batch.diagnostics {
				let _ = incoming_tx
					.send_async(Incoming::Error(error_frame(
						None,
						"transport",
						"invalid_frame",
						diagnostic.reason,
					)))
					.await;
			}
			for bytes in batch.frames {
				let value = match logical.push_frame(&bytes) {
					Ok(Some(value)) => {
						logical_pending = false;
						value
					},
					Ok(None) => {
						logical_pending = true;
						continue;
					},
					Err(source) => {
						logical.reset();
						logical_pending = false;
						let _ = incoming_tx
							.send_async(Incoming::Error(error_frame(
								None,
								"transport",
								"invalid_frame",
								&crate::fault(source),
							)))
							.await;
						continue;
					},
				};
				match serde_json::from_value::<RpcRequest>(value) {
					Ok(request) => {
						if incoming_tx
							.send_async(Incoming::Request(request))
							.await
							.is_err()
						{
							return;
						}
					},
					Err(source) => {
						let _ = incoming_tx
							.send_async(Incoming::Error(error_frame(
								None,
								"parse",
								"invalid_request",
								&crate::fault(source),
							)))
							.await;
					},
				}
			}
		}
	});

	let ui_requests = ui.as_ref().map(RpcUiBridge::requests);
	let (turn_tx, turn_rx) = flume::unbounded::<TurnCompletion<C>>();
	let mut active_session_path = session.journal_path().to_path_buf();
	let jobs = Arc::clone(kernel.jobs());
	let mut current = Some((kernel, session));
	let mut turn_running = false;
	// The running kernel task is an RPC `bash` run (`abort_bash` target).
	let mut bash_running = false;
	// `abort_and_prompt` while a turn runs: the interrupt is sent now and the
	// prompt starts the moment the aborted turn hands the session back.
	let mut abort_prompt: Option<RpcTurnInput> = None;
	let mut pending_session_name: Option<Str> = None;
	let mut pending_todos: Option<Vec<Value>> = None;
	// `cancel` kills the session scope (ADR 0011): no further turn can run,
	// so queued follow-ups stay journaled for a later resume instead of
	// being popped into immediately-cancelled turns.
	let mut session_cancelled = false;
	let mut input_open = true;
	let mut dom_open = true;
	let mut kernel_open = true;
	let mut ui_open = ui_requests.is_some();
	let mut shutting_down = false;

	loop {
		tokio::select! {
			incoming = incoming_rx.recv_async(), if input_open && !shutting_down => {
				match incoming {
					Ok(Incoming::Error(frame)) => {
						outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
					},
					Ok(Incoming::End { truncated }) => {
						input_open = false;
						if truncated {
							outgoing_tx.send(Outgoing::Frame(error_frame(
								None,
								"transport",
								"truncated_frame",
								"input ended mid-frame",
							))).into_diagnostic()?;
						}
						if turn_running {
							if let Some(ui) = &ui {
								ui.close();
							}
							host_tools.close("RPC client disconnected before host tool execution completed");
							let _ = mailbox.send(Up::Cancel);
							shutting_down = true;
						} else {
							break;
						}
					},
					Err(_) => {
						input_open = false;
						if turn_running {
							if let Some(ui) = &ui {
								ui.close();
							}
							host_tools.close("RPC client disconnected before host tool execution completed");
							let _ = mailbox.send(Up::Cancel);
							shutting_down = true;
						} else {
							break;
						}
					},
					Ok(Incoming::Request(request)) => {
						let id = request.id.clone();
						let command = request.command.clone();
						match command.as_str() {
							SESSION_STARTUP_COMMAND => {
								outgoing_tx.send(Outgoing::Frame(error_frame(
									id,
									SESSION_STARTUP_COMMAND,
									"session_already_started",
									"workspace trust must be supplied before session composition",
								))).into_diagnostic()?;
							},
							"negotiate_protocol" => {
								let response = negotiate(id, &request.params);
								let protocol = request.params
									.get("protocolVersion")
									.and_then(Value::as_u64)
									.and_then(|value| u8::try_from(value).ok())
									.filter(|value| *value == PROTOCOL_V2);
								let frame = serde_json::to_value(response).into_diagnostic()?;
								match protocol {
									Some(protocol) => outgoing_tx.send(Outgoing::Negotiated { frame, protocol }).into_diagnostic()?,
									None => outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?,
								}
							},
							"host_tool_update" => {
								let mut params = request.params;
								if let Some(id) = id.as_ref() {
									params.insert("id".into(), Value::String(id.to_string()));
								}
								if !host_tools.handle_update(&params) {
									outgoing_tx.send(Outgoing::Frame(error_frame(
										id,
										command.as_str(),
										"invalid_request",
										"no matching host tool call",
									))).into_diagnostic()?;
								}
							},
							"host_tool_result" => {
								let mut params = request.params;
								if let Some(id) = id.as_ref() {
									params.insert("id".into(), Value::String(id.to_string()));
								}
								if !host_tools.handle_result(&params) {
									outgoing_tx.send(Outgoing::Frame(error_frame(
										id,
										command.as_str(),
										"invalid_request",
										"no matching host tool call",
									))).into_diagnostic()?;
								}
							},
							"set_host_tools" if turn_running => {
								// A host roster replacement reshapes the tool array every
								// request of the running turn carries (and the provider's
								// cached prefix); it is accepted only between turns.
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(busy_response(id, command.as_str())).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_host_tools" => {
								let definitions = request.params
									.get("tools")
									.cloned()
									.map(serde_json::from_value::<Vec<omp_rpc::protocol::HostToolDefinition>>)
									.transpose();
								let response = match definitions {
									Ok(Some(definitions)) => {
										let names = definitions.iter().map(|tool| tool.name.clone()).collect::<Vec<_>>();
										let specs = definitions.into_iter().map(|tool| Ok(HostToolSpec {
											name: Str::new(tool.name),
											description: Str::new(tool.description),
											parameters: tool.parameters,
											rev: None,
											effects: tool.effects.map(host_tool_effects).transpose()?,
										})).collect::<Result<Vec<_>, omp_tool::UsdParseError>>();
										match specs {
											Ok(specs) => {
												host_tool_revision = host_tool_revision.saturating_add(1);
												match tool_registry.replace_host_tools(
													Str::new_static("rpc"),
													host_tool_revision,
													specs,
													Arc::new(host_tools.clone()),
												) {
													Ok(()) => RpcResponse::success(
														id,
														command.as_str(),
														json!({ "toolNames": names }),
													).into_diagnostic()?,
													Err(source) => RpcResponse::error(
														id,
														command.as_str(),
														source.to_string(),
														Some(RpcErrorCode::new("invalid_host_tools")),
													),
												}
											},
											Err(source) => RpcResponse::error(
												id,
												command.as_str(),
												source.to_string(),
												Some(RpcErrorCode::new("invalid_host_tools")),
											),
										}
									},
									Ok(None) | Err(_) => RpcResponse::error(
										id,
										command.as_str(),
										"set_host_tools requires a valid `tools` array",
										Some(RpcErrorCode::new("invalid_params")),
									),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_subagent_subscription" => {
								let level = request.params.get("level").cloned()
									.map(serde_json::from_value::<omp_rpc::protocol::SubscriptionLevel>)
									.transpose();
								let response = match level {
									Ok(Some(level)) => {
										subagent_subscription = level;
										RpcResponse::success(id, command.as_str(), json!({ "level": level })).into_diagnostic()?
									},
									_ => RpcResponse::error(
										id,
										command.as_str(),
										"Invalid subagent subscription level",
										Some(RpcErrorCode::new("invalid_params")),
									),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_subagents" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									json!({ "subagents": rpc_subagents(&jobs) }),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_subagent_messages" => {
								let selector = request.params
									.get("subagentId")
									.and_then(Value::as_str)
									.or_else(|| request.params.get("sessionFile").and_then(Value::as_str));
								let response = match selector {
									Some(selector) => {
										let path = request.params.get("sessionFile").and_then(Value::as_str)
											.map(PathBuf::from)
											.unwrap_or_else(|| home.sessions_dir.join(format!("{}.oms", safe_session_name(selector))));
										match Session::open(&path, omp_session::ComponentRegistry::standard()) {
											Ok(child_session) => {
												let next_byte = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
												RpcResponse::success(id, command.as_str(), json!({
													"sessionFile": path,
													"fromByte": request.params.get("fromByte").and_then(Value::as_u64).unwrap_or(0),
													"nextByte": next_byte,
													"reset": false,
													"entries": [],
													"messages": rpc_messages(child_session.dom()),
												})).into_diagnostic()?
											},
											Err(source) => RpcResponse::error(
												id,
												command.as_str(),
												source.to_string(),
												Some(RpcErrorCode::new("subagent_transcript_error")),
											),
										}
									},
									None => RpcResponse::error(
										id,
										command.as_str(),
										"get_subagent_messages requires subagentId or sessionFile",
										Some(RpcErrorCode::new("invalid_params")),
									),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_available_commands" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									json!({ "commands": available_commands(&runtime) }),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_fast_mode" => {
								let enabled = request.params.get("enabled").and_then(Value::as_bool);
								let response = match enabled {
									Some(enabled) => match set_con(&runtime, "ai_fastmode", omp_con::Value::Bool(enabled)) {
										Ok(()) => RpcResponse::success(
											id,
											command.as_str(),
											json!({ "enabled": enabled, "active": enabled }),
										).into_diagnostic()?,
										Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
									},
									None => RpcResponse::error(id, command.as_str(), "set_fast_mode requires `enabled`", Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_todos" => {
								let response = if let Some(phases) = request.params.get("phases").and_then(Value::as_array) {
									let applied = if let Some((_, session)) = current.as_mut() {
										replace_todos(session, phases)
									} else {
										pending_todos = Some(phases.clone());
										Ok(())
									};
									match applied {
										Ok(()) => RpcResponse::success(id, command.as_str(), json!({ "todoPhases": phases })).into_diagnostic()?,
										Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("session_error"))),
									}
								} else {
									RpcResponse::error(id, command.as_str(), "set_todos requires `phases`", Some(RpcErrorCode::new("invalid_params")))
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_available_models" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									json!({ "models": rpc_models(&runtime) }),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_model" => {
								let provider = request.params.get("provider").and_then(Value::as_str);
								let model_id = request.params.get("modelId").and_then(Value::as_str);
								let response = match (provider, model_id) {
									(Some(provider), Some(model_id)) => {
										let key = format!("{provider}/{model_id}");
										let exists = runtime.catalog.as_ref().is_none_or(|catalog| {
											catalog.models().iter().any(|model| model.key.as_str() == key)
										});
										if !exists {
											RpcResponse::error(id, command.as_str(), format!("Model not found: {key}"), Some(RpcErrorCode::new("model_not_found")))
										} else {
											match apply_model(&mut runtime, &outgoing_tx, &key) {
												Ok(()) => RpcResponse::success(id, command.as_str(), model_value(&runtime, &key)).into_diagnostic()?,
												Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
											}
										}
									},
									_ => RpcResponse::error(id, command.as_str(), "set_model requires `provider` and `modelId`", Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"cycle_model" => {
								let response = if runtime.model_cycle.is_empty() {
									RpcResponse::success(id, command.as_str(), Value::Null).into_diagnostic()?
								} else {
									runtime.model_cycle_index = (runtime.model_cycle_index + 1) % runtime.model_cycle.len();
									let (_, key, thinking) = &runtime.model_cycle[runtime.model_cycle_index];
									let key = key.clone();
									let thinking = thinking.clone();
									match set_con(&runtime, "ai_model", omp_con::Value::Str(key.clone())) {
										Ok(()) => {
											runtime.model = key.clone();
											if let Some(thinking) = &thinking {
												let _ = set_con(&runtime, "ai_thinking", omp_con::Value::Str(thinking.clone()));
											}
											outgoing_tx.send(Outgoing::Frame(json!({ "type": "model_changed" }))).into_diagnostic()?;
											RpcResponse::success(id, command.as_str(), json!({
												"model": model_value(&runtime, key.as_str()),
												"thinkingLevel": thinking,
												"isScoped": true,
											})).into_diagnostic()?
										},
										Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_thinking_level" => {
								let level = request.params.get("level").and_then(Value::as_str);
								let response = match level {
									Some(level) if known_thinking_level(level) => match set_con(&runtime, "ai_thinking", omp_con::Value::Str(Str::new(level))) {
										Ok(()) => {
											outgoing_tx.send(Outgoing::Frame(json!({
												"type": "thinking_level_changed",
												"thinkingLevel": level,
											}))).into_diagnostic()?;
											RpcResponse::success_empty(id, command.as_str())
										},
										Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
									},
									Some(level) => RpcResponse::error(id, command.as_str(), format!("unknown thinking level `{level}`"), Some(RpcErrorCode::new("config_error"))),
									None => RpcResponse::error(id, command.as_str(), "set_thinking_level requires `level`", Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"cycle_thinking_level" => {
								const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];
								let current_level = con_text(&runtime, "ai_thinking");
								let index = current_level.as_deref()
									.and_then(|current| LEVELS.iter().position(|level| *level == current))
									.map_or(0, |index| (index + 1) % LEVELS.len());
								let level = LEVELS[index];
								let response = match set_con(&runtime, "ai_thinking", omp_con::Value::Str(Str::new_static(level))) {
									Ok(()) => RpcResponse::success(id, command.as_str(), json!({ "level": level })).into_diagnostic()?,
									Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_available_thinking_levels" => {
								let levels = history::thinking_levels(runtime.catalog.as_deref(), runtime.model.as_str());
								let response = RpcResponse::success(id, command.as_str(), json!({ "levels": levels })).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_steering_mode" | "set_follow_up_mode" | "set_interrupt_mode" => {
								let mode = request.params.get("mode").and_then(Value::as_str);
								let valid = match command.as_str() {
									"set_interrupt_mode" => matches!(mode, Some("immediate" | "wait")),
									_ => matches!(mode, Some("all" | "one-at-a-time")),
								};
								let response = if valid {
									let value = Str::new(mode.expect("validated mode"));
									match command.as_str() {
										"set_steering_mode" => runtime.steering_mode = value,
										"set_follow_up_mode" => runtime.follow_up_mode = value,
										"set_interrupt_mode" => runtime.interrupt_mode = value,
										_ => unreachable!(),
									}
									RpcResponse::success_empty(id, command.as_str())
								} else {
									RpcResponse::error(id, command.as_str(), "invalid queue mode", Some(RpcErrorCode::new("invalid_params")))
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_auto_compaction" | "set_auto_retry" => {
								let enabled = request.params.get("enabled").and_then(Value::as_bool);
								let response = match enabled {
									Some(enabled) => {
										if command == "set_auto_compaction" {
											runtime.automatic_compaction = enabled;
										} else {
											runtime.auto_retry = enabled;
										}
										RpcResponse::success_empty(id, command.as_str())
									},
									None => RpcResponse::error(id, command.as_str(), "command requires `enabled`", Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"abort_retry" => {
								let _ = mailbox.send(Up::Interrupt);
								let response = RpcResponse::success_empty(id, command.as_str());
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							// Interrupts only an RPC `bash` run, through the kernel's turn
							// cancellation (the environment stops the shell job); a model
							// turn is left alone, as in pi.
							"abort_bash" => {
								if bash_running {
									let _ = mailbox.send(Up::Interrupt);
								}
								let response = RpcResponse::success_empty(id, command.as_str());
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"compact" => {
								let response = if turn_running {
									busy_response(id, command.as_str())
								} else {
									let (kernel, session) = current.as_mut().expect("idle RPC owns session");
									let focus = request.params.get("customInstructions").and_then(Value::as_str).map(Str::new);
									match kernel.compact(session, focus, "manual", None).await {
										Ok(compacted) => RpcResponse::success(
											id,
											command.as_str(),
											json!({ "compacted": compacted }),
										).into_diagnostic()?,
										Err(source) => RpcResponse::error(
											id,
											command.as_str(),
											source.to_string(),
											Some(RpcErrorCode::new("compaction_error")),
										),
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							// RPC `bash` is the user-local `!` run (see `start_bash`): the
							// environment's in-process shell under its admission policy,
							// never a host `/bin/sh`. The response follows once the run
							// settles; `abort_bash` interrupts it meanwhile.
							"bash" => {
								let paused = current
									.as_ref()
									.is_some_and(|(_, session)| omp_agent::pause_state(session.dom()).active);
								let response = match request.params.get("command").and_then(Value::as_str) {
									_ if turn_running => Some(busy_response(id, command.as_str())),
									Some(_) if paused => Some(RpcResponse::error(
										id,
										command.as_str(),
										"Paused: resume before running local commands",
										Some(RpcErrorCode::new("session_paused")),
									)),
									Some(script) => {
										start_bash(&mut current, &turn_tx, id, Str::new(script));
										turn_running = true;
										bash_running = true;
										None
									},
									None => Some(RpcResponse::error(id, command.as_str(), "bash requires `command`", Some(RpcErrorCode::new("invalid_params")))),
								};
								if let Some(response) = response {
									outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
								}
							},
							// `/handoff` in chat: the kernel's in-place compaction under
							// the `handoff` method, which journals a handoff document.
							"handoff" => {
								let response = if turn_running {
									RpcResponse::error(id, command.as_str(), "Cannot hand off while a response is in progress", Some(RpcErrorCode::new(RpcErrorCode::SESSION_BUSY)))
								} else {
									let (kernel, session) = current.as_mut().expect("idle RPC owns session");
									let focus = request.params.get("customInstructions").and_then(Value::as_str).map(Str::new);
									// A handoff is always a written document: pin the soft strategy.
									match kernel.compact(session, focus, "handoff", Some(omp_agent::CompactionStrategy::Soft)).await {
										Ok(handed_off) => RpcResponse::success(
											id,
											command.as_str(),
											json!({
												"handedOff": handed_off,
												"document": handed_off.then(|| handoff_document(session.dom())).flatten(),
											}),
										).into_diagnostic()?,
										Err(source) => RpcResponse::error(
											id,
											command.as_str(),
											source.to_string(),
											Some(RpcErrorCode::new("handoff_error")),
										),
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"export_html" => {
								let requested = request.params.get("outputPath").and_then(Value::as_str);
								let target = requested.map_or_else(
									|| {
										let stem = active_session_path
											.file_stem()
											.and_then(|value| value.to_str())
											.unwrap_or("session");
										runtime.project.join(format!("omp-session-{stem}.html"))
									},
									|path| {
										let path = std::path::PathBuf::from(path);
										if path.is_absolute() {
											path
										} else {
											runtime.project.join(path)
										}
									},
								);
								let blobs = omp_journal::blob::BlobStore::open(
									active_session_path
										.parent()
										.unwrap_or_else(|| std::path::Path::new(".")),
								);
								let response = match blobs
									.into_diagnostic()
									.and_then(|blobs| {
										crate::render_cmd::export_html_snapshot(
											&active_session_path,
											&replica,
											&blobs,
											&target,
										)
									})
								{
									Ok(()) => RpcResponse::success(
										id,
										command.as_str(),
										json!({"path": target}),
									)
									.into_diagnostic()?,
									Err(source) => RpcResponse::error(
										id,
										command.as_str(),
										source.to_string(),
										Some(RpcErrorCode::new("export_error")),
									),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_login_providers" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									json!({ "providers": [] }),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"login" => {
								let response = RpcResponse::error(
									id,
									command.as_str(),
									"OAuth login is unavailable on this RPC composition",
									Some(RpcErrorCode::new("unsupported")),
								);
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_host_uri_schemes" => {
								let response = RpcResponse::error(
									id,
									command.as_str(),
									"host URI schemes are unavailable on this RPC composition",
									Some(RpcErrorCode::new("unsupported")),
								);
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_messages" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									json!({ "messages": rpc_messages(&replica) }),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_messages_page" => {
								let response = if turn_running {
									busy_response(id, command.as_str())
								} else {
									let messages = rpc_messages(&replica);
									let limit = request.params.get("limit").and_then(Value::as_u64)
										.and_then(|value| usize::try_from(value).ok())
										.unwrap_or(100).clamp(1, 1_000);
									let offset = request.params.get("cursor").and_then(Value::as_str)
										.and_then(|value| value.parse::<usize>().ok())
										.unwrap_or(0);
									if offset > messages.len() {
										RpcResponse::error(id, command.as_str(), "stale transcript cursor", Some(RpcErrorCode::new(RpcErrorCode::STALE_CURSOR)))
									} else {
										let end = (offset + limit).min(messages.len());
										RpcResponse::success(id, command.as_str(), json!({
											"messages": messages[offset..end],
											"nextCursor": (end < messages.len()).then(|| end.to_string()),
											"totalMessages": messages.len(),
										})).into_diagnostic()?
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_branch_messages" => {
								let messages = branch_messages(&replica);
								let response = RpcResponse::success(id, command.as_str(), json!({ "messages": messages })).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_entries" | "get_tree" => {
								let response = match current.as_ref() {
									Some((_, session)) if !turn_running => {
										if command == "get_tree" {
											RpcResponse::success(id, command.as_str(), history::tree(session)).into_diagnostic()?
										} else {
											let since = request.params.get("since").and_then(Value::as_str);
											match history::entries(session, since) {
												Ok(data) => RpcResponse::success(id, command.as_str(), data).into_diagnostic()?,
												Err(unknown) => RpcResponse::error(id, command.as_str(), unknown.to_string(), Some(RpcErrorCode::new("unknown_since"))),
											}
										}
									},
									_ => busy_response(id, command.as_str()),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_event_filter" => {
								let response = match event_filter.replace(&request.params) {
									Ok(data) => RpcResponse::success(id, command.as_str(), data).into_diagnostic()?,
									Err(invalid) => RpcResponse::error(id, command.as_str(), invalid.to_string(), Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_last_assistant_text" => {
								let text = last_assistant_text(&replica);
								let response = RpcResponse::success(id, command.as_str(), json!({ "text": text })).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"set_session_name" => {
								let name = request.params.get("name").and_then(Value::as_str).map(str::trim);
								let response = match name.filter(|name| !name.is_empty()) {
									Some(name) => {
										let title = Str::new(name);
										runtime.session_name = Some(title.clone());
										let applied = if let Some((_, session)) = current.as_mut() {
											rename_session(session, title)
										} else {
											pending_session_name = Some(title);
											Ok(())
										};
										if let Err(source) = applied {
											let response = RpcResponse::error(
												id,
												command.as_str(),
												source,
												Some(RpcErrorCode::new("session_error")),
											);
											outgoing_tx.send(Outgoing::Frame(
												serde_json::to_value(response).into_diagnostic()?,
											)).into_diagnostic()?;
											continue;
										}
										outgoing_tx.send(Outgoing::Frame(json!({
											"type": "session_info_update",
											"title": name,
											"sessionId": active_session_path.file_stem().and_then(|name| name.to_str()),
										}))).into_diagnostic()?;
										RpcResponse::success_empty(id, command.as_str())
									},
									None => RpcResponse::error(id, command.as_str(), "Session name cannot be empty", Some(RpcErrorCode::new("invalid_params"))),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"get_session_stats" => {
								let messages = rpc_messages(&replica);
								let response = RpcResponse::success(id, command.as_str(), json!({
									"sessionId": active_session_path.file_stem().and_then(|name| name.to_str()),
									"messageCount": messages.len(),
									"turnCount": replica.children(replica.body()).len(),
									"sessionFile": active_session_path,
								})).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"prompt" => {
								let response = if turn_running {
									busy_response(id, command.as_str())
								} else {
									match message_text(&request.params) {
										Some(text)
											if current
												.as_ref()
												.is_some_and(|(_, session)| {
													omp_agent::pause_state(session.dom()).active
												}) =>
										{
											if let Some((_, session)) = current.as_mut() {
												omp_agent::queue_prompt(session, Str::new(text), &[], None)
													.into_diagnostic()?;
											}
											RpcResponse::success(
												id,
												command.as_str(),
												json!({ "accepted": true, "queued": true, "paused": true }),
											)
											.into_diagnostic()?
										},
										Some(text) => {
											let agent_invoked = skill_input(&runtime, text).is_some();
											let input = request_input(
												&current.as_ref().expect("idle RPC owns session").1,
												&runtime,
												&request.params,
											);
											match input {
												Ok(input) => {
													start_turn(&mut current, &turn_tx, &outgoing_tx, input)?;
													turn_running = true;
													RpcResponse::success(
														id,
														command.as_str(),
														json!({ "accepted": true, "agentInvoked": agent_invoked }),
													).into_diagnostic()?
												},
												Err(source) => RpcResponse::error(
													id,
													command.as_str(),
													source,
													Some(RpcErrorCode::new("invalid_params")),
												),
											}
										},
										None => missing_message(id, command.as_str()),
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"steer" => {
								let response = up_response(id, command.as_str(), &request.params, &mailbox, |text| Up::Steer {
									text,
									attachments: Vec::new(),
									author: None,
								});
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							// Behind a running turn the prompt is journaled into
							// `<queues><prompts>` and popped when the turn yields;
							// idle, it runs now.
							"follow_up" => {
								let response = if turn_running {
									up_response(id, command.as_str(), &request.params, &mailbox, |text| Up::Queue {
										text,
										attachments: Vec::new(),
										author: None,
									})
								} else {
									match message_text(&request.params) {
										Some(text)
											if current
												.as_ref()
												.is_some_and(|(_, session)| {
													omp_agent::pause_state(session.dom()).active
												}) =>
										{
											if let Some((_, session)) = current.as_mut() {
												omp_agent::queue_prompt(session, Str::new(text), &[], None)
													.into_diagnostic()?;
											}
											RpcResponse::success(
												id,
												command.as_str(),
												json!({ "queued": true, "paused": true }),
											)
											.into_diagnostic()?
										},
										Some(_) => {
											match plain_request_input(
												&current.as_ref().expect("idle RPC owns session").1,
												&request.params,
											) {
												Ok(input) => {
													start_turn(&mut current, &turn_tx, &outgoing_tx, input)?;
													turn_running = true;
													RpcResponse::success(
														id,
														command.as_str(),
														json!({ "queued": false }),
													).into_diagnostic()?
												},
												Err(source) => RpcResponse::error(
													id,
													command.as_str(),
													source,
													Some(RpcErrorCode::new("invalid_params")),
												),
											}
										},
										None => missing_message(id, command.as_str()),
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							// Interrupt the running turn, then
							// prompt; the response acknowledges the abort and the new
							// turn's events stream after it.
							"abort_and_prompt" => {
								let response = match message_text(&request.params) {
									Some(text) => {
										let input = if turn_running {
											text_input(text)
										} else {
											match plain_request_input(
												&current.as_ref().expect("idle RPC owns session").1,
												&request.params,
											) {
												Ok(input) => input,
												Err(source) => {
													let response = RpcResponse::error(
														id,
														command.as_str(),
														source,
														Some(RpcErrorCode::new("invalid_params")),
													);
													outgoing_tx.send(Outgoing::Frame(
														serde_json::to_value(response).into_diagnostic()?,
													)).into_diagnostic()?;
													continue;
												},
											}
										};
										if turn_running {
											abort_prompt = Some(input);
											let _ = mailbox.send(Up::Interrupt);
										} else {
											start_turn(&mut current, &turn_tx, &outgoing_tx, input)?;
											turn_running = true;
										}
										RpcResponse::success_empty(id, command.as_str())
									},
									None => missing_message(id, command.as_str()),
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"approve" => {
								let response = approve_response(id, command.as_str(), &request.params, &mailbox);
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"interrupt" | "abort" => {
								let _ = mailbox.send(Up::Interrupt);
								let response = RpcResponse::success_empty(id, command.as_str());
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"pause" | "resume" => {
								let active = command == "pause";
								let mut queued = None;
								if turn_running {
									let _ = mailbox.send(Up::Pause { active });
								} else if let Some((_, session)) = current.as_mut() {
									let transition =
										omp_agent::set_paused(session, active).into_diagnostic()?;
									if !active {
										queued = omp_agent::pop_queued_prompt(session)
											.into_diagnostic()?
																							.map(|omp_agent::QueuedPrompt { text, attachments, .. }| RpcTurnInput::Plain(TurnInput { text, attachments }));
									}
									let response = RpcResponse::success(
										id.clone(),
										command.as_str(),
										json!({
											"paused": transition.state.active,
											"durationMs": transition.state.duration_ms,
										}),
									)
									.into_diagnostic()?;
									outgoing_tx.send(Outgoing::Frame(
										serde_json::to_value(response).into_diagnostic()?,
									)).into_diagnostic()?;
								}
								if turn_running {
									let response = RpcResponse::success(
										id,
										command.as_str(),
										json!({ "paused": active }),
									).into_diagnostic()?;
									outgoing_tx.send(Outgoing::Frame(
										serde_json::to_value(response).into_diagnostic()?,
									)).into_diagnostic()?;
								}
								if let Some(input) = queued {
									start_turn(&mut current, &turn_tx, &outgoing_tx, input)?;
									turn_running = true;
								}
							},
							"cancel" => {
								let _ = mailbox.send(Up::Cancel);
								session_cancelled = true;
								let response = RpcResponse::success_empty(id, command.as_str());
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"extension_ui_response" => {
								let answered = ui.as_ref().is_some_and(|ui| {
									request.id.as_ref().is_some_and(|id| ui.respond(id.as_str(), request.params))
								});
								if !answered {
									outgoing_tx.send(Outgoing::Frame(error_frame(
										id,
										command.as_str(),
										"invalid_request",
										"no matching RPC UI request",
									))).into_diagnostic()?;
								}
							},
							// `get_state` works while streaming (`isStreaming`
							// is part of the state); the replica projects the tree
							// whether or not a turn owns the session.
							"get_state" => {
								let response = RpcResponse::success(
									id,
									command.as_str(),
									rpc_state(
										&runtime,
										&replica,
										&tool_registry,
										turn_running,
										&active_session_path,
									),
								).into_diagnostic()?;
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"new_session" | "switch_session" | "branch" | "open_session" => {
								let open = (command == "open_session").then(|| open_session_plan(&runtime, &request.params, &active_session_path));
								let response = if turn_running {
									busy_response(id, command.as_str())
								} else if let Some(Err(refusal)) = &open {
									refusal.response(id, command.as_str())
								} else if let Some(Ok(OpenSessionPlan::AlreadyOpen { model })) = &open {
									// Reopening the active journal switches nothing.
									match model.as_deref().map(|key| apply_model(&mut runtime, &outgoing_tx, key)).transpose() {
										Ok(_) => RpcResponse::success(id, command.as_str(), open_session_result(&active_session_path, true)).into_diagnostic()?,
										Err(source) => RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("config_error"))),
									}
								} else {
									let params = match &open {
										Some(Ok(OpenSessionPlan::Transition { params, .. })) => params,
										_ => &request.params,
									};
									let (idle_kernel, mut old) = current.take().expect("idle RPC owns session");
									let transition = match idle_kernel.flush_session_state(&mut old) {
										Ok(()) => transition_session(&home, idle_kernel.lifecycle_hooks(), old, command.as_str(), params).await,
										Err(source) => Err((source.to_string(), old)),
									};
									match transition {
										Ok((mut next, start)) => {
											// The kernel outlives the session: state derived
											// from the previous journal must not serve `next`.
											idle_kernel.session_switched(&next);
											idle_kernel.resync_session_state(&next);
											// Committed and resynced: `next` starts. A host
											// refusing it cannot undo the switch; it is logged.
											if let Some(lifecycle) = idle_kernel.lifecycle_hooks()
												&& let Err(error) = lifecycle.session_start(&start).await
											{
												tracing::warn!(
													error = &error as &dyn std::error::Error,
													"session_start refused after an RPC session switch"
												);
											}
											let (snapshot, events) = next.subscribe();
											dom_events = events;
											dom_open = true;
											replica = Dom::from_snapshot(&snapshot);
											active_session_path = next.journal_path().to_path_buf();
											projection.reset();
											let _ = projection.observe(&replica);
											runtime.session_name = None;
											current = Some((idle_kernel, next));
											outgoing_tx.send(Outgoing::Frame(json!({
												"type": "session_start",
												"sessionFile": active_session_path,
												"sessionId": active_session_path.file_stem().and_then(|name| name.to_str()),
											}))).into_diagnostic()?;
											outgoing_tx.send(Outgoing::Frame(json!({
												"type": "available_commands_update",
												"commands": available_commands(&runtime),
											}))).into_diagnostic()?;
											let data = match &open {
												Some(Ok(OpenSessionPlan::Transition { params, model })) => {
													// The switch committed; a model the config refuses
													// leaves the journal's own model in place.
													if let Some(Err(error)) = model.as_deref().map(|key| apply_model(&mut runtime, &outgoing_tx, key)) {
														tracing::warn!(%error, "open_session could not select the requested model");
													}
													open_session_result(&active_session_path, params.contains_key("sessionPath"))
												},
												_ if command == "branch" => json!({ "text": last_assistant_text(&replica).unwrap_or_default(), "cancelled": false }),
												_ => json!({ "cancelled": false }),
											};
											RpcResponse::success(id, command.as_str(), data).into_diagnostic()?
										},
										Err((source, old)) => {
											current = Some((idle_kernel, old));
											RpcResponse::error(id, command.as_str(), source, Some(RpcErrorCode::new("session_error")))
										},
									}
								};
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
							"quit" | "shutdown" => {
								let response = RpcResponse::success_empty(id, command.as_str());
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
								if turn_running {
									if let Some(ui) = &ui {
										ui.close();
									}
									host_tools.close("RPC client disconnected before host tool execution completed");
									let _ = mailbox.send(Up::Cancel);
									shutting_down = true;
								} else {
									break;
								}
							},
							_ => {
								let response = RpcResponse::error(
									id,
									command.as_str(),
									"unknown RPC command",
									Some(RpcErrorCode::new("unknown_command")),
								);
								outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
							},
						}
					},
				}
			},
			completed = turn_rx.recv_async(), if turn_running => {
				let TurnCompletion {
					kernel: turn_kernel,
					session: mut turn_session,
					result,
					origin,
				} = completed.into_diagnostic()?;
				if let Some(title) = pending_session_name.take() {
					rename_session(&mut turn_session, title).map_err(|source| miette!("{source}"))?;
				}
				if let Some(phases) = pending_todos.take() {
					replace_todos(&mut turn_session, &phases).map_err(|source| miette!("{source}"))?;
				}
				while let Ok(event) = dom_events.try_recv() {
					replica.apply_event(&event).into_diagnostic()?;
					for frame in projection.observe(&replica).into_iter().filter_map(|frame| event_filter.apply(frame)) {
						outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
					}
				}
				while let Ok(event) = kernel_events.try_recv() {
					if let Some(value) = kernel_event_value(event).and_then(|value| event_filter.apply(value)) {
						outgoing_tx.send(Outgoing::Frame(value)).into_diagnostic()?;
					}
				}
				for frame in observe_subagents(&jobs, subagent_subscription, &mut subagent_seen) {
					outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
				}
				if let RunOrigin::Bash { id, started } = origin {
					bash_running = false;
					let response = bash_response(id, &turn_session, result, started)?;
					outgoing_tx.send(Outgoing::Frame(serde_json::to_value(response).into_diagnostic()?)).into_diagnostic()?;
				} else {
					if let Some(last) = rpc_messages(&replica)
						.into_iter()
						.rev()
						.find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
					{
						let tool_results = replica
							.children(replica.body())
							.last()
							.copied()
							.map(|turn| rpc_tool_results(&replica, turn))
							.unwrap_or_default();
						let turn_end = json!({
							"type": "turn_end",
							"message": last,
							"toolResults": tool_results,
						});
						if let Some(frame) = event_filter.apply(turn_end) {
							outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
						}
					}
					let terminal = match result {
						Ok(outcome) => json!({
							"type": "agent_end",
							"messages": replica.children(replica.body()).last().copied()
								.map(|turn| rpc_turn_messages(&replica, turn))
								.unwrap_or_default(),
							"isTerminal": true,
							"cancelled": outcome.stop == TurnStop::Cancelled,
							"steered": outcome.stop == TurnStop::Steered,
							"text": outcome.assistant_text,
							"tokensIn": outcome.tokens_in,
							"tokensOut": outcome.tokens_out,
						}),
						Err(source) => json!({
							"type": "agent_end",
							"messages": replica.children(replica.body()).last().copied()
								.map(|turn| rpc_turn_messages(&replica, turn))
								.unwrap_or_default(),
							"isTerminal": true,
							"cancelled": false,
							"error": source.to_string(),
						}),
					};
					if let Some(frame) = event_filter.apply(terminal) {
						outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
					}
				}
				if shutting_down || !input_open {
					current = Some((turn_kernel, turn_session));
					break;
				}
				// The aborted-then-prompted turn outranks the follow-up queue;
				// otherwise the oldest queued follow-up runs now that the
				// agent yielded.
				let next = match abort_prompt.take() {
					Some(input) => Some(input),
					None if session_cancelled => None,
					None => omp_agent::pop_queued_prompt(&mut turn_session)
						.into_diagnostic()?
						.map(|omp_agent::QueuedPrompt { text, attachments, .. }| RpcTurnInput::Plain(TurnInput { text, attachments })),
				};
				current = Some((turn_kernel, turn_session));
				match next {
					Some(input) => start_turn(&mut current, &turn_tx, &outgoing_tx, input)?,
					None => turn_running = false,
				}
			},
			event = dom_events.recv_async(), if dom_open => {
				match event {
					Ok(event) => {
						replica.apply_event(&event).into_diagnostic()?;
						for frame in projection.observe(&replica).into_iter().filter_map(|frame| event_filter.apply(frame)) {
							outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
						}
						for frame in observe_subagents(&jobs, subagent_subscription, &mut subagent_seen) {
							outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
						}
					},
					Err(_) => dom_open = false,
				}
			},
			event = kernel_events.recv_async(), if kernel_open => {
				match event {
					Ok(event) => {
						if let Some(value) = kernel_event_value(event).and_then(|value| event_filter.apply(value)) {
							outgoing_tx.send(Outgoing::Frame(value)).into_diagnostic()?;
						}
					},
					Err(_) => kernel_open = false,
				}
			},
			request = async {
				match &ui_requests {
					Some(requests) => requests.recv_async().await,
					None => std::future::pending().await,
				}
			}, if ui_open => {
				match request {
					Ok(request) => outgoing_tx.send(Outgoing::Frame(request)).into_diagnostic()?,
					Err(_) => ui_open = false,
				}
			},
		}
	}

	input_task.abort();
	let _ = input_task.await;
	if let Some(ui) = &ui {
		ui.close();
	}
	host_tools.close("RPC client disconnected before host tool execution completed");
	let (kernel, mut session) = current.expect("RPC shutdown waits for active turn");
	kernel.flush_session_state(&mut session).into_diagnostic()?;
	session
		.record_exit(omp_session::ExitCause::Normal)
		.into_diagnostic()?;
	if let Some(lifecycle) = kernel.lifecycle_hooks() {
		lifecycle
			.session_shutdown(&omp_agent::SessionShutdown::new(
				&session,
				omp_agent::ShutdownReason::UserExit,
			))
			.await;
	}
	while let Ok(event) = dom_events.try_recv() {
		replica.apply_event(&event).into_diagnostic()?;
		for frame in projection
			.observe(&replica)
			.into_iter()
			.filter_map(|frame| event_filter.apply(frame))
		{
			outgoing_tx.send(Outgoing::Frame(frame)).into_diagnostic()?;
		}
	}
	outgoing_tx
		.send(Outgoing::Frame(json!({ "type": "session_shutdown" })))
		.into_diagnostic()?;
	// The registry retains host-tool executors (and therefore sender clones)
	// until the kernel drops. Use an ordered close barrier instead of channel
	// disconnection so the final response and shutdown frames drain first.
	outgoing_tx.send(Outgoing::Close).into_diagnostic()?;
	drop(session);
	drop(outgoing_tx);
	writer.await.into_diagnostic()??;
	Ok(())
}

/// Selects `key` as the session model (`ai_model`) and tells the host.
fn apply_model(
	runtime: &mut RpcRuntime,
	outgoing: &flume::Sender<Outgoing>,
	key: &str,
) -> Result<(), String> {
	set_con(runtime, "ai_model", omp_con::Value::Str(Str::new(key)))?;
	runtime.model = Str::new(key);
	// A closed writer means the host is gone; nothing is left to tell.
	let _ = outgoing.send(Outgoing::Frame(json!({ "type": "model_changed" })));
	Ok(())
}

/// What an `open_session` request resolves to before any session changes.
enum OpenSessionPlan {
	/// The newest journal in the directory is the active one: nothing switches.
	AlreadyOpen {
		/// Model to select, from `provider`/`modelId`.
		model: Option<String>,
	},
	/// Switch through [`transition_session`] with these parameters: the
	/// newest journal (`sessionPath`) or a fresh one in the directory
	/// (`sessionDir`).
	Transition {
		/// Parameters for the `open_session` transition.
		params: Map<String, Value>,
		/// Model to select once the switch committed.
		model:  Option<String>,
	},
}

/// An `open_session` request refused before any session change.
#[derive(Debug, thiserror::Error)]
enum OpenSessionRefusal {
	/// `sessionDir` is absent or empty.
	#[error("open_session requires `sessionDir`")]
	MissingDirectory,
	/// Only one of `provider` and `modelId` was given.
	#[error("open_session takes `provider` and `modelId` together")]
	PartialModel,
	/// The catalog has no such model.
	#[error("Model not found: {key}")]
	ModelNotFound {
		/// The requested `provider/modelId`.
		key: String,
	},
	/// The directory could not be listed.
	#[error("cannot read session directory {}", directory.display())]
	Directory {
		/// The resolved directory.
		directory: PathBuf,
		/// Why listing it failed.
		#[source]
		source:    std::io::Error,
	},
}

impl OpenSessionRefusal {
	fn response(&self, id: Option<RequestId>, command: &str) -> RpcResponse {
		let code = match self {
			Self::MissingDirectory | Self::PartialModel => "invalid_params",
			Self::ModelNotFound { .. } => "model_not_found",
			Self::Directory { .. } => "session_error",
		};
		RpcResponse::error(id, command, self.to_string(), Some(RpcErrorCode::new(code)))
	}
}

/// Resolves `open_session`: `sessionDir` (relative to the project), the
/// newest journal in it, and the optional `provider`/`modelId` pair, which is
/// checked before anything switches.
fn open_session_plan(
	runtime: &RpcRuntime,
	params: &Map<String, Value>,
	active: &Path,
) -> Result<OpenSessionPlan, OpenSessionRefusal> {
	let directory = params
		.get("sessionDir")
		.and_then(Value::as_str)
		.filter(|directory| !directory.is_empty())
		.ok_or(OpenSessionRefusal::MissingDirectory)?;
	let model = match (
		params.get("provider").and_then(Value::as_str),
		params.get("modelId").and_then(Value::as_str),
	) {
		(None, None) => None,
		(Some(provider), Some(model_id)) => {
			let key = format!("{provider}/{model_id}");
			let known = runtime.catalog.as_ref().is_none_or(|catalog| {
				catalog
					.models()
					.iter()
					.any(|model| model.key.as_str() == key)
			});
			if !known {
				return Err(OpenSessionRefusal::ModelNotFound { key });
			}
			Some(key)
		},
		_ => return Err(OpenSessionRefusal::PartialModel),
	};
	let directory = runtime.project.join(directory);
	let newest = omp_driver::headless::kernel::newest_session(&directory)
		.map_err(|source| OpenSessionRefusal::Directory { directory: directory.clone(), source })?;
	if newest.as_deref() == Some(active) {
		return Ok(OpenSessionPlan::AlreadyOpen { model });
	}
	let mut params = Map::new();
	match newest {
		Some(path) => {
			params.insert("sessionPath".into(), Value::String(path.to_string_lossy().into_owned()))
		},
		None => {
			params.insert("sessionDir".into(), Value::String(directory.to_string_lossy().into_owned()))
		},
	};
	Ok(OpenSessionPlan::Transition { params, model })
}

/// The `open_session` success payload for the session now active.
fn open_session_result(active: &Path, resumed: bool) -> Value {
	json!({
		"cancelled": false,
		"resumed": resumed,
		"sessionId": active.file_stem().and_then(|name| name.to_str()),
		"sessionFile": active,
	})
}

/// Opens the session a transition command names; once it is open, `old`
/// ends on the lifecycle surface and is switched away from. The caller
/// starts the returned session once it resynced it.
async fn transition_session(
	home: &SessionHome,
	lifecycle: Option<omp_agent::LifecycleHooks>,
	mut old: Session,
	command: &str,
	params: &Map<String, Value>,
) -> Result<(Session, omp_agent::SessionStart), (String, Session)> {
	let reason = match command {
		"new_session" => omp_agent::SwitchReason::New,
		"switch_session" => omp_agent::SwitchReason::Resume,
		"open_session" if params.contains_key("sessionPath") => omp_agent::SwitchReason::Resume,
		"open_session" => omp_agent::SwitchReason::New,
		_ => omp_agent::SwitchReason::Fork,
	};
	let result: Result<Session, String> = match command {
		// `open_session` resolved its directory: a fresh journal in it
		// (`sessionDir`) when it holds none, else the newest (`sessionPath`).
		"new_session" | "open_session" if !params.contains_key("sessionPath") => {
			let path = if command == "open_session" {
				let Some(directory) = params.get("sessionDir").and_then(Value::as_str) else {
					return Err(("open_session requires `sessionDir`".into(), old));
				};
				let fresh = home.fresh_path();
				Some(Path::new(directory).join(fresh.file_name().unwrap_or(fresh.as_os_str())))
			} else {
				None
			};
			home
				.create(path)
				.map_err(|source| crate::fault(source).into())
		},
		"switch_session" | "open_session" => {
			let Some(path) = params.get("sessionPath").and_then(Value::as_str) else {
				return Err(("switch_session requires `sessionPath`".into(), old));
			};
			home
				.open(Path::new(path))
				.map_err(|source| crate::fault(source).into())
		},
		"branch" => {
			let Some(entry) = params.get("entryId").and_then(Value::as_str) else {
				return Err(("branch requires `entryId`".into(), old));
			};
			let target: omp_journal::EntryId = match entry.parse() {
				Ok(target) => target,
				Err(source) => return Err((crate::fault(source).into(), old)),
			};
			let source_path = old.journal_path().to_path_buf();
			match home.fork(&source_path) {
				Ok(mut next) => match next.rewind(target) {
					Ok(_) => Ok(next),
					Err(source) => {
						let path = next.journal_path().to_path_buf();
						home.unregister(&next);
						drop(next);
						let _ = fs::remove_file(path);
						Err(crate::fault(source).into())
					},
				},
				Err(source) => Err(crate::fault(source).into()),
			}
		},
		_ => unreachable!("session transition command is matched by caller"),
	};
	match result {
		Ok(next) => {
			if let Some(lifecycle) = &lifecycle {
				lifecycle
					.session_shutdown(&omp_agent::SessionShutdown::switching(&old, &next, reason))
					.await;
			}
			if let Err(source) = old.session_switch() {
				home.unregister(&next);
				return Err((crate::fault(source).into(), old));
			}
			// Committed: the in-process hook hosts follow the switch.
			if let Some(lifecycle) = &lifecycle {
				lifecycle.session_switched(&next);
			}
			let start = omp_agent::SessionStart::switched(&old, &next, reason, &home.project_root);
			home.unregister(&old);
			Ok((next, start))
		},
		Err(source) => Err((source, old)),
	}
}

fn busy_response(id: Option<RequestId>, command: &str) -> RpcResponse {
	RpcResponse::error(
		id,
		command,
		"another RPC operation is active",
		Some(RpcErrorCode::new(RpcErrorCode::SESSION_BUSY)),
	)
}

fn negotiate(id: Option<RequestId>, params: &Map<String, Value>) -> RpcResponse {
	let version = params.get("protocolVersion").and_then(Value::as_u64);
	if version == Some(u64::from(PROTOCOL_V2)) {
		RpcResponse::success(id, "negotiate_protocol", json!({ "protocolVersion": version }))
			.expect("static protocol response serializes")
	} else {
		RpcResponse::error(
			id,
			"negotiate_protocol",
			"only protocol version 2 can be negotiated",
			Some(RpcErrorCode::new(RpcErrorCode::UNSUPPORTED_PROTOCOL)),
		)
	}
}

/// The prompt text of a `prompt`/`steer`/`follow_up`/`abort_and_prompt`
/// request (`message`, or the legacy `text`).
fn message_text(params: &Map<String, Value>) -> Option<&str> {
	params
		.get("message")
		.or_else(|| params.get("text"))
		.and_then(Value::as_str)
}

fn text_input(text: &str) -> RpcTurnInput {
	RpcTurnInput::Plain(TurnInput { text: Str::new(text), attachments: Vec::new() })
}

fn request_input(
	session: &Session,
	runtime: &RpcRuntime,
	params: &Map<String, Value>,
) -> Result<RpcTurnInput, String> {
	let text = message_text(params).ok_or_else(|| "prompt requires `message`".to_owned())?;
	if let Some(skill) = skill_input(runtime, text) {
		return Ok(skill);
	}
	plain_request_input(session, params)
}

fn plain_request_input(
	session: &Session,
	params: &Map<String, Value>,
) -> Result<RpcTurnInput, String> {
	let text = message_text(params).ok_or_else(|| "prompt requires `message`".to_owned())?;
	let inputs = params
		.get("images")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.map(|image| {
			let data = image
				.get("data")
				.and_then(Value::as_str)
				.ok_or_else(|| "image requires base64 `data`".to_owned())?;
			let bytes = omp_core::base64::decode(data)
				.into_vec()
				.map_err(|_| "image `data` is not valid base64".to_owned())?;
			let mime = image
				.get("mimeType")
				.or_else(|| image.get("mime"))
				.and_then(Value::as_str)
				.unwrap_or("image/png");
			Ok(omp_session::AttachmentInput { mime: Str::new(mime), bytes: bytes.into() })
		})
		.collect::<Result<Vec<_>, String>>()?;
	let attachments = session
		.store_attachments(inputs)
		.map_err(|error| String::from(crate::fault(error)))?;
	Ok(RpcTurnInput::Plain(TurnInput { text: Str::new(text), attachments }))
}

fn skill_input(runtime: &RpcRuntime, text: &str) -> Option<RpcTurnInput> {
	if !con_bool(runtime, "sv_skills_enable_skill_commands", true) {
		return None;
	}
	let (name, args) = parse_skill_invocation(text)?;
	let args = (!args.is_empty())
		.then(|| Str::new(args))
		.into_iter()
		.collect::<Vec<_>>();
	runtime
		.skills
		.as_ref()?
		.prompt(name, &args)
		.map(RpcTurnInput::Skill)
}

fn parse_skill_invocation(text: &str) -> Option<(&str, String)> {
	let trimmed = text.trim_start();
	if let Some(rest) = trimmed.strip_prefix("/skill:") {
		let split = rest.find(' ').unwrap_or(rest.len());
		let name = &rest[..split];
		if name.is_empty() {
			return None;
		}
		return Some((name, rest[split..].trim().to_owned()));
	}
	if trimmed.starts_with('/') || trimmed.starts_with('!') || local_python_prefix(trimmed) {
		return None;
	}
	for (start, _) in text.match_indices("/skill:") {
		if start != 0
			&& !text[..start]
				.chars()
				.next_back()
				.is_some_and(char::is_whitespace)
		{
			continue;
		}
		let rest = &text[start + "/skill:".len()..];
		let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
		if end == 0 || rest[..end].contains('/') {
			continue;
		}
		let token_end = start + "/skill:".len() + end;
		let before = text[..start].trim_end();
		let after = text[token_end..].trim_start();
		let args = [before, after]
			.into_iter()
			.filter(|part| !part.is_empty())
			.collect::<Vec<_>>()
			.join(" ");
		return Some((&rest[..end], args));
	}
	None
}

fn local_python_prefix(text: &str) -> bool {
	let bytes = text.as_bytes();
	if bytes.first() != Some(&b'$') {
		return false;
	}
	let length = if bytes.get(1) == Some(&b'$') { 2 } else { 1 };
	bytes.get(length).is_none_or(u8::is_ascii_whitespace)
}

fn missing_message(id: Option<RequestId>, command: &str) -> RpcResponse {
	RpcResponse::error(
		id,
		command,
		format!("{command} requires `message` or `text`"),
		Some(RpcErrorCode::new("invalid_params")),
	)
}

/// Sends the request's message to the running turn through `up` and reports
/// it queued (`steer` → [`Up::Steer`], `follow_up` → [`Up::Queue`]).
fn up_response(
	id: Option<RequestId>,
	command: &str,
	params: &Map<String, Value>,
	mailbox: &flume::Sender<Up>,
	up: impl FnOnce(Str) -> Up,
) -> RpcResponse {
	match message_text(params) {
		Some(text) => {
			let _ = mailbox.send(up(Str::new(text)));
			RpcResponse::success(id, command, json!({ "queued": true }))
				.expect("static queue response serializes")
		},
		None => missing_message(id, command),
	}
}

fn kernel_event_value(event: KernelEvent) -> Option<Value> {
	match event {
		KernelEvent::InferenceStarted => None,
		KernelEvent::InferenceRetry { attempt, max_attempts, delay, reason } => Some(json!({
			"type": "auto_retry_start",
			"attempt": attempt,
			"maxAttempts": max_attempts,
			"delayMs": delay.as_millis(),
			"errorMessage": reason,
		})),
		KernelEvent::Usage { .. }
		| KernelEvent::TextDelta(_)
		| KernelEvent::ThinkingDelta(_)
		| KernelEvent::ToolReady { .. }
		| KernelEvent::ToolUpdate { .. }
		| KernelEvent::ToolSettled { .. } => None,
		KernelEvent::StreamRedirected { director, label, reason } => {
			Some(stream_redirect_frame(&director, &label, reason.as_ref()))
		},
		KernelEvent::StreamObserved { event, payload, .. } => {
			stream_observation_frame(event, &payload)
		},
		KernelEvent::CompactionSpeculating { percent } => Some(json!({
			"type": "auto_compaction_start",
			"reason": "threshold",
			"action": "context-full",
			"percent": percent,
		})),
		KernelEvent::CompactionSettled { applied } => Some(json!({
			"type": "auto_compaction_end",
			"action": "context-full",
			"result": if applied { json!({ "compacted": true }) } else { Value::Null },
			"aborted": false,
			"willRetry": false,
			"skipped": !applied,
		})),
		KernelEvent::JobsDelivered { ids } => Some(json!({
			"type": "async_result",
			"jobIds": ids,
		})),
		KernelEvent::WorkflowActionAnswered { invocation, name, is_error } => Some(json!({
			"type": "workflow_action_end",
			"invocation": invocation,
			"toolName": name,
			"isError": is_error,
		})),
		// The wrapper's approval `select` becomes an extension UI
		// request; the journal-first host names the durable prompt so the
		// client answers with `approve`. One answer decides every
		// requirement, so `requirements` carries them all beside the first.
		KernelEvent::ApprovalRequested(ticket) => {
			let first = ticket.reasons.first();
			Some(json!({
				"type": "tool_approval_request",
				"promptId": ticket.ticket_id,
				"toolCallId": ticket.invocation_id,
				"title": first.map(|spec| spec.title.as_str()),
				"body": first.map(|spec| spec.body.as_str()),
				"subject": first.map(|spec| spec.subject.as_str()),
				"kind": first.map(|spec| spec.kind.as_str()),
				"scopes": first.map(|spec| spec.scopes.clone()),
				"timeoutMs": first.map(|spec| spec.timeout_ms),
				"requirements": ticket.reasons,
			}))
		},
		KernelEvent::TurnEnded { .. } => None,
	}
}

/// Decider recorded for a stdio `approve` that names none: the peer is the
/// owner's own process, so the channel is the only identity it has.
const STDIO_DECIDER: &str = "stdio";

/// `approve {promptId, approved, scope?, reason?, decidedBy?}` →
/// [`Up::Approve`]. The answer always names a decider: `decidedBy` when the
/// client sends one, else the stdio channel.
fn approve_response(
	id: Option<RequestId>,
	command: &str,
	params: &Map<String, Value>,
	mailbox: &flume::Sender<Up>,
) -> RpcResponse {
	let Some(prompt_id) = params
		.get("promptId")
		.or_else(|| params.get("id"))
		.and_then(Value::as_str)
	else {
		return RpcResponse::error(
			id,
			command,
			"approve requires `promptId`",
			Some(RpcErrorCode::new("invalid_params")),
		);
	};
	let approved = params
		.get("approved")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let scope = params
		.get("scope")
		.and_then(Value::as_str)
		.unwrap_or("once")
		.parse::<omp_agent::ApprovalScope>()
		.expect("approval scope parsing is infallible");
	let _ = mailbox.send(Up::approve_local(
		Str::new(prompt_id),
		omp_agent::ApprovalDecision::external(
			approved,
			scope,
			params
				.get("decidedBy")
				.and_then(Value::as_str)
				.filter(|name| !name.trim().is_empty())
				.map_or(Str::new_static(STDIO_DECIDER), Str::new),
			params.get("reason").and_then(Value::as_str).map(Str::new),
		),
	));
	RpcResponse::success(id, command, json!({ "queued": true }))
		.expect("static approval response serializes")
}

fn error_frame(id: Option<RequestId>, command: &str, code: &str, message: &str) -> Value {
	serde_json::to_value(RpcResponse::error(id, command, message, Some(RpcErrorCode::new(code))))
		.expect("RPC error envelope serializes")
}

/// The `stream_redirected` frame print and RPC hosts emit when a Director
/// redirects a response: who redirected, the culprit label (`stream rule
/// <name>`), and the journaled notice as the reason.
pub(crate) fn stream_redirect_frame(director: &str, label: &str, reason: Option<&Str>) -> Value {
	json!({
		"type": "stream_redirected",
		"director": director,
		"label": label,
		"reason": reason.map(Str::as_str),
	})
}

/// A journaled stream observation as a frame named after its hook event
/// (`stream_rule_triggered` for `HOOK_EVENT_STREAM_RULE_TRIGGERED`), carrying
/// the payload extensions received. `None` for a payload that is not a JSON
/// object.
pub(crate) fn stream_observation_frame(
	event: omp_proto::toolhost::v1::HookEventId,
	payload: &str,
) -> Option<Value> {
	let Ok(Value::Object(mut fields)) = serde_json::from_str::<Value>(payload) else {
		return None;
	};
	let name = event.as_str_name();
	let name = name.strip_prefix("HOOK_EVENT_").unwrap_or(name);
	fields.insert("type".to_owned(), Value::from(name.to_ascii_lowercase()));
	Some(Value::Object(fields))
}

#[cfg(test)]
mod tests {
	use omp_agent::{ApprovalSpec, ApprovalTicket, KernelEvent, TicketState};
	use omp_core::Str;

	use super::kernel_event_value;

	#[tokio::test]
	async fn startup_trust_precedes_composition_and_preserves_pipelined_input() {
		use tokio::io::AsyncReadExt as _;

		let mut input = std::io::Cursor::new(
			b"{\"id\":\"start\",\"type\":\"session_startup\",\"trustWorkspace\":true}\n{\"type\":\"get_state\"}\n",
		);
		let mut output = Vec::new();
		let (startup, pending) = super::receive_startup(&mut input, &mut output)
			.await
			.unwrap();
		assert_eq!(startup.trust_workspace, Some(true));
		assert!(pending.is_empty());
		let mut rest = String::new();
		input.read_to_string(&mut rest).await.unwrap();
		assert_eq!(rest, "{\"type\":\"get_state\"}\n");
		let frames: Vec<serde_json::Value> = output
			.split(|byte| *byte == b'\n')
			.filter(|line| !line.is_empty())
			.map(|line| serde_json::from_slice(line).unwrap())
			.collect();
		assert_eq!(frames.len(), 2);
		assert_eq!(frames[0]["type"], "ready");
		assert_eq!(frames[1]["id"], "start");
		assert_eq!(frames[1]["success"], true);
	}

	#[tokio::test]
	async fn omitted_startup_keeps_legacy_requests_and_default_grant_evaluation() {
		let request = b"{\"id\":\"old\",\"type\":\"get_state\"}\n";
		let mut input = std::io::Cursor::new(request);
		let mut output = Vec::new();
		let (startup, pending) = super::receive_startup(&mut input, &mut output)
			.await
			.unwrap();
		assert_eq!(startup, omp_rpc::protocol::SessionStartupParams::default());
		assert_eq!(pending, request);
		assert_eq!(output.iter().filter(|byte| **byte == b'\n').count(), 1);
	}

	#[tokio::test]
	async fn omitted_and_false_trust_startup_keep_default_evaluation() {
		for request in [
			"{\"type\":\"session_startup\"}\n",
			"{\"type\":\"session_startup\",\"trustWorkspace\":false}\n",
		] {
			let mut input = std::io::Cursor::new(request.as_bytes());
			let mut output = Vec::new();
			let (startup, pending) = super::receive_startup(&mut input, &mut output)
				.await
				.unwrap();
			assert_ne!(startup.trust_workspace, Some(true));
			assert!(pending.is_empty());
		}
	}

	#[tokio::test]
	async fn malformed_startup_is_rejected_before_composition() {
		let mut input = std::io::Cursor::new(
			b"{\"id\":\"bad\",\"type\":\"session_startup\",\"trustWorkspace\":\"true\"}\n",
		);
		let mut output = Vec::new();
		assert!(
			super::receive_startup(&mut input, &mut output)
				.await
				.is_err()
		);
		let response: serde_json::Value =
			serde_json::from_slice(output.split(|byte| *byte == b'\n').nth(1).unwrap()).unwrap();
		assert_eq!(response["id"], "bad");
		assert_eq!(response["success"], false);
		assert_eq!(response["code"], "invalid_params");
	}

	#[tokio::test]
	async fn oversized_startup_without_newline_is_bounded() {
		let bytes = vec![b'x'; super::MAX_FRAME_BYTES + 2];
		let mut input = std::io::Cursor::new(bytes);
		assert!(
			super::receive_startup(&mut input, &mut Vec::new())
				.await
				.is_err()
		);
		assert_eq!(input.position(), (super::MAX_FRAME_BYTES + 1) as u64);
	}

	/// One answer to `approve` decides every requirement of the prompt, so
	/// the request carries them all beside the first one's summary.
	#[test]
	fn approval_requests_carry_every_requirement() {
		let requirement = |subject: &str, kind: &str| ApprovalSpec {
			title:         Str::new_static("Allow read to fetch"),
			body:          Str::new_static("body"),
			subject:       Str::new(subject),
			kind:          Str::new(kind),
			scopes:        vec![Str::new_static("once"), Str::new_static("session")],
			default:       Some(false),
			route:         Str::new_static("user"),
			approver:      None,
			timeout_ms:    0,
			unreachable:   Str::new_static("deny"),
			require_human: true,
			pattern:       None,
			evidence:      Vec::new(),
		};
		let event = kernel_event_value(KernelEvent::ApprovalRequested(ApprovalTicket {
			ticket_id:     Str::new_static("approval-1"),
			invocation_id: Some(Str::new_static("call-1")),
			reasons:       vec![
				requirement("http:docs.rs:443", "network"),
				requirement("tool:read", "network"),
			],
			state:         TicketState::Pending,
			decision:      None,
			created_at_ms: 0,
		}))
		.expect("an approval request frame");
		assert_eq!(event["type"], "tool_approval_request");
		assert_eq!(event["subject"], "http:docs.rs:443");
		let subjects = event["requirements"]
			.as_array()
			.expect("requirements")
			.iter()
			.map(|spec| (spec["kind"].as_str(), spec["subject"].as_str()))
			.collect::<Vec<_>>();
		assert_eq!(subjects, [
			(Some("network"), Some("http:docs.rs:443")),
			(Some("network"), Some("tool:read"))
		]);
	}

	/// The stdio `approve` command always names a decider: the client's
	/// `decidedBy` when it sends one, else the stdio channel.
	#[test]
	fn stdio_approve_always_names_a_decider() {
		let (mailbox, queue) = flume::unbounded();
		let approve = |params: serde_json::Value| {
			let params = params.as_object().expect("params object").clone();
			let _ = super::approve_response(None, "approve", &params, &mailbox);
			match queue.try_recv().expect("approve is queued") {
				omp_agent::Up::Approve { id, decision, .. } => (id, decision),
				other => panic!("unexpected mailbox message {other:?}"),
			}
		};

		let (id, anonymous) =
			approve(serde_json::json!({"promptId": "approval-1", "approved": true}));
		assert_eq!(id.as_str(), "approval-1");
		assert_eq!(anonymous.source, omp_agent::ApprovalSource::External);
		assert_eq!(anonymous.decided_by.as_deref(), Some("stdio"));

		let (_, named) = approve(serde_json::json!({"promptId": "approval-1", "decidedBy": "ada"}));
		assert_eq!(named.decided_by.as_deref(), Some("ada"));

		let (_, blank) = approve(serde_json::json!({"promptId": "approval-1", "decidedBy": "  "}));
		assert_eq!(blank.decided_by.as_deref(), Some("stdio"), "a blank name is no name");
	}

	/// What `approve` queues passes the book's decider guard, so the journaled
	/// decision carries its decider.
	#[test]
	fn a_stdio_answer_is_journaled_with_its_decider() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let mut session = omp_session::Session::create(
			directory.path().join("approve.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		let book = omp_agent::ApprovalBook::new();
		let ticket = book
			.open(&mut session, ApprovalSpec {
				title:         Str::new_static("Run command"),
				body:          Str::new_static("body"),
				subject:       Str::new_static("printf ok"),
				kind:          Str::new_static("exec"),
				scopes:        vec![Str::new_static("once")],
				default:       None,
				route:         Str::new_static("user"),
				approver:      None,
				timeout_ms:    0,
				unreachable:   Str::new_static("deny"),
				require_human: true,
				pattern:       None,
				evidence:      Vec::new(),
			})
			.expect("prompt opens");

		let (mailbox, queue) = flume::unbounded();
		let params = serde_json::json!({"promptId": ticket.ticket_id, "approved": true});
		let _ =
			super::approve_response(None, "approve", params.as_object().expect("params"), &mailbox);
		let omp_agent::Up::Approve { id, decision, .. } =
			queue.try_recv().expect("approve is queued")
		else {
			panic!("approve queues Up::Approve");
		};

		let decided = book
			.decide(&mut session, id.as_str(), decision)
			.expect("the guard admits an answer that names its decider");
		assert_eq!(
			decided.decision.and_then(|decision| decision.decided_by),
			Some(Str::new_static("stdio"))
		);
	}
	#[test]
	fn set_con_does_not_run_a_second_statement_from_the_value() {
		let runtime = super::RpcRuntime {
			con:                  Some(std::sync::Arc::new(omp_con::Ctx::new())),
			catalog:              None,
			model:                Str::new_static("test/model"),
			model_cycle:          Vec::new(),
			model_cycle_index:    0,
			project:              std::path::PathBuf::from("."),
			session_name:         None,
			automatic_compaction: true,
			auto_retry:           true,
			steering_mode:        Str::new_static("one-at-a-time"),
			follow_up_mode:       Str::new_static("one-at-a-time"),
			interrupt_mode:       Str::new_static("immediate"),
			skills:               None,
		};
		let before = super::con_value(&runtime, "sv_sandbox_mode");
		assert!(before.is_some(), "sv_sandbox_mode is registered");
		let _ = super::set_con(
			&runtime,
			"ai_thinking",
			omp_con::Value::Str(Str::new_static("high;sv_sandbox_mode off")),
		);
		assert_eq!(
			super::con_value(&runtime, "sv_sandbox_mode"),
			before,
			"a set_thinking_level value ran a second console statement"
		);
	}

	#[test]
	fn set_thinking_level_accepts_only_the_listed_levels() {
		for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
			assert!(super::known_thinking_level(level), "{level} is a listed level");
		}
		for level in ["high;sv_sandbox_mode off", "high\nsv_sandbox_mode off", "turbo", ""] {
			assert!(!super::known_thinking_level(level), "{level:?} is refused");
		}
	}
}
