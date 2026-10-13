//! Listen-only event taps: physical Escape for operation and durable task
//! ownership, and the user's own keys and clicks in the apps a session uses.
use std::{
	ffi::c_void,
	ptr,
	sync::Arc,
	thread::{self, JoinHandle},
	time::Instant,
};

use super::{CoreResult, DesktopError, EmergencyStop, intervention::UserInputs};
use crate::desktop::macos::{front_pid, permission};

pub(crate) const SYNTHETIC_EVENT_TAG: i64 = 0x7069_6465_736b;
const SOURCE_USER_DATA: u32 = 42;
const SOURCE_UNIX_PID: u32 = 41;
/// `kCGEventTargetUnixProcessID`: the process `WindowServer` routes the event
/// to, filled in at the annotated session tap (to be confirmed live for keys
/// and clicks).
const TARGET_UNIX_PID: u32 = 40;
const KEYBOARD_KEYCODE: u32 = 9;
const LEFT_MOUSE_DOWN: u32 = 1;
const RIGHT_MOUSE_DOWN: u32 = 3;
const KEY_DOWN: u32 = 10;
const OTHER_MOUSE_DOWN: u32 = 25;
const SESSION_TAP: u32 = 1;
const ANNOTATED_SESSION_TAP: u32 = 2;
type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

#[repr(C)]
struct SourceContext {
	version:     isize,
	info:        Ref,
	retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	release:     Option<unsafe extern "C" fn(ConstRef)>,
	description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	equal:       Option<unsafe extern "C" fn(ConstRef, ConstRef) -> bool>,
	hash:        Option<unsafe extern "C" fn(ConstRef) -> usize>,
	schedule:    Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:      Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:     Option<unsafe extern "C" fn(Ref)>,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventTapEnable(tap: Ref, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFMachPortInvalidate(port: Ref);
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopStop(run_loop: ConstRef);
	fn CFRunLoopWakeUp(run_loop: ConstRef);
	fn CFRetain(object: ConstRef) -> ConstRef;
	fn CFRelease(object: ConstRef);
}

struct TapContext<C> {
	inner: C,
	tap:   Ref,
}

const fn physical_escape(kind: u32, key: i64, pid: i64, tag: i64) -> bool {
	kind == KEY_DOWN && key == 53 && pid == 0 && tag != SYNTHETIC_EVENT_TAG
}

unsafe extern "C" fn observe(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<EmergencyStop>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		context.inner.cancel();
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (key, pid, tag) = unsafe {
			(
				CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
			)
		};
		if pid == 0 && tag != SYNTHETIC_EVENT_TAG {
			super::USER_ACTIVITY.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
		}
		if physical_escape(kind, key, pid, tag) {
			context.inner.cancel();
		}
	}
	event
}

/// Whether an event came from someone other than this process: the user's
/// hardware, or a tool such as dictation that posts for them under its own
/// process id.
const fn foreign(tag: i64, source_pid: i64, own_pid: i64) -> bool {
	tag != SYNTHETIC_EVENT_TAG && source_pid != own_pid
}

/// The process a foreign key press or click lands in: the target the
/// annotated tap names, else for a key the front process, which takes the
/// keyboard. A click without a target names no app and is dropped.
fn input_target(
	kind: u32,
	target: i64,
	front: impl FnOnce() -> Option<libc::pid_t>,
) -> Option<libc::pid_t> {
	match libc::pid_t::try_from(target) {
		Ok(pid) if pid > 0 => Some(pid),
		_ if kind == KEY_DOWN => front(),
		_ => None,
	}
}

unsafe extern "C" fn observe_user(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext<Arc<UserInputs>>>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (tag, source, target) = unsafe {
			(
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, TARGET_UNIX_PID),
			)
		};
		if foreign(tag, source, i64::from(std::process::id()))
			&& let Some(pid) = input_target(kind, target, front_pid)
		{
			context.inner.record(pid, Instant::now());
		}
	}
	event
}

unsafe extern "C" fn stop_loop(_: Ref) {
	// SAFETY: this callback runs on the monitor's own run loop.
	unsafe {
		CFRunLoopStop(CFRunLoopGetCurrent());
	}
}

/// A listen-only event tap running on its own thread's run loop until drop.
struct TapThread {
	thread:      Option<JoinHandle<()>>,
	run_loop:    usize,
	stop_source: usize,
}

