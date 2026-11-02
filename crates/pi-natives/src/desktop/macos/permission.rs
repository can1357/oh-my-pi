//! macOS privacy permissions. TCC charges each grant to the responsible
//! process: the app that launched omp (a terminal or IDE), or omp itself when
//! no app did.

use std::{
	ffi::{CStr, OsStr},
	os::unix::ffi::OsStrExt,
	path::Path,
};

use objc2_app_kit::NSRunningApplication;
use objc2_core_graphics::{CGPreflightListenEventAccess, CGPreflightPostEventAccess};
use objc2_foundation::NSProcessInfo;

use super::super::error::DesktopError;

type ResponsiblePid = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

/// Private libSystem export with the signature `pid_t (pid_t)`.
const RESPONSIBLE_PID: &CStr = c"responsibility_get_pid_responsible_for_pid";

/// Whether synthesized events reach the event stream (granted with
/// Accessibility).
pub(super) fn post_events() -> bool {
	CGPreflightPostEventAccess()
}

/// Whether an event tap sees user input. Accessibility provides this unless
/// Input Monitoring is turned off for the launching app; a listen-only tap is
/// then still created but receives neither keys nor clicks.
pub(super) fn listen_events() -> bool {
	CGPreflightListenEventAccess()
}

/// The Privacy & Security pane that grants screen capture; macOS 15 renamed
/// it.
pub(super) fn screen_recording_pane() -> &'static str {
	if NSProcessInfo::processInfo()
		.operatingSystemVersion()
		.majorVersion
		>= 15
	{
		"Screen & System Audio Recording"
	} else {
		"Screen Recording"
	}
}

/// A denial naming the app to enable in the Privacy & Security `pane`: the
/// terminal or IDE that launched omp, or omp itself when nothing did.
pub(super) fn denied(pane: &str) -> DesktopError {
	let message = match responsible_app(RESPONSIBLE_PID) {
		Some(app) => format!(
			"macOS {pane} permission is not granted to {app}, which macOS holds responsible for omp; \
			 enable {app} in System Settings > Privacy & Security > {pane}"
		),
		None => format!(
			"macOS {pane} permission is not granted to the app that launched omp; enable that \
			 terminal or IDE in System Settings > Privacy & Security > {pane}"
		),
	};
	DesktopError::permission_denied(message)
}

fn responsible_app(symbol_name: &CStr) -> Option<String> {
	// SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name only reads the
	// loaded images. The private libSystem export may be absent.
	let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, symbol_name.as_ptr()) };
	if symbol.is_null() {
		return None;
	}
	// SAFETY: the export has the signature `pid_t (pid_t)`.
	let responsible: ResponsiblePid = unsafe { std::mem::transmute(symbol) };
	// SAFETY: the call only reads the kernel's responsibility record.
	let pid = unsafe { responsible(libc::getpid()) };
	if pid <= 0 {
		return None;
	}
	if let Some(name) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.localizedName())
	{
		return Some(name.to_string());
	}
	let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
	let capacity = u32::try_from(buffer.len()).ok()?;
	// SAFETY: `buffer` is writable for `capacity` bytes for the synchronous
	// call.
	let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity) };
	let executable = buffer.get(..usize::try_from(length).ok().filter(|&length| length > 0)?)?;
	Some(
		Path::new(OsStr::from_bytes(executable))
			.display()
			.to_string(),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn missing_responsibility_export_names_no_app() {
		assert_eq!(responsible_app(c"pi_natives_missing_responsibility_export"), None);
	}
}
