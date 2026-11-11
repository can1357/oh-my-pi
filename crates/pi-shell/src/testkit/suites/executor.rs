//! Executor behaviour: `set -k`, prefix-assignment errors, `case` status,
//! the EXIT trap of an `exit` in a function, discarded commands, `${ ;}`
//! re-parsing, `set -x` headers of compound commands and the status of
//! `command -v`/`-V`. Goldens: bash 5.3.20 (`/opt/homebrew/bin/bash -c
//! '…'`).

use std::sync::{Arc, Mutex};

use bstr::{BStr, BString};

use crate::{
	bash::SpawnSpec,
	testkit::{FakeHost, Fault, MemFs, run_script},
};

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

#[test]
fn keyword_words_are_assignments_after_the_prefix_ones() {
	let (out, err, _) =
		run("set -k; f=1 g=2 echo x h=3; echo $f $g $h; HOME=/a/b/c a=$HOME c=9; echo $HOME $c $a");
	assert_eq!(err, "");
	assert_eq!(out, "x\n\n/a/b/c 9 /a/b/c\n");
}

#[test]
fn keyword_words_are_traced_as_assignments() {
	let (_, err, _) = run("set -k; set -x; true a=1 b=2");
	assert_eq!(err, "+ a=1\n+ b=2\n+ true\n");
}

#[test]
fn subscripted_prefix_assignment_is_reported_and_the_command_runs() {
	let (out, err, _) = run("var[0]=$(echo side >&2) true; echo $? ${var[0]-unset}");
	assert_eq!(err, "bash: line 1: `var[0]': not a valid identifier\n");
	assert_eq!(out, "0 unset\n");
}

#[test]
fn case_keeps_status_until_an_arm_decides() {
	let (out, ..) = run(
		"false; case x in x) echo $?;; esac; false; case x in x) ;; esac; echo $?; false; case x in \
		 y) ;; esac; echo $?; case x in x) false;;& y) ;; esac; echo $?",
	);
	assert_eq!(out, "1\n0\n0\n1\n");
}

#[test]
fn exit_in_a_function_runs_the_exit_trap_in_its_scope() {
	let (out, _, status) =
		run("trap 'echo trap:$FUNCNAME $x' EXIT; f() { local x=1; exit 3; }; f; echo no");
	assert_eq!(out, "trap:f 1\n");
	assert_eq!(status, 3);
}

#[test]
fn bad_substitution_discards_the_command_of_the_innermost_script() {
	let (out, err, _) = run(
		"echo ${x!y}; echo same\necho next $?\neval \"echo \\${x!y}; echo in1\necho in2\"; echo \
		 after $?",
	);
	assert_eq!(out, "next 1\nin2\nafter 0\n");
	assert_eq!(
		err,
		"bash: line 1: ${x!y}: bad substitution\nbash: line 3: ${x!y}: bad substitution\n"
	);
}

#[test]
fn nofork_comsub_is_reparsed_with_current_aliases() {
	let (out, err, _) = run("shopt -s expand_aliases; alias e='echo al'; echo ${ e; }");
	assert_eq!(err, "");
	assert_eq!(out, "al\n");
}

/// The re-parsed body is reused only while no alias is defined: an alias
/// defined (or removed) between two runs of the same `${ ;}` applies.
#[test]
fn nofork_comsub_reuse_follows_alias_changes() {
	let (out, err, _) = run(
		"shopt -s expand_aliases; e() { echo fn; }; for i in 1 2; do echo ${ e; }; alias e='echo \
		 al'; done; unalias e; echo ${ e; }",
	);
	assert_eq!(err, "");
	assert_eq!(out, "fn\nal\nfn\n");
}

/// The same `${ ;}` text at another line re-parses with that line.
#[test]
fn nofork_comsub_reuse_keeps_each_line() {
	let (out, err, _) = run(
		"for i in 1 2; do\necho ${ echo $LINENO; }\ndone\necho ${ echo $LINENO; }\necho ${ echo \
		 $LINENO; }",
	);
	assert_eq!(err, "");
	assert_eq!(out, "2\n2\n4\n5\n");
}

/// `$( )` turns `-e` off (and out of `SHELLOPTS`) only when it was on.
#[test]
fn comsub_resets_errexit_only_when_set() {
	let (out, err, _) = run(
		"o() { [[ :$SHELLOPTS: == *:errexit:* ]] && echo on || echo off; }; echo $(o); set -e; o; \
		 echo $(o); x=$(false; echo after); echo $x; set +e; echo $(o); shopt -s inherit_errexit; \
		 set -e; echo $(o)",
	);
	assert_eq!(err, "");
	assert_eq!(out, "off\non\noff\nafter\noff\non\n");
}

