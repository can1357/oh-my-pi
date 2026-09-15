use std::{ffi::OsStr, process::Command};

pub(crate) fn darwin_compiler_command(cc: Option<&OsStr>) -> Command {
	let words = cc
		.and_then(|cc| cc.to_str())
		.and_then(shlex::split)
		.unwrap_or_default();

	if let Some((program, args)) = words.split_first() {
		let mut cmd = Command::new(program);
		cmd.args(args);
		cmd
	} else {
		let mut cmd = Command::new("/usr/bin/xcrun");
		cmd.arg("clang");
		cmd
	}
}
