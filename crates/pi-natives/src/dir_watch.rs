//! Directory change watching for Windows via `ReadDirectoryChangesW`.
//!
//! Bun's `fs.watch` on Windows goes through libuv, which reads changes into a
//! 4 KiB buffer and re-arms only after every JS callback ran; bursts overflow
//! it and cost a callback per change. This watcher reads on its own thread
//! with overlapped I/O and a large buffer, waits briefly between reads so the
//! kernel gathers changes, and hands JS one batch per read. Other platforms
//! keep using `fs.watch`, which is lossless and cheap there.

use napi::{Status, bindgen_prelude::Unknown, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;

use crate::task;

/// What happened to an entry, as reported by the file system.
#[napi(string_enum)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryChangeAction {
	#[napi(value = "added")]
	Added,
	#[napi(value = "removed")]
	Removed,
	#[napi(value = "modified")]
	Modified,
	/// The entry's old name in a rename.
	#[napi(value = "renamedFrom")]
	RenamedFrom,
	/// The entry's new name in a rename.
	#[napi(value = "renamedTo")]
	RenamedTo,
}

/// One change below the watched directory.
#[napi(object)]
pub struct DirectoryChange {
	/// Path relative to the watched directory, with the platform's separators.
	pub path:      String,
	pub action:    DirectoryChangeAction,
	/// The entry is a directory. Always false for `modified`, which may also
	/// name a directory whose entries changed.
	pub directory: bool,
}

/// Changes gathered by one read, in the order they happened.
#[napi(object)]
pub struct DirectoryChanges {
	pub changes:  Vec<DirectoryChange>,
	/// Changes were lost (the change buffer overflowed); rescan the directory.
	pub overflow: bool,
}

/// Receives every batch; an error ends the watch (e.g. the directory was
/// removed). Weak: a watcher never keeps the process alive.
type ChangeSink =
	ThreadsafeFunction<DirectoryChanges, Unknown<'static>, DirectoryChanges, Status, true, true>;

/// Watches one directory for changes until closed.
#[napi]
pub struct DirectoryWatcher {
	#[cfg(windows)]
	inner: Option<platform::Watch>,
}

