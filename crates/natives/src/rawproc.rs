//! Raw child processes for the omp daemon.
//!
//! # Overview
//! The daemon supervises children through plain OS pipe fds so they can be
//! kept across an in-place re-exec ([`exec_replace`]) and re-attached by the
//! new image: [`spawn_raw`] hands out the parent-side pipe ends, [`FdStream`]
//! drives one of them asynchronously, and [`reap_child`] collects the exit
//! status of a direct child (including one inherited across the exec).
//!
//! Bun's own `process.execve` closes every fd above 2, which is why the
//! replacement exec lives here.

use std::{
	collections::{HashMap, VecDeque},
	io,
	pin::pin,
	process::{Command, Stdio},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use napi::{
	Env, Error, JsError, Result, Status,
	bindgen_prelude::{Either, Function, PromiseRaw, Uint8Array},
	threadsafe_function::{
		ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
	},
};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

use crate::task;

/// Unwritten bytes above which [`FdStream::write`] reports backpressure.
const HIGH_WATER_BYTES: usize = 1024 * 1024;
/// Bytes read per wakeup.
const READ_CHUNK: usize = 64 * 1024;

/// JS `Error` whose `code` property is `code`.
fn coded_error(env: &Env, code: &str, message: impl Into<String>) -> Error {
	Error::from(JsError::from(Error::new(code, message.into())).into_unknown(*env))
}

/// Errno-style name for `error` (`"E<n>"` for unnamed values).
fn errno_code(error: &io::Error) -> String {
	#[cfg(unix)]
	if let Some(errno) = error.raw_os_error() {
		let name = match errno {
			libc::EPERM => "EPERM",
			libc::ENOENT => "ENOENT",
			libc::ESRCH => "ESRCH",
			libc::EINTR => "EINTR",
			libc::EIO => "EIO",
			libc::E2BIG => "E2BIG",
			libc::ENOEXEC => "ENOEXEC",
			libc::EBADF => "EBADF",
			libc::ECHILD => "ECHILD",
			libc::ENOMEM => "ENOMEM",
			libc::EACCES => "EACCES",
			libc::EFAULT => "EFAULT",
			libc::ENOTDIR => "ENOTDIR",
			libc::EISDIR => "EISDIR",
			libc::EINVAL => "EINVAL",
			libc::EMFILE => "EMFILE",
			libc::ETXTBSY => "ETXTBSY",
			libc::ENAMETOOLONG => "ENAMETOOLONG",
			libc::ELOOP => "ELOOP",
			libc::ENOSYS => "ENOSYS",
			_ => return format!("E{errno}"),
		};
		return name.to_owned();
	}
	match error.kind() {
		io::ErrorKind::NotFound => "ENOENT".to_owned(),
		io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
		io::ErrorKind::InvalidInput => "EINVAL".to_owned(),
		_ => error
			.raw_os_error()
			.map_or_else(|| "EIO".to_owned(), |code| format!("E{code}")),
	}
}

// --- spawnRaw -------------------------------------------------------------

/// Options for `spawnRaw`.
#[napi(object)]
pub struct SpawnRawOptions {
	/// Executable name or path (resolved against `env.PATH`).
	pub application: String,
	/// Arguments passed to the executable.
	pub args:        Vec<String>,
	/// Complete child environment; nothing is inherited from this process.
	pub env:         HashMap<String, String>,
	/// Working directory of the child.
	pub cwd:         String,
}

/// A child spawned by `spawnRaw`: its pid and the parent-side pipe ends.
///
/// The fds are `CLOEXEC`, nonblocking raw fds (Windows: handle values) owned
/// by the caller.
#[napi(object)]
pub struct RawChild {
	pub pid:    u32,
	pub stdin:  i64,
	pub stdout: i64,
	pub stderr: i64,
}

/// Spawn in its own process group with three pipes; parent-side fds are
/// CLOEXEC raw fds owned by the caller.
#[napi]
pub fn spawn_raw(env: &Env, options: SpawnRawOptions) -> Result<RawChild> {
	let mut command = Command::new(&options.application);
	command
		.args(&options.args)
		.env_clear()
		.envs(&options.env)
		.current_dir(&options.cwd)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;
		command.process_group(0);
	}
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
		const CREATE_NO_WINDOW: u32 = 0x0800_0000;
		command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
	}
	let mut child = command.spawn().map_err(|error| {
		coded_error(env, &errno_code(&error), format!("spawnRaw {}: {error}", options.application))
	})?;
	let pid = child.id();
	let (Some(stdin), Some(stdout), Some(stderr)) =
		(child.stdin.take(), child.stdout.take(), child.stderr.take())
	else {
		return Err(Error::from_reason("spawnRaw: child pipes missing"));
	};
	// Dropping `child` neither kills nor reaps it: `reapChild` collects it.
	drop(child);
	#[cfg(unix)]
	{
		use std::os::fd::IntoRawFd;
		let fds = [stdin.into_raw_fd(), stdout.into_raw_fd(), stderr.into_raw_fd()];
		for fd in fds {
			set_nonblocking(fd).map_err(|error| {
				coded_error(env, &errno_code(&error), format!("spawnRaw nonblocking: {error}"))
			})?;
		}
		Ok(RawChild {
			pid,
			stdin: i64::from(fds[0]),
			stdout: i64::from(fds[1]),
			stderr: i64::from(fds[2]),
		})
	}
	#[cfg(windows)]
	{
		use std::os::windows::io::IntoRawHandle;
		Ok(RawChild {
			pid,
			stdin: stdin.into_raw_handle() as i64,
			stdout: stdout.into_raw_handle() as i64,
			stderr: stderr.into_raw_handle() as i64,
		})
	}
}

