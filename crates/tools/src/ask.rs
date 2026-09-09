//! Interactive question selection with a host-provided presentation seam.

use std::{fmt::Write as _, future, future::Future, pin::Pin, sync::Arc};

use async_stream::stream;
use async_trait::async_trait;
use futures::Stream;
use omp_core::{FastHashSet, Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, Constraint, Effects, Ev, ExecutionMode, IncomingParams,
	ParamError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Label used for a host-provided free-text alternative.
pub const OTHER_OPTION: &str = "Other (type your own)";

const RESERVED_LABELS: [&str; 3] = [OTHER_OPTION, "Chat about this", "Next →"];

/// Arguments for `ask@2`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Questions presented in order.
	pub questions: Vec<Question>,
}
/// One picker question.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
	/// Stable key returned with the answer.
	pub id:          Str,
	/// User-visible question text.
	pub question:    Str,
	/// Compact section label.
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "String")]
	pub header:      Option<Str>,
	/// Available choices.
	pub options:     Vec<OptionItem>,
	/// Allow more than one choice.
	#[serde(default)]
	pub multi:       bool,
	/// Zero-based recommended choice used as the initial selection and timeout
	/// fallback.
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "u64")]
	pub recommended: Option<usize>,
}
/// One picker choice.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OptionItem {
	/// Returned choice label.
	pub label:       Str,
	/// Optional explanation.
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "String")]
	pub description: Option<Str>,
	/// Optional rich preview source.
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "String")]
	pub preview:     Option<Str>,
}
/// One observer-local selection returned by an interactive presenter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Selection {
	/// The corresponding question identifier.
	pub id:           Str,
	/// Choice labels in selection order.
	pub selected:     Vec<Str>,
	/// Free text entered through the host-provided Other choice.
	#[serde(rename = "customInput", default, skip_serializing_if = "Option::is_none")]
	pub custom_input: Option<Str>,
	/// Optional user note attached to this answer.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub note:         Option<Str>,
	/// Whether the timeout, rather than the user, chose this answer.
	pub timed_out:    bool,
}
/// A durable answer containing the question contract and its resolved
/// selection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Answer {
	/// The corresponding question identifier.
	pub id:           Str,
	/// Question text shown to the user.
	#[serde(default)]
	pub question:     Str,
	/// Offered choice labels in their original order.
	#[serde(default)]
	pub options:      Vec<Str>,
	/// Whether more than one offered choice was allowed.
	#[serde(default)]
	pub multi:        bool,
	/// Choice labels in selection order.
	pub selected:     Vec<Str>,
	/// Free text entered through the host-provided Other choice.
	#[serde(rename = "customInput", default, skip_serializing_if = "Option::is_none")]
	pub custom_input: Option<Str>,
	/// Optional user note attached to this answer.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub note:         Option<Str>,
	/// Whether the timeout, rather than the user, chose this answer.
	pub timed_out:    bool,
}
/// Structured ask result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Durable answers ordered like the request questions.
	pub answers: Vec<Answer>,
}
/// Ask has no genuine output updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}
/// Ask validation or presenter failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Arguments violate the picker contract.
	#[error("{message}")]
	Invalid {
		/// Stable validation explanation.
		message: Str,
	},
	/// The environment presentation bridge failed.
	#[error("{message}")]
	Presenter {
		/// Stable bridge failure explanation.
		message: Str,
	},
	/// The user dismissed the dialog without answering.
	#[error("{message}")]
	Cancelled {
		/// Stable cancellation explanation.
		message: Str,
	},
	/// The current host has no interactive presentation surface.
	#[error("Ask tool requires interactive mode")]
	RequiresInteractive,
	/// The host returned selections that do not match the presented questions.
	#[error("Ask presenter returned selections that do not match the questions")]
	InvalidPresentation,
}
impl Fault {
	/// The user-cancel fault every interactive presenter reports on Esc.
	#[must_use]
	pub const fn cancelled() -> Self {
		Self::Cancelled { message: Str::new_static("Ask tool was cancelled by the user") }
	}
}

