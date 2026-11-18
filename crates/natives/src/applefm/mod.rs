//! In-process bridge to Apple's on-device Foundation Models (macOS 27+).
//!
//! `bridge.swift` is compiled into a standalone dylib by `build-bridge.sh`
//! (from `build.rs` and the Bazel `applefm_bridge` genrule) and embedded in the
//! addon as bytes. It is never linked: on first use, and only on macOS 27+,
//! the bytes are written to `$TMPDIR` and `dlopen`ed, so older systems never
//! load the Swift runtime or `FoundationModels` (linking them crashed the addon
//! on load there). It exposes a small C ABI; this module wraps it for
//! JavaScript. Hosts without a suitable Swift toolchain embed an empty file,
//! which reports the bridge as not built.
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
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn apple_fm_cancel(handle: u32) {
	platform::cancel(handle);
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, CString, c_char, c_void},
		fs, io,
		path::PathBuf,
		sync::{
			LazyLock,
			atomic::{AtomicU32, Ordering},
		},
	};

	use super::{Error, Result, ThreadsafeFunction, ThreadsafeFunctionCallMode};

	type Emit = extern "C" fn(context: *mut c_void, event: *const c_char, is_final: bool);

	/// The bridge dylib; empty when the build host could not compile it.
	const DYLIB: &[u8] = include_bytes!(env!("OMP_APPLEFM_BRIDGE"));
	/// First macOS release shipping `FoundationModels` with the APIs the bridge
	/// uses.
	const MIN_MACOS_MAJOR: u32 = 27;

	/// The bridge's C ABI, resolved from the `dlopen`ed dylib.
	struct Bridge {
		availability: unsafe extern "C" fn() -> *mut c_char,
		generate:     unsafe extern "C" fn(u64, *const c_char, *mut c_void, Emit),
		cancel:       unsafe extern "C" fn(u64),
		free:         unsafe extern "C" fn(*mut c_char),
	}

	/// Why the bridge is unusable: an availability `reason` code and a message.
	struct Unavailable {
		reason:  &'static str,
		message: String,
	}

	static BRIDGE: LazyLock<std::result::Result<Bridge, Unavailable>> = LazyLock::new(load);
	static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

	fn load() -> std::result::Result<Bridge, Unavailable> {
		if DYLIB.is_empty() {
			return Err(Unavailable {
				reason:  "not_built",
				message: "This omp build does not include Apple Foundation Models support".to_owned(),
			});
		}
		if macos_major().is_none_or(|major| major < MIN_MACOS_MAJOR) {
			return Err(Unavailable {
				reason:  "unsupported_os",
				message: "Apple Foundation Models requires macOS 27 or later".to_owned(),
			});
		}
		let runtime = |message: String| Unavailable { reason: "runtime", message };
		let path = materialize()
			.map_err(|err| runtime(format!("failed to stage the Foundation Models bridge: {err}")))?;
		let c_path = CString::new(path.as_os_str().as_encoded_bytes())
			.map_err(|_| runtime("bridge path contains a NUL byte".to_owned()))?;
		// SAFETY: `c_path` is NUL-terminated. The handle is intentionally never
		// closed: the resolved functions stay in use for the process lifetime.
		let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
		if handle.is_null() {
			// SAFETY: dlerror returns a NUL-terminated string or null.
			let detail = unsafe { libc::dlerror() };
			let detail = if detail.is_null() {
				"unknown error".into()
			} else {
				// SAFETY: non-null dlerror results are valid C strings.
				unsafe { CStr::from_ptr(detail) }.to_string_lossy()
			};
			return Err(runtime(format!("failed to load the Foundation Models bridge: {detail}")));
		}
		let symbol = |name: &CStr| {
			// SAFETY: `handle` is a live dlopen handle and `name` is
			// NUL-terminated.
			let pointer = unsafe { libc::dlsym(handle, name.as_ptr()) };
			if pointer.is_null() {
				Err(runtime(format!("Foundation Models bridge lacks {}", name.to_string_lossy())))
			} else {
				Ok(pointer)
			}
		};
		// SAFETY: each symbol is a `@_cdecl` export of bridge.swift with exactly
		// the signature declared in `Bridge`.
		unsafe {
			Ok(Bridge {
				availability: std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_char>(
					symbol(c"omp_applefm_availability")?,
				),
				generate:     std::mem::transmute::<
					*mut c_void,
					unsafe extern "C" fn(u64, *const c_char, *mut c_void, Emit),
				>(symbol(c"omp_applefm_generate")?),
				cancel:       std::mem::transmute::<*mut c_void, unsafe extern "C" fn(u64)>(symbol(
					c"omp_applefm_cancel",
				)?),
				free:         std::mem::transmute::<*mut c_void, unsafe extern "C" fn(*mut c_char)>(
					symbol(c"omp_applefm_free")?,
				),
			})
		}
	}

	/// Major version of the running macOS (`kern.osproductversion`), which
	/// reports the real release even under `SYSTEM_VERSION_COMPAT`.
	fn macos_major() -> Option<u32> {
		let mut buffer = [0u8; 32];
		let mut length = buffer.len();
		// SAFETY: `buffer`/`length` describe a writable buffer; the name is
		// NUL-terminated.
		let status = unsafe {
			libc::sysctlbyname(
				c"kern.osproductversion".as_ptr(),
				buffer.as_mut_ptr().cast(),
				&raw mut length,
				std::ptr::null_mut(),
				0,
			)
		};
		if status != 0 {
			return None;
		}
		let version = CStr::from_bytes_until_nul(&buffer[..length.min(buffer.len())]).ok()?;
		version.to_str().ok()?.split('.').next()?.parse().ok()
	}

	/// Writes [`DYLIB`] to a content-addressed path under `$TMPDIR` (per-user on
	/// macOS), reusing an identical existing copy.
	fn materialize() -> io::Result<PathBuf> {
		// FNV-1a: a stable content key, so builds with different bridges never
		// share (or overwrite a loaded copy of) one file.
		let hash = DYLIB.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, &byte| {
			(hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
		});
		let path = std::env::temp_dir().join(format!("omp-applefm-{hash:016x}.dylib"));
		if fs::read(&path).is_ok_and(|bytes| bytes == DYLIB) {
			return Ok(path);
		}
		let staging = path.with_extension(format!("{}.tmp", std::process::id()));
		fs::write(&staging, DYLIB)?;
		fs::rename(&staging, &path).inspect_err(|_| {
			let _ = fs::remove_file(&staging);
		})?;
		Ok(path)
	}

	fn availability_json(reason: &str) -> String {
		serde_json::json!({ "type": "availability", "available": false, "reason": reason })
			.to_string()
	}

	pub(super) fn availability() -> String {
		let bridge = match &*BRIDGE {
			Ok(bridge) => bridge,
			Err(unavailable) => return availability_json(unavailable.reason),
		};
		// SAFETY: the bridge returns a NUL-terminated heap string (or null) that
		// we own until handing it back to its `free`.
		unsafe {
			let pointer = (bridge.availability)();
			if pointer.is_null() {
				return availability_json("runtime");
			}
			let json = CStr::from_ptr(pointer).to_string_lossy().into_owned();
			(bridge.free)(pointer);
			json
		}
	}

	pub(super) fn generate(request: &str, on_event: ThreadsafeFunction<String>) -> Result<u32> {
		let request =
			CString::new(request).map_err(|_| Error::from_reason("request contains a NUL byte"))?;
		let bridge = match &*BRIDGE {
			Ok(bridge) => bridge,
			Err(unavailable) => {
				let event = serde_json::json!({
					"type": "error",
					"code": unavailable.reason,
					"message": unavailable.message,
				});
				on_event.call(Ok(event.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
				return Ok(0);
			},
		};
		let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
		let context = Box::into_raw(Box::new(on_event)).cast::<c_void>();
		// SAFETY: `request` outlives the call (the bridge copies it before
		// returning); `context` stays valid until `emit` reclaims it on the
		// terminal event, which the bridge delivers exactly once.
		unsafe { (bridge.generate)(u64::from(handle), request.as_ptr(), context, emit) };
		Ok(handle)
	}

	pub(super) fn cancel(handle: u32) {
		if let Ok(bridge) = &*BRIDGE {
			// SAFETY: cancellation of unknown handles is a no-op in the bridge.
			unsafe { (bridge.cancel)(u64::from(handle)) };
		}
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

	#[allow(clippy::unnecessary_wraps, reason = "matches the fallible macOS signature")]
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
