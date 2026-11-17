//! Releases of `XTest` keys and buttons that outlive omp.
//!
//! Each `XTest` call releases what it pressed on success, error and
//! cancellation, but only while omp lives. Xorg keeps an `XTest` key or button
//! down after the client that pressed it is gone (`Xext/xtest.c` has no
//! cleanup), so an omp killed mid-press left the user's Shift or left button
//! held for the whole X session.
//!
//! The session's first `XTest` call that can press therefore spawns a watcher,
//! `/bin/sh` with an X connection of its own, and a memfd holding one 36-byte
//! request per key and button: a `NoOperation` while the input is up, its
//! `XTest` release from just before omp presses it until the server confirms
//! omp's release. The shell waits on a socket omp never writes to, which ends
//! when omp dies or ends the session, then has `cat` copy the memfd to the
//! server: the releases of what omp still held, no-ops for the rest, and a
//! request that makes the server close the connection. It holds the
//! connection until then, because Xorg drops what a client sent but it had
//! not yet read when that client hangs up.
//!
//! `posix_spawn` does not copy omp's address space (glibc before 2.24 does,
//! once per session), so the watcher costs the same whatever omp's size;
//! each press and release then rewrites one byte of the memfd.

use std::{
	borrow::Cow,
	ffi::CString,
	fs::File,
	io::{self, Read as _},
	mem::MaybeUninit,
	net::{Shutdown, TcpStream},
	os::{
		fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
		unix::{
			fs::{FileExt, PermissionsExt},
			net::UnixStream,
		},
	},
	ptr,
	time::{Duration, Instant},
};

use x11rb::{
	connection::{Connection as _, RequestConnection as _},
	protocol::{
		xproto::{
			BUTTON_RELEASE_EVENT, CreateGCAux, CreateGCRequest, Gcontext, KEY_RELEASE_EVENT,
			KillClientRequest, NO_OPERATION_REQUEST, Window,
		},
		xtest,
	},
	reexports::x11rb_protocol::{
		parse_display::parse_display,
		xauth::{Family, get_auth},
	},
	rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
	utils::RawFdContainer,
};

/// One `XTest` key or button, by X keycode or button number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Held {
	Key(u8),
	Button(u8),
}

impl Held {
	/// Where this input's request starts in the memfd: keys by keycode, then
	/// buttons by number.
	fn offset(self) -> u64 {
		let slot = match self {
			Self::Key(code) => u64::from(code),
			Self::Button(code) => 256 + u64::from(code),
		};
		slot * REQUEST_LEN as u64
	}
}

/// Bytes in one `XTest` `FakeInput` request, which its `NoOperation` matches.
const REQUEST_LEN: usize = 36;
/// Where the watcher's `cat` may be. omp's `PATH` comes from the user's shell
/// and is never searched, so the watcher runs no other program of that name.
const CATS: [&str; 2] = ["/bin/cat", "/usr/bin/cat"];
/// How long ending a session waits for its watcher to exit before killing it.
const EXIT_TIMEOUT: Duration = Duration::from_millis(500);
/// How long a pressing call waits for its session's watcher to start: the
/// new X connection, its setup and the shell's line. Past it the session
/// runs without one.
const START_TIMEOUT: Duration = Duration::from_secs(1);
/// How far past the highest descriptor omp has open the watcher's closing
/// reaches where the C library cannot close the rest: room for descriptors
/// other threads open while it starts.
const CLOSE_MARGIN: RawFd = 64;

/// The session's watcher, which sends the memfd's releases to the X server
/// once omp's end of its socket closes.
pub(super) struct ReleaseWatcher {
	/// One request per key and button, which [`Self::pressing`] and
	/// [`Self::released`] switch by their first byte, then [`closing`].
	slots:   File,
	/// `XTest`'s major opcode: the first byte of a release.
	xtest:   u8,
	socket:  UnixStream,
	watcher: libc::pid_t,
}

