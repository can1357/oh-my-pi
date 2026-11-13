//! pi's extra commands ([`pi_builtins::extras`]) as engine commands.
//!
//! [`PiHost::resolve`](crate::host::PiHost) looks a name up in pi's order:
//! the engine's intrinsics (bash's builtins: `echo`, `printf`, `test`, `kill`,
//! `read`, `cd`, …), then pi's tools ([`crate::tools`]: `timeout`, `nohup`,
//! `git`, and the extras that run command lines), then pi's other extras, then
//! `PATH`. A name with a slash is never an extra. `type` and `command -v`
//! report an extra as a shell builtin, as pi does.
//!
//! - Most extras (`cat`, `sort`, `grep`, `sed`, `ps`, `sleep`, …) are
//!   [`Resolved::Native`](crate::bash::Resolved::Native): [`ExtraTask`] runs
//!   [`pi_builtins::extras::run`] on the session's tokio runtime, and the
//!   engine polls it like any command, in pipelines, substitutions and
//!   background jobs alike. A `TERM`, `INT`, `KILL`, `HUP` or `QUIT` cancels
//!   it: pi's status 130 unless the utility owns its cancellation (`rsync`).
//!   Process builtins buffer their output and drain it asynchronously, so
//!   provider-backed engine pipes also work on a current-thread runtime.
//! - The extras that run command lines (`env`, `ifne`, `xargs`, `find`) are
//!   tool calls (`crate::tools`): their commands run in subshells of the
//!   caller.
//! - `suspend` is withheld: it would stop the shell's root until a `SIGCONT`
//!   nobody can send. It resolves to [`SUSPEND`], which says `suspend: not
//!   available in this shell` and fails with status 1. `exec` stays the
//!   engine's: it never replaces pi's process (an external it runs is spawned,
//!   and the run then ends with its status), and its fd-only form (`exec 3>&1`,
//!   `exec >log`) changes only the shell's own fds.
//!
//! **Gates.** pi's switches ([`ExtrasGate`]) are read once, from the
//! environment the session starts with, as pi registers its builtins once per
//! shell: `PI_DISABLE_UUTILS_BUILTINS` hands every utility to `PATH`,
//! `PI_DISABLE_UUTILS_DESTRUCTIVE` the ones that overwrite or delete (`rm`,
//! `mv`, `cp`, `ln`, `dd`, `rsync`, `tar`), and `PI_DISABLE_RM_BUILTIN` /
//! `PI_DISABLE_MV_BUILTIN` one each. Process builtins (`ps`, `sleep`, …) are
//! not gated.
//!
//! **Descriptors.** An engine fd object with an OS handle (a host file or
//! pipe, the session's streams) reaches the extra as a duplicate of that
//! handle ([`Fd::File`]), so the extra reads, polls and seeks it as a process
//! would. Any other object (an in-memory pipeline pipe, a provider file, a
//! session stream with nothing installed) reaches it as a `pi_vfs` provider
//! file ([`Fd::Vfs`]) whose reads and writes poll the engine object: the
//! extra's own reads are the only reads, so nothing is taken ahead of it
//! (`while read -r f; do wc -l "$f"; done` keeps its lines) and output arrives
//! in the pipe as it is written. A closed engine fd is [`Fd::Closed`].

use std::{
	fmt, io,
	io::SeekFrom,
	sync::{Arc, LazyLock, atomic::AtomicBool},
	task::{Context, Poll, Waker},
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;
use pi_builtins::extras::{ExtraKind, Fd, Invocation};
use tokio_util::sync::CancellationToken;

use crate::{
	bash::{EnvView, FdRef, FileKind, NativeRef, OsHandle, Signal, Task},
	tools::ToolConfig,
};

/// The [`NativeRef`] `suspend` resolves to: a refusal.
pub const SUSPEND: NativeRef = NativeRef(u64::MAX);

/// Names of the extras that run as [`ExtraTask`]s, sorted; a [`NativeRef`]
/// is an index into it.
static NATIVE: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
	let mut names: Vec<&'static str> = pi_builtins::extras::extras()
		.filter(|&(_, kind)| native_kind(kind))
		.map(|(name, _)| name)
		.collect();
	names.sort_unstable();
	names
});

