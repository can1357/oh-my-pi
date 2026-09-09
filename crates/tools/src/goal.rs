//! Hidden goal lifecycle tool over application-owned regime control.

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, StrMut, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Effects, Ev, IncomingParams, ParamError,
	Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Goal operation exposed to an active or explicitly eligible goal session.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Operation {
	/// Create or replace the eligible goal.
	Create,
	/// Read the latest durable projection.
	Get,
	/// Mark the goal complete.
	Complete,
	/// Resume a paused or dropped goal.
	Resume,
	/// Abandon the current goal record.
	Drop,
}

/// Arguments accepted by `goal@1`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Goal operation.
	pub op:           Operation,
	/// Required non-empty objective for `create`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub objective:    Option<Str>,
	/// Optional positive hard token budget for `create`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub token_budget: Option<u64>,
}

/// Durable goal lifecycle state.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Status {
	/// Eligible for automatic continuation.
	Active,
	/// User-paused with accounting retained.
	Paused,
	/// Hard token budget reached.
	#[serde(rename = "budget-limited")]
	#[strum(serialize = "budget-limited")]
	BudgetLimited,
	/// Objective achieved.
	Complete,
	/// Objective abandoned and eligible for replacement.
	Dropped,
}

/// One durable goal projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Goal {
	/// Stable goal identity.
	pub id:             Str,
	/// User-authored objective.
	pub objective:      Str,
	/// Current lifecycle state.
	pub status:         Status,
	/// Optional hard token budget.
	pub token_budget:   Option<u64>,
	/// Fresh tokens charged to this goal.
	pub tokens_used:    u64,
	/// Accumulated wall-clock seconds.
	pub time_used_secs: u64,
	/// Epoch millisecond when this objective was created.
	///
	/// Defaults to zero when decoding historical `goal@1` settlements written
	/// before timestamps became part of the durable projection.
	#[serde(default)]
	pub created_at_ms:  u64,
	/// Epoch millisecond of the latest durable transition or accounting tick.
	///
	/// Defaults to zero when decoding historical `goal@1` settlements written
	/// before timestamps became part of the durable projection.
	#[serde(default)]
	pub updated_at_ms:  u64,
}

/// Durable result of one goal operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Applied operation.
	pub op:                Operation,
	/// Latest goal, absent only for a `get` before creation.
	pub goal:              Option<Goal>,
	/// Remaining hard-budget tokens when one is configured.
	pub remaining_tokens:  Option<u64>,
	/// Model-visible final accounting, present only for successful completion.
	pub completion_report: Option<Str>,
}

/// Goal operations do not stream progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Typed refusal from the goal regime owner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// No live durable goal regime control is installed.
	#[error("goal mode is not active")]
	Unavailable,
	/// An operation required an existing goal.
	#[error("no goal is configured")]
	NoGoal,
	/// Create omitted a non-empty objective.
	#[error("objective is required when op=create")]
	ObjectiveRequired,
	/// A supplied token budget was zero.
	#[error("token_budget must be positive when provided")]
	InvalidBudget,
	/// The active mode prevents a goal transition.
	#[error("the active execution mode prevents this goal transition")]
	ModeConflict,
	/// A resource required by the goal regime is owned by another activation.
	#[error("the goal regime resource {resource} is owned by activation {owner}")]
	ResourceConflict {
		/// Canonical resource name, such as `mode`.
		resource: Str,
		/// Activation currently owning the resource.
		owner:    Str,
		/// Epoch millisecond at which the owner acquired the resource.
		since:    u64,
	},
	/// The requested transition is invalid for the current goal state.
	#[error("the requested goal transition is invalid for its durable state")]
	InvalidTransition,
}

/// App-owned durable goal regime control consumed through a frozen registry
/// entry.
pub trait GoalControl: Clone + Send + Sync + 'static {
	/// Applies one validated operation atomically and returns its latest
	/// projection.
	fn apply(&self, params: Params)
	-> impl Future<Output = Result<Option<Goal>, Fault>> + Send + '_;
}

/// Hidden goal tool backed by one durable regime-control handle.
pub struct GoalTool<C> {
	control: C,
	spec:    ToolSpec,
}

/// Returns the exact `goal@1` declaration shared by native and session-owned
/// execution.
#[must_use]
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("goal"),
		rev:             Rev { family: Str::default(), n: 1 },
		description:     sf!(
			"Creates, inspects, completes, resumes, or drops the durable goal-mode objective."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("goal.rs"),
		)
		.into(),
	}
}

/// Creates `goal@1`; production composition registers it as hidden.
pub fn tool<C: GoalControl>(control: C) -> GoalTool<C> {
	GoalTool { control, spec: spec() }
}

