//! Journal-derived `goal@1` execution over `<meta><directors>`.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_agent::{
	DirectorRegistry, DirectorStack, SessionTool, SessionToolCx, SessionToolError,
	SessionToolFuture, director_status, find_director, state_bool, state_int, state_str,
};
use omp_core::{Str, sf};
use omp_dom::{Op, PropKey, Txn, Value};
use omp_tool::{Abort, CallOutcome, Part, ToolSpec};
use omp_tools::goal::{self, Operation, Status};

const FAMILY: &str = "goal";

/// Session-owned Goal reducer. The immutable declaration lives here; goal
/// state and every transition live only in the journal-derived Director node.
pub struct GoalSessionTool {
	spec: ToolSpec,
}

impl GoalSessionTool {
	/// Creates the canonical journal-derived Goal executor.
	#[must_use]
	pub fn new() -> Self {
		Self { spec: goal::spec() }
	}
}

impl Default for GoalSessionTool {
	fn default() -> Self {
		Self::new()
	}
}

impl SessionTool for GoalSessionTool {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn project(
		&self,
		outcome: &CallOutcome<Box<serde_json::value::RawValue>, Box<serde_json::value::RawValue>>,
	) -> Result<Vec<Part>, SessionToolError> {
		let text = match outcome {
			CallOutcome::Ok(raw) => {
				let payload: goal::Payload = serde_json::from_str(raw.get())?;
				Some(goal::model_output(Ok(&payload)))
			},
			CallOutcome::Faulted(raw) => {
				let fault: goal::Fault = serde_json::from_str(raw.get())?;
				Some(goal::model_output(Err(&fault)))
			},
			CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => None,
		};
		Ok(text.map_or_else(Vec::new, |text| vec![Part::Text { text }]))
	}

