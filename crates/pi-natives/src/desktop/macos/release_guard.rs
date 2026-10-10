//! Releases of held keys and buttons that outlive the input request, and the
//! process, that pressed them.
//!
//! Each input request's own cleanup releases what it presses, cancellation
//! included. A panic unwinds past that cleanup and process death ends it, so
//! a helper process (`release_helper.rs`) receives every press with its
//! prepared release, every drag move and every release. When the stream ends
//! with presses still open, the helper posts their releases
//! (`release::plan`). A request starts the helper at its first press, or at
//! once on the shared HID route, and it exits when the request ends: nothing
//! runs between requests.

use std::{
	cell::RefCell,
	ffi::c_void,
	io::{self, Read, Write},
	os::{
		fd::{AsRawFd, OwnedFd},
		unix::{net::UnixStream, process::CommandExt},
	},
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	ptr, slice, thread,
	time::{Duration, Instant},
};

use core_graphics::{
	event::{CGEvent, EventField},
	sys::CGEventRef,
};
use foreign_types::ForeignType;

use super::release::{self, Input, Record, Route, Transition};
use crate::desktop::{control, error::CoreResult, native_helper::HelperDirectory};

const HELPER: &[u8] = include_bytes!(env!("OMP_INPUT_RELEASE_HELPER"));
/// How long the first press on the shared HID route waits for the helper to
/// start observing the user's keys and buttons.
const READY_TIMEOUT: Duration = Duration::from_millis(250);
/// How long a stalled helper may hold up input before the request goes on
/// without it.
const WRITE_TIMEOUT: Duration = Duration::from_millis(100);
/// How long a request that ends with presses open (a panic unwound it) waits
/// for the helper to release them, keeping input ownership meanwhile.
const RELEASE_TIMEOUT: Duration = Duration::from_millis(500);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGEventGetType(event: CGEventRef) -> u32;
	fn CGEventSetType(event: CGEventRef, kind: u32);
	fn CGEventCreateCopy(event: CGEventRef) -> CGEventRef;
	fn CGEventCreateData(allocator: *const c_void, event: CGEventRef) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
	fn CFDataGetLength(data: *const c_void) -> isize;
	fn CFRelease(object: *const c_void);
}

thread_local! {
	static REQUEST: RefCell<Option<Ledger>> = const { RefCell::new(None) };
	/// The helper executable, written once per desktop session thread and
	/// removed with it.
	static EXECUTABLE: RefCell<Option<(HelperDirectory, PathBuf)>> = const { RefCell::new(None) };
}

/// Runs one input request, streaming its presses to a release helper. A
/// request that presses on the shared HID route (`hid`) starts the helper at
/// once, so it is observing the user by the first press; others start it at
/// their first press.
pub(super) fn scope<T>(hid: bool, action: impl FnOnce() -> T) -> T {
	scope_with(spawn, hid, action)
}

fn scope_with<T>(connect: fn() -> io::Result<Helper>, hid: bool, action: impl FnOnce() -> T) -> T {
	struct End;
	impl Drop for End {
		fn drop(&mut self) {
			end();
		}
	}
	let outermost = REQUEST.with_borrow_mut(|request| {
		if request.is_some() {
			return false;
		}
		let mut ledger =
			Ledger { open: Vec::new(), next_id: 0, helper: None, unguarded: false, connect };
		if hid {
			ledger.observe();
		}
		*request = Some(ledger);
		true
	});
	let _end = outermost.then(|| End);
	action()
}

/// Ends the request's stream, also while a panic unwinds it: the helper
/// releases whatever is still open, then exits. With presses open the request
/// waits for that, so its input ownership outlasts the releases.
fn end() {
	let Some(Ledger { open, helper: Some(helper), .. }) = REQUEST.with_borrow_mut(Option::take)
	else {
		return;
	};
	let Helper { child, socket, .. } = helper;
	drop(socket);
	let Some(mut child) = child else {
		return;
	};
	if !open.is_empty() {
		let deadline = Instant::now() + RELEASE_TIMEOUT;
		while Instant::now() < deadline {
			match child.try_wait() {
				Ok(None) => thread::sleep(Duration::from_millis(2)),
				_ => return,
			}
		}
	}
	// Reaped off the input thread; a failed spawn leaves a zombie rather than
	// a panic during unwinding.
	let _ = thread::Builder::new()
		.name("desktop-release-reaper".into())
		.spawn(move || child.wait());
}

