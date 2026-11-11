//! Cross-platform power assertions for preventing idle sleep.
//!
//! Exposes a small N-API handle that acquires the platform's sleep-inhibition
//! primitive on construction and releases it on `stop()`/drop. Unsupported
//! platforms retain a no-op handle so higher layers can use one code path.

use napi_derive::napi;

/// Options for starting a power assertion.
///
/// Each boolean maps to a `caffeinate(8)` flag and the closest corresponding
/// platform capability. Multiple flags can be combined; when set, one
/// assertion is taken per flag and all are released together when the
/// handle is stopped or dropped.
///
/// If every flag is unset (or omitted), the handle behaves as if `idle`
/// were `true` — preserving the historical default of `caffeinate -i`.
#[napi(object, js_name = "PowerAssertionOptions")]
pub struct PowerAssertionOptions {
	/// Human-readable reason shown in platform power diagnostics.
	pub reason:  Option<String>,
	/// `caffeinate -i`: prevent the system from idle-sleeping.
	pub idle:    Option<bool>,
	/// `caffeinate -s`: prevent the system from sleeping (AC power only).
	pub system:  Option<bool>,
	/// `caffeinate -u`: declare the user is active (wakes the display).
	pub user:    Option<bool>,
	/// `caffeinate -d`: prevent the display from idle-sleeping.
	pub display: Option<bool>,
}

#[cfg(target_os = "macos")]
pub(crate) mod platform {
	use std::{
		ffi::{CString, c_char, c_void},
		ptr,
	};

	use napi::{Error, Result};

	const UTF8_ENCODING: u32 = 0x0800_0100;
	const ASSERTION_LEVEL_ON: u32 = 255;
	const ASSERTION_ID_NONE: u32 = 0;
	const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
	const PREVENT_SYSTEM_SLEEP: &str = "PreventSystemSleep";
	const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
	const USER_IS_ACTIVE: &str = "UserIsActive";

	/// Variants this module knows how to acquire. Mirrors the `caffeinate(8)`
	/// flag set the public API exposes (`-i`, `-s`, `-u`, `-d`).
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum AssertionKind {
		PreventIdleSystemSleep,
		PreventSystemSleep,
		DeclareUserActive,
		PreventDisplaySleep,
	}

