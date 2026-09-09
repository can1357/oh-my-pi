use omp_agent::{
	LoopDecision,
	directors::{
		autoresearch::Autoresearch,
		loop_mode::LoopMode,
		vibe::{VIBE_TOOLS, Vibe},
	},
};

use crate::harness::{Call, Harness};

#[test]
fn test_autoresearch_resumes_logged_experiments_then_exits_at_cap() {
	let mut world = Harness::new();
	world.engage(Autoresearch::new("test", Some(2)));
	assert!(matches!(
		world.turn("", &[Call::new("log_experiment", serde_json::json!({"keep": true}))], 0),
		LoopDecision::Continue { .. }
	));
	assert!(matches!(
		world.turn("", &[Call::new("log_experiment", serde_json::json!({"keep": false}))], 0),
		LoopDecision::Continue { .. }
	));
	world.turn("waiting", &[], 0);
	assert!(!world.active().iter().any(|&id| id == "autoresearch"));
	assert_eq!(
		world
			.developer_texts()
			.iter()
			.filter(|text| text.contains("Resume"))
			.count(),
		2,
	);
}

#[test]
fn test_autoresearch_does_not_resume_across_pending_user_input() {
	let mut world = Harness::new();
	world.engage(Autoresearch::new("wait for user", None));
	world.add_pending_ask();
	assert_eq!(
		world.turn("", &[Call::new("log_experiment", serde_json::json!({}))], 0),
		LoopDecision::Yield,
	);
	assert_eq!(world.state_bool("autoresearch", "armed"), Some(true));
	assert_eq!(world.state_int("autoresearch", "iterations"), Some(0));
}

#[test]
fn test_loop_replays_at_idle_exactly_count_times_then_exits() {
	let mut world = Harness::new();
	world.engage(LoopMode::new("again", Some(2)));
	world.turn("one", &[], 0);
	world.turn("two", &[], 0);
	world.turn("three", &[], 0);
	assert!(!world.active().iter().any(|&id| id == "loop_mode"));
	assert_eq!(
		world
			.developer_texts()
			.iter()
			.filter(|text| text.as_str() == "again")
			.count(),
		2
	);
}

#[test]
fn test_vibe_task_is_anchored_and_workers_outlive_director() {
	let mut world = Harness::new();
	world.add_pending_wake();
	let jobs_before = world.session.dom().count("jobs job").unwrap();
	world.engage(Vibe::new());
	assert_eq!(world.state_str("vibe", "tool").as_deref(), Some("task"));
	assert!(VIBE_TOOLS.contains(&"task"));
	assert!(VIBE_TOOLS.contains(&"hub"));
	assert!(!VIBE_TOOLS.iter().any(|name| name.starts_with("vibe")));
	world.remove_director("vibe");
	assert_eq!(world.session.dom().count("jobs job").unwrap(), jobs_before);
}

#[test]
fn test_vibe_loop_claim_queues_loop_mode() {
	let mut world = Harness::new();
	world.engage(Vibe::new());
	world.engage(LoopMode::new("again", None));
	assert_eq!(world.active(), vec!["vibe"]);
	assert_eq!(world.queued(), vec!["loop_mode"]);
}
