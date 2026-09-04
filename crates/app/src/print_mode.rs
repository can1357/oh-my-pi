//! Single-shot adapter over the journal-first production agent kernel.
//!
//! Text mode keeps stdout clean for shell captures: the
//! only bytes written there are the final assistant response in provider block
//! order (including thinking when `--print-thoughts`), after every prompt
//! settled. Progress (`Working...`) and failures go to stderr, and a failed or
//! aborted turn exits non-zero.
//!
//! JSON mode is an NDJSON lifecycle stream: one `session` header, then
//! `agent_start` → `turn_start` → message/tool events → `turn_end` →
//! `agent_end` for each submitted prompt. A failed turn still closes with
//! `turn_end` and `agent_end`; the terminal assistant message carries
//! `stopReason` and `errorMessage` instead of the stream ending without a
//! terminal frame. Repeated message/partial snapshots are
//! always removed from `message_update`; its incremental
//! `assistantMessageEvent`, terminal messages, and tool results remain
//! complete.

use std::{
	fs,
	path::Path,
	sync::Arc,
	time::{Instant, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_agent::{DispatchError, KernelError, KernelEvent, RunControl, TurnInput, TurnStop, Up};
use omp_catalog::{ModelKey, RouteId, snapshot::Catalog};
use omp_core::{FastHashMap, Str, encoding::base64};
use omp_dom::{Dom, Event, Handle, KnownTag, Node, Op, PropId, PropKey, Sid, StreamOp, Tag, Value};
use omp_journal::{
	Journal,
	blob::{BlobRef, BlobStore},
	data::{Attachment, Genesis},
};
use omp_session::{ExitCause, ExitStatus, latest_session_exit};
use omp_tool::Part;
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;
use xutf::IntoAnsiStripped as _;

use crate::{
	chat_cmd::{Launch, LaunchEnv},
	cli::PrintArgs,
	usage_error::CliUsageError,
};

/// A print-mode failure already written to standard error.
#[derive(Debug, miette::Diagnostic, thiserror::Error)]
#[error("print request failed")]
pub struct PrintFailure;

/// Runs prompts through the new durable headless kernel.
pub async fn run(args: PrintArgs, piped_input: Option<Str>) -> miette::Result<()> {
	// The kernel owns the deadline and journals the terminal assistant before
	// returning. Wrapping the whole adapter in `timeout` could cancel stdout
	// between `turn_end` and `agent_end`, producing an invalid NDJSON tail.
	run_inner(args, piped_input).await
}

/// Output shaping selected by the print flags that are not launch flags.
struct PrintOptions {
	mode:           String,
	print_thoughts: bool,
}

async fn run_inner(args: PrintArgs, piped_input: Option<Str>) -> miette::Result<()> {
	let PrintArgs { launch, mode, print_thoughts, follow_ups } = args;
	let print_thoughts = print_thoughts && !launch.hide_thinking;
	let args = PrintOptions { mode, print_thoughts };
	if launch.from_claude || launch.from_codex {
		return Err(miette!("print mode does not accept interactive legacy session imports"));
	}
	let project = fs::canonicalize(&launch.project).into_diagnostic()?;
	let ctx = Arc::new(crate::process_ctx(&project)?);
	let env = LaunchEnv::production(&project, launch.gateway.is_some())?;
	let launch = Launch::prepare(launch, ctx, env).await?;
	let inputs = crate::chat_cmd::launch_input::prepare(&launch, piped_input, follow_ups)?;
	if inputs.first.is_none() {
		return Err(
			CliUsageError::new("print mode requires a prompt or piped standard input").into(),
		);
	}
	let (mut kernel, mut session) = launch.compose().await?;
	let catalog = Arc::clone(&launch.catalog);
	let ephemeral_path = launch
		.ephemeral
		.then(|| session.journal_path().to_path_buf());
	let session_id = session
		.journal_path()
		.file_stem()
		.and_then(|value| value.to_str())
		.unwrap_or("ephemeral")
		.to_owned();
	let (snapshot, events) = session.subscribe();
	let mut replica = Dom::from_snapshot(&snapshot);
	let mut json = JsonState::new(catalog, session.blobs().clone(), launch.model.clone());
	// Without an interactive UI, an approval-requiring call
	// is denied immediately (`--approval-mode yolo` or `tools.approval.<tool>
	// allow` opt it back in); the denial is journaled like any other.
	let kernel_events = kernel.subscribe();
	let mailbox = kernel.mailbox();
	let mut stdout = tokio::io::stdout();
	if args.mode == "json" {
		write_json_line(&mut stdout, &session_header_from_path(session.journal_path(), &session_id)?)
			.await?;
	}
	if let Some((_, exit)) = latest_session_exit(session.dom())
		&& exit.status != ExitStatus::Clean
	{
		if args.mode == "json" {
			write_json_line(&mut stdout, &serde_json::json!({"type": "session_exit", "exit": exit}))
				.await?;
		} else {
			let mut stderr = tokio::io::stderr();
			let message = omp_chat::notices::session_exit::text(&exit)
				.expect("non-clean exits have a transcript projection");
			stderr
				.write_all(message.as_bytes())
				.await
				.into_diagnostic()?;
			stderr.write_all(b"\n").await.into_diagnostic()?;
			stderr.flush().await.into_diagnostic()?;
		}
	}
	let mut prompts = Vec::with_capacity(1 + inputs.follow_ups.len());
	let first = inputs.first.expect("print input checked above");
	prompts.push(TurnInput {
		text:        first.text,
		attachments: session
			.store_attachments(first.attachments)
			.into_diagnostic()?,
	});
	prompts.extend(
		inputs
			.follow_ups
			.into_iter()
			.map(|text| TurnInput { text, attachments: Vec::new() }),
	);
	let first_turn = replica.children(replica.body()).len();

	if args.mode == "text" {
		tokio::io::stderr()
			.write_all(b"Working...\n")
			.await
			.into_diagnostic()?;
	}
	for prompt in prompts {
		let submission_turn = replica.children(replica.body()).len();
		if args.mode == "json" {
			write_json_line(&mut stdout, &serde_json::json!({"type":"agent_start"})).await?;
		}
		let (result, exit_signal) = {
			let deadline = launch.max_time.map(|duration| Instant::now() + duration);
			let cancellation = CancellationToken::new();
			let control = RunControl::new(cancellation.clone(), deadline);
			let turn = kernel.run_turn(&mut session, prompt, control);
			tokio::pin!(turn);
			let signal = crate::chat_cmd::process_signal();
			tokio::pin!(signal);
			let mut exit_signal = None;
			let mut signal_active = true;
			let result = loop {
				tokio::select! {
					biased;
					event = events.recv_async() => {
						if let Ok(event) = event {
							print_event(&mut stdout, &args, &mut replica, &mut json, event).await?;
						}
					},
					signal = &mut signal, if signal_active => {
						signal_active = false;
						if let Ok(signal) = signal {
							cancellation.cancel();
							exit_signal = Some(signal);
						}
					},
					event = kernel_events.recv_async() => {
						if let Ok(event) = event {
							print_kernel_event(
								&mut stdout,
								&args,
								&replica,
								&mut json,
								&mailbox,
								event,
							)
							.await?;
						}
					},
					result = &mut turn => break result,
				}
			};
			(result, exit_signal)
		};
		// The kernel journals how a turn ended (assistant close + notice)
		// before returning; those patches are still queued here and the
		// terminal frames must reflect them.
		while let Ok(event) = events.try_recv() {
			print_event(&mut stdout, &args, &mut replica, &mut json, event).await?;
		}
		while let Ok(event) = kernel_events.try_recv() {
			print_kernel_event(&mut stdout, &args, &replica, &mut json, &mailbox, event).await?;
		}
		if args.mode == "json" {
			for event in json.finish_turn(&replica) {
				write_json_line(&mut stdout, &event).await?;
			}
			write_json_line(&mut stdout, &agent_end_value_with(&replica, submission_turn, &json))
				.await?;
		}
		stdout.flush().await.into_diagnostic()?;
		if let Some(signal) = exit_signal {
			session
				.record_exit(ExitCause::Signal { signal: signal.clone() })
				.into_diagnostic()?;
			return Err(crate::exit_diagnostics::SignalExit::new(signal).into());
		}
		let stop = match result {
			Ok(outcome) => outcome.stop,
			Err(error) => {
				let message = sanitize_text(&error.to_string());
				let cause = kernel_exit_cause(&error, launch.model.as_str());
				session.record_exit(cause).into_diagnostic()?;
				report_print_failure(&message).await?;
				return Err(PrintFailure.into());
			},
		};
		if stop != TurnStop::Completed {
			let message = turn_error_message(&replica, submission_turn)
				.unwrap_or_else(|| Str::new(format!("Request {}", stop_reason_name(stop))));
			let cause = match stop {
				TurnStop::Failed => {
					let (provider, model) = launch
						.model
						.as_str()
						.split_once('/')
						.map_or((None, Some(launch.model.as_str())), |(provider, model)| {
							(Some(provider), Some(model))
						});
					ExitCause::provider(provider, model, None, Some(message.clone()))
				},
				TurnStop::Cancelled | TurnStop::Steered => {
					ExitCause::Process { exit_code: None, detail: Some(message.clone()) }
				},
				TurnStop::Completed => ExitCause::Normal,
			};
			session.record_exit(cause).into_diagnostic()?;
			report_print_failure(&sanitize_text(message.as_str())).await?;
			return Err(PrintFailure.into());
		}
		if args.mode == "text"
			&& let Some(message) = turn_error_message(&replica, submission_turn)
		{
			let mut stderr = tokio::io::stderr();
			stderr
				.write_all(sanitize_text(message.as_str()).as_bytes())
				.await
				.into_diagnostic()?;
			stderr.write_all(b"\n").await.into_diagnostic()?;
			stderr.flush().await.into_diagnostic()?;
		}
	}

	if args.mode == "text" {
		stdout
			.write_all(final_response_text(&replica, first_turn, args.print_thoughts).as_bytes())
			.await
			.into_diagnostic()?;
		stdout.flush().await.into_diagnostic()?;
	}

	session.record_exit(ExitCause::Normal).into_diagnostic()?;
	drop(session);
	if let Some(path) = ephemeral_path {
		let _ = fs::remove_file(path);
	}
	Ok(())
}

async fn report_print_failure(message: &str) -> miette::Result<()> {
	let mut stderr = tokio::io::stderr();
	stderr
		.write_all(message.as_bytes())
		.await
		.into_diagnostic()?;
	stderr.write_all(b"\n").await.into_diagnostic()?;
	stderr.flush().await.into_diagnostic()
}

fn kernel_exit_cause(error: &KernelError, model: &str) -> ExitCause {
	let detail = Some(Str::new(error.to_string()));
	let (provider, model) = model
		.split_once('/')
		.map_or((None, Some(model)), |(provider, model)| (Some(provider), Some(model)));
	match error {
		KernelError::Inference(_) => ExitCause::provider(provider, model, None, detail),
		KernelError::Dispatch(DispatchError::Join(_)) => {
			ExitCause::worker(None::<Str>, None, None, detail)
		},
		KernelError::Dispatch(_) | KernelError::Registry(_) => {
			ExitCause::tool(None::<Str>, None::<Str>, detail)
		},
		_ => ExitCause::Process { exit_code: None, detail },
	}
}

/// Stop-reason vocabulary for a turn that did not complete.
const fn stop_reason_name(stop: TurnStop) -> &'static str {
	match stop {
		TurnStop::Completed => "stop",
		TurnStop::Cancelled | TurnStop::Steered => "aborted",
		TurnStop::Failed => "error",
	}
}

/// The final `agent_end` frame: every message the submission produced, with
/// the terminal assistant carrying `stopReason`/`errorMessage` when the turn
/// failed or was aborted.
#[cfg(test)]
fn agent_end_value(dom: &Dom, first_turn: usize) -> serde_json::Value {
	serde_json::json!({
		"type": "agent_end",
		"messages": transcript_messages_from(dom, first_turn),
		"isTerminal": true,
	})
}

fn agent_end_value_with(dom: &Dom, first_turn: usize, state: &JsonState) -> serde_json::Value {
	serde_json::json!({
		"type": "agent_end",
		"messages": transcript_messages_from_with(dom, first_turn, state),
		"isTerminal": true,
	})
}

/// The journaled reason the newest turn at or after `first_turn` failed or
/// was interrupted: the content of its last `<notice kind=error|warn>`.
fn turn_error_message(dom: &Dom, first_turn: usize) -> Option<Str> {
	let turns = dom.children(dom.body());
	turns
		.iter()
		.skip(first_turn)
		.rev()
		.find_map(|turn| turn_failure_notice(dom, *turn))
}

/// The last `<notice kind=error|warn>` under `turn`, which is how the kernel
/// journals a failed or interrupted turn.
fn turn_failure_notice(dom: &Dom, turn: Handle) -> Option<Str> {
	dom.children(turn).iter().rev().find_map(|handle| {
		let node = dom.get(*handle)?;
		if node.tag != Tag::Known(KnownTag::Notice) {
			return None;
		}
		match node_text(node, PropId::Kind) {
			Some("error" | "warn") => node.content.clone(),
			_ => None,
		}
	})
}

fn terminal_assistant_message(dom: &Dom, turn: Handle, state: &JsonState) -> serde_json::Value {
	let spec = state
		.catalog
		.model(&ModelKey::from(state.model.as_str()))
		.or_else(|| state.catalog.resolve_alias(state.model.as_str()));
	let route = spec
		.and_then(|spec| spec.routes.first())
		.and_then(|route| state.catalog.route(route));
	let provider = route
		.map(|route| route.provider.as_str())
		.or_else(|| state.model.split_once('/').map(|(provider, _)| provider))
		.unwrap_or("unknown");
	let api = route.map_or("unknown", |route| pi_api(provider, route.codec.as_str()));
	let reason = dom
		.children(turn)
		.iter()
		.rev()
		.find_map(|handle| {
			let node = dom.get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Notice))
				.then(|| node_text(node, PropId::Kind))
				.flatten()
		})
		.map_or("error", |kind| if kind == "warn" { "aborted" } else { "error" });
	let error =
		turn_failure_notice(dom, turn).unwrap_or_else(|| Str::new(format!("Request {reason}")));
	let timestamp = dom
		.get(turn)
		.map_or(0, |node| node_timestamp_ms(node, PropId::Id));
	let completed_at = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX));
	serde_json::json!({
		"role": "assistant",
		"content": [],
		"api": api,
		"provider": provider,
		"model": pi_model_id(
			provider,
			spec.map_or(state.model.as_str(), |spec| spec.key.as_str()),
		),
		"usage": usage_value(None),
		"stopReason": reason,
		"errorMessage": error,
		"timestamp": timestamp,
		"completedAt": completed_at,
	})
}

