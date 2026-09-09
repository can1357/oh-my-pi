//! ADR 0003 Appendix A regressions exercised through real DOM components.

use omp_core::Str;
use omp_proto::thread::v1::{item, part};
use omp_session::{
	ComponentRegistry, Session,
	components::lifecycle::{
		checkpoints, deferred_tools, plan_mode_active, process_exit_observed, roster,
		session_switch_count, turn_number,
	},
	project_thread,
};
use serde_json::value::RawValue;

fn session(path: &std::path::Path) -> Session {
	Session::create(path, ComponentRegistry::default()).expect("session creates")
}

fn raw(value: serde_json::Value) -> Box<RawValue> {
	serde_json::value::to_raw_value(&value).expect("test JSON serializes")
}

fn run_component_tool(session: &mut Session, name: &str, outcome: serde_json::Value) {
	let call = session
		.call(name, 1, format!("{name}-call"), None, Some(raw(serde_json::json!({}))), None)
		.expect("component tool call appends");
	session
		.settle(call, raw(outcome))
		.expect("component tool result appends");
}

fn last_message_text(session: &Session) -> Option<String> {
	project_thread(session.dom())
		.into_iter()
		.rev()
		.find_map(|item| match item.kind? {
			item::Kind::Message(message) => {
				message.parts.into_iter().find_map(|part| match part.kind? {
					part::Kind::Text(text) => Some(text),
					_ => None,
				})
			},
			_ => None,
		})
}

#[test]
fn checkpoint_survives_to_fork() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let source = directory.path().join("source.oms");
	let fork = directory.path().join("fork.oms");
	let mut original = session(&source);
	original.begin_turn().expect("turn starts");
	run_component_tool(
		&mut original,
		"checkpoint",
		serde_json::json!({"action":"created","checkpoints":[{"label":"stash-1"}]}),
	);
	assert_eq!(checkpoints(original.dom()), [Str::new_static("stash-1")]);
	drop(original);
	std::fs::copy(&source, &fork).expect("journal copies to fork");
	let forked = Session::open(fork, ComponentRegistry::default()).expect("fork opens");
	assert_eq!(checkpoints(forked.dom()), [Str::new_static("stash-1")]);
}

#[test]
fn plan_mode_restriction_is_gone_after_rewind_before_engagement() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("plan.oms");
	let mut world = session(&path);
	let before = world.begin_turn().expect("turn starts");
	run_component_tool(&mut world, "plan-mode", serde_json::json!({"active":true}));
	assert!(plan_mode_active(world.dom()));
	world.rewind(before).expect("rewind succeeds");
	assert!(!plan_mode_active(world.dom()));
	world.begin_turn().expect("branch is made durable");
	drop(world);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	assert!(!plan_mode_active(restored.dom()));
}

#[test]
fn turn_counter_is_derived_after_rewind() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut world = session(&directory.path().join("turn-counter.oms"));
	let turn_one = world.begin_turn().expect("turn one");
	world.begin_turn().expect("turn two");
	world.begin_turn().expect("turn three");
	assert_eq!(turn_number(world.dom()), 3);
	world.rewind(turn_one).expect("rewind to first turn");
	world.begin_turn().expect("replacement second turn");
	assert_eq!(turn_number(world.dom()), 2);
}

#[test]
fn dynamically_registered_tool_roster_is_rederived_per_branch() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("tools.oms");
	let mut world = session(&path);
	let root = world.begin_turn().expect("turn starts");
	run_component_tool(&mut world, "dynamic-tools", serde_json::json!({"tools":["calculator"]}));
	assert_eq!(roster(world.dom()), [Str::new_static("calculator")]);
	world.rewind(root).expect("rewind before registration");
	world.begin_turn().expect("branch turn starts");
	run_component_tool(&mut world, "dynamic-tools", serde_json::json!({"tools":["search"]}));
	assert_eq!(roster(world.dom()), [Str::new_static("search")]);
	drop(world);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(roster(restored.dom()), [Str::new_static("search")]);
}

#[test]
fn save_from_abandoned_branch_never_returns() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("save.oms");
	let mut world = session(&path);
	let root = world.begin_turn().expect("turn starts");
	run_component_tool(
		&mut world,
		"checkpoint",
		serde_json::json!({"action":"created","checkpoints":[{"label":"abandoned-save"}]}),
	);
	assert_eq!(checkpoints(world.dom()), [Str::new_static("abandoned-save")]);
	world.rewind(root).expect("rewind before save");
	world.begin_turn().expect("branch is made durable");
	drop(world);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	assert!(checkpoints(restored.dom()).is_empty());
}

#[test]
fn last_message_means_last_on_live_chain() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("last-message.oms");
	let mut world = session(&path);
	let first_turn = world.begin_turn().expect("first turn");
	world.user("abandoned", Vec::new()).expect("old message");
	world.rewind(first_turn).expect("rewind before old message");
	world.begin_turn().expect("new branch turn");
	world
		.user("selected", Vec::new())
		.expect("selected message");
	assert_eq!(last_message_text(&world).as_deref(), Some("selected"));
	drop(world);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(last_message_text(&restored).as_deref(), Some("selected"));
}

#[test]
fn deferred_tool_activation_is_rederived() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut world = session(&directory.path().join("deferred.oms"));
	let root = world.begin_turn().expect("turn starts");
	run_component_tool(&mut world, "discover-tools", serde_json::json!({"tools":["calculator"]}));
	assert_eq!(deferred_tools(world.dom()), [Str::new_static("calculator")]);
	world.rewind(root).expect("rewind before discovery");
	assert!(deferred_tools(world.dom()).is_empty());
}

#[test]
fn session_switch_is_not_process_exit() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let first_path = directory.path().join("first.oms");
	let second_path = directory.path().join("second.oms");
	let mut first = session(&first_path);
	first.begin_turn().expect("turn starts");
	run_component_tool(
		&mut first,
		"checkpoint",
		serde_json::json!({"action":"created","checkpoints":[{"label":"dirty-worktree"}]}),
	);
	first.session_switch().expect("session switch records");
	assert_eq!(session_switch_count(first.dom()), 1);
	assert!(!process_exit_observed(first.dom()));
	drop(first);

	let mut second = session(&second_path);
	second
		.record_exit(omp_session::ExitCause::Normal)
		.expect("process exit records separately");
	assert!(process_exit_observed(second.dom()));
	let restored = Session::open(first_path, ComponentRegistry::default()).expect("first restores");
	assert_eq!(checkpoints(restored.dom()), [Str::new_static("dirty-worktree")]);
	assert_eq!(session_switch_count(restored.dom()), 1);
	assert!(!process_exit_observed(restored.dom()));
}

#[test]
fn live_and_restored_state_read_the_same_entries() {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let path = directory.path().join("restore.oms");
	let mut live = session(&path);
	live.begin_turn().expect("turn starts");
	live.user("same", Vec::new()).expect("message appends");
	run_component_tool(&mut live, "dynamic-tools", serde_json::json!({"tools":["read","bash"]}));
	let live_snapshot = live.dom().snapshot();
	let live_projection = project_thread(live.dom());
	let live_roster = roster(live.dom());
	let live_turn = turn_number(live.dom());
	drop(live);
	let restored = Session::open(path, ComponentRegistry::default()).expect("session restores");
	assert_eq!(restored.dom().snapshot().as_bytes(), live_snapshot.as_bytes());
	assert_eq!(project_thread(restored.dom()), live_projection);
	assert_eq!(roster(restored.dom()), live_roster);
	assert_eq!(turn_number(restored.dom()), live_turn);
}
