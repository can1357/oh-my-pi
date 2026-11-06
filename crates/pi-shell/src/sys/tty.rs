//! Terminal system calls behind the engine's [`Terminal`] seam.
//!
//! - [`NativeTerminal`]: the process host's [`Terminal`] over the real
//!   terminals of this process (Unix; every operation off Unix fails with
//!   `Unsupported`).
//! - [`TermiosGuard`]: saves a terminal's modes and puts them back when dropped
//!   (optionally switching it to raw mode first).
//! - Free functions over raw descriptors (`attrs`, `set_attrs`, `window_size`,
//!   `set_foreground`, `open_controlling`, `open_pty`, …) for code that holds
//!   descriptors itself (the pty test harness).

use std::io;

use bstr::BString;

#[cfg(unix)]
pub use self::unix::*;
use crate::bash::{OsHandle, Pty, SetWhen, Shtty, Terminal, Termios, TtyInfo};

#[cfg(unix)]
mod unix {
	use std::{
		ffi::CStr,
		io,
		mem::MaybeUninit,
		os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		ptr,
	};

	use bstr::BString;

	use crate::bash::{CtlChar, SetWhen, TermFlag, Termios, TtyInfo};

	/// Which `termios` field a [`TermFlag`] lives in.
	#[derive(Clone, Copy)]
	enum Field {
		I,
		O,
		C,
		L,
	}

	/// The platform's bit for each [`TermFlag`] it has.
	const FLAGS: &[(TermFlag, Field, libc::tcflag_t)] = &[
		(TermFlag::Ignbrk, Field::I, libc::IGNBRK),
		(TermFlag::Brkint, Field::I, libc::BRKINT),
		(TermFlag::Ignpar, Field::I, libc::IGNPAR),
		(TermFlag::Parmrk, Field::I, libc::PARMRK),
		(TermFlag::Inpck, Field::I, libc::INPCK),
		(TermFlag::Istrip, Field::I, libc::ISTRIP),
		(TermFlag::Inlcr, Field::I, libc::INLCR),
		(TermFlag::Igncr, Field::I, libc::IGNCR),
		(TermFlag::Icrnl, Field::I, libc::ICRNL),
		#[cfg(target_os = "linux")]
		(TermFlag::Iuclc, Field::I, libc::IUCLC),
		(TermFlag::Ixon, Field::I, libc::IXON),
		(TermFlag::Ixany, Field::I, libc::IXANY),
		(TermFlag::Ixoff, Field::I, libc::IXOFF),
		(TermFlag::Imaxbel, Field::I, libc::IMAXBEL),
		(TermFlag::Iutf8, Field::I, IUTF8),
		(TermFlag::Opost, Field::O, libc::OPOST),
		#[cfg(target_os = "linux")]
		(TermFlag::Olcuc, Field::O, libc::OLCUC),
		(TermFlag::Onlcr, Field::O, libc::ONLCR),
		(TermFlag::Ocrnl, Field::O, libc::OCRNL),
		(TermFlag::Onocr, Field::O, libc::ONOCR),
		(TermFlag::Onlret, Field::O, libc::ONLRET),
		(TermFlag::Cstopb, Field::C, libc::CSTOPB),
		(TermFlag::Cread, Field::C, libc::CREAD),
		(TermFlag::Parenb, Field::C, libc::PARENB),
		(TermFlag::Parodd, Field::C, libc::PARODD),
		(TermFlag::Hupcl, Field::C, libc::HUPCL),
		(TermFlag::Clocal, Field::C, libc::CLOCAL),
		(TermFlag::Crtscts, Field::C, libc::CRTSCTS),
		(TermFlag::Isig, Field::L, libc::ISIG),
		(TermFlag::Icanon, Field::L, libc::ICANON),
		#[cfg(target_os = "linux")]
		(TermFlag::Xcase, Field::L, libc::XCASE),
		(TermFlag::Echo, Field::L, libc::ECHO),
		(TermFlag::Echoe, Field::L, libc::ECHOE),
		(TermFlag::Echok, Field::L, libc::ECHOK),
		(TermFlag::Echonl, Field::L, libc::ECHONL),
		(TermFlag::Noflsh, Field::L, libc::NOFLSH),
		(TermFlag::Tostop, Field::L, libc::TOSTOP),
		(TermFlag::Echoctl, Field::L, libc::ECHOCTL),
		(TermFlag::Echoprt, Field::L, libc::ECHOPRT),
		(TermFlag::Echoke, Field::L, libc::ECHOKE),
		(TermFlag::Flusho, Field::L, libc::FLUSHO),
		(TermFlag::Pendin, Field::L, libc::PENDIN),
		(TermFlag::Iexten, Field::L, libc::IEXTEN),
		(TermFlag::Extproc, Field::L, libc::EXTPROC),
	];

