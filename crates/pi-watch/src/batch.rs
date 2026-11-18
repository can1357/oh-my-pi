//! Batches of events and the emitter backends fill them through.

use std::{
	ffi::OsStr,
	hash::BuildHasher,
	io,
	ops::Range,
	path::Path,
	time::SystemTime,
};

use hashbrown::{DefaultHashBuilder, HashTable};

use crate::{Filter, Flags};

/// A batch this large is delivered even if its gathering window is still
/// open, so offsets into the path arena stay within `u32`.
const MAX_BATCH_BYTES: usize = 64 << 20;

/// One event as stored: its path is a range of the batch's arena.
#[derive(Clone, Copy)]
struct Raw {
	start:  u32,
	len:    u32,
	flags:  Flags,
	native: u32,
	root:   u32,
	id:     u64,
}

impl Raw {
	const fn range(self) -> Range<usize> {
		self.start as usize..(self.start + self.len) as usize
	}
}

/// The changes gathered by one read of the system's notifications, in the
/// order they were reported.
pub struct Batch {
	time:   SystemTime,
	/// Every event's path, back to back.
	bytes:  Vec<u8>,
	events: Vec<Raw>,
	/// Event indices by path, for coalescing.
	index:  HashTable<u32>,
}

/// One change to one path.
#[derive(Clone, Copy, Debug)]
pub struct Event<'a> {
	/// The changed path: the root's path as it was given to the watcher,
	/// joined with the path below it.
	pub path:   &'a Path,
	/// What happened, and what the path is where the system tells.
	pub flags:  Flags,
	/// The system's own flags: `FSEvents` event flags, the inotify mask, or
	/// the `ReadDirectoryChangesW` action; 0 from kqueue and polling.
	pub native: u32,
	/// Index of the root in [`Config::roots`](crate::Config::roots) the path
	/// lies below.
	pub root:   usize,
	/// What ties the event to related ones: the inotify cookie shared by the
	/// two halves of a rename, or the path's file id from `FSEvents` under
	/// [`Config::file_ids`](crate::Config::file_ids); 0 when the system gives
	/// none.
	pub id:     u64,
}

impl Batch {
	const fn new() -> Self {
		Self {
			time:   SystemTime::UNIX_EPOCH,
			bytes:  Vec::new(),
			events: Vec::new(),
			index:  HashTable::new(),
		}
	}

	/// The events, in the order they were reported.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = Event<'_>> {
		self.events.iter().map(|raw| Event {
			path:   path_of(&self.bytes[raw.range()]),
			flags:  raw.flags,
			native: raw.native,
			root:   raw.root as usize,
			id:     raw.id,
		})
	}

	/// The number of events.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.events.len()
	}

	/// Whether the batch holds no event.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.events.is_empty()
	}

	/// When the watcher read the batch from the system.
	#[must_use]
	pub const fn time(&self) -> SystemTime {
		self.time
	}

	/// Whether changes were lost before this batch ([`Flags::OVERFLOW`]).
	#[must_use]
	pub fn overflowed(&self) -> bool {
		self
			.events
			.iter()
			.any(|raw| raw.flags.contains(Flags::OVERFLOW))
	}

	fn clear(&mut self) {
		self.bytes.clear();
		self.events.clear();
		self.index.clear();
	}
}

impl Clone for Batch {
	/// Copies the events; the coalescing index stays with the watcher.
	fn clone(&self) -> Self {
		Self {
			time:   self.time,
			bytes:  self.bytes.clone(),
			events: self.events.clone(),
			index:  HashTable::new(),
		}
	}
}

/// The path stored as `bytes` of the arena.
fn path_of(bytes: &[u8]) -> &Path {
	// SAFETY: the arena holds `OsStr::as_encoded_bytes` of root paths and
	// system-reported names (any bytes on Unix; UTF-8 transcoded from UTF-16
	// on Windows), joined with ASCII separators, and an event's range covers
	// whole such pieces.
	Path::new(unsafe { OsStr::from_encoded_bytes_unchecked(bytes) })
}

/// Receives every batch, and the error that ends the watch.
pub(crate) type Sink = Box<dyn FnMut(io::Result<&Batch>) + Send>;

/// Where a backend puts its events: filters and coalesces them into the batch
/// and hands the batch to the watcher's sink.
pub(crate) struct Emitter {
	batch:    Batch,
	coalesce: bool,
	filter:   Option<Filter>,
	sink:     Sink,
	hasher:   DefaultHashBuilder,
}

