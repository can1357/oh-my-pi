//! Global working-directory ordering at the export command boundary.

use std::{fs, process::Command};

use omp_session::{ComponentRegistry, Session};

#[test]
fn cwd_is_applied_before_export_session_resolution() {
	let scratch = tempfile::tempdir().expect("scratch directory");
	let launch = scratch.path().join("launch");
	let project = scratch.path().join("project");
	let data = scratch.path().join("data");
	let config = scratch.path().join("config");
	fs::create_dir_all(&launch).expect("launch directory");
	fs::create_dir_all(&project).expect("project directory");
	fs::create_dir_all(&config).expect("config directory");
	let canonical_project = project.canonicalize().expect("canonical project");
	let sessions = omp_env::project_state::directory(&data, &canonical_project)
		.expect("project state directory")
		.join("sessions");
	fs::create_dir_all(&sessions).expect("sessions directory");
	let journal = sessions.join("01ARZ3NDEKTSV4RRFFQ69G5FAV.oms");
	let mut session = Session::create(&journal, ComponentRegistry::standard()).expect("session");
	session.begin_turn().expect("turn");
	session
		.user("cwd export", Vec::new())
		.expect("user message");
	drop(session);

	let output = Command::new(env!("CARGO_BIN_EXE_omp"))
		.current_dir(&launch)
		.env("OMP_DATA_DIR", &data)
		.env("OMP_CONFIG_DIR", &config)
		.args([
			"--cwd",
			project.to_str().expect("UTF-8 project path"),
			"--export",
			"01ARZ3NDEKTSV4RRFFQ69G5FAV",
		])
		.output()
		.expect("run omp export");
	assert!(output.status.success(), "export failed: {}", String::from_utf8_lossy(&output.stderr));
	let exported = project.join("omp-session-01ARZ3NDEKTSV4RRFFQ69G5FAV.html");
	assert!(exported.is_file());
	let html = fs::read_to_string(exported).expect("HTML export");
	assert!(html.starts_with("<!doctype html>"));
	assert!(html.contains("cwd export"));
	assert!(
		!launch
			.join("omp-session-01ARZ3NDEKTSV4RRFFQ69G5FAV.html")
			.exists()
	);
}
