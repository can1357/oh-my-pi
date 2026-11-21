//! `direnv` run as an extra over a scratch tree, its XDG directories inside
//! it. Commands it starts are served by the test runner, which has no shell:
//! evaluating an `.envrc` is covered by omp-shell's tests.

use std::{
	collections::HashMap,
	io::{Read as _, Seek as _, Write as _},
	path::{Path, PathBuf},
	time::{Duration, SystemTime},
};

use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::{hex, shells::bash_escape};
use crate::{
	extras::{Fd, Invocation},
	host::TestRunner,
};

/// `{"p":{"FOO":"orig"},"n":{"FOO":"loaded","BAR":"x"}}` in `gzenv`, encoded
/// outside this crate: what a loaded environment carries in `DIRENV_DIFF`.
const LOADED_DIFF: &str =
	"eJyrVipQsqpWcvP3V7JSyi_KTFeq1VHKQwjl5CempKYo6Sg5OQYBuRVKtbUAemQOkA==";
/// `[{"path":"/a","modtime":5,"exists":true}]` in `gzenv`, encoded outside
/// this crate.
const WATCH_DUMP: &str =
	"eJyLrlYqSCzJULJS0k9U0lHKzU8pycxNVbIy1VFKrcgsLilWsiopKk2tjQUADlgNiA==";

/// A scratch tree with direnv's state directories inside it.
struct Sandbox {
	root: PathBuf,
	_dir: tempfile::TempDir,
}

impl Sandbox {
	fn new() -> Self {
		let dir = tempfile::tempdir().expect("scratch tree");
		let root = std::fs::canonicalize(dir.path()).expect("canonical scratch tree");
		Self { root, _dir: dir }
	}

	fn path(&self, relative: &str) -> PathBuf {
		self.root.join(relative)
	}

	fn text(&self, relative: &str) -> String {
		self.path(relative).to_str().expect("utf-8 path").to_owned()
	}

	fn write(&self, relative: &str, content: &str) {
		let path = self.path(relative);
		std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
		std::fs::write(path, content).expect("write file");
	}

	/// The environment direnv starts with: its directories under the tree,
	/// plain logs, then `extra`.
	fn env(&self, extra: &[(&str, &str)]) -> HashMap<String, String> {
		let mut env: HashMap<String, String> = [
			("HOME", self.text("home")),
			("XDG_DATA_HOME", self.text("data")),
			("XDG_CONFIG_HOME", self.text("config")),
			("XDG_CACHE_HOME", self.text("cache")),
			("TERM", "dumb".to_owned()),
			("PATH", std::env::var("PATH").unwrap_or_default()),
		]
		.into_iter()
		.map(|(name, value)| (name.to_owned(), value))
		.collect();
		env.extend(extra.iter().map(|&(name, value)| (name.to_owned(), value.to_owned())));
		env
	}

	/// Runs `direnv ARGS` in the tree's `dir` with `env`, returning its
	/// status, stdout and stderr.
	async fn run(&self, dir: &str, env: HashMap<String, String>, args: &[&str]) -> (i32, String, String) {
		let cwd = self.path(dir);
		std::fs::create_dir_all(&cwd).expect("create working directory");
		let output = tempfile::tempfile().expect("stdout file");
		let error = tempfile::tempfile().expect("stderr file");
		let runner = TestRunner::new(
			env.clone(),
			cwd.clone(),
			output.try_clone().expect("stdout"),
			error.try_clone().expect("stderr"),
		);
		let argv = std::iter::once("direnv").chain(args.iter().copied()).map(str::to_owned).collect();
		let mut invocation = Invocation::new(argv, cwd, omp_vfs::Fs::native());
		invocation.env = env;
		invocation.stdio = [
			Fd::File(tempfile::tempfile().expect("stdin file")),
			Fd::File(output.try_clone().expect("stdout")),
			Fd::File(error.try_clone().expect("stderr")),
		];
		invocation.commands = Some(Box::new(runner));
		let code = crate::extras::run(invocation).await;
		let read = |mut file: std::fs::File| {
			let mut text = String::new();
			file.rewind().expect("rewind capture");
			file.read_to_string(&mut text).expect("read capture");
			text
		};
		(code, read(output), read(error))
	}

	/// `direnv ARGS` in `dir` with the default environment.
	async fn direnv(&self, dir: &str, args: &[&str]) -> (i32, String, String) {
		self.run(dir, self.env(&[]), args).await
	}