/// UI bridge implemented by the environment's `omp.ui.v1.UiRequest` dispatcher.
///
/// The tools crate deliberately does not manufacture UI outcomes: interactive
/// hosts implement this trait and route `Params` through their dialog request
/// path. The default presenter fails explicitly when no interactive host is
/// attached.
pub trait AskPresenter: Send + Sync + 'static {
	/// Whether this presenter has a user-facing interaction surface.
	fn interactive(&self) -> bool {
		true
	}

	/// Presents ordered questions and returns observer-local selections.
	///
	/// `invocation` is the kernel call identity of the asking tool element
	/// (`<ask id>`), when the dispatcher supplied one: interactive hosts
	/// answer that identity, so a presenter correlates by it rather than by
	/// arrival order.
	fn present<'p>(
		&'p self,
		questions: &'p [Question],
		invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>>;
}

/// Replaceable per-environment presentation bridge.
#[derive(Clone)]
pub struct PresenterSlot {
	inner: Arc<RwLock<Arc<dyn AskPresenter>>>,
}

impl PresenterSlot {
	/// Creates a slot with the specified fallback presenter.
	pub fn new(presenter: Arc<dyn AskPresenter>) -> Self {
		Self { inner: Arc::new(RwLock::new(presenter)) }
	}

	/// Replaces the presenter used by subsequent ask invocations.
	pub fn bind(&self, presenter: Arc<dyn AskPresenter>) {
		*self.inner.write() = presenter;
	}
}

impl AskPresenter for PresenterSlot {
	fn interactive(&self) -> bool {
		self.inner.read().interactive()
	}

	fn present<'p>(
		&'p self,
		questions: &'p [Question],
		invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>> {
		let presenter = Arc::clone(&*self.inner.read());
		Box::pin(async move { presenter.present(questions, invocation).await })
	}
}
/// Presenter result with observer-local selections in question order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Presentation {
	/// Selections returned by the host.
	pub selections: Vec<Selection>,
}
/// One ordered spoken line for an ask dialog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpokenLine {
	/// Text spoken in presentation order.
	pub text:        Str,
	/// Whether this line identifies the recommended option.
	pub recommended: bool,
}

/// Cancellable host-owned dialog vocalizer.
#[async_trait]
pub trait AskVocalizer: Send + Sync + 'static {
	/// Speaks the complete ordered dialog or returns silently when disabled.
	async fn speak(
		&self,
		lines: &[SpokenLine],
		cancellation: CancellationToken,
	) -> Result<(), Fault>;
}
/// Explicit noninteractive presenter: `ask` fails instead of inventing a user
/// choice.
#[derive(Default)]
pub struct HeadlessPresenter;
impl AskPresenter for HeadlessPresenter {
	fn interactive(&self) -> bool {
		false
	}

	fn present<'p>(
		&'p self,
		_questions: &'p [Question],
		_invocation: Option<&'p str>,
	) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>> {
		Box::pin(future::ready(Err(Fault::RequiresInteractive)))
	}
}