impl ReleaseWatcher {
	/// Spawns the watcher with its own connection to the X server at the other
	/// end of `x11`, omp's connection to `display` (`DISPLAY` when `None`),
	/// whose root window is `root`. Every wait, on the server's accept queue,
	/// its replies or the shell's line, ends within [`START_TIMEOUT`], so a
	/// start that runs out of time leaves nothing.
	pub(super) fn start(
		x11: BorrowedFd<'_>,
		display: Option<String>,
		root: Window,
	) -> io::Result<Self> {
		let deadline = Instant::now() + START_TIMEOUT;
		let display = parse_display(display.as_deref()).map_err(io::Error::other)?;
		let (stream, (family, address)) = connect(x11, deadline)?;
		// x11rb keeps no copy of the authority omp's connection used, so the
		// file is read again: a local read the deadline does not bound, as
		// omp's own connect does not.
		let (name, data) = get_auth(family, &address, display.display)
			.ok()
			.flatten()
			.unwrap_or_default();
		let conn = RustConnection::connect_to_stream_with_auth_info(
			Deadlined { stream, deadline },
			display.screen.into(),
			name,
			data,
		)
		.map_err(io::Error::other)?;
		let xtest = conn
			.extension_information(xtest::X11_EXTENSION_NAME)
			.map_err(io::Error::other)?
			.ok_or_else(|| io::Error::other("the X server has no XTEST extension"))?
			.major_opcode;
		let gc = conn.generate_id().map_err(io::Error::other)?;
		// x11rb made the socket nonblocking, and `cat` gives up on a read or
		// write that would block instead of waiting for the server.
		let x11 = conn.stream().stream.as_raw_fd();
		// SAFETY: fcntl on an open descriptor with integer arguments.
		let flags = unsafe { libc::fcntl(x11, libc::F_GETFL) };
		// SAFETY: as above.
		if flags == -1 || unsafe { libc::fcntl(x11, libc::F_SETFL, flags & !libc::O_NONBLOCK) } == -1
		{
			return Err(io::Error::last_os_error());
		}
		// The watcher keeps the connection; omp's copy closes with `conn`.
		Self::spawn(x11, xtest, root, gc, deadline)
	}

	/// Spawns a watcher that sends its releases on `x11`, then has the server
	/// close it through the unused id `gc`, once its shell writes its line by
	/// `deadline`.
	fn spawn(
		x11: RawFd,
		xtest: u8,
		root: Window,
		gc: Gcontext,
		deadline: Instant,
	) -> io::Result<Self> {
		// Through the system call, which the glibc omp is built against
		// predates; a kernel without it fails with ENOSYS.
		// SAFETY: memfd_create takes a NUL-terminated name and returns a fresh
		// descriptor or -1.
		let slots = match unsafe {
			libc::syscall(libc::SYS_memfd_create, c"xtest-release".as_ptr(), libc::MFD_CLOEXEC)
		} {
			-1 => return Err(io::Error::last_os_error()),
			// SAFETY: the descriptor is open and owned here alone.
			fd => unsafe { File::from_raw_fd(fd as RawFd) },
		};
		let mut requests: Vec<u8> = (0..=u8::MAX)
			.map(Held::Key)
			.chain((0..=u8::MAX).map(Held::Button))
			.flat_map(|held| {
				let mut request = release(xtest, root, held);
				request[0] = NO_OPERATION_REQUEST;
				request
			})
			.collect();
		requests.extend(closing(root, gc));
		slots.write_all_at(&requests, 0)?;
		let (socket, watched) = UnixStream::pair()?;
		let watcher = spawn_shell(watched.as_raw_fd(), x11, slots.as_raw_fd())?;
		drop(watched);
		let watcher = Self { slots, xtest, socket, watcher };
		// A shell that has not written its line by then is killed, holding
		// nothing, and reaped as the watcher drops. A signal ends the read
		// early, and the next one waits only for what is left.
		let line = loop {
			let read = left(deadline).and_then(|left| {
				watcher.socket.set_read_timeout(Some(left))?;
				(&watcher.socket).read(&mut [0])
			});
			match read {
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				Ok(0) => break Err(io::ErrorKind::UnexpectedEof.into()),
				read => break read,
			}
		};
		match line {
			Ok(_) => Ok(watcher),
			Err(error) => {
				watcher.abandon();
				Err(error)
			},
		}
	}

	/// Whether the watcher is still waiting on its socket: one that died or
	/// was killed closed it.
	pub(super) fn running(&self) -> bool {
		!self.closed(Duration::ZERO)
	}