	impl AssertionKind {
		const fn iokit_name(self) -> &'static str {
			match self {
				Self::PreventIdleSystemSleep => PREVENT_USER_IDLE_SYSTEM_SLEEP,
				Self::PreventSystemSleep => PREVENT_SYSTEM_SLEEP,
				Self::DeclareUserActive => USER_IS_ACTIVE,
				Self::PreventDisplaySleep => PREVENT_USER_IDLE_DISPLAY_SLEEP,
			}
		}
	}

	type CFStringRef = *const c_void;
	type CFTypeRef = *const c_void;
	type IOPMAssertionID = u32;
	type IOPMAssertionLevel = u32;
	type IOReturn = i32;

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFStringCreateWithCString(
			alloc: *const c_void,
			c_str: *const c_char,
			encoding: u32,
		) -> CFStringRef;
		fn CFRelease(value: CFTypeRef);
	}

	#[link(name = "IOKit", kind = "framework")]
	unsafe extern "C" {
		fn IOPMAssertionCreateWithName(
			assertion_type: CFStringRef,
			assertion_level: IOPMAssertionLevel,
			assertion_name: CFStringRef,
			assertion_id: *mut IOPMAssertionID,
		) -> IOReturn;
		fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
	}

	struct CfString(CFStringRef);

	impl CfString {
		fn new(value: &str) -> Result<Self> {
			let c_string = CString::new(value).map_err(|_| {
				Error::from_reason("Power assertion strings must not contain NUL bytes")
			})?;
			// SAFETY: `c_string` is a valid, NUL-terminated UTF-8 byte sequence
			// for the duration of the call, and CoreFoundation copies the
			// contents into a new `CFString` when creation succeeds.
			let string_ref =
				unsafe { CFStringCreateWithCString(ptr::null(), c_string.as_ptr(), UTF8_ENCODING) };
			if string_ref.is_null() {
				return Err(Error::from_reason(
					"Failed to allocate CoreFoundation string for power assertion",
				));
			}
			Ok(Self(string_ref))
		}

		const fn as_ptr(&self) -> CFStringRef {
			self.0
		}
	}

	impl Drop for CfString {
		fn drop(&mut self) {
			if self.0.is_null() {
				return;
			}
			// SAFETY: `self.0` was returned by `CFStringCreateWithCString` in
			// `CfString::new` and this wrapper owns the single outstanding
			// reference, so releasing it here balances creation exactly once.
			unsafe { CFRelease(self.0) };
		}
	}

	pub struct AssertionInner {
		assertion_id: IOPMAssertionID,
	}

	impl AssertionInner {
		pub fn start(kind: AssertionKind, reason: &str) -> Result<Self> {
			let assertion_type = CfString::new(kind.iokit_name())?;
			let assertion_reason = CfString::new(reason)?;
			let mut assertion_id = ASSERTION_ID_NONE;
			// SAFETY: both `CFStringRef` values are valid live CoreFoundation
			// strings owned by this stack frame, `ASSERTION_LEVEL_ON` is the
			// documented enabled value, and `assertion_id` points to writable
			// storage for the returned identifier.
			let status = unsafe {
				IOPMAssertionCreateWithName(
					assertion_type.as_ptr(),
					ASSERTION_LEVEL_ON,
					assertion_reason.as_ptr(),
					&mut assertion_id,
				)
			};
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to acquire macOS power assertion {kind:?} (IOReturn={status})"
				)));
			}
			Ok(Self { assertion_id })
		}

		pub fn stop(&mut self) -> Result<()> {
			if self.assertion_id == ASSERTION_ID_NONE {
				return Ok(());
			}
			let assertion_id = self.assertion_id;
			self.assertion_id = ASSERTION_ID_NONE;
			// SAFETY: `assertion_id` came from a successful
			// `IOPMAssertionCreateWithName` call owned by this handle, and we
			// clear local ownership before releasing so the same assertion
			// cannot be released twice.
			let status = unsafe { IOPMAssertionRelease(assertion_id) };
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to release macOS power assertion (IOReturn={status})"
				)));
			}
			Ok(())
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			let _ = self.stop();
		}
	}
}

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		future::Future,
		sync::atomic::{AtomicU64, Ordering},
	};

	use log::debug;
	use napi::{Error, Result};
	use parking_lot::Mutex;
	use zbus::{Connection, zvariant::OwnedFd};

	/// Message prefix marking "no platform backend present". Mirrored by
	/// `POWER_BACKEND_UNAVAILABLE_CODE` in `packages/coding-agent`.
	const POWER_BACKEND_UNAVAILABLE_CODE: &str = "PowerBackendUnavailable";
	const LOGIN1_DESTINATION: &str = "org.freedesktop.login1";
	const LOGIN1_PATH: &str = "/org/freedesktop/login1";
	const LOGIN1_MANAGER: &str = "org.freedesktop.login1.Manager";
	const SCREENSAVER_DESTINATION: &str = "org.freedesktop.ScreenSaver";
	const SCREENSAVER_PATH: &str = "/org/freedesktop/ScreenSaver";
	const SCREENSAVER_INTERFACE: &str = "org.freedesktop.ScreenSaver";
	const INHIBIT_MODE: &str = "block";
	const INHIBIT_WHO: &str = "omp";

	// The connections own their D-Bus transports, while each assertion owns
	// only its login1 inhibitor fd and ScreenSaver cookie. Reuse healthy
	// transports so a new assertion does not synchronously reconnect from the
	// JavaScript thread, tie each cached transport to the N-API Tokio runtime
	// generation whose reactor drives its internal zbus tasks so a
	// worker/Electron realm restart after runtime teardown reconnects cleanly,
	// and tag each connected instance with a monotonic `cache_revision` so a
	// late error from a superseded transport never evicts a newly reconnected
	// bus. The system bus is dropped after a login1 call failure (login1
	// inhibitors are fd-backed, so reconnecting never orphans them); the shared
	// session bus is kept across non-I/O ScreenSaver method errors so other
	// sessions' cookies stay valid.
	pub(super) struct CachedBus {
		runtime_generation: u64,
		cache_revision:     u64,
		connection:         Connection,
	}

	static NEXT_BUS_CACHE_REVISION: AtomicU64 = AtomicU64::new(1);
	static SYSTEM_BUS: Mutex<Option<CachedBus>> = Mutex::new(None);
	static SESSION_BUS: Mutex<Option<CachedBus>> = Mutex::new(None);

	pub(super) fn block_on_dbus_with<F>(handle: &tokio::runtime::Handle, future: F) -> F::Output
	where
		F: Future + Send,
		F::Output: Send,
	{
		match tokio::runtime::Handle::try_current() {
			Err(_) => handle.block_on(future),
			Ok(current) if current.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
				tokio::task::block_in_place(|| handle.block_on(future))
			},
			Ok(_) => std::thread::scope(|scope| {
				scope
					.spawn(|| handle.block_on(future))
					.join()
					.expect("power assertion runtime helper panicked")
			}),
		}
	}

	/// Drive an async `zbus` call on the addon's bounded Tokio runtime instead
	/// of `zbus::blocking`, which otherwise lazily constructs a private
	/// one-worker-per-CPU Tokio runtime when `zbus/tokio` is unified into the
	/// crate graph.
	#[cfg(test)]
	pub(super) fn block_on_dbus<F>(future: F) -> F::Output
	where
		F: Future + Send,
		F::Output: Send,
	{
		let (_, handle) = crate::active_tokio_runtime();
		block_on_dbus_with(&handle, future)
	}

	pub(super) fn ensure_cached_bus<C>(
		slot: &Mutex<Option<CachedBus>>,
		runtime_generation: u64,
		handle: &tokio::runtime::Handle,
		connect: C,
	) -> zbus::Result<(u64, Connection)>
	where
		C: Future<Output = zbus::Result<Connection>> + Send,
	{
		let mut guard = slot.lock();
		if guard
			.as_ref()
			.is_some_and(|cached| cached.runtime_generation != runtime_generation)
		{
			*guard = None;
		}
		if let Some(cached) = &*guard {
			Ok((cached.cache_revision, cached.connection.clone()))
		} else {
			let connection = block_on_dbus_with(handle, connect)?;
			let cache_revision = NEXT_BUS_CACHE_REVISION.fetch_add(1, Ordering::Relaxed);
			*guard =
				Some(CachedBus { runtime_generation, cache_revision, connection: connection.clone() });
			Ok((cache_revision, connection))
		}
	}

	fn evict_cached_bus(
		slot: &Mutex<Option<CachedBus>>,
		runtime_generation: u64,
		cache_revision: u64,
	) {
		let mut guard = slot.lock();
		if guard.as_ref().is_some_and(|cached| {
			cached.runtime_generation == runtime_generation && cached.cache_revision == cache_revision
		}) {
			*guard = None;
		}
	}

	fn system_bus_connect_error(error: &zbus::Error) -> Error {
		// An absent bus socket means this host has no D-Bus at all
		// (headless container). Tag it with a stable code so callers
		// can tell "no backend" apart from a bus that exists but
		// refuses or rejects us, which stays a plain failure.
		let absent = matches!(
			error,
			zbus::Error::Connection(source, _) | zbus::Error::InputOutput(source)
				if source.kind() == std::io::ErrorKind::NotFound
		);
		let code = if absent {
			format!("{POWER_BACKEND_UNAVAILABLE_CODE}: ")
		} else {
			String::new()
		};
		Error::from_reason(format!("{code}Unable to connect to the system bus: {error}"))
	}

	#[derive(Clone, Copy, Debug)]
	pub(super) struct ScreenSaverInhibit {
		cookie:         u32,
		cache_revision: u64,
	}

	/// Holds login1's inhibitor descriptor and the desktop `ScreenSaver` cookie
	/// paired with the session-bus revision that issued it. Closing the
	/// descriptor and releasing the cookie removes both inhibits.
	pub struct AssertionInner {
		login1_inhibitor:    Option<OwnedFd>,
		screensaver_inhibit: Option<ScreenSaverInhibit>,
	}

	impl AssertionInner {
		pub fn start(what: Option<&str>, display: bool, reason: &str) -> Result<Self> {
			Self::start_with_buses(
				what,
				display,
				reason,
				&SYSTEM_BUS,
				&SESSION_BUS,
				Connection::system,
				Connection::session,
			)
		}

		pub(super) fn start_with_buses<SysFn, SysFut, SessFn, SessFut>(
			what: Option<&str>,
			display: bool,
			reason: &str,
			system_bus: &Mutex<Option<CachedBus>>,
			session_bus: &Mutex<Option<CachedBus>>,
			connect_system: SysFn,
			connect_session: SessFn,
		) -> Result<Self>
		where
			SysFn: FnOnce() -> SysFut,
			SysFut: Future<Output = zbus::Result<Connection>> + Send,
			SessFn: FnOnce() -> SessFut,
			SessFut: Future<Output = zbus::Result<Connection>> + Send,
		{
			// The login1 inhibitor is the only real sleep prevention here, so
			// acquire it first and propagate any failure.
			let login1_inhibitor = match what {
				Some(what) => Some(Self::start_login1_with(system_bus, connect_system, what, reason)?),
				None => None,
			};
			// The desktop ScreenSaver inhibit is a best-effort supplement (it
			// only keeps an attached display awake). On headless/SSH sessions it
			// is unavailable, and propagating that failure would drop the login1
			// inhibitor acquired above during unwinding — leaving the caller
			// with no sleep prevention at all. Degrade to login1-only.
			let screensaver_inhibit = if display {
				match Self::start_screensaver_with(session_bus, connect_session, reason) {
					Ok(inhibit) => Some(inhibit),
					Err(error) => {
						debug!("Unable to acquire ScreenSaver display inhibitor: {error}");
						None
					},
				}
			} else {
				None
			};
			Ok(Self { login1_inhibitor, screensaver_inhibit })
		}

		fn start_login1_with<C, Fut>(
			system_bus: &Mutex<Option<CachedBus>>,
			connect: C,
			what: &str,
			reason: &str,
		) -> Result<OwnedFd>
		where
			C: FnOnce() -> Fut,
			Fut: Future<Output = zbus::Result<Connection>> + Send,
		{
			let (runtime_generation, handle) = crate::active_tokio_runtime();
			let (cache_revision, connection) =
				ensure_cached_bus(system_bus, runtime_generation, &handle, connect())
					.map_err(|error| system_bus_connect_error(&error))?;
			let reply = match block_on_dbus_with(
				&handle,
				connection.call_method(
					Some(LOGIN1_DESTINATION),
					LOGIN1_PATH,
					Some(LOGIN1_MANAGER),
					"Inhibit",
					&(what, INHIBIT_WHO, reason, INHIBIT_MODE),
				),
			) {
				Ok(reply) => reply,
				Err(error) => {
					evict_cached_bus(system_bus, runtime_generation, cache_revision);
					return Err(Error::from_reason(format!("login1 Inhibit failed: {error}")));
				},
			};
			reply.body().deserialize::<OwnedFd>().map_err(|error| {
				Error::from_reason(format!("Invalid login1 inhibitor response: {error}"))
			})
		}

		fn start_screensaver_with<C, Fut>(
			session_bus: &Mutex<Option<CachedBus>>,
			connect: C,
			reason: &str,
		) -> Result<ScreenSaverInhibit>
		where
			C: FnOnce() -> Fut,
			Fut: Future<Output = zbus::Result<Connection>> + Send,
		{
			let (runtime_generation, handle) = crate::active_tokio_runtime();
			let (cache_revision, connection) =
				ensure_cached_bus(session_bus, runtime_generation, &handle, connect()).map_err(
					|error| Error::from_reason(format!("Unable to connect to the session bus: {error}")),
				)?;
			Self::inhibit_screensaver_connection(
				session_bus,
				runtime_generation,
				cache_revision,
				&handle,
				&connection,
				reason,
			)
		}

		pub(super) fn inhibit_screensaver_connection(
			session_bus: &Mutex<Option<CachedBus>>,
			runtime_generation: u64,
			cache_revision: u64,
			handle: &tokio::runtime::Handle,
			connection: &Connection,
			reason: &str,
		) -> Result<ScreenSaverInhibit> {
			let reply = match block_on_dbus_with(
				handle,
				connection.call_method(
					Some(SCREENSAVER_DESTINATION),
					SCREENSAVER_PATH,
					Some(SCREENSAVER_INTERFACE),
					"Inhibit",
					&(INHIBIT_WHO, reason),
				),
			) {
				Ok(reply) => reply,
				Err(error) => {
					// A service-level method error (e.g. ScreenSaver absent on
					// a headless session) does not invalidate the shared
					// transport, and dropping it would release other sessions'
					// cookies. Only evict the cache if the underlying socket
					// failed, in which case the bus already lost those cookies.
					if matches!(error, zbus::Error::InputOutput(_)) {
						evict_cached_bus(session_bus, runtime_generation, cache_revision);
					}
					return Err(Error::from_reason(format!("ScreenSaver Inhibit failed: {error}")));
				},
			};
			let cookie = reply.body().deserialize::<u32>().map_err(|error| {
				Error::from_reason(format!("Invalid ScreenSaver inhibitor response: {error}"))
			})?;
			Ok(ScreenSaverInhibit { cookie, cache_revision })
		}

		pub fn stop(&mut self) {
			self.stop_with_session_bus(&SESSION_BUS);
		}

		pub(super) fn stop_with_session_bus(&mut self, session_bus: &Mutex<Option<CachedBus>>) {
			self.login1_inhibitor.take();
			let Some(inhibit) = self.screensaver_inhibit.take() else {
				return;
			};
			let (runtime_generation, handle) = crate::active_tokio_runtime();
			let connection = {
				let mut guard = session_bus.lock();
				match guard.as_ref() {
					Some(cached) if cached.runtime_generation != runtime_generation => {
						// The Tokio runtime driving this connection's zbus tasks
						// has already shut down; dropping the stale connection
						// closes the socket so the bus releases its cookies
						// without awaiting a dead reactor.
						*guard = None;
						return;
					},
					Some(cached) if cached.cache_revision == inhibit.cache_revision => {
						cached.connection.clone()
					},
					// The issuing session-bus transport was already evicted
					// (and possibly replaced by a newer revision whose
					// ScreenSaver service may reuse cookie numbers); its socket
					// closed when evicted, so `inhibit.cookie` is already gone.
					Some(_) | None => return,
				}
			};
			// Drive UnInhibit synchronously to completion (including inside
			// multi-thread or current-thread Tokio runtimes) so the cookie is
			// released before `stop()` returns, evicting only on socket I/O
			// failures so method errors never drop the shared transport out from
			// under other sessions' cookies.
			let result = block_on_dbus_with(&handle, async move {
				connection
					.call_method(
						Some(SCREENSAVER_DESTINATION),
						SCREENSAVER_PATH,
						Some(SCREENSAVER_INTERFACE),
						"UnInhibit",
						&(inhibit.cookie,),
					)
					.await
			});
			if matches!(result, Err(zbus::Error::InputOutput(_))) {
				evict_cached_bus(session_bus, runtime_generation, inhibit.cache_revision);
			}
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			self.stop();
		}
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		sync::mpsc::{self, Sender},
		thread::{self, JoinHandle},
	};

	use napi::{Error, Result};
	use windows_sys::Win32::System::Power::{
		ES_CONTINUOUS, EXECUTION_STATE, SetThreadExecutionState,
	};

	pub struct AssertionInner {
		release: Option<Sender<()>>,
		worker:  Option<JoinHandle<()>>,
	}

	impl AssertionInner {
		pub fn start(flags: EXECUTION_STATE) -> Result<Self> {
			let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
			let (release, release_receiver) = mpsc::channel();
			// SetThreadExecutionState is thread-affine: acquire and release must
			// happen on the same dedicated thread for the full lifetime of this
			// handle.
			let worker = thread::spawn(move || {
				// SAFETY: `flags` contains only documented `EXECUTION_STATE` bits.
				let result = unsafe { SetThreadExecutionState(flags) };
				let acquired = result != 0;
				let _ = ready_sender
					.send(acquired.ok_or_else(|| std::io::Error::last_os_error().to_string()));
				if !acquired {
					return;
				}
				let _ = release_receiver.recv();
				// SAFETY: this is the same dedicated thread that acquired the
				// state.
				unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
			});
			match ready_receiver.recv() {
				Ok(Ok(())) => Ok(Self { release: Some(release), worker: Some(worker) }),
				Ok(Err(error)) => {
					let _ = worker.join();
					Err(Error::from_reason(format!(
						"Failed to acquire Windows power assertion: {error}"
					)))
				},
				Err(error) => {
					let _ = worker.join();
					Err(Error::from_reason(format!(
						"Windows power assertion worker exited before initialization: {error}"
					)))
				},
			}
		}

		pub fn stop(&mut self) {
			if let Some(release) = self.release.take() {
				let _ = release.send(());
			}
			if let Some(worker) = self.worker.take() {
				let _ = worker.join();
			}
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			self.stop();
		}
	}
}

