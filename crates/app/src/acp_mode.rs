//! Agent Client Protocol adapter over the journal-first kernel and session.

use std::{borrow::Cow, fs, path::Path, sync::Arc};

use miette::{IntoDiagnostic as _, miette};
use omp_agent::{
	ApprovalDecision, ApprovalScope, ApprovalSource, Inference, Kernel, RunControl, TurnInput, Up,
};
use omp_core::{Str, base64};
use omp_driver::{headless::kernel::SessionHome, sessions::SessionIndex};
use omp_session::{AttachmentInput, Session, SessionError};
use serde_json::{Map, Value, json};
use tokio::io::{
	AsyncBufRead, AsyncBufReadExt as _, AsyncRead, AsyncWrite, AsyncWriteExt as _, BufReader, stdin,
	stdout,
};

use crate::{
	acp_events::AcpEventMapper,
	chat_cmd::{Launch, LaunchEnv},
	cli::{AcpArgs, ChatArgs},
};

/// Maximum number of sessions returned by one `session/list` request.
const SESSION_PAGE_SIZE: usize = 50;

/// Runs ACP using stdin for NDJSON requests and stdout for NDJSON responses.
pub async fn run(args: AcpArgs) -> miette::Result<()> {
	let max_time = args.max_time.map(|duration| duration.0);
	let future = run_inner(args.launch);
	match max_time {
		Some(limit) => tokio::time::timeout(limit, future)
			.await
			.map_err(|_| miette!("ACP mode exceeded --max-time"))?,
		None => future.await,
	}
}

async fn run_inner(args: ChatArgs) -> miette::Result<()> {
	let project = fs::canonicalize(&args.project).into_diagnostic()?;
	let ctx = Arc::new(crate::process_ctx(&project)?);
	let env = LaunchEnv::production(&project, args.gateway.is_some())?;
	let launch = Launch::prepare(args, ctx, env).await?;
	let mut input = BufReader::new(stdin());
	let mut output = stdout();
	let Some(terminal_auth) = initialize_transport(&mut input, &mut output).await? else {
		return Ok(());
	};
	let (kernel, session) = launch.compose().await?;
	let home = SessionHome::new(
		&launch.data_dir,
		&launch.project,
		&launch.options,
		launch.model.clone(),
		kernel.mailbox(),
	)
	.into_diagnostic()?
	.with_facts_of(&session);
	serve_acp_state(kernel, session, home, input, output, true, terminal_auth).await
}

async fn initialize_transport<R, W>(input: &mut R, output: &mut W) -> miette::Result<Option<bool>>
where
	R: AsyncBufRead + Unpin,
	W: AsyncWrite + Unpin,
{
	let mut line = String::new();
	loop {
		line.clear();
		if input.read_line(&mut line).await.into_diagnostic()? == 0 {
			return Ok(None);
		}
		if line.trim().is_empty() {
			continue;
		}
		let frame: Value = match serde_json::from_str(&line) {
			Ok(frame) => frame,
			Err(source) => {
				write_frame(output, &error(Value::Null, -32700, &source.to_string())).await?;
				continue;
			},
		};
		let id = frame.get("id").cloned();
		if frame.get("method").and_then(Value::as_str) != Some("initialize") {
			if let Some(id) = id {
				write_frame(
					output,
					&error(id, -32002, "initialize must complete before other requests"),
				)
				.await?;
			}
			continue;
		}
		let params = frame.get("params").and_then(Value::as_object);
		let version = params
			.and_then(|params| params.get("protocolVersion"))
			.and_then(Value::as_u64);
		if version != Some(1) {
			if let Some(id) = id {
				write_frame(output, &error(id, -32602, "unsupported ACP protocol version")).await?;
			}
			continue;
		}
		let terminal_auth = params
			.and_then(|params| params.get("clientCapabilities"))
			.and_then(|capabilities| capabilities.pointer("/auth/terminal"))
			.and_then(Value::as_bool)
			.unwrap_or(false);
		if let Some(id) = id {
			write_frame(output, &success(id, initialize_response(terminal_auth))).await?;
		}
		return Ok(Some(terminal_auth));
	}
}

async fn write_frame<W: AsyncWrite + Unpin>(output: &mut W, value: &Value) -> miette::Result<()> {
	let mut bytes = serde_json::to_vec(value).into_diagnostic()?;
	bytes.push(b'\n');
	output.write_all(&bytes).await.into_diagnostic()?;
	output.flush().await.into_diagnostic()
}