/// Posts `event` on `route` through `deliver`, telling the request's release
/// helper what it presses, drags or releases. A press or drag move is told
/// before it is posted and a release after, so the helper never misses a key
/// that may be down or releases a button where the drag never went. Outside
/// an input request this only delivers.
pub(super) fn post(
	route: Route,
	event: &CGEvent,
	deliver: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	REQUEST.with_borrow_mut(|request| match request {
		Some(ledger) => ledger.post(route, event, deliver),
		None => deliver(),
	})
}

struct Helper {
	/// `None` for a test peer.
	child:    Option<Child>,
	socket:   UnixStream,
	/// Told to follow what the user physically holds.
	observes: bool,
	/// Answered that it does.
	ready:    bool,
}

struct Ledger {
	/// Presses not yet released, in press order.
	open:      Vec<(u32, Route, Input)>,
	next_id:   u32,
	helper:    Option<Helper>,
	/// The helper could not start, or stalled; the request runs without one.
	unguarded: bool,
	connect:   fn() -> io::Result<Helper>,
}

impl Ledger {
	fn post(
		&mut self,
		route: Route,
		event: &CGEvent,
		deliver: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		// SAFETY: `event` is live; the raw type also covers event types the
		// core-graphics enum cannot express.
		let kind = unsafe { CGEventGetType(event.as_ptr()) };
		let code = u16::try_from(event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE))
			.unwrap_or(u16::MAX);
		let button = event.get_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER);
		let flags = event.get_flags().bits();
		match release::transition(kind, code, flags, button, |input| {
			self.find(route, input).is_some()
		}) {
			Some(Transition::Press(input)) => {
				self.prepare(route);
				// Preparing may wait for the helper; input cancelled meanwhile
				// presses nothing new.
				control::check()?;
				self.press(route, input, kind, event);
				deliver()
			},
			Some(Transition::Release(input)) => {
				deliver()?;
				if let Some(index) = self.find(route, input) {
					let (id, ..) = self.open.remove(index);
					self.send(&Record::Release { id });
				}
				Ok(())
			},
			Some(Transition::Move(input)) => {
				if let Some(index) = self.find(route, input)
					&& let Some(event) = released(event, kind)
				{
					let id = self.open[index].0;
					self.send(&Record::Update { id, event });
				}
				deliver()
			},
			None => deliver(),
		}
	}

	fn find(&self, route: Route, input: Input) -> Option<usize> {
		self
			.open
			.iter()
			.rposition(|&(_, open_route, open_input)| open_route == route && open_input == input)
	}

	/// Starts the helper for a press on `route`. On the shared HID route it
	/// must first have read which keys and buttons the user already holds.
	fn prepare(&mut self, route: Route) {
		self.start();
		if route == Route::Hid {
			self.observe();
			self.await_ready();
		}
	}

	fn press(&mut self, route: Route, input: Input, kind: u32, event: &CGEvent) {
		let id = self.next_id;
		self.next_id += 1;
		self.open.push((id, route, input));
		if let Some(event) = released(event, kind) {
			self.send(&Record::Press { id, route, input, event });
		}
	}

	/// Starts the helper unless it runs or could not start.
	fn start(&mut self) {
		if self.helper.is_none() && !self.unguarded {
			match (self.connect)() {
				Ok(helper) => self.helper = Some(helper),
				Err(_) => self.unguarded = true,
			}
		}
	}

	/// Starts the helper following what the user physically holds, which only
	/// presses on the shared HID route need.
	fn observe(&mut self) {
		self.start();
		if let Some(helper) = &mut self.helper
			&& !helper.observes
		{
			helper.observes = true;
			self.send(&Record::Observe);
		}
	}

	/// Holds the first press on the shared HID route until the helper answers
	/// that it has read which keys and buttons the user already holds, so it
	/// can tell the user's holds from this request's. A helper that does not
	/// answer in time, exits (it cannot observe) or answers anything else is
	/// stopped before the press, which it could no longer tell apart.
	fn await_ready(&mut self) {
		let Some(helper) = &mut self.helper else {
			return;
		};
		if helper.ready {
			return;
		}
		let mut answer = [0u8];
		helper.ready = helper.socket.set_read_timeout(Some(READY_TIMEOUT)).is_ok()
			&& matches!(helper.socket.read(&mut answer), Ok(1))
			&& answer[0] == release::READY;
		if !helper.ready {
			self.abandon();
		}
	}

	fn send(&mut self, record: &Record) {
		let Some(helper) = &mut self.helper else {
			return;
		};
		let mut bytes = Vec::new();
		record.encode(&mut bytes);
		if helper.socket.write_all(&bytes).is_err() {
			self.abandon();
		}
	}

	/// Stops a helper that missed part of the stream before it sees the
	/// stream end, so it never releases a key this request still holds.
	fn abandon(&mut self) {
		if let Some(Helper { child: Some(mut child), .. }) = self.helper.take() {
			let _ = child.kill();
			let _ = child.wait();
		}
		self.unguarded = true;
	}
}

