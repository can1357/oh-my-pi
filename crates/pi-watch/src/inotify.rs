//! Linux: inotify.
//!
//! One inotify instance serves every root. A directory root gets a watch per
//! directory of its subtree, added as directories appear or are moved in
//! (what such a directory already holds is reported as created, since it
//! predates the watch) and dropped as they go. A file root is watched by name
//! through its directory, so replacing or recreating the file keeps it
//! watched. When the kernel's queue overflows, every root reports
//! [`Flags::OVERFLOW`] and is walked again for directories the lost events
//! announced.

use std::{
	ffi::{CString, OsString},
	fs, io, mem,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd},
		unix::ffi::{OsStrExt, OsStringExt},
	},
	path::{Path, PathBuf},
	ptr, thread,
	time::Duration,
};

use hashbrown::{HashMap, hash_map::Entry};

use crate::{Descend, Flags, MISSING_ROOT_RECHECK, Root, Timing, batch::Emitter, missing_root};

/// Changes every watch reports.
const CHANGES: u32 = libc::IN_CREATE
	| libc::IN_DELETE
	| libc::IN_MODIFY
	| libc::IN_CLOSE_WRITE
	| libc::IN_MOVED_FROM
	| libc::IN_MOVED_TO
	| libc::IN_ATTRIB
	| libc::IN_DELETE_SELF
	| libc::IN_MOVE_SELF
	| libc::IN_EXCL_UNLINK;
/// Reads and opens, on request.
const ACCESSES: u32 = libc::IN_ACCESS | libc::IN_OPEN | libc::IN_CLOSE_NOWRITE;
/// The kernel's default queue holds 16384 events; one read of this size
/// takes a few thousand of them.
const BUFFER_BYTES: usize = 64 * 1024;
const HEADER_BYTES: usize = mem::size_of::<libc::inotify_event>();

/// The inotify mask as [`Flags`], without the path's type.
fn translate(mask: u32) -> Flags {
	const TRANSLATION: [(u32, Flags); 10] = [
		(libc::IN_CREATE, Flags::CREATED),
		(libc::IN_DELETE | libc::IN_DELETE_SELF, Flags::REMOVED),
		(libc::IN_MODIFY, Flags::UPDATED),
		(libc::IN_CLOSE_WRITE, Flags::CLOSE_WRITE),
		(libc::IN_MOVED_FROM | libc::IN_MOVE_SELF, Flags::RENAMED),
		(libc::IN_MOVED_FROM | libc::IN_MOVE_SELF, Flags::MOVED_FROM),
		(libc::IN_MOVED_TO, Flags::RENAMED),
		(libc::IN_MOVED_TO, Flags::MOVED_TO),
		(libc::IN_ATTRIB, Flags::ATTRIBUTE_MODIFIED),
		(ACCESSES, Flags::PLATFORM_SPECIFIC),
	];
	TRANSLATION
		.iter()
		.filter(|(bits, _)| mask & bits != 0)
		.fold(Flags::NO_OP, |flags, &(_, flag)| flags | flag)
}

/// The watch limit (`fs.inotify.max_user_watches`) was reached.
fn limit_reached() -> io::Error {
	io::Error::new(
		io::ErrorKind::StorageFull,
		"inotify watch limit reached (fs.inotify.max_user_watches)",
	)
}

fn is_limit(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::StorageFull
}

/// One inotify watch: a directory.
struct Watch {
	/// The directory's path, below its root as the caller named it.
	path:  Box<[u8]>,
	/// The root whose subtree the directory belongs to; its entries are
	/// reported under it.
	tree:  Option<u32>,
	/// File roots in the directory: entry name and root.
	files: Vec<(Box<[u8]>, u32)>,
}

struct RootState {
	path:      PathBuf,
	recursive: bool,
	/// The root is gone and awaited.
	missing:   bool,
}

enum Wake {
	Stop,
	Events,
	Timeout,
}

struct State {
	inotify:      OwnedFd,
	wake:         OwnedFd,
	roots:        Vec<RootState>,
	watches:      HashMap<i32, Watch>,
	/// How many roots are missing.
	missing:      usize,
	mask:         u32,
	follow_links: bool,
	timing:       Timing,
	descend:      Option<Descend>,
	emitter:      Emitter,
	/// The path of the event being handled.
	scratch:      Vec<u8>,
}

