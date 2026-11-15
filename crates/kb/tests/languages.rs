use std::{fs, path::Path, process::Command};

use serde_json::Value;
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) {
	let output = Command::new("git")
		.current_dir(root)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

fn repository(name: &str, source: &str) -> TempDir {
	let dir = tempfile::tempdir().unwrap();
	fs::write(dir.path().join(name), source).unwrap();
	git(dir.path(), &["init", "-q"]);
	git(dir.path(), &["add", "."]);
	git(dir.path(), &[
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	dir
}

fn command(root: &Path, args: &[&str]) -> std::process::Output {
	Command::new(env!("CARGO_BIN_EXE_omp-kb"))
		.arg("--repo")
		.arg(root)
		.args(args)
		.env("OMP_KB_SCIP_PYTHON", "/nonexistent/omp-kb-scip-python")
		.env("OMP_KB_SCIP_TYPESCRIPT", "/nonexistent/omp-kb-scip-typescript")
		.env("RUST_ANALYZER", "/nonexistent/omp-kb-rust-analyzer")
		.output()
		.unwrap()
}

#[test]
fn python_without_producer_has_syntactic_definitions_and_calls() {
	let repo = repository(
		"app.py",
		"def helper():
    return 42

def entry():
    return helper()
",
	);
	let output = command(repo.path(), &["update"]);
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	let output = command(repo.path(), &["query", "helper"]);
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["source"], "syntactic");
	assert_eq!(result["results"][0]["definitions"][0]["path"], "app.py");
	assert_eq!(result["results"][0]["definitions"][0]["line"], 1);
	assert_eq!(result["results"][0]["callers"][0]["name"], "entry");
}

#[test]
fn failed_refresh_marks_the_last_good_index_stale() {
	let repo = repository("app.py", "def helper():\n    return 42\n");
	assert!(command(repo.path(), &["update"]).status.success());
	let output = Command::new(env!("CARGO_BIN_EXE_omp-kb"))
		.arg("--repo")
		.arg(repo.path())
		.args(["refresh", "app.py"])
		.env("OMP_KB_SCIP_PYTHON", "/usr/bin/false")
		.output()
		.unwrap();
	assert!(output.status.success());
	let output = command(repo.path(), &["query", "helper"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["stale"], true);
	assert_eq!(result["results"][0]["definitions"][0]["line"], 1);
}

#[test]
fn javascript_without_producer_indexes_calls() {
	let repo = repository(
		"main.js",
		"function helper() { return 3; }\nfunction entry() { return helper(); }\n",
	);
	assert!(command(repo.path(), &["update"]).status.success());
	let output = command(repo.path(), &["query", "helper"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["source"], "syntactic");
	assert_eq!(result["results"][0]["definitions"][0]["path"], "main.js");
	assert_eq!(result["results"][0]["callers"][0]["name"], "entry");
}

#[test]
fn failed_producer_keeps_previous_bytes() {
	let repo = repository("app.py", "def helper():\n    return 42\n");
	assert!(command(repo.path(), &["update"]).status.success());
	let head_path = repo.path().join(".git/omp-kb/index.json");
	let head = fs::read(&head_path).unwrap();
	let metadata: Value = serde_json::from_slice(&head).unwrap();
	let object_path = repo
		.path()
		.join(".git/omp-kb/objects")
		.join(format!("{}.json", metadata["digest"].as_str().unwrap()));
	let object = fs::read(&object_path).unwrap();
	assert!(command(repo.path(), &["update"]).status.success());
	assert_eq!(fs::read(&head_path).unwrap(), head);
	assert_eq!(fs::read(&object_path).unwrap(), object);
	let failed = Command::new(env!("CARGO_BIN_EXE_omp-kb"))
		.arg("--repo")
		.arg(repo.path())
		.arg("update")
		.env("OMP_KB_SCIP_PYTHON", "/usr/bin/false")
		.output()
		.unwrap();
	assert!(!failed.status.success());
	assert_eq!(fs::read(&head_path).unwrap(), head);
	assert_eq!(fs::read(&object_path).unwrap(), object);
}

#[test]
fn rust_without_producer_reports_trait_implementations() {
	let repo = repository(
		"lib.rs",
		"trait Greet { fn greet(&self); }\nstruct Worker;\nimpl Greet for Worker { fn greet(&self) \
		 {} }\n",
	);
	assert!(command(repo.path(), &["update"]).status.success());
	let output = command(repo.path(), &["query", "Greet"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["source"], "syntactic");
	assert_eq!(result["results"][0]["implementations"][0]["name"], "Worker");
	assert_eq!(result["results"][0]["implementations"][0]["line"], 3);
}

fn install_producer(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
	let dir = tempfile::tempdir().unwrap();
	let sample = dir.path().join("sample.scip");
	fs::write(&sample, bytes).unwrap();
	let program = dir.path().join("producer");
	let script = format!(
		"#!/bin/sh\nprev=\nfor arg in \"$@\"; do\n\tif [ \"$prev\" = \"--output\" ]; then\n\t\tcp \
		 \"{}\" \"$arg\"\n\t\texit 0\n\tfi\n\tprev=$arg\ndone\nexit 1\n",
		sample.display()
	);
	fs::write(&program, script).unwrap();
	let mut permissions = fs::metadata(&program).unwrap().permissions();
	use std::os::unix::fs::PermissionsExt;
	permissions.set_mode(0o755);
	fs::set_permissions(&program, permissions).unwrap();
	(dir, program)
}

fn produced(root: &Path, env: &str, program: &Path, args: &[&str]) -> std::process::Output {
	Command::new(env!("CARGO_BIN_EXE_omp-kb"))
		.arg("--repo")
		.arg(root)
		.args(args)
		.env(env, program)
		.env("RUST_ANALYZER", "/nonexistent/omp-kb-rust-analyzer")
		.env("OMP_KB_SCIP_TYPESCRIPT", "/nonexistent/omp-kb-scip-typescript")
		.env("OMP_KB_SCIP_PYTHON", "/nonexistent/omp-kb-scip-python")
		.env(env, program)
		.output()
		.unwrap()
}

fn index_bytes(root: &Path) -> Vec<u8> {
	let head: Value =
		serde_json::from_slice(&fs::read(root.join(".git/omp-kb/index.json")).unwrap()).unwrap();
	let digest = head["digest"].as_str().unwrap();
	fs::read(root.join(format!(".git/omp-kb/objects/{digest}.json"))).unwrap()
}

#[test]
fn typescript_scip_fixture_is_ingested_and_stable() {
	let repo = tempfile::tempdir().unwrap();
	fs::create_dir(repo.path().join("src")).unwrap();
	fs::write(
		repo.path().join("src/lib.ts"),
		"export function helper(): number { return 1 }\nexport function entry(): number { return \
		 helper() }\n",
	)
	.unwrap();
	git(repo.path(), &["init", "-q"]);
	git(repo.path(), &["add", "."]);
	git(repo.path(), &[
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=[EMAIL]",
		"commit",
		"-qm",
		"fixture",
	]);
	let (_keep, program) = install_producer(include_bytes!("fixtures/typescript.scip"));
	let output = produced(repo.path(), "OMP_KB_SCIP_TYPESCRIPT", &program, &["update"]);
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	let first = index_bytes(repo.path());
	assert!(
		produced(repo.path(), "OMP_KB_SCIP_TYPESCRIPT", &program, &["update"])
			.status
			.success()
	);
	assert_eq!(index_bytes(repo.path()), first);
	let output = produced(repo.path(), "OMP_KB_SCIP_TYPESCRIPT", &program, &["query", "helper"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["miss"], false);
	assert_eq!(result["source"], "indexed");
	assert_eq!(result["results"][0]["definitions"][0]["path"], "src/lib.ts");
}

#[test]
fn python_scip_fixture_is_ingested() {
	let repo =
		repository("lib.py", "def helper():\n    return 1\n\ndef entry():\n    return helper()\n");
	let (_keep, program) = install_producer(include_bytes!("fixtures/python.scip"));
	let output = produced(repo.path(), "OMP_KB_SCIP_PYTHON", &program, &["update"]);
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	let output = produced(repo.path(), "OMP_KB_SCIP_PYTHON", &program, &["query", "helper"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["source"], "indexed");
	assert_eq!(result["results"][0]["definitions"][0]["path"], "lib.py");
}

/// A producer that writes build output into the work tree (rust-analyzer's
/// in-tree `target/` on a host with no `CARGO_TARGET_DIR`) changes the
/// snapshot it indexed: kb refuses to publish and names the offending path.
#[test]
fn producer_written_file_is_rejected_and_named() {
	let repo =
		repository("lib.py", "def helper():\n    return 1\n\ndef entry():\n    return helper()\n");
	let (keep, program) = install_producer(include_bytes!("fixtures/python.scip"));
	let polluting = keep.path().join("polluting-producer");
	fs::write(
		&polluting,
		format!("#!/bin/sh\ntouch build-output.txt\nexec '{}' \"$@\"\n", program.display()),
	)
	.unwrap();
	let mut permissions = fs::metadata(&polluting).unwrap().permissions();
	use std::os::unix::fs::PermissionsExt;
	permissions.set_mode(0o755);
	fs::set_permissions(&polluting, permissions).unwrap();
	let output = produced(repo.path(), "OMP_KB_SCIP_PYTHON", &polluting, &["update"]);
	assert!(!output.status.success(), "a producer that changed the repository must not publish");
	let stderr = String::from_utf8_lossy(&output.stderr);
	assert!(
		stderr.contains("repository changed while SCIP producers were running: build-output.txt"),
		"{stderr}"
	);
	assert!(!repo.path().join(".git/omp-kb/index.json").exists());
}

#[test]
fn untagged_wasm_is_not_indexed_as_rust() {
	let repo = repository("lib.rs", "fn helper() {}\n");
	fs::write(repo.path().join("app.wasm"), b"\0asm").unwrap();
	git(repo.path(), &["add", "app.wasm"]);
	git(repo.path(), &[
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=[EMAIL]",
		"commit",
		"-qm",
		"wasm",
	]);
	assert!(command(repo.path(), &["update"]).status.success());
	let text = String::from_utf8(index_bytes(repo.path())).unwrap();
	let index: Value = serde_json::from_str(&text).unwrap();
	let defines_wasm = index["symbols"]
		.as_object()
		.unwrap()
		.values()
		.any(|symbol| {
			symbol["definitions"]
				.as_array()
				.is_some_and(|defs| defs.iter().any(|def| def["path"] == "app.wasm"))
		});
	assert!(!defines_wasm, "untagged wasm has no rust provenance and is not given a definition");
	let output = command(repo.path(), &["query", "app"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["miss"], true);
}

fn wasm_fixture(tag: &str) -> TempDir {
	let repo = repository("lib.rs", "fn helper() {}\n");
	fs::write(repo.path().join("app.wasm"), b"\0asm").unwrap();
	fs::create_dir(repo.path().join(".omp")).unwrap();
	fs::write(repo.path().join(".omp/wasm-rust"), tag).unwrap();
	git(repo.path(), &["add", "app.wasm", ".omp/wasm-rust"]);
	git(repo.path(), &[
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"tag",
	]);
	repo
}

#[test]
fn failed_refresh_preserves_published_graph_after_source_edit() {
	let repo = repository("app.py", "def helper():\n    return 42\n");
	assert!(command(repo.path(), &["update"]).status.success());
	let head_path = repo.path().join(".git/omp-kb/index.json");
	let head = fs::read(&head_path).unwrap();
	let object = index_bytes(repo.path());
	fs::write(repo.path().join("app.py"), "def changed():\n    return 1\n").unwrap();
	let output = Command::new(env!("CARGO_BIN_EXE_omp-kb"))
		.arg("--repo")
		.arg(repo.path())
		.args(["refresh", "app.py"])
		.env("OMP_KB_SCIP_PYTHON", "/usr/bin/false")
		.output()
		.unwrap();
	assert!(output.status.success());
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
	let log_path = repo.path().join(".git/omp-kb/refresh.log");
	while !fs::read_to_string(&log_path)
		.unwrap_or_default()
		.contains("scip-python failed")
	{
		assert!(std::time::Instant::now() < deadline, "refresh did not fail");
		std::thread::sleep(std::time::Duration::from_millis(10));
	}
	assert_eq!(fs::read(head_path).unwrap(), head);
	assert_eq!(index_bytes(repo.path()), object);
	let output = command(repo.path(), &["query", "helper"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["stale"], true);
	assert_eq!(result["miss"], false);
	assert_eq!(result["results"][0]["definitions"][0]["path"], "app.py");
}

#[test]
fn tagged_wasm_points_to_tracked_rust_source() {
	let repo = wasm_fixture("app.wasm = lib.rs\n");
	let output = command(repo.path(), &["update"]);
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	let output = command(repo.path(), &["query", "app"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["miss"], false);
	assert_eq!(result["results"].as_array().unwrap().len(), 1);
	assert_eq!(
		result["results"][0]["definitions"]
			.as_array()
			.unwrap()
			.len(),
		1
	);
	assert_eq!(result["results"][0]["definitions"][0]["path"], "lib.rs");
	let output = command(repo.path(), &["query", "app.wasm"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert!(result["results"].as_array().unwrap().iter().all(|r| {
		r["definitions"]
			.as_array()
			.unwrap()
			.iter()
			.all(|d| d["path"] != "app.wasm")
	}));
	fs::write(repo.path().join("app.wasm"), b"changed").unwrap();
	let output = command(repo.path(), &["query", "app"]);
	let result: Value = serde_json::from_slice(&output.stdout).unwrap();
	assert_eq!(result["stale"], true);
}

#[test]
fn invalid_or_empty_wasm_tags_do_not_attribute() {
	let outside = tempfile::tempdir().unwrap();
	let outside_path = outside.path().join("outside.rs");
	fs::write(&outside_path, "fn outside() {}\n").unwrap();
	for tag in [
		String::new(),
		"app.wasm = missing.rs\n".into(),
		"app.wasm = untracked.rs\n".into(),
		"app.wasm = not-rust.txt\n".into(),
		format!("app.wasm = {}\n", outside_path.display()),
	] {
		let repo = wasm_fixture(&tag);
		fs::write(repo.path().join("untracked.rs"), "fn untracked() {}\n").unwrap();
		fs::write(repo.path().join("not-rust.txt"), "fn not_rust() {}\n").unwrap();
		git(repo.path(), &["add", "not-rust.txt"]);
		let output = command(repo.path(), &["update"]);
		assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
		let output = command(repo.path(), &["query", "app"]);
		let result: Value = serde_json::from_slice(&output.stdout).unwrap();
		assert_eq!(result["miss"], true, "tag: {tag}");
		let index: Value = serde_json::from_slice(&index_bytes(repo.path())).unwrap();
		assert!(
			index["symbols"]
				.as_object()
				.unwrap()
				.values()
				.all(|symbol| symbol["definitions"]
					.as_array()
					.unwrap()
					.iter()
					.all(|def| def["path"] != "app.wasm")),
			"tag: {tag}"
		);
	}
}
