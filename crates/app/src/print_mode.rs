//! Single-shot, stdout-safe inference mode.

use std::{
	collections::BTreeMap,
	env, fs, io,
	io::IsTerminal as _,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use miette::{IntoDiagnostic as _, miette};
use omp_agent::{
	AgentEvent, AgentRunSummary, EventSubscription, InProcTurnClient, PlanState, RunSettlement,
};
use omp_catalog::snapshot;
use omp_core::{Hash32, Str};
use omp_driver::{
	discovery::roles,
	headless::{
		HeadlessLaunchPolicy, HeadlessSession, HeadlessSessionOpen, HeadlessSessionOptions,
		HeadlessToolPolicy,
		finalize::{FinalizerBudget, FinalizerReport},
	},
	plan::ModelSelection,
};
use omp_envd::exthost::lifecycle::{HeadlessLifecycleKind, HeadlessLifecycleSubscription};
use omp_inference::call::{ContentPart, MediaInput};
use omp_proto::{
	inference::v1::{part_start, turn_event},
	thread::v1::{Blob, Item, Message, Part, Role, blob, item, part},
};
use omp_settings::manager::{SettingsManager, SettingsPaths};
use omp_tools::read::dirtree;
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, Stderr, Stdout, stderr, stdin, stdout};

use crate::{
	chat_cmd::AppAdvisorRuntime,
	cli::{PrintArgs, turn_id},
	image_attachment,
	image_attachment::ImageAttachmentError,
	spec,
	usage_error::CliUsageError,
};

const MAX_TOTAL_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;
const MAX_AUTO_READ_TEXT_BYTES: usize = 5 * 1024 * 1024;
const MAX_AUTO_READ_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const DIRECTORY_MENTION_LIMIT: usize = 500;
#[derive(Default)]
struct JsonTurnState {
	part_kinds:        BTreeMap<u32, part_start::Kind>,
	assistant_started: bool,
	settled_items:     Vec<Item>,
}