#[cfg(unix)]
fn set_nonblocking(fd: i32) -> io::Result<()> {
	// SAFETY: fcntl on a caller-owned fd with scalar arguments.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: as above.
	if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

// --- reapChild ------------------------------------------------------------

/// Exit status of a reaped child.
#[napi(object, use_nullable = true)]
pub struct RawExit {
	/// Exit code when the child exited normally.
	pub exit_code: Option<i32>,
	/// Terminating signal when the child was killed by one (Unix).
	pub signal:    Option<i32>,
}

/// waitpid for a direct child (also one inherited across execReplace).
#[napi(ts_return_type = "Promise<RawExit>")]
pub fn reap_child(env: &Env, pid: i32) -> Result<PromiseRaw<'_, RawExit>> {
	task::future(env, "rawproc.reap_child", async move {
		// Dedicated thread so long-lived child waiters never consume Tokio's
		// bounded blocking pool.
		let (done_tx, done_rx) = tokio::sync::oneshot::channel();
		std::thread::Builder::new()
			.name("pi-reap".into())
			.stack_size(256 * 1024)
			.spawn(move || {
				let _ = done_tx.send(wait_child(pid));
			})
			.map_err(|error| {
				Error::new(Status::GenericFailure, format!("reapChild {pid}: {error}"))
			})?;
		done_rx
			.await
			.map_err(|error| Error::from_reason(format!("reapChild task failed: {error}")))?
			.map_err(|error| Error::new(Status::GenericFailure, format!("reapChild {pid}: {error}")))
	})
}

#[cfg(unix)]
fn wait_child(pid: i32) -> io::Result<RawExit> {
	let mut status = 0;
	loop {
		// SAFETY: blocking waitpid on a specific pid with a valid out pointer.
		let reaped = unsafe { libc::waitpid(pid, &mut status, 0) };
		if reaped == pid {
			break;
		}
		let error = io::Error::last_os_error();
		if error.kind() != io::ErrorKind::Interrupted {
			return Err(error);
		}
	}
	if libc::WIFEXITED(status) {
		Ok(RawExit { exit_code: Some(libc::WEXITSTATUS(status)), signal: None })
	} else if libc::WIFSIGNALED(status) {
		Ok(RawExit { exit_code: None, signal: Some(libc::WTERMSIG(status)) })
	} else {
		Ok(RawExit { exit_code: None, signal: None })
	}
}

