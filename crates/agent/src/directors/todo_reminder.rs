//! Session-scoped bounded todo reminder.

use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, TurnView, Verdict, find_director, state_bool,
	state_int,
};

/// Reminds the model about unfinished todo items without burning retries on
/// progress.
pub struct TodoReminder {
	max_reminders:     u32,
	attempts:          u32,
	awaiting_progress: bool,
}

impl TodoReminder {
	/// Creates a reminder with the standard three-rung budget.
	#[must_use]
	pub const fn new(max_reminders: u32) -> Self {
		Self { max_reminders, attempts: 0, awaiting_progress: false }
	}

	/// Reconstructs reminder state from the Director element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		Self {
			max_reminders:     as_u32(state_int(node, "max_reminders"), 3),
			attempts:          as_u32(state_int(node, "attempts"), 0),
			awaiting_progress: state_bool(node, "awaiting_progress").unwrap_or(false),
		}
	}
}

impl Default for TodoReminder {
	fn default() -> Self {
		Self::new(3)
	}
}

impl Director for TodoReminder {
	fn id(&self) -> &'static str {
		"todo_reminder"
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("max_reminders"), BindValue::Int(i64::from(self.max_reminders))),
			(Str::new_static("attempts"), BindValue::Int(i64::from(self.attempts))),
			(Str::new_static("awaiting_progress"), BindValue::Bool(self.awaiting_progress)),
		]
	}

	fn evaluate(&self, dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> DirectorEffect {
		let pending = dom.count("todo item[status!=completed]").unwrap_or(0);
		if pending == 0 {
			return DirectorEffect::new(Verdict::Pass)
				.with_update("attempts", BindValue::Int(0))
				.with_update("awaiting_progress", BindValue::Bool(false));
		}
		let pending_ask = dom
			.count("prompts prompt[kind=ask][status=pending]")
			.unwrap_or(0)
			> 0;
		// A running detached job or subagent will wake this session with an
		// async-result follow-up; stop-time passes defer to the settle reached
		// once the work lands.
		let pending_wake = crate::jobs::pending_wake(dom);
		let open_force = find_director(dom, "force_tool").is_some();
		if pending_ask || pending_wake || open_force || turn.had_tool_calls {
			return DirectorEffect::new(Verdict::Pass);
		}
		if self.awaiting_progress {
			return DirectorEffect::new(Verdict::Pass)
				.with_update("awaiting_progress", BindValue::Bool(false));
		}
		if self.attempts >= self.max_reminders {
			return DirectorEffect::new(Verdict::Pass);
		}
		DirectorEffect::new(Verdict::Continue {
			reminder: Some(Str::new_static(
				"Todo items remain incomplete. Continue working before yielding.",
			)),
		})
		.with_update("attempts", BindValue::Int(i64::from(self.attempts + 1)))
		.with_update("awaiting_progress", BindValue::Bool(true))
	}
}

fn as_u32(value: Option<i64>, default: u32) -> u32 {
	value
		.and_then(|value| u32::try_from(value).ok())
		.unwrap_or(default)
}