/// Long-lived cross-platform power assertion.
///
/// macOS uses `IOKit`, Linux holds login1 and desktop `ScreenSaver` inhibitors,
/// and Windows holds thread-affine execution state until the handle is stopped
/// or dropped. Other platforms return a no-op handle.
#[napi(js_name = "PowerAssertion")]
pub struct PowerAssertion {
	#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
	inners: Vec<platform::AssertionInner>,
}

#[napi]
impl PowerAssertion {
	/// Acquire a power assertion. Unsupported platforms return a no-op handle
	/// so callers can stay cross-platform.
	#[napi(factory)]
	pub fn start(options: Option<PowerAssertionOptions>) -> napi::Result<Self> {
		let reason = options
			.as_ref()
			.and_then(|value| value.reason.as_deref())
			.filter(|value| !value.trim().is_empty())
			.unwrap_or("omp agent session");
		let idle = options.as_ref().and_then(|v| v.idle).unwrap_or(false);
		let system = options.as_ref().and_then(|v| v.system).unwrap_or(false);
		let user = options.as_ref().and_then(|v| v.user).unwrap_or(false);
		let display = options.as_ref().and_then(|v| v.display).unwrap_or(false);

		// Preserve historical default: an empty options object behaves as
		// `caffeinate -i` (prevent idle system sleep).
		let effective_idle = idle || !(system || user || display);

		#[cfg(target_os = "macos")]
		{
			let mut kinds: Vec<platform::AssertionKind> = Vec::new();
			if effective_idle {
				kinds.push(platform::AssertionKind::PreventIdleSystemSleep);
			}
			if system {
				kinds.push(platform::AssertionKind::PreventSystemSleep);
			}
			if user {
				kinds.push(platform::AssertionKind::DeclareUserActive);
			}
			if display {
				kinds.push(platform::AssertionKind::PreventDisplaySleep);
			}
			let mut inners: Vec<platform::AssertionInner> = Vec::with_capacity(kinds.len());
			for kind in kinds {
				inners.push(platform::AssertionInner::start(kind, reason)?);
			}
			Ok(Self { inners })
		}
		#[cfg(target_os = "linux")]
		{
			let _ = user;
			let what = match (effective_idle, system) {
				(true, true) => Some("idle:sleep"),
				(true, false) => Some("idle"),
				(false, true) => Some("sleep"),
				(false, false) => None,
			};
			Ok(Self { inners: vec![platform::AssertionInner::start(what, display, reason)?] })
		}
		#[cfg(target_os = "windows")]
		{
			use windows_sys::Win32::System::Power::{
				ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
			};

			// SetThreadExecutionState carries no diagnostic string, so `reason`
			// has nowhere to go on Windows.
			let _ = (user, reason);
			// ES_CONTINUOUS makes the state persist until the handle clears it.
			let mut flags = ES_CONTINUOUS;
			// Windows has no separate system-sleep assertion: `ES_SYSTEM_REQUIRED`
			// is the strongest available equivalent for both `idle` and `system`.
			if effective_idle || system {
				flags |= ES_SYSTEM_REQUIRED;
			}
			if display {
				flags |= ES_DISPLAY_REQUIRED;
			}
			Ok(Self { inners: vec![platform::AssertionInner::start(flags)?] })
		}
		#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
		{
			let _ = (reason, effective_idle, system, user, display);
			Ok(Self {})
		}
	}