#[test]
fn xtrace_shows_for_case_select_headers_and_negated_primaries() {
	let (_, err, _) = run(
		"set -x; a=1; for i in $a \"b c\"; do :; done; case $a in 1) ;; esac; set -- q; for i; do \
		 :; done; [[ ! x ]]; [[ ! ! x ]]",
	);
	assert_eq!(
		err,
		"+ a=1\n+ for i in $a \"b c\"\n+ :\n+ for i in $a \"b c\"\n+ :\n+ case $a in\n+ set -- q\n+ \
		 for i in \"$@\"\n+ :\n+ [[ ! -n x ]]\n+ [[ -n x ]]\n"
	);
}

#[test]
fn posix_shell_exits_on_an_expansion_error() {
	let (out, err, status) = run("set -o posix; echo ${x!y}\necho after");
	assert_eq!(out, "");
	assert_eq!(err, "bash: line 1: ${x!y}: bad substitution\n");
	assert_ne!(status, 0);
}

#[test]
fn unset_runs_a_command_substitution_in_an_index() {
	let (out, err, _) = run("b=(0 1 2); unset 'b[$(echo 1)]'; declare -p b");
	assert_eq!(err, "");
	assert_eq!(out, "declare -a b=([0]=\"0\" [2]=\"2\")\n");
}

/// `command -v`/`-V` describe every name and succeed when any one is
/// found (bash's `any_found`); `-v` skips misses silently.
#[test]
fn command_v_succeeds_when_any_name_is_found() {
	let (out, err, _) = run(
		"command -v true false pwd nope-xyz; echo st=$?; command -v nope1 nope2; echo st=$?; \
		 command -V true nope; echo st=$?; command -v; echo st=$?",
	);
	assert_eq!(out, "true\nfalse\npwd\nst=0\nst=1\ntrue is a shell builtin\nst=0\nst=0\n");
	assert_eq!(err, "bash: line 1: command: nope: not found\n");
}

/// A command `PATH` lacks runs the host's stand-in (`Host::fallback`, as
/// `omp zsh` offers pi's utilities where Windows has no `ls`); `exec` of
/// it is still not found (a process image cannot be a native), `type`
/// still answers from `PATH`, and a defined not-found handler (Ubuntu's
/// `command-not-found`) handles the name instead.
#[test]
fn path_misses_run_the_hosts_fallback() {
	let mut host = FakeHost::new().natives_as_fallback();
	host.countdown("mytool", 1, 7);
	let out = run_script(
		host,
		b"mytool; echo $?; type mytool || echo untyped; exec mytool",
		&[],
		Fault::None,
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "7\nuntyped\n");
	assert_eq!(out.status, 127);
	let mut host = FakeHost::new().natives_as_fallback();
	host.countdown("mytool", 1, 7);
	let out = run_script(
		host,
		b"command_not_found_handle() { echo \"install $1\"; return 3; }; mytool; echo $?",
		&[],
		Fault::None,
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "install mytool\n3\n");
}

/// A host command whose arguments are written for the program it shadows
/// (`Host::defers_to_path`: Windows's `find /c /v ""` is cmd's `FIND`)
/// runs `PATH`'s program of that name; other arguments run the host's
/// command, and so does a deferred one `PATH` has no program for.
#[test]
fn a_deferred_host_command_runs_the_program_it_shadows() {
	let spawned: Arc<Mutex<Vec<BString>>> = Arc::default();
	let fs = MemFs::new();
	fs.add_file("/bin/find", b"", 0o755);
	let seen = Arc::clone(&spawned);
	let mut host = FakeHost::new()
		.with_fs(fs)
		.with_path_deferral(|_: &BStr, argv: &[BString]| {
			argv.get(1).is_some_and(|a| a.starts_with(b"/"))
		})
		.with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
			seen
				.lock()
				.expect("spawn log")
				.push(BString::from(spec.path.to_vec()));
			Err(std::io::Error::other("spawned"))
		}));
	host.countdown("find", 1, 7);
	let out = run_script(
		host,
		b"PATH=/bin; find /c x; echo $?; find . -name x; echo $?; PATH=/none; find /c x; echo $?",
		&[],
		Fault::None,
	);
	assert_eq!(*spawned.lock().expect("spawn log"), [BString::from("/bin/find")]);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "126\n7\n7\n");
}
