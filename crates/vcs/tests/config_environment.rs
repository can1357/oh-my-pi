#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

use omp_vcs::{git::GitRepo, types::CommitOptions};

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

#[test]
fn commit_obeys_git_configuration_environment() {
	if let Ok(phase) = std::env::var("OMP_VCS_CONFIG_TEST_PHASE") {
		let root = std::env::var("OMP_VCS_CONFIG_TEST_ROOT").unwrap();
		let repo = GitRepo::require(Path::new(&root).join("repo").as_path()).unwrap();
		let options = CommitOptions { allow_empty: true, ..Default::default() };
		match phase.as_str() {
			"hook" => {
				let error = repo.commit_create("blocked", &options).unwrap_err();
				assert!(error.to_string().contains("alt-hook-refused"), "{error}");
			},
			"global" | "system" | "identity" => {
				repo.commit_create(&phase, &options).unwrap();
			},
			"nosystem" => {
				let error = repo.commit_create("must fail", &options).unwrap_err();
				assert!(error.to_string().contains("identity is not configured"), "{error}");
			},
			_ => panic!("unknown test phase"),
		}
		return;
	}

	let temp = tempfile::tempdir().unwrap();
	let root = temp.path();
	let checkout = root.join("repo");
	let xdg = root.join("xdg");
	let hooks = root.join("alt-hooks");
	fs::create_dir_all(&checkout).unwrap();
	fs::create_dir_all(xdg.join("git")).unwrap();
	fs::create_dir_all(&hooks).unwrap();
	git(&checkout, &["init", "-q"]);
	fs::write(checkout.join("file"), "content\n").unwrap();
	git(&checkout, &["add", "file"]);
	git(&checkout, &[
		"-c",
		"user.name=Base",
		"-c",
		"user.email=base@example.invalid",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-qm",
		"base",
	]);
	fs::write(checkout.join("file"), "changed\n").unwrap();
	git(&checkout, &["add", "file"]);
	fs::write(xdg.join("git/config"), "[user]\n name = A\n email = a@example.invalid\n").unwrap();
	let global = root.join("alt.gitconfig");
	fs::write(
		&global,
		format!(
			"[user]\n name = B\n email = b@example.invalid\n[core]\n hooksPath = {}\n",
			hooks.display()
		),
	)
	.unwrap();
	let system = root.join("system.gitconfig");
	fs::write(&system, "[user]\n name = S\n email = s@example.invalid\n").unwrap();
	let hook = hooks.join("commit-msg");
	fs::write(&hook, "#!/bin/sh\necho alt-hook-refused >&2\nexit 1\n").unwrap();
	fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

	let run = |phase: &str, global_path: &Path, no_system: bool| {
		let mut child = Command::new(std::env::current_exe().unwrap());
		child
			.args(["--exact", "commit_obeys_git_configuration_environment", "--nocapture"])
			.env("OMP_VCS_CONFIG_TEST_PHASE", phase)
			.env("OMP_VCS_CONFIG_TEST_ROOT", root)
			.env("HOME", root)
			.env("XDG_CONFIG_HOME", &xdg)
			.env("GIT_CONFIG_GLOBAL", global_path)
			.env("GIT_CONFIG_SYSTEM", &system)
			.env_remove("GIT_CONFIG_COUNT")
			.env_remove("GIT_CONFIG_PARAMETERS")
			.env_remove("GIT_AUTHOR_NAME")
			.env_remove("GIT_AUTHOR_EMAIL")
			.env_remove("GIT_COMMITTER_NAME")
			.env_remove("GIT_COMMITTER_EMAIL")
			.env_remove("EMAIL");
		if no_system {
			child.env("GIT_CONFIG_NOSYSTEM", "1");
		} else {
			child.env_remove("GIT_CONFIG_NOSYSTEM");
		}
		if phase == "identity" {
			child
				.env("GIT_AUTHOR_NAME", "Env Author")
				.env("GIT_AUTHOR_EMAIL", "author@example.invalid");
			child
				.env("GIT_COMMITTER_NAME", "Env Committer")
				.env("GIT_COMMITTER_EMAIL", "committer@example.invalid");
		}
		let output = child.output().unwrap();
		assert!(
			output.status.success(),
			"{phase}: {} {}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);
	};
	let head = git(&checkout, &["rev-parse", "HEAD"]);
	run("hook", &global, true);
	assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head);
	fs::remove_file(hook).unwrap();
	run("global", &global, true);
	assert_eq!(
		git(&checkout, &["show", "-s", "--format=%an <%ae> | %cn <%ce>", "HEAD"]),
		"B <b@example.invalid> | B <b@example.invalid>"
	);
	run("identity", &global, true);
	assert_eq!(
		git(&checkout, &["show", "-s", "--format=%an <%ae> | %cn <%ce>", "HEAD"]),
		"Env Author <author@example.invalid> | Env Committer <committer@example.invalid>"
	);
	run("system", Path::new("/dev/null"), false);
	assert_eq!(
		git(&checkout, &["show", "-s", "--format=%an <%ae> | %cn <%ce>", "HEAD"]),
		"S <s@example.invalid> | S <s@example.invalid>"
	);
	let head = git(&checkout, &["rev-parse", "HEAD"]);
	run("nosystem", Path::new("/dev/null"), true);
	assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head);
}