	/// Release every assertion held by this handle. Safe to call multiple
	/// times; subsequent calls are a no-op.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "not const on supported platforms")]
	pub fn stop(&mut self) -> napi::Result<()> {
		#[cfg(target_os = "macos")]
		{
			let mut first_err: Option<napi::Error> = None;
			for mut inner in self.inners.drain(..) {
				if let Err(err) = inner.stop()
					&& first_err.is_none()
				{
					first_err = Some(err);
				}
			}
			if let Some(err) = first_err {
				return Err(err);
			}
		}
		#[cfg(any(target_os = "linux", target_os = "windows"))]
		for mut inner in self.inners.drain(..) {
			inner.stop();
		}
		Ok(())
	}
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::{
		io,
		os::unix::{
			fs::PermissionsExt,
			net::{UnixListener, UnixStream},
		},
		sync::{
			Arc,
			atomic::{AtomicU32, Ordering},
		},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use napi::bindgen_prelude::shutdown_async_runtime;
	use parking_lot::Mutex;
	use zbus::{Connection, Guid, connection, interface, zvariant::OwnedFd};

	use super::platform::{AssertionInner, CachedBus, block_on_dbus, ensure_cached_bus};

	#[derive(Clone)]
	struct TestScreenSaver {
		next_cookie:   Arc<AtomicU32>,
		released:      Arc<Mutex<Vec<u32>>>,
		release_delay: Duration,
	}

	#[interface(name = "org.freedesktop.ScreenSaver")]
	impl TestScreenSaver {
		#[zbus(name = "Inhibit")]
		fn inhibit(&self, application_name: &str, reason_for_inhibit: &str) -> u32 {
			let _ = (application_name, reason_for_inhibit);
			self.next_cookie.fetch_add(1, Ordering::SeqCst)
		}

		#[zbus(name = "UnInhibit")]
		async fn un_inhibit(&self, cookie: u32) {
			if !self.release_delay.is_zero() {
				tokio::time::sleep(self.release_delay).await;
			}
			self.released.lock().push(cookie);
		}
	}

	#[derive(Clone)]
	struct TestLogin1Manager {
		inhibit_calls: Arc<AtomicU32>,
	}

	#[interface(name = "org.freedesktop.login1.Manager")]
	impl TestLogin1Manager {
		#[zbus(name = "Inhibit")]
		fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> OwnedFd {
			let _ = (what, who, why, mode);
			self.inhibit_calls.fetch_add(1, Ordering::SeqCst);
			let (reader, _writer) = io::pipe().expect("create test inhibitor pipe");
			OwnedFd::from(std::os::fd::OwnedFd::from(reader))
		}
	}

	async fn connect_p2p_screensaver(
		service: TestScreenSaver,
	) -> zbus::Result<(Connection, Connection)> {
		let (client_stream, server_stream) = tokio::net::UnixStream::pair()?;
		let guid = Guid::generate();
		let server_fut = async move {
			connection::Builder::unix_stream(server_stream)
				.server(guid)?
				.p2p()
				.serve_at("/org/freedesktop/ScreenSaver", service)?
				.build()
				.await
		};
		let client_fut = connection::Builder::unix_stream(client_stream)
			.p2p()
			.build();
		tokio::try_join!(client_fut, server_fut)
	}

	async fn connect_p2p_login1(
		service: TestLogin1Manager,
	) -> zbus::Result<(Connection, Connection)> {
		let (client_stream, server_stream) = tokio::net::UnixStream::pair()?;
		let guid = Guid::generate();
		let server_fut = async move {
			connection::Builder::unix_stream(server_stream)
				.server(guid)?
				.p2p()
				.serve_at("/org/freedesktop/login1", service)?
				.build()
				.await
		};
		let client_fut = connection::Builder::unix_stream(client_stream)
			.p2p()
			.build();
		tokio::try_join!(client_fut, server_fut)
	}

	#[test]
	fn block_on_dbus_completes_outside_and_inside_tokio_runtimes() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		let outside = block_on_dbus(async {
			tokio::spawn(async {
				tokio::time::sleep(Duration::from_millis(2)).await;
				7_u32
			})
			.await
			.expect("spawned task outside runtime")
		});
		assert_eq!(outside, 7);

		let multi = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.unwrap();
		let from_multi = multi.block_on(async {
			block_on_dbus(async {
				tokio::spawn(async {
					tokio::time::sleep(Duration::from_millis(2)).await;
					11_u32
				})
				.await
				.expect("spawned task inside multi-thread runtime")
			})
		});
		assert_eq!(from_multi, 11);

		let current = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		let from_current = current.block_on(async {
			block_on_dbus(async {
				tokio::spawn(async {
					tokio::time::sleep(Duration::from_millis(2)).await;
					13_u32
				})
				.await
				.expect("spawned task inside current-thread runtime")
			})
		});
		assert_eq!(from_current, 13);
	}

