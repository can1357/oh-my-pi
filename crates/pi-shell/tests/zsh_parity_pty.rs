//! zsh core behaviour of an interactive `obash` invoked as `zsh -f -i`,
//! against the real `/bin/zsh -f -i` on the same pty session (same keys,
//! same files): a line ending in `||`/`&&` continues on a `PS2` line, and
//! an autoloaded function file is read with comments even though the
//! interactive shell's own input is not (`interactivecomments` unset).

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(300);

/// `zsh -f -i` with a plain prompt and `~/tf`, an autoloadable function
/// file that starts with a comment.
fn spawn(real: bool) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "P> ")
		.env("PS2", "%_> ")
		.rc_file("tf", "# a comment\necho tf ran\n")
		.size(24, 80)
}

/// Type `text` key by key, then wait for the output to settle.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Run `drive` against both shells; assert the final screens match.
fn same(drive: impl Fn(&mut Pty) -> io::Result<()>) {
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.settle(QUIET, TIMEOUT)?;
		drive(pty)
	};
	if !have_real_zsh() {
		let mut ours = spawn(false).spawn().expect("spawn obash");
		run(&mut ours).expect("pty session");
		return;
	}
	let (ours, real) = differential(spawn(false), spawn(true), run).expect("pty session");
	assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
}

#[test]
fn and_or_at_line_end_continues_on_ps2() {
	same(|pty| keys(pty, "echo x y ||\recho z\rfalse &&\recho no\recho done\r"));
}

#[test]
fn autoloaded_file_reads_comments_in_an_interactive_shell() {
	same(|pty| keys(pty, "fpath=(~ $fpath); autoload -Uz tf; tf; echo $?\r"));
}
