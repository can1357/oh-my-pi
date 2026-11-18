//! Windows: `ReadDirectoryChangesW`.
//!
//! libuv's watcher (behind Bun's `fs.watch`) reads changes into a 4 KiB
//! buffer and re-arms only after every callback ran; bursts overflow it. Each
//! root here has a reader thread with overlapped reads into a large buffer,
//! which pauses between reads so the kernel gathers changes and one read
//! takes a whole burst.
//!
//! A directory root is read through two handles, one for files and one for
//! directories, so every change says whether its entry is a directory (plain
//! `ReadDirectoryChangesW` does not, and the `Ex` variant fails on SMB). A
//! file root is read through its directory and matched by name.

use std::{
	io, mem,
	os::windows::{
		ffi::OsStrExt,
		io::{AsRawHandle, FromRawHandle, OwnedHandle},
	},
	path::{Path, PathBuf},
	ptr,
	sync::{Arc, Mutex, PoisonError, mpsc},
	thread,
	time::Duration,
};

use windows_sys::Win32::{
	Foundation::{
		ERROR_INVALID_PARAMETER, ERROR_NOTIFY_ENUM_DIR, ERROR_OPERATION_ABORTED, GetLastError,
		HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
	},
	Storage::FileSystem::{
		CreateFileW, FILE_ACTION_ADDED, FILE_ACTION_MODIFIED, FILE_ACTION_REMOVED,
		FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME, FILE_FLAG_BACKUP_SEMANTICS,
		FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME,
		FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
		FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
		ReadDirectoryChangesW,
	},
	System::{
		IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
		Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects, WaitForSingleObject},
	},
};

use crate::{Flags, MISSING_ROOT_RECHECK, Root, Timing, batch::Emitter, missing_root};

/// Read buffer for file changes on local volumes (what git's fsmonitor
/// uses).
const FILE_BUFFER_BYTES: usize = 512 * 1024;
/// Largest buffer a network share accepts; larger reads fail with
/// `ERROR_INVALID_PARAMETER`. Directory changes are rare enough for it
/// everywhere.
const NETWORK_BUFFER_BYTES: usize = 64 * 1024;
/// Files: created, removed, renamed, written. Directories are reported by a
/// stream of their own.
const FILE_FILTER: u32 =
	FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;
const DIR_FILTER: u32 = FILE_NOTIFY_CHANGE_DIR_NAME;
/// Reads taken back to back into one batch once a gathering window closed.
const DRAIN_ROUNDS: usize = 16;

/// The running watch; dropping it stops the reader threads without waiting.
pub(crate) struct Watch {
	stop: OwnedHandle,
}

impl Watch {
	pub(crate) fn start(roots: &[Root], timing: Timing, emitter: Emitter) -> io::Result<Self> {
		// Dropped on an early return, which stops the readers already started.
		let this = Self { stop: event()? };
		let emitter = Arc::new(Mutex::new(emitter));
		for (index, root) in roots.iter().enumerate() {
			let target = Target::new(index as u32, root);
			let stop = this.stop.try_clone()?;
			let emitter = Arc::clone(&emitter);
			let (ready_tx, ready_rx) = mpsc::sync_channel(1);
			let thread = thread::Builder::new()
				.name("omp-dir-watch".into())
				.spawn(move || {
					// Opened here: the reads are cancelled by the thread that
					// issued them.
					Reader { target, streams: None, stop, timing, emitter }.run(&ready_tx);
				})?;
			// The first reads register the watch with the kernel; changes from
			// then on are queued even while no read is pending.
			match ready_rx.recv() {
				Ok(Ok(())) => {},
				Ok(Err(error)) => {
					let _ = thread.join();
					return Err(error);
				},
				Err(_) => {
					let _ = thread.join();
					return Err(io::Error::other("watcher thread exited before starting"));
				},
			}
		}
		Ok(this)
	}
}

