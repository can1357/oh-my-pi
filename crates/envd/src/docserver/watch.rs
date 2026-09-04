use std::{
	fs, io,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use notify::{
	Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, WatcherKind,
	event::{MetadataKind, ModifyKind, RenameMode},
};
use parking_lot::Mutex;

/// A document-relevant change reported by a native filesystem watcher.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileWatchKind {
	/// The file was created, replaced, or mutated in place.
	Changed,
	/// The file was removed or renamed without a known destination.
	Removed,
	/// The watched file was renamed to the contained destination path.
	Renamed(PathBuf),
	/// Native events may have been lost or cannot be classified safely.
	RescanRequired,
}

/// A native filesystem event tagged with the watch generation that produced it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileWatchEvent {
	/// Generation supplied when the native watcher was bound.
	pub generation: u64,
	/// Document-relevant interpretation of the native event.
	pub kind:       FileWatchKind,
}

type SharedCallback = Arc<Mutex<Box<dyn FnMut(FileWatchEvent) + Send + 'static>>>;

struct Binding {
	watcher:        RecommendedWatcher,
	parent:         PathBuf,
	target:         PathBuf,
	generation:     u64,
	active:         Arc<AtomicBool>,
	gate:           Arc<Mutex<()>>,
	target_watched: bool,
}

impl Binding {
	fn deactivate(&mut self) -> notify::Result<()> {
		let gate = self.gate.lock();
		self.active.store(false, Ordering::SeqCst);
		drop(gate);
		if self.target_watched {
			let _ = self.watcher.unwatch(&self.target);
		}
		self.watcher.unwatch(&self.parent)
	}
}

/// An active, generation-tagged native watch of one exact file path.
///
/// The handle watches the file's canonical parent directory non-recursively,
/// filters native events to the exact file identity, and invokes the supplied
/// callback on notify's event thread. It does not create an intermediate event
/// queue. Dropping or explicitly unwatching the handle deactivates its
/// callback.
#[must_use]
pub struct ActiveFileWatch {
	callback: SharedCallback,
	binding:  Option<Binding>,
}

impl ActiveFileWatch {
	/// Starts watching `path` and tags all delivered events with `generation`.
	///
	/// The parent directory must exist. The final path component may be absent,
	/// which permits watching a document before it is created.
	pub fn new<F>(path: impl AsRef<Path>, generation: u64, callback: F) -> notify::Result<Self>
	where
		F: FnMut(FileWatchEvent) + Send + 'static,
	{
		let callback: SharedCallback = Arc::new(Mutex::new(Box::new(callback)));
		let binding = create_binding(path.as_ref(), generation, Arc::clone(&callback))?;
		Ok(Self { callback, binding: Some(binding) })
	}

	/// Returns the exact canonical-parent path currently being filtered.
	pub fn path(&self) -> &Path {
		&self
			.binding
			.as_ref()
			.expect("active watch has a binding")
			.target
	}

	/// Returns the generation attached to events from the current binding.
	pub const fn generation(&self) -> u64 {
		self
			.binding
			.as_ref()
			.expect("active watch has a binding")
			.generation
	}

	/// Rebinds this handle to `path` under a distinct generation.
	///
	/// A fresh native watcher is made before the old watcher is deactivated, so
	/// a setup failure leaves the existing watch intact. Events already in
	/// flight from the old watcher retain its old generation.
	pub fn rebind(&mut self, path: impl AsRef<Path>, generation: u64) -> notify::Result<()> {
		if self.generation() == generation {
			return Err(notify::Error::generic("a rebound file watch requires a distinct generation"));
		}

		let binding = create_binding(path.as_ref(), generation, Arc::clone(&self.callback))?;
		let mut old = self
			.binding
			.replace(binding)
			.expect("active watch has a binding");
		let _ = old.deactivate();
		Ok(())
	}

	/// Stops this watch and prevents callbacks that have not begun from firing.
	pub fn unwatch(mut self) -> notify::Result<()> {
		self
			.binding
			.take()
			.expect("active watch has a binding")
			.deactivate()
	}
}

impl Drop for ActiveFileWatch {
	fn drop(&mut self) {
		if let Some(mut binding) = self.binding.take() {
			let _ = binding.deactivate();
		}
	}
}

