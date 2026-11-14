//! The Windows console as the shell's terminal ([`Terminal`]): what ZLE
//! needs to edit lines on it.
//!
//! - [`ConsoleFile`]: the shell's own terminal (zsh's `SHTTY`), reading
//!   `CONIN$` (UTF-16 records turned into UTF-8 bytes, with the terminal's
//!   `ICRNL`/`INLCR` input mapping, which the console lacks) and writing
//!   `CONOUT$`. Reads are pollable: a waiter thread wakes the engine when the
//!   console has input.
//! - The console's modes map onto [`Termios`]: line input is `ICANON`, echo
//!   `ECHO`, processed input (Ctrl-C as an event) `ISIG`. Non-canonical input
//!   turns on virtual-terminal input, so keys arrive as the escape sequences a
//!   terminal sends.
//! - The window's size is the visible part of the screen buffer.
//!
//! Process groups, the foreground group and ptys have no console
//! counterpart: those operations fail with `Unsupported`, which turns job
//! control off as a shell without a terminal of its own would.

use std::{
	io,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	task::{Context, Poll, Waker},
};

use bstr::BString;
use windows_sys::Win32::{
	Foundation::{
		CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
	},
	Storage::FileSystem::{
		CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, WriteFile,
	},
	System::{
		Console::{
			CONSOLE_SCREEN_BUFFER_INFO, CTRL_C_EVENT, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
			ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
			ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WRAP_AT_EOL_OUTPUT, FlushConsoleInputBuffer,
			GenerateConsoleCtrlEvent, GetConsoleCP, GetConsoleMode, GetConsoleOutputCP,
			GetConsoleScreenBufferInfo, GetNumberOfConsoleInputEvents, INPUT_RECORD, KEY_EVENT,
			PeekConsoleInputW, ReadConsoleInputW, ReadConsoleW, SetConsoleCP, SetConsoleMode,
			SetConsoleOutputCP,
		},
		Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
	},
};

use crate::bash::{
	CtlChar, File, FileKind, OsHandle, Pty, SetWhen, Shtty, TermFlag, Terminal, Termios, TtyInfo,
	fs::SeekFrom,
};

/// UTF-8, the code page the shell writes in.
const CP_UTF8: u32 = 65001;

/// A handle shared across threads (`HANDLE` is a raw pointer).
#[derive(Clone, Copy, PartialEq, Eq)]
struct Raw(usize);

impl Raw {
	fn of(h: HANDLE) -> Self {
		Self(h as usize)
	}

	const fn get(self) -> HANDLE {
		self.0 as HANDLE
	}
}

/// The console the shell opened ([`Terminal::open_controlling`]): its
/// input and output handles and the input mapping its modes ask for.
struct Console {
	conin:  Raw,
	conout: Raw,
	/// `ICRNL`: CR read as NL.
	icrnl:  AtomicBool,
	/// `INLCR`: NL read as CR.
	inlcr:  AtomicBool,
	/// `ISIG`: the interrupt character raises Ctrl-C.
	isig:   AtomicBool,
	/// Set when the console is dropped: the waiter thread ends.
	stop:   Raw,
	/// The waker of the read waiting for input, and whether a waiter
	/// thread is watching for it.
	waiter: Mutex<(Option<Waker>, bool)>,
}

impl Drop for Console {
	fn drop(&mut self) {
		// SAFETY: the handles are this console's own; the event wakes a
		// waiter thread still watching (it holds no reference to them
		// beyond its wait, which the event ends).
		unsafe {
			SetEvent(self.stop.get());
			CloseHandle(self.conin.get());
			CloseHandle(self.conout.get());
		}
	}
}

