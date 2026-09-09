//! Process-wide terminal lifecycle, raw-mode ownership, and emergency restore.

use std::{
	fs::{File, OpenOptions},
	io::{self, Write as _},
	panic,
	sync::{
		Arc, LazyLock, Once,
		atomic::{AtomicBool, AtomicU8, AtomicU16, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use omp_core::{Str, base64, sf};
use smallvec::SmallVec;
#[cfg(windows)]
use windows_sys::Win32::System::Console::{GetConsoleOutputCP, SetConsoleOutputCP};
use xutf::IntoAnsiStripped as _;

const STDERR_CAPTURE_CAPACITY: usize = 64 * 1024;

#[derive(Default)]
struct CapturedStderr {
	bytes: Vec<u8>,
}

impl CapturedStderr {
	fn new() -> Self {
		Self { bytes: Vec::with_capacity(STDERR_CAPTURE_CAPACITY) }
	}

	fn push(&mut self, bytes: &[u8]) {
		if bytes.len() >= STDERR_CAPTURE_CAPACITY {
			self.bytes.clear();
			self
				.bytes
				.extend_from_slice(&bytes[bytes.len() - STDERR_CAPTURE_CAPACITY..]);
			return;
		}
		let overflow = self
			.bytes
			.len()
			.saturating_add(bytes.len())
			.saturating_sub(STDERR_CAPTURE_CAPACITY);
		if overflow != 0 {
			self.bytes.copy_within(overflow.., 0);
			self.bytes.truncate(self.bytes.len() - overflow);
		}
		self.bytes.extend_from_slice(bytes);
	}

	fn as_slice(&self) -> &[u8] {
		&self.bytes
	}
}

#[cfg(unix)]
mod platform {
	use std::{
		cell::UnsafeCell,
		fs::{File, OpenOptions},
		io,
		mem::MaybeUninit,
		os::fd::{AsRawFd as _, FromRawFd as _, RawFd},
		sync::atomic::{AtomicBool, AtomicI32, Ordering},
		time::{Duration, Instant},
	};

	use nix::{
		errno::Errno,
		libc,
		sys::{
			signal::{self, SaFlags, SigAction, SigHandler, SigSet, Signal},
			termios::{SetArg, Termios, cfmakeraw, tcgetattr, tcsetattr},
		},
	};

	use super::{CapturedStderr, emergency_restore_inner};
	use crate::{Size, tty::open};
	pub(super) const fn set_title(_: &str) -> io::Result<()> {
		Ok(())
	}

	static TTY_FD: AtomicI32 = AtomicI32::new(-1);
	static RAW_VALID: AtomicBool = AtomicBool::new(false);
	static SAVED_STDERR_FD: AtomicI32 = AtomicI32::new(-1);

	struct SavedTermios(UnsafeCell<MaybeUninit<libc::termios>>);

	// Only the active terminal writes this slot before publishing RAW_VALID.
	// Signal and panic handlers read it only after an acquire operation.
	// SAFETY: synchronization through RAW_VALID prevents concurrent access.
	unsafe impl Sync for SavedTermios {}

	static SIGNAL_TERMIOS: SavedTermios = SavedTermios(UnsafeCell::new(MaybeUninit::uninit()));

	pub(super) struct State {
		original: Option<Termios>,
	}
	#[must_use]
	pub(super) struct StderrGuard {
		reader:   Option<File>,
		captured: CapturedStderr,
		active:   bool,
	}

	impl StderrGuard {
		pub(super) fn new(capture: bool) -> io::Result<Self> {
			if !capture {
				return Ok(Self {
					reader:   None,
					captured: CapturedStderr::default(),
					active:   false,
				});
			}

			let mut descriptors = [-1; 2];
			// SAFETY: `descriptors` is a writable two-element buffer for `pipe`.
			if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
				return Err(io::Error::last_os_error());
			}
			let (reader, writer) = (descriptors[0], descriptors[1]);
			if let Err(error) = configure_pipe(reader, writer) {
				// SAFETY: both descriptors were returned by `pipe` and remain owned here.
				unsafe {
					libc::close(reader);
					libc::close(writer);
				}
				return Err(error);
			}
			// SAFETY: duplicating the process stderr descriptor requires no Rust aliasing.
			let saved = unsafe { libc::dup(libc::STDERR_FILENO) };
			if saved < 0 {
				let error = io::Error::last_os_error();
				// SAFETY: both descriptors were returned by `pipe` and remain owned here.
				unsafe {
					libc::close(reader);
					libc::close(writer);
				}
				return Err(error);
			}
			// SAFETY: `saved` is a valid descriptor returned by `dup`.
			let entry_backup = unsafe { libc::dup(saved) };
			if entry_backup < 0 {
				let error = io::Error::last_os_error();
				// SAFETY: all descriptors were acquired by this function and remain owned here.
				unsafe {
					libc::close(reader);
					libc::close(writer);
					libc::close(saved);
				}
				return Err(error);
			}
			for descriptor in [saved, entry_backup] {
				// SAFETY: `descriptor` is a valid descriptor acquired above.
				if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
					let error = io::Error::last_os_error();
					// SAFETY: all descriptors were acquired by this function and remain owned here.
					unsafe {
						libc::close(reader);
						libc::close(writer);
						libc::close(saved);
						libc::close(entry_backup);
					}
					return Err(error);
				}
			}

			// Publish the pre-resolved descriptor before redirecting fd 2 so a
			// fatal signal can restore it with only dup2/close.
			SAVED_STDERR_FD.store(saved, Ordering::Release);
			// SAFETY: `writer` is a valid pipe descriptor and stderr is process-owned.
			if unsafe { libc::dup2(writer, libc::STDERR_FILENO) } < 0 {
				let error = io::Error::last_os_error();
				if SAVED_STDERR_FD
					.compare_exchange(saved, -1, Ordering::AcqRel, Ordering::Acquire)
					.is_ok()
				{
					// SAFETY: `saved` is owned by this function until the atomic exchange succeeds.
					unsafe {
						libc::close(saved);
					}
				}
				// SAFETY: all descriptors were acquired by this function and remain owned here.
				unsafe {
					libc::close(reader);
					libc::close(writer);
					libc::close(entry_backup);
				}
				return Err(error);
			}
			if SAVED_STDERR_FD.load(Ordering::Acquire) != saved {
				// A crash restore raced terminal entry. It ran before the
				// redirect, so undo that redirect from our private backup.
				// SAFETY: `entry_backup`, reader, and writer remain owned by this function.
				unsafe {
					libc::dup2(entry_backup, libc::STDERR_FILENO);
					libc::close(reader);
					libc::close(writer);
					libc::close(entry_backup);
				}
				return Err(io::Error::new(
					io::ErrorKind::Interrupted,
					"stderr capture interrupted by emergency restore",
				));
			}
			// SAFETY: these descriptors remain owned by this function after redirection.
			unsafe {
				libc::close(writer);
				libc::close(entry_backup);
			}
			Ok(Self {
				// SAFETY: `reader` is the uniquely owned pipe descriptor.
				reader:   Some(unsafe { File::from_raw_fd(reader) }),
				captured: CapturedStderr::new(),
				active:   true,
			})
		}

		pub(super) fn drain(&mut self) {
			let Some(reader) = &self.reader else {
				return;
			};
			let mut chunk = [0_u8; 4096];
			loop {
				// SAFETY: `chunk` is writable for its stated length and `reader` is valid.
				let count =
					unsafe { libc::read(reader.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len()) };
				if count > 0 {
					self.captured.push(&chunk[..count as usize]);
					continue;
				}
				if count == 0 {
					break;
				}
				let error = io::Error::last_os_error();
				if error.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				break;
			}
		}

		pub(super) fn restore(&mut self) -> io::Result<()> {
			let result = if self.active {
				restore_stderr()
			} else {
				Ok(())
			};
			if result.is_ok() {
				self.active = false;
			}
			self.drain();
			result
		}

		pub(super) fn captured(&self) -> &[u8] {
			self.captured.as_slice()
		}
	}

	impl Drop for StderrGuard {
		fn drop(&mut self) {
			let _ = self.restore();
		}
	}

	fn configure_pipe(reader: RawFd, writer: RawFd) -> io::Result<()> {
		for descriptor in [reader, writer] {
			// SAFETY: `descriptor` is a valid pipe descriptor.
			if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
				return Err(io::Error::last_os_error());
			}
			// SAFETY: `descriptor` is a valid pipe descriptor.
			let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
			if flags < 0
				// SAFETY: `descriptor` is a valid pipe descriptor and `flags` came from it.
				|| unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
			{
				return Err(io::Error::last_os_error());
			}
		}
		Ok(())
	}
	fn restore_stderr() -> io::Result<()> {
		loop {
			let saved = SAVED_STDERR_FD.load(Ordering::Acquire);
			if saved < 0 {
				return Ok(());
			}
			// SAFETY: `saved` remains valid until the successful atomic exchange below.
			if unsafe { libc::dup2(saved, libc::STDERR_FILENO) } < 0 {
				let error = io::Error::last_os_error();
				if error.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				// A concurrent emergency restore closes `saved` only after it
				// has already restored fd 2.
				if SAVED_STDERR_FD.load(Ordering::Acquire) < 0 {
					return Ok(());
				}
				return Err(error);
			}
			if SAVED_STDERR_FD
				.compare_exchange(saved, -1, Ordering::AcqRel, Ordering::Acquire)
				.is_ok()
			{
				// SAFETY: the compare-exchange transfers ownership of `saved` here.
				unsafe {
					libc::close(saved);
				}
			}
			return Ok(());
		}
	}

	pub(super) fn emergency_restore_stderr() {
		let saved = SAVED_STDERR_FD.swap(-1, Ordering::AcqRel);
		if saved < 0 {
			return;
		}
		loop {
			// SAFETY: `saved` is the descriptor atomically claimed by this handler.
			if unsafe { libc::dup2(saved, libc::STDERR_FILENO) } >= 0 || errno() != libc::EINTR {
				break;
			}
		}
		// SAFETY: `saved` was atomically claimed by this handler.
		unsafe {
			libc::close(saved);
		}
	}

	pub(super) fn prepare() -> io::Result<(File, State)> {
		let tty = open(OpenOptions::new().read(true).write(true))?;
		let original = tcgetattr(&tty).map_err(errno_to_io)?;
		Ok((tty, State { original: Some(original) }))
	}

	pub(super) fn enable_raw(tty: &File, state: &State) -> io::Result<()> {
		let original = state
			.original
			.as_ref()
			.expect("prepared terminal has original mode");
		let mut signal_termios = MaybeUninit::<libc::termios>::uninit();
		// SAFETY: `signal_termios` is writable and `tty` is a valid terminal
		// descriptor.
		if unsafe { libc::tcgetattr(tty.as_raw_fd(), signal_termios.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: terminal activation is exclusive and publication follows this write.
		unsafe { (*SIGNAL_TERMIOS.0.get()).write(signal_termios.assume_init()) };
		TTY_FD.store(tty.as_raw_fd(), Ordering::Release);
		RAW_VALID.store(true, Ordering::Release);

		let mut raw = original.clone();
		cfmakeraw(&mut raw);
		if let Err(error) = tcsetattr(tty, SetArg::TCSANOW, &raw) {
			let _ = tcsetattr(tty, SetArg::TCSANOW, original);
			deactivate();
			return Err(errno_to_io(error));
		}
		Ok(())
	}

	pub(super) fn restore_raw(tty: &File, state: &mut State) -> io::Result<()> {
		let Some(original) = &state.original else {
			return Ok(());
		};
		// TCSAFLUSH: mouse-motion reports queued after the last input read
		// would otherwise echo into the shell once cooked mode returns.
		tcsetattr(tty, SetArg::TCSAFLUSH, original).map_err(errno_to_io)?;
		state.original = None;
		Ok(())
	}

	pub(super) fn size(tty: &File, _: &State) -> io::Result<Size> {
		let mut window = MaybeUninit::<libc::winsize>::zeroed();
		// SAFETY: `window` is writable and `tty` is a valid terminal descriptor.
		if unsafe { libc::ioctl(tty.as_raw_fd(), libc::TIOCGWINSZ, window.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: successful TIOCGWINSZ initializes every field of `window`.
		let window = unsafe { window.assume_init() };
		if window.ws_col == 0 || window.ws_row == 0 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "terminal reported a zero size"));
		}
		Ok(Size::new(window.ws_col, window.ws_row))
	}

	/// Input descriptor for synchronous polling: stdin in production (the
	/// terminal in normal operation), the tty handle under an `OMP_TTY`
	/// override or in tests, where stdin is never the terminal.
	fn input_fd(tty: &File) -> RawFd {
		#[cfg(not(test))]
		use crate::tty::overridden;

		#[cfg(not(test))]
		if !overridden() {
			return libc::STDIN_FILENO;
		}
		tty.as_raw_fd()
	}

	pub(super) fn drain(tty: &File, _: &State, maximum: Duration, idle: Duration) -> io::Result<()> {
		drain_fd(input_fd(tty), maximum, idle)
	}

	fn drain_fd(fd: RawFd, maximum: Duration, idle: Duration) -> io::Result<()> {
		let started = Instant::now();
		let mut last_data = started;
		let mut buffer = [0; 256];
		loop {
			let now = Instant::now();
			let wait = maximum
				.saturating_sub(now.duration_since(started))
				.min(idle.saturating_sub(now.duration_since(last_data)));
			if wait.is_zero() {
				return Ok(());
			}
			let timeout = wait.as_millis().clamp(1, i32::MAX as u128) as i32;
			let mut descriptor = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
			// SAFETY: `descriptor` is a valid writable pollfd.
			let result = unsafe { libc::poll(&mut descriptor, 1, timeout) };
			if result == 0 {
				continue;
			}
			if result < 0 {
				let error = io::Error::last_os_error();
				if error.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Err(error);
			}
			if descriptor.revents & (libc::POLLIN | libc::POLLHUP) == 0 {
				continue;
			}
			// SAFETY: `buffer` is writable for its stated length and `fd` is polled
			// readable.
			let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
			if read > 0 {
				last_data = Instant::now();
				continue;
			}
			if read == 0 {
				return Ok(());
			}
			let error = io::Error::last_os_error();
			if !matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
				return Err(error);
			}
		}
	}

	pub(super) fn install_handlers() -> Result<(), i32> {
		let fatal = SigAction::new(
			SigHandler::Handler(fatal_signal_handler),
			SaFlags::SA_RESTART,
			SigSet::empty(),
		);
		// SAFETY: handlers and actions are fully initialized and installed process-wide
		// once.
		unsafe {
			signal::sigaction(Signal::SIGINT, &fatal).map_err(|error| error as i32)?;
			signal::sigaction(Signal::SIGTERM, &fatal).map_err(|error| error as i32)?;
			signal::sigaction(Signal::SIGHUP, &fatal).map_err(|error| error as i32)?;
		}
		Ok(())
	}

	extern "C" fn fatal_signal_handler(signal_number: libc::c_int) {
		emergency_restore_inner();
		// SAFETY: restoring the default disposition then re-raising is signal-handler
		// safe.
		unsafe {
			libc::signal(signal_number, libc::SIG_DFL);
			libc::raise(signal_number);
		}
	}

	pub(super) fn emergency_restore(payloads: [&[u8]; 3]) {
		let fd = TTY_FD.load(Ordering::Acquire);
		if fd < 0 {
			return;
		}
		for payload in payloads {
			raw_write_all(fd, payload);
		}
		if RAW_VALID.swap(false, Ordering::AcqRel) {
			// SAFETY: RAW_VALID publishes initialized termios while this emergency path
			// owns restore.
			let termios = unsafe { (*SIGNAL_TERMIOS.0.get()).assume_init_ref() };
			// SAFETY: `fd` is the published active terminal descriptor.
			unsafe {
				libc::tcsetattr(fd, libc::TCSANOW, termios);
				// Unread mouse reports would echo into whatever reads the
				// terminal next; TCSANOW above keeps the crash path from
				// blocking on output drain, so flush input separately.
				libc::tcflush(fd, libc::TCIFLUSH);
			}
		}
	}

	fn raw_write_all(fd: RawFd, mut bytes: &[u8]) {
		while !bytes.is_empty() {
			// SAFETY: `bytes` is readable for its stated length and `fd` is active.
			let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
			if written > 0 {
				bytes = &bytes[written as usize..];
				continue;
			}
			if written < 0 && errno() == libc::EINTR {
				continue;
			}
			break;
		}
	}

	#[cfg(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	fn errno() -> libc::c_int {
		// SAFETY: libc supplies a valid thread-local errno pointer.
		unsafe { *libc::__error() }
	}

	#[cfg(any(target_os = "linux", target_os = "android"))]
	fn errno() -> libc::c_int {
		// SAFETY: libc supplies a valid thread-local errno pointer.
		unsafe { *libc::__errno_location() }
	}

	pub(super) fn deactivate() {
		RAW_VALID.store(false, Ordering::Release);
		TTY_FD.store(-1, Ordering::Release);
	}

	fn errno_to_io(error: Errno) -> io::Error {
		io::Error::from_raw_os_error(error as i32)
	}

	#[cfg(test)]
	pub(super) fn drain_for_test(fd: RawFd, maximum: Duration, idle: Duration) -> io::Result<()> {
		drain_fd(fd, maximum, idle)
	}

	#[cfg(test)]
	pub(super) const fn state_for_test() -> State {
		State { original: None }
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		env,
		ffi::c_void,
		fs::{File, OpenOptions, remove_file},
		io::{self, Read as _},
		mem,
		os::windows::io::AsRawHandle as _,
		path::PathBuf,
		process, ptr,
		sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, AtomicU64, Ordering},
		thread,
		time::{Duration, Instant},
	};

	use windows_sys::Win32::{
		Foundation::{FALSE, HANDLE, TRUE},
		System::Console::{
			CONSOLE_SCREEN_BUFFER_INFO, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT,
			ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode,
			GetConsoleScreenBufferInfo, GetNumberOfConsoleInputEvents, GetStdHandle, INPUT_RECORD,
			ReadConsoleInputW, STD_ERROR_HANDLE, SetConsoleCtrlHandler, SetConsoleMode,
			SetConsoleTitleW, SetStdHandle, WriteConsoleA,
		},
	};
	use xutf::IntoAnsiStripped as _;

	use super::{CapturedStderr, emergency_restore_inner};
	use crate::Size;

	pub(super) fn set_title(title: &str) -> io::Result<()> {
		let mut title = title
			.to_owned()
			.into_ansi_stripped()
			.encode_utf16()
			.filter(|unit| *unit >= 0x20 && *unit != 0x7f)
			.collect::<Vec<_>>();
		title.push(0);
		if unsafe { SetConsoleTitleW(title.as_ptr()) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}
	static INPUT_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
	static OUTPUT_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
	static INPUT_MODE: AtomicU32 = AtomicU32::new(0);
	static OUTPUT_MODE: AtomicU32 = AtomicU32::new(0);
	static MODES_VALID: AtomicBool = AtomicBool::new(false);
	static SAVED_STDERR_HANDLE: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
	static STDERR_HANDLE_VALID: AtomicBool = AtomicBool::new(false);
	static STDERR_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

	pub(super) struct State {
		_input_file:     File,
		input:           HANDLE,
		output:          HANDLE,
		original_input:  u32,
		original_output: u32,
		raw:             bool,
	}
	#[must_use]
	pub(super) struct StderrGuard {
		writer:   Option<File>,
		reader:   Option<File>,
		path:     Option<PathBuf>,
		captured: CapturedStderr,
		active:   bool,
	}

	impl StderrGuard {
		pub(super) fn new(capture: bool) -> io::Result<Self> {
			if !capture {
				return Ok(Self {
					writer:   None,
					reader:   None,
					path:     None,
					captured: CapturedStderr::default(),
					active:   false,
				});
			}
			let sequence = STDERR_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let path =
				env::temp_dir().join(format!("omp-tui-stderr-{}-{sequence}.tmp", process::id()));
			let writer = OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&path)?;
			let reader = match OpenOptions::new().read(true).open(&path) {
				Ok(reader) => reader,
				Err(error) => {
					drop(writer);
					let _ = remove_file(&path);
					return Err(error);
				},
			};
			let original = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
			SAVED_STDERR_HANDLE.store(original, Ordering::Release);
			STDERR_HANDLE_VALID.store(true, Ordering::Release);
			if unsafe { SetStdHandle(STD_ERROR_HANDLE, writer.as_raw_handle()) } == 0 {
				let error = io::Error::last_os_error();
				STDERR_HANDLE_VALID.store(false, Ordering::Release);
				SAVED_STDERR_HANDLE.store(ptr::null_mut(), Ordering::Release);
				drop(reader);
				drop(writer);
				let _ = remove_file(&path);
				return Err(error);
			}
			Ok(Self {
				writer:   Some(writer),
				reader:   Some(reader),
				path:     Some(path),
				captured: CapturedStderr::new(),
				active:   true,
			})
		}

		pub(super) fn drain(&mut self) {
			let Some(reader) = &mut self.reader else {
				return;
			};
			let mut chunk = [0_u8; 4096];
			loop {
				match reader.read(&mut chunk) {
					Ok(0) | Err(_) => break,
					Ok(count) => self.captured.push(&chunk[..count]),
				}
			}
		}

		pub(super) fn restore(&mut self) -> io::Result<()> {
			let result = if self.active {
				restore_stderr()
			} else {
				Ok(())
			};
			if result.is_ok() {
				self.active = false;
				self.writer.take();
			}
			self.drain();
			result
		}

		pub(super) fn captured(&self) -> &[u8] {
			self.captured.as_slice()
		}
	}

	impl Drop for StderrGuard {
		fn drop(&mut self) {
			let _ = self.restore();
			self.reader.take();
			if let Some(path) = self.path.take() {
				let _ = remove_file(path);
			}
		}
	}

	fn restore_stderr() -> io::Result<()> {
		if !STDERR_HANDLE_VALID.load(Ordering::Acquire) {
			return Ok(());
		}
		let original = SAVED_STDERR_HANDLE.load(Ordering::Acquire);
		if unsafe { SetStdHandle(STD_ERROR_HANDLE, original) } == 0 {
			return Err(io::Error::last_os_error());
		}
		STDERR_HANDLE_VALID.store(false, Ordering::Release);
		SAVED_STDERR_HANDLE.store(ptr::null_mut(), Ordering::Release);
		Ok(())
	}

	pub(super) fn emergency_restore_stderr() {
		if !STDERR_HANDLE_VALID.swap(false, Ordering::AcqRel) {
			return;
		}
		let original = SAVED_STDERR_HANDLE.swap(ptr::null_mut(), Ordering::AcqRel);
		unsafe {
			SetStdHandle(STD_ERROR_HANDLE, original);
		}
	}

	pub(super) fn prepare() -> io::Result<(File, State)> {
		let tty = OpenOptions::new().write(true).open("CONOUT$")?;
		let input_file = OpenOptions::new().read(true).open("CONIN$")?;
		let input = input_file.as_raw_handle();
		let output = tty.as_raw_handle();
		let mut original_input = 0;
		let mut original_output = 0;
		if unsafe { GetConsoleMode(input, &mut original_input) } == 0
			|| unsafe { GetConsoleMode(output, &mut original_output) } == 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok((tty, State {
			_input_file: input_file,
			input,
			output,
			original_input,
			original_output,
			raw: false,
		}))
	}

	pub(super) fn enable_raw(_: &File, state: &mut State) -> io::Result<()> {
		let input_mode = (state.original_input | ENABLE_VIRTUAL_TERMINAL_INPUT)
			& !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT);
		if unsafe { SetConsoleMode(state.input, input_mode) } == 0 {
			return Err(io::Error::last_os_error());
		}
		let output_mode = state.original_output | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
		if unsafe { SetConsoleMode(state.output, output_mode) } == 0 {
			let error = io::Error::last_os_error();
			let _ = unsafe { SetConsoleMode(state.input, state.original_input) };
			return Err(error);
		}
		INPUT_HANDLE.store(state.input, Ordering::Release);
		OUTPUT_HANDLE.store(state.output, Ordering::Release);
		INPUT_MODE.store(state.original_input, Ordering::Release);
		OUTPUT_MODE.store(state.original_output, Ordering::Release);
		MODES_VALID.store(true, Ordering::Release);
		state.raw = true;
		Ok(())
	}

	pub(super) fn restore_raw(_: &File, state: &mut State) -> io::Result<()> {
		if !state.raw {
			return Ok(());
		}
		let mut first = None;
		if unsafe { SetConsoleMode(state.input, state.original_input) } == 0 {
			first = Some(io::Error::last_os_error());
		}
		if unsafe { SetConsoleMode(state.output, state.original_output) } == 0 && first.is_none() {
			first = Some(io::Error::last_os_error());
		}
		if first.is_none() {
			state.raw = false;
			MODES_VALID.store(false, Ordering::Release);
		}
		first.map_or(Ok(()), Err)
	}

	pub(super) fn size(_: &File, state: &State) -> io::Result<Size> {
		let mut info = unsafe { mem::zeroed::<CONSOLE_SCREEN_BUFFER_INFO>() };
		if unsafe { GetConsoleScreenBufferInfo(state.output, &mut info) } == 0 {
			return Err(io::Error::last_os_error());
		}
		let columns = i32::from(info.srWindow.Right) - i32::from(info.srWindow.Left) + 1;
		let rows = i32::from(info.srWindow.Bottom) - i32::from(info.srWindow.Top) + 1;
		let columns = u16::try_from(columns).map_err(|_| {
			io::Error::new(io::ErrorKind::InvalidData, "console reported an invalid width")
		})?;
		let rows = u16::try_from(rows).map_err(|_| {
			io::Error::new(io::ErrorKind::InvalidData, "console reported an invalid height")
		})?;
		if columns == 0 || rows == 0 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "console reported a zero size"));
		}
		Ok(Size::new(columns, rows))
	}

	pub(super) fn drain(
		_: &File,
		state: &State,
		maximum: Duration,
		idle: Duration,
	) -> io::Result<()> {
		let started = Instant::now();
		let mut last_data = started;
		let mut records = [unsafe { mem::zeroed::<INPUT_RECORD>() }; 64];
		loop {
			let now = Instant::now();
			let wait = maximum
				.saturating_sub(now.duration_since(started))
				.min(idle.saturating_sub(now.duration_since(last_data)));
			if wait.is_zero() {
				return Ok(());
			}
			let mut available = 0;
			if unsafe { GetNumberOfConsoleInputEvents(state.input, &mut available) } == 0 {
				return Err(io::Error::last_os_error());
			}
			if available == 0 {
				thread::sleep(wait.min(Duration::from_millis(1)));
				continue;
			}
			let mut read = 0;
			let count = available.min(records.len() as u32);
			if unsafe { ReadConsoleInputW(state.input, records.as_mut_ptr(), count, &mut read) } == 0 {
				return Err(io::Error::last_os_error());
			}
			if read != 0 {
				last_data = Instant::now();
			}
		}
	}

	pub(super) fn install_handlers() -> Result<(), i32> {
		if unsafe { SetConsoleCtrlHandler(Some(console_ctrl_handler), TRUE) } == 0 {
			return Err(io::Error::last_os_error().raw_os_error().unwrap_or(1));
		}
		Ok(())
	}

	unsafe extern "system" fn console_ctrl_handler(_: u32) -> i32 {
		emergency_restore_inner();
		FALSE
	}

	pub(super) fn emergency_restore(payloads: [&[u8]; 3]) {
		if !MODES_VALID.swap(false, Ordering::AcqRel) {
			return;
		}
		let output = OUTPUT_HANDLE.load(Ordering::Acquire);
		for mut remaining in payloads {
			while !remaining.is_empty() {
				let mut written = 0;
				if unsafe {
					WriteConsoleA(
						output,
						remaining.as_ptr(),
						remaining.len().min(u32::MAX as usize) as u32,
						&mut written,
						ptr::null(),
					)
				} == 0 || written == 0
				{
					break;
				}
				remaining = &remaining[written as usize..];
			}
		}
		let input = INPUT_HANDLE.load(Ordering::Acquire);
		let _ = unsafe { SetConsoleMode(input, INPUT_MODE.load(Ordering::Acquire)) };
		let _ = unsafe { SetConsoleMode(output, OUTPUT_MODE.load(Ordering::Acquire)) };
	}

	pub(super) fn deactivate() {
		MODES_VALID.store(false, Ordering::Release);
	}
}

