//! Production [`UiControlOwner`] for the interactive chat: extension
//! `omp.ui.*` CONTROL requests become host dialogs and presentation facts.
//!
//! Dialogs ride the `ask` path end to end: the owner registers the request
//! id with the environment's [`AskRoute`], opens an [`AskDialog`] /
//! [`InputDialog`] through the actor's console mailbox, and the host's
//! `HostCommand::AskAnswer` for that id settles the extension's request
//! exactly like a tool's `ask` (ADR 0005: the actor answers ids, it never
//! owns the request). Facts that only the actor knows (viewport, charset,
//! appearance) are read through a `PanelCall` round-trip.

use std::{future::Future, pin::Pin, sync::Arc, task::Poll};

use async_trait::async_trait;
use omp_chat::{
	ExtensionStatus, HostAction, HostMailbox,
	overlays::{
		CancelledPanel, PanelCall, PanelEvent, PanelOpener,
		ask::AskDialog,
		ext_input::{FIELD, InputDialog, InputSpec},
	},
};
use omp_con::{Ctx, RegItem};
use omp_core::{Str, Ulid};
use omp_driver::{
	collab::session::{CollabCommandHandle, HostUiRequestError},
	headless::AskRoute,
};
use omp_envd::exthost::{
	ControlAuthority, ControlAuthorityFactory, ControlCompositionError, UiControlAuthority,
	UiControlOwner, UiControlRequest, UiControlResult,
	control::{ControlConnectionIdentity, ControlProtocolError, ControlRequestContext},
};
use omp_proto::collab::v1::{
	EditorSpec, SelectOption, SelectSpec, UiRequest, select_spec, ui_request,
};
use omp_tools::ask::{
	AskPresenter, Fault as AskFault, OptionItem, Presentation, Question, Selection,
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

const YES: &str = "Yes";
const NO: &str = "No";
/// Extension dialog request ids never collide with tool call ids.
const REQUEST_PREFIX: &str = "ext-ui:";

fn remote_select(questions: &[Question]) -> Option<UiRequest> {
	let question = questions.first()?;
	if questions.len() != 1 || question.options.is_empty() || question.multi {
		return None;
	}
	Some(UiRequest {
		title: question.question.to_string(),
		spec: Some(ui_request::Spec::Select(SelectSpec {
			options:         question
				.options
				.iter()
				.map(|option| SelectOption {
					label:       option.label.to_string(),
					description: option.description.as_ref().map(ToString::to_string),
				})
				.collect(),
			initial_index:   u32::try_from(question.recommended.unwrap_or_default())
				.unwrap_or(u32::MAX),
			marker:          if question.multi {
				select_spec::Marker::Checkbox
			} else {
				select_spec::Marker::Radio
			} as i32,
			checked_indices: Vec::new(),
			markable_count:  u32::try_from(question.options.len()).unwrap_or(u32::MAX),
			help_text:       None,
		})),
		..UiRequest::default()
	})
}

fn remote_selection(question: &Question, value: String) -> Selection {
	let value = Str::new(value);
	let known = question.options.iter().any(|option| option.label == value);
	Selection {
		id:           question.id.clone(),
		selected:     if known {
			vec![value.clone()]
		} else {
			Vec::new()
		},
		custom_input: (!known).then_some(value),
		note:         None,
		timed_out:    false,
	}
}

/// Chat-owned UI authority handed to the Environment for the chat's
/// lifetime.
pub struct ChatUiOwner {
	con:         Arc<Ctx>,
	ask:         AskRoute,
	collab:      Option<CollabCommandHandle>,
	dialog_gate: tokio::sync::Mutex<()>,
}

impl ChatUiOwner {
	/// Wraps the actor's console (its mailbox carries host actions) and the
	/// environment's `ask` route.
	#[must_use]
	pub fn new(con: Arc<Ctx>, ask: AskRoute, collab: Option<CollabCommandHandle>) -> Self {
		Self { con, ask, collab, dialog_gate: tokio::sync::Mutex::new(()) }
	}

	/// Factory the Environment binds per authenticated extension connection.
	#[must_use]
	pub fn factory(self: Arc<Self>) -> Arc<dyn ControlAuthorityFactory> {
		Arc::new(move |identity: Arc<ControlConnectionIdentity>| {
			let owner: Arc<dyn UiControlOwner> = Arc::<Self>::clone(&self);
			Ok::<Arc<dyn ControlAuthority>, ControlCompositionError>(Arc::new(
				UiControlAuthority::new(identity, owner),
			))
		})
	}

	fn mailbox(&self) -> Result<Arc<HostMailbox>, ControlProtocolError> {
		self
			.con
			.user::<HostMailbox>()
			.ok_or_else(|| protocol("no_ui", "no interactive host is attached to this session"))
	}

	/// Reads actor-owned facts through one `PanelCall` round-trip.
	async fn with_actor<T: Send + 'static>(
		&self,
		read: impl Fn(&omp_chat::overlays::PanelCx<'_>) -> T + Send + Sync + 'static,
	) -> Result<T, ControlProtocolError> {
		let (tx, rx) = flume::bounded::<T>(1);
		self
			.mailbox()?
			.post(HostAction::Call(PanelCall::new(move |cx| {
				let _ = tx.try_send(read(cx));
				PanelEvent::Consumed
			})));
		rx.recv_async()
			.await
			.map_err(|_| protocol("no_ui", "the interactive host went away before answering"))
	}

	/// Opens a dialog for `questions` and waits for the host's answers;
	/// `None` when the user dismissed it.
	async fn dialog(
		&self,
		id: Str,
		questions: Vec<Question>,
		remote: Option<UiRequest>,
		open: impl Fn(
			Str,
			Vec<Question>,
			&omp_chat::overlays::PanelCx<'_>,
		) -> Box<dyn omp_chat::overlays::Panel>
		+ Send
		+ Sync
		+ 'static,
	) -> Result<Option<Vec<Selection>>, ControlProtocolError> {
		let _gate = self.dialog_gate.lock().await;
		let mailbox = self.mailbox()?;
		let mut present = self.ask.present(&questions, Some(id.as_str()));
		// The route registers the id on first poll; the dialog must not be
		// able to answer before that.
		if let Poll::Ready(settled) = futures::poll!(present.as_mut()) {
			return finish(settled);
		}
		let local_cancel = CancellationToken::new();
		let panel_cancel = local_cancel.clone();
		let dialog_id = id.clone();
		let dialog_questions = questions.clone();
		mailbox.post(HostAction::Open(PanelOpener::new(move |cx| {
			Ok(Box::new(CancelledPanel::new(
				open(dialog_id.clone(), dialog_questions.clone(), cx),
				panel_cancel.clone(),
			)) as Box<dyn omp_chat::overlays::Panel>)
		})));
		let Some((collab, request)) = self.collab.as_ref().zip(remote) else {
			return finish(present.await);
		};
		let remote_cancel = CancellationToken::new();
		let remote_answer = collab.request_guest_ui(request, remote_cancel.clone());
		tokio::pin!(remote_answer);
		tokio::select! {
			local = present.as_mut() => {
				remote_cancel.cancel();
				finish(local)
			},
			remote = &mut remote_answer => match remote {
				Ok(answer) => {
					local_cancel.cancel();
					let _ = self.ask.answer(
						id.as_str(),
						omp_driver::headless::AskReply::Cancelled,
					);
					Ok(answer.value.map(|value| vec![remote_selection(&questions[0], value)]))
				},
				Err(
					HostUiRequestError::NotHost
					| HostUiRequestError::Unavailable
					| HostUiRequestError::Capacity
					| HostUiRequestError::TooLarge
					| HostUiRequestError::OwnerStopped
				) => finish(present.await),
				Err(HostUiRequestError::Cancelled) => {
					local_cancel.cancel();
					let _ = self.ask.answer(
						id.as_str(),
						omp_driver::headless::AskReply::Cancelled,
					);
					Ok(None)
				},
			},
		}
	}

	async fn ask_dialog(
		&self,
		questions: Vec<Question>,
	) -> Result<Option<Vec<Selection>>, ControlProtocolError> {
		self
			.dialog(
				Str::new(format!("{REQUEST_PREFIX}{}", Ulid::generate())),
				questions.clone(),
				remote_select(&questions),
				|id, questions, cx| {
					Box::new(AskDialog::open(id, questions, None, cx.ui.now, cx.viewport, cx.ui))
				},
			)
			.await
	}

	async fn input_dialog(&self, spec: InputSpec) -> Result<Option<Str>, ControlProtocolError> {
		let question = Question {
			id:          Str::new_static(FIELD),
			question:    spec.title.clone(),
			header:      None,
			options:     Vec::new(),
			multi:       false,
			recommended: None,
		};
		let remote = UiRequest {
			title: spec.title.to_string(),
			spec: Some(ui_request::Spec::Editor(EditorSpec {
				prefill: Some(spec.prefill.to_string()),
			})),
			..UiRequest::default()
		};
		let answers = self
			.dialog(
				Str::new(format!("{REQUEST_PREFIX}{}", Ulid::generate())),
				vec![question],
				Some(remote),
				move |id, _, cx| Box::new(InputDialog::open(id, spec.clone(), cx.viewport, cx.ui)),
			)
			.await?;
		Ok(answers.map(|answers| {
			answers
				.into_iter()
				.find(|answer| answer.id.as_str() == FIELD)
				.and_then(|answer| answer.custom_input)
				.unwrap_or_default()
		}))
	}

	async fn run_dialog(
		&self,
		kind: &str,
		mut fields: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		match kind {
			"confirm" => {
				let title = string(&mut fields, "title")?;
				let message = text_field(&mut fields, "message");
				let question = if message.is_empty() {
					title
				} else {
					Str::new(format!("{title}\n{message}"))
				};
				let answers = self
					.ask_dialog(vec![Question {
						id: Str::new_static("confirm"),
						question,
						header: None,
						options: vec![option(YES, None), option(NO, None)],
						multi: false,
						recommended: Some(0),
					}])
					.await?;
				Ok(match answers {
					Some(answers) => {
						let accepted = answers
							.first()
							.is_some_and(|answer| answer.selected.iter().any(|label| label == YES));
						outcome(accepted, Value::Null, Value::Null, Value::Null, None)
					},
					None => dismissed(),
				})
			},
			"select" | "multi_select" => {
				let title = string(&mut fields, "title")?;
				let items = select_items(fields.remove("items"))?;
				let multi = kind == "multi_select";
				let answers = self
					.ask_dialog(vec![Question {
						id: Str::new_static("select"),
						question: title,
						header: None,
						options: items.iter().map(SelectItem::option).collect(),
						multi,
						recommended: items.iter().position(|item| item.recommended),
					}])
					.await?;
				let Some(answers) = answers else {
					return Ok(dismissed());
				};
				let values = answers
					.first()
					.map(|answer| selected_values(answer, &items))
					.unwrap_or_default();
				Ok(if multi {
					outcome(true, Value::Null, json!(values), Value::Null, None)
				} else {
					outcome(true, json!(values.first()), Value::Null, Value::Null, None)
				})
			},
			"input" | "editor" => {
				let spec = InputSpec {
					title:       string(&mut fields, "title")?,
					placeholder: text_field(&mut fields, "placeholder"),
					prefill:     text_field(&mut fields, "prefill"),
					mask:        fields.get("mask").and_then(Value::as_bool).unwrap_or(false),
					multiline:   kind == "editor",
				};
				Ok(match self.input_dialog(spec).await? {
					Some(text) => outcome(true, json!(text), Value::Null, Value::Null, None),
					None => dismissed(),
				})
			},
			"form" => {
				let title = string(&mut fields, "title")?;
				let form = form_fields(fields.remove("fields"))?;
				let questions = form
					.iter()
					.enumerate()
					.map(|(index, field)| field.question(index == 0, &title))
					.collect();
				let Some(answers) = self.ask_dialog(questions).await? else {
					return Ok(dismissed());
				};
				let mut values = Map::new();
				for field in &form {
					let answer = answers.iter().find(|answer| answer.id == field.id);
					values.insert(field.id.to_string(), field.value(answer));
				}
				Ok(outcome(true, Value::Null, Value::Null, Value::Object(values), None))
			},
			"ask_user" => {
				let asked = ask_questions(fields.remove("questions"))?;
				let questions = asked.iter().map(AskUserQuestion::question).collect();
				let Some(answers) = self.ask_dialog(questions).await? else {
					return Ok(dismissed());
				};
				let mut values = Map::new();
				for question in &asked {
					let answer = answers.iter().find(|answer| answer.id == question.id);
					values.insert(question.id.to_string(), question.answer(answer));
				}
				Ok(outcome(true, Value::Null, Value::Null, Value::Object(values), None))
			},
			other => Err(protocol("unknown_operation", format!("unknown dialog kind `{other}`"))),
		}
	}
}

impl AskPresenter for ChatUiOwner {
	fn present<'p>(
		&'p self,
		questions: &'p [Question],
		invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, AskFault>> + Send + 'p>> {
		let Some(invocation) = invocation.filter(|id| id.starts_with("dyn-")) else {
			return self.ask.present(questions, invocation);
		};
		let id = Str::new(invocation);
		let questions = questions.to_vec();
		Box::pin(async move {
			let remote = remote_select(&questions);
			let selections = self
				.dialog(id, questions, remote, |id, questions, cx| {
					Box::new(AskDialog::open(
						id,
						questions,
						omp_chat::overlays::ask::timeout(cx),
						cx.ui.now,
						cx.viewport,
						cx.ui,
					))
				})
				.await
				.map_err(|error| AskFault::Presenter { message: Str::new(error.to_string()) })?
				.ok_or_else(AskFault::cancelled)?;
			Ok(Presentation { selections })
		})
	}
}

