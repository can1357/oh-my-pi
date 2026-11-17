//! Traps must receive signals sent to the real obash process, not just vpids.

#![cfg(unix)]

mod obash_support;

use std::{io, os::unix::process::CommandExt, time::Duration};

use crate::obash_support::{command, finish, obash, output};

#[test]
fn external_signal_runs_trap_in_a_busy_function() {
	let script = "trap 'echo trapped; return 23' USR1; f() { while :; do :; done; }; /bin/sh -c \
	              'kill -USR1 \"$1\"' _ \"$$\" & f; echo status=$?";
	let child = obash().args(["-c", script]).spawn().unwrap();
	// A trap that does not interrupt the busy function fails it here.
	let out = finish(child, Duration::from_secs(5));
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"trapped\nstatus=23\n");
}

#[test]
fn trapped_signal_waits_for_foreground_command() {
	let out = output(obash().args([
		"-c",
		"trap 'echo trapped' USR1; (/bin/sleep .05; /bin/kill -USR1 $$) & /bin/sh -c '/bin/sleep \
		 .2; echo child'; echo done",
	]));
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"child\ntrapped\ndone\n");
}

#[test]
fn signals_ignored_on_entry_remain_ignored() {
	let out = output(command("/bin/sh").args([
		"-c",
		"trap '' USR1; exec \"$1\" -c \"$2\"",
		"_",
		env!("CARGO_BIN_EXE_obash"),
		"trap 'echo wrong' USR1; kill -USR1 $$; echo survived; trap -p USR1",
	]));
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"survived\ntrap -- '' SIGUSR1\n");
}

#[test]
fn inherited_sigpipe_ignore_cannot_be_overridden() {
	let out = output(command("/bin/sh").args([
		"-c",
		"trap '' PIPE; exec \"$1\" -c \"$2\"",
		"_",
		env!("CARGO_BIN_EXE_obash"),
		"trap 'echo wrong' PIPE; kill -PIPE $$; trap -p PIPE; echo survived",
	]));
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"trap -- '' SIGPIPE\nsurvived\n");
}

#[test]
fn sigpipe_with_default_disposition_can_be_trapped() {
	let mut cmd = obash();
	cmd.args(["-c", "trap 'echo caught' PIPE; kill -PIPE $$; echo survived"]);
	// SAFETY: the child restores the signal disposition before exec.
	unsafe {
		cmd.pre_exec(|| {
			if libc::signal(libc::SIGPIPE, libc::SIG_DFL) == libc::SIG_ERR {
				Err(io::Error::last_os_error())
			} else {
				Ok(())
			}
		});
	}
	let out = output(&mut cmd);
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"caught\nsurvived\n");
}

#[test]
fn ignored_traps_are_inherited_by_external_programs() {
	let out =
		output(obash().args(["-c", "trap '' USR1; /bin/sh -c 'kill -USR1 $$; echo inherited'"]));
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert_eq!(out.stdout, b"inherited\n");
}