#[cfg(windows)]
fn wait_child(pid: i32) -> io::Result<RawExit> {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{
			GetExitCodeProcess, INFINITE, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
			PROCESS_SYNCHRONIZE, WaitForSingleObject,
		},
	};
	let pid = u32::try_from(pid).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
	// SAFETY: OpenProcess takes scalars and returns an owned handle or null.
	let handle =
		unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if handle.is_null() {
		return Err(io::Error::last_os_error());
	}
	let mut code = 0u32;
	// SAFETY: `handle` is the live process handle opened above.
	let ok = unsafe {
		WaitForSingleObject(handle, INFINITE);
		GetExitCodeProcess(handle, &mut code)
	};
	let error = io::Error::last_os_error();
	// SAFETY: closes the handle opened above exactly once.
	unsafe { CloseHandle(handle) };
	if ok == 0 {
		return Err(error);
	}
	Ok(RawExit { exit_code: Some(code as i32), signal: None })
}

// --- execReplace ----------------------------------------------------------

/// execve in place: clears CLOEXEC on keepFds, replaces the image, same PID.
/// Throws ENOSYS on Windows.
///
/// On success this never returns: no JS or native cleanup runs afterwards, so
/// callers flush logs and restore the terminal first. On failure the
/// `CLOEXEC` flags are restored and a JS error whose `code` is the errno name
/// is thrown.
#[napi(ts_return_type = "never")]
#[allow(
	clippy::implicit_hasher,
	reason = "napi marshals a JS object into the default-hasher HashMap"
)]
pub fn exec_replace(
	js_env: &Env,
	path: String,
	argv: Vec<String>,
	env: HashMap<String, String>,
	keep_fds: Vec<i32>,
) -> Result<()> {
	#[cfg(unix)]
	{
		use std::ffi::CString;

		let invalid = |what: &str| coded_error(js_env, "EINVAL", format!("execReplace: {what}"));
		let path = CString::new(path).map_err(|_| invalid("path contains NUL"))?;
		let args = argv
			.into_iter()
			.map(CString::new)
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|_| invalid("argument contains NUL"))?;
		let vars = env
			.into_iter()
			.map(|(key, value)| CString::new(format!("{key}={value}")))
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|_| invalid("environment contains NUL"))?;
		let mut arg_ptrs: Vec<*const libc::c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
		arg_ptrs.push(std::ptr::null());
		let mut env_ptrs: Vec<*const libc::c_char> = vars.iter().map(|var| var.as_ptr()).collect();
		env_ptrs.push(std::ptr::null());

		let mut restore = Vec::with_capacity(keep_fds.len());
		let fail = |restore: &[(i32, i32)], error: io::Error, what: &str| {
			for &(fd, flags) in restore {
				// SAFETY: restores the descriptor flags read below.
				unsafe { libc::fcntl(fd, libc::F_SETFD, flags) };
			}
			coded_error(js_env, &errno_code(&error), format!("execReplace {what}: {error}"))
		};
		for fd in keep_fds {
			// SAFETY: fcntl with scalar arguments; a bad fd reports EBADF.
			let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
			if flags < 0 {
				return Err(fail(&restore, io::Error::last_os_error(), &format!("fd {fd}")));
			}
			// SAFETY: as above.
			if unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
				return Err(fail(&restore, io::Error::last_os_error(), &format!("fd {fd}")));
			}
			restore.push((fd, flags));
		}
		// SAFETY: `path`, `arg_ptrs` and `env_ptrs` are NUL-terminated and point
		// into `args`/`vars`, which outlive the call; execve only returns on
		// failure.
		unsafe { libc::execve(path.as_ptr(), arg_ptrs.as_ptr(), env_ptrs.as_ptr()) };
		Err(fail(&restore, io::Error::last_os_error(), &path.to_string_lossy()))
	}
	#[cfg(not(unix))]
	{
		let _ = (path, argv, env, keep_fds);
		Err(coded_error(js_env, "ENOSYS", "execReplace is unsupported on this platform"))
	}
}