/// Text-mode stdout: the last assistant response across the submitted
/// prompts, in provider block order, with thinking included when requested.
/// Intermediate assistant messages before tool calls and the tool calls
/// themselves never reach stdout.
fn final_response_text(dom: &Dom, first_turn: usize, print_thoughts: bool) -> String {
	let mut output = String::new();
	let Some(assistant) = dom
		.children(dom.body())
		.iter()
		.skip(first_turn)
		.rev()
		.find_map(|turn| last_assistant(dom, *turn))
	else {
		return output;
	};
	let Some(node) = dom.get(assistant) else {
		return output;
	};
	let blocks = ordered_assistant_nodes(dom, assistant);
	if blocks.is_empty() {
		if print_thoughts
			&& let Some(thinking) = node_text(node, PropId::Thinking)
			&& !thinking.trim().is_empty()
		{
			output.push_str(thinking);
			output.push('\n');
		}
		let text = node_text(node, PropId::Text)
			.or(node.content.as_deref())
			.unwrap_or_default();
		if !text.is_empty() {
			output.push_str(text);
			output.push('\n');
		}
		return sanitize_text(&output);
	}
	for block in blocks {
		let Some(kind) = node_text(block, PropId::Kind) else {
			continue;
		};
		if kind == "thinking" && !print_thoughts {
			continue;
		}
		if matches!(kind, "text" | "thinking")
			&& let Some(text) = node_text(block, PropId::Text)
			&& !text.is_empty()
		{
			output.push_str(text);
			output.push('\n');
		}
	}
	sanitize_text(&output)
}

fn last_assistant(dom: &Dom, turn: Handle) -> Option<Handle> {
	dom.children(turn).iter().rev().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
	})
}

#[derive(Clone, Copy)]
enum PrintedStream {
	Text { assistant: Handle, index: u32 },
	Thinking { assistant: Handle, index: u32 },
	ToolArguments(Handle),
	ToolResult { call: Handle, node: Handle },
}

struct JsonState {
	streams:             FastHashMap<Sid, PrintedStream>,
	open_turn:           Option<Handle>,
	round_assistant:     Option<Handle>,
	round_tools:         Vec<Handle>,
	call_indices:        FastHashMap<Handle, u32>,
	call_saw_delta:      FastHashMap<Handle, bool>,
	next_content_index:  u32,
	pending_message_end: Option<Handle>,
	pending_tool_starts: Vec<Handle>,
	retry_attempt:       Option<u32>,
	terminal_messages:   FastHashMap<Handle, serde_json::Value>,
	node_timestamps:     FastHashMap<Handle, u64>,
	model:               Str,
	catalog:             Arc<Catalog>,
	blobs:               BlobStore,
}

impl JsonState {
	fn new(catalog: Arc<Catalog>, blobs: BlobStore, model: Str) -> Self {
		Self {
			streams: FastHashMap::default(),
			open_turn: None,
			round_assistant: None,
			round_tools: Vec::new(),
			call_indices: FastHashMap::default(),
			call_saw_delta: FastHashMap::default(),
			next_content_index: 0,
			pending_message_end: None,
			pending_tool_starts: Vec::new(),
			retry_attempt: None,
			terminal_messages: FastHashMap::default(),
			node_timestamps: FastHashMap::default(),
			model,
			catalog,
			blobs,
		}
	}

	fn flush_message_end(&mut self, dom: &Dom, values: &mut Vec<serde_json::Value>) {
		if let Some(assistant) = self.pending_message_end.take() {
			values.push(serde_json::json!({
				"type": "message_end",
				"message": message_value_with(dom, assistant, self),
			}));
		}
		for call in std::mem::take(&mut self.pending_tool_starts) {
			values.push(tool_execution_start(dom, call));
		}
	}

	fn finish_turn(&mut self, dom: &Dom) -> Vec<serde_json::Value> {
		let mut values = Vec::with_capacity(2);
		self.flush_message_end(dom, &mut values);
		let Some(turn) = self.open_turn.take() else {
			return values;
		};
		let assistant = self
			.round_assistant
			.take()
			.or_else(|| last_assistant(dom, turn));
		let tools = std::mem::take(&mut self.round_tools);
		if let Some(assistant) = assistant {
			values.push(turn_end_value_with(dom, Some(assistant), &tools, self));
		} else {
			let message = terminal_assistant_message(dom, turn, self);
			values.push(serde_json::json!({"type":"message_start","message":message.clone()}));
			values.push(serde_json::json!({"type":"message_end","message":message.clone()}));
			values.push(serde_json::json!({
				"type": "turn_end",
				"message": message.clone(),
				"toolResults": [],
			}));
			self.terminal_messages.insert(turn, message);
		}
		self.next_content_index = 0;
		values
	}

	fn begin_round(&mut self, turn: Handle) {
		self.open_turn = Some(turn);
		self.round_assistant = None;
		self.round_tools.clear();
		self.next_content_index = 0;
	}
}

/// Folds one session event into the replica; JSON mode additionally writes
/// the projected lifecycle frames. Text mode writes nothing here: its stdout
/// is the final response, written once every prompt settled.
async fn print_event(
	stdout: &mut tokio::io::Stdout,
	args: &PrintOptions,
	replica: &mut Dom,
	state: &mut JsonState,
	event: Event,
) -> miette::Result<()> {
	let values = project_print_event(args, replica, state, event)?;
	if args.mode == "json" {
		for value in values {
			write_json_line(stdout, &value).await?;
		}
	}
	Ok(())
}

