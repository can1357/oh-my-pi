//! `Fs` and `File` over `std::fs`.
//!
//! Every operation is a local syscall and returns `Ready`, except opening a
//! FIFO for reading or for writing only: that waits for the other end, so it
//! returns `Pending` and a helper thread performs the open (dropping the
//! pending open releases the helper).
//!
//! Reads and writes on pipes, FIFOs, sockets and terminals never wait in the
//! kernel on Unix: the other end may be a vproc of the same engine (a FIFO, a
//! `/dev/fd/N` of a process substitution), and a terminal read must not stop
//! the scheduler (`read -t` timers, other vprocs). [`StdFile`] checks
//! readiness first and returns `Pending` with the waker registered on the
//! shared readiness thread (`ready`); the descriptor's flags stay untouched,
//! since externals inherit them. Windows pipes and consoles keep blocking
//! I/O (anonymous pipes cannot be polled).
//!
//! Windows specifics: `test -x` holds for directories, files with a
//! `PATHEXT` extension and files starting with `#!`; process substitution
//! uses a named pipe `\\.\pipe\obash-<pid>-<n>` (a regular temp file when
//! the engine asks for [`TempPurpose::HereDoc`], e.g. for a consumer that
//! must seek).

use std::{
	cell::RefCell,
	fs::{self, OpenOptions},
	io::{self, IsTerminal, Read, Seek, Write},
	path::Path,
	sync::atomic::{AtomicU32, Ordering},
	task::{Context, Poll},
	time::UNIX_EPOCH,
};

use bstr::{BStr, BString, ByteSlice};

use crate::bash::{
	DirEntry, DirIter, File, FileKind, Fs, FsPoll, OpenFlags, OsHandle, Stat, StdFd,
	fs::{Access, StatKind, TempNode, TempPurpose},
};

/// `Fs` over the host filesystem.
#[derive(Clone, Copy, Debug, Default)]
pub struct StdFs {
	/// The process's file-creation mask, when nothing changes it while this
	/// filesystem is in use (obash reads it once at startup; an embedding
	/// process may change its mask at any time and leaves this `None`). A
	/// create whose mode the mask leaves intact then takes a single `open`
	/// instead of an exclusive-create probe first ([`create_with_mode`]).
	pub umask: Option<u32>,
}

/// A host file, pipe or terminal as an engine [`File`].
#[derive(Debug)]
pub struct StdFile {
	/// Pending readiness waits (pipes, sockets, terminals), one for reading
	/// and one for writing: a terminal the line editor reads keys from is
	/// written to meanwhile (job notices, the display), which must not
	/// drop the read wait. Declared first so they are dropped, and
	/// forgotten by the waiting thread, before `file` closes.
	#[cfg(unix)]
	watch:  [Option<crate::sys::ready::Watch>; 2],
	file:   fs::File,
	kind:   FileKind,
	/// Access mode of the open file description (`O_ACCMODE` bits of
	/// `F_GETFL`; `None` when unknown).
	#[cfg(unix)]
	access: Option<libc::c_int>,
	/// The null device: a write is complete without a syscall.
	null:   bool,
	/// Read-ahead of a regular file this engine opened for reading only
	/// ([`StdFile::opened`]); `None` for every other file and once the
	/// descriptor was handed out ([`File::os_handle`], [`File::dup`]).
	ahead:  RefCell<Option<Ahead>>,
}

/// Bytes of a regular file read from the kernel beyond what the engine
/// consumed. `read` takes a chunk and gives back what follows its line
/// (`SeekFrom::Current(-n)`): with these at hand that is a move of `pos`, not
/// an `lseek`, and the next line needs no `read`. Only the kernel offset is
/// ahead of the engine's, and nothing else sees it until the descriptor is
/// handed out, which first [syncs](Ahead::sync) it.
#[derive(Debug, Default)]
struct Ahead {
	/// Allocated on the first read.
	buf:    Box<[u8]>,
	filled: usize,
	/// Next byte the engine reads.
	pos:    usize,
	/// The kernel offset: the file offset of `buf[filled]`.
	end:    u64,
}

/// Bytes an [`Ahead`] reads per `read`.
const AHEAD: usize = 32 << 10;

impl Ahead {
	fn read(&mut self, file: &mut fs::File, out: &mut [u8]) -> io::Result<usize> {
		if out.is_empty() {
			return Ok(0);
		}
		if self.pos == self.filled {
			if self.buf.is_empty() {
				self.buf = vec![0; AHEAD].into_boxed_slice();
			}
			let n = loop {
				match file.read(&mut self.buf) {
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
					got => break got?,
				}
			};
			self.filled = n;
			self.pos = 0;
			self.end += n as u64;
		}
		let n = out.len().min(self.filled - self.pos);
		out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
		self.pos += n;
		Ok(n)
	}

	/// Move the kernel offset back to the engine's and drop the bytes ahead.
	fn sync(&mut self, mut file: &fs::File) -> io::Result<()> {
		let ahead = self.filled - self.pos;
		if ahead > 0 {
			self.end = file.seek(io::SeekFrom::Current(-(ahead as i64)))?;
		}
		self.filled = 0;
		self.pos = 0;
		Ok(())
	}

	fn seek(&mut self, file: &mut fs::File, pos: io::SeekFrom) -> io::Result<u64> {
		if let io::SeekFrom::Current(back @ ..=0) = pos
			&& let Some(pos) = self.pos.checked_sub(back.unsigned_abs() as usize)
		{
			self.pos = pos;
			return Ok(self.end - (self.filled - self.pos) as u64);
		}
		self.sync(file)?;
		self.end = file.seek(pos)?;
		Ok(self.end)
	}
}

impl StdFile {
	/// Wrap an open file, classifying it.
	pub fn new(file: fs::File) -> Self {
		let (kind, null) = classify(&file);
		Self::with_kind(file, kind, null)
	}

	/// Wrap a file this engine opened with `flags`. A regular file opened
	/// for reading only gets a read-ahead: its open file description is the
	/// engine's own until handed out.
	fn opened(file: fs::File, flags: OpenFlags) -> Self {
		let new = Self::new(file);
		if new.kind == FileKind::Regular && !flags.contains(OpenFlags::WRITE) {
			new.ahead.replace(Some(Ahead::default()));
		}
		new
	}

	/// Sync and drop the read-ahead: the descriptor is about to be shared.
	fn hand_out(&self) {
		if let Some(mut ahead) = self.ahead.take() {
			// A regular file seeks back within what it read; were that to
			// fail, the receiver could only see a later offset.
			let _ = ahead.sync(&self.file);
		}
	}

