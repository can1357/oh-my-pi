//! File-system change notification on the operating system's own mechanism.
//!
//! One [`Watcher`] watches any number of files and directories and reports
//! what changed below them in batches:
//!
//! - macOS: an `FSEventStream` with file-level events; one stream covers every
//!   root, whatever the size of the trees.
//! - Linux: inotify, with watches added as directories appear and a rescan
//!   after a queue overflow.
//! - Windows: `ReadDirectoryChangesW` with overlapped reads into a large
//!   buffer, one handle pair per root for the whole subtree.
//! - On request ([`Backend::Kqueue`], [`Backend::Poll`]): kqueue vnode events,
//!   or periodic scans for file systems that deliver no notifications.
//!
//! A batch owns one path arena and one event array that the watcher reuses, so
//! a burst of thousands of changes allocates nothing per event. A file root
//! is watched by name through its directory: it survives being replaced
//! (write-temp-then-rename saves) and being deleted and created again.
//!
//! # Example
//! ```no_run
//! use pi_watch::{Config, Root, Watcher};
//!
//! let (watcher, batches) = Watcher::channel(Config::new([Root::recursive("/repo/src")]))?;
//! for batch in batches.iter() {
//! 	for event in batch?.iter() {
//! 		println!("{} {:?}", event.path.display(), event.flags);
//! 	}
//! }
//! drop(watcher);
//! # Ok::<(), std::io::Error>(())
//! ```

mod batch;
mod flags;
#[cfg(target_os = "macos")]
mod fsevents;
#[cfg(any(target_os = "linux", target_os = "android"))]
mod inotify;
#[cfg(target_os = "macos")]
mod kqueue;
mod poll;
#[cfg(windows)]
mod windows;

use std::{
	io,
	path::{Path, PathBuf},
	time::Duration,
};

use crate::batch::Emitter;
pub use crate::{
	batch::{Batch, Event},
	flags::Flags,
};

/// The mechanism a [`Watcher`] observes the file system with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Backend {
	/// The platform's native mechanism: [`Backend::FsEvents`] on macOS,
	/// [`Backend::Inotify`] on Linux, [`Backend::Windows`] on Windows, and
	/// [`Backend::Poll`] anywhere else.
	#[default]
	Default,
	/// macOS `FSEventStream`.
	FsEvents,
	/// Linux inotify.
	Inotify,
	/// macOS kqueue vnode events: one descriptor per watched file.
	Kqueue,
	/// Periodic scans comparing file metadata; works on every file system.
	Poll,
	/// Windows `ReadDirectoryChangesW`.
	Windows,
}

impl Backend {
	/// Every backend this platform can run, the native one first.
	#[must_use]
	pub const fn available() -> &'static [Self] {
		if cfg!(target_os = "macos") {
			&[Self::FsEvents, Self::Kqueue, Self::Poll]
		} else if cfg!(any(target_os = "linux", target_os = "android")) {
			&[Self::Inotify, Self::Poll]
		} else if cfg!(windows) {
			&[Self::Windows, Self::Poll]
		} else {
			&[Self::Poll]
		}
	}

	/// The backend [`Backend::Default`] stands for here; any other value is
	/// returned as it is.
	#[must_use]
	pub const fn resolve(self) -> Self {
		match self {
			Self::Default => Self::available()[0],
			other => other,
		}
	}

	/// The monitor name `fswatch` lists the backend under
	/// (`fsevents_monitor`, `inotify_monitor`, …).
	#[must_use]
	pub const fn monitor_name(self) -> &'static str {
		match self.resolve() {
			Self::FsEvents => "fsevents_monitor",
			Self::Inotify => "inotify_monitor",
			Self::Kqueue => "kqueue_monitor",
			Self::Windows => "windows_monitor",
			Self::Poll | Self::Default => "poll_monitor",
		}
	}

	/// The backend `fswatch` names `name` (`poll_monitor`, …).
	#[must_use]
	pub fn from_monitor_name(name: &str) -> Option<Self> {
		Some(match name {
			"fsevents_monitor" => Self::FsEvents,
			"inotify_monitor" => Self::Inotify,
			"kqueue_monitor" => Self::Kqueue,
			"windows_monitor" => Self::Windows,
			"poll_monitor" => Self::Poll,
			_ => return None,
		})
	}
}