#[derive(Debug, thiserror::Error)]
enum PrintTurnError {
	#[error(transparent)]
	Session(#[from] omp_sdk::SessionHandleError),
	#[error(transparent)]
	Stdout(#[from] io::Error),
	#[error(transparent)]
	Json(#[from] serde_json::Error),
}

/// Runs prompts through the durable headless agent loop.
pub async fn run(args: PrintArgs) -> miette::Result<()> {
	let Some(max_time) = args.max_time.map(|duration| duration.0) else {
		return run_inner(args).await;
	};
	tokio::time::timeout(max_time, run_inner(args))
		.await
		.map_err(|_| miette!("print mode exceeded --max-time"))?
}

async fn run_inner(args: PrintArgs) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let cwd = fs::canonicalize(&args.project).into_diagnostic()?;
	let home = env::var_os("HOME").map_or_else(|| cwd.clone(), PathBuf::from);
	let mut settings_paths = SettingsPaths::discover(&data_dir, Some(&cwd));
	settings_paths.overlays.extend(args.config.iter().cloned());
	let settings_manager = SettingsManager::open(settings_paths).into_diagnostic()?;
	let settings_snapshot = settings_manager.snapshot();
	let settings = settings_snapshot
		.project::<omp_driver::settings::Settings>()
		.into_diagnostic()?
		.get()
		.clone();
	let model_settings = settings_snapshot
		.project::<omp_catalog::settings::ModelSettings>()
		.into_diagnostic()?
		.get()
		.resolve_path_scopes(&cwd, &home);
	let catalog = snapshot::Catalog::try_embedded().map_err(|error| miette!(error))?;
	let roles = roles::resolve_launch_roles(
		catalog,
		&model_settings,
		args.model.as_deref(),
		args.smol.as_deref(),
		args.slow.as_deref(),
		args.plan.as_deref(),
	)
	.map_err(|error| miette!(error))?;
	for selector in args
		.models
		.as_ref()
		.into_iter()
		.flat_map(|selectors| selectors.0.iter())
	{
		roles::resolve_role_selector(catalog, &model_settings, selector)
			.map_err(|error| miette!(error))?;
	}
	for root in &args.add_dir {
		fs::canonicalize(root).into_diagnostic()?;
	}
	let model = roles
		.primary
		.map(|model| Str::from(model.as_str()))
		.ok_or_else(|| miette!("print mode requires a configured default model role"))?;
	if args.api_key.is_some() && args.model.is_none() && args.models.is_none() {
		return Err(miette!("--api-key requires a model to be specified via --model or --models"));
	}
	let plan_handoff = if args.plan_yolo {
		match args.plan_yolo_into.as_deref() {
			Some(selector) => {
				let selected = roles::resolve_role_selector(catalog, &model_settings, selector)
					.map_err(|error| miette!(error))?;
				Some(
					ModelSelection::resolved(selected.model.as_str(), selected.thinking.as_deref())
						.map_err(|error| miette!(error))?,
				)
			},
			None => roles
				.smol
				.as_ref()
				.map(|model| ModelSelection::resolved(model.as_str(), None))
				.transpose()
				.map_err(|error| miette!(error))?,
		}
	} else {
		None
	};
	let credential_provider = args
		.api_key
		.as_ref()
		.map(|_| omp_driver::chat::resolve_model_provider(catalog, model.as_str(), None))
		.transpose()
		.map_err(|error| miette!(error))?;
	let initial = initial_parts(&args.prompt, settings.images.auto_resize).await?;
	if initial.is_empty() {
		return Err(
			CliUsageError::new("print mode requires a prompt or piped standard input").into(),
		);
	}
	let system = spec::resolve_prompt_slots(
		&cwd,
		&home,
		args.prompt_settings.custom_prompt.as_deref(),
		args.prompt_settings.append_prompt.as_deref(),
	)?
	.combined();
	let session_open = if args.no_session {
		HeadlessSessionOpen::Ephemeral
	} else if args.continue_session {
		HeadlessSessionOpen::ContinueLatest
	} else if let Some(source) = args.fork.clone() {
		HeadlessSessionOpen::Fork(source)
	} else if let Some(source) = args.resume.clone() {
		HeadlessSessionOpen::Resume(source)
	} else {
		HeadlessSessionOpen::New
	};
	let tool_policy = if args.no_tools {
		HeadlessToolPolicy::None
	} else if let Some(tools) = args.tools.as_ref() {
		HeadlessToolPolicy::Only(tools.0.clone().into_boxed_slice())
	} else {
		HeadlessToolPolicy::All
	};
	let mut session = HeadlessSession::open_with_policy(
		data_dir.clone(),
		HeadlessSessionOptions {
			project: cwd.clone(),
			settings_overlays: args.config.clone().into_boxed_slice(),
			additional_roots: args.add_dir.clone().into_boxed_slice(),
			model,
			initial_regime: args.plan_yolo.then_some("plan"),
			initial_prompt_slot: args.plan_yolo.then_some("plan-yolo"),
			plan_handoff,
			resume: args.resume.clone(),
			fork: args.fork.clone(),
			py_eval: args.py_eval,
			approval_mode: args.effective_approval().map(Into::into),
			pty_denied: args.no_pty,
			credential_provider,
			api_key: args.api_key.clone(),
			prompt_cache_affinity: args.prompt_cache_key.clone(),
			session_generation: 1,
		},
		HeadlessLaunchPolicy {
			session:            session_open,
			sessions_dir:       args.session_dir.clone(),
			tools:              tool_policy,
			lsp_enabled:        !args.no_lsp,
			auto_thinking:      None,
			native_discovery:   omp_driver::discovery::native::NativeDiscoveryOptions {
				explicit_roots:    if matches!(
					args.extension_launch.mode,
					crate::cli::InvocationExtensionMode::Disabled
				) {
					Vec::new()
				} else {
					args.extension_launch.native_roots.clone()
				},
				root_mode:         match args.extension_launch.mode {
					crate::cli::InvocationExtensionMode::Merge => {
						omp_driver::discovery::native::NativeRootMode::Merge
					},
					crate::cli::InvocationExtensionMode::ExplicitOnly
					| crate::cli::InvocationExtensionMode::Disabled => {
						omp_driver::discovery::native::NativeRootMode::ExplicitOnly
					},
				},
				skill_settings:    settings_snapshot
					.project::<omp_driver::discovery::skills::SkillDiscoverySettings>()
					.into_diagnostic()?
					.get()
					.clone(),
				include_workspace: !args.extension_launch.no_workspace
					&& !matches!(
						args.extension_launch.mode,
						crate::cli::InvocationExtensionMode::Disabled
					),
				client_installed:  Some(data_dir.join("ext/installed.toml")),
			},
			extension_specs:    Arc::from(args.extension_launch.trusted.clone()),
			contributed_values: Arc::from(args.extension_launch.contributed.clone()),
		},
	)
	.await
	.into_diagnostic()?;
	for notice in session.take_notices() {
		eprintln!("{notice}");
	}
	let advisor_runtime = if args.advisor {
		let (runtime, _notices) = AppAdvisorRuntime::compose(
			session.advisor_parent(),
			None,
			cwd.clone(),
			Str::new(session.session_id()),
			true,
			session.available_tool_names(),
			session.advise_queue(),
			catalog,
			true,
		);
		Some(Arc::new(runtime))
	} else {
		None
	};
	let fresh = session.initial_items().is_empty();
	let startup_plan_ignored = startup_plan_ignored(&settings, fresh, args.plan_yolo);
	let mut stderr = stderr();
	if startup_plan_ignored {
		stderr
			.write_all(
				b"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to \
				 review the plan). Use --plan-yolo for a headless plan flow.\n",
			)
			.await
			.into_diagnostic()?;
	}
	if args.plan_yolo {
		session.publish(AgentEvent::PlanStateChanged {
			from:               PlanState::Inactive,
			to:                 PlanState::Yolo,
			session_generation: 1,
		});
	}
	session
		.finalizer_mut()
		.set_telemetry(|| async { omp_telemetry::export::shutdown() });
	if let Some(runtime) = advisor_runtime.as_ref() {
		let runtime = Arc::clone(runtime);
		session
			.finalizer_mut()
			.set_advisor(move || async move { runtime.drain().await });
	}
	let events = session
		.take_events()
		.expect("headless print owns the lossless event subscription");
	let lifecycle_events = session
		.take_lifecycle_events()
		.expect("headless print owns the extension event subscription");
	let json = args.mode == "json";
	let mut stdout = stdout();
	if json {
		let header = serde_json::json!({
			"type": "session",
			"version": 3,
			"id": session.session_id(),
			"timestamp": jiff::Timestamp::now().to_string(),
			"cwd": cwd,
			"additionalDirectories": args.add_dir.clone(),
		});
		write_json(&mut stdout, &format!("{}\n", serde_json::to_string(&header).into_diagnostic()?))
			.await?;
	} else {
		stderr.write_all(b"Working...\n").await.into_diagnostic()?;
	}

	let mut json_state = JsonTurnState::default();
	let mut summary = submit_print_turn(
		&mut session,
		&events,
		&lifecycle_events,
		advisor_runtime.as_deref(),
		initial_message(initial, system),
		&mut json_state,
		json,
		args.shape_transcript,
		&mut stdout,
		&mut stderr,
	)
	.await;
	if let Ok(current) = &summary {
		emit_warning(current, &mut stderr).await?;
	}
	for follow_up in &args.follow_ups {
		if summary.is_err() {
			break;
		}
		summary = submit_print_turn(
			&mut session,
			&events,
			&lifecycle_events,
			advisor_runtime.as_deref(),
			vec![message(Role::User, vec![Part {
				kind: Some(part::Kind::Text(follow_up.to_string())),
			}])],
			&mut json_state,
			json,
			args.shape_transcript,
			&mut stdout,
			&mut stderr,
		)
		.await;
		if let Ok(current) = &summary {
			emit_warning(current, &mut stderr).await?;
		}
	}

	let summary = match summary {
		Ok(summary) => summary,
		Err(error) => {
			let report = session
				.finalize(&mut stdout, FinalizerBudget::terminal_error())
				.await;
			emit_finalizer_report(report, &mut stderr).await?;
			return Err(error).into_diagnostic();
		},
	};
	match summary.settlement {
		RunSettlement::Success | RunSettlement::Warning => {},
		RunSettlement::SilentCompactionTransition => {
			let report = session
				.finalize(&mut stdout, FinalizerBudget::success(Duration::from_secs(30)))
				.await;
			emit_finalizer_report(report, &mut stderr).await?;
			return Ok(());
		},
		RunSettlement::CallerAbort | RunSettlement::MaxTokens | RunSettlement::TerminalFault => {
			let report = session
				.finalize(&mut stdout, FinalizerBudget::terminal_error())
				.await;
			emit_finalizer_report(report, &mut stderr).await?;
			return Err(miette!("headless turn settled as {}", <&str>::from(summary.settlement)));
		},
	}

	if !json {
		write_final_assistant(&summary, args.print_thoughts, &mut stdout).await?;
	}
	let report = session
		.finalize(&mut stdout, FinalizerBudget::success(Duration::from_secs(30)))
		.await;
	emit_finalizer_report(report, &mut stderr).await
}

fn startup_plan_ignored(
	settings: &omp_driver::settings::Settings,
	fresh: bool,
	plan_yolo: bool,
) -> bool {
	settings.plan.enabled && settings.plan.default_on_startup && fresh && !plan_yolo
}

async fn submit_print_turn(
	session: &mut HeadlessSession,
	events: &EventSubscription,
	lifecycle_events: &HeadlessLifecycleSubscription,
	advisor: Option<&AppAdvisorRuntime<InProcTurnClient>>,
	items: Vec<Item>,
	json_state: &mut JsonTurnState,
	json: bool,
	shape_transcript: bool,
	stdout: &mut Stdout,
	stderr: &mut Stderr,
) -> Result<AgentRunSummary, PrintTurnError> {
	let turn_id = omp_agent::TurnId::new(turn_id());
	json_state.part_kinds.clear();
	json_state.assistant_started = false;
	json_state.settled_items.clear();
	let submit = session.submit(items, turn_id.clone());
	tokio::pin!(submit);
	let result = loop {
		tokio::select! {
			result = &mut submit => break result,
			event = events.recv() => {
				let Ok(event) = event else { continue; };
				if let Some(advisor) = advisor {
					advisor.observe(event.as_ref()).await;
				}
				emit_event(&event, json_state, json, shape_transcript, stdout, stderr).await?;
			},
			event = lifecycle_events.recv() => {
				let Ok(event) = event else { continue; };
				emit_lifecycle(&event.kind, stderr).await;
			},
		}
	};
	while let Ok(event) = events.try_recv() {
		if let Some(advisor) = advisor {
			advisor.observe(event.as_ref()).await;
		}
		emit_event(&event, json_state, json, shape_transcript, stdout, stderr).await?;
	}
	let summary = result?;
	if json {
		emit_json_settlement(&summary, turn_id.as_str(), json_state, stdout).await?;
	}
	Ok(summary)
}

async fn emit_lifecycle(kind: &HeadlessLifecycleKind, stderr: &mut Stderr) {
	if let HeadlessLifecycleKind::ExtensionError { extension, error } = kind {
		let _ = stderr
			.write_all(
				format!("Extension error ({}): {error}\n", sanitize(extension.as_str())).as_bytes(),
			)
			.await;
	}
}

async fn emit_event(
	event: &AgentEvent,
	state: &mut JsonTurnState,
	json: bool,
	_shape_transcript: bool,
	stdout: &mut Stdout,
	stderr: &mut Stderr,
) -> Result<(), PrintTurnError> {
	if let AgentEvent::Failed { message, .. } = event {
		let _ = stderr
			.write_all(format!("{}\n", sanitize(message.as_str())).as_bytes())
			.await;
	}
	if !json {
		return Ok(());
	}
	let line = match event {
		AgentEvent::Turn { turn_id, event } => match event.event.as_ref() {
			Some(turn_event::Event::PartStart(start)) => {
				if let Ok(kind) = part_start::Kind::try_from(start.kind) {
					state.part_kinds.insert(start.index, kind);
				}
				if state.assistant_started {
					return Ok(());
				}
				state.assistant_started = true;
				serde_json::json!({
					"type":"message_start",
					"message":{"role":"assistant","content":[]},
					"turnId":turn_id.as_str()
				})
			},
			Some(turn_event::Event::PartDelta(delta)) => {
				let kind = state.part_kinds.get(&delta.index).copied();
				let text = String::from_utf8_lossy(&delta.chunk);
				serde_json::json!({
					"type":"message_update",
					"assistantMessageEvent": {
						"type": match kind {
							Some(part_start::Kind::Text) => "text_delta",
							Some(part_start::Kind::Thinking) => "thinking_delta",
							Some(part_start::Kind::ToolCall) => "toolcall_delta",
							_ => "text_delta",
						},
						"delta":sanitize(&text),
					}
				})
			},
			Some(turn_event::Event::PartEnd(end)) => {
				state.part_kinds.remove(&end.index);
				return Ok(());
			},
			Some(turn_event::Event::Outcome(outcome)) => {
				state.settled_items.extend(outcome.output.iter().cloned());
				return Ok(());
			},
			Some(_) | None => return Ok(()),
		},
		AgentEvent::ToolObserved { .. } | AgentEvent::PlanStateChanged { .. } => return Ok(()),
		AgentEvent::ToolOpened { call_id, name, rev } => {
			serde_json::json!({"type":"tool_execution_start","toolCallId":call_id.as_str(),"toolName":name.as_str(),"rev":rev.to_string()})
		},
		AgentEvent::ToolArgs { call_id, fragment, .. } => {
			serde_json::json!({
				"type":"message_update",
				"assistantMessageEvent":{
					"type":"toolcall_delta",
					"toolCallId":call_id.as_str(),
					"delta":String::from_utf8_lossy(fragment)
				}
			})
		},
		AgentEvent::ToolUpdate { call_id, json } => {
			serde_json::json!({"type":"tool_execution_update","toolCallId":call_id.as_str(),"content":String::from_utf8_lossy(json)})
		},
		AgentEvent::ToolFinished { call_id, .. } => {
			serde_json::json!({"type":"tool_execution_end","toolCallId":call_id.as_str()})
		},
		AgentEvent::PhaseChanged { .. }
		| AgentEvent::RosterChanged { .. }
		| AgentEvent::JobRegistered { .. }
		| AgentEvent::JobSettled { .. } => return Ok(()),
		AgentEvent::Failed { message, .. } => {
			serde_json::json!({
				"type":"message_update",
				"assistantMessageEvent":{"type":"error","reason":"error","error":sanitize(message.as_str())}
			})
		},
		AgentEvent::TitleChanged { title, source } => {
			serde_json::json!({"type":"session_info_update","name":title.as_str(),"source":format!("{source:?}")})
		},
		AgentEvent::RunStateChanged { from, to } => {
			if <&str>::from(*to) != "running" {
				return Ok(());
			}
			serde_json::json!({
				"type":"agent_start",
				"from":<&str>::from(*from),
				"to":<&str>::from(*to)
			})
		},
		AgentEvent::Snapshot(_) => return Ok(()),
		AgentEvent::PeerRelay(_) => return Ok(()),
	};
	let mut encoded = serde_json::to_string(&line)?;
	encoded.push('\n');
	stdout.write_all(encoded.as_bytes()).await?;
	Ok(())
}

async fn emit_json_settlement(
	summary: &AgentRunSummary,
	turn_id: &str,
	state: &mut JsonTurnState,
	stdout: &mut Stdout,
) -> Result<(), PrintTurnError> {
	let assistant = summary
		.outcome
		.as_ref()
		.and_then(|outcome| {
			outcome.output.iter().rev().find_map(|item| {
				let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
					return None;
				};
				(message.role() == Role::Assistant).then_some(message)
			})
		})
		.map(|message| message_json(message, Some(stop_reason(summary))))
		.unwrap_or_else(|| {
			serde_json::json!({
				"role":"assistant",
				"content":[],
				"stopReason":stop_reason(summary),
			})
		});
	if !state.assistant_started {
		write_json_value(
			stdout,
			&serde_json::json!({
				"type":"message_start",
				"message":{"role":"assistant","content":[]},
				"turnId":turn_id,
			}),
		)
		.await?;
	}
	write_json_value(
		stdout,
		&serde_json::json!({"type":"message_end","message":assistant,"turnId":turn_id}),
	)
	.await?;
	let tool_results = state
		.settled_items
		.iter()
		.filter_map(|item| match item.kind.as_ref() {
			Some(item::Kind::ToolResult(result)) => Some(tool_result_json(result)),
			_ => None,
		})
		.collect::<Vec<_>>();
	write_json_value(
		stdout,
		&serde_json::json!({"type":"turn_end","message":assistant,"toolResults":tool_results}),
	)
	.await?;
	let messages = state
		.settled_items
		.iter()
		.filter_map(canonical_item_json)
		.collect::<Vec<_>>();
	write_json_value(stdout, &serde_json::json!({"type":"agent_end","messages":messages})).await
}

async fn write_json_value(stdout: &mut Stdout, value: &Value) -> Result<(), PrintTurnError> {
	let mut encoded = serde_json::to_string(value)?;
	encoded.push('\n');
	stdout.write_all(encoded.as_bytes()).await?;
	Ok(())
}

fn canonical_item_json(item: &Item) -> Option<Value> {
	match item.kind.as_ref()? {
		item::Kind::Message(message) => Some(message_json(message, None)),
		item::Kind::ToolCall(call) => Some(serde_json::json!({
			"role":"assistant",
			"content":[{
				"type":"toolCall",
				"id":call.id,
				"name":call.name,
				"arguments":serde_json::from_slice::<Value>(&call.args_json).unwrap_or(Value::Null),
			}],
		})),
		item::Kind::ToolResult(result) => Some(tool_result_json(result)),
	}
}

fn message_json(message: &Message, stop_reason: Option<&str>) -> Value {
	let content = message
		.parts
		.iter()
		.filter_map(|part| match part.kind.as_ref()? {
			part::Kind::Text(text) => Some(serde_json::json!({"type":"text","text":sanitize(text)})),
			part::Kind::Thinking(thinking) => {
				Some(serde_json::json!({"type":"thinking","thinking":sanitize(&thinking.text)}))
			},
			part::Kind::Blob(blob) => Some(serde_json::json!({
				"type":if blob.mime.starts_with("image/") {"image"} else {"document"},
				"mimeType":blob.mime,
				"data":omp_core::base64::encode(&blob.inline),
			})),
			part::Kind::Fallback(fallback) => Some(serde_json::json!({
				"type":"modelFallback",
				"fromModel":fallback.from_model,
				"toModel":fallback.to_model,
			})),
			part::Kind::ServerTool(tool) => Some(serde_json::json!({
				"type":"serverTool",
				"id":tool.id,
				"name":tool.name,
				"payload":serde_json::from_slice::<Value>(&tool.payload_json).unwrap_or(Value::Null),
			})),
		})
		.collect::<Vec<_>>();
	let role = match message.role() {
		Role::System => "system",
		Role::User => "user",
		Role::Assistant => "assistant",
		Role::Unspecified => "unknown",
	};
	let mut value = serde_json::json!({"role":role,"content":content});
	if let Some(stop_reason) = stop_reason {
		value["stopReason"] = Value::String(stop_reason.to_owned());
	}
	value
}

fn tool_result_json(result: &omp_proto::thread::v1::ToolResult) -> Value {
	let content = result
		.parts
		.iter()
		.filter_map(|part| match part.kind.as_ref()? {
			part::Kind::Text(text) => Some(serde_json::json!({"type":"text","text":sanitize(text)})),
			part::Kind::Blob(blob) if blob.mime.starts_with("image/") => Some(serde_json::json!({
				"type":"image",
				"mimeType":blob.mime,
				"data":omp_core::base64::encode(&blob.inline),
			})),
			_ => None,
		})
		.collect::<Vec<_>>();
	serde_json::json!({
		"role":"toolResult",
		"toolCallId":result.call_id,
		"toolName":result.name,
		"content":content,
		"isError":result.is_error,
	})
}

fn stop_reason(summary: &AgentRunSummary) -> &'static str {
	match summary.settlement {
		RunSettlement::Success | RunSettlement::Warning => "stop",
		RunSettlement::SilentCompactionTransition | RunSettlement::CallerAbort => "aborted",
		RunSettlement::MaxTokens => "length",
		RunSettlement::TerminalFault => "error",
	}
}