	#[cfg_attr(
		not(unix),
		expect(clippy::missing_const_for_fn, reason = "reads the access mode with fcntl on Unix")
	)]
	fn with_kind(file: fs::File, kind: FileKind, null: bool) -> Self {
		// Only a descriptor that waits for readiness consults its access
		// mode ([`Self::gated`]); a regular file or device skips the `fcntl`.
		#[cfg(unix)]
		let access = waits(kind)
			.then(|| {
				use std::os::fd::AsRawFd;
				// SAFETY: F_GETFL only reads the flags of our open descriptor.
				let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
				(flags >= 0).then_some(flags & libc::O_ACCMODE)
			})
			.flatten();
		Self {
			file,
			kind,
			#[cfg(unix)]
			watch: [None, None],
			#[cfg(unix)]
			access,
			null,
			ahead: RefCell::new(None),
		}
	}

	/// Whether I/O in this direction must wait for readiness instead of
	/// blocking. A direction the descriptor was not opened for is never
	/// gated: the syscall fails at once with `EBADF`, while readiness would
	/// never come (`poll` on a pipe's read end never reports `POLLOUT`).
	#[cfg(unix)]
	fn gated(&self, write: bool) -> bool {
		let wanted = if write {
			libc::O_WRONLY
		} else {
			libc::O_RDONLY
		};
		let allowed = self
			.access
			.is_none_or(|acc| acc == libc::O_RDWR || acc == wanted);
		allowed && waits(self.kind)
	}

	/// `Ready` when `events` are ready now; else registers `cx`'s waker.
	#[cfg(unix)]
	fn ready(&mut self, cx: &Context<'_>, events: i16) -> Poll<io::Result<()>> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		let fd = self.file.as_raw_fd();
		let slot = usize::from(events != ready::READ);
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				return Poll::Ready(Ok(()));
			},
			Ok(false) => {},
			Err(e) => return Poll::Ready(Err(e)),
		}
		// Replace any earlier watch of this direction, so only the latest
		// waker is kept.
		self.watch[slot] = None;
		match ready::watch(fd, events, cx.waker()) {
			Ok(w) => self.watch[slot] = Some(w),
			Err(e) => return Poll::Ready(Err(e)),
		}
		// It may have become ready before the watch was registered; the
		// poller would see that too, this only saves a round trip.
		match ready::now(fd, events) {
			Ok(true) => {
				self.watch[slot] = None;
				Poll::Ready(Ok(()))
			},
			Ok(false) => Poll::Pending,
			Err(e) => Poll::Ready(Err(e)),
		}
	}

	/// Write what fits without waiting: `ready::WRITE_CHUNK` bytes per
	/// readiness check, as long as the descriptor stays writable.
	#[cfg(unix)]
	fn write_ready(&mut self, buf: &[u8]) -> io::Result<usize> {
		use std::os::fd::AsRawFd;

		use crate::sys::ready;
		let fd = self.file.as_raw_fd();
		let mut done = 0;
		while done < buf.len() {
			if done > 0 && !ready::now(fd, ready::WRITE)? {
				break;
			}
			let end = buf.len().min(done + ready::WRITE_CHUNK);
			match self.file.write(&buf[done..end]) {
				Ok(n) => done += n,
				Err(e) if done > 0 && e.kind() != io::ErrorKind::Interrupted => break,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				Err(e) => return Err(e),
			}
		}
		Ok(done)
	}
}

/// Whether I/O on a descriptor of `kind` waits for readiness instead of
/// blocking ([`StdFile::gated`]).
#[cfg(unix)]
const fn waits(kind: FileKind) -> bool {
	matches!(kind, FileKind::Pipe | FileKind::Socket | FileKind::Tty)
}

/// The file's kind, and whether it is the null device. Only a character
/// device (or a handle `fstat` cannot read) can be a terminal, so a regular
/// file, pipe or socket costs one `fstat` and no terminal probe.
fn classify(file: &fs::File) -> (FileKind, bool) {
	let Ok(meta) = file.metadata() else {
		return if file.is_terminal() {
			(FileKind::Tty, false)
		} else {
			(FileKind::Device, false)
		};
	};
	let ft = meta.file_type();
	if ft.is_file() {
		return (FileKind::Regular, false);
	}
	#[cfg(not(unix))]
	if file.is_terminal() {
		return (FileKind::Tty, false);
	}
	#[cfg(unix)]
	{
		use std::{
			os::unix::fs::{FileTypeExt, MetadataExt},
			sync::LazyLock,
		};
		if ft.is_fifo() {
			return (FileKind::Pipe, false);
		}
		if ft.is_socket() {
			return (FileKind::Socket, false);
		}
		if ft.is_char_device() && file.is_terminal() {
			return (FileKind::Tty, false);
		}
		/// `/dev/null`'s device number.
		static NULL: LazyLock<Option<u64>> =
			LazyLock::new(|| fs::metadata("/dev/null").ok().map(|m| m.rdev()));
		if ft.is_char_device() && Some(meta.rdev()) == *NULL {
			return (FileKind::Device, true);
		}
	}
	(FileKind::Device, false)
}

/// The process's own standard stream `fd` (a duplicate of it), `None` when
/// it is closed.
pub fn std_stream(fd: StdFd) -> Option<Box<dyn File>> {
	#[cfg(unix)]
	let owned = {
		use std::os::fd::AsFd;
		match fd {
			StdFd::Stdin => io::stdin().as_fd().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_fd().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_fd().try_clone_to_owned(),
		}
	};
	#[cfg(windows)]
	let owned = {
		use std::os::windows::io::AsHandle;
		match fd {
			StdFd::Stdin => io::stdin().as_handle().try_clone_to_owned(),
			StdFd::Stdout => io::stdout().as_handle().try_clone_to_owned(),
			StdFd::Stderr => io::stderr().as_handle().try_clone_to_owned(),
		}
	};
	owned
		.ok()
		.map(|h| Box::new(StdFile::new(fs::File::from(h))) as Box<dyn File>)
}

impl File for StdFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if let Some(ahead) = self.ahead.get_mut() {
			return Poll::Ready(ahead.read(&mut self.file, buf));
		}
		#[cfg(unix)]
		if self.gated(false) {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::READ)) {
				return Poll::Ready(Err(e));
			}
			// Readable (or hung up): this read returns without waiting.
			return Poll::Ready(self.file.read(buf));
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.read(buf))
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if self.null {
			return Poll::Ready(Ok(buf.len()));
		}
		#[cfg(unix)]
		if self.gated(true) && !buf.is_empty() {
			if let Err(e) = std::task::ready!(self.ready(cx, crate::sys::ready::WRITE)) {
				return Poll::Ready(Err(e));
			}
			return Poll::Ready(self.write_ready(buf));
		}
		#[cfg(not(unix))]
		let _ = cx;
		Poll::Ready(self.file.write(buf))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(self.file.flush())
	}

	fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
		match self.ahead.get_mut() {
			Some(ahead) => ahead.seek(&mut self.file, pos),
			None => self.file.seek(pos),
		}
	}

	fn kind(&self) -> FileKind {
		self.kind
	}

	fn os_handle(&self) -> Option<OsHandle> {
		self.hand_out();
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			u64::try_from(self.file.as_raw_fd()).ok().map(OsHandle)
		}
		#[cfg(windows)]
		{
			use std::os::windows::io::AsRawHandle;
			Some(OsHandle(self.file.as_raw_handle().addr() as u64))
		}
	}

	fn stat(&self) -> io::Result<Stat> {
		self.file.metadata().map(|m| stat_of(&m))
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.hand_out();
		Ok(Box::new(Self::with_kind(self.file.try_clone()?, self.kind, self.null)))
	}
}

