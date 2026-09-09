use omp_agent::{
	LoopDecision,
	directors::{
		goal::{Goal, continuation_prompt},
		loop_mode::LoopMode,
	},
};

use crate::harness::{Call, Harness};

#[test]
fn test_goal_continues_until_complete_and_accounts_tokens() {
	let mut world = Harness::new();
	world.engage(Goal::new("finish the task", None));
	assert!(matches!(
		world.turn("", &[Call::new("todo", serde_json::json!({"op": "add"}))], 11),
		LoopDecision::Continue { .. }
	));
	assert!(matches!(
		world.turn("", &[Call::new("todo", serde_json::json!({"op": "start"}))], 17),
		LoopDecision::Continue { .. }
	));
	assert_eq!(world.state_int("goal", "tokens_used"), Some(28));
	world.turn("", &[Call::new("goal", serde_json::json!({"op": "complete"}))], 23);
	assert!(!world.active().iter().any(|&id| id == "goal"));
}

#[test]
fn test_goal_holds_budget_limited_without_claiming_completion() {
	let mut world = Harness::new();
	world.engage(Goal::new("bounded work", Some(5)));
	world.turn("", &[Call::new("todo", serde_json::json!({"op": "add"}))], 9);
	assert!(world.active().iter().any(|&id| id == "goal"));
	assert_eq!(world.state_int("goal", "tokens_used"), Some(9));
	assert!(
		continuation_prompt(world.session.dom()).is_none(),
		"budget-limited goals must not arm another idle continuation"
	);
}

#[test]
fn test_goal_holds_instead_of_looping_on_prose_only_turn() {
	let mut world = Harness::new();
	world.engage(Goal::new("do not self-prompt on prose", None));
	assert_eq!(world.turn("I need user guidance", &[], 13), LoopDecision::Yield);
	assert!(world.active().iter().any(|&id| id == "goal"));
}

#[test]
fn continuation_prompt_requires_an_active_goal_and_escapes_the_objective() {
	let mut world = Harness::new();
	world.engage(Goal::new("ship <safe> & sound", Some(20)));
	let prompt = continuation_prompt(world.session.dom()).expect("active goal continues");
	assert!(prompt.contains("<objective>\nship &lt;safe&gt; &amp; sound\n</objective>"));
	assert!(prompt.contains("- Token budget: 20"));
	world.set_state("goal", "continuation_armed", omp_agent::BindValue::Bool(false));
	assert!(
		continuation_prompt(world.session.dom()).is_none(),
		"a prose-only continuation hold is durable in the Director node"
	);
	world.set_state("goal", "continuation_armed", omp_agent::BindValue::Bool(true));
	world
		.stack
		.pause(&mut world.session, "goal")
		.expect("goal pauses");
	assert!(continuation_prompt(world.session.dom()).is_none());
}

#[test]
fn test_goal_loop_claim_queues_and_promotes_a_contender() {
	let mut world = Harness::new();
	world.engage(Goal::new("finish before verification", None));
	world.engage(LoopMode::new("verify", Some(1)));
	assert_eq!(world.queued(), vec!["loop_mode"]);
	world.turn("", &[Call::new("goal", serde_json::json!({"op": "complete"}))], 4);
	assert_eq!(world.active(), vec!["loop_mode"]);
	assert!(world.queued().is_empty());
}

#[test]
fn test_goal_tool_is_unregistered_when_engagement_exits() {
	let mut world = Harness::new();
	world.engage(Goal::new("short-lived tool", None));
	assert_eq!(world.state_str("goal", "tool").as_deref(), Some("goal"));
	world.set_state("goal", "done", omp_agent::BindValue::Bool(true));
	world.turn("done", &[], 0);
	assert!(world.state_str("goal", "tool").is_none());
}
