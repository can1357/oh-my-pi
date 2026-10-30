//! Unix domain socket transport.

use std::{
	ffi::OsStr,
	fs::{self, DirBuilder, OpenOptions, Permissions},
	io::{self, IoSlice},
	mem,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd},
		unix::{
			ffi::OsStrExt,
			fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
			net::UnixStream as StdUnixStream,
		},
	},
	path::{Path, PathBuf},
	time::Duration,
};

use tokio::net::{UnixListener, UnixStream};

use super::{IpcError, endpoint};

/// `listen()` backlog.
const BACKLOG: libc::c_int = 512;

/// Effective uid of this process.
pub fn euid() -> u32 {
	// SAFETY: `geteuid` has no preconditions and cannot fail.
	unsafe { libc::geteuid() }
}

/// Errno-style name for a raw OS error.
pub const fn os_error_code(errno: i32) -> Option<&'static str> {
	Some(match errno {
		libc::ENOENT => "ENOENT",
		libc::EACCES => "EACCES",
		libc::EPERM => "EPERM",
		libc::ECONNREFUSED => "ECONNREFUSED",
		libc::ECONNRESET => "ECONNRESET",
		libc::ECONNABORTED => "ECONNABORTED",
		libc::ENOTCONN => "ENOTCONN",
		libc::EADDRINUSE => "EADDRINUSE",
		libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
		libc::EPIPE => "EPIPE",
		libc::ETIMEDOUT => "ETIMEDOUT",
		libc::EAGAIN => "EAGAIN",
		libc::EINTR => "EINTR",
		libc::EINVAL => "EINVAL",
		libc::EEXIST => "EEXIST",
		libc::ENOTDIR => "ENOTDIR",
		libc::EISDIR => "EISDIR",
		libc::ELOOP => "ELOOP",
		libc::ENAMETOOLONG => "ENAMETOOLONG",
		libc::EMFILE => "EMFILE",
		libc::ENFILE => "ENFILE",
		libc::ENOMEM => "ENOMEM",
		libc::ENOSPC => "ENOSPC",
		libc::EROFS => "EROFS",
		libc::ENOTSOCK => "ENOTSOCK",
		libc::EPROTOTYPE => "EPROTOTYPE",
		libc::EMSGSIZE => "EMSGSIZE",
		libc::ENOBUFS => "ENOBUFS",
		libc::EBADF => "EBADF",
		libc::EIO => "EIO",
		_ => return None,
	})
}

/// Unix reports a vanished peer as EOF or an explicit error; neither is an
/// orderly close beyond `read() == 0`.
pub const fn is_orderly_eof(_error: &io::Error) -> bool {
	false
}

/// Socket file this server bound, identified by inode so close never unlinks a
/// successor's socket.
pub struct Bound {
	path: PathBuf,
	dev:  u64,
	ino:  u64,
}

/// Unlink the socket file if it is still the one this server bound.
pub fn release(bound: Bound) {
	if let Ok(meta) = fs::symlink_metadata(&bound.path)
		&& meta.dev() == bound.dev
		&& meta.ino() == bound.ino
	{
		let _ = fs::remove_file(&bound.path);
	}
}

/// Accepting side of a bound socket.
pub struct Listener(UnixListener);

impl Listener {
	/// Next connection whose peer runs as our effective uid.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "shared shape: Windows swaps in its next pending pipe instance"
	)]
	pub async fn accept(&mut self) -> io::Result<Stream> {
		let euid = euid();
		loop {
			let (stream, _) = self.0.accept().await?;
			// Foreign peers are dropped silently; the 0600 socket already keeps
			// them out on any filesystem honoring permissions.
			if stream.peer_cred().is_ok_and(|cred| cred.uid() == euid) {
				return Ok(Stream(stream));
			}
		}
	}
}