/// Engine path → host path (UTF-8 required on Windows). A URL path
/// ([`crate::bash::fs::url_root_len`]) names no host file: `NotFound`, rather
/// than a lookup relative to the process's working directory. On Windows the
/// null device [`pi_vfs::windows_null_device`] decides the exact spelling
/// `/dev/null` maps to `NUL`; a longer name does not.
pub fn host_path(p: &[u8]) -> io::Result<&Path> {
	if crate::bash::fs::url_root_len(p).is_some() {
		return Err(io::Error::from(io::ErrorKind::NotFound));
	}
	#[cfg(windows)]
	if pi_vfs::windows_null_device(p) {
		return Ok(Path::new("NUL"));
	}
	p.to_path()
		.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// Host path → engine bytes.
fn engine_path(p: &Path) -> BString {
	BString::from(p.as_os_str().as_encoded_bytes())
}

fn kind_of(ft: fs::FileType) -> StatKind {
	if ft.is_dir() {
		return StatKind::Dir;
	}
	if ft.is_symlink() {
		return StatKind::Symlink;
	}
	if ft.is_file() {
		return StatKind::File;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::FileTypeExt;
		if ft.is_fifo() {
			return StatKind::Fifo;
		}
		if ft.is_socket() {
			return StatKind::Socket;
		}
		if ft.is_block_device() {
			return StatKind::BlockDev;
		}
	}
	StatKind::CharDev
}

fn stat_of(meta: &fs::Metadata) -> Stat {
	let kind = kind_of(meta.file_type());
	let since_epoch = |t: io::Result<std::time::SystemTime>| {
		t.ok()
			.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
			.map_or(0, |d| d.as_nanos() as i64)
	};
	let mtime_ns = since_epoch(meta.modified());
	let atime_ns = since_epoch(meta.accessed());
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		Stat {
			kind,
			mode: meta.mode() & 0o7777,
			size: meta.size(),
			uid: meta.uid(),
			gid: meta.gid(),
			dev: meta.dev(),
			ino: meta.ino(),
			nlink: meta.nlink(),
			mtime_ns,
			atime_ns,
			ctime_ns: meta
				.ctime()
				.saturating_mul(1_000_000_000)
				.saturating_add(meta.ctime_nsec()),
			blocks: meta.blocks(),
			rdev: meta.rdev(),
			blksize: meta.blksize(),
		}
	}
	#[cfg(windows)]
	{
		let mode = match (kind, meta.permissions().readonly()) {
			(StatKind::Dir, _) => 0o755,
			(_, true) => 0o444,
			(_, false) => 0o644,
		};
		Stat {
			kind,
			mode,
			size: meta.len(),
			uid: 0,
			gid: 0,
			dev: 0,
			ino: 0,
			nlink: 1,
			mtime_ns,
			atime_ns,
			// Windows has no status-change time: the creation time stands in.
			ctime_ns: since_epoch(meta.created()),
			blocks: meta.len().div_ceil(512),
			rdev: 0,
			blksize: 4096,
		}
	}
}

/// `stat` of `path`. Windows `GetFileAttributes` does not see the null
/// device, so a failed lookup of `NUL` is still the device `test -e` expects.
fn stat_path(path: &BStr, follow: bool) -> io::Result<Stat> {
	let host = host_path(path)?;
	let meta = if follow {
		fs::metadata(host)
	} else {
		fs::symlink_metadata(host)
	};
	#[cfg(windows)]
	if meta.is_err() && host == Path::new("NUL") {
		return Ok(nul_stat());
	}
	Ok(stat_of(&meta?))
}

/// The null device `test -e` sees when Windows cannot stat `NUL`: present
/// and a character device.
#[cfg(windows)]
fn nul_stat() -> Stat {
	Stat {
		kind:     StatKind::CharDev,
		mode:     0o666,
		size:     0,
		uid:      0,
		gid:      0,
		dev:      0,
		ino:      0,
		nlink:    1,
		mtime_ns: 0,
		atime_ns: 0,
		ctime_ns: 0,
		blocks:   0,
		rdev:     0,
		blksize:  4096,
	}
}

fn open(path: &BStr, flags: OpenFlags, mode: u32, umask: Option<u32>) -> io::Result<Box<dyn File>> {
	#[cfg(windows)]
	if let Some(server) = pipe::take(path, flags) {
		return server;
	}
	let path = host_path(path)?;
	Ok(Box::new(StdFile::opened(create_with_mode(path, flags, mode, umask, false)?, flags)))
}

/// [`open`] for writing only, without waiting for a FIFO's reader: such a
/// FIFO fails at once with `ENXIO` (the caller then waits on the helper
/// thread), and nothing is stat'ed first. The descriptor is left blocking,
/// as a plain open leaves it, since externals inherit its flags.
#[cfg(unix)]
fn open_for_writing(
	path: &BStr,
	flags: OpenFlags,
	mode: u32,
	umask: Option<u32>,
) -> io::Result<Box<dyn File>> {
	use std::os::fd::AsRawFd;
	let file = create_with_mode(host_path(path)?, flags, mode, umask, true)?;
	let mut status = if flags.contains(OpenFlags::APPEND) {
		libc::O_APPEND
	} else {
		0
	};
	if flags.contains(OpenFlags::NONBLOCK) {
		status |= libc::O_NONBLOCK;
	}
	// SAFETY: F_SETFL sets the status flags of our own open descriptor.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, status) } < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(Box::new(StdFile::opened(file, flags)))
}