#[async_trait]
impl UiControlOwner for ChatUiOwner {
	async fn request(
		&self,
		_context: ControlRequestContext,
		request: UiControlRequest,
	) -> Result<UiControlResult, ControlProtocolError> {
		match request {
			UiControlRequest::Presentation => {
				let facts = self
					.with_actor(|cx| {
						let charset = match cx.ui.charset {
							omp_tui::Charset::Unicode => "unicode",
							omp_tui::Charset::NerdFont => "nerd",
							omp_tui::Charset::Ascii => "ascii",
						};
						let appearance = match cx.ui.appearance {
							omp_tui::Appearance::Dark => "dark",
							omp_tui::Appearance::Light => "light",
						};
						let graphics = match cx.ui.graphics {
							omp_tui::Graphics::Cells => "cells",
							omp_tui::Graphics::Sixel => "sixel",
							omp_tui::Graphics::KittyDirect => "kitty_direct",
							omp_tui::Graphics::KittyPlaceholders => "kitty_placeholders",
							omp_tui::Graphics::Iterm2 => "iterm2",
						};
						json!({
							"charset": charset,
							"appearance": appearance,
							"width": cx.viewport.width,
							"height": cx.viewport.height,
							"graphics": graphics,
							"hyperlinks": true,
							"has_ui": true,
						})
					})
					.await?;
				Ok(UiControlResult::Value(facts))
			},
			UiControlRequest::Commands => {
				let commands = self
					.con
					.items()
					.filter_map(|item| match item {
						RegItem::Cmd(spec) => Some(json!({
							"name": spec.name,
							"aliases": [],
							"description": spec.desc.lines().next().unwrap_or_default(),
							"source": "builtin",
						})),
						RegItem::Var(_) | RegItem::Action(_) => None,
					})
					.collect::<Vec<_>>();
				Ok(UiControlResult::Value(json!({ "commands": commands })))
			},
			UiControlRequest::Icons { prefix } => {
				let names = omp_tui::Icon::ALL
					.iter()
					.map(|icon| icon.name())
					.filter(|name| name.starts_with(prefix.as_str()))
					.collect::<Vec<_>>();
				Ok(UiControlResult::Value(json!(names)))
			},
			UiControlRequest::ToolsExpanded => Ok(UiControlResult::Value(Value::Bool(
				omp_chat::actions::CL_TOOLS_EXPANDED.get(&self.con),
			))),
			UiControlRequest::SetToolsExpanded { expanded } => {
				omp_chat::actions::CL_TOOLS_EXPANDED
					.set(&self.con, expanded)
					.map_err(|error| protocol("convar", error.to_string()))?;
				Ok(UiControlResult::Ack)
			},
			UiControlRequest::Dialog { kind, fields } => self
				.run_dialog(kind.as_str(), fields)
				.await
				.map(UiControlResult::Value),
			UiControlRequest::EditorText => Err(protocol(
				"unsupported_operation",
				"the chat host does not expose composer text to extensions",
			)),
			UiControlRequest::Themes | UiControlRequest::SetAppearance { .. } => Err(protocol(
				"unsupported_operation",
				"the chat host has no named theme catalog; themes are Environment-fed",
			)),
			UiControlRequest::SetHiddenThinkingLabel { .. } => {
				Err(protocol("unsupported_operation", "the chat host has no hidden-thinking label"))
			},
			UiControlRequest::Overlay { .. }
			| UiControlRequest::OverlayValues { .. }
			| UiControlRequest::OverlayWait { .. }
			| UiControlRequest::OverlayEvents { .. }
			| UiControlRequest::OverlayClose { .. } => Err(protocol(
				"unsupported_operation",
				"retained extension overlays are not implemented by the chat host",
			)),
			UiControlRequest::DynamicMount { .. } => Err(protocol(
				"unsupported_operation",
				"dynamic command mounts are not implemented by the chat host",
			)),
		}
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		effect: Value,
	) -> Result<(), ControlProtocolError> {
		let kind = effect
			.get("kind")
			.and_then(Value::as_str)
			.unwrap_or_default();
		match kind {
			"notify" => {
				let body = effect.get("body").cloned().unwrap_or(Value::Null);
				let text = body
					.get("text")
					.or_else(|| body.get("message"))
					.and_then(Value::as_str)
					.unwrap_or_default();
				let severity = match body.get("level").and_then(Value::as_str) {
					Some("warn" | "warning") => omp_con::Severity::Warn,
					Some("error") => omp_con::Severity::Error,
					_ => omp_con::Severity::Info,
				};
				self
					.mailbox()?
					.post(HostAction::Reply { severity, text: Str::new(text) });
				Ok(())
			},
			"set_title" => {
				let title = effect
					.get("body")
					.and_then(|body| body.get("title"))
					.and_then(Value::as_str)
					.ok_or_else(|| {
						protocol("invalid_effect", "set_title requires a string body.title")
					})?;
				self
					.mailbox()?
					.post(HostAction::ExtensionTitle(Str::new(title)));
				Ok(())
			},
			"set_status" => {
				let body = effect
					.get("body")
					.and_then(Value::as_object)
					.ok_or_else(|| protocol("invalid_effect", "set_status requires an object body"))?;
				let key = body
					.get("key")
					.and_then(Value::as_str)
					.filter(|key| !key.is_empty())
					.ok_or_else(|| {
						protocol("invalid_effect", "set_status requires a non-empty body.key")
					})?;
				let event = match body.get("content") {
					Some(Value::Null) => ExtensionStatus::clear(key),
					Some(Value::Object(content)) => {
						let source = content
							.get("source")
							.and_then(Value::as_str)
							.ok_or_else(|| {
								protocol(
									"invalid_effect",
									"set_status body.content requires a string source",
								)
							})?;
						ExtensionStatus::from_tml(key, source).map_err(|_| {
							protocol("invalid_effect", "set_status body.content.source is invalid TML")
						})?
					},
					_ => {
						return Err(protocol(
							"invalid_effect",
							"set_status body.content must be an object or null",
						));
					},
				};
				self.mailbox()?.post(HostAction::ExtensionStatus(event));
				Ok(())
			},
			other => Err(protocol(
				"unsupported_operation",
				format!("UI effect `{other}` is not implemented by the chat host"),
			)),
		}
	}
}