/// Whether any live [`Terminal`] currently holds the alternate screen.
///
/// Serves the `OMP_TUI_DEBUG` `text`/`info` ops on stream-served hosts,
/// which have no [`Terminal`] in reach, and is read by the renderer to
/// invalidate terminal-side graphics caches across buffer switches:
/// terminals with per-screen Kitty image storage (ghostty) lose
/// transmissions and placements made on the other buffer.
pub fn alt_screen_active() -> bool {
	ALT_SCREEN_ACTIVE.load(Ordering::Acquire)
}

/// Emulates a SIGWINCH delivery for the `OMP_TUI_DEBUG` `resize` op.
///
/// A harness resizing an `OMP_TTY` override device cannot reach the process
/// with a real signal, so the event is injected through the live actor.
pub fn simulate_resize_signal() {
	record_resize_signal();
	let _ = pump::send_event(TerminalEvent::Resize);
}

pub fn record_resize_signal() {
	RESIZE_GENERATION.fetch_add(1, Ordering::Relaxed);
}

use std::mem;

use flume::Receiver;

use crate::{
	InputDecoder, InputEvent, Keymap, ProbeResults, Renderer, Size, TerminalCaps, TerminalResponse,
	context::Appearance,
	debug,
	escape::esc,
	graphics::negotiate,
	notify::{Notification, notify},
	paste,
	paste::{PasteEvents, PasteProgress, Pasted},
	pump,
	pump::{Input, Pump, TerminalEvent},
};

mod resize_watch {
	use std::ops::{Deref, DerefMut};

	use tokio::sync::watch::Receiver;

	pub(super) struct ResizeWatch(pub(super) Receiver<u64>);

	impl Deref for ResizeWatch {
		type Target = Receiver<u64>;

		fn deref(&self) -> &Self::Target {
			&self.0
		}
	}

	impl DerefMut for ResizeWatch {
		fn deref_mut(&mut self) -> &mut Self::Target {
			&mut self.0
		}
	}
}

use resize_watch::ResizeWatch;

