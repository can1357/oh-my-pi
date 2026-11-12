//! `bash`/`sh` run in-engine as a nested shell (`Resolved::SelfShell`): a
//! fresh shell's state, its own `$0`/`$$`/positional parameters, bash's
//! invocation grammar and messages; a script without `#!` starts one too.
//! Goldens from bash 5.3.20 (`bash -c SRC` with `$0` = `bash`, the nested
//! `bash`/`sh` being 5.3.20 too).

use crate::{
	bash::SpawnSpec,
	testkit::{FakeHost, Fault, MemFs, run_script},
};

/// The OS's "exec format error".
const ENOEXEC: i32 = if cfg!(windows) { 193 } else { 8 };

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

/// Only exported variables and functions reach the new shell; aliases,
/// other functions and shell variables do not, `SHLVL` grows and
/// `$BASH_SUBSHELL` starts over.
#[test]
fn starts_from_the_exported_environment() {
	let (out, err, _) = run(
		"x=1; export y=2; f() { :; }; alias a=b; ( : ) ; bash -c 'echo \"[$x][$y]\"; type f a; echo \
		 $BASH_SUBSHELL $SHLVL'; :",
	);
	assert_eq!(out, "[][2]\n0 2\n");
	assert_eq!(err, "bash: line 1: type: f: not found\nbash: line 1: type: a: not found\n");
	let (out, ..) = run("f() { echo F; }; export -f f; bash -c f");
	assert_eq!(out, "F\n");
}

#[test]
fn nested_shells_do_not_reveal_later_root_bindings() {
	let (out, err, status) = run(
		"private=hidden; export kept=before; ( bash -c 'echo \
		 \"${private-absent}:${later-absent}:$kept\"; type -t added || :' ) & later=after; \
		 kept=after; added() { :; }; wait",
	);
	assert_eq!(status, 0);
	assert_eq!(out, "absent:absent:before\n");
	assert_eq!(err, "");
}

#[test]
fn takes_its_name_and_arguments() {
	let (out, ..) = run("bash -c 'echo $0 $# $1' name a b");
	assert_eq!(out, "name 2 a\n");
	let (out, ..) = run("echo 'echo from stdin $0 $#' | bash -s a b");
	assert_eq!(out, "from stdin bash 2\n");
	let (out, ..) = run("echo $$ >/dev/null; bash -c '[ $$ != $PPID ] && echo own pid'");
	assert_eq!(out, "own pid\n");
}

/// The nested shell's exit status (after its EXIT trap) is the command's.
#[test]
fn exit_status_and_exit_trap() {
	let (out, ..) = run("bash -c 'trap \"echo bye\" EXIT; exit 3'; echo $?");
	assert_eq!(out, "bye\n3\n");
	let (out, ..) = run("bash -e -c 'false; echo no'; echo $?");
	assert_eq!(out, "1\n");
}

/// Invocation flags: set flags, inherited `SHELLOPTS`, `sh` is posix mode.
#[test]
fn options_from_flags_environment_and_name() {
	let (out, ..) = run("set -f; bash -c 'echo $-'; export SHELLOPTS; bash -c 'echo $-'");
	assert_eq!(out, "hBc\nfhBc\n");
	let (out, ..) = run("sh -c 'shopt -o posix'; bash -c 'shopt -o posix'");
	// `shopt -o NAME` prints with shopt's `%-20s` (bare `shopt -o` and
	// `set -o` use `%-15s`); bash 5.3.20 output.
	assert_eq!(out, "posix               \ton\nposix               \toff\n");
}

/// bash's invocation errors, on the command's stderr, status 2.
#[test]
fn invocation_errors() {
	let (out, err, _) = run("bash -q; echo $?");
	assert_eq!(out, "2\n");
	assert!(err.starts_with(
		"bash: -q: invalid option\nUsage:\tbash [GNU long option] [option] ...\n\tbash [GNU long \
		 option] [option] script-file ...\nGNU long options:\n\t--debug\n"
	));
	let (out, err, _) = run("bash -O badopt -c :; echo $?; bash -o badopt -c :; echo $?");
	assert_eq!(out, "2\n2\n");
	assert_eq!(
		err,
		"bash: line 0: badopt: invalid shell option name\nbash: line 0: bash: badopt: invalid \
		 option name\n"
	);
}

/// Signals the parent ignores stay ignored; other traps are reset.
#[test]
fn ignored_signals_stay_ignored() {
	let (out, ..) = run("trap '' USR1; trap 'echo x' USR2; bash -c trap");
	assert!(out.contains("trap -- '' SIGUSR1\n"), "{out}");
	assert!(!out.contains("USR2"), "{out}");
}

#[test]
fn command_not_found_handle_runs_in_a_subshell() {
	let (out, err, _) = run(
		"command_not_found_handle() { echo \"hook: $*\"; x=set; return 7; }; nosuch a b; echo $? \
		 \"[$x]\"",
	);
	assert_eq!(out, "hook: nosuch a b\n7 []\n");
	assert_eq!(err, "");
}

/// A failed `exec` ends a non-interactive shell unless `execfail` is set.
#[test]
fn failed_exec_and_execfail() {
	let (out, err, status) = run("exec nosuch; echo after $?");
	assert_eq!(
		(out.as_str(), err.as_str(), status),
		("", "bash: line 1: exec: nosuch: not found\n", 127)
	);
	let (out, ..) = run("shopt -s execfail; exec nosuch; echo after $?");
	assert_eq!(out, "after 127\n");
}

/// A file the OS will not execute (`ENOEXEC`: no `#!`) runs as bash's
/// `shell_execve` runs it: a new shell started from the command's
/// environment (prefix assignments and exports, not shell variables,
/// functions or aliases), `$0` and the message prefix the path, the
/// arguments its positional parameters, its exit status the command's.
#[test]
fn a_script_without_shebang_starts_from_the_command_environment() {
	let fs = MemFs::new();
	fs.add_file(
		"/work/plain",
		b"echo \"$0|$#|$1|$2|[$x][$y][$z]\"; type f a\nnosuch\nexit 23\n",
		0o755,
	);
	let host = FakeHost::new()
		.with_fs(fs)
		.with_spawner(Box::new(|_: SpawnSpec<'_>| Err(std::io::Error::from_raw_os_error(ENOEXEC))));
	let src =
		"x=1; export y=2; f() { :; }; alias a=b; z=3 /work/plain 'two words' ';lit'; echo st=$?";
	let out = run_script(host, src.as_bytes(), &[], Fault::None);
	assert_eq!(
		String::from_utf8_lossy(&out.stdout),
		"/work/plain|2|two words|;lit|[][2][3]\nst=23\n"
	);
	assert_eq!(
		String::from_utf8_lossy(&out.stderr),
		"/work/plain: line 1: type: f: not found\n/work/plain: line 1: type: a: not \
		 found\n/work/plain: line 2: nosuch: command not found\n"
	);
}
