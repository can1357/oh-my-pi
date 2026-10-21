//! `SkyLight` loading and the per-process event routes that background input
//! posts through.
//!
//! The addon and the input-release helper (`release_helper.rs`) both compile
//! this file, so it uses nothing beyond `std` and the system libraries: the
//! helper replays the addon's releases through exactly these routes.

use std::{
	ffi::{CStr, c_char, c_int, c_void},
	mem, ptr,
	sync::LazyLock,
};

/// A live `CGEventRef`.
pub(crate) type EventRef = *mut c_void;

type PostToPidFn = unsafe extern "C" fn(i32, EventRef);
type SetIntegerFieldFn = unsafe extern "C" fn(EventRef, u32, i64);
type SetAuthenticationMessageFn = unsafe extern "C" fn(EventRef, *mut c_void);
type ObjcGetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type SelRegisterNameFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type ClassRespondsToSelectorFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
type AuthenticationFactoryFn =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, i32, u32) -> *mut c_void;

const RTLD_NOW: c_int = 0x2;
const RTLD_GLOBAL: c_int = 0x8;
/// `RTLD_DEFAULT` on Darwin.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

unsafe extern "C" {
	fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
	fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// Loads the private `SkyLight` framework once per process.
pub(crate) fn load_skylight() -> Option<()> {
	static LOADED: LazyLock<bool> = LazyLock::new(|| {
		let path = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
		// SAFETY: `path` is a static NUL-terminated framework path; the handle is
		// intentionally process-lived.
		!unsafe { dlopen(path.as_ptr(), RTLD_NOW | RTLD_GLOBAL) }.is_null()
	});
	if *LOADED { Some(()) } else { None }
}

pub(crate) fn symbol<T: Copy>(name: &CStr) -> Option<T> {
	// SAFETY: `name` is NUL-terminated and RTLD_DEFAULT is valid for
	// process-wide lookup.
	let raw = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: Every callsite requests the exact C signature documented in its
	// function-pointer alias.
	Some(unsafe { mem::transmute_copy::<*mut c_void, T>(&raw) })
}

#[derive(Clone, Copy)]
struct Authentication {
	set_message:       SetAuthenticationMessageFn,
	objc_get_class:    ObjcGetClassFn,
	sel_register_name: SelRegisterNameFn,
	class_responds:    ClassRespondsToSelectorFn,
	factory:           AuthenticationFactoryFn,
}

/// The per-process posting routes of background input.
#[derive(Clone, Copy)]
pub(crate) struct Routes {
	post_to_pid:        PostToPidFn,
	/// `CGEventPostToPid` when it is a separate implementation; `None` where
	/// it re-exports `SLEventPostToPid` (as on macOS 26), since posting
	/// through both would then deliver every event twice.
	public_post_to_pid: Option<PostToPidFn>,
	set_integer:        SetIntegerFieldFn,
	authentication:     Option<Authentication>,
}

/// The event field naming the process a pointer event is addressed to,
/// checked by Chromium's synthetic-event filter. Serializing an event drops
/// it.
pub(crate) const TARGET_PID_FIELD: u32 = 40;

static ROUTES: LazyLock<Option<Routes>> = LazyLock::new(|| {
	load_skylight()?;
	let post_to_pid: PostToPidFn = symbol(c"SLEventPostToPid")?;
	Some(Routes {
		post_to_pid,
		public_post_to_pid: symbol::<PostToPidFn>(c"CGEventPostToPid")
			.filter(|public| *public as usize != post_to_pid as usize),
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		authentication: (|| {
			Some(Authentication {
				set_message:       symbol(c"SLEventSetAuthenticationMessage")?,
				objc_get_class:    symbol(c"objc_getClass")?,
				sel_register_name: symbol(c"sel_registerName")?,
				class_responds:    symbol(c"class_respondsToSelector")?,
				factory:           symbol(c"objc_msgSend")?,
			})
		})(),
	})
});

pub(crate) fn routes() -> Option<&'static Routes> {
	ROUTES.as_ref()
}