async fn emit_warning(summary: &AgentRunSummary, stderr: &mut Stderr) -> miette::Result<()> {
	if summary.settlement != RunSettlement::Warning {
		return Ok(());
	}
	if let Some(outcome) = &summary.outcome {
		for diagnostic in &outcome.diagnostics {
			stderr
				.write_all(format!("Warning: {}\n", sanitize(&diagnostic.detail)).as_bytes())
				.await
				.into_diagnostic()?;
		}
		for unsupported in &outcome.unsupported {
			stderr
				.write_all(
					format!(
						"Warning: {}: {}\n",
						sanitize(&unsupported.what),
						sanitize(&unsupported.detail)
					)
					.as_bytes(),
				)
				.await
				.into_diagnostic()?;
		}
	}
	Ok(())
}

async fn emit_finalizer_report(report: FinalizerReport, stderr: &mut Stderr) -> miette::Result<()> {
	for phase in &report.timed_out {
		stderr
			.write_all(format!("Finalizer timed out: {}\n", <&str>::from(*phase)).as_bytes())
			.await
			.into_diagnostic()?;
	}
	if let Some(error) = report.stdout_error {
		return Err(error).into_diagnostic();
	}
	Ok(())
}

pub(crate) fn initial_message(parts: Vec<ContentPart>, system: Option<Str>) -> Vec<Item> {
	let mut items = Vec::with_capacity(usize::from(system.is_some()) + 1);
	if let Some(system) = system {
		items.push(message(Role::System, vec![Part {
			kind: Some(part::Kind::Text(system.to_string())),
		}]));
	}
	let mut canonical = Vec::with_capacity(parts.len());
	for part in parts {
		match part {
			ContentPart::Text { text, .. } => {
				canonical.push(Part { kind: Some(part::Kind::Text(text.to_string())) })
			},
			ContentPart::Image(media) | ContentPart::Document(media) => {
				if let MediaInput::Bytes { media_type, data } = media {
					canonical.push(Part {
						kind: Some(part::Kind::Blob(Blob {
							hash:   Bytes::copy_from_slice(Hash32::sum(&data).as_bytes()),
							mime:   media_type.to_string(),
							size:   data.len() as u64,
							inline: data,
							detail: blob::Detail::Auto as i32,
						})),
					});
				}
			},
			_ => {},
		}
	}
	items.push(message(Role::User, canonical));
	items
}

