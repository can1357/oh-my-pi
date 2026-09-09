//! macOS appearance detection via CoreFoundation.
//!
//! Provides synchronous dark/light detection and a long-lived observer
//! that fires a JS callback on system appearance changes.
//!
//! Uses raw CoreFoundation FFI — no `ObjC` runtime, no compiled helpers,
//! no shelling out to `defaults`.
//!
//! # Platform
//! - **macOS**: Full implementation via `CFPreferencesCopyAppValue` +
//!   `CFNotificationCenterGetDistributedCenter`
//! - **Other**: Returns `None` / no-op

use napi_derive::napi;

/// System UI appearance reported by native macOS APIs (`detectMacOSAppearance`
/// and observer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum MacOSAppearance {
	/// Dark color scheme.
	#[napi(value = "dark")]
	Dark,
	/// Light color scheme.
	#[napi(value = "light")]
	Light,
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, CString, c_char, c_void},
		ptr,
		sync::Arc,
		thread::{self, JoinHandle},
	};

	use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
	use parking_lot::Mutex;

	use super::MacOSAppearance;

	// -- CoreFoundation FFI types -------------------------------------------

	type CFStringRef = *const c_void;
	type CFTypeRef = *const c_void;
	type CFNotificationCenterRef = *const c_void;
	type CFRunLoopRef = *const c_void;
	type CFRunLoopTimerRef = *const c_void;
	type CFIndex = isize;

	const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
	const CF_NOTIFICATION_SUSPEND_DELIVERY: isize = 4;

	/// Layout matches `CFRunLoopTimerContext` from CoreFoundation.
	#[repr(C)]
	struct TimerContext {
		version:          CFIndex,
		info:             *mut c_void,
		retain:           *const c_void,
		release:          *const c_void,
		copy_description: *const c_void,
	}

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		static kCFPreferencesAnyApplication: CFStringRef;
		static kCFRunLoopDefaultMode: CFStringRef;

		fn CFPreferencesCopyAppValue(key: CFStringRef, app: CFStringRef) -> CFTypeRef;
		fn CFStringCreateWithCString(
			alloc: *const c_void,
			c_str: *const c_char,
			encoding: u32,
		) -> CFStringRef;
		fn CFStringGetCStringPtr(s: CFStringRef, encoding: u32) -> *const c_char;
		fn CFStringGetCString(
			s: CFStringRef,
			buf: *mut c_char,
			buf_size: CFIndex,
			encoding: u32,
		) -> bool;
		fn CFRelease(cf: CFTypeRef);
		fn CFGetTypeID(cf: CFTypeRef) -> u64;
		fn CFStringGetTypeID() -> u64;

		fn CFNotificationCenterGetDistributedCenter() -> CFNotificationCenterRef;
		fn CFNotificationCenterAddObserver(
			center: CFNotificationCenterRef,
			observer: *const c_void,
			callback: unsafe extern "C" fn(
				CFNotificationCenterRef,
				*const c_void,
				CFStringRef,
				*const c_void,
				*const c_void,
			),
			name: CFStringRef,
			object: *const c_void,
			suspension_behavior: isize,
		);
		fn CFNotificationCenterRemoveEveryObserver(
			center: CFNotificationCenterRef,
			observer: *const c_void,
		);

		fn CFRunLoopGetCurrent() -> CFRunLoopRef;
		fn CFRunLoopRun();
		fn CFRunLoopStop(rl: CFRunLoopRef);

		fn CFAbsoluteTimeGetCurrent() -> f64;
		fn CFRunLoopTimerCreate(
			allocator: *const c_void,
			fire_date: f64,
			interval: f64,
			flags: u64,
			order: CFIndex,
			callout: unsafe extern "C" fn(CFRunLoopTimerRef, *mut c_void),
			context: *const TimerContext,
		) -> CFRunLoopTimerRef;
		fn CFRunLoopAddTimer(rl: CFRunLoopRef, timer: CFRunLoopTimerRef, mode: CFStringRef);
		fn CFRunLoopTimerInvalidate(timer: CFRunLoopTimerRef);
	}

	// Link Foundation — the distributed notification center's Mach-port
	// plumbing lives here, not in CoreFoundation.
	#[link(name = "Foundation", kind = "framework")]
	unsafe extern "C" {}

	// -- CoreFoundation helpers ---------------------------------------------

	fn create_cf_string(s: &str) -> CFStringRef {
		let Ok(c_str) = CString::new(s) else {
			return ptr::null();
		};
		// SAFETY: `c_str` is a valid null-terminated C string for the duration of the
		// call.
		unsafe { CFStringCreateWithCString(ptr::null(), c_str.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
	}

	fn cf_string_to_string(s: CFStringRef) -> String {
		// SAFETY: `s` is a live `CFStringRef` returned by CoreFoundation and remains
		// valid for the duration of this conversion helper.
		unsafe {
			let ptr = CFStringGetCStringPtr(s, K_CF_STRING_ENCODING_UTF8);
			if !ptr.is_null() {
				return CStr::from_ptr(ptr).to_string_lossy().into_owned();
			}
			let mut buf = [0u8; 256];
			if CFStringGetCString(s, buf.as_mut_ptr().cast::<c_char>(), 256, K_CF_STRING_ENCODING_UTF8)
			{
				let len = buf.iter().position(|&b| b == 0).unwrap_or(0);
				String::from_utf8_lossy(&buf[..len]).into_owned()
			} else {
				String::new()
			}
		}
	}

	// -- Sync detection -----------------------------------------------------

	/// Read `AppleInterfaceStyle` via CoreFoundation preferences.
	pub fn detect_appearance() -> MacOSAppearance {
		// SAFETY: CoreFoundation pointers are null-checked, type-checked where needed,
		// and every object created or copied here is released exactly once before
		// return.
		unsafe {
			let key = create_cf_string("AppleInterfaceStyle");
			if key.is_null() {
				return MacOSAppearance::Light;
			}

			let value = CFPreferencesCopyAppValue(key, kCFPreferencesAnyApplication);
			CFRelease(key);

			if value.is_null() {
				// Key absent = light mode (no dark mode override set).
				return MacOSAppearance::Light;
			}

			if CFGetTypeID(value) != CFStringGetTypeID() {
				CFRelease(value);
				return MacOSAppearance::Light;
			}

			let result = cf_string_to_string(value);
			CFRelease(value);
			if result == "Dark" {
				MacOSAppearance::Dark
			} else {
				MacOSAppearance::Light
			}
		}
	}

	// -- Observer -----------------------------------------------------------

	/// Opaque handle to a `CFRunLoop` — `Send + Sync` for cross-thread stop.
	struct SendableRunLoop(CFRunLoopRef);
	// SAFETY: `CFRunLoopStop` is documented thread-safe, and this wrapper only
	// exposes the pointer for stopping the run loop from another thread.
	unsafe impl Send for SendableRunLoop {}
	// SAFETY: Shared access is limited to passing the pointer to `CFRunLoopStop`,
	// which does not require exclusive ownership of the run loop object.
	unsafe impl Sync for SendableRunLoop {}

	/// Shared context for the notification callback and the poll timer.
	struct CallbackCtx {
		tsfn: ThreadsafeFunction<MacOSAppearance>,
		/// Last reported appearance — used for dedup so we never fire twice
		/// for the same value (notification + timer can race).
		last: Mutex<Option<MacOSAppearance>>,
	}

	impl CallbackCtx {
		/// Read current appearance; fire JS callback only when it changed.
		fn report_if_changed(&self) {
			let appearance = detect_appearance();
			let mut last = self.last.lock();
			if last.as_ref() != Some(&appearance) {
				*last = Some(appearance);
				self
					.tsfn
					.call(Ok(appearance), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
	}

	/// C notification callback — fired by `CFDistributedNotificationCenter`
	/// when macOS posts `AppleInterfaceThemeChangedNotification`.
	///
	/// # Safety
	///
	/// `observer` must be the `CallbackCtx` pointer allocated by `Box::into_raw`
	/// in `ObserverInner::start` and must remain valid until the run loop exits.
	unsafe extern "C" fn on_notification(
		_center: CFNotificationCenterRef,
		observer: *const c_void,
		_name: CFStringRef,
		_object: *const c_void,
		_user_info: *const c_void,
	) {
		// SAFETY: `observer` is the leaked `Box<CallbackCtx>` installed during observer
		// registration and is only reclaimed after the run loop stops.
		let ctx = unsafe { &*observer.cast::<CallbackCtx>() };
		ctx.report_if_changed();
	}

	/// Timer callback — polls `CFPreferencesCopyAppValue` as a fallback.
	///
	/// Distributed notifications may not reliably deliver to background
	/// threads on all macOS versions. This timer (a) keeps the run loop alive
	/// so `CFRunLoopRun` does not exit immediately, and (b) guarantees we
	/// detect theme changes within the polling interval even if the
	/// notification path is dead.
	///
	/// # Safety
	///
	/// `info` must be the same `CallbackCtx` pointer passed in the timer context
	/// during `ObserverInner::start`, and that allocation must outlive the
	/// timer.
	unsafe extern "C" fn on_timer(_timer: CFRunLoopTimerRef, info: *mut c_void) {
		// SAFETY: `info` comes from the timer context created in `ObserverInner::start`
		// and points at the same leaked `CallbackCtx` as the notification observer.
		let ctx = unsafe { &*(info as *const CallbackCtx) };
		ctx.report_if_changed();
	}

	/// Polling interval in seconds for the fallback timer.
	const POLL_INTERVAL_SECS: f64 = 2.0;

	/// Internal state for a running observer.
	pub struct ObserverInner {
		run_loop: Arc<Mutex<Option<SendableRunLoop>>>,
		thread:   Option<JoinHandle<()>>,
	}

	impl ObserverInner {
		pub fn start(tsfn: ThreadsafeFunction<MacOSAppearance>) -> Self {
			let run_loop: Arc<Mutex<Option<SendableRunLoop>>> = Arc::new(Mutex::new(None));
			let rl_clone = run_loop.clone();

			// Signal that the background thread has stored its `CFRunLoopRef`.
			let (tx, rx) = flume::bounded::<()>(1);

			let handle = thread::spawn(move || {
				// SAFETY: All CoreFoundation objects created or copied here are either released
				// in the cleanup path or intentionally leaked until the run loop exits. The
				// callback context pointer remains valid for both the notification center and
				// timer until `CFRunLoopRun` returns and cleanup reclaims it exactly once.
				unsafe {
					let rl = CFRunLoopGetCurrent();
					*rl_clone.lock() = Some(SendableRunLoop(rl));
					let _ = tx.send(());

					let ctx = Box::new(CallbackCtx { tsfn, last: Mutex::new(None) });
					let ctx_ptr = Box::into_raw(ctx);

					// -- Register for distributed notification ---------------
					let center = CFNotificationCenterGetDistributedCenter();
					let name = create_cf_string("AppleInterfaceThemeChangedNotification");

					CFNotificationCenterAddObserver(
						center,
						ctx_ptr.cast(),
						on_notification,
						name,
						ptr::null(),
						CF_NOTIFICATION_SUSPEND_DELIVERY,
					);

					if !name.is_null() {
						CFRelease(name);
					}

					// -- Polling timer (keep-alive + fallback) ---------------
					//
					// Two purposes:
					// 1. Keeps `CFRunLoopRun` alive — without any source/timer attached,
					//    `CFRunLoopRun` returns immediately.
					// 2. Polls `CFPreferencesCopyAppValue` every 2 s so we catch theme changes even
					//    if the Mach-port notification does not fire on this thread.
					let timer_ctx = TimerContext {
						version:          0,
						info:             ctx_ptr.cast::<c_void>(),
						retain:           ptr::null(),
						release:          ptr::null(),
						copy_description: ptr::null(),
					};
					let timer = CFRunLoopTimerCreate(
						ptr::null(),
						CFAbsoluteTimeGetCurrent() + POLL_INTERVAL_SECS,
						POLL_INTERVAL_SECS,
						0,
						0,
						on_timer,
						&raw const timer_ctx,
					);
					CFRunLoopAddTimer(rl, timer, kCFRunLoopDefaultMode);

					// Report initial appearance immediately.
					(*ctx_ptr).report_if_changed();

					// Block until `CFRunLoopStop()` is called from `stop()`.
					CFRunLoopRun();

					// -- Cleanup ---------------------------------------------
					CFRunLoopTimerInvalidate(timer);
					CFRelease(timer);
					CFNotificationCenterRemoveEveryObserver(center, ctx_ptr.cast());
					drop(Box::from_raw(ctx_ptr));
				}
			});

			// Wait until the background thread stores its run loop pointer before
			// returning, so `stop()` can always reach a live run loop when the observer
			// exists.
			rx.recv()
				.expect("observer startup channel stays alive until run loop is stored");

			Self { run_loop, thread: Some(handle) }
		}

		pub fn stop(&mut self) {
			let rl = self.run_loop.lock().take();
			if let Some(rl) = rl {
				// SAFETY: `rl.0` came from `CFRunLoopGetCurrent` on the observer thread and is
				// only used here to stop that run loop, which Apple documents as thread-safe.
				unsafe {
					CFRunLoopStop(rl.0);
				}
			}
			if let Some(t) = self.thread.take() {
				let _ = t.join();
			}
		}
	}

	impl Drop for ObserverInner {
		fn drop(&mut self) {
			self.stop();
		}
	}
}

// ---------------------------------------------------------------------------
// N-API exports
// ---------------------------------------------------------------------------

/// Detect macOS system appearance via CoreFoundation.
/// Returns `"dark"` or `"light"` on macOS, `null` on other platforms.
#[napi(js_name = "detectMacOSAppearance")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn detect_macos_appearance() -> Option<MacOSAppearance> {
	#[cfg(target_os = "macos")]
	{
		Some(platform::detect_appearance())
	}
	#[cfg(not(target_os = "macos"))]
	{
		None
	}
}

/// Long-lived macOS appearance observer.
///
/// Subscribes to `AppleInterfaceThemeChangedNotification` via
/// `CFDistributedNotificationCenter` and calls the provided callback
/// with `"dark"` or `"light"` on each change (and once on start).
///
/// A 2-second polling timer also runs as fallback — distributed
/// notifications may not reliably reach background threads on all
/// macOS versions.
///
/// On non-macOS platforms, `start()` returns a no-op observer.
#[napi]
pub struct MacAppearanceObserver {
	#[cfg(target_os = "macos")]
	inner: Option<platform::ObserverInner>,
}

#[napi]
impl MacAppearanceObserver {
	#[napi(factory)]
	pub fn start(
		#[napi(ts_arg_type = "(err: null | Error, appearance: MacOSAppearance) => void")]
		callback: napi::threadsafe_function::ThreadsafeFunction<MacOSAppearance>,
	) -> napi::Result<Self> {
		#[cfg(target_os = "macos")]
		{
			Ok(Self { inner: Some(platform::ObserverInner::start(callback)) })
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = callback;
			Ok(Self {})
		}
	}

	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
	pub fn stop(&mut self) {
		#[cfg(target_os = "macos")]
		if let Some(inner) = &mut self.inner {
			inner.stop();
		}
	}
}
