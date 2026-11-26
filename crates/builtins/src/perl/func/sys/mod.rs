//! File, stream, process and system builtins (perlfunc, perlvar, perlop, perlform).

mod argv;
mod file;
mod format;
mod glob;
mod handles;
mod net;
mod output;
mod process;
mod users;

use std::{cell::RefCell, collections::{HashMap, VecDeque}, io, path::PathBuf, rc::{Rc, Weak}};

use crate::perl::{
	ast::{Builtin, Call, Expr, ExprKind},
	interp::{Cx, Interp, PResult, Ret},
	io::{DirHandle, Handle, Io, OpenMode, PipeChild, ReadDeadline, alarm_due},
	value::{PStr, Sv, Value, new_sv},
};

pub(in crate::perl) use self::{
	argv::{finish_argv, readline},
	file::{cache_stat, file_test},
	format::{define_format, format_var, set_format_var},
	glob::{bsd_glob, glob, glob_at},
	handles::{apply_read, by_fd, display_name, fcntl, open_child, remember, replace},
	process::{backticks, register_host_child},
};
#[cfg(unix)]
pub(in crate::perl) use self::{process::logical_ppid, users::resolve_host};
#[cfg(unix)]
pub(in crate::perl) use self::net::{pack_sockaddr, sockaddr_family};

/// Invocation-local state for system builtins, never shared between Perl interpreters.
#[derive(Default)]
pub(in crate::perl) struct State {
	stat: Option<file::CachedStat>,
	dirs: HashMap<usize, (Weak<RefCell<Handle>>, Rc<RefCell<DirHandle>>)>,
	handles: rustc_hash::FxHashMap<usize, handles::KnownHandle>,
	record_buffer: Vec<u8>,
	formats: HashMap<Rc<str>, Rc<format::Definition>>,
	pages: HashMap<usize, (Weak<RefCell<Handle>>, format::Page)>,
	glob_sites: HashMap<glob::Site, VecDeque<Value>>,
	children: HashMap<i32, PipeChild>,
	last_child_id: i32,
	argv_started: bool,
	argv_reset_line: bool,
	argv_select_saved: Option<Io>,
	argv_outer: Vec<argv::Suspended>,
	umask: Option<u32>,
	users: users::State,
}

impl State {
	/// Keep one ordinary-sized allocation from the previous implicit readline assignment.
	pub(in crate::perl) fn recycle_record(&mut self, mut bytes: Vec<u8>) {
		if bytes.capacity() <= 64 * 1024 {
			bytes.clear();
			self.record_buffer = bytes;
		}
	}
}

/// Dispatch the perlfunc intrinsics owned by the system layer.
pub(in crate::perl) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> Option<PResult<Ret>> {
	use Builtin as B;
	Some(match b {
		B::Open | B::Close | B::Binmode | B::Fileno | B::Getc | B::Read | B::Sysread |
		B::Syswrite | B::Sysopen | B::Sysseek | B::Seek | B::Tell | B::Truncate | B::Flock |
		B::Fcntl | B::Ioctl | B::Pipe => handles::call(interp, b, call, cx),
		B::Eof | B::Readline => argv::call(interp, b, call, cx),
		B::Print | B::Printf | B::Say | B::Select => output::call(interp, b, call, cx),
		B::Write | B::Formline => format::call(interp, b, call),
		B::Opendir | B::Readdir | B::Telldir | B::Seekdir | B::Rewinddir | B::Closedir |
		B::Stat | B::Lstat | B::Chdir | B::Chmod | B::Chown | B::Utime | B::Umask | B::Chroot |
		B::Link | B::Symlink | B::Readlink | B::Rename | B::Unlink | B::Mkdir | B::Rmdir => file::call(interp, b, call, cx),
		B::System | B::Exec | B::Readpipe | B::Fork | B::Wait | B::Waitpid | B::Kill | B::Getppid |
		B::Getpgrp | B::Setpgrp | B::Getpriority | B::Setpriority | B::Alarm => process::call(interp, b, call, cx),
		B::Getlogin | B::Getpwnam | B::Getpwuid | B::Getpwent | B::Setpwent | B::Endpwent |
		B::Getgrnam | B::Getgrgid | B::Getgrent | B::Setgrent | B::Endgrent |
		B::Gethostbyname | B::Gethostbyaddr | B::Gethostent | B::Sethostent | B::Endhostent |
		B::Getnetbyname | B::Getnetbyaddr | B::Getnetent | B::Setnetent | B::Endnetent |
		B::Getprotobyname | B::Getprotobynumber | B::Getprotoent | B::Setprotoent | B::Endprotoent |
		B::Getservbyname | B::Getservbyport | B::Getservent | B::Setservent | B::Endservent => users::call(interp, b, call, cx),
		B::Socket | B::Socketpair | B::Connect | B::Bind | B::Listen | B::Accept | B::Shutdown |
		B::Send | B::Recv | B::Getsockopt | B::Setsockopt | B::Getpeername | B::Getsockname => net::call(interp, b, call),
		B::Glob => glob::call(interp, call, cx),
		B::Qx => process::call(interp, B::Readpipe, call, cx),
		B::Msgctl | B::Msgget | B::Msgrcv | B::Msgsnd | B::Semctl | B::Semget | B::Semop |
		B::Shmctl | B::Shmget | B::Shmread | B::Shmwrite | B::Syscall | B::Dbmopen | B::Dbmclose => {
			list(interp, call).map(|_| fail(interp, libc::ENOSYS))
		},
		_ => return None,
	})
}

