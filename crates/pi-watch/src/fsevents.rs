//! macOS: one `FSEventStream` with file-level events over every root.
//!
//! The stream is scheduled on a serial dispatch queue of its own, so there is
//! no run-loop thread; its callback translates each delivery into one batch.
//! `FSEvents` reports canonical paths, so every root is canonicalized for the
//! stream and events are mapped back onto the root's path as it was given.

use std::{
	ffi::{CStr, c_char, c_void},
	fs, io,
	os::unix::ffi::OsStrExt,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
	ptr, slice,
};

use hashbrown::HashMap;

use crate::{Flags, Root, Timing, batch::Emitter, missing_root};

type CFIndex = isize;
type CFRef = *const c_void;

#[repr(C)]
struct CFArrayCallBacks {
	version:          CFIndex,
	retain:           *const c_void,
	release:          *const c_void,
	copy_description: *const c_void,
	equal:            *const c_void,
}

#[repr(C)]
struct FSEventStreamContext {
	version:          CFIndex,
	info:             *mut c_void,
	retain:           *const c_void,
	release:          *const c_void,
	copy_description: *const c_void,
}

type FSEventStreamCallback = extern "C" fn(
	stream: *const c_void,
	info: *mut c_void,
	count: usize,
	paths: *mut c_void,
	flags: *const u32,
	ids: *const u64,
);

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFTypeArrayCallBacks: CFArrayCallBacks;

	fn CFStringCreateWithBytes(
		allocator: CFRef,
		bytes: *const u8,
		len: CFIndex,
		encoding: u32,
		external: u8,
	) -> CFRef;
	fn CFArrayCreate(
		allocator: CFRef,
		values: *const CFRef,
		count: CFIndex,
		callbacks: *const CFArrayCallBacks,
	) -> CFRef;
	fn CFRelease(object: CFRef);
	fn CFArrayGetValueAtIndex(array: CFRef, index: CFIndex) -> CFRef;
	fn CFDictionaryGetValue(dictionary: CFRef, key: CFRef) -> CFRef;
	fn CFNumberGetValue(number: CFRef, kind: CFIndex, value: *mut c_void) -> u8;
	fn CFStringGetLength(string: CFRef) -> CFIndex;
	fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
	fn CFStringGetCString(string: CFRef, buffer: *mut c_char, size: CFIndex, encoding: u32) -> u8;
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
	fn FSEventStreamCreate(
		allocator: CFRef,
		callback: FSEventStreamCallback,
		context: *const FSEventStreamContext,
		paths: CFRef,
		since: u64,
		latency: f64,
		flags: u32,
	) -> *mut c_void;
	fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
	fn FSEventStreamStart(stream: *mut c_void) -> u8;
	fn FSEventStreamStop(stream: *mut c_void);
	fn FSEventStreamInvalidate(stream: *mut c_void);
	fn FSEventStreamRelease(stream: *mut c_void);
}

unsafe extern "C" {
	fn dispatch_queue_create(label: *const c_char, attributes: *const c_void) -> *mut c_void;
	fn dispatch_sync_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
	fn dispatch_release(object: *mut c_void);
}

const UTF8: u32 = 0x0800_0100;
const SINCE_NOW: u64 = u64::MAX;
/// `kCFNumberSInt64Type`.
const NUMBER_SINT64: CFIndex = 4;

/// `kFSEventStreamCreateFlagUseCFTypes`.
const CREATE_USE_CF_TYPES: u32 = 0x01;
/// `kFSEventStreamCreateFlagUseExtendedData`.
const CREATE_USE_EXTENDED_DATA: u32 = 0x40;
const CREATE_NO_DEFER: u32 = 0x02;
const CREATE_WATCH_ROOT: u32 = 0x04;
const CREATE_FILE_EVENTS: u32 = 0x10;

