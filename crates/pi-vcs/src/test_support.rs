//! Shared git fixtures for the crate's unit tests.

use std::{ffi::OsStr, path::Path, process::Command};

/// Run git in `dir` with extra env vars; returns the raw output without
/// asserting on it.
pub(crate) fn git_output(
	dir: &Path,
	env: &[(&str, &OsStr)],
	args: &[&str],
) -> std::process::Output {
	Command::new("git")
		.current_dir(dir)
		.envs(env.iter().copied())
		.args(args)
		.output()
		.unwrap_or_else(|err| panic!("run git {args:?} in {}: {err}", dir.display()))
}

fn stdout_expecting(output: std::process::Output, args: &[&str], code: i32) -> String {
	assert_eq!(
		output.status.code(),
		Some(code),
		"git {args:?}: {}",
		String::from_utf8_lossy(&output.stderr)
	);
	String::from_utf8(output.stdout).expect("git output is UTF-8")
}

/// Run git, assert success, return stdout untrimmed.
pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
	stdout_expecting(git_output(dir, &[], args), args, 0)
}

/// Run git, assert it exits with exactly `code` (e.g. `git diff --no-index`
/// exits 1), return stdout untrimmed.
pub(crate) fn git_expecting(dir: &Path, args: &[&str], code: i32) -> String {
	stdout_expecting(git_output(dir, &[], args), args, code)
}

/// Like [`git`] with `GIT_INDEX_FILE` pointed at `index`.
pub(crate) fn git_with_index(dir: &Path, index: &Path, args: &[&str]) -> String {
	stdout_expecting(git_output(dir, &[("GIT_INDEX_FILE", index.as_os_str())], args), args, 0)
}

/// `git init -q -b main` plus a test identity. Commits nothing.
pub(crate) fn init_repo(dir: &Path) {
	git(dir, &["init", "-q", "-b", "main"]);
	git(dir, &["config", "user.name", "Test"]);
	git(dir, &["config", "user.email", "test@example.com"]);
}
