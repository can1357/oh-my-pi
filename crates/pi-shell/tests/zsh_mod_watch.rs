//! zsh/watch on the real host's login database (utmpx), through the obash
//! binary run as `zsh -f -c SCRIPT`. The sessions depend on the machine,
//! so each script is compared with `/bin/zsh -f -c SCRIPT` 5.9 run the
//! same way (skipped where there is no `/bin/zsh`).

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, path::Path, process::Command};

use crate::obash_support::{command, obash, output};

/// Run `script` as `zsh -f -c script` with `shell`: stdout, stderr,
/// status.
fn run(mut shell: Command, script: &str) -> (String, String, i32) {
	let out = output(shell.args(["-f", "-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// `script` under obash and under `/bin/zsh` give the same output and
/// status.
fn same_as_zsh(script: &str) {
	if !Path::new("/bin/zsh").exists() {
		return;
	}
	let want = run(command("/bin/zsh"), script);
	let mut cmd = obash();
	cmd.arg0("zsh");
	assert_eq!(run(cmd, script), want, "{script}");
}

#[test]
fn zsh_mod_watch_log_matches_zsh() {
	same_as_zsh("zmodload zsh/watch; log; echo $?; watch=(all); log; echo $?");
	same_as_zsh(
		"zmodload zsh/watch; watch=(all); WATCHFMT='%n|%a|%l|%m|%M|%T|%t|%W|%D|%w|%D{%Y \
		 %H:%M:%S}|%(m.remote.local)|%F{red}%f'; log",
	);
	same_as_zsh(
		"zmodload zsh/watch; watch=(notme); log; watch=(\"$USER\"); log; watch=(nosuchuser); log",
	);
}