const MUST_SCAN_SUBDIRS: u32 = 0x1;
const USER_DROPPED: u32 = 0x2;
const KERNEL_DROPPED: u32 = 0x4;
const HISTORY_DONE: u32 = 0x10;
const ROOT_CHANGED: u32 = 0x20;
const MOUNT: u32 = 0x40;
const UNMOUNT: u32 = 0x80;
const ITEM_CREATED: u32 = 0x100;
const ITEM_REMOVED: u32 = 0x200;
const ITEM_INODE_META_MOD: u32 = 0x400;
const ITEM_RENAMED: u32 = 0x800;
const ITEM_MODIFIED: u32 = 0x1000;
const ITEM_FINDER_INFO_MOD: u32 = 0x2000;
const ITEM_CHANGE_OWNER: u32 = 0x4000;
const ITEM_XATTR_MOD: u32 = 0x8000;
const ITEM_IS_FILE: u32 = 0x1_0000;
const ITEM_IS_DIR: u32 = 0x2_0000;
const ITEM_IS_SYMLINK: u32 = 0x4_0000;
const ITEM_IS_HARDLINK: u32 = 0x10_0000;
const ITEM_IS_LAST_HARDLINK: u32 = 0x20_0000;
const ITEM_CLONED: u32 = 0x40_0000;

/// `FSEvents` flags and what each means as [`Flags`].
const TRANSLATION: [(u32, Flags); 16] = [
	(MUST_SCAN_SUBDIRS | USER_DROPPED | KERNEL_DROPPED, Flags::OVERFLOW),
	(MOUNT | UNMOUNT, Flags::PLATFORM_SPECIFIC),
	(ITEM_CREATED, Flags::CREATED),
	(ITEM_REMOVED, Flags::REMOVED),
	(ITEM_INODE_META_MOD, Flags::ATTRIBUTE_MODIFIED),
	(ITEM_RENAMED, Flags::RENAMED),
	(ITEM_MODIFIED, Flags::UPDATED),
	(ITEM_FINDER_INFO_MOD, Flags::PLATFORM_SPECIFIC),
	(ITEM_CHANGE_OWNER, Flags::OWNER_MODIFIED),
	(ITEM_XATTR_MOD, Flags::ATTRIBUTE_MODIFIED),
	(ITEM_IS_FILE, Flags::IS_FILE),
	(ITEM_IS_DIR, Flags::IS_DIR),
	(ITEM_IS_SYMLINK, Flags::IS_SYMLINK),
	(ITEM_IS_HARDLINK, Flags::LINK),
	(ITEM_IS_LAST_HARDLINK, Flags::LINK),
	(ITEM_CLONED, Flags::PLATFORM_SPECIFIC),
];

/// An owned Core Foundation object.
struct Cf(CFRef);

impl Drop for Cf {
	fn drop(&mut self) {
		// SAFETY: `self.0` is a non-null object this value owns one reference to.
		unsafe { CFRelease(self.0) };
	}
}

/// A `CFString` of `text`; null when Core Foundation cannot make one.
fn cf_string(text: &[u8]) -> CFRef {
	// SAFETY: `text` is valid for `text.len()` bytes.
	unsafe { CFStringCreateWithBytes(ptr::null(), text.as_ptr(), text.len() as CFIndex, UTF8, 0) }
}

/// The keys of an extended event's dictionary
/// (`kFSEventStreamEventExtendedDataPathKey`,
/// `kFSEventStreamEventExtendedFileIDKey`).
struct ExtendedKeys {
	path:    Cf,
	file_id: Cf,
}

struct RootInfo {
	/// The root as the caller named it.
	path:      Box<[u8]>,
	recursive: bool,
}

/// What the stream's callback works on; owned by the [`Stream`].
struct Context {
	emitter:  Emitter,
	roots:    Vec<RootInfo>,
	/// Root index by canonical path.
	prefixes: HashMap<Box<[u8]>, u32>,
	stat:     bool,
	/// Set when the stream delivers extended events, for their file ids.
	keys:     Option<ExtendedKeys>,
	/// The path of the extended event being handled.
	scratch:  Vec<u8>,
}

