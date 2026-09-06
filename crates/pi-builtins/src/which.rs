//! `which` builtin: locate executables in the shell's `PATH`.
//!
//! Ported from pi-shell's in-process `which` implementation.

use std::io::Write;

use brush_core::{
	ShellExtensions,
	builtins::Registration,
	pathsearch,
	sys,
};
use clap::Parser;

use crate::host::{Host, Utility, util};

/// Parsed `which` invocation.
#[derive(Parser, Debug)]
#[command(name = "which", about = "Locate a command's executable in the shell's PATH")]
pub(crate) struct WhichCli {
	/// Print all matching executables in PATH, not just the first.
	#[arg(short = 'a', long = "all")]
	all: bool,

	/// Silent (BSD): print nothing, report matches via the exit status only.
	#[arg(short = 's')]
	silent: bool,

	/// Command names to locate.
	#[arg(value_name = "name")]
	names: Vec<String>,
}

impl Utility for WhichCli {
	const NAME: &'static str = "which";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		// BSD and GNU which both treat a bare `which` as a usage error (exit 1).
		if self.names.is_empty() {
			let _ = writeln!(host.stderr, "usage: which [-as] program ...");
			return 1;
		}
		let path_var = host.var("PATH").unwrap_or_default().to_owned();
		let mut all_found = true;

		for name in self.names {
			let matches = if sys::fs::contains_path_separator(&name) {
				let candidate = host.resolve(&name);
				if candidate.is_dir() {
					Vec::new()
				} else {
					sys::fs::resolve_executable(candidate).into_iter().collect()
				}
			} else {
				let dirs = sys::fs::split_paths(&path_var).map(|dir| host.resolve(dir));
				let mut found = pathsearch::search_for_executable(dirs, &name);
				if self.all {
					found.collect()
				} else {
					found.next().into_iter().collect()
				}
			};

			if matches.is_empty() {
				// which(1) reports missing names via the exit status only.
				all_found = false;
			}
			if !self.silent {
				for path in matches {
					let _ = writeln!(host.stdout, "{}", path.display());
				}
			}
		}

		i32::from(!all_found)
	}
}

/// Creates the `which` builtin registration.
pub(crate) fn which_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<WhichCli, SE>()
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
	use std::{fs, os::unix::fs::PermissionsExt, path::Path};

	use clap::Parser;

	use super::WhichCli;
	use crate::host::{Host, Utility};

	fn place_file(dir: &Path, name: &str, executable: bool) -> std::path::PathBuf {
		let path = dir.join(name);
		fs::write(&path, b"#!/bin/sh\n").expect("file should be written");
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(&path, fs::Permissions::from_mode(mode))
			.expect("permissions should be set");
		path
	}

	fn run_which(argv: &[&str], path: &str, cwd: &Path) -> (i32, String) {
		let cli = WhichCli::try_parse_from(
			std::iter::once("which").chain(argv.iter().copied()),
		)
		.expect("test arguments should parse");
		let (mut host, capture) = Host::for_test("which", Vec::new(), cwd);
		host.set_test_var("PATH", path);
		let code = cli.run(&mut host);
		(code, capture.out())
	}

	/// Bare `which` used to silently exit 0; BSD/GNU which report a usage
	/// error on stderr and exit 1.
	#[test]
	fn no_operands_is_a_usage_error() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let cwd = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		let cli = WhichCli::try_parse_from(["which"]).expect("test arguments should parse");
		let (mut host, capture) = Host::for_test("which", Vec::new(), &cwd);
		let code = cli.run(&mut host);

		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "usage: which [-as] program ...\n");
	}

	/// BSD `which -s` used to be rejected by clap with exit 2; it must print
	/// nothing and report found/missing purely via the exit status, including
	/// in the clustered `-as` spelling.
	#[test]
	fn silent_flag_suppresses_output_and_keeps_exit_status() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let dir = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		place_file(&dir, "tool", true);
		let path_var = dir.to_string_lossy();

		assert_eq!(run_which(&["-s", "tool"], &path_var, &dir), (0, String::new()));
		assert_eq!(run_which(&["-s", "missing"], &path_var, &dir), (1, String::new()));
		assert_eq!(run_which(&["-as", "tool"], &path_var, &dir), (0, String::new()));
		assert_eq!(run_which(&["-sa", "tool"], &path_var, &dir), (0, String::new()));
		assert_eq!(run_which(&["-s", "tool", "missing"], &path_var, &dir), (1, String::new()));
	}

	#[test]
	fn finds_only_executable_files() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let dir = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		let tool = place_file(&dir, "tool", true);
		place_file(&dir, "blob", false);
		let path_var = dir.to_string_lossy();

		assert_eq!(run_which(&["tool"], &path_var, &dir), (0, format!("{}\n", tool.display())));
		assert_eq!(run_which(&["blob"], &path_var, &dir), (1, String::new()));
		assert_eq!(run_which(&["missing"], &path_var, &dir), (1, String::new()));
	}

	#[test]
	fn all_flag_returns_matches_in_path_order() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let root = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		let dir_a = root.join("a");
		let dir_b = root.join("b");
		fs::create_dir_all(&dir_a).expect("first PATH directory should be created");
		fs::create_dir_all(&dir_b).expect("second PATH directory should be created");
		let tool_a = place_file(&dir_a, "tool", true);
		let tool_b = place_file(&dir_b, "tool", true);
		let path_var = std::env::join_paths([&dir_a, &dir_b])
			.expect("PATH should join")
			.to_string_lossy()
			.into_owned();

		assert_eq!(
			run_which(&["-a", "tool"], &path_var, &root),
			(0, format!("{}\n{}\n", tool_a.display(), tool_b.display()))
		);
		assert_eq!(
			run_which(&["tool"], &path_var, &root),
			(0, format!("{}\n", tool_a.display()))
		);
	}

	#[test]
	fn name_with_separator_resolves_against_cwd() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let cwd = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin directory should be created");
		let tool = place_file(&bin, "tool", true);
		place_file(&bin, "blob", false);
		let path_var = bin.to_string_lossy();

		assert_eq!(
			run_which(&["bin/tool"], &path_var, &cwd),
			(0, format!("{}\n", tool.display()))
		);
		assert_eq!(run_which(&["bin/blob"], &path_var, &cwd), (1, String::new()));
		assert_eq!(run_which(&["./bin"], &path_var, &cwd), (1, String::new()));
	}

	#[test]
	fn relative_path_entries_resolve_against_cwd() {
		let temp = tempfile::tempdir().expect("temp directory should be created");
		let cwd = fs::canonicalize(temp.path()).expect("temp directory should canonicalize");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin directory should be created");
		let tool = place_file(&bin, "tool", true);

		assert_eq!(
			run_which(&["tool"], "bin", &cwd),
			(0, format!("{}\n", tool.display()))
		);
	}
}
