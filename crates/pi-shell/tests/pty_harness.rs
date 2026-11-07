//! Self-test of the pty harness (`tests/pty_support`): its screen model,
//! the real zsh driven interactively, and obash invoked as `zsh` against
//! `/bin/zsh` on the same terminal sessions.

#![cfg(unix)]

mod pty_support;

use std::{io, time::Duration};

use pty_support::{Screen, Spawn, TIMEOUT, differential, have_real_zsh};

#[test]
fn the_screen_model_prints_wraps_and_erases() {
	let mut s = Screen::new(3, 5);
	s.feed(b"abcdefg\r\nxy\x1b[1;2H\x1b[K");
	assert_eq!(s.contents(), "a\nfg\nxy");
	s.feed(b"\x1b[2J\x1b[Hhi\x1b[6n");
	assert_eq!(s.contents(), "hi");
	assert_eq!(s.take_replies(), b"\x1b[1;3R");
}

#[test]
fn the_screen_model_scrolls_and_switches_screens() {
	let mut s = Screen::new(2, 4);
	s.feed(b"1\r\n2\r\n3");
	assert_eq!(s.contents(), "2\n3");
	s.feed(b"\x1b[?1049hX\x1b[?1049l");
	assert_eq!(s.contents(), "2\n3");
	s.feed("\x1b]0;title\x07é漢".as_bytes());
	assert_eq!(s.row(1), "3é漢");
	s.resize(3, 6);
	assert_eq!(s.contents(), "2\n3é漢");
}

/// The harness drives a real interactive zsh: prompt, a command, a resize
/// it notices (`SIGWINCH`), `exit`.
#[test]
fn drives_the_real_zsh_interactively() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	let mut zsh = Spawn::real_zsh()
		.args(["-f", "-i"])
		.env("PS1", "P> ")
		.spawn()?;
	// Screen rows are compared without trailing blanks.
	zsh.wait_screen_contains("P>", TIMEOUT)?;
	zsh.write("print -r -- $((6*7))\r")?;
	zsh.wait_screen_contains("42", TIMEOUT)?;
	zsh.resize(30, 100)?;
	zsh.write("print -r -- size=$LINES:$COLUMNS\r")?;
	zsh.wait_screen_contains("size=30:100", TIMEOUT)?;
	zsh.write("exit 3\r")?;
	assert_eq!(zsh.wait(TIMEOUT)?.code(), Some(3));
	Ok(())
}

/// The same `-c` session on obash-as-zsh and the real zsh: a terminal on
/// stdin, its size, a line read in canonical mode (echoed by the tty)
/// leave the same screen.
#[test]
fn obash_as_zsh_and_zsh_leave_the_same_screen() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	let script = "if [ -t 0 ]; then print tty; fi; stty size; read line; print -r -- \"got:$line\"";
	let run = |pty: &mut pty_support::Pty| -> io::Result<()> {
		pty.read_until("24 80", TIMEOUT)?;
		pty.write("abc\r")?;
		pty.read_until("got:abc", TIMEOUT)?;
		assert_eq!(pty.wait(TIMEOUT)?.code(), Some(0));
		Ok(())
	};
	let (obash, zsh) = differential(
		Spawn::zsh().args(["-f", "-c", script]),
		Spawn::real_zsh().args(["-f", "-c", script]),
		run,
	)?;
	assert_eq!(obash, zsh);
	assert_eq!(zsh, "tty\n24 80\nabc\ngot:abc");
	Ok(())
}

/// A resize reaches the terminal both shells' children read.
#[test]
fn a_resize_is_seen_by_both() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	let script = "read x; stty size";
	let (obash, zsh) = differential(
		Spawn::zsh().args(["-f", "-c", script]),
		Spawn::real_zsh().args(["-f", "-c", script]),
		|pty| {
			pty.settle(Duration::from_millis(200), TIMEOUT)?;
			pty.resize(30, 100)?;
			pty.write("\r")?;
			pty.read_until("30 100", TIMEOUT)?;
			pty.wait(TIMEOUT).map(drop)
		},
	)?;
	assert_eq!(obash, zsh);
	Ok(())
}

/// `^C` on the terminal ends `zsh -c 'sleep 100'` by `SIGINT`, the shell
/// and the command alike (they share the foreground process group).
#[test]
fn ctrl_c_ends_a_foreground_command_like_zsh() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	let mut statuses = Vec::new();
	for spawn in [Spawn::zsh(), Spawn::real_zsh()] {
		let mut pty = spawn.args(["-f", "-c", "sleep 100"]).spawn()?;
		std::thread::sleep(Duration::from_millis(300));
		pty.write("\x03")?;
		statuses.push(std::os::unix::process::ExitStatusExt::signal(&pty.wait(TIMEOUT)?));
	}
	assert_eq!(statuses, [Some(libc::SIGINT), Some(libc::SIGINT)]);
	Ok(())
}