/// One decoded `SelectItem`.
struct SelectItem {
	value:       Str,
	label:       Str,
	description: Option<Str>,
	recommended: bool,
}

impl SelectItem {
	fn option(&self) -> OptionItem {
		option(self.label.as_str(), self.description.clone())
	}
}

/// One decoded form `Field`.
struct FormField {
	id:      Str,
	kind:    Str,
	label:   Str,
	desc:    Option<Str>,
	value:   Value,
	options: Vec<SelectItem>,
}

impl FormField {
	fn multi(&self) -> bool {
		matches!(self.kind.as_str(), "multi_select" | "multi-select" | "multiselect")
	}

	fn boolean(&self) -> bool {
		matches!(self.kind.as_str(), "bool" | "boolean" | "checkbox" | "toggle")
	}

	fn choice(&self) -> bool {
		self.multi() || matches!(self.kind.as_str(), "select" | "choice" | "radio")
	}

	fn question(&self, first: bool, title: &str) -> Question {
		let mut question = self.label.clone();
		if let Some(desc) = &self.desc {
			question = Str::new(format!("{question}\n{desc}"));
		}
		let options = if self.boolean() {
			vec![option(YES, None), option(NO, None)]
		} else if self.choice() {
			self.options.iter().map(SelectItem::option).collect()
		} else {
			Vec::new()
		};
		let recommended = if self.boolean() {
			Some(usize::from(self.value.as_bool() != Some(true)))
		} else if self.choice() {
			self
				.options
				.iter()
				.position(|item| item.recommended || self.value.as_str() == Some(item.value.as_str()))
		} else {
			None
		};
		Question {
			id: self.id.clone(),
			question,
			header: first.then(|| Str::new(title)),
			options,
			multi: self.multi(),
			recommended,
		}
	}