/// Whether an extra of `kind` runs as an [`ExtraTask`] (not a tool call).
const fn native_kind(kind: ExtraKind) -> bool {
	matches!(kind, ExtraKind::Utility { runs_commands: false } | ExtraKind::Process)
}

/// The extra a [`NativeRef`] from [`ExtrasGate::native`] names.
pub fn native_name(cmd: NativeRef) -> Option<&'static str> {
	usize::try_from(cmd.0)
		.ok()
		.and_then(|index| NATIVE.get(index).copied())
}

/// Which of pi's extras a shell offers (see the module docs).
///
/// The default offers every extra.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtrasGate {
	/// `PI_DISABLE_UUTILS_BUILTINS`: no utility is an extra.
	pub utilities_off:   bool,
	/// `PI_DISABLE_UUTILS_DESTRUCTIVE`: `rm`, `mv`, `cp`, `ln`, `dd`,
	/// `rsync` and `tar` are the system's.
	pub destructive_off: bool,
	/// `PI_DISABLE_RM_BUILTIN`: `rm` is the system's.
	pub rm_off:          bool,
	/// `PI_DISABLE_MV_BUILTIN`: `mv` is the system's.
	pub mv_off:          bool,
}

impl ExtrasGate {
	/// The gate pi's switches set; `on` says whether the switch variable it
	/// names is on ([`flag_on`](crate::git::flag_on) of its value).
	pub fn from_switches(on: impl Fn(&str) -> bool) -> Self {
		Self {
			utilities_off:   on("PI_DISABLE_UUTILS_BUILTINS"),
			destructive_off: on("PI_DISABLE_UUTILS_DESTRUCTIVE"),
			rm_off:          on("PI_DISABLE_RM_BUILTIN"),
			mv_off:          on("PI_DISABLE_MV_BUILTIN"),
		}
	}

	/// Whether the extra `name` of `kind` is offered.
	pub fn allows(self, name: &str, kind: ExtraKind) -> bool {
		match kind {
			ExtraKind::Utility { .. } => {
				!self.utilities_off
					&& match name {
						"rm" => !(self.destructive_off || self.rm_off),
						"mv" => !(self.destructive_off || self.mv_off),
						// cp, dd (`of=`), rsync and tar -x overwrite files (rsync
						// also deletes with --delete), ln -f clobbers them.
						"cp" | "ln" | "dd" | "rsync" | "tar" => !self.destructive_off,
						_ => true,
					}
			},
			ExtraKind::Process => true,
		}
	}

	/// The offered extra `name` and its kind.
	fn offered(self, name: &BStr) -> Option<(&str, ExtraKind)> {
		let name = name.to_str().ok()?;
		let kind = pi_builtins::extras::kind(name)?;
		self.allows(name, kind).then_some((name, kind))
	}

	/// The [`NativeRef`] of `name` when it is an offered extra that runs as
	/// an [`ExtraTask`].
	pub fn native(self, name: &BStr) -> Option<NativeRef> {
		let (name, kind) = self.offered(name)?;
		if !native_kind(kind) {
			return None;
		}
		let index = NATIVE.binary_search_by(|probe| (*probe).cmp(name)).ok()?;
		u64::try_from(index).ok().map(NativeRef)
	}

	/// Whether `name` is an offered extra that runs command lines (`env`,
	/// `ifne`, `xargs`, `find`).
	pub fn runs_commands(self, name: &BStr) -> bool {
		self
			.offered(name)
			.is_some_and(|(_, kind)| kind == ExtraKind::Utility { runs_commands: true })
	}
}

/// The flag an extra raises when it reports an error yet goes on (jq), for
/// the command in flight; pi-shell keeps such output when minimizing.
///
/// Cheap to clone; clones share the slot, so the session can set it per
/// command for the host and the tool calls at once.
#[derive(Clone, Default)]
pub struct ReportedError(Arc<Mutex<Option<Arc<AtomicBool>>>>);

