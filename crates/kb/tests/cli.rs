//!Integration tests for the omp-kb CLI.

use std::{
	fs,
	path::Path,
	process::{Command, Output},
};

use serde_json::Value;
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) {
	let output = Command::new("git")
		.args(args)
		.current_dir(root)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn repo(name: &str, lib: &str, worker: Option<&str>) -> TempDir {
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir(dir.path().join("src")).unwrap();
	fs::write(
		dir.path().join("Cargo.toml"),
		format!("[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
	)
	.unwrap();
	fs::write(
		dir.path().join("Cargo.lock"),
		format!("version = 4\n\n[[package]]\nname = \"{name}\"\nversion = \"0.1.0\"\n"),
	)
	.unwrap();
	fs::write(dir.path().join("src/lib.rs"), lib).unwrap();
	if let Some(worker) = worker {
		fs::write(dir.path().join("src/worker.rs"), worker).unwrap();
	}
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

/// Every spawn gets private build artifacts and an offline `CARGO_HOME`.
/// Keep target output in `.git` too: a hosted runner has no inherited external
/// target directory, and rust-analyzer otherwise creates unignored `target/`
/// files that the source snapshot correctly treats as changes during indexing.
/// Without a private Cargo home, rust-analyzer's metadata and build-script
/// checks queue on the host-global
/// `~/.cargo` package-cache lock behind every other cargo on a shared
/// self-hosted Mac: one SCIP run measured 58s blocked in metadata and 84s in
/// build scripts for about 3s of analysis.
fn kb(root: &Path) -> Command {
	let mut command = Command::new(env!("CARGO_BIN_EXE_omp-kb"));
	command
		.arg("--repo")
		.arg(root)
		.env("CARGO_HOME", root.join(".git/cargo-home"))
		.env("CARGO_TARGET_DIR", root.join(".git/cargo-target"))
		.env("CARGO_NET_OFFLINE", "true");
	command
}

fn command(root: &Path, args: &[&str]) -> Output {
	kb(root).args(args).output().unwrap()
}

fn success(output: Output) -> Value {
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	serde_json::from_slice(&output.stdout).unwrap()
}

fn query(root: &Path, symbol: &str) -> Value {
	success(command(root, &["query", symbol]))
}

fn object(root: &Path, pointer: &[u8]) -> Vec<u8> {
	let head: Value = serde_json::from_slice(pointer).unwrap();
	let digest = head["digest"].as_str().expect("content-addressed head");
	let bytes = fs::read(
		root
			.join(".git/omp-kb/objects")
			.join(format!("{digest}.json")),
	)
	.unwrap();
	assert_eq!(omp_core::Hash32::sum(&bytes).to_string(), digest);
	bytes
}

#[test]
#[cfg(unix)]
fn indexes_calls_implementations_and_preserves_last_good_snapshot() {
	let dir = repo(
		"kb-fixture",
		"pub mod worker;\n\npub trait Greet {\n    fn greet(&self) -> u32;\n}\n\npub fn helper() -> \
		 u32 { 42 }\n\npub fn entry() -> u32 {\n    worker::Worker.greet() + helper()\n}\n",
		Some(
			"use crate::{Greet, helper};\n\npub struct Worker;\n\nimpl Greet for Worker {\n    fn \
			 greet(&self) -> u32 { helper() }\n}\n",
		),
	);
	let root = dir.path();
	success(command(root, &["update"]));
	assert!(!root.join("target").exists(), "SCIP build output must not enter the source tree");
	let index = root.join(".git/omp-kb/index.json");
	let first = fs::read(&index).unwrap();
	let first_object = object(root, &first);
	let helper = query(root, "helper");
	assert_eq!(helper["source"], "indexed");
	assert_eq!(helper["stale"], false);
	assert_eq!(helper["results"][0]["definitions"][0]["path"], "src/lib.rs");
	assert_eq!(helper["results"][0]["definitions"][0]["line"], 7);
	assert!(
		helper["results"][0]["references"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["path"] == "src/worker.rs" && v["line"] == 6)
	);
	let callers = helper["results"][0]["callers"].as_array().unwrap();
	assert!(
		callers
			.iter()
			.any(|v| v["name"] == "entry" && v["line"] == 10)
	);
	assert!(
		callers
			.iter()
			.any(|v| v["name"] == "greet" && v["line"] == 6)
	);
	assert!(!callers.iter().any(|v| v["line"] == 1));
	let greet = query(root, "Greet");
	assert!(
		greet["results"][0]["implementations"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["name"] == "Worker" && v["path"] == "src/worker.rs")
	);
	let methods = query(root, "greet");
	let trait_method = methods["results"]
		.as_array()
		.unwrap()
		.iter()
		.find(|result| result["symbol"].as_str().unwrap().contains("Greet#greet()"))
		.unwrap();
	assert!(
		trait_method["implementations"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["name"] == "greet" && v["path"] == "src/worker.rs" && v["line"] == 6)
	);
	assert!(
		trait_method["callers"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["name"] == "entry" && v["line"] == 10)
	);
	assert!(
		trait_method["references"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["path"] == "src/lib.rs" && v["line"] == 10)
	);
	let entry = query(root, "entry");
	assert!(
		entry["results"][0]["callees"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["name"] == "helper" && v["line"] == 10)
	);
	assert_eq!(query(root, "no_such_symbol")["miss"], true);
	let digest: Value = serde_json::from_slice(&first).unwrap();
	fs::write(
		root
			.join(".git/omp-kb/objects")
			.join(format!("{}.json", digest["digest"].as_str().unwrap())),
		b"corrupt",
	)
	.unwrap();
	assert!(
		!command(root, &["query", "helper"]).status.success(),
		"a corrupt object must not be served"
	);
	success(command(root, &["update"]));
	assert_eq!(first, fs::read(&index).unwrap(), "index must be byte-stable");
	assert_eq!(
		first_object,
		object(root, &fs::read(&index).unwrap()),
		"an update must repair a corrupt cache object"
	);
	let failed = kb(root)
		.arg("update")
		.env("RUST_ANALYZER", "/usr/bin/false")
		.output()
		.unwrap();
	assert!(!failed.status.success());
	assert_eq!(first, fs::read(&index).unwrap(), "failed analyzer must not publish");
	assert_eq!(first_object, object(root, &fs::read(&index).unwrap()));
	let empty = kb(root)
		.arg("update")
		.env("RUST_ANALYZER", "/usr/bin/true")
		.output()
		.unwrap();
	assert!(!empty.status.success(), "an empty SCIP must not replace the index");
	assert_eq!(first, fs::read(&index).unwrap());
	let killed_analyzer = root.join(".git/killed-analyzer.sh");
	fs::write(&killed_analyzer, "#!/bin/sh\nkill -TERM $$\n").unwrap();
	use std::os::unix::fs::PermissionsExt;
	fs::set_permissions(&killed_analyzer, fs::Permissions::from_mode(0o755)).unwrap();
	let killed = kb(root)
		.arg("update")
		.env("RUST_ANALYZER", &killed_analyzer)
		.output()
		.unwrap();
	assert!(!killed.status.success());
	assert_eq!(first, fs::read(&index).unwrap(), "a killed analyzer must not publish");
	assert_eq!(first_object, object(root, &fs::read(&index).unwrap()));
	let live = success(command(root, &["query", "helper", "--live"]));
	assert_eq!(live["source"], "live");
	assert_eq!(first, fs::read(&index).unwrap(), "live query must not publish");
	fs::write(
		root.join("src/worker.rs"),
		"use crate::{Greet, helper};\n\npub struct Worker;\n\nimpl Greet for Worker {\n    fn \
		 greet(&self) -> u32 { helper() + 1 }\n}\n",
	)
	.unwrap();
	assert_eq!(query(root, "helper")["stale"], true);
	let slow = root.join("slow-analyzer.sh");
	let started = root.join(".git/slow-started");
	let finished = root.join(".git/slow-finished");
	fs::write(
		&slow,
		format!(
			"#!/bin/sh\ntouch '{}'\nsleep 3\ntouch '{}'\nexit 1\n",
			started.display(),
			finished.display()
		),
	)
	.unwrap();
	fs::set_permissions(&slow, fs::Permissions::from_mode(0o755)).unwrap();
	let refresh = kb(root)
		.args(["refresh", "src/worker.rs"])
		.env("RUST_ANALYZER", &slow)
		.output()
		.unwrap();
	success(refresh);
	// `refresh` must return before the analyzer's sleep finishes. The start
	// marker can still land later: the detached update is scheduled beside the
	// rest of the suite, and on a busy self-hosted Mac that exceeded the old
	// 2s poll (run 41351939491).
	assert!(!finished.exists(), "refresh must not wait for the analyzer");
	for _ in 0..1500 {
		if started.exists() {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
	assert!(
		started.exists(),
		"detached refresh did not start the analyzer\n{}",
		fs::read_to_string(root.join(".git/omp-kb/refresh.log")).unwrap_or_default()
	);
	assert_eq!(query(root, "helper")["stale"], true);
	assert_eq!(first, fs::read(&index).unwrap(), "refresh must keep serving the last good index");
	for _ in 0..200 {
		if finished.exists() {
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
	assert!(finished.exists());
	fs::remove_file(&slow).unwrap();
	success(command(root, &["refresh", "src/worker.rs"]));
	let mut refreshed = false;
	for _ in 0..600 {
		if query(root, "helper")["stale"] == false {
			refreshed = true;
			break;
		}
		std::thread::sleep(std::time::Duration::from_millis(100));
	}
	assert!(refreshed, "detached refresh must publish updated content");
	fs::write(root.join("new-file.rs"), "pub fn added() {}\n").unwrap();
	assert_eq!(query(root, "helper")["stale"], true, "an untracked file must mark the index stale");
	fs::remove_file(root.join("new-file.rs")).unwrap();
	assert_eq!(query(root, "helper")["stale"], false);
	git(root, &[
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"new revision",
	]);
	assert_eq!(query(root, "helper")["stale"], true, "a changed HEAD must mark the index stale");
}

#[test]
fn works_in_a_second_repository() {
	let dir = repo("kb-other", "pub fn other() -> u8 { 7 }\n", None);
	success(command(dir.path(), &["update"]));
	let result = query(dir.path(), "other");
	assert_eq!(result["results"][0]["definitions"][0]["line"], 1);
	assert_eq!(result["stale"], false);
}

#[test]
fn indexes_impls_for_reference_and_primitive_types() {
	let dir = repo(
		"kb-reference",
		"pub trait Magic {\n    fn magic(&self) -> u32;\n}\n\nimpl Magic for &u32 {\n    fn \
		 magic(&self) -> u32 { **self }\n}\n",
		None,
	);
	success(command(dir.path(), &["update"]));
	let result = query(dir.path(), "Magic");
	assert!(
		result["results"][0]["implementations"]
			.as_array()
			.unwrap()
			.iter()
			.any(|v| v["name"] == "&u32" && v["path"] == "src/lib.rs" && v["line"] == 5)
	);
}

#[test]
fn indexes_a_repository_without_a_committed_lockfile() {
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir(dir.path().join("src")).unwrap();
	fs::write(
		dir.path().join("Cargo.toml"),
		"[package]\nname = \"kb-no-lock\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
	)
	.unwrap();
	fs::write(dir.path().join("src/lib.rs"), "pub fn unlocked() -> u8 { 1 }\n").unwrap();
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
	success(command(dir.path(), &["update"]));
	assert_eq!(query(dir.path(), "unlocked")["results"][0]["definitions"][0]["line"], 1);
}