	#[test]
	fn stop_completes_screensaver_uninhibit_synchronously_across_calling_contexts() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		let released = Arc::new(Mutex::new(Vec::new()));
		let service = TestScreenSaver {
			next_cookie:   Arc::new(AtomicU32::new(10)),
			released:      Arc::clone(&released),
			release_delay: Duration::from_millis(25),
		};
		let servers = Arc::new(Mutex::new(Vec::<Connection>::new()));
		let system_bus: Mutex<Option<CachedBus>> = Mutex::new(None);
		let session_bus: Mutex<Option<CachedBus>> = Mutex::new(None);

		let acquire_display = || {
			let service = service.clone();
			let servers = Arc::clone(&servers);
			AssertionInner::start_with_buses(
				None,
				true,
				"sync-stop-test",
				&system_bus,
				&session_bus,
				|| async { unreachable!("login1 disabled when what is None") },
				move || async move {
					let (client, server) = connect_p2p_screensaver(service).await?;
					servers.lock().push(server);
					Ok(client)
				},
			)
			.expect("start display assertion")
		};

		let mut outside = acquire_display();
		outside.stop_with_session_bus(&session_bus);
		assert_eq!(*released.lock(), vec![10], "outside-runtime stop must await UnInhibit");

		let multi = tokio::runtime::Builder::new_multi_thread()
			.worker_threads(1)
			.enable_all()
			.build()
			.unwrap();
		multi.block_on(async {
			let mut in_multi = acquire_display();
			in_multi.stop_with_session_bus(&session_bus);
			assert_eq!(
				*released.lock(),
				vec![10, 11],
				"multi-thread Tokio caller must observe synchronous UnInhibit completion"
			);
		});