const RESIZE_DEBOUNCE: Duration = Duration::from_millis(50);
const APPEARANCE_DEBOUNCE: Duration = Duration::from_millis(100);
const OSC11_QUERY: &[u8] = esc!(background_color_query).as_bytes();
const DRAIN_IDLE: Duration = Duration::from_millis(50);
const DRAIN_MAX: Duration = Duration::from_millis(1_000);
const PROGRESS_KEEPALIVE: Duration = Duration::from_millis(1_000);
const PROGRESS_CLEAR: &[u8] = esc!(progress_clear).as_bytes();
const TITLE_PUSH: &[u8] = esc!(title_push).as_bytes();
const TITLE_POP: &[u8] = esc!(title_pop).as_bytes();
/// Fixed modes that make the terminal *send* input. Capability-gated
/// appearance and resize notification resets are appended by
/// [`compose_input_reports_off`]. Written before the teardown drain so
/// in-flight reports die there instead of echoing into the shell.
const INPUT_REPORTS_OFF: &[u8] = esc!(
	!mouse_sgr,
	!mouse_any_event,
	!mouse_button_event,
	!mouse_vt200,
	!bracketed_paste,
	!paste_events,
)
.as_bytes();
/// Click and all-motion tracking with SGR encoding — the set scoped to
/// sessions that opt into pointer interaction and to the alternate screen.
/// Matches the coding agent: `1002` (button-motion) is omitted because
/// `1003` already reports every motion, and the emergency-restore payloads
/// only reset the modes this set can leave enabled.
const MOUSE_TRACKING_ON: &[u8] = esc!(mouse_vt200, mouse_any_event, mouse_sgr).as_bytes();
const MOUSE_TRACKING_OFF: &[u8] = esc!(!mouse_sgr, !mouse_any_event, !mouse_vt200).as_bytes();
/// Composes a blind restore payload for the panic and fatal-signal handlers:
/// one shared mode-reset sequence with each variant's deltas spliced in.
/// `main` re-parks the cursor at the viewport bottom because resetting the
/// scroll margins homes it; `alt` instead leaves the alternate screen —
/// `?1049l` restores the saved main-screen cursor — and re-resets the modes
/// entering it enabled. Trailing idents name the xterm scroll-to-bottom
/// modes the session disabled and the payload must restore.
macro_rules! emergency_restore {
	(main $(, $scroll:ident)*) => {
		emergency_restore!(@compose [viewport_bottom,] [] $($scroll),*)
	};
	(alt $(, $scroll:ident)*) => {
		emergency_restore!(
			@compose [] [!alt_screen, !app_cursor_keys, !app_keypad, kitty_keyboard_pop,]
			$($scroll),*
		)
	};
	(@compose [$($park:tt)*] [$($alt_teardown:tt)*] $($scroll:ident),*) => {
		esc!(
			progress_clear,
			!sync_output,
			margins_reset,
			$($park)*
			autowrap,
			!app_cursor_keys,
			!app_keypad,
			!bracketed_paste,
			$($scroll,)*
			!paste_events,
			kitty_keyboard_pop,
			!modify_other_keys,
			!mouse_sgr,
			!mouse_any_event,
			!mouse_vt200,
			$($alt_teardown)*
			title_pop,
			cursor_visible,
		)
		.as_bytes()
	};
}
const XTERM_SCROLL_ON_OUTPUT: u8 = 1;
const XTERM_SCROLL_ON_KEY_PRESS: u8 = 2;
const ANSI_INSERT_MODE: u8 = 1;
const ANSI_NEWLINE_MODE: u8 = 2;
const APPEARANCE_NOTIFICATIONS_MODE: u8 = 1;
const IN_BAND_RESIZE_MODE: u8 = 2;
#[cfg(any(windows, test))]
const UTF8_CODEPAGE: u32 = 65001;

/// Maximum byte count passed to one Unix terminal write.
///
/// Terminal.app can stop draining after one multi-hundred-KiB PTY write;
/// bounded syscalls let the emulator consume a large history replay
/// incrementally.
#[cfg(unix)]
const MAX_TTY_WRITE_CHUNK_BYTES: usize = 16 * 1024;

#[cfg(any(windows, test))]
trait ConsoleCodepage {
	fn output_codepage(&mut self) -> u32;
	fn set_output_codepage(&mut self, codepage: u32) -> bool;
}

#[cfg(any(windows, test))]
fn ensure_console_utf8(console: &mut impl ConsoleCodepage) {
	let codepage = console.output_codepage();
	if codepage != 0 && codepage != UTF8_CODEPAGE {
		let _ = console.set_output_codepage(UTF8_CODEPAGE);
	}
}

#[cfg(windows)]
struct SystemConsoleCodepage;

#[cfg(windows)]
impl ConsoleCodepage for SystemConsoleCodepage {
	fn output_codepage(&mut self) -> u32 {
		// SAFETY: GetConsoleOutputCP has no pointer arguments or preconditions.
		unsafe { GetConsoleOutputCP() }
	}

	fn set_output_codepage(&mut self, codepage: u32) -> bool {
		// SAFETY: SetConsoleOutputCP accepts any codepage identifier; 65001 is
		// the documented UTF-8 identifier.
		unsafe { SetConsoleOutputCP(codepage) != 0 }
	}
}

/// Writes a fully materialized terminal payload, bounding individual Unix
/// writes so terminal emulators can drain large frames incrementally.
#[cfg(unix)]
pub fn terminal_write_all<W: io::Write>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
	let mut offset = 0;
	while offset < bytes.len() {
		let end = offset
			.saturating_add(MAX_TTY_WRITE_CHUNK_BYTES)
			.min(bytes.len());
		match writer.write(&bytes[offset..end]) {
			Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
			Ok(written) => offset += written,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
		}
	}
	Ok(())
}

/// Writes a fully materialized terminal payload after restoring the Windows
/// console's UTF-8 output codepage.
#[cfg(windows)]
pub fn terminal_write_all<W: io::Write>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
	ensure_console_utf8(&mut SystemConsoleCodepage);
	writer.write_all(bytes)
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static ALT_SCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);
static XTERM_SCROLL_RESTORE_MODES: AtomicU8 = AtomicU8::new(0);
static ANSI_MODE_RESTORE_MODES: AtomicU8 = AtomicU8::new(0);
static OWNED_NOTIFICATION_MODES: AtomicU8 = AtomicU8::new(0);
static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);
static HOOKS: LazyLock<Result<(), i32>> = LazyLock::new(platform::install_handlers);
static PANIC_HOOK: Once = Once::new();

/// Cursor shape requested while the terminal is owned by the application.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorStyle {
	/// Blinking block cursor.
	BlinkingBlock,
	/// Steady block cursor.
	SteadyBlock,
	/// Blinking underline cursor.
	BlinkingUnderline,
	/// Steady underline cursor.
	SteadyUnderline,
	/// Blinking bar cursor.
	BlinkingBar,
	/// Steady bar cursor.
	SteadyBar,
}

impl CursorStyle {
	const fn sequence(self) -> &'static [u8] {
		match self {
			Self::BlinkingBlock => esc!(cursor_style_blinking_block).as_bytes(),
			Self::SteadyBlock => esc!(cursor_style_steady_block).as_bytes(),
			Self::BlinkingUnderline => esc!(cursor_style_blinking_underline).as_bytes(),
			Self::SteadyUnderline => esc!(cursor_style_steady_underline).as_bytes(),
			Self::BlinkingBar => esc!(cursor_style_blinking_bar).as_bytes(),
			Self::SteadyBar => esc!(cursor_style_steady_bar).as_bytes(),
		}
	}
}
/// Why staged alternate-screen ownership is being taken
/// ([`Terminal::stage_alt_enter`]).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AltScreenUse {
	/// An interactive surface — a fullscreen scene or modal overlay — that
	/// captures the mouse while it is held.
	Interactive,
	/// A passive borrow for throwaway resize drag frames; input modes stay
	/// untouched so motion reports cannot flood the gesture.
	Resize,
}

/// OSC 9;4 taskbar progress state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Progress {
	/// Clears the terminal progress indicator.
	Clear,
	/// Reports ordinary determinate progress.
	Value(u8),
	/// Reports determinate progress in an error state.
	Error(u8),
	/// Reports progress whose completion percentage is unknown.
	Indeterminate,
	/// Reports paused determinate progress.
	Paused(u8),
}

/// Options controlling terminal entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalOptions {
	/// Capabilities resolved for the controlling terminal.
	///
	/// `None` asks [`Terminal::enter`] to negotiate capabilities while using
	/// the same decoder that the live input pump will own.
	pub caps:           Option<TerminalCaps>,
	/// Whether fd 2 is captured while the terminal owns the viewport.
	///
	/// Capturing is enabled by default. Disable it when stderr already targets
	/// an application-managed sink that must remain live during the TUI session.
	pub capture_stderr: bool,
	/// Cursor shape to use while the application owns the terminal.
	pub cursor_style:   Option<CursorStyle>,
	/// Whether inline mouse reporting is enabled for the whole session.
	///
	/// Off by default so the terminal's native text selection keeps working;
	/// the alternate screen always enables reporting while it is active.
	pub mouse:          bool,
	probe:              ProbeResults,
	probe_timeout:      Duration,
}

impl TerminalOptions {
	/// Creates options for already-resolved terminal capabilities.
	pub fn new(caps: TerminalCaps) -> Self {
		Self {
			caps:           Some(caps),
			capture_stderr: true,
			cursor_style:   None,
			mouse:          false,
			probe:          ProbeResults::default(),
			probe_timeout:  Duration::from_millis(150),
		}
	}

	/// Carries replies and preserved input from an earlier [`crate::negotiate`]
	/// call into terminal mode restoration and the live decoder.
	pub fn probe_results(mut self, probe: ProbeResults) -> Self {
		self.probe = probe;
		self
	}

	/// Sets the capability-probe deadline used when capabilities were not
	/// supplied.
	pub const fn probe_timeout(mut self, timeout: Duration) -> Self {
		self.probe_timeout = timeout;
		self
	}

	/// Requests a cursor style for the terminal session.
	pub const fn cursor_style(mut self, cursor_style: CursorStyle) -> Self {
		self.cursor_style = Some(cursor_style);
		self
	}

	/// Enables inline mouse reporting (click, drag, motion) for the session.
	///
	/// This trades native text selection for pointer interaction, so leave it
	/// off unless the application is genuinely pointer-driven.
	pub const fn mouse(mut self, mouse: bool) -> Self {
		self.mouse = mouse;
		self
	}

	/// Enables or disables capture of unmanaged stderr writes.
	pub const fn capture_stderr(mut self, capture: bool) -> Self {
		self.capture_stderr = capture;
		self
	}
}