impl ReportedError {
	/// Hand `flag` to the extras started from now on (`None`: nobody asks).
	pub fn set(&self, flag: Option<Arc<AtomicBool>>) {
		*self.0.lock() = flag;
	}

	/// The flag extras started now raise.
	pub fn get(&self) -> Option<Arc<AtomicBool>> {
		self.0.lock().clone()
	}
}

/// The invocation of an extra with command line `argv` (named by `argv[0]`),
/// environment `env`, working directory `cwd`, descriptors `stdio` and
/// `extra_fds` and the shell's file-creation mask `umask`, on the filesystem
/// and with the reported-error flag of `config`. Not cancellable and without
/// a command runner yet.
pub(crate) fn invocation(
	argv: &[BString],
	env: &EnvView,
	cwd: &BStr,
	stdio: &[FdRef; 3],
	extra_fds: &[(i32, FdRef)],
	umask: u32,
	config: &ToolConfig,
) -> Invocation {
	let argv = argv
		.iter()
		.map(|arg| arg.to_str_lossy().into_owned())
		.collect();
	// Files the extra creates get the shell's `umask`, not the process's.
	let fs = config.filesystem().with_creation_mask(Some(umask));
	let mut invocation = Invocation::new(argv, cwd.to_path_lossy().into_owned(), fs);
	invocation.env = env
		.iter()
		.map(|(name, value)| (name.to_str_lossy().into_owned(), value.to_str_lossy().into_owned()))
		.collect();
	let [stdin, stdout, stderr] = stdio;
	invocation.stdio = [open_fd(stdin, false), open_fd(stdout, true), open_fd(stderr, true)];
	invocation.fds = extra_fds
		.iter()
		.filter(|(_, fd)| fd.is_open())
		.map(|(number, fd)| (*number, open_fd(fd, false)))
		.collect();
	invocation.reported_error = config.reported_error.get();
	invocation
}

/// The descriptor an extra gets for the engine fd object `fd`, as its
/// input or its `output` (see the module docs).
fn open_fd(fd: &FdRef, output: bool) -> Fd {
	if !fd.is_open() {
		return Fd::Closed;
	}
	let handle = if output {
		fd.os_output_handle()
	} else {
		fd.os_handle()
	};
	if let Some(handle) = handle
		&& let Ok(file) = duplicate(handle)
	{
		return Fd::File(file);
	}
	Fd::Vfs(pi_vfs::File::from_handle(FdHandle { fd: Mutex::new(Some(fd.clone())) }))
}

/// A duplicate of the OS handle of an engine fd object, close-on-exec.
#[cfg(unix)]
fn duplicate(handle: OsHandle) -> io::Result<std::fs::File> {
	use std::os::fd::{BorrowedFd, RawFd};
	let raw = RawFd::try_from(handle.0).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
	// SAFETY: the engine object owning `raw` is alive (the caller holds its
	// `FdRef`) for the duration of the borrow, which only duplicates it.
	let fd = unsafe { BorrowedFd::borrow_raw(raw) };
	Ok(std::fs::File::from(fd.try_clone_to_owned()?))
}

#[cfg(windows)]
fn duplicate(handle: OsHandle) -> io::Result<std::fs::File> {
	use std::os::windows::io::BorrowedHandle;
	let addr =
		usize::try_from(handle.0).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
	let raw = std::ptr::with_exposed_provenance_mut::<std::ffi::c_void>(addr);
	// SAFETY: the engine object owning the handle is alive (the caller holds
	// its `FdRef`) for the duration of the borrow, which only duplicates it.
	let borrowed = unsafe { BorrowedHandle::borrow_raw(raw) };
	Ok(std::fs::File::from(borrowed.try_clone_to_owned()?))
}

#[cfg(not(any(unix, windows)))]
fn duplicate(_handle: OsHandle) -> io::Result<std::fs::File> {
	Err(io::ErrorKind::Unsupported.into())
}