/// One watched path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
	/// The absolute path of a file or directory. Events below it are
	/// reported with this prefix exactly as given.
	pub path:      PathBuf,
	/// Whether a directory's whole subtree is watched, or only its entries.
	pub recursive: bool,
}

impl Root {
	/// `path` with its whole subtree.
	pub fn recursive(path: impl Into<PathBuf>) -> Self {
		Self { path: path.into(), recursive: true }
	}

	/// `path` and, for a directory, its direct entries only.
	pub fn flat(path: impl Into<PathBuf>) -> Self {
		Self { path: path.into(), recursive: false }
	}
}

/// Decides whether an event is reported; runs on the watcher's thread.
pub type Filter = Box<dyn FnMut(&Path, Flags) -> bool + Send>;

/// Decides whether a directory below a recursive root is watched; runs on the
/// watcher's thread. Backends that watch a subtree through its root
/// (`FSEvents`, `ReadDirectoryChangesW`) never ask.
pub type Descend = Box<dyn FnMut(&Path) -> bool + Send>;

/// What a [`Watcher`] watches and how it reports.
pub struct Config {
	/// The watched paths.
	pub roots:          Vec<Root>,
	/// The mechanism to watch with.
	pub backend:        Backend,
	/// How long changes are gathered into one batch. With [`Config::no_defer`]
	/// unset, a batch is delivered this long after its first change; zero
	/// delivers as soon as the system reports.
	pub latency:        Duration,
	/// Deliver the first change after a quiet period at once and gather for
	/// [`Config::latency`] afterwards, instead of holding the first one back
	/// (`kFSEventStreamCreateFlagNoDefer`).
	pub no_defer:       bool,
	/// The time between two scans of [`Backend::Poll`].
	pub poll_interval:  Duration,
	/// Whether symbolic links to directories below a recursive root are
	/// watched as the directories they name.
	pub follow_links:   bool,
	/// Merge the events of one path within a batch into a single event
	/// carrying every flag, at the position of the first.
	pub coalesce:       bool,
	/// `FSEvents` reports a path's recent history as one flag set. With this
	/// set, the watcher checks whether such a path exists: a created-and-removed
	/// path keeps the flag that holds now, and a renamed one gains
	/// [`Flags::MOVED_FROM`] or [`Flags::MOVED_TO`].
	pub stat_ambiguous: bool,
	/// Wait for a root that does not exist, at the start or because it was
	/// removed, and report it created once it does, instead of failing the
	/// start or ending the watch with an error.
	pub await_missing:  bool,
	/// Report reads and opens as well ([`Flags::PLATFORM_SPECIFIC`], with the
	/// system's flags in [`Event::native`]); inotify only.
	pub access:         bool,
	/// Size of the buffer the system fills with changes; `None` uses the
	/// backend's own (`ReadDirectoryChangesW`: 512 KiB, inotify: 64 KiB).
	pub buffer_bytes:   Option<usize>,
	/// Report each path's file id (its inode) in [`Event::id`]; `FSEvents`
	/// only, where the stream then carries extended event data.
	pub file_ids:       bool,
	/// Drops events it returns `false` for before they are batched.
	pub filter:         Option<Filter>,
	/// Prunes directories it returns `false` for from recursive roots.
	pub descend:        Option<Descend>,
}

impl Config {
	/// A configuration watching `roots` natively: no latency, events
	/// coalesced per path, missing roots awaited.
	pub fn new(roots: impl IntoIterator<Item = Root>) -> Self {
		Self {
			roots:          roots.into_iter().collect(),
			backend:        Backend::Default,
			latency:        Duration::ZERO,
			no_defer:       false,
			poll_interval:  Duration::from_secs(1),
			follow_links:   false,
			coalesce:       true,
			stat_ambiguous: true,
			await_missing:  true,
			access:         false,
			buffer_bytes:   None,
			file_ids:       false,
			filter:         None,
			descend:        None,
		}
	}
}

/// The timing and recovery settings every backend shares.
#[derive(Clone, Copy)]
pub(crate) struct Timing {
	pub latency:       Duration,
	pub no_defer:      bool,
	pub await_missing: bool,
	#[cfg_attr(
		not(any(target_os = "linux", target_os = "android", windows)),
		allow(dead_code, reason = "only inotify and ReadDirectoryChangesW read into a buffer")
	)]
	pub buffer_bytes:  Option<usize>,
}