/// Ask tool backed by a UI presentation bridge.
pub struct Ask {
	presenter: Arc<dyn AskPresenter>,
	vocalizer: Option<Arc<dyn AskVocalizer>>,
	spec:      ToolSpec,
}
/// Creates `ask@2` with the specified environment presentation bridge.
pub fn tool(presenter: Arc<dyn AskPresenter>) -> Ask {
	Ask { presenter, vocalizer: None, spec: spec() }
}
/// Creates `ask@2` with ordered cancellable speech.
pub fn tool_with_vocalizer(
	presenter: Arc<dyn AskPresenter>,
	vocalizer: Arc<dyn AskVocalizer>,
) -> Ask {
	Ask { presenter, vocalizer: Some(vocalizer), spec: spec() }
}
/// Creates `ask@2` with an explicit noninteractive failure policy.
pub fn headless_tool() -> Ask {
	tool(Arc::new(HeadlessPresenter))
}
fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("ask"),
		rev:             Rev { family: Str::new(""), n: 2 },
		description:     sf!(
			"Asks the user one or more picker questions. Options may include descriptions and \
			 previews; use `multi` for multi-selection and `recommended` for timeout defaults.",
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::default(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("ask.rs"),
		)
		.into(),
	}
}
impl Tool for Ask {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn execution_mode(&self) -> ExecutionMode {
		ExecutionMode::Sequential
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let arguments = match params.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			if let Err(error) = params.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			if let Err(fault) = validate(&arguments.questions) {
				yield done(Err(fault));
				return;
			}
			if !self.presenter.interactive() {
				yield Ev::Aborted(Abort::Interrupted {
					reason: Str::new_static("Ask tool requires interactive mode"),
				});
				return;
			}
			if let Some(vocalizer) = &self.vocalizer {
				let cancellation = CancellationToken::new();
				let lines = spoken_lines(&arguments.questions);
				let speech = vocalizer.speak(&lines, cancellation.clone());
				tokio::pin!(speech);
				tokio::select! {
					result = &mut speech => {
						if let Err(fault) = result {
							yield done(Err(fault));
							return;
						}
					},
					interrupt = params.next_interrupt() => {
						cancellation.cancel();
						if let Ok(interrupt) = interrupt {
							yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
						} else {
							yield Ev::Aborted(Abort::InputDropped);
						}
						return;
					},
				}
			}
			// The dialog waits on the user; an interrupt (Esc on the turn,
			// Ctrl+C) must abort the wait rather than leave the call hanging
			// until the dispatcher's grace forces it closed.
			let invocation = params.invocation_id().cloned();
			let presented = self.presenter.present(&arguments.questions, invocation.as_deref());
			tokio::pin!(presented);
			let result = tokio::select! {
				result = &mut presented => result,
				interrupt = params.next_interrupt() => {
					if let Ok(interrupt) = interrupt {
						yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
					} else {
						yield Ev::Aborted(Abort::InputDropped);
					}
					return;
				},
			};
			let result = result.and_then(|presentation| durable_result(&arguments.questions, presentation));
			match result {
				Err(Fault::Cancelled { .. }) => {
					yield Ev::Aborted(Abort::Interrupted {
						reason: Str::new_static("Ask tool was cancelled by the user"),
					});
				},
				settled => yield done(settled),
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => prompt_text(payload),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}
/// Projects questions, options, previews, and recommendations into
/// deterministic speech order.
pub fn spoken_lines(questions: &[Question]) -> Vec<SpokenLine> {
	let mut lines = Vec::new();
	for question in questions {
		if let Some(header) = &question.header {
			lines.push(SpokenLine { text: header.clone(), recommended: false });
		}
		lines.push(SpokenLine { text: question.question.clone(), recommended: false });
		for (index, option) in question.options.iter().enumerate() {
			let recommended = question.recommended == Some(index);
			lines.push(SpokenLine { text: option.label.clone(), recommended });
			if let Some(description) = &option.description {
				lines.push(SpokenLine { text: description.clone(), recommended });
			}
			if let Some(preview) = &option.preview {
				lines.push(SpokenLine { text: preview.clone(), recommended });
			}
		}
	}
	lines
}

/// Validates a nonempty request, nonempty unique identifiers, and permitted
/// option labels. Presenters clamp an out-of-range recommendation safely.
pub fn validate(questions: &[Question]) -> Result<(), Fault> {
	if questions.is_empty() {
		return Err(invalid("`questions` must not be empty"));
	}
	let mut ids = FastHashSet::default();
	for question in questions {
		if question.id.trim().is_empty() || !ids.insert(question.id.clone()) {
			return Err(invalid("question ids must be non-empty and unique"));
		}
		for option in &question.options {
			if option.label.trim().is_empty() || RESERVED_LABELS.contains(&option.label.as_ref()) {
				return Err(invalid("option labels must be non-empty and not reserved"));
			}
		}
	}
	Ok(())
}
fn durable_result(questions: &[Question], presentation: Presentation) -> Result<Payload, Fault> {
	if presentation.selections.len() != questions.len() {
		return Err(Fault::InvalidPresentation);
	}
	let single_question = questions.len() == 1;
	let mut answers = Vec::with_capacity(questions.len());
	for (question, selection) in questions.iter().zip(presentation.selections) {
		if selection.id != question.id {
			return Err(Fault::InvalidPresentation);
		}
		let mut selected = FastHashSet::default();
		if selection.selected.iter().any(|label| {
			!selected.insert(label)
				|| !question
					.options
					.iter()
					.any(|option| option.label == label.as_str())
		}) {
			return Err(Fault::InvalidPresentation);
		}
		if !question.multi
			&& (selection.selected.len() > 1
				|| (!selection.selected.is_empty() && selection.custom_input.is_some()))
		{
			return Err(Fault::InvalidPresentation);
		}
		if selection.note.is_some()
			&& selection.selected.is_empty()
			&& selection.custom_input.is_none()
		{
			return Err(Fault::InvalidPresentation);
		}
		if single_question
			&& !question.multi
			&& selection.selected.is_empty()
			&& selection.custom_input.is_none()
			&& !selection.timed_out
		{
			return Err(Fault::cancelled());
		}
		answers.push(Answer {
			id:           question.id.clone(),
			question:     question.question.clone(),
			options:      question
				.options
				.iter()
				.map(|option| option.label.clone())
				.collect(),
			multi:        question.multi,
			selected:     selection.selected,
			custom_input: selection.custom_input,
			note:         selection.note,
			timed_out:    selection.timed_out,
		});
	}
	Ok(Payload { answers })
}

fn prompt_text(payload: &Payload) -> Str {
	let [answer] = payload.answers.as_slice() else {
		let mut text = String::from("User answers:");
		for answer in &payload.answers {
			text.push('\n');
			write_question_answer(&mut text, answer);
		}
		return Str::new(text);
	};
	let mut text = String::new();
	if !answer.selected.is_empty() {
		text.push_str("User selected: ");
		if answer.multi {
			write_labels(&mut text, &answer.selected);
		} else {
			text.push_str(answer.selected[0].as_str());
		}
		if answer.timed_out {
			text.push_str(" (auto-selected after timeout)");
		}
	}
	if let Some(custom) = &answer.custom_input {
		separate_line(&mut text);
		write_user_text(&mut text, "User provided custom input", custom);
	}
	if let Some(note) = &answer.note {
		separate_line(&mut text);
		write_user_text(&mut text, "User added note", note);
	}
	if text.is_empty() {
		text.push_str(if answer.multi {
			"User did not select any options"
		} else {
			"User cancelled the selection"
		});
	}
	Str::new(text)
}

fn write_question_answer(text: &mut String, answer: &Answer) {
	let _ = write!(text, "{}: ", answer.id);
	if let Some(custom) = &answer.custom_input {
		let _ = write!(text, "\"{custom}\"");
	} else if answer.selected.is_empty() {
		text.push_str(if answer.multi { "[]" } else { "(cancelled)" });
	} else if answer.multi {
		text.push('[');
		write_labels(text, &answer.selected);
		text.push(']');
	} else {
		text.push_str(answer.selected[0].as_str());
	}
	if answer.timed_out && !answer.selected.is_empty() {
		text.push_str(" (auto-selected after timeout)");
	}
	if let Some(note) = &answer.note {
		let _ = write!(text, " (note: {note})");
	}
}

fn write_labels(text: &mut String, labels: &[Str]) {
	for (index, label) in labels.iter().enumerate() {
		if index > 0 {
			text.push_str(", ");
		}
		text.push_str(label);
	}
}

fn write_user_text(text: &mut String, label: &str, value: &str) {
	if value.contains('\n') {
		let _ = writeln!(text, "{label}:");
		for (index, line) in value.split('\n').enumerate() {
			if index > 0 {
				text.push('\n');
			}
			let _ = write!(text, "  {line}");
		}
	} else {
		let _ = write!(text, "{label}: {value}");
	}
}

fn separate_line(text: &mut String) {
	if !text.is_empty() && !text.ends_with('\n') {
		text.push('\n');
	}
}

fn invalid(message: &str) -> Fault {
	Fault::Invalid { message: Str::new(message) }
}
const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn commit_event(error: omp_tool::CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		omp_tool::CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		omp_tool::CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		omp_tool::CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"questions":[...] }}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use futures::StreamExt as _;
	use tokio::time;

