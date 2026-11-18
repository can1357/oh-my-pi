//! macOS on request: kqueue vnode events.
//!
//! kqueue watches open files, not names: every watched file and directory
//! costs a descriptor, and a directory only says that its entries changed.
//! So each listed directory remembers its entries and is listed again when it
//! reports a write, which turns up what was created and what went. A file
//! reports its own writes, attribute changes, renames and removal.
//!
//! `FSEvents` is the default on macOS for good reason; this exists for callers
//! that ask for kqueue by name.

use std::{
	ffi::{CString, OsStr},
	fs, io, mem,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::{Path, PathBuf},
	ptr, thread,
	time::Duration,
};

use hashbrown::HashMap;

use crate::{Descend, Flags, MISSING_ROOT_RECHECK, Root, Timing, batch::Emitter, missing_root};

/// Everything a vnode can report.
const NOTES: u32 = libc::NOTE_DELETE
	| libc::NOTE_WRITE
	| libc::NOTE_EXTEND
	| libc::NOTE_ATTRIB
	| libc::NOTE_LINK
	| libc::NOTE_RENAME
	| libc::NOTE_REVOKE;
/// The path under the descriptor is no longer the watched one.
const GONE: u32 = libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;
/// Events taken per `kevent` call.
const EVENTS: usize = 64;

/// The descriptor limit was reached.
fn limit_reached(error: &io::Error) -> io::Error {
	io::Error::new(
		io::ErrorKind::QuotaExceeded,
		format!("kqueue needs a descriptor for every watched file: {error}"),
	)
}

fn is_limit(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::QuotaExceeded
}

/// One watched file or directory.
struct Watched {
	/// Open for events only; the kqueue registration lives as long as it.
	_open:   OwnedFd,
	path:    Box<[u8]>,
	root:    u32,
	is_dir:  bool,
	/// The names of a listed directory's entries, sorted; `None` for a file
	/// and for a directory watched as an entry only (below a flat root).
	entries: Option<Vec<Box<[u8]>>>,
}

struct RootState {
	path:      PathBuf,
	recursive: bool,
	/// The root is gone, or not there yet, and awaited.
	missing:   bool,
}

struct State {
	kqueue:       OwnedFd,
	/// The read end of the pipe a stop is written to.
	wake:         OwnedFd,
	roots:        Vec<RootState>,
	watched:      HashMap<RawFd, Watched>,
	by_path:      HashMap<Box<[u8]>, RawFd>,
	/// How many roots are missing.
	missing:      usize,
	follow_links: bool,
	timing:       Timing,
	descend:      Option<Descend>,
	emitter:      Emitter,
}

/// A zeroed event record.
const fn blank() -> libc::kevent {
	// SAFETY: `kevent` is plain data; all-zero is a valid value.
	unsafe { mem::zeroed() }
}

fn path_of(bytes: &[u8]) -> &Path {
	Path::new(OsStr::from_bytes(bytes))
}

/// `dir` joined with `name`.
fn join(dir: &[u8], name: &[u8]) -> Vec<u8> {
	let mut path = Vec::with_capacity(dir.len() + 1 + name.len());
	path.extend_from_slice(dir);
	if !dir.ends_with(b"/") {
		path.push(b'/');
	}
	path.extend_from_slice(name);
	path
}

/// The sorted names of `dir`'s entries.
fn list(dir: &Path) -> Vec<Box<[u8]>> {
	let mut names: Vec<Box<[u8]>> = fs::read_dir(dir).map_or_else(
		|_| Vec::new(),
		|entries| {
			entries
				.flatten()
				.map(|entry| entry.file_name().as_bytes().into())
				.collect()
		},
	);
	names.sort_unstable();
	names
}

