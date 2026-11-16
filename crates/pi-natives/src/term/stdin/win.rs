//! Windows stdin: console raw mode with VT input, and a cancellable reader.

use std::{
	io,
	os::windows::io::AsRawHandle,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::JoinHandle,
	time::Duration,
};

use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
	Storage::FileSystem::ReadFile,
	System::{
		Console::{
			CONSOLE_MODE, ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_WINDOW_INPUT, GetConsoleMode,
			GetStdHandle, INPUT_RECORD, ReadConsoleInputW, STD_INPUT_HANDLE, SetConsoleMode,
		},
		IO::CancelSynchronousIo,
		Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
	},
};

use super::{End, READ_BYTES, Shared};

/// `INPUT_RECORD::EventType` of a key event.
const KEY_EVENT: u16 = 0x0001;
/// `KEY_EVENT_RECORD::dwControlKeyState` bits.
const RIGHT_ALT_PRESSED: u32 = 0x0001;
const LEFT_ALT_PRESSED: u32 = 0x0002;
const RIGHT_CTRL_PRESSED: u32 = 0x0004;
const LEFT_CTRL_PRESSED: u32 = 0x0008;
const ENHANCED_KEY: u32 = 0x0100;
/// The Alt key's virtual-key code.
const VK_MENU: u16 = 0x12;
/// `ERROR_BROKEN_PIPE`: the writing end of a stdin pipe closed.
const ERROR_BROKEN_PIPE: i32 = 109;
/// Console input records read per call.
const RECORDS: usize = 128;

/// The process's stdin handle; nothing here closes it.
#[derive(Clone, Copy)]
pub(super) struct Input(HANDLE);

// SAFETY: a console or pipe handle is a process-wide kernel object reference
// with no thread affinity.
unsafe impl Send for Input {}

pub(super) fn stdin() -> io::Result<Input> {
	// SAFETY: takes a plain handle id and returns the process's own handle.
	let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
	if handle.is_null() || handle == INVALID_HANDLE_VALUE {
		return Err(io::Error::new(io::ErrorKind::NotFound, "no stdin handle"));
	}
	Ok(Input(handle))
}

/// The console mode of `handle`, or `None` when it is not a console.
fn console_mode(handle: HANDLE) -> Option<CONSOLE_MODE> {
	let mut mode: CONSOLE_MODE = 0;
	// SAFETY: `handle` is the live stdin handle and `mode` is a valid
	// out-pointer for the duration of the call.
	(unsafe { GetConsoleMode(handle, &raw mut mode) } != 0).then_some(mode)
}

/// Raw mode on the stdin console; holds the mode to put back.
pub(super) struct RawMode {
	handle:   HANDLE,
	original: CONSOLE_MODE,
}

// SAFETY: see `Input`.
unsafe impl Send for RawMode {}

impl RawMode {
	/// Switch the stdin console to raw mode. `None` when stdin is not a
	/// console: a pipe or file is read as is.
	pub(super) fn enter(input: Input) -> io::Result<Option<Self>> {
		let Some(original) = console_mode(input.0) else {
			return Ok(None);
		};
		// libuv's raw console mode (`ENABLE_WINDOW_INPUT` alone: no line
		// editing, echo, or Ctrl+C processing) plus
		// `ENABLE_VIRTUAL_TERMINAL_INPUT`, so modified keys (Shift+Tab, `CSI Z`)
		// and terminal reports arrive as VT sequences instead of console events
		// that lose modifier information. A console without VT input keeps plain
		// raw mode.
		// SAFETY: `input` is the live stdin console handle; modes are flag words.
		let set = |mode: CONSOLE_MODE| unsafe { SetConsoleMode(input.0, mode) } != 0;
		if !set(ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT) && !set(ENABLE_WINDOW_INPUT) {
			return Err(io::Error::last_os_error());
		}
		Ok(Some(Self { handle: input.0, original }))
	}