impl Console {
	/// The process's console, opened afresh (`CONIN$`, `CONOUT$`); `None`
	/// when the process has none.
	fn open() -> io::Result<Option<Self>> {
		let Some(conin) = open("CONIN$") else {
			return Ok(None);
		};
		let Some(conout) = open("CONOUT$") else {
			// SAFETY: closes the handle just opened.
			unsafe { CloseHandle(conin.get()) };
			return Ok(None);
		};
		// SAFETY: a manual-reset, unsignalled, unnamed event.
		let stop = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
		if stop.is_null() {
			let e = io::Error::last_os_error();
			// SAFETY: closes the handles just opened.
			unsafe {
				CloseHandle(conin.get());
				CloseHandle(conout.get());
			}
			return Err(e);
		}
		Ok(Some(Self {
			conin,
			conout,
			icrnl: AtomicBool::new(false),
			inlcr: AtomicBool::new(false),
			isig: AtomicBool::new(false),
			stop: Raw::of(stop),
			waiter: Mutex::new((None, false)),
		}))
	}

	/// Whether a read finds a character now. Records that carry none
	/// (key releases, focus and mouse events) are dropped, so they neither
	/// block a read nor keep waking the waiter.
	fn has_char(&self) -> io::Result<bool> {
		let h = self.conin.get();
		loop {
			let mut n = 0u32;
			// SAFETY: `h` is an open console input handle.
			if unsafe { GetNumberOfConsoleInputEvents(h, &raw mut n) } == 0 {
				return Err(io::Error::last_os_error());
			}
			if n == 0 {
				return Ok(false);
			}
			// SAFETY: an all-zero INPUT_RECORD is a valid value.
			let mut records = vec![unsafe { std::mem::zeroed::<INPUT_RECORD>() }; n as usize];
			let mut got = 0u32;
			// SAFETY: `records` holds `n` records.
			if unsafe { PeekConsoleInputW(h, records.as_mut_ptr(), n, &raw mut got) } == 0 {
				return Err(io::Error::last_os_error());
			}
			let records = &records[..got as usize];
			let chars = records.iter().position(|r| {
				// SAFETY: `KeyEvent` is the active field of a KEY_EVENT record.
				r.EventType == KEY_EVENT as u16
					&& unsafe {
						r.Event.KeyEvent.bKeyDown != 0 && r.Event.KeyEvent.uChar.UnicodeChar != 0
					}
			});
			// Drop the records before the first character (all of them
			// when there is none); a read returns the rest.
			let skip = chars.unwrap_or(records.len());
			if skip > 0 {
				// SAFETY: an all-zero INPUT_RECORD is a valid value.
				let mut sink = vec![unsafe { std::mem::zeroed::<INPUT_RECORD>() }; skip];
				// SAFETY: `sink` holds `skip` records; that many are queued.
				unsafe { ReadConsoleInputW(h, sink.as_mut_ptr(), skip as u32, &raw mut got) };
			}
			if chars.is_some() {
				return Ok(true);
			}
		}
	}

	/// Wake `waker` when the console has input: a thread waits on the
	/// input handle (unless one already does) and ends with the wake.
	fn watch(self: &Arc<Self>, waker: &Waker) {
		let mut waiter = self
			.waiter
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		waiter.0 = Some(waker.clone());
		if waiter.1 {
			return;
		}
		waiter.1 = true;
		drop(waiter);
		let console = Arc::downgrade(self);
		let (conin, stop) = (self.conin, self.stop);
		std::thread::Builder::new()
			.name("pi-shell-console".into())
			.spawn(move || {
				let handles = [conin.get(), stop.get()];
				// SAFETY: both handles stay open while `console` lives;
				// dropping it sets `stop` first.
				let which = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
				let Some(console) = console.upgrade() else {
					return;
				};
				let mut waiter = console
					.waiter
					.lock()
					.unwrap_or_else(std::sync::PoisonError::into_inner);
				waiter.1 = false;
				let waker = waiter.0.take();
				drop(waiter);
				if which == WAIT_OBJECT_0
					&& let Some(w) = waker
				{
					w.wake();
				}
			})
			.map_or_else(
				|_| {
					// No thread: wake at once, the engine polls again.
					self
						.waiter
						.lock()
						.unwrap_or_else(std::sync::PoisonError::into_inner)
						.1 = false;
					waker.wake_by_ref();
				},
				drop,
			);
	}
}