fn create_binding(
	path: &Path,
	generation: u64,
	callback: SharedCallback,
) -> notify::Result<Binding> {
	let (parent, target) = canonical_parent_and_target(path)?;
	let active = Arc::new(AtomicBool::new(true));
	let callback_active = Arc::clone(&active);
	let gate = Arc::new(Mutex::new(()));
	let callback_gate = Arc::clone(&gate);
	let callback_target = target.clone();
	let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
		let gate = callback_gate.lock();
		if !callback_active.load(Ordering::SeqCst) {
			return;
		}

		let kind = match result {
			Ok(event) => classify_event(&callback_target, &event),
			Err(_) => Some(FileWatchKind::RescanRequired),
		};
		if let Some(kind) = kind {
			let mut callback = callback.lock();
			callback(FileWatchEvent { generation, kind });
		}
		drop(gate);
	})?;

	if let Err(error) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
		let callback_guard = gate.lock();
		active.store(false, Ordering::SeqCst);
		drop(callback_guard);
		return Err(error);
	}

	let target_exists = match fs::symlink_metadata(&target) {
		Ok(_) => true,
		Err(error) if error.kind() == io::ErrorKind::NotFound => false,
		Err(error) => {
			let callback_guard = gate.lock();
			active.store(false, Ordering::SeqCst);
			drop(callback_guard);
			let _ = watcher.unwatch(&parent);
			return Err(notify::Error::io(error).add_path(target));
		},
	};

	// Kqueue's non-recursive directory watch reports entry changes but does not
	// subscribe to writes of children that already existed when the watch began.
	// Keep the parent watch for replacement/rename events and supplement it with
	// an exact-file watch when that backend can open the current entry.
	let target_watched =
		if target_exists && <RecommendedWatcher as Watcher>::kind() == WatcherKind::Kqueue {
			match watcher.watch(&target, RecursiveMode::NonRecursive) {
				Ok(()) => true,
				Err(error) if watch_path_missing(&error) => false,
				Err(error) => {
					let callback_guard = gate.lock();
					active.store(false, Ordering::SeqCst);
					drop(callback_guard);
					let _ = watcher.unwatch(&parent);
					return Err(error);
				},
			}
		} else {
			false
		};

	Ok(Binding { watcher, parent, target, generation, active, gate, target_watched })
}

fn canonical_parent_and_target(path: &Path) -> notify::Result<(PathBuf, PathBuf)> {
	let file_name = path.file_name().ok_or_else(|| {
		notify::Error::generic("a file watch path must have a final path component")
	})?;
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let parent = fs::canonicalize(parent).map_err(notify::Error::io_watch)?;
	let target = parent.join(file_name);
	Ok((parent, target))
}

fn watch_path_missing(error: &notify::Error) -> bool {
	match &error.kind {
		notify::ErrorKind::PathNotFound => true,
		notify::ErrorKind::Io(source) => source.kind() == io::ErrorKind::NotFound,
		_ => false,
	}
}

/// Classifies one native event for an exact watched path.
///
/// This function is pure and deliberately conservative: unknown or malformed
/// events concerning the watched path require a rescan, while unrelated paths
/// and access-only activity produce no document event.
pub fn classify_event(target: &Path, event: &Event) -> Option<FileWatchKind> {
	if event.need_rescan() {
		return Some(FileWatchKind::RescanRequired);
	}

	match event.kind {
		EventKind::Access(_) => None,
		EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => None,
		EventKind::Modify(ModifyKind::Name(mode)) => classify_rename(target, mode, &event.paths),
		EventKind::Create(_) | EventKind::Modify(_)
			if event.paths.iter().any(|path| path == target) =>
		{
			Some(FileWatchKind::Changed)
		},
		EventKind::Remove(_) if event.paths.iter().any(|path| path == target) => {
			Some(FileWatchKind::Removed)
		},
		EventKind::Any | EventKind::Other if event.paths.iter().any(|path| path == target) => {
			Some(FileWatchKind::RescanRequired)
		},
		_ => None,
	}
}