fn message(role: Role, parts: Vec<Part>) -> Item {
	Item { kind: Some(item::Kind::Message(Message { role: role as i32, parts })), ..Item::default() }
}

async fn write_final_assistant(
	summary: &AgentRunSummary,
	print_thoughts: bool,
	stdout: &mut Stdout,
) -> miette::Result<()> {
	let Some(message) = summary.outcome.as_ref().and_then(|outcome| {
		outcome.output.iter().rev().find_map(|item| {
			let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
				return None;
			};
			(message.role() == Role::Assistant).then_some(message)
		})
	}) else {
		return Ok(());
	};
	for part in &message.parts {
		let text = match part.kind.as_ref() {
			Some(part::Kind::Text(text)) => Some(text.as_str()),
			Some(part::Kind::Thinking(thinking))
				if print_thoughts && !thinking.text.trim().is_empty() =>
			{
				Some(thinking.text.as_str())
			},
			_ => None,
		};
		if let Some(text) = text {
			stdout
				.write_all(sanitize(text).as_bytes())
				.await
				.into_diagnostic()?;
			stdout.write_all(b"\n").await.into_diagnostic()?;
		}
	}
	Ok(())
}

pub(crate) async fn initial_parts(
	words: &[Str],
	auto_resize_images: bool,
) -> miette::Result<Vec<ContentPart>> {
	let mut parts = Vec::new();
	let mut text = String::new();
	let mut consumed = 0usize;
	for word in words {
		if let Some(path) = word.strip_prefix("@") {
			let attachment =
				read_reference(Path::new(path.as_str()), &mut consumed, auto_resize_images)?;
			match attachment {
				Attachment::Text(contents) => append_text(&mut text, &contents),
				Attachment::Image { media_type, data } => {
					parts.push(ContentPart::Image(MediaInput::Bytes { media_type, data }));
				},
				Attachment::Document { media_type, data } => {
					parts.push(ContentPart::Document(MediaInput::Bytes { media_type, data }));
				},
			}
		} else {
			append_text(&mut text, word);
		}
	}
	if !io::stdin().is_terminal() {
		let mut piped = String::new();
		stdin().read_to_string(&mut piped).await.into_diagnostic()?;
		text = combine_stdin_and_body(piped, text);
	}
	if !text.is_empty() {
		parts.insert(0, ContentPart::Text { text: text.into(), proof: None });
	}
	Ok(parts)
}