/// An engine fd object as a `pi_vfs` provider file: every operation polls
/// the object with the waker of whoever awaits it (a runtime task, or a
/// thread parked in `pi_vfs`'s synchronous I/O).
struct FdHandle {
	/// `None` once closed: the object is released with the last descriptor
	/// of the extra, not when the provider file is collected.
	fd: Mutex<Option<FdRef>>,
}

impl FdHandle {
	fn fd(&self) -> io::Result<FdRef> {
		self.fd.lock().clone().ok_or_else(bad_fd)
	}
}

fn bad_fd() -> io::Error {
	io::Error::other(crate::bash::BadFd)
}

impl fmt::Debug for FdHandle {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("FdHandle").field(&*self.fd.lock()).finish()
	}
}

#[async_trait::async_trait]
impl pi_vfs::FileHandle for FdHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let fd = self.fd()?;
		std::future::poll_fn(|cx| fd.poll_read(cx, buf)).await
	}

	/// A zero-length write never waits: it fails only as a write would (an
	/// engine pipe with no reader left is `BrokenPipe`), which is how an
	/// extra asks whether its reader is gone (`OpenFile::reader_gone`).
	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		let fd = self.fd()?;
		if buf.is_empty() {
			return match fd.poll_write(&mut Context::from_waker(Waker::noop()), buf) {
				Poll::Ready(result) => result,
				Poll::Pending => Ok(0),
			};
		}
		std::future::poll_fn(|cx| fd.poll_write(cx, buf)).await
	}

	async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		self.fd()?.seek(pos)
	}

	async fn metadata(&self) -> io::Result<pi_vfs::Metadata> {
		use pi_vfs::FileKind as Vfs;
		let (kind, mode) = match self.fd()?.kind().ok_or_else(bad_fd)? {
			FileKind::Regular => (Vfs::File, 0o644),
			FileKind::Pipe => (Vfs::Fifo, 0o600),
			FileKind::Tty => (Vfs::CharDevice, 0o620),
			FileKind::Device => (Vfs::CharDevice, 0o666),
			FileKind::Socket => (Vfs::Socket, 0o777),
		};
		Ok(pi_vfs::Metadata::new(
			pi_vfs::FileType::from_kind(kind),
			0,
			pi_vfs::Permissions::from_mode(mode),
		))
	}

	async fn flush(&self) -> io::Result<()> {
		let fd = self.fd()?;
		std::future::poll_fn(|cx| fd.poll_flush(cx)).await
	}

	async fn close(&self) -> io::Result<()> {
		let fd = self.fd.lock().take();
		match fd {
			Some(fd) => std::future::poll_fn(|cx| fd.poll_flush(cx)).await,
			None => Ok(()),
		}
	}
}

/// Where a running extra's exit status lands; wakes whoever polled last.
#[derive(Default)]
pub(crate) struct Done(Mutex<(Option<i32>, Option<Waker>)>);

impl Done {
	/// Record `code`, unless a status is recorded already.
	fn finish(&self, code: i32) {
		let waker = {
			let mut state = self.0.lock();
			if state.0.is_none() {
				state.0 = Some(code);
			}
			state.1.take()
		};
		if let Some(waker) = waker {
			waker.wake();
		}
	}

	/// The status once recorded; otherwise `cx` is woken when it is.
	pub(crate) fn poll(&self, cx: &Context<'_>) -> Poll<i32> {
		let mut state = self.0.lock();
		if let Some(code) = state.0 {
			Poll::Ready(code)
		} else {
			state.1 = Some(cx.waker().clone());
			Poll::Pending
		}
	}
}

/// Records status 1 for an extra whose future ended without a status (it
/// panicked, or the runtime shut down and dropped it).
struct Finish(Arc<Done>);

impl Drop for Finish {
	fn drop(&mut self) {
		self.0.finish(1);
	}
}

/// Run `invocation` on `runtime`; its status lands in the returned [`Done`].
pub(crate) fn spawn(runtime: &tokio::runtime::Handle, invocation: Invocation) -> Arc<Done> {
	let done = Arc::new(Done::default());
	let finish = Finish(Arc::clone(&done));
	drop(runtime.spawn(async move {
		let code = pi_builtins::extras::run(invocation).await;
		finish.0.finish(code);
	}));
	done
}