/// The serialized event that releases what `event` (of type `kind`) holds,
/// at the same place and with the same routing fields.
fn released(event: &CGEvent, kind: u32) -> Option<Vec<u8>> {
	// SAFETY: `event` is live; the copy is a new create-rule event owned below.
	let copy = unsafe { CGEventCreateCopy(event.as_ptr()) };
	if copy.is_null() {
		return None;
	}
	// SAFETY: `copy` is a non-null create-rule CGEvent whose ownership moves
	// here.
	let copy = unsafe { CGEvent::from_ptr(copy) };
	let release = release::release_type(kind);
	if release != kind {
		// SAFETY: `copy` is live and `release` is a key-up or button-up type.
		unsafe { CGEventSetType(copy.as_ptr(), release) };
		if kind != release::KEY_DOWN {
			// A button release carries no pressure.
			copy.set_double_value_field(EventField::MOUSE_EVENT_PRESSURE, 0.0);
		}
	}
	// SAFETY: `copy` is live; the data is a create-rule CFData released below.
	let data = unsafe { CGEventCreateData(ptr::null(), copy.as_ptr()) };
	if data.is_null() {
		return None;
	}
	// SAFETY: `data` is a live CFData whose bytes stay valid until it is
	// released after the copy.
	let bytes = unsafe {
		let bytes =
			slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize).to_vec();
		CFRelease(data);
		bytes
	};
	Some(bytes)
}

/// Starts the release helper, holding the host's desktop input ownership.
fn spawn() -> io::Result<Helper> {
	let executable = EXECUTABLE.with_borrow_mut(|executable| {
		if let Some((_, path)) = executable {
			return Ok(path.clone());
		}
		let directory = HelperDirectory::create("omp-input-release")
			.map_err(|error| io::Error::other(error.message))?;
		let path = directory
			.write("omp-input-release", HELPER, 0o700)
			.map_err(|error| io::Error::other(error.message))?;
		*executable = Some((directory, path.clone()));
		Ok::<_, io::Error>(path)
	})?;
	spawn_at(&executable, control::shared_ownership())
}

/// Starts `executable` as a release helper with one end of a socket pair as
/// its standard input, in its own process group so a terminal's Ctrl-C or
/// hangup that ends the host does not end it too. Its standard output, which
/// it never writes, is `ownership` (the kernel lock of desktop input
/// ownership): a host that dies mid-input then keeps other hosts' input out
/// until the helper has released what the host held and exited.
fn spawn_at(executable: &Path, ownership: Option<OwnedFd>) -> io::Result<Helper> {
	let (socket, theirs) = UnixStream::pair()?;
	let enabled: libc::c_int = 1;
	// SAFETY: `socket` owns a live descriptor; the option value outlives the
	// call. A write to an exited helper then fails instead of raising SIGPIPE
	// in the host.
	if unsafe {
		libc::setsockopt(
			socket.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_NOSIGPIPE,
			ptr::from_ref(&enabled).cast(),
			size_of::<libc::c_int>() as libc::socklen_t,
		)
	} != 0
	{
		return Err(io::Error::last_os_error());
	}
	socket.set_write_timeout(Some(WRITE_TIMEOUT))?;
	let child = Command::new(executable)
		.stdin(Stdio::from(OwnedFd::from(theirs)))
		.stdout(ownership.map_or_else(Stdio::null, Stdio::from))
		.stderr(Stdio::null())
		.process_group(0)
		.spawn()?;
	Ok(Helper { child: Some(child), socket, observes: false, ready: false })
}