/// `/dev/tty`: the process's console.
///
/// It reads `CONIN$` and writes `CONOUT$` (an external gets the one for its
/// direction, [`File::os_output_handle`]). Without a console it fails as a
/// Unix process without a controlling terminal does (`ENXIO`).
pub fn open_tty() -> io::Result<Box<dyn File>> {
	let console = Console::open()?.ok_or_else(|| io::Error::other("No such device or address"))?;
	Ok(Box::new(ConsoleFile { console: Arc::new(console), pending: Vec::new(), high: None }))
}

/// Ctrl-C events the process host's console handler claimed (a trapped or
/// ignored `SIGINT`), and whether it claims them now. A console read that
/// Ctrl-C ends looks like end of input under a pseudoconsole (success,
/// nothing read, no error): this count tells them apart.
static CTRL_C_CLAIMED: AtomicU64 = AtomicU64::new(0);
static CLAIMS_CTRL_C: AtomicBool = AtomicBool::new(false);

/// The handler claims Ctrl-C from now on (`on`), or no longer does.
pub fn claim_ctrl_c(on: bool) {
	CLAIMS_CTRL_C.store(on, Ordering::Release);
}

/// The handler claimed one Ctrl-C (it runs on a thread of its own: an
/// atomic only).
pub fn ctrl_c_claimed() {
	CTRL_C_CLAIMED.fetch_add(1, Ordering::AcqRel);
}

/// The claimed Ctrl-C count, to compare with [`ctrl_c_since`].
pub fn ctrl_c_count() -> u64 {
	CTRL_C_CLAIMED.load(Ordering::Acquire)
}

/// Whether a Ctrl-C was claimed since the count was `before`, waiting up to
/// `grace` for the handler's thread when the handler claims Ctrl-C (the
/// console starts it while it ends the read).
pub fn ctrl_c_since(before: u64, grace: std::time::Duration) -> bool {
	let deadline = std::time::Instant::now() + grace;
	loop {
		if ctrl_c_count() != before {
			return true;
		}
		if !CLAIMS_CTRL_C.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
			return false;
		}
		std::thread::sleep(std::time::Duration::from_millis(2));
	}
}

/// zsh's `SHTTY` on the Windows console: reads `CONIN$`, writes `CONOUT$`.
pub struct ConsoleFile {
	console: Arc<Console>,
	/// Bytes read but not yet taken, and a high surrogate waiting for its
	/// pair.
	pending: Vec<u8>,
	high:    Option<u16>,
}

impl ConsoleFile {
	/// Read what the console has (at least one character) into `pending`.
	fn fill(&mut self) -> io::Result<()> {
		let mut wide = [0u16; 256];
		let mut got = 0u32;
		// SAFETY: `wide` holds 256 UTF-16 units; no read-ahead control.
		if unsafe {
			ReadConsoleW(
				self.console.conin.get(),
				wide.as_mut_ptr().cast(),
				wide.len() as u32,
				&raw mut got,
				std::ptr::null(),
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		let mut units: Vec<u16> = self.high.take().into_iter().collect();
		units.extend_from_slice(&wide[..got as usize]);
		if let Some(&last) = units.last()
			&& (0xd800..0xdc00).contains(&last)
		{
			self.high = units.pop();
		}
		let icrnl = self.console.icrnl.load(Ordering::Relaxed);
		let inlcr = self.console.inlcr.load(Ordering::Relaxed);
		let isig = self.console.isig.load(Ordering::Relaxed);
		let mut utf8 = [0u8; 4];
		for c in char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)) {
			let c = match c {
				// `ISIG`: the interrupt character is a signal, not input. With
				// virtual-terminal input the console delivers it as a key;
				// raised as Ctrl-C, it reaches the shell's handler (or ends
				// the shell when it does not trap it), as `SIGINT` would. A
				// terminal also drops the input not yet read (no `NOFLSH`).
				'\u{3}' if isig => {
					self.pending.clear();
					// SAFETY: plain calls on the console's input handle; group
					// 0 is this console's processes sharing the shell's group.
					unsafe {
						FlushConsoleInputBuffer(self.console.conin.get());
						GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
					}
					continue;
				},
				'\r' if icrnl => '\n',
				'\n' if inlcr => '\r',
				c => c,
			};
			self
				.pending
				.extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
		}
		Ok(())
	}
}

