//! Autoresearch Director declaration and bounded resume policy.

use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, Slot, StateUpdate, TurnView, Verdict,
	state_bool, state_int, state_str, turn_called,
};

const CLAIMS: &[Slot] = &[Slot::Mode, Slot::Worktree];

/// Resumes logged experiments until an optional iteration cap is reached.
pub struct Autoresearch {
	goal:           Str,
	iterations:     u32,
	max_iterations: Option<u32>,
	armed:          bool,
	binds:          Vec<(Str, BindValue)>,
}

impl Autoresearch {
	/// Creates an autoresearch engagement.
	#[must_use]
	pub fn new(goal: impl Into<Str>, max_iterations: Option<u32>) -> Self {
		Self {
			goal: goal.into(),
			iterations: 0,
			max_iterations,
			armed: false,
			binds: vec![(
				Str::new_static("ai_prompt_mode"),
				BindValue::Str(Str::new_static("autoresearch")),
			)],
		}
	}

	/// Reconstructs autoresearch state from its DOM element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		let mut director = Self::new(
			state_str(node, "goal").unwrap_or_default(),
			state_int(node, "max_iterations").and_then(|value| u32::try_from(value).ok()),
		);
		director.iterations = state_int(node, "iterations")
			.and_then(|value| u32::try_from(value).ok())
			.unwrap_or(0);
		director.armed = state_bool(node, "armed").unwrap_or(false);
		director
	}
}

impl Director for Autoresearch {
	fn id(&self) -> &'static str {
		"autoresearch"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn binds(&self) -> &[(Str, BindValue)] {
		&self.binds
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("goal"), BindValue::Str(self.goal.clone())),
			(Str::new_static("iterations"), BindValue::Int(i64::from(self.iterations))),
			(
				Str::new_static("max_iterations"),
				BindValue::Int(self.max_iterations.map_or(-1, i64::from)),
			),
			(Str::new_static("armed"), BindValue::Bool(self.armed)),
			(Str::new_static("tools"), BindValue::Str(Str::new_static("init,run,log_experiment"))),
		]
	}

	fn observe_turn(&self, dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> Vec<StateUpdate> {
		if turn_called(dom, turn.turn, "log_experiment") {
			vec![StateUpdate::new("armed", BindValue::Bool(true))]
		} else {
			Vec::new()
		}
	}

	fn evaluate(&self, dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		if self
			.max_iterations
			.is_some_and(|max| self.iterations >= max)
		{
			return DirectorEffect::new(Verdict::Done)
				.with_aside("Autoresearch iteration cap reached.");
		}
		let pending_user_input =
			!dom.children(dom.queues()).is_empty() && dom.count("queues prompt").unwrap_or(0) > 0;
		if self.armed && !pending_user_input {
			return DirectorEffect::new(Verdict::Continue {
				reminder: Some(Str::new_static("Resume the logged autoresearch experiment.")),
			})
			.with_update("armed", BindValue::Bool(false))
			.with_update("iterations", BindValue::Int(i64::from(self.iterations.saturating_add(1))));
		}
		DirectorEffect::new(Verdict::Pass)
	}
}