impl Context {
	/// The root `path` is reported under and the length of that root's
	/// canonical prefix: the deepest root above `path` that covers it.
	fn locate(&self, path: &[u8]) -> Option<(u32, usize)> {
		let mut candidate = path;
		loop {
			if let Some(&root) = self.prefixes.get(candidate) {
				let below = &path[candidate.len()..];
				let below = below.strip_prefix(b"/").unwrap_or(below);
				// A flat root covers itself and its entries.
				let covered = self.roots[root as usize].recursive || !below.contains(&b'/');
				if covered {
					return Some((root, candidate.len()));
				}
			}
			candidate = match candidate.iter().rposition(|&byte| byte == b'/') {
				Some(0) if candidate.len() > 1 => &candidate[..1],
				Some(0) | None => return None,
				Some(slash) => &candidate[..slash],
			};
		}
	}

	/// Handles a delivery of extended events: `paths` is a `CFArray` with one
	/// `CFDictionary` per flag word.
	fn extended(&mut self, paths: CFRef, flags: &[u32]) {
		let Some(keys) = &self.keys else {
			return;
		};
		let (path_key, id_key) = (keys.path.0, keys.file_id.0);
		let mut scratch = std::mem::take(&mut self.scratch);
		for (index, &native) in flags.iter().enumerate() {
			// SAFETY: `paths` holds `flags.len()` dictionaries, valid for this
			// call; a dictionary's values are a CFString and a CFNumber, and the
			// keys are live CFStrings.
			let (path, number) = unsafe {
				let entry = CFArrayGetValueAtIndex(paths, index as CFIndex);
				if entry.is_null() {
					continue;
				}
				(CFDictionaryGetValue(entry, path_key), CFDictionaryGetValue(entry, id_key))
			};
			if path.is_null() {
				continue;
			}
			let mut id = 0i64;
			if !number.is_null() {
				// SAFETY: `number` is a CFNumber and `id` holds the 64-bit integer
				// asked for.
				unsafe { CFNumberGetValue(number, NUMBER_SINT64, (&raw mut id).cast()) };
			}
			// SAFETY: `path` is a CFString; `scratch` has room for its longest
			// UTF-8 form and the terminator.
			let converted = unsafe {
				let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(path), UTF8) + 1;
				scratch.resize(size as usize, 0);
				CFStringGetCString(path, scratch.as_mut_ptr().cast(), size, UTF8) != 0
			};
			if converted && let Ok(path) = CStr::from_bytes_until_nul(&scratch) {
				self.event(path, native, id as u64);
			}
		}
		self.scratch = scratch;
	}

	fn event(&mut self, path: &CStr, native: u32, id: u64) {
		if native & HISTORY_DONE != 0 {
			return;
		}
		let mut bytes = path.to_bytes();
		while bytes.len() > 1 && bytes.ends_with(b"/") {
			bytes = &bytes[..bytes.len() - 1];
		}
		let Some((root, prefix)) = self.locate(bytes) else {
			return;
		};
		let mut flags = TRANSLATION
			.iter()
			.filter(|(bits, _)| native & bits != 0)
			.fold(Flags::NO_OP, |flags, &(_, flag)| flags | flag);
		if native & ROOT_CHANGED != 0 {
			// The root itself, or a directory above it, was moved or removed,
			// or the root is back.
			flags |= if exists(path) {
				Flags::CREATED
			} else {
				Flags::REMOVED
			};
		} else if self.stat {
			let both = Flags::CREATED | Flags::REMOVED;
			if flags.contains(both) || flags.contains(Flags::RENAMED) {
				let exists = exists(path);
				if flags.contains(both) {
					flags = flags.difference(if exists {
						Flags::REMOVED
					} else {
						Flags::CREATED
					});
				}
				if flags.contains(Flags::RENAMED) {
					flags |= if exists {
						Flags::MOVED_TO
					} else {
						Flags::MOVED_FROM
					};
				}
			}
		}
		let below = &bytes[prefix..];
		let below = below.strip_prefix(b"/").unwrap_or(below);
		self
			.emitter
			.push_join(root, &self.roots[root as usize].path, below, flags, native, id);
	}
}

