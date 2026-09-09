//! Typed card for the session checklist reducer.

use omp_core::{Str, sf};
use omp_dom::{Node, PropId};
use omp_tools::todo::{CompletionTransition, Phase, Status, Task};
use omp_tui::{IntoComponent as _, UiContext, components::STRIKE_TOTAL_FRAMES, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_fault, typed_input};

/// Session todo/checklist card.
pub struct TodoCard;

impl Card for TodoCard {
	fn tool(&self) -> &'static str {
		"todo"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		match view.status {
			CardStatus::StreamingArgs | CardStatus::InProgress => render_live(view),
			CardStatus::Done => render_checklist(view, expanded),
			CardStatus::Failed => render_failed(view),
		}
	}
}

fn render_live(view: &CardView<'_>) -> Component {
	let args = typed_input::<omp_tools::todo::Params>(view);
	let op = args
		.as_ref()
		.and_then(|value| value.get("op"))
		.and_then(Value::as_str)
		.or_else(|| partial_string(view.args_text().unwrap_or_default(), "op"))
		.unwrap_or_default();
	dom! {
		<row gap=1><i:pending fg=output/><text fg=accent>{"Todo"}</text><text fg=muted>{op}</text>
			if let Some(badge) = elapsed_badge(view) { {badge} }
		</row>
	}
	.into_component()
}

/// The completion strike ticks every 65 ms for `TODO_STRIKE_TOTAL_FRAMES`
/// frames; `<strike reveal>` sweeps over the
/// same total on the shared clock.
const TODO_STRIKE_FRAME_MS: u64 = 65;

/// Whether one completed row belongs to this settlement. Current payloads
/// carry the authoritative transition list; historical payloads did not, so
/// a single-task `done` call falls back to its exact verbatim identity.
fn completion_sweeps(
	view: &CardView<'_>,
	completed: &[CompletionTransition],
	phase: &str,
	content: &str,
) -> bool {
	if completed
		.iter()
		.any(|transition| transition.phase == phase && transition.content == content)
	{
		return true;
	}
	let Some(args) = typed_input::<omp_tools::todo::Params>(view) else {
		return false;
	};
	args.get("op").and_then(Value::as_str) == Some("done")
		&& args.get("task").and_then(Value::as_str) == Some(content)
		&& args
			.get("phase")
			.and_then(Value::as_str)
			.is_none_or(|named| named == phase)
}

/// Collapsed phases show at most this many task rows.
const COLLAPSED_ITEMS: usize = 8;

/// Closed rows kept above the open window so a completion stays visible.
const COLLAPSED_CLOSED_CONTEXT: usize = 1;

/// A task the collapsed viewport hides.
fn is_closed(task: &Task) -> bool {
	matches!(task.status, Status::Completed | Status::Abandoned)
}

/// Collapsed task rows for one phase plus the trailing summary: the last
/// closed task leads, then in-progress
/// work, then the pending tasks that follow it, capped at `cap`.
fn select_collapsed(tasks: &[Task], cap: usize) -> (Vec<&Task>, Option<Str>) {
	let open = tasks
		.iter()
		.filter(|task| !is_closed(task))
		.collect::<Vec<_>>();
	if open.is_empty() {
		return select_within_cap(tasks.iter().collect(), cap);
	}
	let closed = tasks
		.iter()
		.filter(|task| is_closed(task))
		.collect::<Vec<_>>();
	let lead = &closed[closed.len().saturating_sub(COLLAPSED_CLOSED_CONTEXT)..];
	let (selected, summary) = select_within_cap(open, cap);
	let mut items = Vec::with_capacity(lead.len() + selected.len());
	items.extend_from_slice(lead);
	items.extend(selected);
	(items, summary)
}

/// Selects every in-progress task first (in todo order), then the tasks
/// following the first active one until `cap`; when actives alone
/// overflow, only they show and the summary counts the hidden actives.
fn select_within_cap(base: Vec<&Task>, cap: usize) -> (Vec<&Task>, Option<Str>) {
	if base.len() <= cap {
		return (base, None);
	}
	let active = base
		.iter()
		.copied()
		.filter(|task| task.status == Status::InProgress)
		.collect::<Vec<_>>();
	if active.len() > cap {
		let hidden = active.len() - cap;
		let noun = if hidden == 1 { "todo" } else { "todos" };
		return (active[..cap].to_vec(), Some(sf!("… {hidden} more active {noun}")));
	}
	let first_active = active
		.first()
		.and_then(|first| base.iter().position(|task| std::ptr::eq(*task, *first)))
		.unwrap_or(0);
	let mut items = active;
	for task in base.iter().skip(first_active).copied() {
		if items.len() >= cap {
			break;
		}
		if task.status != Status::InProgress {
			items.push(task);
		}
	}
	let hidden = base.len() - items.len();
	let summary = (hidden > 0).then(|| {
		let noun = if hidden == 1 { "todo" } else { "todos" };
		sf!("… {hidden} more {noun}")
	});
	(items, summary)
}