/// Opens `path`, giving a file the open creates exactly `mode`.
///
/// The engine passes `0o666 & !umask` with the shell's own umask, but the
/// kernel still applies the process umask (`process_umask`) on creation, so
/// a looser shell mask (`umask 000`) would lose the bits the process mask
/// clears. When the process mask is known and clears none of `mode`, a plain
/// open already creates exactly `mode`. Otherwise only an exclusive create
/// proves the file is new (an existing file keeps its mode), so a plain
/// `O_CREAT` open tries one first and falls back on `EEXIST`.
fn create_with_mode(
	path: &std::path::Path,
	flags: OpenFlags,
	mode: u32,
	process_umask: Option<u32>,
	nonblock: bool,
) -> io::Result<fs::File> {
	let options = || {
		#[cfg_attr(not(unix), expect(unused_mut, reason = "custom flags are Unix's"))]
		let mut o = options(flags, mode);
		#[cfg(unix)]
		if nonblock {
			use std::os::unix::fs::OpenOptionsExt;
			// `custom_flags` replaces the earlier ones.
			o.custom_flags(libc::O_NONBLOCK | custom_flags(flags));
		}
		#[cfg(not(unix))]
		let _ = nonblock;
		o
	};
	#[cfg(not(unix))]
	let _ = process_umask;
	#[cfg(unix)]
	if flags.contains(OpenFlags::CREATE) && process_umask.is_none_or(|mask| mode & mask != 0) {
		use std::os::unix::fs::PermissionsExt as _;
		let mut exclusive = options();
		exclusive.create_new(true);
		match exclusive.open(path) {
			Ok(file) => {
				// Best effort: without it the file keeps the stricter mode
				// the process umask left.
				let _ = file.set_permissions(fs::Permissions::from_mode(mode & 0o7777));
				return Ok(file);
			},
			Err(err)
				if err.kind() == io::ErrorKind::AlreadyExists && !flags.contains(OpenFlags::EXCL) => {},
			Err(err) => return Err(err),
		}
	}
	options().open(path)
}

fn options(flags: OpenFlags, mode: u32) -> OpenOptions {
	let mut o = OpenOptions::new();
	// `OpenOptions` refuses append with truncate, which `open(2)` takes
	// (zsh `sysopen -a -o trunc`): on Unix the append flag then goes in as
	// a custom flag ([`custom_flags`]).
	let append_trunc =
		cfg!(unix) && flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC);
	o.read(flags.contains(OpenFlags::READ))
		.write(flags.contains(OpenFlags::WRITE) || append_trunc)
		.append(flags.contains(OpenFlags::APPEND) && !append_trunc)
		.truncate(flags.contains(OpenFlags::TRUNC))
		.create(flags.contains(OpenFlags::CREATE));
	if flags.contains(OpenFlags::EXCL) {
		o.create_new(true);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		o.mode(mode);
		let custom = custom_flags(flags);
		if custom != 0 {
			o.custom_flags(custom);
		}
	}
	#[cfg(windows)]
	let _ = mode;
	o
}

/// The `open(2)` flags of `flags` that [`OpenOptions`] has no setter for.
#[cfg(unix)]
fn custom_flags(flags: OpenFlags) -> libc::c_int {
	let mut custom = 0;
	if flags.contains(OpenFlags::APPEND) && flags.contains(OpenFlags::TRUNC) {
		custom |= libc::O_APPEND;
	}
	if flags.contains(OpenFlags::NOFOLLOW) {
		custom |= libc::O_NOFOLLOW;
	}
	if flags.contains(OpenFlags::SYNC) {
		custom |= libc::O_SYNC;
	}
	#[cfg(any(target_os = "linux", target_os = "android"))]
	if flags.contains(OpenFlags::NOATIME) {
		custom |= libc::O_NOATIME;
	}
	if flags.contains(OpenFlags::NONBLOCK) {
		custom |= libc::O_NONBLOCK;
	}
	custom
}

/// Opening a FIFO in one direction blocks until the other end opens; it runs
/// on a helper thread and completes as a pending fs op.
#[cfg(unix)]
mod fifo {
	use std::{
		fs::{self, OpenOptions},
		io,
		os::unix::fs::{FileTypeExt, OpenOptionsExt},
		path::PathBuf,
		sync::Arc,
		task::{Context, Poll, Waker},
		thread,
	};

	use bstr::BStr;
	use parking_lot::Mutex;

	use super::{StdFile, host_path, options};
	use crate::bash::{File, FsPending, OpenFlags};

	/// Result slot shared with the helper thread.
	#[derive(Default)]
	struct Slot {
		result:    Option<io::Result<fs::File>>,
		waker:     Option<Waker>,
		/// The result was handed to the engine.
		finished:  bool,
		/// The engine dropped the open: the helper closes what it gets.
		cancelled: bool,
	}

	/// A FIFO open in flight.
	struct FifoOpen {
		slot:  Arc<Mutex<Slot>>,
		path:  PathBuf,
		write: bool,
	}

	/// `Some` when `path` is a FIFO opened for reading only or writing only
	/// (`O_RDWR` never blocks on a FIFO).
	pub fn pending(
		path: &BStr,
		flags: OpenFlags,
		mode: u32,
	) -> Option<Box<dyn FsPending<Box<dyn File>>>> {
		let write = flags.contains(OpenFlags::WRITE);
		if flags.contains(OpenFlags::READ) == write {
			return None;
		}
		let host = host_path(path).ok()?;
		if !fs::metadata(host).ok()?.file_type().is_fifo() {
			return None;
		}
		let slot = Arc::new(Mutex::new(Slot::default()));
		let (opts, target, helper) = (options(flags, mode), host.to_path_buf(), Arc::clone(&slot));
		let spawned = thread::Builder::new()
			.name("obash-fifo".into())
			.stack_size(64 << 10)
			.spawn(move || {
				let opened = opts.open(&target);
				let mut s = helper.lock();
				if s.cancelled {
					return;
				}
				s.result = Some(opened);
				let waker = s.waker.take();
				drop(s);
				if let Some(w) = waker {
					w.wake();
				}
			});
		if let Err(e) = spawned {
			slot.lock().result = Some(Err(e));
		}
		Some(Box::new(FifoOpen { slot, path: host.to_path_buf(), write }))
	}

	impl FsPending<Box<dyn File>> for FifoOpen {
		fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<Box<dyn File>>> {
			let mut s = self.slot.lock();
			if let Some(r) = s.result.take() {
				s.finished = true;
				return Poll::Ready(r.map(|f| Box::new(StdFile::new(f)) as Box<dyn File>));
			}
			if !s.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
				s.waker = Some(cx.waker().clone());
			}
			Poll::Pending
		}

		/// Cancelling releases the helper by briefly opening the other end,
		/// which the real other end can observe (a writer that comes and
		/// goes reads as end of file).
		fn reissuable(&self) -> bool {
			false
		}
	}

	impl Drop for FifoOpen {
		fn drop(&mut self) {
			{
				let mut s = self.slot.lock();
				if s.finished || s.result.is_some() {
					return;
				}
				s.cancelled = true;
			}
			// Release the helper blocked in open(2): be the other end for a
			// moment, without blocking ourselves.
			let mut other = OpenOptions::new();
			if self.write {
				other.read(true);
			} else {
				other.write(true);
			}
			other.custom_flags(libc::O_NONBLOCK);
			let _ = other.open(&self.path);
		}
	}
}