async fn print_kernel_event(
	stdout: &mut tokio::io::Stdout,
	args: &PrintOptions,
	dom: &Dom,
	state: &mut JsonState,
	mailbox: &flume::Sender<Up>,
	event: KernelEvent,
) -> miette::Result<()> {
	let value = match event {
		KernelEvent::ApprovalRequested(ticket) => {
			let _ = mailbox.send(Up::Approve {
				id:       ticket.ticket_id,
				decision: omp_agent::ApprovalDecision {
					approved:   false,
					scope:      omp_agent::ApprovalScope::Once,
					source:     omp_agent::ApprovalSource::Unavailable,
					decided_by: None,
					reason:     Some(Str::new_static(
						"requires approval but no interactive UI is available; use --approval-mode yolo \
						 or tools.approval.<tool> allow",
					)),
					audited:    false,
				},
			});
			None
		},
		KernelEvent::InferenceRetry { attempt, max_attempts, delay, reason } => {
			state.retry_attempt = Some(attempt);
			Some(serde_json::json!({
				"type": "auto_retry_start",
				"attempt": attempt,
				"maxAttempts": max_attempts,
				"delayMs": u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
				"errorMessage": reason,
			}))
		},
		KernelEvent::InferenceStarted => None,
		KernelEvent::TurnEnded { stop } => state.retry_attempt.take().map(|attempt| {
			let success = stop == TurnStop::Completed;
			let mut value = serde_json::json!({
				"type": "auto_retry_end",
				"success": success,
				"attempt": attempt,
			});
			if !success {
				if let Some(message) = state
					.open_turn
					.and_then(|turn| turn_failure_notice(dom, turn))
				{
					value["finalError"] = serde_json::json!(message);
				} else {
					value["finalError"] =
						serde_json::json!(format!("Request {}", stop_reason_name(stop)));
				}
			}
			value
		}),
		KernelEvent::CompactionSpeculating { .. } => Some(serde_json::json!({
			"type": "auto_compaction_start",
			"reason": "threshold",
			"action": "context-full",
		})),
		KernelEvent::CompactionSettled { applied } => Some(serde_json::json!({
			"type": "auto_compaction_end",
			"action": "context-full",
			"aborted": !applied,
			"willRetry": false,
		})),
		KernelEvent::TextDelta(_)
		| KernelEvent::ThinkingDelta(_)
		| KernelEvent::Usage { .. }
		| KernelEvent::ToolReady { .. }
		| KernelEvent::ToolUpdate { .. }
		| KernelEvent::ToolSettled { .. }
		| KernelEvent::JobsDelivered { .. }
		| KernelEvent::WorkflowActionAnswered { .. } => None,
	};
	if args.mode == "json"
		&& let Some(value) = value
	{
		write_json_line(stdout, &value).await?;
	}
	Ok(())
}

fn project_print_event(
	_args: &PrintOptions,
	replica: &mut Dom,
	state: &mut JsonState,
	event: Event,
) -> miette::Result<Vec<serde_json::Value>> {
	let mut values = Vec::new();
	let mut inserted = Vec::new();
	let mut appended = None;
	let mut opened = None;
	let mut closed = None;
	let mut terminal_calls = Vec::new();

	match &event {
		Event::Patch(patch) => {
			let mut next = replica.high_water() + 1;
			for op in &patch.ops {
				match op {
					Op::Ins { node, .. } => {
						if node.tag == Tag::Known(KnownTag::Turn) {
							values.extend(state.finish_turn(replica));
						}
						if let Some(handle) = Handle::new(next) {
							inserted.push((handle, node.tag.clone()));
							state
								.node_timestamps
								.insert(handle, patch.cause.as_ulid().timestamp_ms());
						}
						next += 1;
					},
					Op::Set { h, prop, value }
						if *prop == PropId::Status.into()
							&& matches!(
								value.as_str(),
								Some("ok" | "error" | "cancelled" | "aborted")
							) =>
					{
						terminal_calls.push(*h);
					},
					_ => {},
				}
			}
		},
		Event::Stream { sid, op: StreamOp::Open, node: Some(node), prop: Some(prop), .. } => {
			opened = replica.get(*node).and_then(|target| match &target.tag {
				Tag::Custom(tag)
					if tag.as_str() == omp_session::ASSISTANT_CONTENT_TAG
						&& *prop == PropId::Text.into() =>
				{
					let assistant = replica.parent(*node)?;
					let index = provider_block_index(target);
					match node_text(target, PropId::Kind) {
						Some("text") => Some(PrintedStream::Text { assistant, index }),
						Some("thinking") => Some(PrintedStream::Thinking { assistant, index }),
						_ => None,
					}
				},
				Tag::Known(KnownTag::Assistant) if *prop == PropId::Text.into() => {
					Some(PrintedStream::Text { assistant: *node, index: 0 })
				},
				Tag::Known(KnownTag::Assistant) if *prop == PropId::Thinking.into() => {
					Some(PrintedStream::Thinking { assistant: *node, index: 0 })
				},
				Tag::Known(KnownTag::Input) => replica.parent(*node).map(PrintedStream::ToolArguments),
				Tag::Known(KnownTag::Result | KnownTag::Diag) => replica
					.parent(*node)
					.map(|call| PrintedStream::ToolResult { call, node: *node }),
				_ => None,
			});
			if let Some(target) = opened {
				state.streams.insert(*sid, target);
			}
		},
		Event::Stream { sid, op: StreamOp::Append, text: Some(delta), .. } => {
			appended = state
				.streams
				.get(sid)
				.copied()
				.map(|stream| (stream, delta.clone()));
		},
		Event::Stream { sid, op: StreamOp::Close, .. } => {
			closed = state.streams.get(sid).copied();
		},
		Event::Reset { .. } => {
			state.streams.clear();
			state.open_turn = None;
			state.round_assistant = None;
			state.round_tools.clear();
			state.call_indices.clear();
			state.call_saw_delta.clear();
			state.pending_message_end = None;
			state.pending_tool_starts.clear();
			state.next_content_index = 0;
			state.terminal_messages.clear();
			state.node_timestamps.clear();
		},
		Event::Stream { .. } => {},
	}

	replica.apply_event(&event).into_diagnostic()?;

	for (handle, tag) in inserted {
		match tag {
			Tag::Known(KnownTag::Turn) => {
				state.begin_round(handle);
				values.push(serde_json::json!({"type":"turn_start"}));
			},
			Tag::Known(KnownTag::User) => {
				let message = message_value_with(replica, handle, state);
				values.push(serde_json::json!({
					"type": "message_start",
					"message": message.clone(),
				}));
				values.push(serde_json::json!({"type":"message_end","message":message}));
			},
			Tag::Known(KnownTag::Assistant) => {
				if state.round_assistant.is_some() {
					let turn = replica.parent(handle).unwrap_or(replica.body());
					values.extend(state.finish_turn(replica));
					state.begin_round(turn);
					values.push(serde_json::json!({"type":"turn_start"}));
				}
				state.round_assistant = Some(handle);
				values.push(serde_json::json!({
					"type": "message_start",
					"message": message_value_with(replica, handle, state),
				}));
			},
			Tag::Known(KnownTag::Usage) => {
				if replica.parent(handle) == state.open_turn {
					state.flush_message_end(replica, &mut values);
				}
			},
			Tag::Known(KnownTag::Notice) => {
				let Some(node) = replica.get(handle) else {
					continue;
				};
				let level = match node_text(node, PropId::Kind) {
					Some("error") => "error",
					Some("warn" | "warning") => "warning",
					_ => "info",
				};
				let mut value = serde_json::json!({
					"type": "notice",
					"level": level,
					"message": node.content.as_deref().unwrap_or_default(),
				});
				if let Some(source) = node
					.prop(&PropKey::Custom(Str::new_static("name")))
					.or_else(|| node.prop(&PropKey::Known(PropId::Name)))
					.and_then(Value::as_str)
				{
					value["source"] = serde_json::json!(source);
				}
				values.push(value);
			},
			Tag::Known(KnownTag::Diag) => {
				if let Some(call) = replica.parent(handle)
					&& matches!(replica.get(call).map(|node| &node.tag), Some(Tag::Custom(_)))
					&& prop_text(replica.get(call), PropId::Status) == Some("running")
				{
					values.push(tool_execution_update_from(replica, call, handle));
				}
			},
			Tag::Custom(tag) if tag.as_str() == omp_session::ASSISTANT_CONTENT_TAG => {
				state.next_content_index = state
					.next_content_index
					.max(provider_block_index(replica.get(handle).unwrap()) + 1);
			},
			Tag::Custom(tag) if tag.as_str() == "artifact" => {
				let Some(node) = replica.get(handle) else {
					continue;
				};
				let index = provider_block_index(node);
				state.next_content_index = state.next_content_index.max(index + 1);
				if let Some(assistant) = replica.parent(handle)
					&& let Some(content) = assistant_block_value_with(node, &state.blobs)
				{
					values.push(printable_message_update(serde_json::json!({
						"type": "image_end",
						"contentIndex": index,
						"content": content,
					})));
					state.round_assistant = Some(assistant);
				}
			},
			Tag::Custom(_) => {
				let index = state.next_content_index;
				state.next_content_index = state.next_content_index.saturating_add(1);
				state.call_indices.insert(handle, index);
				state.call_saw_delta.insert(handle, false);
				state.round_tools.push(handle);
				values.push(tool_call_start(index));
				if prop_text(replica.get(handle), PropId::Status) == Some("running") {
					let delta = serde_json::to_string(&tool_args(replica, handle))
						.unwrap_or_else(|_| "{}".to_owned());
					values.push(tool_call_delta(index, &delta));
					state.call_saw_delta.insert(handle, true);
					values.push(tool_call_end(replica, handle, index));
					state.pending_tool_starts.push(handle);
				}
			},
			_ => {},
		}
	}

	if let Some(stream) = opened {
		match stream {
			PrintedStream::Text { index, .. } => {
				state.next_content_index = state.next_content_index.max(index + 1);
				values.push(printable_message_update(serde_json::json!({
					"type": "text_start",
					"contentIndex": index,
				})));
			},
			PrintedStream::Thinking { index, .. } => {
				state.next_content_index = state.next_content_index.max(index + 1);
				values.push(printable_message_update(serde_json::json!({
					"type": "thinking_start",
					"contentIndex": index,
				})));
			},
			PrintedStream::ToolArguments(_) | PrintedStream::ToolResult { .. } => {},
		}
	}

	if let Some((stream, delta)) = appended {
		match stream {
			PrintedStream::Text { index, .. } => {
				values.push(message_delta(index, "text_delta", delta.as_str()));
			},
			PrintedStream::Thinking { index, .. } => {
				values.push(message_delta(index, "thinking_delta", delta.as_str()));
			},
			PrintedStream::ToolArguments(call) => {
				let index = call_index(state, call);
				state.call_saw_delta.insert(call, true);
				values.push(tool_call_delta(index, delta.as_str()));
			},
			PrintedStream::ToolResult { call, node } => {
				values.push(tool_execution_update_from(replica, call, node));
			},
		}
	}

	if let Some(stream) = closed {
		match stream {
			PrintedStream::Text { assistant, index } => {
				values.push(printable_message_update(serde_json::json!({
					"type": "text_end",
					"contentIndex": index,
					"content": content_text(replica, assistant, index, "text"),
				})));
			},
			PrintedStream::Thinking { assistant, index } => {
				values.push(printable_message_update(serde_json::json!({
					"type": "thinking_end",
					"contentIndex": index,
					"content": content_text(replica, assistant, index, "thinking"),
				})));
			},
			PrintedStream::ToolArguments(_) | PrintedStream::ToolResult { .. } => {},
		}
	}

	if let Event::Patch(patch) = &event {
		let mut updated_calls = Vec::new();
		for op in &patch.ops {
			let Op::Set { h, prop, value } = op else {
				continue;
			};
			if *prop == PropId::StopReason.into()
				&& replica
					.get(*h)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			{
				state.pending_message_end = Some(*h);
			} else if *prop == PropId::Status.into()
				&& matches!(replica.get(*h).map(|node| &node.tag), Some(Tag::Custom(_)))
			{
				match value.as_str() {
					Some("running") => {
						let index = call_index(state, *h);
						if !state.call_saw_delta.get(h).copied().unwrap_or(false) {
							let delta = serde_json::to_string(&tool_args(replica, *h))
								.unwrap_or_else(|_| "{}".to_owned());
							values.push(tool_call_delta(index, &delta));
							state.call_saw_delta.insert(*h, true);
						}
						values.push(tool_call_end(replica, *h, index));
						if !state.pending_tool_starts.contains(h) {
							state.pending_tool_starts.push(*h);
						}
					},
					Some("ok" | "error" | "cancelled" | "aborted") => {
						state.flush_message_end(replica, &mut values);
						let result = tool_result_value_with(replica, *h, &state.blobs);
						values.push(tool_execution_end_with(replica, *h, &state.blobs));
						values.push(serde_json::json!({
							"type": "message_start",
							"message": result.clone(),
						}));
						values.push(serde_json::json!({
							"type": "message_end",
							"message": result,
						}));
					},
					_ => {},
				}
			} else if *prop == PropId::Data.into()
				&& !terminal_calls
					.iter()
					.any(|call| replica.parent(*h) == Some(*call))
				&& let Some(call) = replica.parent(*h)
				&& matches!(replica.get(call).map(|node| &node.tag), Some(Tag::Custom(_)))
				&& replica.get(*h).is_some_and(|node| {
					matches!(node.tag, Tag::Known(KnownTag::Result | KnownTag::Diag | KnownTag::Usage))
				}) && !updated_calls.contains(&call)
			{
				updated_calls.push(call);
				values.push(tool_execution_update_from(replica, call, *h));
			}
		}
	}
	if let Event::Stream { sid, op: StreamOp::Close, .. } = event {
		state.streams.remove(&sid);
	}
	Ok(values)
}