	/// Arms `held`'s release, before its press goes out.
	pub(super) fn pressing(&self, held: Held) -> io::Result<()> {
		self.slots.write_all_at(&[self.xtest], held.offset())
	}

	/// Disarms `held`'s release, after the server confirmed it. A watcher
	/// that sends it anyway, because omp died in between, sends a release the
	/// server drops for an input that is not down.
	pub(super) fn released(&self, held: Held) -> io::Result<()> {
		self
			.slots
			.write_all_at(&[NO_OPERATION_REQUEST], held.offset())
	}

	/// Ends the watcher without sending the memfd, which no longer says
	/// what is down.
	pub(super) fn abandon(self) {
		if !self.closed(Duration::ZERO) {
			// SAFETY: kill takes integers only; the group's id names the
			// watcher's group alone, as in `drop`.
			unsafe { libc::kill(-self.watcher, libc::SIGKILL) };
		}
	}

	/// Whether every process of the watcher's has closed its copy of the
	/// socket, which they hold until they exit, within `timeout`.
	fn closed(&self, timeout: Duration) -> bool {
		let mut hangup =
			libc::pollfd { fd: self.socket.as_raw_fd(), events: libc::POLLIN, revents: 0 };
		let deadline = Instant::now() + timeout;
		loop {
			let left = deadline.saturating_duration_since(Instant::now());
			let timeout = libc::c_int::try_from(left.as_millis()).unwrap_or(libc::c_int::MAX);
			// SAFETY: one valid pollfd for the duration of the call.
			match unsafe { libc::poll(&raw mut hangup, 1, timeout) } {
				1 => return true,
				-1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => {},
				_ => return false,
			}
		}
	}
}

impl Drop for ReleaseWatcher {
	fn drop(&mut self) {
		// Ending the socket makes the watcher send the memfd, only no-ops
		// after calls that released everything, and exit once the server
		// closes its connection. One that has not exited in time (stopped,
		// or on a server that stopped reading) is killed with its `cat`, so
		// the session's end never waits on it for long.
		let _ = self.socket.shutdown(Shutdown::Write);
		if !self.closed(EXIT_TIMEOUT) {
			// SAFETY: kill takes integers only. The watcher leads its group,
			// and its pid, the group's id, stays its own until the waitpid
			// below: omp reaps only children it started, and `spawn_shell`
			// starts none where SIGCHLD would reap them.
			unsafe { libc::kill(-self.watcher, libc::SIGKILL) };
		}
		// Every process of the group has exited or been killed.
		// SAFETY: waitpid on this code's own child, with a null status
		// pointer and no flags.
		while unsafe { libc::waitpid(self.watcher, ptr::null_mut(), 0) } == -1
			&& io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
		{}
	}
}

/// The start's X stream, whose waits for the server end at `deadline`.
struct Deadlined {
	stream:   DefaultStream,
	deadline: Instant,
}

impl Stream for Deadlined {
	fn poll(&self, mode: PollMode) -> io::Result<()> {
		let events = match mode {
			PollMode::Readable => libc::POLLIN,
			PollMode::Writable => libc::POLLOUT,
			PollMode::ReadAndWritable => libc::POLLIN | libc::POLLOUT,
		};
		let mut ready = libc::pollfd { fd: self.stream.as_raw_fd(), events, revents: 0 };
		loop {
			let timeout =
				libc::c_int::try_from(left(self.deadline)?.as_millis()).unwrap_or(libc::c_int::MAX);
			// SAFETY: one valid pollfd for the duration of the call.
			match unsafe { libc::poll(&raw mut ready, 1, timeout) } {
				0 => return Err(io::ErrorKind::TimedOut.into()),
				-1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => {},
				-1 => return Err(io::Error::last_os_error()),
				_ => return Ok(()),
			}
		}
	}

	fn read(&self, buf: &mut [u8], fd_storage: &mut Vec<RawFdContainer>) -> io::Result<usize> {
		self.stream.read(buf, fd_storage)
	}

	fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
		self.stream.write(buf, fds)
	}
}