	/// `IUTF8` (not in every libc target module).
	#[cfg(target_os = "linux")]
	const IUTF8: libc::tcflag_t = 0o040000;
	#[cfg(not(target_os = "linux"))]
	const IUTF8: libc::tcflag_t = libc::IUTF8;

	/// The platform's `c_cc` index for each [`CtlChar`] it has.
	const CHARS: &[(CtlChar, usize)] = &[
		(CtlChar::Intr, libc::VINTR),
		(CtlChar::Quit, libc::VQUIT),
		(CtlChar::Erase, libc::VERASE),
		(CtlChar::Kill, libc::VKILL),
		(CtlChar::Eof, libc::VEOF),
		(CtlChar::Eol, libc::VEOL),
		(CtlChar::Eol2, libc::VEOL2),
		(CtlChar::Start, libc::VSTART),
		(CtlChar::Stop, libc::VSTOP),
		(CtlChar::Susp, libc::VSUSP),
		#[cfg(not(target_os = "linux"))]
		(CtlChar::Dsusp, libc::VDSUSP),
		(CtlChar::Lnext, libc::VLNEXT),
		(CtlChar::Werase, libc::VWERASE),
		(CtlChar::Reprint, libc::VREPRINT),
		(CtlChar::Discard, libc::VDISCARD),
		#[cfg(not(target_os = "linux"))]
		(CtlChar::Status, libc::VSTATUS),
		#[cfg(target_os = "linux")]
		(CtlChar::Swtc, libc::VSWTC),
	];

	/// `_POSIX_VDISABLE`.
	#[cfg(target_os = "linux")]
	const VDISABLE: libc::cc_t = 0;
	#[cfg(not(target_os = "linux"))]
	const VDISABLE: libc::cc_t = 0xff;

	/// Linux encodes speeds as `B…` codes; `(code, baud)`.
	#[cfg(target_os = "linux")]
	const SPEEDS: &[(libc::speed_t, u32)] = &[
		(libc::B0, 0),
		(libc::B50, 50),
		(libc::B75, 75),
		(libc::B110, 110),
		(libc::B134, 134),
		(libc::B150, 150),
		(libc::B200, 200),
		(libc::B300, 300),
		(libc::B600, 600),
		(libc::B1200, 1200),
		(libc::B1800, 1800),
		(libc::B2400, 2400),
		(libc::B4800, 4800),
		(libc::B9600, 9600),
		(libc::B19200, 19200),
		(libc::B38400, 38400),
		(libc::B57600, 57600),
		(libc::B115200, 115_200),
		(libc::B230400, 230_400),
		(libc::B460800, 460_800),
		(libc::B500000, 500_000),
		(libc::B576000, 576_000),
		(libc::B921600, 921_600),
		(libc::B1000000, 1_000_000),
		(libc::B1152000, 1_152_000),
		(libc::B1500000, 1_500_000),
		(libc::B2000000, 2_000_000),
		(libc::B2500000, 2_500_000),
		(libc::B3000000, 3_000_000),
		(libc::B3500000, 3_500_000),
		(libc::B4000000, 4_000_000),
	];

	#[cfg(target_os = "linux")]
	fn baud(code: libc::speed_t) -> u32 {
		SPEEDS.iter().find(|s| s.0 == code).map_or(0, |s| s.1)
	}

