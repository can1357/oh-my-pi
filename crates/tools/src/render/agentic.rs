//! Native goal lifecycle renderer.

use std::time::Duration;

use omp_core::Str;
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::{fault_view, view::El};
use crate::{
	gallery::RendererGalleryFixture,
	goal::{Fault as GoalFault, Payload as GoalPayload, Update as GoalUpdate},
	view,
};

#[derive(Default)]
pub(super) struct GoalState {
	op:        Option<crate::goal::Operation>,
	objective: Option<Str>,
}

pub(super) struct GoalRenderer;

impl RenderFold for GoalRenderer {
	type Outcome = CallOutcome<GoalPayload, GoalFault>;
	type State = GoalState;
	type Update = GoalUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		state.op = args
			.get("op")
			.and_then(omp_core::slopjson::Value::as_str)
			.and_then(|value| value.parse().ok());
		state.objective = args
			.get("objective")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::from);
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_goal_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_goal_payload(payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(fault_view("goal", &fault.to_string()).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn render_goal_live(state: &GoalState) -> El {
	let objective = state
		.objective
		.as_ref()
		.map(|value| value.as_str().trim())
		.filter(|value| !value.is_empty())
		.map(|value| value.lines().next().unwrap_or_default());
	view! {
		<row sep=" · ">
			<text bold>
				if let Some(op) = state.op {
					{<&'static str>::from(op)}
				} else {
					{"waiting"}
				}
			</text>
			if let Some(objective) = objective {
				<row sep="">
					<text fg=muted italic>{"\""}</text>
					<text fg=muted italic max-chars=88 truncate-from="end">{objective}</text>
					<text fg=muted italic>{"\""}</text>
				</row>
			}
		</row>
	}
}

fn render_goal_payload(payload: &GoalPayload) -> El {
	let Some(goal) = payload.goal.as_ref() else {
		return view! {
			<row sep=" · ">
				<text bold>{<&'static str>::from(payload.op)}</text>
				<text fg=muted>{"No active goal"}</text>
			</row>
		};
	};
	let remaining_tokens = goal.token_budget.map(|budget| {
		payload
			.remaining_tokens
			.unwrap_or_else(|| budget.saturating_sub(goal.tokens_used))
	});

	view! {
		<col gap=1>
			<box border=round bc=border pad="0 1">
				<row sep="">
					<text italic>{"\""}</text>
					<text italic max-chars=180 truncate-from="end">{goal.objective.as_str().trim()}</text>
					<text italic>{"\""}</text>
				</row>
			</box>
			<row fg=muted sep=" · ">
				<row sep="">
					<num value={goal.tokens_used} compact/>
					if let Some(budget) = goal.token_budget {
						<text>{" / "}</text>
						<num value={budget} compact/>
						<text>{" tokens ("}</text>
						<num value={remaining_tokens.expect("budget produces remaining tokens")} compact/>
						<text>{" left)"}</text>
					} else {
						<text>{" tokens"}</text>
					}
				</row>
				if goal.time_used_secs > 0 {
					<row sep="">
						<time ms={Duration::from_secs(goal.time_used_secs)} kind="duration"/>
						<text>{" elapsed"}</text>
					</row>
				}
			</row>
			if let Some(report) = payload.completion_report.as_ref() {
				<text fg=muted>{report}</text>
			}
		</col>
	}
}

/// Native goal renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(goal: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![RendererGalleryFixture {
		identity: goal,
		streaming_args: r#"{"op":"create","objective":"Ship the auth hardening pass: per-account rate"#,
		args: r#"{"op":"create","objective":"Ship the auth hardening pass: per-account rate limits and sliding session expiry.","token_budget":500000}"#,
		progress_update: None,
		success_outcome: br#"{"kind":"ok","value":{"op":"create","goal":{"id":"goal_8f2a","objective":"Ship the auth hardening pass: per-account rate limits and sliding session expiry.","status":"active","token_budget":500000,"tokens_used":48200,"time_used_secs":312,"created_at_ms":1749200000000,"updated_at_ms":1749200312000},"remaining_tokens":451800,"completion_report":null}}"#,
		error_outcome: br#"{"kind":"faulted","value":{"kind":"objective_required"}}"#,
	}]
}

#[cfg(test)]
mod tests {
	use omp_tool::Rev;

	use super::*;
	use crate::goal::{Goal, Operation, Status};

	#[test]
	fn fixture_wire_shapes_decode() {
		let identity =
			ToolIdentity { name: Str::new_static("goal"), rev: Rev { family: Str::default(), n: 1 } };
		let fixture = gallery_fixtures(identity).pop().expect("goal fixture");
		assert!(fixture.progress_update.is_none());
		let args = omp_core::slopjson::parse_streaming(fixture.streaming_args);
		let mut state = GoalState::default();
		GoalRenderer.fold_args(&mut state, &args, false);
		assert!(
			GoalRenderer
				.view(&state, None)
				.expect("streaming view")
				.contains("auth hardening")
		);
		serde_json::from_slice::<CallOutcome<GoalPayload, GoalFault>>(fixture.success_outcome)
			.expect("success outcome decodes");
		serde_json::from_slice::<CallOutcome<GoalPayload, GoalFault>>(fixture.error_outcome)
			.expect("error outcome decodes");
	}

	#[test]
	fn budgeted_goal_renders_semantic_objective_counts_and_elapsed_time() {
		let outcome = CallOutcome::Ok(GoalPayload {
			op:                Operation::Create,
			goal:              Some(Goal {
				id:             Str::new_static("goal_8f2a"),
				objective:      Str::new_static("Ship the <auth> hardening pass"),
				status:         Status::Active,
				token_budget:   Some(500_000),
				tokens_used:    48_200,
				time_used_secs: 312,
				created_at_ms:  0,
				updated_at_ms:  0,
			}),
			remaining_tokens:  Some(451_800),
			completion_report: None,
		});
		let rendered = GoalRenderer
			.view(&GoalState::default(), Some(&outcome))
			.expect("goal renders");
		assert!(rendered.contains(
			"<text italic max-chars=180 truncate-from=end>Ship the &lt;auth&gt; hardening \
			 pass</text><text italic>\"</text>",
		));
		assert!(rendered.contains("<num value=48200 compact/>"));
		assert!(rendered.contains("<num value=500000 compact/>"));
		assert!(rendered.contains("<num value=451800 compact/>"));
		assert!(rendered.contains("<time ms=312000 kind=duration/>"));
		assert!(rendered.contains("<row fg=muted sep=\" · \">"));
		assert!(!rendered.contains("48K"));
		assert!(!rendered.contains("5m12s"));
	}

	#[test]
	fn unbudgeted_goal_and_completion_report_preserve_facts() {
		let outcome = CallOutcome::Ok(GoalPayload {
			op:                Operation::Complete,
			goal:              Some(Goal {
				id:             Str::new_static("goal_8f2a"),
				objective:      Str::new_static("Finish migration"),
				status:         Status::Complete,
				token_budget:   None,
				tokens_used:    987,
				time_used_secs: 0,
				created_at_ms:  0,
				updated_at_ms:  0,
			}),
			remaining_tokens:  None,
			completion_report: Some(Str::new_static("Shipped <all> renderers & fixtures")),
		});
		let rendered = GoalRenderer
			.view(&GoalState::default(), Some(&outcome))
			.expect("goal renders");
		assert!(rendered.contains("<num value=987 compact/><text> tokens</text>"));
		assert!(!rendered.contains("<time "));
		assert!(rendered.contains("Shipped &lt;all&gt; renderers &amp; fixtures"));
	}

	#[test]
	fn no_active_goal_preserves_operation_and_status() {
		let outcome = CallOutcome::Ok(GoalPayload {
			op:                Operation::Get,
			goal:              None,
			remaining_tokens:  None,
			completion_report: None,
		});
		let rendered = GoalRenderer
			.view(&GoalState::default(), Some(&outcome))
			.expect("goal renders");
		assert_eq!(
			rendered.as_str(),
			"<row sep=\" · \"><text bold>get</text><text fg=muted>No active goal</text></row>",
		);
	}

	#[test]
	fn live_objective_is_semantically_bounded_and_escaped() {
		let mut state = GoalState::default();
		let args = omp_core::slopjson::parse_streaming(
			"{\"op\":\"create\",\"objective\":\"Harden <session> & cookie validation while rotating \
			 every signing key without interrupting active requests END\\nsecond line\"",
		);
		GoalRenderer.fold_args(&mut state, &args, false);
		let rendered = GoalRenderer.view(&state, None).expect("live goal renders");
		assert!(rendered.starts_with("<row sep=\" · \"><text bold>create</text>"));
		assert!(rendered.contains(
			"<text fg=muted italic max-chars=88 truncate-from=end>Harden &lt;session&gt; &amp; \
			 cookie validation while rotating every signing key without interrupting active requests \
			 END</text>",
		));
		assert!(!rendered.contains("second line"));
	}

	#[test]
	fn live_without_parsed_args_renders_waiting() {
		let rendered = GoalRenderer
			.view(&GoalState::default(), None)
			.expect("live goal renders");
		assert_eq!(rendered.as_str(), "<row sep=\" · \"><text bold>waiting</text></row>",);
	}
}
