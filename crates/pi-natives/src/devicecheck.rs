//! Apple `DeviceCheck` token generation (`DCDevice.generateToken`).
//!
//! Reimplements the flow the `ChatGPT` desktop app's `devicecheck.node` addon
//! uses to mint attestation tokens: resolve `DCDevice.currentDevice`, check
//! `isSupported`, then call `generateTokenWithCompletionHandler:` and wait up
//! to one second for the completion block, reporting the base64-encoded token
//! or the failure reason.
//!
//! Uses raw Objective-C runtime FFI and a hand-built block literal — no
//! `objc2`/`block2` dependency.
//!
//! # Platform
//! - **macOS**: Full implementation via `DeviceCheck.framework`.
//! - **Other**: Returns `supported: false` without touching the network.

use napi_derive::napi;

use crate::task;

/// Outcome of a single `DCDevice.generateToken` request.
#[napi(object)]
pub struct DeviceCheckTokenResult {
	/// Whether `DCDevice.isSupported` reported attestation support.
	pub supported:    bool,
	/// Base64-encoded `DeviceCheck` token; present only when generation
	/// succeeded.
	pub token_base64: Option<String>,
	/// Human-readable failure reason when no token was produced.
	pub error:        Option<String>,
	/// Wall-clock time spent in the native call, in milliseconds.
	pub latency_ms:   f64,
}

