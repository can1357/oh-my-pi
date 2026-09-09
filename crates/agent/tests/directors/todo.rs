use omp_agent::{LoopDecision, directors::todo_reminder::TodoReminder};

use crate::harness::{Call, Harness};

#[test]
fn test_nags_and_continues_on_a_stalled_turn() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.engage(TodoReminder::new(3));
	assert!(matches!(world.turn("stall", &[], 0), LoopDecision::Continue { .. }));
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(1));
	assert_eq!(world.developer_texts().len(), 1);
}

#[test]
fn test_progress_rearms_after_awaiting_progress() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.engage(TodoReminder::new(3));
	world.turn("first stall", &[], 0);
	assert_eq!(world.turn("second stall", &[], 0), LoopDecision::Yield);
	world.turn("", &[Call::new("todo", serde_json::json!({"op": "add"}))], 0);
	assert!(matches!(world.turn("third stall", &[], 0), LoopDecision::Continue { .. }));
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(2));
}

#[test]
fn test_pending_ask_skips_without_burning_a_rung() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.add_pending_ask();
	world.engage(TodoReminder::new(3));
	assert_eq!(world.turn("waiting", &[], 0), LoopDecision::Yield);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(0));
	assert!(world.developer_texts().is_empty());
}

#[test]
fn test_pending_wake_skips_without_burning_a_rung() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.add_pending_wake();
	world.engage(TodoReminder::new(3));
	assert_eq!(world.turn("waiting", &[], 0), LoopDecision::Yield);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(0));
}

#[test]
fn test_reminder_budget_comes_from_settings() {
	let mut world = Harness::new();
	world.add_todo("task");
	world.engage(TodoReminder::new(1));
	assert!(matches!(world.turn("first stall", &[], 0), LoopDecision::Continue { .. }));
	world.turn("second stall", &[], 0);
	world.turn("third stall", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(1));
	assert_eq!(world.developer_texts().len(), 1);
}

#[test]
fn test_satisfied_items_reset_budget_for_new_pending_work() {
	let mut world = Harness::new();
	world.add_todo("original");
	world.engage(TodoReminder::new(1));
	world.turn("stall", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(1));
	world.complete_todos();
	world.turn("done", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(0));
	world.add_todo("new task");
	world.turn("new stall", &[], 0);
	assert_eq!(world.state_int("todo_reminder", "attempts"), Some(1));
	assert_eq!(world.developer_texts().len(), 2);
}