	fn value(&self, answer: Option<&Selection>) -> Value {
		let Some(answer) = answer else {
			return self.value.clone();
		};
		if self.boolean() {
			return Value::Bool(answer.selected.iter().any(|label| label == YES));
		}
		if self.choice() {
			let values = selected_values(answer, &self.options);
			return if self.multi() {
				json!(values)
			} else {
				json!(values.first())
			};
		}
		let text = answer.custom_input.clone().unwrap_or_default();
		if matches!(self.kind.as_str(), "number" | "int" | "integer" | "float") {
			if let Ok(number) = text.as_str().parse::<i64>() {
				return json!(number);
			}
			if let Ok(number) = text.as_str().parse::<f64>() {
				return json!(number);
			}
		}
		json!(text)
	}
}

/// One decoded `AskQuestion`.
struct AskUserQuestion {
	id:          Str,
	question:    Str,
	header:      Option<Str>,
	options:     Vec<SelectItem>,
	multi:       bool,
	recommended: Option<Str>,
}

impl AskUserQuestion {
	fn question(&self) -> Question {
		Question {
			id:          self.id.clone(),
			question:    self.question.clone(),
			header:      self.header.clone(),
			options:     self.options.iter().map(SelectItem::option).collect(),
			multi:       self.multi,
			recommended: self
				.recommended
				.as_ref()
				.and_then(|wanted| self.options.iter().position(|item| &item.value == wanted)),
		}
	}