	#[cfg(target_os = "linux")]
	fn code(baud: u32) -> Option<libc::speed_t> {
		SPEEDS.iter().find(|s| s.1 == baud).map(|s| s.0)
	}

	#[cfg(not(target_os = "linux"))]
	fn baud(code: libc::speed_t) -> u32 {
		u32::try_from(code).unwrap_or(u32::MAX)
	}

	#[cfg(not(target_os = "linux"))]
	fn code(baud: u32) -> libc::speed_t {
		libc::speed_t::from(baud)
	}

	const fn field(t: &mut libc::termios, f: Field) -> &mut libc::tcflag_t {
		match f {
			Field::I => &mut t.c_iflag,
			Field::O => &mut t.c_oflag,
			Field::C => &mut t.c_cflag,
			Field::L => &mut t.c_lflag,
		}
	}

	/// The bytes of `t` (its encoding in [`Termios::os`]).
	fn encode(t: &libc::termios) -> Vec<u8> {
		// SAFETY: `termios` is plain old data; the slice covers exactly it
		// and lives no longer than the borrow.
		unsafe {
			std::slice::from_raw_parts(ptr::from_ref(t).cast::<u8>(), size_of::<libc::termios>())
		}
		.to_vec()
	}

	/// `t` in the engine's terms.
	pub fn from_os(t: &libc::termios) -> Termios {
		let mut out = Termios::default();
		let mut os = *t;
		for &(flag, f, bit) in FLAGS {
			out.set(flag, *field(&mut os, f) & bit != 0);
		}
		out.char_size = match t.c_cflag & libc::CSIZE {
			libc::CS5 => 5,
			libc::CS6 => 6,
			libc::CS7 => 7,
			_ => 8,
		};
		for &(c, idx) in CHARS {
			let v = t.c_cc[idx];
			out.set_char(c, (v != VDISABLE).then_some(v));
		}
		out.min = t.c_cc[libc::VMIN];
		out.time = t.c_cc[libc::VTIME];
		// SAFETY: both only read the struct.
		let (i, o) = unsafe { (libc::cfgetispeed(t), libc::cfgetospeed(t)) };
		out.ispeed = baud(i);
		out.ospeed = baud(o);
		out.os = encode(t);
		out
	}

	/// `t` in the platform's terms: its own encoding (when it is this
	/// platform's) with every named field applied over it.
	pub fn to_os(t: &Termios) -> libc::termios {
		// SAFETY: an all-zero `termios` is a valid value.
		let mut os: libc::termios = unsafe { std::mem::zeroed() };
		if t.os.len() == size_of::<libc::termios>() {
			// SAFETY: the source holds exactly one `termios` (plain old data)
			// and the regions do not overlap.
			unsafe {
				ptr::copy_nonoverlapping(
					t.os.as_ptr(),
					ptr::from_mut(&mut os).cast::<u8>(),
					size_of::<libc::termios>(),
				);
			}
		}
		for &(flag, f, bit) in FLAGS {
			let word = field(&mut os, f);
			if t.get(flag) {
				*word |= bit;
			} else {
				*word &= !bit;
			}
		}
		os.c_cflag &= !libc::CSIZE;
		os.c_cflag |= match t.char_size {
			5 => libc::CS5,
			6 => libc::CS6,
			7 => libc::CS7,
			_ => libc::CS8,
		};
		for &(c, idx) in CHARS {
			os.c_cc[idx] = t.char(c).unwrap_or(VDISABLE);
		}
		os.c_cc[libc::VMIN] = t.min;
		os.c_cc[libc::VTIME] = t.time;
		// An unknown speed keeps the encoding's.
		#[cfg(target_os = "linux")]
		let (ispeed, ospeed) = (code(t.ispeed), code(t.ospeed));
		#[cfg(not(target_os = "linux"))]
		let (ispeed, ospeed) = (Some(code(t.ispeed)), Some(code(t.ospeed)));
		if let Some(i) = ispeed {
			// SAFETY: `os` is a valid termios.
			unsafe { libc::cfsetispeed(&raw mut os, i) };
		}
		if let Some(o) = ospeed {
			// SAFETY: `os` is a valid termios.
			unsafe { libc::cfsetospeed(&raw mut os, o) };
		}
		os
	}