impl TapThread {
	/// Without event-listening access the tap is still created but never sees
	/// an event, so that case fails here instead of starting a blind monitor.
	/// Callers discard the error, so it skips the responsible-app lookup.
	fn start<C: Send + 'static>(
		thread_name: &'static str,
		label: &'static str,
		location: u32,
		mask: u64,
		inner: C,
		callback: Callback,
	) -> CoreResult<Self> {
		if !permission::listen_events() {
			return Err(DesktopError::permission_denied(
				"macOS event-listening access (Input Monitoring) is not granted",
			));
		}
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name(thread_name.into())
			.spawn(move || {
				let mut context = TapContext { inner, tap: ptr::null_mut() };
				// SAFETY: listen-only tap; context stays live until invalidation.
				let tap = unsafe {
					CGEventTapCreate(location, 0, 1, mask, callback, ptr::from_mut(&mut context).cast())
				};
				if tap.is_null() {
					let _ = ready.send(None);
					return;
				}
				context.tap = tap;
				let mut stop_context = SourceContext {
					version:     0,
					info:        ptr::null_mut(),
					retain:      None,
					release:     None,
					description: None,
					equal:       None,
					hash:        None,
					schedule:    None,
					cancel:      None,
					perform:     Some(stop_loop),
				};
				// SAFETY: valid create-rule tap and version-zero run-loop context.
				let (source, stop_source) = unsafe {
					(
						CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0),
						CFRunLoopSourceCreate(ptr::null_mut(), -1, &raw mut stop_context),
					)
				};
				if source.is_null() || stop_source.is_null() {
					// SAFETY: release exactly the objects successfully created
					// above.
					unsafe {
						if !source.is_null() {
							CFRelease(source);
						}
						if !stop_source.is_null() {
							CFRelease(stop_source);
						}
						CFMachPortInvalidate(tap);
						CFRelease(tap);
					}
					let _ = ready.send(None);
					return;
				}
				// SAFETY: all sources remain retained throughout the loop; the
				// owner gets separate retains for its signal/wakeup
				// request.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopAddSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CGEventTapEnable(tap, true);
					let _ =
						ready.send(Some((CFRetain(run_loop) as usize, CFRetain(stop_source) as usize)));
					CFRunLoopRun();
					CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopRemoveSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CFMachPortInvalidate(tap);
					CFRelease(source);
					CFRelease(stop_source);
					CFRelease(tap);
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start {label} monitor: {error}"))
			})?;
		let Some((run_loop, stop_source)) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::input_failed(format!("cannot create the {label} event tap")));
		};
		Ok(Self { thread: Some(worker), run_loop, stop_source })
	}
}

impl Drop for TapThread {
	fn drop(&mut self) {
		// SAFETY: these retains belong to this owner. A signaled source remains
		// pending even when stop races the first CFRunLoopRun call.
		unsafe {
			CFRunLoopSourceSignal(self.stop_source as Ref);
			CFRunLoopWakeUp(self.run_loop as ConstRef);
			CFRelease(self.stop_source as ConstRef);
			CFRelease(self.run_loop as ConstRef);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

pub(super) struct EscapeMonitor {
	_tap: TapThread,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-escape",
			"emergency Escape",
			SESSION_TAP,
			(1 << KEY_DOWN) | (1 << 1) | (1 << 3) | (1 << 25) | (1 << 12),
			emergency,
			observe,
		)?;
		Ok(Self { _tap: tap })
	}
}

/// Records every foreign key press and click by the process it lands in, at
/// the annotated session tap where `WindowServer` has named that process. It
/// listens during background input and between calls, not only during
/// takeover like the Escape monitor.
pub(super) struct UserInputMonitor {
	_tap: TapThread,
}

impl UserInputMonitor {
	pub(super) fn start(inputs: Arc<UserInputs>) -> CoreResult<Self> {
		let tap = TapThread::start(
			"desktop-user-input",
			"user input",
			ANNOTATED_SESSION_TAP,
			(1 << KEY_DOWN)
				| (1 << LEFT_MOUSE_DOWN)
				| (1 << RIGHT_MOUSE_DOWN)
				| (1 << OTHER_MOUSE_DOWN),
			inputs,
			observe_user,
		)?;
		Ok(Self { _tap: tap })
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn only_physical_escape_cancels() {
		assert!(physical_escape(KEY_DOWN, 53, 0, 0));
		assert!(!physical_escape(KEY_DOWN, 53, 0, SYNTHETIC_EVENT_TAG));
		assert!(!physical_escape(KEY_DOWN, 53, 42, 0));
		assert!(!physical_escape(KEY_DOWN, 0, 0, 0));
		assert!(!physical_escape(11, 53, 0, 0));
	}

	#[test]
	fn the_users_and_their_tools_input_is_foreign_and_this_processs_is_not() {
		let own = 900;
		// Hardware input carries no source process.
		assert!(foreign(0, 0, own));
		// A dictation tool posts under its own process id.
		assert!(foreign(0, 4242, own));
		// Anything this process posts carries its tag, whoever relays it.
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 0, own));
		assert!(!foreign(SYNTHETIC_EVENT_TAG, 4242, own));
		// An untagged event this process posted is still its own.
		assert!(!foreign(0, own, own));
	}

	#[test]
	fn foreign_input_lands_in_its_annotated_target_or_a_key_in_the_front_process() {
		let unread = || -> Option<libc::pid_t> { panic!("the front process is not read") };
		assert_eq!(input_target(KEY_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 77, unread), Some(77));
		assert_eq!(input_target(KEY_DOWN, 0, || Some(12)), Some(12));
		assert_eq!(input_target(KEY_DOWN, 0, || None), None);
		assert_eq!(input_target(LEFT_MOUSE_DOWN, 0, unread), None);
		assert_eq!(input_target(RIGHT_MOUSE_DOWN, -1, unread), None);
	}
}