fn access(path: &BStr, mode: Access) -> io::Result<()> {
	#[cfg(unix)]
	{
		let c = std::ffi::CString::new(path.as_bytes())
			.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
		let mut m = libc::F_OK;
		if mode.contains(Access::READ) {
			m |= libc::R_OK;
		}
		if mode.contains(Access::WRITE) {
			m |= libc::W_OK;
		}
		if mode.contains(Access::EXEC) {
			m |= libc::X_OK;
		}
		// SAFETY: `c` is a valid NUL-terminated string for the duration of the
		// call.
		if unsafe { libc::access(c.as_ptr(), m) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
	#[cfg(windows)]
	{
		let p = host_path(path)?;
		let meta = fs::metadata(p);
		// `GetFileAttributes` does not see the null device. A failed lookup of
		// `NUL` is still readable and writable (`test -r`/`test -w`/`test -e`);
		// it is not executable.
		if meta.is_err() && p == Path::new("NUL") {
			if mode.contains(Access::EXEC) {
				return Err(io::ErrorKind::PermissionDenied.into());
			}
			return Ok(());
		}
		let meta = meta?;
		if mode.contains(Access::WRITE) && meta.permissions().readonly() {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		if mode.contains(Access::EXEC)
			&& !meta.is_dir()
			&& !crate::sys::pathext::Pathext::from_env().has_executable_extension(p)
			&& !crate::sys::shebang::has_shebang(p)
		{
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		Ok(())
	}
}

/// Directory listing collected up front (a local readdir).
struct StdDir(std::vec::IntoIter<io::Result<DirEntry>>);

impl DirIter for StdDir {
	fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>> {
		Poll::Ready(self.0.next())
	}
}

fn read_dir(path: &BStr) -> io::Result<Box<dyn DirIter>> {
	let entries: Vec<io::Result<DirEntry>> = fs::read_dir(host_path(path)?)?
		.map(|e| {
			e.map(|e| DirEntry {
				name: BString::from(e.file_name().as_encoded_bytes()),
				kind: e.file_type().ok().map(kind_of),
			})
		})
		.collect();
	Ok(Box::new(StdDir(entries.into_iter())))
}

/// Unique temp names within this process.
static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn temp(purpose: TempPurpose) -> io::Result<TempNode> {
	let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
	#[cfg(windows)]
	if let TempPurpose::ProcSub { output } = purpose {
		return pipe::create(output, seq);
	}
	let path = std::env::temp_dir().join(format!("obash-{}-{seq}", std::process::id()));
	let fifo = matches!(purpose, TempPurpose::ProcSub { .. }) && cfg!(unix);
	if fifo {
		#[cfg(unix)]
		{
			let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
				.map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
			// SAFETY: `c` is a valid NUL-terminated path for the duration of the
			// call.
			if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
				return Err(io::Error::last_os_error());
			}
		}
	} else {
		fs::File::create_new(&path)?;
	}
	Ok(TempNode { path: engine_path(&path), fifo })
}

fn chdir_check(path: &BStr) -> io::Result<()> {
	if !fs::metadata(host_path(path)?)?.is_dir() {
		return Err(io::ErrorKind::NotADirectory.into());
	}
	access(path, Access::EXEC)
}

/// Named pipes for process substitution on Windows.
///
/// [`pipe::create`] makes the server end and parks it; the producer side of
/// the substitution takes it with [`Fs::open`] in its direction (write for
/// `<( )`, read for `>( )`), the consumer opens the path as a client. The
/// server end is overlapped ([`OsPipe::server`](crate::sys::pump::os::OsPipe)):
/// it connects on first I/O, which stays `Pending` until the consumer has
/// opened the path, and its reads and writes never wait either. It reports
/// no OS handle, so an external producer is fed through a pump.
#[cfg(windows)]
mod pipe {
	use std::{
		collections::HashMap,
		io,
		os::windows::io::{FromRawHandle, OwnedHandle},
		ptr,
		sync::{Arc, LazyLock},
		task::{Context, Poll},
	};

	use bstr::{BStr, BString};
	use parking_lot::Mutex;
	use windows_sys::Win32::{
		Storage::FileSystem::{
			FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_INBOUND,
			PIPE_ACCESS_OUTBOUND,
		},
		System::Pipes::{
			CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
			PIPE_WAIT,
		},
	};

	use crate::{
		bash::{File, FileKind, OpenFlags, OsHandle, fs::TempNode},
		sys::pump::os::OsPipe,
	};

	/// Server ends not yet taken, by path; `true` when the server writes.
	static PENDING: LazyLock<Mutex<HashMap<BString, (OwnedHandle, bool)>>> =
		LazyLock::new(|| Mutex::new(HashMap::new()));

	const BUF: u32 = 64 << 10;

	/// Create the pipe for a `<( )` (`output == false`: we write, the
	/// consumer reads) or `>( )` substitution.
	pub fn create(output: bool, seq: u32) -> io::Result<TempNode> {
		let name = format!(r"\\.\pipe\obash-{}-{seq}", std::process::id());
		let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
		let access = if output {
			PIPE_ACCESS_INBOUND
		} else {
			PIPE_ACCESS_OUTBOUND
		};
		// SAFETY: `wide` is NUL-terminated; null security attributes.
		let h = unsafe {
			CreateNamedPipeW(
				wide.as_ptr(),
				access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
				PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
				1,
				BUF,
				BUF,
				0,
				ptr::null(),
			)
		};
		if h.is_null() || h as isize == -1 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: a fresh handle we own.
		let h = unsafe { OwnedHandle::from_raw_handle(h.cast()) };
		let path = BString::from(name);
		PENDING.lock().insert(path.clone(), (h, !output));
		Ok(TempNode { path, fifo: true })
	}

	/// The parked server end of `path`, when `flags` open it in the server's
	/// direction; `None` leaves the open to the client path.
	pub fn take(path: &BStr, flags: OpenFlags) -> Option<io::Result<Box<dyn File>>> {
		let mut pending = PENDING.lock();
		let &(_, writes) = pending.get(path)?;
		if flags.contains(OpenFlags::WRITE) != writes {
			return None;
		}
		let (h, _) = pending.remove(path)?;
		Some(OsPipe::server(h).map(|pipe| {
			Box::new(Server(Arc::new(Mutex::new(ServerEnd { pipe, connected: false }))))
				as Box<dyn File>
		}))
	}

	/// Server end of a substitution pipe. Duplicates share it, as the
	/// duplicates of one open file do.
	struct Server(Arc<Mutex<ServerEnd>>);

	struct ServerEnd {
		pipe:      OsPipe,
		connected: bool,
	}

	impl ServerEnd {
		/// Ready once the consumer has connected (`Pending` until it opens
		/// the path, like opening a FIFO, without waiting).
		fn poll_connected(&mut self, cx: &Context<'_>) -> Poll<io::Result<()>> {
			if !self.connected {
				std::task::ready!(self.pipe.poll_connect(cx))?;
				self.connected = true;
			}
			Poll::Ready(Ok(()))
		}
	}

	impl File for Server {
		fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_read(cx, buf)
		}

		fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
			let mut end = self.0.lock();
			if let Err(e) = std::task::ready!(end.poll_connected(cx)) {
				return Poll::Ready(Err(e));
			}
			end.pipe.poll_write(cx, buf)
		}

		fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
			let mut end = self.0.lock();
			if !end.connected {
				return Poll::Ready(Ok(()));
			}
			end.pipe.poll_flush(cx)
		}

		fn seek(&mut self, _pos: io::SeekFrom) -> io::Result<u64> {
			Err(io::ErrorKind::NotSeekable.into())
		}

		fn kind(&self) -> FileKind {
			FileKind::Pipe
		}

		fn os_handle(&self) -> Option<OsHandle> {
			// Externals would write before the consumer connects: pump instead.
			None
		}

		fn dup(&self) -> io::Result<Box<dyn File>> {
			Ok(Box::new(Self(Arc::clone(&self.0))))
		}
	}
}