	fn answer(&self, answer: Option<&Selection>) -> Value {
		let Some(answer) = answer else {
			return json!({ "selected": [], "freeform": null, "note": null, "timed_out": false });
		};
		json!({
			"selected": selected_values(answer, &self.options),
			"freeform": answer.custom_input,
			"note": answer.note,
			"timed_out": answer.timed_out,
		})
	}
}

fn finish(
	settled: Result<omp_tools::ask::Presentation, AskFault>,
) -> Result<Option<Vec<Selection>>, ControlProtocolError> {
	match settled {
		Ok(presentation) => Ok(Some(presentation.selections)),
		Err(AskFault::Cancelled { .. }) => Ok(None),
		Err(error) => Err(protocol("dialog_failed", error.to_string())),
	}
}

fn option(label: &str, description: Option<Str>) -> OptionItem {
	OptionItem { label: Str::new(label), description, preview: None }
}

/// Selected labels mapped back to item values; a free-text `Other` reply
/// stands in as the value when nothing was picked.
fn selected_values(answer: &Selection, items: &[SelectItem]) -> Vec<Str> {
	let mut values = answer
		.selected
		.iter()
		.map(|label| {
			items
				.iter()
				.find(|item| &item.label == label)
				.map_or_else(|| label.clone(), |item| item.value.clone())
		})
		.collect::<Vec<_>>();
	if values.is_empty()
		&& let Some(custom) = &answer.custom_input
	{
		values.push(custom.clone());
	}
	values
}

fn outcome(
	accepted: bool,
	value: Value,
	values: Value,
	answers: Value,
	reason: Option<&str>,
) -> Value {
	json!({
		"accepted": accepted,
		"value": value,
		"values": values,
		"answers": answers,
		"reason": reason,
	})
}

fn dismissed() -> Value {
	outcome(false, Value::Null, Value::Null, Value::Null, Some("dismissed"))
}

fn protocol(code: &'static str, message: impl Into<Str>) -> ControlProtocolError {
	ControlProtocolError::new(code, message)
}

fn string(
	fields: &mut Map<String, Value>,
	name: &'static str,
) -> Result<Str, ControlProtocolError> {
	match fields.remove(name) {
		Some(Value::String(value)) => Ok(Str::new(value)),
		_ => Err(protocol("invalid_ui_request", format!("dialog field `{name}` must be a string"))),
	}
}

/// A string or wire `Tml` (`{"source": …}`) field; empty when absent.
fn text_field(fields: &mut Map<String, Value>, name: &str) -> Str {
	match fields.remove(name) {
		Some(Value::String(value)) => Str::new(value),
		Some(Value::Object(object)) => object
			.get("source")
			.and_then(Value::as_str)
			.map_or_else(Str::default, Str::new),
		_ => Str::default(),
	}
}

