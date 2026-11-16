//! Unix stdin: termios raw mode and a poll-driven, cancellable reader.

use std::{
	io,
	os::{fd::AsRawFd, unix::net::UnixStream},
	sync::Arc,
	thread::JoinHandle,
};

use super::{End, READ_BYTES, Shared};

/// A stdin descriptor. The owner keeps it open until the reader is joined.
pub(super) type Input = i32;

#[allow(clippy::unnecessary_wraps, reason = "the Windows stdin handle lookup can fail")]
pub(super) const fn stdin() -> io::Result<Input> {
	Ok(libc::STDIN_FILENO)
}

/// `tcsetattr`, retried when a signal interrupts it.
fn set_attributes(fd: i32, attributes: &libc::termios) -> io::Result<()> {
	loop {
		// SAFETY: `attributes` is an initialized termios; fd is only configured.
		if unsafe { libc::tcsetattr(fd, libc::TCSADRAIN, attributes) } == 0 {
			return Ok(());
		}
		let err = io::Error::last_os_error();
		if err.kind() != io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

/// Raw mode on a TTY; holds the attributes to put back.
pub(super) struct RawMode {
	fd:       i32,
	original: libc::termios,
}

impl RawMode {
	/// Switch the TTY behind `fd` to raw mode. `None` when `fd` is not a TTY:
	/// a pipe or file is read as is.
	pub(super) fn enter(fd: i32) -> io::Result<Option<Self>> {
		// SAFETY: isatty only inspects the descriptor.
		if unsafe { libc::isatty(fd) } == 0 {
			return Ok(None);
		}
		let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
		// SAFETY: fd is a TTY and `original` is valid output storage.
		if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: tcgetattr succeeded.
		let original = unsafe { original.assume_init() };
		// libuv's UV_TTY_MODE_RAW, which Bun's `setRawMode(true)` applies: no
		// line editing, echo, signals, or input translation, 8-bit bytes, one
		// byte satisfies a read; output post-processing stays on.
		let mut raw = original;
		raw.c_iflag &= !(libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON);
		raw.c_oflag |= libc::ONLCR;
		raw.c_cflag |= libc::CS8;
		raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG);
		raw.c_cc[libc::VMIN] = 1;
		raw.c_cc[libc::VTIME] = 0;
		set_attributes(fd, &raw)?;
		Ok(Some(Self { fd, original }))
	}

	/// The terminal folded Enter into a line feed (ICRNL) until now, so bytes
	/// it buffered carry LF where the user pressed Enter.
	pub(super) const fn cooked(&self) -> bool {
		self.original.c_iflag & libc::ICRNL != 0
	}

	/// Put the attributes found at [`enter`](Self::enter) back.
	pub(super) fn restore(&self) -> io::Result<()> {
		set_attributes(self.fd, &self.original)
	}
}

/// The reader thread and the socket whose closing cancels it.
pub(super) struct Reader {
	thread: Option<JoinHandle<()>>,
	cancel: Option<UnixStream>,
}

impl Reader {
	pub(super) fn start(fd: i32, shared: Arc<Shared>) -> io::Result<Self> {
		// Closing the sender wakes poll without writes, SIGPIPE, or a
		// potentially full wake pipe.
		let (cancel_read, cancel_write) = UnixStream::pair()?;
		let thread = std::thread::Builder::new()
			.name("term-stdin".into())
			.spawn(move || read_loop(fd, &cancel_read, &shared))?;
		Ok(Self { thread: Some(thread), cancel: Some(cancel_write) })
	}

	/// Cancel the reader and join it.
	pub(super) fn stop(&mut self) {
		drop(self.cancel.take());
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

impl Drop for Reader {
	fn drop(&mut self) {
		self.stop();
	}
}

enum Wait {
	Readable,
	Cancelled,
}

/// Wait until `fd` has something to report (bytes, end, or an error the read
/// will surface) or the owner cancels.
fn wait_readable(fd: i32, cancel_fd: i32) -> io::Result<Wait> {
	let mut fds = [libc::pollfd { fd, events: libc::POLLIN, revents: 0 }, libc::pollfd {
		fd:      cancel_fd,
		events:  libc::POLLIN,
		revents: 0,
	}];
	loop {
		// SAFETY: fds holds two valid poll entries for the duration of the call.
		let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, -1) };
		if ready < 0 {
			let err = io::Error::last_os_error();
			if err.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		if fds[1].revents != 0 {
			return Ok(Wait::Cancelled);
		}
		if fds[0].revents & libc::POLLNVAL != 0 {
			return Err(io::Error::from_raw_os_error(libc::EBADF));
		}
		if fds[0].revents != 0 {
			return Ok(Wait::Readable);
		}
	}
}

fn read_loop(fd: i32, cancel: &UnixStream, shared: &Shared) {
	let mut buf = vec![0u8; READ_BYTES];
	loop {
		match wait_readable(fd, cancel.as_raw_fd()) {
			Ok(Wait::Readable) => {},
			Ok(Wait::Cancelled) => return,
			Err(err) => {
				shared.finish(End::Failed(err));
				return;
			},
		}
		// SAFETY: `buf` is writable for its length; the owner keeps fd open
		// until this thread is joined.
		let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
		if read > 0 {
			shared.deliver(&buf[..read as usize]);
			continue;
		}
		if read == 0 {
			shared.finish(End::Eof);
			return;
		}
		let err = io::Error::last_os_error();
		if matches!(err.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
			continue;
		}
		shared.finish(End::Failed(err));
		return;
	}
}