impl Drop for Watch {
	fn drop(&mut self) {
		// The threads own their handles and buffers and cancel their reads
		// themselves; joining here would block on that cancellation (a round
		// trip on a network share).
		// SAFETY: `stop` is a live event handle.
		unsafe { SetEvent(self.stop.as_raw_handle() as HANDLE) };
	}
}

/// What one reader thread watches.
struct Target {
	root:      u32,
	/// The root's path.
	path:      PathBuf,
	/// The root's path as the caller named it, which events are reported
	/// under.
	prefix:    Box<[u8]>,
	/// Whether a directory root's subtree is watched.
	deep:      bool,
	/// The directory the streams read: the root, or a file root's directory.
	dir:       PathBuf,
	recursive: bool,
	/// A file root's name in `dir`: only that entry is reported, as the root.
	file:      Option<Vec<u16>>,
}

impl Target {
	fn new(index: u32, root: &Root) -> Self {
		Self {
			root:      index,
			path:      root.path.clone(),
			prefix:    root.path.as_os_str().as_encoded_bytes().into(),
			deep:      root.recursive,
			dir:       root.path.clone(),
			recursive: root.recursive,
			file:      None,
		}
	}

	/// Decides what to read for the root as it is now: a directory itself, a
	/// file through its directory.
	fn resolve(&mut self) -> io::Result<()> {
		let metadata =
			std::fs::metadata(&self.path).map_err(|error| missing_root(&self.path, &error))?;
		if metadata.is_dir() {
			self.dir.clone_from(&self.path);
			self.recursive = self.deep;
			self.file = None;
			return Ok(());
		}
		let (Some(parent), Some(name)) = (self.path.parent(), self.path.file_name()) else {
			return Err(io::ErrorKind::InvalidInput.into());
		};
		self.dir = if parent.as_os_str().is_empty() {
			PathBuf::from(".")
		} else {
			parent.to_path_buf()
		};
		self.recursive = false;
		self.file = Some(name.encode_wide().collect());
		Ok(())
	}

	/// Whether `name`, an entry of the directory, is the file root.
	fn names_file(file: &[u16], name: &[u16]) -> bool {
		let lower = |unit: u16| match u8::try_from(unit) {
			Ok(byte) => u16::from(byte.to_ascii_lowercase()),
			Err(_) => unit,
		};
		file.len() == name.len() && file.iter().zip(name).all(|(&a, &b)| lower(a) == lower(b))
	}
}

/// One `ReadDirectoryChangesW` stream over its own handle to the directory.
struct Stream {
	directory:   OwnedHandle,
	io:          OwnedHandle,
	filter:      u32,
	/// u64 elements keep the buffer DWORD-aligned, as the API requires.
	buffer:      Vec<u64>,
	len:         usize,
	/// Changes from this stream are directories.
	directories: bool,
	/// Boxed: a pending read keeps a pointer to it.
	overlapped:  Box<OVERLAPPED>,
	pending:     bool,
}

enum Read {
	/// The first this many bytes of the buffer hold change records.
	Changes(usize),
	Overflow,
	/// The read was retried with a smaller buffer; nothing to report.
	Rearmed,
}

impl Stream {
	fn open(dir: &Path, filter: u32, len: usize, directories: bool) -> io::Result<Self> {
		let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
		// SAFETY: `wide` is NUL-terminated and outlives the call.
		let raw = unsafe {
			CreateFileW(
				wide.as_ptr(),
				FILE_LIST_DIRECTORY,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				ptr::null(),
				OPEN_EXISTING,
				FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
				ptr::null_mut(),
			)
		};
		if raw == INVALID_HANDLE_VALUE {
			return Err(last_error(&format!("open {}", dir.display())));
		}
		// SAFETY: `raw` is a valid handle this function exclusively owns.
		let directory = unsafe { OwnedHandle::from_raw_handle(raw) };
		let len = len.max(4096);
		Ok(Self {
			directory,
			io: event()?,
			filter,
			buffer: vec![0u64; len.div_ceil(8)],
			len,
			directories,
			// SAFETY: OVERLAPPED is plain data; zeroed is its documented
			// initial state.
			overlapped: Box::new(unsafe { mem::zeroed() }),
			pending: false,
		})
	}