impl Fs for StdFs {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		#[cfg(unix)]
		if flags.contains(OpenFlags::WRITE) && !flags.contains(OpenFlags::READ) {
			match open_for_writing(path, flags, mode, self.umask) {
				// No reader (or not a FIFO at all: the checks below tell).
				Err(err) if err.raw_os_error() == Some(libc::ENXIO) => {},
				opened => return FsPoll::Ready(opened),
			}
		}
		#[cfg(unix)]
		if let Some(pending) = fifo::pending(path, flags, mode) {
			return FsPoll::Pending(pending);
		}
		FsPoll::Ready(open(path, flags, mode, self.umask))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		FsPoll::Ready(stat_path(path, follow))
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		FsPoll::Ready(access(path, mode))
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		FsPoll::Ready(read_dir(path))
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(
			host_path(path)
				.and_then(fs::read_link)
				.map(|p| engine_path(&p)),
		)
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		FsPoll::Ready(
			host_path(path)
				.and_then(fs::canonicalize)
				.map(|p| engine_path(&p)),
		)
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		FsPoll::Ready(temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(chdir_check(path))
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_file))
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::rename(f, host_path(to)?)))
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		#[cfg(unix)]
		let res = host_path(path).and_then(|p| std::os::unix::fs::symlink(host_path(target)?, p));
		#[cfg(not(unix))]
		let res = {
			let _ = (target, path);
			Err(io::ErrorKind::Unsupported.into())
		};
		FsPoll::Ready(res)
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(from).and_then(|f| fs::hard_link(f, host_path(to)?)))
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		FsPoll::Ready(lock_file(path))
	}

	fn lock_fd(&mut self, file: OsHandle, lock: crate::bash::fs::FdLock) -> FsPoll<()> {
		FsPoll::Ready(lock_fd(file, lock))
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::mkdir(p, mode, self.umask)))
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(fs::remove_dir))
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chmod(p, mode)))
	}

	fn chown(
		&mut self,
		path: &BStr,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::chown(p, uid, gid, follow)))
	}

	fn sync(&mut self) -> FsPoll<()> {
		FsPoll::Ready(super::fs_ops::sync())
	}

	fn getxattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<BString> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::getxattr(p, name, follow)))
	}

	fn setxattr(&mut self, path: &BStr, name: &BStr, value: &[u8], follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::setxattr(p, name, value, follow)))
	}

	fn removexattr(&mut self, path: &BStr, name: &BStr, follow: bool) -> FsPoll<()> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::removexattr(p, name, follow)))
	}

	fn listxattr(&mut self, path: &BStr, follow: bool) -> FsPoll<Vec<BString>> {
		FsPoll::Ready(host_path(path).and_then(|p| super::fs_ops::listxattr(p, follow)))
	}

	fn user_db(
		&mut self,
		query: &crate::bash::fs::PwQuery,
	) -> FsPoll<Vec<crate::bash::fs::PwEntry>> {
		FsPoll::Ready(super::fs_ops::user_db(query))
	}
}

/// `fcntl(F_SETLK)` of a whole-file lock on descriptor `file`
/// ([`Fs::lock_fd`]): `WouldBlock` on contention.
#[cfg(unix)]
fn lock_fd(file: OsHandle, lock: crate::bash::fs::FdLock) -> io::Result<()> {
	use crate::bash::fs::FdLock;
	let fd = libc::c_int::try_from(file.0).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
	// SAFETY: `flock` is plain data; all-zero is a valid value.
	let mut lck: libc::flock = unsafe { std::mem::zeroed() };
	lck.l_type = (match lock {
		FdLock::Shared => libc::F_RDLCK,
		FdLock::Exclusive => libc::F_WRLCK,
		FdLock::Unlock => libc::F_UNLCK,
	}) as _;
	lck.l_whence = libc::SEEK_SET as _;
	loop {
		// SAFETY: `fcntl` on a caller-supplied descriptor with a valid
		// `flock`; a stale descriptor fails with `EBADF`.
		if unsafe { libc::fcntl(fd, libc::F_SETLK, &lck) } != -1 {
			return Ok(());
		}
		let err = io::Error::last_os_error();
		match err.raw_os_error() {
			Some(libc::EINTR) => {},
			Some(libc::EAGAIN | libc::EACCES) => return Err(io::ErrorKind::WouldBlock.into()),
			_ => return Err(err),
		}
	}
}

/// Record locks on descriptors need `fcntl` ([`Fs::lock_fd`]).
#[cfg(not(unix))]
fn lock_fd(_file: OsHandle, _lock: crate::bash::fs::FdLock) -> io::Result<()> {
	Err(io::ErrorKind::Unsupported.into())
}

