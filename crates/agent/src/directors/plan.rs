//! Plan composition and its write/decision gates.

use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::director::{
	BindValue, Director, DirectorCx, DirectorEffect, ForceUntil, Slot, StateUpdate, TurnView,
	Verdict, state_bool, state_int, state_str, turn_call_inputs, turn_called,
};

const CLAIMS: &[Slot] = &[Slot::Mode, Slot::Worktree];
/// Tools a planning turn may use: read-only discovery plus the plan file
/// write and the decision request. The built-in `write` stays active while
/// the read-only guard handles every other tool.
pub const PLAN_TOOLS: &[&str] = &[
	"read",
	"grep",
	"glob",
	"ast_grep",
	"lsp",
	"web_search",
	"think",
	"todo",
	"write",
	"ask",
	"task",
	"hub",
	"yield",
];

/// Requires a durable plan followed by an explicit user decision request.
pub struct Plan {
	plan_file:         Str,
	plan_written:      bool,
	decision_made:     bool,
	write_attempts:    u32,
	decision_attempts: u32,
	/// Once the plan is written and presented, hand off to this model and keep
	/// going instead of yielding for approval.
	yolo_into:         Option<Str>,
	yolo_thinking:     Option<Str>,
	binds:             Vec<(Str, BindValue)>,
}

impl Plan {
	/// Creates a plan engagement for one local artifact.
	#[must_use]
	pub fn new(plan_file: impl Into<Str>) -> Self {
		Self {
			plan_file:         plan_file.into(),
			plan_written:      false,
			decision_made:     false,
			write_attempts:    0,
			decision_attempts: 0,
			yolo_into:         None,
			yolo_thinking:     None,
			binds:             plan_binds(),
		}
	}

	/// Enables the yolo handoff: after the plan is written and presented the
	/// Director exits, re-targets `ai_model` (and `ai_thinking` when given),
	/// and continues implementing.
	#[must_use]
	pub fn with_yolo(mut self, target: impl Into<Str>, thinking: Option<Str>) -> Self {
		self.yolo_into = Some(target.into());
		self.yolo_thinking = thinking;
		self
	}

	/// Reconstructs plan state from its DOM element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		Self {
			plan_file:         state_str(node, "plan_file")
				.unwrap_or_else(|| Str::new_static("local://plans/current.md")),
			plan_written:      state_bool(node, "plan_written").unwrap_or(false),
			decision_made:     state_bool(node, "decision_made").unwrap_or(false),
			write_attempts:    u32_value(state_int(node, "write_attempts")),
			decision_attempts: u32_value(state_int(node, "decision_attempts")),
			yolo_into:         state_str(node, "yolo_into").filter(|value| !value.is_empty()),
			yolo_thinking:     state_str(node, "yolo_thinking").filter(|value| !value.is_empty()),
			binds:             plan_binds(),
		}
	}

	fn yolo_handoff(&self) -> Option<DirectorEffect> {
		let target = self.yolo_into.as_ref()?;
		let mut effect = DirectorEffect::new(Verdict::Done)
			.with_aside(format!("Plan approved. Implementing now with {target}."))
			.with_write("ai_model", BindValue::Str(target.clone()))
			.continuing_after_exit();
		if let Some(thinking) = &self.yolo_thinking {
			effect = effect.with_write("ai_thinking", BindValue::Str(thinking.clone()));
		}
		Some(effect)
	}
}

impl Director for Plan {
	fn id(&self) -> &'static str {
		"plan"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn binds(&self) -> &[(Str, BindValue)] {
		&self.binds
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("plan_file"), BindValue::Str(self.plan_file.clone())),
			(Str::new_static("plan_written"), BindValue::Bool(self.plan_written)),
			(Str::new_static("decision_made"), BindValue::Bool(self.decision_made)),
			(Str::new_static("write_attempts"), BindValue::Int(i64::from(self.write_attempts))),
			(Str::new_static("decision_attempts"), BindValue::Int(i64::from(self.decision_attempts))),
			(Str::new_static("tools"), BindValue::Str(Str::new_static("write,ask"))),
			(Str::new_static("yolo_into"), BindValue::Str(self.yolo_into.clone().unwrap_or_default())),
			(
				Str::new_static("yolo_thinking"),
				BindValue::Str(self.yolo_thinking.clone().unwrap_or_default()),
			),
		]
	}

	fn observe_turn(&self, dom: &Dom, _cx: &DirectorCx<'_>, turn: &TurnView) -> Vec<StateUpdate> {
		let wrote_plan = call_wrote_path(dom, turn.turn, self.plan_file.as_str());
		let proposed = turn_called(dom, turn.turn, "ask");
		let mut updates = Vec::with_capacity(2);
		if wrote_plan && !self.plan_written {
			updates.push(StateUpdate::new("plan_written", BindValue::Bool(true)));
		}
		if proposed && !self.decision_made {
			updates.push(StateUpdate::new("decision_made", BindValue::Bool(true)));
		}
		updates
	}

	fn evaluate(&self, _dom: &Dom, cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		if !self.plan_written {
			if self.write_attempts >= 3 {
				return DirectorEffect::new(Verdict::Yield);
			}
			let verdict = cx.force_tool(
				"write",
				ForceUntil::ToolCalled(Str::new_static("write")),
				Some(Str::new(format!(
					"Write the plan to {} before asking for approval.",
					self.plan_file
				))),
				3,
			);
			return DirectorEffect::new(verdict)
				.with_update("write_attempts", BindValue::Int(i64::from(self.write_attempts + 1)))
				.with_aside(format!(
					"Write the plan to {} before asking for approval.",
					self.plan_file
				));
		}
		if self.decision_made {
			return self
				.yolo_handoff()
				.unwrap_or_else(|| DirectorEffect::new(Verdict::Yield));
		}
		if self.decision_attempts >= 3 {
			return DirectorEffect::new(Verdict::Yield);
		}
		DirectorEffect::new(cx.force_tool(
			"required",
			ForceUntil::AnyToolCall,
			Some(Str::new_static(
				"Present the completed plan for an explicit decision before yielding.",
			)),
			3,
		))
		.with_update("decision_attempts", BindValue::Int(i64::from(self.decision_attempts + 1)))
	}
}

/// The engagement layer plan mode installs (ADR 0012/0015): the mode prompt
/// slot, the `@plan` role route, and the planning tool roster.
fn plan_binds() -> Vec<(Str, BindValue)> {
	vec![
		(Str::new_static("ai_prompt_mode"), BindValue::Str(Str::new_static("plan"))),
		(Str::new_static("ai_model"), BindValue::Str(Str::new_static("@plan"))),
		(Str::new_static("sv_tools"), BindValue::list(PLAN_TOOLS)),
	]
}

fn call_wrote_path(dom: &Dom, turn: omp_dom::Handle, expected: &str) -> bool {
	turn_call_inputs(dom, turn, "write").any(|input| {
		serde_json::from_str::<serde_json::Value>(input)
			.ok()
			.and_then(|value| {
				value
					.get("path")
					.and_then(|path| path.as_str())
					.map(str::to_owned)
			})
			.is_some_and(|path| path == expected)
	})
}

fn u32_value(value: Option<i64>) -> u32 {
	value
		.and_then(|value| u32::try_from(value).ok())
		.unwrap_or(0)
}
