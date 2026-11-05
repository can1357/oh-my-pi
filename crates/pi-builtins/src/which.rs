//! `which` builtin: locate executables in the shell's `PATH`.
//!
//! Ported from pi-shell's in-process `which` implementation.

use std::{
	io::Write,
	path::{Path, PathBuf},
};

use clap::Parser;
use pi_vfs::BlockingFs;

use crate::host::{Host, Utility};

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
		let search_path = host.var("PATH").unwrap_or_default().to_owned();
		let mut missing = false;
		for name in &self.names {
			let found = locate(host, &search_path, name, self.all);
			missing |= found.is_empty();
			if !self.silent {
				for path in found {
					let _ = writeln!(host.stdout, "{}", path.display());
				}
			}
		}
		i32::from(missing)
	}
}

/// The executables `name` stands for: itself when it contains a directory
/// separator, else the matches in the `search_path` directories, in order
/// (only the first unless `all`). Directories never match.
fn locate(host: &Host, search_path: &str, name: &str, all: bool) -> Vec<PathBuf> {
	let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
	if name.contains(separators) {
		return runnable(host.fs(), &host.resolve(name)).into_iter().collect();
	}
	let mut found = Vec::new();
	for entry in std::env::split_paths(search_path) {
		// Quoted entries are common in Windows `PATH`s.
		let entry = if cfg!(windows) {
			PathBuf::from(entry.to_string_lossy().trim_matches('"'))
		} else {
			entry
		};
		let candidate = pi_vfs::join_path(&host.resolve(entry), Path::new(name));
		let Some(path) = runnable(host.fs(), &candidate) else {
			continue;
		};
		found.push(path);
		if !all {
			break;
		}
	}
	found
}

/// The file at `candidate` the user can run, if any. Windows has no execute
/// bit: a file runs when its extension is one `PATHEXT` lists, and `name`
/// also names `name.exe` and the like.
fn runnable(fs: &BlockingFs, candidate: &Path) -> Option<PathBuf> {
	if fs.is_dir(candidate) {
		return None;
	}
	#[cfg(windows)]
	{
		let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
		let extensions: Vec<String> = pathext
			.split(';')
			.map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
			.filter(|ext| !ext.is_empty())
			.collect();
		let listed = candidate
			.extension()
			.and_then(|ext| ext.to_str())
			.is_some_and(|ext| extensions.iter().any(|known| known.eq_ignore_ascii_case(ext)));
		if listed && fs.is_file(candidate) {
			return Some(candidate.to_path_buf());
		}
		extensions.iter().find_map(|ext| {
			let mut with_ext = candidate.as_os_str().to_owned();
			with_ext.push(".");
			with_ext.push(ext);
			let with_ext = PathBuf::from(with_ext);
			fs.is_file(&with_ext).then_some(with_ext)
		})
	}
	#[cfg(not(windows))]
	{
		fs.access(candidate, false, false, true).is_ok().then(|| candidate.to_path_buf())
	}
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