// --- FdStream -------------------------------------------------------------

/// Item delivered to JavaScript through the stream's event sink.
enum Event {
	Chunk(Vec<u8>),
	Close(Option<String>),
	/// The reader stopped for `pause()`: every earlier chunk has been
	/// delivered, so the pause promises resolve.
	Paused(Vec<oneshot::Sender<()>>),
}

/// Ordered event channel into JavaScript.
type EventSink = ThreadsafeFunction<Event, (), (), Status, false>;

/// Nonblocking pipe/pty end registered with the Tokio reactor.
#[cfg(unix)]
struct FdIo(tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>);

#[cfg(unix)]
impl FdIo {
	fn new(fd: i64) -> io::Result<Self> {
		use std::os::fd::{FromRawFd, OwnedFd};
		let raw = i32::try_from(fd).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
		// SAFETY: the caller hands over ownership of `raw`.
		let owned = unsafe { OwnedFd::from_raw_fd(raw) };
		set_nonblocking(raw)?;
		napi::bindgen_prelude::within_runtime_if_available(|| tokio::io::unix::AsyncFd::new(owned))
			.map(Self)
	}

	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		use std::os::fd::AsRawFd;
		loop {
			let mut guard = self.0.readable().await?;
			let result = guard.try_io(|fd| {
				// SAFETY: reads into `buf`, which is valid for `buf.len()` bytes.
				let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
				if n < 0 {
					Err(io::Error::last_os_error())
				} else {
					Ok(n as usize)
				}
			});
			match result {
				Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
				// A pty master reports EIO once the slave side is gone.
				Ok(Err(error)) if error.raw_os_error() == Some(libc::EIO) => return Ok(0),
				Ok(result) => return result,
				Err(_would_block) => {},
			}
		}
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		use std::os::fd::AsRawFd;
		loop {
			let mut guard = self.0.writable().await?;
			let result = guard.try_io(|fd| {
				// SAFETY: writes from `buf`, which is valid for `buf.len()` bytes.
				let n = unsafe { libc::write(fd.as_raw_fd(), buf.as_ptr().cast(), buf.len()) };
				if n < 0 {
					Err(io::Error::last_os_error())
				} else {
					Ok(n as usize)
				}
			});
			match result {
				Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {},
				Ok(result) => return result,
				Err(_would_block) => {},
			}
		}
	}
}

/// Pipe handle driven from blocking threads (anonymous pipes have no
/// overlapped I/O).
#[cfg(windows)]
struct FdIo(Arc<std::fs::File>);

#[cfg(windows)]
impl FdIo {
	#[allow(clippy::unnecessary_wraps, reason = "mirrors the fallible unix constructor")]
	fn new(fd: i64) -> io::Result<Self> {
		use std::os::windows::io::FromRawHandle;
		// SAFETY: the caller hands over ownership of the handle.
		let file = unsafe { std::fs::File::from_raw_handle(fd as isize as *mut std::ffi::c_void) };
		Ok(Self(Arc::new(file)))
	}

	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		use std::io::Read;
		let file = Arc::clone(&self.0);
		let len = buf.len();
		let (n, data) = tokio::task::spawn_blocking(move || {
			let mut data = vec![0u8; len];
			let n = match (&*file).read(&mut data) {
				Ok(n) => n,
				Err(error) if error.kind() == io::ErrorKind::BrokenPipe => 0,
				Err(error) => return Err(error),
			};
			Ok((n, data))
		})
		.await
		.map_err(io::Error::other)??;
		buf[..n].copy_from_slice(&data[..n]);
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		use std::io::Write;
		let file = Arc::clone(&self.0);
		let data = buf.to_vec();
		tokio::task::spawn_blocking(move || (&*file).write(&data))
			.await
			.map_err(io::Error::other)?
	}
}