/// Phases this update touched: the phase holding in-progress work, phases
/// with a task just completed, phases named by the
/// op's `phase`/`task`; `init` replaces the whole list, so every phase counts.
/// `None` means no usable signal: render every phase in full.
fn touched_phases(
	view: &CardView<'_>,
	phases: &[Phase],
	completed: &[CompletionTransition],
) -> Option<Vec<Str>> {
	let mut touched: Vec<Str> = Vec::new();
	let mut touch = |name: &Str| {
		if !touched.contains(name) {
			touched.push(name.clone());
		}
	};
	for phase in phases {
		if phase
			.tasks
			.iter()
			.any(|task| task.status == Status::InProgress)
		{
			touch(&phase.name);
		}
	}
	for transition in completed {
		touch(&transition.phase);
	}
	if let Some(args) = typed_input::<omp_tools::todo::Params>(view) {
		if args.get("op").and_then(Value::as_str) == Some("init") {
			return Some(phases.iter().map(|phase| phase.name.clone()).collect());
		}
		if let Some(named) = args.get("phase").and_then(Value::as_str) {
			if let Some(phase) = phases.iter().find(|phase| phase.name.as_str() == named) {
				touch(&phase.name);
			}
		}
		if let Some(content) = args.get("task").and_then(Value::as_str) {
			if let Some(phase) = phases.iter().find(|phase| {
				phase
					.tasks
					.iter()
					.any(|task| task.content.as_str() == content)
			}) {
				touch(&phase.name);
			}
		}
	}
	(!touched.is_empty()).then_some(touched)
}

fn render_checklist(view: &CardView<'_>, expanded: bool) -> Component {
	let sweep = sf!("{}ms", TODO_STRIKE_FRAME_MS * u64::from(STRIKE_TOTAL_FRAMES));
	let (phases, completed) = view
		.result::<omp_tools::todo::Payload>()
		.map(|payload| (payload.phases, payload.completed_tasks))
		.unwrap_or_default();
	let total: usize = phases.iter().map(|phase| phase.tasks.len()).sum();
	if total == 0 {
		let empty = if typed_input::<omp_tools::todo::Params>(view)
			.as_ref()
			.and_then(|args| args.get("op"))
			.and_then(Value::as_str)
			== Some("view")
		{
			"Todo list is empty."
		} else {
			"Todo list cleared."
		};
		return dom! {
			<box border=round bc=border title_pad=3 pad="0 1">
				<row kind=title gap=1><i:todo fg=accent/><text fg=accent>{"Todo"}</text><text fg=muted>{"0 tasks"}</text></row>
				<text fg=muted>{empty}</text>
			</box>
		}
		.into_component();
	}
	// Collapsed multi-phase lists fold the phases this update did not touch
	// to a one-line summary; a single phase or the manual expand shows all.
	let touched = if expanded || phases.len() < 2 {
		None
	} else {
		touched_phases(view, &phases, &completed)
	};
	let mut phase_rows = Vec::new();
	for (phase_index, phase) in phases.iter().enumerate() {
		let title = phase.name.as_str();
		let tasks = phase.tasks.as_slice();
		let done = tasks.iter().filter(|task| is_closed(task)).count();
		let heading = sf!("{}. {title}", roman_numeral(phase_index + 1));
		let folded = touched
			.as_ref()
			.is_some_and(|touched| !touched.contains(&phase.name));
		if folded {
			phase_rows.push(
				dom! { <row gap=2><text fg=muted bold>{heading}</text><text fg=muted>{sf!("{done}/{}", tasks.len())}</text></row> }
					.into_component(),
			);
			continue;
		}
		phase_rows.push(
			dom! { <row gap=2><text fg=accent>{heading}</text><text fg=muted>{sf!("{done}/{}", tasks.len())}</text></row> }
				.into_component(),
		);
		let (shown, summary) = if expanded {
			(tasks.iter().collect(), None)
		} else {
			select_collapsed(tasks, COLLAPSED_ITEMS)
		};
		let row_count = shown.len();
		for (task_index, task) in shown.into_iter().enumerate() {
			let text = task.content.clone();
			let is_completed = task.status == Status::Completed;
			let last = task_index + 1 == row_count && summary.is_none();
			let sweeping =
				is_completed && completion_sweeps(view, &completed, phase.name.as_str(), text.as_str());
			let blocked_note = (task.status == Status::Blocked).then(|| {
				task
					.blocker
					.as_ref()
					.filter(|text| !text.is_empty())
					.map_or_else(|| Str::new_static("(blocked)"), |blocker| sf!("(blocked: {blocker})"))
			});
			phase_rows.push(
				dom! {
					<row gap=1 pad-x=2>
						if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
						match task.status {
							Status::Completed => <i:checked fg=ok/>,
							Status::InProgress => <i:unchecked fg=accent/>,
							Status::Abandoned => <i:unchecked fg=err/>,
							Status::Blocked => <i:unchecked fg=warn/>,
							Status::Pending => <i:unchecked fg=muted/>,
						}
						if sweeping { <strike reveal={sweep.clone()} fg=ok>{text}</strike> }
						else {
							match task.status {
								Status::Completed => <text strike fg=ok>{text}</text>,
								Status::InProgress => <text fg=accent>{text}</text>,
								Status::Abandoned => <text strike fg=err>{text}</text>,
								Status::Blocked => <text fg=warn>{text}</text>,
								Status::Pending => <text fg=muted>{text}</text>,
							}
						}
						if let Some(note) = blocked_note { <text fg=warn>{note}</text> }
					</row>
				}
				.into_component(),
			);
		}
		if let Some(summary) = summary {
			phase_rows.push(
				dom! { <row gap=1 pad-x=2><i:tree-last/><text fg=muted>{summary}</text></row> }
					.into_component(),
			);
		}
	}
	dom! {
		<box border=round bc=border title_pad=3 pad="0 1">
			<row kind=title gap=1><i:todo fg=accent/><text fg=accent>{"Todo"}</text><text fg=muted>{sf!("{total} tasks")}</text></row>
			{phase_rows}
		</box>
	}
	.into_component()
}