impl State {
	/// Registers `fd` for `filter` events.
	fn register(&self, fd: RawFd, filter: i16, notes: u32) -> io::Result<()> {
		let mut change = blank();
		change.ident = fd as usize;
		change.filter = filter;
		change.flags = libc::EV_ADD | libc::EV_CLEAR;
		change.fflags = notes;
		// SAFETY: one initialized change record, no event list.
		let done = unsafe {
			libc::kevent(
				self.kqueue.as_raw_fd(),
				&raw const change,
				1,
				ptr::null_mut(),
				0,
				ptr::null(),
			)
		};
		if done < 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	/// Opens and registers `path`; a path watched already is left alone.
	/// `follow` watches what a symbolic link points at instead of the link.
	fn open(&mut self, path: &[u8], root: u32, is_dir: bool, follow: bool) -> io::Result<RawFd> {
		if let Some(&fd) = self.by_path.get(path) {
			return Ok(fd);
		}
		let name = CString::new(path)?;
		let links = if follow { 0 } else { libc::O_SYMLINK };
		// SAFETY: `name` is NUL-terminated.
		let fd = unsafe { libc::open(name.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC | links) };
		if fd < 0 {
			let error = io::Error::last_os_error();
			let full = matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE));
			return Err(if full { limit_reached(&error) } else { error });
		}
		// SAFETY: `fd` is a fresh descriptor this value now owns.
		let owned = unsafe { OwnedFd::from_raw_fd(fd) };
		self.register(fd, libc::EVFILT_VNODE, NOTES)?;
		self.watched.insert(fd, Watched {
			_open: owned,
			path: path.into(),
			root,
			is_dir,
			entries: None,
		});
		self.by_path.insert(path.into(), fd);
		Ok(fd)
	}

	/// Watches `path` for `root`: a file, or a directory with its entries
	/// and, below a recursive root, every directory under it the `descend`
	/// hook admits. `announce` reports what a directory holds as created.
	/// `top` marks the root itself, whose failure is the caller's; anything
	/// else that cannot be watched (it is gone already) is skipped.
	fn add(&mut self, path: PathBuf, root: u32, top: bool, announce: bool) -> io::Result<()> {
		let recursive = self.roots[root as usize].recursive;
		let mut stack = vec![(path, top, true)];
		while let Some((path, top, listed)) = stack.pop() {
			let follow = top || self.follow_links;
			let metadata = if follow {
				fs::metadata(&path)
			} else {
				fs::symlink_metadata(&path)
			};
			let bytes = path.as_os_str().as_bytes();
			let opened = metadata.and_then(|metadata| {
				let is_dir = metadata.is_dir();
				self
					.open(bytes, root, is_dir, follow)
					.map(|fd| (fd, is_dir))
			});
			let (fd, is_dir) = match opened {
				Ok(opened) => opened,
				Err(error) if top || is_limit(&error) => return Err(error),
				Err(_) => continue,
			};
			if !(is_dir && listed) {
				continue;
			}
			let names = list(&path);
			for name in &names {
				let entry = PathBuf::from(OsStr::from_bytes(&join(bytes, name)));
				let kind = fs::symlink_metadata(&entry).map(|metadata| metadata.file_type());
				let Ok(kind) = kind else {
					continue;
				};
				let is_dir = kind.is_dir()
					|| (kind.is_symlink()
						&& self.follow_links
						&& fs::metadata(&entry).is_ok_and(|target| target.is_dir()));
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
						.push(root, entry.as_os_str().as_bytes(), Flags::CREATED | kind, 0, 0);
				}
				// A directory below a flat root, or one the hook prunes, is
				// watched as an entry: its own changes, not its entries.
				let listed =
					is_dir && recursive && self.descend.as_mut().is_none_or(|descend| descend(&entry));
				stack.push((entry, false, listed));
			}
			if let Some(watched) = self.watched.get_mut(&fd) {
				watched.entries = Some(names);
			}
		}
		Ok(())
	}

	/// Stops watching `path` and, for a directory, everything below it.
	fn forget(&mut self, path: &[u8]) {
		let Some(fd) = self.by_path.remove(path) else {
			return;
		};
		let Some(watched) = self.watched.remove(&fd) else {
			return;
		};
		if watched.is_dir {
			let watched = &mut self.watched;
			self.by_path.retain(|below, fd| {
				let inside = below
					.strip_prefix(path)
					.is_some_and(|rest| rest.first() == Some(&b'/'));
				if inside {
					watched.remove(fd);
				}
				!inside
			});
		}
		// The directory holding it no longer lists it.
		let path = path_of(path);
		if let (Some(parent), Some(name)) = (path.parent(), path.file_name())
			&& let Some(parent) = self.by_path.get(parent.as_os_str().as_bytes())
			&& let Some(entries) = self
				.watched
				.get_mut(parent)
				.and_then(|dir| dir.entries.as_mut())
			&& let Ok(at) = entries.binary_search_by(|entry| (**entry).cmp(name.as_bytes()))
		{
			entries.remove(at);
		}
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
			let path = self.roots[root as usize].path.clone();
			let Ok(metadata) = fs::metadata(&path) else {
				continue;
			};
			match self.add(path.clone(), root, true, true) {
				Ok(()) => {
					self.roots[root as usize].missing = false;
					self.missing -= 1;
					let kind = if metadata.is_dir() {
						Flags::IS_DIR
					} else {
						Flags::IS_FILE
					};
					self
						.emitter
						.push(root, path.as_os_str().as_bytes(), Flags::CREATED | kind, 0, 0);
				},
				Err(error) if is_limit(&error) => return Err(error),
				Err(_) => {},
			}
		}
		Ok(())
	}

	/// Lists the directory behind `fd` again: reports and watches what is
	/// new, reports and forgets what went.
	fn relist(&mut self, fd: RawFd) -> io::Result<()> {
		let Some(watched) = self.watched.get_mut(&fd) else {
			return Ok(());
		};
		let Some(before) = watched.entries.take() else {
			return Ok(());
		};
		let (dir, root) = (watched.path.clone(), watched.root);
		let now = list(path_of(&dir));
		watched.entries = Some(now.clone());
		for name in &before {
			if now.binary_search(name).is_ok() {
				continue;
			}
			let path = join(&dir, name);
			// Its own removal may have been reported already.
			if let Some(gone) = self.by_path.get(&*path).and_then(|fd| self.watched.get(fd)) {
				let kind = if gone.is_dir {
					Flags::IS_DIR
				} else {
					Flags::IS_FILE
				};
				self.emitter.push(root, &path, Flags::REMOVED | kind, 0, 0);
			}
			self.forget(&path);
		}
		let recursive = self.roots[root as usize].recursive;
		for name in &now {
			if before.binary_search(name).is_ok() {
				continue;
			}
			let path = join(&dir, name);
			let entry = PathBuf::from(OsStr::from_bytes(&path));
			let Ok(metadata) = fs::symlink_metadata(&entry) else {
				continue;
			};
			let kind = if metadata.file_type().is_symlink() {
				Flags::IS_SYMLINK
			} else if metadata.is_dir() {
				Flags::IS_DIR
			} else {
				Flags::IS_FILE
			};
			self.emitter.push(root, &path, Flags::CREATED | kind, 0, 0);
			let is_dir = metadata.is_dir()
				|| (self.follow_links && fs::metadata(&entry).is_ok_and(|target| target.is_dir()));
			if is_dir && recursive && self.descend.as_mut().is_none_or(|descend| descend(&entry)) {
				match self.add(entry, root, false, true) {
					Err(error) if is_limit(&error) => return Err(error),
					_ => {},
				}
			} else {
				match self.open(&path, root, is_dir, self.follow_links) {
					Err(error) if is_limit(&error) => return Err(error),
					_ => {},
				}
			}
		}
		Ok(())
	}

	/// One vnode event: `notes` for the path behind `fd`.
	fn handle(&mut self, fd: RawFd, notes: u32) -> io::Result<()> {
		let Some(watched) = self.watched.get(&fd) else {
			return Ok(());
		};
		let (root, is_dir, listed) = (watched.root, watched.is_dir, watched.entries.is_some());
		let mut flags = Flags::NO_OP;
		if notes & (libc::NOTE_DELETE | libc::NOTE_REVOKE) != 0 {
			flags |= Flags::REMOVED;
		}
		if notes & libc::NOTE_RENAME != 0 {
			flags |= Flags::RENAMED | Flags::MOVED_FROM;
		}
		if notes & libc::NOTE_ATTRIB != 0 {
			flags |= Flags::ATTRIBUTE_MODIFIED;
		}
		// A directory's writes and link counts are its entries coming and
		// going, which the listing reports.
		if !is_dir {
			if notes & (libc::NOTE_WRITE | libc::NOTE_EXTEND) != 0 {
				flags |= Flags::UPDATED;
			}
			if notes & libc::NOTE_LINK != 0 {
				flags |= Flags::LINK;
			}
		}
		if !flags.is_empty() {
			let kind = if is_dir {
				Flags::IS_DIR
			} else {
				Flags::IS_FILE
			};
			self
				.emitter
				.push(root, &watched.path, flags | kind, notes, 0);
		}
		if notes & GONE != 0 {
			let path = watched.path.clone();
			self.forget(&path);
			if *path == *self.roots[root as usize].path.as_os_str().as_bytes() {
				self.lose(root)?;
			}
			return Ok(());
		}
		if listed && notes & libc::NOTE_WRITE != 0 {
			self.relist(fd)?;
		}
		Ok(())
	}

	/// Waits out the latency; `true` when the watch was stopped meanwhile.
	fn pause(&self) -> bool {
		if self.timing.latency.is_zero() {
			return false;
		}
		let mut wake =
			libc::pollfd { fd: self.wake.as_raw_fd(), events: libc::POLLIN, revents: 0 };
		let millis = i32::try_from(self.timing.latency.as_millis().max(1)).unwrap_or(i32::MAX);
		// SAFETY: one initialized entry.
		unsafe { libc::poll(&raw mut wake, 1, millis) > 0 }
	}

	/// Takes up to [`EVENTS`] events, waiting for `timeout` (forever without
	/// one). `None` once the watch is stopped or the queue fails.
	fn take(&self, events: &mut [libc::kevent; EVENTS], timeout: Option<Duration>) -> Option<usize> {
		let timeout = timeout.map(|timeout| libc::timespec {
			tv_sec:  timeout.as_secs() as libc::time_t,
			tv_nsec: timeout.subsec_nanos().into(),
		});
		let limit = timeout.as_ref().map_or(ptr::null(), ptr::from_ref);
		loop {
			// SAFETY: `events` is writable for `EVENTS` records; `limit` is
			// null or points at a live `timespec`.
			let taken = unsafe {
				libc::kevent(
					self.kqueue.as_raw_fd(),
					ptr::null(),
					0,
					events.as_mut_ptr(),
					EVENTS as i32,
					limit,
				)
			};
			if taken < 0 {
				if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return None;
			}
			let taken = taken as usize;
			let stopped = events[..taken]
				.iter()
				.any(|event| event.filter == libc::EVFILT_READ);
			return (!stopped).then_some(taken);
		}
	}

	fn run(mut self) {
		let mut events = [blank(); EVENTS];
		loop {
			let recheck = (self.missing > 0).then_some(MISSING_ROOT_RECHECK);
			let Some(mut taken) = self.take(&mut events, recheck) else {
				return;
			};
			if taken > 0 {
				if !self.timing.no_defer && self.pause() {
					return;
				}
				// What the first call took, then whatever else is queued.
				while taken > 0 {
					for event in &events[..taken] {
						if let Err(error) = self.handle(event.ident as RawFd, event.fflags) {
							self.emitter.fail(error);
							return;
						}
					}
					match self.take(&mut events, Some(Duration::ZERO)) {
						Some(more) => taken = more,
						None => return,
					}
				}
				self.emitter.flush();
				if self.timing.no_defer && self.pause() {
					return;
				}
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
pub(crate) struct Kqueue {
	/// The write end of the pipe the reader waits on.
	stop:   OwnedFd,
	thread: Option<thread::JoinHandle<()>>,
}

impl Kqueue {
	pub(crate) fn start(
		roots: Vec<Root>,
		timing: Timing,
		follow_links: bool,
		descend: Option<Descend>,
		emitter: Emitter,
	) -> io::Result<Self> {
		let mut pipe = [0; 2];
		// SAFETY: plain syscalls; each returned descriptor is owned right away.
		let (kqueue, wake, stop) = unsafe {
			let kqueue = libc::kqueue();
			if kqueue < 0 {
				return Err(io::Error::last_os_error());
			}
			let kqueue = OwnedFd::from_raw_fd(kqueue);
			if libc::pipe(pipe.as_mut_ptr()) < 0 {
				return Err(io::Error::last_os_error());
			}
			let (wake, stop) = (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1]));
			libc::fcntl(wake.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
			libc::fcntl(stop.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
			(kqueue, wake, stop)
		};
		let mut state = State {
			kqueue,
			wake,
			roots: roots
				.into_iter()
				.map(|root| RootState {
					path:      root.path,
					recursive: root.recursive,
					missing:   false,
				})
				.collect(),
			watched: HashMap::new(),
			by_path: HashMap::new(),
			missing: 0,
			follow_links,
			timing,
			descend,
			emitter,
		};
		state.register(state.wake.as_raw_fd(), libc::EVFILT_READ, 0)?;
		for root in 0..state.roots.len() as u32 {
			let path = state.roots[root as usize].path.clone();
			match state.add(path, root, true, false) {
				Ok(()) => {},
				Err(error) if is_limit(&error) => return Err(error),
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

impl Drop for Kqueue {
	fn drop(&mut self) {
		// SAFETY: one readable byte; the pipe is live.
		unsafe { libc::write(self.stop.as_raw_fd(), [0u8].as_ptr().cast(), 1) };
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}