/// [`Fs::lock`]: open `path` read-write and take a non-waiting `F_WRLCK`
/// record lock on the whole file.
fn lock_file(path: &BStr) -> io::Result<Box<dyn File>> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.open(host_path(path)?)?;
	#[cfg(unix)]
	{
		use std::os::fd::AsRawFd;
		// SAFETY: `flock` is plain data; all-zero is a valid value.
		let mut lck: libc::flock = unsafe { std::mem::zeroed() };
		lck.l_type = libc::F_WRLCK as _;
		lck.l_whence = libc::SEEK_SET as _;
		// SAFETY: a valid open descriptor and a valid `flock`.
		if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lck) } == -1 {
			let err = io::Error::last_os_error();
			return Err(match err.raw_os_error() {
				Some(libc::EAGAIN | libc::EACCES) => io::ErrorKind::WouldBlock.into(),
				_ => err,
			});
		}
	}
	#[cfg(not(unix))]
	file.try_lock().map_err(|e| match e {
		fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
		fs::TryLockError::Error(e) => e,
	})?;
	Ok(Box::new(StdFile::new(file)))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ready<T>(p: FsPoll<T>) -> io::Result<T> {
		match p {
			FsPoll::Ready(r) => r,
			FsPoll::Pending(_) => panic!("StdFs never pends"),
		}
	}

	#[test]
	fn stat_and_access_distinguish_files_dirs_and_missing_paths() {
		let dir = std::env::temp_dir();
		let mut fs = StdFs::default();
		let dir_bytes = engine_path(&dir);
		assert_eq!(ready(fs.stat(dir_bytes.as_bstr(), true)).unwrap().kind, StatKind::Dir);
		let missing = ready(fs.stat(b"/definitely/not/here".as_bstr(), true)).unwrap_err();
		assert_eq!(missing.kind(), io::ErrorKind::NotFound);
		assert!(ready(fs.chdir_check(dir_bytes.as_bstr())).is_ok());
	}

	/// Windows maps only the exact null device to `NUL`. A child or a longer
	/// name stays a normal path, and a URL still names no host file. On Unix
	/// `/dev/null` is unchanged. A regression makes `>/dev/null` open the wrong
	/// file, or a URL resolve against the working directory.
	#[test]
	fn host_path_maps_only_dev_null_to_nul() {
		#[cfg(windows)]
		{
			assert_eq!(host_path(b"/dev/null").unwrap(), Path::new("NUL"));
			assert_eq!(host_path(b"/dev/null/child").unwrap(), Path::new("/dev/null/child"));
			assert_eq!(host_path(b"/dev/nullx").unwrap(), Path::new("/dev/nullx"));
		}
		#[cfg(unix)]
		{
			assert_eq!(host_path(b"/dev/null").unwrap(), Path::new("/dev/null"));
		}
		let url = host_path(b"skill://x/y").unwrap_err();
		assert_eq!(url.kind(), io::ErrorKind::NotFound);
	}

	/// The null device answers `access` through both the engine spelling
	/// `/dev/null` and a host-style `NUL`: readable and writable even though
	/// `GetFileAttributes` cannot stat the device, and never executable. A
	/// regression breaks `test -r` / `test -w`, or lets `test -x` succeed.
	#[cfg(windows)]
	#[test]
	fn access_nul_accepts_read_write_and_denies_exec() {
		for path in [b"/dev/null".as_bstr(), b"NUL".as_bstr()] {
			assert!(access(path, Access::READ).is_ok(), "{path} readable");
			assert!(access(path, Access::WRITE).is_ok(), "{path} writable");
			assert_eq!(
				access(path, Access::EXEC).map_err(|e| e.kind()),
				Err(io::ErrorKind::PermissionDenied),
				"{path} executable"
			);
		}
	}

	/// The Unix counterpart of the Windows null-device test above:
	/// `/dev/null` is readable and writable through the native path. A
	/// regression makes `test -r` / `test -w` fail on the device.
	#[cfg(unix)]
	#[test]
	fn access_reports_dev_null_readable_and_writable() {
		assert!(access(b"/dev/null".as_bstr(), Access::READ).is_ok());
		assert!(access(b"/dev/null".as_bstr(), Access::WRITE).is_ok());
	}

	#[cfg(unix)]
	mod fifos {
		use std::{
			io::{Read, Write},
			os::unix::fs::OpenOptionsExt,
			sync::Arc,
			task::{Wake, Waker},
			thread,
			time::{Duration, Instant},
		};

		use super::*;

		struct Unpark(thread::Thread);

		impl Wake for Unpark {
			fn wake(self: Arc<Self>) {
				self.0.unpark();
			}
		}

		fn fifo() -> BString {
			let node =
				ready(StdFs::default().mkfifo_or_temp(TempPurpose::ProcSub { output: false })).unwrap();
			assert!(node.fifo);
			node.path
		}

		fn pending(p: FsPoll<Box<dyn File>>) -> Box<dyn crate::bash::FsPending<Box<dyn File>>> {
			match p {
				FsPoll::Pending(p) => p,
				FsPoll::Ready(_) => panic!("a one-way FIFO open must not complete synchronously"),
			}
		}

		fn finish(p: &mut Box<dyn crate::bash::FsPending<Box<dyn File>>>) -> Box<dyn File> {
			let waker = Waker::from(Arc::new(Unpark(thread::current())));
			let mut cx = Context::from_waker(&waker);
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				if let Poll::Ready(r) = p.poll(&mut cx) {
					return r.unwrap();
				}
				assert!(Instant::now() < deadline, "open never completed");
				thread::park_timeout(Duration::from_millis(100));
			}
		}

		#[test]
		fn reading_a_fifo_is_pending_until_a_writer_opens() {
			let path = fifo();
			let mut p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			let host = host_path(&path).unwrap().to_path_buf();
			let writer = thread::spawn(move || {
				thread::sleep(Duration::from_millis(50));
				fs::OpenOptions::new()
					.write(true)
					.open(host)
					.unwrap()
					.write_all(b"x")
					.unwrap();
			});
			let mut f = finish(&mut p);
			writer.join().unwrap();
			let waker = Waker::noop();
			let mut buf = [0; 4];
			let n = match f.poll_read(&mut Context::from_waker(waker), &mut buf) {
				Poll::Ready(r) => r.unwrap(),
				Poll::Pending => panic!("StdFile reads are ready"),
			};
			assert_eq!(&buf[..n], b"x");
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		#[test]
		fn writing_a_fifo_is_pending_until_a_reader_opens() {
			let path = fifo();
			let mut p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let host = host_path(&path).unwrap().to_path_buf();
			let reader = thread::spawn(move || {
				let mut s = String::new();
				fs::File::open(host)
					.unwrap()
					.read_to_string(&mut s)
					.unwrap();
				s
			});
			let mut f = finish(&mut p);
			assert!(matches!(
				f.poll_write(&mut Context::from_waker(Waker::noop()), b"hi"),
				Poll::Ready(Ok(2))
			));
			drop(f);
			assert_eq!(reader.join().unwrap(), "hi");
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		/// `mkfifo f; echo x > f & . f` in one engine thread: both ends live
		/// on this thread, so neither read nor write may wait in the kernel.
		#[test]
		fn both_ends_of_a_fifo_on_one_thread_never_block() {
			let path = fifo();
			let mut r = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			let mut w = pending(StdFs::default().open(path.as_bstr(), OpenFlags::WRITE, 0));
			let mut reader = finish(&mut r);
			let mut writer = finish(&mut w);
			assert_eq!(reader.kind(), FileKind::Pipe);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let mut buf = [0u8; 8192];
			assert!(
				reader.poll_read(&mut cx, &mut buf).is_pending(),
				"no data yet: Pending, not a wait"
			);
			assert!(matches!(writer.poll_write(&mut cx, b"echo four - OK\n"), Poll::Ready(Ok(15))));
			flag.wait("reader woken by the write");
			let Poll::Ready(Ok(n)) = reader.poll_read(&mut cx, &mut buf) else {
				panic!("readable after the write");
			};
			assert_eq!(&buf[..n], b"echo four - OK\n");

			// Fill the pipe: the writer gets Pending instead of waiting.
			let chunk = vec![b'z'; 1 << 16];
			let mut written = 0usize;
			loop {
				match writer.poll_write(&mut cx, &chunk) {
					Poll::Ready(Ok(n)) => written += n,
					Poll::Ready(Err(e)) => panic!("{e}"),
					Poll::Pending => break,
				}
				assert!(written < 64 << 20, "the pipe never filled");
			}
			let mut read = 0usize;
			while read < written {
				match reader.poll_read(&mut cx, &mut buf) {
					Poll::Ready(Ok(n)) => read += n,
					other => panic!("data is buffered: {other:?}"),
				}
			}
			flag.wait("writer woken once space freed up");
			drop(writer);
			assert!(
				matches!(reader.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(0))),
				"end of file after the writer closed"
			);
			fs::remove_file(host_path(&path).unwrap()).unwrap();
		}

		/// `exec 3</etc/passwd; echo foo >&3` (and the same on a pipe's read
		/// end): writing in a direction the fd was not opened for fails at once
		/// with EBADF, as in bash; readiness for it would never come.
		#[test]
		fn the_wrong_direction_fails_with_ebadf_instead_of_waiting() {
			let (r, w) = io::pipe().unwrap();
			let mut reader = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(r)));
			let mut writer = StdFile::new(fs::File::from(std::os::fd::OwnedFd::from(w)));
			assert_eq!(reader.kind(), FileKind::Pipe);
			let mut cx = Context::from_waker(Waker::noop());
			let ebadf = |p: Poll<io::Result<usize>>| match p {
				Poll::Ready(Err(e)) => e.raw_os_error() == Some(libc::EBADF),
				_ => false,
			};
			assert!(ebadf(reader.poll_write(&mut cx, b"foo\n")), "write to a read end");
			assert!(ebadf(writer.poll_read(&mut cx, &mut [0; 4])), "read from a write end");
			let file = fs::File::open("/etc/passwd").unwrap();
			let mut regular = StdFile::new(file);
			assert!(ebadf(regular.poll_write(&mut cx, b"foo\n")), "write to a read-only file");
		}

		/// `read -t 0.00001 var` with a terminal on stdin: the terminal read
		/// must not wait in the kernel, or the `read -t` timer and every other
		/// vproc stall.
		#[test]
		fn terminal_reads_are_pending_until_input_arrives() {
			use std::{
				ffi::CStr,
				os::fd::{AsRawFd, FromRawFd},
			};

			// SAFETY: plain call; returns a new fd we own (checked below).
			let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
			assert!(master >= 0, "posix_openpt: {}", io::Error::last_os_error());
			// SAFETY: `master` is a valid fd we own from here on.
			let mut master = unsafe { fs::File::from_raw_fd(master) };
			let fd = master.as_raw_fd();
			// SAFETY: plain calls on our master fd; `ptsname` returns a static
			// buffer read at once (each nextest test is its own process).
			let name = unsafe {
				assert_eq!(libc::grantpt(fd), 0);
				assert_eq!(libc::unlockpt(fd), 0);
				CStr::from_ptr(libc::ptsname(fd))
					.to_str()
					.unwrap()
					.to_owned()
			};
			let slave = fs::OpenOptions::new()
				.read(true)
				.write(true)
				.custom_flags(libc::O_NOCTTY)
				.open(&name)
				.unwrap();
			let mut tty = StdFile::new(slave);
			assert_eq!(tty.kind(), FileKind::Tty);
			let flag = Arc::new(Flag::default());
			let waker = Waker::from(Arc::clone(&flag));
			let mut cx = Context::from_waker(&waker);
			let mut buf = [0u8; 64];
			assert!(tty.poll_read(&mut cx, &mut buf).is_pending(), "no input: Pending, not a wait");
			master.write_all(b"typed\n").unwrap();
			flag.wait("terminal reader woken by input");
			let Poll::Ready(Ok(n)) = tty.poll_read(&mut cx, &mut buf) else {
				panic!("a line is available");
			};
			assert_eq!(&buf[..n], b"typed\n");
			assert!(
				matches!(tty.poll_write(&mut cx, b"out\n"), Poll::Ready(Ok(4))),
				"terminal output fits"
			);
		}

		/// A waker that records being woken.
		#[derive(Default)]
		struct Flag(std::sync::atomic::AtomicBool);

		impl Wake for Flag {
			fn wake(self: Arc<Self>) {
				self.0.store(true, std::sync::atomic::Ordering::SeqCst);
			}
		}

		impl Flag {
			fn wait(&self, what: &str) {
				let deadline = Instant::now() + Duration::from_secs(10);
				while !self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
					assert!(Instant::now() < deadline, "not woken: {what}");
					thread::sleep(Duration::from_millis(5));
				}
			}
		}

		#[test]
		fn dropping_a_pending_fifo_open_releases_the_helper() {
			let path = fifo();
			let host = host_path(&path).unwrap().to_path_buf();
			let p = pending(StdFs::default().open(path.as_bstr(), OpenFlags::READ, 0));
			drop(p);
			// Once the helper's read end is closed, no reader is left: a
			// non-blocking write open fails with ENXIO.
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				let r = fs::OpenOptions::new()
					.write(true)
					.custom_flags(libc::O_NONBLOCK)
					.open(&host);
				if r.as_ref().err().and_then(io::Error::raw_os_error) == Some(libc::ENXIO) {
					break;
				}
				assert!(Instant::now() < deadline, "helper still holds the FIFO");
				thread::sleep(Duration::from_millis(10));
			}
			fs::remove_file(&host).unwrap();
		}

		#[test]
		fn read_write_fifo_opens_and_regular_files_stay_ready() {
			let path = fifo();
			let both = OpenFlags::READ.with(OpenFlags::WRITE);
			assert!(
				ready(StdFs::default().open(path.as_bstr(), both, 0)).is_ok(),
				"O_RDWR never blocks"
			);
			fs::remove_file(host_path(&path).unwrap()).unwrap();
			let node = ready(StdFs::default().mkfifo_or_temp(TempPurpose::HereDoc)).unwrap();
			assert!(ready(StdFs::default().open(node.path.as_bstr(), OpenFlags::READ, 0)).is_ok());
			fs::remove_file(host_path(&node.path).unwrap()).unwrap();
		}
	}

	#[test]
	fn exclusive_open_refuses_an_existing_file() {
		let mut fs = StdFs::default();
		let node = ready(fs.mkfifo_or_temp(TempPurpose::HereDoc)).unwrap();
		assert!(!node.fifo);
		let flags = OpenFlags::WRITE
			.with(OpenFlags::CREATE)
			.with(OpenFlags::EXCL);
		let err = ready(fs.open(node.path.as_bstr(), flags, 0o600))
			.err()
			.unwrap();
		assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
		std::fs::remove_file(host_path(&node.path).unwrap()).unwrap();
	}
}
