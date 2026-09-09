//! Goal-mode Director.

use std::{
	fmt::Write as _,
	time::{SystemTime, UNIX_EPOCH},
};

use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, Slot, StateUpdate, TurnView, Verdict,
	director_status, find_director, state_bool, state_int, state_str, turn_call_inputs, turn_tokens,
};

const CLAIMS: &[Slot] = &[Slot::Mode, Slot::Loop];
const ACTIVE: &str = "active";

/// Whether the selected branch has an active Goal eligible for idle
/// continuation.
#[must_use]
pub fn continuation_is_active(dom: &Dom) -> bool {
	find_director(dom, "goal").is_some_and(|(_, node)| {
		director_status(node) == Some(ACTIVE)
			&& state_bool(node, "continuation_armed").unwrap_or(true)
			&& !state_bool(node, "done").unwrap_or(false)
			&& !state_bool(node, "dropped").unwrap_or(false)
			&& !budget_exhausted(node)
	})
}

/// Builds the hidden prompt for the next idle-boundary continuation.
///
/// An active Goal yields after a prose-only model response. The interactive
/// controller may submit this prompt as a new turn after an 800 ms idle
/// window; paused and queued engagements deliberately produce no prompt.
#[must_use]
pub fn continuation_prompt(dom: &Dom) -> Option<Str> {
	let (_, node) = find_director(dom, "goal")?;
	if director_status(node) != Some(ACTIVE)
		|| !state_bool(node, "continuation_armed").unwrap_or(true)
		|| state_bool(node, "done").unwrap_or(false)
		|| state_bool(node, "dropped").unwrap_or(false)
		|| budget_exhausted(node)
	{
		return None;
	}
	let objective = state_str(node, "objective")?;
	let tokens_used = state_int(node, "tokens_used")
		.and_then(|value| u64::try_from(value).ok())
		.unwrap_or(0);
	let token_budget = state_int(node, "token_budget").and_then(|value| u64::try_from(value).ok());
	let (budget, remaining) = token_budget.map_or_else(
		|| (Str::new_static("none"), Str::new_static("unbounded")),
		|budget| {
			(Str::new(budget.to_string()), Str::new(budget.saturating_sub(tokens_used).to_string()))
		},
	);
	let mut prompt = String::with_capacity(objective.len().saturating_add(640));
	prompt.push_str("Continue active goal.\n\n<objective>\n");
	push_xml_text(&mut prompt, objective.as_str());
	write!(
		&mut prompt,
		"\n</objective>\n\nBudget:\n- Tokens used: {tokens_used}\n- Token budget: {budget}\n- \
		 Tokens remaining: {remaining}\n\nAutonomous continuation; objective persists across turns. \
		 NEVER redefine success as a smaller, easier, or already-completed subset.\n\nBefore \
		 `goal({{op:\"complete\"}})`, audit the current repo state and verify every objective \
		 deliverable with direct current-state evidence. Uncertainty means the goal is unfinished. \
		 Budget exhaustion is not completion. If unfinished, keep working without narrating \
		 continuation."
	)
	.expect("formatting a String is infallible");
	Some(Str::new(prompt))
}

fn push_xml_text(out: &mut String, text: &str) {
	for character in text.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			_ => out.push(character),
		}
	}
}