impl Default for TerminalOptions {
	fn default() -> Self {
		Self {
			caps:           None,
			capture_stderr: true,
			cursor_style:   None,
			mouse:          false,
			probe:          ProbeResults::default(),
			probe_timeout:  Duration::from_millis(150),
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KeyboardMode {
	Kitty(&'static str),
	ModifyOtherKeys,
}

impl KeyboardMode {
	const fn enter(self) -> &'static [u8] {
		match self {
			Self::Kitty(sequence) => sequence.as_bytes(),
			Self::ModifyOtherKeys => esc!(modify_other_keys).as_bytes(),
		}
	}

	const fn leave(self) -> &'static [u8] {
		match self {
			Self::Kitty(_) => esc!(kitty_keyboard_pop).as_bytes(),
			Self::ModifyOtherKeys => esc!(!modify_other_keys).as_bytes(),
		}
	}
}

struct ProgressWorker {
	state:  Arc<AtomicU16>,
	thread: thread::JoinHandle<()>,
}

/// Owns raw mode and every terminal mode enabled for an interactive session.
///
/// Only one `Terminal` may be active in a process. Normal teardown is
/// idempotent, and panic plus fatal-signal handlers perform an allocation-free
/// blind restore when ordinary unwinding cannot run.
pub struct Terminal {
	caps: TerminalCaps,
	tty: File,
	platform: platform::State,
	stderr: platform::StderrGuard,
	keyboard: KeyboardMode,
	cursor_style: Option<CursorStyle>,
	xterm_scroll_restore_modes: u8,
	ansi_mode_restore_modes: u8,
	owned_notification_modes: u8,
	mouse: bool,
	cursor_visible: Option<bool>,
	alt_screen: bool,
	alt_mouse: bool,
	active: bool,
	inside_multiplexer: bool,
	seen_resize: u64,
	pending_resize: Option<(u64, Instant)>,
	appearance: Option<Appearance>,
	appearance_callbacks: Vec<Box<dyn FnMut(Appearance) + Send>>,
	appearance_query_generation: Arc<AtomicU64>,
	in_band_size: Option<Size>,
	keymap: Keymap,
	resize_ready: bool,
	resize_live: bool,
	events: Receiver<TerminalEvent>,
	resize_watch: ResizeWatch,
	pump: Pump,
	cell_pixel_size: Option<(u16, u16)>,
	progress: Option<ProgressWorker>,
	paste_events: PasteEvents,
	pending_paste: Option<Pasted>,
}

impl Terminal {
	/// Takes ownership of the controlling terminal and emits one
	/// capability-aware entry batch.
	#[tracing::instrument(level = "debug", name = "terminal_enter", skip_all)]
	pub fn enter(mut options: TerminalOptions) -> io::Result<Self> {
		ensure_restore_hooks()?;
		let (caps, probe) = match options.caps {
			Some(caps) => (caps, mem::take(&mut options.probe)),
			None => negotiate(options.probe_timeout),
		};
		#[cfg(unix)]
		let (mut tty, platform) = platform::prepare()?;
		#[cfg(windows)]
		let (mut tty, mut platform) = platform::prepare()?;
		if ACTIVE
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
		{
			return Err(io::Error::new(
				io::ErrorKind::AlreadyExists,
				"another Terminal already owns the controlling terminal",
			));
		}
		// Debug server thread: started here so every host kind serves
		// `OMP_TUI_DEBUG`; the socket binds before the thread spawns so a
		// bad path fails loudly.
		if let Err(error) = debug::ensure_server() {
			deactivate_emergency_state();
			return Err(error);
		}
		let stderr = match platform::StderrGuard::new(options.capture_stderr) {
			Ok(stderr) => stderr,
			Err(error) => {
				deactivate_emergency_state();
				return Err(error);
			},
		};
		#[cfg(unix)]
		let raw_result = platform::enable_raw(&tty, &platform);
		#[cfg(windows)]
		let raw_result = platform::enable_raw(&tty, &mut platform);
		if let Err(error) = raw_result {
			deactivate_emergency_state();
			return Err(error);
		}
		omp_core::logging::set_stderr_muted(true);

		let keyboard = keyboard_mode(caps.kitty_keyboard);
		let xterm_scroll_restore_modes = xterm_scroll_restore_modes(caps);
		let ansi_mode_restore_modes = ansi_mode_restore_modes(&probe);
		let owned_notification_modes = owned_notification_modes(caps, &probe);
		XTERM_SCROLL_RESTORE_MODES.store(xterm_scroll_restore_modes, Ordering::Release);
		ANSI_MODE_RESTORE_MODES.store(ansi_mode_restore_modes, Ordering::Release);
		OWNED_NOTIFICATION_MODES.store(owned_notification_modes, Ordering::Release);
		let batch = compose_enter(
			keyboard,
			options.cursor_style,
			xterm_scroll_restore_modes,
			owned_notification_modes,
			options.mouse,
			caps.paste_events,
		);
		if let Err(error) = terminal_write_all(&mut tty, &batch).and_then(|()| tty.flush()) {
			emergency_restore_inner();
			return Err(error);
		}

		let appearance = caps
			.background
			.map(|(red, green, blue)| Appearance::from_rgb16(red, green, blue));
		let mut decoder = InputDecoder::new();
		decoder.set_kitty_keyboard(matches!(keyboard, KeyboardMode::Kitty(_)));
		let keymap = decoder.keymap().clone();
		// Event actor: an async task owns the decoder, the input handle,
		// and the resize self-pipe, and publishes decoded events on the
		let channels = match Self::acquire_input()
			.and_then(|input| pump::spawn(input, decoder, &probe.preserved_input, true))
		{
			Ok(channels) => channels,
			Err(error) => {
				emergency_restore_inner();
				return Err(error);
			},
		};
		channels.pump.publish();
		Ok(Self {
			caps,
			tty,
			platform,
			stderr,
			keyboard,
			cursor_style: options.cursor_style,
			xterm_scroll_restore_modes,
			ansi_mode_restore_modes,
			owned_notification_modes,
			mouse: options.mouse,
			cursor_visible: Some(false),
			alt_screen: false,
			alt_mouse: false,
			active: true,
			inside_multiplexer: caps.inside_multiplexer,
			seen_resize: RESIZE_GENERATION.load(Ordering::Acquire),
			pending_resize: None,
			appearance,
			appearance_callbacks: Vec::new(),
			appearance_query_generation: Arc::new(AtomicU64::new(0)),
			in_band_size: None,
			keymap,
			resize_ready: false,
			resize_live: true,
			events: channels.events,
			resize_watch: ResizeWatch(channels.resize),
			pump: channels.pump,
			cell_pixel_size: caps.cell_px,
			progress: None,
			paste_events: PasteEvents::default(),
			pending_paste: None,
		})
	}

	/// Chooses the event actor's input handle.
	///
	/// Production reads stdin when it is the terminal (matching shells and
	/// multiplexers), else a fresh controlling-terminal handle — the
	/// `OMP_TTY` override device when set. Non-macOS Unix handles are
	/// readiness-pollable; macOS `/dev/tty` and Windows `CONIN$` bridge
	/// through a reader thread.
	fn acquire_input() -> io::Result<Input> {
		#[cfg(all(unix, not(target_os = "macos")))]
		{
			use crate::tty::open;
			Ok(Input::Pollable(open(OpenOptions::new().read(true))?))
		}
		#[cfg(target_os = "macos")]
		{
			use crate::tty::{open, overridden};
			// SAFETY: isatty reads only the fixed stdin descriptor.
			let stdin_is_tty = unsafe { nix::libc::isatty(nix::libc::STDIN_FILENO) } == 1;
			let input = if stdin_is_tty && !overridden() {
				// SAFETY: duplicating stdin does not affect Rust aliasing.
				let fd = unsafe { nix::libc::dup(nix::libc::STDIN_FILENO) };
				if fd < 0 {
					return Err(io::Error::last_os_error());
				}
				// SAFETY: `dup` returned a fresh descriptor owned by this file.
				unsafe {
					use std::os::fd::FromRawFd as _;
					File::from_raw_fd(fd)
				}
			} else {
				open(OpenOptions::new().read(true))?
			};
			Ok(Input::Bridged(input))
		}
		#[cfg(windows)]
		{
			Ok(Input::Bridged(OpenOptions::new().read(true).open("CONIN$")?))
		}
	}

	/// Restores every mode enabled by [`Terminal::enter`] and raw mode.
	///
	/// Keyboard enhancement, mouse reporting, and bracketed paste are disabled
	/// before input is drained, preventing late key-release or mouse-motion
	/// reports from reaching the parent shell. Calling this method more than
	/// once is harmless.
	pub fn leave(&mut self) -> io::Result<()> {
		if !self.active {
			return Ok(());
		}
		let mut first_error = None;
		// Restore fd 2 before any escape output or fallible teardown so panic
		// diagnostics and external programs immediately see the real terminal.
		record_error(self.stderr.restore(), &mut first_error);
		self
			.appearance_query_generation
			.fetch_add(1, Ordering::AcqRel);

		if self.alt_screen {
			record_error(self.leave_alt(), &mut first_error);
		}
		record_error(terminal_write_all(&mut self.tty, self.keyboard.leave()), &mut first_error);
		let input_reports_off = compose_input_reports_off(self.owned_notification_modes);
		record_error(terminal_write_all(&mut self.tty, &input_reports_off), &mut first_error);
		record_error(self.tty.flush(), &mut first_error);
		record_error(self.stop_progress(false), &mut first_error);
		// The pump thread reads the same handle; stop it before the drain
		// below so teardown owns the descriptor exclusively.
		self.pump.stop();
		record_error(
			platform::drain(&self.tty, &self.platform, DRAIN_MAX, DRAIN_IDLE),
			&mut first_error,
		);

		record_error(terminal_write_all(&mut self.tty, PROGRESS_CLEAR), &mut first_error);
		let tail = compose_leave(
			self.cursor_style.is_some(),
			self.xterm_scroll_restore_modes,
			self.ansi_mode_restore_modes,
		);
		record_error(terminal_write_all(&mut self.tty, &tail), &mut first_error);
		record_error(self.tty.flush(), &mut first_error);
		self.cursor_visible = Some(true);
		let raw_restored = match self.restore_raw() {
			Ok(()) => true,
			Err(error) => {
				record_error(Err(error), &mut first_error);
				false
			},
		};

		if raw_restored {
			self.active = false;
			deactivate_emergency_state();
			omp_core::logging::set_stderr_muted(false);
		}
		if let Some(error) = first_error {
			Err(error)
		} else {
			Ok(())
		}
	}

	/// Immediately performs the blind, async-signal-safe terminal restore.
	///
	/// This is intended for crash paths. It bypasses buffered output and writes
	/// directly to the active controlling-terminal descriptor.
	pub fn emergency_restore() {
		emergency_restore_inner();
	}

	/// Returns stderr bytes captured while this terminal owned the viewport.
	///
	/// The slice is finalized by [`Terminal::leave`]. While active it contains
	/// bytes drained by the event pump so far. Capture retains the newest 64
	/// KiB.
	pub fn captured_stderr(&self) -> &[u8] {
		self.stderr.captured()
	}

	/// Returns the capabilities resolved for this terminal session.
	pub const fn caps(&self) -> TerminalCaps {
		self.caps
	}

	/// Returns the active chord-to-key map.
	pub const fn keymap(&self) -> &Keymap {
		&self.keymap
	}

	/// Edits the chord-to-key map; changes reach the event actor's decoder
	/// before the next decoded chord.
	pub fn edit_keymap(&mut self, edit: impl FnOnce(&mut Keymap)) {
		edit(&mut self.keymap);
		self.pump.set_keymap(self.keymap.clone());
	}

	/// Enables or disables inline pointer reporting without leaving raw mode.
	///
	/// Hosts use this while a modal or fullscreen interactive surface owns
	/// focus, returning native terminal text selection when it closes.
	pub fn set_mouse(&mut self, mouse: bool) -> io::Result<()> {
		if self.mouse == mouse {
			return Ok(());
		}
		let payload = if mouse {
			MOUSE_TRACKING_ON
		} else {
			MOUSE_TRACKING_OFF
		};
		terminal_write_all(&mut self.tty, payload)?;
		self.tty.flush()?;
		self.mouse = mouse;
		Ok(())
	}

	/// Returns the controlling terminal's current cell dimensions.
	pub fn size(&self) -> io::Result<Size> {
		platform::size(&self.tty, &self.platform)
	}

	/// Waits for the next terminal event.
	///
	/// One async mailbox carries everything in arrival order: decoded input
	/// (real terminal bytes and `OMP_TUI_DEBUG` injections alike), debug
	/// queries, and closure. Resize rides a `watch` side channel and this
	/// biased select observes it before any queued input backlog; resolve
	/// the geometry with [`Terminal::take_resize`].
	///
	/// Terminal-owned debug queries (`text`, `info`, `resize`, `quit`) are
	/// answered here when dequeued — after every previously injected event —
	/// and never surface; a `quit` acknowledgement returns as `C-c` input.
	/// Retained-tree queries ([`crate::DebugOp::Frame`]/`Tree`/`Values`)
	/// surface as [`TerminalEvent::Debug`] for hosts that can answer them.
	///
	/// Terminal response events are returned like any input; forward them
	/// to [`Terminal::handle_input_event`] so appearance, geometry, and
	/// pixel-size state stay current.
	///
	/// Cancel-safe: events stay queued until returned.
	///
	/// # Errors
	///
	/// Fails once the terminal input closed.
	pub async fn next(&mut self) -> io::Result<TerminalEvent> {
		use crate::pump::TerminalEvent;
		self.stderr.drain();
		loop {
			tokio::select! {
				biased;
				changed = self.resize_watch.changed(), if self.resize_live => {
					match changed {
						Ok(()) => {
							self.resize_ready = true;
							return Ok(TerminalEvent::Resize);
						},
						// The actor is gone; the mailbox below reports why.
						Err(_) => self.resize_live = false,
					}
				},
				event = self.events.recv_async() => {
					match event {
						Ok(TerminalEvent::Resize) => {
							self.resize_ready = true;
							return Ok(TerminalEvent::Resize);
						},
						Ok(TerminalEvent::Closed) | Err(_) => {
							return Err(std::io::Error::new(
								io::ErrorKind::UnexpectedEof,
								"terminal input closed",
							));
						},
						Ok(TerminalEvent::Debug(query)) => {
							if query.op == crate::pump::DebugOp::Quit {
								crate::debug::respond_debug_query(
									query.id,
									crate::debug::terminal_response(query.op)
										.expect("quit is terminal-owned"),
								);
								return Ok(TerminalEvent::Input(InputEvent::Key(
									crate::Key::Ctrl('c'),
								)));
							}
							match crate::debug::terminal_response(query.op) {
								Some(response) => {
									crate::debug::respond_debug_query(query.id, response);
								},
								None => return Ok(TerminalEvent::Debug(query)),
							}
						},
						Ok(event) => return Ok(event),
					}
				},
			}
		}
	}

	/// Takes the latest resize notification and returns its authoritative size.
	///
	/// SIGWINCH and DEC 2048 in-band geometry share this channel. A resize is
	/// reported once; operating-system geometry wins when it is available.
	pub fn take_resize(&mut self) -> io::Result<Option<Size>> {
		if !self.resize_ready && !self.size_changed() {
			return Ok(None);
		}
		self.resize_ready = false;
		match self.size() {
			Ok(size) => Ok(Some(size)),
			Err(error) => self.in_band_size.map(Some).ok_or(error),
		}
	}

	/// Applies the latest DEC 2048 cell-pixel geometry to a renderer.
	pub fn sync_renderer<W: io::Write>(&self, renderer: &mut Renderer<W>) -> io::Result<()> {
		if let Some((width, height)) = self.cell_pixel_size {
			renderer.set_cell_pixel_size(width, height)?;
		}
		Ok(())
	}

	/// Returns the latest terminal-reported cell dimensions in pixels.
	pub const fn cell_pixel_size(&self) -> Option<(u16, u16)> {
		self.cell_pixel_size
	}

	/// Returns whether the terminal session is running inside a multiplexer.
	pub const fn inside_multiplexer(&self) -> bool {
		self.inside_multiplexer
	}

	/// Consumes a SIGWINCH-backed resize notification.
	///
	/// Multiplexers often deliver a burst of intermediate sizes; there this
	/// method returns `true` only after the observed generation has remained
	/// unchanged for 50 ms. Callers should continue polling while it returns
	/// `false` after a resize signal.
	pub fn size_changed(&mut self) -> bool {
		let generation = RESIZE_GENERATION.load(Ordering::Acquire);
		if !self.inside_multiplexer {
			if generation == self.seen_resize {
				return false;
			}
			self.seen_resize = generation;
			self.cursor_visible = None;
			return true;
		}

		let now = Instant::now();
		if generation != self.seen_resize {
			match self.pending_resize {
				Some((pending, since)) if pending == generation => {
					if now.duration_since(since) >= RESIZE_DEBOUNCE {
						self.seen_resize = generation;
						self.pending_resize = None;
						self.cursor_visible = None;
						return true;
					}
				},
				_ => self.pending_resize = Some((generation, now)),
			}
		}
		false
	}

	/// Returns the most recently classified terminal background appearance.
	pub const fn appearance(&self) -> Option<Appearance> {
		self.appearance
	}

	/// Requests a debounced OSC 11 appearance refresh.
	///
	/// Hosts use this after an explicit display reset so theme observers see
	/// the terminal's current luminance before the forced repaint.
	pub fn refresh_appearance(&self) -> io::Result<()> {
		self.debounce_appearance_query()
	}

	/// Returns the effective geometry from the latest in-band resize report.
	///
	/// The operating-system size replaces reported dimensions when they
	/// disagree.
	pub const fn in_band_size(&self) -> Option<Size> {
		self.in_band_size
	}

	/// Registers a callback for dark/light appearance flips.
	///
	/// A callback registered after initial OSC 11 detection is immediately
	/// invoked with the current appearance.
	pub fn on_appearance_change(&mut self, mut callback: impl FnMut(Appearance) + Send + 'static) {
		if let Some(appearance) = self.appearance {
			callback(appearance);
		}
		self.appearance_callbacks.push(Box::new(callback));
	}

	/// Applies a decoded terminal response to appearance and image geometry.
	///
	/// Returns `true` when the response was consumed by terminal state plumbing.
	pub fn handle_response<W: io::Write>(
		&mut self,
		response: &TerminalResponse,
		renderer: &mut Renderer<W>,
	) -> io::Result<bool> {
		let consumed = self.handle_response_state(response)?;
		self.sync_renderer(renderer)?;
		Ok(consumed)
	}

	fn handle_response_state(&mut self, response: &TerminalResponse) -> io::Result<bool> {
		// OSC replies may carry an enhanced-paste (OSC 5522) conversation
		// step; everything else falls through to the copy-friendly match.
		if let TerminalResponse::Osc(payload) = response {
			return match self.paste_events.handle_osc(payload) {
				PasteProgress::NotMine => Ok(false),
				PasteProgress::Consumed => Ok(true),
				PasteProgress::Reply(reply) => {
					terminal_write_all(&mut self.tty, reply.as_bytes())?;
					self.tty.flush()?;
					Ok(true)
				},
				PasteProgress::Done(pasted) => {
					self.pending_paste = Some(pasted);
					Ok(true)
				},
			};
		}
		match *response {
			TerminalResponse::OscColor { index: 11, r, g, b } => {
				self.set_appearance(Appearance::from_rgb16(r, g, b));
				Ok(true)
			},
			TerminalResponse::AppearanceChanged(_) => {
				self.debounce_appearance_query()?;
				Ok(true)
			},
			TerminalResponse::InBandResize { rows, cols, x_px, y_px } => {
				if rows == 0 || cols == 0 || x_px == 0 || y_px == 0 {
					return Ok(true);
				}
				let cell_width = rounded_cell_pixels(x_px, cols);
				let cell_height = rounded_cell_pixels(y_px, rows);
				self.cell_pixel_size = Some((cell_width, cell_height));
				let reported = Size::new(cols, rows);
				self.in_band_size = Some(reconcile_in_band_geometry(reported, self.size().ok()));
				self.resize_ready = true;
				Ok(true)
			},
			_ => Ok(false),
		}
	}

	/// Applies terminal-response events while leaving user input untouched.
	///
	/// Returns `true` only for a response consumed by
	/// [`Terminal::handle_response`].
	pub fn handle_input_event<W: io::Write>(
		&mut self,
		event: &InputEvent,
		renderer: &mut Renderer<W>,
	) -> io::Result<bool> {
		let InputEvent::Response(response) = event else {
			return Ok(false);
		};
		self.handle_response(response, renderer)
	}

	/// Consumes a completed OSC 5522 enhanced-paste payload.
	///
	/// Terminals supporting DEC mode 5522 (see [`TerminalCaps::paste_events`])
	/// deliver terminal-level pastes as out-of-band clipboard offers instead
	/// of bracketed paste, which is how an *image* paste reaches the
	/// application. The offer conversation runs inside
	/// [`Terminal::handle_response`]; once it completes, the assembled
	/// [`Pasted`] payload waits here for the host — mirroring
	/// [`Terminal::take_resize`].
	pub const fn take_paste(&mut self) -> Option<Pasted> {
		self.pending_paste.take()
	}

	/// Copies `text` to the system clipboard.
	///
	/// Writes OSC 52 to the terminal first (works over SSH and multiplexers
	/// that forward it), then starts a detached native write for local
	/// sessions whose terminal ignores OSC 52. The returned receiver preserves
	/// the native backend outcome for hosts that surface copy notices.
	pub fn copy_to_clipboard(
		&mut self,
		text: &str,
	) -> io::Result<tokio::sync::oneshot::Receiver<paste::ClipboardWriteOutcome>> {
		let encoded = base64::encode(text.as_bytes()).into_string();
		let mut sequence = String::with_capacity(esc!(osc, "52;c;").len() + encoded.len() + 1);
		sequence.push_str(esc!(osc, "52;c;"));
		sequence.push_str(&encoded);
		sequence.push('\x07');
		terminal_write_all(&mut self.tty, sequence.as_bytes())?;
		self.tty.flush()?;
		Ok(paste::spawn_clipboard_write(Str::new(text)))
	}

	fn set_appearance(&mut self, appearance: Appearance) {
		if self.appearance == Some(appearance) {
			return;
		}
		self.appearance = Some(appearance);
		for callback in &mut self.appearance_callbacks {
			callback(appearance);
		}
	}

	fn debounce_appearance_query(&self) -> io::Result<()> {
		let generation = self
			.appearance_query_generation
			.fetch_add(1, Ordering::AcqRel)
			.wrapping_add(1);
		let observed = Arc::clone(&self.appearance_query_generation);
		let mut tty = self.tty.try_clone()?;
		thread::Builder::new()
			.name("omp-terminal-appearance".into())
			.spawn(move || {
				thread::sleep(APPEARANCE_DEBOUNCE);
				if observed.load(Ordering::Acquire) == generation && ACTIVE.load(Ordering::Acquire) {
					let _ = terminal_write_all(&mut tty, OSC11_QUERY).and_then(|()| tty.flush());
				}
			})?;
		Ok(())
	}

	/// Enters the alternate screen and re-pushes screen-local Kitty keyboard
	/// flags. Repeated calls are deduplicated.
	pub fn enter_alt(&mut self) -> io::Result<()> {
		if self.alt_screen {
			return Ok(());
		}
		let mut batch = SmallVec::<u8, 64>::new();
		batch.extend_from_slice(esc!(alt_screen).as_bytes());
		if let KeyboardMode::Kitty(sequence) = self.keyboard {
			batch.extend_from_slice(sequence.as_bytes());
		}
		batch.extend_from_slice(esc!(!cursor_visible, !autowrap, !origin, margins_reset).as_bytes());
		if !self.mouse {
			// Fullscreen overlays get pointer interaction even when the inline
			// session leaves the mouse to native text selection.
			batch.extend_from_slice(MOUSE_TRACKING_ON);
		}
		terminal_write_all(&mut self.tty, &batch)?;
		self.tty.flush()?;
		self.alt_screen = true;
		self.alt_mouse = !self.mouse;
		ALT_SCREEN_ACTIVE.store(true, Ordering::Release);
		self.cursor_visible = Some(false);
		Ok(())
	}

	/// Pops screen-local Kitty keyboard flags and leaves the alternate screen.
	/// Repeated calls are deduplicated.
	pub fn leave_alt(&mut self) -> io::Result<()> {
		if !self.alt_screen {
			return Ok(());
		}
		let mut batch = SmallVec::<u8, 48>::new();
		if mem::take(&mut self.alt_mouse) {
			batch.extend_from_slice(MOUSE_TRACKING_OFF);
		}
		if matches!(self.keyboard, KeyboardMode::Kitty(_)) {
			batch.extend_from_slice(esc!(kitty_keyboard_pop).as_bytes());
		}
		batch.extend_from_slice(esc!(!alt_screen).as_bytes());
		terminal_write_all(&mut self.tty, &batch)?;
		self.tty.flush()?;
		self.alt_screen = false;
		ALT_SCREEN_ACTIVE.store(false, Ordering::Release);
		self.cursor_visible = None;
		Ok(())
	}

	/// Runs an operation while the alternate screen is active, restoring the
	/// main screen even when the operation returns an error.
	pub fn with_alt_screen<T>(
		&mut self,
		operation: impl FnOnce(&mut Self) -> io::Result<T>,
	) -> io::Result<T> {
		self.enter_alt()?;
		let result = operation(self);
		let leave = self.leave_alt();
		match (result, leave) {
			(Err(error), _) => Err(error),
			(Ok(_), Err(error)) => Err(error),
			(Ok(value), Ok(())) => Ok(value),
		}
	}

	/// Flips alternate-screen bookkeeping on and returns the entry sequence —
	/// buffer switch, screen-local Kitty flag push, and, for an
	/// [`AltScreenUse::Interactive`] hold in an inline-mouse-off session,
	/// mouse tracking — for the caller to embed at the head of its next
	/// synchronized paint, keeping the switch atomic with the first frame
	/// drawn there. `None` when the alternate screen is already active.
	///
	/// [`Renderer::repaint`](crate::Renderer::repaint) accepts the sequence
	/// as its leading prefix. A passive
	/// [`AltScreenUse::Resize`] borrow never touches mouse modes: motion
	/// reports would flood input mid-drag. Teardown and emergency restore
	/// treat the alternate screen as active immediately, so the sequence
	/// must reach the terminal promptly.
	pub fn stage_alt_enter(&mut self, purpose: AltScreenUse) -> Option<Str> {
		if self.alt_screen {
			// Ownership transfer on the active screen: upgrading a passive
			// borrow to an interactive hold — an overlay opening mid-drag —
			// enables the mouse capture the hold contract promises.
			if purpose == AltScreenUse::Interactive && !self.alt_mouse && !self.mouse {
				self.alt_mouse = true;
				return Some(sf!(esc!(mouse_vt200, mouse_any_event, mouse_sgr)));
			}
			return None;
		}
		self.alt_screen = true;
		ALT_SCREEN_ACTIVE.store(true, Ordering::Release);
		self.cursor_visible = None;
		self.alt_mouse = purpose == AltScreenUse::Interactive && !self.mouse;
		Some(match (self.keyboard, self.alt_mouse) {
			(KeyboardMode::Kitty(esc!(csi, ">1u")), true) => {
				sf!(esc!(alt_screen, csi, ">1u", mouse_vt200, mouse_any_event, mouse_sgr))
			},
			(KeyboardMode::Kitty(esc!(csi, ">3u")), true) => {
				sf!(esc!(alt_screen, csi, ">3u", mouse_vt200, mouse_any_event, mouse_sgr))
			},
			(KeyboardMode::Kitty(esc!(csi, ">5u")), true) => {
				sf!(esc!(alt_screen, csi, ">5u", mouse_vt200, mouse_any_event, mouse_sgr))
			},
			(KeyboardMode::Kitty(_), true) => {
				sf!(esc!(alt_screen, csi, ">7u", mouse_vt200, mouse_any_event, mouse_sgr))
			},
			(KeyboardMode::Kitty(esc!(csi, ">1u")), false) => {
				sf!(esc!(alt_screen, csi, ">1u"))
			},
			(KeyboardMode::Kitty(esc!(csi, ">3u")), false) => {
				sf!(esc!(alt_screen, csi, ">3u"))
			},
			(KeyboardMode::Kitty(esc!(csi, ">5u")), false) => {
				sf!(esc!(alt_screen, csi, ">5u"))
			},
			(KeyboardMode::Kitty(_), false) => sf!(esc!(alt_screen, csi, ">7u")),
			(KeyboardMode::ModifyOtherKeys, true) => {
				sf!(esc!(alt_screen, mouse_vt200, mouse_any_event, mouse_sgr))
			},
			(KeyboardMode::ModifyOtherKeys, false) => sf!(esc!(alt_screen)),
		})
	}

	/// Returns the staged exit sequence without changing bookkeeping.
	///
	/// The caller must deliver and flush this prefix with the main-screen
	/// repaint, then call [`Terminal::commit_alt_leave`]. Keeping ownership
	/// live until that commit lets [`Drop`] recover when the repaint fails.
	pub const fn stage_alt_leave(&self) -> Option<&'static str> {
		if !self.alt_screen {
			return None;
		}
		Some(match (self.keyboard, self.alt_mouse) {
			(KeyboardMode::Kitty(_), true) => {
				esc!(!mouse_sgr, !mouse_any_event, !mouse_vt200, kitty_keyboard_pop, !alt_screen)
			},
			(KeyboardMode::Kitty(_), false) => esc!(kitty_keyboard_pop, !alt_screen),
			(KeyboardMode::ModifyOtherKeys, true) => {
				esc!(!mouse_sgr, !mouse_any_event, !mouse_vt200, !alt_screen)
			},
			(KeyboardMode::ModifyOtherKeys, false) => esc!(!alt_screen),
		})
	}

	/// Commits a successfully delivered [`Terminal::stage_alt_leave`] prefix.
	pub fn commit_alt_leave(&mut self) {
		if !self.alt_screen {
			return;
		}
		self.alt_screen = false;
		ALT_SCREEN_ACTIVE.store(false, Ordering::Release);
		self.cursor_visible = None;
		self.alt_mouse = false;
	}

	/// Hides the cursor unless its tracked state is already hidden.
	pub fn hide_cursor(&mut self) -> io::Result<()> {
		if self.cursor_visible == Some(false) {
			return Ok(());
		}
		terminal_write_all(&mut self.tty, esc!(!cursor_visible).as_bytes())?;
		self.tty.flush()?;
		self.cursor_visible = Some(false);
		Ok(())
	}

	/// Shows the cursor unless its tracked state is already visible.
	pub fn show_cursor(&mut self) -> io::Result<()> {
		if self.cursor_visible == Some(true) {
			return Ok(());
		}
		terminal_write_all(&mut self.tty, esc!(cursor_visible).as_bytes())?;
		self.tty.flush()?;
		self.cursor_visible = Some(true);
		Ok(())
	}

	/// Sets both the terminal window title and icon name with OSC 0.
	///
	/// Control characters are removed so untrusted text cannot terminate the OSC
	/// or inject another terminal command. Entry pushes the previous title with
	/// XTGETTITLE's title-stack operation and teardown pops it; terminals
	/// without a title stack safely ignore those operations.
	pub fn set_title(&mut self, title: &str) -> io::Result<()> {
		let sequence = compose_title(title);
		platform::set_title(title)?;
		terminal_write_all(&mut self.tty, &sequence)?;
		self.tty.flush()
	}

	/// Delivers one structured attention notification through the negotiated
	/// terminal protocol and platform fallback.
	pub fn notify(&mut self, notification: &Notification) -> io::Result<()> {
		notify(&mut self.tty, &self.caps, notification)?;
		self.tty.flush()
	}

	/// Updates the host's OSC 9;4 progress indicator.
	///
	/// Percentages are clamped to `0..=100`. Every non-clear state is refreshed
	/// once per second for terminals that expire stale indicators.
	pub fn set_progress(&mut self, progress: Progress) -> io::Result<()> {
		if progress == Progress::Clear {
			return self.stop_progress(true);
		}
		let state = progress_state(progress);
		if let Some(worker) = &self.progress {
			worker.state.store(state, Ordering::Release);
			let sequence = compose_progress(state);
			terminal_write_all(&mut self.tty, &sequence)?;
			return self.tty.flush();
		}
		let sequence = compose_progress(state);
		terminal_write_all(&mut self.tty, &sequence)?;
		self.tty.flush()?;

		let state = Arc::new(AtomicU16::new(state));
		let worker_state = Arc::clone(&state);
		let mut tty = self.tty.try_clone()?;
		let worker = thread::Builder::new()
			.name("omp-terminal-progress".into())
			.spawn(move || {
				loop {
					thread::park_timeout(PROGRESS_KEEPALIVE);
					let current = worker_state.load(Ordering::Acquire);
					if current == 0 || !ACTIVE.load(Ordering::Acquire) {
						break;
					}
					let sequence = compose_progress(current);
					let _ = terminal_write_all(&mut tty, &sequence).and_then(|()| tty.flush());
				}
			})?;
		self.progress = Some(ProgressWorker { state, thread: worker });
		Ok(())
	}

	fn stop_progress(&mut self, emit_clear: bool) -> io::Result<()> {
		if let Some(worker) = self.progress.take() {
			worker.state.store(0, Ordering::Release);
			worker.thread.thread().unpark();
			let _ = worker.thread.join();
		}
		if emit_clear {
			terminal_write_all(&mut self.tty, PROGRESS_CLEAR)?;
			self.tty.flush()?;
		}
		Ok(())
	}

	fn restore_raw(&mut self) -> io::Result<()> {
		platform::restore_raw(&self.tty, &mut self.platform)
	}
}
fn rounded_cell_pixels(pixels: u16, cells: u16) -> u16 {
	let rounded = (u32::from(pixels) + u32::from(cells) / 2) / u32::from(cells);
	u16::try_from(rounded.max(1)).unwrap_or(u16::MAX)
}

fn reconcile_in_band_geometry(reported: Size, os: Option<Size>) -> Size {
	match os {
		Some(os) if os != reported => os,
		_ => reported,
	}
}

impl Drop for Terminal {
	fn drop(&mut self) {
		if self.leave().is_err() {
			emergency_restore_inner();
		}
	}
}

const fn keyboard_mode(reported: Option<u8>) -> KeyboardMode {
	match reported {
		Some(flags) if flags & 0b0000_0001 != 0 => {
			if flags & 0b0000_0010 != 0 {
				KeyboardMode::Kitty(esc!(csi, ">3u"))
			} else {
				KeyboardMode::Kitty(esc!(csi, ">1u"))
			}
		},
		Some(flags) if flags & 0b0000_0010 != 0 => KeyboardMode::Kitty(esc!(csi, ">7u")),
		Some(_) => KeyboardMode::Kitty(esc!(csi, ">5u")),
		None => KeyboardMode::ModifyOtherKeys,
	}
}

fn xterm_scroll_restore_modes(caps: TerminalCaps) -> u8 {
	(u8::from(caps.xterm_scroll_to_bottom_on_output) * XTERM_SCROLL_ON_OUTPUT)
		| (u8::from(caps.xterm_scroll_to_bottom_on_key_press) * XTERM_SCROLL_ON_KEY_PRESS)
}

fn ansi_mode_restore_modes(probe: &ProbeResults) -> u8 {
	(u8::from(probe.insert_mode_set) * ANSI_INSERT_MODE)
		| (u8::from(probe.newline_mode_set) * ANSI_NEWLINE_MODE)
}

fn owned_notification_modes(caps: TerminalCaps, probe: &ProbeResults) -> u8 {
	(u8::from(caps.appearance_notifications && !probe.appearance_notifications_set)
		* APPEARANCE_NOTIFICATIONS_MODE)
		| (u8::from(caps.in_band_resize && !probe.in_band_resize_set) * IN_BAND_RESIZE_MODE)
}

fn compose_input_reports_off(owned_notification_modes: u8) -> SmallVec<u8, 96> {
	let mut batch = SmallVec::new();
	batch.extend_from_slice(INPUT_REPORTS_OFF);
	if owned_notification_modes & APPEARANCE_NOTIFICATIONS_MODE != 0 {
		batch.extend_from_slice(esc!(!appearance_notifications).as_bytes());
	}
	if owned_notification_modes & IN_BAND_RESIZE_MODE != 0 {
		batch.extend_from_slice(esc!(!in_band_resize).as_bytes());
	}
	batch
}

fn compose_enter(
	keyboard: KeyboardMode,
	cursor_style: Option<CursorStyle>,
	xterm_scroll_restore_modes: u8,
	owned_notification_modes: u8,
	mouse: bool,
	paste_events: bool,
) -> SmallVec<u8, 160> {
	let mut batch = SmallVec::new();
	batch.extend_from_slice(TITLE_PUSH);
	batch.extend_from_slice(esc!(!insert_mode, !newline_mode).as_bytes());
	batch.extend_from_slice(esc!(!cursor_visible).as_bytes());
	if xterm_scroll_restore_modes & XTERM_SCROLL_ON_OUTPUT != 0 {
		batch.extend_from_slice(esc!(!scroll_on_output).as_bytes());
	}
	if xterm_scroll_restore_modes & XTERM_SCROLL_ON_KEY_PRESS != 0 {
		batch.extend_from_slice(esc!(!scroll_on_key_press).as_bytes());
	}
	if let Some(style) = cursor_style {
		batch.extend_from_slice(style.sequence());
	}
	batch.extend_from_slice(
		esc!(!autowrap, !origin, margins_reset, !app_cursor_keys, !app_keypad, bracketed_paste)
			.as_bytes(),
	);
	if owned_notification_modes & APPEARANCE_NOTIFICATIONS_MODE != 0 {
		batch.extend_from_slice(esc!(appearance_notifications).as_bytes());
	}
	if owned_notification_modes & IN_BAND_RESIZE_MODE != 0 {
		batch.extend_from_slice(esc!(in_band_resize).as_bytes());
	}
	if paste_events {
		batch.extend_from_slice(esc!(paste_events).as_bytes());
	}
	if mouse {
		batch.extend_from_slice(MOUSE_TRACKING_ON);
	}
	batch.extend_from_slice(keyboard.enter());
	batch
}

fn compose_leave(
	reset_cursor_style: bool,
	xterm_scroll_restore_modes: u8,
	ansi_mode_restore_modes: u8,
) -> SmallVec<u8, 160> {
	let mut batch = SmallVec::new();
	batch.extend_from_slice(esc!(!sync_output).as_bytes());
	if xterm_scroll_restore_modes & XTERM_SCROLL_ON_OUTPUT != 0 {
		batch.extend_from_slice(esc!(scroll_on_output).as_bytes());
	}
	if xterm_scroll_restore_modes & XTERM_SCROLL_ON_KEY_PRESS != 0 {
		batch.extend_from_slice(esc!(scroll_on_key_press).as_bytes());
	}
	batch.extend_from_slice(
		esc!(
			autowrap,
			!app_cursor_keys,
			!app_keypad,
			style_reset,
			!origin,
			margins_reset,
			viewport_newline,
		)
		.as_bytes(),
	);
	if reset_cursor_style {
		batch.extend_from_slice(esc!(cursor_style_default).as_bytes());
	}
	batch.extend_from_slice(TITLE_POP);
	batch.extend_from_slice(esc!(cursor_visible).as_bytes());
	if ansi_mode_restore_modes & ANSI_INSERT_MODE != 0 {
		batch.extend_from_slice(esc!(insert_mode).as_bytes());
	}
	if ansi_mode_restore_modes & ANSI_NEWLINE_MODE != 0 {
		batch.extend_from_slice(esc!(newline_mode).as_bytes());
	}
	batch
}

fn compose_title(title: &str) -> SmallVec<u8, 128> {
	let mut sequence = SmallVec::new();
	sequence.extend_from_slice(esc!(osc, "0;").as_bytes());
	for character in title
		.to_owned()
		.into_ansi_stripped()
		.chars()
		.filter(|character| !character.is_control())
	{
		let mut bytes = [0; 4];
		sequence.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
	}
	sequence.extend_from_slice(esc!(bel).as_bytes());
	sequence
}

fn progress_state(progress: Progress) -> u16 {
	match progress {
		Progress::Clear => 0,
		Progress::Value(percent) => 0x100 | u16::from(percent.min(100)),
		Progress::Error(percent) => 0x200 | u16::from(percent.min(100)),
		Progress::Indeterminate => 0x300,
		Progress::Paused(percent) => 0x400 | u16::from(percent.min(100)),
	}
}

fn compose_progress(state: u16) -> SmallVec<u8, 24> {
	let mut sequence = SmallVec::new();
	let status = state >> 8;
	if status == 0 {
		sequence.extend_from_slice(PROGRESS_CLEAR);
		return sequence;
	}
	sequence.extend_from_slice(esc!(osc, "9;4;").as_bytes());
	sequence.push(b'0' + u8::try_from(status).unwrap_or(0));
	if status != 3 {
		sequence.push(b';');
		push_decimal(&mut sequence, state & 0xff);
	}
	sequence.extend_from_slice(esc!(bel).as_bytes());
	sequence
}

fn push_decimal(sequence: &mut SmallVec<u8, 24>, value: u16) {
	if value >= 100 {
		sequence.extend_from_slice(b"100");
	} else if value >= 10 {
		sequence.push(b'0' + u8::try_from(value / 10).unwrap_or(0));
		sequence.push(b'0' + u8::try_from(value % 10).unwrap_or(0));
	} else {
		sequence.push(b'0' + u8::try_from(value).unwrap_or(0));
	}
}

fn record_error(result: io::Result<()>, first: &mut Option<io::Error>) {
	if let Err(error) = result
		&& first.is_none()
	{
		*first = Some(error);
	}
}

fn ensure_restore_hooks() -> io::Result<()> {
	let result = &*HOOKS;
	if let Err(code) = result {
		return Err(io::Error::from_raw_os_error(*code));
	}
	PANIC_HOOK.call_once(|| {
		let previous = panic::take_hook();
		panic::set_hook(Box::new(move |information| {
			emergency_restore_inner();
			previous(information);
		}));
	});
	Ok(())
}

fn emergency_restore_inner() {
	// This must precede every other crash-path operation: panic reporting uses
	// fd 2, and Unix restoration is only an atomic swap plus dup2/close.
	platform::emergency_restore_stderr();
	omp_core::logging::set_stderr_muted(false);
	if !ACTIVE.swap(false, Ordering::AcqRel) {
		return;
	}
	let alt_screen = ALT_SCREEN_ACTIVE.swap(false, Ordering::AcqRel);
	let xterm_scroll_restore_modes = XTERM_SCROLL_RESTORE_MODES.swap(0, Ordering::AcqRel);
	let ansi_mode_restore_modes = ANSI_MODE_RESTORE_MODES.swap(0, Ordering::AcqRel);
	let owned_notification_modes = OWNED_NOTIFICATION_MODES.swap(0, Ordering::AcqRel);
	let payloads = [
		notification_modes_off_payload(owned_notification_modes),
		emergency_restore_payload(alt_screen, xterm_scroll_restore_modes),
		ansi_mode_restore_payload(ansi_mode_restore_modes),
	];
	platform::emergency_restore(payloads);
}

const fn notification_modes_off_payload(modes: u8) -> &'static [u8] {
	match modes & (APPEARANCE_NOTIFICATIONS_MODE | IN_BAND_RESIZE_MODE) {
		0 => b"",
		APPEARANCE_NOTIFICATIONS_MODE => esc!(!appearance_notifications).as_bytes(),
		IN_BAND_RESIZE_MODE => esc!(!in_band_resize).as_bytes(),
		_ => esc!(!appearance_notifications, !in_band_resize).as_bytes(),
	}
}

