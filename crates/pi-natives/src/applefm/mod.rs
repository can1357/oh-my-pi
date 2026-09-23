//! In-process bridge to Apple's on-device Foundation Models (macOS 27+).
//!
//! `bridge.swift` is compiled into a static library by `build-bridge.sh` (from
//! `build.rs` and the Bazel `applefm_bridge` genrule) and linked into the addon
//! with `FoundationModels` weak-linked. It exposes a small C ABI; this module
//! wraps it for JavaScript. Hosts without a suitable Swift toolchain link
//! `stub.c` instead, which reports the bridge as not built.
//!
//! Requests and events are JSON documents whose schema is owned by
//! `bridge.swift` and mirrored by `packages/ai/src/providers/apple-fm.ts`.
//!
//! # Example (non-runnable)
//!
//! ```ignore
//! const handle = appleFmGenerate(JSON.stringify(request), (err, event) => …);
//! appleFmCancel(handle);
//! ```

use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

use crate::task;

/// Reports whether the on-device model can generate, as an `availability`
/// event JSON: `{available, reason?, contextSize?, variant?, vision?,
/// toolCalling?}`.
#[napi]
pub fn apple_fm_availability() -> task::Promise<String> {
	task::blocking("applefm.availability", (), move |_| Ok(platform::availability()))
}

/// Starts one model turn for a JSON request and streams JSON events to
/// `on_event` until a terminal `done` or `error` event. Returns a handle for
/// [`apple_fm_cancel`].
#[napi]
pub fn apple_fm_generate(
	request: String,
	#[napi(ts_arg_type = "(err: null | Error, event: string) => void")] on_event: ThreadsafeFunction<
		String,
	>,
) -> Result<u32> {
	platform::generate(&request, on_event)
}

/// Cancels a generation; its stream then ends with a `cancelled` error event.
/// Unknown or finished handles are ignored.
#[napi]
pub fn apple_fm_cancel(handle: u32) {
	platform::cancel(handle);
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, CString, c_char, c_void},
		sync::atomic::{AtomicU32, Ordering},
	};

	use super::{Error, Result, ThreadsafeFunction, ThreadsafeFunctionCallMode};

	type Emit = extern "C" fn(context: *mut c_void, event: *const c_char, is_final: bool);

	unsafe extern "C" {
		fn omp_applefm_availability() -> *mut c_char;
		fn omp_applefm_generate(
			handle: u64,
			request: *const c_char,
			context: *mut c_void,
			emit: Emit,
		);
		fn omp_applefm_cancel(handle: u64);
		fn omp_applefm_free(pointer: *mut c_char);
	}

	static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

	pub(super) fn availability() -> String {
		// SAFETY: the bridge returns a NUL-terminated heap string (or null) that
		// we own until handing it back to `omp_applefm_free`.
		unsafe {
			let pointer = omp_applefm_availability();
			if pointer.is_null() {
				return r#"{"type":"availability","available":false,"reason":"runtime"}"#.to_owned();
			}
			let json = CStr::from_ptr(pointer).to_string_lossy().into_owned();
			omp_applefm_free(pointer);
			json
		}
	}

	pub(super) fn generate(request: &str, on_event: ThreadsafeFunction<String>) -> Result<u32> {
		let request =
			CString::new(request).map_err(|_| Error::from_reason("request contains a NUL byte"))?;
		let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
		let context = Box::into_raw(Box::new(on_event)).cast::<c_void>();
		// SAFETY: `request` outlives the call (the bridge copies it before
		// returning); `context` stays valid until `emit` reclaims it on the
		// terminal event, which the bridge delivers exactly once.
		unsafe { omp_applefm_generate(u64::from(handle), request.as_ptr(), context, emit) };
		Ok(handle)
	}

	pub(super) fn cancel(handle: u32) {
		// SAFETY: cancellation of unknown handles is a no-op in the bridge.
		unsafe { omp_applefm_cancel(u64::from(handle)) };
	}

	extern "C" fn emit(context: *mut c_void, event: *const c_char, is_final: bool) {
		// SAFETY: `event` is a NUL-terminated string valid for this call.
		let event = unsafe { CStr::from_ptr(event) }
			.to_string_lossy()
			.into_owned();
		let callback = context.cast::<ThreadsafeFunction<String>>();
		if is_final {
			// SAFETY: the terminal event is the last use of `context`, created by
			// `Box::into_raw` in `generate`.
			let callback = unsafe { Box::from_raw(callback) };
			callback.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
		} else {
			// SAFETY: non-terminal events are delivered sequentially before the
			// terminal one, so the box is still live.
			unsafe { &*callback }.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
}

#[cfg(not(target_os = "macos"))]
mod platform {
	use super::{Result, ThreadsafeFunction, ThreadsafeFunctionCallMode};

	pub(super) fn availability() -> String {
		r#"{"type":"availability","available":false,"reason":"unsupported_platform"}"#.to_owned()
	}

	pub(super) fn generate(_request: &str, on_event: ThreadsafeFunction<String>) -> Result<u32> {
		on_event.call(
			Ok(r#"{"type":"error","code":"unsupported_platform","message":"Apple Foundation Models requires macOS"}"#
				.to_owned()),
			ThreadsafeFunctionCallMode::NonBlocking,
		);
		Ok(0)
	}

	pub(super) const fn cancel(_handle: u32) {}
}