#[napi]
impl DirectoryWatcher {
	/// Start watching `dir`, its whole subtree when `recursive`. Changes that
	/// happen once the promise resolves are reported. Opening the directory and
	/// arming the first read run off the JS thread (each is a round trip on a
	/// network share). Rejects when the directory cannot be opened or watched;
	/// on platforms other than Windows, always.
	#[napi(ts_return_type = "Promise<DirectoryWatcher>")]
	#[allow(
		clippy::use_self,
		reason = "napi expands this into a wrapper where `Self` does not resolve"
	)]
	pub fn start(
		dir: String,
		recursive: bool,
		#[napi(ts_arg_type = "(err: null | Error, changes: DirectoryChanges) => void")]
		callback: ChangeSink,
	) -> task::Promise<DirectoryWatcher> {
		task::blocking("dir_watch.start", (), move |_| {
			#[cfg(windows)]
			{
				Ok(DirectoryWatcher { inner: Some(platform::Watch::start(&dir, recursive, callback)?) })
			}
			#[cfg(not(windows))]
			{
				let _ = (dir, recursive, callback);
				Err(napi::Error::from_reason("DirectoryWatcher is only available on Windows"))
			}
		})
	}

	/// Stop watching without waiting: the reader thread cancels its pending
	/// reads (a round trip on a network share) and exits on its own. Batches or
	/// an error it queued before stopping may still reach the callback
	/// afterwards; ignore them.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
	pub fn close(&mut self) {
		#[cfg(windows)]
		drop(self.inner.take());
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		mem,
		os::windows::{
			ffi::OsStrExt,
			io::{AsRawHandle, FromRawHandle, OwnedHandle},
		},
		path::Path,
		ptr,
		sync::mpsc,
		thread,
	};

	use napi::threadsafe_function::ThreadsafeFunctionCallMode;
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
			FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
			OPEN_EXISTING, ReadDirectoryChangesW,
		},
		System::{
			IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
			Threading::{
				CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
			},
		},
	};

	use super::{ChangeSink, DirectoryChange, DirectoryChangeAction, DirectoryChanges};

	/// Read buffer for file changes on local volumes (what git's fsmonitor
	/// uses).
	const FILE_BUFFER_BYTES: usize = 512 * 1024;
	/// Largest buffer a network share accepts; larger reads fail with
	/// `ERROR_INVALID_PARAMETER`. Directory changes are rare enough for it
	/// everywhere.
	const NETWORK_BUFFER_BYTES: usize = 64 * 1024;
	/// Pause between reads: the kernel keeps gathering changes for the open
	/// handle meanwhile, so a burst costs a few reads instead of one per change.
	const COALESCE_MS: u32 = 20;
	/// Files: created, removed, renamed, written. Directories are reported by a
	/// stream of their own, so every change says whether its entry is one (plain
	/// `ReadDirectoryChangesW` does not, and the `Ex` variant fails on SMB).
	const FILE_FILTER: u32 =
		FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;
	const DIR_FILTER: u32 = FILE_NOTIFY_CHANGE_DIR_NAME;

	/// The running watch; dropping it stops the reader thread without waiting.
	pub struct Watch {
		stop: OwnedHandle,
	}

	impl Watch {
		pub fn start(dir: &str, recursive: bool, sink: ChangeSink) -> napi::Result<Self> {
			let dir = dir.to_owned();
			let stop = event()?;
			let stop_for_thread = stop
				.try_clone()
				.map_err(|error| napi::Error::from_reason(error.to_string()))?;
			let (ready_tx, ready_rx) = mpsc::sync_channel(1);
			let thread = thread::Builder::new()
				.name("omp-dir-watch".into())
				.spawn(move || {
					// Opened here: a pending read's OVERLAPPED must not cross
					// threads.
					let streams =
						Stream::open(&dir, FILE_FILTER, FILE_BUFFER_BYTES, false).and_then(|files| {
							Ok([files, Stream::open(&dir, DIR_FILTER, NETWORK_BUFFER_BYTES, true)?])
						});
					match streams {
						Ok(streams) => {
							Reader { streams, stop: stop_for_thread, recursive, sink }.run(&ready_tx);
						},
						Err(error) => drop(ready_tx.send(Err(error))),
					}
				})
				.map_err(|error| napi::Error::from_reason(format!("spawn watcher thread: {error}")))?;
			// The first reads register the watch with the kernel; changes from
			// then on are queued even while no read is pending.
			match ready_rx.recv() {
				Ok(Ok(())) => Ok(Self { stop }),
				Ok(Err(error)) => {
					let _ = thread.join();
					Err(error)
				},
				Err(_) => {
					let _ = thread.join();
					Err(napi::Error::from_reason("watcher thread exited before starting"))
				},
			}
		}
	}

	impl Drop for Watch {
		fn drop(&mut self) {
			// The thread owns its handles and buffers and cancels its reads
			// itself; joining here would block JS on that cancellation.
			// SAFETY: `stop` is a live event handle.
			unsafe { SetEvent(self.stop.as_raw_handle() as HANDLE) };
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
		overlapped:  OVERLAPPED,
		pending:     bool,
	}

	enum Read {
		Changes(Vec<DirectoryChange>),
		Overflow,
		/// The read was retried with a smaller buffer; nothing to report.
		Rearmed,
	}

	impl Stream {
		fn open(dir: &str, filter: u32, len: usize, directories: bool) -> napi::Result<Self> {
			let wide: Vec<u16> = Path::new(dir)
				.as_os_str()
				.encode_wide()
				.chain([0])
				.collect();
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
				return Err(last_error(&format!("open {dir}")));
			}
			// SAFETY: `raw` is a valid handle this function exclusively owns.
			let directory = unsafe { OwnedHandle::from_raw_handle(raw) };
			Ok(Self {
				directory,
				io: event()?,
				filter,
				buffer: vec![0u64; len / 8],
				len,
				directories,
				// SAFETY: OVERLAPPED is plain data; zeroed is its documented
				// initial state.
				overlapped: unsafe { mem::zeroed() },
				pending: false,
			})
		}

		fn handle(&self) -> HANDLE {
			self.directory.as_raw_handle() as HANDLE
		}

		/// Issue a read, falling back to the network buffer size when the
		/// volume rejects the larger one. The stream must not move while the
		/// read is pending.
		fn arm(&mut self, recursive: bool) -> napi::Result<()> {
			loop {
				// SAFETY: as in `open`.
				self.overlapped = unsafe { mem::zeroed() };
				self.overlapped.hEvent = self.io.as_raw_handle() as HANDLE;
				// SAFETY: `buffer` holds at least `len` bytes and, like
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
						&mut self.overlapped,
						None,
					)
				};
				if issued != 0 {
					self.pending = true;
					return Ok(());
				}
				// SAFETY: no intervening calls since the failure.
				if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER
					&& self.len > NETWORK_BUFFER_BYTES
				{
					self.len = NETWORK_BUFFER_BYTES;
					continue;
				}
				return Err(last_error("ReadDirectoryChangesW"));
			}
		}

		/// Collect the read whose event fired.
		fn complete(&mut self, recursive: bool) -> napi::Result<Read> {
			self.pending = false;
			let mut bytes = 0u32;
			// SAFETY: the read signalled completion.
			if unsafe { GetOverlappedResult(self.handle(), &self.overlapped, &mut bytes, 0) } == 0 {
				// SAFETY: no intervening calls since the failure.
				return match unsafe { GetLastError() } {
					ERROR_NOTIFY_ENUM_DIR => Ok(Read::Overflow),
					ERROR_INVALID_PARAMETER if self.len > NETWORK_BUFFER_BYTES => {
						self.len = NETWORK_BUFFER_BYTES;
						self.arm(recursive)?;
						Ok(Read::Rearmed)
					},
					ERROR_OPERATION_ABORTED => Err(napi::Error::from_reason("watch cancelled")),
					_ => Err(last_error("watch")),
				};
			}
			if bytes == 0 {
				return Ok(Read::Overflow);
			}
			Ok(Read::Changes(parse(&self.buffer, bytes as usize, self.directories)))
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
				CancelIoEx(self.handle(), &self.overlapped);
				GetOverlappedResult(self.handle(), &self.overlapped, &mut bytes, 1);
			}
		}
	}

	impl Drop for Stream {
		fn drop(&mut self) {
			self.cancel();
		}
	}

	struct Reader {
		streams:   [Stream; 2],
		stop:      OwnedHandle,
		recursive: bool,
		sink:      ChangeSink,
	}

	impl Reader {
		fn run(mut self, ready: &mpsc::SyncSender<napi::Result<()>>) {
			for stream in &mut self.streams {
				if let Err(error) = stream.arm(self.recursive) {
					let _ = ready.send(Err(error));
					return;
				}
			}
			let _ = ready.send(Ok(()));
			let stop = self.stop.as_raw_handle() as HANDLE;
			loop {
				let handles = [
					self.streams[0].io.as_raw_handle() as HANDLE,
					self.streams[1].io.as_raw_handle() as HANDLE,
					stop,
				];
				// SAFETY: all three are live events.
				let woke = unsafe { WaitForMultipleObjects(3, handles.as_ptr(), 0, INFINITE) };
				let index = woke.wrapping_sub(WAIT_OBJECT_0) as usize;
				// The stop event, or a failed wait: the streams cancel their reads
				// on drop.
				if index >= 2 {
					return;
				}
				let stream = &mut self.streams[index];
				let batch = match stream.complete(self.recursive) {
					Ok(Read::Changes(changes)) => DirectoryChanges { changes, overflow: false },
					Ok(Read::Overflow) => DirectoryChanges { changes: Vec::new(), overflow: true },
					Ok(Read::Rearmed) => continue,
					Err(error) => {
						let _ = self
							.sink
							.call(Err(error), ThreadsafeFunctionCallMode::NonBlocking);
						return;
					},
				};
				self
					.sink
					.call(Ok(batch), ThreadsafeFunctionCallMode::NonBlocking);
				// SAFETY: `stop` is a live event handle.
				if unsafe { WaitForSingleObject(stop, COALESCE_MS) } == WAIT_OBJECT_0 {
					return;
				}
				if let Err(error) = self.streams[index].arm(self.recursive) {
					let _ = self
						.sink
						.call(Err(error), ThreadsafeFunctionCallMode::NonBlocking);
					return;
				}
			}
		}
	}

	/// Decode the `FILE_NOTIFY_INFORMATION` records in the first `bytes` of
	/// `buffer`.
	fn parse(buffer: &[u64], bytes: usize, directories: bool) -> Vec<DirectoryChange> {
		let base = buffer.as_ptr().cast::<u8>();
		let name_offset = mem::offset_of!(FILE_NOTIFY_INFORMATION, FileName);
		let mut changes = Vec::new();
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
			let action = match record.Action {
				FILE_ACTION_ADDED => Some(DirectoryChangeAction::Added),
				FILE_ACTION_REMOVED => Some(DirectoryChangeAction::Removed),
				FILE_ACTION_MODIFIED => Some(DirectoryChangeAction::Modified),
				FILE_ACTION_RENAMED_OLD_NAME => Some(DirectoryChangeAction::RenamedFrom),
				FILE_ACTION_RENAMED_NEW_NAME => Some(DirectoryChangeAction::RenamedTo),
				_ => None,
			};
			if let Some(action) = action {
				changes.push(DirectoryChange {
					path: String::from_utf16_lossy(name),
					action,
					directory: directories,
				});
			}
			if record.NextEntryOffset == 0 {
				break;
			}
			offset += record.NextEntryOffset as usize;
		}
		changes
	}

	/// A manual-reset, initially unsignalled event.
	fn event() -> napi::Result<OwnedHandle> {
		// SAFETY: default security, no name.
		let raw = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
		if raw.is_null() {
			return Err(last_error("CreateEventW"));
		}
		// SAFETY: `raw` is a valid handle this function exclusively owns.
		Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
	}

	fn last_error(what: &str) -> napi::Error {
		napi::Error::from_reason(format!("{what}: {}", std::io::Error::last_os_error()))
	}
}