impl State {
	fn add_watch(&self, path: &Path, extra: u32) -> io::Result<i32> {
		let path = CString::new(path.as_os_str().as_bytes())?;
		// SAFETY: `path` is NUL-terminated; the descriptor is live.
		let wd = unsafe {
			libc::inotify_add_watch(self.inotify.as_raw_fd(), path.as_ptr(), self.mask | extra)
		};
		if wd < 0 {
			let error = io::Error::last_os_error();
			return Err(if error.raw_os_error() == Some(libc::ENOSPC) { limit_reached() } else { error });
		}
		Ok(wd)
	}

	fn root_bytes(&self, root: u32) -> &[u8] {
		self.roots[root as usize].path.as_os_str().as_bytes()
	}

	/// Watches the root: a directory's tree, or a file through its directory.
	/// `announce` reports what a directory already holds as created.
	///
	/// Returns whether the root exists. An awaited root that does not is
	/// watched through its directory like a file, if that exists.
	fn watch_root(&mut self, root: u32, announce: bool) -> io::Result<bool> {
		let path = self.roots[root as usize].path.clone();
		let exists = match fs::metadata(&path) {
			Ok(metadata) if metadata.is_dir() => {
				return self.add_tree(path, root, true, announce).map(|()| true);
			},
			Ok(_) => true,
			Err(error) if error.kind() == io::ErrorKind::NotFound && self.timing.await_missing => {
				false
			},
			Err(error) => return Err(error),
		};
		let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
			return Err(io::ErrorKind::InvalidInput.into());
		};
		let parent = if parent.as_os_str().is_empty() { Path::new(".") } else { parent };
		let wd = self.add_watch(parent, 0)?;
		let watch = self.watches.entry(wd).or_insert_with(|| Watch {
			path:  parent.as_os_str().as_bytes().into(),
			tree:  None,
			files: Vec::new(),
		});
		if !watch.files.iter().any(|&(_, known)| known == root) {
			watch.files.push((name.as_bytes().into(), root));
		}
		Ok(exists)
	}

	/// Watches `dir` for `root` and, below a recursive root, every directory
	/// under it the `descend` hook admits. `top` marks the root itself, whose
	/// failure is the caller's; any other directory that cannot be watched
	/// (it is gone already, or unreadable) is skipped.
	fn add_tree(&mut self, dir: PathBuf, root: u32, top: bool, announce: bool) -> io::Result<()> {
		let recursive = self.roots[root as usize].recursive;
		let mut stack = vec![(dir, top)];
		while let Some((dir, top)) = stack.pop() {
			let links = if top || self.follow_links { 0 } else { libc::IN_DONT_FOLLOW };
			let wd = match self.add_watch(&dir, libc::IN_ONLYDIR | links) {
				Ok(wd) => wd,
				Err(error) if top || is_limit(&error) => return Err(error),
				Err(_) => continue,
			};
			let bytes = dir.as_os_str().as_bytes();
			match self.watches.entry(wd) {
				Entry::Occupied(mut slot) => {
					let watch = slot.get_mut();
					// Reached again under another name (a symlink cycle): the
					// first name stays, and its tree is not walked twice.
					if watch.tree.is_some() && *watch.path != *bytes && !top {
						continue;
					}
					watch.path = bytes.into();
					watch.tree = Some(root);
				},
				Entry::Vacant(slot) => {
					slot.insert(Watch { path: bytes.into(), tree: Some(root), files: Vec::new() });
				},
			}
			if !recursive && !announce {
				continue;
			}
			let Ok(entries) = fs::read_dir(&dir) else {
				continue;
			};
			for entry in entries.flatten() {
				let Ok(kind) = entry.file_type() else {
					continue;
				};
				let path = entry.path();
				let is_dir = kind.is_dir()
					|| (kind.is_symlink()
						&& self.follow_links
						&& fs::metadata(&path).is_ok_and(|target| target.is_dir()));
				if announce {
					let kind = if kind.is_symlink() {
						Flags::IS_SYMLINK
					} else if is_dir {
						Flags::IS_DIR
					} else {
						Flags::IS_FILE
					};
					self
						.emitter
						.push(root, path.as_os_str().as_bytes(), Flags::CREATED | kind, 0, 0);
				}
				if recursive && is_dir && self.descend.as_mut().is_none_or(|descend| descend(&path)) {
					stack.push((path, false));
				}
			}
		}
		Ok(())
	}

	/// Drops the watches of every directory below `dir`, and with `inclusive`
	/// that of `dir` itself.
	fn forget_below(&mut self, dir: &[u8], inclusive: bool) {
		let inotify = self.inotify.as_raw_fd();
		self.watches.retain(|&wd, watch| {
			let gone = watch.path.strip_prefix(dir).is_some_and(|rest| match rest.first() {
				None => inclusive,
				Some(&next) => next == b'/',
			});
			if gone {
				// SAFETY: plain syscall on a live descriptor.
				unsafe { libc::inotify_rm_watch(inotify, wd) };
			}
			!gone
		});
	}

	/// The root is gone: await it, or end the watch.
	fn lose(&mut self, root: u32) -> io::Result<()> {
		let state = &mut self.roots[root as usize];
		if !self.timing.await_missing {
			return Err(io::Error::new(
				io::ErrorKind::NotFound,
				format!("{}: watched path was removed", state.path.display()),
			));
		}
		if !mem::replace(&mut state.missing, true) {
			self.missing += 1;
		}
		Ok(())
	}

	/// Watches the missing roots that exist again and reports them created.
	fn restore(&mut self) -> io::Result<()> {
		for root in 0..self.roots.len() as u32 {
			if !self.roots[root as usize].missing {
				continue;
			}
			match self.watch_root(root, true) {
				Ok(exists) => {
					let state = &mut self.roots[root as usize];
					state.missing = false;
					self.missing -= 1;
					// A root still absent is now watched through its directory,
					// which reports its creation.
					if exists {
						let kind = if state.path.is_dir() { Flags::IS_DIR } else { Flags::IS_FILE };
						let path = state.path.as_os_str().as_bytes();
						self.emitter.push(root, path, Flags::CREATED | kind, 0, 0);
					}
				},
				Err(error) if is_limit(&error) => return Err(error),
				Err(_) => {},
			}
		}
		Ok(())
	}

	/// The kernel dropped events: say so for every root, and walk each again
	/// for the directories whose creation went unreported.
	fn rescan(&mut self) -> io::Result<()> {
		for root in 0..self.roots.len() as u32 {
			let state = &self.roots[root as usize];
			let path = state.path.as_os_str().as_bytes();
			self
				.emitter
				.push(root, path, Flags::OVERFLOW, libc::IN_Q_OVERFLOW, 0);
			if state.missing {
				continue;
			}
			match self.watch_root(root, false) {
				Ok(_) => {},
				Err(error) if is_limit(&error) => return Err(error),
				Err(_) => self.lose(root)?,
			}
		}
		Ok(())
	}

	/// An event about the watched directory `wd` itself.
	fn handle_self(&mut self, wd: i32, mask: u32) -> io::Result<()> {
		let Some(watch) = self.watches.get(&wd) else {
			return Ok(());
		};
		let root = watch
			.tree
			.filter(|&root| *watch.path == *self.root_bytes(root));
		if mask & libc::IN_IGNORED != 0 {
			// The kernel dropped the watch: the directory is gone.
			let Some(watch) = self.watches.remove(&wd) else {
				return Ok(());
			};
			if let Some(root) = root {
				self.lose(root)?;
			}
			for (_, root) in watch.files {
				self.lose(root)?;
			}
			return Ok(());
		}
		let moved = mask & libc::IN_MOVE_SELF != 0;
		let orphaned = moved && (root.is_some() || !watch.files.is_empty());
		if let Some(root) = root {
			let flags = translate(mask);
			if !flags.is_empty() {
				self
					.emitter
					.push(root, &watch.path, flags | Flags::IS_DIR, mask, 0);
			}
		}
		if orphaned {
			// The watches follow the moved directory, but its old path is what
			// is watched: drop them, and treat the root as removed once the
			// kernel confirms.
			let path = watch.path.clone();
			self.forget_below(&path, false);
			// SAFETY: plain syscall on a live descriptor.
			unsafe { libc::inotify_rm_watch(self.inotify.as_raw_fd(), wd) };
		}
		Ok(())
	}

	fn handle(&mut self, wd: i32, mask: u32, cookie: u32, name: &[u8]) -> io::Result<()> {
		if mask & libc::IN_Q_OVERFLOW != 0 {
			return self.rescan();
		}
		if name.is_empty() {
			return self.handle_self(wd, mask);
		}
		let Some(watch) = self.watches.get(&wd) else {
			return Ok(());
		};
		let flags = translate(mask);
		if flags.is_empty() {
			return Ok(());
		}
		let is_dir = mask & libc::IN_ISDIR != 0;
		let flags = flags | if is_dir { Flags::IS_DIR } else { Flags::IS_FILE };
		let id = u64::from(cookie);
		// A file root that turns out to be, or comes back as, a directory.
		let mut grown = None;
		for (file, root) in &watch.files {
			if **file == *name {
				let path = self.roots[*root as usize].path.as_os_str().as_bytes();
				self.emitter.push(*root, path, flags, mask, id);
				if is_dir && mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
					grown = Some(*root);
				}
			}
		}
		let tree = watch.tree;
		if let Some(root) = grown {
			let path = self.roots[root as usize].path.clone();
			match self.add_tree(path, root, true, true) {
				Err(error) if is_limit(&error) => return Err(error),
				_ => {},
			}
		}
		let Some(watch) = self.watches.get(&wd) else {
			return Ok(());
		};
		let Some(root) = tree else {
			return Ok(());
		};
		self.scratch.clear();
		self.scratch.extend_from_slice(&watch.path);
		if !watch.path.ends_with(b"/") {
			self.scratch.push(b'/');
		}
		self.scratch.extend_from_slice(name);
		self.emitter.push(root, &self.scratch, flags, mask, id);
		if !is_dir {
			return Ok(());
		}
		if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
			if self.roots[root as usize].recursive {
				let path = PathBuf::from(OsString::from_vec(self.scratch.clone()));
				if self.descend.as_mut().is_none_or(|descend| descend(&path)) {
					// Created or moved in: what it holds by now is new under
					// this name, and came before the watch.
					self.add_tree(path, root, false, true)?;
				}
			}
		} else if mask & libc::IN_MOVED_FROM != 0 {
			// Its watches follow the directory to wherever it went.
			let moved = mem::take(&mut self.scratch);
			self.forget_below(&moved, true);
			self.scratch = moved;
		}
		Ok(())
	}

	/// Reads and handles everything queued.
	fn drain(&mut self, buffer: &mut [u32]) -> io::Result<()> {
		let bytes = mem::size_of_val(buffer);
		let base = buffer.as_mut_ptr().cast::<u8>();
		loop {
			// SAFETY: `base` is writable for `bytes` bytes.
			let read = unsafe { libc::read(self.inotify.as_raw_fd(), base.cast(), bytes) };
			if read < 0 {
				let error = io::Error::last_os_error();
				match error.kind() {
					io::ErrorKind::WouldBlock => return Ok(()),
					io::ErrorKind::Interrupted => continue,
					_ => return Err(error),
				}
			}
			let read = read as usize;
			if read == 0 {
				return Ok(());
			}
			let mut offset = 0;
			while offset + HEADER_BYTES <= read {
				// SAFETY: the kernel wrote whole records into the first `read`
				// bytes; the header lies within them (checked above).
				let header =
					unsafe { ptr::read_unaligned(base.add(offset).cast::<libc::inotify_event>()) };
				let name_len = header.len as usize;
				let name_start = offset + HEADER_BYTES;
				if name_start + name_len > read {
					break;
				}
				// SAFETY: the name's bytes follow the header within `read`
				// (checked above), and nothing writes the buffer meanwhile.
				let name = unsafe { std::slice::from_raw_parts(base.add(name_start), name_len) };
				let name = name.split(|&byte| byte == 0).next().unwrap_or_default();
				self.handle(header.wd, header.mask, header.cookie, name)?;
				offset = name_start + name_len;
			}
		}
	}

	/// Sleeps until there are events (when `events`), the stop signal, or
	/// `timeout`.
	fn wait(&self, events: bool, timeout: Option<Duration>) -> Wake {
		let mut fds = [
			libc::pollfd { fd: self.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 },
			libc::pollfd { fd: self.inotify.as_raw_fd(), events: libc::POLLIN, revents: 0 },
		];
		let count = if events { 2 } else { 1 };
		let timeout = timeout.map_or(-1, |timeout| {
			i32::try_from(timeout.as_millis().max(1)).unwrap_or(i32::MAX)
		});
		loop {
			// SAFETY: `fds` holds `count` initialized entries.
			let ready = unsafe { libc::poll(fds.as_mut_ptr(), count, timeout) };
			if ready < 0 {
				if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Wake::Stop;
			}
			return if fds[0].revents != 0 {
				Wake::Stop
			} else if ready > 0 {
				Wake::Events
			} else {
				Wake::Timeout
			};
		}
	}

	/// Waits out the latency; `true` when the watch was stopped meanwhile.
	fn pause(&self) -> bool {
		!self.timing.latency.is_zero()
			&& matches!(self.wait(false, Some(self.timing.latency)), Wake::Stop)
	}

	fn run(mut self) {
		let bytes = self.timing.buffer_bytes.unwrap_or(BUFFER_BYTES).max(4096);
		let mut buffer = vec![0u32; bytes / 4];
		loop {
			let recheck = (self.missing > 0).then_some(MISSING_ROOT_RECHECK);
			match self.wait(true, recheck) {
				Wake::Stop => return,
				Wake::Timeout => {},
				Wake::Events => {
					if !self.timing.no_defer && self.pause() {
						return;
					}
					if let Err(error) = self.drain(&mut buffer) {
						self.emitter.fail(error);
						return;
					}
					self.emitter.flush();
					if self.timing.no_defer && self.pause() {
						return;
					}
				},
			}
			if self.missing > 0 {
				if let Err(error) = self.restore() {
					self.emitter.fail(error);
					return;
				}
				self.emitter.flush();
			}
		}
	}
}