	fn handle(&self) -> HANDLE {
		self.directory.as_raw_handle() as HANDLE
	}

	fn io(&self) -> HANDLE {
		self.io.as_raw_handle() as HANDLE
	}

	/// Issue a read, falling back to the network buffer size when the
	/// volume rejects the larger one.
	fn arm(&mut self, recursive: bool) -> io::Result<()> {
		loop {
			// SAFETY: as in `open`.
			*self.overlapped = unsafe { mem::zeroed() };
			self.overlapped.hEvent = self.io();
			// SAFETY: `buffer` holds at least `len` bytes and, like the boxed
			// `overlapped`, stays in place until the read completes or is
			// cancelled (`cancel`, also run on drop).
			let issued = unsafe {
				ReadDirectoryChangesW(
					self.handle(),
					self.buffer.as_mut_ptr().cast(),
					self.len as u32,
					i32::from(recursive),
					self.filter,
					ptr::null_mut(),
					&raw mut *self.overlapped,
					None,
				)
			};
			if issued != 0 {
				self.pending = true;
				return Ok(());
			}
			// SAFETY: no intervening calls since the failure.
			if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER && self.len > NETWORK_BUFFER_BYTES
			{
				self.len = NETWORK_BUFFER_BYTES;
				continue;
			}
			return Err(last_error("ReadDirectoryChangesW"));
		}
	}

	/// Collect the read whose event fired.
	fn complete(&mut self, recursive: bool) -> io::Result<Read> {
		self.pending = false;
		let mut bytes = 0u32;
		// SAFETY: the read signalled completion.
		if unsafe { GetOverlappedResult(self.handle(), &raw const *self.overlapped, &mut bytes, 0) }
			== 0
		{
			// SAFETY: no intervening calls since the failure.
			return match unsafe { GetLastError() } {
				ERROR_NOTIFY_ENUM_DIR => Ok(Read::Overflow),
				ERROR_INVALID_PARAMETER if self.len > NETWORK_BUFFER_BYTES => {
					self.len = NETWORK_BUFFER_BYTES;
					self.arm(recursive)?;
					Ok(Read::Rearmed)
				},
				ERROR_OPERATION_ABORTED => Err(io::Error::other("watch cancelled")),
				_ => Err(last_error("watch")),
			};
		}
		if bytes == 0 {
			return Ok(Read::Overflow);
		}
		Ok(Read::Changes(bytes as usize))
	}

	/// Whether the pending read has completed already.
	fn completed(&self) -> bool {
		// SAFETY: `io` is a live event handle.
		unsafe { WaitForSingleObject(self.io(), 0) == WAIT_OBJECT_0 }
	}

	/// Cancel a pending read and wait until the kernel no longer writes
	/// into the buffer.
	fn cancel(&mut self) {
		if !self.pending {
			return;
		}
		self.pending = false;
		let mut bytes = 0u32;
		// SAFETY: the read is pending on this handle with this OVERLAPPED.
		unsafe {
			CancelIoEx(self.handle(), &raw const *self.overlapped);
			GetOverlappedResult(self.handle(), &raw const *self.overlapped, &mut bytes, 1);
		}
	}
}

impl Drop for Stream {
	fn drop(&mut self) {
		self.cancel();
	}
}

struct Reader {
	target:  Target,
	/// The file stream and the directory stream; `None` while the root is
	/// gone.
	streams: Option<[Stream; 2]>,
	stop:    OwnedHandle,
	timing:  Timing,
	emitter: Arc<Mutex<Emitter>>,
}