	/// How `direnv status --json` in `dir` rates the `.envrc` it finds:
	/// 0 allowed, 1 not allowed, 2 denied.
	async fn allowed(&self, dir: &str) -> Value {
		let (code, out, err) = self.direnv(dir, &["status", "--json"]).await;
		assert_eq!(code, 0, "{err}");
		let status: Value = serde_json::from_str(&out).expect("status JSON");
		status["state"]["foundRC"]["allowed"].clone()
	}
}

fn sha256(parts: &[&str]) -> String {
	let mut hash = Sha256::new();
	for part in parts {
		hash.update(part);
	}
	hex(&hash.finalize())
}

/// Moves the modification time of `path` by `seconds`, as a later edit would.
fn shift_mtime(path: &Path, seconds: u64) {
	let file = std::fs::File::options().write(true).open(path).expect("open for touch");
	file.set_modified(SystemTime::now() + Duration::from_secs(seconds)).expect("set mtime");
}

/// Contract: `allow` and `deny` keep the lists the real direnv reads, a file
/// named by the hash of the `.envrc`'s path and content (allow) or path
/// (deny), so a changed file needs a new `allow` and either program honors
/// the other's decision.
#[tokio::test]
async fn allow_and_deny_keep_direnvs_own_lists() {
	let tree = Sandbox::new();
	let rc = tree.text("proj/.envrc");
	tree.write("proj/.envrc", "export A=1\n");
	assert_eq!(tree.allowed("proj").await, 1);

	let (code, out, err) = tree.direnv("proj", &["allow"]).await;
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
	let entry = tree.path("data/direnv/allow").join(sha256(&[&rc, "\n", "export A=1\n"]));
	assert_eq!(std::fs::read_to_string(&entry).expect("allow entry"), format!("{rc}\n"));
	assert_eq!(tree.allowed("proj").await, 0);

	// Other content is another file as far as the allow list goes.
	tree.write("proj/.envrc", "export A=2\n");
	assert_eq!(tree.allowed("proj").await, 1);
	// From a directory below, the nearest `.envrc` above is the one allowed.
	let (code, ..) = tree.direnv("proj/sub", &["permit"]).await;
	assert_eq!(code, 0);
	let entry = tree.path("data/direnv/allow").join(sha256(&[&rc, "\n", "export A=2\n"]));
	assert!(entry.exists(), "allow entry of the new content");
	assert_eq!(tree.allowed("proj/sub").await, 0);

	let (code, ..) = tree.direnv("proj", &["deny"]).await;
	assert_eq!(code, 0);
	assert!(!entry.exists(), "deny revokes the allow entry");
	let denied = tree.path("data/direnv/deny").join(sha256(&[&rc, "\n"]));
	assert_eq!(std::fs::read_to_string(&denied).expect("deny entry"), format!("{rc}\n"));
	assert_eq!(tree.allowed("proj").await, 2);

	let (code, ..) = tree.direnv(".", &["allow", "proj/.envrc"]).await;
	assert_eq!(code, 0);
	assert!(!denied.exists(), "allow lifts the denial");
	assert_eq!(tree.allowed("proj").await, 0);

	let (code, _, err) = tree.direnv("elsewhere", &["allow"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error .envrc file not found"), "{err}");
}

/// Contract: an `.envrc` nobody allowed is never evaluated; `export` fails
/// but still hands the shell direnv's bookkeeping, so the same file is not
/// tried again until it changes. A denied file is skipped without an error.
#[tokio::test]
async fn export_of_a_blocked_envrc_reports_once() {
	let tree = Sandbox::new();
	let rc = tree.text("proj/.envrc");
	tree.write("proj/.envrc", "export A=1\n");

	let (code, out, err) = tree.direnv("proj", &["export", "json"]).await;
	assert_eq!(code, 1);
	assert!(
		err.contains(&format!("direnv: error {rc} is blocked. Run `direnv allow` to approve its content")),
		"{err}"
	);
	let exported: Value = serde_json::from_str(&out).expect("export JSON");
	let exported = exported.as_object().expect("JSON object");
	let mut names: Vec<&str> = exported.keys().map(String::as_str).collect();
	names.sort_unstable();
	assert_eq!(names, ["DIRENV_DIFF", "DIRENV_DIR", "DIRENV_FILE", "DIRENV_WATCHES"]);
	assert_eq!(exported["DIRENV_FILE"], rc.as_str());
	assert_eq!(exported["DIRENV_DIR"], format!("-{}", tree.text("proj")).as_str());

	// The shell applied the export: nothing changed since, nothing to do.
	let applied: Vec<(&str, &str)> = exported
		.iter()
		.map(|(name, value)| (name.as_str(), value.as_str().expect("string value")))
		.collect();
	let (code, out, err) = tree.run("proj", tree.env(&applied), &["export", "json"]).await;
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));

	// An edit is a reason to look again.
	shift_mtime(&tree.path("proj/.envrc"), 60);
	let (code, out, _) = tree.run("proj", tree.env(&applied), &["export", "json"]).await;
	assert_eq!(code, 1);
	assert!(out.contains("DIRENV_WATCHES"), "{out}");

	let (code, ..) = tree.direnv("proj", &["deny"]).await;
	assert_eq!(code, 0);
	let (code, out, err) = tree.direnv("proj", &["export", "json"]).await;
	assert_eq!((code, err.as_str()), (0, ""));
	assert!(out.contains("DIRENV_FILE"), "{out}");
}