	use super::*;
	fn question(recommended: Option<usize>) -> Question {
		Question {
			id: sf!("format"),
			question: sf!("Which?"),
			header: None,
			options: vec![
				OptionItem { label: sf!("Markdown"), description: None, preview: None },
				OptionItem {
					label:       sf!("Text"),
					description: None,
					preview:     Some(sf!("plain")),
				},
			],
			multi: false,
			recommended,
		}
	}
	#[test]
	fn revision_two_schema_is_the_dyn_contract() {
		let ask = headless_tool();
		assert_eq!(ask.spec().rev.n, 2);
		assert_eq!(ask.execution_mode(), ExecutionMode::Sequential);
		let schema: serde_json::Value =
			serde_json::from_slice(&ask.spec().schema).expect("ask schema");
		assert_eq!(schema["required"][0], "i");
		assert_eq!(schema["required"][1], "questions");
		let question = &schema["properties"]["questions"]["items"]["properties"];
		assert_eq!(question["multi"]["type"], "boolean");
		assert_eq!(question["recommended"]["type"], "integer");
		assert_eq!(question["options"]["items"]["properties"]["preview"]["type"], "string");
		assert!(schema["properties"].get("timeout").is_none());
		assert!(schema["properties"].get("customInput").is_none());
	}
	#[test]
	fn durable_answer_serializes_question_contract_and_custom_input() {
		let answer = Answer {
			id:           sf!("database"),
			question:     sf!("Which database?"),
			options:      vec![sf!("Postgres"), sf!("SQLite")],
			multi:        false,
			selected:     Vec::new(),
			custom_input: Some(sf!("DuckDB")),
			note:         Some(sf!("embedded analytics")),
			timed_out:    false,
		};
		let value = serde_json::to_value(answer).expect("answer serializes");
		assert_eq!(value["question"], "Which database?");
		assert_eq!(value["options"], serde_json::json!(["Postgres", "SQLite"]));
		assert_eq!(value["customInput"], "DuckDB");
		assert_eq!(value["note"], "embedded analytics");
		assert!(value.get("custom_input").is_none());
	}
	#[test]
	fn multi_choice_and_freeform_survive_in_the_durable_result() {
		let mut question = question(Some(1));
		question.multi = true;
		let result = durable_result(&[question], Presentation {
			selections: vec![Selection {
				id:           sf!("format"),
				selected:     vec![sf!("Markdown")],
				custom_input: Some(sf!("AsciiDoc")),
				note:         Some(sf!("support both")),
				timed_out:    false,
			}],
		})
		.expect("valid multi answer");
		assert_eq!(result.answers[0].options, [sf!("Markdown"), sf!("Text")]);
		assert_eq!(result.answers[0].selected, [sf!("Markdown")]);
		assert_eq!(result.answers[0].custom_input.as_deref(), Some("AsciiDoc"));
		assert_eq!(
			prompt_text(&result),
			"User selected: Markdown\nUser provided custom input: AsciiDoc\nUser added note: support \
			 both"
		);
	}
	#[test]
	fn rejects_reserved_labels_and_malformed_presenter_results() {
		let mut reserved = question(Some(0));
		reserved.options[0].label = sf!("Next →");
		assert!(validate(&[reserved]).is_err());

		let mut single = question(None);
		single.multi = false;
		assert_eq!(
			durable_result(&[single], Presentation {
				selections: vec![Selection {
					id:           sf!("format"),
					selected:     vec![sf!("Markdown"), sf!("Text")],
					custom_input: None,
					note:         None,
					timed_out:    false,
				}],
			},),
			Err(Fault::InvalidPresentation)
		);
	}