fn session_header_from_path(path: &Path, id: &str) -> miette::Result<serde_json::Value> {
	let entries = Journal::scan(path).into_diagnostic()?;
	let genesis = entries
		.first()
		.ok_or_else(|| miette!("session journal has no genesis frame"))?;
	let payload: Genesis = serde_json::from_str(genesis.data.as_str()).into_diagnostic()?;
	let created_ms = payload.created.parse::<i64>().into_diagnostic()?;
	let mut timestamp = jiff::Timestamp::from_millisecond(created_ms)
		.map_err(|error| miette!(error))?
		.to_string();
	match (timestamp.find('.'), timestamp.rfind('Z')) {
		(None, Some(z)) => timestamp.insert_str(z, ".000"),
		(Some(dot), Some(z)) if z.saturating_sub(dot + 1) < 3 => {
			timestamp.insert_str(z, &"0".repeat(3 - z.saturating_sub(dot + 1)));
		},
		_ => {},
	}
	Ok(serde_json::json!({
		"type": "session",
		"version": 3,
		"id": id,
		"timestamp": timestamp,
		"cwd": payload.cwd,
	}))
}

#[cfg(test)]
fn session_header(id: &str, model: &str) -> serde_json::Value {
	serde_json::json!({"type":"session","version":1,"id":id,"model":model})
}

async fn write_json_line(
	stdout: &mut tokio::io::Stdout,
	value: &serde_json::Value,
) -> miette::Result<()> {
	let mut line = serde_json::to_vec(value).into_diagnostic()?;
	line.push(b'\n');
	stdout.write_all(&line).await.into_diagnostic()
}

fn message_delta(index: u32, kind: &str, delta: &str) -> serde_json::Value {
	printable_message_update(serde_json::json!({
		"type": kind,
		"contentIndex": index,
		"delta": delta,
	}))
}

fn printable_message_update(stream: serde_json::Value) -> serde_json::Value {
	// Partial snapshots and the
	// outer message are intentionally absent so NDJSON grows linearly.
	serde_json::json!({"type":"message_update","assistantMessageEvent":stream})
}

#[cfg(test)]
fn shaped_message_update(
	dom: &Dom,
	assistant: Handle,
	mut stream: serde_json::Value,
	shaped: bool,
) -> serde_json::Value {
	let mut event = printable_message_update(stream.clone());
	if !shaped {
		let message = message_value(dom, assistant);
		stream["partial"] = message.clone();
		event["message"] = message;
		event["assistantMessageEvent"] = stream;
	}
	event
}

fn call_index(state: &mut JsonState, call: Handle) -> u32 {
	if let Some(index) = state.call_indices.get(&call) {
		return *index;
	}
	let index = state.next_content_index;
	state.next_content_index = state.next_content_index.saturating_add(1);
	state.call_indices.insert(call, index);
	index
}

fn tool_call_start(index: u32) -> serde_json::Value {
	printable_message_update(serde_json::json!({
		"type": "toolcall_start",
		"contentIndex": index,
	}))
}

fn tool_call_delta(index: u32, delta: &str) -> serde_json::Value {
	printable_message_update(serde_json::json!({
		"type": "toolcall_delta",
		"contentIndex": index,
		"delta": delta,
	}))
}

fn tool_call_end(dom: &Dom, call: Handle, index: u32) -> serde_json::Value {
	printable_message_update(serde_json::json!({
		"type": "toolcall_end",
		"contentIndex": index,
		"toolCall": tool_call_value(dom, call),
	}))
}

fn tool_call_value(dom: &Dom, call: Handle) -> serde_json::Value {
	let mut value = serde_json::json!({
		"type": "toolCall",
		"id": prop_text(dom.get(call), PropId::Id).unwrap_or_default(),
		"name": tool_name(dom.get(call)).unwrap_or_default(),
		"arguments": tool_args(dom, call),
	});
	if let Some(intent) = prop_text(dom.get(call), PropId::I) {
		value["intent"] = serde_json::json!(intent);
	}
	value
}

fn tool_execution_start(dom: &Dom, call: Handle) -> serde_json::Value {
	let mut value = serde_json::json!({
		"type": "tool_execution_start",
		"toolCallId": prop_text(dom.get(call), PropId::Id).unwrap_or_default(),
		"toolName": tool_name(dom.get(call)).unwrap_or_default(),
		"args": tool_args(dom, call),
	});
	if let Some(intent) = prop_text(dom.get(call), PropId::I) {
		value["intent"] = serde_json::json!(intent);
	}
	value
}

fn tool_execution_update_from(dom: &Dom, call: Handle, update: Handle) -> serde_json::Value {
	let partial = dom.get(update).map_or_else(
		|| serde_json::json!({"content":[],"details":{}}),
		|node| {
			let text = node
				.content
				.as_deref()
				.or_else(|| node_text(node, PropId::Text))
				.unwrap_or_default();
			let details = node
				.prop(&PropKey::Known(PropId::Data))
				.and_then(|value| match value {
					Value::Json(raw) => serde_json::from_str::<serde_json::Value>(raw.get()).ok(),
					_ => None,
				})
				.unwrap_or_else(|| serde_json::json!({}));
			serde_json::json!({
				"content": [{"type":"text","text":text}],
				"details": details,
			})
		},
	);
	serde_json::json!({
		"type": "tool_execution_update",
		"toolCallId": prop_text(dom.get(call), PropId::Id).unwrap_or_default(),
		"toolName": tool_name(dom.get(call)).unwrap_or_default(),
		"args": tool_args(dom, call),
		"partialResult": partial,
	})
}

fn tool_execution_end_with(dom: &Dom, call: Handle, blobs: &BlobStore) -> serde_json::Value {
	serde_json::json!({
		"type": "tool_execution_end",
		"toolCallId": prop_text(dom.get(call), PropId::Id).unwrap_or_default(),
		"toolName": tool_name(dom.get(call)).unwrap_or_default(),
		"result": tool_result_payload(dom, call, Some(blobs)),
		"isError": tool_is_error(dom, call),
	})
}

fn turn_end_value_with(
	dom: &Dom,
	assistant: Option<Handle>,
	tools: &[Handle],
	state: &JsonState,
) -> serde_json::Value {
	let message =
		assistant.map_or(serde_json::Value::Null, |handle| message_value_with(dom, handle, state));
	let tool_results = tools
		.iter()
		.copied()
		.filter(|handle| {
			matches!(
				prop_text(dom.get(*handle), PropId::Status),
				Some("ok" | "error" | "cancelled" | "aborted")
			)
		})
		.map(|handle| tool_result_value_with(dom, handle, &state.blobs))
		.collect::<Vec<_>>();
	serde_json::json!({
		"type": "turn_end",
		"message": message,
		"toolResults": tool_results,
	})
}

#[cfg(test)]
fn turn_end_value(dom: &Dom, turn: Handle) -> serde_json::Value {
	let assistant = last_assistant(dom, turn);
	let tools = dom
		.children(turn)
		.iter()
		.copied()
		.filter(|handle| matches!(dom.get(*handle).map(|node| &node.tag), Some(Tag::Custom(_))))
		.collect::<Vec<_>>();
	let message = assistant.map_or(serde_json::Value::Null, |handle| message_value(dom, handle));
	let tool_results = tools
		.into_iter()
		.filter(|handle| {
			matches!(
				prop_text(dom.get(*handle), PropId::Status),
				Some("ok" | "error" | "cancelled" | "aborted")
			)
		})
		.map(|handle| tool_result_value(dom, handle))
		.collect::<Vec<_>>();
	serde_json::json!({
		"type": "turn_end",
		"message": message,
		"toolResults": tool_results,
	})
}

#[cfg(test)]
fn transcript_messages_from(dom: &Dom, first_turn: usize) -> Vec<serde_json::Value> {
	let mut messages = Vec::new();
	for turn in dom.children(dom.body()).iter().skip(first_turn) {
		for handle in dom.children(*turn) {
			match dom.get(*handle).map(|node| &node.tag) {
				Some(Tag::Known(KnownTag::User | KnownTag::Assistant)) => {
					messages.push(message_value(dom, *handle));
				},
				Some(Tag::Custom(_))
					if matches!(
						prop_text(dom.get(*handle), PropId::Status),
						Some("ok" | "error" | "cancelled" | "aborted")
					) =>
				{
					messages.push(tool_result_value(dom, *handle));
				},
				_ => {},
			}
		}
	}
	messages
}