#[cfg(test)]
mod tests {
	use std::{
		cell::Cell,
		fs::{File, OpenOptions},
		panic::catch_unwind,
	};

	use core_graphics::{
		event::{CGEventFlags, CGEventType, CGMouseButton},
		geometry::CGPoint,
	};

	use super::*;
	use crate::desktop::{
		control::{self, CancellationSource},
		error::ErrorCode,
		macos::{input, route, skylight},
	};

	thread_local! {
		static PEER: RefCell<Option<UnixStream>> = const { RefCell::new(None) };
		static STAND_IN: RefCell<Option<(HelperDirectory, PathBuf)>> = const { RefCell::new(None) };
		/// The process id of the last stand-in helper started.
		static STARTED: Cell<libc::pid_t> = const { Cell::new(0) };
	}

	/// A helper that is only the far end of the socket, kept for the test to
	/// read.
	fn peer() -> io::Result<Helper> {
		let (socket, theirs) = UnixStream::pair()?;
		PEER.set(Some(theirs));
		Ok(Helper { child: None, socket, observes: false, ready: true })
	}

	/// A peer that has not answered `READY` yet.
	fn unready_peer() -> io::Result<Helper> {
		let mut helper = peer()?;
		helper.ready = false;
		Ok(helper)
	}

	/// A stand-in helper executable that reads its stream to the end, then
	/// takes 300 ms to exit, as one posting releases would.
	fn stand_in() -> PathBuf {
		STAND_IN.with_borrow_mut(|stand_in| {
			let (_, path) = stand_in.get_or_insert_with(|| {
				let directory = HelperDirectory::create("omp-release-test").expect("directory");
				let script = b"#!/bin/sh\ncat >/dev/null\nsleep 0.3\n";
				let path = directory
					.write("helper", script, 0o700)
					.expect("stand-in helper");
				(directory, path)
			});
			path.clone()
		})
	}

	fn slow_helper() -> io::Result<Helper> {
		let helper = spawn_at(&stand_in(), None)?;
		let pid = helper.child.as_ref().map_or(0, Child::id);
		STARTED.set(libc::pid_t::try_from(pid).expect("process id"));
		Ok(helper)
	}

	fn running(pid: libc::pid_t) -> bool {
		// SAFETY: signal 0 only checks that `pid` exists.
		unsafe { libc::kill(pid, 0) == 0 }
	}

	fn decode(stream: &[u8]) -> Vec<Record> {
		let mut records = Vec::new();
		let mut at = 0;
		while let Some((record, size)) = Record::decode(&stream[at..]).expect("valid stream") {
			records.push(record);
			at += size;
		}
		records
	}

	/// The rest of the stream, once the request has ended it.
	fn rest() -> Vec<Record> {
		let mut stream = Vec::new();
		PEER
			.take()
			.expect("a helper started")
			.read_to_end(&mut stream)
			.expect("stream");
		decode(&stream)
	}

	/// What a helper would hold open once the stream ends.
	fn left_open() -> Vec<release::Open> {
		let mut open = Vec::new();
		for record in rest() {
			release::apply(&mut open, record);
		}
		open
	}

	/// The records the helper has been sent so far, without consuming them.
	fn told() -> Vec<Record> {
		PEER.with_borrow(|peer| {
			let peer = peer.as_ref().expect("a helper started");
			let mut stream = vec![0u8; 4096];
			// SAFETY: `stream` is writable for its length; MSG_PEEK leaves the
			// bytes for `rest`.
			let length = unsafe {
				libc::recv(
					peer.as_raw_fd(),
					stream.as_mut_ptr().cast(),
					stream.len(),
					libc::MSG_PEEK | libc::MSG_DONTWAIT,
				)
			};
			decode(&stream[..usize::try_from(length).unwrap_or(0)])
		})
	}