/// Generate an Apple `DeviceCheck` attestation token.
///
/// Resolves with the token (or the error reason) after at most a 1-second
/// wait, matching the upstream `devicecheck.node` addon contract.
#[napi]
pub fn device_check_generate_token() -> task::Promise<DeviceCheckTokenResult> {
	task::blocking("devicecheck.generate_token", (), move |_| Ok(platform::generate_token()))
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CStr, c_char, c_void},
		panic::{AssertUnwindSafe, catch_unwind},
		ptr,
		sync::mpsc::{self, SyncSender},
		time::{Duration, Instant},
	};

	use super::DeviceCheckTokenResult;

	/// How long to wait for the `DeviceCheck` completion handler before giving
	/// up, matching the timeout in the upstream `devicecheck.node` addon.
	const TOKEN_TIMEOUT: Duration = Duration::from_secs(1);

	type Id = *mut c_void;
	type Sel = *mut c_void;

	// `objc_msgSend` is typed per call signature via `#[link_name]` aliases,
	// the standard idiom for raw ObjC messaging without an objc crate.
	#[allow(
		clashing_extern_declarations,
		reason = "objc_msgSend is an assembly trampoline that forwards to the method IMP; each \
		          alias types the same symbol for a distinct call signature"
	)]
	#[link(name = "objc")]
	unsafe extern "C" {
		fn objc_getClass(name: *const c_char) -> Id;
		fn sel_registerName(name: *const c_char) -> Sel;
		fn objc_retain(obj: Id) -> Id;
		fn objc_release(obj: Id);
		fn objc_autoreleasePoolPush() -> *mut c_void;
		fn objc_autoreleasePoolPop(pool: *mut c_void);

		#[link_name = "objc_msgSend"]
		fn msg_send_noarg(receiver: Id, selector: Sel) -> Id;
		#[link_name = "objc_msgSend"]
		fn msg_send_bool(receiver: Id, selector: Sel) -> u8;
		#[link_name = "objc_msgSend"]
		fn msg_send_u64(receiver: Id, selector: Sel, options: u64) -> Id;
		#[link_name = "objc_msgSend"]
		fn msg_send_block(receiver: Id, selector: Sel, block: *const c_void);
	}

	// Linking DeviceCheck.framework registers `DCDevice` with the ObjC
	// runtime when the addon image loads.
	#[link(name = "DeviceCheck", kind = "framework")]
	unsafe extern "C" {}

	unsafe extern "C" {
		/// Stack-block class from `libsystem_blocks`; used as the literal's isa.
		static _NSConcreteStackBlock: *const c_void;
	}

	// `SessionGetInfo` reports the caller's login-session attributes; consulted
	// to detect a GUI/graphic session before touching the GUI-only DeviceCheck
	// daemon.
	#[link(name = "Security", kind = "framework")]
	unsafe extern "C" {
		fn SessionGetInfo(session: u32, session_id: *mut u32, attributes: *mut u32) -> i32;
	}

	/// `callerSecuritySession` — query the session hosting the current process.
	const CALLER_SECURITY_SESSION: u32 = u32::MAX;
	/// `sessionHasGraphicAccess` attribute bit from `Security/AuthSession.h`.
	const SESSION_HAS_GRAPHIC_ACCESS: u32 = 0x0010;

	/// Whether the caller's security session has GUI/graphic access.
	///
	/// `DCDevice.isSupported` synchronously opens an XPC connection to the
	/// per-user `DeviceCheck` metadata daemon, which exists only in an
	/// interactive GUI login session. From a session without graphic access
	/// (SSH, a launchd `LaunchDaemon`, a CI runner, a service account, a
	/// sandbox) the connection setup hits `_xpc_api_misuse` and aborts the
	/// whole process with `SIGTRAP` before the completion handler can run — so
	/// there is no error to return, only a dead process. Gating on the
	/// documented session attribute keeps the call out of that trapping path.
	///
	/// Returns `false` when graphic access is absent *or* the session cannot be
	/// queried: degrading to "unsupported" merely drops the attestation header
	/// (exactly as on every non-macOS host), whereas optimistically assuming
	/// "supported" risks the process-killing trap.
	fn session_has_graphic_access() -> bool {
		let mut attributes: u32 = 0;
		// SAFETY: `SessionGetInfo` writes the caller session's attribute bits
		// through the out-pointer; the session-id slot is unused, so it is null.
		let status =
			unsafe { SessionGetInfo(CALLER_SECURITY_SESSION, ptr::null_mut(), &mut attributes) };
		status == 0 && attributes & SESSION_HAS_GRAPHIC_ACCESS != 0
	}

	/// Outcome delivered once from the completion block to the waiting worker.
	enum Completion {
		Token(String),
		Error(String),
	}

	/// Objective-C block ABI: the 32-byte literal header followed by the
	/// captured context (a raw pointer to the channel sender).
	#[repr(C)]
	struct CompletionBlock {
		isa:        *const c_void,
		flags:      i32,
		reserved:   i32,
		invoke:     unsafe extern "C" fn(*mut Self, Id, Id),
		descriptor: *const CompletionBlockDescriptor,
		sender:     *const SyncSender<Completion>,
	}

	/// `Block_descriptor_1` followed immediately by `Block_descriptor_3`.
	/// No `Block_descriptor_2` (copy/dispose helpers) is emitted because the
	/// captured sender pointer is plain-old-data and needs no retain/release.
	#[repr(C)]
	struct CompletionBlockDescriptor {
		reserved:  usize,
		size:      usize,
		signature: *const c_char,
	}

	/// `BLOCK_HAS_SIGNATURE` — the only flag needed for a POD stack block.
	const BLOCK_HAS_SIGNATURE: i32 = 1 << 30;

	/// Type encoding for `void (^)(NSData *token, NSError *error)`:
	/// void return, 24 bytes of arguments (block at 0, token at 8, error at 16).
	const BLOCK_SIGNATURE: &CStr = c"v24@?0@8@16";

	/// Immutable, process-lifetime data; the raw signature pointer is never
	/// mutated, so shared access from the `ObjC` runtime is race-free.
	// SAFETY: every field is immutable process-lifetime data.
	unsafe impl Sync for CompletionBlockDescriptor {}

	static COMPLETION_DESCRIPTOR: CompletionBlockDescriptor = CompletionBlockDescriptor {
		reserved:  0,
		size:      size_of::<CompletionBlock>(),
		signature: BLOCK_SIGNATURE.as_ptr(),
	};

	/// Resolve a selector by name; `sel_registerName` is idempotent and cheap.
	///
	/// # Safety
	/// The returned selector is valid for the lifetime of the process.
	unsafe fn selector(name: &CStr) -> Sel {
		// SAFETY: `name` is a valid null-terminated C string.
		unsafe { sel_registerName(name.as_ptr()) }
	}

	/// Copy a C string owned by an autoreleased `NSString` into a Rust `String`.
	///
	/// # Safety
	/// `ptr` must be null or point to a valid null-terminated UTF-8 string that
	/// outlives the call.
	unsafe fn copy_c_string(ptr: *const c_char) -> String {
		if ptr.is_null() {
			return String::new();
		}
		// SAFETY: upheld by the caller; `CStr::from_ptr` only reads.
		unsafe { CStr::from_ptr(ptr) }
			.to_string_lossy()
			.into_owned()
	}

	/// Read the UTF-8 payload of an `NSString` into a Rust `String`.
	///
	/// # Safety
	/// `string` must be a live `NSString` for the duration of the call.
	unsafe fn ns_string(string: Id) -> String {
		// SAFETY: `string` is a live NSString; the returned pointer stays valid
		// until the enclosing autorelease pool drains.
		unsafe { copy_c_string(msg_send_noarg(string, selector(c"UTF8String")).cast()) }
	}

	/// Completion block body. Runs on `DeviceCheck`'s XPC reply queue, which is
	/// why the result travels over a channel instead of a return value.
	///
	/// # Safety
	/// Called by the Objective-C runtime with a valid block literal; `token`
	/// and `error` are live `NSData`/`NSError` objects (or null) for the
	/// duration of the call.
	unsafe extern "C" fn completion_invoke(block: *mut CompletionBlock, token: Id, error: Id) {
		let completion = catch_unwind(AssertUnwindSafe(|| {
			if !token.is_null() {
				// SAFETY: `token` is a live NSData for the duration of the callback.
				let encoded =
					unsafe { msg_send_u64(token, selector(c"base64EncodedStringWithOptions:"), 0) };
				if encoded.is_null() {
					return Completion::Error("DeviceCheck returned no token".to_owned());
				}
				// SAFETY: `encoded` is a live NSString.
				return Completion::Token(unsafe { ns_string(encoded) });
			}
			if !error.is_null() {
				// SAFETY: `error` is a live NSError for the duration of the callback.
				let description = unsafe { msg_send_noarg(error, selector(c"localizedDescription")) };
				if description.is_null() {
					return Completion::Error("DeviceCheck token request failed".to_owned());
				}
				// SAFETY: `description` is a live NSString.
				return Completion::Error(unsafe { ns_string(description) });
			}
			Completion::Error("DeviceCheck returned no token".to_owned())
		}));
		let completion = match completion {
			Ok(completion) => completion,
			Err(payload) => {
				// Never let a panic escape into the ObjC runtime; mirror the
				// bounded-leak disposal used by `task::Blocking` instead of
				// dropping a potentially panicking payload type here.
				std::mem::forget(payload);
				Completion::Error("DeviceCheck completion panicked".to_owned())
			},
		};
		// SAFETY: the owner keeps the sender alive until the block has fired
		// (and leaks it on timeout), so the captured pointer is always valid.
		// `try_send` never blocks the XPC queue, even if the runtime were to
		// invoke the block more than once.
		unsafe {
			_ = (*(*block).sender).try_send(completion);
		}
	}

	/// Build the result for a supported device by driving
	/// `generateTokenWithCompletionHandler:` and waiting on the channel.
	///
	/// # Safety
	/// `device` must be a live, retained `DCDevice` instance.
	unsafe fn run_token_request(device: Id) -> DeviceCheckTokenResult {
		let (sender, receiver) = mpsc::sync_channel::<Completion>(1);
		let sender = Box::into_raw(Box::new(sender));
		let block = CompletionBlock {
			isa: ptr::addr_of!(_NSConcreteStackBlock).cast::<c_void>(),
			flags: BLOCK_HAS_SIGNATURE,
			reserved: 0,
			invoke: completion_invoke,
			descriptor: &raw const COMPLETION_DESCRIPTOR,
			sender,
		};
		// SAFETY: `device` is a live DCDevice and `block` follows the block ABI;
		// the runtime copies the literal, so the stack frame may die after the call.
		unsafe {
			msg_send_block(
				device,
				selector(c"generateTokenWithCompletionHandler:"),
				(&raw const block).cast(),
			);
		}

		let mut result = DeviceCheckTokenResult {
			supported:    true,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		};
		match receiver.recv_timeout(TOKEN_TIMEOUT) {
			Ok(Completion::Token(token)) => {
				result.token_base64 = Some(token);
				// SAFETY: the block has fired and will not fire again, so the
				// sender is unreachable from the runtime and can be reclaimed.
				drop(unsafe { Box::from_raw(sender) });
			},
			Ok(Completion::Error(message)) => {
				result.error = Some(message);
				// SAFETY: same as above — the single-shot block already fired.
				drop(unsafe { Box::from_raw(sender) });
			},
			Err(_) => {
				// Timeout (or a vanished sender): the block may still fire on
				// the XPC queue, so deliberately leak the sender to keep the
				// captured pointer valid. Bounded to one leak per timeout.
				result.error = Some("timed out waiting for DeviceCheck token".to_owned());
			},
		}
		result
	}

	fn generate_token_inner() -> DeviceCheckTokenResult {
		let mut result = DeviceCheckTokenResult {
			supported:    false,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		};
		if !session_has_graphic_access() {
			result.error = Some("DeviceCheck unavailable without a GUI login session".to_owned());
			return result;
		}
		// SAFETY: `c"DCDevice"` is a valid null-terminated class name.
		let class = unsafe { objc_getClass(c"DCDevice".as_ptr()) };
		if class.is_null() {
			result.error = Some("DeviceCheck framework unavailable".to_owned());
			return result;
		}
		// SAFETY: `class` is a registered ObjC class; `currentDevice` is a
		// documented DCDevice class method returning an autoreleased instance.
		let device = unsafe { msg_send_noarg(class, selector(c"currentDevice")) };
		if device.is_null() {
			result.error = Some("DeviceCheck currentDevice unavailable".to_owned());
			return result;
		}
		// SAFETY: `device` is a live object; retain balances the release below.
		let device = unsafe { objc_retain(device) };
		// SAFETY: `device` is a live DCDevice; `isSupported` returns BOOL.
		let supported = unsafe { msg_send_bool(device, selector(c"isSupported")) } != 0;
		if supported {
			// SAFETY: `device` is live and retained for the duration of the call.
			return unsafe {
				let mut token_result = run_token_request(device);
				objc_release(device);
				token_result.supported = true;
				token_result
			};
		}
		// SAFETY: balances the retain above.
		unsafe { objc_release(device) };
		result
	}

	pub fn generate_token() -> DeviceCheckTokenResult {
		let start = Instant::now();
		// SAFETY: pool push/pop are balanced within this scope.
		let pool = unsafe { objc_autoreleasePoolPush() };
		let mut result = generate_token_inner();
		result.latency_ms = start.elapsed().as_secs_f64() * 1000.0;
		// SAFETY: balances the push above.
		unsafe { objc_autoreleasePoolPop(pool) };
		result
	}
}

// ---------------------------------------------------------------------------
// Non-macOS stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod platform {
	use super::DeviceCheckTokenResult;

	pub const fn generate_token() -> DeviceCheckTokenResult {
		DeviceCheckTokenResult {
			supported:    false,
			token_base64: None,
			error:        None,
			latency_ms:   0.0,
		}
	}
}