/// A new connection to the server at the other end of `x11`, made by
/// `deadline`. Its address is `x11`'s peer, so no host name is looked up.
fn connect(
	x11: BorrowedFd<'_>,
	deadline: Instant,
) -> io::Result<(DefaultStream, (Family, Vec<u8>))> {
	// SAFETY: sockaddr_storage is plain data, valid zeroed.
	let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
	let mut length = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
	// SAFETY: getpeername writes at most `length` bytes of `address`, and
	// how many it wrote to `length`.
	if unsafe { libc::getpeername(x11.as_raw_fd(), (&raw mut address).cast(), &raw mut length) }
		== -1
	{
		return Err(io::Error::last_os_error());
	}
	match libc::c_int::from(address.ss_family) {
		libc::AF_UNIX => DefaultStream::from_unix_stream(connect_to(
			&address,
			length,
			UnixStream::set_write_timeout,
			deadline,
		)?),
		libc::AF_INET | libc::AF_INET6 => DefaultStream::from_tcp_stream(connect_to(
			&address,
			length,
			TcpStream::set_write_timeout,
			deadline,
		)?),
		_ => Err(io::Error::other("omp's X connection is neither a Unix nor a TCP socket")),
	}
}

/// A socket connected to the first `length` bytes of `address` by
/// `deadline`, through `send_timeout`: Linux ends a connect waiting for room
/// in the accept queue, or for a TCP handshake, once the send timeout passes.
fn connect_to<S: From<OwnedFd> + AsRawFd>(
	address: &libc::sockaddr_storage,
	length: libc::socklen_t,
	send_timeout: fn(&S, Option<Duration>) -> io::Result<()>,
	deadline: Instant,
) -> io::Result<S> {
	let family = libc::c_int::from(address.ss_family);
	// SAFETY: socket takes integers and returns a fresh descriptor or -1.
	let socket = match unsafe { libc::socket(family, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) } {
		-1 => return Err(io::Error::last_os_error()),
		// SAFETY: the descriptor is open and owned here alone.
		fd => S::from(unsafe { OwnedFd::from_raw_fd(fd) }),
	};
	send_timeout(&socket, Some(left(deadline)?))?;
	// SAFETY: connect reads the first `length` bytes of `address`.
	if unsafe { libc::connect(socket.as_raw_fd(), ptr::from_ref(address).cast(), length) } == -1 {
		return Err(io::Error::last_os_error());
	}
	send_timeout(&socket, None)?;
	Ok(socket)
}

/// The time left until `deadline`, or a timeout once none is.
fn left(deadline: Instant) -> io::Result<Duration> {
	deadline
		.checked_duration_since(Instant::now())
		.filter(|left| !left.is_zero())
		.ok_or_else(|| io::ErrorKind::TimedOut.into())
}

/// The `XTest` release of `held` on `root`.
fn release(xtest: u8, root: Window, held: Held) -> [u8; REQUEST_LEN] {
	let (type_, detail) = match held {
		Held::Key(code) => (KEY_RELEASE_EVENT, code),
		Held::Button(code) => (BUTTON_RELEASE_EVENT, code),
	};
	let ([request], _) = xtest::FakeInputRequest {
		type_,
		detail,
		time: x11rb::CURRENT_TIME,
		root,
		root_x: 0,
		root_y: 0,
		deviceid: 0,
	}
	.serialize(xtest);
	let mut bytes = [0; REQUEST_LEN];
	bytes.copy_from_slice(&request);
	bytes
}

/// A GC `gc` on `root` and the `KillClient` of it, which closes the
/// connection that created it once the server has read everything before.
fn closing(root: Window, gc: Gcontext) -> Vec<u8> {
	let (create, _) = CreateGCRequest {
		cid:        gc,
		drawable:   root,
		value_list: Cow::Owned(CreateGCAux::new()),
	}
	.serialize();
	let (kill, _) = KillClientRequest { resource: gc }.serialize();
	create
		.iter()
		.chain(&kill)
		.flat_map(|part| part.iter().copied())
		.collect()
}

