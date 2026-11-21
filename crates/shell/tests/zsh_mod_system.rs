//! zsh/system on real files and processes, through the obash binary run as
//! `zsh -f -c SCRIPT` in a fresh temporary directory: `sysopen` (flags,
//! modes, close-on-exec), `sysseek`/`systell`, `sysread`/`syswrite` on
//! files, and `zsystem flock` contention between two shells. Expected
//! output from `/bin/zsh -f -c SCRIPT` 5.9 in the same setup (macOS), with
//! `SH=/bin/zsh` for the second shell. fd numbers are not compared: zsh's
//! own input occupies fd 10 there.

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, process::Command};

use crate::obash_support::{obash, output};

/// Run `script` as `zsh -f -c script` in a new empty directory, with
/// `$SH` naming the obash binary: stdout, stderr, status.
fn zsh(script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd: Command = obash();
	cmd.arg0("zsh");
	let out = output(
		cmd.current_dir(dir.path())
			.env("SH", env!("CARGO_BIN_EXE_obash"))
			.args(["-f", "-c", script]),
	);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

#[test]
fn zsh_mod_system_sysopen_sysseek_systell_on_files() {
	let (out, err, st) = zsh(
		"zmodload zsh/system
sysopen -w -o create -u fd f2; (( fd >= 10 )) && echo high; syswrite -o $fd hello; echo $(( \
		 systell(fd) ))
sysseek -u $fd 1; echo $(( systell(fd) )); sysseek -u $fd -w end 0; echo $(( systell(fd) )); \
		 sysseek -u $fd -w current -2; echo $(( systell(fd) ))
syswrite -o $fd XY; exec {fd}>&-; cat f2; echo
sysopen -r -u 5 f2; sysread -i 5 x; print -r $x; sysseek -u 5 -w start 2; sysread -i 5 -s 2 y; \
		 print $y; echo $(( systell(5) )); sysseek -u 5 -5; echo $?; syserror
sysopen -w -o excl -u fd f2; echo $?; sysopen -a -u fd f2; syswrite -o $fd .; cat f2; echo
sysopen -w -m 600 -o create,O_TRUNC -u fd f3; ls -l f3 | cut -c1-10
sysopen -r -o cloexec -u fd f2; cat /dev/fd/$fd 2>/dev/null; echo $?
sysopen -r -u fd f2; cat /dev/fd/$fd; echo; echo $?
sysopen -r -u fd nonexist; echo $?
sysopen -w -o nofollow -u fd f2; echo $?; ln -s f2 sl; sysopen -w -o nofollow -u fd sl; echo $?",
	);
	assert_eq!(
		out,
		"high\n5\n1\n5\n3\nhelXY\nhelXY\nlX\n4\n2\n1\nhelXY.\n-rw-------\n1\nhelXY.\n0\n1\n0\n1\n"
	);
	assert_eq!(
		err,
		"Invalid argument
zsh:sysopen:6: can't open file f2: file exists
zsh:sysopen:10: can't open file nonexist: no such file or directory
zsh:sysopen:11: can't open file sl: too many levels of symbolic links
"
	);
	assert_eq!(st, 0);
}

/// powerlevel10k's and gitstatus's uses: an append-and-truncate open with a
/// mode, and a close-on-exec descriptor on a process substitution read
/// with timeouts into array elements.
#[test]
fn zsh_mod_system_p10k_and_gitstatus_paths() {
	let (out, err, st) = zsh(
		r#"zmodload zsh/system zsh/zselect zsh/mathfunc
sysopen -r -o cloexec -u fd <(print -n 1234; sleep 0.2; print -n abc) || exit
(( sysparams[procsubstpid] > 0 )) && echo pid
local buf; sysread -t 1 -i $fd "buf[$#buf+1]"; echo $? $buf
sysread -s 2 -t 0.05 -i $fd "buf[$#buf+1]"; echo $? $buf
sysread -t 1 -i $fd "buf[$#buf+1]"; echo $? $buf
sysread -t 1 -i $fd x; echo $?
typeset -gi P="sysparams[pid]"; (( P == $$ )) && echo pidok
t=0.05; zselect -t $((int(ceil(100 * (t - EPOCHREALTIME % t))))) || true; echo z
sysopen -a -m 600 -o creat,trunc -u fd2 -- tmpf && syswrite -o $fd2 data && cat tmpf; echo
ls -l tmpf | cut -c1-10"#,
	);
	assert_eq!(out, "pid\n0 1234\n4 1234\n0 1234abc\n5\npidok\nz\ndata\n-rw-------\n");
	assert_eq!(err, "");
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_flock_contention_between_two_shells() {
	let (out, err, st) = zsh(
		r#"zmodload zsh/system
: > lk; ln -s $SH zsh
zsystem flock -f fd lk || exit
./zsh -f -c "zmodload zsh/system; zsystem flock -t 0 lk; echo \$?; zsystem flock -t 0.2 -i 0.05 lk; echo \$?; zsystem flock -r -t 0 lk; echo \$?"
./zsh -f -c "zmodload zsh/system; zsystem flock lk; echo got" &
sleep 0.3; echo unlocking; zsystem flock -u $fd; wait
./zsh -f -c "zmodload zsh/system; zsystem flock -t 0 -f f lk; echo \$?""#,
	);
	assert_eq!(out, "1\n2\n1\nunlocking\ngot\n0\n");
	assert_eq!(
		err,
		"zsh:zsystem:1: failed to lock file lk: resource temporarily unavailable
zsh:zsystem:1: failed to lock file lk: resource temporarily unavailable
"
	);
	assert_eq!(st, 0);
}

/// A subshell is a process of its own in zsh: its lock conflicts with its
/// parent's and its children's (zsh's Test/V14system.ztst "unsuccessful
/// wait test"), ends when it exits, and a parent's lock is not inherited;
/// releasing one lock fd ends all of the shell's locks on the file.
#[test]
fn zsh_mod_system_flock_subshells_are_processes() {
	let (out, err, st) = zsh(
		"zmodload zsh/system zsh/zselect
: > file
(zsystem flock file && : > locked && zselect -t 100; mv locked locked.done) &
while ! [[ -f locked || -f locked.done ]]; do zselect -t 1; done
zsystem flock -t 0.5 file; echo $?
zsystem flock -t 0 file; echo $?
wait
zsystem flock -t 0 -f fd file; echo $?
( zsystem flock -t 0 file ); echo $?
zsystem flock -t 0 file; echo $?
zsystem flock -u $fd; ( zsystem flock -t 0 file ); echo $?",
	);
	assert_eq!(out, "2\n1\n0\n1\n0\n0\n");
	assert_eq!(
		err,
		"zsh:zsystem:6: failed to lock file file: resource temporarily unavailable
zsh:zsystem:9: failed to lock file file: resource temporarily unavailable
"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_system_flock_fd_is_close_on_exec_unless_e() {
	let (out, _, st) = zsh(
		"zmodload zsh/system; : > lk; zsystem flock -f a lk; cat /dev/fd/$a 2>/dev/null; echo $?; \
		 zsystem flock -u $a; zsystem flock -e -f b lk; cat /dev/fd/$b; echo $?",
	);
	assert_eq!(out, "1\n0\n");
	assert_eq!(st, 0);
}