impl Routes {
	/// Stamps a raw `SkyLight` integer field onto `event`.
	///
	/// # Safety
	/// `event` must be a live `CGEventRef`.
	pub(crate) unsafe fn set_field(&self, event: EventRef, field: u32, value: i64) {
		// SAFETY: the caller keeps `event` alive and the setter was resolved
		// with its exact ABI.
		unsafe { (self.set_integer)(event, field, value) };
	}

	/// Posts a pointer event through `SkyLight` alone, without the keyboard
	/// authentication envelope, which would route it past the session event
	/// tap Chromium's window handler listens on.
	///
	/// # Safety
	/// `event` must be a live `CGEventRef`.
	pub(crate) unsafe fn routed(&self, pid: i32, event: EventRef) {
		// SAFETY: the caller keeps `event` alive and `post_to_pid` was resolved
		// with its exact ABI.
		unsafe { (self.post_to_pid)(pid, event) };
	}

	/// Posts a pointer event, after [`Self::routed`], through the public
	/// per-pid queue too, only where `CGEventPostToPid` is a separate function.
	/// Where it is not, a second post would deliver the event twice. The
	/// separate public post is kept as it was; its benefit there is unmeasured.
	///
	/// # Safety
	/// `event` must be a live `CGEventRef`.
	pub(crate) unsafe fn public(&self, pid: i32, event: EventRef) {
		if let Some(public_post_to_pid) = self.public_post_to_pid {
			// SAFETY: forwarded caller contract; the public symbol shares the
			// `SLEventPostToPid` ABI.
			unsafe { public_post_to_pid(pid, event) };
		}
	}

	/// Posts a keyboard event on the authenticated `SkyLight` route, which
	/// reaches Chromium and `AppKit`. Posting the same event through the
	/// public per-pid queue as well would deliver every key twice.
	///
	/// # Safety
	/// `event` must be a live `CGEventRef`.
	pub(crate) unsafe fn keyboard(&self, pid: i32, event: EventRef) {
		// SAFETY: forwarded caller contract.
		unsafe {
			self.authenticate(pid, event);
			(self.post_to_pid)(pid, event);
		}
	}

	/// # Safety
	/// `event` must be a live `CGEventRef`.
	unsafe fn authenticate(&self, pid: i32, event: EventRef) {
		let Some(spi) = self.authentication else {
			return;
		};
		// SAFETY: Both C strings are static; runtime lookup functions have their
		// exact Objective-C ABI.
		let class = unsafe { (spi.objc_get_class)(c"SLSEventAuthenticationMessage".as_ptr()) };
		// SAFETY: The selector C string is static and NUL-terminated.
		let selector =
			unsafe { (spi.sel_register_name)(c"messageWithEventRecord:pid:version:".as_ptr()) };
		if class.is_null() || selector.is_null() {
			return;
		}
		// SAFETY: This guard is required because macOS 14 has the class but lacks
		// the macOS 15+ factory selector.
		if !unsafe { (spi.class_responds)(class, selector) } {
			return;
		}
		// __CGEvent stores its SLSEventRecord pointer after CFRuntimeBase and a
		// padded u32.
		let mut record = ptr::null_mut();
		for offset in [24usize, 32, 16] {
			// SAFETY: These are the known pointer-aligned candidate slots in
			// __CGEvent; read_unaligned avoids alignment assumptions.
			let candidate =
				unsafe { ptr::read_unaligned(event.cast::<u8>().add(offset).cast::<*mut c_void>()) };
			if !candidate.is_null() {
				record = candidate;
				break;
			}
		}
		if record.is_null() {
			return;
		}
		// SAFETY: Class response was checked before invoking this exact factory
		// signature.
		let message = unsafe { (spi.factory)(class, selector, record, pid, 0) };
		if message.is_null() {
			return;
		}
		// SAFETY: The event and autoreleased authentication object are alive for
		// the synchronous attachment.
		unsafe { (spi.set_message)(event, message) };
	}
}