/// The canonical form of `path`. With `lenient`, a path that does not exist
/// yet is its deepest existing directory's canonical path plus the rest, which
/// is where `FSEvents` will report it once it exists.
fn canonicalize(path: &Path, lenient: bool) -> io::Result<PathBuf> {
	let error = match fs::canonicalize(path) {
		Err(error) if lenient && error.kind() == io::ErrorKind::NotFound => error,
		other => return other,
	};
	let mut rest = Vec::new();
	let mut current = path;
	loop {
		let (Some(parent), Some(name)) = (current.parent(), current.file_name()) else {
			return Err(error);
		};
		rest.push(name);
		let above = if parent.as_os_str().is_empty() {
			Path::new(".")
		} else {
			parent
		};
		if let Ok(mut base) = fs::canonicalize(above) {
			base.extend(rest.iter().rev());
			return Ok(base);
		}
		current = parent;
	}
}

/// Whether `path` names anything, without following a final symlink.
fn exists(path: &CStr) -> bool {
	let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `path` is NUL-terminated and `stat` is writable for one `stat`.
	unsafe { libc::lstat(path.as_ptr(), stat.as_mut_ptr()) == 0 }
}

extern "C" fn on_events(
	_stream: *const c_void,
	info: *mut c_void,
	count: usize,
	paths: *mut c_void,
	flags: *const u32,
	_ids: *const u64,
) {
	if count == 0 {
		return;
	}
	// A panic must not unwind into the dispatch queue.
	let _ = catch_unwind(AssertUnwindSafe(|| {
		// SAFETY: `info` is the `Context` the stream was created with, alive
		// until the stream is invalidated and its serial queue drained, and only
		// this callback, which the queue never runs twice at once, touches it.
		let context = unsafe { &mut *info.cast::<Context>() };
		// SAFETY: `flags` is an array of `count` flag words, valid for this call.
		let flags = unsafe { slice::from_raw_parts(flags, count) };
		if context.keys.is_some() {
			context.extended(paths.cast_const(), flags);
		} else {
			// SAFETY: without `UseCFTypes`, `paths` is an array of `count` C
			// strings, valid for this call.
			let paths = unsafe { slice::from_raw_parts(paths.cast::<*const c_char>(), count) };
			for (&path, &native) in paths.iter().zip(flags) {
				// SAFETY: as above; each path is NUL-terminated.
				context.event(unsafe { CStr::from_ptr(path) }, native, 0);
			}
		}
		context.emitter.flush();
	}));
}

const extern "C" fn barrier(_: *mut c_void) {}

/// The running stream; dropping it stops the stream and waits for a callback
/// in flight.
pub(crate) struct Stream {
	raw:     *mut c_void,
	queue:   *mut c_void,
	context: *mut Context,
	started: bool,
}

// SAFETY: the pointers are only used to tear the stream down, which Core
// Services allows from any thread.
unsafe impl Send for Stream {}
// SAFETY: a shared reference exposes nothing.
unsafe impl Sync for Stream {}