struct FdShared {
	/// Taken by `close()`; tasks hold their own clones until they stop.
	io:             Mutex<Option<Arc<FdIo>>>,
	frames:         Mutex<VecDeque<Vec<u8>>>,
	queued:         AtomicUsize,
	/// Set by `close()` or a failed write: further writes are dropped.
	closed:         AtomicBool,
	writer_running: AtomicBool,
	started:        AtomicBool,
	write_wake:     Notify,
	drained:        Notify,
	cancel:         CancellationToken,
	reader:         Mutex<ReaderState>,
}

/// Read side of an [`FdStream`], guarded by [`FdShared::reader`].
struct ReaderState {
	/// Kept while the stream can still emit events; dropped with `Close`.
	sink:  Option<Arc<EventSink>>,
	phase: ReadPhase,
}

#[cfg_attr(not(unix), allow(dead_code, reason = "`pause()` never stops the Windows reader"))]
enum ReadPhase {
	/// `start` not called yet.
	Idle,
	/// The read loop runs; cancelling the token pauses it.
	Running(CancellationToken),
	/// `pause()` cancelled the loop; these promises resolve once it stops.
	Pausing(Vec<oneshot::Sender<()>>),
	/// Stopped by `pause()`; the fd stays open and unread bytes stay in the
	/// kernel.
	Paused,
	/// `Close` was emitted.
	Done,
}

/// Why a read loop stopped.
enum ReadExit {
	Paused,
	Close(Option<String>),
}

impl FdShared {
	fn discard(&self) {
		self.frames.lock().clear();
		self.queued.store(0, Ordering::Release);
		self.drained.notify_waiters();
	}
}

/// Async reader/writer over a raw fd (pipe end).
#[napi]
pub struct FdStream {
	shared: Arc<FdShared>,
}

#[napi]
impl FdStream {
	/// Take ownership of `fd` (Windows: a pipe handle value).
	#[napi(constructor)]
	pub fn new(fd: i64) -> Result<Self> {
		let io = FdIo::new(fd).map_err(|error| {
			Error::from_reason(format!("FdStream {fd}: {}: {error}", errno_code(&error)))
		})?;
		Ok(Self {
			shared: Arc::new(FdShared {
				io:             Mutex::new(Some(Arc::new(io))),
				frames:         Mutex::new(VecDeque::new()),
				queued:         AtomicUsize::new(0),
				closed:         AtomicBool::new(false),
				writer_running: AtomicBool::new(false),
				started:        AtomicBool::new(false),
				write_wake:     Notify::new(),
				drained:        Notify::new(),
				cancel:         CancellationToken::new(),
				reader:         Mutex::new(ReaderState { sink: None, phase: ReadPhase::Idle }),
			}),
		})
	}

	/// Begin reading: every chunk goes to `onChunk`, then `onClose` fires once
	/// with `null` on EOF/`close()` or an error message.
	#[napi]
	pub fn start(
		&self,
		env: &Env,
		#[napi(ts_arg_type = "(chunk: Uint8Array) => void")] on_chunk: Function<
			'_,
			Uint8Array,
			UnknownReturnValue,
		>,
		#[napi(ts_arg_type = "(reason: string | null) => void")] on_close: Function<
			'_,
			Option<String>,
			UnknownReturnValue,
		>,
	) -> Result<()> {
		if self.shared.started.swap(true, Ordering::AcqRel) {
			return Err(coded_error(env, "ERR_INVALID_STATE", "FdStream already started"));
		}
		let on_chunk = on_chunk.create_ref()?;
		let on_close = on_close.create_ref()?;
		let dispatcher =
			env.create_function_from_closure::<(), (), _>("fdStreamDispatch", |_| Ok(()))?;
		let sink: EventSink = dispatcher
			.build_threadsafe_function::<Event>()
			.build_callback(move |ctx: ThreadsafeCallContext<Event>| match ctx.value {
				Event::Chunk(chunk) => on_chunk
					.borrow_back(&ctx.env)?
					.call(Uint8Array::from(chunk))
					.map(drop),
				Event::Close(reason) => on_close.borrow_back(&ctx.env)?.call(reason).map(drop),
				Event::Paused(waiters) => {
					for waiter in waiters {
						let _ = waiter.send(());
					}
					Ok(())
				},
			})?;
		let Some(io) = self.shared.io.lock().clone() else {
			sink.call(Event::Close(None), ThreadsafeFunctionCallMode::NonBlocking);
			self.shared.reader.lock().phase = ReadPhase::Done;
			return Ok(());
		};
		let sink = Arc::new(sink);
		let pause = CancellationToken::new();
		{
			let mut reader = self.shared.reader.lock();
			reader.sink = Some(Arc::clone(&sink));
			reader.phase = ReadPhase::Running(pause.clone());
		}
		spawn_reader(Arc::clone(&self.shared), io, sink, pause);
		Ok(())
	}