		let current = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		current.block_on(async {
			let mut in_current = acquire_display();
			in_current.stop_with_session_bus(&session_bus);
			assert_eq!(
				*released.lock(),
				vec![10, 11, 12],
				"current-thread Tokio caller must observe synchronous UnInhibit completion"
			);
		});
	}

	#[test]
	fn cached_dbus_transports_reconnect_cleanly_after_napi_runtime_teardown_and_restart() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		shutdown_async_runtime();

		let released = Arc::new(Mutex::new(Vec::new()));
		let screensaver_connects = Arc::new(AtomicU32::new(0));
		let login1_connects = Arc::new(AtomicU32::new(0));
		let login1_inhibit_calls = Arc::new(AtomicU32::new(0));
		let servers = Arc::new(Mutex::new(Vec::<Connection>::new()));
		let system_bus: Mutex<Option<CachedBus>> = Mutex::new(None);
		let session_bus: Mutex<Option<CachedBus>> = Mutex::new(None);

		let run_worker_cycle = |reason: &str| {
			let screensaver = TestScreenSaver {
				next_cookie:   Arc::new(AtomicU32::new(100)),
				released:      Arc::clone(&released),
				release_delay: Duration::from_millis(5),
			};
			let login1 = TestLogin1Manager { inhibit_calls: Arc::clone(&login1_inhibit_calls) };
			let sys_servers = Arc::clone(&servers);
			let sess_servers = Arc::clone(&servers);
			let sys_connects = Arc::clone(&login1_connects);
			let sess_connects = Arc::clone(&screensaver_connects);

			let mut assertion = AssertionInner::start_with_buses(
				Some("sleep:idle"),
				true,
				reason,
				&system_bus,
				&session_bus,
				move || async move {
					sys_connects.fetch_add(1, Ordering::SeqCst);
					let (client, server) = connect_p2p_login1(login1).await?;
					sys_servers.lock().push(server);
					Ok(client)
				},
				move || async move {
					sess_connects.fetch_add(1, Ordering::SeqCst);
					let (client, server) = connect_p2p_screensaver(screensaver).await?;
					sess_servers.lock().push(server);
					Ok(client)
				},
			)
			.expect("PowerAssertion start must succeed");
			assertion.stop_with_session_bus(&session_bus);
		};

		// Worker 1 registers and acquires + stops two assertions (second reuses
		// cached buses).
		crate::omp_install_tokio_runtime();
		run_worker_cycle("worker-1a");
		run_worker_cycle("worker-1b");
		assert_eq!(login1_connects.load(Ordering::SeqCst), 1);
		assert_eq!(screensaver_connects.load(Ordering::SeqCst), 1);
		assert_eq!(login1_inhibit_calls.load(Ordering::SeqCst), 2);
		assert_eq!(released.lock().len(), 2);

		// Worker 1 exits: napi shuts down runtime #1, invalidating its zbus
		// tasks.
		servers.lock().clear();
		shutdown_async_runtime();

		// Worker 2 registers: bounded runtime #2 starts and buses reconnect on
		// the new generation.
		crate::omp_install_tokio_runtime();
		run_worker_cycle("worker-2");
		assert_eq!(login1_connects.load(Ordering::SeqCst), 2);
		assert_eq!(screensaver_connects.load(Ordering::SeqCst), 2);
		assert_eq!(login1_inhibit_calls.load(Ordering::SeqCst), 3);
		assert_eq!(released.lock().len(), 3);

		servers.lock().clear();
		shutdown_async_runtime();
	}

	#[test]
	fn stale_failed_screensaver_attempt_does_not_evict_reconnected_session_bus() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		let system_bus: Mutex<Option<CachedBus>> = Mutex::new(None);
		let session_bus: Mutex<Option<CachedBus>> = Mutex::new(None);

		let released_1 = Arc::new(Mutex::new(Vec::new()));
		let service_1 = TestScreenSaver {
			next_cookie:   Arc::new(AtomicU32::new(100)),
			released:      Arc::clone(&released_1),
			release_delay: Duration::ZERO,
		};
		let server_1_holder = Arc::new(Mutex::new(None::<Connection>));
		let server_1_slot = Arc::clone(&server_1_holder);
		let mut initial = AssertionInner::start_with_buses(
			None,
			true,
			"seed-session-bus",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			move || async move {
				let (client, server) = connect_p2p_screensaver(service_1).await?;
				*server_1_slot.lock() = Some(server);
				Ok(client)
			},
		)
		.expect("seed initial ScreenSaver assertion");
		initial.stop_with_session_bus(&session_bus);
		assert_eq!(*released_1.lock(), vec![100]);

		// Concurrent caller B clones the cached connection (`rev1`) before the
		// transport breaks.
		let (runtime_generation, handle) = crate::active_tokio_runtime();
		let (stale_revision, stale_connection) =
			ensure_cached_bus(&session_bus, runtime_generation, &handle, async {
				unreachable!("session_bus must already hold rev1")
			})
			.expect("clone cached rev1 connection");

		// Server #1 closes its socket, breaking `rev1`.
		server_1_holder.lock().take();

		// Caller A hits the broken `rev1` socket and evicts `rev1`.
		let caller_a = AssertionInner::start_with_buses(
			None,
			true,
			"evict-broken-rev1",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			|| async { unreachable!("caller A must attempt cached rev1") },
		)
		.expect("ScreenSaver failure degrades without failing assertion start");
		drop(caller_a);

		// Caller C reconnects to healthy server #2 (`rev2`) and holds cookie 200.
		let released_2 = Arc::new(Mutex::new(Vec::new()));
		let service_2 = TestScreenSaver {
			next_cookie:   Arc::new(AtomicU32::new(200)),
			released:      Arc::clone(&released_2),
			release_delay: Duration::ZERO,
		};
		let server_2_holder = Arc::new(Mutex::new(None::<Connection>));
		let server_2_slot = Arc::clone(&server_2_holder);
		let mut reconnected = AssertionInner::start_with_buses(
			None,
			true,
			"healthy-rev2",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			move || async move {
				let (client, server) = connect_p2p_screensaver(service_2).await?;
				*server_2_slot.lock() = Some(server);
				Ok(client)
			},
		)
		.expect("reconnect ScreenSaver assertion on rev2");

		// Now caller B's late I/O failure on `rev1` runs eviction; it must NOT
		// evict `rev2` from `session_bus` or close caller C's transport.
		let stale_err = AssertionInner::inhibit_screensaver_connection(
			&session_bus,
			runtime_generation,
			stale_revision,
			&handle,
			&stale_connection,
			"late-stale-caller",
		)
		.expect_err("broken rev1 connection must fail Inhibit");
		assert!(stale_err.reason.contains("ScreenSaver Inhibit failed:"));
		drop(stale_connection);

		reconnected.stop_with_session_bus(&session_bus);
		assert_eq!(
			*released_2.lock(),
			vec![200],
			"late failure from superseded revision must leave reconnected session bus intact"
		);
	}

	#[test]
	fn stopping_superseded_assertion_does_not_release_reused_cookie_on_reconnected_session_bus() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		let system_bus: Mutex<Option<CachedBus>> = Mutex::new(None);
		let session_bus: Mutex<Option<CachedBus>> = Mutex::new(None);

		// Assertion A acquires cookie 7 on revision R1.
		let released_1 = Arc::new(Mutex::new(Vec::new()));
		let service_1 = TestScreenSaver {
			next_cookie:   Arc::new(AtomicU32::new(7)),
			released:      Arc::clone(&released_1),
			release_delay: Duration::ZERO,
		};
		let server_1_holder = Arc::new(Mutex::new(None::<Connection>));
		let server_1_slot = Arc::clone(&server_1_holder);
		let mut assertion_a = AssertionInner::start_with_buses(
			None,
			true,
			"assertion-a-r1",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			move || async move {
				let (client, server) = connect_p2p_screensaver(service_1).await?;
				*server_1_slot.lock() = Some(server);
				Ok(client)
			},
		)
		.expect("start assertion A on R1");

		// ScreenSaver service #1 dies and an I/O failure evicts R1 from
		// `session_bus`.
		server_1_holder.lock().take();
		let evictor = AssertionInner::start_with_buses(
			None,
			true,
			"evict-r1",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			|| async { unreachable!("evictor must attempt cached R1") },
		)
		.expect("ScreenSaver failure degrades without failing assertion start");
		drop(evictor);

		// Restarted ScreenSaver service #2 reconnects as revision R2 and reuses
		// cookie 7 for assertion B.
		let released_2 = Arc::new(Mutex::new(Vec::new()));
		let service_2 = TestScreenSaver {
			next_cookie:   Arc::new(AtomicU32::new(7)),
			released:      Arc::clone(&released_2),
			release_delay: Duration::ZERO,
		};
		let server_2_holder = Arc::new(Mutex::new(None::<Connection>));
		let server_2_slot = Arc::clone(&server_2_holder);
		let mut assertion_b = AssertionInner::start_with_buses(
			None,
			true,
			"assertion-b-r2",
			&system_bus,
			&session_bus,
			|| async { unreachable!("login1 disabled") },
			move || async move {
				let (client, server) = connect_p2p_screensaver(service_2).await?;
				*server_2_slot.lock() = Some(server);
				Ok(client)
			},
		)
		.expect("start assertion B on R2");

		// Stopping/dropping assertion A (from R1) must NOT send UnInhibit(7) over
		// R2 and release assertion B's live inhibitor.
		assertion_a.stop_with_session_bus(&session_bus);
		drop(assertion_a);
		assert!(
			released_2.lock().is_empty(),
			"stopping superseded R1 assertion must not release reused cookie 7 on R2"
		);

		// Stopping assertion B (from R2) releases its cookie 7 over R2.
		assertion_b.stop_with_session_bus(&session_bus);
		assert_eq!(*released_2.lock(), vec![7]);
	}

	#[test]
	fn start_assertion_distinguishes_absent_system_bus_socket_from_permission_denied() {
		let _guard = crate::RUNTIME_LIFECYCLE_TEST_LOCK.lock();
		let temp_dir = std::env::temp_dir().join(format!(
			"pi-natives-dbus-err-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap_or_default()
				.as_nanos()
		));
		std::fs::create_dir_all(&temp_dir).expect("create temp dir");

		let system_bus: Mutex<Option<CachedBus>> = Mutex::new(None);
		let session_bus: Mutex<Option<CachedBus>> = Mutex::new(None);

		let missing_addr = format!("unix:path={}", temp_dir.join("missing.sock").display());
		let Err(missing_err) = AssertionInner::start_with_buses(
			Some("sleep:idle"),
			false,
			"missing-bus-test",
			&system_bus,
			&session_bus,
			move || async move {
				connection::Builder::address(missing_addr.as_str())?
					.build()
					.await
			},
			|| async { unreachable!("display inhibit disabled") },
		) else {
			panic!("missing system bus socket must fail");
		};
		assert!(
			missing_err
				.reason
				.starts_with("PowerBackendUnavailable: Unable to connect to the system bus:"),
			"missing system bus socket must propagate PowerBackendUnavailable marker: {}",
			missing_err.reason
		);

		let denied_sock = temp_dir.join("denied.sock");
		let _listener = UnixListener::bind(&denied_sock).expect("bind denied Unix socket");
		std::fs::set_permissions(&denied_sock, std::fs::Permissions::from_mode(0o000))
			.expect("chmod 0000 denied Unix socket");

		// Root with CAP_DAC_OVERRIDE bypasses 0o000 socket permissions; run the
		// permission-denied contract assertion whenever the kernel enforces
		// EACCES.
		let enforces_eacces = matches!(
			UnixStream::connect(&denied_sock),
			Err(ref err) if err.kind() == io::ErrorKind::PermissionDenied
		);
		if enforces_eacces {
			let denied_addr = format!("unix:path={}", denied_sock.display());
			let Err(denied_err) = AssertionInner::start_with_buses(
				Some("sleep:idle"),
				false,
				"denied-bus-test",
				&system_bus,
				&session_bus,
				move || async move {
					connection::Builder::address(denied_addr.as_str())?
						.build()
						.await
				},
				|| async { unreachable!("display inhibit disabled") },
			) else {
				panic!("permission-denied system bus socket must fail");
			};
			assert!(
				!denied_err.reason.starts_with("PowerBackendUnavailable:"),
				"permission failures must not report an absent backend: {}",
				denied_err.reason
			);
			assert!(
				denied_err
					.reason
					.starts_with("Unable to connect to the system bus:"),
				"unexpected error reason: {}",
				denied_err.reason
			);
		}

		let _ = std::fs::set_permissions(&denied_sock, std::fs::Permissions::from_mode(0o600));
		let _ = std::fs::remove_dir_all(&temp_dir);
	}
}