fn combine_stdin_and_body(mut piped: String, body: String) -> String {
	if piped.is_empty() {
		return body;
	}
	if body.is_empty() {
		return piped;
	}
	if !piped.ends_with('\n') {
		piped.push('\n');
	}
	piped.push_str(&body);
	piped
}

fn append_text(target: &mut String, value: &str) {
	if !target.is_empty() {
		target.push(' ');
	}
	target.push_str(value);
}

enum Attachment {
	Text(String),
	Image { media_type: Str, data: Bytes },
	Document { media_type: Str, data: Bytes },
}

fn read_reference(
	path: &Path,
	consumed: &mut usize,
	auto_resize_images: bool,
) -> miette::Result<Attachment> {
	let metadata = fs::metadata(path).into_diagnostic()?;
	if metadata.is_dir() {
		return read_directory_reference(path);
	}
	let bytes = fs::read(path).into_diagnostic()?;
	*consumed = consumed
		.checked_add(bytes.len())
		.ok_or_else(|| miette!("attachment budget overflow"))?;
	if *consumed > MAX_TOTAL_ATTACHMENT_BYTES {
		return Ok(skip_notice(path, "total attachment budget exceeded", bytes.len()));
	}
	if let Some(media_type) = image_media_type(&bytes) {
		if bytes.len() > MAX_AUTO_READ_IMAGE_BYTES {
			return Ok(skip_notice(path, "too large", bytes.len()));
		}
		if !auto_resize_images {
			return Ok(Attachment::Image {
				media_type: Str::new_static(media_type),
				data:       Bytes::from(bytes),
			});
		}
		return match image_attachment::prepare(Bytes::from(bytes), true) {
			Ok(image) => Ok(Attachment::Image {
				media_type: Str::new_static(image.media_type),
				data:       image.bytes,
			}),
			Err(ImageAttachmentError::Unsupported) => {
				Ok(skip_notice(path, "unrecognized image encoding", metadata.len() as usize))
			},
			Err(_) => Ok(skip_notice(path, "too large", metadata.len() as usize)),
		};
	}
	if let Some(media_type) = document_media_type(path, &bytes) {
		return Ok(Attachment::Document {
			media_type: media_type.into(),
			data:       Bytes::from(bytes),
		});
	}
	if bytes.len() > MAX_AUTO_READ_TEXT_BYTES {
		return Ok(skip_notice(path, "too large", bytes.len()));
	}
	if omp_tools::read::is_probably_binary_header(
		&bytes[..bytes.len().min(omp_tools::read::BINARY_SNIFF_BYTES)],
	) {
		return Ok(skip_notice(path, "binary file", bytes.len()));
	}
	let content = match String::from_utf8(bytes) {
		Ok(content) => content,
		Err(error) => return Ok(skip_notice(path, "binary file", error.as_bytes().len())),
	};
	let tag = omp_hashline::compute_file_hash(&content);
	let header = omp_hashline::format_hashline_header(&path.to_string_lossy(), tag.as_str());
	let numbered = omp_hashline::format_numbered_lines(&content, 1);
	Ok(Attachment::Text(format!(
		"<file name=\"{}\">\n{header}\n{numbered}\n</file>",
		path.display()
	)))
}

