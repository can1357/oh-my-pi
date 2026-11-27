//! zsh/rlimits on the real host, through the obash binary run as
//! `zsh -f -c SCRIPT`: listings in every format, units, the shell's own
//! limits versus its children's (`limit -s`, `ulimit`), and the limits
//! spawned commands see. Limits depend on the machine, so each script is
//! compared with `/bin/zsh -f -c SCRIPT` 5.9 run the same way (skipped
//! where there is no `/bin/zsh`); the engine process's own limits must
//! not change.

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, path::Path, process::Command};

use crate::obash_support::{command, obash, output};

/// Run `script` as `zsh -f -c script` with `shell`: stdout, stderr,
/// status.
fn run(mut shell: Command, script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let out = output(shell.current_dir(dir.path()).args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

fn obash_zsh(script: &str) -> (String, String, i32) {
	let mut cmd = obash();
	cmd.arg0("zsh");
	run(cmd, script)
}

/// `script` under obash and under `/bin/zsh` give the same output and
/// status.
fn same_as_zsh(script: &str) {
	if !Path::new("/bin/zsh").exists() {
		return;
	}
	let want = run(command("/bin/zsh"), script);
	assert_eq!(obash_zsh(script), want, "{script}");
}

fn host_nofile() -> (libc::rlim_t, libc::rlim_t) {
	let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
	// SAFETY: `lim` is a valid, writable `rlimit` for the call.
	assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut lim) }, 0);
	(lim.rlim_cur, lim.rlim_max)
}

#[test]
fn zsh_mod_rlimits_listings_match_zsh() {
	same_as_zsh(
		"limit; limit -h; ulimit -a; ulimit -Ha; ulimit; ulimit -n; ulimit -c -n; ulimit -tn",
	);
	same_as_zsh(
		"limit descriptors; limit -h stacksize; limit 3; limit c; ulimit -N 3; ulimit -s -n",
	);
}

#[test]
fn zsh_mod_rlimits_units_match_zsh() {
	same_as_zsh(
		"limit cputime 1:30; limit cputime; limit cputime 2h; limit cputime; limit cputime 3m; \
		 limit cputime; limit stacksize 1m; limit stacksize; ulimit -s; limit filesize 2g; limit \
		 filesize; limit coredumpsize 10; limit coredumpsize; ulimit -c; ulimit -c 10; ulimit -c; \
		 limit coredumpsize",
	);
}

#[test]
fn zsh_mod_rlimits_children_see_the_limits() {
	let before = host_nofile();
	let (out, err, st) =
		obash_zsh("limit descriptors 100; limit descriptors; ulimit -n; sh -c 'ulimit -n'");
	assert_eq!((out.as_str(), err.as_str(), st), ("descriptors     100\n100\n100\n", "", 0));
	let (out, err, st) =
		obash_zsh("ulimit -n 64; ulimit -n; sh -c 'ulimit -n'; (sh -c 'ulimit -n')");
	assert_eq!((out.as_str(), err.as_str(), st), ("64\n64\n64\n", "", 0));
	let (out, err, st) = obash_zsh(
		"(limit descriptors 99; sh -c 'ulimit -n'); limit -s descriptors 98; sh -c 'ulimit -n'",
	);
	assert_eq!((out.as_str(), err.as_str(), st), ("99\n98\n", "", 0));
	assert_eq!(host_nofile(), before, "the engine's own limits are untouched");
}

#[test]
fn zsh_mod_rlimits_shell_and_child_hard_limits_match_zsh() {
	// `limit -h` without `-s` changes only the children's limits, so it may
	// raise them again; `ulimit` applies to the shell.
	same_as_zsh("limit -h descriptors 100; limit -h descriptors 200; limit -h descriptors; echo $?");
	same_as_zsh("ulimit -n 100; ulimit -Hn 50; ulimit -n; ulimit -Hn; echo $?");
	same_as_zsh("ulimit -Sn 100 -Hn 200; echo $?; ulimit -n -Hn");
	same_as_zsh(
		"ulimit -n 64; ulimit -Sn hard; ulimit -n; ulimit -n 64; ulimit -n unlimited; echo $?",
	);
	same_as_zsh("limit -s descriptors 100; limit -s -h descriptors 90; echo $?; limit descriptors");
	same_as_zsh(
		"limit -h descriptors 100; limit descriptors 200; echo $?; unlimit descriptors; limit \
		 descriptors",
	);
	same_as_zsh("limit -s; echo $?; unlimit; echo $?; unlimit -h; echo $?");
}