struct TurnCompletion<C> {
	kernel:   Kernel<C>,
	session:  Session,
	id:       Option<Value>,
	response: Result<Value, (i64, &'static str)>,
}

enum InputEvent<C> {
	Line(Option<String>),
	Turn(TurnCompletion<C>),
}

/// Serves ACP over caller-provided NDJSON transport halves.
#[doc(hidden)]
pub async fn serve_acp<C, R, W>(
	kernel: Kernel<C>,
	session: Session,
	home: SessionHome,
	input: R,
	output: W,
) -> miette::Result<()>
where
	C: Inference + Send + Sync + 'static,
	R: AsyncRead + Unpin,
	W: AsyncWrite + Unpin + Send + 'static,
{
	serve_acp_state(kernel, session, home, input, output, false, false).await
}

async fn serve_acp_state<C, R, W>(
	mut kernel: Kernel<C>,
	mut session: Session,
	home: SessionHome,
	input: R,
	mut output: W,
	mut initialized: bool,
	mut terminal_auth: bool,
) -> miette::Result<()>
where
	C: Inference + Send + Sync + 'static,
	R: AsyncRead + Unpin,
	W: AsyncWrite + Unpin + Send + 'static,
{
	kernel.reconcile_jobs(&mut session).into_diagnostic()?;
	home.register(&session);
	let mut session_id = session_identifier(&session);
	let (output_tx, output_rx) = flume::unbounded::<Value>();
	let writer = tokio::spawn(async move {
		while let Ok(value) = output_rx.recv_async().await {
			let mut bytes = serde_json::to_vec(&value).into_diagnostic()?;
			bytes.push(b'\n');
			output.write_all(&bytes).await.into_diagnostic()?;
			output.flush().await.into_diagnostic()?;
		}
		Ok::<(), miette::Report>(())
	});
	let (snapshot, events) = session.subscribe();
	let mut forwarder = Some(
		start_forwarder(
			snapshot,
			events,
			output_tx.clone(),
			session_id.clone(),
			home.project_root.clone(),
			session.blobs().clone(),
			false,
		)
		.await?,
	);
	let mailbox = kernel.mailbox();
	// Every journaled approval prompt becomes
	// one `session/request_permission` request; the client's selected
	// option answers the prompt (`session/approve` remains for clients that
	// answer by prompt id).
	let permission_session = Arc::new(parking_lot::RwLock::new(session_id.clone()));
	let permission_requests =
		request_permissions(kernel.subscribe(), output_tx.clone(), Arc::clone(&permission_session));
	let mut controller = Some((kernel, session));
	let mut active: Option<tokio::task::JoinHandle<TurnCompletion<C>>> = None;
	let mut closed = false;
	let mut lines = BufReader::new(input).lines();

	loop {
		let input_event: InputEvent<C> = if let Some(turn) = active.as_mut() {
			tokio::select! {
				completed = turn => InputEvent::Turn(completed.into_diagnostic()?),
				line = lines.next_line() => InputEvent::Line(line.into_diagnostic()?),
			}
		} else {
			InputEvent::Line(lines.next_line().await.into_diagnostic()?)
		};
		let line = match input_event {
			InputEvent::Turn(completed) => {
				active = None;
				restore_turn(completed, &mut controller, &output_tx, forwarder.as_ref()).await?;
				continue;
			},
			InputEvent::Line(Some(line)) => line,
			InputEvent::Line(None) => {
				if let Some(turn) = active.take() {
					let _ = mailbox.send(Up::Interrupt);
					restore_turn(
						turn.await.into_diagnostic()?,
						&mut controller,
						&output_tx,
						forwarder.as_ref(),
					)
					.await?;
				}
				break;
			},
		};
		if line.trim().is_empty() {
			continue;
		}
		let frame: Value = match serde_json::from_str(&line) {
			Ok(frame) => frame,
			Err(source) => {
				output_tx
					.send(error(Value::Null, -32700, &source.to_string()))
					.into_diagnostic()?;
				continue;
			},
		};
		let id = frame.get("id").cloned();
		let Some(method) = frame.get("method").and_then(Value::as_str) else {
			// A response to one of our `session/request_permission` requests.
			if let Some((prompt_id, decision)) =
				permission_requests.answer(id.as_ref(), frame.get("result"))
			{
				let _ = mailbox.send(Up::Approve { id: prompt_id, decision });
				continue;
			}
			if let Some(id) = id {
				output_tx
					.send(error(id, -32600, "request has no method"))
					.into_diagnostic()?;
			}
			continue;
		};
		let params = frame
			.get("params")
			.and_then(Value::as_object)
			.cloned()
			.unwrap_or_default();
		if method != "initialize" && !initialized {
			if let Some(id) = id {
				output_tx
					.send(error(id, -32002, "initialize must complete before other requests"))
					.into_diagnostic()?;
			}
			continue;
		}
		if method == "session/prompt"
			&& targets_session(&params, session_id.as_str())
			&& let Some(turn) = active.take()
		{
			let _ = mailbox.send(Up::Interrupt);
			restore_turn(
				turn.await.into_diagnostic()?,
				&mut controller,
				&output_tx,
				forwarder.as_ref(),
			)
			.await?;
		}
		let result = match method {
			"initialize" => {
				let version = params.get("protocolVersion").and_then(Value::as_u64);
				if version != Some(1) {
					Err((-32602, "unsupported ACP protocol version"))
				} else {
					initialized = true;
					terminal_auth = serde_json::Value::Object(params.clone())
						.pointer("/clientCapabilities/auth/terminal")
						.and_then(Value::as_bool)
						.unwrap_or(false);
					Ok(initialize_response(terminal_auth))
				}
			},
			"authenticate" => {
				let method = params.get("methodId").and_then(Value::as_str);
				if matches!(method, Some("agent"))
					|| terminal_auth && matches!(method, Some("terminal"))
				{
					Ok(json!({}))
				} else {
					Err((-32602, "unknown ACP authentication method"))
				}
			},
			"session/new" if active.is_some() => Err((-32001, "a turn is already running")),
			"session/new" => {
				if let Err(message) = validate_session_cwd(&home, &params) {
					Err((-32602, message))
				} else {
					let next = match home.create(None) {
						Ok(next) => next,
						Err(source) => {
							if let Some(id) = id {
								output_tx
									.send(error(id, -32000, &source.to_string()))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					switch_session(
						&mut controller,
						next,
						&home,
						&output_tx,
						&mut forwarder,
						&mut session_id,
						&permission_session,
						false,
					)
					.await?;
					closed = false;
					Ok(new_session_descriptor(session_id.as_str(), home.model.as_str()))
				}
			},
			"session/load" | "session/resume" if active.is_some() => {
				Err((-32001, "a turn is already running"))
			},
			"session/load" | "session/resume" => {
				if let Err(message) = validate_session_cwd(&home, &params) {
					Err((-32602, message))
				} else {
					let selector = match requested_session(&params) {
						Ok(selector) => selector,
						Err(message) => {
							if let Some(id) = id {
								output_tx
									.send(error(id, -32602, message))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					let replay = method == "session/load";
					let next = match home.open(Path::new(selector)) {
						Ok(next) => next,
						Err(source) => {
							if let Some(id) = id {
								output_tx
									.send(error(id, -32000, &source.to_string()))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					switch_session(
						&mut controller,
						next,
						&home,
						&output_tx,
						&mut forwarder,
						&mut session_id,
						&permission_session,
						replay,
					)
					.await?;
					closed = false;
					Ok(session_state(home.model.as_str()))
				}
			},
			// Stored sessions are newest first, paged by an
			// offset cursor, optionally scoped to one `cwd`. The live session
			// is flushed to disk by construction (journal-first), so the scan
			// already sees it.
			"session/list" => match list_sessions(&home, &params) {
				Ok(page) => Ok(page),
				Err(message) => Err((-32602, message)),
			},
			// Copy the source journal (the whole
			// branch tree travels) and switch authority to the copy.
			"session/fork" if active.is_some() => Err((-32001, "a turn is already running")),
			"session/fork" => {
				if let Err(message) = validate_session_cwd(&home, &params) {
					Err((-32602, message))
				} else {
					let selector = match requested_session(&params) {
						Ok(selector) => selector,
						Err(message) => {
							if let Some(id) = id {
								output_tx
									.send(error(id, -32602, message))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					let next = match home.fork(Path::new(selector)) {
						Ok(next) => next,
						Err(source) => {
							if let Some(id) = id {
								output_tx
									.send(error(id, -32000, &source.to_string()))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					switch_session(
						&mut controller,
						next,
						&home,
						&output_tx,
						&mut forwarder,
						&mut session_id,
						&permission_session,
						false,
					)
					.await?;
					closed = false;
					Ok(new_session_descriptor(session_id.as_str(), home.model.as_str()))
				}
			},
			"session/set_mode" if !targets_session(&params, session_id.as_str()) => {
				Err((-32000, "unsupported ACP session"))
			},
			"session/set_mode" => {
				if params.get("modeId").and_then(Value::as_str) != Some("default") {
					Err((-32602, "unsupported ACP session mode"))
				} else {
					output_tx
						.send(session_update(
							session_id.as_str(),
							json!({
								"sessionUpdate": "current_mode_update",
								"currentModeId": "default",
							}),
						))
						.into_diagnostic()?;
					Ok(json!({}))
				}
			},
			"session/set_config_option" if !targets_session(&params, session_id.as_str()) => {
				Err((-32000, "unsupported ACP session"))
			},
			"session/set_config_option" => {
				let valid = params.get("configId").and_then(Value::as_str) == Some("model")
					&& params.get("value").and_then(Value::as_str) == Some(home.model.as_str());
				if !valid {
					Err((-32602, "unsupported ACP session config option"))
				} else {
					let state = session_state(home.model.as_str());
					output_tx
						.send(session_update(
							session_id.as_str(),
							json!({
								"sessionUpdate": "config_option_update",
								"configOptions": state["configOptions"].clone(),
							}),
						))
						.into_diagnostic()?;
					Ok(json!({"configOptions": state["configOptions"].clone()}))
				}
			},
			"session/prompt" if closed => Err((-32000, "ACP session is closed")),
			"session/prompt" if !targets_session(&params, session_id.as_str()) => {
				Err((-32000, "unsupported ACP session"))
			},
			"session/prompt" => match prompt_input(&params) {
				Ok(prompt) => {
					let (mut kernel, mut session) = controller
						.take()
						.expect("idle ACP controller owns its kernel and session");
					let input = match prompt.into_turn_input(&session) {
						Ok(input) => input,
						Err(source) => {
							controller = Some((kernel, session));
							if let Some(id) = id {
								output_tx
									.send(error(id, -32000, &source.to_string()))
									.into_diagnostic()?;
							}
							continue;
						},
					};
					let turn_output = output_tx.clone();
					let turn_session = session_id.clone();
					active = Some(tokio::spawn(async move {
						let response = match kernel
							.run_turn(&mut session, input, RunControl::default())
							.await
						{
							Ok(outcome) => Ok(prompt_response(&session, &outcome)),
							Err(source) => {
								let text = source.to_string();
								let message_id = session
									.head()
									.map(|entry| entry.to_string())
									.unwrap_or_else(|| "error".to_owned());
								let _ = turn_output.send(session_update(
									turn_session.as_str(),
									json!({
										"sessionUpdate": "agent_message_chunk",
										"content": {"type": "text", "text": text},
										"messageId": message_id,
									}),
								));
								Ok(json!({"stopReason": error_stop_reason(&text)}))
							},
						};
						TurnCompletion { kernel, session, id, response }
					}));
					continue;
				},
				Err(message) => Err((-32602, message)),
			},
			// ACP names the notification `cancel`; `session/cancel` is the
			// legacy spelling earlier omp clients used.
			"cancel" | "session/cancel" if !targets_session(&params, session_id.as_str()) => {
				Err((-32000, "unsupported ACP session"))
			},
			"cancel" | "session/cancel" => {
				if active.is_some() {
					let _ = mailbox.send(Up::Interrupt);
				}
				Ok(json!({}))
			},
			"session/approve" => match approval(&params) {
				Ok((id, decision)) => {
					if active.is_some() {
						let _ = mailbox.send(Up::Approve { id, decision });
					}
					Ok(json!({}))
				},
				Err(message) => Err((-32602, message)),
			},
			"session/close" if !targets_session(&params, session_id.as_str()) => Ok(json!({})),
			"session/close" if active.is_some() => Err((-32001, "a turn is already running")),
			"session/close" => {
				if !closed {
					if let Some((_, session)) = controller.as_mut() {
						session.session_switch().into_diagnostic()?;
						home.unregister(session);
					}
					closed = true;
				}
				Ok(json!({}))
			},
			"shutdown" => {
				if let Some(id) = id {
					output_tx.send(success(id, json!({}))).into_diagnostic()?;
				}
				if let Some(turn) = active.take() {
					// ACP shutdown is graceful: it waits for the active prompt's
					// delivery handlers before disposing the session. EOF remains
					// the abrupt transport-loss path that interrupts the turn.
					restore_turn(
						turn.await.into_diagnostic()?,
						&mut controller,
						&output_tx,
						forwarder.as_ref(),
					)
					.await?;
				}
				break;
			},
			_ => Err((-32601, "unknown ACP method")),
		};
		if let Some(id) = id {
			let succeeded = result.is_ok();
			let response = match result {
				Ok(value) => success(id, value),
				Err((code, message)) => error(id, code, message),
			};
			output_tx.send(response).into_diagnostic()?;
			if succeeded
				&& matches!(method, "session/new" | "session/load" | "session/resume" | "session/fork")
			{
				schedule_bootstrap_updates(output_tx.clone(), session_id.clone(), home.model.clone());
			}
		}
	}

	let (kernel, mut session) = controller
		.take()
		.expect("ACP controller owns its kernel and session after active turn completion");
	if !closed {
		session
			.record_exit(omp_session::ExitCause::Normal)
			.into_diagnostic()?;
		home.unregister(&session);
	}
	drop(session);
	drop(kernel);
	if let Some(forwarder) = forwarder {
		forwarder.finish().await?;
	}
	drop(output_tx);
	writer.await.into_diagnostic()??;
	Ok(())
}

/// Outstanding `session/request_permission` requests keyed by JSON-RPC id.
#[derive(Clone)]
struct PermissionRequests {
	pending: Arc<parking_lot::Mutex<std::collections::BTreeMap<u64, Str>>>,
	_task:   Arc<tokio::task::JoinHandle<()>>,
}

impl PermissionRequests {
	/// Maps a client response to the prompt it answers: option ids
	/// `allow_once`/`allow_always`/`reject_once`/`reject_always`; a
	/// `cancelled` outcome or an unknown option fails closed.
	fn answer(&self, id: Option<&Value>, result: Option<&Value>) -> Option<(Str, ApprovalDecision)> {
		let id = id.and_then(Value::as_u64)?;
		let prompt_id = self.pending.lock().remove(&id)?;
		let outcome = result.and_then(|result| result.get("outcome"));
		let option = outcome
			.filter(|outcome| outcome.get("outcome").and_then(Value::as_str) == Some("selected"))
			.and_then(|outcome| outcome.get("optionId"))
			.and_then(Value::as_str);
		let (approved, scope) = match option {
			Some("allow_once") => (true, ApprovalScope::Once),
			Some("allow_always") => (true, ApprovalScope::Session),
			Some("reject_always") => (false, ApprovalScope::Session),
			_ => (false, ApprovalScope::Once),
		};
		Some((prompt_id, ApprovalDecision {
			approved,
			scope,
			source: ApprovalSource::External,
			decided_by: None,
			reason: (!approved).then(|| Str::new_static("rejected by ACP client")),
			audited: false,
		}))
	}
}

fn request_permissions(
	events: flume::Receiver<omp_agent::KernelEvent>,
	output: flume::Sender<Value>,
	session_id: Arc<parking_lot::RwLock<Str>>,
) -> PermissionRequests {
	let pending = Arc::new(parking_lot::Mutex::new(std::collections::BTreeMap::new()));
	let table = Arc::clone(&pending);
	let task = tokio::spawn(async move {
		let mut next_id = 1_u64;
		while let Ok(event) = events.recv_async().await {
			let omp_agent::KernelEvent::ApprovalRequested(ticket) = event else {
				continue;
			};
			let id = next_id;
			next_id += 1;
			table.lock().insert(id, ticket.ticket_id.clone());
			let first = ticket.reasons.first();
			let mut tool_call = json!({
				"toolCallId": ticket.invocation_id.as_deref().unwrap_or(ticket.ticket_id.as_str()),
				"title": first.map_or("Approval required", |spec| spec.title.as_str()),
				"status": "pending",
				"rawInput": {
					"subject": first.map(|spec| spec.subject.as_str()),
					"body": first.map(|spec| spec.body.as_str()),
				},
			});
			if let Some(spec) = first {
				let kind = match spec.kind.as_str() {
					"exec" | "execute" | "bash" | "shell" => "execute",
					"write" | "edit" => "edit",
					"delete" => "delete",
					"move" => "move",
					"read" => "read",
					_ => "other",
				};
				tool_call["kind"] = Value::String(kind.to_owned());
				if kind == "execute" {
					tool_call["content"] = json!([{
						"type": "content",
						"content": {"type": "text", "text": format!("$ {}", spec.subject)},
					}]);
				}
			}
			let request = json!({
				"jsonrpc": "2.0",
				"id": id,
				"method": "session/request_permission",
				"params": {
					"sessionId": session_id.read().clone(),
					"toolCall": tool_call,
					"options": [
						{"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"},
						{"optionId": "allow_always", "name": "Always allow", "kind": "allow_always"},
						{"optionId": "reject_once", "name": "Reject", "kind": "reject_once"},
						{"optionId": "reject_always", "name": "Always reject", "kind": "reject_always"},
					],
				},
			});
			if output.send(request).is_err() {
				break;
			}
		}
	});
	PermissionRequests { pending, _task: Arc::new(task) }
}

struct EventForwarder {
	flush: flume::Sender<tokio::sync::oneshot::Sender<()>>,
	task:  tokio::task::JoinHandle<miette::Result<()>>,
}

impl EventForwarder {
	async fn flush(&self) -> miette::Result<()> {
		let (tx, rx) = tokio::sync::oneshot::channel();
		self.flush.send_async(tx).await.into_diagnostic()?;
		rx.await.into_diagnostic()
	}

	async fn finish(self) -> miette::Result<()> {
		drop(self.flush);
		self.task.await.into_diagnostic()?
	}
}

async fn start_forwarder(
	snapshot: omp_dom::Snapshot,
	events: flume::Receiver<omp_dom::Event>,
	output: flume::Sender<Value>,
	session_id: Str,
	cwd: std::path::PathBuf,
	blobs: omp_journal::blob::BlobStore,
	replay: bool,
) -> miette::Result<EventForwarder> {
	let (flush_tx, flush_rx) = flume::unbounded::<tokio::sync::oneshot::Sender<()>>();
	let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
	let task = tokio::spawn(async move {
		let mut mapper = AcpEventMapper::new(&snapshot, cwd, blobs);
		if replay {
			for update in mapper.replay_updates().into_diagnostic()? {
				if output
					.send(session_update(session_id.as_str(), update))
					.is_err()
				{
					let _ = ready_tx.send(());
					return Ok(());
				}
			}
		}
		let _ = ready_tx.send(());
		loop {
			tokio::select! {
				biased;
				flush = flush_rx.recv_async() => {
					let Ok(flush) = flush else { break };
					while let Ok(event) = events.try_recv() {
						for update in mapper.map_event(&event).into_diagnostic()? {
							if output.send(session_update(session_id.as_str(), update)).is_err() {
								let _ = flush.send(());
								return Ok(());
							}
						}
					}
					let _ = flush.send(());
				},
				event = events.recv_async() => {
					let Ok(event) = event else { break };
					for update in mapper.map_event(&event).into_diagnostic()? {
						if output.send(session_update(session_id.as_str(), update)).is_err() {
							return Ok(());
						}
					}
				},
			}
		}
		Ok(())
	});
	ready_rx.await.into_diagnostic()?;
	Ok(EventForwarder { flush: flush_tx, task })
}

async fn restore_turn<C>(
	completed: TurnCompletion<C>,
	controller: &mut Option<(Kernel<C>, Session)>,
	output: &flume::Sender<Value>,
	forwarder: Option<&EventForwarder>,
) -> miette::Result<()> {
	let TurnCompletion { kernel, session, id, response } = completed;
	*controller = Some((kernel, session));
	if let Some(forwarder) = forwarder {
		forwarder.flush().await?;
	}
	if let Some(id) = id {
		let response = match response {
			Ok(value) => success(id, value),
			Err((code, message)) => error(id, code, message),
		};
		output.send(response).into_diagnostic()?;
	}
	Ok(())
}

async fn switch_session<C>(
	controller: &mut Option<(Kernel<C>, Session)>,
	mut next: Session,
	home: &SessionHome,
	output: &flume::Sender<Value>,
	forwarder: &mut Option<EventForwarder>,
	session_id: &mut Str,
	permission_session: &parking_lot::RwLock<Str>,
	replay: bool,
) -> miette::Result<()> {
	let (kernel, mut previous) = controller
		.take()
		.expect("idle ACP controller owns its kernel and session");
	kernel.reconcile_jobs(&mut next).into_diagnostic()?;
	let (snapshot, events) = next.subscribe();
	let _ = previous.session_switch();
	home.unregister(&previous);
	drop(previous);
	if let Some(previous_forwarder) = forwarder.take() {
		previous_forwarder.finish().await?;
	}
	home.register(&next);
	*session_id = session_identifier(&next);
	*permission_session.write() = session_id.clone();
	*forwarder = Some(
		start_forwarder(
			snapshot,
			events,
			output.clone(),
			session_id.clone(),
			home.project_root.clone(),
			next.blobs().clone(),
			replay,
		)
		.await?,
	);
	*controller = Some((kernel, next));
	Ok(())
}

fn session_identifier(session: &Session) -> Str {
	session
		.journal_path()
		.file_stem()
		.and_then(|value| value.to_str())
		.map_or_else(|| Str::new_static("session"), Str::new)
}

fn requested_session(params: &Map<String, Value>) -> Result<&str, &'static str> {
	params
		.get("sessionId")
		.or_else(|| params.get("session"))
		.and_then(Value::as_str)
		.ok_or("sessionId is required")
}

fn targets_session(params: &Map<String, Value>, current: &str) -> bool {
	params
		.get("sessionId")
		.and_then(Value::as_str)
		.is_none_or(|requested| requested == current)
}

fn validate_session_cwd(
	home: &SessionHome,
	params: &Map<String, Value>,
) -> Result<(), &'static str> {
	let Some(cwd) = params.get("cwd").and_then(Value::as_str) else {
		return Ok(());
	};
	let path = Path::new(cwd);
	if !path.is_absolute() {
		return Err("cwd must be an absolute path");
	}
	let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
	if path != home.project_root {
		return Err("cwd does not match the configured ACP project");
	}
	Ok(())
}

/// `session/list {cwd?, cursor?}` → `{sessions, nextCursor?}` pages every
/// journal in the session directory, newest first; `cwd` scopes by genesis
/// working directory and `cursor` offsets that ordering.
fn list_sessions(home: &SessionHome, params: &Map<String, Value>) -> Result<Value, &'static str> {
	let cwd = match params.get("cwd").and_then(Value::as_str) {
		Some(cwd) => {
			let path = Path::new(cwd);
			if !path.is_absolute() {
				return Err("cwd must be an absolute path");
			}
			Some(fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
		},
		None => None,
	};
	let offset = match params.get("cursor") {
		None | Some(Value::Null) => 0,
		Some(cursor) => cursor
			.as_str()
			.and_then(|cursor| cursor.parse::<usize>().ok())
			.or_else(|| {
				cursor
					.as_u64()
					.and_then(|cursor| usize::try_from(cursor).ok())
			})
			.ok_or("invalid session cursor")?,
	};
	let index =
		SessionIndex::open(&home.sessions_dir).map_err(|_| "session directory unreadable")?;
	let mut rows = index.list();
	if let Some(cwd) = &cwd {
		rows.retain(|row| {
			let recorded = Path::new(row.cwd.as_str());
			recorded == cwd || fs::canonicalize(recorded).is_ok_and(|recorded| recorded == *cwd)
		});
	}
	let total = rows.len();
	let page: Vec<Value> = rows
		.iter()
		.skip(offset)
		.take(SESSION_PAGE_SIZE)
		.map(|row| {
			let size = fs::metadata(&row.path).map(|meta| meta.len()).unwrap_or(0);
			json!({
				"sessionId": row.id,
				"cwd": row.cwd,
				"title": row.title,
				"updatedAt": jiff::Timestamp::from_millisecond(i64::try_from(row.updated_ms).unwrap_or(i64::MAX))
					.map(|stamp| stamp.to_string())
					.unwrap_or_default(),
				"_meta": {"messageCount": row.messages, "size": size},
			})
		})
		.collect();
	let next = offset.saturating_add(page.len());
	let mut result = json!({ "sessions": page });
	if next < total {
		result["nextCursor"] = Value::String(next.to_string());
	}
	Ok(result)
}

fn schedule_bootstrap_updates(output: flume::Sender<Value>, session_id: Str, model: Str) {
	tokio::spawn(async move {
		tokio::time::sleep(std::time::Duration::from_millis(50)).await;
		for update in [
			json!({"sessionUpdate": "current_mode_update", "currentModeId": "default"}),
			json!({
				"sessionUpdate": "config_option_update",
				"configOptions": session_state(model.as_str())["configOptions"].clone(),
			}),
			json!({"sessionUpdate": "available_commands_update", "availableCommands": []}),
			json!({
				"sessionUpdate": "session_info_update",
				"updatedAt": jiff::Timestamp::now().to_string(),
			}),
		] {
			if output
				.send(session_update(session_id.as_str(), update))
				.is_err()
			{
				break;
			}
		}
	});
}

fn initialize_response(terminal_auth: bool) -> Value {
	let mut auth = vec![json!({
		"id": "agent",
		"name": "Use existing local credentials",
		"description": "Authenticate via the provider keys/OAuth state already configured under ~/.o2.",
	})];
	if terminal_auth {
		auth.push(json!({
			"type": "terminal",
			"id": "terminal",
			"name": "Set up Oh My Pi in terminal",
			"description": "Launch the omp TUI to add provider keys and select models.",
			"args": ["--acp-terminal-auth"],
		}));
	}
	json!({
		"protocolVersion": 1,
		"agentInfo": {
			"name": "oh-my-pi",
			"title": "Oh My Pi",
			"version": env!("CARGO_PKG_VERSION"),
		},
		"authMethods": auth,
		"agentCapabilities": {
			"loadSession": true,
			"mcpCapabilities": {"http": true, "sse": true},
			"sessionCapabilities": {"list": {}, "fork": {}, "resume": {}, "close": {}},
			"promptCapabilities": {"image": true, "embeddedContext": true},
		},
	})
}

fn session_state(model: &str) -> Value {
	json!({
		"configOptions": [{
			"type": "select",
			"id": "model",
			"name": "Model",
			"currentValue": model,
			"options": [{"value": model, "name": model}],
		}],
		"modes": {
			"currentModeId": "default",
			"availableModes": [{
				"id": "default",
				"name": "Default",
				"description": "Standard coding-agent behavior",
			}],
		},
	})
}

fn new_session_descriptor(session_id: &str, model: &str) -> Value {
	let mut descriptor = session_state(model);
	descriptor["sessionId"] = Value::String(session_id.to_owned());
	descriptor
}

fn prompt_response(session: &Session, outcome: &omp_agent::TurnOutcome) -> Value {
	let stop_reason = if outcome.stop == omp_agent::TurnStop::Cancelled {
		"cancelled"
	} else {
		session
			.dom()
			.children(session.dom().body())
			.iter()
			.rev()
			.filter_map(|turn| session.dom().get(*turn))
			.flat_map(|turn| turn.kids.iter().rev())
			.filter_map(|handle| session.dom().get(*handle))
			.find(|node| node.tag == omp_dom::Tag::Known(omp_dom::KnownTag::Assistant))
			.and_then(|node| node.prop(&omp_dom::PropId::StopReason.into()))
			.and_then(omp_dom::Value::as_str)
			.map(|reason| match reason {
				"length" => "max_tokens",
				"max_requests" | "max_turn_requests" => "max_turn_requests",
				"aborted" | "cancelled" => "cancelled",
				"refusal" | "content_filter" => "refusal",
				_ => "end_turn",
			})
			.unwrap_or("end_turn")
	};
	let mut response = json!({"stopReason": stop_reason});
	let total = outcome.tokens_in.saturating_add(outcome.tokens_out);
	if total != 0 {
		response["usage"] = json!({
			"totalTokens": total,
			"inputTokens": outcome.tokens_in,
			"outputTokens": outcome.tokens_out,
		});
	}
	response
}

fn error_stop_reason(message: &str) -> &'static str {
	let message = message.to_ascii_lowercase();
	if message.contains("content_filter")
		|| message.contains("content filter")
		|| message.contains("refusal")
		|| message.contains("refused")
	{
		"refusal"
	} else {
		"end_turn"
	}
}

/// A `session/prompt` request reduced to the turn text and its image blocks,
/// each decoded with its declared `mimeType`.
struct PromptInput {
	text:   Str,
	images: Vec<AttachmentInput>,
}

impl PromptInput {
	/// Stores every image in the session's blob store and returns the turn
	/// input whose attachments reference them — the seam the chat composer's
	/// image chips also take.
	fn into_turn_input(self, session: &Session) -> Result<TurnInput, SessionError> {
		Ok(TurnInput { text: self.text, attachments: session.store_attachments(self.images)? })
	}
}

/// Reduces the request's `prompt` to text plus images: a bare string, a
/// `{text}` object, or the ACP content-block array (`text`, `image`,
/// `resource`, `resource_link`, `audio`).
fn prompt_input(params: &Map<String, Value>) -> Result<PromptInput, &'static str> {
	let prompt = params
		.get("prompt")
		.or_else(|| params.get("message"))
		.ok_or("session/prompt requires a prompt")?;
	if let Some(text) = prompt.as_str() {
		return Ok(PromptInput { text: Str::new(text), images: Vec::new() });
	}
	if let Some(text) = prompt.get("text").and_then(Value::as_str) {
		return Ok(PromptInput { text: Str::new(text), images: Vec::new() });
	}
	let blocks = prompt
		.as_array()
		.ok_or("session/prompt requires a prompt string or content blocks")?;
	let mut texts: Vec<Cow<'_, str>> = Vec::with_capacity(blocks.len());
	let mut images = Vec::new();
	for block in blocks {
		match block.get("type").and_then(Value::as_str) {
			Some("text") => {
				let text = block
					.get("text")
					.and_then(Value::as_str)
					.ok_or("text content block requires text")?;
				texts.push(Cow::Borrowed(text));
			},
			Some("image") => {
				let data = block
					.get("data")
					.and_then(Value::as_str)
					.ok_or("image content block requires base64 data")?;
				let mime = block
					.get("mimeType")
					.and_then(Value::as_str)
					.ok_or("image content block requires mimeType")?;
				images.push(decode_image(data, mime)?);
			},
			Some("resource") => {
				let resource = block
					.get("resource")
					.and_then(Value::as_object)
					.ok_or("resource block requires a resource object")?;
				let uri = resource
					.get("uri")
					.and_then(Value::as_str)
					.ok_or("resource block requires a resource uri")?;
				if let Some(text) = resource.get("text").and_then(Value::as_str) {
					texts.push(Cow::Borrowed(text));
				} else if let Some(mime) = resource
					.get("mimeType")
					.and_then(Value::as_str)
					.filter(|mime| mime.starts_with("image/"))
					&& let Some(blob) = resource.get("blob").and_then(Value::as_str)
				{
					images.push(decode_image(blob, mime)?);
				} else {
					texts.push(Cow::Owned(format!("[embedded resource: {uri}]")));
				}
			},
			Some("resource_link") => {
				let uri = block
					.get("uri")
					.and_then(Value::as_str)
					.ok_or("resource_link content block requires uri")?;
				texts.push(Cow::Borrowed(
					block
						.get("title")
						.or_else(|| block.get("name"))
						.and_then(Value::as_str)
						.unwrap_or(uri),
				));
			},
			Some("audio") => {
				block
					.get("data")
					.and_then(Value::as_str)
					.ok_or("audio content block requires base64 data")?;
				block
					.get("mimeType")
					.and_then(Value::as_str)
					.ok_or("audio content block requires mimeType")?;
				texts.push(Cow::Borrowed("[audio omitted]"));
			},
			_ => return Err("unsupported prompt content block"),
		}
	}
	let text = texts.join("\n\n");
	let text = text.trim();
	if text.is_empty() && images.is_empty() {
		return Err("prompt contains no text");
	}
	Ok(PromptInput { text: Str::new(text), images })
}

fn decode_image(data: &str, mime: &str) -> Result<AttachmentInput, &'static str> {
	base64::decode(data.as_bytes())
		.into_vec()
		.map(|bytes| AttachmentInput { mime: Str::new(mime), bytes: bytes.into() })
		.map_err(|_| "image content block data is not valid base64")
}

fn approval(params: &Map<String, Value>) -> Result<(Str, ApprovalDecision), &'static str> {
	let id = params
		.get("promptId")
		.or_else(|| params.get("id"))
		.and_then(Value::as_str)
		.ok_or("session/approve requires promptId")?;
	let approved = params
		.get("approved")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let scope = match params
		.get("scope")
		.and_then(Value::as_str)
		.unwrap_or("once")
	{
		"once" => ApprovalScope::Once,
		"call" => ApprovalScope::Call,
		"session" | "always" => ApprovalScope::Session,
		_ => return Err("session/approve has an invalid scope"),
	};
	Ok((Str::new(id), ApprovalDecision {
		approved,
		scope,
		source: ApprovalSource::External,
		decided_by: None,
		reason: None,
		audited: false,
	}))
}

fn session_update(session_id: &str, update: Value) -> Value {
	json!({
		"jsonrpc": "2.0",
		"method": "session/update",
		"params": {"sessionId": session_id, "update": update},
	})
}

fn success(id: Value, result: Value) -> Value {
	json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: Value, code: i64, message: &str) -> Value {
	json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn params(value: Value) -> Map<String, Value> {
		value.as_object().expect("object params").clone()
	}

	#[test]
	fn initialize_capabilities_and_terminal_auth_match_pi() {
		let ordinary = initialize_response(false);
		assert_eq!(ordinary["protocolVersion"], 1);
		assert_eq!(ordinary["agentInfo"]["name"], "oh-my-pi");
		assert_eq!(ordinary["agentCapabilities"]["loadSession"], true);
		assert_eq!(ordinary["agentCapabilities"]["mcpCapabilities"]["http"], true);
		assert_eq!(ordinary["agentCapabilities"]["mcpCapabilities"]["sse"], true);
		assert_eq!(ordinary["agentCapabilities"]["promptCapabilities"]["embeddedContext"], true);
		assert_eq!(ordinary["agentCapabilities"]["promptCapabilities"]["image"], true);
		assert_eq!(ordinary["authMethods"].as_array().map(Vec::len), Some(1));
		assert!(ordinary["authMethods"][0].get("type").is_none());

		let terminal = initialize_response(true);
		assert_eq!(terminal["authMethods"].as_array().map(Vec::len), Some(2));
		assert_eq!(terminal["authMethods"][1]["type"], "terminal");
		assert_eq!(terminal["authMethods"][1]["args"], json!(["--acp-terminal-auth"]));
	}

	#[test]
	fn prompt_accepts_string_object_and_content_blocks() {
		let plain = prompt_input(&params(json!({"prompt": "hi"}))).expect("string prompt");
		assert_eq!(plain.text.as_str(), "hi");
		assert!(plain.images.is_empty());

		let object =
			prompt_input(&params(json!({"prompt": {"text": "structured"}}))).expect("object prompt");
		assert_eq!(object.text.as_str(), "structured");

		let blocks = prompt_input(&params(json!({"prompt": [
			{"type": "text", "text": "look"},
			{"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
			{"type": "resource", "resource": {"uri": "file:///a.txt", "text": "alpha"}},
			{"type": "resource", "resource": {"uri": "file:///b.bin", "mimeType": "application/octet-stream", "blob": "AAAA"}},
			{"type": "resource", "resource": {"uri": "file:///c.png", "mimeType": "image/png", "blob": "d29ybGQ="}},
			{"type": "resource_link", "uri": "file:///d.md", "title": "Design"},
			{"type": "audio", "data": "", "mimeType": "audio/wav"},
		]})))
		.expect("content blocks");
		assert_eq!(
			blocks.text.as_str(),
			"look\n\nalpha\n\n[embedded resource: file:///b.bin]\n\nDesign\n\n[audio omitted]"
		);
		let images = blocks
			.images
			.iter()
			.map(|image| (image.mime.as_str(), image.bytes.as_ref()))
			.collect::<Vec<_>>();
		assert_eq!(images, vec![
			("image/png", b"hello".as_slice()),
			("image/png", b"world".as_slice())
		]);
		assert_eq!(
			prompt_input(&params(json!({"prompt": [{"type": "image", "data": "aGVsbG8="}]}))).err(),
			Some("image content block requires mimeType")
		);
	}

	#[test]
	fn prompt_rejects_missing_and_malformed_content() {
		assert_eq!(prompt_input(&params(json!({}))).err(), Some("session/prompt requires a prompt"));
		assert_eq!(
			prompt_input(&params(json!({"prompt": [{"type": "text", "text": "  "}]}))).err(),
			Some("prompt contains no text")
		);
		assert_eq!(
			prompt_input(&params(
				json!({"prompt": [{"type": "image", "data": "%%%", "mimeType": "image/png"}]})
			))
			.err(),
			Some("image content block data is not valid base64")
		);
		assert_eq!(
			prompt_input(&params(json!({"prompt": [{"type": "video"}]}))).err(),
			Some("unsupported prompt content block")
		);
		let image_only = prompt_input(&params(json!({"prompt": [
			{"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
		]})))
		.expect("an image-only prompt is a valid turn");
		assert!(image_only.text.is_empty());
		assert_eq!(image_only.images.len(), 1);
	}
}