fn read_directory_reference(path: &Path) -> miette::Result<Attachment> {
	let mut entries = Vec::new();
	for entry in fs::read_dir(path).into_diagnostic()? {
		let entry = entry.into_diagnostic()?;
		let metadata = match entry.metadata() {
			Ok(metadata) => metadata,
			Err(_) => continue,
		};
		let modified_ms = metadata
			.modified()
			.ok()
			.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
			.and_then(|duration| u64::try_from(duration.as_millis()).ok())
			.unwrap_or(0);
		entries.push(dirtree::DirEntry {
			relative_path: entry.file_name().to_string_lossy().into_owned().into(),
			is_dir: metadata.is_dir(),
			size: metadata.len(),
			modified_ms,
		});
	}
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
		.unwrap_or(0);
	let listing = dirtree::render_directory_mention(&entries, now_ms, DIRECTORY_MENTION_LIMIT);
	Ok(Attachment::Text(format!("<directory name=\"{}\">\n{listing}\n</directory>", path.display())))
}

fn skip_notice(path: &Path, reason: &str, bytes: usize) -> Attachment {
	Attachment::Text(format!(
		"<file name=\"{}\">(skipped auto-read: {reason}, {} bytes)</file>",
		path.display(),
		bytes
	))
}

fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
	if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		Some("image/png")
	} else if bytes.starts_with(b"\xff\xd8\xff") {
		Some("image/jpeg")
	} else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
		Some("image/gif")
	} else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
		Some("image/webp")
	} else {
		None
	}
}