fn transcript_messages_from_with(
	dom: &Dom,
	first_turn: usize,
	state: &JsonState,
) -> Vec<serde_json::Value> {
	let mut messages = Vec::new();
	for turn in dom.children(dom.body()).iter().skip(first_turn) {
		let mut saw_assistant = false;
		for handle in dom.children(*turn) {
			match dom.get(*handle).map(|node| &node.tag) {
				Some(Tag::Known(KnownTag::User)) => {
					messages.push(message_value_with(dom, *handle, state));
				},
				Some(Tag::Known(KnownTag::Assistant)) => {
					saw_assistant = true;
					messages.push(message_value_with(dom, *handle, state));
				},
				Some(Tag::Known(KnownTag::Developer)) => {
					let node = dom.get(*handle).expect("matched developer node");
					messages.push(serde_json::json!({
						"role": "developer",
						"content": node.content.as_deref().unwrap_or_default(),
						"timestamp": state
							.node_timestamps
							.get(handle)
							.copied()
							.unwrap_or_else(|| node_timestamp_ms(node, PropId::Id)),
					}));
				},
				Some(Tag::Custom(_))
					if matches!(
						prop_text(dom.get(*handle), PropId::Status),
						Some("ok" | "error" | "cancelled" | "aborted")
					) =>
				{
					messages.push(tool_result_value_with(dom, *handle, &state.blobs));
				},
				_ => {},
			}
		}
		if !saw_assistant && let Some(message) = state.terminal_messages.get(turn) {
			messages.push(message.clone());
		}
	}
	messages
}

#[cfg(test)]
fn message_value(dom: &Dom, handle: Handle) -> serde_json::Value {
	message_value_impl(dom, handle, None)
}

fn message_value_with(dom: &Dom, handle: Handle, state: &JsonState) -> serde_json::Value {
	message_value_impl(dom, handle, Some(state))
}

fn message_value_impl(dom: &Dom, handle: Handle, state: Option<&JsonState>) -> serde_json::Value {
	let Some(node) = dom.get(handle) else {
		return serde_json::Value::Null;
	};
	if node.tag == Tag::Known(KnownTag::User) {
		let content = user_content(node, state.map(|state| &state.blobs));
		let mut message = serde_json::json!({
			"role": "user",
			"content": content,
			"timestamp": state
				.and_then(|state| state.node_timestamps.get(&handle).copied())
				.unwrap_or_else(|| node_timestamp_ms(node, PropId::Id)),
		});
		let steering = custom_bool(node, "steering");
		if steering {
			message["steering"] = serde_json::Value::Bool(true);
		}
		let synthetic = node_bool(node, PropId::Synthetic)
			|| custom_bool(node, "async_result")
			|| custom_bool(node, "launch_completion");
		if synthetic {
			message["synthetic"] = serde_json::Value::Bool(true);
			message["attribution"] = serde_json::Value::String("agent".to_owned());
		}
		return message;
	}

	let mut indexed = ordered_assistant_nodes(dom, handle)
		.into_iter()
		.enumerate()
		.filter_map(|(position, node)| {
			assistant_block_value_impl(node, state.map(|state| &state.blobs))
				.map(|value| (provider_block_index(node), position, value))
		})
		.collect::<Vec<_>>();
	// Journals written before ordered assistant-content children stored text
	// and thinking directly on the assistant. Preserve those blocks even when
	// a following tool call makes the indexed content list non-empty.
	if indexed.is_empty() {
		if let Some(thinking) = node_text(node, PropId::Thinking)
			&& !thinking.is_empty()
		{
			indexed.push((0, 0, serde_json::json!({"type":"thinking","thinking":thinking})));
		}
		if let Some(text) = node_text(node, PropId::Text)
			.or(node.content.as_deref())
			.filter(|text| !text.is_empty())
		{
			let position = indexed.len();
			let index = u32::try_from(position).unwrap_or(u32::MAX);
			indexed.push((index, position, serde_json::json!({"type":"text","text":text})));
		}
	}
	let mut next_index = indexed
		.iter()
		.map(|(index, ..)| index.saturating_add(1))
		.max()
		.unwrap_or_default();
	if let Some(turn) = dom.parent(handle) {
		let children = dom.children(turn);
		let start = children
			.iter()
			.position(|candidate| *candidate == handle)
			.map_or(0, |position| position + 1);
		for call in children.iter().skip(start) {
			if dom
				.get(*call)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			{
				break;
			}
			if !matches!(dom.get(*call).map(|node| &node.tag), Some(Tag::Custom(_))) {
				continue;
			}
			let index = state
				.and_then(|state| state.call_indices.get(call).copied())
				.or_else(|| {
					dom.get(*call)
						.and_then(|node| {
							node.prop(&PropKey::Custom(Str::new_static(
								omp_session::PROVIDER_BLOCK_INDEX_PROP,
							)))
						})
						.and_then(|value| match value {
							Value::Int(index) => u32::try_from(*index).ok(),
							_ => None,
						})
				})
				.unwrap_or_else(|| {
					let index = next_index;
					next_index = next_index.saturating_add(1);
					index
				});
			indexed.push((index, usize::MAX, tool_call_value(dom, *call)));
		}
	}
	indexed.sort_by_key(|(index, position, _)| (*index, *position));
	let mut content = indexed
		.into_iter()
		.map(|(_, _, value)| value)
		.collect::<Vec<_>>();
	if content.is_empty() {
		if let Some(text) = node_text(node, PropId::Thinking)
			&& !text.is_empty()
		{
			content.push(serde_json::json!({"type":"thinking","thinking":text}));
		}
		if let Some(text) = node_text(node, PropId::Text)
			.or(node.content.as_deref())
			.filter(|text| !text.is_empty())
		{
			content.push(serde_json::json!({"type":"text","text":text}));
		}
	}

	let usage_node = assistant_usage_node(dom, handle);
	let route = prop_text(Some(node), PropId::Route).unwrap_or_default();
	let provider = prop_text(Some(node), PropId::Provider).unwrap_or_default();
	let api = state
		.and_then(|state| state.catalog.route(&RouteId::from(route)))
		.map_or("unknown", |route| pi_api(provider, route.codec.as_str()));
	let reason = normalize_stop_reason(prop_text(Some(node), PropId::StopReason));
	let mut message = serde_json::json!({
		"role": "assistant",
		"content": content,
		"api": api,
		"provider": provider,
		"model": pi_model_id(
			provider,
			prop_text(Some(node), PropId::Model).unwrap_or_default(),
		),
		"usage": usage_value(usage_node),
		"stopReason": reason,
		"timestamp": node_timestamp_ms(node, PropId::Id),
	});
	if let Some(usage) = usage_node {
		if let Some(duration) = node_integer(usage, PropId::DurationMs) {
			message["duration"] = serde_json::json!(duration);
		}
		if let Some(ttft) = node_integer(usage, PropId::TtftMs) {
			message["ttft"] = serde_json::json!(ttft);
		}
	}
	if prop_text(Some(node), PropId::StopReason).is_some() {
		message["completedAt"] = serde_json::json!(node_timestamp_ms(node, PropId::Order));
	}
	if matches!(reason, "error" | "aborted")
		&& let Some(text) = dom
			.parent(handle)
			.and_then(|turn| turn_failure_notice(dom, turn))
	{
		message["errorMessage"] = serde_json::json!(text);
	}
	message
}

fn user_content(node: &Node, blobs: Option<&BlobStore>) -> serde_json::Value {
	let text = node.content.as_deref().unwrap_or_default();
	let attachments = node
		.prop(&PropKey::Known(PropId::Data))
		.and_then(|value| match value {
			Value::Json(raw) => serde_json::from_str::<Vec<Attachment>>(raw.get()).ok(),
			_ => None,
		})
		.unwrap_or_default();
	if attachments.is_empty() {
		return serde_json::Value::String(text.to_owned());
	}
	let mut content = Vec::with_capacity(attachments.len() + usize::from(!text.is_empty()));
	if !text.is_empty() {
		content.push(serde_json::json!({"type":"text","text":text}));
	}
	content.extend(
		attachments
			.into_iter()
			.map(|attachment| attachment_value(&attachment.blob, attachment.mime.as_str(), blobs)),
	);
	serde_json::Value::Array(content)
}

fn attachment_value(
	reference: &BlobRef,
	mime: &str,
	blobs: Option<&BlobStore>,
) -> serde_json::Value {
	let data = blobs
		.and_then(|store| store.get(reference).ok())
		.map(|bytes| base64::encode(&bytes).into_string())
		.unwrap_or_default();
	serde_json::json!({
		"type": "image",
		"data": data,
		"mimeType": mime,
	})
}

fn ordered_assistant_nodes(dom: &Dom, assistant: Handle) -> Vec<&Node> {
	let mut blocks = dom
		.children(assistant)
		.iter()
		.enumerate()
		.filter_map(|(position, handle)| {
			let node = dom.get(*handle)?;
			let recognized = matches!(
				&node.tag,
				Tag::Custom(tag)
					if matches!(
						tag.as_str(),
						omp_session::ASSISTANT_CONTENT_TAG | "artifact"
					)
			);
			recognized.then_some((provider_block_index(node), position, node))
		})
		.collect::<Vec<_>>();
	blocks.sort_by_key(|(index, position, _)| (*index, *position));
	blocks.into_iter().map(|(_, _, node)| node).collect()
}

fn provider_block_index(node: &Node) -> u32 {
	node
		.prop(&PropKey::Custom(Str::new_static(omp_session::PROVIDER_BLOCK_INDEX_PROP)))
		.and_then(|value| match value {
			Value::Int(index) => u32::try_from(*index).ok(),
			_ => None,
		})
		.unwrap_or_default()
}

fn assistant_block_value_with(node: &Node, blobs: &BlobStore) -> Option<serde_json::Value> {
	assistant_block_value_impl(node, Some(blobs))
}