impl File for ConsoleFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		while self.pending.is_empty() {
			match self.console.has_char() {
				Ok(true) => {},
				Ok(false) => {
					self.console.watch(cx.waker());
					// Input may have come before the watch started.
					if !matches!(self.console.has_char(), Ok(true)) {
						return Poll::Pending;
					}
				},
				Err(e) => return Poll::Ready(Err(e)),
			}
			if buf.is_empty() {
				return Poll::Ready(Ok(0));
			}
			// What was read may all have been signals: look again.
			if let Err(e) = self.fill() {
				return Poll::Ready(Err(e));
			}
		}
		let n = buf.len().min(self.pending.len());
		buf[..n].copy_from_slice(&self.pending[..n]);
		self.pending.drain(..n);
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		let mut wrote = 0u32;
		let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
		// SAFETY: `buf` holds at least `len` bytes.
		if unsafe {
			WriteFile(
				self.console.conout.get(),
				buf.as_ptr(),
				len,
				&raw mut wrote,
				std::ptr::null_mut(),
			)
		} == 0
		{
			return Poll::Ready(Err(io::Error::last_os_error()));
		}
		Poll::Ready(Ok(wrote as usize))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn kind(&self) -> FileKind {
		FileKind::Tty
	}

	fn os_handle(&self) -> Option<OsHandle> {
		Some(OsHandle(self.console.conin.0 as u64))
	}

	fn os_output_handle(&self) -> Option<OsHandle> {
		Some(OsHandle(self.console.conout.0 as u64))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self { console: Arc::clone(&self.console), pending: Vec::new(), high: None }))
	}
}

/// The console modes and code pages before the shell changed them.
struct Saved {
	conin:  Raw,
	conout: Raw,
	input:  u32,
	output: u32,
	in_cp:  u32,
	out_cp: u32,
}

/// The Windows half of [`crate::sys::tty::NativeTerminal`].
#[derive(Default)]
pub struct WindowsConsole {
	console:    Option<Arc<Console>>,
	saved:      Option<Saved>,
	/// The group job control gave the terminal ([`Terminal::set_foreground`]),
	/// which the console itself does not know.
	foreground: Option<i32>,
}

impl WindowsConsole {
	/// No console opened yet.
	#[must_use]
	pub const fn new() -> Self {
		Self { console: None, saved: None, foreground: None }
	}
}

/// The job the keyboard's Ctrl-C is forwarded to as `CTRL_BREAK_EVENT`, by
/// its leader's pid (0: nowhere): a job `fg` brought to the foreground
/// whose stages lead console process groups of their own, which the
/// console's own Ctrl-C does not reach (the console has no `tcsetpgrp`).
static FORWARD_CTRL_C: AtomicU32 = AtomicU32::new(0);

/// The job a Ctrl-C the shell's handler sees goes on to (0: none), for
/// [`crate::sys::spawn::break_console_groups`].
pub fn ctrl_c_forward() -> u32 {
	FORWARD_CTRL_C.load(Ordering::Acquire)
}

impl Drop for WindowsConsole {
	/// The console is shared with the shell that started this one: its
	/// modes and code pages always go back.
	fn drop(&mut self) {
		if let Some(s) = self.saved.take() {
			// SAFETY: plain calls on handles kept open by `console`.
			unsafe {
				SetConsoleMode(s.conin.get(), s.input);
				SetConsoleMode(s.conout.get(), s.output);
				SetConsoleCP(s.in_cp);
				SetConsoleOutputCP(s.out_cp);
			}
		}
	}
}

