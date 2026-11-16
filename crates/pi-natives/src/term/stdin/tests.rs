//! Raw mode, reader, and hand-back behavior on real PTYs.

use std::{
	os::fd::{AsRawFd, FromRawFd, OwnedFd},
	sync::atomic::AtomicUsize,
	time::{Duration, Instant},
};

use super::*;

/// A PTY pair; the slave starts in the kernel's default cooked mode.
struct Pty {
	master: OwnedFd,
	slave:  OwnedFd,
}

impl Pty {
	fn new() -> Self {
		let mut master = -1;
		let mut slave = -1;
		// SAFETY: both outputs point to valid storage; no name, termios, or
		// window size is passed.
		let opened = unsafe {
			libc::openpty(
				&mut master,
				&mut slave,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
			)
		};
		assert_eq!(opened, 0, "openpty: {}", io::Error::last_os_error());
		// SAFETY: openpty succeeded and returned two newly owned descriptors.
		unsafe { Self { master: OwnedFd::from_raw_fd(master), slave: OwnedFd::from_raw_fd(slave) } }
	}

	/// Type `bytes` on the terminal side, then read away the echo a cooked
	/// slave sends back: `TCSADRAIN` waits for unread slave output on macOS.
	fn type_bytes(&self, bytes: &[u8]) {
		let master = self.master.as_raw_fd();
		// SAFETY: `bytes` is initialized and the master is live.
		let written = unsafe { libc::write(master, bytes.as_ptr().cast(), bytes.len()) };
		assert_eq!(written, bytes.len() as isize, "{}", io::Error::last_os_error());
		let mut fds = [libc::pollfd { fd: master, events: libc::POLLIN, revents: 0 }];
		let mut buf = [0u8; 1024];
		loop {
			// SAFETY: fds holds one valid entry for the duration of the call.
			if unsafe { libc::poll(fds.as_mut_ptr(), 1, 10) } <= 0 {
				break;
			}
			// SAFETY: buf is writable for its length and the master is live.
			if unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) } <= 0 {
				break;
			}
		}
	}
}

/// Input flags `setRawMode` clears.
const RAW_IFLAGS: libc::tcflag_t =
	libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON;
/// Local flags `setRawMode` clears.
const RAW_LFLAGS: libc::tcflag_t = libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG;

fn attributes(fd: i32) -> libc::termios {
	let mut attrs = std::mem::MaybeUninit::<libc::termios>::uninit();
	// SAFETY: fd is a live test-owned TTY and attrs is valid output storage.
	assert_eq!(unsafe { libc::tcgetattr(fd, attrs.as_mut_ptr()) }, 0);
	// SAFETY: tcgetattr succeeded.
	unsafe { attrs.assume_init() }
}

/// Equal attributes, ignoring PENDIN: BSD kernels set that state bit
/// themselves when ICANON turns back on.
fn same_attributes(a: &libc::termios, b: &libc::termios) -> bool {
	a.c_iflag == b.c_iflag
		&& a.c_oflag == b.c_oflag
		&& a.c_cflag == b.c_cflag
		&& a.c_lflag & !libc::PENDIN == b.c_lflag & !libc::PENDIN
		&& a.c_cc == b.c_cc
}

fn wait_until(mut ready: impl FnMut() -> bool) {
	let deadline = Instant::now() + Duration::from_secs(3);
	while !ready() {
		assert!(Instant::now() < deadline, "timed out waiting for the reader");
		std::thread::sleep(Duration::from_millis(1));
	}
}

/// Attach to `fd`, counting wake-ups.
fn attach(fd: i32) -> (Stdin, Arc<AtomicUsize>) {
	let wakes = Arc::new(AtomicUsize::new(0));
	let counter = Arc::clone(&wakes);
	let stdin = Stdin::open(
		fd,
		Box::new(move || {
			counter.fetch_add(1, Ordering::AcqRel);
		}),
	)
	.unwrap();
	(stdin, wakes)
}