/// How long a backend sleeps between checks for a missing root.
pub(crate) const MISSING_ROOT_RECHECK: Duration = Duration::from_millis(250);

/// A running watch; dropping it stops the watch.
///
/// Do not drop it from inside its own sink.
pub struct Watcher {
	_backend: Running,
	backend:  Backend,
}

#[allow(dead_code, reason = "each variant only keeps its backend alive")]
enum Running {
	#[cfg(target_os = "macos")]
	FsEvents(fsevents::Stream),
	#[cfg(any(target_os = "linux", target_os = "android"))]
	Inotify(inotify::Inotify),
	#[cfg(windows)]
	Windows(windows::Watch),
	#[cfg(target_os = "macos")]
	Kqueue(kqueue::Kqueue),
	Poll(poll::Poll),
}

impl Watcher {
	/// Starts watching and calls `sink` with every batch, on a thread of the
	/// watcher's. Changes that happen once this returns are reported.
	///
	/// An `Err` passed to `sink` is final: the watch has ended.
	///
	/// # Errors
	///
	/// - [`io::ErrorKind::NotFound`]: a root does not exist and
	///   [`Config::await_missing`] is unset.
	/// - [`io::ErrorKind::Unsupported`]: the platform lacks [`Config::backend`].
	/// - Whatever the system reports when it cannot watch a root (the inotify
	///   watch limit, a denied open).
	pub fn start(
		config: Config,
		sink: impl FnMut(io::Result<&Batch>) + Send + 'static,
	) -> io::Result<Self> {
		let Config {
			roots,
			backend,
			latency,
			no_defer,
			poll_interval,
			follow_links,
			coalesce,
			stat_ambiguous,
			await_missing,
			access,
			buffer_bytes,
			file_ids,
			filter,
			descend,
		} = config;
		let backend = backend.resolve();
		let emitter = Emitter::new(coalesce, filter, Box::new(sink));
		let timing = Timing { latency, no_defer, await_missing, buffer_bytes };
		let running = match backend {
			#[cfg(target_os = "macos")]
			Backend::FsEvents => {
				let _ = (follow_links, descend, poll_interval, access);
				Running::FsEvents(fsevents::Stream::start(
					&roots,
					timing,
					stat_ambiguous,
					file_ids,
					emitter,
				)?)
			},
			#[cfg(any(target_os = "linux", target_os = "android"))]
			Backend::Inotify => {
				let _ = (stat_ambiguous, poll_interval, file_ids);
				Running::Inotify(inotify::Inotify::start(
					roots,
					timing,
					follow_links,
					access,
					descend,
					emitter,
				)?)
			},
			#[cfg(windows)]
			Backend::Windows => {
				let _ = (follow_links, descend, stat_ambiguous, poll_interval, access, file_ids);
				Running::Windows(windows::Watch::start(&roots, timing, emitter)?)
			},
			#[cfg(target_os = "macos")]
			Backend::Kqueue => {
				let _ = (stat_ambiguous, poll_interval, access, file_ids);
				Running::Kqueue(kqueue::Kqueue::start(roots, timing, follow_links, descend, emitter)?)
			},
			Backend::Poll => {
				let _ = (stat_ambiguous, descend, access, file_ids);
				Running::Poll(poll::Poll::start(roots, timing, poll_interval, follow_links, emitter)?)
			},
			_ => {
				return Err(io::Error::new(
					io::ErrorKind::Unsupported,
					format!("{} is not available on this platform", backend.monitor_name()),
				));
			},
		};
		Ok(Self { _backend: running, backend })
	}

	/// Starts watching and queues every batch on the returned channel, which
	/// yields a final `Err` if the watch ends on its own and disconnects once
	/// the watcher is dropped.
	///
	/// # Errors
	///
	/// As for [`Watcher::start`].
	pub fn channel(config: Config) -> io::Result<(Self, flume::Receiver<io::Result<Batch>>)> {
		let (sender, receiver) = flume::unbounded();
		let watcher = Self::start(config, move |batch| {
			let _ = sender.send(batch.cloned());
		})?;
		Ok((watcher, receiver))
	}

	/// The backend in use; never [`Backend::Default`].
	#[must_use]
	pub const fn backend(&self) -> Backend {
		self.backend
	}
}

/// `NotFound` for a root that does not exist.
pub(crate) fn missing_root(path: &Path, error: &io::Error) -> io::Error {
	io::Error::new(error.kind(), format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests;