/// The console mode of `h`; `None` when it is no console handle.
fn mode(h: HANDLE) -> Option<u32> {
	let mut m = 0u32;
	// SAFETY: GetConsoleMode only writes the mode.
	(unsafe { GetConsoleMode(h, &raw mut m) } != 0).then_some(m)
}

/// `ENOTTY` for a handle that is no console.
fn not_a_tty() -> io::Error {
	io::Error::other("Inappropriate ioctl for device")
}

/// Open a console device (`CONIN$`, `CONOUT$`) read-write.
fn open(name: &str) -> Option<Raw> {
	let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
	// SAFETY: `wide` is NUL-terminated; no security attributes or template.
	let h = unsafe {
		CreateFileW(
			wide.as_ptr(),
			GENERIC_READ | GENERIC_WRITE,
			FILE_SHARE_READ | FILE_SHARE_WRITE,
			std::ptr::null(),
			OPEN_EXISTING,
			0,
			std::ptr::null_mut(),
		)
	};
	(h != INVALID_HANDLE_VALUE && !h.is_null()).then(|| Raw::of(h))
}

/// The [`Termios`] of console input mode `input`; `icrnl`/`inlcr` are
/// the mapping the shell asked for (the console has none).
pub(crate) fn termios_of(input: u32, icrnl: bool, inlcr: bool) -> Termios {
	let mut t = Termios::default();
	t.set(TermFlag::Icanon, input & ENABLE_LINE_INPUT != 0);
	t.set(TermFlag::Echo, input & ENABLE_ECHO_INPUT != 0);
	t.set(TermFlag::Echoe, true);
	t.set(TermFlag::Echok, true);
	t.set(TermFlag::Isig, input & ENABLE_PROCESSED_INPUT != 0);
	t.set(TermFlag::Iexten, true);
	t.set(TermFlag::Icrnl, icrnl);
	t.set(TermFlag::Inlcr, inlcr);
	// Output is always processed (`\n` starts a new line).
	t.set(TermFlag::Opost, true);
	t.set(TermFlag::Onlcr, true);
	t.set(TermFlag::Cread, true);
	for (c, v) in [
		(CtlChar::Intr, 0x03),
		(CtlChar::Quit, 0x1c),
		(CtlChar::Erase, 0x7f),
		(CtlChar::Kill, 0x15),
		(CtlChar::Eof, 0x04),
		(CtlChar::Start, 0x11),
		(CtlChar::Stop, 0x13),
		(CtlChar::Susp, 0x1a),
		(CtlChar::Lnext, 0x16),
		(CtlChar::Werase, 0x17),
		(CtlChar::Reprint, 0x12),
	] {
		t.set_char(c, Some(v));
	}
	t.ispeed = 38400;
	t.ospeed = 38400;
	t.os = input.to_le_bytes().to_vec();
	t
}

/// The console input mode for `t`, starting from the mode `base`: line
/// input, echo (only with line input, the console refuses it alone) and
/// processed input from the flags; virtual-terminal input exactly when
/// input is not canonical, so editing keys arrive as escape sequences.
pub(crate) const fn input_mode_of(t: &Termios, base: u32) -> u32 {
	let canon = t.get(TermFlag::Icanon);
	let mut m = base
		& !(ENABLE_LINE_INPUT
			| ENABLE_ECHO_INPUT
			| ENABLE_PROCESSED_INPUT
			| ENABLE_VIRTUAL_TERMINAL_INPUT);
	if canon {
		m |= ENABLE_LINE_INPUT;
		if t.get(TermFlag::Echo) {
			m |= ENABLE_ECHO_INPUT;
		}
	} else {
		m |= ENABLE_VIRTUAL_TERMINAL_INPUT;
	}
	if t.get(TermFlag::Isig) {
		m |= ENABLE_PROCESSED_INPUT;
	}
	m
}

impl WindowsConsole {
	/// The opened console's input handle if `h` is a console handle at all
	/// (the shell's own, or a standard stream on the same console).
	fn input_for(&self, h: HANDLE) -> io::Result<HANDLE> {
		mode(h).ok_or_else(not_a_tty)?;
		Ok(self.console.as_ref().map_or(h, |c| c.conin.get()))
	}