fn render_failed(view: &CardView<'_>) -> Component {
	let fault = typed_fault::<omp_tools::todo::Fault>(view)
		.or_else(|| diag_text(view.diag))
		.unwrap_or_else(|| Str::new_static("operation failed"));
	dom! {
		<box border=round bc=err bg=error_surface bleed title_pad=3 pad="0 1">
			<row kind=title gap=1><i:error fg=err/><text fg=accent>{"Todo"}</text></row>
			<text pad-x=2 fg=err>{fault}</text>
		</box>
	}
	.into_component()
}

fn partial_string<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let marker = sf!("\"{key}\":\"");
	let start = json.find(marker.as_str())? + marker.len();
	let rest = &json[start..];
	Some(rest.split('"').next().unwrap_or(rest))
}

fn roman_numeral(mut index: usize) -> String {
	const DIGITS: &[(usize, &str)] = &[
		(1000, "M"),
		(900, "CM"),
		(500, "D"),
		(400, "CD"),
		(100, "C"),
		(90, "XC"),
		(50, "L"),
		(40, "XL"),
		(10, "X"),
		(9, "IX"),
		(5, "V"),
		(4, "IV"),
		(1, "I"),
	];
	let mut roman = String::new();
	for &(value, digit) in DIGITS {
		while index >= value {
			roman.push_str(digit);
			index -= value;
		}
	}
	roman
}