	/// Reads the records the helper has been sent so far.
	fn drain() -> Vec<Record> {
		let records = told();
		let mut sent = Vec::new();
		for record in &records {
			record.encode(&mut sent);
		}
		let mut read = vec![0u8; sent.len()];
		PEER
			.with_borrow_mut(|peer| {
				peer
					.as_mut()
					.expect("a helper started")
					.read_exact(&mut read)
			})
			.expect("told records");
		assert_eq!(read, sent);
		records
	}

	/// Whether the request closed its end of the stream, with nothing unread.
	fn closed() -> bool {
		PEER.with_borrow(|peer| {
			peer.as_ref().is_none_or(|peer| {
				let mut byte = 0u8;
				// SAFETY: `byte` is writable for one byte; MSG_PEEK leaves it.
				unsafe {
					libc::recv(
						peer.as_raw_fd(),
						ptr::from_mut(&mut byte).cast(),
						1,
						libc::MSG_PEEK | libc::MSG_DONTWAIT,
					) == 0
				}
			})
		})
	}

	fn unguarded() -> bool {
		REQUEST.with_borrow(|request| {
			request
				.as_ref()
				.is_some_and(|ledger| ledger.helper.is_none() && ledger.unguarded)
		})
	}

	fn key(code: u16, down: bool, flags: CGEventFlags) -> CGEvent {
		let source = input::source().expect("event source");
		let event = CGEvent::new_keyboard_event(source, code, down).expect("key event");
		event.set_flags(flags);
		event
	}

	fn shift(down: bool) -> CGEvent {
		let flags = if down {
			CGEventFlags::CGEventFlagShift
		} else {
			CGEventFlags::CGEventFlagNull
		};
		key(56, down, flags)
	}

	fn mouse(kind: CGEventType, x: f64) -> CGEvent {
		let source = input::source().expect("event source");
		CGEvent::new_mouse_event(source, kind, CGPoint::new(x, 7.0), CGMouseButton::Left)
			.expect("mouse event")
	}

	fn reborn(open: &release::Open) -> CGEvent {
		#[link(name = "CoreGraphics", kind = "framework")]
		unsafe extern "C" {
			fn CGEventCreateFromData(allocator: *const c_void, data: *const c_void) -> *mut c_void;
		}
		#[link(name = "CoreFoundation", kind = "framework")]
		unsafe extern "C" {
			fn CFDataCreate(
				allocator: *const c_void,
				bytes: *const u8,
				length: isize,
			) -> *const c_void;
		}
		// SAFETY: the bytes outlive the copying CFDataCreate; both create-rule
		// objects are released or owned below.
		unsafe {
			let data = CFDataCreate(ptr::null(), open.event.as_ptr(), open.event.len() as isize);
			let event = CGEventCreateFromData(ptr::null(), data);
			CFRelease(data);
			assert!(!event.is_null(), "release event deserializes");
			CGEvent::from_ptr(event.cast())
		}
	}

	#[test]
	fn a_panicking_request_leaves_its_open_presses_to_the_helper() {
		let route = Route::Keyboard(4242);
		let result = catch_unwind(|| {
			scope_with(peer, false, || {
				post(route, &shift(true), || Ok(())).expect("Shift down");
				let a = |down| key(0, down, CGEventFlags::CGEventFlagShift);
				post(Route::Hid, &a(true), || Ok(())).expect("A down");
				post(Route::Hid, &a(false), || Ok(())).expect("A up");
				panic!("native code panicked while Shift was held");
			})
		});
		assert!(result.is_err());
		let open = left_open();
		assert_eq!(
			open
				.iter()
				.map(|press| (press.route, press.input))
				.collect::<Vec<_>>(),
			[(route, Input::Key(56))]
		);
		// The helper posts a Shift release built from the press.
		let release = reborn(&open[0]);
		assert_eq!(release.get_type() as u32, CGEventType::FlagsChanged as u32);
		assert_eq!(release.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE), 56);