fn opt_str(object: &Map<String, Value>, name: &str) -> Option<Str> {
	object.get(name).and_then(Value::as_str).map(Str::new)
}

fn select_item(value: &Value) -> Result<SelectItem, ControlProtocolError> {
	match value {
		Value::String(value) => Ok(SelectItem {
			value:       Str::new(value.as_str()),
			label:       Str::new(value.as_str()),
			description: None,
			recommended: false,
		}),
		Value::Object(object) => {
			let value = opt_str(object, "value")
				.ok_or_else(|| protocol("invalid_ui_request", "select item is missing `value`"))?;
			Ok(SelectItem {
				label: opt_str(object, "label").unwrap_or_else(|| value.clone()),
				description: opt_str(object, "desc"),
				recommended: object
					.get("recommended")
					.and_then(Value::as_bool)
					.unwrap_or(false),
				value,
			})
		},
		_ => Err(protocol("invalid_ui_request", "select items must be strings or objects")),
	}
}

fn select_items(value: Option<Value>) -> Result<Vec<SelectItem>, ControlProtocolError> {
	let Some(Value::Array(items)) = value else {
		return Err(protocol("invalid_ui_request", "dialog field `items` must be a list"));
	};
	items.iter().map(select_item).collect()
}

fn form_fields(value: Option<Value>) -> Result<Vec<FormField>, ControlProtocolError> {
	let Some(Value::Array(fields)) = value else {
		return Err(protocol("invalid_ui_request", "form `fields` must be a list"));
	};
	fields
		.iter()
		.map(|field| {
			let Value::Object(object) = field else {
				return Err(protocol("invalid_ui_request", "form fields must be objects"));
			};
			let id = opt_str(object, "id")
				.ok_or_else(|| protocol("invalid_ui_request", "form field is missing `id`"))?;
			let options = match object.get("options") {
				Some(Value::Array(items)) => items.iter().map(select_item).collect::<Result<_, _>>()?,
				_ => Vec::new(),
			};
			Ok(FormField {
				label: opt_str(object, "label").unwrap_or_else(|| id.clone()),
				kind: opt_str(object, "kind").unwrap_or_else(|| Str::new_static("text")),
				desc: opt_str(object, "desc"),
				value: object.get("value").cloned().unwrap_or(Value::Null),
				options,
				id,
			})
		})
		.collect()
}