fn assistant_block_value_impl(node: &Node, blobs: Option<&BlobStore>) -> Option<serde_json::Value> {
	match &node.tag {
		Tag::Custom(tag) if tag.as_str() == omp_session::ASSISTANT_CONTENT_TAG => {
			let text = node_text(node, PropId::Text)?;
			match node_text(node, PropId::Kind)? {
				"text" => Some(serde_json::json!({"type":"text","text":text})),
				"thinking" => Some(serde_json::json!({"type":"thinking","thinking":text})),
				_ => None,
			}
		},
		Tag::Custom(tag) if tag.as_str() == "artifact" => {
			let kind = node_text(node, PropId::Kind).unwrap_or("file");
			let uri = node_text(node, PropId::Blob).unwrap_or_default();
			let mime = node_text(node, PropId::Mime).unwrap_or_default();
			if kind == "image"
				&& let Some(reference) = artifact_blob_ref(node, uri)
			{
				return Some(attachment_value(&reference, mime, blobs));
			}
			let mut value = serde_json::json!({"type":kind,"uri":uri,"mimeType":mime});
			if let Some(Value::Int(size)) = node.prop(&PropKey::Custom(Str::new_static("size"))) {
				value["size"] = serde_json::json!(size);
			}
			Some(value)
		},
		_ => None,
	}
}

fn artifact_blob_ref(node: &Node, uri: &str) -> Option<BlobRef> {
	let hash = uri.strip_prefix("artifact://sha256/")?;
	let size = node
		.prop(&PropKey::Custom(Str::new_static("size")))
		.and_then(|value| match value {
			Value::Int(size) => u64::try_from(*size).ok(),
			_ => None,
		})?;
	BlobRef::parse_hex(hash, size).ok()
}

#[cfg(test)]
fn tool_result_value(dom: &Dom, call: Handle) -> serde_json::Value {
	tool_result_value_impl(dom, call, None)
}

fn tool_result_value_with(dom: &Dom, call: Handle, blobs: &BlobStore) -> serde_json::Value {
	tool_result_value_impl(dom, call, Some(blobs))
}

fn tool_result_value_impl(dom: &Dom, call: Handle, blobs: Option<&BlobStore>) -> serde_json::Value {
	let node = dom.get(call);
	let payload = tool_result_payload(dom, call, blobs);
	let mut message = serde_json::json!({
		"role": "toolResult",
		"toolCallId": prop_text(node, PropId::Id).unwrap_or_default(),
		"toolName": tool_name(node).unwrap_or_default(),
		"content": payload["content"].clone(),
		"details": payload["details"].clone(),
		"isError": tool_is_error(dom, call),
		"timestamp": node.map_or(0, |node| node_timestamp_ms(node, PropId::Order)),
	});
	if let Some(useless) = payload.get("useless").and_then(serde_json::Value::as_bool)
		&& useless
		&& !message["isError"].as_bool().unwrap_or(false)
	{
		message["useless"] = serde_json::Value::Bool(true);
	}
	message
}

fn tool_result_payload(dom: &Dom, call: Handle, blobs: Option<&BlobStore>) -> serde_json::Value {
	let status = prop_text(dom.get(call), PropId::Status);
	let terminal = if status == Some("error") {
		dom.children(call).iter().rev().find_map(|handle| {
			let node = dom.get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Diag)
				&& node_text(node, PropId::Severity) == Some("error"))
			.then_some(node)
		})
	} else if status == Some("ok") {
		dom.children(call).iter().find_map(|handle| {
			let node = dom.get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Result)).then_some(node)
		})
	} else {
		dom.children(call).iter().rev().find_map(|handle| {
			let node = dom.get(*handle)?;
			matches!(node.tag, Tag::Known(KnownTag::Result | KnownTag::Diag)).then_some(node)
		})
	};
	let content = terminal
		.and_then(|node| node.prop(&PropKey::Known(PropId::Data)))
		.and_then(|value| match value {
			Value::Json(raw) => serde_json::from_str::<Vec<Part>>(raw.get()).ok(),
			_ => None,
		})
		.map(|parts| {
			parts
				.into_iter()
				.filter_map(|part| tool_part_value(part, blobs))
				.collect::<Vec<_>>()
		})
		.filter(|parts| !parts.is_empty())
		.unwrap_or_else(|| {
			let text = terminal
				.and_then(|node| {
					node
						.content
						.as_deref()
						.or_else(|| node_text(node, PropId::Text))
				})
				.unwrap_or_default();
			vec![serde_json::json!({"type":"text","text":text})]
		});
	let details = terminal
		.and_then(|node| {
			node
				.prop(&PropKey::Known(PropId::Outcome))
				.or_else(|| node.prop(&PropKey::Known(PropId::Fault)))
		})
		.and_then(|value| match value {
			Value::Json(raw) => serde_json::from_str::<serde_json::Value>(raw.get()).ok(),
			_ => None,
		})
		.map(|value| value.get("value").cloned().unwrap_or(value))
		.unwrap_or_else(|| serde_json::json!({}));
	serde_json::json!({"content":content,"details":details})
}

fn tool_part_value(part: Part, blobs: Option<&BlobStore>) -> Option<serde_json::Value> {
	match part {
		Part::Text { text } => Some(serde_json::json!({"type":"text","text":text})),
		Part::Json { json } => Some(serde_json::json!({
			"type": "text",
			"text": String::from_utf8_lossy(&json),
		})),
		Part::Blob { blob, alt } => {
			if blob.media_type.starts_with("image/")
				&& let Ok(reference) = BlobRef::parse_hex(blob.hash.as_str(), blob.byte_len)
			{
				return Some(attachment_value(&reference, blob.media_type.as_str(), blobs));
			}
			alt.map(|text| serde_json::json!({"type":"text","text":text}))
		},
	}
}

fn tool_is_error(dom: &Dom, call: Handle) -> bool {
	matches!(prop_text(dom.get(call), PropId::Status), Some("error" | "cancelled" | "aborted"))
}

fn tool_args(dom: &Dom, call: Handle) -> serde_json::Value {
	let raw = dom.children(call).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		(node.tag == Tag::Known(KnownTag::Input))
			.then(|| {
				node
					.content
					.as_deref()
					.or_else(|| node_text(node, PropId::Text))
			})
			.flatten()
	});
	raw.and_then(|raw| serde_json::from_str(raw).ok())
		.unwrap_or_else(|| serde_json::json!({}))
}

fn assistant_usage_node(dom: &Dom, assistant: Handle) -> Option<&Node> {
	let turn = dom.parent(assistant)?;
	let children = dom.children(turn);
	let start = children.iter().position(|handle| *handle == assistant)? + 1;
	for handle in children.iter().skip(start) {
		let node = dom.get(*handle)?;
		if node.tag == Tag::Known(KnownTag::Assistant) {
			break;
		}
		if node.tag == Tag::Known(KnownTag::Usage) {
			return Some(node);
		}
	}
	None
}

fn usage_value(node: Option<&Node>) -> serde_json::Value {
	let input = node
		.and_then(|node| node_integer(node, PropId::TokensIn))
		.unwrap_or_default();
	let output = node
		.and_then(|node| node_integer(node, PropId::TokensOut))
		.unwrap_or_default();
	let cache_read = node
		.and_then(|node| node_integer(node, PropId::CacheRead))
		.unwrap_or_default();
	let cache_write = node
		.and_then(|node| node_integer(node, PropId::CacheWrite))
		.unwrap_or_default();
	let total = input
		.saturating_add(output)
		.saturating_add(cache_read)
		.saturating_add(cache_write);
	let total_cost = node
		.and_then(|node| node_integer(node, PropId::CostNanoUsd))
		.map_or(0.0, |nano| nano as f64 / 1_000_000_000.0);
	let mut usage = serde_json::json!({
		"input": input,
		"output": output,
		"cacheRead": cache_read,
		"cacheWrite": cache_write,
		"totalTokens": total,
		"cost": {
			"input": 0.0,
			"output": 0.0,
			"cacheRead": 0.0,
			"cacheWrite": 0.0,
			"total": total_cost,
		},
	});
	if let Some(premium) = node.and_then(|node| node_integer(node, PropId::PremiumRequests))
		&& premium != 0
	{
		usage["premiumRequests"] = serde_json::json!(premium as f64 / 1_000_000.0);
	}
	usage
}

fn pi_model_id<'a>(provider: &str, model: &'a str) -> &'a str {
	model
		.strip_prefix(provider)
		.and_then(|model| model.strip_prefix('/'))
		.unwrap_or(model)
}

fn pi_api<'a>(provider: &str, codec: &'a str) -> &'a str {
	if provider == "openrouter" {
		return "openrouter";
	}
	if provider == "azure" && codec == "openai-responses" {
		return "azure-openai-responses";
	}
	match codec {
		"anthropic" | "anthropic-bedrock" | "anthropic-vertex" => "anthropic-messages",
		"bedrock-converse" => "bedrock-converse-stream",
		"openai-chat" => "openai-completions",
		"openai-codex" => "openai-codex-responses",
		"google-genai" => "google-generative-ai",
		"google-cca" => "google-gemini-cli",
		"google-vertex" => "google-vertex",
		"ollama" => "ollama-chat",
		"cursor" => "cursor-agent",
		"gitlab-duo" => "gitlab-duo-agent",
		"devin" => "devin-agent",
		other => other,
	}
}

fn normalize_stop_reason(reason: Option<&str>) -> &'static str {
	match reason {
		Some("length") => "length",
		Some("tool_calls" | "toolUse") => "toolUse",
		Some("error" | "content_filter") => "error",
		Some("cancelled" | "aborted") => "aborted",
		Some("stop" | "stream_closed") | None => "stop",
		Some(_) => "error",
	}
}

fn content_text(dom: &Dom, assistant: Handle, index: u32, kind: &str) -> Str {
	ordered_assistant_nodes(dom, assistant)
		.into_iter()
		.find(|node| {
			provider_block_index(node) == index && node_text(node, PropId::Kind) == Some(kind)
		})
		.and_then(|node| node_text(node, PropId::Text))
		.map_or_else(Str::default, Str::new)
}

fn node_timestamp_ms(node: &Node, prop: PropId) -> u64 {
	node_text(node, prop)
		.and_then(|value| value.parse::<omp_journal::EntryId>().ok())
		.map_or(0, |id| id.as_ulid().timestamp_ms())
}

fn node_integer(node: &Node, prop: PropId) -> Option<u64> {
	node
		.prop(&PropKey::Known(prop))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		})
}

fn node_bool(node: &Node, prop: PropId) -> bool {
	node.prop(&PropKey::Known(prop)) == Some(&Value::Bool(true))
}

fn custom_bool(node: &Node, prop: &'static str) -> bool {
	node.prop(&PropKey::Custom(Str::new_static(prop))) == Some(&Value::Bool(true))
}

fn sanitize_text(text: &str) -> String {
	text
		.to_owned()
		.into_ansi_stripped()
		.chars()
		.filter(|character| {
			matches!(*character, '\t' | '\n')
				|| (!character.is_control() && !matches!(*character as u32, 0x7f..=0x9f))
		})
		.collect()
}

