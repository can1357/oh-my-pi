//! Directory change watching for Windows via `ReadDirectoryChangesW`.
//!
//! Bun's `fs.watch` on Windows goes through libuv, which reads changes into a
//! 4 KiB buffer and re-arms only after every JS callback ran; bursts overflow
//! it and cost a callback per change. This watcher is [`pi_watch`]'s: it reads
//! on its own thread with overlapped I/O and a large buffer, waits briefly
//! between reads so the kernel gathers changes, and hands JS one batch per
//! read. Other platforms keep using `fs.watch`, which is lossless and cheap
//! there.

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
	inner: Option<pi_watch::Watcher>,
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
				Ok(DirectoryWatcher { inner: Some(platform::start(dir, recursive, callback)?) })
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
	use std::{path::PathBuf, time::Duration};

	use napi::threadsafe_function::ThreadsafeFunctionCallMode;
	use pi_watch::{Config, Flags, Root, Watcher};

	use super::{ChangeSink, DirectoryChange, DirectoryChangeAction, DirectoryChanges};

	/// Pause between reads: the kernel keeps gathering changes for the open
	/// handle meanwhile, so a burst costs a few reads instead of one per change.
	const COALESCE: Duration = Duration::from_millis(20);

	/// The action a change's flags stand for.
	fn action(flags: Flags) -> Option<DirectoryChangeAction> {
		[
			(Flags::MOVED_FROM, DirectoryChangeAction::RenamedFrom),
			(Flags::MOVED_TO, DirectoryChangeAction::RenamedTo),
			(Flags::CREATED, DirectoryChangeAction::Added),
			(Flags::REMOVED, DirectoryChangeAction::Removed),
			(Flags::UPDATED, DirectoryChangeAction::Modified),
		]
		.into_iter()
		.find(|&(flag, _)| flags.contains(flag))
		.map(|(_, action)| action)
	}

	/// Watches `dir`, handing `sink` one batch per read and, once, the error
	/// that ended the watch.
	pub fn start(dir: String, recursive: bool, sink: ChangeSink) -> napi::Result<Watcher> {
		let root = PathBuf::from(dir);
		let mut config = Config::new([Root { path: root.clone(), recursive }]);
		config.latency = COALESCE;
		config.no_defer = true;
		// One change per record, in the order they happened.
		config.coalesce = false;
		// A removed directory ends the watch.
		config.await_missing = false;
		Watcher::start(config, move |batch| {
			let batch = match batch {
				Ok(batch) => batch,
				Err(error) => {
					sink.call(
						Err(napi::Error::from_reason(error.to_string())),
						ThreadsafeFunctionCallMode::NonBlocking,
					);
					return;
				},
			};
			let changes = batch
				.iter()
				.filter_map(|event| {
					let action = action(event.flags)?;
					let path = event.path.strip_prefix(&root).unwrap_or(event.path);
					Some(DirectoryChange {
						path: path.to_string_lossy().into_owned(),
						action,
						directory: event.flags.contains(Flags::IS_DIR),
					})
				})
				.collect();
			sink.call(
				Ok(DirectoryChanges { changes, overflow: batch.overflowed() }),
				ThreadsafeFunctionCallMode::NonBlocking,
			);
		})
		.map_err(|error| napi::Error::from_reason(error.to_string()))
	}
}