impl Stream {
	pub(crate) fn start(
		roots: &[Root],
		timing: Timing,
		stat: bool,
		file_ids: bool,
		emitter: Emitter,
	) -> io::Result<Self> {
		let mut infos = Vec::with_capacity(roots.len());
		let mut prefixes = HashMap::with_capacity(roots.len());
		let mut strings = Vec::with_capacity(roots.len());
		for (index, root) in roots.iter().enumerate() {
			let canonical = canonicalize(&root.path, timing.await_missing)
				.map_err(|error| missing_root(&root.path, &error))?;
			let bytes = canonical.as_os_str().as_bytes();
			let string = cf_string(bytes);
			if string.is_null() {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					format!("{}: path is not valid UTF-8", root.path.display()),
				));
			}
			strings.push(Cf(string));
			// Two names of one directory: the recursive one covers both.
			let slot = prefixes
				.entry(Box::<[u8]>::from(bytes))
				.or_insert(index as u32);
			if root.recursive {
				*slot = index as u32;
			}
			infos.push(RootInfo {
				path:      root.path.as_os_str().as_bytes().into(),
				recursive: root.recursive,
			});
		}
		if strings.is_empty() {
			return Ok(Self {
				raw:     ptr::null_mut(),
				queue:   ptr::null_mut(),
				context: ptr::null_mut(),
				started: false,
			});
		}
		let raw: Vec<CFRef> = strings.iter().map(|string| string.0).collect();
		// SAFETY: `raw` holds `raw.len()` live CFStrings; the array retains them.
		let array = Cf(unsafe {
			CFArrayCreate(
				ptr::null(),
				raw.as_ptr(),
				raw.len() as CFIndex,
				&raw const kCFTypeArrayCallBacks,
			)
		});
		if array.0.is_null() {
			std::mem::forget(array);
			return Err(io::Error::other("CFArrayCreate failed"));
		}
		let keys = if file_ids {
			let (path, file_id) = (cf_string(b"path"), cf_string(b"fileID"));
			if path.is_null() || file_id.is_null() {
				for key in [path, file_id] {
					if !key.is_null() {
						drop(Cf(key));
					}
				}
				return Err(io::Error::other("CFStringCreateWithBytes failed"));
			}
			Some(ExtendedKeys { path: Cf(path), file_id: Cf(file_id) })
		} else {
			None
		};
		let extended = keys.is_some();
		let context = Box::into_raw(Box::new(Context {
			emitter,
			roots: infos,
			prefixes,
			stat,
			keys,
			scratch: Vec::new(),
		}));
		let stream_context = FSEventStreamContext {
			version:          0,
			info:             context.cast(),
			retain:           ptr::null(),
			release:          ptr::null(),
			copy_description: ptr::null(),
		};
		let mut flags = CREATE_FILE_EVENTS | CREATE_WATCH_ROOT;
		if extended {
			flags |= CREATE_USE_CF_TYPES | CREATE_USE_EXTENDED_DATA;
		}
		if timing.no_defer {
			flags |= CREATE_NO_DEFER;
		}
		// SAFETY: the callback and `context` outlive the stream (see `Drop`);
		// FSEvents copies `stream_context` and retains `array`.
		let stream = unsafe {
			FSEventStreamCreate(
				ptr::null(),
				on_events,
				&raw const stream_context,
				array.0,
				SINCE_NOW,
				timing.latency.as_secs_f64(),
				flags,
			)
		};
		if stream.is_null() {
			// SAFETY: `context` came from `Box::into_raw` above and nothing else
			// holds it.
			drop(unsafe { Box::from_raw(context) });
			return Err(io::Error::other("FSEventStreamCreate failed"));
		}
		// SAFETY: the label is NUL-terminated; a null attribute makes the queue
		// serial.
		let queue = unsafe { dispatch_queue_create(c"sh.omp.watch".as_ptr(), ptr::null()) };
		let mut this = Self { raw: stream, queue, context, started: false };
		// SAFETY: `stream` and `queue` are live; the stream is scheduled before
		// it starts.
		this.started = unsafe {
			FSEventStreamSetDispatchQueue(stream, queue);
			FSEventStreamStart(stream) != 0
		};
		if !this.started {
			// `this` tears the stream down.
			return Err(io::Error::other("FSEventStreamStart failed"));
		}
		Ok(this)
	}
}

impl Drop for Stream {
	fn drop(&mut self) {
		if self.raw.is_null() {
			return;
		}
		// SAFETY: `raw` and `queue` are live and owned by this value. Once
		// the stream is invalidated no new callback is queued, and the empty
		// block run synchronously on the serial queue returns after any callback
		// in flight, so nothing uses `context` when it is freed.
		unsafe {
			if self.started {
				FSEventStreamStop(self.raw);
			}
			FSEventStreamInvalidate(self.raw);
			dispatch_sync_f(self.queue, ptr::null_mut(), barrier);
			FSEventStreamRelease(self.raw);
			drop(Box::from_raw(self.context));
			dispatch_release(self.queue);
		}
	}
}