impl Emitter {
	pub(crate) fn new(coalesce: bool, filter: Option<Filter>, sink: Sink) -> Self {
		Self { batch: Batch::new(), coalesce, filter, sink, hasher: DefaultHashBuilder::default() }
	}

	/// Adds an event for `path`.
	pub(crate) fn push(&mut self, root: u32, path: &[u8], flags: Flags, native: u32, id: u64) {
		let start = self.begin();
		self.batch.bytes.extend_from_slice(path);
		self.commit(root, start, flags, native, id);
	}

	/// Adds an event for `name` below `dir`; an empty `name` is `dir` itself.
	#[cfg(target_os = "macos")]
	pub(crate) fn push_join(
		&mut self,
		root: u32,
		dir: &[u8],
		name: &[u8],
		flags: Flags,
		native: u32,
		id: u64,
	) {
		let start = self.begin();
		self.batch.bytes.extend_from_slice(dir);
		if !name.is_empty() {
			self.separate(dir);
			self.batch.bytes.extend_from_slice(name);
		}
		self.commit(root, start, flags, native, id);
	}

	/// Adds an event for the UTF-16 `name` below `dir`.
	#[cfg(windows)]
	pub(crate) fn push_wide(
		&mut self,
		root: u32,
		dir: &[u8],
		name: &[u16],
		flags: Flags,
		native: u32,
		id: u64,
	) {
		let start = self.begin();
		self.batch.bytes.extend_from_slice(dir);
		if !name.is_empty() {
			self.separate(dir);
			let mut utf8 = [0u8; 4];
			for unit in char::decode_utf16(name.iter().copied()) {
				let c = unit.unwrap_or(char::REPLACEMENT_CHARACTER);
				self
					.batch
					.bytes
					.extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
			}
		}
		self.commit(root, start, flags, native, id);
	}

	/// Delivers the batch, if it holds anything, and empties it.
	pub(crate) fn flush(&mut self) {
		if self.batch.events.is_empty() {
			return;
		}
		self.batch.time = SystemTime::now();
		(self.sink)(Ok(&self.batch));
		self.batch.clear();
	}

	/// Delivers what is batched, then `error`: the watch has ended.
	#[cfg_attr(
		not(any(target_os = "linux", target_os = "android", windows)),
		allow(dead_code, reason = "FSEvents, kqueue and polling have no failure of their own")
	)]
	pub(crate) fn fail(&mut self, error: io::Error) {
		self.flush();
		(self.sink)(Err(error));
	}

	/// Start of the next path in the arena.
	fn begin(&mut self) -> usize {
		if self.batch.bytes.len() >= MAX_BATCH_BYTES {
			self.flush();
		}
		self.batch.bytes.len()
	}

	/// Ends `dir` in the arena with a separator, unless it brought one.
	#[cfg(any(target_os = "macos", windows))]
	fn separate(&mut self, dir: &[u8]) {
		let ends_separated = dir
			.last()
			.is_some_and(|&last| last == b'/' || last == std::path::MAIN_SEPARATOR as u8);
		if !ends_separated {
			self.batch.bytes.push(std::path::MAIN_SEPARATOR as u8);
		}
	}

	/// Turns the arena's tail from `start` into an event, unless the filter
	/// drops it or an event of the same path absorbs it.
	fn commit(&mut self, root: u32, start: usize, flags: Flags, native: u32, id: u64) {
		let Batch { bytes, events, index, .. } = &mut self.batch;
		let path = &bytes[start..];
		if let Some(filter) = &mut self.filter
			&& !filter(path_of(path), flags)
		{
			bytes.truncate(start);
			return;
		}
		if self.coalesce {
			let hash = self.hasher.hash_one(path);
			let same = index.find(hash, |&at| {
				let event = events[at as usize];
				event.root == root && bytes[event.range()] == *path
			});
			if let Some(&at) = same {
				let event = &mut events[at as usize];
				event.flags |= flags;
				event.native |= native;
				if event.id == 0 {
					event.id = id;
				}
				bytes.truncate(start);
				return;
			}
			let hasher = &self.hasher;
			index.insert_unique(hash, events.len() as u32, |&at| {
				hasher.hash_one(&bytes[events[at as usize].range()])
			});
		}
		events.push(Raw {
			start: start as u32,
			len: (bytes.len() - start) as u32,
			flags,
			native,
			root,
			id,
		});
	}
}