/// Bind `endpoint` (see `IpcServer.listen`).
pub async fn listen(endpoint: &str) -> Result<(Listener, Bound), IpcError> {
	let path = PathBuf::from(endpoint);
	let (std_listener, bound) = napi::bindgen_prelude::spawn_blocking(move || bind_locked(path))
		.await
		.map_err(|error| IpcError::new("EIO", format!("bind task failed: {error}")))??;
	let listener = UnixListener::from_std(std_listener)
		.map_err(|error| IpcError::io(&error, "register listener"))?;
	Ok((Listener(listener), bound))
}

fn bind_locked(path: PathBuf) -> Result<(std::os::unix::net::UnixListener, Bound), IpcError> {
	let display = path.display().to_string();
	prepare_parent(&path)?;

	let mut lock_path = path.clone().into_os_string();
	lock_path.push(".bind.lock");
	let lock = OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.mode(0o600)
		.open(&lock_path)
		.map_err(|error| {
			IpcError::io(&error, &format!("open {}", Path::new(&lock_path).display()))
		})?;
	loop {
		match lock.lock() {
			Ok(()) => break,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
			Err(error) => return Err(IpcError::io(&error, "lock bind sidecar")),
		}
	}

	match fs::symlink_metadata(&path) {
		Ok(meta) if !meta.file_type().is_socket() => {
			return Err(IpcError::new("EADDRINUSE", format!("{display} exists and is not a socket")));
		},
		Ok(_) => match StdUnixStream::connect(&path) {
			Ok(_) => {
				return Err(IpcError::new(
					"EADDRINUSE",
					format!("{display} already has a live listener"),
				));
			},
			Err(error)
				if matches!(
					error.kind(),
					io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
				) =>
			{
				match fs::remove_file(&path) {
					Ok(()) => {},
					Err(error) if error.kind() == io::ErrorKind::NotFound => {},
					Err(error) => return Err(IpcError::io(&error, &format!("remove stale {display}"))),
				}
			},
			Err(error) => return Err(IpcError::io(&error, &format!("probe {display}"))),
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(IpcError::io(&error, &format!("stat {display}"))),
	}

	let socket =
		bind_private(&path).map_err(|error| IpcError::io(&error, &format!("bind {display}")))?;
	let meta = fs::symlink_metadata(&path)
		.map_err(|error| IpcError::io(&error, &format!("stat {display}")))?;
	let bound = Bound { path, dev: meta.dev(), ino: meta.ino() };
	// SAFETY: `socket` is a bound AF_UNIX stream socket owned by this frame.
	if unsafe { libc::listen(socket.as_raw_fd(), BACKLOG) } != 0 {
		let error = io::Error::last_os_error();
		release(bound);
		return Err(IpcError::io(&error, &format!("listen {display}")));
	}
	let listener = std::os::unix::net::UnixListener::from(socket);
	if let Err(error) = listener.set_nonblocking(true) {
		release(bound);
		return Err(IpcError::io(&error, "set listener nonblocking"));
	}
	drop(lock);
	Ok((listener, bound))
}

/// Create an `AF_UNIX` stream socket bound at `path` with mode 0600.
///
/// The mode is applied between `bind()` and `listen()`: until `listen()` every
/// connect is refused, so there is no window in which a wider mode is usable.
fn bind_private(path: &Path) -> io::Result<OwnedFd> {
	let address = socket_address(path.as_os_str())?;
	// SAFETY: plain socket(2) call; the result is checked before use.
	let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
	if raw < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `raw` is a fresh descriptor owned by nothing else.
	let socket = unsafe { OwnedFd::from_raw_fd(raw) };
	// SAFETY: `socket` is live; FD_CLOEXEC only affects exec inheritance.
	if unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `address.0` is a fully initialized sockaddr_un and `address.1`
	// is the exact length bind(2) must read from it.
	let status = unsafe {
		libc::bind(socket.as_raw_fd(), (&raw const address.0).cast::<libc::sockaddr>(), address.1)
	};
	if status != 0 {
		return Err(io::Error::last_os_error());
	}
	if let Err(error) = fs::set_permissions(path, Permissions::from_mode(0o600)) {
		let _ = fs::remove_file(path);
		return Err(error);
	}
	Ok(socket)
}

fn socket_address(path: &OsStr) -> io::Result<(libc::sockaddr_un, libc::socklen_t)> {
	// SAFETY: sockaddr_un is plain old data; all-zero is a valid value.
	let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
	let bytes = path.as_bytes();
	if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"socket path does not fit sockaddr_un (use ipcEndpoint)",
		));
	}
	address.sun_family = libc::AF_UNIX as libc::sa_family_t;
	for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
		*slot = *byte as libc::c_char;
	}
	let len = mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
	#[cfg(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	{
		address.sun_len = len as u8;
	}
	Ok((address, len as libc::socklen_t))
}