	fn call<'a>(
		&'a self,
		cx: SessionToolCx<'a>,
		args: Box<serde_json::value::RawValue>,
	) -> SessionToolFuture<'a> {
		Box::pin(async move {
			let mut raw: serde_json::Value = serde_json::from_str(args.get())?;
			if let Some(object) = raw.as_object_mut() {
				object.remove("i");
				object.remove("notrunc");
			}
			let params: goal::Params = match serde_json::from_value(raw) {
				Ok(params) => params,
				Err(_) => {
					return Ok(CallOutcome::ArgsRejected(omp_tool::ArgIssue {
						path:     Vec::new(),
						expected: sf!("a valid goal operation"),
						kind:     omp_tool::ArgIssueKind::Malformed,
						example:  Some(sf!(r#"{{"op":"get"}}"#)),
						found:    None,
					}));
				},
			};
			if params.token_budget == Some(0) {
				return fault(goal::Fault::InvalidBudget);
			}
			if params.op == Operation::Create
				&& params
					.objective
					.as_ref()
					.is_none_or(|value| value.trim().is_empty())
			{
				return fault(goal::Fault::ObjectiveRequired);
			}
			if cx.cancel.is_cancelled() {
				return Ok(CallOutcome::aborted(Abort::Skipped {
					reason: Str::new_static("goal operation cancelled before its atomic commit"),
				}));
			}

			let op = params.op;
			let registry = DirectorRegistry::standard();
			let mut stack = DirectorStack::from_dom(cx.session.dom(), &registry);
			let mut existing = find_director(cx.session.dom(), FAMILY).map(|(handle, _)| handle);
			if op != Operation::Create && existing.is_some() {
				account_current_turn(cx.session, cx.call)?;
				existing = find_director(cx.session.dom(), FAMILY).map(|(handle, _)| handle);
			}
			match op {
				Operation::Create => {
					if existing.is_some() {
						return fault(goal::Fault::InvalidTransition);
					}
					stack.engage(
						cx.session,
						Box::new(omp_agent::directors::goal::Goal::new(
							params.objective.expect("validated objective"),
							params.token_budget,
						)),
					)?;
					// Goal accounting begins at creation, not at the request
					// that led the model to create it.
					if let (Some((handle, _)), Some(turn)) =
						(find_director(cx.session.dom(), FAMILY), cx.session.dom().parent(cx.call))
					{
						let baseline = omp_agent::turn_tokens(cx.session.dom(), turn);
						patch_state(cx.session, handle, [
							(
								"state/accounted_turn",
								Value::Int(i64::try_from(turn.get()).unwrap_or(i64::MAX)),
							),
							(
								"state/accounted_turn_tokens",
								Value::Int(i64::try_from(baseline).unwrap_or(i64::MAX)),
							),
						])?;
					}
				},
				Operation::Get => {},
				Operation::Complete => {
					let Some(handle) = existing else {
						return fault(goal::Fault::NoGoal);
					};
					patch_state(cx.session, handle, [
						("state/done", Value::Bool(true)),
						("state/continuation_armed", Value::Bool(false)),
						("state/updated_at_ms", Value::Int(i64::try_from(now_ms()).unwrap_or(i64::MAX))),
					])?;
				},
				Operation::Resume => {
					let Some((_, node)) = find_director(cx.session.dom(), FAMILY) else {
						return fault(goal::Fault::NoGoal);
					};
					if director_status(node) != Some("paused") {
						return fault(goal::Fault::InvalidTransition);
					}
					if !stack.resume(cx.session, FAMILY)? {
						return fault(goal::Fault::InvalidTransition);
					}
					set_armed(cx.session, true)?;
				},
				Operation::Drop => {
					let Some(handle) = existing else {
						return fault(goal::Fault::NoGoal);
					};
					patch_state(cx.session, handle, [
						("state/dropped", Value::Bool(true)),
						("state/continuation_armed", Value::Bool(false)),
						("state/updated_at_ms", Value::Int(i64::try_from(now_ms()).unwrap_or(i64::MAX))),
					])?;
				},
			}
			let projection = project(cx.session.dom());
			let remaining_tokens = projection.as_ref().and_then(|goal| {
				goal
					.token_budget
					.map(|budget| budget.saturating_sub(goal.tokens_used))
			});
			let completion_report = (op == Operation::Complete)
				.then(|| projection.as_ref())
				.flatten()
				.map(completion_report);
			let payload = goal::Payload { op, goal: projection, remaining_tokens, completion_report };
			Ok(CallOutcome::Ok(serde_json::value::to_raw_value(&payload)?))
		})
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn account_current_turn(
	session: &mut omp_session::Session,
	call: omp_dom::Handle,
) -> Result<(), omp_session::SessionError> {
	let Some(turn) = session.dom().parent(call) else {
		return Ok(());
	};
	let Some((handle, node)) = find_director(session.dom(), FAMILY) else {
		return Ok(());
	};
	let total = omp_agent::turn_tokens(session.dom(), turn);
	let previous = if state_int(node, "accounted_turn").and_then(|value| u64::try_from(value).ok())
		== Some(turn.get())
	{
		state_int(node, "accounted_turn_tokens")
			.and_then(|value| u64::try_from(value).ok())
			.unwrap_or(0)
	} else {
		0
	};
	let used = state_int(node, "tokens_used")
		.and_then(|value| u64::try_from(value).ok())
		.unwrap_or(0)
		.saturating_add(total.saturating_sub(previous));
	patch_state(session, handle, [
		("state/tokens_used", Value::Int(i64::try_from(used).unwrap_or(i64::MAX))),
		("state/accounted_turn", Value::Int(i64::try_from(turn.get()).unwrap_or(i64::MAX))),
		("state/accounted_turn_tokens", Value::Int(i64::try_from(total).unwrap_or(i64::MAX))),
		("state/updated_at_ms", Value::Int(i64::try_from(now_ms()).unwrap_or(i64::MAX))),
	])
}

/// Durably changes whether the interactive idle boundary may start another
/// hidden Goal turn.
pub fn set_armed(
	session: &mut omp_session::Session,
	armed: bool,
) -> Result<bool, omp_session::SessionError> {
	let Some((handle, node)) = find_director(session.dom(), FAMILY) else {
		return Ok(false);
	};
	if state_bool(node, "continuation_armed") == Some(armed) {
		return Ok(false);
	}
	patch_state(session, handle, [("state/continuation_armed", Value::Bool(armed))])?;
	Ok(true)
}

/// Reconstructs the public typed Goal projection from the selected branch.
#[must_use]
pub fn project(dom: &omp_dom::Dom) -> Option<goal::Goal> {
	let (_, node) = find_director(dom, FAMILY)?;
	let tokens_used = state_int(node, "tokens_used")
		.and_then(|value| u64::try_from(value).ok())
		.unwrap_or(0);
	let token_budget = state_int(node, "token_budget").and_then(|value| u64::try_from(value).ok());
	let status = if state_bool(node, "dropped").unwrap_or(false) {
		Status::Dropped
	} else if state_bool(node, "done").unwrap_or(false) {
		Status::Complete
	} else if director_status(node) == Some("paused") {
		Status::Paused
	} else if token_budget.is_some_and(|budget| tokens_used >= budget) {
		Status::BudgetLimited
	} else {
		Status::Active
	};
	Some(goal::Goal {
		id: state_str(node, "id").unwrap_or_default(),
		objective: state_str(node, "objective").unwrap_or_default(),
		status,
		token_budget,
		tokens_used,
		time_used_secs: state_int(node, "time_used_secs")
			.and_then(|value| u64::try_from(value).ok())
			.unwrap_or(0),
		created_at_ms: state_int(node, "created_at_ms")
			.and_then(|value| u64::try_from(value).ok())
			.unwrap_or(0),
		updated_at_ms: state_int(node, "updated_at_ms")
			.and_then(|value| u64::try_from(value).ok())
			.unwrap_or(0),
	})
}

fn patch_state<const N: usize>(
	session: &mut omp_session::Session,
	handle: omp_dom::Handle,
	updates: [(&'static str, Value); N],
) -> Result<(), omp_session::SessionError> {
	let cause = session
		.head()
		.ok_or(omp_session::SessionError::NoActiveTurn)?;
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("goal.state")),
		ops: updates
			.into_iter()
			.map(|(prop, value)| Op::Set {
				h: handle,
				prop: PropKey::Custom(Str::new_static(prop)),
				value,
			})
			.collect(),
	})?;
	Ok(())
}

fn completion_report(goal: &goal::Goal) -> Str {
	let mut report = sf!(
		"Goal achieved. Report final budget usage to the user: tokens used: {}",
		goal.tokens_used
	);
	if let Some(budget) = goal.token_budget {
		report = sf!("{report} of {budget}");
	}
	if goal.time_used_secs > 0 {
		report = sf!("{report}; time used: {} seconds", goal.time_used_secs);
	}
	sf!("{report}.")
}

fn fault(
	fault: goal::Fault,
) -> Result<
	CallOutcome<Box<serde_json::value::RawValue>, Box<serde_json::value::RawValue>>,
	SessionToolError,
> {
	Ok(CallOutcome::Faulted(serde_json::value::to_raw_value(&fault)?))
}