	/// Record the console's modes and code pages before the first change.
	fn save(&mut self, conin: Raw, conout: Raw) {
		if self.saved.is_some() {
			return;
		}
		// SAFETY: plain queries.
		let (in_cp, out_cp) = unsafe { (GetConsoleCP(), GetConsoleOutputCP()) };
		self.saved = Some(Saved {
			conin,
			conout,
			input: mode(conin.get()).unwrap_or(0),
			output: mode(conout.get()).unwrap_or(0),
			in_cp,
			out_cp,
		});
	}
}

impl Terminal for WindowsConsole {
	fn is_terminal(&self, h: OsHandle) -> bool {
		mode(h.0 as HANDLE).is_some()
	}

	fn attrs(&self, h: OsHandle) -> io::Result<Termios> {
		let input = self.input_for(h.0 as HANDLE)?;
		let m = mode(input).ok_or_else(not_a_tty)?;
		let (icrnl, inlcr) = self.console.as_ref().map_or((false, false), |c| {
			(c.icrnl.load(Ordering::Relaxed), c.inlcr.load(Ordering::Relaxed))
		});
		Ok(termios_of(m, icrnl, inlcr))
	}

	fn set_attrs(&mut self, h: OsHandle, attrs: &Termios, when: SetWhen) -> io::Result<()> {
		let input = self.input_for(h.0 as HANDLE)?;
		let base = mode(input).ok_or_else(not_a_tty)?;
		if let Some(c) = &self.console {
			let (conin, conout) = (c.conin, c.conout);
			self.save(conin, conout);
		}
		if when == SetWhen::Flush {
			// SAFETY: `input` is a console input handle.
			unsafe { FlushConsoleInputBuffer(input) };
		}
		// SAFETY: as above; the mode is built from the current one.
		if unsafe { SetConsoleMode(input, input_mode_of(attrs, base)) } == 0 {
			return Err(io::Error::last_os_error());
		}
		if let Some(c) = &self.console {
			c.icrnl.store(attrs.get(TermFlag::Icrnl), Ordering::Relaxed);
			c.inlcr.store(attrs.get(TermFlag::Inlcr), Ordering::Relaxed);
			c.isig.store(attrs.get(TermFlag::Isig), Ordering::Relaxed);
		}
		Ok(())
	}

	fn size(&self, h: OsHandle) -> io::Result<TtyInfo> {
		let mut h = h.0 as HANDLE;
		mode(h).ok_or_else(not_a_tty)?;
		// SAFETY: an all-zero CONSOLE_SCREEN_BUFFER_INFO is a valid value.
		let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
		// An input handle has no window: the shell's console output has.
		// SAFETY: GetConsoleScreenBufferInfo only writes `info`.
		if unsafe { GetConsoleScreenBufferInfo(h, &raw mut info) } == 0 {
			h = self.console.as_ref().ok_or_else(not_a_tty)?.conout.get();
			// SAFETY: as above.
			if unsafe { GetConsoleScreenBufferInfo(h, &raw mut info) } == 0 {
				return Err(io::Error::last_os_error());
			}
		}
		let w = info.srWindow;
		Ok(TtyInfo {
			cols: u16::try_from(i32::from(w.Right) - i32::from(w.Left) + 1).unwrap_or(80),
			rows: u16::try_from(i32::from(w.Bottom) - i32::from(w.Top) + 1).unwrap_or(24),
		})
	}

	fn set_size(&mut self, _h: OsHandle, _size: TtyInfo) -> io::Result<()> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn foreground(&self, h: OsHandle) -> io::Result<i32> {
		mode(h.0 as HANDLE).ok_or_else(not_a_tty)?;
		Ok(self.foreground.unwrap_or_else(|| self.process_group()))
	}