	/// Stop reading without closing the fd. Resolves once every chunk read
	/// before the pause has been delivered to `onChunk`; unread bytes stay in
	/// the kernel buffer. Writes are unaffected. No-op (resolved) when not
	/// reading (not started, already paused, or closed).
	///
	/// Windows: the blocking pipe read cannot be interrupted without losing its
	/// bytes, so this resolves immediately and reading continues.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn pause<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		#[cfg(unix)]
		let stopped = {
			let mut guard = self.shared.reader.lock();
			let reader = &mut *guard;
			match &mut reader.phase {
				ReadPhase::Running(token) => {
					// The read happens inside `try_io`, so cancelling while the loop
					// awaits readiness consumes nothing.
					token.cancel();
					let (tx, rx) = oneshot::channel();
					reader.phase = ReadPhase::Pausing(vec![tx]);
					Some(rx)
				},
				ReadPhase::Pausing(waiters) => {
					let (tx, rx) = oneshot::channel();
					waiters.push(tx);
					Some(rx)
				},
				ReadPhase::Idle | ReadPhase::Paused | ReadPhase::Done => None,
			}
		};
		#[cfg(not(unix))]
		let stopped: Option<oneshot::Receiver<()>> = None;
		task::future(env, "rawproc.fd_stream.pause", async move {
			if let Some(stopped) = stopped {
				// A dropped sender means the stream went away; nothing is left to
				// deliver either way.
				let _ = stopped.await;
			}
			Ok(())
		})
	}

	/// Restart the read loop after `pause()` with the callbacks given to
	/// `start`. No-op when not paused.
	#[napi]
	pub fn resume(&self) {
		let shared = &self.shared;
		let mut reader = shared.reader.lock();
		if !matches!(reader.phase, ReadPhase::Paused) {
			return;
		}
		let (Some(io), Some(sink)) = (shared.io.lock().clone(), reader.sink.clone()) else {
			return;
		};
		let pause = CancellationToken::new();
		reader.phase = ReadPhase::Running(pause.clone());
		drop(reader);
		spawn_reader(Arc::clone(shared), io, sink, pause);
	}

	/// Queue `data`; false once more than 1 MiB is unwritten (or the stream is
	/// closed).
	#[napi]
	pub fn write(&self, data: Either<String, Uint8Array>) -> bool {
		let shared = &self.shared;
		if shared.closed.load(Ordering::Acquire) {
			return false;
		}
		let bytes = match data {
			Either::A(text) => text.into_bytes(),
			Either::B(bytes) => bytes.to_vec(),
		};
		let len = bytes.len();
		if len == 0 {
			return shared.queued.load(Ordering::Acquire) <= HIGH_WATER_BYTES;
		}
		shared.frames.lock().push_back(bytes);
		let total = shared.queued.fetch_add(len, Ordering::AcqRel) + len;
		shared.write_wake.notify_one();
		if !shared.writer_running.swap(true, Ordering::AcqRel) {
			let io = shared.io.lock().clone();
			if let Some(io) = io {
				napi::bindgen_prelude::spawn(run_writer(Arc::clone(shared), io));
			}
		}
		total <= HIGH_WATER_BYTES
	}

	/// Resolve once every queued byte was written or the stream closed.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn drained<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
		let shared = Arc::clone(&self.shared);
		task::future(env, "rawproc.fd_stream.drained", async move {
			loop {
				let mut notified = pin!(shared.drained.notified());
				notified.as_mut().enable();
				if shared.queued.load(Ordering::Acquire) == 0 || shared.closed.load(Ordering::Acquire) {
					return Ok(());
				}
				notified.await;
			}
		})
	}

	/// Stop reading and writing, drop queued bytes, and close the fd.
	#[napi]
	pub fn close(&self) {
		let shared = &self.shared;
		shared.closed.store(true, Ordering::Release);
		shared.io.lock().take();
		shared.cancel.cancel();
		shared.discard();
		// A running loop emits `Close` itself; a paused one is gone.
		let mut reader = shared.reader.lock();
		if matches!(reader.phase, ReadPhase::Paused) {
			reader.phase = ReadPhase::Done;
			if let Some(sink) = reader.sink.take() {
				sink.call(Event::Close(None), ThreadsafeFunctionCallMode::NonBlocking);
			}
		}
	}
}

