//! Native ask, todo, and think renderers.

use omp_core::Str;
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::view::El;
use crate::{
	ask::{
		Answer as AskAnswer, Fault as AskFault, Payload as AskPayload, Question as AskQuestion,
		Update as AskUpdate,
	},
	gallery::RendererGalleryFixture,
	think::{Fault as ThinkFault, Payload as ThinkPayload, Update as ThinkUpdate},
	todo::{
		Fault as TodoFault, InitListEntry as TodoInitListEntry, Payload as TodoPayload,
		Phase as TodoPhase, Status as TodoStatus, Task as TodoTask, Update as TodoUpdate,
	},
	view,
};

#[derive(Default)]
pub(super) struct AskState {
	questions: Vec<AskQuestion>,
}

pub(super) struct AskRenderer;

impl RenderFold for AskRenderer {
	type Outcome = CallOutcome<AskPayload, AskFault>;
	type State = AskState;
	type Update = AskUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		let Some(questions) = args.get("questions").and_then(|value| value.as_array()) else {
			return;
		};
		state.questions.clear();
		state.questions.extend(
			questions
				.iter()
				.filter_map(|question| question.deserialize_into::<AskQuestion>().ok()),
		);
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None if state.questions.is_empty() => {
				Some(view! { <spinner color=accent label="Waiting for answers"/> }.into())
			},
			None => Some(render_ask(&state.questions, None).into()),
			Some(CallOutcome::Ok(payload)) => {
				let rendered = if state.questions.is_empty() {
					render_durable_ask(&payload.answers)
				} else {
					render_ask(&state.questions, Some(&payload.answers))
				};
				Some(rendered.into())
			},
			Some(CallOutcome::Faulted(fault)) => {
				let message = match fault {
					AskFault::Invalid { message } | AskFault::Presenter { message } => message.as_str(),
					AskFault::Cancelled { message } => message.as_str(),
					AskFault::RequiresInteractive => "Ask tool requires interactive mode",
					AskFault::InvalidPresentation => {
						"Ask presenter returned selections that do not match the questions"
					},
				};
				Some(render_fault(message).into())
			},
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct TodoState {
	op:     Option<Str>,
	phases: Vec<TodoPhase>,
}

pub(super) struct TodoRenderer;

impl RenderFold for TodoRenderer {
	type Outcome = CallOutcome<TodoPayload, TodoFault>;
	type State = TodoState;
	type Update = TodoUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(op) = args.get("op").and_then(|value| value.as_str()) {
			state.op = Some(Str::new(op));
		}
		if let Some(phases) = args.get("list").and_then(|value| value.as_array()) {
			state.phases.clear();
			state.phases.extend(phases.iter().filter_map(|phase| {
				let phase = phase.deserialize_into::<TodoInitListEntry>().ok()?;
				Some(TodoPhase {
					name:  phase.phase,
					tasks: phase
						.items
						.into_iter()
						.map(|content| TodoTask { content, status: TodoStatus::Pending, blocker: None })
						.collect(),
				})
			}));
		} else if let Some(items) = args.get("items").and_then(|value| value.as_array()) {
			let phase = args
				.get("phase")
				.and_then(|value| value.as_str())
				.unwrap_or("Todos");
			state.phases.clear();
			state.phases.push(TodoPhase {
				name:  Str::new(phase),
				tasks: items
					.iter()
					.filter_map(|item| item.as_str())
					.map(|content| TodoTask {
						content: Str::new(content),
						status:  TodoStatus::Pending,
						blocker: None,
					})
					.collect(),
			});
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None if !state.phases.is_empty() => Some(render_todo_phases(&state.phases).into()),
			None => Some(render_todo_live(state.op.as_deref()).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_todo(payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_todo_fault(fault).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct ThinkState {
	thoughts: Option<Str>,
}

pub(super) struct ThinkRenderer;

impl RenderFold for ThinkRenderer {
	type Outcome = CallOutcome<ThinkPayload, ThinkFault>;
	type State = ThinkState;
	type Update = ThinkUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(thoughts) = args.get("thoughts").and_then(|value| value.as_str()) {
			state.thoughts = Some(Str::new(thoughts));
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => state
				.thoughts
				.as_deref()
				.map(|thoughts| render_thought(thoughts).into())
				.or_else(|| Some(view! { <spinner color=muted label="Recording thought"/> }.into())),
			Some(CallOutcome::Ok(_)) => state
				.thoughts
				.as_deref()
				.map(|thoughts| render_thought(thoughts).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_fault(fault.message()).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}
fn render_ask(questions: &[AskQuestion], answers: Option<&[AskAnswer]>) -> El {
	view! {
		<col gap=1>
			for question in questions {
				{render_question(question, answers)}
			}
		</col>
	}
}

fn render_durable_ask(answers: &[AskAnswer]) -> El {
	view! {
		<col gap=1>
			for answer in answers {
				<col gap=0>
					<row sep=" · ">
						<fact label="ID">{&answer.id}</fact>
						<fact label="Options"><num value={answer.options.len()} compact/></fact>
						if answer.multi { <fact label="Mode">{"multiple"}</fact> }
					</row>
					<text bold wrap="word">{&answer.question}</text>
					for option in &answer.options {
						<choice
							multi={answer.multi}
							selected={answer.selected.contains(option)}
						>
							{option}
						</choice>
					}
					{render_written_answer(answer)}
				</col>
			}
		</col>
	}
}

fn render_question(question: &AskQuestion, answers: Option<&[AskAnswer]>) -> El {
	let answer = answers.and_then(|items| items.iter().find(|item| item.id == question.id));
	view! {
		<col gap=0>
			<row sep=" · ">
				<fact label="ID">{&question.id}</fact>
				<fact label="Options"><num value={question.options.len()} compact/></fact>
				if question.multi { <fact label="Mode">{"multiple"}</fact> }
			</row>
			<text bold wrap="word">{&question.question}</text>
			for option in &question.options {
				<choice
					multi={question.multi}
					selected={answer.is_some_and(|item| item.selected.iter().any(|label| label == &option.label))}
				>
					{&option.label}
				</choice>
				if let Some(description) = option.description.as_deref()
					&& !description.trim().is_empty()
				{
					<text fg=muted wrap="word">{description}</text>
				}
			}
			if let Some(answer) = answer {
				for selected in &answer.selected {
					if !question.options.iter().any(|option| option.label == *selected) {
						<choice multi={question.multi} selected>{selected}</choice>
					}
				}
				{render_written_answer(answer)}
			}
		</col>
	}
}

fn render_written_answer(answer: &AskAnswer) -> El {
	view! {
		<col gap=0>
			if let Some(custom) = &answer.custom_input {
				<fact label="Other">{custom}</fact>
			}
			if let Some(note) = &answer.note {
				<fact label="Note">{note}</fact>
			}
			if answer.timed_out {
				<text fg=muted>{"auto-selected after timeout — not a user choice"}</text>
			}
		</col>
	}
}

fn render_todo(payload: &TodoPayload) -> El {
	render_todo_phases(&payload.phases)
}

fn render_todo_phases(phases: &[TodoPhase]) -> El {
	view! {
		<todo guides="round" numbering="roman">
			for phase in phases {
				<task label={&phase.name}>
					for task in &phase.tasks {
						{render_todo_task(task)}
					}
				</task>
			}
		</todo>
	}
}

fn render_todo_task(task: &TodoTask) -> El {
	if task.status == TodoStatus::Blocked
		&& let Some(blocker) = task.blocker.as_deref()
	{
		view! {
			<task status={task.status.as_ref()} desc={blocker}>{&task.content}</task>
		}
	} else {
		view! {
			<task status={task.status.as_ref()}>{&task.content}</task>
		}
	}
}

fn render_todo_live(op: Option<&str>) -> El {
	let Some(op) = op else {
		return view! { <spinner color=accent label="Updating task list"/> };
	};
	view! {
		<row sep=" · ">
			<spinner color=accent label="Updating task list"/>
			<fact label="Operation">{op}</fact>
		</row>
	}
}

fn render_todo_fault(fault: &TodoFault) -> El {
	render_fault(&fault.to_string())
}

fn render_fault(message: &str) -> El {
	view! { <callout kind="error">{message}</callout> }
}

fn render_thought(thoughts: &str) -> El {
	view! { <text fg=muted dim italic wrap="word">{thoughts}</text> }
}
/// Native ask, todo, and think renderer lifecycle fixtures for the visual QA
/// gallery.
pub fn gallery_fixtures(
	ask: ToolIdentity,
	todo: ToolIdentity,
	think: ToolIdentity,
) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: ask,
			streaming_args: r#"{"questions":[{"id":"db","question":"Which database should the new service use?","options":[{"label":"Postgres","description":"Relational, strong consistency, JSONB support"},{"label":"SQLite","description":"Embedded, zero-ops, great for single-node"},{"label":"MongoDB","description":"Document store, flexible schema"}],"recommended":0},{"id":"features","question":"Which auth flows should sh"#,
			args: r#"{"questions":[{"id":"db","question":"Which database should the new service use?","options":[{"label":"Postgres","description":"Relational, strong consistency, JSONB support"},{"label":"SQLite","description":"Embedded, zero-ops, great for single-node"},{"label":"MongoDB","description":"Document store, flexible schema"}],"recommended":0},{"id":"features","question":"Which auth flows should ship in v1?","options":[{"label":"Email + password"},{"label":"OAuth (Google, GitHub)"},{"label":"Magic links"},{"label":"SAML SSO","description":"Enterprise; can be deferred"}],"multi":true}]}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"answers":[{"id":"db","question":"Which database should the new service use?","options":["Postgres","SQLite","MongoDB"],"multi":false,"selected":["Postgres"],"timed_out":false},{"id":"features","question":"Which auth flows should ship in v1?","options":["Email + password","OAuth (Google, GitHub)","Magic links","SAML SSO"],"multi":true,"selected":["Email + password","OAuth (Google, GitHub)"],"customInput":"Custom <flow>","timed_out":false}]}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"presenter","message":"Prompt cancelled by user before any answer was given"}}"#,
		},
		RendererGalleryFixture {
			identity: todo,
			streaming_args: r#"{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Au"#,
			args: r#"{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]}]}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"op":"init","phases":[{"name":"Foundation","tasks":[{"content":"Scaffold crate","status":"completed"},{"content":"Wire workspace","status":"in_progress"}]},{"name":"Auth","tasks":[{"content":"Port credential store","status":"pending"},{"content":"Wire OAuth providers","status":"pending"}]}],"completed_tasks":[{"phase":"Foundation","content":"Scaffold crate"}]}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"phase_not_found","name":"Auth"}}"#,
		},
		RendererGalleryFixture {
			identity: think,
			streaming_args: r#"{"thoughts":"The retry loop re-reads the config after every failure, which explains the doubled lat"#,
			args: r#"{"thoughts":"The retry loop re-reads the config after every failure, which explains the doubled latency. Cache the parsed config outside the loop, then re-check the invalidation path."}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"recorded":true}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"thoughts must not be empty"}}"#,
		},
	]
}
#[cfg(test)]
mod tests {
	use omp_tool::Rev;

	use super::*;

	fn identity(name: &'static str) -> ToolIdentity {
		ToolIdentity { name: Str::new_static(name), rev: Rev { family: Str::new_static(""), n: 1 } }
	}

	#[test]
	fn fixtures_decode_and_render_rich_lifecycle_states() {
		let fixtures = gallery_fixtures(identity("ask"), identity("todo"), identity("think"));

		let ask_outcome =
			serde_json::from_slice::<CallOutcome<AskPayload, AskFault>>(fixtures[0].success_outcome)
				.expect("ask outcome decodes");
		let ask_fault =
			serde_json::from_slice::<CallOutcome<AskPayload, AskFault>>(fixtures[0].error_outcome)
				.expect("ask fault decodes");
		let mut ask_state = AskState::default();
		let streaming = omp_core::slopjson::parse_streaming(fixtures[0].streaming_args);
		AskRenderer.fold_args(&mut ask_state, &streaming, false);
		let live = AskRenderer
			.view(&ask_state, None)
			.expect("ask live view renders");
		assert!(live.contains("<row sep=\" · \"><fact label=ID>db</fact>"));
		assert!(live.contains("<fact label=Options><num value=3 compact/></fact>"));
		assert!(live.contains("<choice>Postgres</choice>"));
		assert!(live.contains("Relational, strong consistency, JSONB support"));
		assert!(!live.contains('↳'));
		let committed = omp_core::slopjson::parse(fixtures[0].args).expect("ask args decode");
		AskRenderer.fold_args(&mut ask_state, &committed, true);
		let success = AskRenderer
			.view(&ask_state, Some(&ask_outcome))
			.expect("ask success renders");
		assert!(success.contains("<choice selected>Postgres</choice>"));
		assert!(success.contains("<choice multi selected>Email + password</choice>"));
		assert!(success.contains("<fact label=Other>Custom &lt;flow&gt;</fact>"));
		assert!(success.contains("Relational, strong consistency, JSONB support"));
		assert!(!success.contains('●'));
		assert!(!success.contains('○'));
		assert!(
			AskRenderer
				.view(&ask_state, Some(&ask_fault))
				.expect("ask fault renders")
				.as_str()
				== "<callout kind=error>Prompt cancelled by user before any answer was given</callout>"
		);

		let todo_outcome =
			serde_json::from_slice::<CallOutcome<TodoPayload, TodoFault>>(fixtures[1].success_outcome)
				.expect("todo outcome decodes");
		let todo_fault =
			serde_json::from_slice::<CallOutcome<TodoPayload, TodoFault>>(fixtures[1].error_outcome)
				.expect("todo fault decodes");
		let mut todo_state = TodoState::default();
		let streaming = omp_core::slopjson::parse_streaming(fixtures[1].streaming_args);
		TodoRenderer.fold_args(&mut todo_state, &streaming, false);
		let live = TodoRenderer
			.view(&todo_state, None)
			.expect("todo live view renders");
		assert!(live.contains("label=Foundation"));
		assert!(live.contains("<todo guides=round numbering=roman>"));
		let committed = omp_core::slopjson::parse(fixtures[1].args).expect("todo args decode");
		TodoRenderer.fold_args(&mut todo_state, &committed, true);
		let todo = TodoRenderer
			.view(&todo_state, Some(&todo_outcome))
			.expect("todo success renders");
		assert!(todo.contains("label=Foundation"));
		assert!(todo.contains("status=completed"));
		assert!(todo.contains("label=Auth"));
		assert_eq!(
			TodoRenderer
				.view(&todo_state, Some(&todo_fault))
				.expect("todo fault renders")
				.as_str(),
			"<callout kind=error>Phase \"Auth\" not found</callout>",
		);

		let think_outcome = serde_json::from_slice::<CallOutcome<ThinkPayload, ThinkFault>>(
			fixtures[2].success_outcome,
		)
		.expect("think outcome decodes");
		let think_fault =
			serde_json::from_slice::<CallOutcome<ThinkPayload, ThinkFault>>(fixtures[2].error_outcome)
				.expect("think fault decodes");
		let mut think_state = ThinkState::default();
		let streaming = omp_core::slopjson::parse_streaming(fixtures[2].streaming_args);
		ThinkRenderer.fold_args(&mut think_state, &streaming, false);
		let live = ThinkRenderer
			.view(&think_state, None)
			.expect("think live view renders");
		assert!(live.starts_with("<text fg=muted dim italic"));
		assert!(live.contains("doubled lat"));
		let committed = omp_core::slopjson::parse(fixtures[2].args).expect("think args decode");
		ThinkRenderer.fold_args(&mut think_state, &committed, true);
		let success = ThinkRenderer
			.view(&think_state, Some(&think_outcome))
			.expect("think success renders");
		assert!(success.contains("Cache the parsed config outside the loop"));
		assert_eq!(
			ThinkRenderer
				.view(&think_state, Some(&think_fault))
				.expect("think fault renders")
				.as_str(),
			"<callout kind=error>thoughts must not be empty</callout>",
		);
	}

	#[test]
	fn user_text_is_escaped_in_every_renderer() {
		let thought = render_thought("<retry & inspect>");
		assert_eq!(
			thought.to_tml().as_str(),
			"<text fg=muted dim italic wrap=word>&lt;retry &amp; inspect&gt;</text>",
		);

		let todo = TodoPayload {
			op:              crate::todo::Op::View,
			phases:          vec![crate::todo::Phase {
				name:  Str::new("Build \"core\""),
				tasks: vec![crate::todo::Task {
					content: Str::new("<compile>"),
					status:  TodoStatus::Blocked,
					blocker: Some(Str::new("CI & review")),
				}],
			}],
			completed_tasks: Vec::new(),
		};
		let rendered = render_todo(&todo).to_tml();
		assert!(rendered.contains("label=\"Build &quot;core&quot;\""));
		assert!(rendered.contains("<todo guides=round numbering=roman>"));
		assert!(rendered.contains("desc=\"CI &amp; review\""));
		assert!(rendered.contains("&lt;compile&gt;"));
		assert!(!rendered.contains("Ⅰ"));
		assert!(!rendered.contains("Ⅱ"));

		let live = render_todo_live(Some("<replace>"));
		assert_eq!(
			live.to_tml().as_str(),
			"<row sep=\" · \"><spinner color=accent label=\"Updating task list\"/><fact \
			 label=Operation>&lt;replace&gt;</fact></row>",
		);
	}

	#[test]
	fn fault_callouts_escape_tool_messages() {
		let fault = AskFault::Invalid { message: Str::new("<invalid & cancelled>") };
		let rendered = AskRenderer
			.view(&AskState::default(), Some(&CallOutcome::Faulted(fault)))
			.expect("ask fault renders");
		assert_eq!(
			rendered.as_str(),
			"<callout kind=error>&lt;invalid &amp; cancelled&gt;</callout>",
		);
	}
}
