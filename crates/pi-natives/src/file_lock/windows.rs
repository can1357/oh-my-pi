use std::{
	io,
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr,
};

use windows_sys::Win32::{
	Foundation::{ERROR_ALREADY_EXISTS, GetLastError, SetLastError},
	System::Threading::{CreateMutexW, ReleaseMutex},
};

/// Windows lock held by a named kernel mutex.
pub struct PlatformFileLock {
	handle: Option<OwnedHandle>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let name = super::memory_lock_name(path);
	let wide_name: Vec<u16> = format!(r"Global\{name}")
		.encode_utf16()
		.chain(std::iter::once(0))
		.collect();

	// `bInitialOwner` only grants ownership when this call creates the mutex.
	// Existing mutexes return `ERROR_ALREADY_EXISTS` without changing ownership,
	// which also prevents Win32's same-thread recursive acquisition behavior.
	// SAFETY: the attributes pointer is null, and `wide_name` is a live,
	// NUL-terminated UTF-16 string for the duration of the call.
	unsafe { SetLastError(0) };
	let raw_handle = unsafe { CreateMutexW(ptr::null(), 1, wide_name.as_ptr()) };
	if raw_handle.is_null() {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `CreateMutexW` returned a fresh owned handle. `OwnedHandle` closes
	// it exactly once on every return path.
	let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
	// SAFETY: this immediately observes the last-error value set by
	// `CreateMutexW`; no intervening system call can overwrite it.
	if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
		return Ok(None);
	}
	Ok(Some(PlatformFileLock { handle: Some(handle) }))
}

impl PlatformFileLock {
	pub fn release(&mut self) -> io::Result<()> {
		let Some(handle) = self.handle.as_ref() else {
			return Ok(());
		};
		// SAFETY: this handle was created with initial ownership on the calling
		// N-API thread. On failure the handle stays live so ownership cannot be
		// silently transferred.
		if unsafe { ReleaseMutex(handle.as_raw_handle()) } == 0 {
			return Err(io::Error::last_os_error());
		}
		drop(self.handle.take());
		Ok(())
	}
}