/// Contract: `exec` runs its command through the shell's dispatch (here an
/// in-process `printenv`) with the environment a loaded `.envrc` left
/// undone, passes its status on, and names a command it cannot find.
#[tokio::test]
async fn exec_runs_the_command_in_the_restored_environment() {
	let tree = Sandbox::new();
	let loaded = tree.env(&[("FOO", "loaded"), ("BAR", "x"), ("DIRENV_DIFF", LOADED_DIFF)]);

	// `FOO` is back to what it was; `BAR` and the diff are gone, which
	// `printenv` reports with status 1.
	let (code, out, err) = tree.run("plain", loaded.clone(), &["exec", ".", "printenv", "FOO", "BAR", "DIRENV_DIFF"]).await;
	assert_eq!((code, out.as_str(), err.as_str()), (1, "orig\n", ""));

	// Options after the command are the command's.
	let (code, out, _) = tree.run("plain", loaded.clone(), &["exec", ".", "printenv", "--null", "FOO"]).await;
	assert_eq!((code, out.as_str()), (0, "orig\0"));

	let (code, _, err) = tree.direnv("plain", &["exec", ".", "no-such-command-here"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error command 'no-such-command-here' not found on PATH '"), "{err}");
	let (code, _, err) = tree.direnv("plain", &["exec", "."]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error missing COMMAND argument"), "{err}");
	let (code, _, err) = tree.direnv("plain", &["exec", "missing-dir", "true"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error stat missing-dir: no such file or directory"), "{err}");
}

/// Contract: `direnv.toml` decides what loads without `allow`
/// (`whitelist.prefix`), whether a bare `.env` counts (`load_dotenv`), and
/// the settings `status` reports; a setting of the wrong type is an error.
#[tokio::test]
async fn configuration_file_is_honored() {
	let tree = Sandbox::new();
	let trusted = tree.text("trusted");
	tree.write(
		"config/direnv/direnv.toml",
		&format!("[global]\nload_dotenv = true\nwarn_timeout = \"90s\"\n\n[whitelist]\nprefix = ['{trusted}']\n"),
	);
	tree.write("trusted/.env", "A=1\n");
	tree.write("other/.env", "A=1\n");

	let (code, out, err) = tree.direnv("trusted", &["status"]).await;
	assert_eq!(code, 0, "{err}");
	for line in [
		"warn_timeout 1m30s".to_owned(),
		format!("whitelist.prefix [{trusted}]"),
		format!("Found RC path {trusted}/.env"),
		"Found RC allowed 0".to_owned(),
	] {
		assert!(out.lines().any(|found| found == line), "missing {line:?} in:\n{out}");
	}
	assert_eq!(tree.allowed("other").await, 1);

	tree.write("config/direnv/direnv.toml", "load_dotenv = \"yes\"\n");
	let (code, _, err) = tree.direnv("trusted", &["status"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("LoadConfig() failed to parse"), "{err}");
}

/// Contract: the commands the stdlib calls back into print bash the
/// `.envrc` evaluates: `dotenv` exports a `.env` file with `$PWD` its own
/// directory, and `watch` extends the watch list that `current` checks.
#[tokio::test]
async fn stdlib_callbacks_print_bash() {
	let tree = Sandbox::new();
	tree.write("proj/conf/.env", "A=\"b c\"\nHERE=$PWD\n");
	let (code, out, err) = tree.direnv("proj", &["dotenv", "bash", "conf/.env"]).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, format!("export A=$'b c';export HERE={};\n", bash_escape(&tree.text("proj/conf"))));

	tree.write("proj/watched", "one");
	let (code, out, err) = tree.direnv("proj", &["watch", "bash", "watched", "absent"]).await;
	assert_eq!(code, 0, "{err}");
	let watches = out
		.strip_prefix("export DIRENV_WATCHES=$'")
		.and_then(|rest| rest.strip_suffix("';"))
		.expect("an export of the watch list");
	let watching = tree.env(&[("DIRENV_WATCHES", watches)]);
	let (code, out, _) = tree.run("proj", watching.clone(), &["watch-print"]).await;
	assert_eq!(code, 0);
	assert_eq!(out, format!("{}\n{}\n", tree.text("proj/watched"), tree.text("proj/absent")));

	let (code, ..) = tree.run("proj", watching.clone(), &["current", "watched"]).await;
	assert_eq!(code, 0);
	shift_mtime(&tree.path("proj/watched"), 60);
	let (code, _, err) = tree.run("proj", watching.clone(), &["current", "watched"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("has changed"), "{err}");
	// A watched file that did not exist reloads once it appears.
	tree.write("proj/absent", "now here");
	let (code, _, err) = tree.run("proj", watching, &["current", "absent"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("newly created"), "{err}");
}

/// Contract: dumps are interchangeable with the real direnv's: `show_dump`
/// reads its `gzenv`, and `apply_dump` turns a dumped environment (`gzenv`
/// or, from a host without direnv, `env -0`) into the exports that reach it.
#[tokio::test]
async fn dumps_decode_and_apply() {
	let tree = Sandbox::new();
	let (code, out, err) = tree.direnv(".", &["show_dump", WATCH_DUMP]).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, "[\n  {\n    \"exists\": true,\n    \"modtime\": 5,\n    \"path\": \"/a\"\n  }\n]\n");

	// The current environment with one variable changed, one added and one
	// (`HOME`) gone.
	let env = tree.env(&[]);
	let mut dump = Vec::new();
	for (name, value) in env.iter().filter(|&(name, _)| name != "HOME" && name != "TERM") {
		write!(dump, "{name}={value}\0").expect("write dump");
	}
	dump.extend_from_slice(b"TERM=xterm\0NEW=val ue\0");
	std::fs::write(tree.path("dump"), dump).expect("write dump file");
	let (code, out, err) = tree.run(".", env, &["apply_dump", "dump"]).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, "unset HOME;export NEW=$'val ue';export TERM=$'xterm';\n");

	let (code, _, err) = tree.direnv(".", &["apply_dump"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error not enough arguments"), "{err}");
}

/// Contract: `direnv version AT_LEAST` (the stdlib's `direnv_version`)
/// succeeds for this version and older ones, compares numerically, and
/// rejects what is no version.
#[tokio::test]
async fn version_checks_compare_numerically() {
	let tree = Sandbox::new();
	let (code, out, _) = tree.direnv(".", &["version"]).await;
	assert_eq!((code, out.as_str()), (0, "2.38.2\n"));
	for at_least in ["2.38.2", "2.38", "v2", "2.9.9", "2.38.2-rc1"] {
		let (code, _, err) = tree.direnv(".", &["version", at_least]).await;
		assert_eq!(code, 0, "{at_least}: {err}");
	}
	for at_least in ["2.38.3", "2.100", "10"] {
		let (code, _, err) = tree.direnv(".", &["version", at_least]).await;
		assert_eq!(code, 1, "{at_least}");
		assert!(
			err.contains(&format!("current version v2.38.2 is older than the desired version v{at_least}")),
			"{err}"
		);
	}
	let (code, _, err) = tree.direnv(".", &["version", "2.x"]).await;
	assert_eq!(code, 1);
	assert!(err.contains("direnv: error v2.x is not a valid semver version"), "{err}");
}

/// Contract: an external program asked for its environment (`use nix`) gets
/// the host's direnv by path when there is one, and a plain `env -0` when
/// there is none, so the hand-back works on a host without direnv.
#[cfg(unix)]
#[tokio::test]
async fn stdlib_names_a_dump_command_external_programs_can_run() {
	use std::os::unix::fs::PermissionsExt as _;

	let tree = Sandbox::new();
	let (code, out, err) = tree.run(".", tree.env(&[("PATH", "/nonexistent")]), &["stdlib"]).await;
	assert_eq!(code, 0, "{err}");
	assert!(out.contains("\ndirenv=$'direnv'\n"), "direnv= line");
	assert!(out.contains("\n__direnv_dump=(sh -c 'env -0 >\"$DIRENV_DUMP_FILE_PATH\"')\n"), "env fallback");

	tree.write("bin/direnv", "#!/bin/sh\n");
	std::fs::set_permissions(tree.path("bin/direnv"), std::fs::Permissions::from_mode(0o755))
		.expect("make executable");
	let (code, out, _) = tree.run(".", tree.env(&[("PATH", &tree.text("bin"))]), &["stdlib"]).await;
	assert_eq!(code, 0);
	let dump = format!("\n__direnv_dump=({} dump)\n", bash_escape(&tree.text("bin/direnv")));
	assert!(out.contains(&dump), "host direnv by path");
}
