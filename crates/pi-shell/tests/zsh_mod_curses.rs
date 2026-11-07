//! zsh/curses on a terminal: obash run as `zsh` and the real `/bin/zsh`
//! 5.9 (ncurses) drive the same `zcurses` sessions on a pty and must leave
//! the same screen (decoded by the harness' VT model: text and cursor
//! position, not the exact escape sequences ncurses picks).

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// Run `script` (`zsh -f -c`) on both shells with `drive`; the screens.
fn both(
	script: &str,
	drive: impl FnMut(&mut Pty) -> io::Result<()>,
) -> io::Result<Option<(String, String)>> {
	if !have_real_zsh() {
		return Ok(None);
	}
	differential(
		Spawn::zsh().args(["-f", "-c", script]),
		Spawn::real_zsh().args(["-f", "-c", script]),
		drive,
	)
	.map(Some)
}

const QUIET: Duration = Duration::from_millis(300);

/// Windows, a border, attributes, colors and wide characters, shown while
/// `zcurses input` waits.
#[test]
fn zsh_mod_curses_draws_windows_like_ncurses() -> io::Result<()> {
	let script = "zmodload zsh/curses
zcurses init
zcurses addwin w 6 24 2 4
zcurses border w
zcurses move w 1 2
zcurses attr w bold red/blue
zcurses string w hello
zcurses attr w -bold default/default
zcurses move w 2 2
zcurses string w 'wide: 漢字 ok'
zcurses addwin s 2 10 5 6 w
zcurses string s sub
zcurses refresh w s
zcurses input w key";
	let Some((obash, zsh)) = both(script, |pty| {
		pty.wait_screen_contains("sub", TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	assert!(zsh.contains("hello") && zsh.contains("漢字"), "{zsh}");
	Ok(())
}

/// `end` gives the normal screen back; the window table and positions
/// stay, and a refresh after `end` redraws curses' screen.
#[test]
fn zsh_mod_curses_end_and_resume() -> io::Result<()> {
	let script = "zmodload zsh/curses
print before
zcurses init
zcurses addwin w 3 10 1 1
zcurses string w abc
zcurses refresh w
zcurses end
zcurses position w pos
print -r -- pos=$pos wins=$zcurses_windows
zcurses querychar w q
print -r -- q=$q colors=$ZCURSES_COLORS
read -r line
zcurses refresh
zcurses touch w
zcurses refresh w
zcurses input w";
	let Some((obash, zsh)) = both(script, |pty| {
		pty.wait_screen_contains("colors=", TIMEOUT)?;
		pty.write("\r")?;
		pty.wait_screen_contains("abc", TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	Ok(())
}

/// `input` reads characters and, with a key parameter, keypad keys.
#[test]
fn zsh_mod_curses_reads_keys() -> io::Result<()> {
	let script = "zmodload zsh/curses
zcurses init
zcurses input stdscr c
zcurses input stdscr c2 k2
zcurses input stdscr c3 k3
zcurses timeout stdscr 0
zcurses input stdscr c4; s4=$?
zcurses end
print -r -- \"[$c][$c2|$k2][$c3|$k3][$c4|$s4]\"";
	let Some((obash, zsh)) = both(script, |pty| {
		pty.settle(QUIET, TIMEOUT)?;
		pty.write("x")?;
		pty.settle(QUIET, TIMEOUT)?;
		// The cursor-up key in keypad (application) mode.
		pty.write("\x1bOA")?;
		pty.settle(QUIET, TIMEOUT)?;
		pty.write("é")?;
		pty.wait_screen_contains("]", TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	assert!(zsh.contains("[x][|UP][é|][|1]"), "{zsh}");
	Ok(())
}

/// The terminal's user-defined keys (`kUP5`, `kDC5`, `kHOM7`, `kRIT5`) are
/// numbered as ncurses numbers them; standard ones keep their names.
#[test]
fn zsh_mod_curses_reads_user_defined_keys() -> io::Result<()> {
	let script = "zmodload zsh/curses
zcurses init
for i in 1 2 3 4 5 6 7 8; do zcurses input stdscr c k; r+=(\"$?|${(q)c}|$k\"); done
zcurses end
print -rl -- $r";
	let keys: [&[u8]; 8] = [
		b"\x1b[1;5A",
		b"\x1b[1;2B",
		b"\x1b[3;5~",
		b"\x1b[1;7H",
		b"\x1b[1;5C",
		b"\x1b[1;3P",
		b"\x1b[15;2~",
		b"\x1b[Z",
	];
	let Some((obash, zsh)) = both(script, |pty| {
		pty.settle(QUIET, TIMEOUT)?;
		for k in keys {
			pty.write(k)?;
			pty.settle(QUIET, TIMEOUT)?;
		}
		pty.wait_screen_contains("BTAB", TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	Ok(())
}

/// Scrolling, clearing and backgrounds change what the window shows.
#[test]
fn zsh_mod_curses_scrolls_and_clears() -> io::Result<()> {
	let script = "zmodload zsh/curses
zcurses init
zcurses addwin w 4 12 1 2
zcurses scroll w on
zcurses string w $'one\\ntwo\\nthree\\nfour\\nfive'
zcurses scroll w -1
zcurses addwin v 3 12 8 2
zcurses bg v @.
zcurses string v dots
zcurses move v 0 2
zcurses clear v eol
zcurses refresh w v
zcurses input w";
	let Some((obash, zsh)) = both(script, |pty| {
		pty.wait_screen_contains("four", TIMEOUT)?;
		pty.settle(QUIET, TIMEOUT)
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	Ok(())
}

/// Messages and statuses (no terminal needed: they come before or
/// without drawing).
#[test]
fn zsh_mod_curses_messages() -> io::Result<()> {
	let script = "zmodload zsh/curses
zcurses; print s=$?
zcurses foo; print s=$?
zcurses move; print s=$?
zcurses move w 1 2; print s=$?
zcurses init
zcurses move nope 1 1; print s=$?
zcurses addwin w 1 1 0 0 nope; print s=$?
zcurses addwin w 2 2 0 0
zcurses addwin x 9 9 0 0 w; print s=$?
zcurses delwin stdscr; print s=$?
zcurses clear w bogus; print s=$?
zcurses attr w blinky; print s=$?
zcurses attr w pink/blue; print s=$?
zcurses scroll w lots; print s=$?
zcurses timeout w soon; print s=$?
zcurses resize 0 0; print s=$?
zcurses end
zcurses addwin stdscr 1 1 0 0; print not reached";
	let Some((obash, zsh)) = both(script, |pty| {
		pty.wait(TIMEOUT)?;
		Ok(())
	})?
	else {
		return Ok(());
	};
	assert_eq!(obash, zsh);
	assert!(zsh.contains("window already defined: stdscr"), "{zsh}");
	Ok(())
}
