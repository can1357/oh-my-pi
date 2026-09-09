//! One-shot todo-gated model prewalk.

use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, Slot, StateUpdate, TurnView, Verdict,
	state_bool, state_str, turn_settled_successfully,
};

const CLAIMS: &[Slot] = &[Slot::Mode, Slot::Loop];
const PLAN_NUDGE: &str = "Before implementation, inspect the relevant code deeply and create or \
                          update the todo list. Do not edit or write yet.";
const CONTINUE_NUDGE: &str = "Continue the prewalk. Build the todo-backed implementation plan \
                              before the first edit or write.";
const HANDOFF: &str = "Prewalk complete. Continue implementation on the selected model and \
                       execute the todo checklist.";

/// Keeps the planning model in control until the todo gate is open and the
/// first workspace edit/write settles, then switches models exactly once.
pub struct Prewalk {
	target:      Str,
	thinking:    Option<Str>,
	todo_seen:   bool,
	action_seen: bool,
	prompted:    bool,
}

impl Prewalk {
	/// Arms a prewalk for `target` and optional reasoning level.
	#[must_use]
	pub fn new(target: impl Into<Str>, thinking: Option<Str>) -> Self {
		Self {
			target: target.into(),
			thinking,
			todo_seen: false,
			action_seen: false,
			prompted: false,
		}
	}

	/// Reconstructs the one-shot state from the session DOM.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		Self {
			target:      state_str(node, "target").unwrap_or_else(|| Str::new_static("@smol")),
			thinking:    state_str(node, "thinking").filter(|value| !value.is_empty()),
			todo_seen:   state_bool(node, "todo_seen").unwrap_or(false),
			action_seen: state_bool(node, "action_seen").unwrap_or(false),
			prompted:    state_bool(node, "prompted").unwrap_or(false),
		}
	}

	fn handoff(&self) -> DirectorEffect {
		let mut effect = DirectorEffect::new(Verdict::Done)
			.with_write("ai_model", BindValue::Str(self.target.clone()))
			.with_aside(HANDOFF)
			.continuing_after_exit();
		if let Some(thinking) = &self.thinking {
			effect = effect.with_write("ai_thinking", BindValue::Str(thinking.clone()));
		}
		effect
	}
}

impl Director for Prewalk {
	fn id(&self) -> &'static str {
		"prewalk"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("target"), BindValue::Str(self.target.clone())),
			(Str::new_static("thinking"), BindValue::Str(self.thinking.clone().unwrap_or_default())),
			(Str::new_static("todo_seen"), BindValue::Bool(self.todo_seen)),
			(Str::new_static("action_seen"), BindValue::Bool(self.action_seen)),
			(Str::new_static("prompted"), BindValue::Bool(self.prompted)),
		]
	}

	fn prepare_inference(&self, _cx: &DirectorCx<'_>, request: &mut omp_ai::ChatRequest) {
		crate::director::prepend_system(
			request,
			Str::new_static(if self.prompted {
				CONTINUE_NUDGE
			} else {
				PLAN_NUDGE
			}),
		);
	}

	fn observe_turn(&self, dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> Vec<StateUpdate> {
		let todo_available = omp_session::components::lifecycle::roster(dom)
			.iter()
			.any(|tool| tool == "todo");
		let todo_seen = self.todo_seen || turn_settled_successfully(dom, turn.turn, "todo");
		let gate_open = todo_seen || !todo_available;
		let action_seen = self.action_seen
			|| (gate_open
				&& (turn_settled_successfully(dom, turn.turn, "edit")
					|| turn_settled_successfully(dom, turn.turn, "write")));
		vec![
			StateUpdate::new("todo_seen", BindValue::Bool(todo_seen)),
			StateUpdate::new("action_seen", BindValue::Bool(action_seen)),
			StateUpdate::new("prompted", BindValue::Bool(true)),
		]
	}

	fn after_settled_turn(
		&self,
		_dom: &Dom,
		_cx: &DirectorCx<'_>,
		_turn: &TurnView,
	) -> Option<DirectorEffect> {
		self.action_seen.then(|| self.handoff())
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		if self.action_seen {
			return self.handoff();
		}
		DirectorEffect::new(Verdict::Continue { reminder: Some(Str::new_static(CONTINUE_NUDGE)) })
	}
}