fn document_media_type(path: &Path, bytes: &[u8]) -> Option<&'static str> {
	if bytes.starts_with(b"%PDF-") {
		return Some("application/pdf");
	}
	if bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
		return Some("application/vnd.ms-office");
	}
	match path
		.extension()
		.and_then(|extension| extension.to_str())
		.map(str::to_ascii_lowercase)
		.as_deref()
	{
		Some("docx") => {
			Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		},
		Some("pptx") => {
			Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
		},
		Some("xlsx") => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
		Some("ipynb") => Some("application/x-ipynb+json"),
		Some("html" | "htm") => Some("text/html"),
		_ => None,
	}
}

async fn write_json(stdout: &mut Stdout, line: &str) -> miette::Result<()> {
	stdout.write_all(line.as_bytes()).await.into_diagnostic()?;
	stdout.flush().await.into_diagnostic()
}

fn sanitize(text: &str) -> String {
	text.replace('\0', "")
}

#[cfg(test)]
mod tests {

	use omp_driver::settings::Settings;

	use super::*;
	#[test]
	fn piped_stdin_precedes_the_positional_body() {
		assert_eq!(
			combine_stdin_and_body("context".into(), "review this".into()),
			"context\nreview this"
		);
		assert_eq!(
			combine_stdin_and_body("context\n".into(), "review this".into()),
			"context\nreview this"
		);
	}
	#[test]
	fn print_suppresses_only_fresh_startup_plan_without_yolo() {
		let mut settings = Settings::default();
		settings.plan.enabled = true;
		settings.plan.default_on_startup = true;
		assert!(startup_plan_ignored(&settings, true, false));
		assert!(!startup_plan_ignored(&settings, false, false));
		assert!(!startup_plan_ignored(&settings, true, true));
	}