/// Take until `bytes` reads have arrived (or the end), collecting them.
fn take_reads(stdin: &Stdin, bytes: usize) -> (Vec<Vec<u8>>, Option<End>) {
	let mut reads = Vec::new();
	let mut total = 0;
	let mut end = None;
	let mut taken = Reads::default();
	wait_until(|| {
		end = end.take().or_else(|| stdin.take(&mut taken));
		for read in taken.iter() {
			total += read.len();
			reads.push(read.to_vec());
		}
		taken.clear();
		total >= bytes || end.is_some()
	});
	(reads, end)
}

#[test]
fn raw_mode_matches_set_raw_mode_and_detach_restores_the_exact_attributes() {
	let pty = Pty::new();
	let fd = pty.slave.as_raw_fd();
	let original = attributes(fd);
	assert_ne!(original.c_lflag & libc::ICANON, 0);

	let (stdin, _) = attach(fd);
	let raw = attributes(fd);
	assert_eq!(raw.c_iflag & RAW_IFLAGS, 0);
	assert_eq!(raw.c_lflag & RAW_LFLAGS, 0);
	assert_ne!(raw.c_oflag & libc::ONLCR, 0);
	assert_eq!(raw.c_cflag & libc::CS8, libc::CS8);
	assert_eq!(raw.c_cc[libc::VMIN], 1);
	assert_eq!(raw.c_cc[libc::VTIME], 0);
	// Nothing beyond setRawMode's flags changed.
	assert_eq!(raw.c_iflag | RAW_IFLAGS, original.c_iflag | RAW_IFLAGS);
	assert_eq!(raw.c_lflag | RAW_LFLAGS, original.c_lflag | RAW_LFLAGS);
	assert!(stdin.cooked_typeahead());

	stdin.detach().unwrap();
	assert!(same_attributes(&attributes(fd), &original));
}

#[test]
fn an_attach_over_a_raw_terminal_has_no_cooked_typeahead_and_restores_raw() {
	let pty = Pty::new();
	let fd = pty.slave.as_raw_fd();
	let mut raw = attributes(fd);
	// SAFETY: raw is initialized and the PTY is test-owned.
	unsafe { libc::cfmakeraw(&mut raw) };
	// SAFETY: as above.
	assert_eq!(unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) }, 0);
	let before = attributes(fd);

	let (stdin, _) = attach(fd);
	assert!(!stdin.cooked_typeahead());
	stdin.detach().unwrap();
	assert!(same_attributes(&attributes(fd), &before));
}

#[test]
fn reads_arrive_whole_and_in_order_with_one_wake_per_batch() {
	let pty = Pty::new();
	let (stdin, wakes) = attach(pty.slave.as_raw_fd());

	pty.type_bytes(b"\x1b[200~paste\x1b[201~\r");
	wait_until(|| wakes.load(Ordering::Acquire) == 1);
	// Untaken reads do not wake again.
	pty.type_bytes("界".as_bytes());
	wait_until(|| {
		let queued = stdin.shared.queue.lock().reads.bytes.len();
		queued == "\x1b[200~paste\x1b[201~\r界".len()
	});
	assert_eq!(wakes.load(Ordering::Acquire), 1);

	let mut taken = Reads::default();
	assert!(stdin.take(&mut taken).is_none());
	let joined: Vec<u8> = taken.iter().flatten().copied().collect();
	assert_eq!(joined, "\x1b[200~paste\x1b[201~\r界".as_bytes());
	assert!(taken.iter().all(|read| !read.is_empty()));
	assert_eq!(taken.iter().next().unwrap(), b"\x1b[200~paste\x1b[201~\r");
	taken.clear();

	// Taking re-arms the wake-up.
	pty.type_bytes(b"x");
	wait_until(|| wakes.load(Ordering::Acquire) == 2);
	let (reads, end) = take_reads(&stdin, 1);
	assert_eq!(reads, [b"x".to_vec()]);
	assert!(end.is_none());
	stdin.detach().unwrap();
}