fn ask_questions(value: Option<Value>) -> Result<Vec<AskUserQuestion>, ControlProtocolError> {
	let questions = match value {
		Some(Value::Array(questions)) => questions,
		Some(question @ Value::Object(_)) => vec![question],
		_ => return Err(protocol("invalid_ui_request", "`questions` must be a question or a list")),
	};
	questions
		.iter()
		.map(|question| {
			let Value::Object(object) = question else {
				return Err(protocol("invalid_ui_request", "ask questions must be objects"));
			};
			let id = opt_str(object, "id")
				.ok_or_else(|| protocol("invalid_ui_request", "ask question is missing `id`"))?;
			let text = opt_str(object, "question")
				.ok_or_else(|| protocol("invalid_ui_request", "ask question is missing `question`"))?;
			let options = match object.get("options") {
				Some(Value::Array(items)) => items.iter().map(select_item).collect::<Result<_, _>>()?,
				_ => Vec::new(),
			};
			Ok(AskUserQuestion {
				id,
				question: text,
				header: opt_str(object, "header"),
				options,
				multi: object
					.get("multi")
					.and_then(Value::as_bool)
					.unwrap_or(false),
				recommended: opt_str(object, "recommended"),
			})
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeSet, time::Duration};

	use omp_chat::overlays::Panel;
	use omp_driver::headless::AskReply;
	use omp_tui::{Key, Size, UiContext};

	use super::*;

	fn owner() -> (Arc<ChatUiOwner>, Arc<Ctx>, AskRoute) {
		let ctx = Arc::new(HostMailbox::new().attach(Ctx::builder()).build());
		let ask = AskRoute::new();
		(Arc::new(ChatUiOwner::new(Arc::clone(&ctx), ask.clone(), None)), ctx, ask)
	}

	fn context() -> ControlRequestContext {
		ControlRequestContext {
			connection: Arc::new(ControlConnectionIdentity {
				extension:          Str::new_static("demo"),
				principal:          omp_core::Principal::new(
					Str::new_static("test"),
					Str::new_static("test"),
				),
				artifact_digest:    Str::new_static("digest"),
				layer:              Str::new_static("user"),
				tier:               Str::new_static("trusted"),
				trust:              Str::new_static("trusted"),
				host_generation:    1,
				session_generation: 1,
				capabilities:       Arc::new(BTreeSet::new()),
			}),
			request_id: 1,
			invocation: None,
		}
	}

	/// Drains the actor mailbox, opening the dialog it carries the way the
	/// host would, and returns the opened panel.
	fn opened_dialog(ctx: &Ctx) -> Box<dyn Panel> {
		let mailbox = ctx.user::<HostMailbox>().expect("mailbox");
		let ui = UiContext::default();
		let dom = omp_dom::Dom::new();
		let services: Arc<dyn omp_chat::overlays::Services> =
			Arc::new(omp_chat::overlays::services::NoServices);
		let cx = omp_chat::overlays::PanelCx {
			dom:      &dom,
			con:      ctx,
			ui:       &ui,
			viewport: Size { width: 80, height: 24 },
			services: &services,
		};
		let opener = mailbox
			.drain()
			.find_map(|action| match action {
				HostAction::Open(opener) => Some(opener),
				_ => None,
			})
			.expect("dialog opener posted");
		opener.open(&cx).expect("dialog opens")
	}

	async fn settle(
		ctx: Arc<Ctx>,
		ask: AskRoute,
		answer: impl FnOnce(Box<dyn Panel>) -> PanelEvent + Send + 'static,
	) {
		tokio::task::spawn_blocking(move || {
			// The owner registers the id before posting the opener.
			std::thread::sleep(Duration::from_millis(50));
			let panel = opened_dialog(&ctx);
			let PanelEvent::Ask { id, answers } = answer(panel) else {
				panic!("dialog answers");
			};
			let reply = answers.map_or(AskReply::Cancelled, AskReply::Answers);
			assert!(ask.answer(id.as_str(), reply), "the extension request was waiting");
		})
		.await
		.expect("host thread");
	}

	#[tokio::test]
	async fn dynamic_ask_opens_the_typed_chat_dialog_and_returns_selection() {
		let (owner, ctx, ask) = owner();
		let questions = vec![Question {
			id:          Str::new_static("region"),
			question:    Str::new_static("Which region?"),
			header:      Some(Str::new_static("Region")),
			options:     vec![option("us", None), option("eu", Some(Str::new_static("Frankfurt")))],
			multi:       false,
			recommended: Some(1),
		}];
		let present = owner.present(&questions, Some("dyn-7"));
		let host = settle(ctx, ask, |mut panel| panel.key(Key::Enter));
		let (presentation, ()) = tokio::join!(present, host);
		let presentation = presentation.expect("dynamic ask answered");
		assert_eq!(presentation.selections[0].id, "region");
		assert_eq!(presentation.selections[0].selected, [Str::new_static("eu")]);
	}

	#[tokio::test]
	async fn confirm_dialog_reports_the_chosen_button() {
		let (owner, ctx, ask) = owner();
		let request = owner.request(context(), UiControlRequest::Dialog {
			kind:   Str::new_static("confirm"),
			fields: json!({ "title": "Proceed?", "message": "This rewrites files." })
				.as_object()
				.cloned()
				.expect("object"),
		});
		let host = settle(Arc::clone(&ctx), ask, |mut panel| {
			// `Yes` is the recommended first row: Enter picks it.
			panel.key(Key::Enter)
		});
		let (result, ()) = tokio::join!(request, host);
		let UiControlResult::Value(value) = result.expect("confirm settles") else {
			panic!("confirm returns a value");
		};
		assert_eq!(value["accepted"], Value::Bool(true));
		assert_eq!(value["reason"], Value::Null);
	}

	#[tokio::test]
	async fn dismissed_dialog_reports_dismissed() {
		let (owner, ctx, ask) = owner();
		let request = owner.request(context(), UiControlRequest::Dialog {
			kind:   Str::new_static("select"),
			fields: json!({ "title": "Pick", "items": ["alpha", {"value": "b", "label": "Beta"}] })
				.as_object()
				.cloned()
				.expect("object"),
		});
		let host = settle(Arc::clone(&ctx), ask, |mut panel| panel.key(Key::Esc));
		let (result, ()) = tokio::join!(request, host);
		let UiControlResult::Value(value) = result.expect("select settles") else {
			panic!("select returns a value");
		};
		assert_eq!(value["accepted"], Value::Bool(false));
		assert_eq!(value["reason"], Value::String("dismissed".into()));
	}

	#[tokio::test]
	async fn select_dialog_maps_the_label_back_to_the_item_value() {
		let (owner, ctx, ask) = owner();
		let request = owner.request(context(), UiControlRequest::Dialog {
			kind:   Str::new_static("select"),
			fields: json!({ "title": "Pick", "items": ["alpha", {"value": "b", "label": "Beta"}] })
				.as_object()
				.cloned()
				.expect("object"),
		});
		let host = settle(Arc::clone(&ctx), ask, |mut panel| {
			panel.key(Key::Down);
			panel.key(Key::Enter)
		});
		let (result, ()) = tokio::join!(request, host);
		let UiControlResult::Value(value) = result.expect("select settles") else {
			panic!("select returns a value");
		};
		assert_eq!(value["accepted"], Value::Bool(true));
		assert_eq!(value["value"], Value::String("b".into()));
	}

	#[tokio::test]
	async fn input_dialog_returns_the_typed_text() {
		let (owner, ctx, ask) = owner();
		let request = owner.request(context(), UiControlRequest::Dialog {
			kind:   Str::new_static("input"),
			fields: json!({ "title": "Token", "placeholder": "", "prefill": "", "mask": true })
				.as_object()
				.cloned()
				.expect("object"),
		});
		let host = settle(Arc::clone(&ctx), ask, |mut panel| {
			for ch in "abc".chars() {
				panel.key(Key::Char(ch));
			}
			panel.key(Key::Enter)
		});
		let (result, ()) = tokio::join!(request, host);
		let UiControlResult::Value(value) = result.expect("input settles") else {
			panic!("input returns a value");
		};
		assert_eq!(value["value"], Value::String("abc".into()));
	}

	#[tokio::test]
	async fn presentation_facts_come_from_the_actor() {
		let (owner, ctx, _ask) = owner();
		let request = owner.request(context(), UiControlRequest::Presentation);
		let host = tokio::task::spawn_blocking(move || {
			std::thread::sleep(Duration::from_millis(50));
			let mailbox = ctx.user::<HostMailbox>().expect("mailbox");
			let ui = UiContext::default();
			let dom = omp_dom::Dom::new();
			let services: Arc<dyn omp_chat::overlays::Services> =
				Arc::new(omp_chat::overlays::services::NoServices);
			let cx = omp_chat::overlays::PanelCx {
				dom:      &dom,
				con:      &ctx,
				ui:       &ui,
				viewport: Size { width: 100, height: 30 },
				services: &services,
			};
			for action in mailbox.drain() {
				if let HostAction::Call(call) = action {
					call.call(&cx);
				}
			}
		});
		let (result, host) = tokio::join!(request, host);
		host.expect("host thread");
		let UiControlResult::Value(value) = result.expect("presentation settles") else {
			panic!("presentation returns a value");
		};
		assert_eq!(value["width"], json!(100));
		assert_eq!(value["height"], json!(30));
		assert_eq!(value["has_ui"], Value::Bool(true));
		assert_eq!(value["charset"], Value::String("unicode".into()));
	}

	#[tokio::test]
	async fn set_title_effect_posts_a_distinct_extension_title_action() {
		let (owner, ctx, _ask) = owner();
		owner
			.effect(
				context(),
				json!({"kind": "set_title", "body": {"title": "extension: exact title"}}),
			)
			.await
			.expect("extension title");
		let actions = ctx
			.user::<HostMailbox>()
			.expect("mailbox")
			.drain()
			.collect::<Vec<_>>();
		assert_eq!(actions, [HostAction::ExtensionTitle(Str::new_static("extension: exact title"))]);
		assert!(
			owner
				.effect(context(), json!({"kind": "set_title", "body": {"title": null}}))
				.await
				.is_err(),
			"a missing extension title is rejected before it reaches the actor",
		);
	}

	#[tokio::test]
	async fn set_status_effect_posts_sanitized_set_and_clear() {
		let (owner, ctx, _ask) = owner();
		owner
			.effect(
				context(),
				json!({
					"kind": "set_status",
					"body": {
						"key": "build",
						"content": {
							"source": "<row gap=1><text fg=error>failed</text><text>safely</text></row>",
						},
					},
				}),
			)
			.await
			.expect("styled status");
		owner
			.effect(
				context(),
				json!({"kind": "set_status", "body": {"key": "build", "content": null}}),
			)
			.await
			.expect("clear status");
		let actions = ctx
			.user::<HostMailbox>()
			.expect("mailbox")
			.drain()
			.collect::<Vec<_>>();
		assert!(
			matches!(
				actions.first(),
				Some(HostAction::ExtensionStatus(ExtensionStatus::Set { key, text }))
					if key == "build" && text == "failed safely"
			),
			"{actions:?}",
		);
		assert!(matches!(
			actions.get(1),
			Some(HostAction::ExtensionStatus(ExtensionStatus::Clear { key }))
				if key == "build"
		));
		assert!(
			owner
				.effect(
					context(),
					json!({
						"kind": "set_status",
						"body": {
							"key": "build",
							"content": {
								"source": "<md><button id=unsafe when=active>interactive</button></md>",
							},
						},
					}),
				)
				.await
				.is_err(),
			"interactive or malformed TML is rejected at the app bridge",
		);
	}

	#[test]
	fn collaboration_select_projection_is_correlated_and_single_choice_only() {
		let single = Question {
			id:          Str::new_static("release"),
			question:    Str::new_static("Ship?"),
			header:      None,
			options:     vec![option("Yes", None), option("No", None)],
			multi:       false,
			recommended: Some(1),
		};
		let request = remote_select(std::slice::from_ref(&single)).expect("remote request");
		let Some(ui_request::Spec::Select(spec)) = request.spec else {
			panic!("select");
		};
		assert_eq!(spec.initial_index, 1);
		assert_eq!(spec.options.len(), 2);
		let selected = remote_selection(&single, "Yes".to_owned());
		assert_eq!(selected.selected, [Str::new_static("Yes")]);
		assert!(selected.custom_input.is_none());

		let mut multi = single;
		multi.multi = true;
		assert!(remote_select(&[multi]).is_none(), "multi-step asks remain local");
	}

	#[tokio::test]
	async fn without_a_host_mailbox_dialogs_are_refused_typed() {
		let ctx = Arc::new(Ctx::new());
		let owner = ChatUiOwner::new(Arc::clone(&ctx), AskRoute::new(), None);
		let error = owner
			.request(context(), UiControlRequest::Dialog {
				kind:   Str::new_static("confirm"),
				fields: json!({ "title": "?" })
					.as_object()
					.cloned()
					.expect("object"),
			})
			.await
			.err()
			.expect("refused");
		assert_eq!(error.code.as_str(), "no_ui");
	}
}