impl<C: GoalControl> Tool for GoalTool<C> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			if params.token_budget == Some(0) {
				yield Ev::Done(ToolTerminal::Done { result: Err(Fault::InvalidBudget), useless: true });
				return;
			}
			if params.op == Operation::Create
				&& params.objective.as_ref().is_none_or(|value| value.trim().is_empty())
			{
				yield Ev::Done(ToolTerminal::Done { result: Err(Fault::ObjectiveRequired), useless: true });
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let op = params.op;
			match self.control.apply(params).await {
				Ok(goal) => {
					let remaining_tokens = goal.as_ref().and_then(|goal| {
						goal.token_budget.map(|budget| budget.saturating_sub(goal.tokens_used))
					});
					let completion_report = (op == Operation::Complete)
						.then_some(goal.as_ref())
						.flatten()
						.map(completion_report);
					yield Ev::Done(ToolTerminal::Done {
						result: Ok(Payload { op, goal, remaining_tokens, completion_report }),
						useless: false,
					});
				},
				Err(fault) => yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false }),
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text { text: model_output(view) }]
	}
}

/// Projects one typed Goal outcome into the canonical model-visible text.
#[must_use]
pub fn model_output(view: Result<&Payload, &Fault>) -> Str {
	match view {
		Ok(payload) => render_payload(payload),
		Err(fault) => Str::new(fault.to_string()),
	}
}

fn render_payload(payload: &Payload) -> Str {
	let Some(goal) = payload.goal.as_ref() else {
		return sf!("No active goal.");
	};
	let mut text = StrMut::new("");
	text.push_str("Goal: ");
	text.push_str(&goal.objective);
	text.push_str("\nStatus: ");
	text.push_str(<&'static str>::from(goal.status));
	text.push_str("\nTokens: ");
	use std::fmt::Write as _;
	let _ = write!(text, "{} used", goal.tokens_used);
	if let Some(budget) = goal.token_budget {
		let _ = write!(text, " / {budget} budget");
	}
	if let Some(remaining) = payload.remaining_tokens {
		let _ = write!(text, "\nRemaining tokens: {remaining}");
	}
	if let Some(report) = payload.completion_report.as_ref() {
		text.push_str("\n\n");
		text.push_str(report);
	}
	text.freeze()
}

fn completion_report(goal: &Goal) -> Str {
	let budget = goal
		.token_budget
		.map_or_else(|| sf!("unbounded"), |value| sf!("{value}"));
	let remaining = goal
		.token_budget
		.map_or_else(|| sf!("unbounded"), |value| sf!("{}", value.saturating_sub(goal.tokens_used)));
	let overrun = goal
		.token_budget
		.map_or(0, |value| goal.tokens_used.saturating_sub(value));
	sf!(
		"Goal achieved. Report final budget usage to the user: charged tokens: {}; configured \
		 budget: {}; remaining tokens: {}; overrun tokens: {}; elapsed time: {} seconds.",
		goal.tokens_used,
		budget,
		remaining,
		overrun,
		goal.time_used_secs,
	)
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

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"op":"get"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn schema_rejects_unknown_and_zero_budget_is_typed() {
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({
				"op": "get",
				"extra": true
			}))
			.is_err()
		);
		assert_eq!(
			serde_json::from_value::<Params>(serde_json::json!({
				"op": "create",
				"objective": "x",
				"token_budget": 0
			}))
			.expect("shape parses")
			.token_budget,
			Some(0)
		);
	}

	#[test]
	fn pre_timestamp_goal_v1_payload_defaults_migration_fields() {
		let payload = serde_json::from_value::<Payload>(serde_json::json!({
			"op": "get",
			"goal": {
				"id": "goal_legacy",
				"objective": "ship",
				"status": "active",
				"token_budget": 1000,
				"tokens_used": 100,
				"time_used_secs": 60
			},
			"remaining_tokens": 900,
			"completion_report": null
		}))
		.expect("pre-timestamp goal@1 payload decodes");
		let goal = payload.goal.expect("legacy payload retains goal");
		assert_eq!(goal.created_at_ms, 0);
		assert_eq!(goal.updated_at_ms, 0);
	}

	#[test]
	fn current_goal_v1_payload_retains_timestamps() {
		let payload = Payload {
			op:                Operation::Get,
			goal:              Some(Goal {
				id:             Str::new_static("goal_current"),
				objective:      Str::new_static("ship"),
				status:         Status::Active,
				token_budget:   None,
				tokens_used:    100,
				time_used_secs: 60,
				created_at_ms:  1_749_200_000_000,
				updated_at_ms:  1_749_200_312_000,
			}),
			remaining_tokens:  None,
			completion_report: None,
		};
		let value = serde_json::to_value(payload).expect("current goal@1 payload serializes");
		assert_eq!(value["goal"]["created_at_ms"], 1_749_200_000_000_u64);
		assert_eq!(value["goal"]["updated_at_ms"], 1_749_200_312_000_u64);
	}

	#[test]
	fn resource_conflict_retains_mode_owner_data() {
		let fault = Fault::ResourceConflict {
			resource: sf!("mode"),
			owner:    sf!("activation-7"),
			since:    42,
		};
		assert_eq!(
			serde_json::to_value(fault).expect("fault serializes"),
			serde_json::json!({
				"kind": "resource_conflict",
				"resource": "mode",
				"owner": "activation-7",
				"since": 42
			})
		);
	}
}
