//! Best-effort launcher for URLs and file paths via the OS default handler.
//!
//! Uses `open` on macOS, `ShellExecute` through PowerShell on Windows, and
//! `wslview`/`xdg-open` on Linux. Callers always keep a visible copy-URL
//! fallback; launch failures are logged, never surfaced.

use std::{
	process::{Command, Stdio},
	thread,
};

#[cfg(not(any(target_os = "macos", windows)))]
use url::Url;

/// Opens `target` (URL or file path) with the platform's registered handler.
///
/// Fire-and-forget: the caller never blocks and never fails. Spawn errors and
/// non-zero opener exits (e.g. `xdg-open` without an `https` handler) are
/// recorded via `tracing` so silent misconfigurations stay diagnosable.
pub fn open_path(target: &str) {
	let mut command = opener_command(target);
	command
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	match command.spawn() {
		Ok(mut child) => {
			let target = target.to_owned();
			// Reap off-thread: no zombies, and delayed failures still get logged.
			thread::spawn(move || match child.wait() {
				Ok(status) if !status.success() => {
					tracing::warn!(%target, %status, "external opener exited with non-zero status");
				},
				Ok(_) => {},
				Err(error) => {
					tracing::warn!(%target, %error, "failed to reap external opener");
				},
			});
		},
		Err(error) => {
			tracing::warn!(%target, %error, "failed to open external URL/path");
		},
	}
}

#[cfg(target_os = "macos")]
fn opener_command(target: &str) -> Command {
	let mut command = Command::new("open");
	command.arg(target);
	command
}

/// ShellExecute via PowerShell `Start-Process`:
/// unlike `rundll32 url.dll,FileProtocolHandler` it reports launch failures
/// (missing target, no handler, access denied) as a non-zero exit, and
/// `-EncodedCommand` keeps cmd/PowerShell metacharacter parsing (OAuth URLs
/// carry `&`) away from the target entirely — inside the decoded script the
/// target is a single-quoted literal with embedded quotes doubled.
#[cfg(windows)]
fn opener_command(target: &str) -> Command {
	use std::{env, os::windows::process::CommandExt, path::PathBuf};

	const CREATE_NO_WINDOW: u32 = 0x0800_0000;

	// Anchor PowerShell to System32: machine PATHs that dropped System32 are a
	// real-world occurrence. Bare-name fallback for exotic SystemRoot layouts.

	let system_root = env::var("SystemRoot")
		.ok()
		.map(|value| value.trim().to_owned())
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "C:\\Windows".to_owned());
	let absolute: PathBuf =
		[system_root.as_str(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"]
			.iter()
			.collect();
	let powershell = if absolute.is_file() {
		absolute
	} else {
		PathBuf::from("powershell.exe")
	};

	let script =
		format!("$ErrorActionPreference='Stop';Start-Process '{}'", target.replace('\'', "''"));
	let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
	let encoded = crate::base64::encode(&utf16le).into_string();

	let mut command = Command::new(powershell);
	command
		.args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
		.arg(encoded)
		.creation_flags(CREATE_NO_WINDOW);
	command
}

#[cfg(not(any(target_os = "macos", windows)))]
fn opener_command(target: &str) -> Command {
	// Under WSL, hand existing local files to the Windows side via `wslview`;
	// everything else (notably https URLs) goes through `xdg-open`.
	if let Some(windows_path) = wsl_windows_path(target) {
		let mut command = Command::new("wslview");
		command.arg(windows_path);
		return command;
	}
	let mut command = Command::new("xdg-open");
	command.arg(target);
	command
}

/// Converts `target` to a Windows path with `wslpath -w` when running under
/// WSL with `wslview` available and `target` names an existing local file.
/// Returns `None` for URLs, missing files, and non-WSL environments.
#[cfg(not(any(target_os = "macos", windows)))]
fn wsl_windows_path(target: &str) -> Option<String> {
	use std::{
		env,
		path::{self, PathBuf},
	};

	if env::var_os("WSL_DISTRO_NAME").is_none() && env::var_os("WSL_INTEROP").is_none() {
		return None;
	}
	if !on_path("wslview") {
		return None;
	}
	let local: PathBuf = if target.starts_with("file://") {
		Url::parse(target).ok()?.to_file_path().ok()?
	} else if has_url_scheme(target) {
		// Any non-file scheme (https, vscode, …) belongs to xdg-open.
		return None;
	} else {
		path::absolute(target).ok()?
	};
	if !local.exists() {
		return None;
	}
	let output = Command::new("wslpath")
		.arg("-w")
		.arg(&local)
		.stderr(Stdio::null())
		.output()
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let converted = str::from_utf8(&output.stdout).ok()?.trim();
	(!converted.is_empty()).then(|| converted.to_owned())
}

/// Recognizes URI schemes (`^[a-zA-Z][a-zA-Z\d+.-]*:`).
#[cfg(not(any(target_os = "macos", windows)))]
fn has_url_scheme(target: &str) -> bool {
	let mut bytes = target.bytes();
	if !bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic()) {
		return false;
	}
	for byte in bytes {
		match byte {
			b':' => return true,
			byte if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-') => {},
			_ => return false,
		}
	}
	false
}

/// Reports whether an executable `name` is reachable through `PATH`.
#[cfg(not(any(target_os = "macos", windows)))]
fn on_path(name: &str) -> bool {
	use std::{env, os::unix::fs::PermissionsExt};

	env::var_os("PATH").is_some_and(|path| {
		env::split_paths(&path).any(|dir| {
			let candidate = dir.join(name);
			candidate
				.metadata()
				.is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
		})
	})
}