	fn check(rc: libc::c_int) -> io::Result<()> {
		if rc == -1 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	/// `tcgetattr` in the platform's terms.
	pub fn get_os(fd: RawFd) -> io::Result<libc::termios> {
		let mut t = MaybeUninit::<libc::termios>::zeroed();
		// SAFETY: tcgetattr writes one termios into the valid pointer.
		check(unsafe { libc::tcgetattr(fd, t.as_mut_ptr()) })?;
		// SAFETY: tcgetattr succeeded.
		Ok(unsafe { t.assume_init() })
	}

	/// `tcsetattr` in the platform's terms.
	pub fn set_os(fd: RawFd, t: &libc::termios, when: SetWhen) -> io::Result<()> {
		let how = match when {
			SetWhen::Now => libc::TCSANOW,
			SetWhen::Drain => libc::TCSADRAIN,
			SetWhen::Flush => libc::TCSAFLUSH,
		};
		loop {
			// SAFETY: `t` is a valid termios.
			match check(unsafe { libc::tcsetattr(fd, how, t) }) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				other => return other,
			}
		}
	}

	/// The modes of terminal `fd` (`tcgetattr`).
	pub fn attrs(fd: RawFd) -> io::Result<Termios> {
		get_os(fd).map(|t| from_os(&t))
	}

	/// Set the modes of terminal `fd` (`tcsetattr`).
	pub fn set_attrs(fd: RawFd, attrs: &Termios, when: SetWhen) -> io::Result<()> {
		set_os(fd, &to_os(attrs), when)
	}

	/// Whether `fd` is a terminal.
	pub fn is_terminal(fd: RawFd) -> bool {
		// SAFETY: isatty only inspects the descriptor.
		unsafe { libc::isatty(fd) == 1 }
	}

