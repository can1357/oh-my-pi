//! Deterministic, journal-derived tool-card gallery.

use bytes::Bytes;
use omp_core::{CowBytes, Str};
use omp_dom::{Handle, KnownTag, Node, PropId, Snapshot, Tag, Value as DomValue};
use omp_journal::EntryId;
use omp_session::{ComponentRegistry, Session};
use omp_tool::Part;
use omp_tools::{eval, shell};
use omp_tui::{Charset, Frame, IntoComponent as _, Ui, UiContext, dom};
use serde_json::{Value, value::RawValue};
use smallvec::SmallVec;
use strum::{Display, EnumIter};
use thiserror::Error;

use crate::cards::{CardRegistry, CardStatus, CardView, fixtures::CardFixture};

/// Tool lifecycle states rendered by the gallery, in display order.
///
/// The `Display` spelling is the label printed above each state
/// (`gallery-cli.ts` `GALLERY_STATE_LABELS`).
#[derive(Clone, Copy, Debug, Display, EnumIter, Eq, PartialEq)]
pub enum GalleryState {
	/// Arguments are still streaming.
	#[strum(serialize = "streaming args")]
	StreamingArgs,
	/// The call is executing.
	#[strum(serialize = "in progress")]
	InProgress,
	/// The call settled successfully.
	#[strum(serialize = "done")]
	Done,
	/// The call faulted, or settled a payload that reports the tool's own
	/// failure (a Python exception is `eval`'s `CellOutcome::Error`, not a
	/// fault).
	#[strum(serialize = "failed")]
	Failed,
}

impl GalleryState {
	/// All states in reference-gallery order.
	pub const ALL: [Self; 4] = [Self::StreamingArgs, Self::InProgress, Self::Done, Self::Failed];

	const fn index(self) -> usize {
		match self {
			Self::StreamingArgs => 0,
			Self::InProgress => 1,
			Self::Done => 2,
			Self::Failed => 3,
		}
	}
}

/// One rendered fixture state.
pub struct GallerySection {
	/// Gallery fixture identity.
	pub tool:  &'static str,
	/// Human-readable fixture title.
	pub title: &'static str,
	/// Lifecycle state represented by this frame.
	pub state: GalleryState,
	/// Fully laid-out card frame.
	pub frame: Frame,
}