	/// Job control's record of the foreground. A job leading a console
	/// group of its own (started in the background) gets the keyboard's
	/// Ctrl-C forwarded ([`ctrl_c_forward`]); one in the shell's group gets
	/// it from the console itself.
	fn set_foreground(&mut self, h: OsHandle, pgid: i32) -> io::Result<()> {
		mode(h.0 as HANDLE).ok_or_else(not_a_tty)?;
		self.foreground = Some(pgid);
		let forward = u32::try_from(pgid)
			.ok()
			.filter(|&p| p != std::process::id() && crate::sys::spawn::has_console_groups(p))
			.unwrap_or(0);
		FORWARD_CTRL_C.store(forward, Ordering::Release);
		Ok(())
	}

	fn session(&self, _h: OsHandle) -> io::Result<i32> {
		Err(io::ErrorKind::Unsupported.into())
	}

	fn name(&self, h: OsHandle) -> io::Result<BString> {
		mode(h.0 as HANDLE).ok_or_else(not_a_tty)?;
		// `/dev/tty` opens the shell's own terminal (`print > $TTY`).
		Ok(BString::from("/dev/tty"))
	}

	/// The shell's own group: its pid (its stages lead groups of their own
	/// or stay in its group, as the spawner places them).
	fn process_group(&self) -> i32 {
		i32::try_from(std::process::id()).unwrap_or(0)
	}

	/// Nothing to move: the spawner placed every process in its console
	/// group when it created it.
	fn set_process_group(&mut self, _pid: i32, _pgid: i32) -> io::Result<()> {
		Ok(())
	}

	fn open_controlling(&mut self) -> io::Result<Option<Shtty>> {
		if let Some(c) = &self.console {
			let file = ConsoleFile { console: Arc::clone(c), pending: Vec::new(), high: None };
			return Ok(Some(Shtty { file: Box::new(file), name: BString::from("/dev/tty") }));
		}
		// zsh opens the terminal only when one is there: a process without
		// a console on its standard input (a pipe, a service) gets none.
		if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
			return Ok(None);
		}
		let Some(console) = Console::open()? else {
			return Ok(None);
		};
		self.save(console.conin, console.conout);
		// The shell writes UTF-8 and escape sequences (ZLE's display).
		// SAFETY: plain calls on the console's handles.
		unsafe {
			SetConsoleOutputCP(CP_UTF8);
			SetConsoleCP(CP_UTF8);
			if let Some(m) = mode(console.conout.get()) {
				SetConsoleMode(
					console.conout.get(),
					m | ENABLE_PROCESSED_OUTPUT
						| ENABLE_WRAP_AT_EOL_OUTPUT
						| ENABLE_VIRTUAL_TERMINAL_PROCESSING,
				);
			}
		}
		let console = Arc::new(console);
		self.console = Some(Arc::clone(&console));
		let file = ConsoleFile { console, pending: Vec::new(), high: None };
		Ok(Some(Shtty { file: Box::new(file), name: BString::from("/dev/tty") }))
	}

	fn open_pty(&mut self, _size: Option<TtyInfo>) -> io::Result<Pty> {
		Err(io::ErrorKind::Unsupported.into())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The shell's normal modes read back as they were set, and ZLE's raw
	/// modes turn line input and echo off and virtual-terminal input on
	/// (else arrows arrive as nothing ZLE can bind).
	#[test]
	fn modes_round_trip_and_raw_input_is_virtual_terminal_input() {
		let cooked = ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT;
		let t = termios_of(cooked, false, false);
		assert!(t.get(TermFlag::Icanon) && t.get(TermFlag::Echo) && t.get(TermFlag::Isig));
		assert_eq!(input_mode_of(&t, cooked), cooked);
		let mut raw = t;
		raw.set(TermFlag::Icanon, false);
		raw.set(TermFlag::Echo, false);
		let m = input_mode_of(&raw, cooked);
		assert_eq!(m, ENABLE_PROCESSED_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT);
		// Echo without line input is refused by the console: dropped.
		raw.set(TermFlag::Echo, true);
		assert_eq!(input_mode_of(&raw, cooked) & ENABLE_ECHO_INPUT, 0);
	}
}