fn node_text(node: &Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::Known(prop)).and_then(Value::as_str)
}

fn prop_text(node: Option<&Node>, prop: PropId) -> Option<&str> {
	node?.prop(&PropKey::Known(prop)).and_then(Value::as_str)
}

fn tool_name(node: Option<&Node>) -> Option<&str> {
	match &node?.tag {
		Tag::Custom(name) => Some(name.as_str()),
		_ => None,
	}
}

/// Projects the plain headless transcript from the authoritative session DOM.
///
/// This is intentionally the model-visible answer/tool timeline, not a
/// terminal screenshot: it is stable across terminal widths and contains
/// neither ANSI styling nor observer-local chrome.
#[must_use]
pub fn transcript_text(dom: &Dom) -> String {
	let mut output = String::new();
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::Assistant) => {
					let blocks = ordered_assistant_nodes(dom, *handle);
					if blocks.is_empty() {
						if let Some(Value::Str(text)) = node.prop(&PropId::Text.into()) {
							output.push_str(text.as_str());
							if !text.is_empty() && !text.ends_with('\n') {
								output.push('\n');
							}
						}
					} else {
						for block in blocks {
							if node_text(block, PropId::Kind) != Some("text") {
								continue;
							}
							if let Some(Value::Str(text)) = block.prop(&PropId::Text.into()) {
								output.push_str(text.as_str());
								if !text.is_empty() && !text.ends_with('\n') {
									output.push('\n');
								}
							}
						}
					}
				},
				Tag::Custom(name) => {
					output.push_str("[tool: ");
					output.push_str(name.as_str());
					output.push_str("]\n");
				},
				_ => {},
			}
		}
	}
	sanitize_text(&output)
}

/// Projects text and tool markers in exact provider content order.
#[must_use]
pub fn transcript_text_with_blobs(dom: &Dom, blobs: &BlobStore) -> String {
	let document = transcript_json(dom, blobs);
	let mut output = String::new();
	if let Some(messages) = document["messages"].as_array() {
		for message in messages {
			if message["role"] != "assistant" {
				continue;
			}
			let Some(content) = message["content"].as_array() else {
				continue;
			};
			for part in content {
				match part["type"].as_str() {
					Some("text") => {
						if let Some(text) = part["text"].as_str() {
							output.push_str(text);
							if !text.is_empty() && !text.ends_with('\n') {
								output.push('\n');
							}
						}
					},
					Some("toolCall") => {
						output.push_str("[tool: ");
						output.push_str(part["name"].as_str().unwrap_or("tool"));
						output.push_str("]\n");
					},
					_ => {},
				}
			}
		}
	}
	sanitize_text(&output)
}

/// Stable, provider-payload-free JSON projection of the live session branch.
#[must_use]
pub fn transcript_json(dom: &Dom, blobs: &BlobStore) -> serde_json::Value {
	let model = dom
		.children(dom.body())
		.iter()
		.flat_map(|turn| dom.children(*turn))
		.find_map(|handle| {
			let node = dom.get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Assistant))
				.then(|| prop_text(Some(node), PropId::Model))
				.flatten()
		})
		.unwrap_or("session");
	let state =
		JsonState::new(Arc::new(Catalog::embedded().clone()), blobs.clone(), Str::new(model));
	let notices = dom
		.children(dom.body())
		.iter()
		.flat_map(|turn| dom.children(*turn))
		.filter_map(|handle| {
			let node = dom.get(*handle)?;
			(node.tag == Tag::Known(KnownTag::Notice)).then(|| {
				serde_json::json!({
					"kind": node_text(node, PropId::Kind).unwrap_or("info"),
					"text": node.content.as_deref().unwrap_or_default(),
				})
			})
		})
		.collect::<Vec<_>>();
	let mut value = serde_json::json!({
		"format": "omp-transcript@1",
		"messages": transcript_messages_from_with(dom, 0, &state),
		"notices": notices,
	});
	if let Some((_, exit)) = latest_session_exit(dom)
		&& exit.status != ExitStatus::Clean
	{
		value["sessionExit"] = serde_json::json!(exit);
	}
	value
}

/// Concise Markdown projection of the live session branch.
///
/// Tool call/result pairs collapse into one bounded line, reasoning is hidden
/// unless requested, and attachment bytes never enter the Markdown document.
#[must_use]
pub fn transcript_markdown(dom: &Dom, blobs: &BlobStore, include_thinking: bool) -> String {
	let document = transcript_json(dom, blobs);
	let messages = document["messages"]
		.as_array()
		.map(Vec::as_slice)
		.unwrap_or_default();
	let mut results = FastHashMap::<&str, &serde_json::Value>::default();
	for message in messages {
		if message["role"] == "toolResult"
			&& let Some(id) = message["toolCallId"].as_str()
		{
			results.insert(id, message);
		}
	}
	let mut consumed = omp_core::FastHashSet::<&str>::default();
	let mut lines = Vec::new();
	for message in messages {
		match message["role"].as_str() {
			Some("user" | "developer") => {
				let role = message["role"].as_str().unwrap_or("user");
				let text = json_content_text(&message["content"]);
				if !text.trim().is_empty() {
					lines.push(format!("## {role}"));
					lines.push(String::new());
					lines.push(text);
					lines.push(String::new());
				}
			},
			Some("assistant") => {
				let mut body = Vec::new();
				if let Some(content) = message["content"].as_array() {
					for part in content {
						match part["type"].as_str() {
							Some("text") => {
								if let Some(text) = part["text"].as_str()
									&& !text.trim().is_empty()
								{
									body.push(text.to_owned());
								}
							},
							Some("thinking") if include_thinking => {
								if let Some(text) = part["thinking"].as_str()
									&& !text.trim().is_empty()
								{
									body.push(format!("_thinking:_ {text}"));
								}
							},
							Some("toolCall") => {
								let id = part["id"].as_str().unwrap_or_default();
								let result = results.get(id).copied();
								if result.is_some() {
									consumed.insert(id);
								}
								body.push(markdown_tool_line(part, result));
							},
							Some("image") => body.push("[image]".to_owned()),
							Some(kind) if kind != "redactedThinking" => {
								if let Some(uri) = part["uri"].as_str() {
									body.push(format!("[{kind}] {uri}"));
								}
							},
							_ => {},
						}
					}
				}
				if let Some(error) = message["errorMessage"].as_str()
					&& !error.trim().is_empty()
				{
					body.push(format!("[error] {}", one_line(error, 120)));
				}
				if !body.is_empty() {
					lines.push("## assistant".to_owned());
					lines.push(String::new());
					lines.extend(body);
					lines.push(String::new());
				}
			},
			Some("toolResult") => {
				let id = message["toolCallId"].as_str().unwrap_or_default();
				if !consumed.contains(id) {
					let call = serde_json::json!({
						"name": message["toolName"],
						"arguments": {},
					});
					lines.push(markdown_tool_line(&call, Some(message)));
					lines.push(String::new());
				}
			},
			_ => {},
		}
	}
	if let Some(notices) = document["notices"].as_array() {
		for notice in notices {
			let text = notice["text"].as_str().unwrap_or_default();
			if !text.trim().is_empty() {
				lines.push(format!(
					"[{}] {}",
					notice["kind"].as_str().unwrap_or("notice"),
					one_line(text, 240),
				));
				lines.push(String::new());
			}
		}
	}
	if let Some(exit) = document.get("sessionExit")
		&& let Ok(exit) = serde_json::from_value::<omp_session::SessionExit>(exit.clone())
		&& let Some(text) = omp_chat::notices::session_exit::text(&exit)
	{
		lines.push(format!("[session-exit] {}", one_line(text.as_str(), 240)));
		lines.push(String::new());
	}
	let rendered = lines.join("\n");
	format!("{}\n", sanitize_text(rendered.trim()))
}

fn json_content_text(content: &serde_json::Value) -> String {
	if let Some(text) = content.as_str() {
		return text.to_owned();
	}
	let Some(parts) = content.as_array() else {
		return String::new();
	};
	parts
		.iter()
		.filter_map(|part| match part["type"].as_str() {
			Some("text") => part["text"].as_str().map(ToOwned::to_owned),
			Some("image") => Some("[image]".to_owned()),
			Some(kind) => Some(format!("[{kind}]")),
			None => None,
		})
		.collect::<Vec<_>>()
		.join("\n")
}

fn markdown_tool_line(call: &serde_json::Value, result: Option<&serde_json::Value>) -> String {
	let name = call["name"]
		.as_str()
		.or_else(|| call["toolName"].as_str())
		.unwrap_or("tool");
	let args = call.get("arguments").unwrap_or(&serde_json::Value::Null);
	let head = format!("→ {name}({})", primary_arg(name, args));
	let Some(result) = result else {
		return format!("{head} ⇒ pending");
	};
	let text = json_content_text(&result["content"]);
	let count = if text.is_empty() {
		0
	} else {
		text.split('\n').count()
	};
	let noun = if count == 1 { "line" } else { "lines" };
	if result["isError"].as_bool().unwrap_or(false) {
		let preview = one_line(text.split('\n').next().unwrap_or_default(), 120);
		if preview.is_empty() {
			format!("{head} ⇒ error · {count} {noun}")
		} else {
			format!("{head} ⇒ error · {count} {noun} — {preview}")
		}
	} else {
		format!("{head} ⇒ ok · {count} {noun}")
	}
}

fn primary_arg(name: &str, args: &serde_json::Value) -> String {
	let scalar = |key: &str| {
		args.get(key).and_then(|value| {
			if let Some(text) = value.as_str() {
				Some(text.to_owned())
			} else {
				value.as_array().and_then(|items| {
					items
						.iter()
						.map(serde_json::Value::as_str)
						.collect::<Option<Vec<_>>>()
						.map(|items| items.join(", "))
				})
			}
		})
	};
	let value = if name == "advise" {
		match (scalar("severity"), scalar("note")) {
			(Some(severity), Some(note)) => Some(format!("{severity}: {note}")),
			(_, note) => note,
		}
	} else if name == "grep" {
		match (scalar("pattern"), scalar("path").or_else(|| scalar("paths"))) {
			(Some(pattern), Some(path)) => Some(format!("{pattern} @ {path}")),
			(pattern, path) => pattern.or(path),
		}
	} else if name == "glob" {
		scalar("path").or_else(|| scalar("paths"))
	} else if name == "ast_grep" {
		scalar("pat")
	} else {
		[
			"path",
			"file_path",
			"filePath",
			"command",
			"cmd",
			"pattern",
			"url",
			"query",
			"prompt",
			"assignment",
			"note",
			"message",
			"op",
			"name",
			"id",
		]
		.into_iter()
		.find_map(scalar)
	};
	if let Some(value) = value {
		return one_line(&value, 120);
	}
	let Some(object) = args.as_object() else {
		return String::new();
	};
	let visible = object
		.iter()
		.filter(|(key, _)| key.as_str() != "i")
		.map(|(key, value)| (key.clone(), value.clone()))
		.collect::<serde_json::Map<_, _>>();
	if visible.is_empty() {
		return String::new();
	}
	one_line(&serde_json::to_string(&visible).unwrap_or_default(), 120)
}

