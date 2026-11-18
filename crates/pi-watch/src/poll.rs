//! Polling: a scan of every root on each interval, compared with the last.
//!
//! For file systems that deliver no notifications (network shares) and for
//! callers that ask for it by name. Each path's metadata is remembered; a
//! scan reports what appeared, what went, and what differs: content
//! (modification time or size), attributes (mode, or a change time that moved
//! alone), owner, and link count.

use std::{
	fs, io,
	path::PathBuf,
	sync::mpsc,
	thread,
	time::{Duration, SystemTime},
};

use hashbrown::HashMap;

use crate::{Flags, Root, Timing, batch::Emitter, missing_root};

/// What a scan remembers of a path.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
	/// The type flag: [`Flags::IS_DIR`], [`Flags::IS_SYMLINK`] or
	/// [`Flags::IS_FILE`].
	kind:     Flags,
	modified: Option<SystemTime>,
	/// The inode change time; zero where the system has none.
	changed:  (i64, i64),
	size:     u64,
	/// Permission bits, or the Windows file attributes.
	mode:     u32,
	owner:    (u32, u32),
	links:    u64,
}

impl Stamp {
	fn of(metadata: &fs::Metadata) -> Self {
		let kind = if metadata.is_dir() {
			Flags::IS_DIR
		} else if metadata.file_type().is_symlink() {
			Flags::IS_SYMLINK
		} else {
			Flags::IS_FILE
		};
		#[cfg(unix)]
		let (changed, mode, owner, links) = {
			use std::os::unix::fs::MetadataExt as _;
			(
				(metadata.ctime(), metadata.ctime_nsec()),
				metadata.mode(),
				(metadata.uid(), metadata.gid()),
				metadata.nlink(),
			)
		};
		#[cfg(windows)]
		let (changed, mode, owner, links) = {
			use std::os::windows::fs::MetadataExt as _;
			((0, 0), metadata.file_attributes(), (0, 0), 1)
		};
		#[cfg(not(any(unix, windows)))]
		let (changed, mode, owner, links) = ((0, 0), 0, (0, 0), 1);
		Self { kind, modified: metadata.modified().ok(), changed, size: metadata.len(), mode, owner, links }
	}

	/// What changed between two scans of one path of one type.
	fn changes_to(&self, now: &Self) -> Flags {
		let mut flags = Flags::NO_OP;
		if self.modified != now.modified || self.size != now.size {
			flags |= Flags::UPDATED;
		}
		if self.owner != now.owner {
			flags |= Flags::OWNER_MODIFIED;
		}
		if self.links != now.links {
			flags |= Flags::LINK;
		}
		// Every write moves the change time; alone, it tells of attributes.
		if self.mode != now.mode || (self.changed != now.changed && flags.is_empty()) {
			flags |= Flags::ATTRIBUTE_MODIFIED;
		}
		flags
	}
}

struct Known {
	stamp: Stamp,
	root:  u32,
	/// The scan that last saw the path.
	scan:  u32,
}

struct Scanner {
	roots:         Vec<Root>,
	known:         HashMap<Box<[u8]>, Known>,
	scan:          u32,
	follow_links:  bool,
	await_missing: bool,
	emitter:       Emitter,
	/// Directories still to list: path and depth below the root.
	stack:         Vec<(PathBuf, u32)>,
}

impl Scanner {
	/// Scans every root. With `report`, differences from the last scan
	/// become events; without, the scan is the baseline.
	///
	/// # Errors
	///
	/// A root that does not exist, unless missing roots are awaited.
	fn scan(&mut self, report: bool) -> io::Result<()> {
		self.scan = self.scan.wrapping_add(1);
		for index in 0..self.roots.len() {
			let root = &self.roots[index];
			let recursive = root.recursive;
			if let Err(error) = fs::metadata(&root.path)
				&& !self.await_missing
			{
				return Err(missing_root(&root.path, &error));
			}
			self.stack.push((root.path.clone(), 0));
			while let Some((path, depth)) = self.stack.pop() {
				// A root is what it points at; below it, links are followed
				// only on request.
				let metadata = if depth == 0 || self.follow_links {
					fs::metadata(&path).or_else(|_| fs::symlink_metadata(&path))
				} else {
					fs::symlink_metadata(&path)
				};
				let Ok(metadata) = metadata else {
					continue;
				};
				let bytes = path.as_os_str().as_encoded_bytes();
				let stamp = Stamp::of(&metadata);
				if let Some(known) = self.known.get_mut(bytes) {
					// Seen already in this scan: reached again through a second
					// root; its entries were listed then.
					if known.scan == self.scan {
						continue;
					}
					if report {
						if known.stamp.kind == stamp.kind {
							let flags = known.stamp.changes_to(&stamp);
							if !flags.is_empty() {
								self.emitter.push(index as u32, bytes, flags | stamp.kind, 0, 0);
							}
						} else {
							self
								.emitter
								.push(known.root, bytes, Flags::REMOVED | known.stamp.kind, 0, 0);
							self
								.emitter
								.push(index as u32, bytes, Flags::CREATED | stamp.kind, 0, 0);
						}
					}
					*known = Known { stamp, root: index as u32, scan: self.scan };
				} else {
					if report {
						self
							.emitter
							.push(index as u32, bytes, Flags::CREATED | stamp.kind, 0, 0);
					}
					self
						.known
						.insert(bytes.into(), Known { stamp, root: index as u32, scan: self.scan });
				}
				if metadata.is_dir()
					&& (depth == 0 || recursive)
					&& let Ok(entries) = fs::read_dir(&path)
				{
					self
						.stack
						.extend(entries.flatten().map(|entry| (entry.path(), depth + 1)));
				}
			}
		}
		if report {
			let (scan, emitter) = (self.scan, &mut self.emitter);
			self.known.retain(|path, known| {
				let seen = known.scan == scan;
				if !seen {
					emitter.push(known.root, path, Flags::REMOVED | known.stamp.kind, 0, 0);
				}
				seen
			});
		}
		Ok(())
	}
}

/// The running watch; dropping it stops the scanning thread and waits for it.
pub(crate) struct Poll {
	stop:   mpsc::Sender<()>,
	thread: Option<thread::JoinHandle<()>>,
}

impl Poll {
	pub(crate) fn start(
		roots: Vec<Root>,
		timing: Timing,
		interval: Duration,
		follow_links: bool,
		emitter: Emitter,
	) -> io::Result<Self> {
		let mut scanner = Scanner {
			roots,
			known: HashMap::new(),
			scan: 0,
			follow_links,
			await_missing: timing.await_missing,
			emitter,
			stack: Vec::new(),
		};
		scanner.scan(false)?;
		let (stop, stopped) = mpsc::channel();
		let thread = thread::Builder::new()
			.name("omp-watch".into())
			.spawn(move || {
				// Anything but a timeout is the stop, or the watch being dropped.
				while matches!(stopped.recv_timeout(interval), Err(mpsc::RecvTimeoutError::Timeout)) {
					match scanner.scan(true) {
						Ok(()) => scanner.emitter.flush(),
						Err(error) => {
							scanner.emitter.fail(error);
							return;
						},
					}
				}
			})?;
		Ok(Self { stop, thread: Some(thread) })
	}
}

impl Drop for Poll {
	fn drop(&mut self) {
		let _ = self.stop.send(());
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}
