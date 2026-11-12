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
	pub path:   String,
	pub action: DirectoryChangeAction,
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
	/// happen once this returns are reported. Throws when the directory cannot
	/// be opened or watched; on platforms other than Windows, always.
	#[napi(factory)]
	pub fn start(
		dir: String,
		recursive: bool,
		#[napi(ts_arg_type = "(err: null | Error, changes: DirectoryChanges) => void")]
		callback: ChangeSink,
	) -> napi::Result<Self> {
		#[cfg(windows)]
		{
			Ok(Self { inner: Some(platform::Watch::start(&dir, recursive, callback)?) })
		}
		#[cfg(not(windows))]
		{
			let _ = (dir, recursive, callback);
			Err(napi::Error::from_reason("DirectoryWatcher is only available on Windows"))
		}
	}

	/// Stop watching and join the reader thread. Batches or an error it queued
	/// before stopping may still reach the callback afterwards; ignore them.
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
		thread::{self, JoinHandle},
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

	/// Read buffer for local volumes (what git's fsmonitor uses).
	const LOCAL_BUFFER_BYTES: usize = 512 * 1024;
	/// Largest buffer a network share accepts; larger reads fail with
	/// `ERROR_INVALID_PARAMETER`.
	const NETWORK_BUFFER_BYTES: usize = 64 * 1024;
	/// Pause between reads: the kernel keeps gathering changes for the open
	/// handle meanwhile, so a burst costs a few reads instead of one per change.
	const COALESCE_MS: u32 = 20;
	const NOTIFY_FILTER: u32 = FILE_NOTIFY_CHANGE_FILE_NAME
		| FILE_NOTIFY_CHANGE_DIR_NAME
		| FILE_NOTIFY_CHANGE_SIZE
		| FILE_NOTIFY_CHANGE_LAST_WRITE;

	pub struct Watch {
		stop:   OwnedHandle,
		thread: Option<JoinHandle<()>>,
	}

	impl Watch {
		pub fn start(dir: &str, recursive: bool, sink: ChangeSink) -> napi::Result<Self> {
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
			let stop = event()?;
			let io = event()?;
			let stop_for_thread = stop
				.try_clone()
				.map_err(|error| napi::Error::from_reason(error.to_string()))?;
			let (ready_tx, ready_rx) = mpsc::sync_channel(1);
			let thread = thread::Builder::new()
				.name("omp-dir-watch".into())
				.spawn(move || {
					Reader { directory, io, stop: stop_for_thread, recursive, sink }.run(&ready_tx);
				})
				.map_err(|error| napi::Error::from_reason(format!("spawn watcher thread: {error}")))?;
			// The first read registers the watch with the kernel; changes from
			// then on are queued even while no read is pending.
			match ready_rx.recv() {
				Ok(Ok(())) => Ok(Self { stop, thread: Some(thread) }),
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
			// SAFETY: `stop` is a live event handle.
			unsafe { SetEvent(self.stop.as_raw_handle() as HANDLE) };
			if let Some(thread) = self.thread.take() {
				let _ = thread.join();
			}
		}
	}

	struct Reader {
		directory: OwnedHandle,
		io:        OwnedHandle,
		stop:      OwnedHandle,
		recursive: bool,
		sink:      ChangeSink,
	}

	enum Read {
		Changes(Vec<DirectoryChange>),
		Overflow,
		Stopped,
	}

	impl Reader {
		fn run(self, ready: &mpsc::SyncSender<napi::Result<()>>) {
			// u64 elements keep the buffer DWORD-aligned, as the API requires.
			let mut buffer = vec![0u64; LOCAL_BUFFER_BYTES / 8];
			let mut len = LOCAL_BUFFER_BYTES;
			let mut ready = Some(ready);
			loop {
				let read = self.read(&mut buffer, &mut len, &mut ready);
				let batch = match read {
					Ok(Read::Changes(changes)) => DirectoryChanges { changes, overflow: false },
					Ok(Read::Overflow) => DirectoryChanges { changes: Vec::new(), overflow: true },
					Ok(Read::Stopped) => return,
					Err(error) => {
						match ready.take() {
							Some(ready) => drop(ready.send(Err(error))),
							None => drop(
								self
									.sink
									.call(Err(error), ThreadsafeFunctionCallMode::NonBlocking),
							),
						}
						return;
					},
				};
				self
					.sink
					.call(Ok(batch), ThreadsafeFunctionCallMode::NonBlocking);
				// SAFETY: `stop` is a live event handle.
				if unsafe { WaitForSingleObject(self.stop.as_raw_handle() as HANDLE, COALESCE_MS) }
					== WAIT_OBJECT_0
				{
					return;
				}
			}
		}

		/// One overlapped read: issue it, report readiness after the first one,
		/// then wait for changes or a stop request.
		fn read(
			&self,
			buffer: &mut [u64],
			len: &mut usize,
			ready: &mut Option<&mpsc::SyncSender<napi::Result<()>>>,
		) -> napi::Result<Read> {
			let directory = self.directory.as_raw_handle() as HANDLE;
			loop {
				// SAFETY: OVERLAPPED is plain data; zeroed is its documented
				// initial state.
				let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
				overlapped.hEvent = self.io.as_raw_handle() as HANDLE;
				// SAFETY: `buffer` holds at least `len` bytes and, like
				// `overlapped`, stays alive until the read completes or is
				// cancelled below.
				let issued = unsafe {
					ReadDirectoryChangesW(
						directory,
						buffer.as_mut_ptr().cast(),
						*len as u32,
						i32::from(self.recursive),
						NOTIFY_FILTER,
						ptr::null_mut(),
						&mut overlapped,
						None,
					)
				};
				if issued == 0 {
					// SAFETY: no intervening calls since the failure.
					if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER
						&& *len > NETWORK_BUFFER_BYTES
					{
						*len = NETWORK_BUFFER_BYTES;
						continue;
					}
					return Err(last_error("ReadDirectoryChangesW"));
				}
				if let Some(ready) = ready.take() {
					let _ = ready.send(Ok(()));
				}
				let handles = [overlapped.hEvent, self.stop.as_raw_handle() as HANDLE];
				// SAFETY: both handles are live events.
				let woke = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
				let mut bytes = 0u32;
				if woke != WAIT_OBJECT_0 {
					// SAFETY: cancel the read issued above, then wait for it to
					// settle so the kernel no longer writes into `buffer`.
					unsafe {
						CancelIoEx(directory, &overlapped);
						GetOverlappedResult(directory, &overlapped, &mut bytes, 1);
					}
					return Ok(Read::Stopped);
				}
				// SAFETY: the read signalled completion.
				if unsafe { GetOverlappedResult(directory, &overlapped, &mut bytes, 0) } == 0 {
					// SAFETY: no intervening calls since the failure.
					match unsafe { GetLastError() } {
						ERROR_NOTIFY_ENUM_DIR => return Ok(Read::Overflow),
						ERROR_INVALID_PARAMETER if *len > NETWORK_BUFFER_BYTES => {
							*len = NETWORK_BUFFER_BYTES;
							continue;
						},
						ERROR_OPERATION_ABORTED => return Ok(Read::Stopped),
						_ => return Err(last_error("watch")),
					}
				}
				if bytes == 0 {
					return Ok(Read::Overflow);
				}
				return Ok(Read::Changes(parse(buffer, bytes as usize)));
			}
		}
	}

	/// Decode the `FILE_NOTIFY_INFORMATION` records in the first `bytes` of
	/// `buffer`.
	fn parse(buffer: &[u64], bytes: usize) -> Vec<DirectoryChange> {
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
				changes.push(DirectoryChange { path: String::from_utf16_lossy(name), action });
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
