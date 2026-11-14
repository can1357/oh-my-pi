//! zsh/curses without a terminal (`FakeHost`, no `$TERM`): the module's
//! parameters, the messages zsh gives before curses starts, and ncurses'
//! refusal of an unknown terminal (it ends the shell). Expected output from
//! `env -u TERM /bin/zsh -f -c` 5.9; drawing is covered on a pty by
//! `tests/zsh_mod_curses.rs`.

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
fn zsh_mod_curses_parameters() {
	let (out, err, st) = zsh(
		"print -r -- ${(t)zcurses_windows}; zmodload zsh/curses; print -r -- ${(t)zcurses_keycodes} \
		 ${(t)ZCURSES_COLORS} $ZCURSES_COLORS $#zcurses_keycodes ${zcurses_keycodes[-3,-1]} \
		 $zcurses_colors $zcurses_attrs; print -r -- ${(t)zcurses_windows} x${zcurses_windows}x; \
		 zcurses_windows=(a); print s=$?",
	);
	assert_eq!(
		out,
		"\narray-readonly-hide-hideval-special integer-readonly-hide-hideval-special 0 92 MOUSE \
		 RESIZE EVENT black red green yellow blue magenta cyan white default blink bold dim reverse \
		 standout underline\narray-readonly-hide-hideval-special xx\n"
	);
	assert_eq!(err, "zsh:1: read-only variable: zcurses_windows\n");
	assert_eq!(st, 1);
}

#[test]
fn zsh_mod_curses_messages_before_init() {
	let (out, err, st) = zsh(
		"zmodload zsh/curses
zcurses; print s=$?
zcurses foo; print s=$?
zcurses move; print s=$?
zcurses move w 1 2; print s=$?
zcurses input w a b c d; print s=$?
zcurses end; print s=$?",
	);
	assert_eq!(out, "s=1\ns=1\ns=1\ns=1\ns=1\ns=0\n");
	assert_eq!(
		err,
		"zsh:zcurses:2: not enough arguments
zsh:zcurses:3: unknown subcommand: foo
zsh:zcurses:4: too few arguments for subcommand: move
zsh:zcurses:5: command `move' can't be used before `zcurses init'
zsh:zcurses:6: too many arguments for subcommand: input
"
	);
	assert_eq!(st, 0);
}

/// ncurses' `initscr` ends the process when it knows no such terminal.
#[test]
fn zsh_mod_curses_unknown_terminal_ends_the_shell() {
	let (out, err, st) = zsh("zmodload zsh/curses; zcurses init; print after");
	assert_eq!(out, "");
	assert_eq!(err, "Error opening terminal: unknown.\n");
	assert_eq!(st, 1);
}