const fn ansi_mode_restore_payload(modes: u8) -> &'static [u8] {
	match modes & (ANSI_INSERT_MODE | ANSI_NEWLINE_MODE) {
		0 => b"",
		ANSI_INSERT_MODE => esc!(insert_mode).as_bytes(),
		ANSI_NEWLINE_MODE => esc!(newline_mode).as_bytes(),
		_ => esc!(insert_mode, newline_mode).as_bytes(),
	}
}

const fn emergency_restore_payload(
	alt_screen: bool,
	xterm_scroll_restore_modes: u8,
) -> &'static [u8] {
	match (alt_screen, xterm_scroll_restore_modes & 0b0000_0011) {
		(false, 0) => emergency_restore!(main),
		(false, XTERM_SCROLL_ON_OUTPUT) => emergency_restore!(main, scroll_on_output),
		(false, XTERM_SCROLL_ON_KEY_PRESS) => emergency_restore!(main, scroll_on_key_press),
		(false, _) => emergency_restore!(main, scroll_on_output, scroll_on_key_press),
		(true, 0) => emergency_restore!(alt),
		(true, XTERM_SCROLL_ON_OUTPUT) => emergency_restore!(alt, scroll_on_output),
		(true, XTERM_SCROLL_ON_KEY_PRESS) => emergency_restore!(alt, scroll_on_key_press),
		(true, _) => emergency_restore!(alt, scroll_on_output, scroll_on_key_press),
	}
}