	struct DelayedPresenter;

	impl AskPresenter for DelayedPresenter {
		fn present<'p>(
			&'p self,
			questions: &'p [Question],
			_invocation: Option<&'p str>,
		) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>> {
			Box::pin(async move {
				time::sleep(Duration::from_millis(10)).await;
				Ok(Presentation {
					selections: vec![Selection {
						id:           questions[0].id.clone(),
						selected:     vec![questions[0].options[0].label.clone()],
						custom_input: None,
						note:         None,
						timed_out:    false,
					}],
				})
			})
		}
	}

	#[tokio::test(flavor = "current_thread")]
	async fn call_awaits_async_presenter_on_current_thread_runtime() {
		let ask = tool(Arc::new(DelayedPresenter));
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new(
				r#"{"questions":[{"id":"format","question":"Which?","options":[{"label":"Markdown"}]}]}"#,
			))
			.expect("ask invocation remains live");

		let events = ask.call(params).collect::<Vec<_>>().await;
		let [Ev::Done(ToolTerminal::Done { result: Ok(Payload { answers }), .. })] =
			events.as_slice()
		else {
			panic!("expected successful async ask result: {events:?}");
		};
		assert_eq!(answers[0].selected, [sf!("Markdown")]);
		assert_eq!(answers[0].question, "Which?");
		assert_eq!(answers[0].options, [sf!("Markdown")]);
		assert!(!answers[0].timed_out);
	}

	struct CancelledPresenter;

	impl AskPresenter for CancelledPresenter {
		fn present<'p>(
			&'p self,
			questions: &'p [Question],
			_invocation: Option<&'p str>,
		) -> Pin<Box<dyn Future<Output = Result<Presentation, Fault>> + Send + 'p>> {
			Box::pin(future::ready(Ok(Presentation {
				selections: vec![Selection {
					id:           questions[0].id.clone(),
					selected:     Vec::new(),
					custom_input: None,
					note:         None,
					timed_out:    false,
				}],
			})))
		}
	}

	#[tokio::test(flavor = "current_thread")]
	async fn empty_single_choice_is_a_call_abort_but_empty_multi_is_valid() {
		let ask = tool(Arc::new(CancelledPresenter));
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new(
				r#"{"questions":[{"id":"format","question":"Which?","options":[{"label":"Markdown"}]}]}"#,
			))
			.expect("ask invocation remains live");
		let events = ask.call(params).collect::<Vec<_>>().await;
		assert!(matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })]
				if reason == "Ask tool was cancelled by the user"
		));

		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new(
				r#"{"questions":[{"id":"format","question":"Which?","multi":true,"options":[{"label":"Markdown"}]}]}"#,
			))
			.expect("ask invocation remains live");
		let events = ask.call(params).collect::<Vec<_>>().await;
		assert!(matches!(
			events.as_slice(),
			[Ev::Done(ToolTerminal::Done { result: Ok(Payload { answers }), .. })]
				if answers[0].selected.is_empty()
		));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn headless_call_fails_without_vocalizing_or_inventing_an_answer() {
		let ask = headless_tool();
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new(
				r#"{"questions":[{"id":"format","question":"Which?","options":[{"label":"Markdown"}],"recommended":0}]}"#,
			))
			.expect("ask invocation remains live");
		let events = ask.call(params).collect::<Vec<_>>().await;
		assert!(matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })]
				if reason == "Ask tool requires interactive mode"
		));
	}
}