fn classify_rename(target: &Path, mode: RenameMode, paths: &[PathBuf]) -> Option<FileWatchKind> {
	match mode {
		RenameMode::Both if paths.len() == 2 && paths[0] == target => {
			Some(FileWatchKind::Renamed(paths[1].clone()))
		},
		RenameMode::Both if paths.len() == 2 && paths[1] == target => Some(FileWatchKind::Changed),
		RenameMode::From if paths.len() == 1 && paths[0] == target => Some(FileWatchKind::Removed),
		RenameMode::To if paths.len() == 1 && paths[0] == target => Some(FileWatchKind::Changed),
		RenameMode::Any | RenameMode::Other if paths.iter().any(|path| path == target) => {
			Some(FileWatchKind::RescanRequired)
		},
		RenameMode::Both | RenameMode::From | RenameMode::To
			if paths.iter().any(|path| path == target) =>
		{
			Some(FileWatchKind::RescanRequired)
		},
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::mpsc, time};

	use notify::event::{AccessKind, CreateKind, DataChange, Flag, RemoveKind};

	use super::*;

	fn path(value: &str) -> PathBuf {
		PathBuf::from(value)
	}

	#[test]
	fn ignores_access_and_unrelated_temp_events() {
		let target = Path::new("/workspace/note.txt");
		let access = Event::new(EventKind::Access(AccessKind::Read)).add_path(target.into());
		let temp =
			Event::new(EventKind::Create(CreateKind::File)).add_path(path("/workspace/.note.txt.tmp"));

		assert_eq!(classify_event(target, &access), None);
		assert_eq!(classify_event(target, &temp), None);
	}

	#[test]
	fn distinguishes_both_rename_roles() {
		let target = Path::new("/workspace/note.txt");
		let destination = path("/workspace/archive.txt");
		let source = path("/workspace/.replacement");
		let renamed = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
			.add_path(target.into())
			.add_path(destination.clone());
		let replaced = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
			.add_path(source)
			.add_path(target.into());

		assert_eq!(classify_event(target, &renamed), Some(FileWatchKind::Renamed(destination)));
		assert_eq!(classify_event(target, &replaced), Some(FileWatchKind::Changed));
	}

	#[test]
	fn classifies_unpaired_rename_roles() {
		let target = Path::new("/workspace/note.txt");
		let from =
			Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(target.into());
		let to =
			Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(target.into());

		assert_eq!(classify_event(target, &from), Some(FileWatchKind::Removed));
		assert_eq!(classify_event(target, &to), Some(FileWatchKind::Changed));
	}

	#[test]
	fn classifies_direct_changes_and_removal() {
		let target = Path::new("/workspace/note.txt");
		let changed = Event::new(EventKind::Create(CreateKind::File)).add_path(target.into());
		let written = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
			.add_path(target.into());
		let removed = Event::new(EventKind::Remove(RemoveKind::File)).add_path(target.into());

		assert_eq!(classify_event(target, &changed), Some(FileWatchKind::Changed));
		assert_eq!(classify_event(target, &written), Some(FileWatchKind::Changed));
		assert_eq!(classify_event(target, &removed), Some(FileWatchKind::Removed));
	}

	#[test]
	fn malformed_rename_and_overflow_require_rescan() {
		let target = Path::new("/workspace/note.txt");
		let malformed =
			Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both))).add_path(target.into());
		let overflow = Event::new(EventKind::Other)
			.add_path(path("/workspace/unrelated"))
			.set_flag(Flag::Rescan);

		assert_eq!(classify_event(target, &malformed), Some(FileWatchKind::RescanRequired));
		assert_eq!(classify_event(target, &overflow), Some(FileWatchKind::RescanRequired));
	}
	#[test]
	fn missing_target_watch_observes_later_creation() {
		let root = tempfile::tempdir().expect("temporary directory");
		let target = root.path().join("created.txt");
		let (sender, receiver) = mpsc::channel();
		let watch = ActiveFileWatch::new(&target, 17, move |event| {
			let _ = sender.send(event);
		})
		.expect("missing target watch");

		fs::write(&target, b"created").expect("create watched target");
		let event = receiver
			.recv_timeout(time::Duration::from_secs(5))
			.expect("creation event");
		assert_eq!(event, FileWatchEvent { generation: 17, kind: FileWatchKind::Changed });
		drop(watch);
	}

	#[test]
	fn recognizes_both_missing_path_error_forms() {
		let explicit = notify::Error::path_not_found();
		let backend = notify::Error::io(io::Error::from(io::ErrorKind::NotFound));
		let denied = notify::Error::io(io::Error::from(io::ErrorKind::PermissionDenied));

		assert!(watch_path_missing(&explicit));
		assert!(watch_path_missing(&backend));
		assert!(!watch_path_missing(&denied));
	}
}