		// Negative control: a request that releases what it pressed leaves
		// nothing open.
		scope_with(peer, false, || {
			post(route, &shift(true), || Ok(())).expect("Shift down");
			post(route, &shift(false), || Ok(())).expect("Shift up");
		});
		assert!(left_open().is_empty());
	}

	#[test]
	fn a_press_is_told_before_it_posts_and_a_release_after() {
		let route = Route::Keyboard(7);
		let mut seen = Vec::new();
		scope_with(peer, false, || {
			for down in [true, false] {
				post(route, &key(12, down, CGEventFlags::CGEventFlagNull), || {
					seen.push(told().len());
					Ok(())
				})
				.expect("posted");
			}
			assert_eq!(told().len(), 2);
		});
		// The press was on the stream when it posted; its release was not yet.
		assert_eq!(seen, [1, 1]);
		assert!(left_open().is_empty());
	}

	#[test]
	fn a_drag_releases_where_it_last_moved_even_mid_move() {
		let mut release_at = Vec::new();
		scope_with(peer, false, || {
			let route = Route::Dual(7);
			post(route, &mouse(CGEventType::LeftMouseDown, 1.0), || Ok(())).expect("down");
			for x in [5.0, 9.0] {
				post(route, &mouse(CGEventType::LeftMouseDragged, x), || {
					let mut open = Vec::new();
					for record in told() {
						release::apply(&mut open, record);
					}
					release_at.push(reborn(&open[0]).location().x);
					Ok(())
				})
				.expect("moved");
			}
		});
		// A host that dies while a move posts has the helper release there.
		assert_eq!(release_at, [5.0, 9.0]);
		let open = left_open();
		assert_eq!(open.len(), 1);
		let release = reborn(&open[0]);
		assert_eq!(release.get_type() as u32, CGEventType::LeftMouseUp as u32);
		assert_eq!(release.location().x, 9.0);
	}

	#[test]
	fn only_a_helper_that_answers_ready_is_told_the_first_hid_press() {
		for answer in [Some(release::READY), Some(0xff), None] {
			let ready = answer == Some(release::READY);
			let mut closed_when_posted = None;
			scope_with(unready_peer, true, || {
				assert_eq!(drain(), [Record::Observe]);
				if let Some(answer) = answer {
					PEER
						.with_borrow_mut(|peer| peer.as_mut().expect("helper").write_all(&[answer]))
						.expect("answer");
				}
				post(Route::Hid, &shift(true), || {
					closed_when_posted = Some(closed());
					Ok(())
				})
				.expect("the press goes ahead either way");
				assert_eq!(unguarded(), !ready, "answer {answer:?}");
			});
			// A ready helper was told the press before it posted; any other
			// was stopped first and told nothing.
			assert_eq!(closed_when_posted, Some(!ready), "answer {answer:?}");
			assert_eq!(left_open().len(), usize::from(ready), "answer {answer:?}");
		}
		// A helper that exits (it cannot observe the user) is stopped too.
		scope_with(unready_peer, true, || {
			drop(PEER.take());
			post(Route::Hid, &shift(true), || Ok(())).expect("posted");
			assert!(unguarded());
		});
	}

	#[test]
	fn input_cancelled_while_the_helper_gets_ready_presses_nothing() {
		let source = CancellationSource::default();
		let mut delivered = false;
		let (pressed, released) = control::with_token_for_test(&source.token(), || {
			scope_with(unready_peer, true, || {
				assert_eq!(drain(), [Record::Observe]);
				let helper = PEER
					.with_borrow(|peer| peer.as_ref().expect("helper").try_clone())
					.expect("helper end");
				let cancel = source.clone();
				// The helper answers only once the input is cancelled.
				let answer = thread::spawn(move || {
					cancel.cancel();
					(&helper).write_all(&[release::READY])
				});
				let pressed = post(Route::Hid, &shift(true), || {
					delivered = true;
					Ok(())
				});
				answer.join().expect("helper thread").expect("READY");
				// Cleanup still releases after cancellation.
				let released = control::cleanup(|| post(Route::Hid, &shift(false), || Ok(())));
				(pressed, released)
			})
		});
		assert_eq!(pressed.map_err(|error| error.code).unwrap_err(), ErrorCode::Cancelled);
		assert!(!delivered);
		assert!(released.is_ok());
		assert!(rest().is_empty(), "the helper was told of no press");
	}

	#[test]
	fn a_nested_scope_keeps_the_outer_request() {
		let route = Route::Keyboard(7);
		scope_with(peer, false, || {
			post(route, &shift(true), || Ok(())).expect("Shift down");
			scope_with(peer, false, || {
				let a = key(0, true, CGEventFlags::CGEventFlagShift);
				post(route, &a, || Ok(())).expect("A down");
			});
			assert!(REQUEST.with_borrow(Option::is_some));
		});
		assert_eq!(left_open().len(), 2);
	}

	#[test]
	fn a_request_unwound_with_presses_open_waits_for_their_release() {
		let unwound = catch_unwind(|| {
			scope_with(slow_helper, false, || {
				post(Route::Keyboard(7), &shift(true), || Ok(())).expect("Shift down");
				panic!("native code panicked while Shift was held");
			})
		});
		assert!(unwound.is_err());
		assert!(!running(STARTED.get()), "the helper released and exited first");
		// Negative control: a request that released what it pressed does not
		// wait.
		scope_with(slow_helper, false, || {
			post(Route::Keyboard(7), &shift(true), || Ok(())).expect("Shift down");
			post(Route::Keyboard(7), &shift(false), || Ok(())).expect("Shift up");
		});
		assert!(running(STARTED.get()));
	}

	#[test]
	fn the_helper_keeps_input_ownership_until_it_exits() {
		let path = std::env::temp_dir()
			.join(format!("omp-release-ownership-test-{}.lock", std::process::id()));
		let open = || {
			OpenOptions::new()
				.read(true)
				.write(true)
				.create(true)
				.truncate(false)
				.open(&path)
				.expect("lock file")
		};
		// SAFETY: `file` owns a live descriptor; flock is nonblocking.
		let lock =
			|file: &File| unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 };
		let host = open();
		assert!(lock(&host));
		let ownership = host.try_clone().expect("shared lock");
		let Helper { child, socket, .. } =
			spawn_at(&stand_in(), Some(ownership.into())).expect("helper");
		// The host dies: its own descriptor closes without unlocking.
		drop(host);
		let other = open();
		assert!(!lock(&other), "the running helper keeps ownership");
		drop(socket);
		child.expect("child").wait().expect("helper exits");
		assert!(lock(&other), "ownership ends with the helper");
		drop(other);
		std::fs::remove_file(&path).expect("remove test lock");
	}

	#[test]
	fn release_events_keep_their_routing_fields_but_not_their_target_process() {
		type GetWindowLocation = unsafe extern "C" fn(CGEventRef) -> CGPoint;
		let fields = [(3, 1), (7, 3), (51, 77), (52, 5), (58, 99), (91, 77), (92, 77)];
		let event = mouse(CGEventType::RightMouseDown, 3.0);
		skylight::set_fields(&event, &fields).expect("SkyLight fields");
		skylight::set_fields(&event, &[(route::TARGET_PID_FIELD, 4242)]).expect("SkyLight fields");
		skylight::set_window_location(&event, CGPoint::new(11.0, 13.0)).expect("window location");
		let release = reborn(&release::Open {
			id:    0,
			route: Route::Dual(4242),
			input: Input::Button(1),
			event: released(&event, CGEventType::RightMouseDown as u32).expect("serialized"),
		});
		assert_eq!(release.get_type() as u32, CGEventType::RightMouseUp as u32);
		for (field, value) in fields {
			assert_eq!(release.get_integer_value_field(field), value, "field {field}");
		}
		let window_location: GetWindowLocation =
			route::symbol(c"CGEventGetWindowLocation").expect("window location getter");
		// SAFETY: a live event and the getter's exact signature.
		let local = unsafe { window_location(release.as_ptr()) };
		assert_eq!((local.x, local.y), (11.0, 13.0));
		// Serialization drops the target process, which the helper stamps
		// again from the press's route before posting.
		assert_eq!(release.get_integer_value_field(route::TARGET_PID_FIELD), 0);
		let routes = route::routes().expect("SkyLight routes");
		// SAFETY: `release` is live.
		unsafe { routes.set_field(release.as_ptr().cast(), route::TARGET_PID_FIELD, 4242) };
		assert_eq!(release.get_integer_value_field(route::TARGET_PID_FIELD), 4242);
	}

	#[test]
	fn outside_a_request_nothing_is_recorded() {
		let mut delivered = false;
		post(Route::Hid, &shift(true), || {
			delivered = true;
			Ok(())
		})
		.expect("posted");
		assert!(delivered);
		assert!(REQUEST.with_borrow(Option::is_none));
	}
}