/// The running watch; dropping it stops the reader thread and waits for it.
pub(crate) struct Inotify {
	stop:   OwnedFd,
	thread: Option<thread::JoinHandle<()>>,
}

impl Inotify {
	pub(crate) fn start(
		roots: Vec<Root>,
		timing: Timing,
		follow_links: bool,
		access: bool,
		descend: Option<Descend>,
		emitter: Emitter,
	) -> io::Result<Self> {
		// SAFETY: plain syscalls; each returned descriptor is owned right away.
		let (inotify, wake) = unsafe {
			let inotify = libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC);
			if inotify < 0 {
				return Err(io::Error::last_os_error());
			}
			let inotify = OwnedFd::from_raw_fd(inotify);
			let wake = libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC);
			if wake < 0 {
				return Err(io::Error::last_os_error());
			}
			(inotify, OwnedFd::from_raw_fd(wake))
		};
		let stop = wake.try_clone()?;
		let mut state = State {
			inotify,
			wake,
			roots: roots
				.into_iter()
				.map(|root| RootState { path: root.path, recursive: root.recursive, missing: false })
				.collect(),
			watches: HashMap::new(),
			missing: 0,
			mask: if access { CHANGES | ACCESSES } else { CHANGES },
			follow_links,
			timing,
			descend,
			emitter,
			scratch: Vec::new(),
		};
		for root in 0..state.roots.len() as u32 {
			match state.watch_root(root, false) {
				Ok(_) => {},
				Err(error) if is_limit(&error) => return Err(error),
				// Not even its directory exists yet.
				Err(error) if error.kind() == io::ErrorKind::NotFound && timing.await_missing => {
					state.lose(root)?;
				},
				Err(error) => return Err(missing_root(&state.roots[root as usize].path, &error)),
			}
		}
		let thread = thread::Builder::new()
			.name("omp-watch".into())
			.spawn(move || state.run())?;
		Ok(Self { stop, thread: Some(thread) })
	}
}

impl Drop for Inotify {
	fn drop(&mut self) {
		let one = 1u64.to_ne_bytes();
		// SAFETY: `one` is readable for its eight bytes; the eventfd is live.
		unsafe { libc::write(self.stop.as_raw_fd(), one.as_ptr().cast(), one.len()) };
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}
