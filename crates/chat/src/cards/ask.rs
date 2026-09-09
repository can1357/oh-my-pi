//! Typed interactive question card.

use std::collections::BTreeMap;

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tools::ask::{Answer, OptionItem, Params, Payload, Question};
use omp_tui::{IntoComponent as _, UiContext, dom};

use super::{Card, CardStatus, CardView, Component, typed_fault};

/// Renders streamed questions, choices, answers, and cancellation faults.
pub struct AskCard;

impl Card for AskCard {
	fn tool(&self) -> &'static str {
		"ask"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		if view.status == CardStatus::Failed {
			let fault = failure(view);
			return dom! {
				<col><row gap=1><icon name="warning-status" fg=warn/><text fg=accent>{"Ask"}</text></row><text fg=muted>{fault}</text></col>
			}.into_component();
		}

		let payload = view.result::<Payload>();
		let questions = render_questions(view, payload.as_ref());
		let answers = payload
			.as_ref()
			.map(|payload| {
				payload
					.answers
					.iter()
					.map(|answer| (answer.id.as_str(), answer))
					.collect::<BTreeMap<_, _>>()
			})
			.unwrap_or_default();
		let answered = payload.is_some();
		let count = if questions.len() == 1 {
			"1 question".to_owned()
		} else {
			format!("{} questions", questions.len())
		};
		let mut question_rows = Vec::new();
		for question in &questions {
			let answer = answers.get(question.id.as_str()).copied();
			let divider = if answered {
				format!("[{}]", question.id)
			} else if question.multi {
				format!("[{}] · multi · options:{}", question.id, question.options.len())
			} else {
				format!("[{}] · options:{}", question.id, question.options.len())
			};
			question_rows
				.push(dom! { <hr title={divider} title_pad=3 bc=border fg=muted/> }.into_component());
			question_rows.push(
				dom! { <text pad-x=1 fg=accent>{question.question.clone()}</text> }.into_component(),
			);
			for option in &question.options {
				let checked = answer.is_some_and(|answer| answer.selected.contains(&option.label));
				question_rows.push(
					dom! {
						<row gap=1 pad-x=1>
							if question.multi && checked { <i:checked fg=ok/> }
							else if question.multi { <i:unchecked fg=muted/> }
							else if checked { <icon name="radio-selected" fg=ok/> }
							else { <i:unselected fg=muted/> }
							<text fg=output>{option.label.clone()}</text>
						</row>
					}
					.into_component(),
				);
				if !answered && let Some(description) = &option.description {
					let description = Str::new(format!("↳ {description}"));
					question_rows
						.push(dom! { <text pad-x=3 fg=muted>{description}</text> }.into_component());
				}
			}
			if let Some(answer) = answer {
				append_written_rows(&mut question_rows, answer);
			}
		}
		dom! {
			<box border=round bc=border bg=panel bleed title_pad=3 pad="0 1">
				<row kind=title gap=1>
					if answered { <i:success fg=ok/> }
					<text fg=accent>{"Ask"}</text><text fg=muted>{count}</text>
				</row>
				<col>{question_rows}</col>
			</box>
		}
		.into_component()
	}
}

#[derive(Clone)]
struct RenderQuestion {
	id:       Str,
	question: Str,
	options:  Vec<OptionItem>,
	multi:    bool,
}

impl From<&Question> for RenderQuestion {
	fn from(question: &Question) -> Self {
		Self {
			id:       question.id.clone(),
			question: question.question.clone(),
			options:  question.options.clone(),
			multi:    question.multi,
		}
	}
}

impl From<&Answer> for RenderQuestion {
	fn from(answer: &Answer) -> Self {
		Self {
			id:       answer.id.clone(),
			question: answer.question.clone(),
			options:  answer
				.options
				.iter()
				.map(|label| OptionItem {
					label:       label.clone(),
					description: None,
					preview:     None,
				})
				.collect(),
			multi:    answer.multi,
		}
	}
}

fn render_questions(view: &CardView<'_>, payload: Option<&Payload>) -> Vec<RenderQuestion> {
	if let Some(Params { questions }) = view.input::<Params>() {
		return questions.iter().map(RenderQuestion::from).collect();
	}
	if let Some(payload) = payload {
		return payload.answers.iter().map(RenderQuestion::from).collect();
	}
	let raw = node_text(view.input).unwrap_or_default();
	vec![RenderQuestion {
		id:       extract_string(raw.as_str(), "id").unwrap_or_default(),
		question: extract_string(raw.as_str(), "question").unwrap_or_default(),
		options:  vec![OptionItem {
			label:       extract_string(raw.as_str(), "label").unwrap_or_default(),
			description: None,
			preview:     None,
		}],
		multi:    false,
	}]
}

fn append_written_rows(rows: &mut Vec<Component>, answer: &Answer) {
	if let Some(custom) = &answer.custom_input {
		let mut lines = custom.as_str().split('\n');
		let first = Str::new(lines.next().unwrap_or_default());
		rows
			.push(dom! { <row gap=1 pad-x=1><i:success/><text>{first}</text></row> }.into_component());
		for line in lines {
			rows.push(dom! { <text pad-x=3>{Str::new(line)}</text> }.into_component());
		}
	}
	if let Some(note) = &answer.note {
		let mut lines = note.as_str().split('\n');
		let first = Str::new(lines.next().unwrap_or_default());
		rows.push(
			dom! { <row gap=1 pad-x=1><text fg=muted>{"Note:"}</text><text>{first}</text></row> }
				.into_component(),
		);
		for line in lines {
			rows.push(dom! { <text pad-x=7>{Str::new(line)}</text> }.into_component());
		}
	}
	if answer.timed_out {
		rows.push(
			dom! { <text pad-x=1 fg=muted>{"auto-selected after timeout — not a user choice"}</text> }
				.into_component(),
		);
	}
}

fn extract_string(raw: &str, key: &str) -> Option<Str> {
	let marker = format!("\"{key}\":\"");
	let rest = raw.split_once(&marker)?.1;
	Some(Str::new(rest.split('"').next().unwrap_or(rest)))
}

fn failure(view: &CardView<'_>) -> Str {
	if let Some(fault) = typed_fault::<omp_tools::ask::Fault>(view) {
		return fault;
	}
	let raw = view.diag.and_then(node_text).unwrap_or_default();
	serde_json::from_str::<String>(raw.as_str())
		.map(Str::new)
		.unwrap_or(raw)
}

fn node_text(node: &Node) -> Option<Str> {
	node.content.clone().or_else(|| {
		node
			.prop(&PropId::Text.into())
			.and_then(|value| value.as_str())
			.map(Str::new)
	})
}
