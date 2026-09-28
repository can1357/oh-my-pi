//! Windows known folder resolution via SHGetKnownFolderPath.
//!
//! Provides synchronous access to system known folders on Windows.
//! On non-Windows platforms, throws an error.

use napi_derive::napi;

#[cfg(target_os = "windows")]
mod windows {
	use std::{ffi::c_void, slice};

	use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};

	#[link(name = "ole32")]
	unsafe extern "system" {
		fn CoTaskMemFree(ptr: *const c_void);
	}

	/// Get the machine-wide ProgramData directory.
	///
	/// Resolves via Windows SHGetKnownFolderPath with FOLDERID_ProgramData.
	/// Returns the path as a UTF-8 string, or an error if retrieval fails.
	pub(super) fn machine_program_data_dir() -> Result<String, String> {
		unsafe {
			let mut path_ptr: *mut u16 = std::ptr::null_mut();

			// Call SHGetKnownFolderPath with FOLDERID_ProgramData
			let hr = SHGetKnownFolderPath(
				&FOLDERID_ProgramData,
				0, // KF_FLAG_DEFAULT
				std::ptr::null_mut(),
				&mut path_ptr,
			);

			// Ensure cleanup regardless of success/failure
			let result = if hr == 0 {
				// Success: HRESULT S_OK = 0
				if path_ptr.is_null() {
					Err("SHGetKnownFolderPath returned null pointer".to_string())
				} else {
					// Find string length
					let mut len = 0;
					let mut p = path_ptr;
					while *p != 0 {
						len += 1;
						p = p.add(1);
					}

					// Create slice and convert UTF-16 to String
					let wide_slice = slice::from_raw_parts(path_ptr, len);
					String::from_utf16(wide_slice)
						.map_err(|error| format!("Invalid ProgramData path: {error}"))
				}
			} else {
				Err(format!("SHGetKnownFolderPath failed with HRESULT: 0x{:08X}", hr as u32))
			};

			// Free memory allocated by SHGetKnownFolderPath
			if !path_ptr.is_null() {
				CoTaskMemFree(path_ptr as *const c_void);
			}

			result
		}
	}
}

#[cfg(not(target_os = "windows"))]
mod non_windows {
	pub(super) fn machine_program_data_dir() -> Result<String, String> {
		Err("machineProgramDataDir is only available on Windows".to_string())
	}
}

/// Get the machine-wide ProgramData directory path.
///
/// On Windows, resolves via SHGetKnownFolderPath with FOLDERID_ProgramData,
/// ensuring machine-level policy configuration resolution is independent of
/// process environment variables.
///
/// On other platforms, throws an error indicating the API is Windows-only.
///
/// # Returns
/// The absolute path to the ProgramData directory as a UTF-8 string.
///
/// # Throws
/// - On non-Windows platforms: "machineProgramDataDir is only available on
///   Windows"
/// - On Windows if the API call fails: "SHGetKnownFolderPath failed with
///   HRESULT: ..."
#[napi(js_name = "machineProgramDataDir")]
pub fn machine_program_data_dir() -> napi::Result<String> {
	#[cfg(target_os = "windows")]
	{
		windows::machine_program_data_dir()
			.map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
	}
	#[cfg(not(target_os = "windows"))]
	{
		non_windows::machine_program_data_dir()
			.map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
	}
}
