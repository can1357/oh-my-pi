//! The input-release helper the addon starts for an input request
//! (`release_guard.rs`). Standard input is a socket carrying the request's
//! presses, drag moves and releases (`release.rs`). When it ends with presses
//! still open, because the host died or a panic unwound the request, this
//! posts their releases through the routes the presses took, then exits.
//! Standard output, never written, holds the host's desktop input ownership
//! lock, so no other host takes input over before these releases are out.
//!
//! The HID route is shared with the user's own keyboard and mouse, so a
//! listen-only tap follows what the user physically holds there, and a
//! release the user's own hold still covers is left to the user.

#![allow(
	dead_code,
	reason = "release.rs and route.rs are shared with the addon, which uses the rest"
)]
#[path = "release.rs"]
mod release;
#[path = "route.rs"]
mod route;

use std::{
	ffi::c_void,
	io::{Read, Write},
	os::{fd::FromRawFd, unix::net::UnixStream},
	process, ptr,
	sync::Arc,
	thread,
};

use release::{Input, Observation, Open, Record, Route, Step, Transitions};

type Ref = *mut c_void;
type TapCallback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

/// `kCGEventSourceStateHIDSystemState`.
const HID_SYSTEM_STATE: i32 = 1;
/// `kCGSessionEventTap`, `kCGHeadInsertEventTap`,
/// `kCGEventTapOptionListenOnly`.
const SESSION_TAP: u32 = 1;
const HEAD_INSERT: u32 = 0;
const LISTEN_ONLY: u32 = 1;
/// `kCGHIDEventTap`.
const HID_TAP: u32 = 0;
const KEYCODE_FIELD: u32 = 9;
const BUTTON_NUMBER_FIELD: u32 = 3;
const SOURCE_PID_FIELD: u32 = 41;
/// `kCGEventTapDisabledByTimeout` and `kCGEventTapDisabledByUserInput`.
const TAP_DISABLED: [u32; 2] = [u32::MAX - 1, u32::MAX];
/// `CLOCK_UPTIME_RAW`, the clock Quartz event timestamps count.
const CLOCK_UPTIME_RAW: u32 = 8;
/// `kCFRunLoopRunHandledSource`.
const HANDLED_SOURCE: i32 = 4;
const SIGINT: i32 = 2;
const SIGHUP: i32 = 1;
const SIGPIPE: i32 = 13;
const SIG_IGN: usize = 1;
/// How long releasing may take once the stream ends before `SIGALRM` ends
/// the helper, and with it the ownership it holds.
const RELEASE_DEADLINE_SECONDS: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: TapCallback,
		user: Ref,
	) -> Ref;
	fn CGEventTapEnable(tap: Ref, enable: bool);
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventGetFlags(event: Ref) -> u64;
	fn CGEventSetFlags(event: Ref, flags: u64);
	fn CGEventSetTimestamp(event: Ref, timestamp: u64);
	fn CGEventGetType(event: Ref) -> u32;
	fn CGEventCreate(source: Ref) -> Ref;
	fn CGEventGetLocation(event: Ref) -> Point;
	fn CGEventSetLocation(event: Ref, location: Point);
	fn CGEventCreateFromData(allocator: Ref, data: Ref) -> Ref;
	fn CGEventPost(tap: u32, event: Ref);
	fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
	fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopCommonModes: Ref;
	static kCFRunLoopDefaultMode: Ref;
	fn CFDataCreate(allocator: Ref, bytes: *const u8, length: isize) -> Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopGetCurrent() -> Ref;
	fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source_handled: bool) -> i32;
	fn CFRunLoopStop(run_loop: Ref);
	fn CFRunLoopWakeUp(run_loop: Ref);
	fn CFRelease(object: Ref);
}

unsafe extern "C" {
	fn signal(signal: i32, handler: usize) -> usize;
	fn alarm(seconds: u32) -> u32;
	fn clock_gettime_nsec_np(clock: u32) -> u64;
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
	x: f64,
	y: f64,
}

/// `CFRunLoopSourceContext`, version 0.
#[repr(C)]
struct SourceContext {
	version:          isize,
	info:             Ref,
	retain:           Option<unsafe extern "C" fn(Ref) -> Ref>,
	release:          Option<unsafe extern "C" fn(Ref)>,
	copy_description: Option<unsafe extern "C" fn(Ref) -> Ref>,
	equal:            Option<unsafe extern "C" fn(Ref, Ref) -> bool>,
	hash:             Option<unsafe extern "C" fn(Ref) -> usize>,
	schedule:         Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:           Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:          Option<unsafe extern "C" fn(Ref)>,
}

struct Tap {
	observation: Arc<Observation>,
	port:        Ref,
}

/// The observer thread's run loop, applying the tap's transitions.
struct RunLoop;