/// Make sure the socket's parent directory exists (0700 when created). The
/// shared relocation directory must additionally be a real directory owned by
/// us with no group/other access.
fn prepare_parent(path: &Path) -> Result<(), IpcError> {
	let Some(parent) = path.parent().filter(|parent| !parent.is_empty()) else {
		return Ok(());
	};
	let euid = euid();
	if parent == Path::new(&endpoint::relocation_dir(euid)) {
		return ensure_private_dir(parent, euid);
	}
	DirBuilder::new()
		.recursive(true)
		.mode(0o700)
		.create(parent)
		.map_err(|error| IpcError::io(&error, &format!("create {}", parent.display())))
}

fn ensure_private_dir(dir: &Path, euid: u32) -> Result<(), IpcError> {
	match DirBuilder::new().mode(0o700).create(dir) {
		Ok(()) => {},
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
		Err(error) => return Err(IpcError::io(&error, &format!("create {}", dir.display()))),
	}
	let meta = fs::symlink_metadata(dir)
		.map_err(|error| IpcError::io(&error, &format!("stat {}", dir.display())))?;
	if !meta.file_type().is_dir() || meta.uid() != euid {
		return Err(IpcError::new(
			"EACCES",
			format!("{} is not a directory owned by uid {euid}", dir.display()),
		));
	}
	if meta.mode() & 0o077 != 0 {
		fs::set_permissions(dir, Permissions::from_mode(0o700))
			.map_err(|error| IpcError::io(&error, &format!("chmod {}", dir.display())))?;
	}
	Ok(())
}

/// Dial `endpoint` and verify the server runs as our effective uid.
pub async fn connect(endpoint: &str, _timeout: Duration) -> Result<Stream, IpcError> {
	let stream = UnixStream::connect(endpoint)
		.await
		.map_err(|error| IpcError::io(&error, &format!("connect {endpoint}")))?;
	let cred = stream
		.peer_cred()
		.map_err(|error| IpcError::io(&error, "read peer credentials"))?;
	let euid = euid();
	if cred.uid() != euid {
		return Err(IpcError::new(
			"EACCES",
			format!("{endpoint} is served by uid {}, expected {euid}", cred.uid()),
		));
	}
	Ok(Stream(stream))
}

/// How [`Stream::finish_write`] left the stream.
pub enum WriteFinish {
	/// Write side shut; reading continues until EOF.
	HalfClosed,
	/// The whole stream must be dropped now.
	#[allow(dead_code, reason = "Windows-only outcome kept in the shared shape")]
	Closed,
}

/// Connected socket.
pub struct Stream(UnixStream);

impl Stream {
	pub async fn readable(&self) -> io::Result<()> {
		self.0.readable().await
	}

	/// Read into `buf`'s spare capacity without initializing it first.
	pub fn try_read_buf(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		self.0.try_read_buf(buf)
	}

	pub async fn writable(&self) -> io::Result<()> {
		self.0.writable().await
	}

	pub fn try_write_vectored(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
		self.0.try_write_vectored(bufs)
	}

	/// Shut the write half; the peer reads EOF after the queued bytes.
	pub fn finish_write(&self) -> io::Result<WriteFinish> {
		// SAFETY: the descriptor is owned by `self.0` and live for this call.
		if unsafe { libc::shutdown(self.0.as_raw_fd(), libc::SHUT_WR) } != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(WriteFinish::HalfClosed)
	}
}
