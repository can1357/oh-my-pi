use omp_agent::{
	Control, ControlDraft, Director, DirectorCx, DirectorEffect, ForceUntil, LoopDecision, Slot,
	TurnView, Verdict, arbitrate,
	directors::{
		force_tool::ForceTool, goal::Goal, loop_mode::LoopMode, todo_reminder::TodoReminder,
	},
};
use omp_core::Str;
use omp_dom::{Dom, Node};

use crate::harness::Harness;

struct PassAside;
impl Director for PassAside {
	fn id(&self) -> &'static str {
		"test_pass_aside"
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		DirectorEffect::new(Verdict::Pass).with_aside("from-inner")
	}
}
fn pass_aside(_node: &Node) -> Box<dyn Director> {
	Box::new(PassAside)
}

struct DoneMode;
impl Director for DoneMode {
	fn id(&self) -> &'static str {
		"test_done_mode"
	}

	fn claims(&self) -> &'static [Slot] {
		&[Slot::Mode]
	}

	fn on_yield(&self, _cx: &DirectorCx<'_>, _turn: &TurnView) -> Verdict {
		Verdict::Done
	}
}
fn done_mode(_node: &Node) -> Box<dyn Director> {
	Box::new(DoneMode)
}

struct DoneAside;
impl Director for DoneAside {
	fn id(&self) -> &'static str {
		"test_done_aside"
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		DirectorEffect::new(Verdict::Done).with_aside("last-words")
	}
}
fn done_aside(_node: &Node) -> Box<dyn Director> {
	Box::new(DoneAside)
}

#[test]
fn test_continue_reruns_and_idle_settles() {
	let mut world = Harness::new();
	world.engage(LoopMode::new("again", Some(2)));
	assert!(matches!(world.turn("a", &[], 0), LoopDecision::Continue { .. }));
	assert!(matches!(world.turn("b", &[], 0), LoopDecision::Continue { .. }));
	assert_eq!(world.turn("c", &[], 0), LoopDecision::Yield);
	assert!(!world.active().iter().any(|&id| id == "loop_mode"));
}

#[test]
fn test_hold_outranks_continue() {
	assert_eq!(arbitrate([Control::Continue, Control::Hold]), Some(Control::Hold),);
}

#[test]
fn test_injections_union_across_directors() {
	let mut world = Harness::new();
	world.register("test_pass_aside", pass_aside);
	world.engage(LoopMode::new("from-outer", Some(1)));
	world.engage(PassAside);
	assert!(matches!(world.turn("x", &[], 0), LoopDecision::Continue { .. }));
	let messages = world.developer_texts();
	assert!(messages.iter().any(|text| text == "from-inner"));
	assert!(messages.iter().any(|text| text == "from-outer"));
}

#[test]
fn test_one_control_per_tick_is_enforced() {
	let mut draft = ControlDraft::new();
	draft.stage(Control::Continue).expect("first control");
	assert!(draft.stage(Control::Hold).is_err());
	assert_eq!(draft.finish(), Some(Control::Continue));
}

#[test]
fn test_claims_queue_and_promote() {
	let mut world = Harness::new();
	world.register("test_done_mode", done_mode);
	world.engage(DoneMode);
	world.engage(Goal::new("second", None));
	assert_eq!(world.queued(), vec!["goal"]);
	world.turn("done", &[], 0);
	assert_eq!(world.active(), vec!["goal"]);
	assert!(world.queued().is_empty());
}

#[test]
fn test_member_exits_with_parent() {
	let mut world = Harness::new();
	world.register("test_done_mode", done_mode);
	world.engage(DoneMode);
	world.engage(LoopMode::new("never", Some(0)));
	world.turn("candidate", &[], 0);
	assert!(world.active().is_empty());
}

#[test]
fn test_force_head_wins_and_loser_rung_is_not_burned() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("write", ForceUntil::ToolCalled(Str::new_static("write")), None, 3));
	world.engage(ForceTool::new("ask", ForceUntil::ToolCalled(Str::new_static("ask")), None, 3));
	assert_eq!(world.queued(), vec!["force_tool"]);
	world.turn("", &[crate::harness::Call::new("write", serde_json::json!({}))], 0);
	assert_eq!(world.active(), vec!["force_tool"]);
	assert_eq!(world.state_str("force_tool", "tool").as_deref(), Some("ask"));
	assert_eq!(world.state_int("force_tool", "attempts"), Some(0));
}

#[test]
fn test_provider_downgrade_records_reminder_path() {
	let mut world = Harness::new();
	world.route.forced_choice_free = false;
	world.engage(ForceTool::new("write", ForceUntil::AnyToolCall, None, 2));
	assert!(matches!(world.turn("ignored", &[], 0), LoopDecision::Continue { .. }));
	assert!(
		world
			.developer_texts()
			.iter()
			.any(|text| text.contains("write"))
	);
	assert_eq!(world.state_int("force_tool", "attempts"), Some(1));
}

#[test]
fn test_bounded_nag_satisfied_resets_and_skip_burns_nothing() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.engage(TodoReminder::new(2));
	world.turn("stall", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(1));
	world.complete_todos();
	world.turn("done", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(0));
}

#[test]
fn test_exit_tick_effects_commit() {
	let mut world = Harness::new();
	world.register("test_done_aside", done_aside);
	world.engage(DoneAside);
	world.turn("x", &[], 0);
	assert!(world.active().is_empty());
	assert!(
		world
			.developer_texts()
			.iter()
			.any(|text| text == "last-words")
	);
}

#[test]
fn test_state_dataclass_seeding() {
	let mut world = Harness::new();
	world.engage(Goal::new("hello", Some(42)));
	assert_eq!(world.state_str("goal", "objective").as_deref(), Some("hello"));
	assert_eq!(world.state_int("goal", "tokens_used"), Some(0));
	assert_eq!(world.state_int("goal", "token_budget"), Some(42));
}
