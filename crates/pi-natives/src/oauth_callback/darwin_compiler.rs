use std::{
	ffi::OsStr,
	path::PathBuf,
	process::{Command, Stdio},
};

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

/// Resolves the macOS SDK to pass as `-isysroot`, mirroring rustc and the `cc`
/// crate.
///
/// Without an explicit sysroot, Apple clang prefers
/// `/Library/Developer/CommandLineTools/SDKs` even when `xcode-select` points
/// at Xcode.app. When the Command Line Tools ship a newer SDK than Xcode's
/// linker understands, the `.tbd` stubs fail to parse (`unknown architecture`).
/// Pinning the SDK that belongs to the selected developer dir keeps linker and
/// SDK in lockstep.
///
/// `SDKROOT` wins when set and non-empty; otherwise `xcrun --sdk macosx
/// --show-sdk-path` is consulted. Returns `None` when neither yields a path,
/// letting clang fall back to its default.
pub(crate) fn darwin_sdk_root(sdkroot: Option<&OsStr>) -> Option<PathBuf> {
	if let Some(sdkroot) = sdkroot.filter(|value| !value.is_empty()) {
		return Some(PathBuf::from(sdkroot));
	}
	let output = Command::new("/usr/bin/xcrun")
		.args(["--sdk", "macosx", "--show-sdk-path"])
		.stdin(Stdio::null())
		.stderr(Stdio::null())
		.output()
		.ok()
		.filter(|output| output.status.success())?;
	let path = String::from_utf8(output.stdout).ok()?;
	let path = path.trim();
	(!path.is_empty()).then(|| PathBuf::from(path))
}