/// Failure to materialize or render a gallery fixture.
#[derive(Debug, Error)]
pub enum GalleryError {
	/// A fixture payload was not valid complete JSON for its lifecycle state.
	#[error("gallery fixture JSON is invalid")]
	Json(#[from] serde_json::Error),
	/// A temporary journal could not be created.
	#[error("gallery temporary journal failed")]
	Temp(#[from] std::io::Error),
	/// The journal-to-DOM fold failed.
	#[error("gallery session fold failed")]
	Session(#[from] omp_session::SessionError),
	/// The folded call element or one of its mandatory children is absent.
	#[error("gallery fixture did not materialize {0}")]
	Missing(&'static str),
}

/// Returns gallery fixture names in stable reference order.
#[must_use]
pub fn fixture_names() -> Vec<&'static str> {
	let mut names = crate::cards::fixtures::all()
		.into_iter()
		.map(|fixture| fixture.tool)
		.collect::<Vec<_>>();
	names.sort_unstable();
	names
}

/// Materializes and renders selected card fixtures through real sessions.
///
/// `tool = None` renders every fixture in stable reference order.
pub fn render_sections(
	tool: Option<&str>,
	states: &[GalleryState],
	width: u16,
	expanded: bool,
) -> Result<Vec<GallerySection>, GalleryError> {
	let mut fixtures = crate::cards::fixtures::all();
	fixtures.sort_unstable_by_key(|fixture| fixture.tool);
	let registry = CardRegistry::standard();
	let mut sections = Vec::with_capacity(fixtures.len().saturating_mul(states.len()));
	for fixture in fixtures {
		if tool.is_some_and(|wanted| wanted != fixture.tool) {
			continue;
		}
		for &state in states {
			sections.push(render_fixture(&registry, fixture, state, width, expanded)?);
		}
	}
	Ok(sections)
}

fn render_fixture(
	registry: &CardRegistry,
	fixture: &'static CardFixture,
	state: GalleryState,
	width: u16,
	expanded: bool,
) -> Result<GallerySection, GalleryError> {
	let directory = tempfile::tempdir()?;
	let journal = directory.path().join("gallery.oms");
	let mut session = Session::create(journal, ComponentRegistry::standard())?;
	session.begin_turn()?;
	let state_fixture = fixture.states[state.index()];
	let call_id = format!("gallery-{}-{}", fixture.tool, state.index());
	let tool_name = card_tool(fixture.tool);
	let revision = if tool_name == "github" { 3 } else { 1 };
	let call = if state == GalleryState::StreamingArgs {
		let (call, sid) = session.call_streaming(tool_name, revision, call_id.as_str(), None)?;
		if !state_fixture.args.is_empty() {
			session.stream_append(sid, state_fixture.args)?;
		}
		call
	} else {
		session.call(
			tool_name,
			revision,
			call_id.as_str(),
			None,
			Some(raw(state_fixture.args)?),
			None,
		)?
	};
	if state != GalleryState::StreamingArgs {
		if let Some(update) = state_fixture.update {
			session.call_update(call, raw(update)?)?;
		}
		let tool = card_tool(fixture.tool);
		match state {
			GalleryState::StreamingArgs | GalleryState::InProgress => {},
			// A `Failed` fixture without a fault settles a payload that
			// carries the tool's own failure verdict, exactly as the tool
			// would (`eval` journals `Ok(Payload)` for a Python exception).
			GalleryState::Done | GalleryState::Failed if state_fixture.fault.is_none() => {
				let (payload, frames) =
					fixture_payload(tool, state_fixture.args, state_fixture.result.unwrap_or("null"))?;
				stream_output(&mut session, call, &frames)?;
				let parts = projected_parts(tool, &payload)?;
				session.settle_projected(call, outcome_value("ok", payload)?, raw_parts(parts)?)?;
			},
			GalleryState::Done | GalleryState::Failed => {
				let raw_fault: Value =
					serde_json::from_str(state_fixture.fault.expect("fault checked above"))?;
				let fault = fixture_fault(tool, state_fixture.args, raw_fault);
				stream_output(&mut session, call, &fault_frames(tool, &fault))?;
				let parts = projected_parts(tool, &fault)?;
				session.fail_projected(call, outcome_value("faulted", fault)?, raw_parts(parts)?)?;
			},
		}
	}
	let snapshot = session.dom().snapshot();
	let tool = find_snapshot_call(&snapshot, call_id.as_str())
		.ok_or(GalleryError::Missing("tool element"))?;
	let node = snapshot
		.get(tool)
		.ok_or(GalleryError::Missing("tool element"))?;
	let input =
		child(&snapshot, tool, KnownTag::Input).ok_or(GalleryError::Missing("input element"))?;
	let status = node
		.prop(&PropId::Status.into())
		.and_then(DomValue::as_str)
		.map_or(CardStatus::InProgress, CardStatus::from_dom);
	if status == CardStatus::Done {
		let result =
			child(&snapshot, tool, KnownTag::Result).ok_or(GalleryError::Missing("result element"))?;
		if result.prop(&PropId::Outcome.into()).is_none()
			|| result.prop(&PropId::Data.into()).is_none()
		{
			return Err(GalleryError::Missing("projected result truth"));
		}
	}
	let diagnostics = snapshot
		.children(tool)
		.iter()
		.filter_map(|handle| snapshot.get(*handle))
		.filter(|node| node.tag == Tag::Known(KnownTag::Diag))
		.collect::<Vec<_>>();
	let diag = diagnostics.iter().rev().copied().find(|node| {
		node
			.prop(&PropId::Severity.into())
			.and_then(DomValue::as_str)
			== Some("error")
			|| node.prop(&PropId::Fault.into()).is_some()
	});
	if status == CardStatus::Failed {
		let diag = diag.ok_or(GalleryError::Missing("diag element"))?;
		if diag.prop(&PropId::Fault.into()).is_none() || diag.prop(&PropId::Data.into()).is_none() {
			return Err(GalleryError::Missing("projected fault truth"));
		}
	}
	let notices = diagnostics
		.iter()
		.copied()
		.filter(|node| diag.is_none_or(|terminal| !std::ptr::eq(*node, terminal)))
		.collect::<SmallVec<_, 2>>();
	let result = child(&snapshot, tool, KnownTag::Result);
	// Like the live projection (`project.rs` `card_view`), `output` is the
	// text of a running call only; settled cards read the `<result>` element.
	let output = (status == CardStatus::InProgress)
		.then(|| result.and_then(node_text))
		.flatten();
	let view = CardView {
		input,
		result,
		diag,
		notices,
		usage: child(&snapshot, tool, KnownTag::Usage),
		status,
		output,
		started: None,
	};
	let mut ui_context = UiContext::default();
	ui_context.charset = Charset::NerdFont;
	let card = registry.render(card_tool(fixture.tool), &view, expanded, &ui_context);
	// Custom/state renderers already own their vertical extent. Framed
	// tool calls inherit the transcript block's one-row vertical margin.
	let component = if matches!(fixture.tool, "context_gauge" | "custom" | "read_group") {
		card
	} else {
		dom! { <col pad="1 0">{card}</col> }.into_component()
	};
	let ui = Ui::from_root(component, width, ui_context);
	Ok(GallerySection { tool: fixture.tool, title: fixture.title, state, frame: ui.frame().clone() })
}

fn raw(text: &str) -> Result<Box<RawValue>, serde_json::Error> {
	let value: serde_json::Value = serde_json::from_str(text)?;
	serde_json::value::to_raw_value(&value)
}

/// One ordered output update a tool emits before it settles, with the text
/// its bytes reveal on the `<result>` stream.
struct OutputFrame {
	update: Value,
	text:   String,
}

/// Streams fixture output exactly as dispatch does (`OutputStream::push`):
/// the bytes are revealed on the bounded `<result>` text stream, then the
/// typed update is journaled with its `data` emptied so the bytes are never
/// journaled twice.
fn stream_output(
	session: &mut Session,
	call: EntryId,
	frames: &[OutputFrame],
) -> Result<(), GalleryError> {
	if frames.is_empty() {
		return Ok(());
	}
	let element = session.call_handle(call)?;
	let dom = session.dom();
	let result = dom
		.children(element)
		.iter()
		.copied()
		.find(|child| {
			dom.get(*child)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Result))
		})
		.ok_or(GalleryError::Missing("result element"))?;
	let sid = session.stream_open(result, PropId::Text.into())?;
	for frame in frames {
		session.stream_append(sid, &frame.text)?;
		let mut update = frame.update.clone();
		if let Some(data) = update.get_mut("data") {
			*data = Value::Array(Vec::new());
		}
		session.call_update(call, serde_json::value::to_raw_value(&update)?)?;
	}
	session.stream_close(sid)?;
	Ok(())
}

/// The readable `{"data": "…"}` frames of an exec fixture, in order.
fn text_frames(value: &Value, key: &str) -> Vec<String> {
	value
		.get(key)
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(|frame| frame.get("data").and_then(Value::as_str))
		.map(str::to_owned)
		.collect()
}

/// The live `bash@2` updates for a settled transcript.
fn shell_frames(payload: &shell::Payload) -> Vec<OutputFrame> {
	payload
		.transcript
		.iter()
		.map(|frame| OutputFrame {
			update: serde_json::to_value(shell::Update {
				channel:  frame.channel,
				data:     frame.data.clone(),
				sequence: frame.sequence,
				exec_id:  payload.exec_id.clone(),
				started:  frame.sequence == 1,
				terminal: false,
			})
			.expect("shell update serializes"),
			text:   String::from_utf8_lossy(frame.data.as_ref()).into_owned(),
		})
		.collect()
}

/// Output the tool streamed before faulting with `fault`.
fn fault_frames(tool: &str, fault: &Value) -> Vec<OutputFrame> {
	match tool {
		"bash" => serde_json::from_value::<shell::Fault>(fault.clone())
			.ok()
			.and_then(|fault| match fault {
				shell::Fault::CommandFailed { payload } => Some(shell_frames(&payload)),
				_ => None,
			})
			.unwrap_or_default(),
		_ => Vec::new(),
	}
}

/// The durable `bash@2` payload for a readable fixture transcript
/// (`{"transcript":[{"data":"…"}],"status":{"exit_code":…,"wall_clock_ms":…
/// }}`).
fn shell_payload(args: &Value, value: &Value) -> shell::Payload {
	let exit_code = value
		.pointer("/status/exit_code")
		.and_then(Value::as_i64)
		.and_then(|code| i32::try_from(code).ok());
	shell::Payload {
		session_id:  Bytes::new(),
		exec_id:     Bytes::new(),
		command:     Str::new(
			args
				.get("command")
				.and_then(Value::as_str)
				.unwrap_or_default(),
		),
		transcript:  text_frames(value, "transcript")
			.into_iter()
			.enumerate()
			.map(|(index, text)| shell::TranscriptFrame {
				channel:  shell::OutputChannel::Stdout,
				data:     CowBytes::from(text.into_bytes()),
				sequence: index as u64 + 1,
			})
			.collect(),
		attachments: Vec::new(),
		adjustments: Vec::new(),
		status:      shell::ExecStatus {
			outcome: shell::ExecOutcome::Exited,
			exit_code,
			signal: None,
			wall_clock_ms: value
				.pointer("/status/wall_clock_ms")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			spilled_output: None,
			aborted: false,
			effects_unknown: false,
			diags: Vec::new(),
			final_cwd_uri: None,
			final_cwd_revision: 0,
		},
	}
}

/// The durable `eval@1` payload for a readable fixture cell
/// (`{"frames":[{"data":"…"}],"display_outputs":[…],"status":{…}}`) and the
/// stdout updates the cell streamed before settling: `eval` never retains
/// stdout in its payload, so the card reads it from the `<result>` stream.
fn eval_payload(
	args: &Value,
	value: &Value,
) -> Result<(eval::Payload, Vec<OutputFrame>), serde_json::Error> {
	let frames = text_frames(value, "frames")
		.into_iter()
		.enumerate()
		.map(|(index, text)| {
			let update = serde_json::to_value(eval::Update {
				channel:  eval::OutputChannel::Stdout,
				data:     CowBytes::from(text.clone().into_bytes()),
				sequence: index as u64 + 1,
			})?;
			Ok(OutputFrame { update, text })
		})
		.collect::<Result<Vec<_>, serde_json::Error>>()?;
	let status: eval::CellStatus =
		serde_json::from_value(value.get("status").cloned().unwrap_or_else(
			|| serde_json::json!({"outcome":"complete","exit_code":0,"duration_ms":0,"exception":null}),
		))?;
	let display_outputs: Vec<eval::DisplayOutput> = serde_json::from_value(
		value
			.get("display_outputs")
			.cloned()
			.unwrap_or_else(|| Value::Array(Vec::new())),
	)?;
	let payload = eval::Payload {
		session_id: Bytes::new(),
		cell_id: Bytes::new(),
		language: eval::Language::Py,
		title: args.get("title").and_then(Value::as_str).map(Str::new),
		code: Str::new(args.get("code").and_then(Value::as_str).unwrap_or_default()),
		reset: false,
		had_output: !frames.is_empty(),
		result: None,
		display_outputs,
		status,
	};
	Ok((payload, frames))
}

/// Wraps a fixture payload in the `CallOutcome` envelope the kernel journals
/// (`{"kind":"ok"|"faulted","value":…}`), so cards read the gallery exactly
/// like a live session.
fn outcome_value(kind: &str, value: serde_json::Value) -> Result<Box<RawValue>, serde_json::Error> {
	serde_json::value::to_raw_value(&serde_json::json!({ "kind": kind, "value": value }))
}

fn raw_parts(parts: Vec<Part>) -> Result<Box<RawValue>, serde_json::Error> {
	serde_json::value::to_raw_value(&parts)
}

/// Produces the exact typed durable shape used by the live tool, rather than
/// letting an old gallery-only object masquerade as the payload, plus the
/// ordered output the tool streamed before settling it.
fn fixture_payload(
	tool: &str,
	args: &str,
	text: &str,
) -> Result<(serde_json::Value, Vec<OutputFrame>), serde_json::Error> {
	let value: serde_json::Value = serde_json::from_str(text)?;
	let args: serde_json::Value = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
	match tool {
		"bash" => {
			let payload = shell_payload(&args, &value);
			let frames = shell_frames(&payload);
			return Ok((serde_json::to_value(payload)?, frames));
		},
		"eval" => {
			let (payload, frames) = eval_payload(&args, &value)?;
			return Ok((serde_json::to_value(payload)?, frames));
		},
		_ => {},
	}
	let payload = match tool {
		"hub" => serde_json::json!({ "text": serde_json::to_string(&value)?, "useless": false }),
		"web_search" => {
			let mut response = value.as_object().cloned().unwrap_or_default();
			if let Some(provider) = response.remove("provider") {
				response.entry("engine".to_owned()).or_insert(provider);
			}
			serde_json::json!({ "response": response })
		},
		"debug" => serde_json::json!({
			"action": args.get("action").cloned().unwrap_or_else(|| serde_json::json!("output")),
			"session": null,
			"revision": null,
			"output": "",
			"data": value,
		}),
		"lsp" => serde_json::json!({
			"action": args.get("action").cloned().unwrap_or_else(|| serde_json::json!("diagnostics")),
			"servers": [],
			"output": "",
			"data": value,
		}),
		"github" => serde_json::json!({
			"op": args.get("op").cloned().unwrap_or_else(|| serde_json::json!("repo_view")),
			"output": value.get("output").and_then(serde_json::Value::as_str).unwrap_or_default(),
			"result": value,
			"artifact": null,
			"useless": false,
			"rate_limit_remaining": null,
			"rate_limit_reset": null,
		}),
		"goal" => {
			let goal = value.get("goal").map(|goal| serde_json::json!({
				"id": goal.get("id").cloned().unwrap_or_else(|| serde_json::json!("goal")),
				"objective": goal.get("objective").cloned().unwrap_or_else(|| serde_json::json!("")),
				"status": goal.get("status").cloned().unwrap_or_else(|| serde_json::json!("active")),
				"token_budget": goal.get("token_budget").or_else(|| goal.get("tokenBudget")).cloned(),
				"tokens_used": goal.get("tokens_used").or_else(|| goal.get("tokensUsed")).cloned().unwrap_or_else(|| serde_json::json!(0)),
				"time_used_secs": goal.get("time_used_secs").or_else(|| goal.get("timeUsedSeconds")).cloned().unwrap_or_else(|| serde_json::json!(0)),
				"created_at_ms": goal.get("created_at_ms").or_else(|| goal.get("createdAt")).cloned(),
				"updated_at_ms": goal.get("updated_at_ms").or_else(|| goal.get("updatedAt")).cloned(),
			}));
			serde_json::json!({
				"op": value.get("op").cloned().unwrap_or_else(|| serde_json::json!("get")),
				"goal": goal,
				"remaining_tokens": value.get("remaining_tokens").or_else(|| value.get("remainingTokens")).cloned(),
				"completion_report": value.get("completion_report").or_else(|| value.get("completionBudgetReport")).cloned(),
			})
		},
		"ask" => {
			let answers = value
				.get("answers")
				.and_then(serde_json::Value::as_array)
				.into_iter()
				.flatten()
				.map(|answer| {
					let id = answer
						.get("id")
						.or_else(|| answer.get("question"))
						.cloned()
						.unwrap_or_default();
					let question = args
						.get("questions")
						.and_then(serde_json::Value::as_array)
						.and_then(|questions| {
							questions.iter().find(|question| question.get("id") == Some(&id))
						});
					serde_json::json!({
						"id": id,
						"question": question.and_then(|question| question.get("question")).cloned().unwrap_or_default(),
						"options": question
							.and_then(|question| question.get("options"))
							.and_then(serde_json::Value::as_array)
							.map(|options| options.iter().filter_map(|option| option.get("label")).cloned().collect::<Vec<_>>())
							.unwrap_or_default(),
						"multi": question.and_then(|question| question.get("multi")).and_then(serde_json::Value::as_bool).unwrap_or(false),
						"selected": answer.get("selected").or_else(|| answer.get("options")).cloned().unwrap_or_else(|| serde_json::json!([])),
						"customInput": answer.get("customInput").cloned(),
						"note": answer.get("note").cloned(),
						"timed_out": answer.get("timed_out").or_else(|| answer.get("timedOut")).and_then(serde_json::Value::as_bool).unwrap_or(false),
					})
				})
				.collect::<Vec<_>>();
			serde_json::json!({ "answers": answers })
		},
		"bash" => {
			let projection = value
				.get("transcript")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.filter_map(|frame| frame.get("data").and_then(Value::as_str))
				.collect::<String>();
			serde_json::json!({
				"session_id": [],
				"exec_id": [],
				"command": args.get("command").cloned().unwrap_or_else(|| serde_json::json!("")),
				"transcript": [],
				"attachments": [],
				"adjustments": [],
				"status": {
					"outcome": "exited",
					"exit_code": value.pointer("/status/exit_code").cloned(),
					"signal": null,
					"wall_clock_ms": value.pointer("/status/wall_clock_ms").cloned().unwrap_or_else(|| serde_json::json!(0)),
					"spilled_output": null,
					"aborted": false,
					"effects_unknown": false,
					"final_cwd_uri": null,
					"final_cwd_revision": 0
				},
				"_projection": projection
			})
		},
		"eval" => {
			let projection = value
				.get("frames")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.filter_map(|frame| frame.get("data").and_then(Value::as_str))
				.collect::<String>();
			serde_json::json!({
				"session_id": [],
				"cell_id": [],
				"language": args.get("language").cloned().unwrap_or_else(|| serde_json::json!("py")),
				"title": args.get("title").cloned(),
				"code": args.get("code").cloned().unwrap_or_else(|| serde_json::json!("")),
				"reset": args.get("reset").cloned().unwrap_or_else(|| serde_json::json!(false)),
				"had_output": !projection.is_empty(),
				"result": value.get("result").cloned(),
				"display_outputs": value.get("display_outputs").cloned().unwrap_or_else(|| serde_json::json!([])),
				"status": {
					"outcome": "complete",
					"exit_code": 0,
					"duration_ms": value.pointer("/status/duration_ms").cloned().unwrap_or_else(|| serde_json::json!(0)),
					"exception": null
				},
				"_projection": projection
			})
		},
		"glob" => {
			let matches = value
				.get("matches")
				.or_else(|| value.get("files"))
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(|entry| {
					serde_json::json!({
						"path": entry.get("path").cloned().unwrap_or_else(|| entry.clone()),
						"modified_ms": 0,
						"is_dir": false
					})
				})
				.collect::<Vec<_>>();
			let count = value
				.get("partial_match_count")
				.or_else(|| value.get("file_count"))
				.cloned()
				.unwrap_or_else(|| serde_json::json!(matches.len()));
			serde_json::json!({
				"matches": matches,
				"missing_paths": [],
				"timed_out": false,
				"truncated": false,
				"result_limit_reached": null,
				"partial_match_count": count,
				"timeout_ms": 0
			})
		},
		"grep" => {
			let mut files = serde_json::Map::new();
			for row in value
				.get("matches")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
			{
				let path = row.get("path").and_then(Value::as_str).unwrap_or_default();
				files
					.entry(path.to_owned())
					.or_insert_with(|| serde_json::json!([]))
					.as_array_mut()
					.expect("inserted array")
					.push(serde_json::json!({
						"line_number": row.get("line").cloned().unwrap_or_else(|| serde_json::json!(0)),
						"line": row.get("text").cloned().unwrap_or_else(|| serde_json::json!("")),
						"truncated": false,
						"context_before": [],
						"context_after": []
					}));
			}
			let groups = files
				.into_iter()
				.map(|(path, matches)| {
					serde_json::json!({
						"path": path.clone(),
						"source_key": path,
						"snapshot_tag": null,
						"matches": matches
					})
				})
				.collect::<Vec<_>>();
			serde_json::json!({
				"total_files": groups.len(),
				"files": groups,
				"total_files_lower_bound": false,
				"multi_scope": true,
				"skip": 0,
				"file_limit_reached": false,
				"per_file_limit_reached": false,
				"notes": []
			})
		},
		"ast_grep" => {
			let matches = value
				.get("matches")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(|entry| {
					let line = entry
						.get("line")
						.cloned()
						.unwrap_or_else(|| serde_json::json!(1));
					let bindings = match entry.get("bindings") {
						Some(Value::Object(fields)) => fields
							.iter()
							.map(|(key, value)| {
								format!(
									"${key}={}",
									value
										.as_str()
										.map_or_else(|| value.to_string(), str::to_owned)
								)
							})
							.collect::<Vec<_>>()
							.join(", "),
						Some(Value::String(text)) => text.clone(),
						_ => String::new(),
					};
					serde_json::json!({
						"path": entry.get("path").cloned().unwrap_or_else(|| serde_json::json!("")),
						"line": line,
						"column": entry.get("column").cloned().unwrap_or_else(|| serde_json::json!(1)),
						"end_line": entry.get("end_line").cloned().unwrap_or(line),
						"end_column": entry.get("end_column").cloned().unwrap_or_else(|| serde_json::json!(1)),
						"text": entry.get("text").cloned().unwrap_or_else(|| serde_json::json!("")),
						"bindings": bindings
					})
				})
				.collect::<Vec<_>>();
			let total = value
				.get("match_count")
				.or_else(|| value.get("total"))
				.cloned()
				.unwrap_or_else(|| serde_json::json!(matches.len()));
			serde_json::json!({
				"matches": matches,
				"advisories": [],
				"total": total,
				"next_skip": null,
				"files_searched": value.get("files_searched").cloned().unwrap_or_else(|| serde_json::json!(0))
			})
		},
		"todo" => {
			let phases = value
				.get("phases")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(|phase| {
					let tasks = phase
						.get("tasks")
						.or_else(|| phase.get("items"))
						.and_then(Value::as_array)
						.into_iter()
						.flatten()
						.map(|task| serde_json::json!({
							"content": task.get("content").or_else(|| task.get("text")).cloned().unwrap_or_else(|| serde_json::json!("")),
							"status": task.get("status").cloned().unwrap_or_else(|| serde_json::json!("pending")),
							"blocker": task.get("blocker").cloned()
						}))
						.collect::<Vec<_>>();
					serde_json::json!({
						"name": phase.get("name").or_else(|| phase.get("phase")).cloned().unwrap_or_else(|| serde_json::json!("")),
						"tasks": tasks
					})
				})
				.collect::<Vec<_>>();
			serde_json::json!({
				"op": args.get("op").cloned().unwrap_or_else(|| serde_json::json!("view")),
				"phases": phases,
				"completed_tasks": value.get("completed_tasks").cloned().unwrap_or_else(|| serde_json::json!([]))
			})
		},
		"browser" => serde_json::json!({
			"action": value.get("action").or_else(|| args.get("action")).cloned().unwrap_or_else(|| serde_json::json!("run")),
			"name": value.get("name").or_else(|| args.get("name")).cloned().unwrap_or_else(|| serde_json::json!("main")),
			"url": value.get("url").cloned(),
			"title": value.get("title").cloned(),
			"display": value.get("display").cloned().unwrap_or_else(|| serde_json::json!([])),
			"result": value.get("result").cloned(),
			"artifacts": value.get("artifacts").cloned().unwrap_or_else(|| serde_json::json!([])),
			"browser": value.get("browser").cloned()
		}),
		"computer" => serde_json::json!({
			"action": value.get("action").or_else(|| args.get("action")).cloned().unwrap_or_else(|| serde_json::json!("run")),
			"code": value.get("code").or_else(|| args.get("code")).cloned(),
			"results": value.get("results").cloned().unwrap_or_else(|| serde_json::json!([])),
			"artifacts": value.get("artifacts").cloned().unwrap_or_else(|| serde_json::json!([])),
			"capabilities": value.get("capabilities").cloned()
		}),
		"task" => {
			let children = value
				.get("children")
				.or_else(|| value.get("results"))
				.and_then(serde_json::Value::as_array)
				.into_iter()
				.flatten()
				.map(|child| {
					let cost_nano_usd = child
						.get("cost")
						.and_then(Value::as_f64)
						.map_or(0, |cost| (cost * 1_000_000_000.0).round() as u64);
					serde_json::json!({
						"id": child.get("id").or_else(|| child.get("job")).cloned().unwrap_or_else(|| serde_json::json!("agent")),
						"agent": child.get("agent").cloned().unwrap_or_else(|| serde_json::json!("task")),
						"text": child.get("text").or_else(|| child.get("output")).cloned().unwrap_or_else(|| serde_json::json!("")),
						"description": child.get("description").cloned(),
						"assignment": child.get("assignment").cloned(),
						"stats": {
							"requests": child.get("requests").cloned().unwrap_or_else(|| serde_json::json!(0)),
							"context_tokens": child.get("context_tokens").cloned().unwrap_or_else(|| serde_json::json!(0)),
							"context_window": child.get("context_window").cloned().unwrap_or_else(|| serde_json::json!(0)),
							"cost_nano_usd": cost_nano_usd,
							"duration_ms": child.get("wall_ms").cloned().unwrap_or_else(|| serde_json::json!(0))
						},
						"session_path": child.get("session_path").cloned().unwrap_or_else(|| serde_json::json!("")),
						"tokens_in": child.get("tokens_in").or_else(|| child.get("context_tokens")).cloned().unwrap_or_else(|| serde_json::json!(0)),
						"tokens_out": child.get("tokens_out").cloned().unwrap_or_else(|| serde_json::json!(0)),
						"output": null,
						"workspace": null,
						"error": child.get("error").cloned(),
					})
				})
				.collect::<Vec<_>>();
			serde_json::json!({
				"children": children,
				"duration_ms": value.get("total_duration_ms").cloned().unwrap_or_else(|| serde_json::json!(0))
			})
		},
		"recall" => {
			let items = value
				.get("items")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.map(|item| {
					serde_json::json!({
						"memory": {
							"id": item.get("id").cloned().unwrap_or_else(|| serde_json::json!("memory")),
							"bank": item.get("bank").cloned().unwrap_or_else(|| serde_json::json!("global")),
							"tier": "working",
							"content": item.get("content").cloned().unwrap_or_else(|| serde_json::json!("")),
							"source": null,
							"session_id": "gallery",
							"timestamp": "2026-01-01T00:00:00Z",
							"importance": 0.5,
							"veracity": "observed",
							"memory_type": "fact",
							"metadata": {
								"context": item.get("context").cloned().unwrap_or(serde_json::Value::Null)
							},
							"superseded_by": null
						},
						"score": item.get("score").cloned().unwrap_or_else(|| serde_json::json!(0.0)),
						"voice_scores": {"vector":0.0,"graph":0.0,"episodic":0.0,"working":0.0},
						"broadened": false
					})
				})
				.collect::<Vec<_>>();
			serde_json::json!({
				"query": value.get("query").cloned().unwrap_or_else(|| serde_json::json!("")),
				"items": items
			})
		},
		"write" => {
			let path = args
				.get("path")
				.and_then(serde_json::Value::as_str)
				.unwrap_or_default();
			let content = args
				.get("content")
				.and_then(serde_json::Value::as_str)
				.unwrap_or_default();
			serde_json::json!({
				"resolved_path": path,
				"display_path": path,
				"canonical_recovery": null,
				"byte_len": content.len(),
				"reported_len": content.encode_utf16().count(),
				"disposition": value.get("disposition").cloned().unwrap_or_else(|| serde_json::json!("created")),
				"stripped_wrapper": false,
				"made_executable": false,
				"snapshot_tag": null,
				"operation": { "kind": "plain" },
			})
		},
		_ => value,
	};
	Ok((payload, Vec::new()))
}

/// Produces the exact typed fault the live tool journals from a readable
/// fixture fault.
fn fixture_fault(tool: &str, args: &str, value: serde_json::Value) -> serde_json::Value {
	let args: serde_json::Value = serde_json::from_str(args).unwrap_or(serde_json::Value::Null);
	match tool {
		// `{"kind":"command_failed","payload":{"transcript":…,"status":…}}`:
		// a non-zero exit is `Fault::CommandFailed` carrying the complete
		// transcript and status, never a bare message.
		"bash" if value.get("kind").and_then(Value::as_str) == Some("command_failed") => {
			let payload = shell_payload(&args, value.get("payload").unwrap_or(&Value::Null));
			serde_json::to_value(shell::Fault::CommandFailed { payload: Box::new(payload) })
				.expect("shell fault serializes")
		},
		"web_search" => {
			let message = value
				.get("message")
				.or_else(|| value.get("error"))
				.and_then(Value::as_str)
				.or_else(|| value.as_str())
				.unwrap_or("search failed");
			serde_json::json!({
				"kind": "search",
				"provider": value.get("provider").cloned(),
				"code": "gallery",
				"message": message
			})
		},
		_ => value,
	}
}

/// Model-facing parts are persisted beside the outcome exactly as production
/// dispatch does. Cards must ignore this bounded projection and decode the
/// typed outcome; wrapper tools explicitly unwrap their projection contract.
fn projected_parts(tool: &str, value: &serde_json::Value) -> Result<Vec<Part>, serde_json::Error> {
	let text = match tool {
		// `Response::text` for a settled call, `Fault::message` for a fault.
		"hub" => value
			.get("text")
			.or_else(|| value.get("message"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned(),
		"bash" => serde_json::from_value::<shell::Payload>(value.clone())
			.ok()
			.or_else(|| {
				serde_json::from_value::<shell::Fault>(value.clone())
					.ok()
					.and_then(|fault| match fault {
						shell::Fault::CommandFailed { payload } => Some(*payload),
						_ => None,
					})
			})
			.map(|payload| {
				payload
					.transcript
					.iter()
					.map(|frame| String::from_utf8_lossy(frame.data.as_ref()).into_owned())
					.collect::<String>()
			})
			.unwrap_or_default(),
		"eval" => value
			.pointer("/status/exception/traceback")
			.and_then(Value::as_array)
			.map(|lines| {
				lines
					.iter()
					.filter_map(Value::as_str)
					.collect::<Vec<_>>()
					.join("\n")
			})
			.unwrap_or_default(),
		"web_search" => web_projection(value.pointer("/response").unwrap_or(&Value::Null)),
		"task" => value
			.get("children")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter_map(|child| child.get("text").and_then(Value::as_str))
			.collect::<Vec<_>>()
			.join("\n"),
		"read" => value
			.get("parts")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter_map(|part| part.get("text").and_then(Value::as_str))
			.collect::<Vec<_>>()
			.join("\n"),
		_ => value
			.as_str()
			.or_else(|| {
				value
					.get("output")
					.or_else(|| value.get("message"))
					.and_then(Value::as_str)
			})
			.map(str::to_owned)
			.unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default()),
	};
	Ok(vec![Part::Text { text: Str::new(text) }])
}

fn web_projection(response: &Value) -> String {
	use std::fmt::Write as _;
	let mut text = response
		.get("answer")
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned();
	let sources = response
		.get("sources")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	if !sources.is_empty() {
		if !text.is_empty() {
			text.push_str("\n\n");
		}
		text.push_str("## Sources\n\n");
		for (index, source) in sources.iter().enumerate() {
			let _ = write!(
				text,
				"{}. [{}]({})",
				index + 1,
				source
					.get("title")
					.and_then(Value::as_str)
					.unwrap_or_default(),
				source
					.get("url")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			);
			if let Some(snippet) = source.get("snippet").and_then(Value::as_str)
				&& !snippet.is_empty()
			{
				let _ = write!(text, " — {snippet}");
			}
			text.push('\n');
		}
	}
	text
}

fn find_snapshot_call(snapshot: &Snapshot, call_id: &str) -> Option<Handle> {
	snapshot.handles().find(|handle| {
		snapshot.get(*handle).is_some_and(|node| {
			matches!(&node.tag, Tag::Custom(_))
				&& node
					.prop(&PropId::Id.into())
					.and_then(DomValue::as_str)
					.is_some_and(|id| id == call_id)
		})
	})
}

fn child(snapshot: &Snapshot, parent: Handle, tag: KnownTag) -> Option<&Node> {
	snapshot
		.children(parent)
		.iter()
		.filter_map(|handle| snapshot.get(*handle))
		.find(|node| node.tag == Tag::Known(tag))
}

fn node_text(node: &Node) -> Option<&str> {
	node
		.prop(&PropId::Text.into())
		.and_then(DomValue::as_str)
		.filter(|text| !text.is_empty())
		.or(node.content.as_deref())
}

fn card_tool(tool: &str) -> &str {
	match tool {
		"read_group" => "read",
		"edit_delete" | "edit_move" => "edit",
		"report_tool_issue" => "report_issue",
		"eval_workpool" => "eval",
		"hub_inbox" | "hub_jobs" | "hub_list" | "hub_logs" | "hub_send" | "hub_start"
		| "hub_wait" => "hub",
		"custom" => "Custom Tool",
		other => other,
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::frame_text;

	use super::{GalleryState, fixture_names, render_sections};

	#[test]
	fn gallery_fixture_inventory_is_complete() {
		assert_eq!(fixture_names(), [
			"apply_patch",
			"ask",
			"ast_edit",
			"ast_grep",
			"bash",
			"browser",
			"checkpoint",
			"computer",
			"context_gauge",
			"custom",
			"debug",
			"edit",
			"edit_delete",
			"edit_move",
			"eval",
			"eval_workpool",
			"github",
			"glob",
			"goal",
			"grep",
			"hub",
			"hub_inbox",
			"hub_jobs",
			"hub_list",
			"hub_logs",
			"hub_send",
			"hub_start",
			"hub_wait",
			"image_gen",
			"learn",
			"lsp",
			"manage_skill",
			"memory_edit",
			"read",
			"read_group",
			"recall",
			"reflect",
			"reject",
			"report_issue",
			"report_tool_issue",
			"resolve",
			"retain",
			"rewind",
			"security_scan",
			"task",
			"think",
			"todo",
			"tts",
			"web_search",
			"write",
			"yield",
		]);
	}

	#[test]
	fn gallery_materializes_every_read_lifecycle_through_session() {
		let sections = render_sections(Some("read"), &GalleryState::ALL, 100, false)
			.expect("read fixtures should fold and render");
		assert_eq!(sections.len(), GalleryState::ALL.len());
		for (section, state) in sections.iter().zip(GalleryState::ALL) {
			assert_eq!(section.state, state);
			assert_eq!(section.frame.size().width, 100);
			assert!(!frame_text(&section.frame).trim().is_empty());
		}
	}

	#[test]
	fn all_51_fixtures_use_projected_production_settlement() {
		let sections = render_sections(None, &GalleryState::ALL, 100, false)
			.expect("every fixture should fold through settle_projected/fail_projected");
		assert_eq!(fixture_names().len(), 51);
		assert_eq!(sections.len(), 51 * GalleryState::ALL.len());
		assert!(
			sections
				.iter()
				.all(|section| !frame_text(&section.frame).trim().is_empty()),
			"every lifecycle frame must carry meaningful presentation"
		);
	}
}
