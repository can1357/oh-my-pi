//! ADR 0013 child seeding and cfg-order regression.

use std::fs;

use omp_driver::{cfg::CfgFiles, subagent::settings::child_ctx};

#[test]
fn child_uses_parent_live_then_user_and_project_spawn_cfgs() {
	let root = tempfile::tempdir().expect("scratch root");
	let user = root.path().join("user");
	let project = root.path().join("project/.omp");
	fs::create_dir_all(&user).expect("user cfg root");
	fs::create_dir_all(&project).expect("project cfg root");
	fs::write(user.join("config.cfg"), "ai_model stale\n").expect("stale main cfg");
	fs::write(user.join("subagent.cfg"), "ai_fastmode false\n").expect("user subagent cfg");
	fs::write(project.join("subagent.cfg"), "ai_fastmode true\n").expect("project subagent cfg");
	fs::write(user.join("sonic.cfg"), "ai_thinking low\n").expect("user class cfg");

	let parent = omp_con::Ctx::new();
	parent
		.run("ai_model live; ai_fastmode false; ai_thinking high")
		.expect("parent values");
	let files = CfgFiles::with_roots(user, Some(project));
	let child = child_ctx(&parent, &files, "sonic").expect("child context");

	assert_eq!(
		child
			.get_typed::<omp_core::Str>("ai_model")
			.expect("model")
			.as_str(),
		"live"
	);
	assert!(child.get_typed::<bool>("ai_fastmode").expect("fast mode"));
	assert_eq!(
		child
			.get_typed::<omp_core::Str>("ai_thinking")
			.expect("thinking")
			.as_str(),
		"low"
	);
	assert_eq!(
		parent
			.get_typed::<omp_core::Str>("ai_model")
			.expect("parent model")
			.as_str(),
		"live"
	);
}