	#[test]
	fn classifies_text_documents_and_images_by_content() {
		assert_eq!(image_media_type(b"\x89PNG\r\n\x1a\nmore"), Some("image/png"));
		assert_eq!(
			document_media_type(Path::new("report.pdf"), b"%PDF-1.7"),
			Some("application/pdf")
		);
		assert!(document_media_type(Path::new("sheet.xlsx"), b"PK\x03\x04").is_some());
	}
	#[test]
	fn canonical_json_messages_retain_complete_text_and_thinking() {
		let message = Message {
			role:  Role::Assistant as i32,
			parts: vec![Part { kind: Some(part::Kind::Text("answer".into())) }, Part {
				kind: Some(part::Kind::Thinking(omp_proto::thread::v1::Thinking {
					text: "reason".into(),
					..Default::default()
				})),
			}],
		};
		assert_eq!(
			message_json(&message, Some("stop")),
			serde_json::json!({
				"role":"assistant",
				"content":[
					{"type":"text","text":"answer"},
					{"type":"thinking","thinking":"reason"}
				],
				"stopReason":"stop"
			})
		);
	}

	#[test]
	fn canonical_json_tool_results_retain_authoritative_content() {
		let result = omp_proto::thread::v1::ToolResult {
			call_id: "call-1".into(),
			name: "echo".into(),
			parts: vec![Part { kind: Some(part::Kind::Text("done".into())) }],
			..Default::default()
		};
		assert_eq!(
			tool_result_json(&result),
			serde_json::json!({
				"role":"toolResult",
				"toolCallId":"call-1",
				"toolName":"echo",
				"content":[{"type":"text","text":"done"}],
				"isError":false
			})
		);
	}
	#[test]
	fn attachment_budget_returns_an_explicit_skip_notice() {
		let file = env::temp_dir().join("omp-print-large-reference.txt");
		fs::write(&file, vec![b'x'; MAX_AUTO_READ_TEXT_BYTES + 1]).expect("write");
		let Attachment::Text(notice) = read_reference(&file, &mut 0, true).expect("notice") else {
			panic!("text notice");
		};
		assert!(notice.contains("skipped auto-read: too large"));
		let _ = fs::remove_file(file);
	}

	#[test]
	fn text_binary_and_directory_mentions_are_classified_explicitly() {
		let tree = tempfile::tempdir().unwrap();
		let text = tree.path().join("main.rs");
		fs::write(&text, "fn main() {}\n").unwrap();
		let Attachment::Text(rendered) = read_reference(&text, &mut 0, true).unwrap() else {
			panic!("text");
		};
		assert!(rendered.contains("["));
		assert!(rendered.contains("#"));
		assert!(rendered.contains("1:fn main() {}"));

		let binary = tree.path().join("blob.bin");
		fs::write(&binary, b"a\0b").unwrap();
		let Attachment::Text(notice) = read_reference(&binary, &mut 0, true).unwrap() else {
			panic!("binary notice");
		};
		assert!(notice.contains("binary file"));

		let Attachment::Text(listing) = read_reference(tree.path(), &mut 0, true).unwrap() else {
			panic!("directory");
		};
		assert!(listing.contains("blob.bin"));
		assert!(listing.contains("main.rs"));
	}
}