impl Transitions for RunLoop {
	fn drain(&self) {
		// The tap queues only key and button transitions, which arrive far
		// slower than this applies them, so the queue empties.
		// SAFETY: runs this thread's run loop without waiting.
		while unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, true) } == HANDLED_SOURCE {}
	}

	fn run(&self) {
		// SAFETY: runs this thread's run loop until `stop_here` stops it.
		unsafe { CFRunLoopRun() };
	}
}

/// A signal that stops the observer thread's run loop, also when it comes
/// before that loop runs: a signalled source stays pending until it runs.
struct Stop {
	source:   Ref,
	run_loop: Ref,
}

// SAFETY: signalling a source and waking its run loop are thread-safe, and
// both objects live until the process exits.
unsafe impl Send for Stop {}

impl Stop {
	fn signal(self) {
		// SAFETY: see `Send` above.
		unsafe {
			CFRunLoopSourceSignal(self.source);
			CFRunLoopWakeUp(self.run_loop);
		}
	}
}

unsafe extern "C" fn stop_here(_info: Ref) {
	// SAFETY: a source's perform callback runs on its run loop's thread.
	unsafe { CFRunLoopStop(CFRunLoopGetCurrent()) };
}

fn main() {
	// SAFETY: ignoring signals has no preconditions. The host's terminal may
	// send these to its whole session as it goes; the releases still go out.
	unsafe {
		signal(SIGINT, SIG_IGN);
		signal(SIGHUP, SIG_IGN);
		signal(SIGPIPE, SIG_IGN);
	}
	// SAFETY: the addon passes its end of a socket pair as standard input,
	// which nothing else in this process owns.
	let mut stream = unsafe { UnixStream::from_raw_fd(0) };
	let observation = Arc::new(Observation::default());
	let ready = stream.try_clone().ok();
	let open = read_open(&mut stream, || {
		if let Some(ready) = ready {
			let observation = Arc::clone(&observation);
			let _ = thread::Builder::new()
				.name("observe-user".into())
				.spawn(move || observe(&observation, ready));
		}
	});
	// SAFETY: scheduling SIGALRM has no preconditions.
	unsafe { alarm(RELEASE_DEADLINE_SECONDS) };
	if open.is_empty() {
		return;
	}
	for step in release::plan(&open, observation.settle()) {
		if let Step::Post { id, flags } = step
			&& let Some(press) = open.iter().find(|press| press.id == id)
		{
			post(press, flags);
		}
	}
}

/// The presses still open when the stream ends, calling `observe` at the
/// first [`Record::Observe`]. A malformed stream ends it too, keeping what
/// arrived intact.
fn read_open(stream: &mut UnixStream, observe: impl FnOnce()) -> Vec<Open> {
	let mut observe = Some(observe);
	let mut open = Vec::new();
	let mut pending = Vec::new();
	let mut chunk = [0u8; 16 * 1024];
	loop {
		match stream.read(&mut chunk) {
			Ok(0) => return open,
			Ok(length) => pending.extend_from_slice(&chunk[..length]),
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(_) => return open,
		}
		let mut at = 0;
		loop {
			match Record::decode(&pending[at..]) {
				Ok(Some((record, length))) => {
					if record == Record::Observe
						&& let Some(observe) = observe.take()
					{
						observe();
					}
					release::apply(&mut open, record);
					at += length;
				},
				Ok(None) => break,
				Err(_) => return open,
			}
		}
		pending.drain(..at);
	}
}