/// A signal that cancels an extra: those whose default action ends a
/// process (pi's TERM/INT/KILL, and the hangup and quit a job may get).
const fn cancels(sig: Signal) -> bool {
	matches!(sig, Signal::Term | Signal::Int | Signal::Kill | Signal::Hup | Signal::Quit)
}

/// A running extra, as the engine's [`Task`].
///
/// Dropping it (the engine abandoned the command) cancels the extra, which
/// then unwinds on the runtime.
pub struct ExtraTask {
	done:   Arc<Done>,
	cancel: CancellationToken,
}

impl ExtraTask {
	/// Start `invocation` on `runtime`.
	pub(crate) fn start(runtime: &tokio::runtime::Handle, mut invocation: Invocation) -> Self {
		let cancel = CancellationToken::new();
		invocation.cancel = Some(cancel.clone());
		Self { done: spawn(runtime, invocation), cancel }
	}
}

impl Task for ExtraTask {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		self.done.poll(cx)
	}

	fn signal(&mut self, sig: Signal) {
		if cancels(sig) {
			self.cancel.cancel();
		}
	}
}

impl Drop for ExtraTask {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}

/// A builtin pi withholds (`suspend`): says so on stderr, status 1.
pub struct Refusal {
	stderr:  FdRef,
	message: Vec<u8>,
	written: usize,
}

impl Refusal {
	/// The refusal of `name`, reported on `stderr`.
	pub(crate) fn new(name: &[u8], stderr: FdRef) -> Self {
		let mut message = name.to_vec();
		message.extend_from_slice(b": not available in this shell\n");
		Self { stderr, message, written: 0 }
	}
}

impl Task for Refusal {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		while self.written < self.message.len() {
			match self.stderr.poll_write(cx, &self.message[self.written..]) {
				Poll::Ready(Ok(n)) if n > 0 => self.written += n,
				// A closed or failing stderr loses the message.
				Poll::Ready(_) => break,
				Poll::Pending => return Poll::Pending,
			}
		}
		Poll::Ready(1)
	}

	fn signal(&mut self, sig: Signal) {
		if cancels(sig) {
			self.written = self.message.len();
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::git::flag_on;

	#[test]
	fn gates_follow_pis_switches() {
		let gate = |pairs: &'static [(&'static str, &'static str)]| {
			ExtrasGate::from_switches(|name| {
				flag_on(pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| *v))
			})
		};
		let all = ExtrasGate::default();
		assert!(all.native("sort".into()).is_some());
		assert!(all.native("sleep".into()).is_some());
		assert!(all.runs_commands("xargs".into()));
		assert!(all.native("xargs".into()).is_none(), "command runners are tools");
		assert!(all.native("timeout".into()).is_none(), "timeout is a tool");
		assert!(all.native("no-such-extra".into()).is_none());

		let off = gate(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]);
		assert!(off.native("sort".into()).is_none());
		assert!(!off.runs_commands("xargs".into()));
		assert!(off.native("sleep".into()).is_some(), "process builtins are not gated");

		let destructive = gate(&[("PI_DISABLE_UUTILS_DESTRUCTIVE", "true")]);
		for name in ["rm", "mv", "cp", "ln", "dd", "tar"] {
			assert!(destructive.native(name.into()).is_none(), "{name}");
		}
		assert!(destructive.native("cat".into()).is_some());

		let rm = gate(&[("PI_DISABLE_RM_BUILTIN", "1"), ("PI_DISABLE_MV_BUILTIN", "0")]);
		assert!(rm.native("rm".into()).is_none());
		assert!(rm.native("mv".into()).is_some());
	}

	#[test]
	fn native_refs_name_their_extra() {
		let gate = ExtrasGate::default();
		for name in ["cat", "sort", "ps", "sleep", "sg", "ast-grep"] {
			if let Some(cmd) = gate.native(name.into()) {
				assert_eq!(native_name(cmd), Some(name));
			}
		}
		assert_eq!(native_name(SUSPEND), None);
	}
}
