//! Job control of `obash` invoked as an interactive `zsh -f -i`, against the
//! real `/bin/zsh` on the same pty sessions: `^Z` on a foreground external,
//! `jobs`, `bg`, `fg` and `^C`, the terminal modes after a suspension, and
//! `exit` with a stopped job. Only the job lines are compared (`zsh: …`,
//! `[n] …`) with pids masked: the prompts are the line editor's.

#![cfg(unix)]

mod pty_support;

use std::{io, thread, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, have_real_zsh};

/// How long a just-typed external gets to start before a key signals it.
const START: Duration = Duration::from_millis(600);

/// An interactive `zsh -f` on a fresh pty: obash as `zsh`, or the real one.
fn shell(real: bool) -> io::Result<Pty> {
	let spawn = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	spawn.args(["-f", "-i"]).env("PS1", "").spawn()
}

/// Type `line` and a return.
fn line(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.write(format!("{text}\r"))
}

/// The job lines of `out` (`zsh: suspended  …`, `[1]  + running    …`,
/// `zsh: you have …`), the pid of `[1]  + 12345 …` and `[1] 12345`
/// replaced by `PID`.
fn job_lines(out: &str) -> Vec<String> {
	out.split('\n')
		.map(|l| {
			// What a line shows: the text after its last carriage return.
			let l = l.trim_end_matches('\r');
			let l = l.rsplit('\r').next().unwrap_or(l).trim_end();
			// The terminal's echo of `^Z` when no newline followed it.
			l.strip_prefix("^Z").unwrap_or(l).to_owned()
		})
		.filter(|l| l.starts_with("zsh: ") || l.starts_with('['))
		.map(|l| {
			let job = l.starts_with('[');
			let words: Vec<&str> = l
				.split(' ')
				.enumerate()
				.map(|(i, w)| {
					let pid = !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit());
					if pid && job && (i == 1 || i == 3) {
						"PID"
					} else {
						w
					}
				})
				.collect();
			words.join(" ")
		})
		.collect()
}

/// Run `drive` against obash and, when present, the real zsh; the job
/// lines of each.
fn both(
	drive: impl Fn(&mut Pty) -> io::Result<()>,
) -> io::Result<(Vec<String>, Option<Vec<String>>)> {
	let mut ours = shell(false)?;
	drive(&mut ours)?;
	let ours = job_lines(&ours.output());
	if !have_real_zsh() {
		return Ok((ours, None));
	}
	let mut real = shell(true)?;
	drive(&mut real)?;
	Ok((ours, Some(job_lines(&real.output()))))
}

/// `^Z` on `sleep 100` prints `zsh: suspended  sleep 100`, `jobs` lists the
/// stopped job, and `kill -9 %1` reports it killed before the next command.
#[test]
fn ctrl_z_suspends_a_foreground_job_and_jobs_lists_it() -> io::Result<()> {
	let (ours, real) = both(|pty| {
		line(pty, "sleep 100")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sleep 100", TIMEOUT)?;
		line(pty, "jobs")?;
		pty.read_until("[1]  + suspended  sleep 100", TIMEOUT)?;
		line(pty, "jobs -l")?;
		pty.read_until("suspended  sleep 100", TIMEOUT)?;
		line(pty, "kill -9 %1")?;
		line(pty, "echo next")?;
		pty.read_until("killed     sleep 100", TIMEOUT)?;
		pty.settle(Duration::from_millis(300), TIMEOUT)
	})?;
	assert_eq!(ours, [
		"zsh: suspended  sleep 100",
		"[1]  + suspended  sleep 100",
		"[1]  + PID suspended  sleep 100",
		"[1]  + killed     sleep 100",
	]);
	if let Some(real) = real {
		assert_eq!(ours, real);
	}
	Ok(())
}

/// `bg` continues the stopped job (`[1]  + continued  sleep 100`), `fg`
/// brings it back to the terminal, and `^C` interrupts it: `$?` is 130.
#[test]
fn bg_then_fg_then_ctrl_c() -> io::Result<()> {
	let (ours, real) = both(|pty| {
		line(pty, "sleep 100")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sleep 100", TIMEOUT)?;
		line(pty, "bg")?;
		pty.read_until("continued  sleep 100", TIMEOUT)?;
		line(pty, "jobs")?;
		pty.read_until("running    sleep 100", TIMEOUT)?;
		line(pty, "fg")?;
		pty.read_until("running    sleep 100", TIMEOUT)?;
		thread::sleep(START);
		pty.write("\x03")?;
		line(pty, "echo st=$?")?;
		pty.read_until("st=130", TIMEOUT)?;
		Ok(())
	})?;
	if let Some(real) = real {
		assert_eq!(ours, real);
	}
	Ok(())
}

