//! `sh`, `bash` and `zsh` by bare name through a [`Session`]: child shells
//! the engine runs itself (`crate::host::loopback`), and the command lines
//! that still go to the program on `PATH`.
//!
//! Most sessions here have a `PATH` that holds nothing, so a child shell that
//! prints anything ran in-engine: the system's shell would not be found.

#![cfg(unix)]

use std::{
	io::{self, Read as _, Seek as _},
	os::unix::ffi::OsStrExt as _,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use bstr::BString;
use parking_lot::Mutex;
use omp_vfs::{FileHandle, FileSystem, FileType, Metadata, OpenOptions, Permissions, ReadDir};
use tokio_util::sync::CancellationToken;

use crate::{
	bash::Fs,
	session::{RunStdio, Session, SessionConfig},
	vfs::VfsFs,
};

/// A `PATH` no program is on.
const NO_PATH: &str = "/nonexistent-pi-loopback";

/// The process environment without pi's switches and the shells' startup
/// hooks, with `extra` in place of what it names.
fn env_with(extra: &[(&str, &str)]) -> Vec<(BString, BString)> {
	std::env::vars_os()
		.filter(|(name, _)| {
			let name = name.as_bytes();
			!name.starts_with(b"PI_")
				&& !matches!(name, b"BASH_ENV" | b"ENV" | b"ZDOTDIR")
				&& !extra.iter().any(|(key, _)| key.as_bytes() == name)
		})
		.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
		.chain(
			extra
				.iter()
				.map(|&(k, v)| (BString::from(k), BString::from(v))),
		)
		.collect()
}

fn session_with(dir: &Path, extra: &[(&str, &str)], vfs: Option<VfsFs>) -> Session {
	let fs: Box<dyn Fs + Send> = match &vfs {
		Some(vfs) => Box::new(vfs.clone()),
		None => Box::new(crate::sys::StdFs::default()),
	};
	Session::new(SessionConfig {
		env: env_with(extra),
		cwd: BString::from(dir.as_os_str().as_bytes()),
		fs,
		vfs,
		runtime: tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap()
}

/// A session in `dir` (also its `HOME`) that finds no program on `PATH`.
fn engine_session(dir: &Path) -> Session {
	let home = dir.to_str().unwrap();
	session_with(dir, &[("PATH", NO_PATH), ("HOME", home)], None)
}

/// A session in `dir` (also its `HOME`) with the process's `PATH`.
fn host_session(dir: &Path) -> Session {
	session_with(dir, &[("HOME", dir.to_str().unwrap())], None)
}

struct Ran {
	status:    i32,
	cancelled: bool,
	stdout:    String,
	stderr:    String,
	elapsed:   Duration,
}

fn read_back(mut file: std::fs::File) -> String {
	file.rewind().unwrap();
	let mut text = String::new();
	file.read_to_string(&mut text).unwrap();
	text
}

async fn run_with(s: &mut Session, command: &str, cancel: CancellationToken) -> Ran {
	let (out, err) = (tempfile::tempfile().unwrap(), tempfile::tempfile().unwrap());
	let stdio = RunStdio {
		stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
		stdout: Some(out.try_clone().unwrap()),
		stderr: Some(err.try_clone().unwrap()),
	};
	let started = Instant::now();
	let outcome = s.run(command, stdio, cancel).await.unwrap();
	Ran {
		status:    outcome.status,
		cancelled: outcome.cancelled,
		stdout:    read_back(out),
		stderr:    read_back(err),
		elapsed:   started.elapsed(),
	}
}

async fn run(s: &mut Session, command: &str) -> Ran {
	run_with(s, command, CancellationToken::new()).await
}

/// stdout of `command`, which must succeed.
async fn out(s: &mut Session, command: &str) -> String {
	let ran = run(s, command).await;
	assert_eq!(ran.status, 0, "{command}: stderr {:?}", ran.stderr);
	ran.stdout
}

/// Waits (bounded) for `file` to exist.
async fn appeared(file: &Path) {
	let start = Instant::now();
	while !file.exists() {
		assert!(start.elapsed() < Duration::from_secs(10), "{} never appeared", file.display());
		tokio::time::sleep(Duration::from_millis(10)).await;
	}
}

/// `$0`, the argument count and the arguments.
const ARGS: &str = "echo \"$0:$#:$*\"\n";

// Failure mode: a form agents type spawns the system shell (here: is not
// found), or the child shell gets the wrong `$0` and arguments.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_invocation_form_is_a_child_shell_of_the_engine() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("s.sh"), ARGS).unwrap();
	let mut s = engine_session(dir.path());
	for (command, expected) in [
		("bash -c 'echo \"$0:$#:$*\"' name a b", "name:2:a b\n"),
		("bash -c 'echo \"$0:$#:$*\"'", "bash:0:\n"),
		("bash s.sh a 'b c'", "s.sh:2:a b c\n"),
		("bash ./s.sh", "./s.sh:0:\n"),
		("bash < s.sh", "bash:0:\n"),
		("bash -s a b < s.sh", "bash:2:a b\n"),
		("bash -s -- a b < s.sh", "bash:2:a b\n"),
		("cat s.sh | bash", "bash:0:\n"),
		("echo 'echo piped' | bash", "piped\n"),
		("bash <<< 'echo \"here $0\"'", "here bash\n"),
		("bash <<'EOF'\necho \"doc $0\"\nEOF", "doc bash\n"),
		("sh -c 'echo \"$0:$#:$*\"' name a", "name:1:a\n"),
		("sh s.sh x", "s.sh:1:x\n"),
		("sh < s.sh", "sh:0:\n"),
		("echo 'echo \"$1\"' | sh -s arg", "arg\n"),
		("zsh -fc 'echo \"$0:$#:$*\"' name a", "name:1:a\n"),
		("zsh -f s.sh x", "s.sh:1:x\n"),
		("zsh -f < s.sh", "zsh:0:\n"),
		("echo 'echo \"$1\"' | zsh -fs arg", "arg\n"),
		// Wrapped by the commands that run commands.
		("command bash -c 'echo wrapped'", "wrapped\n"),
		("env X=1 sh -c 'echo \"$X\"'", "1\n"),
		("env -i X=2 sh -c 'echo \"$X-${HOME-none}\"'", "2-none\n"),
		("echo a | xargs sh -c 'echo \"[$1]\"' _", "[a]\n"),
		("find . -name s.sh -exec sh -c 'echo \"found $1\"' _ {} ';'", "found ./s.sh\n"),
		("timeout 5 bash -c 'echo timed'", "timed\n"),
		("x=$(bash -c 'echo sub'); echo \"[$x]\"", "[sub]\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
}

// Failure mode: `sh` runs bash's full dialect, or `zsh` code is parsed as
// bash.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_name_runs_its_own_dialect() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	let posix = "case $SHELLOPTS in *posix*) echo posix;; *) echo plain;; esac";
	for (command, expected) in [
		(format!("sh -c '{posix}'"), "posix\n"),
		(format!("bash -c '{posix}'"), "plain\n"),
		(format!("bash --posix -c '{posix}'"), "posix\n"),
		(format!("bash -o posix -c '{posix}'"), "posix\n"),
		("bash -c 'echo ${BASH_VERSION+bash}${ZSH_VERSION+zsh}'".to_owned(), "bash\n"),
		("zsh -fc 'echo ${BASH_VERSION+bash}${ZSH_VERSION+zsh}'".to_owned(), "zsh\n"),
		("zsh -fc 'x=ab; print -r -- ${(U)x}'".to_owned(), "AB\n"),
	] {
		assert_eq!(out(&mut s, &command).await, expected, "{command}");
	}
}

// Failure mode: an option agents pass is ignored (a failing script goes on,
// a syntax check runs the script) or refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bash_options_take_effect() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("bad.sh"), "if then\n").unwrap();
	std::fs::write(dir.path().join(".bash_profile"), "echo profile\n").unwrap();
	let mut s = engine_session(dir.path());
	for (command, expected) in [
		("bash -c 'false; echo went-on'", "went-on\n"),
		("bash -ec 'false; echo went-on'; echo \"st=$?\"", "st=1\n"),
		("bash -uc 'echo \"$nope\"; echo went-on' 2>/dev/null; echo \"st=$?\"", "st=127\n"),
		("bash -xc 'echo hi' 2>&1", "+ echo hi\nhi\n"),
		("bash -c 'false | true'; echo \"st=$?\"", "st=0\n"),
		("bash -o pipefail -c 'false | true'; echo \"st=$?\"", "st=1\n"),
		("bash -euo pipefail -c 'echo strict'", "strict\n"),
		("bash -n -c 'echo ran'; echo \"st=$?\"", "st=0\n"),
		("bash -n bad.sh 2>/dev/null; echo \"st=$?\"", "st=2\n"),
		("bash -c 'shopt -q nullglob || echo off'", "off\n"),
		("bash -O nullglob -c 'shopt -q nullglob && echo on'", "on\n"),
		("bash --norc --noprofile -c 'echo plain'", "plain\n"),
		("bash -c 'shopt -q login_shell || echo not-login'", "not-login\n"),
		("bash --noprofile --login -c 'shopt -q login_shell && echo login'", "login\n"),
		("bash --noprofile -lc 'echo cmd'", "cmd\n"),
		("echo 'echo \"$1-$2\"' | bash -s a b", "a-b\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
	// A login shell sources its user's profile before the command.
	let login = out(&mut s, "bash -lc 'echo cmd'").await;
	assert!(login.ends_with("profile\ncmd\n"), "{login:?}");
	let ran = run(&mut s, "bash -n bad.sh").await;
	assert!(ran.stderr.contains("syntax error"), "{:?}", ran.stderr);
}

// Failure mode: the same options on `sh` and `zsh` are ignored or refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sh_and_zsh_options_take_effect() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("bad.sh"), "if then\n").unwrap();
	let mut s = engine_session(dir.path());
	for (command, expected) in [
		("sh -ec 'false; echo went-on'; echo \"st=$?\"", "st=1\n"),
		("sh -uc 'echo \"$nope\"' 2>/dev/null; echo \"st=$?\"", "st=127\n"),
		("sh -xc 'echo hi' 2>&1", "+ echo hi\nhi\n"),
		("sh -o pipefail -c 'false | true'; echo \"st=$?\"", "st=1\n"),
		("sh -n -c 'echo ran'; echo \"st=$?\"", "st=0\n"),
		("sh -n bad.sh 2>/dev/null; echo \"st=$?\"", "st=2\n"),
		("zsh -fec 'false; echo went-on'; echo \"st=$?\"", "st=1\n"),
		("zsh -fuc 'echo $nope' 2>/dev/null; echo \"st=$?\"", "st=1\n"),
		("zsh -fc 'false | true'; echo \"st=$?\"", "st=0\n"),
		("zsh -f -o pipefail -c 'false | true'; echo \"st=$?\"", "st=1\n"),
		("zsh -fn -c 'echo ran'; echo \"st=$?\"", "st=0\n"),
		("zsh -fn bad.sh 2>/dev/null; echo \"st=$?\"", "st=1\n"),
		("zsh -f -l -c '[[ -o login ]] && echo login'", "login\n"),
		("zsh -fc '[[ -o login ]] || echo not-login'", "not-login\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
	let traced = out(&mut s, "zsh -fxc 'echo hi' 2>&1").await;
	assert!(traced.contains("> echo hi\n") && traced.ends_with("hi\n"), "{traced:?}");
}

// Failure mode: the caller sees the wrong status of its child shell (a
// failing script looks fine, a missing one looks like a failed command).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_statuses_are_the_child_shells() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	for (command, status) in [
		("bash -c 'exit 7'", 7),
		("sh -c 'exit 300'", 44),
		("zsh -fc 'exit 9'", 9),
		("bash -c 'true; false'", 1),
		("bash -c 'nosuchcommand-pi' 2>/dev/null", 127),
		("bash -c 'if then' 2>/dev/null", 2),
		("bash \"$PWD\" 2>/dev/null", 126),
		("bash -c 'kill -TERM $$'", 143),
		("sh -c 'kill -KILL $$'", 137),
		("echo 'exit 5' | bash", 5),
	] {
		assert_eq!(run(&mut s, command).await.status, status, "{command}");
	}
	let ran = run(&mut s, "bash nosuch.sh").await;
	assert_eq!(
		(ran.status, ran.stderr.as_str()),
		(127, "bash: nosuch.sh: No such file or directory\n")
	);
	// The session's own shell is not the one that exited.
	assert_eq!(out(&mut s, "bash -c 'exit 3'; echo \"after $?\"").await, "after 3\n");
}

// Failure mode: a child shell sees its parent's unexported variables,
// functions and aliases, or what it changes leaks back into the session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn children_inherit_exports_only_and_change_nothing() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::create_dir(dir.path().join("sub")).unwrap();
	let mut s = engine_session(dir.path());
	let cwd = dir.path().display();
	for (command, expected) in [
		("x=1; export y=2; z=3 bash -c 'echo \"${x-unset} $y $z\"'", "unset 2 3\n".to_owned()),
		("zsh -fc 'echo \"${x-unset} $y ${z-unset}\"'", "unset 2 unset\n".to_owned()),
		(
			"bash -c 'y=changed; export w=1; cd /; shopt -s nullglob'; shopt -q nullglob || echo \
			 \"$y ${w-unset} $PWD\"",
			format!("2 unset {cwd}\n"),
		),
		("cd sub && bash -c 'echo \"${PWD##*/}\"' && sh -c pwd", format!("sub\n{cwd}/sub\n")),
		("f() { echo F; }; export -f f; bash -c f", "F\n".to_owned()),
		("g() { :; }; alias a=b; bash -c 'type g a' 2>&1 | grep -c 'not found'", "2\n".to_owned()),
		(
			"echo $$ > parent; bash -c 'echo $PPID > seen; [ $$ != $PPID ] && echo own'",
			"own\n".to_owned(),
		),
		("[ \"$(cat seen)\" = \"$(cat parent)\" ] && echo parent", "parent\n".to_owned()),
		("echo $(( $(bash -c 'echo $SHLVL') - SHLVL ))", "1\n".to_owned()),
		("echo $(( $(bash -c 'bash -c \"echo \\$SHLVL\"') - SHLVL ))", "2\n".to_owned()),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
}

// Failure mode: a child shell's streams are not the command's (output lost
// or merged, piped input not read, an inherited descriptor closed).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn children_use_the_commands_streams() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	let ran = run(&mut s, "bash -c 'echo out; echo err >&2'").await;
	assert_eq!((ran.stdout.as_str(), ran.stderr.as_str()), ("out\n", "err\n"));
	for (command, expected) in [
		("printf 'a\\nb\\n' | bash -c 'read x; cat; echo \"[$x]\"'", "b\n[a]\n"),
		// A script on stdin shares it with the commands it runs.
		("printf 'read x\\nvalue\\necho \"got $x\"\\n' | bash", "got value\n"),
		("bash -c 'echo three >&3' 3>&1", "three\n"),
		("bash -c 'echo to-file' > f; cat f", "to-file\n"),
		("bash -c 'echo b; echo a' | sort", "a\nb\n"),
		("bash -c 'cat' < f", "to-file\n"),
		("bash -c 'echo err >&2' 2>&1 | tr a-z A-Z", "ERR\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
}

/// A background child shell that traps with `trap`, writes `mark` once the
/// trap is set and loops; then `signal` (a command naming it by `$pid`), and
/// its status.
fn signalled(trap: &str, mark: &str, signal: &str) -> String {
	format!(
		"bash -c '{trap}; : > {mark}; while :; do sleep 0.05; done' & pid=$!; while [ ! -e {mark} \
		 ]; do sleep 0.02; done; {signal}; wait \"$pid\"; echo \"st=$?\""
	)
}

// Failure mode: a signal sent to a child shell misses it or skips its
// traps (a script's cleanup never runs), or `wait` loses its status.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signals_and_jobs_reach_child_shells() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	for (command, expected) in [
		("bash -c 'exit 3' & wait $!; echo \"st=$?\"".to_owned(), "st=3\n"),
		(
			"bash -c 'while :; do sleep 0.05; done' & kill $!; wait $!; echo \"st=$?\"".to_owned(),
			"st=143\n",
		),
		(signalled("trap \"echo term; exit 9\" TERM", "m1", "kill \"$pid\""), "term\nst=9\n"),
		(signalled("trap \"echo term; exit 9\" TERM", "m2", "kill %%"), "term\nst=9\n"),
		(
			signalled(
				"trap \"echo usr\" USR1; trap \"exit 5\" TERM",
				"m3",
				"kill -USR1 $pid; sleep 0.2; kill $pid",
			),
			"usr\nst=5\n",
		),
		// bash runs its `EXIT` trap when a signal ends it.
		(signalled("trap \"echo bye\" EXIT", "m4", "kill \"$pid\""), "bye\nst=143\n"),
		(signalled("trap \"\" TERM", "m5", "kill $pid; sleep 0.2; kill -KILL $pid"), "st=137\n"),
		// The child shell does its own job control.
		(
			"bash -c 'sleep 0.1 & wait $!; echo \"bg=$?\"; (exit 4) & wait $!; echo \"sub=$?\"'"
				.to_owned(),
			"bg=0\nsub=4\n",
		),
		// `timeout` signals the child shell, whose trap runs.
		(
			"timeout 0.3 bash -c 'trap \"echo timed-out; exit 0\" TERM; while :; do sleep 0.05; \
			 done'; echo \"st=$?\""
				.to_owned(),
			"timed-out\nst=124\n",
		),
	] {
		assert_eq!(out(&mut s, &command).await, expected, "{command}");
	}
	let ran = run(&mut s, "timeout 0.3 bash -c 'while :; do sleep 0.05; done'").await;
	assert_eq!(ran.status, 124, "{}", ran.stderr);
	assert!(ran.elapsed < Duration::from_secs(3), "took {:?}", ran.elapsed);
}

// Failure mode: a cancelled command leaves its child shell running, or ends
// it without the `TERM` trap that cleans up after the script.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_ends_child_shells_through_their_traps() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	// Alone, and as a pipeline stage (a subshell stands between the cancel
	// and the child shell).
	for (n, tail) in ["", " | cat"].into_iter().enumerate() {
		let ready = dir.path().join(format!("ready{n}"));
		let cleaned = dir.path().join(format!("cleaned{n}"));
		let command = format!(
			"bash -c 'trap \"echo cleaned > cleaned{n}; exit 0\" TERM; while :; do : > ready{n}; \
			 sleep 0.05; done'{tail}"
		);
		let cancel = CancellationToken::new();
		let trigger = cancel.clone();
		let probe = async {
			appeared(&ready).await;
			trigger.cancel();
		};
		let (ran, ()) = tokio::join!(run_with(&mut s, &command, cancel), probe);
		assert!(ran.cancelled, "{command}");
		assert!(ran.elapsed < Duration::from_secs(5), "{command} took {:?}", ran.elapsed);
		// The trap is the shell's last action; the run does not wait for it.
		appeared(&cleaned).await;
		assert_eq!(out(&mut s, "echo alive").await, "alive\n");
		// The loop is gone: nothing writes after the trap.
		std::fs::remove_file(&ready).unwrap();
		tokio::time::sleep(Duration::from_millis(200)).await;
		assert!(!ready.exists(), "{command}: the child shell runs on");
	}
}

// Failure mode: a host drops a session whose backgrounded child shell is
// between two commands (`bash -c 'while …; sleep 1; done' &`), ending it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_background_child_shell_counts_as_a_live_job() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = engine_session(dir.path());
	assert_eq!(s.live_external_jobs().await.unwrap(), 0);
	let started = run(&mut s, "bash -c ': > up; while :; do sleep 0.05; done' &").await;
	assert_eq!(started.status, 0);
	appeared(&dir.path().join("up")).await;
	assert_eq!(s.live_external_jobs().await.unwrap(), 1);
	assert_eq!(out(&mut s, "kill %1; wait %1; echo \"st=$?\"").await, "st=143\n");
	assert_eq!(s.live_external_jobs().await.unwrap(), 0);
}

