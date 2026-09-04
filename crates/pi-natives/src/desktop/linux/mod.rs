pub mod ax;
pub mod wayland;
pub mod x11;

use std::{ffi::OsStr, mem::MaybeUninit, os::unix::net::UnixStream, path::Path};

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	let wayland = wayland_reachable(
		std::env::var_os("WAYLAND_SOCKET").as_deref(),
		std::env::var_os("WAYLAND_DISPLAY").as_deref(),
		std::env::var_os("XDG_RUNTIME_DIR").as_deref(),
	);
	if wayland {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server reachable (no Wayland socket and DISPLAY is not set)",
	))
}

/// Check for a Wayland compositor the way libwayland connects. A valid
/// `WAYLAND_SOCKET` is an inherited socket descriptor. Otherwise an absolute
/// `WAYLAND_DISPLAY` is the socket path and a relative one lives under
/// `XDG_RUNTIME_DIR`, and something has to accept a connection there. A stale
/// name, an orphaned socket file, an empty value, or a descriptor that is
/// closed or not a socket cannot hide a live X11 display.
fn wayland_reachable(
	socket_fd: Option<&OsStr>,
	display: Option<&OsStr>,
	runtime_dir: Option<&OsStr>,
) -> bool {
	if socket_fd.is_some_and(is_socket_fd) {
		return true;
	}
	let Some(display) = display.filter(|display| !display.is_empty()) else {
		return false;
	};
	let display = Path::new(display);
	if display.is_absolute() {
		return UnixStream::connect(display).is_ok();
	}
	runtime_dir
		.is_some_and(|runtime_dir| UnixStream::connect(Path::new(runtime_dir).join(display)).is_ok())
}

/// libwayland parses `WAYLAND_SOCKET` as a whole-string integer and rejects
/// descriptors that are not open. Requiring a socket as well rules out numbers
/// that happen to name some other open file.
fn is_socket_fd(value: &OsStr) -> bool {
	let Some(fd) = value
		.to_str()
		.and_then(|value| value.parse::<libc::c_int>().ok())
	else {
		return false;
	};
	let mut stat = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `fstat` only writes through the out-pointer and reports EBADF for
	// a closed or negative descriptor; nothing here takes ownership of `fd`.
	if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
		return false;
	}
	// SAFETY: a zero return from `fstat` means the struct was fully written.
	let stat = unsafe { stat.assume_init() };
	stat.st_mode & libc::S_IFMT == libc::S_IFSOCK
}

#[cfg(test)]
mod tests {
	use std::{
		ffi::OsString,
		fs::File,
		os::{
			fd::AsRawFd,
			unix::{fs::FileTypeExt, net::UnixListener},
		},
		path::PathBuf,
	};

	use super::*;

	struct RuntimeDir(PathBuf);

	impl RuntimeDir {
		fn new(test: &str) -> Self {
			let path = std::env::temp_dir().join(format!("omp-wayland-{test}-{}", std::process::id()));
			let _ = std::fs::remove_dir_all(&path);
			std::fs::create_dir_all(&path).expect("create runtime dir");
			Self(path)
		}

		fn as_os_str(&self) -> &OsStr {
			self.0.as_os_str()
		}
	}

	impl Drop for RuntimeDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	fn os(value: &str) -> OsString {
		OsString::from(value)
	}

	#[test]
	fn ignores_wayland_display_without_listener() {
		let runtime = RuntimeDir::new("no-listener");
		std::fs::write(runtime.0.join("plain-file"), b"").expect("write file");
		let orphan = runtime.0.join("orphan");
		drop(UnixListener::bind(&orphan).expect("bind socket"));
		assert!(
			std::fs::metadata(&orphan)
				.expect("orphan socket file")
				.file_type()
				.is_socket(),
			"dropping the listener must leave the socket inode behind"
		);

		assert!(!wayland_reachable(None, None, Some(runtime.as_os_str())));
		assert!(!wayland_reachable(None, Some(&os("")), Some(runtime.as_os_str())));
		assert!(!wayland_reachable(None, Some(&os("wayland-0")), Some(runtime.as_os_str())));
		assert!(!wayland_reachable(None, Some(&os("wayland-0")), None));
		assert!(!wayland_reachable(None, Some(&os("plain-file")), Some(runtime.as_os_str())));
		assert!(!wayland_reachable(None, Some(&os("orphan")), Some(runtime.as_os_str())));
		assert!(!wayland_reachable(None, Some(orphan.as_os_str()), None));
	}

	#[test]
	fn accepts_relative_socket_under_runtime_dir() {
		let runtime = RuntimeDir::new("relative");
		let _listener = UnixListener::bind(runtime.0.join("wayland-0")).expect("bind socket");

		assert!(wayland_reachable(None, Some(&os("wayland-0")), Some(runtime.as_os_str())));
	}

	#[test]
	fn accepts_absolute_socket_path() {
		let runtime = RuntimeDir::new("absolute");
		let socket = runtime.0.join("compositor.sock");
		let _listener = UnixListener::bind(&socket).expect("bind socket");

		assert!(wayland_reachable(None, Some(socket.as_os_str()), None));
	}

	#[test]
	fn accepts_inherited_wayland_socket_fd() {
		let (socket, _peer) = UnixStream::pair().expect("socketpair");

		assert!(wayland_reachable(Some(&os(&socket.as_raw_fd().to_string())), None, None));
	}

	#[test]
	fn ignores_invalid_wayland_socket_fd() {
		let runtime = RuntimeDir::new("bad-fd");
		let file = File::create(runtime.0.join("plain-file")).expect("create file");
		let (socket, _peer) = UnixStream::pair().expect("socketpair");
		// Park the duplicate above the range the rest of the test process
		// allocates from, so the number stays closed once it is closed.
		// SAFETY: duplicates a descriptor owned by `socket`; the copy is closed
		// below and nothing else references it.
		let closed = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 512) };
		assert!(closed >= 512, "dup failed: {}", std::io::Error::last_os_error());
		// SAFETY: `closed` is the duplicate created above.
		assert_eq!(unsafe { libc::close(closed) }, 0);

		for value in ["", " ", "x", "3x", "-1", &closed.to_string(), &file.as_raw_fd().to_string()] {
			assert!(!wayland_reachable(Some(&os(value)), None, None), "WAYLAND_SOCKET={value:?}");
		}
	}
}