/// Deliver chunks read from `io` until EOF, an error, `close()` (all emit
/// `Close`) or `pause` (emits `Paused`, keeps the fd).
fn spawn_reader(
	shared: Arc<FdShared>,
	io: Arc<FdIo>,
	sink: Arc<EventSink>,
	pause: CancellationToken,
) {
	napi::bindgen_prelude::spawn(async move {
		let cancel = shared.cancel.clone();
		let mut buf = vec![0u8; READ_CHUNK];
		let exit = loop {
			tokio::select! {
				biased;
				() = cancel.cancelled() => break ReadExit::Close(None),
				() = pause.cancelled() => break ReadExit::Paused,
				read = io.read(&mut buf) => match read {
					Ok(0) => break ReadExit::Close(None),
					Ok(n) => {
						sink.call(Event::Chunk(buf[..n].to_vec()), ThreadsafeFunctionCallMode::NonBlocking);
					},
					Err(error) => break ReadExit::Close(Some(format!("{}: {error}", errno_code(&error)))),
				},
			}
		};
		drop(io);
		let mut reader = shared.reader.lock();
		// `close()` cancels before taking this lock, so a pause that raced it
		// still ends in `Close`.
		let reason = match exit {
			ReadExit::Paused if !cancel.is_cancelled() => {
				if let ReadPhase::Pausing(waiters) =
					std::mem::replace(&mut reader.phase, ReadPhase::Paused)
				{
					sink.call(Event::Paused(waiters), ThreadsafeFunctionCallMode::NonBlocking);
				}
				return;
			},
			ReadExit::Paused => None,
			ReadExit::Close(reason) => reason,
		};
		let phase = std::mem::replace(&mut reader.phase, ReadPhase::Done);
		reader.sink = None;
		sink.call(Event::Close(reason), ThreadsafeFunctionCallMode::NonBlocking);
		if let ReadPhase::Pausing(waiters) = phase {
			sink.call(Event::Paused(waiters), ThreadsafeFunctionCallMode::NonBlocking);
		}
	});
}

/// Write queued frames in order until closed or the fd fails.
async fn run_writer(shared: Arc<FdShared>, io: Arc<FdIo>) {
	loop {
		let frame = shared.frames.lock().pop_front();
		let Some(frame) = frame else {
			tokio::select! {
				() = shared.cancel.cancelled() => return,
				() = shared.write_wake.notified() => continue,
			}
		};
		let mut offset = 0;
		while offset < frame.len() {
			let written = tokio::select! {
				() = shared.cancel.cancelled() => return,
				written = io.write(&frame[offset..]) => written,
			};
			match written {
				Ok(0) | Err(_) => {
					shared.closed.store(true, Ordering::Release);
					shared.discard();
					return;
				},
				Ok(n) => {
					offset += n;
					if shared.queued.fetch_sub(n, Ordering::AcqRel) == n {
						shared.drained.notify_waiters();
					}
				},
			}
		}
	}
}