/// Posts the release of `press` through its route, now-stamped, carrying
/// `flags` when it releases a key. A button released on the HID route is
/// released where the pointer is; one released to a process is addressed to
/// it again, since serialization dropped its target process.
fn post(press: &Open, flags: Option<u64>) {
	// SAFETY: the bytes outlive CFDataCreate, which copies them; every
	// create-rule object is released below.
	let event = unsafe {
		let data = CFDataCreate(ptr::null_mut(), press.event.as_ptr(), press.event.len() as isize);
		if data.is_null() {
			return;
		}
		let event = CGEventCreateFromData(ptr::null_mut(), data);
		CFRelease(data);
		event
	};
	if event.is_null() {
		return;
	}
	// SAFETY: `event` is a live CGEvent owned here until the release below.
	unsafe {
		if let Some(flags) = flags {
			CGEventSetFlags(event, flags);
		}
		CGEventSetTimestamp(event, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
		match press.route {
			Route::Hid => {
				if matches!(press.input, Input::Button(_)) {
					let here = CGEventCreate(ptr::null_mut());
					if !here.is_null() {
						CGEventSetLocation(event, CGEventGetLocation(here));
						CFRelease(here);
					}
				}
				CGEventPost(HID_TAP, event);
			},
			Route::Keyboard(pid) => {
				if let Some(routes) = route::routes() {
					routes.keyboard(pid, event);
				}
			},
			Route::Routed(pid) | Route::Dual(pid) => {
				if let Some(routes) = route::routes() {
					routes.set_field(event, route::TARGET_PID_FIELD, i64::from(pid));
					routes.routed(pid, event);
					if matches!(press.route, Route::Dual(_)) {
						routes.public(pid, event);
					}
				}
			},
		}
		CFRelease(event);
	}
}

/// Follows the keys and buttons the user physically holds: the transitions of
/// events no process posted (the addon's and this helper's own events carry
/// their process ids), on top of those down in the HID system state when the
/// tap starts. The tap starts first and its events queue until the run loop
/// runs them, after the snapshot, so a key that changes in between ends in
/// its latest state; they run before `READY` lets the request's first HID
/// press go, and again before the release plan reads the holds.
/// Without a tap (no Input Monitoring) the helper cannot tell the user's holds
/// from the request's, so it exits; the request goes on without it.
fn observe(observation: &Arc<Observation>, mut ready: UnixStream) {
	// A process's first query loads the state, which takes milliseconds; it
	// runs before the tap so the tap's events do not pile up meanwhile.
	// SAFETY: read-only query of the HID system state.
	unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, 0) };
	let mask = release::TRANSITION_TYPES
		.iter()
		.fold(0u64, |mask, &kind| mask | (1 << kind));
	let context = Box::into_raw(Box::new(Tap {
		observation: Arc::clone(observation),
		port:        ptr::null_mut(),
	}));
	// SAFETY: a listen-only session tap whose context lives for the rest of
	// the process.
	let port = unsafe {
		CGEventTapCreate(SESSION_TAP, HEAD_INSERT, LISTEN_ONLY, mask, observed, context.cast())
	};
	if port.is_null() {
		process::exit(0);
	}
	// SAFETY: `context` is live and only this thread writes it before the run
	// loop starts.
	unsafe { (*context).port = port };
	// SAFETY: `port` is a live tap; the sources and run loop stay alive while
	// the run loop runs, which is until the process exits. The stop source's
	// context is copied at creation.
	let stop = unsafe {
		let run_loop = CFRunLoopGetCurrent();
		let source = CFMachPortCreateRunLoopSource(ptr::null_mut(), port, 0);
		let mut stop_context = SourceContext {
			version:          0,
			info:             ptr::null_mut(),
			retain:           None,
			release:          None,
			copy_description: None,
			equal:            None,
			hash:             None,
			schedule:         None,
			cancel:           None,
			perform:          Some(stop_here),
		};
		let stop = CFRunLoopSourceCreate(ptr::null_mut(), 0, &raw mut stop_context);
		if source.is_null() || stop.is_null() {
			process::exit(0);
		}
		CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
		CFRunLoopAddSource(run_loop, stop, kCFRunLoopCommonModes);
		CGEventTapEnable(port, true);
		Stop { source: stop, run_loop }
	};
	{
		let mut holds = observation.holds();
		for code in 0..128u16 {
			// SAFETY: read-only query of the HID system state.
			if unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, code) } {
				holds.set(Input::Key(code), true);
			}
		}
		for button in 0..32u8 {
			// SAFETY: read-only query of the HID system state.
			if unsafe { CGEventSourceButtonState(HID_SYSTEM_STATE, u32::from(button)) } {
				holds.set(Input::Button(button), true);
			}
		}
	}
	observation.follow(&RunLoop, Box::new(move || stop.signal()), || {
		let _ = ready.write_all(&[release::READY]);
	});
}

unsafe extern "C" fn observed(_proxy: Ref, kind: u32, event: Ref, context: Ref) -> Ref {
	// SAFETY: `context` is the leaked `Tap` this tap was created with.
	let tap = unsafe { &*context.cast::<Tap>() };
	if TAP_DISABLED.contains(&kind) {
		// SAFETY: the tap outlives its callback.
		unsafe { CGEventTapEnable(tap.port, true) };
		return event;
	}
	if event.is_null() {
		return event;
	}
	// SAFETY: documented read-only fields of a live event.
	let (pid, kind, code, flags, button) = unsafe {
		(
			CGEventGetIntegerValueField(event, SOURCE_PID_FIELD),
			CGEventGetType(event),
			CGEventGetIntegerValueField(event, KEYCODE_FIELD),
			CGEventGetFlags(event),
			CGEventGetIntegerValueField(event, BUTTON_NUMBER_FIELD),
		)
	};
	if pid != 0 {
		return event;
	}
	let mut holds = tap.observation.holds();
	let code = u16::try_from(code).unwrap_or(u16::MAX);
	match release::transition(kind, code, flags, button, |input| holds.has(input)) {
		Some(release::Transition::Press(input)) => holds.set(input, true),
		Some(release::Transition::Release(input)) => holds.set(input, false),
		_ => {},
	}
	event
}
