//! Terminal utilities.

use std::path::PathBuf;

use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
	System::{
		Console::{
			ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
			ENABLE_PROCESSED_OUTPUT, GetConsoleMode, GetConsoleWindow, GetStdHandle,
			STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleMode,
		},
		Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
			TH32CS_SNAPPROCESS,
		},
		Threading::GetCurrentProcessId,
	},
	UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow},
};

use crate::{error, openfiles, sys, terminal};

struct Snapshot(HANDLE);

impl Drop for Snapshot {
	fn drop(&mut self) {
		// SAFETY: `self.0` is a live snapshot handle returned by
		// `CreateToolhelp32Snapshot` and is owned by this `Snapshot`; after `drop`
		// no code in this module uses the handle again.
		let _ = unsafe { CloseHandle(self.0) };
	}
}

/// Terminal configuration.
#[derive(Clone, Debug)]
pub struct Config {
	input_mode: u32,
	output_mode: u32,
}

impl Config {
	/// Creates a new `Config` from the actual terminal attributes of the
	/// terminal associated with the given file descriptor.
	///
	/// # Arguments
	///
	/// * `_file` - A reference to the open terminal.
	pub fn from_term(_file: &openfiles::OpenFile) -> Result<Self, error::Error> {
		let input_handle = console_input_handle()?;
		let output_handle = console_output_handle()?;

		let input_mode = console_mode(input_handle)?;
		let output_mode = console_mode(output_handle)?;

		Ok(Self {
			input_mode,
			output_mode,
		})
	}

	/// Applies the terminal settings to the terminal associated with the given
	/// file descriptor.
	///
	/// # Arguments
	///
	/// * `_file` - A reference to the open terminal.
	pub fn apply_to_term(&self, _file: &openfiles::OpenFile) -> Result<(), error::Error> {
		let input_handle = console_input_handle()?;
		let output_handle = console_output_handle()?;

		set_console_mode(input_handle, self.input_mode)?;
		set_console_mode(output_handle, self.output_mode)?;

		Ok(())
	}

	/// Applies the given high-level terminal settings to this configuration.
	/// Does not modify any terminal itself.
	///
	/// # Arguments
	///
	/// * `settings` - The high-level terminal settings to apply to this
	///   configuration.
	pub fn update(&mut self, settings: &terminal::Settings) {
		if let Some(echo_input) = settings.echo_input {
			if echo_input {
				self.input_mode |= ENABLE_ECHO_INPUT;
			} else {
				self.input_mode &= !ENABLE_ECHO_INPUT;
			}
		}

		if let Some(line_input) = settings.line_input {
			if line_input {
				self.input_mode |= ENABLE_LINE_INPUT;
			} else {
				self.input_mode &= !ENABLE_LINE_INPUT;
			}
		}

		if let Some(interrupt_signals) = settings.interrupt_signals {
			if interrupt_signals {
				self.input_mode |= ENABLE_PROCESSED_INPUT;
			} else {
				self.input_mode &= !ENABLE_PROCESSED_INPUT;
			}
		}

		if let Some(output_nl_as_nlcr) = settings.output_nl_as_nlcr {
			if output_nl_as_nlcr {
				self.output_mode |= ENABLE_PROCESSED_OUTPUT;
			} else {
				self.output_mode &= !ENABLE_PROCESSED_OUTPUT;
			}
		}
	}
}

/// Get the process ID of this process's parent.
pub fn get_parent_process_id() -> Option<sys::process::ProcessId> {
	let pid = current_process_id();
	let snapshot = create_process_snapshot()?;

	let mut entry = PROCESSENTRY32W {
		dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
		// SAFETY: `PROCESSENTRY32W` is a plain C data structure, and zeroed fields
		// are accepted by the ToolHelp APIs as long as `dwSize` is initialized.
		..unsafe { std::mem::zeroed() }
	};

	// SAFETY: `snapshot.0` is a valid snapshot handle owned by `snapshot`, and
	// `entry` points to initialized writable storage with `dwSize` populated as
	// required by `Process32FirstW`.
	let mut result = unsafe { Process32FirstW(snapshot.0, &mut entry) };
	while result != 0 {
		if entry.th32ProcessID == pid {
			return Some(entry.th32ParentProcessID as sys::process::ProcessId);
		}

		// SAFETY: `snapshot.0` remains valid for the duration of the loop, and
		// `entry` remains valid writable storage for the next process entry.
		result = unsafe { Process32NextW(snapshot.0, &mut entry) };
	}

	None
}