	/// Console input queues key records, not line-translated text, so a cooked
	/// console leaves no LF-folded typeahead behind.
	#[allow(clippy::unused_self, reason = "the unix mode answers from its saved attributes")]
	pub(super) const fn cooked(&self) -> bool {
		false
	}

	/// Put the mode found at [`enter`](Self::enter) back.
	pub(super) fn restore(&self) -> io::Result<()> {
		// SAFETY: `handle` was the stdin console at `enter`; if it has since
		// been closed the call fails without touching anything.
		if unsafe { SetConsoleMode(self.handle, self.original) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
}

/// A manual-reset event the owner signals to cancel a console wait.
struct Event(HANDLE);

// SAFETY: an event handle is a process-wide kernel object reference; setting
// and waiting on it are thread-safe.
unsafe impl Send for Event {}
// SAFETY: as above.
unsafe impl Sync for Event {}

impl Event {
	fn new() -> io::Result<Self> {
		// SAFETY: no security attributes or name: an unnamed manual-reset event,
		// initially unsignaled.
		let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
		if handle.is_null() {
			return Err(io::Error::last_os_error());
		}
		Ok(Self(handle))
	}

	fn set(&self) {
		// SAFETY: the event stays open while `self` lives.
		unsafe { SetEvent(self.0) };
	}
}

impl Drop for Event {
	fn drop(&mut self) {
		// SAFETY: `self` owns the handle and nothing waits on it any more.
		unsafe { CloseHandle(self.0) };
	}
}

/// The reader thread and what cancels it.
pub(super) struct Reader {
	thread:    Option<JoinHandle<()>>,
	cancel:    Arc<Event>,
	cancelled: Arc<AtomicBool>,
}

impl Reader {
	pub(super) fn start(input: Input, shared: Arc<Shared>) -> io::Result<Self> {
		let cancel = Arc::new(Event::new()?);
		let cancelled = Arc::new(AtomicBool::new(false));
		let console = console_mode(input.0).is_some();
		let thread_cancel = Arc::clone(&cancel);
		let thread_cancelled = Arc::clone(&cancelled);
		let thread = std::thread::Builder::new()
			.name("term-stdin".into())
			.spawn(move || {
				if console {
					console_loop(input, &thread_cancel, &shared);
				} else {
					file_loop(input, &thread_cancelled, &shared);
				}
			})?;
		Ok(Self { thread: Some(thread), cancel, cancelled })
	}

	/// Cancel the reader and join it.
	pub(super) fn stop(&mut self) {
		let Some(thread) = self.thread.take() else {
			return;
		};
		self.cancelled.store(true, Ordering::Release);
		self.cancel.set();
		// A pipe read blocks in `ReadFile`: cancel it until the reader exits. A
		// cancel that lands before the read starts is a no-op, so it repeats.
		while !thread.is_finished() {
			// SAFETY: the thread handle stays valid until the JoinHandle is
			// joined; cancelling I/O the thread is not performing is a no-op.
			unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
			std::thread::sleep(Duration::from_millis(1));
		}
		let _ = thread.join();
	}
}

impl Drop for Reader {
	fn drop(&mut self) {
		self.stop();
	}
}

fn console_loop(input: Input, cancel: &Event, shared: &Shared) {
	let handles = [input.0, cancel.0];
	// SAFETY: INPUT_RECORD is plain data for which all-zero bytes are valid.
	let mut records: [INPUT_RECORD; RECORDS] = unsafe { std::mem::zeroed() };
	let mut units = Vec::new();
	let mut text = String::new();
	loop {
		// SAFETY: both handles stay open until this thread is joined.
		let woke = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
		if woke == 1 {
			return;
		}
		if woke != 0 {
			shared.finish(End::Failed(io::Error::last_os_error()));
			return;
		}
		let mut count = 0u32;
		// SAFETY: `records` is writable for its length and `count` is a valid
		// out-pointer. The console signaled queued input, so this returns
		// without blocking.
		let ok = unsafe {
			ReadConsoleInputW(input.0, records.as_mut_ptr(), RECORDS as u32, &raw mut count)
		};
		if ok == 0 {
			shared.finish(End::Failed(io::Error::last_os_error()));
			return;
		}
		for record in &records[..count as usize] {
			key_units(record, &mut units);
		}
		decode(&mut units, &mut text);
		if !text.is_empty() {
			shared.deliver(text.as_bytes());
			text.clear();
		}
	}
}

fn file_loop(input: Input, cancelled: &AtomicBool, shared: &Shared) {
	let mut buf = vec![0u8; READ_BYTES];
	while !cancelled.load(Ordering::Acquire) {
		let mut read = 0u32;
		// SAFETY: `buf` is writable for its length, `read` is a valid
		// out-pointer, and the read is synchronous (no OVERLAPPED).
		let ok = unsafe {
			ReadFile(input.0, buf.as_mut_ptr(), buf.len() as u32, &raw mut read, std::ptr::null_mut())
		};
		if ok == 0 {
			let err = io::Error::last_os_error();
			if cancelled.load(Ordering::Acquire) {
				return;
			}
			shared.finish(if err.raw_os_error() == Some(ERROR_BROKEN_PIPE) {
				End::Eof
			} else {
				End::Failed(err)
			});
			return;
		}
		if read == 0 {
			shared.finish(End::Eof);
			return;
		}
		shared.deliver(&buf[..read as usize]);
	}
}

/// Virtual keys Alt+numpad character composition is typed on.
const fn is_numpad(key: u16) -> bool {
	// VK_INSERT, VK_END, VK_DOWN, VK_NEXT, VK_LEFT, VK_CLEAR, VK_RIGHT, VK_HOME,
	// VK_UP, VK_PRIOR, and VK_NUMPAD0..=VK_NUMPAD9.
	matches!(key, 0x2d | 0x23 | 0x28 | 0x22 | 0x25 | 0x0c | 0x27 | 0x24 | 0x26 | 0x21 | 0x60..=0x69)
}

/// The UTF-16 a console input record types, as libuv's raw console reader
/// produced it. Under VT input every key and report arrives as character
/// records; a key without a character would need VT input to be encoded.
fn key_units(record: &INPUT_RECORD, units: &mut Vec<u16>) {
	if record.EventType != KEY_EVENT {
		return;
	}
	// SAFETY: `EventType` says the union holds a key event.
	let key = unsafe { record.Event.KeyEvent };
	// SAFETY: every key event carries a UTF-16 unit (or 0) in this union.
	let unit = unsafe { key.uChar.UnicodeChar };
	let state = key.dwControlKeyState;
	// Key-ups type nothing, except the character an Alt+numpad composition
	// produces when Alt is released.
	if key.bKeyDown == 0 && (key.wVirtualKeyCode != VK_MENU || unit == 0) {
		return;
	}
	// Numpad keys pressed while Alt composes a character (or Windows simulates
	// that).
	if state & LEFT_ALT_PRESSED != 0 && state & ENHANCED_KEY == 0 && is_numpad(key.wVirtualKeyCode) {
		return;
	}
	if unit == 0 {
		return;
	}
	// Alt held for a character it did not compose: the ESC of an Alt chord
	// (AltGr reports Ctrl+Alt and types its character plainly).
	let alt = key.bKeyDown != 0
		&& state & (LEFT_ALT_PRESSED | RIGHT_ALT_PRESSED) != 0
		&& state & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED) == 0
		&& !(0xdc00..0xe000).contains(&unit);
	for _ in 0..key.wRepeatCount.max(1) {
		if alt {
			units.push(0x1b);
		}
		units.push(unit);
	}
}

/// Move the decodable prefix of `units` into `text` as UTF-8. A high
/// surrogate whose low half has not arrived yet waits for the next batch.
fn decode(units: &mut Vec<u16>, text: &mut String) {
	let held = units
		.last()
		.is_some_and(|unit| (0xd800..0xdc00).contains(unit));
	let end = units.len() - usize::from(held);
	text.extend(
		char::decode_utf16(units[..end].iter().copied())
			.map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER)),
	);
	units.drain(..end);
}