fn one_line(text: &str, max: usize) -> String {
	let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
	let count = flat.chars().count();
	if count <= max {
		return flat;
	}
	let mut out = flat.chars().take(max.saturating_sub(1)).collect::<String>();
	out.push('…');
	out
}

#[cfg(test)]
mod tests {
	use omp_dom::{NodeSpec, Txn};
	use omp_session::{CrashTail, SessionExit};
	use serde_json::value::RawValue;
	use tempfile::tempdir;

	use super::*;

	fn current_turn(session: &omp_session::Session) -> Handle {
		*session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn node")
	}

	#[test]
	fn prior_exit_text_keeps_typed_signal_and_tail_detail() {
		let exit = SessionExit {
			status:             ExitStatus::Interrupted,
			cause:              ExitCause::Signal {
				signal: omp_session::ExitSignal::new("SIGTERM", Some(15)),
			},
			recorded_at_ms:     1,
			crash_tail:         vec![CrashTail::Tool {
				call_id:       Str::new_static("call-1"),
				name:          Str::new_static("bash"),
				intent:        Some(Str::new_static("inspect logs")),
				argument:      Some(Str::new_static("journalctl -n 20")),
				started_at_ms: 2,
			}],
			crash_tail_omitted: 0,
		};
		let text = omp_chat::notices::session_exit::text(&exit).expect("abnormal exit");
		assert!(text.contains("SIGTERM"));
		assert!(text.contains("Pending tool bash call-1"));
		assert!(text.contains("journalctl -n 20"));
	}

	fn assistant_with(
		session: &mut omp_session::Session,
		thinking: Option<&str>,
		text: &str,
		stop: &str,
	) {
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = current_turn(session);
		let assistant = last_assistant(session.dom(), turn).expect("assistant node");
		if let Some(thinking) = thinking {
			let sid = session
				.stream_open(assistant, PropId::Thinking.into())
				.expect("thinking stream");
			session
				.stream_append(sid, thinking)
				.expect("thinking delta");
			session.stream_close(sid).expect("thinking close");
		}
		let sid = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text stream");
		session.stream_append(sid, text).expect("text delta");
		session.stream_close(sid).expect("text close");
		session.assistant_end(stop).expect("assistant end");
	}

	fn settled_call(session: &mut omp_session::Session, name: &str) {
		let call = session
			.call(
				name,
				1,
				"call-1",
				None,
				Some(RawValue::from_string(r#"{"path":"note.txt"}"#.to_owned()).expect("args")),
				None,
			)
			.expect("call");
		session
			.settle(
				call,
				RawValue::from_string(
					r#"{"content":[{"type":"text","text":"hello from fixture"}]}"#.to_owned(),
				)
				.expect("outcome"),
			)
			.expect("settle");
	}

	fn error_notice(session: &mut omp_session::Session, text: &str) {
		let turn = current_turn(session);
		let after = session.dom().children(turn).last().copied();
		let cause = session.head().expect("head");
		session
			.patch(Txn {
				cause,
				label: Some(Str::new_static("kernel.notice")),
				ops: vec![Op::Ins {
					parent: turn,
					after,
					node: NodeSpec::new(KnownTag::Notice)
						.with_prop(PropId::Kind, Value::Str(Str::new_static("error")))
						.with_content(Str::new(text)),
				}],
			})
			.expect("notice");
	}

	#[test]
	fn text_mode_stdout_is_only_the_final_response() {
		let scratch = tempdir().expect("scratch");
		let mut session = omp_session::Session::create(
			scratch.path().join("text.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		session.begin_turn().expect("turn");
		session.user("read note.txt", Vec::new()).expect("user");
		assistant_with(&mut session, None, "Let me read that file.", "tool_calls");
		settled_call(&mut session, "read");
		assistant_with(
			&mut session,
			Some("The file says hello."),
			"hello from fixture",
			"stream_closed",
		);

		assert_eq!(
			final_response_text(session.dom(), 0, false),
			"hello from fixture\n",
			"intermediate assistant text and tool markers must never reach stdout",
		);
		assert_eq!(
			final_response_text(session.dom(), 0, true),
			"The file says hello.\nhello from fixture\n",
		);
		assert_eq!(final_response_text(session.dom(), 1, false), "");
		let markdown = transcript_markdown(session.dom(), session.blobs(), false);
		assert_eq!(
			markdown,
			"## user\n\nread note.txt\n\n## assistant\n\nLet me read that file.\n→ read(note.txt) ⇒ \
			 ok · 1 line\n\n## assistant\n\nhello from fixture\n",
		);
		let with_thinking = transcript_markdown(session.dom(), session.blobs(), true);
		assert_eq!(
			with_thinking,
			"## user\n\nread note.txt\n\n## assistant\n\nLet me read that file.\n→ read(note.txt) ⇒ \
			 ok · 1 line\n\n## assistant\n\n_thinking:_ The file says hello.\nhello from fixture\n",
		);
	}

	#[test]
	fn failed_turn_agent_end_carries_stop_reason_and_error_message() {
		let scratch = tempdir().expect("scratch");
		let mut session = omp_session::Session::create(
			scratch.path().join("failed.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		session.begin_turn().expect("turn");
		session.user("hi", Vec::new()).expect("user");
		assistant_with(&mut session, None, "partial", "error");
		error_notice(&mut session, "provider exploded: http 500");

		let end = agent_end_value(session.dom(), 0);
		assert_eq!(end["type"], "agent_end");
		assert_eq!(end["isTerminal"], true);
		let assistant = end["messages"]
			.as_array()
			.expect("messages")
			.iter()
			.rev()
			.find(|message| message["role"] == "assistant")
			.expect("terminal assistant");
		assert_eq!(assistant["stopReason"], "error");
		assert_eq!(assistant["errorMessage"], "provider exploded: http 500");
		assert_eq!(
			turn_error_message(session.dom(), 0).as_deref(),
			Some("provider exploded: http 500"),
		);
		assert_eq!(turn_error_message(session.dom(), 1), None);
	}

	#[test]
	fn interrupted_assistant_reports_pi_aborted_stop_reason() {
		let scratch = tempdir().expect("scratch");
		let mut session = omp_session::Session::create(
			scratch.path().join("aborted.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		session.begin_turn().expect("turn");
		assistant_with(&mut session, None, "part", "cancelled");
		let turn = current_turn(&session);
		let assistant = last_assistant(session.dom(), turn).expect("assistant");
		let message = message_value(session.dom(), assistant);
		assert_eq!(message["stopReason"], "aborted");
		assert!(message.get("errorMessage").is_none());
		assert_eq!(stop_reason_name(TurnStop::Cancelled), "aborted");
		assert_eq!(stop_reason_name(TurnStop::Failed), "error");
	}

	#[test]
	fn json_stream_starts_with_resumable_session_header() {
		assert_eq!(
			session_header("01TEST", "test/model"),
			serde_json::json!({
				"type": "session",
				"version": 1,
				"id": "01TEST",
				"model": "test/model",
			}),
		);
	}

	#[test]
	fn shaped_updates_drop_snapshots_but_keep_incremental_tool_identity() {
		let scratch = tempdir().expect("scratch");
		let mut session = omp_session::Session::create(
			scratch.path().join("shape.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		session.begin_turn().expect("turn");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn node");
		let assistant = *session
			.dom()
			.children(turn)
			.iter()
			.find(|handle| {
				session
					.dom()
					.get(**handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			})
			.expect("assistant node");
		let stream = serde_json::json!({
			"type": "toolcall_delta",
			"toolCallId": "call-7",
			"delta": "{\"path\":",
		});
		let shaped = shaped_message_update(session.dom(), assistant, stream.clone(), true);
		assert!(shaped.get("message").is_none());
		assert!(
			shaped["assistantMessageEvent"].get("partial").is_none(),
			"shaped stream must not repeat an ever-growing partial snapshot",
		);
		assert_eq!(shaped["assistantMessageEvent"]["toolCallId"], "call-7");

		let full = shaped_message_update(session.dom(), assistant, stream, false);
		assert!(full.get("message").is_some());
		assert!(full["assistantMessageEvent"].get("partial").is_some());
	}

	#[test]
	fn terminal_turn_event_carries_tool_results_and_agent_messages() {
		let scratch = tempdir().expect("scratch");
		let mut session = omp_session::Session::create(
			scratch.path().join("events.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		session.begin_turn().expect("turn");
		session.user("run it", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		session.assistant_end("tool_calls").expect("assistant end");
		let call = session
			.call(
				"bash",
				1,
				"call-1",
				None,
				Some(RawValue::from_string(r#"{"command":"echo ok"}"#.to_owned()).expect("args")),
				None,
			)
			.expect("call");
		session
			.settle(
				call,
				RawValue::from_string(r#"{"content":[{"type":"text","text":"ok"}]}"#.to_owned())
					.expect("outcome"),
			)
			.expect("settle");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn node");
		let event = turn_end_value(session.dom(), turn);
		assert_eq!(event["type"], "turn_end");
		assert_eq!(event["toolResults"][0]["toolCallId"], "call-1");
		assert!(
			event["toolResults"][0]["content"][0]["text"]
				.as_str()
				.is_some_and(|text| text.contains("ok")),
		);
		let messages = transcript_messages_from(session.dom(), 0);
		assert!(messages.iter().any(|message| message["role"] == "user"));
		assert!(
			messages
				.iter()
				.any(|message| message["role"] == "assistant")
		);
		assert!(
			messages
				.iter()
				.any(|message| message["role"] == "toolResult")
		);
	}

	#[test]
	fn exported_text_is_control_safe_and_previews_are_unicode_bounded() {
		assert_eq!(sanitize_text("\u{1b}[31mred\u{1b}[0m\u{0}ok\n"), "redok\n");
		assert_eq!(one_line("😀 😀 😀 😀", 3), "😀 …");
		let long = "x".repeat(200);
		assert_eq!(one_line(&long, 120).chars().count(), 120);
		assert!(one_line(&long, 120).ends_with('…'));
	}
}