/// Get the process group ID for this process's process group.
pub fn get_process_group_id() -> Option<sys::process::ProcessId> {
	Some(current_process_id() as sys::process::ProcessId)
}

/// Get the foreground process ID of the attached terminal.
pub fn get_foreground_pid() -> Option<sys::process::ProcessId> {
	// SAFETY: `GetForegroundWindow` takes no parameters and returns either null
	// or a window handle managed by the OS; this code only inspects the handle.
	let hwnd = unsafe { GetForegroundWindow() };
	if hwnd.is_null() {
		return None;
	}

	let mut pid = 0u32;
	// SAFETY: `hwnd` is non-null and came from `GetForegroundWindow`; `pid`
	// points to writable storage for the process id output.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	(pid != 0).then_some(pid as sys::process::ProcessId)
}

/// Move the specified process to the foreground of the attached terminal.
pub fn move_to_foreground(_pid: sys::process::ProcessId) -> Result<(), error::Error> {
	// SAFETY: `GetConsoleWindow` takes no parameters and returns either null or
	// the console window handle for this process; the handle is only passed back
	// to another Win32 API.
	let hwnd = unsafe { GetConsoleWindow() };
	if !hwnd.is_null() {
		// SAFETY: `hwnd` is the non-null console window handle returned by
		// `GetConsoleWindow`; the OS validates whether foreground activation is
		// permitted, and failure is intentionally ignored to match shell best effort.
		let _ = unsafe { SetForegroundWindow(hwnd) };
	}
	Ok(())
}

/// Moves the current process to the foreground of the attached terminal.
pub fn move_self_to_foreground() -> Result<(), std::io::Error> {
	let pid = current_process_id();
	move_to_foreground(pid as sys::process::ProcessId)
		.map_err(|err| std::io::Error::other(err.to_string()))
}

/// Tries to get the path of the terminal device associated with the attached
/// terminal.
pub fn try_get_terminal_device_path() -> Option<PathBuf> {
	None
}

fn current_process_id() -> u32 {
	// SAFETY: `GetCurrentProcessId` takes no parameters and has no preconditions.
	unsafe { GetCurrentProcessId() }
}

fn create_process_snapshot() -> Option<Snapshot> {
	// SAFETY: `TH32CS_SNAPPROCESS` is a documented snapshot flag, and the second
	// argument is ignored for process snapshots when set to zero.
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE_VALUE {
		None
	} else {
		Some(Snapshot(snapshot))
	}
}

fn console_input_handle() -> Result<HANDLE, error::Error> {
	// SAFETY: `STD_INPUT_HANDLE` is a documented pseudo-handle selector for
	// `GetStdHandle`; the returned handle is validated before use.
	let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
	validate_handle(handle)
}

fn console_output_handle() -> Result<HANDLE, error::Error> {
	// SAFETY: `STD_OUTPUT_HANDLE` is a documented pseudo-handle selector for
	// `GetStdHandle`; the returned handle is validated before use.
	let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
	validate_handle(handle)
}

fn validate_handle(handle: HANDLE) -> Result<HANDLE, error::Error> {
	if handle.is_null() || handle == INVALID_HANDLE_VALUE {
		return Err(std::io::Error::last_os_error().into());
	}

	Ok(handle)
}

fn console_mode(handle: HANDLE) -> Result<u32, error::Error> {
	let mut mode = 0u32;
	// SAFETY: `handle` has been validated as non-null/non-invalid by
	// `validate_handle`, and `mode` points to writable storage for the console
	// mode output.
	if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
		return Err(std::io::Error::last_os_error().into());
	}

	Ok(mode)
}

fn set_console_mode(handle: HANDLE, mode: u32) -> Result<(), error::Error> {
	// SAFETY: `handle` has been validated as non-null/non-invalid by
	// `validate_handle`; `mode` is a bitset obtained from or derived from Win32
	// console mode flags, and the OS validates unsupported combinations.
	if unsafe { SetConsoleMode(handle, mode) } == 0 {
		return Err(std::io::Error::last_os_error().into());
	}

	Ok(())
}