/// #17820: what the user typed during a cooked-mode prepaint is the first
/// read once raw input attaches, with Enter folded into LF by ICRNL.
#[test]
fn cooked_typeahead_is_the_first_read_after_attach() {
	let pty = Pty::new();
	pty.type_bytes(b"hello\r");
	let (stdin, _) = attach(pty.slave.as_raw_fd());
	assert!(stdin.cooked_typeahead());
	let (reads, _) = take_reads(&stdin, 6);
	assert_eq!(reads.first().map(Vec::as_slice), Some(&b"hello\n"[..]));
	stdin.detach().unwrap();
}

/// The terminal is handed back (external editor, suspend, exit): nothing is
/// consumed after the reader stops, so the next reader gets every byte.
#[test]
fn bytes_typed_after_stop_reading_stay_for_the_next_reader() {
	let pty = Pty::new();
	let fd = pty.slave.as_raw_fd();
	let (mut stdin, _) = attach(fd);
	stdin.stop_reading();
	pty.type_bytes(b"for the editor");
	std::thread::sleep(Duration::from_millis(20));
	let mut taken = Reads::default();
	assert!(stdin.take(&mut taken).is_none());
	assert_eq!(taken.iter().count(), 0);

	// The bytes are all still queued for the next reader.
	let mut buf = [0u8; 64];
	// SAFETY: buf is writable; fd is a live raw TTY with queued input.
	let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
	assert_eq!(&buf[..read as usize], b"for the editor");
	stdin.detach().unwrap();
}

#[test]
fn a_hangup_ends_input_after_the_reads_before_it() {
	let pty = Pty::new();
	let (stdin, _) = attach(pty.slave.as_raw_fd());
	pty.type_bytes(b"last words");
	wait_until(|| !stdin.shared.queue.lock().reads.bytes.is_empty());
	drop(pty.master);
	let (reads, end) = take_reads(&stdin, usize::MAX);
	assert_eq!(reads.concat(), b"last words");
	// Linux answers a hung-up PTY with EIO, macOS with end of file.
	assert!(matches!(end, Some(End::Eof | End::Failed(_))), "{end:?}");
	// A dead terminal may refuse the restore; the caller decides.
	let _ = stdin.detach();
}

#[test]
fn a_non_terminal_is_read_as_is_until_it_ends() {
	let (socket, peer) = std::os::unix::net::UnixStream::pair().unwrap();
	let (stdin, _) = attach(socket.as_raw_fd());
	assert!(stdin.mode.is_none());
	assert!(!stdin.cooked_typeahead());
	std::io::Write::write_all(&mut &peer, b"piped").unwrap();
	drop(peer);
	let (reads, end) = take_reads(&stdin, usize::MAX);
	assert_eq!(reads.concat(), b"piped");
	assert!(matches!(end, Some(End::Eof)), "{end:?}");
	stdin.detach().unwrap();
}

/// A terminal revoked under a live session: the restore fails and says so,
/// rather than silently leaving the terminal raw.
#[test]
fn a_failed_restore_is_reported() {
	let pty = Pty::new();
	let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
	// SAFETY: duplicating a live test-owned descriptor.
	let fd = unsafe { libc::dup(pty.slave.as_raw_fd()) };
	assert!(fd >= 0);
	let (stdin, _) = attach(fd);
	// The descriptor stops being a terminal under the live session (an
	// atomic replacement, so no other test can reuse the number).
	// SAFETY: both descriptors are live and test-owned.
	assert_eq!(unsafe { libc::dup2(socket.as_raw_fd(), fd) }, fd);
	assert!(stdin.detach().is_err());
	// SAFETY: fd is the test's own descriptor, no longer used.
	unsafe { libc::close(fd) };
}