impl Reader {
	fn run(mut self, ready: &mpsc::SyncSender<io::Result<()>>) {
		let mut present = match self.open() {
			Ok(()) => true,
			// An awaited root that does not exist yet.
			Err(_) if self.timing.await_missing && !self.target.path.exists() => false,
			Err(error) => {
				let _ = ready.send(Err(error));
				return;
			},
		};
		let _ = ready.send(Ok(()));
		loop {
			if present {
				let Err(error) = self.read() else {
					return;
				};
				let gone = !self.target.dir.exists();
				if !(gone && self.timing.await_missing) {
					// Cancels the reads and closes the handles.
					self.streams = None;
					self.emit(|emitter| emitter.fail(error));
					return;
				}
				self.report_root(Flags::REMOVED);
			}
			loop {
				self.streams = None;
				if self.stopped(MISSING_ROOT_RECHECK) {
					return;
				}
				if self.open().is_ok() {
					break;
				}
			}
			self.report_root(Flags::CREATED);
			present = true;
		}
	}

	/// Opens both streams and issues their first reads.
	fn open(&mut self) -> io::Result<()> {
		self.target.resolve()?;
		let dir = &self.target.dir;
		let files = self.timing.buffer_bytes.unwrap_or(FILE_BUFFER_BYTES);
		let streams = self.streams.insert([
			Stream::open(dir, FILE_FILTER, files, false)?,
			Stream::open(dir, DIR_FILTER, NETWORK_BUFFER_BYTES, true)?,
		]);
		for stream in streams {
			stream.arm(self.target.recursive)?;
		}
		Ok(())
	}

	fn emit(&self, deliver: impl FnOnce(&mut Emitter)) {
		let mut emitter = self.emitter.lock().unwrap_or_else(PoisonError::into_inner);
		deliver(&mut emitter);
	}

	/// Reports the root itself as removed or created.
	fn report_root(&self, change: Flags) {
		let Target { root, prefix, file, .. } = &self.target;
		let kind = if file.is_some() {
			Flags::IS_FILE
		} else {
			Flags::IS_DIR
		};
		self.emit(|emitter| {
			emitter.push(*root, prefix, change | kind, 0, 0);
			emitter.flush();
		});
	}

	/// Waits for `timeout`; `true` when the watch was stopped meanwhile.
	fn stopped(&self, timeout: Duration) -> bool {
		let millis = u32::try_from(timeout.as_millis()).unwrap_or(INFINITE - 1);
		// SAFETY: `stop` is a live event handle.
		unsafe { WaitForSingleObject(self.stop.as_raw_handle() as HANDLE, millis) == WAIT_OBJECT_0 }
	}

	/// Reads changes until the watch is stopped (`Ok`) or a read fails.
	fn read(&mut self) -> io::Result<()> {
		let Timing { latency, no_defer, .. } = self.timing;
		let recursive = self.target.recursive;
		let stop = self.stop.as_raw_handle() as HANDLE;
		loop {
			let Some(streams) = &mut self.streams else {
				return Ok(());
			};
			let handles = [streams[0].io(), streams[1].io(), stop];
			// SAFETY: all three are live events.
			let woke = unsafe { WaitForMultipleObjects(3, handles.as_ptr(), 0, INFINITE) };
			let index = woke.wrapping_sub(WAIT_OBJECT_0) as usize;
			// The stop event, or a failed wait: the streams cancel their reads
			// on drop.
			if index >= 2 {
				return Ok(());
			}
			if !no_defer && !latency.is_zero() && self.stopped(latency) {
				return Ok(());
			}
			let Some(streams) = &mut self.streams else {
				return Ok(());
			};
			let stream = &mut streams[index];
			let mut emitter = self.emitter.lock().unwrap_or_else(PoisonError::into_inner);
			let mut armed = false;
			for _ in 0..DRAIN_ROUNDS {
				match stream.complete(recursive) {
					Ok(Read::Changes(bytes)) => {
						parse(&stream.buffer, bytes, stream.directories, &self.target, &mut emitter);
					},
					Ok(Read::Overflow) => {
						emitter.push(self.target.root, &self.target.prefix, Flags::OVERFLOW, 0, 0);
					},
					Ok(Read::Rearmed) => {
						armed = true;
						break;
					},
					Err(error) => {
						emitter.flush();
						return Err(error);
					},
				}
				// Without a gathering window, the kernel gathers while no read
				// is pending: deliver, pause, then read again.
				if no_defer {
					break;
				}
				// What queued up during the window comes with the next reads.
				stream.arm(recursive)?;
				armed = true;
				if !stream.completed() {
					break;
				}
				armed = false;
			}
			emitter.flush();
			drop(emitter);
			if armed {
				continue;
			}
			if no_defer && !latency.is_zero() && self.stopped(latency) {
				return Ok(());
			}
			let Some(streams) = &mut self.streams else {
				return Ok(());
			};
			let stream = &mut streams[index];
			// A read left completed by the last drain round is collected by
			// the next wait.
			if !stream.pending {
				stream.arm(recursive)?;
			}
		}
	}
}