fn diag_text(node: Option<&Node>) -> Option<Str> {
	node.and_then(|node| {
		node.content.clone().or_else(|| {
			node
				.prop(&PropId::Text.into())
				.and_then(|value| value.as_str())
				.map(Str::new)
		})
	})
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use omp_core::Str;
	use omp_dom::{KnownTag, Node, PropId, Value};
	use omp_tui::{CellContent, Ui, UiContext, test_support::frame_row_text};

	use super::TodoCard;
	use crate::cards::{Card as _, CardStatus, CardView};

	const RESULT: &str = r#"{"op":"view","phases":[{"name":"Foundation","tasks":[{"content":"Scaffold crate","status":"completed"},{"content":"Wire workspace","status":"completed"}]}],"completed_tasks":[]}"#;

	fn text_node(tag: KnownTag, text: &'static str) -> Node {
		let mut props = smallvec::SmallVec::new();
		props.push((PropId::Text.into(), Value::Str(Str::new_static(text))));
		Node { tag: tag.into(), props, kids: Vec::new(), content: None }
	}

	/// Cell column of `needle` in a single-width row (`str::find` is bytes).
	fn column_of(row: &str, needle: &str) -> u16 {
		let at = row.find(needle).expect("task row");
		u16::try_from(row[..at].chars().count()).unwrap()
	}

	fn struck(ui: &Ui, row: u16, from: u16, len: u16) -> Vec<bool> {
		(from..from + len)
			.filter(|x| matches!(ui.frame().cell(*x, row).content(), CellContent::Grapheme { .. }))
			.map(|x| ui.frame().cell(x, row).style().spec().strikethrough)
			.collect()
	}

	#[test]
	fn todo_strike_reveals_progressively_then_settles() {
		let input = text_node(
			KnownTag::Input,
			r#"{"op":"done","phase":"Foundation","task":"Scaffold crate"}"#,
		);
		let result = text_node(KnownTag::Result, RESULT);
		let view = CardView {
			input:   &input,
			result:  Some(&result),
			diag:    None,
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::Done,
			output:  None,
			started: None,
		};
		let mut ui = Ui::from_root(
			TodoCard.render(&view, false, &UiContext::default()),
			40,
			UiContext::default(),
		);
		let row = frame_row_text(ui.frame(), 2);
		let at = column_of(&row, "Scaffold");
		let len = u16::try_from("Scaffold crate".len()).unwrap();
		// The task the op just completed starts plain and sweeps; the other
		// completed task was struck already and stays struck throughout.
		assert!(struck(&ui, 2, at, len).iter().all(|s| !s), "frame 0 holds plain: {row}");
		assert!(struck(&ui, 3, at, len).iter().all(|s| *s));
		assert_eq!(ui.next_wake(), Some(Duration::from_millis(65)));
		ui.tick(Duration::from_millis(455));
		let mid = struck(&ui, 2, at, len);
		let count = mid.iter().filter(|s| **s).count();
		assert!(count > 0 && count < usize::from(len), "mid-sweep: {count}");
		assert!(mid[..count].iter().all(|s| *s), "the strike grows from the start");
		ui.tick(Duration::from_millis(910));
		assert!(struck(&ui, 2, at, len).iter().all(|s| *s));
		assert_eq!(ui.next_wake(), None, "settled sweeps stop waking");
		assert_eq!(frame_row_text(ui.frame(), 2), row, "the text itself never changes");
	}

	#[test]
	fn phase_completion_animates_every_reported_transition() {
		let input = text_node(KnownTag::Input, r#"{"op":"done","phase":"Foundation"}"#);
		let result = text_node(
			KnownTag::Result,
			r#"{"op":"done","phases":[{"name":"Foundation","tasks":[{"content":"Scaffold crate","status":"completed"},{"content":"Wire workspace","status":"completed"}]}],"completed_tasks":[{"phase":"Foundation","content":"Scaffold crate"},{"phase":"Foundation","content":"Wire workspace"}]}"#,
		);
		let view = CardView {
			input:   &input,
			result:  Some(&result),
			diag:    None,
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::Done,
			output:  None,
			started: None,
		};
		let mut ui = Ui::from_root(
			TodoCard.render(&view, true, &UiContext::default()),
			40,
			UiContext::default(),
		);
		for (row, label) in [(2, "Scaffold crate"), (3, "Wire workspace")] {
			let at = column_of(&frame_row_text(ui.frame(), row), label);
			assert!(
				struck(&ui, row, at, u16::try_from(label.len()).unwrap())
					.iter()
					.all(|value| !*value)
			);
		}
		ui.tick(Duration::from_millis(910));
		for (row, label) in [(2, "Scaffold crate"), (3, "Wire workspace")] {
			let at = column_of(&frame_row_text(ui.frame(), row), label);
			assert!(
				struck(&ui, row, at, u16::try_from(label.len()).unwrap())
					.iter()
					.all(|value| *value)
			);
		}
	}

	#[test]
	fn todo_without_a_done_op_strikes_statically() {
		let input = text_node(KnownTag::Input, r#"{"op":"view"}"#);
		let result = text_node(KnownTag::Result, RESULT);
		let view = CardView {
			input:   &input,
			result:  Some(&result),
			diag:    None,
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::Done,
			output:  None,
			started: None,
		};
		let ui = Ui::from_root(
			TodoCard.render(&view, false, &UiContext::default()),
			40,
			UiContext::default(),
		);
		let at = column_of(&frame_row_text(ui.frame(), 2), "Scaffold");
		assert!(struck(&ui, 2, at, 14).iter().all(|s| *s));
		assert_eq!(ui.next_wake(), None);
	}
}