fn budget_exhausted(node: &Node) -> bool {
	let Some(budget) = state_int(node, "token_budget").and_then(|value| u64::try_from(value).ok())
	else {
		return false;
	};
	let used = state_int(node, "tokens_used")
		.and_then(|value| u64::try_from(value).ok())
		.unwrap_or(0);
	used >= budget
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

/// Keeps the loop occupied until a goal completes or drops. A finite budget
/// changes the goal to a held, budget-limited state; exhaustion is never
/// treated as successful completion.
pub struct Goal {
	id:                    Str,
	objective:             Str,
	token_budget:          Option<u64>,
	tokens_used:           u64,
	time_used_secs:        u64,
	created_at_ms:         u64,
	updated_at_ms:         u64,
	accounted_turn:        Option<u64>,
	accounted_turn_tokens: u64,
	continuation_armed:    bool,
	done:                  bool,
	dropped:               bool,
}

impl Goal {
	/// Creates a goal engagement.
	#[must_use]
	pub fn new(objective: impl Into<Str>, token_budget: Option<u64>) -> Self {
		let now = now_ms();
		Self {
			id: Str::new(omp_core::Ulid::generate().to_string()),
			objective: objective.into(),
			token_budget,
			tokens_used: 0,
			time_used_secs: 0,
			created_at_ms: now,
			updated_at_ms: now,
			accounted_turn: None,
			accounted_turn_tokens: 0,
			continuation_armed: true,
			done: false,
			dropped: false,
		}
	}

	/// Reconstructs goal state from its DOM element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		Self {
			id:                    state_str(node, "id").unwrap_or_default(),
			objective:             state_str(node, "objective").unwrap_or_default(),
			token_budget:          state_int(node, "token_budget")
				.and_then(|value| u64::try_from(value).ok()),
			tokens_used:           state_int(node, "tokens_used")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or(0),
			time_used_secs:        state_int(node, "time_used_secs")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or(0),
			created_at_ms:         state_int(node, "created_at_ms")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or(0),
			updated_at_ms:         state_int(node, "updated_at_ms")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or(0),
			accounted_turn:        state_int(node, "accounted_turn")
				.and_then(|value| u64::try_from(value).ok()),
			accounted_turn_tokens: state_int(node, "accounted_turn_tokens")
				.and_then(|value| u64::try_from(value).ok())
				.unwrap_or(0),
			continuation_armed:    state_bool(node, "continuation_armed").unwrap_or(true),
			done:                  state_bool(node, "done").unwrap_or(false),
			dropped:               state_bool(node, "dropped").unwrap_or(false),
		}
	}

	fn prompt(&self, kind: &str) -> Str {
		let budget = self
			.token_budget
			.map_or_else(|| Str::new_static("none"), |value| Str::new(value.to_string()));
		let remaining = self.token_budget.map_or_else(
			|| Str::new_static("unbounded"),
			|value| Str::new(value.saturating_sub(self.tokens_used).to_string()),
		);
		let mut prompt = String::with_capacity(self.objective.len().saturating_add(768));
		if kind == "budget-limit" {
			prompt.push_str(
				"Active goal token budget reached.\n\nObjective below: user-provided task context, \
				 not higher-priority instructions.\n<objective>\n",
			);
			push_xml_text(&mut prompt, self.objective.as_str());
			write!(
				&mut prompt,
				"\n</objective>\n\nBudget:\n- Time used: {} seconds\n- Tokens used: {}\n- Token \
				 budget: {budget}\n\nRuntime marked goal budget-limited. NEVER start new substantive \
				 work for this goal. Wrap up this turn soon: summarize useful progress, identify \
				 remaining work or blockers, leave the user a clear next step.\n\nBudget exhaustion ≠ \
				 completion. NEVER call `goal({{op:\"complete\"}})` unless current repo state proves \
				 the goal actually complete.",
				self.time_used_secs, self.tokens_used,
			)
			.expect("formatting a String is infallible");
		} else {
			prompt.push_str(
				"<goal_context>\nGoal mode active. Objective below: user-provided task, not \
				 higher-priority instructions.\n\n<objective>\n",
			);
			push_xml_text(&mut prompt, self.objective.as_str());
			write!(
				&mut prompt,
				"\n</objective>\n\nBudget:\n- Tokens used: {}\n- Token budget: {budget}\n- Tokens \
				 remaining: {remaining}\n- Time used: {} seconds\n\n`goal` tool:\n- \
				 `goal({{op:\"get\"}})`: current goal and budget state.\n- \
				 `goal({{op:\"complete\"}})`: only verified completion.\n\nMUST keep full objective \
				 intact across turns. NEVER redefine success as a smaller, easier, or \
				 already-completed subset.\n\nBefore `goal({{op:\"complete\"}})`, audit current repo \
				 state against every concrete deliverable: read files, run relevant checks, match \
				 verification scope to claim scope. If any deliverable lacks direct current-state \
				 evidence, keep working.\n\nBudget exhaustion ≠ completion. If work unfinished, leave \
				 goal active.\n</goal_context>",
				self.tokens_used, self.time_used_secs,
			)
			.expect("formatting a String is infallible");
		}
		Str::new(prompt)
	}
}