/// Decode the `FILE_NOTIFY_INFORMATION` records in the first `bytes` of
/// `buffer` into events.
fn parse(buffer: &[u64], bytes: usize, directories: bool, target: &Target, emitter: &mut Emitter) {
	let base = buffer.as_ptr().cast::<u8>();
	let name_offset = mem::offset_of!(FILE_NOTIFY_INFORMATION, FileName);
	let mut offset = 0usize;
	while offset + name_offset <= bytes {
		// SAFETY: the kernel wrote well-formed, DWORD-aligned records into the
		// first `bytes` of the buffer; the header lies within them (checked
		// above).
		let record = unsafe { &*base.add(offset).cast::<FILE_NOTIFY_INFORMATION>() };
		let name_len = record.FileNameLength as usize / 2;
		if offset + name_offset + name_len * 2 > bytes {
			break;
		}
		// SAFETY: the name's UTF-16 units follow the header within `bytes`
		// (checked above).
		let name = unsafe {
			std::slice::from_raw_parts(base.add(offset + name_offset).cast::<u16>(), name_len)
		};
		// A modification on the file stream may also name a directory whose
		// entries changed, so it carries no type.
		let kind = if directories {
			Flags::IS_DIR
		} else {
			Flags::IS_FILE
		};
		let flags = match record.Action {
			FILE_ACTION_ADDED => Some(Flags::CREATED | kind),
			FILE_ACTION_REMOVED => Some(Flags::REMOVED | kind),
			FILE_ACTION_MODIFIED if directories => Some(Flags::UPDATED | kind),
			FILE_ACTION_MODIFIED => Some(Flags::UPDATED),
			FILE_ACTION_RENAMED_OLD_NAME => Some(Flags::RENAMED | Flags::MOVED_FROM | kind),
			FILE_ACTION_RENAMED_NEW_NAME => Some(Flags::RENAMED | Flags::MOVED_TO | kind),
			_ => None,
		};
		if let Some(flags) = flags {
			match &target.file {
				None => emitter.push_wide(target.root, &target.prefix, name, flags, record.Action, 0),
				Some(file) if Target::names_file(file, name) => {
					emitter.push(target.root, &target.prefix, flags, record.Action, 0);
				},
				Some(_) => {},
			}
		}
		if record.NextEntryOffset == 0 {
			break;
		}
		offset += record.NextEntryOffset as usize;
	}
}

/// A manual-reset, initially unsignalled event.
fn event() -> io::Result<OwnedHandle> {
	// SAFETY: default security, no name.
	let raw = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
	if raw.is_null() {
		return Err(last_error("CreateEventW"));
	}
	// SAFETY: `raw` is a valid handle this function exclusively owns.
	Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn last_error(what: &str) -> io::Error {
	let error = io::Error::last_os_error();
	io::Error::new(error.kind(), format!("{what}: {error}"))
}