/// Spawns the watcher: `/bin/sh` with `socket` as its input, `x11` as its
/// output, `slots` as descriptor 3 and no other descriptor of omp's, an empty
/// environment, its complaints (such as a server already gone) discarded,
/// and a process group of its own, so a terminal's Ctrl+C, Ctrl+Z or hangup
/// reaches omp alone.
fn spawn_shell(socket: RawFd, x11: RawFd, slots: RawFd) -> io::Result<libc::pid_t> {
	// Ending the watcher signals its group and waits for it by pid, which
	// stays its own only while its exit leaves a zombie for that wait; an
	// omp whose SIGCHLD reaps children at once gets no watcher.
	let mut sigchld = MaybeUninit::<libc::sigaction>::uninit();
	// SAFETY: with no new action, sigaction only writes the current one.
	if unsafe { libc::sigaction(libc::SIGCHLD, ptr::null(), sigchld.as_mut_ptr()) } == -1 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: sigaction succeeded, so it wrote the whole struct.
	let sigchld = unsafe { sigchld.assume_init() };
	if sigchld.sa_sigaction == libc::SIG_IGN || sigchld.sa_flags & libc::SA_NOCLDWAIT != 0 {
		return Err(io::Error::other("omp's children are reaped at once"));
	}
	let cat = CATS
		.into_iter()
		.find(|cat| {
			std::fs::metadata(cat)
				.is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
		})
		.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no /bin/cat or /usr/bin/cat"))?;
	// The shell ignores the signals sent to end a hung omp, so it ends with
	// its socket instead, keeps a copy of the socket on descriptor 4 for
	// itself and its `cat`s until they exit, and writes a line back on it,
	// which tells omp it started. `read` waits for the socket to end, `cat`
	// sends the memfd on the X connection, and the last `cat` reads that
	// connection until the server closes it.
	let script = CString::new(format!(
		"trap '' HUP INT TERM QUIT; exec 4<&0; echo >&0; read -r _; {cat} <&3; exec {cat} <&1 \
		 >/dev/null"
	))?;
	// Copies above the descriptors the watcher gets, so no copy into 0, 1 or
	// 3 overwrites a source a later one still needs.
	let high = |fd: RawFd| {
		// SAFETY: fcntl on an open descriptor with integer arguments.
		match unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) } {
			-1 => Err(io::Error::last_os_error()),
			// SAFETY: the copy is open and owned here alone.
			copy => Ok(unsafe { OwnedFd::from_raw_fd(copy) }),
		}
	};
	let (socket, x11, slots) = (high(socket)?, high(x11)?, high(slots)?);
	// glibc 2.34 closes the rest in the child. Elsewhere (older glibc, musl)
	// the child closes every descriptor from 4 to [`closes_through`], so also
	// those other threads open before the spawn; a host that cannot list
	// them gets no watcher.
	// SAFETY: dlsym takes a NUL-terminated name; the symbol, where present,
	// has this signature.
	let close_from = unsafe {
		let symbol =
			libc::dlsym(libc::RTLD_DEFAULT, c"posix_spawn_file_actions_addclosefrom_np".as_ptr());
		(!symbol.is_null()).then(|| {
			std::mem::transmute::<
				*mut libc::c_void,
				unsafe extern "C" fn(*mut libc::posix_spawn_file_actions_t, libc::c_int) -> libc::c_int,
			>(symbol)
		})
	};
	let close_through: RawFd = if close_from.is_some() {
		3
	} else {
		let highest = std::fs::read_dir("/proc/self/fd")?
			.map(|fd| {
				fd?.file_name()
					.to_str()
					.and_then(|fd| fd.parse().ok())
					.ok_or_else(|| io::Error::other("unreadable /proc/self/fd entry"))
			})
			.try_fold(3, |highest, fd| fd.map(|fd: RawFd| highest.max(fd)))?;
		// SAFETY: sysconf takes an integer.
		closes_through(highest, unsafe { libc::sysconf(libc::_SC_OPEN_MAX) })
	};
	let argv = [c"sh".as_ptr(), c"-c".as_ptr(), script.as_ptr(), ptr::null()];
	let env = [ptr::null::<libc::c_char>()];
	let mut watcher = 0;
	let mut actions = MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
	let mut attr = MaybeUninit::<libc::posix_spawnattr_t>::uninit();
	let mut no_signals = MaybeUninit::<libc::sigset_t>::uninit();
	let (actions, attr) = (actions.as_mut_ptr(), attr.as_mut_ptr());
	let no_signals = no_signals.as_mut_ptr();
	// SAFETY: each struct is initialised by its init call before any other
	// use and destroyed once; every string is NUL-terminated and outlives the
	// spawn, and both vectors end in a null pointer.
	unsafe {
		libc::posix_spawn_file_actions_init(actions);
		libc::posix_spawnattr_init(attr);
		libc::sigemptyset(no_signals);
		let prepared = [
			libc::posix_spawn_file_actions_adddup2(actions, socket.as_raw_fd(), 0),
			libc::posix_spawn_file_actions_adddup2(actions, x11.as_raw_fd(), 1),
			libc::posix_spawn_file_actions_addopen(
				actions,
				2,
				c"/dev/null".as_ptr(),
				libc::O_WRONLY,
				0,
			),
			libc::posix_spawn_file_actions_adddup2(actions, slots.as_raw_fd(), 3),
			close_from.map_or(0, |close_from| close_from(actions, 4)),
			// No signal blocked in the shell, whatever this thread's mask.
			// glibc before 2.24 forks for a spawn with file actions: once per
			// session, and vfork, its alternative there, would run omp's
			// signal handlers in omp's memory until the exec.
			libc::posix_spawnattr_setflags(
				attr,
				(libc::POSIX_SPAWN_SETPGROUP | libc::POSIX_SPAWN_SETSIGMASK) as libc::c_short,
			),
			libc::posix_spawnattr_setpgroup(attr, 0),
			libc::posix_spawnattr_setsigmask(attr, no_signals),
		];
		let closes =
			(4..=close_through).map(|fd| libc::posix_spawn_file_actions_addclose(actions, fd));
		let spawned = match prepared.into_iter().chain(closes).find(|&error| error != 0) {
			Some(error) => error,
			None => libc::posix_spawn(
				&raw mut watcher,
				c"/bin/sh".as_ptr(),
				actions,
				attr,
				argv.as_ptr().cast(),
				env.as_ptr().cast(),
			),
		};
		libc::posix_spawn_file_actions_destroy(actions);
		libc::posix_spawnattr_destroy(attr);
		match spawned {
			0 => Ok(watcher),
			error => Err(io::Error::from_raw_os_error(error)),
		}
	}
}