fn deactivate_emergency_state() {
	ACTIVE.store(false, Ordering::Release);
	ALT_SCREEN_ACTIVE.store(false, Ordering::Release);
	XTERM_SCROLL_RESTORE_MODES.store(0, Ordering::Release);
	ANSI_MODE_RESTORE_MODES.store(0, Ordering::Release);
	OWNED_NOTIFICATION_MODES.store(0, Ordering::Release);
	platform::deactivate();
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		env,
		fs::{self, File, OpenOptions},
		io,
		mem::MaybeUninit,
		os::fd::AsRawFd as _,
		process::{self, Command, Output},
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
		thread,
		time::{Duration, Instant},
	};

	use nix::{
		libc,
		pty::{Winsize, openpty},
		sys::termios::{SetArg, cfmakeraw, tcgetattr, tcsetattr},
		unistd::{pipe, read, write},
	};
	use parking_lot::Mutex;

	use super::{
		ACTIVE, ALT_SCREEN_ACTIVE, ANSI_INSERT_MODE, ANSI_NEWLINE_MODE,
		APPEARANCE_NOTIFICATIONS_MODE, AltScreenUse, ConsoleCodepage, CursorStyle,
		IN_BAND_RESIZE_MODE, INPUT_REPORTS_OFF, KeyboardMode, MAX_TTY_WRITE_CHUNK_BYTES,
		MOUSE_TRACKING_ON, OSC11_QUERY, Progress, RESIZE_GENERATION, ResizeWatch, TITLE_POP,
		TITLE_PUSH, Terminal, UTF8_CODEPAGE, XTERM_SCROLL_ON_KEY_PRESS, XTERM_SCROLL_ON_OUTPUT,
		ansi_mode_restore_modes, ansi_mode_restore_payload, base64, compose_enter,
		compose_input_reports_off, compose_leave, compose_progress, compose_title,
		emergency_restore_payload, ensure_console_utf8, ensure_restore_hooks, keyboard_mode,
		notification_modes_off_payload, owned_notification_modes, platform, progress_state,
		reconcile_in_band_geometry, rounded_cell_pixels, terminal_write_all,
	};
	use crate::{
		Appearance, InputDecoder, InputEvent, Key, Keymap, Mods, Mouse, MouseButton, MouseReport,
		ProbeResults, Renderer, Size, TerminalResponse, detect,
		escape::esc,
		paste::{PasteEvents, Pasted},
		pump::{Input, TerminalEvent, spawn},
	};

	fn contains(haystack: &[u8], needle: &[u8]) -> bool {
		haystack
			.windows(needle.len())
			.any(|window| window == needle)
	}

	/// One unframed OSC 5522 packet as the decoder would deliver it.
	fn osc(body: &str) -> InputEvent {
		InputEvent::Response(TerminalResponse::Osc(body.into()))
	}

	#[tokio::test]
	async fn enhanced_paste_offer_replies_and_stages_the_payload() {
		let dir = env::temp_dir().join(format!("omp-tui-5522-{}", process::id()));
		fs::create_dir_all(&dir).expect("temp dir");
		let path = dir.join("tty");
		fs::write(&path, b"").expect("tty file");
		let tty = OpenOptions::new()
			.read(true)
			.write(true)
			.open(&path)
			.expect("tty opens");
		let mut terminal = test_terminal(tty);
		let mut renderer = Renderer::new(Vec::new());
		let mime = base64::encode(b"text/plain").into_string();

		// Unrelated OSC replies stay application input.
		assert!(
			!terminal
				.handle_input_event(&osc("52;c;?"), &mut renderer)
				.expect("io ok")
		);
		// Offer: OK opens the listing, DATA names text/plain, DONE elicits
		// the read request instead of completing a paste.
		for body in [
			"5522;type=read:status=OK:pw=123".to_owned(),
			format!("5522;type=read:status=DATA:mime={mime}"),
			"5522;type=read:status=DONE".to_owned(),
		] {
			assert!(
				terminal
					.handle_input_event(&osc(&body), &mut renderer)
					.expect("io ok")
			);
		}
		assert!(terminal.take_paste().is_none(), "listing DONE only requests the payload");
		let request = fs::read_to_string(&path).expect("request written");
		assert!(request.contains("pw=123"), "read request echoes the grant: {request:?}");
		assert!(request.contains(&mime));

		// Payload chunk + DONE completes the paste.
		let chunk = base64::encode(b"hello").into_string();
		for body in [
			format!("5522;type=read:status=DATA:mime={mime};{chunk}"),
			"5522;type=read:status=DONE".to_owned(),
		] {
			assert!(
				terminal
					.handle_input_event(&osc(&body), &mut renderer)
					.expect("io ok")
			);
		}
		assert_eq!(terminal.take_paste(), Some(Pasted::Text("hello".into())));
		fs::remove_dir_all(&dir).ok();
	}

	#[derive(Default)]
	struct MockCodepage {
		current: u32,
		sets:    Vec<u32>,
	}

	impl ConsoleCodepage for MockCodepage {
		fn output_codepage(&mut self) -> u32 {
			self.current
		}

		fn set_output_codepage(&mut self, codepage: u32) -> bool {
			self.sets.push(codepage);
			self.current = codepage;
			true
		}
	}

	#[test]
	fn console_codepage_guard_only_reasserts_utf8_after_a_flip() {
		let mut utf8 = MockCodepage { current: UTF8_CODEPAGE, sets: Vec::new() };
		ensure_console_utf8(&mut utf8);
		assert!(utf8.sets.is_empty());

		let mut detached = MockCodepage::default();
		ensure_console_utf8(&mut detached);
		assert!(detached.sets.is_empty());

		let mut legacy = MockCodepage { current: 437, sets: Vec::new() };
		ensure_console_utf8(&mut legacy);
		assert_eq!(legacy.sets, [UTF8_CODEPAGE]);
		ensure_console_utf8(&mut legacy);
		assert_eq!(legacy.sets, [UTF8_CODEPAGE]);
	}

	#[derive(Default)]
	struct RecordingWriter {
		requested: Vec<usize>,
		output:    Vec<u8>,
	}

	impl io::Write for RecordingWriter {
		fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
			self.requested.push(bytes.len());
			self.output.extend_from_slice(bytes);
			Ok(bytes.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	#[test]
	fn large_terminal_payload_is_split_into_bounded_unix_writes() {
		let payload = vec![b'x'; MAX_TTY_WRITE_CHUNK_BYTES * 2 + 7];
		let mut writer = RecordingWriter::default();
		terminal_write_all(&mut writer, &payload).unwrap();
		assert_eq!(writer.requested, [MAX_TTY_WRITE_CHUNK_BYTES, MAX_TTY_WRITE_CHUNK_BYTES, 7]);
		assert_eq!(writer.output, payload);
	}

	#[test]
	fn enter_batch_selects_reported_kitty_flags_or_xterm_fallback() {
		let cases = [
			(Some(0), esc!(csi, ">5u").as_bytes()),
			(Some(1), esc!(csi, ">1u").as_bytes()),
			(Some(2), esc!(csi, ">7u").as_bytes()),
			(Some(3), esc!(csi, ">3u").as_bytes()),
			(None, esc!(modify_other_keys).as_bytes()),
		];
		// Inline sessions leave the mouse alone so native selection works;
		// opting in appends the tracking set before the keyboard mode.
		const PREFIX: &[u8] = esc!(
			title_push,
			!insert_mode,
			!newline_mode,
			!cursor_visible,
			!autowrap,
			!origin,
			margins_reset,
			!app_cursor_keys,
			!app_keypad,
			bracketed_paste,
		)
		.as_bytes();
		const PREFIX_MOUSE: &[u8] = esc!(
			title_push,
			!insert_mode,
			!newline_mode,
			!cursor_visible,
			!autowrap,
			!origin,
			margins_reset,
			!app_cursor_keys,
			!app_keypad,
			bracketed_paste,
			mouse_vt200,
			mouse_any_event,
			mouse_sgr,
		)
		.as_bytes();
		for (reported, keyboard) in cases {
			let batch = compose_enter(keyboard_mode(reported), None, 0, 0, false, false);
			assert_eq!(batch.as_slice(), [PREFIX, keyboard].concat());
			let batch = compose_enter(keyboard_mode(reported), None, 0, 0, true, false);
			assert_eq!(batch.as_slice(), [PREFIX_MOUSE, keyboard].concat());
		}
	}

	#[test]
	fn inherited_modes_drive_entry_ownership_and_restoration() {
		let mut caps = detect();
		caps.appearance_notifications = true;
		caps.in_band_resize = true;
		let probe = ProbeResults {
			insert_mode_set: true,
			newline_mode_set: true,
			appearance_notifications_set: true,
			..ProbeResults::default()
		};
		let ansi_modes = ansi_mode_restore_modes(&probe);
		let notification_modes = owned_notification_modes(caps, &probe);
		assert_eq!(ansi_modes, ANSI_INSERT_MODE | ANSI_NEWLINE_MODE);
		assert_eq!(notification_modes, IN_BAND_RESIZE_MODE);

		let keyboard = KeyboardMode::Kitty(esc!(csi, ">5u"));
		let enter = compose_enter(keyboard, None, 0, notification_modes, false, false);
		assert!(contains(&enter, esc!(!insert_mode, !newline_mode).as_bytes()));
		assert!(!contains(&enter, esc!(appearance_notifications).as_bytes()));
		assert!(contains(&enter, esc!(in_band_resize).as_bytes()));
		let leave = compose_leave(false, 0, ansi_modes);
		assert!(
			leave.ends_with(esc!(title_pop, cursor_visible, insert_mode, newline_mode).as_bytes())
		);
	}

	#[test]
	fn teardown_disables_owned_input_reports_before_drain_and_raw_restore() {
		let keyboard = KeyboardMode::Kitty(esc!(csi, ">5u")).leave();
		assert_eq!(keyboard, esc!(kitty_keyboard_pop).as_bytes());
		assert_eq!(compose_input_reports_off(0).as_slice(), INPUT_REPORTS_OFF);
		let reports_off =
			compose_input_reports_off(APPEARANCE_NOTIFICATIONS_MODE | IN_BAND_RESIZE_MODE);
		assert_eq!(
			reports_off.as_slice(),
			esc!(
				!mouse_sgr,
				!mouse_any_event,
				!mouse_button_event,
				!mouse_vt200,
				!bracketed_paste,
				!paste_events,
				!appearance_notifications,
				!in_band_resize,
			)
			.as_bytes()
		);
		let tail = compose_leave(true, 0, 0);
		assert!(tail.starts_with(esc!(!sync_output).as_bytes()));
		assert!(tail.ends_with(esc!(cursor_style_default, title_pop, cursor_visible).as_bytes()));
		// Terminal::leave flushes keyboard and report shutdown before draining,
		// then flushes this tail before restoring raw mode.
	}

	#[test]
	fn emergency_payloads_reset_every_mode_the_tracking_set_enables() {
		// A panic or fatal signal in an opted-in app restores through the
		// blind payloads, so each `?Nh` in MOUSE_TRACKING_ON needs a matching
		// `?Nl` there — otherwise tracking survives the crash and native
		// selection stays broken in the parent shell.
		for alt_screen in [false, true] {
			for modes in [
				0,
				XTERM_SCROLL_ON_OUTPUT,
				XTERM_SCROLL_ON_KEY_PRESS,
				XTERM_SCROLL_ON_OUTPUT | XTERM_SCROLL_ON_KEY_PRESS,
			] {
				let payload = emergency_restore_payload(alt_screen, modes);
				for mode in String::from_utf8_lossy(MOUSE_TRACKING_ON).split('h') {
					if mode.is_empty() {
						continue;
					}
					let reset = format!("{mode}l");
					assert!(contains(payload, reset.as_bytes()), "missing {reset:?}");
				}
			}
		}
	}

	#[test]
	fn xterm_scroll_to_bottom_modes_are_composed_in_order() {
		let keyboard = KeyboardMode::Kitty(esc!(csi, ">5u"));
		let enter_prefix = esc!(title_push, !insert_mode, !newline_mode, !cursor_visible).as_bytes();
		let enter_suffix = esc!(
			!autowrap,
			!origin,
			margins_reset,
			!app_cursor_keys,
			!app_keypad,
			bracketed_paste,
			mouse_vt200,
			mouse_any_event,
			mouse_sgr,
			csi,
			">5u",
		)
		.as_bytes();
		let leave_prefix = esc!(!sync_output).as_bytes();
		let leave_suffix = esc!(
			autowrap,
			!app_cursor_keys,
			!app_keypad,
			style_reset,
			!origin,
			margins_reset,
			viewport_newline,
			title_pop,
			cursor_visible,
		)
		.as_bytes();
		for (modes, enter_modes, leave_modes) in [
			(0, esc!().as_bytes(), esc!().as_bytes()),
			(
				XTERM_SCROLL_ON_OUTPUT,
				esc!(!scroll_on_output).as_bytes(),
				esc!(scroll_on_output).as_bytes(),
			),
			(
				XTERM_SCROLL_ON_KEY_PRESS,
				esc!(!scroll_on_key_press).as_bytes(),
				esc!(scroll_on_key_press).as_bytes(),
			),
			(
				XTERM_SCROLL_ON_OUTPUT | XTERM_SCROLL_ON_KEY_PRESS,
				esc!(!scroll_on_output, !scroll_on_key_press).as_bytes(),
				esc!(scroll_on_output, scroll_on_key_press).as_bytes(),
			),
		] {
			assert_eq!(
				compose_enter(keyboard, None, modes, 0, true, false).as_slice(),
				[enter_prefix, enter_modes, enter_suffix].concat()
			);
			assert_eq!(
				compose_leave(false, modes, 0).as_slice(),
				[leave_prefix, leave_modes, leave_suffix].concat()
			);
		}
	}

	#[test]
	fn emergency_payload_splices_deltas_in_wire_order() {
		// Flat expectations, independent of the emergency_restore! splice
		// points: a delta landing in the wrong slot fails here even though
		// every atom is correct. Wire bytes are anchored raw in escape.rs.
		assert_eq!(
			emergency_restore_payload(false, 0),
			esc!(
				progress_clear,
				!sync_output,
				margins_reset,
				viewport_bottom,
				autowrap,
				!app_cursor_keys,
				!app_keypad,
				!bracketed_paste,
				!paste_events,
				kitty_keyboard_pop,
				!modify_other_keys,
				!mouse_sgr,
				!mouse_any_event,
				!mouse_vt200,
				title_pop,
				cursor_visible,
			)
			.as_bytes()
		);
		assert_eq!(
			emergency_restore_payload(true, XTERM_SCROLL_ON_OUTPUT),
			esc!(
				progress_clear,
				!sync_output,
				margins_reset,
				autowrap,
				!app_cursor_keys,
				!app_keypad,
				!bracketed_paste,
				scroll_on_output,
				!paste_events,
				kitty_keyboard_pop,
				!modify_other_keys,
				!mouse_sgr,
				!mouse_any_event,
				!mouse_vt200,
				!alt_screen,
				!app_cursor_keys,
				!app_keypad,
				kitty_keyboard_pop,
				title_pop,
				cursor_visible,
			)
			.as_bytes()
		);
	}

	#[test]
	fn emergency_owned_mode_deltas_are_byte_exact() {
		for (modes, expected) in [
			(0, esc!().as_bytes()),
			(APPEARANCE_NOTIFICATIONS_MODE, esc!(!appearance_notifications).as_bytes()),
			(IN_BAND_RESIZE_MODE, esc!(!in_band_resize).as_bytes()),
			(
				APPEARANCE_NOTIFICATIONS_MODE | IN_BAND_RESIZE_MODE,
				esc!(!appearance_notifications, !in_band_resize).as_bytes(),
			),
		] {
			assert_eq!(notification_modes_off_payload(modes), expected);
		}
		for (modes, expected) in [
			(0, esc!().as_bytes()),
			(ANSI_INSERT_MODE, esc!(insert_mode).as_bytes()),
			(ANSI_NEWLINE_MODE, esc!(newline_mode).as_bytes()),
			(ANSI_INSERT_MODE | ANSI_NEWLINE_MODE, esc!(insert_mode, newline_mode).as_bytes()),
		] {
			assert_eq!(ansi_mode_restore_payload(modes), expected);
		}
	}

	#[test]
	fn emergency_payload_selects_only_requested_scroll_mode_restores() {
		for alt_screen in [false, true] {
			for modes in [
				0,
				XTERM_SCROLL_ON_OUTPUT,
				XTERM_SCROLL_ON_KEY_PRESS,
				XTERM_SCROLL_ON_OUTPUT | XTERM_SCROLL_ON_KEY_PRESS,
			] {
				let payload = emergency_restore_payload(alt_screen, modes);
				assert_eq!(
					contains(payload, esc!(scroll_on_output).as_bytes()),
					modes & XTERM_SCROLL_ON_OUTPUT != 0
				);
				assert_eq!(
					contains(payload, esc!(scroll_on_key_press).as_bytes()),
					modes & XTERM_SCROLL_ON_KEY_PRESS != 0
				);
				assert_eq!(contains(payload, esc!(!alt_screen).as_bytes()), alt_screen);
			}
		}
	}

	#[test]
	fn stderr_guard_captures_direct_writes_and_leave_restores_fd_2() {
		let output = run_stderr_guard_child("leave");
		assert!(output.status.success(), "{output:?}");
		let stderr = String::from_utf8_lossy(&output.stderr);
		assert!(stderr.contains("stderr-after-leave"), "{stderr:?}");
		assert!(!stderr.contains("stderr-under-guard"), "{stderr:?}");
	}

	#[test]
	fn panic_hook_restores_stderr_before_printing() {
		let output = run_stderr_guard_child("panic");
		assert!(!output.status.success(), "{output:?}");
		let stderr = String::from_utf8_lossy(&output.stderr);
		assert!(stderr.contains("panic-after-emergency-restore"), "{stderr:?}");
	}

	#[test]
	fn stderr_guard_subprocess() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.expect("test runtime builds");
		let _guard = runtime.enter();
		match env::var("OMP_TUI_STDERR_GUARD_CASE").as_deref() {
			Ok("leave") => {
				let before = stderr_stat();
				let mut terminal = test_terminal(
					OpenOptions::new()
						.read(true)
						.write(true)
						.open("/dev/null")
						.expect("/dev/null opens"),
				);
				terminal.stderr = platform::StderrGuard::new(true).expect("stderr capture engages");
				terminal.active = true;
				ACTIVE.store(true, Ordering::Release);
				raw_stderr_write(b"stderr-under-guard\n");
				terminal.leave().expect("terminal leaves");
				assert_eq!(terminal.captured_stderr(), b"stderr-under-guard\n");
				let after = stderr_stat();
				assert_eq!((after.st_dev, after.st_ino), (before.st_dev, before.st_ino));
				raw_stderr_write(b"stderr-after-leave\n");
			},
			Ok("panic") => {
				ensure_restore_hooks().expect("restore hooks install");
				let _guard = platform::StderrGuard::new(true).expect("stderr capture engages");
				ACTIVE.store(true, Ordering::Release);
				panic!("panic-after-emergency-restore");
			},
			_ => {},
		}
	}

	fn run_stderr_guard_child(case: &str) -> Output {
		Command::new(env::current_exe().expect("current test executable"))
			.args(["--exact", "terminal::tests::stderr_guard_subprocess", "--nocapture"])
			.env("OMP_TUI_STDERR_GUARD_CASE", case)
			.output()
			.expect("stderr guard subprocess runs")
	}

	fn stderr_stat() -> libc::stat {
		let mut stat = MaybeUninit::<libc::stat>::zeroed();
		// SAFETY: `stat` is writable and fstat initializes it on success.
		assert_eq!(unsafe { libc::fstat(libc::STDERR_FILENO, stat.as_mut_ptr()) }, 0);
		// SAFETY: fstat succeeded and initialized `stat`.
		unsafe { stat.assume_init() }
	}

	fn raw_stderr_write(bytes: &[u8]) {
		assert_eq!(
			// SAFETY: `bytes` is readable for its stated length and stderr is open.
			unsafe { libc::write(libc::STDERR_FILENO, bytes.as_ptr().cast(), bytes.len()) },
			bytes.len() as isize
		);
	}

	#[test]
	fn title_and_progress_sequences_are_sanitized_and_exact() {
		assert_eq!(
			compose_title(esc!("omp", osc, "2;bad", bel, " title")).as_slice(),
			esc!(osc, "0;omp title", bel).as_bytes()
		);
		assert!(
			compose_enter(KeyboardMode::Kitty(esc!(csi, ">5u")), None, 0, 0, false, false)
				.starts_with(TITLE_PUSH)
		);
		assert!(contains(&compose_leave(false, 0, 0), TITLE_POP));
		assert_eq!(
			compose_progress(progress_state(Progress::Value(42))).as_slice(),
			esc!(osc, "9;4;1;42", bel).as_bytes()
		);
		assert_eq!(
			compose_progress(progress_state(Progress::Error(150))).as_slice(),
			esc!(osc, "9;4;2;100", bel).as_bytes()
		);
		assert_eq!(
			compose_progress(progress_state(Progress::Indeterminate)).as_slice(),
			esc!(osc, "9;4;3", bel).as_bytes()
		);
		assert_eq!(
			compose_progress(progress_state(Progress::Paused(7))).as_slice(),
			esc!(osc, "9;4;4;7", bel).as_bytes()
		);
		assert_eq!(
			compose_progress(progress_state(Progress::Clear)).as_slice(),
			esc!(progress_clear).as_bytes()
		);
	}

	#[test]
	fn cursor_style_is_composed_after_cursor_hide() {
		let batch = compose_enter(
			KeyboardMode::Kitty(esc!(csi, ">5u")),
			Some(CursorStyle::BlinkingBar),
			0,
			0,
			false,
			false,
		);
		assert!(contains(&batch, esc!(!cursor_visible, cursor_style_blinking_bar).as_bytes()));
	}

	#[test]
	fn enter_batch_enables_enhanced_paste_only_when_supported() {
		let keyboard = KeyboardMode::Kitty(esc!(csi, ">5u"));
		let without = compose_enter(keyboard, None, 0, 0, false, false);
		assert!(!contains(&without, esc!(paste_events).as_bytes()));
		let with = compose_enter(keyboard, None, 0, 0, false, true);
		// Mode 5522 rides directly after bracketed paste so a supporting
		// terminal switches paste delivery before any input can arrive.
		assert!(contains(&with, esc!(bracketed_paste, paste_events).as_bytes()));
	}

	#[test]
	fn input_drain_stops_after_idle_window() {
		let (reader, writer) = pipe().expect("pipe opens");
		write(&writer, b"late release").expect("pipe accepts input");
		let started = Instant::now();

		platform::drain_for_test(
			reader.as_raw_fd(),
			Duration::from_millis(300),
			Duration::from_millis(20),
		)
		.expect("drain succeeds");
		let elapsed = started.elapsed();
		assert!(elapsed >= Duration::from_millis(15));
		assert!(elapsed < Duration::from_millis(200));
	}
	#[test]
	fn resize_pipe_wakes_coalesces_and_preserves_input() {
		if env::var_os("OMP_TUI_RESIZE_PIPE_CHILD").is_none() {
			let output = Command::new(env::current_exe().expect("test executable resolves"))
				.args(["--exact", "terminal::tests::resize_pipe_wakes_coalesces_and_preserves_input"])
				.env("OMP_TUI_RESIZE_PIPE_CHILD", "1")
				.output()
				.expect("resize test child starts");
			assert!(output.status.success(), "{output:?}");
			return;
		}
		ensure_restore_hooks().expect("signal handlers install");
		let window = Winsize { ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0 };
		let pty = openpty(Some(&window), None).expect("PTY opens");
		let mut raw = tcgetattr(&pty.slave).expect("PTY attributes read");
		cfmakeraw(&mut raw);
		tcsetattr(&pty.slave, SetArg::TCSANOW, &raw).expect("PTY enters raw mode");
		tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.expect("test runtime builds")
			.block_on(async {
				let mut terminal = test_terminal_with_resize(File::from(pty.slave));
				thread::spawn(|| {
					thread::sleep(Duration::from_millis(30));
					// SAFETY: delivering SIGWINCH to this process exercises the installed handler.
					unsafe {
						libc::raise(libc::SIGWINCH);
					}
				});
				let started = Instant::now();
				let event = tokio::time::timeout(Duration::from_secs(3), terminal.next())
					.await
					.expect("resize wakes the event loop")
					.expect("resize event arrives");
				assert_eq!(event, TerminalEvent::Resize);
				assert!(started.elapsed() < Duration::from_millis(500));
				assert!(terminal.resize_ready);
				assert_eq!(terminal.take_resize().expect("resize size reads"), Some(Size::new(80, 24)));

				// SAFETY: delivering SIGWINCH to this process exercises the installed handler.
				unsafe {
					libc::raise(libc::SIGWINCH);
					libc::raise(libc::SIGWINCH);
				}
				let event = tokio::time::timeout(Duration::from_secs(3), terminal.next())
					.await
					.expect("burst wakes the event loop")
					.expect("burst resize arrives");
				assert_eq!(event, TerminalEvent::Resize);
				assert_eq!(
					terminal.take_resize().expect("coalesced resize reads"),
					Some(Size::new(80, 24))
				);
				// The watch coalesces the burst; at most resize echoes drain
				// before the mailbox goes quiet.
				while let Ok(event) =
					tokio::time::timeout(Duration::from_millis(30), terminal.next()).await
				{
					assert_eq!(
						event.expect("drained event decodes"),
						TerminalEvent::Resize,
						"only resize echoes remain queued"
					);
					let _ = terminal.take_resize();
				}

				write(&pty.master, b"x").expect("PTY accepts key");
				let event = tokio::time::timeout(Duration::from_secs(1), terminal.next())
					.await
					.expect("key wakes the event loop")
					.expect("key decodes");
				assert_eq!(event, TerminalEvent::Input(InputEvent::Key(Key::Char('x'))));
				platform::deactivate();
			});
	}

	/// Collects the next `count` input events, applying terminal responses
	/// to `terminal` state as a host's event loop would.
	async fn collect_inputs(
		terminal: &mut Terminal,
		renderer: &mut Renderer<Vec<u8>>,
		count: usize,
	) -> Vec<InputEvent> {
		let mut events = Vec::new();
		while events.len() < count {
			let event = tokio::time::timeout(Duration::from_secs(1), terminal.next())
				.await
				.expect("event arrives")
				.expect("event decodes");
			match event {
				TerminalEvent::Input(InputEvent::Response(response)) => {
					terminal
						.handle_response(&response, renderer)
						.expect("response applies");
				},
				TerminalEvent::Input(event) => events.push(event),
				TerminalEvent::Resize => {
					// Process-wide SIGWINCH tests can race this terminal.
					terminal.resize_ready = false;
				},
				other => panic!("unexpected event {other:?}"),
			}
		}
		events
	}

	#[tokio::test]
	async fn probe_window_events_are_first_and_responses_surface() {
		let (reader, _writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal_seeded(
			File::from(reader),
			esc!(
				"k",
				csi,
				"<0;4;3M",
				csi,
				"200~pasted",
				csi,
				"201~",
				csi,
				"I",
				osc,
				"11;rgb:ffff/ffff/ffff",
				bel,
			)
			.as_bytes(),
		);
		let mut renderer = Renderer::new(Vec::new());
		let events = collect_inputs(&mut terminal, &mut renderer, 4).await;
		assert_eq!(events, [
			InputEvent::Key(Key::Char('k')),
			InputEvent::Mouse(MouseReport {
				kind:    Mouse::Click,
				col:     3,
				row:     2,
				button:  MouseButton::Left,
				mods:    Mods::default(),
				pressed: true,
			}),
			InputEvent::Paste("pasted".into()),
			InputEvent::Focus(true),
		]);
		// The trailing OSC 11 reply is the fifth queued event; apply it like
		// a host event loop would.
		let event = tokio::time::timeout(Duration::from_secs(1), terminal.next())
			.await
			.expect("response arrives")
			.expect("response decodes");
		let TerminalEvent::Input(InputEvent::Response(response)) = event else {
			panic!("expected the trailing terminal response, got {event:?}");
		};
		terminal
			.handle_response(&response, &mut renderer)
			.expect("response applies");
		assert_eq!(terminal.appearance(), Some(Appearance::Light));
	}

	#[tokio::test]
	async fn probe_window_partial_sequence_continues_in_live_pump() {
		let (reader, writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal_seeded(File::from(reader), esc!(csi).as_bytes());
		write(&writer, b"A").expect("pipe accepts sequence tail");
		let mut renderer = Renderer::new(Vec::new());
		let events = collect_inputs(&mut terminal, &mut renderer, 1).await;
		assert_eq!(events, [InputEvent::Key(Key::Up)]);
	}

	#[tokio::test]
	async fn pump_joins_split_escape_sequence_into_one_key() {
		let (reader, writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal(File::from(reader));
		write(&writer, esc!(escape).as_bytes()).expect("pipe accepts escape");
		// Inside the decoder's partial-hold window the tail joins the held
		// escape into one decoded key.
		tokio::time::sleep(Duration::from_millis(20)).await;
		write(&writer, b"[A").expect("pipe accepts sequence tail");
		let mut renderer = Renderer::new(Vec::new());
		let events = collect_inputs(&mut terminal, &mut renderer, 1).await;
		assert_eq!(events, [InputEvent::Key(Key::Up)]);
	}

	#[tokio::test]
	async fn pump_responses_surface_and_update_terminal_state() {
		let (reader, writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal(File::from(reader));
		write(
			&writer,
			esc!(osc, "11;rgb:ffff/ffff/ffff", bel, csi, "48;24;80;1600;800 t").as_bytes(),
		)
		.expect("pipe accepts terminal replies");
		write(&writer, b"x").expect("pipe accepts trailing key");
		let mut renderer = Renderer::new(Vec::new());
		// Both replies surface as `Input(Response)` and apply through
		// `handle_response` before the trailing key is collected.
		let events = collect_inputs(&mut terminal, &mut renderer, 1).await;
		assert_eq!(events, [InputEvent::Key(Key::Char('x'))]);
		assert_eq!(terminal.appearance(), Some(Appearance::Light));
		assert_eq!(terminal.cell_pixel_size(), Some((10, 67)));
		assert_eq!(terminal.take_resize().expect("resize is available"), Some(Size::new(80, 24)));
	}

	#[tokio::test]
	async fn pump_timeout_tick_flushes_held_partial() {
		let (reader, writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal(File::from(reader));
		write(&writer, esc!(escape).as_bytes()).expect("pipe accepts escape");
		// The actor's own decoder deadline releases the held escape; no
		// host-side polling is involved.
		let mut renderer = Renderer::new(Vec::new());
		let events = collect_inputs(&mut terminal, &mut renderer, 1).await;
		assert_eq!(events, [InputEvent::Key(Key::Esc)]);
	}

	#[tokio::test]
	async fn appearance_callback_only_fires_on_a_classification_flip() {
		let (reader, writer) = pipe().expect("pipe opens");
		drop(reader);
		let mut terminal = test_terminal(File::from(writer));
		let observed = Arc::new(Mutex::new(None));
		let callback_observed = Arc::clone(&observed);
		terminal.on_appearance_change(move |appearance| *callback_observed.lock() = Some(appearance));
		let mut renderer = Renderer::new(Vec::new());
		terminal
			.handle_response(
				&TerminalResponse::OscColor {
					index: 11,
					r:     u16::MAX,
					g:     u16::MAX,
					b:     u16::MAX,
				},
				&mut renderer,
			)
			.unwrap();
		assert_eq!(terminal.appearance(), Some(Appearance::Light));
		assert_eq!(*observed.lock(), Some(Appearance::Light));
		*observed.lock() = None;
		terminal
			.handle_response(
				&TerminalResponse::OscColor { index: 11, r: 0xeeee, g: 0xeeee, b: 0xeeee },
				&mut renderer,
			)
			.unwrap();
		assert_eq!(*observed.lock(), None);
	}

	#[tokio::test]
	async fn appearance_pushes_collapse_to_one_debounced_query() {
		let (reader, writer) = pipe().expect("pipe opens");
		let mut terminal = test_terminal(File::from(writer));
		let mut renderer = Renderer::new(Vec::new());
		ACTIVE.store(true, Ordering::Release);
		terminal
			.handle_response(&TerminalResponse::AppearanceChanged(1), &mut renderer)
			.unwrap();
		thread::sleep(Duration::from_millis(10));
		terminal
			.handle_response(&TerminalResponse::AppearanceChanged(2), &mut renderer)
			.unwrap();
		thread::sleep(Duration::from_millis(120));
		let mut bytes = [0; 64];
		let count = read(&reader, &mut bytes).expect("query is written");
		ACTIVE.store(false, Ordering::Release);
		assert_eq!(&bytes[..count], OSC11_QUERY);
	}

	#[tokio::test]
	async fn in_band_resize_derives_pixels_and_os_geometry_wins() {
		assert_eq!(rounded_cell_pixels(1000, 120), 8);
		assert_eq!(rounded_cell_pixels(777, 80), 10);
		let reported = Size::new(120, 40);
		let os = Size::new(100, 30);
		assert_eq!(reconcile_in_band_geometry(reported, Some(os)), os);
		assert_eq!(reconcile_in_band_geometry(reported, Some(reported)), reported);

		let (reader, writer) = pipe().expect("pipe opens");
		drop(reader);
		let mut terminal = test_terminal(File::from(writer));
		let mut renderer = Renderer::new(Vec::new());
		terminal
			.handle_response(
				&TerminalResponse::InBandResize { rows: 40, cols: 120, x_px: 1000, y_px: 800 },
				&mut renderer,
			)
			.unwrap();
		assert_eq!(terminal.in_band_size(), Some(reported));
	}

	#[tokio::test]
	async fn staged_alt_sequences_split_interactive_and_resize_ownership() {
		let (reader, writer) = pipe().expect("pipe opens");
		drop(reader);
		let mut terminal = test_terminal(File::from(writer));

		// An interactive hold captures the mouse for its lifetime.
		let enter = terminal
			.stage_alt_enter(AltScreenUse::Interactive)
			.expect("first entry stages");
		assert_eq!(
			enter.as_str(),
			esc!(alt_screen, csi, ">5u", mouse_vt200, mouse_any_event, mouse_sgr)
		);
		assert!(
			terminal
				.stage_alt_enter(AltScreenUse::Interactive)
				.is_none(),
			"entry while active is a no-op"
		);
		let leave = terminal.stage_alt_leave().expect("exit stages");
		assert_eq!(
			leave,
			esc!(!mouse_sgr, !mouse_any_event, !mouse_vt200, kitty_keyboard_pop, !alt_screen)
		);
		assert!(terminal.stage_alt_leave().is_some(), "staging alone retains recovery ownership");
		assert!(terminal.alt_screen);
		assert!(ALT_SCREEN_ACTIVE.load(Ordering::Acquire));
		terminal.commit_alt_leave();
		assert!(!terminal.alt_screen);
		assert!(!ALT_SCREEN_ACTIVE.load(Ordering::Acquire));
		assert!(terminal.stage_alt_leave().is_none(), "exit on the main screen is a no-op");

		// A resize borrow never touches mouse modes: motion reports would
		// flood input mid-drag, and the exit stays symmetric.
		let enter = terminal
			.stage_alt_enter(AltScreenUse::Resize)
			.expect("borrow stages");
		assert_eq!(enter.as_str(), esc!(alt_screen, csi, ">5u"));
		let leave = terminal.stage_alt_leave().expect("borrow exit stages");
		assert_eq!(leave, esc!(kitty_keyboard_pop, !alt_screen));
		terminal.commit_alt_leave();

		// An overlay opening mid-drag upgrades the live borrow in place:
		// mouse capture turns on without a buffer round-trip, and the
		// upgraded exit turns it back off.
		let _ = terminal
			.stage_alt_enter(AltScreenUse::Resize)
			.expect("borrow re-stages");
		assert!(
			terminal.stage_alt_enter(AltScreenUse::Resize).is_none(),
			"borrow while active is a no-op"
		);
		let upgrade = terminal
			.stage_alt_enter(AltScreenUse::Interactive)
			.expect("mid-drag hold upgrades in place");
		assert_eq!(upgrade.as_str(), esc!(mouse_vt200, mouse_any_event, mouse_sgr));
		assert!(
			terminal
				.stage_alt_enter(AltScreenUse::Interactive)
				.is_none(),
			"an upgraded hold is already interactive"
		);
		let leave = terminal.stage_alt_leave().expect("upgraded exit stages");
		assert_eq!(
			leave,
			esc!(!mouse_sgr, !mouse_any_event, !mouse_vt200, kitty_keyboard_pop, !alt_screen)
		);
		terminal.commit_alt_leave();

		// A session that owns the mouse inline never toggles tracking here.
		terminal.keyboard = KeyboardMode::ModifyOtherKeys;
		terminal.mouse = true;
		assert_eq!(
			terminal
				.stage_alt_enter(AltScreenUse::Interactive)
				.expect("re-entry stages")
				.as_str(),
			esc!(alt_screen)
		);
		assert_eq!(terminal.stage_alt_leave().expect("re-exit stages"), esc!(!alt_screen));
		terminal.commit_alt_leave();
	}

	/// Terminal over an arbitrary readable handle with a live event actor.
	fn test_terminal(tty: File) -> Terminal {
		test_terminal_seeded(tty, b"")
	}

	fn test_terminal_with_resize(tty: File) -> Terminal {
		test_terminal_seeded_resize(tty, b"", true)
	}

	/// [`test_terminal`] with `preserved` bytes seeding the actor's decoder,
	/// mirroring capability-negotiation carry-over.
	fn test_terminal_seeded(tty: File, preserved: &[u8]) -> Terminal {
		test_terminal_seeded_resize(tty, preserved, false)
	}

	fn test_terminal_seeded_resize(tty: File, preserved: &[u8], watch_resize: bool) -> Terminal {
		let source = tty.try_clone().expect("test tty clones");
		let channels =
			match spawn(Input::Pollable(source), InputDecoder::new(), preserved, watch_resize) {
				Ok(channels) => channels,
				// `/dev/null` and friends are not readiness-pollable; bridge.
				Err(_) => spawn(
					Input::Bridged(tty.try_clone().expect("test tty clones")),
					InputDecoder::new(),
					preserved,
					watch_resize,
				)
				.expect("bridged test actor spawns"),
			};
		Terminal {
			caps: detect(),
			tty,
			platform: platform::state_for_test(),
			stderr: platform::StderrGuard::new(false).expect("disabled stderr guard"),
			keyboard: KeyboardMode::Kitty(esc!(csi, ">5u")),
			cursor_style: None,
			xterm_scroll_restore_modes: 0,
			ansi_mode_restore_modes: 0,
			owned_notification_modes: 0,
			mouse: false,
			cursor_visible: None,
			alt_screen: false,
			alt_mouse: false,
			active: false,
			inside_multiplexer: false,
			seen_resize: RESIZE_GENERATION.load(Ordering::Acquire),
			pending_resize: None,
			appearance: Some(Appearance::Dark),
			appearance_callbacks: Vec::new(),
			appearance_query_generation: Arc::new(AtomicU64::new(0)),
			in_band_size: None,
			keymap: Keymap::default(),
			resize_ready: false,
			resize_live: true,
			events: channels.events,
			resize_watch: ResizeWatch(channels.resize),
			pump: channels.pump,
			cell_pixel_size: None,
			progress: None,
			paste_events: PasteEvents::default(),
			pending_paste: None,
		}
	}
}