	/// The window size of terminal `fd` (`TIOCGWINSZ`).
	pub fn window_size(fd: RawFd) -> io::Result<TtyInfo> {
		let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
		// SAFETY: TIOCGWINSZ writes one `winsize` into the valid pointer.
		check(unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &raw mut ws) })?;
		Ok(TtyInfo { rows: ws.ws_row, cols: ws.ws_col })
	}

	/// Set the window size of terminal `fd` (`TIOCSWINSZ`).
	pub fn set_window_size(fd: RawFd, size: TtyInfo) -> io::Result<()> {
		let ws =
			libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: 0, ws_ypixel: 0 };
		// SAFETY: TIOCSWINSZ reads one `winsize` from the valid pointer.
		check(unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &raw const ws) })
	}

	/// The foreground process group of terminal `fd` (`tcgetpgrp`).
	pub fn foreground(fd: RawFd) -> io::Result<i32> {
		// SAFETY: tcgetpgrp only inspects the descriptor.
		let pgid = unsafe { libc::tcgetpgrp(fd) };
		if pgid == -1 {
			Err(io::Error::last_os_error())
		} else {
			Ok(pgid)
		}
	}

	/// Make `pgid` the foreground process group of terminal `fd`
	/// (`tcsetpgrp`) with `SIGTTOU` blocked on this thread, so a caller in
	/// a background group is not stopped by it.
	pub fn set_foreground(fd: RawFd, pgid: i32) -> io::Result<()> {
		// SAFETY: the sets are initialized by sigemptyset before use; the
		// mask is restored before returning.
		unsafe {
			let mut block = MaybeUninit::<libc::sigset_t>::zeroed();
			libc::sigemptyset(block.as_mut_ptr());
			libc::sigaddset(block.as_mut_ptr(), libc::SIGTTOU);
			let mut old = MaybeUninit::<libc::sigset_t>::zeroed();
			libc::pthread_sigmask(libc::SIG_BLOCK, block.as_ptr(), old.as_mut_ptr());
			let rc = libc::tcsetpgrp(fd, pgid);
			let err = io::Error::last_os_error();
			libc::pthread_sigmask(libc::SIG_SETMASK, old.as_ptr(), ptr::null_mut());
			if rc == -1 { Err(err) } else { Ok(()) }
		}
	}

	/// The session of terminal `fd` (`tcgetsid`).
	pub fn session(fd: RawFd) -> io::Result<i32> {
		// SAFETY: tcgetsid only inspects the descriptor.
		let sid = unsafe { libc::tcgetsid(fd) };
		if sid == -1 {
			Err(io::Error::last_os_error())
		} else {
			Ok(sid)
		}
	}

	/// The device name of terminal `fd` (`ttyname`).
	pub fn name(fd: RawFd) -> io::Result<BString> {
		let mut buf = [0u8; 256];
		// SAFETY: the buffer is valid for its length; ttyname_r
		// NUL-terminates on success.
		let rc = unsafe { libc::ttyname_r(fd, buf.as_mut_ptr().cast(), buf.len()) };
		if rc != 0 {
			return Err(io::Error::from_raw_os_error(rc));
		}
		let name = CStr::from_bytes_until_nul(&buf).map_err(|_| io::ErrorKind::InvalidData)?;
		Ok(BString::from(name.to_bytes()))
	}

	/// `fcntl(fd, F_DUPFD_CLOEXEC, 10)`: a close-on-exec copy of `fd` at 10
	/// or above (zsh's `movefd`).
	pub fn dup_high(fd: RawFd) -> io::Result<OwnedFd> {
		// SAFETY: F_DUPFD_CLOEXEC creates a new descriptor this function owns.
		let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
		if new == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `new` was just created and nothing else owns it.
		Ok(unsafe { OwnedFd::from_raw_fd(new) })
	}

	fn open_rdwr(path: &CStr) -> io::Result<OwnedFd> {
		// SAFETY: a NUL-terminated path; the result is a new descriptor.
		let fd =
			unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
		if fd == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fd` was just created and nothing else owns it.
		let owned = unsafe { OwnedFd::from_raw_fd(fd) };
		if fd >= 10 {
			Ok(owned)
		} else {
			dup_high(owned.as_raw_fd())
		}
	}

	/// Whether `fd` is open for reading and writing.
	fn rdwr(fd: RawFd) -> bool {
		// SAFETY: F_GETFL only reads the status flags.
		let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
		flags != -1 && flags & libc::O_ACCMODE == libc::O_RDWR
	}

	/// zsh's `init_io`: the shell's terminal and its name.
	///
	/// The tty of fd 0 reopened read-write by name, else fd 0 itself when it is
	/// open read-write; else fd 1's when it is a read-write terminal; else
	/// `/dev/tty`. The descriptor is at 10 or above, close-on-exec; the
	/// process's own descriptors are only duplicated, never taken over.
	pub fn open_controlling() -> io::Result<Option<(OwnedFd, BString)>> {
		if is_terminal(0) {
			let name = self::name(0).ok();
			if let Some(n) = &name
				&& let Ok(path) = std::ffi::CString::new(n.to_vec())
				&& let Ok(fd) = open_rdwr(&path)
			{
				return Ok(Some((fd, n.clone())));
			}
			if rdwr(0)
				&& let Ok(fd) = dup_high(0)
			{
				return Ok(Some((fd, name.unwrap_or_else(|| BString::from("/dev/tty")))));
			}
		}
		if is_terminal(1)
			&& rdwr(1)
			&& let Ok(fd) = dup_high(1)
		{
			let name = self::name(1).unwrap_or_else(|_| BString::from("/dev/tty"));
			return Ok(Some((fd, name)));
		}
		match open_rdwr(c"/dev/tty") {
			Ok(fd) => {
				let name = self::name(fd.as_raw_fd()).unwrap_or_else(|_| BString::from("/dev/tty"));
				Ok(Some((fd, name)))
			},
			Err(_) => Ok(None),
		}
	}

	/// A new pty pair, close-on-exec, with window size `size` if given:
	/// `(master, slave, slave name)`.
	pub fn open_pty(size: Option<TtyInfo>) -> io::Result<(OwnedFd, OwnedFd, BString)> {
		let (mut m, mut s) = (-1, -1);
		let ws = size.map(|z| libc::winsize {
			ws_row:    z.rows,
			ws_col:    z.cols,
			ws_xpixel: 0,
			ws_ypixel: 0,
		});
		let wsp = ws
			.as_ref()
			.map_or(ptr::null_mut(), |w| ptr::from_ref(w).cast_mut());
		// SAFETY: both out pointers are valid; a null name and termios are
		// allowed; `wsp` is null or points at a live winsize.
		check(unsafe {
			libc::openpty(&raw mut m, &raw mut s, ptr::null_mut(), ptr::null_mut(), wsp.cast())
		})?;
		// SAFETY: openpty created both descriptors; nothing else owns them.
		let (m, s) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
		for fd in [m.as_raw_fd(), s.as_raw_fd()] {
			// SAFETY: F_SETFD only changes the descriptor flags.
			unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
		}
		let name = self::name(s.as_raw_fd())?;
		Ok((m, s, name))
	}

	/// A terminal's modes, put back when dropped (unless [disarmed]).
	///
	/// Holds its own descriptor of the terminal, so it outlives whatever
	/// descriptor it was made from.
	///
	/// [disarmed]: TermiosGuard::disarm
	pub struct TermiosGuard {
		fd:    Option<OwnedFd>,
		saved: libc::termios,
	}

	impl TermiosGuard {
		/// Save the modes of terminal `fd`.
		///
		/// # Errors
		///
		/// When `fd` is not a terminal or cannot be duplicated.
		pub fn save(fd: BorrowedFd<'_>) -> io::Result<Self> {
			let saved = get_os(fd.as_raw_fd())?;
			Ok(Self { fd: Some(dup_high(fd.as_raw_fd())?), saved })
		}

		/// Save the modes of terminal `fd`, then put it in raw mode
		/// ([`Termios::make_raw`]).
		///
		/// # Errors
		///
		/// As [`Self::save`], or when the modes cannot be set.
		pub fn raw(fd: BorrowedFd<'_>) -> io::Result<Self> {
			let guard = Self::save(fd)?;
			let mut t = from_os(&guard.saved);
			t.make_raw();
			set_attrs(fd.as_raw_fd(), &t, SetWhen::Flush)?;
			Ok(guard)
		}

		/// The saved modes.
		pub fn saved(&self) -> Termios {
			from_os(&self.saved)
		}

		/// Whether `other` is the same terminal device as this guard's.
		pub fn same_device(&self, other: RawFd) -> bool {
			self
				.fd
				.as_ref()
				.is_some_and(|fd| device(fd.as_raw_fd()).is_some_and(|d| device(other) == Some(d)))
		}

		/// Put the saved modes back now.
		///
		/// # Errors
		///
		/// When the terminal refuses them.
		pub fn restore(&self) -> io::Result<()> {
			match &self.fd {
				Some(fd) => set_os(fd.as_raw_fd(), &self.saved, SetWhen::Drain),
				None => Ok(()),
			}
		}

		/// Drop without restoring.
		pub fn disarm(mut self) {
			self.fd = None;
		}
	}

	impl Drop for TermiosGuard {
		fn drop(&mut self) {
			let _ = self.restore();
		}
	}

	/// The device of `fd` (`st_rdev`), for telling terminals apart.
	pub(super) fn device(fd: RawFd) -> Option<libc::dev_t> {
		let mut st = MaybeUninit::<libc::stat>::zeroed();
		// SAFETY: fstat writes one stat into the valid pointer.
		if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
			return None;
		}
		// SAFETY: fstat succeeded.
		Some(unsafe { st.assume_init() }.st_rdev)
	}

	#[cfg(test)]
	mod tests {
		use std::os::fd::AsFd;

		use super::*;

		#[test]
		fn termios_round_trips_through_a_pty() {
			let (m, s, name) = open_pty(Some(TtyInfo { rows: 30, cols: 100 })).unwrap();
			assert!(name.starts_with(b"/dev/"), "{name}");
			assert!(is_terminal(s.as_raw_fd()) && is_terminal(m.as_raw_fd()));
			assert_eq!(window_size(s.as_raw_fd()).unwrap(), TtyInfo { rows: 30, cols: 100 });
			set_window_size(m.as_raw_fd(), TtyInfo { rows: 40, cols: 120 }).unwrap();
			assert_eq!(window_size(s.as_raw_fd()).unwrap(), TtyInfo { rows: 40, cols: 120 });
			let before = attrs(s.as_raw_fd()).unwrap();
			assert!(before.get(TermFlag::Icanon) && before.get(TermFlag::Echo));
			assert_eq!(before.char(CtlChar::Intr), Some(3));
			{
				let guard = TermiosGuard::raw(s.as_fd()).unwrap();
				let raw = attrs(s.as_raw_fd()).unwrap();
				assert!(!raw.get(TermFlag::Icanon) && !raw.get(TermFlag::Echo));
				assert!(guard.same_device(s.as_raw_fd()));
				let mut t = raw.clone();
				t.set(TermFlag::Isig, true);
				t.set_char(CtlChar::Intr, Some(7));
				set_attrs(s.as_raw_fd(), &t, SetWhen::Now).unwrap();
				let read = attrs(s.as_raw_fd()).unwrap();
				assert!(read.get(TermFlag::Isig));
				assert_eq!(read.char(CtlChar::Intr), Some(7));
			}
			// BSD kernels set PENDIN when ICANON comes back on: otherwise the
			// restored modes are the saved ones, bit for bit.
			let (mut after, mut before) = (attrs(s.as_raw_fd()).unwrap(), before);
			after.set(TermFlag::Pendin, false);
			before.set(TermFlag::Pendin, false);
			assert_eq!(encode(&to_os(&after)), encode(&to_os(&before)));
			assert!(dup_high(s.as_raw_fd()).unwrap().as_raw_fd() >= 10);
		}
	}
}

/// The process host's [`Terminal`]: this process's real terminals.
///
/// With `restore` set ([`Self::new`]) it puts back, when dropped, the modes
/// the user's terminal (the one on fds 0–2, or the shell's own from
/// [`Terminal::open_controlling`]) had before this host first changed
/// them, so an embedding process gets its terminal back as it was; it
/// always does when dropped during a panic. Ptys the shell opened itself
/// (`zpty`) are never held or restored: their master must see the hang-up
/// when their program ends.
#[derive(Default)]
pub struct NativeTerminal {
	#[cfg(unix)]
	guards:  Vec<TermiosGuard>,
	/// The device of the terminal [`Terminal::open_controlling`] opened.
	#[cfg(unix)]
	shtty:   Option<libc::dev_t>,
	#[cfg_attr(not(unix), expect(dead_code, reason = "nothing to restore off Unix"))]
	restore: bool,
}

impl NativeTerminal {
	/// A terminal host; `restore` puts every terminal's modes back when it
	/// is dropped.
	#[must_use]
	pub const fn new(restore: bool) -> Self {
		Self {
			#[cfg(unix)]
			guards: Vec::new(),
			#[cfg(unix)]
			shtty: None,
			restore,
		}
	}

	/// Whether `fd` is the user's terminal: the shell's own, or the one on
	/// one of the process's standard descriptors.
	#[cfg(unix)]
	fn users_terminal(&self, fd: std::os::fd::RawFd) -> bool {
		let Some(dev) = unix::device(fd) else {
			return false;
		};
		self.shtty == Some(dev) || (0..=2).any(|n| is_terminal(n) && unix::device(n) == Some(dev))
	}
}

#[cfg(unix)]
impl Drop for NativeTerminal {
	fn drop(&mut self) {
		let restore = self.restore || std::thread::panicking();
		for guard in self.guards.drain(..).rev() {
			if restore {
				drop(guard);
			} else {
				guard.disarm();
			}
		}
	}
}

/// The raw descriptor of `h`.
#[cfg(unix)]
fn raw(h: OsHandle) -> io::Result<std::os::fd::RawFd> {
	i32::try_from(h.0).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))
}

#[cfg(unix)]
fn file(fd: std::os::fd::OwnedFd) -> Box<dyn crate::bash::File> {
	Box::new(crate::sys::StdFile::new(std::fs::File::from(fd)))
}

#[cfg(unix)]
impl Terminal for NativeTerminal {
	fn is_terminal(&self, h: OsHandle) -> bool {
		raw(h).is_ok_and(is_terminal)
	}

	fn attrs(&self, h: OsHandle) -> io::Result<Termios> {
		attrs(raw(h)?)
	}

	fn set_attrs(&mut self, h: OsHandle, attrs: &Termios, when: SetWhen) -> io::Result<()> {
		let fd = raw(h)?;
		if self.users_terminal(fd) && !self.guards.iter().any(|g| g.same_device(fd)) {
			// SAFETY: the engine's handle is open for the duration of the call.
			let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
			self.guards.push(TermiosGuard::save(borrowed)?);
		}
		set_attrs(fd, attrs, when)
	}

	fn size(&self, h: OsHandle) -> io::Result<TtyInfo> {
		window_size(raw(h)?)
	}

	fn set_size(&mut self, h: OsHandle, size: TtyInfo) -> io::Result<()> {
		set_window_size(raw(h)?, size)
	}

	fn foreground(&self, h: OsHandle) -> io::Result<i32> {
		foreground(raw(h)?)
	}

	fn set_foreground(&mut self, h: OsHandle, pgid: i32) -> io::Result<()> {
		set_foreground(raw(h)?, pgid)
	}

	fn session(&self, h: OsHandle) -> io::Result<i32> {
		session(raw(h)?)
	}

	fn name(&self, h: OsHandle) -> io::Result<BString> {
		name(raw(h)?)
	}

	fn process_group(&self) -> i32 {
		// SAFETY: getpgrp has no preconditions.
		unsafe { libc::getpgrp() }
	}

	fn set_process_group(&mut self, pid: i32, pgid: i32) -> io::Result<()> {
		// SAFETY: setpgid takes integer ids.
		if unsafe { libc::setpgid(pid, pgid) } == -1 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	fn open_controlling(&mut self) -> io::Result<Option<Shtty>> {
		Ok(open_controlling()?.map(|(fd, name)| {
			use std::os::fd::AsRawFd;
			self.shtty = unix::device(fd.as_raw_fd());
			Shtty { file: file(fd), name }
		}))
	}

	fn open_pty(&mut self, size: Option<TtyInfo>) -> io::Result<Pty> {
		let (master, slave, name) = open_pty(size)?;
		Ok(Pty { master: file(master), slave: file(slave), name })
	}
}

#[cfg(not(unix))]
fn unsupported<T>() -> io::Result<T> {
	Err(io::ErrorKind::Unsupported.into())
}

#[cfg(not(unix))]
impl Terminal for NativeTerminal {
	fn is_terminal(&self, _h: OsHandle) -> bool {
		false
	}

	fn attrs(&self, _h: OsHandle) -> io::Result<Termios> {
		unsupported()
	}

	fn set_attrs(&mut self, _h: OsHandle, _attrs: &Termios, _when: SetWhen) -> io::Result<()> {
		unsupported()
	}

	fn size(&self, _h: OsHandle) -> io::Result<TtyInfo> {
		unsupported()
	}

	fn set_size(&mut self, _h: OsHandle, _size: TtyInfo) -> io::Result<()> {
		unsupported()
	}

	fn foreground(&self, _h: OsHandle) -> io::Result<i32> {
		unsupported()
	}

	fn set_foreground(&mut self, _h: OsHandle, _pgid: i32) -> io::Result<()> {
		unsupported()
	}

	fn session(&self, _h: OsHandle) -> io::Result<i32> {
		unsupported()
	}

	fn name(&self, _h: OsHandle) -> io::Result<BString> {
		unsupported()
	}

	fn process_group(&self) -> i32 {
		0
	}

	fn set_process_group(&mut self, _pid: i32, _pgid: i32) -> io::Result<()> {
		unsupported()
	}

	fn open_controlling(&mut self) -> io::Result<Option<Shtty>> {
		unsupported()
	}

	fn open_pty(&mut self, _size: Option<TtyInfo>) -> io::Result<Pty> {
		unsupported()
	}
}