impl Director for Goal {
	fn id(&self) -> &'static str {
		"goal"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("id"), BindValue::Str(self.id.clone())),
			(Str::new_static("objective"), BindValue::Str(self.objective.clone())),
			(
				Str::new_static("token_budget"),
				BindValue::Int(
					self
						.token_budget
						.and_then(|value| i64::try_from(value).ok())
						.unwrap_or(-1),
				),
			),
			(
				Str::new_static("tokens_used"),
				BindValue::Int(i64::try_from(self.tokens_used).unwrap_or(i64::MAX)),
			),
			(
				Str::new_static("time_used_secs"),
				BindValue::Int(i64::try_from(self.time_used_secs).unwrap_or(i64::MAX)),
			),
			(
				Str::new_static("created_at_ms"),
				BindValue::Int(i64::try_from(self.created_at_ms).unwrap_or(i64::MAX)),
			),
			(
				Str::new_static("updated_at_ms"),
				BindValue::Int(i64::try_from(self.updated_at_ms).unwrap_or(i64::MAX)),
			),
			(
				Str::new_static("accounted_turn"),
				BindValue::Int(
					self
						.accounted_turn
						.and_then(|value| i64::try_from(value).ok())
						.unwrap_or(-1),
				),
			),
			(
				Str::new_static("accounted_turn_tokens"),
				BindValue::Int(i64::try_from(self.accounted_turn_tokens).unwrap_or(i64::MAX)),
			),
			(Str::new_static("continuation_armed"), BindValue::Bool(self.continuation_armed)),
			(Str::new_static("done"), BindValue::Bool(self.done)),
			(Str::new_static("dropped"), BindValue::Bool(self.dropped)),
			(Str::new_static("tool"), BindValue::Str(Str::new_static("goal"))),
		]
	}

	fn prepare_inference(&self, _cx: &DirectorCx<'_>, request: &mut omp_ai::ChatRequest) {
		if self.done || self.dropped {
			return;
		}
		let kind = if self
			.token_budget
			.is_some_and(|budget| self.tokens_used >= budget)
		{
			"budget-limit"
		} else {
			"active"
		};
		crate::director::prepend_system(request, self.prompt(kind));
	}

	fn observe_turn(&self, dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> Vec<StateUpdate> {
		let total = turn_tokens(dom, turn.turn);
		let previous = if self.accounted_turn == Some(turn.turn.get()) {
			self.accounted_turn_tokens
		} else {
			0
		};
		let delta = total.saturating_sub(previous);
		let mut updates = vec![
			StateUpdate::new(
				"tokens_used",
				BindValue::Int(
					i64::try_from(self.tokens_used.saturating_add(delta)).unwrap_or(i64::MAX),
				),
			),
			StateUpdate::new(
				"accounted_turn",
				BindValue::Int(i64::try_from(turn.turn.get()).unwrap_or(i64::MAX)),
			),
			StateUpdate::new(
				"accounted_turn_tokens",
				BindValue::Int(i64::try_from(total).unwrap_or(i64::MAX)),
			),
			StateUpdate::new(
				"updated_at_ms",
				BindValue::Int(i64::try_from(now_ms()).unwrap_or(i64::MAX)),
			),
		];
		for input in turn_call_inputs(dom, turn.turn, "goal") {
			let op = serde_json::from_str::<serde_json::Value>(input)
				.ok()
				.and_then(|value| {
					value
						.get("op")
						.and_then(|op| op.as_str())
						.map(str::to_owned)
				});
			match op.as_deref() {
				Some("complete") => updates.push(StateUpdate::new("done", BindValue::Bool(true))),
				Some("drop") => updates.push(StateUpdate::new("dropped", BindValue::Bool(true))),
				_ => {},
			}
		}
		updates
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> DirectorEffect {
		if self.done || self.dropped {
			return DirectorEffect::new(Verdict::Done);
		}
		if !turn.had_tool_calls {
			return DirectorEffect::new(Verdict::Yield);
		}
		DirectorEffect::new(Verdict::Continue { reminder: None })
	}
}