/// Whether `text` is one absolute path of a program called `name`.
fn is_program(text: &str, name: &str) -> bool {
	text.starts_with('/') && text.ends_with(&format!("/{name}\n")) && text.lines().count() == 1
}

// Failure mode: a command line only the system's shell can serve runs
// in-engine: a path names another program than the one asked for, an
// `exec` or `nohup` shell ends with the session, `-i` loses the user's own
// shell setup.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_program_still_runs_where_the_engine_does_not_stand_in() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = host_session(dir.path());
	// In-engine, `sort` is pi's own; to the system's shell it is a program.
	assert_eq!(out(&mut s, "sh -c 'command -v sort'").await, "sort\n");
	for command in [
		"/bin/sh -c 'command -v sort'",
		"(exec sh -c 'command -v sort')",
		"zsh -fc 'exec sh -c \"command -v sort\"'",
		"nohup sh -c 'command -v sort'",
		"sh -ic 'command -v sort' 2>/dev/null",
		"sh -vc 'command -v sort' 2>/dev/null",
	] {
		let found = out(&mut s, command).await;
		assert!(is_program(&found, "sort"), "{command}: {found:?}");
	}
	// The name still means the program: its path is what scripts ask for.
	let found = out(&mut s, "command -v sh").await;
	assert!(is_program(&found, "sh"), "{found:?}");
	assert_eq!(out(&mut s, "type -t sh").await, "file\n");

	// With no such program, the engine's shell runs after all.
	let mut s = engine_session(dir.path());
	for (command, expected) in [
		("sh -ic 'echo fallback' 2>/dev/null", "fallback\n"),
		("bash -vc 'echo fallback' 2>/dev/null", "fallback\n"),
		("nohup sh -c 'echo detached'", "detached\n"),
		("type -t sh bash zsh", "builtin\nbuiltin\nbuiltin\n"),
		("command -v sh", "sh\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
}

// ---------------------------------------------------------------------------
// Scripts named by URL.

/// What `mem://rendered.sh` holds.
const RENDERED: &[u8] = b"echo \"rendered $0 $*\"\n";

/// `mem://kit/<file>` is an alias of `<root>/<file>`; `mem://rendered.sh` is
/// served from memory and aliases nothing. Every other path is the host's.
#[derive(Debug)]
struct Kit {
	root: PathBuf,
}

impl Kit {
	/// The host file `path` is an alias of.
	fn backing(&self, path: &Path) -> Option<PathBuf> {
		path
			.to_str()?
			.strip_prefix("mem://kit/")
			.map(|file| self.root.join(file))
	}
}

#[async_trait]
impl FileSystem for Kit {
	fn is_native_local(&self, path: &Path) -> bool {
		!omp_vfs::is_virtual_path(path)
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		Ok(self.backing(path))
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<omp_vfs::File> {
		if let Some(file) = self.backing(path) {
			return omp_vfs::Fs::native().open_with(file, options).await;
		}
		if path != Path::new("mem://rendered.sh") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(omp_vfs::File::from_handle(Rendered { pos: Mutex::new(0) }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		if let Some(file) = self.backing(path) {
			return omp_vfs::Fs::native().metadata(file).await;
		}
		if path != Path::new("mem://rendered.sh") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(rendered_meta())
	}

	async fn read_dir(&self, _path: &Path) -> io::Result<ReadDir> {
		Err(io::ErrorKind::NotFound.into())
	}
}

fn rendered_meta() -> Metadata {
	Metadata::new(
		FileType::from_kind(omp_vfs::FileKind::File),
		RENDERED.len() as u64,
		Permissions::from_mode(0o644),
	)
}

#[derive(Debug)]
struct Rendered {
	pos: Mutex<usize>,
}

#[async_trait]
impl FileHandle for Rendered {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let mut pos = self.pos.lock();
		let n = (RENDERED.len() - *pos).min(buf.len());
		buf[..n].copy_from_slice(&RENDERED[*pos..*pos + n]);
		*pos += n;
		Ok(n)
	}

	async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
		Err(io::ErrorKind::PermissionDenied.into())
	}

	async fn seek(&self, pos: io::SeekFrom) -> io::Result<u64> {
		let mut at = self.pos.lock();
		*at = match pos {
			io::SeekFrom::Start(to) => usize::try_from(to)
				.unwrap_or(usize::MAX)
				.min(RENDERED.len()),
			_ => return Err(io::ErrorKind::Unsupported.into()),
		};
		Ok(*at as u64)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Ok(rendered_meta())
	}
}

// Failure mode: `bash skill://x/run.sh` reports "No such file", or the
// script cannot find the files next to it because `$0` is a URL it cannot
// take the directory of.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scripts_named_by_url_run_in_the_child_shell() {
	let dir = tempfile::tempdir().unwrap();
	let kit = dir.path().join("kit");
	std::fs::create_dir(&kit).unwrap();
	std::fs::write(
		kit.join("run.sh"),
		"echo \"$0\"\n. \"$(dirname \"$0\")/lib.sh\"\ngreet \"$@\"\n",
	)
	.unwrap();
	std::fs::write(kit.join("lib.sh"), "greet() { echo \"hello $*\"; }\n").unwrap();
	let vfs = VfsFs::new(
		omp_vfs::Fs::new(Arc::new(Kit { root: kit.clone() })),
		tokio::runtime::Handle::current(),
	);
	let home = dir.path().to_str().unwrap();
	let mut s = session_with(dir.path(), &[("PATH", NO_PATH), ("HOME", home)], Some(vfs));

	// An alias of a host file runs as that file.
	let script = kit.join("run.sh");
	let greeted = format!("{}\nhello a b\n", script.display());
	for command in [
		"bash mem://kit/run.sh a b",
		"sh mem://kit/run.sh a b",
		"zsh -f mem://kit/run.sh a b",
		"bash -eu mem://kit/run.sh a b",
	] {
		assert_eq!(out(&mut s, command).await, greeted, "{command}");
	}
	// One the filesystem only serves is read through it.
	for (command, expected) in [
		("bash mem://rendered.sh a b", "rendered mem://rendered.sh a b\n"),
		("sh mem://rendered.sh", "rendered mem://rendered.sh \n"),
		("bash -s x < mem://rendered.sh", "rendered bash x\n"),
		("cat mem://rendered.sh | bash -s y", "rendered bash y\n"),
		// The child shell opens URLs as its parent does.
		("bash -c 'cat mem://rendered.sh' | wc -l | tr -d ' '", "1\n"),
		("bash -c '. mem://kit/lib.sh; greet sourced'", "hello sourced\n"),
	] {
		assert_eq!(out(&mut s, command).await, expected, "{command}");
	}
	for missing in ["mem://kit/absent.sh", "mem://absent.sh"] {
		let ran = run(&mut s, &format!("bash {missing}")).await;
		assert_eq!(
			(ran.status, ran.stderr),
			(127, format!("bash: {missing}: No such file or directory\n")),
		);
	}
}