/// The last descriptor the watcher's child closes where the C library cannot
/// close the rest: [`CLOSE_MARGIN`] past `highest`, the highest omp has open,
/// up to the descriptor limit `open_max`, which no new descriptor reaches and
/// glibc refuses to close at or past. A `highest` past the limit, opened
/// before it was lowered, is still included: glibc's refusal then fails the
/// spawn rather than leaving it open in the watcher.
fn closes_through(highest: RawFd, open_max: libc::c_long) -> RawFd {
	let through = highest.saturating_add(CLOSE_MARGIN);
	match RawFd::try_from(open_max - 1) {
		Ok(last) if open_max > 0 => through.min(last).max(highest),
		_ => through,
	}
}

#[cfg(test)]
mod tests {
	use std::os::{
		fd::{AsFd as _, AsRawFd as _},
		linux::net::SocketAddrExt as _,
		unix::net::{SocketAddr, UnixListener, UnixStream},
	};

	use super::{ReleaseWatcher, closes_through};

	/// A server whose accept queue stays full: the start gives up instead of
	/// waiting for room.
	#[test]
	fn a_start_gives_up_on_a_server_whose_accept_queue_stays_full() {
		let name = format!("pi-natives-release-watcher-{}", std::process::id());
		let listener =
			UnixListener::bind_addr(&SocketAddr::from_abstract_name(name).unwrap()).unwrap();
		// SAFETY: listen on an open socket with an integer backlog.
		assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
		// omp's connection, the one connection a backlog of 0 holds.
		let x11 = UnixStream::connect_addr(&listener.local_addr().unwrap()).unwrap();
		assert!(ReleaseWatcher::start(x11.as_fd(), Some(":0".into()), 0).is_err());
	}

	/// Closing stops at the descriptor limit, except to reach a descriptor
	/// opened before the limit was lowered.
	#[test]
	fn closing_reaches_a_descriptor_above_a_lowered_limit() {
		assert_eq!(closes_through(20, 64), 63);
		assert_eq!(closes_through(256, 64), 256);
	}
}
