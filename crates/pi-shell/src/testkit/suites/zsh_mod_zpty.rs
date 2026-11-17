//! zsh/zpty on a host without terminals (`FakeHost`): the usage errors zsh
//! reports before it needs a pty, and the refusal to open one. Messages
//! from `/bin/zsh -f -c` 5.9; the pty itself is covered by
//! `tests/zsh_mod_zpty.rs` through the process host.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

#[test]
fn zsh_mod_zpty_needs_a_terminal_host() {
	let (out, err, st) = zsh("zmodload zsh/zpty; zpty x cat; print $?; zpty; zpty -L; print end");
	assert_eq!(out, "1\nend\n");
	assert_eq!(err, "zsh:zpty:1: can't open pseudo terminal: operation not supported\n");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_zpty_usage_errors_without_a_pty() {
	let (out, err, st) = zsh(
		"zmodload zsh/zpty
zpty -r; print $?
zpty -r nope; print $?
zpty -rw x; print $?
zpty -dL; print $?
zpty -wt x; print $?
zpty -nb x; print $?
zpty x; print $?
zpty -t; print $?
zpty -t nope; print $?
zpty -d nope; print $?
zpty y 'echo a; )'; print $?",
	);
	assert_eq!(out, "1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:zpty:2: missing pty command name
zsh:zpty:3: no such pty command: nope
zsh:zpty:4: illegal option combination
zsh:zpty:5: illegal option combination
zsh:zpty:6: illegal option combination
zsh:zpty:7: illegal option combination
zsh:zpty:8: missing command
zsh:zpty:9: missing pty command name
zsh:zpty:10: no such pty command: nope
zsh:zpty:11: no such pty command: nope
(zpty):12: parse error near `)'
"
	);
	assert_eq!(st, 0);
}

/// zsh/clone loads with zsh's feature table and `clone` checks its
/// arguments and terminal as zsh does (`/bin/zsh -f -c` 5.9), but the fork
/// onto another terminal is not provided: it fails loudly.
#[test]
fn zsh_mod_clone_loads_and_fails_loudly() {
	let (out, err, st) = zsh(
		"zmodload zsh/clone; print st=$?; zmodload -lF zsh/clone; whence -w clone
clone; print s=$?
clone a b; print s=$?
clone /nonexistent/x; print s=$?",
	);
	assert_eq!(out, "st=0\n+b:clone\nclone: builtin\ns=1\ns=1\ns=1\n");
	assert_eq!(
		err,
		"zsh:clone:2: not enough arguments
zsh:clone:3: too many arguments
zsh:clone:4: /nonexistent/x: no such file or directory
"
	);
	assert_eq!(st, 0);
	let (out, err, st) = zsh("zmodload zsh/clone; print -n > /tmp/tty; clone /tmp/tty; print s=$?");
	assert_eq!(out, "s=1\n");
	assert!(err.contains("`clone' (forking the running shell onto another terminal)"), "{err}");
	assert_eq!(st, 0);
}

/// Before `zmodload` the builtin does not exist (zsh/zpty is not
/// autoloaded at startup).
#[test]
fn zsh_mod_zpty_is_a_module_builtin() {
	let (out, err, st) = zsh("whence -w zpty; zmodload zsh/zpty; whence -w zpty");
	assert_eq!(out, "zpty: none\nzpty: builtin\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}