/// A pipeline suspends as one job (`sleep 100 | cat`, its last stage run
/// by the shell itself); `fg` continues both, `^C` ends both.
#[test]
fn a_suspended_pipeline_is_one_job() -> io::Result<()> {
	let (ours, real) = both(|pty| {
		line(pty, "sleep 100 | cat")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sleep 100 | cat", TIMEOUT)?;
		line(pty, "jobs")?;
		pty.read_until("[1]  + suspended  sleep 100 | cat", TIMEOUT)?;
		line(pty, "fg")?;
		pty.read_until("continued  sleep 100 | cat", TIMEOUT)?;
		thread::sleep(START);
		pty.write("\x03")?;
		line(pty, "echo st=$?")?;
		pty.read_until("st=130", TIMEOUT)?;
		Ok(())
	})?;
	assert_eq!(ours, [
		"zsh: suspended  sleep 100 | cat",
		"[1]  + suspended  sleep 100 | cat",
		"[1]  + continued  sleep 100 | cat",
	]);
	if let Some(real) = real {
		assert_eq!(ours, real);
	}
	Ok(())
}

/// `^Z` inside a loop suspends the rest of the loop with it (zsh forks the
/// construct): the next iteration does not run until `fg`, the rest of the
/// command line is dropped, and the finished job is named by the loop.
#[test]
fn a_suspended_loop_takes_the_rest_of_the_loop_with_it() -> io::Result<()> {
	let (ours, real) = both(|pty| {
		line(pty, "for i in 1 2; do sleep 100; echo it$i; done; echo after")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sleep 100", TIMEOUT)?;
		line(pty, "jobs")?;
		pty.read_until("[1]  + suspended  sleep 100", TIMEOUT)?;
		line(pty, "kill -9 %1")?;
		line(pty, "echo done")?;
		pty.read_until("killed", TIMEOUT)?;
		pty.settle(Duration::from_millis(300), TIMEOUT)
	})?;
	assert_eq!(ours, [
		"zsh: suspended  sleep 100",
		"[1]  + suspended  sleep 100",
		"[1]  + killed     for i in 1 2; do; sleep 100; echo it$i; done",
	]);
	if let Some(real) = real {
		assert_eq!(ours, real);
	}
	Ok(())
}

/// A job that turned echo off and was suspended leaves the terminal as the
/// shell had it: the next command sees `echo` on.
#[test]
fn a_suspended_job_does_not_leave_its_terminal_modes() -> io::Result<()> {
	for real in [false, true] {
		if real && !have_real_zsh() {
			continue;
		}
		let mut pty = shell(real)?;
		line(&mut pty, "sh -c 'stty -echo; sleep 100'")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sh -c", TIMEOUT)?;
		line(&mut pty, "stty -a | tr ' ' '\\n' | grep -x -e echo -e -echo | sed 's/^/mode=/'")?;
		let seen = pty.read_until("\nmode=", TIMEOUT)?;
		let rest = pty.read_until("\n", TIMEOUT)?;
		assert_eq!(rest.trim_end(), "echo", "real zsh: {real}; {seen}");
	}
	Ok(())
}

/// `exit` with a stopped job warns once (`zsh: you have suspended jobs.`);
/// an `exit` right after leaves.
#[test]
fn exit_with_a_stopped_job_warns_once() -> io::Result<()> {
	let (ours, real) = both(|pty| {
		line(pty, "sleep 100")?;
		thread::sleep(START);
		pty.write("\x1a")?;
		pty.read_until("suspended  sleep 100", TIMEOUT)?;
		line(pty, "exit")?;
		pty.read_until("you have suspended jobs.", TIMEOUT)?;
		line(pty, "exit")?;
		pty.wait(TIMEOUT)?;
		Ok(())
	})?;
	assert_eq!(ours, ["zsh: suspended  sleep 100", "zsh: you have suspended jobs."]);
	if let Some(real) = real {
		assert_eq!(ours, real);
	}
	Ok(())
}