fn args(call: &Call) -> &[Expr] {
	match call.args.as_deref() {
		Some(Expr { kind: ExprKind::List(es), .. }) => es,
		Some(e) => std::slice::from_ref(e),
		None => &[],
	}
}

fn list(interp: &mut Interp<'_>, call: &Call) -> PResult<Vec<Value>> {
	call.args.as_deref().map_or_else(|| Ok(Vec::new()), |e| interp.eval_list(e))
}

fn tail(interp: &mut Interp<'_>, es: &[Expr]) -> PResult<Vec<Value>> {
	let mut out = Vec::with_capacity(es.len());
	for e in es { out.extend(interp.eval_list(e)?); }
	Ok(out)
}

fn scalar(interp: &mut Interp<'_>, e: Option<&Expr>) -> PResult<Value> {
	e.map_or(Ok(Value::Undef), |e| interp.eval_scalar(e))
}

fn topic(interp: &mut Interp<'_>) -> PResult<Value> { let sv = interp.topic(); interp.read_sv(&sv) }
fn global(interp: &mut Interp<'_>, name: &str) -> PResult<Value> { let sv = interp.sv(name); interp.read_sv(&sv) }
fn set_global(interp: &mut Interp<'_>, name: &str, v: Value) -> PResult<()> { let sv = interp.sv(name); interp.write_sv(&sv, v) }
fn aliases(values: impl IntoIterator<Item = Value>) -> Vec<Sv> { values.into_iter().map(new_sv).collect() }
fn one(v: Value) -> Ret { Ret::One(v) }
fn yes() -> Ret { one(Value::Int(1)) }
fn bool_value(v: bool) -> Value { if v { Value::Int(1) } else { Value::bytes(b"") } }
fn bool_ret(v: bool) -> Ret { one(bool_value(v)) }
fn fail(interp: &mut Interp<'_>, errno: i32) -> Ret { interp.set_errno_code(errno); one(Value::Undef) }
fn errno(interp: &mut Interp<'_>, err: &io::Error) -> Ret { set_io_errno(interp, err); one(Value::Undef) }

fn set_io_errno(interp: &mut Interp<'_>, err: &io::Error) {
	if err.raw_os_error().is_some() {
		interp.set_errno(err);
		return;
	}
	use io::ErrorKind as E;
	interp.set_errno_code(match err.kind() {
		E::NotFound => libc::ENOENT, E::PermissionDenied => libc::EACCES, E::AlreadyExists => libc::EEXIST,
		E::InvalidInput | E::InvalidData => libc::EINVAL, E::BrokenPipe => libc::EPIPE, E::Unsupported => libc::ENOSYS,
		E::Interrupted => libc::EINTR, E::TimedOut => libc::ETIMEDOUT, E::WouldBlock => libc::EAGAIN,
		E::NotSeekable => libc::ESPIPE, E::OutOfMemory => libc::ENOMEM, _ => libc::EIO,
	});
}
fn result<T>(interp: &mut Interp<'_>, r: io::Result<T>, ok: impl FnOnce(T) -> Ret) -> Ret {
	match r { Ok(v) => ok(v), Err(e) => errno(interp, &e) }
}

/// Run a read on `io` that a pending `alarm` may interrupt while it blocks.
/// A handler that returns resumes the read (keeping a partial record), as
/// PerlIO restarts after EINTR; a handler that dies unwinds from the read.
fn interruptible<T>(interp: &mut Interp<'_>, io: &Io, mut op: impl FnMut(&mut Handle) -> io::Result<T>) -> PResult<io::Result<T>> {
	loop {
		let deadline = interp.alarm_deadline().map(|at| ReadDeadline { at, cancel: interp.host().cancel_flag() });
		let armed = deadline.is_some();
		let r = {
			let mut h = io.borrow_mut();
			if !armed { break Ok(op(&mut *h)); }
			h.set_read_deadline(deadline);
			let r = op(&mut *h);
			h.set_read_deadline(None);
			r
		};
		match r {
			Err(err) if alarm_due(&err) => {
				if let Err(flow) = interp.poll_alarm() {
					io.borrow_mut().discard_partial();
					return Err(flow);
				}
			},
			r => break Ok(r),
		}
	}
}

/// Perl refuses names with an embedded NUL before any system call: a
/// "syscalls" warning naming `op`, `$!` = ENOENT. `what` is "pathname" or "pattern".
fn nul_in_name(interp: &mut Interp<'_>, op: &str, what: &str, bytes: &[u8]) -> bool {
	if !bytes.contains(&0) { return false; }
	warn_on(interp, "syscalls", || {
		let shown = String::from_utf8_lossy(bytes).replace('\0', "\\0");
		format!("Invalid \\0 character in {what} for {op}: {shown}")
	});
	interp.set_errno_code(libc::ENOENT);
	true
}

fn path(interp: &Interp<'_>, bytes: &[u8]) -> io::Result<PathBuf> {
	if bytes.is_empty() || bytes.contains(&0) { return Err(io::Error::from_raw_os_error(libc::ENOENT)); }
	Ok(interp.resolve_path(bytes))
}

fn link_path(interp: &mut Interp<'_>, bytes: &[u8]) -> io::Result<PathBuf> {
	if bytes.is_empty() || bytes.contains(&0) { return Err(io::Error::from_raw_os_error(libc::ENOENT)); }
	let bytes = os_str(bytes);
	let path = std::path::Path::new(&*bytes);
	let cwd = interp.resolve_path(b".");
	Ok(interp.host().paths().resolve_link(omp_vfs::absolute_path(&cwd, path)))
}

fn os_str(bytes: &[u8]) -> std::borrow::Cow<'_, std::ffi::OsStr> {
	#[cfg(unix)] { use std::os::unix::ffi::OsStrExt as _; std::borrow::Cow::Borrowed(std::ffi::OsStr::from_bytes(bytes)) }
	#[cfg(not(unix))] {
		match String::from_utf8_lossy(bytes) {
			std::borrow::Cow::Borrowed(s) => std::borrow::Cow::Borrowed(std::ffi::OsStr::new(s)),
			std::borrow::Cow::Owned(s) => std::borrow::Cow::Owned(s.into()),
		}
	}
}

const READ: OpenMode = OpenMode { read: true, write: false, append: false, truncate: false, create: false };
const WRITE: OpenMode = OpenMode { read: false, write: true, ..READ };
#[cfg(unix)]
const READ_WRITE: OpenMode = OpenMode { read: true, write: true, ..READ };

fn bad_fd() -> io::Error { io::Error::from_raw_os_error(libc::EBADF) }

fn io_name(io: &Io) -> usize { Rc::as_ptr(io) as usize }

fn default_layers(interp: &Interp<'_>, mode: OpenMode) -> Option<PStr> {
	interp.hints().open_layers.as_ref().map(|(r, w)| if mode.read { r.clone() } else { w.clone() })
}

fn warn_on(interp: &mut Interp<'_>, category: &str, message: impl FnOnce() -> String) {
	if interp.warn_on(category) { interp.warn_category(category, message()); }
}
