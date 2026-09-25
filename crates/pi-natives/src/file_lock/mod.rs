//! Cross-process advisory locks backed by platform ownership primitives.
//!
//! Linux uses abstract Unix sockets and Windows uses named mutexes, so neither
//! platform leaves a filesystem artifact. Other Unix platforms use `flock(2)`
//! on a persistent sidecar because they lack a process-owned in-memory name
//! registry with automatic crash recovery.

use std::{io, path::Path};

use napi::JsString;
use napi_derive::napi;

use crate::js;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(unix, not(target_os = "linux")))]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(all(unix, not(target_os = "linux")))]
use unix as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(unix, target_os = "windows")))]
compile_error!("pi-natives file locks require Unix or Windows");

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn memory_lock_name(path: &str) -> String {
	const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
	const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
	let bytes = path.as_bytes();
	let high = xxhash_rust::xxh64::xxh64(bytes, HIGH_SEED);
	let low = xxhash_rust::xxh64::xxh64(bytes, LOW_SEED);
	format!("omp-file-lock-{high:016x}{low:016x}")
}

/// Process-owned cross-platform advisory lock.
///
/// `tryAcquire()` is non-blocking; its returned handle reports whether it won
/// through `acquired`. Ownership ends on `release()`, garbage collection, or
/// process exit; `release()` is idempotent.
#[napi(js_name = "FileLock")]
pub struct FileLock {
	inner: Option<platform::PlatformFileLock>,
}

#[napi]
impl FileLock {
	/// Try to acquire a lock directly from native Rust code.
	///
	/// This is crate-only so native subsystems share the same kernel-backed
	/// ownership primitive without exposing another JavaScript API.
	pub(crate) fn try_acquire_path(path: &Path) -> io::Result<Self> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		platform::try_acquire(path).map(|inner| Self { inner })
	}

	/// Try to acquire `path` without blocking.
	#[napi(factory)]
	pub fn try_acquire(path: JsString) -> napi::Result<Self> {
		let path = js::utf8(path)?;
		Self::try_acquire_path(Path::new(&*path)).map_err(|error| {
			napi::Error::from_reason(format!(
				"Failed to acquire native file lock for {}: {error}",
				&*path
			))
		})
	}

	/// Whether this handle owns the requested lock.
	#[napi(getter)]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn acquired(&self) -> bool {
		self.is_acquired()
	}

	/// Whether this native handle owns the requested lock.
	pub(crate) const fn is_acquired(&self) -> bool {
		self.inner.is_some()
	}

	/// Release this handle's ownership without affecting a successor.
	#[napi]
	pub fn release(&mut self) -> napi::Result<()> {
		self.release_native().map_err(|error| {
			napi::Error::from_reason(format!("Failed to release native file lock: {error}"))
		})
	}

	/// Release native ownership while preserving the handle on failure.
	pub(crate) fn release_native(&mut self) -> io::Result<()> {
		let Some(mut inner) = self.inner.take() else {
			return Ok(());
		};
		if let Err(error) = inner.release() {
			self.inner = Some(inner);
			return Err(error);
		}
		Ok(())
	}
}

impl Drop for FileLock {
	fn drop(&mut self) {
		if let Some(inner) = self.inner.as_mut() {
			let _ = inner.release();
		}
	}
}
