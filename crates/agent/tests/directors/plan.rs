use omp_agent::{
	BindValue, LoopDecision,
	directors::{plan::Plan, todo_reminder::TodoReminder},
};

use crate::harness::{Call, Harness};

const PLAN_FILE: &str = "local://plans/current.md";

#[test]
fn test_stall_then_write_then_propose_advances_the_gate() {
	let mut world = Harness::new();
	world.engage(Plan::new(PLAN_FILE));
	assert!(matches!(world.turn("still thinking", &[], 0), LoopDecision::Continue { .. }));
	assert_eq!(world.active(), vec!["plan", "force_tool"]);
	world.turn(
		"",
		&[Call::new("write", serde_json::json!({"path": PLAN_FILE, "content": "plan"}))],
		0,
	);
	assert_eq!(world.state_bool("plan", "plan_written"), Some(true));
	assert_eq!(world.active(), vec!["plan", "force_tool"]);
	let result = world.turn("", &[Call::new("ask", serde_json::json!({"question": "approve?"}))], 0);
	assert_eq!(result, LoopDecision::Yield);
	assert_eq!(world.state_bool("plan", "decision_made"), Some(true));
}

#[test]
fn test_stall_rungs_cap_at_three_then_idle() {
	let mut world = Harness::new();
	world.route.forced_choice_free = false;
	world.engage(Plan::new(PLAN_FILE));
	for _ in 0..5 {
		let _ = world.turn("stall", &[], 0);
	}
	assert!(!world.notices().is_empty());
	assert!(
		world
			.state_int("plan", "write_attempts")
			.is_some_and(|attempts| attempts <= 3)
	);
}

#[test]
fn plan_binds_derive_into_registered_convars_and_restrict_the_roster() {
	let mut world = Harness::new();
	let con = omp_con::Ctx::new();
	world.engage(Plan::new(PLAN_FILE));
	world.stack.apply_binds(world.session.dom(), &con);
	assert_eq!(
		con.get("ai_prompt_mode"),
		Some(omp_con::Value::Str("plan".into())),
		"plan binds the mode prompt slot"
	);
	assert_eq!(con.get("ai_model"), Some(omp_con::Value::Str("@plan".into())));
	let roster = omp_agent::SV_TOOLS.get(&con);
	assert!(roster.iter().any(|name| name.as_str() == "write"), "{roster:?}");
	assert!(!roster.iter().any(|name| name.as_str() == "edit"), "{roster:?}");
	assert_eq!(
		omp_agent::tool_allowlist(Some(&con))
			.as_deref()
			.map(<[_]>::len),
		Some(omp_agent::directors::plan::PLAN_TOOLS.len())
	);
	world.remove_director("plan");
	world.stack.apply_binds(world.session.dom(), &con);
	assert_eq!(con.get("ai_prompt_mode"), Some(omp_con::Value::Str("".into())));
	assert!(omp_agent::SV_TOOLS.get(&con).is_empty(), "exit restores the full roster");
}

#[test]
fn plan_yolo_handoff_exits_writes_the_target_model_and_continues() {
	let mut world = Harness::new();
	world.engage(Plan::new(PLAN_FILE).with_yolo("test/impl", Some("low".into())));
	world.set_state("plan", "plan_written", BindValue::Bool(true));
	world.set_state("plan", "decision_made", BindValue::Bool(true));
	assert!(matches!(world.turn("plan presented", &[], 0), LoopDecision::Continue { .. }));
	assert!(!world.active().iter().any(|&id| id == "plan"), "plan exited");
	let writes = omp_session::components::con::con_writes(world.session.dom());
	assert!(
		writes
			.iter()
			.any(|write| write.name.as_str() == "ai_model" && write.value.contains("test/impl")),
		"{writes:?}"
	);
	assert!(
		writes
			.iter()
			.any(|write| write.name.as_str() == "ai_thinking"),
		"{writes:?}"
	);
	assert!(
		world
			.developer_texts()
			.iter()
			.any(|text| text.contains("Implementing now with test/impl")),
	);
}

#[test]
fn test_todo_reminder_sees_empty_plan_scope_not_pending_root_items() {
	let mut world = Harness::new();
	world.add_todo("root work");
	world.engage(TodoReminder::new(3));
	world.engage(Plan::new(PLAN_FILE));
	world.turn("stall", &[], 0);
	let texts = world.developer_texts();
	assert!(texts.iter().any(|text| text.contains(PLAN_FILE)));
	assert!(!texts.iter().any(|text| text.contains("Todo items remain")));
}
